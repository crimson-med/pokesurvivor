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
  function io(url, opts) {
    const h = new Map();
    const s = {
      url, opts, connected: false, active: false, emitted: [], auths: [], connects: 0, closed: false,
      on(ev, fn) { if (!h.has(ev)) h.set(ev, []); h.get(ev).push(fn); return s; },
      off() { h.clear(); return s; },
      fire(ev, ...a) { for (const fn of [...(h.get(ev) || [])]) fn(...a); },
      connect() {
        s.connects++; s.active = true;
        opts.auth(data => s.auths.push(data));
        return s;
      },
      disconnect() { s.closed = true; s.connected = false; s.active = false; return s; },
      emit(...a) { s.emitted.push(a); return s; },
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

function setup({ url = 'http://relay.test', search = '?relay', user = true, ioFn, timers } = {}) {
  const fake = fakeIo();
  const tokens = [];
  const currentUser = user ? {
    uid: 'u1',
    getIdToken(force) { tokens.push(!!force); return Promise.resolve('tok' + tokens.length); }
  } : null;
  const G = {
    RELAY_URL: url,
    DB: {
      fb: { uid: 'u1', auth: { currentUser } }, user: 'Ash',
      save: { partner: 25, partnerShiny: true }, ownsShiny: d => d === 25
    },
    Social: { me: { uid: 'u1', name: 'AshK' } }
  };
  const st = (timers && timers.setTimeout) || setTimeout, ct = (timers && timers.clearTimeout) || clearTimeout;
  new Function('G', 'io', 'location', 'setTimeout', 'clearTimeout', source('js/net/relay.js'))(
    G, ioFn === undefined ? fake.io : ioFn, { search }, st, ct);
  return { R: G.Relay, G, fake, tokens, sock: () => fake.sockets[fake.sockets.length - 1] };
}

async function online(t) {
  const p = t.R.connect();
  await tick();
  t.sock().accept();
  await p;
}

test('enabled needs both G.RELAY_URL and the relay URL flag', () => {
  assert.equal(setup().R.enabled, true);
  assert.equal(setup({ search: '?dev&relay=1' }).R.enabled, true);
  assert.equal(setup({ url: '' }).R.enabled, false);
  assert.equal(setup({ search: '' }).R.enabled, false);
  assert.equal(setup({ search: '?relayx' }).R.enabled, false);
});

test('disabled: no socket opens and connect rejects with code disabled', async () => {
  for (const t of [setup({ url: '' }), setup({ search: '?dev' }), setup({ ioFn: null })]) {
    await assert.rejects(t.R.connect(), e => e.code === 'disabled');
    assert.equal(t.fake.sockets.length, 0);
    assert.equal(t.R.state, 'off');
    assert.equal(t.R.emit('sig', 'x', {}), false);
  }
});

test('connect: handshake, websocket only, state events, uid, idempotent', async () => {
  const t = setup(), states = [];
  t.R.on('state', s => states.push(s));
  assert.equal(t.R.state, 'off'); assert.equal(t.R.uid, null);
  const p1 = t.R.connect(), p2 = t.R.connect();
  assert.equal(p1, p2);
  assert.equal(t.R.state, 'connecting');
  await tick();
  const s = t.sock();
  assert.equal(t.fake.sockets.length, 1);
  assert.equal(s.url, 'http://relay.test');
  assert.deepEqual(s.opts.transports, ['websocket']);
  assert.equal(typeof s.opts.auth, 'function');
  assert.deepEqual(s.auths, [{ v: 1, token: 'tok1', name: 'AshK', dex: 25, shiny: true }]);
  assert.deepEqual(t.tokens, [false]);
  s.accept();
  await p1;
  assert.equal(t.R.state, 'online'); assert.equal(t.R.uid, 'u1');
  assert.deepEqual(states, ['connecting', 'online']);
  await t.R.connect();
  assert.equal(t.fake.sockets.length, 1);
});

test('handshake falls back to the account name and no shiny without one', async () => {
  const t = setup();
  t.G.Social = null; t.G.DB.ownsShiny = () => false;
  t.R.connect(); await tick();
  assert.deepEqual(t.sock().auths[0], { v: 1, token: 'tok1', name: 'Ash', dex: 25, shiny: false });
});

test('each server rejection maps to its code and closes the socket', async () => {
  for (const code of ['old-version', 'busy']) {
    const t = setup();
    const p = t.R.connect(); await tick();
    t.sock().reject(code);
    await assert.rejects(p, e => e instanceof Error && e.code === code);
    assert.equal(t.R.state, 'offline');
    assert.equal(t.sock().closed, true);
  }
  const t = setup();
  const p = t.R.connect(); await tick();
  t.sock().reject('something-else');
  await assert.rejects(p, e => e.code === 'unreachable');
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

test('no signed in account rejects bad-token, local mode disabled, both without a socket', async () => {
  const t = setup({ user: false });
  await assert.rejects(t.R.connect(), e => e.code === 'bad-token');
  assert.equal(t.fake.sockets.length, 0);
  const l = setup();
  l.G.DB.fb = null;
  await assert.rejects(l.R.connect(), e => e.code === 'disabled');
  assert.equal(l.fake.sockets.length, 0);
});

test('a rejection while reconnecting on its own reports the code through state', async () => {
  const t = setup(), states = [];
  await online(t);
  t.R.on('state', (...a) => states.push(a));
  const s = t.sock();
  s.drop('transport close');
  s.reject('old-version');
  assert.deepEqual(states, [['offline'], ['offline', 'old-version']]);
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

test('bad-token: refreshes the token once and retries, then rejects', async () => {
  let t = setup();
  let p = t.R.connect(); await tick();
  t.sock().reject('bad-token'); await tick();
  assert.equal(t.sock().connects, 2);
  assert.deepEqual(t.tokens, [false, true]);
  assert.equal(t.sock().auths[1].token, 'tok2');
  t.sock().accept();
  await p;
  assert.equal(t.R.state, 'online');

  t = setup();
  p = t.R.connect(); await tick();
  const rejected = assert.rejects(p, e => e.code === 'bad-token');
  t.sock().reject('bad-token'); await tick();
  t.sock().reject('bad-token');
  await rejected;
  assert.equal(t.sock().connects, 2);
  assert.deepEqual(t.tokens, [false, true]);
  assert.equal(t.R.state, 'offline');
});

test('reconnect asks for a fresh token and network drops keep the socket', async () => {
  const t = setup(), states = [];
  await online(t);
  t.R.on('state', s => states.push(s));
  const s = t.sock();
  s.drop('transport close');
  assert.equal(t.R.state, 'offline'); assert.equal(s.closed, false);
  assert.equal(t.R.uid, 'u1');
  s.netError();                              // un reintento que falla: sigue el mismo socket
  assert.equal(s.closed, false);
  s.opts.auth(d => s.auths.push(d)); await tick();   // socket.io reintenta
  assert.equal(s.auths[1].token, 'tok2');
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

test('on/off for server events; a throwing listener does not stop others', async () => {
  const t = setup(), got = [];
  const warn = console.warn; console.warn = () => {};
  try {
    const sig = (from, p) => got.push(['sig', from, p]);
    t.R.on('sig', () => { throw new Error('boom'); });
    t.R.on('sig', sig);
    t.R.on('m', (f, seq, b) => got.push(['m', f, seq, b.length]));
    t.R.on('peer', (u, s) => got.push(['peer', u, s]));
    await online(t);
    const s = t.sock();
    s.fire('sig', 'host', { ice: [] });
    s.fire('m', 'host', 3, new Uint8Array(4));
    s.fire('peer', 'g1', 'away');
    t.R.off('sig', sig);
    s.fire('sig', 'host', { ice: [1] });
    assert.deepEqual(got, [['sig', 'host', { ice: [] }], ['m', 'host', 3, 4], ['peer', 'g1', 'away']]);
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
  await assert.rejects(p, e => e.code === 'disabled');
});

test('dev.html loads the config after firebase-config and socket.io then relay before social', () => {
  const html = source('dev.html');
  const at = f => { const i = html.indexOf(`<script defer src="${f}"></script>`); assert.ok(i > 0, f); return i; };
  assert.ok(at('js/core/firebase-config.js') < at('js/net/relay-config.js'));
  assert.ok(at('js/net/relay-config.js') < at('js/core/db.js'));
  assert.ok(at('js/vendor/socket.io.min.js') < at('js/net/relay.js'));
  assert.ok(at('js/net/relay.js') < at('js/net/social.js'));
  assert.match(source('js/vendor/socket.io.min.js'), /^\/\*!\n \* Socket\.IO v4\.7\.5\n/);
  assert.match(source('js/net/relay-config.js'), /^G\.RELAY_URL = '';$/m);
});
