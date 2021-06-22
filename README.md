# homebridge-open-sesame

Homebridge plugin for SESAME3.  

## Install

```
npm install -g homebridge-open-sesame
```

## Configuration

### Configure with UI

Configure with [Homebridge Config UI X](https://github.com/oznu/homebridge-config-ui-x#readme) is recommended.

![config-ui](images/config-ui.png)

### Configure with config.json

```json
{
  "platforms": [
    {
      "platform": "OpenSesame",
      "name": "Open Sesame",
      "apiKey": "API_KEY from candyhouse developer site",
      "clientID": "CLIENT_ID from candyhouse developer site",
      "locks": [
        {
          "name": "Sesame device name",
          "uuid": "UUID from Sesame.app",
          "secret": "Key Secret"
        }
      ],
      "updateInterval": 60
    }
  ]
}
```
_Note_

- `updateInterval`: Update sesame status interval(second).

## Credits

- Cognito integration code based on [pysesame3](https://github.com/mochipon/pysesame3).
