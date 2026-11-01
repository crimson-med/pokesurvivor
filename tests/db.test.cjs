// js/core/db.js de verdad con un G.Api falso: entrar con código, invitados,
// sin conexión, cerrar sesión, borrar la cuenta, varias pestañas, la partida
// en el servidor (rev, 409, subir lo de sin conexión) y añadir las de antes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const SRC = ['js/core/save-merge.js', 'js/core/db.js'].map(f => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')]);
const { mergeInto } = require('../js/core/save-merge.js');

let NOW = 1e12;
const apiErr = (code, status, data) => Object.assign(new Error(code), { code, status, data: data || null });
const copy = x => (x == null ? x : JSON.parse(JSON.stringify(x)));

/**
 * Un servidor falso para G.Api: sesiones por navegador (store), cuentas por
 * correo y la partida de cada una (saves: uid -> { save, rev }, con la regla
 * de rev de server/http/save.js). server.down = true: todo falla con 'offline';
 * server.clash = true: cada PUT /api/save es un 409 (otro aparato siempre gana).
 */
function makeServer() {
  const srv = { down: false, calls: [], users: new Map(), byEmail: new Map(), codes: new Map(), saves: new Map(), n: 0 };
  srv.puts = () => srv.calls.filter(c => c[0] === 'PUT' && c[1] === '/api/save').length;
  srv.saveOf = uid => copy((srv.saves.get(uid) || {}).save);
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
        if (u) {
          if (sess && sess.kind === 'guest') {
            // Como server/http/auth.js: la partida del invitado, dentro de la de la cuenta.
            const g = srv.saves.get(sess.uid), a = srv.saves.get(u.uid);
            if (g) srv.saves.set(u.uid, { save: copy(mergeInto(a && a.save, g.save, 'g' + sess.uid)), rev: (a ? a.rev : 0) + 1 });
            srv.saves.delete(sess.uid); srv.users.delete(sess.uid); merged = true;
          }
        }
        else if (sess && sess.kind === 'guest') { u = sess; u.kind = 'email'; u.email = body.email; srv.byEmail.set(body.email, u); }
        else u = newUser('email', body.email);
        browser.sid = u.uid;
        return { me: meOf(u), merged };
      }
      if (p === '/api/auth/logout') { browser.sid = null; return null; }
      if (p === '/api/auth/logout-all') { if (srv.failAll) throw apiErr('offline', 0); browser.sid = null; return null; }
      if (method === 'DELETE' && p === '/api/me') { if (!sess) throw apiErr('signed-out', 401); srv.users.delete(sess.uid); srv.saves.delete(sess.uid); browser.sid = null; return null; }
      if (p === '/api/save') {
        if (!sess) throw apiErr('signed-out', 401);
        const row = srv.saves.get(sess.uid);
        if (method === 'GET') { if (!row) throw apiErr('not-found', 404); return { save: copy(row.save), rev: row.rev, updated: 1 }; }
        if (method === 'PUT') {
          if (srv.tooBig) throw apiErr('too-big', 413);
          if (srv.clash || (row ? row.rev !== body.rev : body.rev !== 0)) {
            throw apiErr('conflict', 409, { save: row ? copy(row.save) : null, rev: row ? row.rev : 0 });
          }
          srv.saves.set(sess.uid, { save: copy(body.save), rev: body.rev + 1 });
          return { rev: body.rev + 1 };
        }
      }
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
  const mine = [], timers = [], win = {};
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
    window: { addEventListener: (t, fn) => { if (t !== 'storage') { (win[t] ||= []).push(fn); return; } mine.push(fn); TABS.get(store).push(fn); } },
    Date: { now: () => NOW }
  };
  vm.createContext(ctx);
  for (const [f, src] of SRC) vm.runInContext(src, ctx, { filename: f });
  return {
    DB: G.DB, G, timers, win,
    // Pasa el tiempo: salta todo lo que esperaba (subidas agrupadas, reintentos).
    async tick() { for (const fn of timers.splice(0)) fn(); await settle(); },
    close() { const l = TABS.get(store); for (const fn of mine) l.splice(l.indexOf(fn), 1); timers.length = 0; }
  };
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

test('entrar con código: cuenta del servidor, partida en el servidor y en este navegador, sesión al recargar', async () => {
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
  // Cuenta nueva: sin partida en el servidor (404), queda pendiente de subir.
  assert.ok(srv.calls.some(c => c[0] === 'GET' && c[1] === '/api/save'));
  assert.equal(t.DB.syncState, 'pending');
  const uid = t.DB.me.uid;
  t.DB.save.tickets.t1 += 4; t.DB.commit();
  assert.equal(cloudSave(b, uid).tickets.t1, 4);
  assert.equal(srv.puts(), 0);                // se agrupa: todavía no ha subido
  await t.tick();
  assert.equal(srv.puts(), 1);
  assert.equal(srv.saveOf(uid).tickets.t1, 4);
  assert.equal(srv.saves.get(uid).rev, 1);
  assert.equal(t.DB.syncState, 'ok');
  assert.deepEqual(plain(await t.DB.saveNow()), { ok: true, why: 'done' });
  t.DB.save.tickets.t1 += 1; t.DB.commit();
  assert.deepEqual(plain(await t.DB.saveNow()), { ok: true });
  assert.equal(srv.saveOf(uid).tickets.t1, 5);
  // Guardar sin cambios no escribe.
  t.DB.commit(); await t.DB.flush();
  assert.equal(srv.puts(), 2);
  // Recargar: la cookie sigue, la partida también, y va a la par con el servidor.
  t.close(); t = await open(srv, b);
  assert.equal(t.restored, true);
  assert.equal(t.DB.save.tickets.t1, 5);
  assert.equal(t.DB.syncState, 'ok');
  // Otro navegador con el mismo correo: la misma partida.
  const pc = await open(srv, newBrowser());
  await pc.DB.sendCode('ash@example.com'); await pc.DB.verifyCode('ash@example.com', '123456');
  assert.equal(pc.DB.me.uid, uid);
  assert.equal(pc.DB.save.tickets.t1, 5);
  assert.equal(pc.DB.syncState, 'ok');
});

test('sin conexión con alguien de antes: se juega con su copia y se vuelve a preguntar', async () => {
  const srv = makeServer(), b = newBrowser();
  let t = await open(srv, b);
  await t.DB.sendCode('misty@example.com'); await t.DB.verifyCode('misty@example.com', '123456');
  t.DB.save.coins = 900; t.DB.commit();
  t.close();                                 // (cerrada antes de subir: queda en la copia)
  srv.down = true;
  t = await open(srv, b);
  assert.equal(t.restored, true);
  assert.equal(t.DB.mode, 'cloud');
  assert.equal(t.DB.syncState, 'offline');
  assert.equal(t.DB.online, false);
  assert.equal(t.DB.save.coins, 900);
  // Sin conexión se sigue jugando: se guarda aquí y la subida espera.
  t.DB.save.tickets.t10 = 2; t.DB.commit();
  assert.equal(t.DB.syncState, 'offline');
  assert.deepEqual(plain(await t.DB.saveNow()), { ok: false, why: 'offline' });
  await t.tick();                            // un reintento, aún sin servidor
  assert.equal(t.DB.syncState, 'offline');
  const uid = t.DB.me.uid;
  assert.equal(srv.saves.has(uid), false);
  // Vuelve el servidor: en el siguiente reintento sube todo.
  srv.down = false;
  await t.tick();
  assert.equal(t.DB.online, true);
  assert.equal(t.DB.syncState, 'ok');
  assert.equal(srv.saveOf(uid).coins, 900);
  assert.equal(srv.saveOf(uid).tickets.t10, 2);
  // Y si el navegador avisa de que vuelve la red, sin esperar.
  srv.down = true;
  t.DB.save.coins = 950; t.DB.commit();
  await t.tick();
  assert.equal(t.DB.syncState, 'offline');
  srv.down = false;
  for (const fn of t.win.online) fn();
  await settle();
  assert.equal(srv.saveOf(uid).coins, 950);
  assert.equal(t.DB.syncState, 'ok');
});

test('dos aparatos con la misma cuenta: la rev frena al de la copia vieja, se juntan y sube otra vez', async () => {
  const srv = makeServer(), pcB = newBrowser(), mobB = newBrowser();
  const pc = await open(srv, pcB);
  await pc.DB.sendCode('ash@example.com'); await pc.DB.verifyCode('ash@example.com', '123456');
  const uid = pc.DB.me.uid;
  pc.DB.grant(1, 'starter'); pc.DB.save.partner = 1; pc.DB.commit();
  await pc.DB.flush();
  const mob = await open(srv, mobB);
  await mob.DB.sendCode('ash@example.com'); await mob.DB.verifyCode('ash@example.com', '123456');
  assert.ok(mob.DB.owns(1));
  // Los dos juegan; el PC sube primero.
  NOW += 1000;
  pc.DB.grant(7, 'gacha'); pc.DB.save.coins += 100; pc.DB.commit();
  await pc.DB.flush();
  assert.equal(srv.saves.get(uid).rev, 2);
  NOW += 1000;
  mob.DB.grant(25, 'wild'); mob.DB.save.tickets.t1 += 3; mob.DB.commit();
  const before = srv.puts();
  assert.deepEqual(plain(await mob.DB.saveNow()), { ok: true });
  assert.equal(srv.puts() - before, 2);      // 409 con la rev 1, y otra vez con la 2
  const s = srv.saveOf(uid);
  assert.deepEqual(Object.keys(s.owned).sort(), ['1', '25', '7']);
  assert.equal(s.coins, 600);
  assert.equal(s.tickets.t1, 3);
  assert.equal(srv.saves.get(uid).rev, 3);
  assert.ok(mob.DB.owns(7));
  assert.equal(mob.DB.save.coins, 600);
  assert.equal(cloudSave(mobB, uid).coins, 600);
  assert.equal(mob.DB.syncState, 'ok');
  // El PC, al recargar, también lo tiene todo.
  pc.close();
  const pc2 = await open(srv, pcB);
  assert.ok(pc2.DB.owns(25));
  assert.equal(pc2.DB.save.tickets.t1, 3);
});

test('409 una y otra vez: se junta y se reintenta una sola vez; luego queda pendiente', async () => {
  const srv = makeServer(), b = newBrowser();
  const t = await open(srv, b);
  await t.DB.sendCode('ash@example.com'); await t.DB.verifyCode('ash@example.com', '123456');
  await t.DB.flush();
  const uid = t.DB.me.uid;
  // Otro aparato subió una partida con un Pokémon que aquí no está.
  srv.saves.set(uid, { save: Object.assign(srv.saveOf(uid), { owned: { 150: { at: 1, from: 'wild' } } }), rev: 9 });
  srv.clash = true;
  t.DB.grant(4, 'gacha'); t.DB.commit();
  const before = srv.puts();
  assert.deepEqual(plain(await t.DB.saveNow()), { ok: false, why: 'fail' });
  assert.equal(srv.puts() - before, 2);
  assert.ok(t.DB.owns(150) && t.DB.owns(4));  // lo del servidor ya está aquí
  assert.equal(t.DB.syncState, 'pending');
  srv.clash = false;
  await t.tick();
  assert.equal(t.DB.syncState, 'ok');
  assert.equal(srv.saves.get(uid).rev, 10);
  assert.ok(srv.saveOf(uid).owned[4] && srv.saveOf(uid).owned[150]);
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

for (const pushed of [false, true]) {
  test(`invitado que entra en una cuenta que ya existía: su progreso se junta con el de la cuenta (${pushed ? 'ya subido' : 'sin subir'})`, async () => {
    const srv = makeServer(), pc = newBrowser(), mob = newBrowser();
    let a = await open(srv, pc);
    await a.DB.sendCode('erika@example.com'); await a.DB.verifyCode('erika@example.com', '123456');
    const acc = a.DB.me.uid;
    a.DB.grant(1, 'starter'); a.DB.save.partner = 1; a.DB.commit();
    await a.DB.flush();
    const before = srv.saveOf(acc);
    // En el móvil (otro navegador) se juega como invitado.
    const m = await open(srv, mob);
    m.DB.save || await m.DB.playAsGuest();
    const guid = m.DB.me.uid;
    m.DB.grant(4, 'gacha'); m.DB.save.tickets.t10 = 2; m.DB.save.coins += 50; m.DB.commit();
    // (Ya subida: el servidor la junta con la de la cuenta y el navegador otra vez; no cuenta doble.)
    if (pushed) { await m.DB.flush(); assert.equal(srv.saveOf(guid).coins, 550); }
    await m.DB.sendCode('erika@example.com');
    const r = await m.DB.verifyCode('erika@example.com', '123456');
    assert.deepEqual(plain(r), { ok: true, isNew: false, merged: true });
    assert.equal(m.DB.me.uid, acc);
    assert.ok(m.DB.owns(1) && m.DB.owns(4));
    assert.equal(m.DB.save.partner, 1);        // el compañero es el de la cuenta
    assert.equal(m.DB.save.tickets.t10, 2);
    // Cada aparato con su apunte en la libreta: las monedas se suman, no gana la mayor.
    assert.equal(m.DB.save.coins, before.coins + 500 + 50);
    assert.equal(m.DB.user, before.name);     // el nombre es el de la cuenta, no el del invitado
    assert.equal(mob.store.has('ps.cloud.' + guid), false);
    assert.ok(cloudSave(mob, acc).owned[4]);
    await m.DB.flush();
    assert.equal(srv.saveOf(acc).coins, before.coins + 550);
    assert.ok(srv.saveOf(acc).owned[4]);
  });
}

test('cerrar sesión: la copia se queda para la próxima vez; en todas partes y borrar la cuenta', async () => {
  const srv = makeServer(), b = newBrowser();
  let t = await open(srv, b);
  await t.DB.sendCode('oak@example.com'); await t.DB.verifyCode('oak@example.com', '123456');
  const uid = t.DB.me.uid;
  t.DB.save.coins = 1234; t.DB.commit();
  const left = [];
  t.DB.onLeave(why => left.push(why));
  assert.deepEqual(plain(await t.DB.logout()), { ok: true });
  assert.equal(srv.saveOf(uid).coins, 1234);  // lo pendiente sube antes de cerrar
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
  // Las dos suben; la segunda se encuentra la rev nueva, junta y no cambia nada.
  await A.tick(); await A2.tick();
  assert.equal(srv.saveOf(A.DB.me.uid).tickets.t1, 10);
  assert.equal(A.DB.syncState, 'ok');
  assert.equal(A2.DB.syncState, 'ok');
});

test('un fallo que no se arregla solo (413): no se reintenta en cada guardado, sólo con Guardar', async () => {
  const srv = makeServer(), b = newBrowser();
  const t = await open(srv, b);
  await t.DB.sendCode('ash@example.com'); await t.DB.verifyCode('ash@example.com', '123456');
  srv.tooBig = true;
  await t.tick();
  assert.equal(srv.puts(), 1);
  assert.equal(t.DB.syncState, 'pending');
  t.DB.save.coins += 1; t.DB.commit();
  await t.tick(); await t.tick();
  assert.equal(srv.puts(), 1);
  assert.deepEqual(plain(await t.DB.saveNow()), { ok: false, why: 'fail' });
  assert.equal(srv.puts(), 2);
  srv.tooBig = false;
  assert.deepEqual(plain(await t.DB.saveNow()), { ok: true });
  assert.equal(t.DB.syncState, 'ok');
});

// Partidas de antes en un navegador: una del modo local y una del juego original (uid de Firebase).
const FB_UID = 'aB3dE5gH7jK9mN1pQ3sT5vX7yZ9b';
function oldBrowser() {
  const b = newBrowser();
  b.store.set('ps.save.ash', JSON.stringify({ v: 3, name: 'Ash', updated: 5, coins: 300, owned: { 4: { at: 1, from: 'starter' } }, partner: 4 }));
  b.store.set('ps.cloud.' + FB_UID, JSON.stringify({ v: 3, name: 'Ash', updated: 6, coins: 0, tickets: { t1: 0, t10: 1 }, owned: { 7: { at: 2, from: 'gacha' } } }));
  // Esta es de una cuenta de este servidor (su forma de uid): no es de antes.
  b.store.set('ps.cloud.AAAAAAAAAAAAAAAAAAAAAA', JSON.stringify({ v: 3, coins: 0, owned: { 150: { at: 3 } } }));
  // Y una cuenta creada y sin jugar tampoco.
  b.store.set('ps.save.empty', JSON.stringify({ v: 3, coins: 500, owned: {} }));
  return b;
}

test('partidas de antes en este navegador: se ofrecen una vez y, con sí, se juntan con la cuenta y suben', async () => {
  const srv = makeServer(), b = oldBrowser();
  let t = await open(srv, b);
  assert.equal(t.DB.importable, false);       // sin cuenta, nada
  await t.DB.sendCode('ash@example.com'); await t.DB.verifyCode('ash@example.com', '123456');
  const uid = t.DB.me.uid;
  assert.equal(t.DB.importable, true);
  const r = await t.DB.importOld();
  assert.deepEqual(plain(r), { ok: true, n: 2 });
  assert.ok(t.DB.owns(4) && t.DB.owns(7));
  assert.equal(t.DB.owns(150), false);
  assert.equal(t.DB.save.coins, 500 + 300);   // las monedas se suman
  assert.equal(t.DB.save.tickets.t10, 1);
  const up = srv.saveOf(uid);
  assert.ok(up.owned[4] && up.owned[7]);
  assert.equal(up.coins, 800);
  assert.equal(t.DB.syncState, 'ok');
  // Ya no se vuelve a ofrecer (tampoco al recargar); las de antes siguen en el navegador.
  assert.equal(t.DB.importable, false);
  assert.deepEqual(plain(await t.DB.importOld()), { ok: false, n: 0 });
  assert.equal(t.DB.save.coins, 800);
  t.close(); t = await open(srv, b);
  assert.equal(t.DB.importable, false);
  assert.ok(b.store.has('ps.save.ash'));
});

test('partidas de antes: con no, se quedan y no se vuelve a preguntar; las de otras cuentas de aquí no cuentan', async () => {
  const srv = makeServer(), b = oldBrowser();
  let t = await open(srv, b);
  await t.DB.sendCode('ash@example.com'); await t.DB.verifyCode('ash@example.com', '123456');
  assert.equal(t.DB.importable, true);
  t.DB.declineImport();
  assert.equal(t.DB.importable, false);
  assert.equal(b.store.get('ps.import.no'), '1');
  assert.ok(b.store.has('ps.save.ash') && b.store.has('ps.cloud.' + FB_UID));
  await t.DB.logout();
  await t.DB.sendCode('misty@example.com'); await t.DB.verifyCode('misty@example.com', '123456');
  assert.equal(t.DB.importable, false);
  // Un navegador sin partidas de antes, con dos cuentas de este servidor: la de la otra no se ofrece.
  const c = newBrowser();
  t = await open(srv, c);
  await t.DB.sendCode('brock@example.com'); await t.DB.verifyCode('brock@example.com', '123456');
  t.DB.grant(1, 'starter'); t.DB.commit();
  await t.DB.logout();
  await t.DB.sendCode('gary@example.com'); await t.DB.verifyCode('gary@example.com', '123456');
  assert.equal(t.DB.importable, false);
  // Un invitado del modo local (sin servidor) no tiene a qué añadirlas.
  const l = await open(srv, oldBrowser(), { protocol: 'file:' });
  assert.equal(l.DB.importable, false);
});

test('G.DB.merge es G.SaveMerge.merge (la misma que usa el servidor)', async () => {
  const t = await open(makeServer(), newBrowser());
  const a = { updated: 1, created: 1, coins: 5, tickets: { t1: 0, t10: 0 }, owned: { 1: { at: 1 } }, shiny: {}, upgrades: {}, stats: { runs: 2 } };
  const b = { updated: 2, created: 2, coins: 1, tickets: { t1: 3, t10: 0 }, owned: { 7: { at: 2 } }, shiny: {}, upgrades: {}, stats: { runs: 1 } };
  assert.deepEqual(plain(t.DB.merge(a, b)), plain(require('../js/core/save-merge.js').merge(a, b)));
  assert.deepEqual(plain(Object.keys(t.DB.merge(a, b).owned).sort()), ['1', '7']);
});
