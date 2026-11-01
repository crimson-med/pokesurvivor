// js/ui/login.js con un DOM y un G.DB falsos: correo, código de 6 cifras,
// errores, reenviar a los 30 s, invitado, "añadir un correo" y la oferta de
// añadir las partidas de antes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'js/ui/login.js'), 'utf8');

function el(id) {
  const cls = new Set();
  const e = {
    id, value: '', textContent: '', disabled: false, focused: 0, dataset: {},
    classList: {
      add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c),
      toggle: (c, on) => { if (on === undefined ? !cls.has(c) : on) cls.add(c); else cls.delete(c); }
    },
    get hidden() { return cls.has('hidden'); },
    focus() { e.focused++; env.focus = e; }, select() {},
    requestSubmit() { return e.onsubmit && e.onsubmit({ preventDefault() {} }); }
  };
  return e;
}
let env;

function load(db) {
  const nodes = {}, timers = [];
  const $ = id => (nodes[id] ||= el(id));
  const otp = Array.from({ length: 6 }, (_, i) => el('otp' + i));
  const tabs = ['login', 'register'].map(t => Object.assign(el('tab-' + t), { dataset: { tab: t } }));
  for (const id of ['login-code', 'login-local']) $(id).classList.add('hidden');
  $('btn-login-back').classList.add('hidden');
  const flow = { after: 0, menu: 0 };
  const toasts = [];
  let clock = 0;
  const ctx = {
    G: {
      UI: { $, chrome() {}, show() {}, toast: t => toasts.push(t), refreshCoins() {} },
      DB: db, I18n: { lang: 'es', has: () => false, f: (s, ...v) => { let i = 0; return s.replace(/\{x\}/g, () => v[i++]); } }, T: s => s,
      siteHost: () => 'play.example.com',
      Flow: { afterLogin: () => flow.after++, goMenu: () => flow.menu++ }
    },
    document: { querySelectorAll: s => (s === '#otp input' ? otp : s === '#login-local .tab' ? tabs : []) },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {},
    Date: { now: () => clock },
    localStorage: { getItem: () => null, setItem() {} }
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  env = { L: ctx.G.LoginUI, $, otp, flow, toasts, timers, tick: ms => { clock += ms; } };
  env.L.init();
  return env;
}

const settle = () => new Promise(r => setImmediate(r));
const submit = async form => { await form.onsubmit({ preventDefault() {} }); await settle(); };

function fakeDB(o = {}) {
  const db = {
    mode: 'cloud', storageOk: true, localReason: '', guest: false, save: { stats: {} },
    calls: [],
    async sendCode(e) { db.calls.push(['send', e]); return o.send ? o.send(e) : { ok: true }; },
    async verifyCode(e, c) { db.calls.push(['verify', e, c]); return o.verify ? o.verify(e, c) : { ok: true, isNew: false, merged: false }; },
    async playAsGuest() { db.calls.push(['guest']); return { ok: true, isNew: true }; }
  };
  return db;
}

test('correo, luego el código en 6 casillas: pegarlo las llena y entra solo', async () => {
  const db = fakeDB();
  const { L, $, otp, flow } = load(db);
  L.open();
  assert.equal($('login-email').hidden, false);
  assert.equal($('login-code').hidden, true);
  assert.equal($('login-local').hidden, true);
  assert.equal($('btn-guest').hidden, false);
  // La web oficial es la de SITE_URL (G.siteHost), no la del juego original.
  assert.equal($('login-official').textContent, 'Web oficial: play.example.com · si alguien te pide pagar, no somos nosotros');
  $('f-email').value = 'no-es-correo';
  await submit($('login-email'));
  assert.equal($('login-err').textContent, 'Escribe un correo válido.');
  assert.equal(db.calls.length, 0);
  $('f-email').value = ' Ash@Example.com ';
  await submit($('login-email'));
  assert.deepEqual(db.calls[0], ['send', 'ash@example.com']);
  assert.equal($('login-email').hidden, true);
  assert.equal($('login-code').hidden, false);
  assert.equal($('code-email').textContent, 'ash@example.com');
  // Pegar "123 456" en la primera casilla.
  let prevented = false;
  otp[0].onpaste({ clipboardData: { getData: () => '123 456' }, preventDefault() { prevented = true; } });
  assert.ok(prevented);
  assert.deepEqual(otp.map(b => b.value), ['1', '2', '3', '4', '5', '6']);
  await settle();
  assert.deepEqual(db.calls[1], ['verify', 'ash@example.com', '123456']);
  assert.equal(flow.after, 1);
});

test('escribir cifra a cifra pasa a la siguiente; el autocompletado del móvil (6 de golpe) también vale', async () => {
  const db = fakeDB();
  const { L, $, otp, flow } = load(db);
  L.open();
  $('f-email').value = 'a@b.co';
  await submit($('login-email'));
  for (const [i, d] of ['9', '8', '7'].entries()) { otp[i].value = d; otp[i].oninput(); }
  assert.equal(env.focus, otp[3]);
  otp[3].value = 'x'; otp[3].oninput();
  assert.equal(otp[3].value, '');                 // sólo cifras
  // Borrar en una vacía vuelve a la anterior.
  otp[3].onkeydown({ key: 'Backspace', preventDefault() {} });
  assert.equal(otp[2].value, '');
  assert.equal(env.focus, otp[2]);
  otp[0].value = '654321'; otp[0].oninput();       // one-time-code del móvil
  await settle();
  assert.deepEqual(db.calls.at(-1), ['verify', 'a@b.co', '654321']);
  assert.equal(flow.after, 1);
});

test('errores del servidor en su texto; código incorrecto vacía las casillas', async () => {
  let answer = { ok: false, code: 'bad-code' };
  const db = fakeDB({ verify: () => answer, send: e => (e === 'r@b.co' ? { ok: false, code: 'rate' } : { ok: true }) });
  const { L, $, otp, flow } = load(db);
  L.open();
  $('f-email').value = 'r@b.co';
  await submit($('login-email'));
  assert.equal($('login-err').textContent, 'Demasiados intentos seguidos. Espera un poco.');
  assert.equal($('login-code').hidden, true);
  $('f-email').value = 'a@b.co';
  await submit($('login-email'));
  await submit($('login-code'));
  assert.equal($('login-err').textContent, 'Escribe las 6 cifras del código.');
  otp.forEach(b => { b.value = '1'; });
  await submit($('login-code'));
  assert.equal($('login-err').textContent, 'Ese código no es correcto. Revísalo y vuelve a probar.');
  assert.deepEqual(otp.map(b => b.value), ['', '', '', '', '', '']);
  for (const [code, text] of [['expired', 'El código ha caducado. Pide otro.'], ['too-many', 'Demasiados intentos con este código. Pide otro.'],
    ['offline', 'Sin conexión a internet.'], ['mail', 'No se pudo mandar el correo. Vuelve a probar en un minuto.'], ['raro', 'Algo ha fallado. Vuelve a probar en un momento.']]) {
    answer = { ok: false, code };
    otp.forEach(b => { b.value = '2'; });
    await submit($('login-code'));
    assert.equal($('login-err').textContent, text, code);
  }
  assert.equal($('btn-resend').disabled, false);    // caducado o quemado: pedir otro ya
  answer = { ok: true, merged: true };
  otp.forEach(b => { b.value = '3'; });
  await submit($('login-code'));
  assert.deepEqual(env.toasts, ['Tu progreso de invitado se ha añadido a esta cuenta.']);
  assert.equal(flow.after, 1);
});

test('"Reenviar código" a los 30 s, y "Usar otro correo" vuelve al primer paso', async () => {
  const db = fakeDB();
  const { L, $, timers } = load(db);
  L.open();
  $('f-email').value = 'a@b.co';
  await submit($('login-email'));
  assert.equal($('btn-resend').disabled, true);
  assert.equal($('btn-resend').textContent, 'Reenviar código (30 s)');
  await $('btn-resend').onclick();
  assert.equal(db.calls.filter(c => c[0] === 'send').length, 1);
  env.tick(30000);
  timers.filter(t => t.ms === 1000).at(-1).fn();
  assert.equal($('btn-resend').disabled, false);
  assert.equal($('btn-resend').textContent, 'Reenviar código');
  await $('btn-resend').onclick();
  assert.equal(db.calls.filter(c => c[0] === 'send').length, 2);
  assert.deepEqual(env.toasts, ['Te hemos mandado otro código.']);
  $('btn-other').onclick();
  assert.equal($('login-email').hidden, false);
  assert.equal($('login-code').hidden, true);
});

test('invitado; "añadir un correo" sin invitado y con Volver; modo local con nombre y contraseña', async () => {
  const db = fakeDB();
  const { L, $, flow } = load(db);
  L.open();
  await $('btn-guest').onclick();
  assert.deepEqual(db.calls, [['guest']]);
  assert.equal(flow.after, 1);
  L.open({ add: true });
  assert.equal($('btn-guest').hidden, true);
  assert.equal($('btn-login-back').hidden, false);
  $('btn-login-back').onclick();
  assert.equal(flow.menu, 1);
  db.mode = 'local';
  L.open();
  assert.equal($('login-local').hidden, false);
  assert.equal($('login-email').hidden, true);
  assert.equal($('btn-guest').hidden, false);
});

test('partidas de antes: la oferta sale una vez antes que los avisos; sí las añade, no se acuerda', async () => {
  for (const yes of [true, false]) {
    const db = fakeDB();
    let asked = true;
    Object.defineProperty(db, 'importable', { get: () => asked });
    db.importOld = async () => { db.calls.push(['import']); asked = false; return { ok: true, n: 1 }; };
    db.declineImport = () => { db.calls.push(['no']); asked = false; };
    const { L, $, toasts } = load(db);
    assert.equal(L.updateNotices(), true);
    assert.equal($('scr-savenote').hidden, false);
    assert.equal($('savenote-title').textContent, 'Progreso de antes en este navegador');
    assert.equal($('savenote-ok').textContent, 'Añadir a esta cuenta');
    assert.equal($('savenote-no').hidden, false);
    if (yes) await $('savenote-ok').onclick(); else $('savenote-no').onclick();
    assert.deepEqual(db.calls, [[yes ? 'import' : 'no']]);
    assert.deepEqual(toasts, yes ? ['Progreso de antes añadido a esta cuenta.'] : []);
    // Detrás, los avisos de siempre (con su único botón); la oferta ya no vuelve.
    assert.equal($('savenote-no').hidden, true);
    assert.equal($('savenote-title').textContent, 'Importante: guarda tu partida');
    assert.equal(L.updateNotices(), true);
    assert.notEqual($('savenote-title').textContent, 'Progreso de antes en este navegador');
    assert.equal(db.calls.length, 1);
  }
});
