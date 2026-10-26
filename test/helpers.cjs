const hap = require('@homebridge/hap-nodejs');
const { EventEmitter } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { SinopeAccessory } = require('../dist/platformAccessory');
const logs = [];
const log = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(k => [k, (...args) => logs.push(args)]));
class Accessory extends hap.Accessory {
  constructor(name, uuid) { super(name, uuid); this.context = {}; }
}
const device = { id: 1, identifier: 'test-device-1', name: 'Thermostat', sku: 'TH1123ZB', vendor: 'Sinope', parentDevice$id: 10 };
const state = { roomTemperature: { value: 19.5 }, roomSetpoint: 6.5, outputPercentDisplay: 20, setpointMode: 'manual', systemMode: 'heat' };
function api() {
  const a = new EventEmitter();
  a.hap = hap; a.platformAccessory = Accessory;
  a.registered = []; a.updated = [];
  a.registerPlatformAccessories = (plugin, platform, list) => a.registered.push({ plugin, platform, list });
  a.updatePlatformAccessories = list => a.updated.push(list);
  return a;
}
function fixture(t, { kind = 'thermostat', sku = device.sku, read = async () => kind === 'thermostat' ? state : { onOff: 'on', intensity: 42 }, write = async () => ({}) } = {}) {
  const a = api();
  const calls = [];
  const p = { api: a, log, config: { pollInterval: 60 }, Service: hap.Service, Characteristic: hap.Characteristic,
    neviweb: { fetchThermostat: read, fetchSwitch: read, fetchDimmer: read,
      updateDevice: async (...args) => { calls.push(args); return write(...args); } } };
  const accessory = new Accessory(device.name, hap.uuid.generate(device.identifier)); accessory.context.device = device;
  const handler = new SinopeAccessory(p, accessory, { ...device, sku }, kind);
  t.after(() => handler.dispose());
  return { handler, accessory, platform: p, calls, c: name => handler.service.getCharacteristic(hap.Characteristic[name]) };
}
module.exports = { hap, api, Accessory, device, state, fixture, log, logs, delay };
