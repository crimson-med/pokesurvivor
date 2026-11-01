/* ============ auth.test.js: códigos por correo, invitados, sesiones y CSRF ============ */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioc } = require('socket.io-client');
const { createServer } = require('../index');
const { loadConfig } = require('../config');
const store = require('../db');
const { createMailer, codeMail, LANGS } = require('../mail');
const { maskEmail } = require('../http/guard');
const { mergeInto } = require('../../js/core/save-merge.js');

const ORIGIN = 'http://localhost:8000';
const DAY = 24 * 3600 * 1000;

let NOW = Date.now();
const mails = [];
let mailFails = false;

async function start(o = {}) {
  const srv = createServer(loadConfig({ SITE_URL: ORIGIN, ...o.env }), {
    store: store.open(':memory:', { log: false }),
    now: () => NOW,
    mailer: {
      async sendCode(to, code, lang) {
        if (mailFails) throw new Error('smtp caído');
        mails.push({ to, code, lang });
      },
    },
    limits: o.limits,
  });
  const port = await srv.listen(0, '127.0.0.1');
  return { srv, url: 'http://127.0.0.1:' + port };
}

let s;
test.before(async () => {
  // Todos llaman desde 127.0.0.1: los topes por IP se suben aquí y se prueban abajo con otro servidor.
  s = await start({ limits: { codeIp: [1000, 3600000], guestIp: [1000, 3600000] } });
});
test.after(() => s.srv.close());

// Un navegador: su cookie, X-PS y Origin.
function browser(base = () => s.url) {
  let cookie = '';
  async function call(method, p, body, extra = {}) {
    const headers = { 'content-type': 'application/json', 'x-ps': '1', origin: ORIGIN, ...extra };
    if (cookie) headers.cookie = cookie;
    const r = await fetch(base() + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of r.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const v = kv.slice(kv.indexOf('=') + 1);
      if (kv.startsWith('ps_sid=')) cookie = v ? 'ps_sid=' + v : '';
    }
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null, headers: r.headers };
  }
  return {
    get: p => call('GET', p),
    post: (p, b = {}, h) => call('POST', p, b, h),
    put: (p, b = {}) => call('PUT', p, b),
    del: (p, b = {}) => call('DELETE', p, b),
    get cookie() { return cookie; },
    set cookie(v) { cookie = v; },
  };
}

const lastCode = email => [...mails].reverse().find(m => m.to === email).code;

async function signIn(b, email) {
  assert.equal((await b.post('/api/auth/email', { email, lang: 'es' })).status, 204);
  return b.post('/api/auth/verify', { email, code: lastCode(email) });
}

const rows = (sql, ...a) => s.srv.store.prep(sql).all(...a);

test('código enviado, comprobado, cookie puesta y /api/me', async () => {
  const b = browser();
  assert.equal((await b.get('/api/me')).status, 401);
  assert.deepEqual((await b.get('/api/me')).body, { error: 'signed-out' });
  const r = await b.post('/api/auth/email', { email: '  Ash@Example.COM ', lang: 'fr' });
  assert.equal(r.status, 204);
  const m = mails.at(-1);
  assert.equal(m.to, 'ash@example.com');
  assert.match(m.code, /^\d{6}$/);
  assert.equal(m.lang, 'fr');
  // Sólo se guarda el resumen del código.
  const c = rows('SELECT code_hash FROM codes WHERE email = ?', 'ash@example.com')[0];
  assert.ok(Buffer.isBuffer(c.code_hash) && !c.code_hash.toString().includes(m.code));

  const v = await b.post('/api/auth/verify', { email: 'ash@example.com', code: m.code });
  assert.equal(v.status, 200);
  assert.equal(v.body.merged, false);
  assert.equal(v.body.me.kind, 'email');
  assert.equal(v.body.me.email, 'a***@example.com');
  assert.match(v.body.me.name, /^Guest\d{4}$/);
  assert.equal(v.body.me.admin, false);
  assert.ok(b.cookie.startsWith('ps_sid='));
  const me = await b.get('/api/me');
  assert.equal(me.status, 200);
  assert.deepEqual(me.body.me, v.body.me);
  // El código ya no vale otra vez.
  assert.equal((await browser().post('/api/auth/verify', { email: 'ash@example.com', code: m.code })).body.error, 'expired');
  // Y otra vez con el mismo correo: la misma cuenta.
  const b2 = browser();
  assert.equal((await signIn(b2, 'ash@example.com')).body.me.uid, v.body.me.uid);
});

test('la cookie: HttpOnly, SameSite=Lax, Path=/, 180 días; Secure fuera de localhost', async () => {
  const r = await fetch(s.url + '/api/auth/guest', { method: 'POST', headers: { 'x-ps': '1', origin: ORIGIN, 'content-type': 'application/json' }, body: '{}' });
  const c = r.headers.getSetCookie()[0];
  assert.match(c, /^ps_sid=[A-Za-z0-9_-]{43};/);
  for (const p of ['HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=15552000']) assert.ok(c.includes(p), p);
  assert.ok(!c.includes('Secure'));
  const prod = await start({ env: { SITE_URL: 'https://play.example.com' } });
  try {
    const r2 = await fetch(prod.url + '/api/auth/guest', { method: 'POST', headers: { 'x-ps': '1', origin: 'https://play.example.com', 'content-type': 'application/json' }, body: '{}' });
    assert.ok(r2.headers.getSetCookie()[0].includes('Secure'));
  } finally { await prod.srv.close(); }
});

test('5 códigos mal queman el código (too-many), también el bueno', async () => {
  const b = browser();
  await b.post('/api/auth/email', { email: 'brock@example.com' });
  const good = lastCode('brock@example.com');
  const bad = good === '000000' ? '111111' : '000000';
  const errs = [];
  for (let i = 0; i < 5; i++) errs.push((await b.post('/api/auth/verify', { email: 'brock@example.com', code: bad })).body.error);
  assert.deepEqual(errs, ['bad-code', 'bad-code', 'bad-code', 'bad-code', 'too-many']);
  const r = await b.post('/api/auth/verify', { email: 'brock@example.com', code: good });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'too-many');
  assert.equal(b.cookie, '');
});

test('código caducado a los 10 minutos; pedir otro sustituye al anterior', async () => {
  const b = browser();
  await b.post('/api/auth/email', { email: 'misty@example.com' });
  const first = lastCode('misty@example.com');
  NOW += 10 * 60 * 1000 + 1;
  assert.equal((await b.post('/api/auth/verify', { email: 'misty@example.com', code: first })).body.error, 'expired');
  await b.post('/api/auth/email', { email: 'misty@example.com' });
  const second = lastCode('misty@example.com');
  await b.post('/api/auth/email', { email: 'misty@example.com' });
  const third = lastCode('misty@example.com');
  if (second !== third) assert.equal((await b.post('/api/auth/verify', { email: 'misty@example.com', code: second })).body.error, 'bad-code');
  assert.equal((await b.post('/api/auth/verify', { email: 'misty@example.com', code: third })).status, 200);
});

test('/api/auth/email: 204 para cualquier correo; mal formado, invalid; sin correo, 502 mail', async () => {
  const b = browser();
  assert.equal((await b.post('/api/auth/email', { email: 'nadie-tiene-esto@example.com' })).status, 204);
  assert.equal((await b.post('/api/auth/email', { email: 'ash@example.com' })).status, 204);
  for (const email of ['', 'sin-arroba', 'a@b', 'a b@c.d', 'x'.repeat(250) + '@e.com', 42, null]) {
    const r = await b.post('/api/auth/email', { email });
    assert.equal(r.status, 400, String(email));
    assert.equal(r.body.error, 'invalid');
  }
  mailFails = true;
  try {
    const r = await b.post('/api/auth/email', { email: 'roto@example.com' });
    assert.equal(r.status, 502);
    assert.equal(r.body.error, 'mail');
    assert.equal(rows('SELECT * FROM codes WHERE email = ?', 'roto@example.com').length, 0);
  } finally { mailFails = false; }
  assert.equal((await b.post('/api/auth/verify', { email: 'ash@example.com', code: '12' })).body.error, 'invalid');
});

test('topes: 3 códigos por correo cada 15 min y 10 por IP cada hora (429 rate con Retry-After)', async () => {
  const x = await start({ limits: { guestIp: [1000, 3600000] } });
  const b = browser(() => x.url);
  try {
    const st = [];
    for (let i = 0; i < 4; i++) st.push((await b.post('/api/auth/email', { email: 'gary@example.com' })).status);
    assert.deepEqual(st, [204, 204, 204, 429]);
    const r = await b.post('/api/auth/email', { email: 'gary@example.com' });
    assert.equal(r.body.error, 'rate');
    assert.ok(+r.headers.get('retry-after') > 0);
    // Por IP: 10 en total (los 5 de gary cuentan, también los que paró el tope del correo).
    const more = [];
    for (let i = 0; i < 8; i++) more.push((await b.post('/api/auth/email', { email: 'p' + i + '@example.com' })).status);
    assert.deepEqual(more, [204, 204, 204, 204, 204, 429, 429, 429]);
    assert.equal((await b.post('/api/auth/email', { email: 'nuevo@example.com' })).body.error, 'rate');
  } finally { await x.srv.close(); }
});

test('invitados: 10 por IP y hora', async () => {
  const x = await start();
  try {
    const st = [];
    for (let i = 0; i < 11; i++) st.push((await browser(() => x.url).post('/api/auth/guest')).status);
    assert.deepEqual(st, [...Array(10).fill(200), 429]);
  } finally { await x.srv.close(); }
});

test('invitado: se crea, con sesión devuelve la misma cuenta', async () => {
  const b = browser();
  const r = await b.post('/api/auth/guest');
  assert.equal(r.status, 200);
  assert.equal(r.body.me.kind, 'guest');
  assert.equal(r.body.me.email, null);
  assert.match(r.body.me.name, /^Guest\d{4}$/);
  const again = await b.post('/api/auth/guest');
  assert.equal(again.body.me.uid, r.body.me.uid);
  assert.deepEqual((await b.get('/api/me')).body.me, r.body.me);
});

test('invitado que pone un correo nuevo: mismo uid y misma partida', async () => {
  const b = browser();
  const g = (await b.post('/api/auth/guest')).body.me;
  s.srv.store.prep('INSERT INTO saves (uid, rev, body, updated) VALUES (?, 1, ?, 1)').run(g.uid, JSON.stringify({ v: 3, coins: 7 }));
  const v = await signIn(b, 'nuevo-entrenador@example.com');
  assert.equal(v.status, 200);
  assert.equal(v.body.merged, false);
  assert.equal(v.body.me.uid, g.uid);
  assert.equal(v.body.me.kind, 'email');
  assert.equal(v.body.me.name, g.name);
  assert.equal(JSON.parse(rows('SELECT body FROM saves WHERE uid = ?', g.uid)[0].body).coins, 7);
  assert.equal((await b.get('/api/me')).body.me.kind, 'email');
});

test('invitado que pone un correo con cuenta: se juntan las partidas y el invitado se borra', async () => {
  const owner = browser();
  const acc = (await signIn(owner, 'erika@example.com')).body.me;
  const A = { v: 3, name: 'Erika', updated: 100, created: 1, coins: 10, tickets: { t1: 0, t10: 0 }, owned: { 1: { at: 5 } }, shiny: {}, upgrades: {}, stats: { runs: 4 } };
  const B = { v: 3, name: 'Guest', updated: 200, created: 2, coins: 3, tickets: { t1: 2, t10: 0 }, owned: { 4: { at: 9 } }, shiny: {}, upgrades: {}, stats: { runs: 1 } };
  s.srv.store.prep('INSERT INTO saves (uid, rev, body, updated) VALUES (?, 5, ?, 1)').run(acc.uid, JSON.stringify(A));
  const b = browser();
  const g = (await b.post('/api/auth/guest')).body.me;
  s.srv.store.prep('INSERT INTO saves (uid, rev, body, updated) VALUES (?, 1, ?, 1)').run(g.uid, JSON.stringify(B));
  const guestCookie = b.cookie;
  const v = await signIn(b, 'erika@example.com');
  assert.equal(v.body.merged, true);
  assert.equal(v.body.me.uid, acc.uid);
  assert.notEqual(b.cookie, guestCookie);
  const row = rows('SELECT rev, body FROM saves WHERE uid = ?', acc.uid)[0];
  assert.equal(row.rev, 6);
  // Lo mismo que hace el juego (es la misma función, js/core/save-merge.js).
  assert.deepEqual(JSON.parse(row.body), JSON.parse(JSON.stringify(mergeInto(A, B, 'g' + g.uid))));
  const got = JSON.parse(row.body);
  assert.deepEqual(Object.keys(got.owned).sort(), ['1', '4']);
  assert.equal(got.tickets.t1, 2);
  assert.equal(got.coins, 13);              // se suman: el invitado es otra cuenta
  assert.equal(got.name, 'Erika');          // el nombre es el de la cuenta
  assert.equal(got.stats.runs, 4);
  assert.equal(rows('SELECT * FROM users WHERE uid = ?', g.uid).length, 0);
  assert.equal(rows('SELECT * FROM saves WHERE uid = ?', g.uid).length, 0);
  // La cookie vieja del invitado ya no vale.
  const old = browser(); old.cookie = guestCookie;
  assert.equal((await old.get('/api/me')).status, 401);
});

test('el código lo pidió otra sesión: el invitado que lo comprueba no se junta', async () => {
  const owner = browser();
  await owner.post('/api/auth/email', { email: 'otra-sesion@example.com' });   // sin sesión
  const b = browser();
  const g = (await b.post('/api/auth/guest')).body.me;
  const v = await b.post('/api/auth/verify', { email: 'otra-sesion@example.com', code: lastCode('otra-sesion@example.com') });
  assert.equal(v.status, 200);
  assert.notEqual(v.body.me.uid, g.uid);
  assert.equal(v.body.merged, false);
});

test('CSRF: sin X-PS, con otro Origin o sin Origin, 403 csrf', async () => {
  const send = headers => fetch(s.url + '/api/auth/guest', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' })
    .then(async r => [r.status, (await r.json()).error]);
  assert.deepEqual(await send({ origin: ORIGIN }), [403, 'csrf']);
  assert.deepEqual(await send({ 'x-ps': '1', origin: 'https://otra.web' }), [403, 'csrf']);
  assert.deepEqual(await send({ 'x-ps': '1' }), [403, 'csrf']);
  assert.deepEqual(await send({ 'x-ps': '2', origin: ORIGIN }), [403, 'csrf']);
  for (const [m, p] of [['DELETE', '/api/me'], ['PUT', '/api/me/name'], ['POST', '/api/auth/email']]) {
    const r = await fetch(s.url + p, { method: m, headers: { origin: ORIGIN } });
    assert.equal(r.status, 403, m + ' ' + p);
  }
  // GET no lo necesita.
  assert.equal((await fetch(s.url + '/api/me')).status, 401);
});

test('logout borra esta sesión y cierra su socket; logout-all, todas', async () => {
  const pc = browser(), mob = browser();
  const me = (await signIn(pc, 'oak@example.com')).body.me;
  await signIn(mob, 'oak@example.com');
  assert.equal(rows('SELECT * FROM sessions WHERE uid = ?', me.uid).length, 2);

  const sock = ioc(s.url, { auth: { v: 1 }, transports: ['websocket'], reconnection: false, forceNew: true, extraHeaders: { cookie: pc.cookie } });
  await new Promise((res, rej) => { sock.once('connect', res); sock.once('connect_error', rej); });
  const closed = new Promise(r => sock.once('disconnect', r));
  const pcCookie = pc.cookie;
  assert.equal((await pc.post('/api/auth/logout')).status, 204);
  assert.equal(await closed, 'io server disconnect');
  assert.equal(pc.cookie, '');
  const again = browser(); again.cookie = pcCookie;
  assert.equal((await again.get('/api/me')).status, 401);
  assert.equal((await mob.get('/api/me')).status, 200);

  // Con la cookie de una sesión borrada, el socket no entra.
  const late = ioc(s.url, { auth: { v: 1 }, transports: ['websocket'], reconnection: false, forceNew: true, extraHeaders: { cookie: pcCookie } });
  const err = await new Promise(r => late.once('connect_error', r));
  assert.equal(err.message, 'signed-out');
  late.close();

  await signIn(pc, 'oak@example.com');
  assert.equal((await mob.post('/api/auth/logout-all')).status, 204);
  assert.equal(rows('SELECT * FROM sessions WHERE uid = ?', me.uid).length, 0);
  assert.equal((await pc.get('/api/me')).status, 401);
  // Sin sesión, logout da 204 igual; logout-all, 401.
  assert.equal((await browser().post('/api/auth/logout')).status, 204);
  assert.equal((await browser().post('/api/auth/logout-all')).status, 401);
});

test('DELETE /api/me: borra la cuenta, la partida y las sesiones', async () => {
  const b = browser();
  const me = (await signIn(b, 'borrar@example.com')).body.me;
  s.srv.store.prep('INSERT INTO saves (uid, rev, body, updated) VALUES (?, 1, ?, 1)').run(me.uid, '{}');
  assert.equal((await b.del('/api/me')).status, 204);
  assert.equal(rows('SELECT * FROM users WHERE uid = ?', me.uid).length, 0);
  assert.equal(rows('SELECT * FROM saves WHERE uid = ?', me.uid).length, 0);
  assert.equal(rows('SELECT * FROM sessions WHERE uid = ?', me.uid).length, 0);
  assert.equal((await b.get('/api/me')).status, 401);
  // El mismo correo después: una cuenta nueva.
  assert.notEqual((await signIn(browser(), 'borrar@example.com')).body.me.uid, me.uid);
});

test('la sesión se renueva tras 7 días de uso y caduca a los 180 sin usarse', async () => {
  const b = browser();
  await b.post('/api/auth/guest');
  const first = b.cookie;
  NOW += 3 * DAY;
  let r = await b.get('/api/me');
  assert.equal(r.headers.getSetCookie().length, 0);
  NOW += 5 * DAY;
  r = await b.get('/api/me');
  assert.equal(r.status, 200);
  assert.equal(r.headers.getSetCookie().length, 1);
  assert.equal(b.cookie, first);              // el mismo valor, 180 días más
  NOW += 181 * DAY;
  assert.equal((await b.get('/api/me')).status, 401);
});

test('PUT /api/me/name: el mismo VALID que social.js y único sin mayúsculas', async () => {
  const a = browser(), c = browser();
  await a.post('/api/auth/guest');
  await c.post('/api/auth/guest');
  const r = await a.put('/api/me/name', { name: 'Pikachu_25' });
  assert.equal(r.status, 200);
  assert.equal(r.body.me.name, 'Pikachu_25');
  assert.equal((await a.put('/api/me/name', { name: 'Pikachu_25' })).status, 200);   // el suyo otra vez
  const t = await c.put('/api/me/name', { name: 'pikachu_25' });
  assert.equal(t.status, 409);
  assert.equal(t.body.error, 'taken');
  for (const name of ['ab', 'x'.repeat(17), 'con espacio', '<b>', 7]) assert.equal((await c.put('/api/me/name', { name })).body.error, 'invalid');
  // Los nombres por defecto (de otros) no se pueden elegir.
  assert.equal((await c.put('/api/me/name', { name: 'guest0042' })).body.error, 'taken');
  assert.equal((await browser().put('/api/me/name', { name: 'Libre' })).status, 401);
});

test('admin: los correos de ADMIN_EMAILS', async () => {
  const x = await start({ env: { ADMIN_EMAILS: 'Jefa@Example.com' } });
  try {
    assert.equal((await signIn(browser(() => x.url), 'jefa@example.com')).body.me.admin, true);
    assert.equal((await signIn(browser(() => x.url), 'otro@example.com')).body.me.admin, false);
  } finally { await x.srv.close(); }
});

test('120 peticiones por minuto y sesión', async () => {
  const x = await start({ limits: { api: [5, 60000] } });
  try {
    const b = browser(() => x.url);
    await b.post('/api/auth/guest');
    const st = [];
    for (let i = 0; i < 6; i++) st.push((await b.get('/api/me')).status);
    assert.deepEqual(st, [200, 200, 200, 200, 200, 429]);
  } finally { await x.srv.close(); }
});

test('mail: correo en los 7 idiomas, y en consola el código en el registro', async () => {
  assert.deepEqual(LANGS, ['es', 'en', 'fr', 'it', 'pt-BR', 'zh-Hans', 'zh-Hant']);
  for (const l of LANGS) {
    const m = codeMail('123456', l);
    assert.ok(m.subject.includes('123456') && m.text.includes('123456') && m.html.includes('123456'), l);
    assert.ok(m.text.includes('10') && m.html.includes('10'), l);
    assert.ok(!/<img|https?:/.test(m.html), l);
  }
  assert.equal(codeMail('123456', 'en').subject, 'Your PokéSurvivor code: 123456');
  assert.equal(codeMail('123456', 'xx').subject, 'Your PokéSurvivor code: 123456');
  const out = [];
  await createMailer({ mail: 'console' }, { log: x => out.push(x) }).sendCode('a@b.co', '654321', 'es');
  assert.deepEqual(out, ['[mail] to=a@b.co code=654321']);
});

test('maskEmail', () => {
  assert.equal(maskEmail('mederic@gmail.com'), 'm***@gmail.com');
  assert.equal(maskEmail(null), null);
});
