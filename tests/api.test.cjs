// js/net/api.js (G.Api): cabeceras, cuerpos y cómo se convierten los errores.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'js/net/api.js'), 'utf8');

function load(reply) {
  const calls = [];
  const ctx = {
    G: {},
    fetch: async (url, opts) => {
      calls.push([url, opts]);
      const r = await reply(url, opts);
      if (r instanceof Error) throw r;
      const headers = new Map(Object.entries(r.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
      return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: k => headers.get(k.toLowerCase()) || null }, text: async () => r.body || '' };
    }
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { Api: ctx.G.Api, calls };
}

test('mismo origen, X-PS: 1 y JSON; devuelve el cuerpo ya leído (null si viene vacío)', async () => {
  const { Api, calls } = load(() => ({ status: 200, body: '{"me":{"uid":"u1"}}' }));
  assert.equal((await Api.get('/api/me')).me.uid, 'u1');
  const [url, o] = calls[0];
  assert.equal(url, '/api/me');
  assert.equal(o.method, 'GET');
  assert.equal(o.credentials, 'same-origin');
  assert.equal(o.headers['X-PS'], '1');
  assert.equal(o.body, undefined);
  await Api.post('/api/auth/email', { email: 'a@b.co' });
  assert.equal(calls[1][1].method, 'POST');
  assert.equal(calls[1][1].headers['Content-Type'], 'application/json');
  assert.equal(calls[1][1].body, '{"email":"a@b.co"}');
  await Api.put('/api/me/name', { name: 'Ash' });
  await Api.del('/api/me');
  assert.deepEqual(calls.slice(2).map(c => [c[1].method, c[1].body]), [['PUT', '{"name":"Ash"}'], ['DELETE', '{}']]);
  const empty = load(() => ({ status: 204 }));
  assert.equal(await empty.Api.post('/api/auth/logout'), null);
});

test('errores: .code del servidor, .status, .data; 429 con .retry; sin { error }, http; sin red, offline', async () => {
  const cases = [
    [{ status: 401, body: '{"error":"signed-out"}' }, 'signed-out', 401],
    [{ status: 400, body: '{"error":"bad-code"}' }, 'bad-code', 400],
    [{ status: 403, body: '{"error":"csrf"}' }, 'csrf', 403],
    [{ status: 409, body: '{"error":"conflict","rev":3}' }, 'conflict', 409],
    [{ status: 502, body: '{"error":"mail"}' }, 'mail', 502],
    [{ status: 404, body: '<html>no</html>' }, 'http', 404],
    [{ status: 503, body: '' }, 'http', 503],
    [new TypeError('Failed to fetch'), 'offline', 0],
  ];
  for (const [reply, code, status] of cases) {
    const { Api } = load(() => reply);
    const e = await Api.post('/api/x').then(() => null, x => x);
    assert.ok(e instanceof Error || (e && e.message), code);
    assert.equal(e.code, code);
    assert.equal(e.status, status);
    if (code === 'conflict') assert.equal(e.data.rev, 3);
  }
  const { Api } = load(() => ({ status: 429, body: '{"error":"rate"}', headers: { 'Retry-After': '42' } }));
  const e = await Api.post('/api/auth/email', {}).catch(x => x);
  assert.equal(e.code, 'rate');
  assert.equal(e.retry, 42);
});
