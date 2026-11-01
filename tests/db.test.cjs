// js/core/db.js de verdad con un G.Api falso: entrar con código, invitados,
// sin conexión, cerrar sesión, borrar la cuenta y varias pestañas.
// (La partida en el servidor llega en el paso 3: aquí sólo la copia del navegador.)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const SRC = ['js/core/save-merge.js', 'js/core/db.js'].map(f => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')]);

let NOW = 1e12;
const apiErr = (code, status) => Object.assign(new Error(code), { code, status, data: null });

/**
 * Un servidor falso para G.Api: sesiones por navegador (store), cuentas por correo.
 * server.down = true: todo falla con 'offline'.
 */
function makeServer() {
  const srv = { down: false, calls: [], users: new Map(), byEmail: new Map(), codes: new Map(), n: 0 };
  const meOf = u => ({ uid: u.uid, kind: u.kind, name: u.name, email: u.email ? u.email[0] + '***' + u.email.slice(u.email.indexOf('@')) : null, admin: false });
  const newUser = (kind, email) => { const u = { uid: 'U' + (++srv.n), kind, email, name: 'Guest' + (1000 + srv.n) }; srv.users.set(u.uid, u); if (email) srv.byEmail.set(email, u); return u; };
  srv.api = browser => {
    const call = async (method, p, body) => {
      srv.calls.push([method, p, body]);
      if (srv.down) throw apiErr('offline', 0);
      if (srv.missing) throw apiErr('http', 404);
      const sess = browser.sid && srv.users.get(browser.sid);
      if (method === 'GET' && p === '/api/me') { if (!sess) throw apiErr('signed-out', 401); return { me: meOf(sess) }; }
      if (p === '/api/auth/guest') { const u = sess || newUser('guest', null); browser.sid = u.uid; return { me: meOf(u) }; }
      if (p === '/api/auth/email') { if (!/@/.test(body.email)) throw apiErr('invalid', 400); srv.codes.set(body.email, '123456'); srv.lastLang = body.lang; return null; }
      if (p === '/api/auth/verify') {
        if (srv.codes.get(body.email) !== body.code) throw apiErr('bad-code', 400);
        srv.codes.delete(body.email);
        let u = srv.byEmail.get(body.email), merged = false;
        if (u) { if (sess && sess.kind === 'guest') { srv.users.delete(sess.uid); merged = true; } }
        else if (sess && sess.kind === 'guest') { u = sess; u.kind = 'email'; u.email = body.email; srv.byEmail.set(body.email, u); }
        else u = newUser('email', body.email);
        browser.sid = u.uid;
        return { me: meOf(u), merged };
      }
      if (p === '/api/auth/logout') { browser.sid = null; return null; }
      if (p === '/api/auth/logout-all') { if (srv.failAll) throw apiErr('offline', 0); browser.sid = null; return null; }
      if (method === 'DELETE' && p === '/api/me') { if (!sess) throw apiErr('signed-out', 401); srv.users.delete(sess.uid); browser.sid = null; return null; }
      throw apiErr('not-found', 404);
    };
    return { get: p => call('GET', p), post: (p, b = {}) => call('POST', p, b), put: (p, b = {}) => call('PUT', p, b), del: (p, b = {}) => call('DELETE', p, b) };
  };
  return srv;
}

const TABS = new Map();   // navegador (su localStorage) -> eventos 'storage' de cada pestaña
/** Una pestaña: browser = { store: Map (localStorage), sid (la cookie) }. */
function tab(server, browser, o = {}) {
  const store = browser.store;
  if (!TABS.has(store)) TABS.set(store, []);
  const mine = [], timers = [];
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); for (const fn of TABS.get(store)) if (!mine.includes(fn)) setImmediate(() => fn({ key: k, newValue: String(v) })); },
    removeItem: k => store.delete(k), key: i => [...store.keys()][i], get length() { return store.size; }
  };
  const G = { Api: server.api(browser), I18n: { lang: 'fr' } };
  const ctx = {
    G, localStorage, console: { warn() {}, log: console.log }, TextEncoder,
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {},
    location: { protocol: o.protocol || 'https:', hostname: 'localhost' }, navigator: { onLine: true },
    document: { hidden: false, addEventListener() {} },
    window: { addEventListener: (t, fn) => { mine.push(fn); TABS.get(store).push(fn); } }, Date: { now: () => NOW }
  };
  vm.createContext(ctx);
  for (const [f, src] of SRC) vm.runInContext(src, ctx, { filename: f });
  return { DB: G.DB, G, timers, close() { const l = TABS.get(store); for (const fn of mine) l.splice(l.indexOf(fn), 1); } };
}
// Lo que sale del vm es de otro reino: se compara en JSON.
const plain = x => JSON.parse(JSON.stringify(x));
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };
const newBrowser = () => ({ store: new Map(), sid: null });
async function open(server, browser, o) { const t = tab(server, browser, o); const r = await t.DB.ready(); await settle(); return Object.assign(t, { restored: r }); }
const cloudSave = (browser, uid) => JSON.parse(browser.store.get('ps.cloud.' + uid));

test('sin sesión: modo nube, a la pantalla de entrar', async () => {
  const srv = makeServer();
  const t = await open(srv, newBrowser());
  assert.equal(t.restored, false);
  assert.equal(t.DB.mode, 'cloud');
  assert.equal(t.DB.online, false);
  assert.equal(t.DB.me, null);
  assert.equal(t.DB.fb, null);
  assert.deepEqual(srv.calls.map(c => c[1]), ['/api/me']);
});

test('entrar con código: cuenta del servidor, partida en este navegador y sesión al recargar', async () => {
  const srv = makeServer(), b = newBrowser();
  let t = await open(srv, b);
  assert.deepEqual(plain(await t.DB.sendCode('nope')), { ok: false, code: 'invalid' });
  assert.deepEqual(plain(await t.DB.sendCode(' ash@example.com ')), { ok: true });
  assert.equal(srv.lastLang, 'fr');
  assert.equal((await t.DB.verifyCode('ash@example.com', '000000')).code, 'bad-code');
  const r = await t.DB.verifyCode('ash@example.com', '123456');
  assert.deepEqual(plain(r), { ok: true, isNew: true, merged: false });
  assert.equal(t.DB.online, true);
  assert.equal(t.DB.emailAccount, true);
  assert.equal(t.DB.guestAccount, false);
  assert.equal(t.DB.me.email, 'a***@example.com');
  assert.equal(t.DB.user, t.DB.me.name);
  assert.equal(t.DB.syncState, 'local');
  t.DB.save.tickets.t1 += 4; t.DB.commit();
  assert.equal(cloudSave(b, t.DB.me.uid).tickets.t1, 4);
  // Recargar: la cookie sigue, la partida también.
  t.close(); t = await open(srv, b);
  assert.equal(t.restored, true);
  assert.equal(t.DB.save.tickets.t1, 4);
  assert.deepEqual(plain(await t.DB.saveNow()), { ok: true, why: 'local' });
  await t.DB.flush();
});

test('sin conexión con alguien de antes: se juega con su copia y se vuelve a preguntar', async () => {
  const srv = makeServer(), b = newBrowser();
  let t = await open(srv, b);
  await t.DB.sendCode('misty@example.com'); await t.DB.verifyCode('misty@example.com', '123456');
  t.DB.save.coins = 900; t.DB.commit();
  t.close();
  srv.down = true;
  t = await open(srv, b);
  assert.equal(t.restored, true);
  assert.equal(t.DB.mode, 'cloud');
  assert.equal(t.DB.syncState, 'offline');
  assert.equal(t.DB.online, false);
  assert.equal(t.DB.save.coins, 900);
  srv.down = false;
  for (const fn of t.timers.splice(0)) fn();
  await settle();
  assert.equal(t.DB.online, true);
});

test('sin conexión y sin nadie de antes, o una web sin el servidor (404): modo local', async () => {
  const srv = makeServer();
  srv.down = true;
  let t = await open(srv, newBrowser());
  assert.equal(t.DB.mode, 'local');
  assert.equal(t.DB.localReason, 'error');
  srv.down = false; srv.missing = true;
  t = await open(srv, newBrowser());
  assert.equal(t.DB.mode, 'local');
  assert.equal(t.DB.localReason, 'config');
  srv.calls.length = 0;
  t = await open(srv, newBrowser(), { protocol: 'file:' });
  assert.equal(t.DB.localReason, 'file');
  assert.equal(srv.calls.length, 0);
  // Modo local: cuentas de este navegador, como siempre.
  assert.equal((await t.DB.register('Ash', 'pikachu')).ok, true);
  assert.equal((await t.DB.sendCode('a@b.co')).code, 'local');
});

test('invitado: cuenta del servidor que se guarda; al poner un correo nuevo sigue igual', async () => {
  const srv = makeServer(), b = newBrowser();
  let t = await open(srv, b);
  const g = await t.DB.playAsGuest();
  assert.deepEqual(plain(g), { ok: true, isNew: true });
  assert.equal(t.DB.guest, false);          // se guarda (no es el invitado en memoria)
  assert.equal(t.DB.guestAccount, true);
  assert.equal(t.DB.emailAccount, false);
  assert.equal(t.DB.online, true);
  const uid = t.DB.me.uid;
  t.DB.save.tickets.t1 = 3; t.DB.commit();
  t.close(); t = await open(srv, b);
  assert.equal(t.DB.save.tickets.t1, 3);
  await t.DB.sendCode('brock@example.com');
  const r = await t.DB.verifyCode('brock@example.com', '123456');
  assert.equal(r.merged, false);
  assert.equal(t.DB.me.uid, uid);
  assert.equal(t.DB.emailAccount, true);
  assert.equal(t.DB.save.tickets.t1, 3);
});

test('invitado que entra en una cuenta que ya existía: su progreso se junta con el de la cuenta', async () => {
  const srv = makeServer(), pc = newBrowser(), mob = newBrowser();
  let a = await open(srv, pc);
  await a.DB.sendCode('erika@example.com'); await a.DB.verifyCode('erika@example.com', '123456');
  const acc = a.DB.me.uid;
  a.DB.grant(1, 'starter'); a.DB.save.partner = 1; a.DB.commit();
  // En el móvil (otro navegador), la cuenta ya tenía su copia de antes (paso 3: vendrá del servidor).
  mob.store.set('ps.cloud.' + acc, pc.store.get('ps.cloud.' + acc));
  const m = await open(srv, mob);
  m.DB.save || await m.DB.playAsGuest();
  const guid = m.DB.me.uid;
  const before = JSON.parse(mob.store.get('ps.cloud.' + acc));
  m.DB.grant(4, 'gacha'); m.DB.save.tickets.t10 = 2; m.DB.save.coins += 50; m.DB.commit();
  await m.DB.sendCode('erika@example.com');
  const r = await m.DB.verifyCode('erika@example.com', '123456');
  assert.deepEqual(plain(r), { ok: true, isNew: false, merged: true });
  assert.equal(m.DB.me.uid, acc);
  assert.ok(m.DB.owns(1) && m.DB.owns(4));
  assert.equal(m.DB.save.tickets.t10, 2);
  // El mismo navegador (el mismo aparato en la libreta): las monedas se suman, no gana la mayor.
  assert.equal(m.DB.save.coins, before.coins + 500 + 50);
  assert.equal(m.DB.user, before.name);     // el nombre es el de la cuenta, no el del invitado
  assert.equal(mob.store.has('ps.cloud.' + guid), false);
  assert.ok(cloudSave(mob, acc).owned[4]);
});

test('cerrar sesión: la copia se queda para la próxima vez; en todas partes y borrar la cuenta', async () => {
  const srv = makeServer(), b = newBrowser();
  let t = await open(srv, b);
  await t.DB.sendCode('oak@example.com'); await t.DB.verifyCode('oak@example.com', '123456');
  const uid = t.DB.me.uid;
  t.DB.save.coins = 1234; t.DB.commit();
  const left = [];
  t.DB.onLeave(why => left.push(why));
  assert.deepEqual(plain(await t.DB.logout()), { ok: true });
  assert.deepEqual(plain(left), ['logout']);
  assert.equal(t.DB.save, null);
  assert.equal(t.DB.me, null);
  assert.equal(b.store.has('ps.me'), false);
  assert.ok(b.store.has('ps.cloud.' + uid));
  assert.equal(b.sid, null);
  await t.DB.sendCode('oak@example.com'); await t.DB.verifyCode('oak@example.com', '123456');
  assert.equal(t.DB.save.coins, 1234);

  srv.failAll = true;
  assert.equal((await t.DB.logout(true)).ok, false);
  assert.ok(t.DB.save);                      // sin conexión no se cierra a medias
  srv.failAll = false;
  assert.deepEqual(plain(await t.DB.logout(true)), { ok: true });
  assert.ok(srv.calls.some(c => c[1] === '/api/auth/logout-all'));

  await t.DB.sendCode('oak@example.com'); await t.DB.verifyCode('oak@example.com', '123456');
  assert.deepEqual(plain(await t.DB.deleteAccount()), { ok: true });
  assert.ok(srv.calls.some(c => c[0] === 'DELETE' && c[1] === '/api/me'));
  assert.equal(b.store.has('ps.cloud.' + uid), false);
  assert.equal(t.DB.loggedIn, false);
});

test('cerrar sesión sin conexión: al volver se cierra en el servidor y no entra sola', async () => {
  const srv = makeServer(), b = newBrowser();
  let t = await open(srv, b);
  await t.DB.sendCode('gary@example.com'); await t.DB.verifyCode('gary@example.com', '123456');
  srv.down = true;
  assert.deepEqual(plain(await t.DB.logout()), { ok: true });
  assert.ok(b.sid);                          // la cookie sigue valiendo
  t.close();
  srv.down = false;
  t = await open(srv, b);
  assert.equal(t.restored, false);
  assert.equal(b.sid, null);
  assert.equal(b.store.has('ps.out'), false);
  // Y "jugar como invitado" justo después (vuelve la red) no entra en la cuenta de antes.
  await t.DB.sendCode('gary@example.com'); await t.DB.verifyCode('gary@example.com', '123456');
  const gary = t.DB.me.uid;
  srv.down = true;
  await t.DB.logout();
  srv.down = false;
  const g = await t.DB.playAsGuest();
  assert.equal(g.ok, true);
  assert.notEqual(t.DB.me.uid, gary);
  assert.equal(t.DB.guestAccount, true);
});

test('el servidor contesta con un error al abrir (rate): no pasa a modo local', async () => {
  const srv = makeServer(), b = newBrowser();
  let t = await open(srv, b);
  await t.DB.sendCode('ash@example.com'); await t.DB.verifyCode('ash@example.com', '123456');
  t.close();
  const api = srv.api;
  srv.api = br => Object.assign(api(br), { get: async () => { throw apiErr('rate', 429); } });
  t = await open(srv, b);
  assert.equal(t.DB.mode, 'cloud');
  assert.equal(t.restored, true);
  assert.equal(t.DB.syncState, 'offline');
  t.close();
  t = await open(srv, newBrowser());
  assert.equal(t.DB.mode, 'cloud');
  assert.equal(t.restored, false);
  srv.api = api;
});

test('dos pestañas del mismo navegador no se pisan', async () => {
  const srv = makeServer(), b = newBrowser();
  const A = await open(srv, b);
  await A.DB.sendCode('ash@example.com'); await A.DB.verifyCode('ash@example.com', '123456');
  const A2 = await open(srv, b);
  const act = async (t, n) => { NOW += 1000; t.DB.save.tickets.t1 += n; t.DB.commit(); await settle(); };
  await act(A, 5); await act(A2, 2); await act(A, -1); await act(A2, 4);
  assert.equal(A.DB.save.tickets.t1, 10);
  assert.equal(A2.DB.save.tickets.t1, 10);
  assert.equal(cloudSave(b, A.DB.me.uid).tickets.t1, 10);
});

test('G.DB.merge es G.SaveMerge.merge (la misma que usa el servidor)', async () => {
  const t = await open(makeServer(), newBrowser());
  const a = { updated: 1, created: 1, coins: 5, tickets: { t1: 0, t10: 0 }, owned: { 1: { at: 1 } }, shiny: {}, upgrades: {}, stats: { runs: 2 } };
  const b = { updated: 2, created: 2, coins: 1, tickets: { t1: 3, t10: 0 }, owned: { 7: { at: 2 } }, shiny: {}, upgrades: {}, stats: { runs: 1 } };
  assert.deepEqual(plain(t.DB.merge(a, b)), plain(require('../js/core/save-merge.js').merge(a, b)));
  assert.deepEqual(plain(Object.keys(t.DB.merge(a, b).owned).sort()), ['1', '7']);
});
