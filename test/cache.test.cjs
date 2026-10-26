const test = require('node:test');
const assert = require('node:assert/strict');
const { StateCache, CommandQueue } = require('../dist/state-cache');
const { delay } = require('./helpers.cjs');

test('refresh failures are not cached as successful fabricated device values', async () => {
  let calls = 0;
  const cache = new StateCache(async () => { calls++; throw new Error('offline'); });
  await Promise.all(Array.from({ length: 20 }, () => assert.rejects(cache.get())));
  assert.equal(calls, 1);
  await assert.rejects(cache.get()); assert.equal(calls, 1);
  cache.invalidate(); await assert.rejects(cache.get()); assert.equal(calls, 2);
});

test('a read started before a write cannot fill the post-write cache', async () => {
  let release, calls = 0;
  const cache = new StateCache(() => ++calls === 1 ? new Promise(r => { release = r; }) : Promise.resolve(20));
  const first = cache.get(); await delay(1);
  cache.invalidate(); const second = cache.get(); release(6);
  assert.equal(await first, 6); assert.equal(await second, 20); assert.equal(await cache.get(), 20);
});

test('writes execute serially and one failure does not deadlock the queue', async () => {
  const queue = new CommandQueue(); const order = [];
  await Promise.allSettled([
    queue.run(async () => { order.push(1); await delay(20); order.push(2); throw new Error('fail'); }),
    queue.run(async () => { order.push(3); }),
  ]);
  assert.deepEqual(order, [1, 2, 3]);
});

test('queued commands expire promptly and are never replayed later', async () => {
  const queue = new CommandQueue(); let writes = 0;
  const first = queue.run(async () => { await delay(80); writes++; });
  await assert.rejects(queue.run(async () => { writes++; }, 10), /expired/);
  await first; await delay(10); assert.equal(writes, 1);
  await queue.run(async () => { writes++; }); assert.equal(writes, 2);
});

test('write queue bounds pending commands under a HomeKit request flood', async () => {
  const q = new CommandQueue(); const pending = Array.from({ length: 8 }, () => q.run(async () => delay(5)));
  await assert.rejects(q.run(async () => undefined), /Too many/); await Promise.all(pending);
});
