/* ============ words.js: números de la Pokédex que valen para los códigos ============
 * La lista es la misma que usa el juego (js/data/room-words.js dentro de
 * STATIC_DIR: la raíz del repositorio o /app/public en Docker), para que los
 * cuatro Pokémon del código se puedan escribir y leer en todos los idiomas.
 * Si el archivo no está (o no trae una lista válida), se usan los números del
 * 1 al 800 y se avisa: los códigos funcionan, pero el juego quizá no sepa
 * nombrar alguno.
 *
 * load(staticDir) -> lista de números (staticDir: cfg.staticDir de config.js)
 */
'use strict';

const path = require('path');

function fallback(why) {
  console.warn('[relay] js/data/room-words.js no disponible (' + why + '): se usan los números 1 a 800');
  return Object.freeze(Array.from({ length: 800 }, (_, i) => i + 1));
}

function valid(list) {
  return Array.isArray(list) && list.length >= 16 &&
    list.every(n => Number.isInteger(n) && n > 0) &&
    new Set(list).size === list.length;
}

function load(staticDir = path.resolve(__dirname, '..', '..')) {
  let list;
  try {
    list = require(path.join(staticDir, 'js', 'data', 'room-words.js')).ROOM_DEX;
    if (!valid(list)) list = fallback('lista vacía o con números no válidos');
  } catch (e) {
    list = fallback(e.code || e.message);
  }
  return list;
}

module.exports = { load };
