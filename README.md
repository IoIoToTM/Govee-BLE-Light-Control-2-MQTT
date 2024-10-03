# Govee BLE Light Control 2 MQTT

This repository is for a simple node.js script that I created to connect to my Govee BLE lights (specifically H600D in my case), and control them via the specified MQTT broker, listening for commands to change the lights. It basically stays connected to the lights all the time because I realised that connecting to them every time I wanted to change the lights was very slow. This way, it's always connected and ready to receive commands.

I am running it on a Raspberry Pi Zero W, but it should work on any device that can run node.js and has BLE capabilities.

This wouldn't be possible without the help of [Universal-Govee-Bluetooth-control](https://github.com/Fefedu973/Universal-Govee-Bluetooth-control) for the initial code and [Govee-Reverse-Engineering](https://github.com/egold555/Govee-Reverse-Engineering) (specifically the information on [H6127](https://github.com/egold555/Govee-Reverse-Engineering/blob/master/Products/H6127.md)).

I am putting this here in case anyone else finds it useful and helpful. I am also not responsible for any damage to your devices or anything else that may happen as a result of using this code (although it should be safe to use).

## Installation and Usage

1. Clone the repository.
2. Run `npm install` to install the dependencies.
3. Edit the `example.devicesConfig.js` file in src to include your devices and rename it to `devicesConfig.js`.
4. Edit the `example.secrets.js` file in src to include your MQTT broker and rename it to `secrets.js`.
5. Add any devices you want to control to the `devices` array in `devicesConfig.js`. For some information on the different devices, check out [Govee-Reverse-Engineering](https://github.com/egold555/Govee-Reverse-Engineering).
6. Run `node src/lights.js` to start the script. This will connect to the lights and start listening for MQTT commands.



## Credits

- [Universal-Govee-Bluetooth-control](https://github.com/Fefedu973/Universal-Govee-Bluetooth-control) for the initial idea and starting code.
- [Govee-Reverse-Engineering](https://github.com/egold555/Govee-Reverse-Engineering) for the information on the Govee BLE protocol and the different reverse engineered devices.
- [Noble](https://github.com/abandonware/noble) for the BLE library.
- [MQTT.js](https://github.com/mqttjs/MQTT.js) for the MQTT library.
- ChatGPT and the AI overlords for the overall help with the code and deciphering the white light temperature commands.


## License

This project uses third-party libraries:

- **@abandonware/noble** is licensed under the MIT License.
- **mqtt** is licensed under the MIT License.

Please refer to the [LICENSE](LICENSE) file for more information.