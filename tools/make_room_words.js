/* ============ make_room_words.js: Pokémon que valen para los códigos de sala ============
 *   node tools/make_room_words.js
 *
 * Escribe js/data/room-words.js: los números de la Pokédex que pueden salir en un
 * código de sala (cuatro Pokémon, el orden cuenta), que usan el juego y el servidor,
 * y sus nombres en los idiomas en que no son el español (para entender un código
 * escrito en cualquier idioma, aunque el jugador sólo descargue el suyo).
 *
 * Un Pokémon entra si su nombre, en cada idioma del juego, se escribe fácil:
 *   - 3 a 10 letras sin acentos, sin espacios, puntos, apóstrofos, guiones ni ♀♂
 *     (en chino, de 1 a 5 caracteres chinos),
 *   - el nombre español es el inglés (así se entiende en cualquier idioma),
 *   - en cada idioma, no se parece a uno ya elegido: mismas 5 primeras letras o
 *     una sola letra de diferencia (se queda el primero). En chino sólo cuenta
 *     sobrar o faltar un carácter (拉达 / 小拉达): cambiar uno ya se ve distinto,
 *   - ningún nombre, en ningún idioma, es el de otro Pokémon de la lista.
 * Los nombres salen como en pantalla: G.I18n.t() con el diccionario de cada idioma.
 *
 * Sólo se añade al final: los que ya están no se mueven ni se quitan (los códigos
 * guardan números). Si alguno dejara de valer, el script falla y no escribe nada.
 * Los nombres sí se reescriben cada vez: si cambia una traducción, se vuelve a lanzar.
 */
const fs = require('fs'), path = require('path'), vm = require('vm');
const langs = require('./build_langs.js');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'js', 'data', 'room-words.js');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** Idiomas del juego, los de locales.js (uno nuevo se comprueba solo). */
const LANGS = (() => {
  const sb = { localStorage: { getItem: () => null }, navigator: {}, location: { pathname: '/' }, document: { documentElement: {} } };
  sb.window = sb;
  vm.runInNewContext(read('js/core/locales.js'), sb, { filename: 'js/core/locales.js' });
  return sb.PS_LOCALES.choices.map(([id]) => id);
})();

/** El juego en un idioma, como en el navegador: locales.js, su diccionario, i18n.js, lang-en.js y la Pokédex. */
function boot(lang) {
  const queue = langs.capture(langs.SOURCES, '?').filter(([, l]) => l === lang);
  const noop = () => {};
  const ctx = {
    G: {}, console, navigator: { language: lang, languages: [lang] }, location: { pathname: '/' },
    localStorage: { getItem: () => lang, setItem: noop },
    document: { documentElement: {}, write: noop }, CanvasRenderingContext2D: function () {},
    confirm: () => true, alert: noop, PS_LANG_Q: queue
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  const load = f => vm.runInContext(read(f), ctx, { filename: f });
  for (const f of ['js/core/locales.js', 'js/core/i18n.js', 'js/data/lang-en.js', 'js/data/pokedex.js']) load(f);
  if (ctx.G.I18n.lang !== lang) throw new Error('make_room_words: el juego no arranca en ' + lang);
  return { ctx, G: ctx.G, load };
}

const isZh = lang => lang.startsWith('zh-');
/** Como lo compara el juego: sin acentos ni mayúsculas. */
const norm = s => String(s).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const valid = (name, lang) => isZh(lang) ? /^\p{Script=Han}{1,5}$/u.test(name) : /^[a-z]{3,10}$/.test(norm(name));

/** ¿Una sola letra de diferencia? (cambiar, quitar o poner una) */
function oneApart(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length > b.length) [a, b] = [b, a];
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return a.length === b.length ? a.slice(i + 1) === b.slice(i + 1) : a.slice(i) === b.slice(i + 1);
}
/** ¿Se confunden dos nombres (ya normalizados) de un idioma? */
function close(a, b, lang) {
  if (isZh(lang)) return a === b || (Math.abs(a.length - b.length) === 1 && oneApart(a, b));
  return (a.length >= 5 && b.length >= 5 && a.slice(0, 5) === b.slice(0, 5)) || oneApart(a, b);
}

/** Nombres de cada Pokémon en cada idioma, como en pantalla: { dex: { lang: nombre } } */
function names() {
  const out = {};
  for (const lang of LANGS) {
    const { G } = boot(lang);
    for (const p of G.DEX) (out[p.dex] = out[p.dex] || { _es: p.name })[lang] = G.I18n.t(p.name);
  }
  return out;
}

/** Elige la lista: primero las que ya hay (deben seguir valiendo), luego las nuevas en orden de Pokédex. */
function pick(all, previous = []) {
  const kept = [], tokens = new Map(), perLang = Object.fromEntries(LANGS.map(l => [l, []]));
  const reason = dex => {
    const n = all[dex];
    if (!n) return 'no está en la Pokédex';
    for (const l of LANGS) if (!valid(n[l], l)) return `nombre no válido en ${l} (${n[l]})`;
    if (norm(n.es) !== norm(n.en)) return `el nombre español no es el inglés (${n.es} / ${n.en})`;
    for (const l of LANGS) {
      const a = norm(n[l]), b = perLang[l].find(o => close(a, o.name, l));
      if (b) return `en ${l}, ${n[l]} se parece a ${all[b.dex][l]}`;
    }
    for (const l of LANGS) {
      const o = tokens.get(norm(n[l]));
      if (o !== undefined && o !== dex) return `${n[l]} ya es el nombre de #${o}`;
    }
    return '';
  };
  const take = dex => {
    kept.push(dex);
    for (const l of LANGS) { perLang[l].push({ dex, name: norm(all[dex][l]) }); tokens.set(norm(all[dex][l]), dex); }
  };
  for (const dex of previous) {
    const why = kept.includes(dex) ? 'repetido' : reason(dex);
    if (why) throw new Error(`make_room_words: #${dex} ya está en la lista y dejaría de valer: ${why}`);
    take(dex);
  }
  const rest = Object.keys(all).map(Number).filter(d => !previous.includes(d)).sort((a, b) => a - b);
  for (const dex of rest) if (!reason(dex)) take(dex);
  return kept;
}

/** La lista que ya está escrita (vacía si aún no hay archivo). */
function current() {
  if (!fs.existsSync(OUT)) return [];
  const sb = { module: { exports: {} } };
  vm.runInNewContext(fs.readFileSync(OUT, 'utf8'), sb, { filename: OUT });
  return [...sb.module.exports.ROOM_DEX];
}

/** { idioma: { dex: nombre } } con los nombres que no son el español. */
function localNames(all, list) {
  const out = {};
  for (const l of LANGS.filter(x => x !== 'es')) {
    const d = {};
    for (const dex of list) if (all[dex][l] !== all[dex].es) d[dex] = all[dex][l];
    if (Object.keys(d).length) out[l] = d;
  }
  return out;
}

function render(list, local) {
  const rows = [];
  for (let i = 0; i < list.length; i += 16) rows.push('    ' + list.slice(i, i + 16).join(', '));
  const langRows = Object.entries(local).map(([l, d]) => {
    const items = Object.entries(d).map(([dex, n]) => `${dex}: ${JSON.stringify(n)}`), lines = [];
    for (let i = 0; i < items.length; i += 10) lines.push('      ' + items.slice(i, i + 10).join(', '));
    return `    ${JSON.stringify(l)}: Object.freeze({\n${lines.join(',\n')}\n    })`;
  });
  return `/* ============ room-words.js: Pokémon de los códigos de sala ============
 * GENERADO por tools/make_room_words.js: no editar a mano.
 * Un código de sala son 4 de estos números de la Pokédex (el orden cuenta), y en
 * pantalla salen sus nombres en el idioma del jugador (js/net/room-code.js).
 * Sólo se añade al final: el servidor (relay/) usa la misma lista.
 * ROOM_NAMES: sus nombres en cada idioma, sólo donde no son el de G.DEX.
 */
(function () {
  const ROOM_DEX = Object.freeze([
${rows.join(',\n')}
  ]);
  const ROOM_NAMES = Object.freeze({
${langRows.join(',\n')}
  });
  if (typeof G !== 'undefined') { G.ROOM_DEX = ROOM_DEX; G.ROOM_NAMES = ROOM_NAMES; }
  if (typeof module !== 'undefined' && module.exports) module.exports = { ROOM_DEX, ROOM_NAMES };
})();
`;
}

module.exports = { LANGS, boot, norm, valid, close, names, pick, localNames, OUT };

if (require.main === module) {
  const before = current(), all = names();
  const list = pick(all, before);
  fs.writeFileSync(OUT, render(list, localNames(all, list)));
  console.log(`ok: ${list.length} Pokémon en js/data/room-words.js (${list.length - before.length} nuevos)`);
}
