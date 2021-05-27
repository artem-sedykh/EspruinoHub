/*
 * This file is part of EspruinoHub, a Bluetooth-MQTT bridge for
 * Puck.js/Espruino JavaScript Microcontrollers
 *
 * Copyright (C) 2016 Gordon Williams <gw@pur3.co.uk>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * ----------------------------------------------------------------------------
 *  Converts BLE advertising packets to MQTT
 * ----------------------------------------------------------------------------
 */

var noble;
try {
  noble = require("noble");
} catch (e) {
  noble = require("@abandonware/noble");
}
var mqtt            = require("./mqttclient");
var config          = require("./config");
var attributes      = require("./attributes");
const homeassistant = require("./homeassistant");
const util          = require("./util");

// List of BLE devices that are currently in range
var inRange             = {};
var packetsReceived     = 0;
var lastPacketsReceived = 0;
var scanStartTime       = Date.now();
var isScanning          = false;
var scanStopCallback    = null;
var stateCache          = {};

function log(x) {
  console.log("[Discover] " + x);
}

function IBeacon(peripheral) {
  const manufacturerData = peripheral.advertisement.manufacturerData;
  const uuid = manufacturerData.slice(4, 20).toString('hex');
  const major = manufacturerData.slice(20, 22).readUInt16BE(0);
  const minor = manufacturerData.slice(22, 24).readUInt16BE(0);
  const measuredPower = manufacturerData.slice(24, 25).readInt8(0);

  let tag = {
    uuid : `${uuid}-${major}-${minor}`.toLowerCase(),
    major: major,
    minor: minor,
    measuredPower: measuredPower
  }

  tag.distance = function(peripheral) {
    const rssi = peripheral.rssi;
    const txPower = tag.measuredPower;
    let distance = -1;
    if (rssi === 0) {
      return distance;
    }

    let ratio = rssi * 1 / txPower;
    if (ratio < 1.0) {
      distance = Math.pow(ratio, 10);
    } else {
      distance = (0.89976) * Math.pow(ratio, 7.7095) + 0.111;
    }

    distance = (parseInt((distance * 10).toString())) / 10;

    return distance;
  };

  return tag;
}

// ----------------------------------------------------------------------
var powerOnTimer;
if (config.ble_timeout > 0)
  powerOnTimer = setTimeout(function () {
    powerOnTimer = undefined;
    log("BLE broken? No Noble State Change to 'poweredOn' in " + config.ble_timeout + " seconds - restarting!");
    process.exit(1);
  }, config.ble_timeout * 1000)

function onStateChange(state) {
  log("Noble StateChange: " + state);
  if (state != "poweredOn") return;
  if (powerOnTimer) {
    clearTimeout(powerOnTimer);
    powerOnTimer = undefined;
  }
  // delay startup to allow Bleno to set discovery up
  setTimeout(function () {
    log("Starting scan...");
    noble.startScanning([], true);
  }, 1000);
};

function onDiscoveryIBeacon(peripheral) {
  packetsReceived++;

  const tag = IBeacon(peripheral);
  let id   = tag.uuid;
  const known_devices = config.bluetooth_low_energy.known_devices;
  let home = true;
  let distance = 0;

  if (tag.uuid in known_devices) {
    const known_device = known_devices[tag.uuid];
    id = known_device.name;
    let maxDistance = 0;

    if (known_device.hasOwnProperty('measured_power')) {
      tag.measuredPower = known_device.measured_power;
    }

    distance = tag.distance(peripheral);

    if (known_device.hasOwnProperty('max_distance') && known_device.max_distance > 0) {
      maxDistance = known_device.max_distance;
    }

    if (maxDistance > 0 && distance > maxDistance) {
      log( `detection distance exceeded! name: ${id} distance: ${distance}`);
      home = false;
    }

  } else {
    return;
  }

  const entered = !inRange[tag.uuid];
  const state = home ? "home" : "not_home";
  if (entered) {
    inRange[tag.uuid] = {
      id: id,
      address: tag.uuid,
      peripheral: peripheral,
      name: "?",
      data: {},
      tag: tag,
      ble: true
    };

    mqtt.send(`${config.mqtt_prefix}/device_tracker/ble-${id}-tracker/status`, "online", {retain: true});
    mqtt.send(`${config.mqtt_prefix}/device_tracker/ble-${id}-tracker/state`, state, {retain: true});
  }

  let mqttData = { distance: distance, rssi: peripheral.rssi, state: state };
  inRange[tag.uuid].lastSeen = Date.now();
  inRange[tag.uuid].rssi     = peripheral.rssi;

  mqtt.send(`${config.mqtt_prefix}/sensor/ble-${id}/attributes`, JSON.stringify(mqttData));
  mqtt.send(`${config.mqtt_prefix}/sensor/ble-${id}/status`, "online", {retain: true});
}

// ----------------------------------------------------------------------
function onDiscovery(peripheral) {

  if (util.isIBeacon(peripheral)) {
    onDiscoveryIBeacon(peripheral);
    return;
  }

  packetsReceived++;
  let addr = peripheral.address;
  let id   = addr;
  if (addr in config.known_devices) {
    id = config.known_devices[addr];
  } else {
    if (config.only_known_devices)
      return;
  }
  var entered = !inRange[addr];

  if (entered) {
    inRange[addr] = {
      id: id,
      address: addr,
      peripheral: peripheral,
      name: "?",
      data: {}
    };
    mqtt.send(config.mqtt_prefix + "/presence/" + id, "1", {retain: true});
  }
  const mqttData = {
    rssi: peripheral.rssi
  };

  if (peripheral.advertisement && peripheral.advertisement.localName) {
    mqttData.name      = peripheral.advertisement.localName;
    inRange[addr].name = peripheral.advertisement.localName;
  }

  if (peripheral.advertisement.serviceUuids)
    mqttData.serviceUuids = peripheral.advertisement.serviceUuids;
  inRange[addr].lastSeen = Date.now();
  inRange[addr].rssi     = peripheral.rssi;

  if (peripheral.advertisement.manufacturerData && config.mqtt_advertise_manufacturer_data) {
    var mdata = peripheral.advertisement.manufacturerData.toString("hex");

    // Include the entire raw string, incl. manufacturer, as hex
    mqttData.manufacturerData = mdata;
    mqtt.send(config.mqtt_prefix + "/advertise/" + id, JSON.stringify(mqttData));

    // First two bytes is the manufacturer code (little-endian)
    // re: https://www.bluetooth.com/specifications/assigned-numbers/company-identifiers
    var manu = mdata.slice(2, 4) + mdata.slice(0, 2);
    var rest = mdata.slice(4);

    // Split out the manufacturer specific data
    mqtt.send(config.mqtt_prefix + "/advertise/" + id + "/manufacturer/" + manu, JSON.stringify(rest));
    if (manu == "0590") {
      var str = "";
      for (var i = 0; i < rest.length; i += 2)
        str += String.fromCharCode(parseInt(rest.substr(i, 2), 16));
      var j;
      try {
        /* If we use normal JSON it'll complain about {a:1} because
        it's not {"a":1}. JSON5 won't do that */
        j = require("json5").parse(str);
        mqtt.send(config.mqtt_prefix + "/advertise/" + id + "/espruino", str);
        if ("object" == typeof j)
          for (var key in j)
            mqtt.send(config.mqtt_prefix + "/advertise/" + id + "/" + key, JSON.stringify(j[key]));
      } catch (e) {
        // it's not valid JSON, leave it
      }
    }
  } else if (config.mqtt_advertise) {
    // No manufacturer specific data
    mqtt.send(config.mqtt_prefix + "/advertise/" + id, JSON.stringify(mqttData));
  }

  if (config.mqtt_advertise) {
    mqtt.send(config.mqtt_prefix + "/advertise/" + id + "/rssi", JSON.stringify(peripheral.rssi));
  }

  peripheral.advertisement.serviceData.forEach(function (d) {
    /* Don't keep sending the same old data on MQTT. Only send it if
    it's changed or >1 minute old. */
    if (inRange[addr].data[d.uuid] &&
        inRange[addr].data[d.uuid].payload.toString() == d.data.toString() &&
        inRange[addr].data[d.uuid].time > Date.now() - 60000)
      return;

    if (config.mqtt_advertise_service_data) {
      // Send advertising data as a simple JSON array, eg. "[1,2,3]"
      const byteData = [];
      for (let i = 0; i < d.data.length; i++)
        byteData.push(d.data.readUInt8(i));
      mqtt.send(config.mqtt_prefix + "/advertise/" + id + "/" + d.uuid, JSON.stringify(byteData));
    }

    inRange[addr].data[d.uuid] = {payload: d.data, time: Date.now()};
    const decoded = attributes.decodeAttribute(d.uuid, d.data);

    if (decoded !== d.data) {
      decoded.rssi = peripheral.rssi;

      if (config.homeassistant) {
        homeassistant.configDiscovery(id, decoded, peripheral, d.uuid);
      }

      for (let k in decoded) {
        if (config.mqtt_advertise) {
          mqtt.send(`${config.mqtt_prefix}/advertise/${id}/${k}`, JSON.stringify(decoded[k]));
        }
        if (config.mqtt_format_decoded_key_topic) {
          mqtt.send(`${config.mqtt_prefix}/${id}/${k}`, JSON.stringify(decoded[k]));
        }
      }

      if (config.mqtt_format_json) {
        let state = decoded;
        if (stateCache[addr + d.uuid] !== undefined) {
          state = {...stateCache[addr + d.uuid], ...state};
        }
        stateCache[addr + d.uuid] = state;
        mqtt.send(`${config.mqtt_prefix}/json/${id}/${d.uuid}`, JSON.stringify(state));
      }
    }
  });
}

/** If a BLE device hasn't polled in for 60? seconds, emit a presence event */
function checkForPresence() {
  var timeout = Date.now() - config.presence_timeout * 1000;

  if (!isScanning || scanStartTime > timeout)
    return; // don't check, as we're not scanning/haven't had time

  Object.keys(inRange).forEach(function (addr) {
    if (inRange[addr].lastSeen < timeout) {
      if (inRange[addr].ble) {
        const id = inRange[addr].id;
        mqtt.send(`${config.mqtt_prefix}/device_tracker/ble-${id}-tracker/status`, "offline", {retain: true});
        mqtt.send(`${config.mqtt_prefix}/device_tracker/ble-${id}-tracker/state`, "not_home", {retain: true});
        mqtt.send(`${config.mqtt_prefix}/sensor/ble-${id}/status`, "offline", {retain: true});
        mqtt.send(`${config.mqtt_prefix}/sensor/ble-${id}/attributes`, JSON.stringify({ state: "not_home" }));
      }
      else{
        mqtt.send(config.mqtt_prefix + "/presence/" + inRange[addr].id, "0", {retain: true});
      }
      delete inRange[addr];
    }
  });
}

function checkIfBroken() {
  if (isScanning) {
    // If no packets for 10 seconds, restart
    if (packetsReceived == 0 && lastPacketsReceived == 0) {
      log("BLE broken? No advertising packets in " + config.ble_timeout + " seconds - restarting!");
      process.exit(1);
    }
  } else {
    packetsReceived = 1; // don't restart as we were supposed to not be advertising
  }
  lastPacketsReceived = packetsReceived;
  packetsReceived     = 0;
}

exports.init = function () {
  noble.on("stateChange", onStateChange);
  noble.on("discover", onDiscovery);
  noble.on("scanStart", function () {
    isScanning    = true;
    scanStartTime = Date.now();
    log("Scanning started.");
  });
  noble.on("scanStop", function () {
    isScanning = false;
    log("Scanning stopped.");
    if (scanStopCallback) {
      scanStopCallback();
      scanStopCallback = undefined;
    }
  });

  setInterval(checkForPresence, 1000);

  if (config.ble_timeout > 0)
    setInterval(checkIfBroken, config.ble_timeout * 1000);
};

exports.inRange = inRange;

exports.restartScan = function () {
  if (!isScanning) {
    log("Restarting scan");
    noble.startScanning([], true);
  } else {
    log("restartScan: already scanning!");
  }
}

exports.stopScan = function (callback) {
  if (isScanning) {
    scanStopCallback = callback;
    noble.stopScanning();
  } else if (callback) callback();
}

/// Send up to date presence data for all known devices over MQTT (to be done when first connected to MQTT)
exports.sendMQTTPresence = function () {
  log("Re-sending presence status of known devices");
  for (var addr in inRange) {
    mqtt.send(config.mqtt_prefix + "/presence/" + inRange[addr].id, "1", {retain: true});
  }
  for (var addr in config.known_devices) {
    mqtt.send(config.mqtt_prefix + "/presence/" + config.known_devices[addr], (addr in inRange) ? "1" : "0", {retain: true});
  }
};
