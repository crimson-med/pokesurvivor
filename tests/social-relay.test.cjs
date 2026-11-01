// Salas en el servidor propio (?relay): js/net/social.js de verdad, con un G.Relay
// falso unido a un servidor en memoria (docs/relay-coop/02-protocol.md) y un
// Firestore falso para amigos e invitaciones. Sin ?relay, todo por la Realtime Database.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'js/net/social.js'), 'utf8');

const clone = o => (o === undefined ? o : JSON.parse(JSON.stringify(o)));
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };
const codeErr = c => Object.assign(Error(c), { code: c });
const isErr = e => Object.prototype.toString.call(e) === '[object Error]';   // (Error de otro contexto de vm)

// ---------------- servidor falso ----------------
const CODES = [[25, 95, 151, 133], [1, 4, 7, 152], [6, 9, 3, 150]];
function server(opts = {}) {
  const rooms = new Map();          // 'a-b-c-d' -> { code, state, mode, host, members }
  const clients = new Map();        // uid -> relay falso
  let n = 0;
  const srv = { rooms, clients, down: false, sameNet: false, rate: false, busy: false };
  const key = c => c.join('-');
  const roomOf = u => [...rooms.values()].find(r => r.members.some(m => m.uid === u));
  const snap = r => clone({ code: r.code, state: r.state, mode: r.mode, host: r.host, directWaitMs: 6000, members: r.members });
  const push = r => { for (const m of r.members) if (clients.has(m.uid)) clients.get(m.uid).fire('room', snap(r)); };
  const close = (r, why, but) => {
    rooms.delete(key(r.code));
    for (const m of r.members) if (m.uid !== but && clients.has(m.uid)) clients.get(m.uid).fire('closed', why);
  };
  const member = (u, extra) => Object.assign({ uid: u, online: true, path: null, sameNet: false, hideIp: false }, clients.get(u).info, extra);
  srv.handle = (u, ev, p) => {
    const r = roomOf(u);
    if (ev === 'create') {
      if (srv.busy) return { ok: false, err: 'busy' };
      const old = [...rooms.values()].find(x => x.host === u);
      if (old) close(old, 'host-left', u);
      const code = CODES[n++ % CODES.length];
      const room = { code, state: 'lobby', mode: p.mode, host: u, members: [member(u)] };
      rooms.set(key(code), room);
      return { ok: true, code, room: snap(room) };
    }
    if (ev === 'join') {
      if (srv.rate) return { ok: false, err: 'rate' };
      const room = Array.isArray(p.code) ? rooms.get(key(p.code)) : null;
      if (!room) return { ok: false, err: 'not-found' };
      if (room.state === 'playing') return { ok: false, err: 'started' };
      if (room.members.length >= 4) return { ok: false, err: 'full' };
      room.members.push(member(u, { sameNet: srv.sameNet, hideIp: !!p.hideIp, path: p.hideIp ? 'server' : null }));
      setImmediate(() => push(room));
      return { ok: true, room: snap(room), sameNet: srv.sameNet };
    }
    if (!r) return { ok: false, err: 'not-in-room' };
    if (ev === 'leave') {
      if (r.host === u) close(r, 'host-left', u);
      else { r.members = r.members.filter(m => m.uid !== u); setImmediate(() => push(r)); }
      return { ok: true };
    }
    if (ev === 'member') { Object.assign(r.members.find(m => m.uid === u), p); setImmediate(() => push(r)); return; }
    if (r.host !== u) return { ok: false, err: 'not-host' };
    if (ev === 'start' || ev === 'end') { r.state = ev === 'start' ? 'playing' : 'lobby'; setImmediate(() => push(r)); return { ok: true }; }
    if (ev === 'kick') {
      r.members = r.members.filter(m => m.uid !== p.uid);
      if (clients.has(p.uid)) clients.get(p.uid).fire('closed', 'kicked');
      setImmediate(() => push(r));
      return { ok: true };
    }
    return { ok: false, err: 'bad-event' };
  };
  return srv;
}

function fakeRelay(srv, uid, info, connectErr) {
  const ls = new Map(), calls = [];
  const R = {
    enabled: true, state: 'off', uid, room: null, calls, info,
    async connect() {
      calls.push(['connect']);
      if (connectErr || srv.down) throw codeErr(connectErr || 'unreachable');
      R.state = 'online';
    },
    async request(ev, p) {
      calls.push([ev, clone(p)]);
      const a = srv.handle(uid, ev, clone(p));
      if (a && a.ok === false) throw codeErr(a.err);
      if (a && a.room) R.room = a.room;
      return a;
    },
    emit(ev, p) { calls.push([ev, clone(p)]); srv.handle(uid, ev, clone(p)); },
    on(ev, fn) { if (!ls.has(ev)) ls.set(ev, new Set()); ls.get(ev).add(fn); },
    off(ev, fn) { if (ls.has(ev)) ls.get(ev).delete(fn); },
    fire(ev, ...args) { if (ev === 'room') R.room = args[0]; setImmediate(() => { for (const fn of ls.get(ev) || []) fn(...args); }); },
    sent: ev => calls.filter(c => c[0] === ev)
  };
  srv.clients.set(uid, R);
  return R;
}

// ---------------- Firestore y Realtime Database falsos ----------------
function fakeFs() {
  const cols = new Map(), subs = [];
  const col = n => { if (!cols.has(n)) cols.set(n, new Map()); return cols.get(n); };
  const docOf = (n, id, d) => ({ id, data: () => clone(d), ref: docRef(n, id) });
  const snapOf = (s, changes) => ({
    docChanges: () => changes,
    forEach: fn => { for (const [id, d] of col(s.n)) if (s.match(d)) fn(docOf(s.n, id, d)); }
  });
  function notify(n, id, type, d) {
    for (const s of subs) if (s.n === n && s.match(d)) setImmediate(() => s.cb(snapOf(s, [{ type, doc: docOf(n, id, d) }])));
  }
  function docRef(n, id) {
    return {
      id,
      async get() { const d = col(n).get(id); return { exists: !!d, data: () => clone(d) }; },
      async set(d) { const had = col(n).has(id); col(n).set(id, clone(d)); notify(n, id, had ? 'modified' : 'added', d); },
      async update(p) { col(n).set(id, Object.assign(col(n).get(id) || {}, clone(p))); },
      async delete() { const d = col(n).get(id); if (d) { col(n).delete(id); notify(n, id, 'removed', d); } }
    };
  }
  function query(n, f, op, v) {
    const match = d => !!d && (op === '==' ? d[f] === v : (d[f] || []).includes(v));
    return {
      onSnapshot(cb) {
        const s = { n, match, cb };
        subs.push(s);
        const init = [...col(n)].filter(([, d]) => match(d)).map(([id, d]) => ({ type: 'added', doc: docOf(n, id, d) }));
        setImmediate(() => cb(snapOf(s, init)));
        return () => subs.splice(subs.indexOf(s), 1);
      },
      async get() { return { docs: [...col(n)].filter(([, d]) => match(d)).map(([id, d]) => docOf(n, id, d)) }; }
    };
  }
  return {
    cols, col,
    collection: n => ({ doc: id => docRef(n, id), where: (f, op, v) => query(n, f, op, v) }),
    runTransaction: async () => {}
  };
}

function fakeRtdb(log) {
  const ref = p => ({
    path: p,
    async set() { log.push(['set', p]); },
    async update() { log.push(['update', p]); },
    async remove() { log.push(['remove', p]); },
    async get() { log.push(['get', p]); return { val: () => null, numChildren: () => 0 }; },
    on() { log.push(['on', p]); }, off() {},
    onDisconnect: () => ({ remove() { log.push(['onDisconnect', p]); }, cancel: async () => {} }),
    child: c => ref(p + '/' + c),
    orderByChild: () => ({ equalTo: () => ({ limitToFirst: () => ({ async get() { log.push(['query', p]); return { forEach() {} }; } }) }) })
  });
  return { ref, goOnline() { log.push(['goOnline']); }, goOffline() { log.push(['goOffline']); } };
}

// ---------------- un jugador ----------------
const NAMES = { pikachu: 25, onix: 95, mew: 151, eevee: 133, bulbasaur: 1, charmander: 4, squirtle: 7 };
function player(uid, name, o = {}) {
  const rtdbLog = [], store = new Map(o.storage || []);
  if (!store.has('ps.nick.' + uid)) store.set('ps.nick.' + uid, name);
  const settings = o.settings || {};
  const G = {
    DB: {
      online: true, user: name, nameAccount: false, save: { name, partner: o.dex || 25, partnerShiny: !!o.shiny },
      fb: { uid, fs: o.fs || fakeFs(), rtdb: fakeRtdb(rtdbLog) },
      setName() {}, ownsShiny: () => true, onLeave() {}
    },
    Settings: { get: k => settings[k] },
    Net: { isLocalIp: ip => /^192\.168\./.test(ip), publicIp: async () => '203.0.113.7' }
  };
  if (o.srv) G.Relay = fakeRelay(o.srv, uid, { name, dex: o.dex || 25, shiny: !!o.shiny }, o.connectErr);
  if (o.relayOff && G.Relay) G.Relay.enabled = false;
  if (o.noRelay) delete G.Relay;
  if (!o.noRoomCode) {
    G.RoomCode = {
      parseCode: s => {
        const p = String(s).toLowerCase().split(/[\s,-]+/).filter(Boolean).map(w => NAMES[w]);
        return p.length === 4 && p.every(Boolean) ? p : null;
      }
    };
  }
  const ctx = {
    G, console: { warn() {}, log: console.log },
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    fetch: () => Promise.reject(Error('offline')),
    firebase: { database: { ServerValue: { TIMESTAMP: 0 } }, firestore: { FieldValue: { serverTimestamp: () => Date.now() } } },
    setTimeout, clearTimeout, setImmediate, Date, crypto: globalThis.crypto, TextEncoder, btoa
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const S = G.Social, events = [];
  S.on(w => events.push(w));
  return { G, S, R: G.Relay, rtdbLog, events, store, settings };
}
// Las escrituras y lecturas de salas en la Realtime Database (goOffline al entrar no cuenta).
const roomTraffic = p => p.rtdbLog.filter(e => e[0] !== 'goOffline');

async function pair(o = {}) {
  const srv = o.srv || server(), sharedFs = fakeFs();
  const host = player('H1', 'Ash', Object.assign({ srv, fs: sharedFs }, o.host));
  const guest = player('G1', 'Misty', Object.assign({ srv, fs: sharedFs, dex: 120 }, o.guest));
  await host.S.start(); await guest.S.start();
  return { srv, host, guest, fs: sharedFs };
}

// ---------------- sin ?relay: como siempre ----------------

test('relay off: rooms go through the Realtime Database and G.Relay is never called', async () => {
  for (const which of ['disabled', 'missing']) {
    const srv = server();
    const p = player('H1', 'Ash', which === 'disabled' ? { srv, relayOff: true } : { noRelay: true });
    await p.S.start();
    const r = await p.S.createRoom();
    assert.equal(r.id, 'H1', which + ': the room is still named after the host');
    assert.equal(r.relay, undefined);
    assert.ok(p.rtdbLog.some(e => e[0] === 'set' && e[1] === 'rooms/H1'));
    p.S.setOpen(false); p.S.refreshMember(); p.S.dropMember('X');
    assert.ok(p.rtdbLog.some(e => e[0] === 'set' && e[1] === 'rooms/H1/open'));
    assert.ok(p.rtdbLog.some(e => e[0] === 'update' && e[1] === 'rooms/H1/m/H1'));
    assert.ok(p.rtdbLog.some(e => e[0] === 'remove' && e[1] === 'rooms/H1/m/X'));
    const j = await p.S.joinRoom('OTHER');
    assert.equal(j.ok, false);
    assert.equal(typeof j.error, 'string', 'errors are still the old strings');
    if (p.R) assert.deepEqual(p.R.calls, [], which + ': no relay call');
  }
});

test('relay off: invites carry no code', async () => {
  const sharedFs = fakeFs();
  sharedFs.col('friendships').set('G1_H1', { users: ['G1', 'H1'], from: 'H1', to: 'G1', status: 'ok', names: { H1: 'Ash', G1: 'Misty' } });
  const p = player('H1', 'Ash', { noRelay: true, fs: sharedFs });
  await p.S.start(); await p.S.ensureFriends();
  const r = await p.S.invite('G1');
  assert.equal(r.ok, true);
  const inv = sharedFs.col('inv').get('G1_H1');
  assert.equal(inv.room, 'H1');
  assert.equal('code' in inv, false);
});

// ---------------- crear ----------------

test('createRoom: connects, sends create (direct by default) and gives the usual room plus code and mode', async () => {
  const srv = server();
  const p = player('H1', 'Ash', { srv, dex: 6, shiny: true });
  await p.S.start();
  const r = await p.S.createRoom();
  assert.deepEqual(p.R.calls.slice(0, 2), [['connect'], ['create', { mode: 'direct' }]]);
  assert.equal(r, p.S.room);
  assert.equal(r.id, '25-95-151-133');
  assert.deepEqual(r.code, [25, 95, 151, 133]);
  assert.equal(r.mode, 'direct');
  assert.equal(r.host, 'H1');
  assert.equal(r.isHost, true);
  assert.equal(r.open, true);
  assert.equal(r.lost, false);
  assert.equal(r.relay, true);
  assert.deepEqual(clone(r.members), [{ uid: 'H1', name: 'Ash', dex: 6, shiny: true, online: true, path: null, sameNet: false, hideIp: false }]);
  assert.ok(p.events.includes('room'));
  assert.deepEqual(roomTraffic(p), [], 'no Realtime Database at all');
  assert.equal(await p.S.createRoom(), r, 'already in a room: the same one');
  assert.equal(p.R.sent('create').length, 1);
});

test('createRoom: { mode: "server" } (or just "server") and two calls at once make one room', async () => {
  const srv = server();
  const p = player('H1', 'Ash', { srv });
  await p.S.start();
  const [a, b] = await Promise.all([p.S.createRoom({ mode: 'server' }), p.S.createRoom({ mode: 'server' })]);
  assert.equal(a, b);
  assert.equal(a.mode, 'server');
  assert.deepEqual(p.R.sent('create'), [['create', { mode: 'server' }]]);
  await p.S.leaveRoom();
  assert.equal((await p.S.createRoom('server')).mode, 'server');
  assert.deepEqual(p.R.sent('create')[1], ['create', { mode: 'server' }]);
});

test('createRoom: server and relay errors reject as Error with .code', async () => {
  const srv = server();
  srv.busy = true;
  const p = player('H1', 'Ash', { srv });
  await p.S.start();
  await assert.rejects(p.S.createRoom(), e => isErr(e) && e.code === 'busy');
  assert.equal(p.S.room, null);
  for (const code of ['old-version', 'bad-token', 'unreachable']) {
    const q = player('H2', 'Brock', { srv: server(), connectErr: code });
    await q.S.start();
    await assert.rejects(q.S.createRoom(), e => isErr(e) && e.code === code);
    assert.deepEqual(q.R.sent('create'), [], 'nothing sent when the socket did not open');
  }
});

// ---------------- entrar ----------------

test('joinRoom: by code array, room id string or typed names; the host sees the guest from the room event', async () => {
  for (const input of [[25, 95, 151, 133], '25-95-151-133', ' Pikachu, onix MEW-eevee ']) {
    const { host, guest } = await pair();
    await host.S.createRoom();
    const j = await guest.S.joinRoom(input);
    assert.equal(j.ok, true, JSON.stringify(input));
    assert.deepEqual(guest.R.sent('join'), [['join', { code: [25, 95, 151, 133], hideIp: false }]]);
    const g = guest.S.room;
    assert.equal(g.id, '25-95-151-133');
    assert.equal(g.isHost, false);
    assert.equal(g.host, 'H1');
    assert.deepEqual(g.members.map(m => m.uid), ['H1', 'G1']);
    await settle();
    assert.deepEqual(host.S.room.members.map(m => m.uid), ['H1', 'G1'], 'host first, then by arrival');
    assert.equal(host.S.room.members[1].dex, 120);
    assert.ok(host.events.filter(e => e === 'room').length >= 2);
    assert.deepEqual(roomTraffic(host), []);
    assert.deepEqual(roomTraffic(guest), []);
    assert.deepEqual(clone(await guest.S.joinRoom(input)), { ok: true }, 'joining the room you are in does nothing');
    assert.equal(guest.R.sent('join').length, 1);
  }
});

test('joinRoom: hideIp comes from the coopHideIp setting, and sameNet and path reach the room', async () => {
  const srv = server();
  srv.sameNet = true;
  const { host, guest } = await pair({ srv, guest: { settings: { coopHideIp: true } } });
  await host.S.createRoom();
  const j = await guest.S.joinRoom([25, 95, 151, 133]);
  assert.equal(j.sameNet, true);
  assert.equal(guest.S.room.sameNet, true);
  assert.deepEqual(guest.R.sent('join')[0][1], { code: [25, 95, 151, 133], hideIp: true });
  await settle();
  const m = host.S.room.members.find(x => x.uid === 'G1');
  assert.equal(m.hideIp, true);
  assert.equal(m.sameNet, true);
  assert.equal(m.path, 'server');
});

test('joinRoom: errors come back as { ok: false, code, error: Error } with no text', async () => {
  const { srv, host, guest } = await pair();
  const check = async (input, code) => {
    const j = await guest.S.joinRoom(input);
    assert.equal(j.ok, false);
    assert.equal(j.code, code);
    assert.ok(isErr(j.error));
    assert.equal(j.error.code, code);
    assert.equal(guest.S.room, null);
  };
  await check([1, 2, 3, 4], 'not-found');
  const before = guest.R.calls.length;
  await check('not a code', 'not-found');
  await check(['x', 2, 3], 'not-found');
  assert.equal(guest.R.calls.length, before, 'unreadable input never reaches the server');
  await host.S.createRoom();
  srv.rate = true; await check([25, 95, 151, 133], 'rate'); srv.rate = false;
  srv.rooms.get('25-95-151-133').state = 'playing';
  await check([25, 95, 151, 133], 'started');
  srv.rooms.get('25-95-151-133').state = 'lobby';
  for (const u of ['A', 'B', 'C']) {
    fakeRelay(srv, u, { name: u, dex: 1 });
    srv.handle(u, 'join', { code: [25, 95, 151, 133] });
  }
  await check([25, 95, 151, 133], 'full');
  srv.down = true;
  await check([25, 95, 151, 133], 'unreachable');
});

test('joinRoom: without G.RoomCode a typed code is just not found (no crash)', async () => {
  const { host, guest } = await pair({ guest: { noRoomCode: true } });
  await host.S.createRoom();
  assert.equal((await guest.S.joinRoom('pikachu onix mew eevee')).code, 'not-found');
  assert.equal((await guest.S.joinRoom('25-95-151-133')).ok, true);
});

// ---------------- salir, Pokémon, partida, echar ----------------

test('leaveRoom sends leave; when the host leaves, the guest gets room-closed', async () => {
  const { host, guest } = await pair();
  await host.S.createRoom();
  await guest.S.joinRoom([25, 95, 151, 133]);
  await settle();
  await guest.S.leaveRoom();
  assert.deepEqual(guest.R.sent('leave'), [['leave', {}]]);
  assert.equal(guest.S.room, null);
  assert.equal(guest.events.at(-1), 'room');
  await settle();
  assert.deepEqual(host.S.room.members.map(m => m.uid), ['H1']);
  await guest.S.joinRoom([25, 95, 151, 133]);
  await settle();
  await host.S.leaveRoom();
  await settle();
  assert.equal(guest.S.room, null);
  assert.ok(guest.events.includes('room-closed'));
  assert.deepEqual(roomTraffic(guest), []);
});

test('refreshMember sends member with name, dex and shiny', async () => {
  const { host } = await pair();
  await host.S.createRoom();
  host.G.DB.save.partner = 150; host.G.DB.save.partnerShiny = true;
  host.S.refreshMember();
  assert.deepEqual(host.R.sent('member'), [['member', { name: 'Ash', dex: 150, shiny: true }]]);
  await settle();
  assert.equal(host.S.room.members[0].dex, 150);
  assert.equal(host.S.room.members[0].shiny, true);
});

test('setOpen and setPlaying fold into one start and one end, from the host only', async () => {
  const { srv, host, guest } = await pair();
  await host.S.createRoom();
  await guest.S.joinRoom([25, 95, 151, 133]);
  await settle();
  // Como en el juego: setOpen(false) al empezar, setPlaying(true) en todos...
  host.S.setOpen(false); host.S.setPlaying(true); guest.S.setPlaying(true);
  await settle();
  assert.deepEqual(host.R.sent('start'), [['start', {}]]);
  assert.equal(srv.rooms.get('25-95-151-133').state, 'playing');
  assert.equal(host.S.room.open, false);
  assert.equal(guest.S.room.open, false, 'the guest sees the room closed from the snapshot');
  // ...y al acabar, setPlaying(false) y setOpen(true) al volver a la sala.
  host.S.setPlaying(false); guest.S.setPlaying(false); host.S.setOpen(true);
  await settle();
  assert.deepEqual(host.R.sent('end'), [['end', {}]]);
  assert.equal(host.S.room.open, true);
  assert.deepEqual(guest.R.sent('start').concat(guest.R.sent('end')), [], 'guests never send start / end');
  assert.deepEqual(roomTraffic(host), []);
});

test('dropMember sends kick; the kicked guest gets room-closed and the host the new list', async () => {
  const { host, guest } = await pair();
  await host.S.createRoom();
  await guest.S.joinRoom([25, 95, 151, 133]);
  await settle();
  host.S.dropMember('H1');
  guest.S.dropMember('H1');
  assert.deepEqual(host.R.sent('kick').concat(guest.R.sent('kick')), [], 'not yourself, and guests cannot');
  host.S.dropMember('G1');
  assert.deepEqual(host.R.sent('kick'), [['kick', { uid: 'G1' }]]);
  await settle();
  assert.equal(guest.S.room, null);
  assert.ok(guest.events.includes('room-closed'));
  assert.deepEqual(host.S.room.members.map(m => m.uid), ['H1']);
});

test('peer: away and back flip online, gone removes the member; closed ends the room', async () => {
  const { host, guest } = await pair();
  await host.S.createRoom();
  await guest.S.joinRoom([25, 95, 151, 133]);
  await settle();
  const n = host.events.length;
  host.R.fire('peer', 'G1', 'away'); await settle();
  assert.equal(host.S.room.members[1].online, false);
  host.R.fire('peer', 'G1', 'online'); await settle();
  assert.equal(host.S.room.members[1].online, true);
  host.R.fire('peer', 'G1', 'gone'); await settle();
  assert.deepEqual(host.S.room.members.map(m => m.uid), ['H1']);
  assert.equal(host.events.length, n + 3);
  host.R.fire('peer', 'nobody', 'gone'); await settle();
  assert.equal(host.events.length, n + 3, 'unknown uid: nothing');
  host.R.fire('closed', 'idle'); await settle();
  assert.equal(host.S.room, null);
  assert.equal(host.events.at(-1), 'room-closed');
  assert.deepEqual(roomTraffic(host), []);
});

test('room events for another room, or with no room, are ignored', async () => {
  const { host } = await pair();
  host.R.fire('room', { code: [1, 4, 7, 152], state: 'lobby', mode: 'direct', host: 'H1', members: [{ uid: 'H1' }] });
  await settle();
  assert.equal(host.S.room, null);
  await host.S.createRoom();
  const n = host.events.length;
  host.R.fire('room', { code: [1, 4, 7, 152], state: 'lobby', mode: 'direct', host: 'X', members: [{ uid: 'H1' }, { uid: 'X' }] });
  await settle();
  assert.equal(host.events.length, n);
  assert.deepEqual(host.S.room.members.map(m => m.uid), ['H1']);
});

// ---------------- misma wifi ----------------

test('same Wi-Fi with the relay: setLocal keeps the IP but writes no lan key, findLocal reads nothing', async () => {
  const { host, guest } = await pair();
  assert.deepEqual(clone(await host.S.setLocal('192.168.1.20')), { ok: true });
  assert.equal(host.S.room.relay, true, 'setLocal creates a server room');
  assert.equal(host.S.room.lanIp, '192.168.1.20');
  await settle();
  const f = await guest.S.findLocal('192.168.1.20');
  assert.equal(f.ok, false);
  assert.equal(f.code, 'not-found');
  assert.deepEqual(roomTraffic(host), []);
  assert.deepEqual(roomTraffic(guest), []);
});

// ---------------- invitaciones ----------------

test('invites carry the code with the relay, and acceptInvite joins by that code', async () => {
  const { host, guest, fs: sharedFs } = await pair({ guest: { storage: [['ps.hasfr.G1', '1']] } });
  sharedFs.col('friendships').set('G1_H1', { users: ['G1', 'H1'], from: 'H1', to: 'G1', status: 'ok', names: { H1: 'Ash', G1: 'Misty' } });
  await host.S.ensureFriends();
  const r = await host.S.invite('G1');
  assert.equal(r.ok, true);
  const doc = sharedFs.col('inv').get('G1_H1');
  assert.deepEqual(doc.code, [25, 95, 151, 133]);
  assert.equal(doc.room, '25-95-151-133', 'room stays for older clients');
  await settle();
  assert.deepEqual(clone(guest.S.invites[0].code), [25, 95, 151, 133]);
  assert.equal(guest.S.invites[0].room, '25-95-151-133');
  const a = await guest.S.acceptInvite('H1');
  assert.equal(a.ok, true);
  assert.deepEqual(guest.R.sent('join'), [['join', { code: [25, 95, 151, 133], hideIp: false }]]);
  assert.equal(guest.S.room.id, host.S.room.id);
  assert.equal(sharedFs.col('inv').has('G1_H1'), false, 'the invite is used up');
});

test('an old invite (room id only, no code) with the relay on fails cleanly', async () => {
  const { guest, fs: sharedFs } = await pair({ guest: { storage: [['ps.hasfr.G1', '1']] } });
  await sharedFs.collection('inv').doc('G1_H1').set({ to: 'G1', from: 'H1', room: 'H1', name: 'Ash', at: Date.now() });
  await settle();
  assert.equal(guest.S.invites.length, 1);
  const a = await guest.S.acceptInvite('H1');
  assert.equal(a.ok, false);
  assert.equal(a.code, 'not-found');
  assert.deepEqual(guest.R.sent('join'), []);
});

// ---------------- carreras y fallos ----------------

test('leaving while create or join is on its way undoes it on the server too', async () => {
  const { srv, host, guest } = await pair();
  const c = host.S.createRoom();
  await host.S.leaveRoom();
  await assert.rejects(c, e => e.code === 'left');
  assert.equal(host.S.room, null);
  assert.deepEqual(host.R.sent('leave'), [['leave', {}]]);
  assert.equal(srv.rooms.size, 0);
  await host.S.createRoom();
  const code = host.S.room.code;
  const j = guest.S.joinRoom(code);
  await guest.S.leaveRoom();                 // (todavía sin sala ni create pendiente: no hace nada)
  assert.equal((await j).ok, true);
});

test('a late snapshot does not swallow the next start', async () => {
  const { srv, host, guest } = await pair();
  await host.S.createRoom();
  await guest.S.joinRoom(host.S.room.code);
  host.S.setOpen(false); host.S.setPlaying(true); await settle();
  host.S.setPlaying(false);
  // Una foto de antes del 'end' llega tarde (state: 'playing') y el anfitrión empieza otra vez.
  host.R.fire('room', Object.assign(clone(host.R.room), { state: 'playing' }));
  await settle();
  host.S.setOpen(false); host.S.setPlaying(true);
  assert.equal(host.R.sent('start').length, 2);
  assert.equal(host.R.sent('end').length, 1);
  await settle();
  assert.equal(srv.rooms.get(host.S.room.id).state, 'playing');
});

test('invite and setLocal return the error when the room cannot be created', async () => {
  const sharedFs = fakeFs();
  sharedFs.col('friendships').set('G1_H1', { users: ['G1', 'H1'], from: 'H1', to: 'G1', status: 'ok', names: { H1: 'Ash', G1: 'Misty' } });
  const p = player('H1', 'Ash', { srv: server(), fs: sharedFs, connectErr: 'disabled' });
  await p.S.start(); await p.S.ensureFriends();
  const r = await p.S.invite('G1');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'disabled');
  assert.equal(sharedFs.col('inv').size, 0);
  const l = await p.S.setLocal('192.168.1.20');
  assert.equal(l.ok, false);
  assert.equal(l.code, 'disabled');
  assert.equal(p.S.room, null);
});
