// js/net/social.js de verdad, con un G.Relay y un G.Api falsos unidos a un servidor
// en memoria (docs/relay-coop/02-protocol.md): salas, amigos, en línea e invitaciones.
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
  const srv = { rooms, clients, down: false, sameNet: false, rate: false, busy: false, runs: 0,
    users: new Map(),               // uid -> { name, kind }
    links: new Map(),               // 'a|b' (a < b) -> { from, status: 'pending' | 'ok' }
    invites: new Map(),             // to + '|' + from -> { code }
    profiles: new Map() };
  const pk = (x, y) => (x < y ? x + '|' + y : y + '|' + x);
  srv.befriend = (x, y) => srv.links.set(pk(x, y), { from: x, status: 'ok' });
  srv.listOf = u => [...srv.links].filter(([k]) => k.split('|').includes(u)).map(([k, l]) => {
    const o = k.split('|').find(x => x !== u);
    const status = l.status === 'ok' ? 'ok' : l.from === u ? 'out' : 'in';
    return { uid: o, name: (srv.users.get(o) || {}).name || '???', status, online: status === 'ok' && clients.has(o) };
  });
  srv.tell = (u, ev, ...a) => { if (clients.has(u)) clients.get(u).fire(ev, ...a); };
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
      push(room);                      // (como io.js: la foto sale antes que la respuesta)
      return { ok: true, code, room: snap(room) };
    }
    if (ev === 'join') {
      if (srv.rate) return { ok: false, err: 'rate' };
      const room = Array.isArray(p.code) ? rooms.get(key(p.code)) : null;
      if (!room) return { ok: false, err: 'not-found' };
      if (room.state === 'playing') return { ok: false, err: 'started' };
      if (room.members.length >= 4) return { ok: false, err: 'full' };
      room.members.push(member(u, { sameNet: srv.sameNet, hideIp: !!p.hideIp, path: p.hideIp ? 'server' : null }));
      push(room);                      // (como io.js: la foto sale antes que la respuesta)
      return { ok: true, room: snap(room), sameNet: srv.sameNet };
    }
    if (ev === 'invite-answer') {
      const inv = srv.invites.get(u + '|' + p.from);
      if (!inv) return { ok: false, err: 'expired' };
      srv.invites.delete(u + '|' + p.from);
      srv.tell(p.from, 'invite-answer', u, p.accept === true);
      return p.accept ? { ok: true, code: inv.code } : { ok: true };
    }
    if (!r) return { ok: false, err: 'not-in-room' };
    if (ev === 'invite') {
      if (r.host !== u) return { ok: false, err: 'not-host' };
      const l = srv.links.get(pk(u, p.to));
      if (!l || l.status !== 'ok') return { ok: false, err: 'not-friend' };
      if (!clients.has(p.to)) return { ok: false, err: 'offline' };
      srv.invites.set(p.to + '|' + u, { code: r.code });
      const me = clients.get(u).info;
      srv.tell(p.to, 'invite', { from: u, name: me.name, dex: me.dex, shiny: !!me.shiny, code: r.code });
      return { ok: true };
    }
    if (ev === 'leave') {
      if (r.host === u) close(r, 'host-left', u);
      else { r.members = r.members.filter(m => m.uid !== u); setImmediate(() => push(r)); }
      return { ok: true };
    }
    if (ev === 'member') { Object.assign(r.members.find(m => m.uid === u), p); setImmediate(() => push(r)); return; }
    if (r.host !== u) return { ok: false, err: 'not-host' };
    if (ev === 'start' || ev === 'end') {
      r.state = ev === 'start' ? 'playing' : 'lobby'; setImmediate(() => push(r));
      // Como io.js: el start abre la partida en grupo del ranking (null si el anfitrión está solo).
      return ev === 'start' ? { ok: true, run: r.members.length > 1 ? 'run-' + (++srv.runs) : null } : { ok: true };
    }
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
      await new Promise(r => setImmediate(r));   // la respuesta llega después de lo que ya mandó el servidor
      if (a && a.ok === false) throw codeErr(a.err);
      if (a && a.room) R.room = a.room;
      return a;
    },
    emit(ev, p) { calls.push([ev, clone(p)]); srv.handle(uid, ev, clone(p)); },
    disconnect() { calls.push(['disconnect']); R.state = 'off'; R.room = null; },
    on(ev, fn) { if (!ls.has(ev)) ls.set(ev, new Set()); ls.get(ev).add(fn); },
    off(ev, fn) { if (ls.has(ev)) ls.get(ev).delete(fn); },
    fire(ev, ...args) { if (ev === 'room') R.room = args[0]; setImmediate(() => { for (const fn of ls.get(ev) || []) fn(...args); }); },
    sent: ev => calls.filter(c => c[0] === ev)
  };
  srv.clients.set(uid, R);
  return R;
}

// ---------------- G.Api falso (amigos, apodo y perfil) ----------------
function fakeApi(srv, uid) {
  const calls = [];
  const fail = (code, status) => Object.assign(Error(code), { code, status });
  const pk = (x, y) => (x < y ? x + '|' + y : y + '|' + x);
  const byName = n => [...srv.users].find(([, x]) => x.name.toLowerCase() === String(n).toLowerCase());
  async function call(method, path, body) {
    calls.push([method, path, clone(body)]);
    await new Promise(r => setImmediate(r));
    const me = srv.users.get(uid);
    let m;
    if (method === 'PUT' && path === '/api/me/name') {
      if (byName(body.name) && byName(body.name)[0] !== uid) throw fail('taken', 409);
      me.name = body.name;
      return { me: { uid, kind: me.kind, name: me.name } };
    }
    if (method === 'GET' && (m = /^\/api\/profile\/(.+)$/.exec(path))) {
      const o = decodeURIComponent(m[1]), pr = srv.profiles.get(o);
      if (!pr) throw fail('not-found', 404);
      return { profile: Object.assign({}, pr, { name: srv.users.get(o).name }) };
    }
    if (me.kind !== 'email') throw fail('needs-email', 403);
    if (method === 'PUT' && path === '/api/profile') { srv.profiles.set(uid, clone(body.profile)); return null; }
    if (method === 'GET' && path === '/api/friends') return clone(srv.listOf(uid));
    if (method === 'POST' && path === '/api/friends') {
      const o = byName(body.name);
      if (!o || o[1].kind !== 'email') throw fail('not-found', 404);
      const l = srv.links.get(pk(uid, o[0]));
      if (l && l.status === 'pending' && l.from === o[0]) l.status = 'ok';
      else if (l) throw fail('conflict', 409);
      else srv.links.set(pk(uid, o[0]), { from: uid, status: 'pending' });
      srv.tell(o[0], 'friends');
      return null;
    }
    if (method === 'POST' && (m = /^\/api\/friends\/(.+)\/accept$/.exec(path))) {
      const o = decodeURIComponent(m[1]), l = srv.links.get(pk(uid, o));
      if (!l || l.status !== 'pending' || l.from !== o) throw fail('not-found', 404);
      l.status = 'ok';
      srv.tell(o, 'friends');
      return null;
    }
    if (method === 'DELETE' && (m = /^\/api\/friends\/(.+)$/.exec(path))) {
      const o = decodeURIComponent(m[1]);
      if (srv.links.delete(pk(uid, o))) srv.tell(o, 'friends');
      return null;
    }
    throw fail('not-found', 404);
  }
  return {
    calls,
    get: p => call('GET', p), post: (p, b = {}) => call('POST', p, b),
    put: (p, b = {}) => call('PUT', p, b), del: (p, b = {}) => call('DELETE', p, b),
    sent: (method, p) => calls.filter(c => c[0] === method && (!p || c[1] === p))
  };
}

// ---------------- un jugador ----------------
const NAMES = { pikachu: 25, onix: 95, mew: 151, eevee: 133, bulbasaur: 1, charmander: 4, squirtle: 7 };
// o.kind: 'email' (por defecto) o 'guest'.
function player(uid, name, o = {}) {
  const store = new Map(o.storage || []);
  const settings = o.settings || {};
  const srv = o.srv || server();
  const kind = o.kind || 'email';
  srv.users.set(uid, { name, kind });
  const G = {
    DB: {
      online: true, user: name, save: { name, partner: o.dex || 25, partnerShiny: !!o.shiny, stats: {}, profile: {} },
      me: { uid, name, kind },
      setName(n) { G.DB.save.name = n; G.DB.user = n; },
      updateMe(m) { G.DB.me = m; },
      ownsShiny: () => true, onLeave() {}
    },
    AchDefs: { LIST: [] },
    Settings: { get: k => settings[k] },
    Net: { isLocalIp: ip => /^192\.168\./.test(ip) }
  };
  G.Relay = fakeRelay(srv, uid, { name, dex: o.dex || 25, shiny: !!o.shiny }, o.connectErr);
  G.Api = fakeApi(srv, uid);
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
    setTimeout, clearTimeout, setImmediate, Date, crypto: globalThis.crypto, TextEncoder, btoa
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const S = G.Social, events = [];
  S.on(w => events.push(w));
  return { G, S, R: G.Relay, A: G.Api, events, store, settings, srv };
}

// o.friends: ya son amigos antes de entrar.
async function pair(o = {}) {
  const srv = o.srv || server();
  const host = player('H1', 'Ash', Object.assign({ srv }, o.host));
  const guest = player('G1', 'Misty', Object.assign({ srv, dex: 120 }, o.guest));
  if (o.friends) srv.befriend('H1', 'G1');
  await host.S.start(); await guest.S.start();
  await settle();
  return { srv, host, guest };
}

// ---------------- entrar en la cuenta ----------------

test('start: the nickname is the account name, the socket opens right away and the friends list loads', async () => {
  const p = player('H1', 'Ash');
  assert.equal(await p.S.start(), 'ok');
  assert.deepEqual(clone(p.S.me), { uid: 'H1', name: 'Ash' });
  assert.equal(p.S.uid, 'H1');
  assert.deepEqual(p.R.calls, [['connect']]);
  assert.equal(await p.S.start(), 'ok');
  assert.equal(p.R.sent('connect').length, 1);
  await p.S.ensureFriends();
  assert.equal(p.S.friends.length, 0);
  assert.equal(p.A.sent('GET', '/api/friends').length, 1, 'once, then from events');
  const off = player('H2', 'Brock');
  off.G.DB.online = false;
  assert.equal(await off.S.start(), 'off');
  assert.deepEqual(off.R.calls, []);
});

test('start: an email account still called Guest and 4 digits must pick a nickname (claimNick)', async () => {
  const srv = server();
  player('X9', 'Taken', { srv });
  const p = player('E1', 'Guest0042', { srv });
  assert.equal(await p.S.start(), 'need-nick');
  assert.equal(p.S.me, null);
  assert.equal((await p.S.claimNick('ab')).ok, false);
  assert.equal((await p.S.claimNick('Guest1234')).ok, false, 'default names are taken');
  assert.deepEqual(p.A.sent('PUT', '/api/me/name'), [], 'checked here first');
  const t = await p.S.claimNick('taken');
  assert.equal(t.ok, false);
  assert.equal(t.error, 'Ese apodo ya lo tiene otro jugador.');
  assert.equal((await p.S.claimNick(' Brock ')).ok, true);
  assert.deepEqual(clone(p.S.me), { uid: 'E1', name: 'Brock' });
  assert.equal(p.G.DB.me.name, 'Brock');
  assert.equal(p.G.DB.save.name, 'Brock');
  assert.equal(await p.S.start(), 'ok');
  // Un invitado juega con el nombre de serie y no tiene amigos.
  const g = player('U1', 'Guest0007', { srv, kind: 'guest' });
  assert.equal(await g.S.start(), 'ok');
  assert.equal(g.S.canFriend, false);
  await g.S.ensureFriends();
  assert.deepEqual(g.A.calls, [], 'a guest never asks for friends');
  assert.equal((await g.S.request('Brock')).error, 'Añade un correo para tener amigos.');
});

test('start again after a guest adds an email (same account): friends load and the nickname is asked', async () => {
  const srv = server();
  const p = player('U3', 'Guest0003', { srv, kind: 'guest' });
  assert.equal(await p.S.start(), 'ok');
  assert.equal(p.S.me.name, 'Guest0003');
  srv.users.get('U3').kind = 'email';
  p.G.DB.me = { uid: 'U3', name: 'Guest0003', kind: 'email' };
  assert.equal(await p.S.start(), 'need-nick');
  assert.equal(p.S.me, null);
  assert.equal(p.A.sent('GET', '/api/friends').length, 1);
  assert.equal((await p.S.claimNick('Gary')).ok, true);
  assert.equal(await p.S.start(), 'ok');
});

test('stop (logout): leaves the room, then closes the socket', async () => {
  const { host } = await pair();
  await host.S.createRoom();
  await host.S.stop('logout');
  assert.deepEqual(host.R.calls.slice(-2).map(c => c[0]), ['leave', 'disconnect']);
  assert.equal(host.S.room, null);
  assert.equal(host.S.started, false);
});

test('reload: the server still has you in a room, so the room comes back on its own', async () => {
  const { srv, host, guest } = await pair();
  await host.S.createRoom();
  await guest.S.joinRoom(host.S.room.code);
  host.S.setOpen(false); host.S.setPlaying(true); await settle();
  // El invitado recarga: página nueva, sin sala; al conectar, el servidor le manda la suya.
  const g2 = player('G1', 'Misty', { srv, dex: 120 });
  await g2.S.start(); await settle();
  srv.clients.get('G1').fire('room', { code: host.S.room.code, state: 'playing', mode: 'direct', host: 'H1', directWaitMs: 6000,
    members: srv.rooms.get(host.S.room.id).members });
  await settle();
  assert.ok(g2.S.room, 'back in the room');
  assert.equal(g2.S.room.id, host.S.room.id);
  assert.equal(g2.S.room.isHost, false);
  assert.ok(g2.events.includes('room'));
  assert.deepEqual(g2.R.sent('join'), [], 'no join needed: the server kept the slot');
  // El anfitrión que recarga en partida la acaba (la partida se perdió) para que vuelva a admitir gente.
  const h2 = player('H1', 'Ash', { srv });
  await h2.S.start();
  srv.clients.get('H1').fire('room', clone(Object.assign({}, srv.rooms.get(host.S.room.id), { directWaitMs: 6000 })));
  await settle();
  assert.equal(h2.S.room.isHost, true);
  assert.deepEqual(h2.R.sent('end'), [['end', {}]]);
  await settle();
  assert.equal(srv.rooms.get(h2.S.room.id).state, 'lobby');
});

test('reload: a room you just left, or one you are not in, is not adopted from a late snapshot', async () => {
  const { srv, host, guest } = await pair();
  await host.S.createRoom();
  await guest.S.joinRoom(host.S.room.code);
  const snap = clone(Object.assign({}, srv.rooms.get(host.S.room.id), { directWaitMs: 6000 }));
  await guest.S.leaveRoom();
  guest.R.fire('room', snap); await settle();
  assert.equal(guest.S.room, null, 'the snapshot from before the leave does not put you back');
  const other = player('X1', 'Brock', { srv });
  await other.S.start();
  other.R.fire('room', snap); await settle();
  assert.equal(other.S.room, null);
});

// ---------------- crear ----------------
// ---------------- crear ----------------

test('createRoom: connects, sends create (direct by default) and gives the usual room plus code and mode', async () => {
  const srv = server();
  const p = player('H1', 'Ash', { srv, dex: 6, shiny: true });
  await p.S.start();
  const r = await p.S.createRoom();
  assert.deepEqual(p.R.calls.slice(0, 3), [['connect'], ['connect'], ['create', { mode: 'direct' }]], 'on start, and again before create');
  assert.equal(r, p.S.room);
  assert.equal(r.id, '25-95-151-133');
  assert.deepEqual(r.code, [25, 95, 151, 133]);
  assert.equal(r.mode, 'direct');
  assert.equal(r.host, 'H1');
  assert.equal(r.isHost, true);
  assert.equal(r.open, true);
  assert.deepEqual(clone(r.members), [{ uid: 'H1', name: 'Ash', dex: 6, shiny: true, online: true, path: null, sameNet: false, hideIp: false }]);
  assert.ok(p.events.includes('room'));
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
  for (const code of ['old-version', 'signed-out', 'banned', 'unreachable']) {
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
});

test('room events for another room, or for a room you are not in, are ignored', async () => {
  const { host } = await pair();
  host.R.fire('room', { code: [1, 4, 7, 152], state: 'lobby', mode: 'direct', host: 'X', members: [{ uid: 'X' }] });
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

test('same Wi-Fi: setLocal keeps the IP only here (nothing goes to the server), and there is no join by IP', async () => {
  const { host, guest } = await pair();
  assert.deepEqual(clone(await host.S.setLocal('192.168.1.20')), { ok: true });
  assert.ok(host.S.room.code, 'setLocal creates a server room');
  assert.equal(host.S.room.lanIp, '192.168.1.20');
  assert.ok(!JSON.stringify(host.R.calls).includes('192.168'));
  assert.equal((await guest.S.setLocal('8.8.8.8')).ok, false);
  await guest.S.joinRoom(host.S.room.code);
  assert.equal((await guest.S.setLocal('192.168.1.30')).ok, false, 'host only');
  assert.equal(guest.S.findLocal, undefined);
  assert.equal(guest.S.lanKey, undefined);
});

// ---------------- amigos ----------------

test('friends: request by nickname, the other one gets it from the friends event, accepts, and both are friends', async () => {
  const { host, guest } = await pair();
  const r = await host.S.request('misty');
  assert.equal(r.ok, true);
  assert.equal(r.msg, 'Solicitud enviada a Misty');
  assert.deepEqual(clone(host.S.friends), [{ uid: 'G1', name: 'Misty', status: 'out', online: false }]);
  await settle();
  assert.deepEqual(clone(guest.S.friends), [{ uid: 'H1', name: 'Ash', status: 'in', online: false }], 'reloaded on the friends event');
  assert.equal((await host.S.request('Misty')).error, 'Ya le enviaste una solicitud.');
  assert.equal((await host.S.request('ash')).error, 'Ese eres tú.');
  const a = await guest.S.accept('H1');
  assert.equal(a.msg, 'Ahora eres amigo de Ash');
  await settle();
  assert.equal(host.S.friends[0].status, 'ok');
  assert.equal(host.S.friends[0].online, true, 'online comes with the list');
  assert.equal((await host.S.request('Misty')).error, 'Ya sois amigos.');
  assert.equal((await host.S.request('Nadie')).error, 'No hay ningún jugador con ese apodo.');
  assert.equal((await guest.S.remove('H1')).ok, true);
  await settle();
  assert.equal(host.S.friends.length, 0);
});

test('friends: asking someone who already asked you accepts it', async () => {
  const { host, guest } = await pair();
  await host.S.request('Misty');
  await settle();
  const r = await guest.S.request('Ash');
  assert.equal(r.ok, true);
  assert.equal(r.msg, 'Ahora eres amigo de Ash');
  assert.deepEqual(guest.A.sent('POST').map(c => c[1]), ['/api/friends/H1/accept']);
});

test('presence: the online dot follows the server, only for accepted friends', async () => {
  const { host } = await pair({ friends: true });
  const f = () => host.S.friends.find(x => x.uid === 'G1');
  assert.equal(f().online, true);
  host.R.fire('presence', 'G1', false); await settle();
  assert.equal(f().online, false);
  assert.equal(host.events.at(-1), 'friends');
  host.R.fire('presence', 'G1', true); await settle();
  assert.equal(f().online, true);
  host.R.fire('presence', 'nobody', true); await settle();
  assert.equal(host.S.friends.length, 1);
});

// ---------------- invitaciones ----------------

test('invite: creates the room if needed, the friend gets the invite with the code, accepting joins by it', async () => {
  const { srv, host, guest } = await pair({ friends: true });
  await host.S.ensureFriends();
  const r = await host.S.invite('G1');
  assert.equal(r.ok, true);
  assert.equal(r.msg, 'Invitación enviada a Misty');
  assert.deepEqual(host.R.sent('invite'), [['invite', { to: 'G1' }]]);
  await settle();
  assert.equal(guest.S.invites.length, 1);
  const inv = guest.S.invites[0];
  assert.equal(inv.from, 'H1');
  assert.equal(inv.name, 'Ash');
  assert.deepEqual(clone(inv.code), [25, 95, 151, 133]);
  assert.equal(inv.room, '25-95-151-133');
  assert.ok(guest.events.includes('invites'));
  // Pulsar otra vez enseguida no manda nada.
  assert.equal((await host.S.invite('G1')).ok, true);
  assert.equal(host.R.sent('invite').length, 1);
  const a = await guest.S.acceptInvite('H1');
  assert.equal(a.ok, true);
  assert.deepEqual(guest.R.sent('invite-answer'), [['invite-answer', { from: 'H1', accept: true }]]);
  assert.deepEqual(guest.R.sent('join'), [['join', { code: [25, 95, 151, 133], hideIp: false }]]);
  assert.equal(guest.S.room.id, host.S.room.id);
  assert.equal(guest.S.invites.length, 0, 'the invite is used up');
  assert.equal(srv.invites.size, 0);
});

test('invite: refused by the server (offline, not a friend) comes back with the code; declining tells the host', async () => {
  const { srv, host, guest } = await pair({ friends: true });
  srv.clients.delete('G1');
  const r = await host.S.invite('G1');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'offline');
  srv.clients.set('G1', guest.R);
  srv.links.clear();
  assert.equal((await host.S.invite('G1')).code, 'not-friend');
  srv.befriend('H1', 'G1');
  assert.equal((await host.S.invite('G1')).ok, true);
  await settle();
  const told = [];
  host.R.on('invite-answer', (u, yes) => told.push([u, yes]));
  guest.S.declineInvite('H1');
  await settle();
  assert.equal(guest.S.invites.length, 0);
  assert.deepEqual(told, [['G1', false]]);
  assert.equal(guest.S.room, null);
});

test('invite: one the server no longer has (expired) fails cleanly with no join; one with no code is ignored', async () => {
  const { srv, guest } = await pair({ friends: true });
  guest.R.fire('invite', { from: 'H1', name: 'Ash', dex: 25, shiny: false, code: [25, 95, 151, 133] });
  await settle();
  assert.equal(guest.S.invites.length, 1);
  const a = await guest.S.acceptInvite('H1');
  assert.equal(a.ok, false);
  assert.equal(a.error, 'La invitación ha caducado.');
  assert.deepEqual(guest.R.sent('join'), []);
  guest.R.fire('invite', { from: 'H1', name: 'Ash', room: 'H1' });
  await settle();
  assert.equal(guest.S.invites.length, 0);
  assert.equal(srv.invites.size, 0);
});

// ---------------- perfil ----------------

test('profile: publishProfile goes to PUT /api/profile (email only), getProfile reads it cleaned', async () => {
  const { host, guest } = await pair({ friends: true });
  const U = {
    str: (v, n) => (typeof v === 'string' ? v.slice(0, n) : ''), int: (v, m = 1e15) => Math.max(0, Math.min(m, Math.floor(+v) || 0)),
    list: (v, n) => (Array.isArray(v) ? v.slice(0, n) : [])
  };
  host.G.U = guest.G.U = U;
  host.G.DEX_BY = guest.G.DEX_BY = { 25: {} };
  host.G.DB.save.profile = { title: 'Campeón', favs: [{ dex: 25, shiny: true }] };
  host.S.publishProfile(true);
  await new Promise(r => setTimeout(r, 900));
  assert.equal(host.A.sent('PUT', '/api/profile').length, 1);
  const p = await guest.S.getProfile('H1');
  assert.equal(p.name, 'Ash');
  assert.equal(p.title, 'Campeón');
  assert.deepEqual(clone(p.favs), [{ dex: 25, shiny: true }]);
  assert.equal(await guest.S.getProfile('nobody'), null);
  const g = player('U2', 'Guest0001', { kind: 'guest' });
  await g.S.start();
  g.S.publishProfile(true);
  await new Promise(r => setTimeout(r, 900));
  assert.deepEqual(g.A.sent('PUT', '/api/profile'), [], 'guests have no public profile');
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
  const srv = server();
  player('G1', 'Misty', { srv });
  srv.befriend('H1', 'G1');
  const p = player('H1', 'Ash', { srv, connectErr: 'signed-out' });
  await p.S.start(); await p.S.ensureFriends();
  const r = await p.S.invite('G1');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'signed-out');
  assert.equal(srv.invites.size, 0);
  const l = await p.S.setLocal('192.168.1.20');
  assert.equal(l.ok, false);
  assert.equal(l.code, 'signed-out');
  assert.equal(p.S.room, null);
});

test('start: the run the server opens for the rankings goes to G.Ranking.setCoopRun and stays in runId', async () => {
  const { host, guest } = await pair();
  const runs = [];
  host.G.Ranking = { setCoopRun: r => runs.push(r) };
  await host.S.createRoom();
  await guest.S.joinRoom(host.S.room.code);
  host.S.setOpen(false); host.S.setPlaying(true); await settle();
  assert.deepEqual(runs, [null, 'run-1'], 'cleared at start, then the one from the ack');
  assert.equal(host.S.runId, 'run-1');
  host.S.setPlaying(false); await settle();
  assert.equal(host.S.runId, 'run-1', 'kept after the end, for the upload');
  host.S.setOpen(false); host.S.setPlaying(true); await settle();
  assert.deepEqual(runs, [null, 'run-1', null, 'run-2']);
  assert.equal(guest.S.runId, null, 'only the host gets one');
});
