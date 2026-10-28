// Sala con el servidor propio (social-ui.js, ?relay): cómo llega cada jugador,
// los errores del servidor en texto, y pegar un código en cualquier casilla.
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
    I18n: { lang: 'en' }, Relay: { enabled: true }, RoomCode
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
  for (const c of ['not-found', 'full', 'started', 'rate', 'old-version', 'bad-token', 'busy', 'unreachable', 'timeout', 'disabled']) {
    const t = G.SocialUI.relayError(err(c), 'FALLBACK');
    assert.ok(t && t !== 'FALLBACK' && t !== c, c);
    assert.ok(!/[–—]/.test(t), c);
  }
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
