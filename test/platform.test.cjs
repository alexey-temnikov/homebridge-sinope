const test = require('node:test');
const assert = require('node:assert/strict');
const { SinopePlatform } = require('../dist/platform');
const { deviceKind } = require('../dist/types');
const { api, device, Accessory, hap, log, delay } = require('./helpers.cjs');

test('all deployed device classes and consecutive switches are recognized deterministically', () => {
  assert.deepEqual(['TH1123ZB', 'OTH3600', 'SW2500ZB', 'SW2500ZB', 'RM3250ZB', 'DM2500ZB', 'SP2600ZB', 'GT130'].map(sku => deviceKind({ ...device, sku })),
    ['thermostat', 'thermostat', 'switch', 'switch', 'switch', 'dimmer', 'outlet', undefined]);
  assert.equal(deviceKind({ ...device, parentDevice$id: null }), undefined);
});

test('discovery retains cached ownership/UUID, avoids duplicates, and refreshes device metadata', async () => {
  const a = api(); const p = new SinopePlatform(log, {}, a);
  const old = new Accessory('Thermostat', hap.uuid.generate(device.identifier)); old.context.device = device;
  p.configureAccessory(old);
  p.neviweb.login = async () => true;
  p.neviweb.fetchDevices = async () => [{ ...device, name: 'Updated' }, { ...device, name: 'Duplicate' }];
  await p.discoverDevices(); assert.equal(p.accessories.length, 1); assert.equal(a.registered.length, 0);
  assert.equal(old.UUID, hap.uuid.generate(device.identifier)); assert.equal(old.context.device.name, 'Updated');
  p.neviweb.logout = async () => true; await p.shutdown();
});

test('new devices register once in the deployed plugin namespace across rediscovery', async () => {
  const a = api(); const p = new SinopePlatform(log, {}, a);
  p.neviweb.login = async () => true; p.neviweb.fetchDevices = async () => [device];
  await p.discoverDevices(); await p.discoverDevices();
  assert.equal(a.registered.length, 1); assert.equal(a.registered[0].plugin, '@wfortin/homebridge-sinope');
  p.neviweb.logout = async () => true; await p.shutdown();
});

test('failed launch discovery is caught and shutdown cancels its retry timer', async () => {
  const a = api(); const p = new SinopePlatform(log, {}, a); p.neviweb.login = async () => { throw new Error('offline'); };
  a.emit('didFinishLaunching'); await delay(10);
  assert.ok(p.retry); p.neviweb.logout = async () => { throw new Error('offline'); };
  a.emit('shutdown'); await delay(10); assert.equal(p.retry, undefined);
});
