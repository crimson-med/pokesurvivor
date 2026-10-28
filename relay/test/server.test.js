/* ============ server.test.js: el servidor de verdad, con sockets en 127.0.0.1 ============ */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioc } = require('socket.io-client');
const { createServer, publicIp } = require('../server');
const { createRooms } = require('../rooms');

const PROJECT = 'demo-pokesurvivor';
const ORIGIN = 'http://localhost:8000';
const WORDS = Array.from({ length: 100 }, (_, i) => i + 1);

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
// Token como los del emulador de Auth: sin firma.
function token(sub, aud = PROJECT) {
  const t = Math.floor(Date.now() / 1000);
  return b64({ alg: 'none', typ: 'JWT' }) + '.' +
    b64({ sub, user_id: sub, aud, iss: 'https://securetoken.google.com/' + aud, iat: t, exp: t + 3600 }) + '.';
}

let srv, url;
const open = [];

test.before(async () => {
  srv = createServer({
    authEmulator: true, project: PROJECT, origins: [ORIGIN],
    rooms: createRooms({ words: WORDS }),
    // Todos los clientes de la prueba vienen de 127.0.0.1: el tope por IP se
    // sube aquí (se prueba en limits.test.js) y queda el de la cuenta.
    limits: { joinIp: [1000, 60000] },
  });
  const port = await srv.listen(0, '127.0.0.1');
  url = 'http://127.0.0.1:' + port;
});

test.after(async () => {
  for (const s of open) s.close();
  await srv.close();
});

function client(uid, o = {}) {
  const s = ioc(url, {
    auth: { v: 1, token: token(uid), name: uid, dex: 25, shiny: false, ...o.auth },
    transports: ['websocket'], reconnection: false, forceNew: true,
    extraHeaders: o.headers,
  });
  open.push(s);
  return s;
}

function connected(s) {
  return new Promise((resolve, reject) => {
    s.once('connect', () => resolve(s));
    s.once('connect_error', reject);
  });
}

// Con connectionStateRecovery, socket.io añade al final de cada envío a una
// sala su posición (un texto): se quita para comparar.
function once(s, ev, ms = 2000, n = { closed: 1, peer: 2, room: 1, sig: 2, m: 3, ack: 2 }[ev]) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('sin ' + ev)), ms);
    s.once(ev, (...a) => { clearTimeout(t); resolve(n ? a.slice(0, n) : a); });
  });
}

// Comprueba que no llega nada en `ms`.
function never(s, ev, ms = 250) {
  return new Promise((resolve, reject) => {
    const fn = () => reject(new Error('llegó ' + ev));
    s.once(ev, fn);
    setTimeout(() => { s.off(ev, fn); resolve(); }, ms);
  });
}

const req = (s, ev, p) => s.timeout(2000).emitWithAck(ev, p);

async function hostAndGuest(h, g, mode = 'direct') {
  const host = await connected(client(h));
  const made = await req(host, 'create', { mode });
  assert.equal(made.ok, true);
  const guest = await connected(client(g));
  const joined = await req(guest, 'join', { code: made.code });
  assert.equal(joined.ok, true);
  return { host, guest, made, joined };
}

test('una v distinta se rechaza con old-version', async () => {
  const err = await connected(client('v0', { auth: { v: 99 } })).catch(e => e);
  assert.equal(err.message, 'old-version');
});

test('token del emulador vale; uno basura o de otro proyecto no', async () => {
  await connected(client('ok1'));
  const bad = await connected(client('x', { auth: { token: 'basura' } })).catch(e => e);
  assert.equal(bad.message, 'bad-token');
  const other = await connected(client('x', { auth: { token: token('x', 'otro-proyecto') } })).catch(e => e);
  assert.equal(other.message, 'bad-token');
  const none = await connected(client('x', { auth: { token: undefined } })).catch(e => e);
  assert.equal(none.message, 'bad-token');
});

test('un origen que no está en ORIGINS no conecta', async () => {
  const err = await connected(client('o1', { headers: { origin: 'https://otra.web' } })).catch(e => e);
  assert.ok(err instanceof Error);
  await connected(client('o2', { headers: { origin: ORIGIN } }));
});

test('create y join: código, estado de la sala y evento room', async () => {
  const host = await connected(client('ha'));
  const made = await req(host, 'create', { mode: 'server' });
  assert.equal(made.ok, true);
  assert.equal(made.code.length, 4);
  assert.deepEqual(made.room.code, made.code);
  assert.equal(made.room.mode, 'server');
  const guest = await connected(client('ga'));
  const roomEv = once(host, 'room');
  const joined = await req(guest, 'join', { code: made.code, hideIp: true });
  assert.equal(joined.ok, true);
  assert.equal(joined.sameNet, true);   // los dos vienen de 127.0.0.1
  const [snap] = await roomEv;
  assert.deepEqual(snap.members.map(m => m.uid), ['ha', 'ga']);
  const g = snap.members[1];
  assert.deepEqual(g, { uid: 'ga', name: 'ga', dex: 25, shiny: false, online: true, path: null, sameNet: true, hideIp: true });
  assert.ok(!JSON.stringify(snap).includes('127.0.0.1'));
  const reversed = made.code.slice().reverse();
  if (reversed.join() !== made.code.join()) {
    const other = await connected(client('ga2'));
    assert.equal((await req(other, 'join', { code: reversed })).err, 'not-found');
  }
});

test('create con { id } (modo provisional) y join con el id', async () => {
  const host = await connected(client('hid'));
  const made = await req(host, 'create', { id: 'hid' });
  assert.equal(made.ok, true);
  assert.equal(made.code, null);
  assert.equal(made.room.code, null);
  const guest = await connected(client('gid'));
  const joined = await req(guest, 'join', { code: 'hid' });
  assert.equal(joined.ok, true);
  assert.equal(joined.room.members.length, 2);
});

test('anfitrión e invitado se pasan sig y m; from es el uid del que manda', async () => {
  const { host, guest } = await hostAndGuest('hb', 'gb');
  let got = once(guest, 'sig');
  host.emit('sig', 'gb', { sdp: { type: 'offer', sdp: 'x' } });
  let [from, payload] = await got;
  assert.equal(from, 'hb');
  assert.deepEqual(payload, { sdp: { type: 'offer', sdp: 'x' } });

  got = once(host, 'sig');
  guest.emit('sig', 'quien-sea', { sdp: { type: 'answer' }, from: 'falso' });
  [from, payload] = await got;
  assert.equal(from, 'gb');
  assert.equal(payload.from, 'falso');   // el contenido no se toca; el from bueno es el primero

  got = once(guest, 'm');
  host.emit('m', 'gb', 1, Buffer.from([1, 2, 3]));
  let [mf, seq, bytes] = await got;
  assert.equal(mf, 'hb');
  assert.equal(seq, 1);
  assert.deepEqual([...new Uint8Array(bytes)], [1, 2, 3]);

  got = once(host, 'm');
  guest.emit('m', 'hb', 7, '{"k":"i"}');
  [mf, seq, bytes] = await got;
  assert.equal(mf, 'gb');
  assert.equal(seq, 7);
  assert.equal(bytes, '{"k":"i"}');

  got = once(host, 'ack');
  guest.emit('ack', 7);
  const [af, aseq] = await got;
  assert.equal(af, 'gb');
  assert.equal(aseq, 7);
});

test('un invitado no llega a otro invitado: va al anfitrión', async () => {
  const { host, guest: g1, made } = await hostAndGuest('hc', 'gc1');
  const g2 = await connected(client('gc2'));
  assert.equal((await req(g2, 'join', { code: made.code })).ok, true);
  const toHost = once(host, 'm');
  const notG2 = never(g2, 'm');
  g1.emit('m', 'gc2', 1, 'hola');
  const [from] = await toHost;
  assert.equal(from, 'gc1');
  await notG2;
});

test('un m de 300 KB se tira y la conexión sigue', async () => {
  const { host, guest } = await hostAndGuest('hd', 'gd');
  const notBig = never(guest, 'm', 300);
  host.emit('m', 'gd', 1, Buffer.alloc(300 * 1024));
  await notBig;
  const small = once(guest, 'm');
  host.emit('m', 'gd', 2, Buffer.alloc(10));
  const [, seq] = await small;
  assert.equal(seq, 2);
  assert.equal(host.connected, true);
});

test('join 6 veces en un minuto: la sexta da rate', async () => {
  const s = await connected(client('ge'));
  const errs = [];
  for (let i = 0; i < 6; i++) errs.push((await req(s, 'join', { code: [9, 9, 9, i + 1] })).err);
  assert.deepEqual(errs, ['not-found', 'not-found', 'not-found', 'not-found', 'not-found', 'rate']);
});

test('path del anfitrión sale en el estado; un invitado no puede cambiarlo', async () => {
  const { host, guest } = await hostAndGuest('hf', 'gf');
  guest.emit('path', 'gf', 'direct');
  await never(host, 'room', 200);
  const ev = once(guest, 'room');
  host.emit('path', 'gf', 'server');
  const [snap] = await ev;
  assert.equal(snap.members[1].path, 'server');
});

test('se cae el invitado: away; vuelve: online y conserva el hueco', async () => {
  const { host, guest, made } = await hostAndGuest('hg', 'gg');
  const away = once(host, 'peer');
  guest.close();
  assert.deepEqual(await away, ['gg', 'away']);
  const online = once(host, 'peer');
  const back = client('gg');
  const roomEv = once(back, 'room');
  await connected(back);
  assert.deepEqual(await online, ['gg', 'online']);
  const snap = (await roomEv)[0];
  assert.equal(snap.members.length, 2);
  assert.deepEqual(snap.code, made.code);
});

test('kick: el expulsado recibe closed(kicked) y los demás peer gone', async () => {
  const { host, guest } = await hostAndGuest('hh', 'gh');
  const closed = once(guest, 'closed');
  const gone = once(host, 'peer');
  assert.deepEqual(await req(host, 'kick', { uid: 'gh' }), { ok: true });
  assert.deepEqual(await closed, ['kicked']);
  assert.deepEqual(await gone, ['gh', 'gone']);
});

test('expulsado mientras estaba caído: al volver recibe closed(kicked)', async () => {
  const { host, guest } = await hostAndGuest('hl', 'gl');
  const away = once(host, 'peer');
  guest.close();
  await away;
  host.emit('m', 'gl', 1, 'se pierde');   // caído: no se guarda ni rompe nada
  assert.deepEqual(await req(host, 'kick', { uid: 'gl' }), { ok: true });
  const back = client('gl');
  const closed = once(back, 'closed');
  await connected(back);
  assert.deepEqual(await closed, ['kicked']);
});

test('start y end sólo para el anfitrión; jugando no entra nadie nuevo', async () => {
  const { host, guest, made } = await hostAndGuest('hi', 'gi');
  assert.equal((await req(guest, 'start', {})).err, 'not-host');
  assert.deepEqual(await req(host, 'start', {}), { ok: true });
  const late = await connected(client('gi2'));
  assert.equal((await req(late, 'join', { code: made.code })).err, 'started');
  assert.deepEqual(await req(host, 'end', {}), { ok: true });
  assert.equal((await req(late, 'join', { code: made.code })).ok, true);
});

test('el anfitrión se va: closed(host-left) para el invitado', async () => {
  const { host, guest } = await hostAndGuest('hj', 'gj');
  const closed = once(guest, 'closed');
  const notHost = never(host, 'closed', 200);
  assert.deepEqual(await req(host, 'leave', {}), { ok: true });
  assert.deepEqual(await closed, ['host-left']);
  await notHost;
});

test('al reiniciar se avisa closed(server-restart)', async () => {
  const { guest } = await hostAndGuest('hk', 'gk');
  const closed = once(guest, 'closed');
  srv.shutdown('server-restart');
  assert.deepEqual(await closed, ['server-restart']);
});

test('/healthz responde', async () => {
  const r = await fetch(url + '/healthz');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(typeof j.rooms, 'number');
  assert.equal(typeof j.sockets, 'number');
  assert.deepEqual(Object.keys(j.paths).sort(), ['direct', 'server']);
  assert.equal((await fetch(url + '/otra')).status, 404);
});

test('IP pública: Fly-Client-IP, si no X-Forwarded-For, si no la del socket', () => {
  const hs = (headers, address = '::ffff:10.0.0.1') => ({ headers, address });
  assert.equal(publicIp(hs({ 'fly-client-ip': '5.5.5.5', 'x-forwarded-for': '6.6.6.6' }), true), '5.5.5.5');
  assert.equal(publicIp(hs({ 'x-forwarded-for': '6.6.6.6, 7.7.7.7' }), true), '6.6.6.6');
  assert.equal(publicIp(hs({}), true), '10.0.0.1');
  assert.equal(publicIp(hs({ 'x-forwarded-for': '6.6.6.6' }), false), '10.0.0.1');
});
