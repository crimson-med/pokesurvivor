/* ============ io.test.js: el socket de verdad, con clientes en 127.0.0.1 ============ */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioc } = require('socket.io-client');
const { createServer } = require('../index');
const { loadConfig } = require('../config');
const { publicIp, originOk } = require('../relay/io');
const { createRooms } = require('../relay/rooms');
const { createLimits } = require('../relay/limits');
const store = require('../db');
const { sessionCookie } = require('./helpers');

const ORIGIN = 'http://localhost:8000';
const WORDS = Array.from({ length: 100 }, (_, i) => i + 1);

let srv, url;
const open = [];
// Lo que hace el ranking al empezar una partida en grupo (deps.rank, paso 7).
const coopRuns = [];
let rank = null;
// Cuentas bloqueadas (users.banned): lo que diría guard.fromCookie.
const banned = new Set();

function start(env = {}) {
  const cfg = loadConfig({ SITE_URL: ORIGIN, ...env });
  return createServer(cfg, {
    store: store.open(':memory:', { log: false }),
    relay: {
      rooms: createRooms({ words: WORDS }),
      // Todos los clientes de la prueba vienen de 127.0.0.1: el tope por IP se
      // sube aquí (se prueba en limits.test.js) y queda el de la cuenta.
      limits: createLimits({ joinIp: [1000, 60000] }),
      rank: { openCoopRun: room => (rank ? rank.openCoopRun(room) : null) },
      sessionOf: h => { const w = srv.guard.fromCookie(h); return w && banned.has(w.uid) ? { ...w, banned: true } : w; },
    },
  });
}

test.before(async () => {
  srv = start();
  const port = await srv.listen(0, '127.0.0.1');
  url = 'http://127.0.0.1:' + port;
});

test.after(async () => {
  for (const s of open) s.close();
  await srv.close();
});

// Una sesión por cuenta (la misma al volver a conectar), en la base de datos del servidor.
const cookies = new Map();
function cookieFor(uid) {
  if (!cookies.has(uid)) cookies.set(uid, sessionCookie(srv.store, uid));
  return cookies.get(uid);
}

// o.cookie: la cabecera Cookie (null = ninguna); si no, la de la cuenta `uid`.
function client(uid, o = {}) {
  const cookie = o.cookie !== undefined ? o.cookie : cookieFor(uid);
  const s = ioc(o.url || url, {
    auth: { v: 2, dex: 25, shiny: false, ep: 'ep-' + uid, ...o.auth },
    transports: ['websocket'], reconnection: false, forceNew: true,
    extraHeaders: { ...(cookie ? { cookie } : {}), ...o.headers },
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

test('una v distinta se rechaza con old-version; la 2 y la anterior entran', async () => {
  for (const v of [99, 0, undefined, '2']) {
    const err = await connected(client('v0', { auth: { v } })).catch(e => e);
    assert.equal(err.message, 'old-version', String(v));
  }
  await connected(client('v1', { auth: { v: 1 } }));
  await connected(client('v2'));
});

test('una cuenta bloqueada no entra: banned', async () => {
  banned.add('ban1');
  try {
    const err = await connected(client('ban1')).catch(e => e);
    assert.equal(err.message, 'banned');
  } finally { banned.delete('ban1'); }
  await connected(client('ban1'));
  // users.banned en la base de datos (lo que pone /api/admin/ban).
  const cookie = cookieFor('ban2');
  srv.store.prep('UPDATE users SET banned = 1 WHERE uid = ?').run('ban2');
  assert.equal((await connected(client('ban2', { cookie })).catch(e => e)).message, 'banned');
  srv.store.prep('UPDATE users SET banned = 0 WHERE uid = ?').run('ban2');
  await connected(client('ban2', { cookie }));
});

test('con la cookie de una sesión entra; sin ella, con otra o con una inventada: signed-out', async () => {
  await connected(client('ok1'));
  const fake = 'ps_sid=' + 'A'.repeat(43);
  for (const cookie of [null, fake, 'ps_sid=corta', 'otra=1', cookieFor('ok1') + 'x']) {
    const err = await connected(client('x', { cookie })).catch(e => e);
    assert.equal(err.message, 'signed-out', String(cookie));
  }
  // auth.dev (el del paso 1) ya no vale.
  const err = await connected(client('x', { cookie: null, auth: { dev: 'ok1' } })).catch(e => e);
  assert.equal(err.message, 'signed-out');
});

test('el nombre es el de la cuenta, no el que manda el cliente', async () => {
  const cookie = sessionCookie(srv.store, 'nm1', { name: 'Misty' });
  const host = await connected(client('nm1', { cookie, auth: { name: 'Otro' } }));
  const made = await req(host, 'create', { mode: 'server' });
  assert.equal(made.room.members[0].name, 'Misty');
});

test('kick: los sockets de una sesión (o de toda la cuenta) se cierran', async () => {
  const a = await connected(client('kk1'));
  const gone = new Promise(r => a.once('disconnect', r));
  srv.relay.kick('kk1', 'otra-sesion');
  await never(a, 'disconnect', 150);
  srv.relay.kick('kk1');
  assert.equal(await gone, 'io server disconnect');
});

test('un origen que no es SITE_URL no conecta', async () => {
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
  assert.deepEqual(g, { uid: 'ga', name: 'ga', dex: 25, shiny: false, online: true, path: null, sameNet: true, hideIp: true, ep: 'ep-ga' });
  assert.ok(!JSON.stringify(snap).includes('127.0.0.1'));
  const reversed = made.code.slice().reverse();
  if (reversed.join() !== made.code.join()) {
    const other = await connected(client('ga2'));
    assert.equal((await req(other, 'join', { code: reversed })).err, 'not-found');
  }
});

test('sólo códigos: create con { id } da una sala con código y join por uid no encuentra nada', async () => {
  const host = await connected(client('hid'));
  const made = await req(host, 'create', { id: 'hid' });
  assert.equal(made.ok, true);
  assert.equal(made.code.length, 4);
  assert.deepEqual(made.room.code, made.code);
  const guest = await connected(client('gid'));
  assert.equal((await req(guest, 'join', { code: 'hid' })).err, 'not-found');
  assert.equal((await req(guest, 'join', { code: made.code })).ok, true);
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
  assert.deepEqual(await req(host, 'start', {}), { ok: true, run: null });
  const late = await connected(client('gi2'));
  assert.equal((await req(late, 'join', { code: made.code })).err, 'started');
  assert.deepEqual(await req(host, 'end', {}), { ok: true });
  assert.equal((await req(late, 'join', { code: made.code })).ok, true);
});

test('start abre la partida en grupo del ranking (deps.rank.openCoopRun) y su run va en la respuesta', async () => {
  const { host, guest } = await hostAndGuest('hr', 'gr');
  rank = { openCoopRun: room => { coopRuns.push([room.host, [...room.members.keys()], room.state]); return 'run-1'; } };
  try {
    assert.equal((await req(guest, 'start', {})).err, 'not-host');
    assert.deepEqual(coopRuns, [], 'only when the host really starts');
    assert.deepEqual(await req(host, 'start', {}), { ok: true, run: 'run-1' });
    assert.deepEqual(coopRuns, [['hr', ['hr', 'gr'], 'playing']]);
    // Promesa o fallo: la partida empieza igual (sin run si falla).
    rank = { openCoopRun: async () => ({ id: 'run-2' }) };
    assert.deepEqual(await req(host, 'start', {}), { ok: true, run: { id: 'run-2' } });
    const err = console.error; console.error = () => {};
    try {
      rank = { openCoopRun: () => { throw new Error('db'); } };
      assert.deepEqual(await req(host, 'start', {}), { ok: true, run: null });
      rank = { openCoopRun: async () => { throw new Error('db'); } };
      assert.deepEqual(await req(host, 'start', {}), { ok: true, run: null });
    } finally { console.error = err; }
  } finally { rank = null; }
});

test('ep: el invitado que recarga vuelve con otro ep y el anfitrión lo ve en la foto de la sala', async () => {
  const { host, guest } = await hostAndGuest('hep', 'gep');
  await new Promise(r => setTimeout(r, 100));     // (que lleguen antes las fotos del join)
  const away = once(host, 'peer'), awayRoom = once(host, 'room');
  guest.close();
  await away; await awayRoom;
  const online = once(host, 'peer');
  const roomEv = once(host, 'room');   // (peer y room salen juntos: online primero)
  await connected(client('gep', { auth: { ep: 'recargada' } }));
  assert.deepEqual(await online, ['gep', 'online']);
  const [snap] = await roomEv;
  assert.deepEqual(snap.members.map(m => [m.uid, m.ep, m.online]), [['hep', 'ep-hep', true], ['gep', 'recargada', true]]);
  // Un ep raro no se guarda.
  const bad = await connected(client('gep2', { auth: { ep: 'x'.repeat(40) } }));
  const made = await req(bad, 'create', { mode: 'direct' });
  assert.equal(made.room.members[0].ep, null);
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
  srv.relay.shutdown('server-restart');
  assert.deepEqual(await closed, ['server-restart']);
});

test('origen: SITE_URL, sin Origin, y localhost sólo en desarrollo', () => {
  const dev = loadConfig({ SITE_URL: 'https://play.example.com' });
  const prod = loadConfig({ SITE_URL: 'https://play.example.com', NODE_ENV: 'production', CODE_PEPPER: 'x' });
  for (const cfg of [dev, prod]) {
    assert.equal(originOk(undefined, cfg), true);
    assert.equal(originOk('https://play.example.com', cfg), true);
    assert.equal(originOk('https://otra.web', cfg), false);
    assert.equal(originOk('https://play.example.com.otra.web', cfg), false);
  }
  assert.equal(originOk('http://localhost:5173', dev), true);
  assert.equal(originOk('http://localhost:5173', prod), false);
});

test('IP pública: la que puso el último proxy de confianza en X-Forwarded-For, si no la del socket', () => {
  const hs = (headers, address = '::ffff:10.0.0.1') => ({ headers, address });
  // Lo que inventa el jugador queda a la izquierda: no cuenta.
  assert.equal(publicIp(hs({ 'x-forwarded-for': '6.6.6.6, 7.7.7.7' }), 1), '7.7.7.7');
  assert.equal(publicIp(hs({ 'x-forwarded-for': '6.6.6.6, 7.7.7.7, 8.8.8.8' }), 2), '7.7.7.7');
  assert.equal(publicIp(hs({ 'fly-client-ip': '5.5.5.5', 'x-forwarded-for': '::ffff:6.6.6.6' }), 1), '6.6.6.6');
  assert.equal(publicIp(hs({ 'x-forwarded-for': '6.6.6.6' }), 2), '10.0.0.1');
  assert.equal(publicIp(hs({}), 1), '10.0.0.1');
  assert.equal(publicIp(hs({ 'x-forwarded-for': '6.6.6.6' }), 0), '10.0.0.1');
});

test('member cambia dex y shiny, no el nombre de la cuenta', async () => {
  const { host, guest } = await hostAndGuest('hm', 'gm');
  const ev = once(host, 'room');
  guest.emit('member', { name: 'hm', dex: 7, shiny: true });
  const [snap] = await ev;
  assert.deepEqual(snap.members[1], { uid: 'gm', name: 'gm', dex: 7, shiny: true, online: true, path: null, sameNet: true, hideIp: false, ep: 'ep-gm' });
});
