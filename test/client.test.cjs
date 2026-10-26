const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { NeviwebRestClient } = require('../dist/rest-client');
const { NeviwebApi } = require('../dist/neviweb');
const { log, logs, delay } = require('./helpers.cjs');

async function server(t, handler) {
  const requests = [];
  const s = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) { body += chunk; }
    requests.push({ url: req.url, method: req.method, headers: req.headers, body });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/login') { res.end(JSON.stringify({ session: 'test-session', refreshToken: 'test-refresh', iat: 1 })); }
    else if (req.url === '/api/logout') { res.end('{"success":true}'); }
    else { await handler(req, res); }
  });
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  t.after(() => { s.closeAllConnections(); s.close(); });
  const config = { url: `http://127.0.0.1:${s.address().port}/api`, username: 'test-user', password: 'test-secret', requestTimeoutMs: 3500 };
  return { config, requests };
}

test('authentication is shared across concurrent first reads and ignores API iat units', async t => {
  const f = await server(t, (_req, res) => res.end('{}'));
  const c = new NeviwebRestClient(f.config, log);
  await Promise.all(Array.from({ length: 20 }, () => c.request({ path: '/devices' })));
  assert.equal(f.requests.filter(r => r.url.endsWith('/login')).length, 1);
  assert.ok(f.requests.filter(r => r.url.endsWith('/devices')).every(r => r.headers['session-id'] === 'test-session'));
  assert.equal(await c.logout(), true);
});

test('hung API responses time out and never leak transport credentials', async t => {
  const f = await server(t, () => undefined); const c = new NeviwebRestClient(f.config, log);
  assert.equal(await c.login(), true); c.timeoutMs = 100; const started = Date.now();
  await assert.rejects(c.request({ path: '/device/1/attribute' }), /TIMEOUT/);
  assert.ok(Date.now() - started < 1000);
  assert.ok(!JSON.stringify(logs).includes('test-secret'));
});

test('a response body stalled after headers is also covered by the deadline', async t => {
  const f = await server(t, (_req, res) => { res.writeHead(200); res.write('{'); });
  const c = new NeviwebRestClient(f.config, log); assert.equal(await c.login(), true); c.timeoutMs = 100;
  await assert.rejects(c.request({ path: '/devices' }), /TIMEOUT/);
});

test('failed writes are never retried automatically', async t => {
  const f = await server(t, (_req, res) => { res.statusCode = 503; res.end('{"error":"private test-secret"}'); });
  const c = new NeviwebRestClient(f.config, log);
  await assert.rejects(c.request({ path: '/device/1/attribute', method: 'PUT', data: { roomSetpoint: 20 } }), /HTTP_503/);
  assert.equal(f.requests.filter(r => r.method === 'PUT').length, 1);
});

test('expired sessions share one refresh, then successful device requests recover', async t => {
  let refreshes = 0;
  const f = await server(t, (req, res) => {
    if (req.url === '/api/connect') { refreshes++; res.end('{"session":"renewed","refreshToken":"renewed-refresh"}'); }
    else if (req.headers['session-id'] === 'test-session') { res.end('{"error":{"code":"USRSESSEXP"}}'); }
    else { res.end('{}'); }
  });
  const c = new NeviwebRestClient(f.config, log);
  await assert.rejects(c.request({ path: '/devices' }), /USRSESSEXP/);
  await Promise.all(Array.from({ length: 20 }, () => c.request({ path: '/devices' })));
  assert.equal(refreshes, 1);
});

test('API errors are sanitized and malformed bodies fail safely', async t => {
  let n = 0;
  const f = await server(t, (_req, res) => res.end(n++ === 0 ? '{"error":"test-secret"}' : 'not json'));
  const c = new NeviwebRestClient(f.config, log);
  await assert.rejects(c.request({ path: '/devices' }), /API_ERROR/);
  await assert.rejects(c.request({ path: '/devices' }), /TRANSPORT_OR_RESPONSE/);
});

test('account lockout applies shared backoff instead of hammering credential login', async t => {
  const s = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"error":{"code":"USRLOCKED"}}'); });
  let attempts = 0; s.on('request', () => { attempts++; });
  await new Promise(r => s.listen(0, '127.0.0.1', r)); t.after(() => { s.closeAllConnections(); s.close(); });
  const c = new NeviwebRestClient({ url: `http://127.0.0.1:${s.address().port}`, username: 'test', password: 'test-secret' }, log);
  assert.equal(await c.login(), false);
  await Promise.all(Array.from({ length: 30 }, () => assert.rejects(c.request({ path: '/devices' }), /AUTH_BACKOFF/)));
  assert.equal(attempts, 1);
});

test('device discovery validates payloads and encodes location IDs', async t => {
  const f = await server(t, (_req, res) => res.end(JSON.stringify([{ id: 1, identifier: 'abc', name: 'test', sku: 'TH1123ZB' }, {}, null])));
  const api = new NeviwebApi({ ...f.config, locationid: '1&other=2' }, log);
  assert.equal((await api.fetchDevices()).length, 1);
  assert.equal(f.requests.at(-1).url, '/api/devices?location$id=1%26other%3D2');
});

test('shutdown forbids any new authenticated API requests', async t => {
  const f = await server(t, (_req, res) => res.end('{}')); const c = new NeviwebRestClient(f.config, log);
  await c.login(); await c.logout(); const n = f.requests.length;
  await assert.rejects(c.request({ path: '/devices' }), /SHUTDOWN/); assert.equal(f.requests.length, n);
});

test('redirects are rejected so API credentials cannot follow a redirect', async t => {
  const f = await server(t, (_req, res) => { res.statusCode = 302; res.setHeader('Location', '/api/unexpected'); res.end('{}'); });
  const c = new NeviwebRestClient(f.config, log); await c.login();
  await assert.rejects(c.request({ path: '/devices' }), /TRANSPORT_OR_RESPONSE/);
  assert.equal(f.requests.filter(r => r.url.endsWith('/unexpected')).length, 0);
});

test('insecure non-local URLs and invalid request deadlines are rejected', () => {
  assert.throws(() => new NeviwebRestClient({ url: 'http://example.com/api' }, log), /HTTPS/);
  assert.throws(() => new NeviwebRestClient({ url: 'https://user:pass@example.com/api' }, log), /HTTPS/);
  assert.throws(() => new NeviwebRestClient({ requestTimeoutMs: Infinity }, log), /requestTimeoutMs/);
});

test('network recovery after an earlier device failure is possible without restarting client', async t => {
  let fail = true; const f = await server(t, (_req, res) => { if (fail) { res.statusCode = 503; } res.end('{}'); });
  const c = new NeviwebRestClient(f.config, log); await assert.rejects(c.request({ path: '/devices' }));
  fail = false; await delay(1); assert.deepEqual(await c.request({ path: '/devices' }), {});
});

for (const code of ['USRSESSEXP', 'HTTP_401']) {
  test(`invalid refresh (${code}) backs off and a subsequent credential login can recover`, async t => {
    const f = await server(t, (req, res) => {
      if (req.url === '/api/connect') {
        if (code === 'HTTP_401') { res.statusCode = 401; res.end('{}'); }
        else { res.end('{"error":{"code":"USRSESSEXP"}}'); }
      } else { res.end('{}'); }
    });
    const c = new NeviwebRestClient(f.config, log); await c.login(); c.expiresAt = 0;
    await assert.rejects(c.request({ path: '/devices' }));
    await assert.rejects(c.request({ path: '/devices' }), /AUTH_BACKOFF/);
    c.retryAfter = 0; await c.request({ path: '/devices' });
    assert.equal(f.requests.filter(r => r.url.endsWith('/login')).length, 2);
  });
}
