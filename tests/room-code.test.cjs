/* Códigos de sala: la lista de Pokémon (js/data/room-words.js) y G.RoomCode (js/net/room-code.js). */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const words = require('../tools/make_room_words.js');
const { ROOM_DEX, ROOM_NAMES } = require('../js/data/room-words.js');

/** El juego en un idioma, con la lista y los códigos cargados. */
const games = {};
function game(lang) {
  if (games[lang]) return games[lang];
  const b = words.boot(lang);
  b.load('js/data/room-words.js');
  b.load('js/net/room-code.js');
  // Lo que devuelve el juego viene de otro contexto (vm): se copia para compararlo.
  const plain = x => x === null || x === undefined ? x : JSON.parse(JSON.stringify(x));
  const R = Object.fromEntries(Object.entries(b.G.RoomCode).map(([k, f]) => [k, (...a) => plain(f(...a))]));
  return (games[lang] = { RoomCode: R, ROOM_DEX: plain(b.G.ROOM_DEX) });
}
const names = words.names();
const strip = s => s.normalize('NFD').replace(/\p{M}/gu, '');
// Códigos repartidos por toda la lista (principio, medio y final).
const step = Math.floor(ROOM_DEX.length / 13);
const codes = Array.from({ length: 12 }, (_, i) => [0, 1, 2, 3].map(k => ROOM_DEX[(i * step + k * 7 + i) % ROOM_DEX.length]));
codes.push([ROOM_DEX[0], ROOM_DEX[0], ROOM_DEX.at(-1), ROOM_DEX.at(-1)]);

test('room-words: lista sin repetidos, en la Pokédex, al día y en Node y en el juego', () => {
  assert.ok(Object.isFrozen(ROOM_DEX));
  assert.ok(ROOM_DEX.length >= 700, 'unos 800 Pokémon: ' + ROOM_DEX.length);
  assert.equal(new Set(ROOM_DEX).size, ROOM_DEX.length);
  for (const d of ROOM_DEX) assert.ok(names[d], '#' + d + ' en la Pokédex');
  // Volver a generarla da lo mismo (no falta nada por añadir ni ha dejado de valer nada).
  assert.deepEqual(words.pick(names, ROOM_DEX), [...ROOM_DEX]);
  // Los nombres guardados son los de los diccionarios (si no, node tools/make_room_words.js).
  assert.deepEqual(JSON.parse(JSON.stringify(ROOM_NAMES)), words.localNames(names, ROOM_DEX));
  assert.deepEqual(game('es').ROOM_DEX, [...ROOM_DEX]);
});

test('room-words: cada nombre es válido y distinto en cada idioma', () => {
  const seen = new Map();
  for (const d of ROOM_DEX) {
    assert.equal(words.norm(names[d].es), words.norm(names[d].en), `#${d}: español = inglés`);
    for (const l of words.LANGS) {
      const n = names[d][l];
      assert.ok(words.valid(n, l), `#${d} en ${l}: ${n}`);
      const k = words.norm(n), o = seen.get(k);
      assert.ok(o === undefined || o === d, `${n} (#${d}) y #${o}`);
      seen.set(k, d);
    }
  }
});

test('room-words: sólo se añade al final', () => {
  // Una lista vieja en otro orden se respeta tal cual y lo nuevo va detrás.
  const old = [ROOM_DEX[5], ROOM_DEX[2], ROOM_DEX[9]];
  const next = words.pick(names, old);
  assert.deepEqual(next.slice(0, 3), old);
  assert.equal(next.length, ROOM_DEX.length);
  // Si uno de la lista dejara de valer, falla en vez de quitarlo.
  const bad = Object.keys(names).map(Number).find(d => !ROOM_DEX.includes(d));
  assert.throws(() => words.pick(names, [...ROOM_DEX, bad]), /dejaría de valer/);
  assert.throws(() => words.pick(names, [ROOM_DEX[0], ROOM_DEX[0]]), /repetido/);
});

for (const lang of words.LANGS) {
  test(`${lang}: nombres, formato y vuelta (${lang})`, () => {
    const R = game(lang).RoomCode;
    for (const code of codes) {
      const shown = R.codeNames(code);
      assert.deepEqual(shown, code.map(d => names[d][lang]));
      assert.equal(R.format(code), shown.join(' '));
      assert.deepEqual(R.parseCode(R.format(code)), code);
      // Mayúsculas, sin acentos, espacios y separadores de más.
      assert.deepEqual(R.parseCode('  ' + strip(shown.join(' , ')).toUpperCase() + ' '), code);
      assert.deepEqual(R.parseCode(shown.join('-').toLowerCase()), code);
      assert.deepEqual(R.parseCode(shown.join('、')), code);
      // Siempre valen los nombres ingleses y los números.
      assert.deepEqual(R.parseCode(code.map(d => names[d].en).join(' ')), code);
      assert.deepEqual(R.parseCode(code.join(' ')), code);
      assert.deepEqual(R.parseCode(code.slice()), code);
      assert.deepEqual(R.parseCode(code.map(String)), code);
    }
    // Los nombres de cualquier otro idioma, para enseñarlos y para escribirlos.
    for (const other of words.LANGS) {
      for (const code of codes) {
        assert.deepEqual(R.codeNames(code, other), code.map(d => names[d][other]));
        assert.deepEqual(R.parseCode(R.format(code, other)), code, `${other} en ${lang}`);
        assert.deepEqual(R.parseCode(strip(R.format(code, other)).toUpperCase()), code);
      }
    }
    // Un código con nombres de cuatro idiomas distintos.
    const mixed = codes[5].map((d, i) => names[d][words.LANGS[(i * 2) % words.LANGS.length]]);
    assert.deepEqual(R.parseCode(mixed.join(' ')), codes[5]);
    // Cada Pokémon de la lista, solo.
    for (const d of ROOM_DEX) assert.deepEqual(R.parseCode([names[d][lang], d, names[d].en, String(d)].join(' ')), [d, d, d, d]);
  });
}

test('parseCode: nombres conocidos con acentos y en chino sin separar', () => {
  const fr = game('fr').RoomCode, zh = game('zh-Hans').RoomCode, hant = game('zh-Hant').RoomCode;
  assert.deepEqual(fr.parseCode('Pikachu Évoli evoli EVOLI'), [25, 133, 133, 133]);
  assert.deepEqual(fr.parseCode('bulbizarre bulbasaur Pikachu pikachu'), [1, 1, 25, 25]);
  assert.deepEqual(game('es').RoomCode.parseCode('PIKACHU, eevee; Bulbasaur / pikachu'), [25, 133, 1, 25]);
  assert.deepEqual(zh.parseCode('皮卡丘 伊布 妙蛙种子 皮卡丘'), [25, 133, 1, 25]);
  assert.deepEqual(zh.parseCode('皮卡丘伊布妙蛙种子皮卡丘'), [25, 133, 1, 25]);
  assert.deepEqual(zh.parseCode('皮卡丘，pikachu，伊布 25'), [25, 25, 133, 25]);
  assert.deepEqual(hant.parseCode('皮卡丘 伊布 妙蛙種子 皮卡丘'), [25, 133, 1, 25]);
  assert.deepEqual(game('en').RoomCode.parseCode('ｐｉｋａｃｈｕ eevee eevee eevee'), [25, 133, 133, 133]);
  // Un amigo francés lee el código a uno que juega en italiano o en chino.
  assert.deepEqual(game('it').RoomCode.parseCode('Bulbizarre Évoli Pikachu Onix'), [1, 133, 25, 95]);
  assert.deepEqual(zh.parseCode('bulbizarre evoli 皮卡丘 onix'), [1, 133, 25, 95]);
  assert.deepEqual(game('es').RoomCode.parseCode('妙蛙種子 伊布 Pikachu 151'), [1, 133, 25, 151]);
  assert.deepEqual(game('es').RoomCode.codeNames([1, 133, 25, 151], 'fr'), ['Bulbizarre', 'Évoli', 'Pikachu', 'Mew']);
  // Números pegados a los nombres.
  assert.deepEqual(game('en').RoomCode.parseCode('25pikachu 133eevee'), [25, 25, 133, 133]);
  assert.deepEqual(zh.parseCode('皮卡丘25伊布133'), [25, 25, 133, 133]);
});

test('parseCode: lo que no es un código da null', () => {
  const R = game('en').RoomCode, code = codes[3], shown = R.codeNames(code);
  const notInList = Object.keys(names).map(Number).find(d => !ROOM_DEX.includes(d));
  for (const bad of [
    '', '   ', shown.slice(0, 3).join(' '), [...shown, shown[0]].join(' '), shown.slice(0, 3).join(' ') + ' Agumon',
    `${code[0]} ${code[1]} ${code[2]} ${notInList}`, '1 2 3 99999', '0 1 2 3', '1.5 2 3 4',
    code.slice(0, 3), [...code, code[0]], [code[0], code[1], code[2], notInList], [1.5, 1, 1, 1], [1, 1, 1, null],
    null, undefined, 25, {}, code.join('')
  ]) assert.equal(R.parseCode(bad), null, JSON.stringify(bad));
});

test('suggest: hasta 5, por el principio, en el idioma pedido', () => {
  const en = game('en').RoomCode, fr = game('fr').RoomCode, zh = game('zh-Hans').RoomCode;
  assert.deepEqual(en.suggest('pika')[0], { dex: 25, name: 'Pikachu' });
  assert.deepEqual(en.suggest('PIKACHU'), [{ dex: 25, name: 'Pikachu' }]);
  assert.deepEqual(en.suggest(''), []);
  assert.deepEqual(en.suggest('pikachu '), []);
  assert.deepEqual(en.suggest('zzzz'), []);
  const many = en.suggest('a');
  assert.equal(many.length, 5);
  for (const s of many) assert.ok(words.norm(s.name).startsWith('a') && ROOM_DEX.includes(s.dex));
  // Lo último que se ha escrito.
  assert.deepEqual(en.suggest('Onix Mew pika')[0], { dex: 25, name: 'Pikachu' });
  // Francés: con o sin acento, y por el nombre inglés sale el francés.
  assert.ok(fr.suggest('evo').some(s => s.dex === 133 && s.name === 'Évoli'));
  assert.ok(fr.suggest('ÉVO').some(s => s.dex === 133));
  assert.deepEqual(fr.suggest('bulbasaur'), [{ dex: 1, name: 'Bulbizarre' }]);
  assert.ok(zh.suggest('皮').some(s => s.dex === 25 && s.name === '皮卡丘'));
  // Sin separar: sugiere lo que va detrás de los nombres ya completos.
  assert.ok(zh.suggest('皮卡丘伊').some(s => s.dex === 133 && s.name === '伊布'));
  assert.deepEqual(en.suggest('pikachuonix'), [{ dex: 95, name: 'Onix' }]);
  assert.deepEqual(en.suggest('25'), []);
  // Otro idioma: el nombre sale en ese idioma.
  assert.deepEqual(en.suggest('bulbizarre', 'fr'), [{ dex: 1, name: 'Bulbizarre' }]);
  assert.deepEqual(zh.suggest('pikachu', 'en'), [{ dex: 25, name: 'Pikachu' }]);
});
