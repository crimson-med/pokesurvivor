/* ============ social.test.js: apodos, perfiles, amigos, en línea e invitaciones ============ */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioc } = require('socket.io-client');
const { createServer } = require('../index');
const { loadConfig } = require('../config');
const { createRooms } = require('../relay/rooms');
const { createLimits } = require('../relay/limits');
const store = require('../db');
const { sessionCookie } = require('./helpers');

const ORIGIN = 'http://localhost:8000';
const WORDS = Array.from({ length: 100 }, (_, i) => i + 1);
let NOW = Date.now();

let srv, url;
const open = [];

test.before(async () => {
  srv = createServer(loadConfig({ SITE_URL: ORIGIN, ADMIN_EMAILS: 'jefa@example.com' }), {
    store: store.open(':memory:', { log: false }),
    now: () => NOW,
    relay: { rooms: createRooms({ words: WORDS }), limits: createLimits({ joinIp: [1000, 60000] }), now: () => NOW },
  });
  const port = await srv.listen(0, '127.0.0.1');
  url = 'http://127.0.0.1:' + port;
});

test.after(async () => {
  for (const s of open) s.close();
  await srv.close();
});

// Una cuenta con su sesión: kind 'email' salvo que se diga.
const cookies = new Map();
function account(uid, o = {}) {
  if (!cookies.has(uid)) cookies.set(uid, sessionCookie(srv.store, uid, { kind: 'email', ...o }));
  return cookies.get(uid);
}

async function call(uid, method, p, body) {
  const headers = { 'content-type': 'application/json', 'x-ps': '1', origin: ORIGIN, cookie: account(uid) };
  const r = await fetch(url + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}
const api = uid => ({
  get: p => call(uid, 'GET', p),
  post: (p, b = {}) => call(uid, 'POST', p, b),
  put: (p, b = {}) => call(uid, 'PUT', p, b),
  del: (p, b = {}) => call(uid, 'DELETE', p, b),
});

function client(uid) {
  const s = ioc(url, {
    auth: { v: 2, dex: 25, shiny: false, ep: 'ep-' + uid },
    transports: ['websocket'], reconnection: false, forceNew: true,
    extraHeaders: { cookie: account(uid) },
  });
  open.push(s);
  return new Promise((resolve, reject) => {
    s.once('connect', () => resolve(s));
    s.once('connect_error', reject);
  });
}

// Con connectionStateRecovery, socket.io añade al final su posición (un texto): se quita.
function once(s, ev, ms = 2000, n = { presence: 2, 'invite-answer': 2, invite: 1, room: 1 }[ev]) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('sin ' + ev)), ms);
    s.once(ev, (...a) => { clearTimeout(t); resolve(n ? a.slice(0, n) : a); });
  });
}
function never(s, ev, ms = 250) {
  return new Promise((resolve, reject) => {
    const fn = () => reject(new Error('llegó ' + ev));
    s.once(ev, fn);
    setTimeout(() => { s.off(ev, fn); resolve(); }, ms);
  });
}
const req = (s, ev, p) => s.timeout(2000).emitWithAck(ev, p);

// Dos cuentas con correo, con apodo (N y el uid), ya amigas.
async function friends(a, b) {
  assert.equal((await api(a).put('/api/me/name', { name: 'N' + a })).status, 200);
  assert.equal((await api(b).put('/api/me/name', { name: 'N' + b })).status, 200);
  assert.equal((await api(a).post('/api/friends', { name: 'N' + b })).status, 204);
  assert.equal((await api(b).post('/api/friends/' + a + '/accept')).status, 204);
}

// ---------------- apodos ----------------

test('PUT /api/me/name: único sin mayúsculas, VALID de social.js y el socket lo sabe', async () => {
  const a = api('nA'), c = api('nC');
  assert.equal((await a.put('/api/me/name', { name: 'Ñandú_1' })).body.me.name, 'Ñandú_1');
  assert.equal((await c.put('/api/me/name', { name: 'ñandú_1' })).body.error, 'taken');
  assert.equal((await c.put('/api/me/name', { name: 'Guest1234' })).body.error, 'taken');
  assert.equal((await c.put('/api/me/name', { name: 'a b' })).body.error, 'invalid');
  // Al cambiarlo, el que se ve en la sala es el nuevo.
  const s = await client('nC');
  assert.equal((await req(s, 'create', { mode: 'direct' })).room.members[0].name, 'nC');
  const room = once(s, 'room');
  assert.equal((await c.put('/api/me/name', { name: 'Brock' })).status, 200);
  assert.equal((await room)[0].members[0].name, 'Brock');
  await req(s, 'leave', {});
});

// ---------------- perfiles ----------------

test('perfil: limpio, una vez por minuto, y el nombre es el de la cuenta', async () => {
  const a = api('pA');
  await a.put('/api/me/name', { name: 'Erika' });
  const profile = {
    name: 'Otro', title: 'Campeona', favs: [{ dex: 25, shiny: true }, { dex: 'x' }, { dex: 4 }, { dex: 7 }, { dex: 1 }],
    best: { solo: 120, group: 1e9, level: -3, kills: 'mucho' }, medals: ['a', 'b', 3], extra: '<script>',
  };
  assert.equal((await a.put('/api/profile', { profile })).status, 204);
  const r = await api('pB').get('/api/profile/pA');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.profile, {
    name: 'Erika', title: 'Campeona', favs: [{ dex: 25, shiny: true }, { dex: 4, shiny: false }],
    best: { solo: 120, group: 86400, level: 0, bosses: 0, legends: 0, kills: 0, medals: 0 }, medals: ['a', 'b'],
  });
  assert.equal((await a.put('/api/profile', { profile })).status, 429);
  NOW += 61 * 1000;
  assert.equal((await a.put('/api/profile', { profile: [] })).status, 400);
  NOW += 61 * 1000;
  assert.equal((await a.put('/api/profile', { profile: { title: 'Líder' } })).status, 204);
  assert.equal((await api('pB').get('/api/profile/pA')).body.profile.title, 'Líder');
  assert.equal((await api('pB').get('/api/profile/nadie')).status, 404);
  // Los invitados no tienen perfil (ni amigos ni ranking).
  account('pG', { kind: 'guest' });
  assert.equal((await api('pG').put('/api/profile', { profile })).body.error, 'needs-email');
});

// ---------------- amigos ----------------

test('amigos: pedir por apodo, aceptar, la lista de los dos y quitar', async () => {
  const a = api('fA'), b = api('fB');
  await a.put('/api/me/name', { name: 'Ash' });
  await b.put('/api/me/name', { name: 'Misty' });
  assert.equal((await a.post('/api/friends', { name: 'misty' })).status, 204);
  assert.deepEqual((await a.get('/api/friends')).body, [{ uid: 'fB', name: 'Misty', status: 'out', online: false }]);
  assert.deepEqual((await b.get('/api/friends')).body, [{ uid: 'fA', name: 'Ash', status: 'in', online: false }]);
  assert.equal((await a.post('/api/friends', { name: 'Misty' })).body.error, 'conflict');
  // Quien pidió no puede aceptar por el otro.
  assert.equal((await a.post('/api/friends/fB/accept')).status, 404);
  assert.equal((await b.post('/api/friends/fA/accept')).status, 204);
  assert.equal((await a.get('/api/friends')).body[0].status, 'ok');
  assert.equal((await b.get('/api/friends')).body[0].status, 'ok');
  assert.equal((await b.post('/api/friends', { name: 'Ash' })).body.error, 'conflict');
  assert.equal((await b.del('/api/friends/fA')).status, 204);
  assert.deepEqual((await a.get('/api/friends')).body, []);
  // Pedir a quien ya te pidió acepta la suya.
  await a.post('/api/friends', { name: 'Misty' });
  assert.equal((await b.post('/api/friends', { name: 'Ash' })).status, 204);
  assert.equal((await a.get('/api/friends')).body[0].status, 'ok');
});

test('amigos: no existe, tú mismo, invitados (needs-email) y apodos raros', async () => {
  const a = api('xA');
  await a.put('/api/me/name', { name: 'Xavi' });
  assert.equal((await a.post('/api/friends', { name: 'NoExiste' })).status, 404);
  assert.equal((await a.post('/api/friends', { name: 'xavi' })).body.error, 'invalid');
  assert.equal((await a.post('/api/friends', { name: '<b>' })).body.error, 'invalid');
  account('xG', { kind: 'guest' });
  const g = api('xG');
  await g.put('/api/me/name', { name: 'Invitado1' });
  for (const r of [await g.get('/api/friends'), await g.post('/api/friends', { name: 'Xavi' }),
    await g.post('/api/friends/xA/accept'), await g.del('/api/friends/xA')]) {
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'needs-email');
  }
  // A un invitado no se le puede pedir: como si no existiera.
  assert.equal((await a.post('/api/friends', { name: 'Invitado1' })).status, 404);
});

test('amigos: 50 solicitudes sin contestar y 200 amigos como mucho', async () => {
  const add = srv.store.prep("INSERT INTO users (uid, kind, email, name, name_lower, created, seen) VALUES (?, 'email', ?, ?, ?, 0, 0)");
  const fr = srv.store.prep('INSERT INTO friendships (a, b, from_uid, status, at) VALUES (?, ?, ?, ?, 0)');
  const pair = (x, y) => (x < y ? [x, y] : [y, x]);
  for (let i = 0; i < 260; i++) add.run('lim' + i, 'lim' + i + '@x.co', 'Lim' + i, 'lim' + i);
  const a = api('lA');
  await a.put('/api/me/name', { name: 'Limitado' });
  for (let i = 0; i < 50; i++) fr.run(...pair('lA', 'lim' + i), 'lA', 'pending');
  assert.equal((await a.post('/api/friends', { name: 'Lim50' })).body.error, 'too-many');
  srv.store.prep("DELETE FROM friendships WHERE from_uid = 'lA'").run();
  for (let i = 0; i < 200; i++) fr.run(...pair('lA', 'lim' + i), 'lA', 'ok');
  assert.equal((await a.post('/api/friends', { name: 'Lim250' })).body.error, 'full');
  // Ni aceptando una que te mandaron.
  fr.run(...pair('lA', 'lim251'), 'lim251', 'pending');
  assert.equal((await a.post('/api/friends/lim251/accept')).body.error, 'full');
});

// ---------------- en línea ----------------

test('presence: sólo a los amigos conectados, al entrar y al salir; la lista dice online', async () => {
  await friends('oA', 'oB');
  account('oC');
  const a = await client('oA');
  const c = await client('oC');
  const noC = never(c, 'presence', 400);
  const on = once(a, 'presence');
  const b = await client('oB');
  assert.deepEqual(await on, ['oB', true]);
  assert.deepEqual((await api('oA').get('/api/friends')).body.map(f => [f.uid, f.online]), [['oB', true]]);
  const off = once(a, 'presence');
  b.close();
  assert.deepEqual(await off, ['oB', false]);
  await noC;
  assert.equal((await api('oA').get('/api/friends')).body[0].online, false);
  // Una solicitud sin aceptar no dice si estás en línea.
  await api('oC').put('/api/me/name', { name: 'NoC' });
  await api('oC').post('/api/friends', { name: 'NoA' });
  assert.deepEqual((await api('oC').get('/api/friends')).body, [{ uid: 'oA', name: 'NoA', status: 'out', online: false }]);
});

test('friends: el otro recibe el aviso al pedir, aceptar, quitar, cambiar de apodo y borrar la cuenta', async () => {
  for (const u of ['wA', 'wB']) await api(u).put('/api/me/name', { name: 'N' + u });
  const b = await client('wB');
  const a = await client('wA');
  let got = once(b, 'friends');
  await api('wA').post('/api/friends', { name: 'NwB' });
  await got;
  got = once(a, 'friends');
  await api('wB').post('/api/friends/wA/accept');
  await got;
  got = once(b, 'friends');
  await api('wA').del('/api/friends/wB');
  await got;
  // También al cambiar de apodo y al borrar la cuenta.
  await api('wA').post('/api/friends', { name: 'NwB' });
  got = once(b, 'friends');
  await api('wA').put('/api/me/name', { name: 'NwA2' });
  await got;
  assert.equal((await api('wB').get('/api/friends')).body[0].name, 'NwA2');
  got = once(b, 'friends');
  assert.equal((await api('wA').del('/api/me')).status, 204);
  await got;
  assert.deepEqual((await api('wB').get('/api/friends')).body, []);
});

// ---------------- invitaciones ----------------

test('invite: a un amigo conectado le llega el código; aceptar da el código y entra con join', async () => {
  await friends('iA', 'iB');
  const a = await client('iA');
  const b = await client('iB');
  const made = await req(a, 'create', { mode: 'direct' });
  const got = once(b, 'invite');
  assert.deepEqual(await req(a, 'invite', { to: 'iB' }), { ok: true });
  const [inv] = await got;
  assert.deepEqual(inv, { from: 'iA', name: 'NiA', dex: 25, shiny: false, code: made.code });
  const told = once(a, 'invite-answer');
  const ans = await req(b, 'invite-answer', { from: 'iA', accept: true });
  assert.deepEqual(ans, { ok: true, code: made.code });
  assert.deepEqual(await told, ['iB', true]);
  assert.equal((await req(b, 'join', { code: ans.code })).ok, true);
  // Ya contestada: no vale otra vez.
  assert.deepEqual(await req(b, 'invite-answer', { from: 'iA', accept: true }), { ok: false, err: 'expired' });
  await req(b, 'leave', {});
  await req(a, 'leave', {});
});

test('invite: a quien no es amigo, desconectado, sin sala o no siendo anfitrión: no se manda', async () => {
  await friends('jA', 'jB');
  account('jC');
  await friends('jA', 'jD');
  const a = await client('jA');
  const c = await client('jC');
  assert.deepEqual(await req(a, 'invite', { to: 'jB' }), { ok: false, err: 'not-in-room' });
  const made = await req(a, 'create', { mode: 'direct' });
  const noInv = never(c, 'invite');
  assert.deepEqual(await req(a, 'invite', { to: 'jC' }), { ok: false, err: 'not-friend' });
  await noInv;
  assert.deepEqual(await req(a, 'invite', { to: 'jB' }), { ok: false, err: 'offline' });
  assert.deepEqual(await req(a, 'invite', { to: 'jA' }), { ok: false, err: 'not-friend' });
  const d = await client('jD');
  assert.equal((await req(d, 'join', { code: made.code })).ok, true);
  const b = await client('jB');
  assert.deepEqual(await req(d, 'invite', { to: 'jB' }), { ok: false, err: 'not-host' });
  await req(d, 'leave', {});
  await req(a, 'leave', {});
  b.close();
});

test('invite: al mismo amigo una vez cada 20 s, caduca a los 3 minutos y rechazar avisa al anfitrión', async () => {
  await friends('kA', 'kB');
  const a = await client('kA');
  const b = await client('kB');
  await req(a, 'create', { mode: 'server' });
  assert.equal((await req(a, 'invite', { to: 'kB' })).ok, true);
  assert.deepEqual(await req(a, 'invite', { to: 'kB' }), { ok: false, err: 'rate' });
  NOW += 21 * 1000;
  assert.equal((await req(a, 'invite', { to: 'kB' })).ok, true);
  NOW += 3 * 60 * 1000;
  assert.deepEqual(await req(b, 'invite-answer', { from: 'kA', accept: true }), { ok: false, err: 'expired' });
  assert.equal((await req(a, 'invite', { to: 'kB' })).ok, true);
  const told = once(a, 'invite-answer');
  assert.deepEqual(await req(b, 'invite-answer', { from: 'kA', accept: false }), { ok: true });
  assert.deepEqual(await told, ['kB', false]);
  // Si el anfitrión ya cerró la sala, aceptar dice not-found.
  NOW += 21 * 1000;
  assert.equal((await req(a, 'invite', { to: 'kB' })).ok, true);
  await req(a, 'leave', {});
  assert.deepEqual(await req(b, 'invite-answer', { from: 'kA', accept: true }), { ok: false, err: 'not-found' });
  // A otra sala sí se le puede invitar enseguida.
  await req(a, 'create', { mode: 'direct' });
  assert.equal((await req(a, 'invite', { to: 'kB' })).ok, true);
  await req(a, 'leave', {});
});

// ---------------- moderación ----------------

test('admin: banear cierra los sockets de esa cuenta y ya no vuelve a entrar', async () => {
  account('jefa', { email: 'jefa@example.com' });
  const s = await client('bad1');
  const gone = once(s, 'disconnect');
  assert.equal((await api('jefa').post('/api/admin/ban', { uids: ['bad1'] })).status, 200);
  assert.equal((await gone)[0], 'io server disconnect');
  assert.equal((await client('bad1').catch(e => e)).message, 'banned');
});
