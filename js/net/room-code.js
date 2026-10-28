/* ============ room-code.js: códigos de sala de cuatro Pokémon ============
 * Un código son 4 números de la Pokédex de G.ROOM_DEX (js/data/room-words.js),
 * el orden cuenta. En pantalla salen los nombres en el idioma del jugador. Al
 * escribirlo vale cualquier idioma del juego (los nombres están en G.ROOM_NAMES y
 * tools/make_room_words.js comprueba que no se repiten), sin mirar mayúsculas,
 * acentos ni espacios, o directamente los 4 números.
 *   codeNames(code, lang)  -> ['Pikachu', 'Onix', 'Mew', 'Évoli']
 *   format(code, lang)     -> 'Pikachu Onix Mew Évoli'
 *   parseCode(texto)       -> [25, 95, 151, 133] o null
 *   suggest(prefijo, lang) -> hasta 5 { dex, name } para autocompletar
 */
G.RoomCode = (() => {
  const MAX_SUGGEST = 5, MAX_LEN = 10;
  const curLang = () => (G.I18n && G.I18n.lang) || 'en';
  /** Como se comparan: sin acentos ni mayúsculas, letras anchas a normales. */
  const norm = s => String(s).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  /** Palabras de un texto: lo que no es letra ni número separa, y los números van aparte. */
  const words = s => norm(s).split(/[^\p{L}\p{N}]+/u).flatMap(w => w.match(/\p{N}+|[^\p{N}]+/gu) || []);
  let allowed = null, index = null;
  const lists = new Map();

  const dexSet = () => allowed || (allowed = new Set(G.ROOM_DEX || []));

  /** Nombre de un Pokémon en un idioma: el de pantalla si es el del juego. */
  function nameOf(dex, lang = curLang()) {
    const p = G.DEX_BY && G.DEX_BY[dex];
    if (!p) return String(dex);
    if (G.I18n && lang === G.I18n.lang) return G.I18n.t(p.name);
    const local = G.ROOM_NAMES && G.ROOM_NAMES[lang];
    return (local && local[dex]) || p.name;
  }

  /** Nombre normalizado -> número, con los nombres de todos los idiomas. */
  function lookup() {
    if (index) return index;
    index = new Map();
    const langs = [curLang(), 'en', ...Object.keys(G.ROOM_NAMES || {})];
    for (const dex of G.ROOM_DEX || []) {
      for (const l of langs) {
        const k = norm(nameOf(dex, l));
        if (k && !index.has(k)) index.set(k, dex);
      }
    }
    return index;
  }

  function toDex(x) {
    if (typeof x === 'number') return Number.isInteger(x) && dexSet().has(x) ? x : null;
    if (typeof x !== 'string') return null;
    const k = norm(x).trim();
    if (/^\d+$/.test(k)) return toDex(Number(k));
    const d = lookup().get(k);
    return d === undefined ? null : d;
  }

  /** Un trozo sin separadores (皮卡丘伊布...): sólo si se parte en nombres de una única forma. */
  function split(word) {
    const map = lookup(), n = word.length;
    // ways[i]: formas de partir word.slice(i) (0, 1 o 2 = más de una); next[i]: dónde acaba el primer nombre.
    const ways = new Array(n + 1).fill(0), next = new Array(n + 1);
    ways[n] = 1;
    for (let i = n - 1; i >= 0; i--) {
      for (let j = i + 1; j <= Math.min(n, i + MAX_LEN); j++) {
        if (!ways[j] || !map.has(word.slice(i, j))) continue;
        ways[i] = Math.min(2, ways[i] + ways[j]);
        next[i] = j;
      }
    }
    if (ways[0] !== 1) return null;
    const out = [];
    for (let i = 0; i < n; i = next[i]) out.push(map.get(word.slice(i, next[i])));
    return out;
  }

  /** Texto, números o lista -> los 4 números del código, o null. */
  function parseCode(input) {
    let parts;
    if (Array.isArray(input)) parts = input.map(toDex);
    else if (typeof input === 'string') {
      parts = [];
      for (const w of words(input)) {
        const d = toDex(w);
        if (d !== null) { parts.push(d); continue; }
        const many = /^\d+$/.test(w) ? null : split(w);
        if (!many) return null;
        parts.push(...many);
      }
    } else return null;
    if (parts.length !== 4 || parts.some(d => d === null)) return null;
    return parts;
  }

  /** Los 4 nombres del código en un idioma (el del juego si no se dice). */
  function codeNames(code, lang = curLang()) {
    return Array.isArray(code) ? code.map(d => nameOf(d, lang)) : [];
  }

  const format = (code, lang) => codeNames(code, lang).join(' ');

  /** [dex, nombre, nombre del idioma normalizado, inglés normalizado] de un idioma, una vez. */
  function listFor(lang) {
    if (!lists.has(lang)) {
      lists.set(lang, (G.ROOM_DEX || []).map(dex => {
        const name = nameOf(dex, lang);
        return [dex, name, norm(name), norm(nameOf(dex, 'en'))];
      }));
    }
    return lists.get(lang);
  }

  function matches(p, lang) {
    const hits = [];
    for (const [dex, name, own, en] of listFor(lang)) {
      // Primero el nombre exacto, luego los del idioma, luego los ingleses.
      const rank = own === p || en === p ? 0 : own.startsWith(p) ? 1 : en.startsWith(p) ? 2 : -1;
      if (rank >= 0) hits.push({ rank, dex, name });
    }
    return hits.sort((a, b) => a.rank - b.rank).slice(0, MAX_SUGGEST).map(h => ({ dex: h.dex, name: h.name }));
  }

  /** Hasta 5 Pokémon cuyo nombre empieza por lo último que se ha escrito. */
  function suggest(prefix, lang = curLang()) {
    const raw = norm(prefix || '');
    if (/[^\p{L}\p{N}]$/u.test(raw)) return [];
    const ws = words(raw), w = ws[ws.length - 1];
    if (!w || /^\d+$/.test(w)) return [];
    // Sin separar (皮卡丘伊): se quitan delante los nombres ya completos.
    for (let i = 0; i < w.length; i++) {
      if (i && !split(w.slice(0, i))) continue;
      const hits = matches(w.slice(i), lang);
      if (hits.length) return hits;
    }
    return [];
  }

  return { codeNames, format, parseCode, suggest };
})();
