import {
  CognitoIdentityClient,
  Credentials,
  GetIdCommand,
  GetCredentialsForIdentityCommand,
} from "@aws-sdk/client-cognito-identity";
import { aws4Interceptor } from "aws4-axios";
import * as awsIot from "aws-iot-device-sdk";
import axios from "axios";
import { Logger } from "homebridge";
import { aesCmac } from "node-aes-cmac";
import { TextDecoder } from "util";
import { v4 as uuidv4 } from "uuid";

import * as Util from "./Util";
import { Sesame3 } from "./accessories/Sesame3";
import { SesameBot } from "./accessories/SesameBot";
import { Client } from "./interfaces/Client";
import { CHSesame2MechStatus } from "./types/API";
import { Command } from "./types/Command";
import { CHDevice } from "./types/Device";

const APIGW_URL =
  "https://jhcr1i3ecb.execute-api.ap-northeast-1.amazonaws.com/prod";
const IOT_EP = "a3i4hui4gxwoo8-ats.iot.ap-northeast-1.amazonaws.com";

export class CognitoClient implements Client {
  readonly #device: CHDevice;
  readonly #deviceType: typeof Sesame3 | typeof SesameBot;
  readonly #apiKey: string;
  readonly #clientID: string;

  #credential: Credentials;
  #connection: awsIot.device | undefined = undefined;
  #updateCredentialTimer: NodeJS.Timer | undefined = undefined;

  constructor(
    deviceType: typeof Sesame3 | typeof SesameBot,
    device: CHDevice,
    apiKey: string,
    clientID: string,
    private readonly log: Logger,
  ) {
    this.#deviceType = deviceType;
    this.#device = device;
    this.#apiKey = apiKey;
    this.#clientID = clientID;

    this.#credential = {};
  }

  shutdown(): void {
    this.#connection?.end(true);
  }

  async getMechStatus(): Promise<CHSesame2MechStatus | undefined> {
    this.log.debug(`GET /things/sesame2/shadow?name=${this.#device.uuid}`);

    if (this.credentialExpired) {
      await this.authenticate();
    }

    if (!this.authenticated) {
      return;
    }

    const client = axios.create();
    const interceptor = aws4Interceptor(
      {
        region: "ap-northeast-1",
        service: "iotdata",
      },
      {
        accessKeyId: this.#credential.AccessKeyId!,
        secretAccessKey: this.#credential.SecretKey!,
        sessionToken: this.#credential.SessionToken!,
      },
    );
    client.interceptors.request.use(interceptor);
    try {
      const res = await client.get<{
        state: { reported: { mechst: string } };
      }>(`https://${IOT_EP}/things/sesame2/shadow?name=${this.#device.uuid}`);

      const status = Util.convertToSesame2MechStatus(
        this.#deviceType,
        res.data.state.reported.mechst,
      );
      this.log.debug(`${this.#device.uuid}:`, JSON.stringify(status));

      return status;
    } catch (e) {
      this.log.error("Failed to getMechStatus.");
      this.log.debug(`${e}`);
      return;
    }
  }

  async subscribe(
    callback: (status: CHSesame2MechStatus) => void,
  ): Promise<void> {
    if (this.credentialExpired) {
      await this.authenticate();
    }

    if (!this.authenticated) {
      return;
    }

    // Set timer to update credential for mqtt reconnection.
    // Websocket connection will be closed after 24 hours based on aws iot quota.
    // see https://docs.aws.amazon.com/general/latest/gr/iot-core.html#iot-protocol-limits
    this.setUpdateCredentialTimer();

    this.#connection = new awsIot.device({
      host: IOT_EP,
      protocol: "wss",
      clean: false,
      keepalive: 60,
      clientId: uuidv4(),
      accessKeyId: this.#credential.AccessKeyId!,
      secretKey: this.#credential.SecretKey!,
      sessionToken: this.#credential.SessionToken!,
    });

    const decoder = new TextDecoder("utf8");
    this.#connection.on("message", (_, payload: ArrayBuffer) => {
      const data = decoder.decode(payload);
      if (typeof data === "undefined") {
        return;
      }

      const json = JSON.parse(data);
      const mechst = json.state.reported.mechst;
      if (typeof mechst !== "string") {
        return;
      }

      const status = Util.convertToSesame2MechStatus(this.#deviceType, mechst);
      this.log.debug(`${this.#device.uuid}:`, JSON.stringify(status));
      callback(status);
    });

    this.#connection.on("connect", () => {
      this.log.debug(`${this.#device.uuid}: mqtt connection is established`);

      const topic = `$aws/things/sesame2/shadow/name/${
        this.#device.uuid
      }/update/accepted`;
      this.#connection?.subscribe(topic, { qos: 1 }, (err) => {
        if (!err) {
          this.log.debug(`${this.#device.uuid}: subscribed to ${topic}`);
        }
      });
    });

    this.#connection
      .on("error", (error) => {
        this.log.error(`${this.#device.uuid}: mqtt error:`, error);
      })
      .on("reconnect", async () => {
        this.log.debug(`${this.#device.uuid}: mqtt connection will reconnect`);

        // Ensure to use not expired credential for mqtt reconnetion
        this.updateWebSocketCredentials();

        // Refresh status for the case when lock/unlock cmd is triggered just before mqtt reconnection
        const status = await this.getMechStatus();
        if (!status) {
          return;
        }
        callback(status);
      })
      .on("close", async () => {
        this.log.debug(`${this.#device.uuid}: mqtt connection is closed`);
      });
  }

  async postCmd(cmd: Command, historyName?: string): Promise<boolean> {
    this.log.debug(`POST /device/v1/iot/sesame2/${this.#device.uuid}`);

    if (this.credentialExpired) {
      await this.authenticate();
    }

    const instance = axios.create({
      headers: { "x-api-key": this.#apiKey },
    });
    instance.interceptors.request.use(
      aws4Interceptor(
        {
          region: "ap-northeast-1",
          service: "execute-api",
        },
        {
          accessKeyId: this.#credential.AccessKeyId!,
          secretAccessKey: this.#credential.SecretKey!,
          sessionToken: this.#credential.SessionToken!,
        },
      ),
    );

    const url = `https://app.candyhouse.co/api/sesame2/${this.#device.uuid}/cmd`;
    const history = historyName ?? "Homebridge";
    const base64_history = Buffer.from(history).toString("base64");
    const sign = this.generateRandomTag(this.#device.secret).slice(0, 8);
    const res = await instance.post(url, {
      cmd: cmd,
      history: base64_history,
      sign: sign,
    });

    return res.status === 200;
  }

  private get credentialExpired(): boolean {
    const expireAt = this.#credential.Expiration?.getTime();
    if (expireAt == null) {
      return true;
    }
    return expireAt - 60 * 1000 < new Date().getTime();
  }

  private get authenticated(): boolean {
    return (
      typeof this.#credential.AccessKeyId !== "undefined" &&
      typeof this.#credential.SecretKey !== "undefined"
    );
  }

  private async authenticate(): Promise<void> {
    try {
      const region = this.#clientID.split(":")[0];
      const cognitoClient = new CognitoIdentityClient({ region: region });
      const command = new GetIdCommand({ IdentityPoolId: this.#clientID });

      const data = await cognitoClient.send(command);

      const credCommand = new GetCredentialsForIdentityCommand({
        IdentityId: data.IdentityId,
      });
      this.#credential = (await cognitoClient.send(credCommand)).Credentials!;
    } catch (e) {
      this.log.error("Failed to authenticate.");
      this.log.debug(`${e}`);
    }
  }

  private setUpdateCredentialTimer(): void {
    if (this.#updateCredentialTimer) {
      clearTimeout(this.#updateCredentialTimer);
    }

    // Update credential 2.5 minutes before expire(proceeds 1 hour a day)
    const now = new Date().getTime();
    const expire =
      this.#credential.Expiration?.getTime() ?? now + 60 * 60 * 1000;
    const timeout = Math.max(expire - now - 150 * 1000, 5 * 1000);

    // Update credential periodically
    this.#updateCredentialTimer = setTimeout(async () => {
      this.log.debug("Renewing aws credential.");
      await this.updateWebSocketCredentials(true);
      this.setUpdateCredentialTimer();
    }, timeout);
  }

  private async updateWebSocketCredentials(force = false): Promise<void> {
    if (
      force ||
      typeof this.#credential === "undefined" ||
      this.credentialExpired
    ) {
      await this.authenticate();
    }

    this.#connection?.updateWebSocketCredentials(
      this.#credential.AccessKeyId!,
      this.#credential.SecretKey!,
      this.#credential.SessionToken!,
      this.#credential.Expiration!,
    );
  }

  // https://doc.candyhouse.co/ja/SesameAPI
  private generateRandomTag(secret: string): string {
    // * key:key-secret_hex to data
    const key = Buffer.from(secret, "hex");

    // message
    // 1. timestamp  (SECONDS SINCE JAN 01 1970. (UTC))  // 1621854456905
    // 2. timestamp to uint32  (little endian)   //f888ab60
    // 3. remove most-significant byte    //0x88ab60
    const date = Math.floor(Date.now() / 1000);
    const dateDate = Buffer.allocUnsafe(4);
    dateDate.writeUInt32LE(date);
    const message = Buffer.from(dateDate.slice(1, 4));

    return aesCmac(key, message);
  }
}
