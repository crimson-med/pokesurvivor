/* ============ save.test.js: GET y PUT /api/save (rev, 409, tope, invitados y correo) ============ */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../index');
const { loadConfig } = require('../config');
const store = require('../db');
const { SAVE_LIMIT } = require('../http/guard');
const { sessionCookie } = require('./helpers');

const ORIGIN = 'http://localhost:8000';
let s;
test.before(async () => {
  const srv = createServer(loadConfig({ SITE_URL: ORIGIN }), { store: store.open(':memory:', { log: false }) });
  const port = await srv.listen(0, '127.0.0.1');
  s = { srv, url: 'http://127.0.0.1:' + port };
});
test.after(() => s.srv.close());

// Un navegador con la sesión de `uid` (o sin sesión).
function as(uid, o) {
  const cookie = uid ? sessionCookie(s.srv.store, uid, o) : null;
  async function call(method, body, extra = {}) {
    const headers = { 'content-type': 'application/json', 'x-ps': '1', origin: ORIGIN, ...extra };
    if (cookie) headers.cookie = cookie;
    const r = await fetch(s.url + '/api/save', { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null, headers: r.headers };
  }
  return { get: () => call('GET'), put: (b, h) => call('PUT', b, h) };
}

const row = uid => s.srv.store.prep('SELECT rev, body, updated FROM saves WHERE uid = ?').get(uid);

test('sin sesión: 401; sin partida: 404', async () => {
  assert.equal((await as(null).get()).status, 401);
  assert.equal((await as(null).put({ save: { v: 3 }, rev: 0 })).status, 401);
  const r = await as('nosave').get();
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'not-found');
});

test('crear con rev 0, actualizar con la rev buena y leerla', async () => {
  const b = as('ash', { kind: 'email' });
  let r = await b.put({ save: { v: 3, coins: 10 }, rev: 0 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { rev: 1 });
  r = await b.put({ save: { v: 3, coins: 20 }, rev: 1 });
  assert.deepEqual(r.body, { rev: 2 });
  r = await b.get();
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(r.body.save, { v: 3, coins: 20 });
  assert.equal(r.body.rev, 2);
  assert.equal(typeof r.body.updated, 'number');
  assert.equal(row('ash').rev, 2);
});

test('rev equivocada: 409 con la copia del servidor, y no se escribe', async () => {
  const b = as('misty', { kind: 'email' });
  await b.put({ save: { v: 3, coins: 1 }, rev: 0 });
  await b.put({ save: { v: 3, coins: 2 }, rev: 1 });
  for (const rev of [0, 1, 5]) {
    const r = await b.put({ save: { v: 3, coins: 99 }, rev });
    assert.equal(r.status, 409, String(rev));
    assert.equal(r.body.error, 'conflict');
    assert.deepEqual(r.body.save, { v: 3, coins: 2 });
    assert.equal(r.body.rev, 2);
  }
  assert.equal(JSON.parse(row('misty').body).coins, 2);
  // Sin fila y una rev que no es 0 (la base de datos empezó de cero): 409 con save null.
  const r = await as('brock').put({ save: { v: 3 }, rev: 4 });
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, { save: null, rev: 0, error: 'conflict' });
  assert.equal(row('brock'), undefined);
});

test('invitados también guardan, cada uno la suya', async () => {
  const g1 = as('guest1'), g2 = as('guest2', { kind: 'guest' });
  assert.deepEqual((await g1.put({ save: { v: 3, coins: 7 }, rev: 0 })).body, { rev: 1 });
  assert.deepEqual((await g2.put({ save: { v: 3, coins: 8 }, rev: 0 })).body, { rev: 1 });
  assert.equal((await g1.get()).body.save.coins, 7);
  assert.equal((await g2.get()).body.save.coins, 8);
});

test('tope de 512 KB y cuerpos mal formados', async () => {
  const b = as('oak', { kind: 'email' });
  const pad = n => ({ v: 3, pad: 'x'.repeat(n) });
  // Justo en el tope pasa; un byte más, 413.
  const base = JSON.stringify(pad(0)).length;
  assert.equal((await b.put({ save: pad(SAVE_LIMIT - base), rev: 0 })).status, 200);
  let r = await b.put({ save: pad(SAVE_LIMIT - base + 1), rev: 1 });
  assert.equal(r.status, 413);
  assert.equal(r.body.error, 'too-big');
  r = await b.put({ save: pad(SAVE_LIMIT * 2), rev: 1 });
  assert.equal(r.status, 413);
  assert.equal(row('oak').rev, 1);
  for (const bad of [[], { rev: 1 }, { save: [], rev: 1 }, { save: { v: '3' }, rev: 1 }, { save: { coins: 1 }, rev: 1 },
    { save: { v: 3 } }, { save: { v: 3 }, rev: -1 }, { save: { v: 3 }, rev: 1.5 }, { save: { v: 3 }, rev: '1' }, '{nope']) {
    r = await b.put(bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(r.body.error, 'invalid');
  }
  assert.equal(row('oak').rev, 1);
});

test('PUT sin X-PS o desde otro origen: 403 csrf', async () => {
  const b = as('gary', { kind: 'email' });
  assert.equal((await b.put({ save: { v: 3 }, rev: 0 }, { 'x-ps': '' })).status, 403);
  assert.equal((await b.put({ save: { v: 3 }, rev: 0 }, { origin: 'https://evil.example' })).status, 403);
  assert.equal(row('gary'), undefined);
});

test('borrar la cuenta borra su partida', async () => {
  const b = as('erika', { kind: 'email' });
  await b.put({ save: { v: 3 }, rev: 0 });
  s.srv.store.prep('DELETE FROM users WHERE uid = ?').run('erika');
  assert.equal(row('erika'), undefined);
});
