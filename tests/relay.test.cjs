// G.Relay (js/net/relay.js) con un io() falso: sin red ni paquetes de npm.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const tick = () => new Promise(r => setImmediate(r));

// Socket falso: guarda los manejadores; el "servidor" acepta o rechaza a mano.
function fakeIo() {
  const sockets = [];
  function io(a, b) {
    const opts = b || a, url = b ? a : undefined;
    const h = new Map();
    const s = {
      url, opts, args: b ? 2 : 1, connected: false, active: false, emitted: [], auths: [], connects: 0, closed: false,
      on(ev, fn) { if (!h.has(ev)) h.set(ev, []); h.get(ev).push(fn); return s; },
      off() { h.clear(); return s; },
      fire(ev, ...x) { for (const fn of [...(h.get(ev) || [])]) fn(...x); },
      connect() {
        s.connects++; s.active = true;
        opts.auth(data => s.auths.push(data));
        return s;
      },
      disconnect() { s.closed = true; s.connected = false; s.active = false; return s; },
      emit(...x) { s.emitted.push(x); return s; },
      // lado del servidor
      accept() { s.connected = true; s.fire('connect'); },
      reject(msg) { s.active = false; s.fire('connect_error', new Error(msg)); },
      netError() { s.fire('connect_error', new Error('websocket error')); },
      drop(reason) { s.connected = false; if (reason === 'io server disconnect') s.active = false; s.fire('disconnect', reason); }
    };
    sockets.push(s);
    return s;
  }
  return { io, sockets };
}

function setup({ protocol = 'https:', online = true, me = { uid: 'u1', name: 'Ash', kind: 'email' }, ioFn, timers } = {}) {
  const fake = fakeIo();
  const G = {
    DB: { online, me, save: { partner: 25, partnerShiny: true }, ownsShiny: d => d === 25 }
  };
  const st = (timers && timers.setTimeout) || setTimeout, ct = (timers && timers.clearTimeout) || clearTimeout;
  new Function('G', 'io', 'location', 'setTimeout', 'clearTimeout', source('js/net/relay.js'))(
    G, ioFn === undefined ? fake.io : ioFn, { protocol }, st, ct);
  return { R: G.Relay, G, fake, sock: () => fake.sockets[fake.sockets.length - 1] };
}

async function online(t) {
  const p = t.R.connect();
  await tick();
  t.sock().accept();
  await p;
}

test('enabled: signed in on the game server and served over http(s)', () => {
  assert.equal(setup().R.enabled, true);
  assert.equal(setup({ protocol: 'http:' }).R.enabled, true);
  assert.equal(setup({ protocol: 'file:' }).R.enabled, false);
  assert.equal(setup({ online: false }).R.enabled, false);
  const t = setup();
  t.G.DB.online = false;
  assert.equal(t.R.enabled, false, 'follows G.DB.online (logout)');
});

test('not signed in: connect rejects signed-out; no http(s) or no socket.io client: unreachable; never a socket', async () => {
  for (const [t, code] of [[setup({ online: false }), 'signed-out'], [setup({ me: null }), 'signed-out'],
    [setup({ protocol: 'file:' }), 'unreachable'], [setup({ ioFn: null }), 'unreachable']]) {
    await assert.rejects(t.R.connect(), e => e.code === code);
    assert.equal(t.fake.sockets.length, 0);
    assert.equal(t.R.state, 'off');
    assert.equal(t.R.emit('sig', 'x', {}), false);
  }
});

test('connect: same origin (no URL), websocket only, v 2 with the page epoch and no token, state events, uid', async () => {
  const t = setup(), states = [];
  t.R.on('state', s => states.push(s));
  assert.equal(t.R.state, 'off'); assert.equal(t.R.uid, null);
  const p1 = t.R.connect(), p2 = t.R.connect();
  assert.equal(p1, p2);
  assert.equal(t.R.state, 'connecting');
  await tick();
  const s = t.sock();
  assert.equal(t.fake.sockets.length, 1);
  assert.equal(s.args, 1, 'io(opts): the page origin, so the session cookie goes by itself');
  assert.equal(s.url, undefined);
  assert.deepEqual(s.opts.transports, ['websocket']);
  assert.equal(typeof s.opts.auth, 'function');
  assert.match(t.R.ep, /^[0-9a-f]{24}$/);
  assert.deepEqual(s.auths, [{ v: 2, ep: t.R.ep, dex: 25, shiny: true }]);
  assert.ok(!('token' in s.auths[0]) && !('name' in s.auths[0]), 'the server knows who you are from the cookie');
  s.accept();
  await p1;
  assert.equal(t.R.state, 'online'); assert.equal(t.R.uid, 'u1');
  assert.deepEqual(states, ['connecting', 'online']);
  await t.R.connect();
  assert.equal(t.fake.sockets.length, 1);
  assert.notEqual(setup().R.ep, t.R.ep, 'another page load, another epoch');
});

test('handshake: no shiny without owning it', async () => {
  const t = setup();
  t.G.DB.ownsShiny = () => false;
  t.R.connect(); await tick();
  assert.deepEqual(t.sock().auths[0], { v: 2, ep: t.R.ep, dex: 25, shiny: false });
});

test('each server rejection maps to its code and closes the socket', async () => {
  for (const code of ['old-version', 'signed-out', 'banned', 'busy']) {
    const t = setup();
    const p = t.R.connect(); await tick();
    t.sock().reject(code);
    await assert.rejects(p, e => e instanceof Error && e.code === code);
    assert.equal(t.R.state, 'offline');
    assert.equal(t.sock().closed, true);
  }
  for (const msg of ['something-else', 'bad-token', 'disabled']) {
    const t = setup();
    const p = t.R.connect(); await tick();
    t.sock().reject(msg);
    await assert.rejects(p, e => e.code === 'unreachable', msg);
  }
});

test('unreachable server on the first try: rejects and stops retrying', async () => {
  const t = setup();
  const p = t.R.connect(); await tick();
  t.sock().netError();
  await assert.rejects(p, e => e.code === 'unreachable');
  assert.equal(t.R.state, 'offline'); assert.equal(t.sock().closed, true);
  // otro connect() abre un socket nuevo
  const p2 = t.R.connect(); await tick();
  assert.equal(t.fake.sockets.length, 2);
  t.sock().accept(); await p2;
  assert.equal(t.R.state, 'online');
});

test('a rejection while reconnecting on its own reports the code through state', async () => {
  const t = setup(), states = [];
  await online(t);
  t.R.on('state', (...a) => states.push(a));
  const s = t.sock();
  s.drop('transport close');
  s.reject('signed-out');
  assert.deepEqual(states, [['offline'], ['offline', 'signed-out']]);
  assert.equal(s.closed, true); assert.equal(t.R.uid, null);
});

test('requests waiting for an ack fail as unreachable when the connection drops', async () => {
  const t = setup();
  await online(t);
  const p = t.R.request('create', {});
  const r = assert.rejects(p, e => e.code === 'unreachable');
  t.sock().drop('transport close');
  await r;
  t.sock().emitted[0][2]({ ok: true });       // ya no cuenta
});

test('network drops keep the socket, and reconnecting sends the same epoch (a reconnect is not a reload)', async () => {
  const t = setup(), states = [];
  await online(t);
  t.R.on('state', s => states.push(s));
  const s = t.sock();
  s.drop('transport close');
  assert.equal(t.R.state, 'offline'); assert.equal(s.closed, false);
  assert.equal(t.R.uid, 'u1');
  s.netError();                              // un reintento que falla: sigue el mismo socket
  assert.equal(s.closed, false);
  t.G.DB.save.partner = 7;
  s.opts.auth(d => s.auths.push(d));         // socket.io reintenta
  assert.deepEqual(s.auths[1], { v: 2, ep: t.R.ep, dex: 7, shiny: false }, 'the current partner, the same epoch');
  s.accept();
  assert.equal(t.R.state, 'online');
  assert.deepEqual(states, ['offline', 'online']);
  assert.equal(t.fake.sockets.length, 1);
});

test('server disconnect closes the socket; connect opens a new one', async () => {
  const t = setup();
  await online(t);
  const first = t.sock();
  first.fire('room', { code: [1, 2, 3, 4], members: [] });
  first.drop('io server disconnect');
  assert.equal(t.R.state, 'offline'); assert.equal(first.closed, true);
  assert.equal(t.R.uid, null);
  assert.deepEqual(t.R.room, { code: [1, 2, 3, 4], members: [] });   // la última recibida, hasta 'closed'
  const p = t.R.connect(); await tick();
  assert.equal(t.fake.sockets.length, 2);
  t.sock().accept(); await p;
  assert.equal(t.R.state, 'online');
});

test('request: resolves the ack, rejects ok:false with the server code', async () => {
  const t = setup();
  await assert.rejects(t.R.request('create', {}), e => e.code === 'unreachable');
  await online(t);
  const s = t.sock();
  const p = t.R.request('create', { mode: 'direct' });
  const [ev, payload, ack] = s.emitted[0];
  assert.equal(ev, 'create'); assert.deepEqual(payload, { mode: 'direct' });
  ack({ ok: true, code: [1, 2, 3, 4] });
  assert.deepEqual(await p, { ok: true, code: [1, 2, 3, 4] });

  const p2 = t.R.request('join', { code: [9, 9, 9, 9] });
  s.emitted[1][2]({ ok: false, err: 'full' });
  await assert.rejects(p2, e => e instanceof Error && e.code === 'full');

  const p3 = t.R.request('leave');
  assert.deepEqual(s.emitted[2][1], {});
  s.emitted[2][2]({ ok: false });
  await assert.rejects(p3, e => e.code === 'error');
});

test('request: times out after 8 s with code timeout; a late ack is ignored', async () => {
  const pending = [];
  const timers = {
    setTimeout(fn, ms) { pending.push({ fn, ms, on: true }); return pending.length; },
    clearTimeout(id) { if (pending[id - 1]) pending[id - 1].on = false; }
  };
  const t = setup({ timers });
  await online(t);
  const p = t.R.request('start', {});
  const timer = pending[pending.length - 1];
  assert.equal(timer.ms, 8000);
  timer.fn();
  await assert.rejects(p, e => e.code === 'timeout');
  t.sock().emitted[0][2]({ ok: true });       // tarde: no pasa nada

  const p2 = t.R.request('end', {});
  t.sock().emitted[1][2]({ ok: true });
  await p2;
  assert.equal(pending[pending.length - 1].on, false);
});

test('emit is fire and forget, and a no-op when not online', async () => {
  const t = setup();
  assert.equal(t.R.emit('sig', 'h', { sdp: 1 }), false);
  await online(t);
  assert.equal(t.R.emit('sig', 'h', { sdp: 1 }), true);
  assert.equal(t.R.emit('m', 'h', 7, new Uint8Array([1, 2])), true);
  assert.deepEqual(t.sock().emitted.map(a => a[0]), ['sig', 'm']);
  assert.deepEqual(t.sock().emitted[1].slice(1, 3), ['h', 7]);
  t.sock().drop('transport close');
  assert.equal(t.R.emit('sig', 'h', {}), false);
  assert.equal(t.sock().emitted.length, 2);
});

test('on/off for server events (invite and presence too); a throwing listener does not stop others', async () => {
  const t = setup(), got = [];
  const warn = console.warn; console.warn = () => {};
  try {
    const sig = (from, p) => got.push(['sig', from, p]);
    t.R.on('sig', () => { throw new Error('boom'); });
    t.R.on('sig', sig);
    t.R.on('m', (f, seq, b) => got.push(['m', f, seq, b.length]));
    t.R.on('peer', (u, s) => got.push(['peer', u, s]));
    t.R.on('invite', i => got.push(['invite', i.from]));
    t.R.on('presence', (u, on) => got.push(['presence', u, on]));
    await online(t);
    const s = t.sock();
    s.fire('sig', 'host', { ice: [] });
    s.fire('m', 'host', 3, new Uint8Array(4));
    s.fire('peer', 'g1', 'away');
    s.fire('invite', { from: 'f1', code: [1, 2, 3, 4] });
    s.fire('presence', 'f1', true);
    t.R.off('sig', sig);
    s.fire('sig', 'host', { ice: [1] });
    assert.deepEqual(got, [['sig', 'host', { ice: [] }], ['m', 'host', 3, 4], ['peer', 'g1', 'away'], ['invite', 'f1'], ['presence', 'f1', true]]);
  } finally { console.warn = warn; }
});

test('room snapshot is kept and cleared on closed', async () => {
  const t = setup(), rooms = [], closed = [];
  t.R.on('room', r => rooms.push(r));
  t.R.on('closed', why => closed.push([why, t.R.room]));
  await online(t);
  assert.equal(t.R.room, null);
  const snap = { code: [25, 1, 4, 7], state: 'lobby', mode: 'direct', host: 'u1', members: [{ uid: 'u1' }] };
  t.sock().fire('room', snap);
  assert.equal(t.R.room, snap);
  assert.deepEqual(rooms, [snap]);
  t.sock().fire('closed', 'host-left');
  assert.equal(t.R.room, null);
  assert.deepEqual(closed, [['host-left', null]]);
});

test('disconnect: closes the socket, clears state and rejects a pending connect', async () => {
  const t = setup(), states = [];
  t.R.on('state', s => states.push(s));
  await online(t);
  t.sock().fire('room', { code: [1, 2, 3, 4] });
  t.R.disconnect();
  assert.equal(t.sock().closed, true);
  assert.equal(t.R.state, 'off'); assert.equal(t.R.uid, null); assert.equal(t.R.room, null);
  assert.deepEqual(states, ['connecting', 'online', 'off']);
  const p = t.R.connect();
  t.R.disconnect();
  await assert.rejects(p, e => e.code === 'signed-out');
});

test('dev.html loads socket.io then relay before social; no relay-config.js and no G.RELAY_URL left', () => {
  const html = source('dev.html');
  const at = f => { const i = html.indexOf(`<script defer src="${f}"></script>`); assert.ok(i > 0, f); return i; };
  assert.ok(at('js/net/api.js') < at('js/core/db.js'));
  assert.ok(at('js/vendor/socket.io.min.js') < at('js/net/relay.js'));
  assert.ok(at('js/net/relay.js') < at('js/net/social.js'));
  assert.ok(!html.includes('relay-config.js'));
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'js/net/relay-config.js')));
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'js/net'))) {
    const src = source('js/net/' + f);
    assert.ok(!src.includes('RELAY_URL'), f);
    assert.ok(!/[?&]relay\b|has\('relay'\)/.test(src), f + ': no ?relay flag');
  }
  assert.match(source('js/vendor/socket.io.min.js'), /^\/\*!\n \* Socket\.IO v4\.8\.4\n/);
});
