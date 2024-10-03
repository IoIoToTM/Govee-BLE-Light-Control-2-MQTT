const noble = require('@abandonware/noble');
const mqtt = require('mqtt');
const products = require('./devices');
const devicesConfig = require('./devicesConfig');
const secrets = require('./secrets');

let devices = {}; // Object to hold device instances
let connectingDevices = new Set(); // Set to keep track of devices being connected
let pendingConnections = [];
let isConnecting = false;
let isScanning = false;

// MQTT client setup
const mqttClient = mqtt.connect(secrets.server, {
    username: secrets.username,
    password: secrets.password
});
mqttClient.on('connect', () => {
    console.log('Connected to MQTT broker');
    // Discovery messages will be published after devices are connected
});

mqttClient.on('message', (topic, message) => {
    const payload = message.toString();
    const topicParts = topic.split('/');
    const deviceId = topicParts[2];
    let commandType;
    let action;

    if (topicParts.length === 4) {
        commandType = topicParts[3]; // 'set' for on/off
    } else if (topicParts.length === 5) {
        commandType = topicParts[3]; // 'brightness' or 'color'
        action = topicParts[4]; // 'set'
    } else {
        console.log(`Unknown topic format: ${topic}`);
        return;
    }

    const device = devices[deviceId];
    if (!device) {
        console.log(`Unknown device ID: ${deviceId}`);
        return;
    }

    if (commandType === 'set' && !action) {
        // Handle power on/off
        if (payload === 'ON') {
            powerOn(device.productData, device.characteristic);
            mqttClient.publish(`home/lights/${deviceId}/state`, 'ON', { retain: true });
        } else if (payload === 'OFF') {
            powerOff(device.productData, device.characteristic);
            mqttClient.publish(`home/lights/${deviceId}/state`, 'OFF', { retain: true });
        }
    } else if (commandType === 'brightness' && action === 'set') {
        // Handle brightness
        const brightnessValue = parseInt(payload, 10);
        brightness(device.productData, device.characteristic, brightnessValue);
        mqttClient.publish(`home/lights/${deviceId}/brightness/state`, payload, { retain: true });
    } else if (commandType === 'color' && action === 'set') {
        // Handle color
        const colorValues = payload.split(',').map(v => parseInt(v, 10));
        if (colorValues.length !== 3) {
            console.log(`Invalid color payload: ${payload}`);
            return;
        }
        const [red, green, blue] = colorValues;
        changeDeviceColor(device.productData, device.characteristic, red, green, blue);
        mqttClient.publish(`home/lights/${deviceId}/color/state`, payload, { retain: true });
    } else if (commandType === 'color_temp' && action === 'set') {
        // Handle color temperature
        const miredValue = parseInt(payload, 10);
        let colorTemp = Math.round(1000000 / miredValue);
        // Clamp the color temperature between 2700K and 6500K
        colorTemp = Math.max(2700, Math.min(colorTemp, 6500));
        changeDeviceColorTemperature(device.productData, device.characteristic, colorTemp);
        mqttClient.publish(`home/lights/${deviceId}/color_temp/state`, payload, { retain: true });
    } else {
        console.log(`Unknown command type: ${commandType}`);
    }
});

// Start scanning for BLE devices
noble.on('stateChange', function (state) {
    console.log('State changed: ' + state);
    if (state === 'poweredOn') {
        noble.startScanning([], true);
    } else {
        noble.stopScanning();
    }
});

noble.on('scanStart', function () {
    isScanning = true;
    console.log('Scanning started.');
});

noble.on('scanStop', function () {
    isScanning = false;
    console.log('Scanning stopped.');
});

function startScanning() {
    if (!isScanning) {
        noble.startScanning([], true);
    }
}

noble.on('discover', function (peripheral) {
    const deviceConfig = devicesConfig.find(config => config.address === peripheral.address);
    if (!deviceConfig) return;

    if (devices[deviceConfig.unique_id] || connectingDevices.has(deviceConfig.unique_id)) return;

    const supportedProduct = Object.keys(products).find(product =>
        peripheral.advertisement.localName.includes(products[product].deviceName)
    );
    if (!supportedProduct) return;

    console.log(`Found device: ${deviceConfig.name} (${peripheral.address})`);

    connectingDevices.add(deviceConfig.unique_id);
    pendingConnections.push({ peripheral, deviceConfig, supportedProduct });
    processConnectionQueue();
});

function processConnectionQueue() {
    if (isConnecting || pendingConnections.length === 0) {
        return;
    }

    isConnecting = true;
    const { peripheral, deviceConfig, supportedProduct } = pendingConnections.shift();
    const productData = products[supportedProduct];

    // Set a timeout for the connection attempt
    const connectionTimeout = setTimeout(() => {
        console.log(`Connection timeout for ${deviceConfig.name}`);
        peripheral.disconnect();
        connectingDevices.delete(deviceConfig.unique_id);
        isConnecting = false;
        processConnectionQueue();
        startScanning(); // Start scanning again
    }, 10000); // 10 seconds timeout

    peripheral.connect(function (error) {
        clearTimeout(connectionTimeout);
        if (error) {
            console.log(`Error connecting to ${deviceConfig.name}:`, error);
            connectingDevices.delete(deviceConfig.unique_id);
            isConnecting = false;
            processConnectionQueue();
            startScanning(); // Start scanning again
            return;
        }
        console.log(`Connected to ${deviceConfig.name}`);

        // Proceed with service and characteristic discovery...
        peripheral.discoverServices([productData.ServiceUUID], function (error, services) {
            if (error) {
                console.log(`Error discovering services for ${deviceConfig.name}:`, error);
                peripheral.disconnect();
                connectingDevices.delete(deviceConfig.unique_id);
                isConnecting = false;
                processConnectionQueue();
                startScanning(); // Start scanning again
                return;
            }

            const service = services[0];
            service.discoverCharacteristics(
                [productData.WriteCharacteristicUUID, productData.ReadCharacteristicUUID],
                function (error, characteristics) {
                    if (error) {
                        console.log(`Error discovering characteristics for ${deviceConfig.name}:`, error);
                        peripheral.disconnect();
                        connectingDevices.delete(deviceConfig.unique_id);
                        isConnecting = false;
                        processConnectionQueue();
                        startScanning(); // Start scanning again
                        return;
                    }

                    const writeCharacteristic = characteristics.find(
                        char => char.uuid === productData.WriteCharacteristicUUID
                    );

                    if (!writeCharacteristic) {
                        console.log(`Write characteristic not found for ${deviceConfig.name}`);
                        peripheral.disconnect();
                        connectingDevices.delete(deviceConfig.unique_id);
                        isConnecting = false;
                        processConnectionQueue();
                        startScanning(); // Start scanning again
                        return;
                    }

                    // Save device info
                    devices[deviceConfig.unique_id] = {
                        peripheral,
                        productData,
                        characteristic: writeCharacteristic,
                        config: deviceConfig
                    };

                    connectingDevices.delete(deviceConfig.unique_id);

                    // Publish MQTT discovery message
                    publishMQTTDiscovery(deviceConfig);

                    // Subscribe to command topics
                    mqttClient.subscribe(`home/lights/${deviceConfig.unique_id}/set`);
                    mqttClient.subscribe(`home/lights/${deviceConfig.unique_id}/brightness/set`);
                    mqttClient.subscribe(`home/lights/${deviceConfig.unique_id}/color/set`);
                    mqttClient.subscribe(`home/lights/${deviceConfig.unique_id}/color_temp/set`);

                    // Start keep-alive
                    startKeepAliveLoop(deviceConfig.unique_id);

                    // Handle disconnects
                    peripheral.on('disconnect', () => {
                        console.log(`${deviceConfig.name} disconnected`);
                        delete devices[deviceConfig.unique_id];
                        connectingDevices.delete(deviceConfig.unique_id);
                        // Re-add device to the queue for reconnection
                        pendingConnections.push({ peripheral, deviceConfig, supportedProduct });
                        processConnectionQueue();
                        startScanning(); // Start scanning again
                    });

                    isConnecting = false;
                    processConnectionQueue(); // Proceed to the next device
                    startScanning(); // Start scanning again
                }
            );
        });
    });
}

function publishMQTTDiscovery(deviceConfig) {
    const discoveryPayload = {
        name: "", //leaving this empty because home assistant otherwise duplicates the name
        unique_id: deviceConfig.unique_id,
        command_topic: `home/lights/${deviceConfig.unique_id}/set`,
        state_topic: `home/lights/${deviceConfig.unique_id}/state`,
        brightness_command_topic: `home/lights/${deviceConfig.unique_id}/brightness/set`,
        brightness_state_topic: `home/lights/${deviceConfig.unique_id}/brightness/state`,
        rgb_command_topic: `home/lights/${deviceConfig.unique_id}/color/set`,
        rgb_state_topic: `home/lights/${deviceConfig.unique_id}/color/state`,
        color_temp_command_topic: `home/lights/${deviceConfig.unique_id}/color_temp/set`,
        color_temp_state_topic: `home/lights/${deviceConfig.unique_id}/color_temp/state`,
        payload_on: 'ON',
        payload_off: 'OFF',
        brightness_scale: 100,
        supported_color_modes: ['rgb', 'color_temp'],
        min_mireds: 153, // Corresponds to 6500K
        max_mireds: 370, // Corresponds to 2700K
        device: {
            identifiers: [deviceConfig.unique_id],
            name: deviceConfig.name,
            manufacturer: 'Govee',
            model: 'GU10'
        }
    };

    mqttClient.publish(`homeassistant/light/${deviceConfig.unique_id}/config`, JSON.stringify(discoveryPayload), { retain: true });
}

function startKeepAliveLoop(deviceId) {
    const device = devices[deviceId];
    if (!device) return;

    const { productData, characteristic, peripheral } = device;

    const sendKeepAlive = () => {
        keepAlive(productData, characteristic);
    };

    sendKeepAlive();
    const intervalId = setInterval(sendKeepAlive, 2000);

    peripheral.once('disconnect', () => {
        clearInterval(intervalId);
    });
}

function sendCommand(characteristic, command) {
    characteristic.write(Buffer.from(command), true, function (error) {
        if (error) {
            console.log('Error writing to characteristic: ' + error);
        }
    });
}

function powerOn(productData, characteristic) {
    const powerCommand = productData.commands.power;
    const onValue = powerCommand.on;
    const commandData = powerCommand.data.map(item => (item === 'state' ? onValue : item));

    const checksum = commandData.reduce((acc, byte) => acc ^ byte, 0);
    const checksumIndex = commandData.indexOf('checksum');
    if (checksumIndex !== -1) {
        commandData[checksumIndex] = checksum;
    }

    sendCommand(characteristic, commandData);
}

function powerOff(productData, characteristic) {
    const powerCommand = productData.commands.power;
    const offValue = powerCommand.off;
    const commandData = powerCommand.data.map(item => (item === 'state' ? offValue : item));

    const checksum = commandData.reduce((acc, byte) => acc ^ byte, 0);
    const checksumIndex = commandData.indexOf('checksum');
    if (checksumIndex !== -1) {
        commandData[checksumIndex] = checksum;
    }

    sendCommand(characteristic, commandData);
}

function brightness(productData, characteristic, brightnessPercentage) {
    const brightnessCommand = productData.commands.brightness;
    const min = brightnessCommand.min;
    const max = brightnessCommand.max;
    const brightnessValue = Math.round(((max - min) * brightnessPercentage) / 100 + min);

    const commandData = brightnessCommand.data.map(item => (item === 'brightness' ? brightnessValue : item));

    const checksum = commandData.reduce((acc, byte) => acc ^ byte, 0);
    const checksumIndex = commandData.indexOf('checksum');
    if (checksumIndex !== -1) {
        commandData[checksumIndex] = checksum;
    }

    sendCommand(characteristic, commandData);
}

function changeDeviceColor(productData, characteristic, redValue, greenValue, blueValue) {
    const colorCommand = productData.commands.colors;
    const commandData = colorCommand.data.map(item => {
        if (item === 'red') {
            return redValue;
        } else if (item === 'green') {
            return greenValue;
        } else if (item === 'blue') {
            return blueValue;
        } else {
            return item;
        }
    });

    // Calculate XOR checksum
    let checksum = 0;
    for (const byte of commandData) {
        checksum ^= byte;
    }

    // Replace 'checksum' in the array with the calculated checksum
    const checksumIndex = commandData.indexOf('checksum');
    if (checksumIndex !== -1) {
        commandData[checksumIndex] = checksum;
    }

    sendCommand(characteristic, commandData);
}

function changeDeviceColorTemperature(productData, characteristic, colorTemp) {
    // Split the color temperature into high and low bytes (big-endian)
    const tempHighByte = (colorTemp >> 8) & 0xFF;
    const tempLowByte = colorTemp & 0xFF;

    const commandData = productData.commands.colorTemperature.data.map(item => {
        switch (item) {
            case 'temp_high_byte':
                return tempHighByte;
            case 'temp_low_byte':
                return tempLowByte;
            default:
                return item;
        }
    });

    // Calculate XOR checksum
    let checksum = commandData.slice(0, -1).reduce((acc, byte) => acc ^ byte, 0);

    // Set the checksum
    commandData[commandData.length - 1] = checksum;

    sendCommand(characteristic, commandData);
}


function keepAlive(productData, characteristic) {
    const keepAliveCommand = productData.commands.keepAlive;
    sendCommand(characteristic, keepAliveCommand.data);
}