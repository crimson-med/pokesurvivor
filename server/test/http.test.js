/* ============ http.test.js: archivos del juego, caché, /healthz, /api/config ============ */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../index');
const { loadConfig } = require('../config');
const store = require('../db');
const guard = require('../http/guard');

const ROOT = path.resolve(__dirname, '..', '..');

async function start(env = {}, opts = {}) {
  const srv = createServer(loadConfig({ SITE_URL: 'http://localhost:8000', ...env }), {
    store: store.open(':memory:', { log: false }),
    ...opts,
  });
  const port = await srv.listen(0, '127.0.0.1');
  return { srv, url: 'http://127.0.0.1:' + port };
}

let dev;
test.before(async () => { dev = await start(); });
test.after(() => dev.srv.close());

test('version.json, HTML y sw.js: no-cache', async () => {
  for (const p of ['/version.json', '/sw.js', '/404.html']) {
    const r = await fetch(dev.url + p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers.get('cache-control'), 'no-cache', p);
  }
});

test('assets/: un año, inmutable; css/: corta', async () => {
  const a = await fetch(dev.url + '/assets/icons/icon-48.png');
  assert.equal(a.status, 200);
  assert.equal(a.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const c = await fetch(dev.url + '/css/style.css');
  assert.equal(c.status, 200);
  assert.equal(c.headers.get('cache-control'), 'public, max-age=3600');
});

test('en desarrollo / es dev.html y server/ no se sirve', async () => {
  const r = await fetch(dev.url + '/');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-cache');
  assert.equal(await r.text(), fs.readFileSync(path.join(ROOT, 'dev.html'), 'utf8'));
  for (const p of ['/server/package.json', '/server/index.js', '/%73erver/package.json', '/server%2fpackage.json',
    '/SERVER/package.json', '/server./package.json', '/server%5cpackage.json']) {
    assert.equal((await fetch(dev.url + p)).status, 404, p);
  }
});

test('producción con STATIC_DIR en la raíz del repositorio: server/ tampoco se sirve', async () => {
  const prod = await start({ NODE_ENV: 'production', CODE_PEPPER: 'x' });
  try {
    assert.equal((await fetch(prod.url + '/server/config.js')).status, 404);
    assert.equal((await fetch(prod.url + '/%73erver/config.js')).status, 404);
    assert.equal((await fetch(prod.url + '/version.json')).status, 200);
  } finally {
    await prod.srv.close();
  }
});

test('/api/x desconocida: 404 en JSON', async () => {
  for (const [method, p] of [['GET', '/api/x'], ['POST', '/api/x/y'], ['GET', '/api']]) {
    const r = await fetch(dev.url + p, { method });
    assert.equal(r.status, 404, method + ' ' + p);
    assert.match(r.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await r.json(), { error: 'not-found' });
  }
  assert.equal((await fetch(dev.url + '/no-existe.png')).status, 404);
});

test('/healthz: ok, salas, sockets, caminos y db', async () => {
  const r = await fetch(dev.url + '/healthz');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.db, 'ok');
  assert.equal(typeof j.rooms, 'number');
  assert.equal(typeof j.sockets, 'number');
  assert.deepEqual(Object.keys(j.paths).sort(), ['direct', 'server']);
});

test('/api/config: STUN, espera directa y versión', async () => {
  const r = await fetch(dev.url + '/api/config');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(j.stunUrls, ['stun:stun.l.google.com:19302']);
  assert.equal(j.directWaitMs, 6000);
  assert.equal(j.version, JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8')).v);
});

test('producción: / es index.html de STATIC_DIR, STUN vacío y versión de su version.json', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-static-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>construido</title>');
  fs.writeFileSync(path.join(dir, 'version.json'), '{"v":"abc123"}');
  const prod = await start({ NODE_ENV: 'production', CODE_PEPPER: 'x', STATIC_DIR: dir, STUN_URLS: '', DIRECT_WAIT_MS: '10000' });
  try {
    const r = await fetch(prod.url + '/');
    assert.equal(await r.text(), '<!doctype html><title>construido</title>');
    assert.equal(r.headers.get('cache-control'), 'no-cache');
    assert.deepEqual(await (await fetch(prod.url + '/api/config')).json(), { stunUrls: [], directWaitMs: 10000, version: 'abc123' });
  } finally {
    await prod.srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('/healthz con la base de datos cerrada: 503', async () => {
  const s = await start();
  s.srv.store.close();
  try {
    const r = await fetch(s.url + '/healthz');
    assert.equal(r.status, 503);
    const j = await r.json();
    assert.equal(j.ok, false);
    assert.equal(j.db, 'error');
  } finally {
    await s.srv.close();
  }
});

test('guard: fail y body (JSON mal formado, demasiado grande)', async () => {
  const express = require('express');
  const app = express();
  app.post('/t', guard.body(64), (req, res) => res.json({ got: req.body }));
  app.get('/f', (req, res) => guard.fail(res, 409, 'taken'));
  app.post('/s', guard.needSession, (req, res) => res.json({}));
  app.post('/c', guard.csrf, (req, res) => res.json({}));
  const http = require('http').createServer(app);
  await new Promise(r => http.listen(0, '127.0.0.1', r));
  const u = 'http://127.0.0.1:' + http.address().port;
  const post = (p, b) => fetch(u + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: b });
  try {
    assert.deepEqual(await (await post('/t', '{"a":1}')).json(), { got: { a: 1 } });
    let r = await post('/t', '{mal');
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: 'invalid' });
    r = await post('/t', JSON.stringify({ a: 'x'.repeat(100) }));
    assert.equal(r.status, 413);
    assert.deepEqual(await r.json(), { error: 'too-big' });
    r = await fetch(u + '/f');
    assert.equal(r.status, 409);
    assert.deepEqual(await r.json(), { error: 'taken' });
    // Hasta el paso 2, cerrados.
    assert.equal((await post('/s', '{}')).status, 401);
    assert.equal((await post('/c', '{}')).status, 403);
  } finally {
    await new Promise(r => http.close(r));
  }
});
