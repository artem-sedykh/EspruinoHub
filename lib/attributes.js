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
 *  Known Attributes and conversions for them
 * ----------------------------------------------------------------------------
 */

var config = require("./config");
const util = require("./util");

const xiaomiProductName = {
  0x005d: "HHCCPOT002",
  0x0098: "HHCCJCY01",
  0x01d8: "Stratos",
  0x02df: "JQJCY01YM",
  0x03b6: "YLKG08YL",
  0x03bc: "GCLS002",
  0x040a: "WX08ZM",
  0x045b: "LYWSD02",
  0x055b: "LYWSD03MMC",
  0x0576: "CGD1",
  0x0347: "CGG1",
  0x01aa: "LYWSDCGQ",
  0x03dd: "MUE4094RT",
  0x07f6: "MJYD02YLA",
  0x0387: "MHOC401",
  0x0113: "YM-K1501EU"
}

function parseXiaomiValue(type, data, length, r) {
  switch (type) {
    case '5-16': {
      r.switch = !!data[0];
      r.temp = data[1];
      break;
    }
    case 0x04: { // temperature, 2 bytes, 16-bit signed integer (LE)
      let temp = data[1] << 8 | data[0];
      if (temp & 0x8000) temp -= 0x10000;
      r.temp = temp / 10;
      break;
    }
    case 0x06: { // humidity, 2 bytes, 16-bit signed integer (LE)
      r.humidity = (data[1] << 8 | data[0]) / 10;
      break;
    }
    case 0x0a: { // battery, 1 byte, 8-bit unsigned integer
      r.battery = data[0];
      break;
    }
    case 0x0d: { // temperature+humidity, 4 bytes, 16-bit signed integer (LE)
      let temp = data[1] << 8 | data[0];
      if (temp & 0x8000) temp -= 0x10000;
      r.temp     = temp / 10;
      r.humidity = (data[3] << 8 | data[2]) / 10;
      break;
    }
    case 0x09: {  // conductivity, 2 bytes, 16-bit unsigned integer (LE), 1 µS/cm
      if (length !== 2) break;
      r.conductivity = data[1] << 8 | data[0];
      break;
    }
    case 0x07: {  // illuminance, 3 bytes, 24-bit unsigned integer (LE), 1 lx
      if (length !== 3) break;
      r.illuminance = data[2] << 16 | data[1] << 8 | data[0];
      break;
    }
    case 0x08: {  // soil moisture, 1 byte, 8-bit unsigned integer, 1 %
      if (length !== 1) break;
      r.moisture = data[0];
      break;
    }
  }
}

exports.names = {
  // https://www.bluetooth.com/specifications/gatt/services/
  "1801": "Generic Attribute",
  "1809": "Temperature",
  "180a": "Device Information",
  "180f": "Battery Service",
  // https://github.com/atc1441/ATC_MiThermometer#advertising-format-of-the-custom-firmware
  "181a": "ATC_MiThermometer",
  "181b": "Body Composition",
  "181c": "User Data",
  "181d": "Weight Scale",
  // https://www.bluetooth.com/specifications/gatt/characteristics/
  "2a2b": "Current Time",
  "2a6d": "Pressure",
  "2a6e": "Temperature",
  "2a6f": "Humidity",
  // https://www.bluetooth.com/specifications/assigned-numbers/16-bit-uuids-for-members/
  "fe0f": "Philips",
  "fe95": "Xiaomi",
  "fe9f": "Google",
  "feaa": "Google Eddystone",

  "6e400001b5a3f393e0a9e50e24dcca9e": "nus",
  "6e400002b5a3f393e0a9e50e24dcca9e": "nus_tx",
  "6e400003b5a3f393e0a9e50e24dcca9e": "nus_rx"
};

exports.handlers = {
  "1809": function (a) { // Temperature
    var t = (a.length == 2) ? (((a[1] << 8) + a[0]) / 100) : a[0];
    if (t >= 128) t -= 256;
    return {temp: t}
  },
  "180f": function (a) { // Battery percent
    return {
      battery: a[0]
    }
  },
  "181a": function (a) { // ATC_MiThermometer
    if (a.length >= 15) { // pvvx
      let voltage = a.readUInt16LE(10);
      return {
        temp: a.readUInt16LE(6) / 100,
        humidity: a.readUInt16LE(8) / 100,
        battery_voltage: voltage > 1000 ? voltage / 1000 : voltage,
        battery: a.readUInt8(12),
        counter: a.readUInt8(13),
        flg: a.readUInt8(14)
      }
    } else if (a.length === 13) {
      return {
        temp: (a[7] | (a[6] << 8)) / 10,
        humidity: a[8],
        battery: a[9],
        battery_voltage: (a[11] | (a[10] << 8)) / 1000
      }
    }
  },
  "181b": function (a) { // Xiaomi V2 Scale
    let unit;
    let weight = a.readUInt16LE(a.length - 2) / 100;
    if ((a[0] & (1 << 4)) !== 0) { // Chinese Catty
      unit = "jin";
    } else if ((a[0] & 0x0F) === 0x03) { // Imperial pound
      unit = "lbs";
    } else if ((a[0] & 0x0F) === 0x02) { // MKS kg
      unit   = "kg";
      weight = weight / 2;
    } else {
      unit = "???"
    }
    const state = {
      isStabilized: ((a[1] & (1 << 5)) !== 0),
      loadRemoved: ((a[1] & (1 << 7)) !== 0),
      impedanceMeasured: ((a[1] & (1 << 1)) !== 0)
    };

    const measurements = {
      weight: util.toFixedFloat(weight, 2),
      unit,
      impedance: a.readUInt16LE(a.length - 4)
    };
    return {...measurements, ...state};
  },
  "181d": function (a) { // Xiaomi V1 Scale
    let unit;
    let weight = a.readUInt16LE(1) * 0.01;
    // status byte:
    //- Bit 0: lbs unit
    //- Bit 1-3: unknown
    //- Bit 4: jin unit
    //- Bit 5: stabilized
    //- Bit 6: unknown
    //- Bit 7: weight removed
    let status = [];
    for (let i = 0; i <= 7; i++) {
      status.push(a[0] & (1 << i) ? 1 : 0)
    }

    if (status[0] === 1) {
      unit = "lbs";
    } else if (status[4] === 1) {
      unit = "jin";
    } else {
      unit   = "kg";
      weight = weight / 2;
    }

    const state = {
      isStabilized: (status[5] !== 0),
      loadRemoved: (status[7] !== 0)
    };

    const date = {
      year: a.readUInt16LE(3),
      month: a.readUInt8(5),
      day: a.readUInt8(6),
      hour: a.readUInt8(7),
      minute: a.readUInt8(8),
      second: a.readUInt8(9)
    }
    return {weight: util.toFixedFloat(weight, 2), unit, ...state, ...date};
  },
  "fe95": function (d) {
    var frameControl = (d[1] << 8) + d[0];
    var productId    = (d[3] << 8) + d[2];
    var counter      = d[4];
    var r            = {
      frameControl: frameControl,
      productId: productId,
      counter: counter
    };
    if (xiaomiProductName[productId] !== undefined) r.productName = xiaomiProductName[productId];

    const rawOffset  = productId === 0x01aa || productId === 0x055b ? 11 : 12;
    const dataType   = productId == 0x0113? d.slice(rawOffset, rawOffset + 2).join('-'): d[rawOffset];
    const dataLength = d[rawOffset + 2];
    const data       = d.slice(rawOffset + 3);

    parseXiaomiValue(dataType, data, dataLength, r);
    return r;
  },
  "fee0": function (d) {
    let r = {steps: (0xff & d[0] | (0xff & d[1]) << 8)};
    if (d.length === 5)
      r.heartRate = d[4];
    return r;
  },
  "feaa": function (d) { // Eddystone
    if (d[0] == 0x10) { // URL
      var rssi = d[1];
      if (rssi & 128) rssi -= 256; // signed number
      var urlType   = d[2];
      var URL_TYPES = [
        "http://www.",
        "https://www.",
        "http://",
        "https://"];
      var url       = URL_TYPES[urlType] || "";
      for (var i = 3; i < d.length; i++)
        url += String.fromCharCode(d[i]);
      return {url: url, "rssi@1m": rssi};
    }
  },
  "2a6d": function (a) { // Pressure in pa
    return {pressure: ((a[1] << 24) + (a[1] << 16) + (a[1] << 8) + a[0]) / 10}
  },
  "2a6e": function (a) { // Temperature in C
    var t = ((a[1] << 8) + a[0]) / 100;
    if (t >= 128) t -= 256;
    return {temp: t}
  },
  "2a6f": function (a) { // Humidity
    return {humidity: ((a[1] << 8) + a[0]) / 100}
  },
  "2a06": function (a) { // org.bluetooth.characteristic.alert_level
    // probably not meant for advertising, but seems useful!
    return {alert: a[0]}
  },
  "2a56": function (a) { // org.bluetooth.characteristic.digital
    // probably not meant for advertising, but seems useful!
    return {digital: a[0]!=0}
  },
  "2a58": function (a) { // org.bluetooth.characteristic.analog
    // probably not meant for advertising, but seems useful!
    return {analog: a[0] | (a.length>1 ? (a[1]<<8) : 0)}
  },
  // org.bluetooth.characteristic.digital_output	0x2A57 ?
  "ffff": function (a) { // 0xffff isn't standard anything - just transmit it as 'data'
    if (a.length == 1)
      return {data: a[0]};
    return {data: Array.prototype.slice.call(a, 0).join(",")}
  }
};

exports.getReadableAttributeName = function (attr) {
  for (var i in exports.names)
    if (exports.names[i] == attr) return i;
  return attr;
};

exports.decodeAttribute = function (name, value) {
  // built-in decoders
  if (name in exports.handlers) {
    var r = exports.handlers[name](value);
    return r ? r : value;
  }

  // use generic decoder for known services
  if (name in exports.names) {
    var obj                  = {};
    obj[exports.names[name]] = value;
    return obj;
  }

  // look up decoders in config.json
  if (name in config.advertised_services) {
    var srv       = config.advertised_services[name];
    var obj       = {};
    obj[srv.name] = value[0];
    return obj;
  }
  // otherwise as-is
  return value;
};

exports.lookup = function (attr) {
  for (var i in exports.names)
    if (exports.names[i] == attr) return i;
  return attr;
};
