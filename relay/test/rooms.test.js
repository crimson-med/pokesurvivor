/* ============ rooms.test.js: lógica de las salas, sin red ============ */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRooms, keyOf, AWAY_MS, IDLE_MS, REUSE_MS } = require('../rooms');

const WORDS = Array.from({ length: 50 }, (_, i) => i + 1);

function setup(o = {}) {
  const clock = { t: 1000000 };
  const r = createRooms({ words: WORDS, now: () => clock.t, ...o });
  return { r, clock };
}

const info = name => ({ name, dex: 25, shiny: false });
const V = { v: 1 };
const host = (r, uid = 'h', mode = 'direct', extra = {}) => r.create(uid, info(uid), { mode }, { ...V, pubIp: '1.1.1.1', sid: 's-' + uid, ...extra });
const guest = (r, code, uid, extra = {}) => r.join(code, uid, info(uid), { ...V, pubIp: '2.2.2.2', sid: 's-' + uid, ...extra });

test('create da un código de 4 números de la lista y una sala de espera', () => {
  const { r } = setup();
  const f = host(r);
  assert.equal(f.ok, true);
  assert.equal(f.room.code.length, 4);
  for (const n of f.room.code) assert.ok(WORDS.includes(n));
  const s = r.snapshot(f.room);
  assert.deepEqual(Object.keys(s).sort(), ['code', 'directWaitMs', 'host', 'members', 'mode', 'state'].sort());
  assert.equal(s.state, 'lobby');
  assert.equal(s.mode, 'direct');
  assert.equal(s.host, 'h');
  assert.equal(s.directWaitMs, 6000);
  assert.deepEqual(s.members, [{ uid: 'h', name: 'h', dex: 25, shiny: false, online: true, path: null, sameNet: false, hideIp: false }]);
});

test('create con { id }: la clave es el id y code es null', () => {
  const { r } = setup();
  const f = r.create('h', info('h'), { id: 'h' }, V);
  assert.equal(f.ok, true);
  assert.equal(r.snapshot(f.room).code, null);
  const g = r.join('h', 'g', info('g'), V);
  assert.equal(g.ok, true);
  assert.equal(r.snapshot(g.room).members.length, 2);
  // Nadie puede crear con el id de otro (ni con uno con forma de código).
  assert.equal(r.create('x', info('x'), { id: 'h' }, V).err, 'bad-id');
  assert.equal(r.create('1-2-3-4', info('x'), { id: '1-2-3-4' }, V).err, 'bad-id');
  assert.equal(r.roomOf('g').host, 'h');
  // El anfitrión puede volver a crearla con su id: se cierra la vieja.
  const again = r.create('h', info('h'), { id: 'h' }, V);
  assert.equal(again.ok, true);
  assert.equal(again.closed[0].why, 'host-left');
});

test('mode server se guarda; cualquier otra cosa es direct', () => {
  const { r } = setup();
  assert.equal(host(r, 'a', 'server').room.mode, 'server');
  assert.equal(host(r, 'b', 'raro').room.mode, 'direct');
});

test('hasta 4 jugadores; el quinto recibe full', () => {
  const { r } = setup();
  const code = host(r).room.code;
  for (const u of ['g1', 'g2', 'g3']) assert.equal(guest(r, code, u).ok, true);
  assert.equal(guest(r, code, 'g4').err, 'full');
});

test('join acepta el código como array o como texto con guiones', () => {
  const { r } = setup();
  const code = host(r).room.code;
  assert.equal(guest(r, code.join('-'), 'g1').ok, true);
  assert.equal(guest(r, code, 'g2').ok, true);
  assert.equal(guest(r, [1, 2, 3], 'g3').err, 'not-found');
  assert.equal(guest(r, null, 'g3').err, 'not-found');
  assert.equal(keyOf([1, 2, 3, 4.5]), null);
});

test('el orden del código cuenta', () => {
  let i = 0;
  const seq = [1, 2, 3, 4];
  const { r } = setup({ randomInt: () => seq[i++ % 4] - 1 });
  const code = host(r).room.code;
  assert.deepEqual(code, [1, 2, 3, 4]);
  assert.equal(guest(r, [4, 3, 2, 1], 'g').err, 'not-found');
  assert.equal(guest(r, [1, 2, 3, 4], 'g').ok, true);
});

test('los códigos no se repiten entre salas vivas ni 10 minutos tras cerrar', () => {
  // El azar siempre da el mismo código: la segunda sala no encuentra hueco.
  const { r, clock } = setup({ randomInt: () => 0 });
  const a = host(r, 'a');
  assert.equal(a.ok, true);
  assert.equal(host(r, 'b').err, 'busy');
  r.leave('a');
  assert.equal(host(r, 'b').err, 'busy');   // cerrado hace nada
  clock.t += REUSE_MS - 1;
  assert.equal(host(r, 'b').err, 'busy');
  clock.t += 1;
  assert.equal(host(r, 'b').ok, true);
});

test('crear con muchas salas vivas da códigos distintos', () => {
  const { r } = setup();
  const keys = new Set();
  for (let i = 0; i < 200; i++) keys.add(host(r, 'u' + i).room.key);
  assert.equal(keys.size, 200);
});

test('una sala por cuenta: crear otra cierra la vieja', () => {
  const { r } = setup();
  const a = host(r);
  guest(r, a.room.code, 'g');
  const b = host(r);
  assert.equal(b.ok, true);
  assert.equal(b.closed.length, 1);
  assert.equal(b.closed[0].room, a.room);
  assert.equal(b.closed[0].why, 'host-left');
  assert.equal(b.closed[0].except, 'h');
  assert.equal(r.size, 1);
  assert.equal(guest(r, a.room.code, 'x').err, 'not-found');
});

test('MAX_ROOMS: create da busy sin sacar a nadie de su sala', () => {
  const { r } = setup({ maxRooms: 2 });
  const a = host(r, 'a');
  host(r, 'b');
  guest(r, a.room.code, 'g');
  assert.equal(host(r, 'c').err, 'busy');
  const f = host(r, 'g');
  assert.equal(f.err, 'busy');
  assert.equal(f.gone.length, 0);
  assert.equal(r.roomOf('g'), a.room);
  // El anfitrión de una sala sí puede cambiarla por otra.
  assert.equal(host(r, 'a').ok, true);
});

test('sala jugando: started, salvo si vuelve uno que ya estaba', () => {
  const { r } = setup();
  const code = host(r).room.code;
  guest(r, code, 'g');
  assert.equal(r.start('g').err, 'not-host');
  assert.equal(r.start('h').ok, true);
  assert.equal(guest(r, code, 'x').err, 'started');
  r.markAway('g', 's-g');
  const back = guest(r, code, 'g', { sid: 's-g2' });
  assert.equal(back.ok, true);
  assert.equal(back.peer[0].state, 'online');
  assert.equal(r.end('h').ok, true);
  assert.equal(guest(r, code, 'x').ok, true);
});

test('join con otra versión que el anfitrión: old-version', () => {
  const { r } = setup();
  const code = host(r).room.code;
  assert.equal(guest(r, code, 'g', { v: 2 }).err, 'old-version');
});

test('el invitado siempre llega al anfitrión, diga lo que diga to', () => {
  const { r } = setup();
  const code = host(r).room.code;
  guest(r, code, 'g1');
  guest(r, code, 'g2');
  assert.equal(r.target('g1', 'g2').member.uid, 'h');
  assert.equal(r.target('g1', 'nadie').member.uid, 'h');
  assert.equal(r.target('g1', undefined).member.uid, 'h');
  assert.equal(r.target('h', 'g2').member.uid, 'g2');
  assert.equal(r.target('h', 'h'), null);
  assert.equal(r.target('h', 'nadie'), null);
  assert.equal(r.target('fuera', 'h'), null);
});

test('si se va el anfitrión se cierra la sala; si se va un invitado, queda su hueco libre', () => {
  const { r } = setup();
  const code = host(r).room.code;
  guest(r, code, 'g1');
  guest(r, code, 'g2');
  guest(r, code, 'g3');
  const f = r.leave('g1');
  assert.deepEqual(f.gone.map(g => g.uid), ['g1']);
  assert.equal(r.roomOf('g1'), null);
  assert.equal(guest(r, code, 'g4').ok, true);
  const c = r.leave('h');
  assert.equal(c.closed[0].why, 'host-left');
  assert.equal(r.roomOf('g2'), null);
  assert.equal(r.size, 0);
});

test('kick: sólo el anfitrión, y el expulsado sale', () => {
  const { r } = setup();
  const code = host(r).room.code;
  guest(r, code, 'g1');
  guest(r, code, 'g2');
  assert.equal(r.kick('g1', 'g2').err, 'not-host');
  assert.equal(r.kick('h', 'h').err, 'not-found');
  const f = r.kick('h', 'g2');
  assert.equal(f.ok, true);
  assert.equal(f.kicked.uid, 'g2');
  assert.equal(f.kicked.sid, 's-g2');
  assert.equal(r.roomOf('g2'), null);
});

test('path: lo pone el anfitrión, empieza en null', () => {
  const { r } = setup();
  const code = host(r).room.code;
  guest(r, code, 'g');
  const room = r.roomOf('g');
  assert.equal(r.snapshot(room).members[1].path, null);
  assert.equal(r.path('g', 'g', 'direct').err, 'not-host');
  assert.equal(r.path('h', 'g', 'raro').err, 'bad-path');
  assert.equal(r.path('h', 'g', 'server').ok, true);
  assert.equal(r.snapshot(room).members[1].path, 'server');
  assert.deepEqual(r.stats(), { rooms: 1, paths: { direct: 0, server: 1 } });
});

test('sameNet: misma IP pública que el anfitrión; hideIp sale en el estado', () => {
  const { r } = setup();
  const code = host(r).room.code;
  const a = guest(r, code, 'a', { pubIp: '1.1.1.1', hideIp: true });
  const b = guest(r, code, 'b', { pubIp: '9.9.9.9' });
  const s = r.snapshot(b.room);
  const by = Object.fromEntries(s.members.map(m => [m.uid, m]));
  assert.equal(by.a.sameNet, true);
  assert.equal(by.a.hideIp, true);
  assert.equal(by.b.sameNet, false);
  assert.equal(by.h.sameNet, false);
  assert.ok(!JSON.stringify(s).includes('1.1.1.1'));
  // El anfitrión vuelve con otra IP: se recalcula.
  r.markAway('h', 's-h');
  r.markBack('h', { sid: 's-h2', pubIp: '9.9.9.9' });
  const s2 = Object.fromEntries(r.snapshot(b.room).members.map(m => [m.uid, m]));
  assert.equal(s2.a.sameNet, false);
  assert.equal(s2.b.sameNet, true);
});

test('caído 30 s: se libera el hueco; vuelve antes y lo conserva', () => {
  const { r, clock } = setup();
  const code = host(r).room.code;
  guest(r, code, 'g1');
  guest(r, code, 'g2');
  const away = r.markAway('g1', 's-g1');
  assert.deepEqual(away.peer.map(p => [p.uid, p.state]), [['g1', 'away']]);
  // Un socket viejo que se cierra tarde no cuenta.
  assert.equal(r.markAway('g2', 'otro').peer.length, 0);
  clock.t += AWAY_MS - 1;
  assert.equal(r.expire().gone.length, 0);
  const back = r.markBack('g1', { sid: 's-g1b' });
  assert.equal(back.ok, true);
  assert.equal(back.peer[0].state, 'online');
  clock.t += AWAY_MS * 2;
  assert.equal(r.expire().gone.length, 0);
  r.markAway('g2', 's-g2');
  clock.t += AWAY_MS;
  const f = r.expire();
  assert.deepEqual(f.gone.map(g => g.uid), ['g2']);
  assert.equal(r.roomOf('g2'), null);
  assert.equal(r.roomOf('g1').members.size, 2);
});

test('anfitrión caído 30 s: la sala se cierra con host-left', () => {
  const { r, clock } = setup();
  const code = host(r).room.code;
  guest(r, code, 'g');
  r.start('h');
  r.markAway('h', 's-h');
  clock.t += AWAY_MS;
  const f = r.expire();
  assert.equal(f.closed.length, 1);
  assert.equal(f.closed[0].why, 'host-left');
  assert.equal(r.size, 0);
});

test('sala de espera sin cambios 30 min: idle; jugando no se cierra', () => {
  const { r, clock } = setup();
  host(r, 'a');
  const b = host(r, 'b');
  r.start('b');
  clock.t += IDLE_MS - 1;
  assert.equal(r.expire().closed.length, 0);
  clock.t += 1;
  const f = r.expire();
  assert.deepEqual(f.closed.map(c => c.why), ['idle']);
  assert.equal(r.size, 1);
  assert.equal(r.roomOf('b'), b.room);
});

test('un cambio en la sala de espera retrasa el cierre por inactividad', () => {
  const { r, clock } = setup();
  const code = host(r).room.code;
  clock.t += IDLE_MS - 1000;
  guest(r, code, 'g');
  clock.t += 2000;
  assert.equal(r.expire().closed.length, 0);
});

test('entrar en otra sala te saca de la anterior', () => {
  const { r } = setup();
  const a = host(r, 'a').room.code;
  const b = host(r, 'b').room.code;
  guest(r, a, 'g');
  const f = guest(r, b, 'g');
  assert.equal(f.ok, true);
  assert.deepEqual(f.gone.map(x => x.uid), ['g']);
  assert.equal(r.roomOf('a').members.size, 1);
  // Un anfitrión que entra en otra sala cierra la suya.
  const f2 = guest(r, b, 'a');
  assert.equal(f2.closed[0].why, 'host-left');
});

test('member limpia los datos que llegan', () => {
  const { r } = setup();
  const room = host(r).room;
  r.update('h', { name: '  ' + 'x'.repeat(50), dex: -3, shiny: 'si' });
  const m = r.snapshot(room).members[0];
  assert.equal(m.name.length, 32);
  assert.equal(m.dex, 0);
  assert.equal(m.shiny, false);
});
