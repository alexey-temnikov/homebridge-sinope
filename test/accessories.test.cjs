const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, delay, state, hap, Accessory, device, api, log } = require('./helpers.cjs');
const { SinopeAccessory } = require('../dist/platformAccessory');
const unavailable = hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE;

test('40 concurrent HomeKit reads share a single cloud fetch and allow 6.5 C frost setpoints', async t => {
  let reads = 0;
  const f = fixture(t, { read: async () => { reads++; await delay(40); return state; } });
  const values = await Promise.all(Array.from({ length: 40 }, () => f.c('TargetTemperature').handleGetRequest()));
  assert.equal(reads, 1); assert.deepEqual(new Set(values), new Set([6.5]));
  assert.equal(f.c('TargetTemperature').props.minValue, 5);
});

test('concurrent rejected cloud reads report HomeKit unavailable without unhandled rejections or fake zero values', async t => {
  let reads = 0;
  const f = fixture(t, { read: async () => { reads++; await delay(20); throw new Error('async-lock timed out in queue state'); } });
  const results = await Promise.allSettled(Array.from({ length: 30 }, () => f.c('CurrentTemperature').handleGetRequest()));
  assert.ok(results.every(r => r.status === 'rejected' && r.reason === unavailable));
  await assert.rejects(f.c('CurrentTemperature').handleGetRequest(), e => e === unavailable);
  assert.equal(reads, 1); await delay(20); // strict test runner catches stray rejections
});

for (const [label, raw] of [
  ['missing temperature', { ...state, roomTemperature: undefined }],
  ['missing setpoint', { ...state, roomSetpoint: undefined }],
  ['NaN', { ...state, roomSetpoint: NaN }],
  ['invalid output', { ...state, outputPercentDisplay: 200 }],
  ['unknown mode', { ...state, setpointMode: 'unexpected', systemMode: 'unexpected' }],
]) {
  test(`invalid telemetry (${label}) is unavailable, not cached as healthy`, async t => {
    const f = fixture(t, { read: async () => raw });
    await assert.rejects(f.c('CurrentTemperature').handleGetRequest(), e => e === unavailable);
  });
}

test('heating state supports the structured outputPercentDisplay form', async t => {
  const f = fixture(t, { read: async () => ({ ...state, outputPercentDisplay: { percent: 75 } }) });
  assert.equal(await f.c('CurrentHeatingCoolingState').handleGetRequest(), 1);
});

test('failed SET reports unavailable and never reports successful heating control', async t => {
  const f = fixture(t, { write: async () => { throw new Error('cloud timeout'); } });
  await assert.rejects(f.c('TargetTemperature').handleSetRequest(20), e => e === unavailable);
  assert.equal(f.calls.length, 1);
});

test('successful SET invalidates the cache and subsequent read observes cloud state', async t => {
  let current = { ...state };
  const f = fixture(t, { read: async () => current, write: async (_id, body) => { current = { ...current, ...body }; } });
  assert.equal(await f.c('TargetTemperature').handleGetRequest(), 6.5);
  await f.c('TargetTemperature').handleSetRequest(20);
  assert.equal(await f.c('TargetTemperature').handleGetRequest(), 20);
  assert.deepEqual(f.calls[0][1], { roomSetpoint: 20 });
});

test('heat, off, and automatic mode map to distinct cloud modes; cooling is unsupported', async t => {
  const f = fixture(t, { sku: 'TH1123WF' });
  for (const mode of [0, 1, 3]) { await f.c('TargetHeatingCoolingState').handleSetRequest(mode); }
  assert.deepEqual(f.calls.map(c => c[1]), [{ setpointMode: 'off' }, { setpointMode: 'manual' }, { setpointMode: 'auto' }]);
  assert.ok(!f.c('TargetHeatingCoolingState').props.validValues.includes(2));
});

test('HomeKit display units are a stored preference and never change physical thermostat settings', async t => {
  const f = fixture(t);
  await f.c('TemperatureDisplayUnits').handleSetRequest(1);
  assert.equal(await f.c('TemperatureDisplayUnits').handleGetRequest(), 1); assert.equal(f.calls.length, 0);
});

test('switch publishes On instead of adding an invalid OutletInUse characteristic', async t => {
  const f = fixture(t, { kind: 'switch' });
  assert.equal(await f.c('On').handleGetRequest(), true);
  assert.ok(!f.handler.service.characteristics.some(c => c.UUID === hap.Characteristic.OutletInUse.UUID));
  await f.c('On').handleSetRequest(false); assert.deepEqual(f.calls[0][1], { onOff: 'off' });
});

test('outlet reuses the cached service without duplicate UUID errors', async t => {
  const a = api();
  const accessory = new Accessory('Outlet', hap.uuid.generate('cached-outlet')); accessory.context.device = device;
  accessory.addService(hap.Service.Outlet);
  const p = { api: a, log, config: {}, Service: hap.Service, Characteristic: hap.Characteristic,
    neviweb: { fetchSwitch: async () => ({ onOff: 'on' }) } };
  const h = new SinopeAccessory(p, accessory, device, 'outlet'); t.after(() => h.dispose());
  assert.equal(accessory.services.filter(s => s.UUID === hap.Service.Outlet.UUID).length, 1);
  await assert.rejects(h.service.getCharacteristic(hap.Characteristic.OutletInUse).handleGetRequest(), e => e === unavailable);
});

test('dimmer brightness is validated and sends exactly one PUT', async t => {
  const f = fixture(t, { kind: 'dimmer' });
  assert.equal(await f.c('Brightness').handleGetRequest(), 42);
  await f.c('Brightness').handleSetRequest(55);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0][1], { intensity: 55 });
});

test('shutdown disables handler writes and cleans its poll timer', async t => {
  const f = fixture(t); f.handler.dispose();
  await assert.rejects(f.c('TargetTemperature').handleSetRequest(20), e => e === unavailable);
  assert.equal(f.calls.length, 0);
});

test('Zigbee mode reads/writes use systemMode and do not invent scheduled/cooling support', async t => {
  const f = fixture(t, { read: async () => ({ roomTemperature: { value: 21.12 }, roomSetpoint: 7.5, outputPercentDisplay: 0, systemMode: 'heat' }) });
  assert.equal(await f.c('TargetHeatingCoolingState').handleGetRequest(), 1);
  assert.deepEqual(f.c('TargetHeatingCoolingState').props.validValues, [0, 1]);
  await f.c('TargetHeatingCoolingState').handleSetRequest(0);
  await f.c('TargetHeatingCoolingState').handleSetRequest(1);
  assert.deepEqual(f.calls.map(c => c[1]), [{ systemMode: 'off' }, { systemMode: 'heat' }]);
});
