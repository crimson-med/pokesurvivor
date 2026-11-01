// La sala (social-ui.js): cómo llega cada jugador, los errores del servidor en
// texto, pegar un código en cualquier casilla, y que ya no quede «Misma wifi» ni
// «Entrar por IP».
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function fakeEl(id) {
  const ls = {};
  const el = {
    id, ls, dataset: {}, children: [], textContent: '', innerHTML: '', value: '', onclick: null, onsubmit: null, style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(t, fn) { (ls[t] = ls[t] || []).push(fn); },
    appendChild(c) { el.children.push(c); }, setAttribute() {}, focus() { el.focused = true; },
    querySelectorAll: () => [], querySelector: () => null
  };
  return el;
}

// Un G.RoomCode de mentira: cuatro números de Pokédex <-> nombres.
const NAMES = { 25: 'Pikachu', 95: 'Onix', 151: 'Mew', 133: 'Eevee' };
const RoomCode = {
  parseCode(t) {
    const ids = String(t).toLowerCase().split(/[\s,-]+/).filter(Boolean)
      .map(w => +Object.keys(NAMES).find(k => NAMES[k].toLowerCase() === w));
    return ids.length === 4 && ids.every(Boolean) ? ids : null;
  },
  codeNames: code => code.map(d => NAMES[d]),
  format: code => code.map(d => NAMES[d].toLowerCase()).join('-'),
  suggest: () => []
};

function load(extra = {}) {
  const els = {}, $ = id => (els[id] = els[id] || fakeEl(id));
  const inputs = [0, 1, 2, 3].map(i => fakeEl('code-in-' + i));
  $('code-join').querySelectorAll = sel => sel === '.code-inputs input' ? inputs : [];
  const G = Object.assign({
    UI: { $, show() {}, hide() {}, isOpen: () => true, toast() {} }, U: { esc: s => String(s) },
    Audio: { sfx() {} }, Social: { on() {}, room: null, MAX_PLAYERS: 4 }, Net: { mode: () => 'connecting' },
    I18n: { lang: 'en' }, RoomCode
  }, extra);
  const document = { createElement: () => fakeEl(), querySelectorAll: () => [] };
  new Function('G', 'document', 'window', 'navigator', 'setTimeout', source('js/ui/social-ui.js'))(G, document, {}, {}, () => 0);
  return { G, $, inputs };
}

test('path badges: Same Wi-Fi, Direct, Server, Connecting, Reconnecting', () => {
  const { G } = load();
  const badge = (m, room = { isHost: false }) => G.SocialUI.pathBadge(Object.assign({ uid: 'u' }, m), room);
  assert.deepEqual(badge({ path: 'direct', sameNet: true }), { kind: 'lan', text: 'Misma wifi' });
  assert.deepEqual(badge({ path: 'direct', sameNet: false }), { kind: 'direct', text: 'Directo' });
  assert.deepEqual(badge({ path: 'server', sameNet: true }), { kind: 'server', text: 'Servidor' });
  assert.deepEqual(badge({ path: 'relay' }), { kind: 'server', text: 'Servidor' });
  assert.deepEqual(badge({ path: null }), { kind: 'wait', text: 'Conectando…' });
  assert.deepEqual(badge({ path: 'direct', online: false }), { kind: 'away', text: 'Reconectando…' });
  // El anfitrión ya sabe por su conexión que va directo, antes de que lo diga el servidor.
  G.Net.mode = () => 'direct';
  assert.equal(badge({ path: null }, { isHost: true }).kind, 'direct');
  assert.equal(badge({ path: null }, { isHost: false }).kind, 'wait');
});

test('server errors map to a text for every code', () => {
  const { G } = load();
  const err = code => Object.assign(new Error(code), { code });
  for (const c of ['not-found', 'full', 'started', 'rate', 'old-version', 'signed-out', 'banned', 'busy', 'unreachable', 'timeout']) {
    const t = G.SocialUI.relayError(err(c), 'FALLBACK');
    assert.ok(t && t !== 'FALLBACK' && t !== c, c);
    assert.ok(!/[–—]/.test(t), c);
  }
  assert.equal(G.SocialUI.relayError(err('signed-out'), 'X'), 'Vuelve a iniciar sesión para jugar en grupo.');
  assert.equal(G.SocialUI.relayError(err('banned'), 'X'), 'Esta cuenta no puede jugar en grupo.');
  // Ya no existen: sin cuenta es signed-out, y el token de Firebase se fue.
  for (const c of ['bad-token', 'disabled']) assert.equal(G.SocialUI.relayError(err(c), 'X'), 'X', c);
  assert.equal(G.SocialUI.relayError({ ok: false, err: 'full' }, 'X'), 'Esta sala está llena (4 jugadores).');
  assert.equal(G.SocialUI.relayError(new Error('xhr poll error'), 'X'), 'X');
  // Como responde social.js: { ok: false, code, error } (el código manda sobre el texto en bruto).
  assert.equal(G.SocialUI.relayError({ ok: false, code: 'rate', error: 'rate limited' }, 'X'), 'Demasiados intentos. Espera un minuto y vuelve a probar.');
  assert.equal(G.SocialUI.relayError({ ok: false, error: 'Esa sala ya no existe.' }, 'X'), 'Esa sala ya no existe.');
  assert.equal(G.SocialUI.relayError({ code: 'constructor' }, 'X'), 'X');
});

test('pasting a whole code in any box fills all four', () => {
  const { G, inputs } = load();
  G.FriendsUI.init();
  let prevented = false;
  inputs[2].ls.paste[0]({ clipboardData: { getData: () => 'pikachu-onix-mew-eevee' }, preventDefault() { prevented = true; } });
  assert.ok(prevented);
  assert.deepEqual(inputs.map(i => i.value), ['Pikachu', 'Onix', 'Mew', 'Eevee']);
  // Un solo nombre se pega como siempre.
  inputs.forEach(i => { i.value = ''; });
  prevented = false;
  inputs[0].ls.paste[0]({ clipboardData: { getData: () => 'Mew' }, preventDefault() { prevented = true; } });
  assert.ok(!prevented);
  // Escrito con espacios en una casilla (o pegado sin aviso en el móvil): también se reparte.
  inputs[1].value = 'eevee mew onix pikachu';
  inputs[1].ls.input[0]({ inputType: 'insertText' });
  assert.deepEqual(inputs.map(i => i.value), ['Eevee', 'Mew', 'Onix', 'Pikachu']);
});

test('without G.RoomCode the paste helper does nothing (no crash)', () => {
  const { G, inputs } = load({ RoomCode: undefined });
  assert.equal(G.SocialUI.fillCode(inputs, 'pikachu-onix-mew-eevee'), false);
  assert.deepEqual(inputs.map(i => i.value), ['', '', '', '']);
});

test('the lobby is always the code lobby: no Same Wi-Fi tab, no join by IP, no lanHint banners', () => {
  const html = source('dev.html'), ui = source('js/ui/social-ui.js'), social = source('js/net/social.js');
  for (const id of ['fr-tabs', 'fr-lan', 'lan-host', 'lan-join', 'lan-join-ip', 'lan-found', 'lan-msg', 'lobby-lan']) {
    assert.ok(!html.includes('id="' + id + '"'), id);
    assert.ok(!ui.includes("'" + id + "'"), id);
  }
  assert.ok(!html.includes('Entrar por IP') && !html.includes('Crear sala local'));
  for (const f of ['lanHint', 'renderHint', 'findLocal', 'G.Relay.enabled', 'relayOn', 'viaTurn']) assert.ok(!ui.includes(f), f);
  for (const f of ['findLocal', 'lanKey', 'rtdb', 'rooms/']) assert.ok(!social.includes(f), f);
  assert.ok(html.includes('id="fr-code"') && html.includes('id="lobby-hint"'), 'code screens and "Connect locally" stay');
  // (social.js aún tiene los amigos de Firestore hasta el paso 6: sólo sin salas en él.)
  for (const f of ['js/net/net.js', 'js/net/relay.js', 'js/net/coop.js']) assert.ok(!/rooms\/|firebase|TURN/.test(source(f)), f);
});

test('the strings of the removed screens are gone in every language, and the new ones are there', () => {
  const en = source('js/data/lang-en.js'), up = source('js/data/lang-updates.js');
  for (const k of ['Entrar por IP', 'Crear sala local', 'Buscar sala', 'Tus amigos en la misma wifi entran con',
    'Para jugar en grupo necesitas una cuenta.', 'No se pudo comprobar tu red. Revisa la conexión y prueba otra vez.']) {
    assert.ok(!en.includes(JSON.stringify(k) + ':'), k);
    assert.ok(!up.includes('[' + JSON.stringify(k) + ','), k);
  }
  assert.ok(en.includes('"Esta cuenta no puede jugar en grupo.":'));
  assert.ok(up.includes('["Esta cuenta no puede jugar en grupo.",'));
});
