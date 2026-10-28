/* ============ limits.js: límites de uso (cubos de fichas) ============
 * Cada cubo tiene `cap` fichas y se rellena entero en `windowMs`. Cada uso
 * gasta una; sin fichas, se rechaza. Un mapa por clave (cuenta o IP: los
 * límites "por socket" van por cuenta, para que reconectar no los vacíe);
 * clean() borra los cubos que ya se han rellenado del todo, así nada (las IP
 * tampoco) se queda en memoria más de lo que dura su ventana.
 *
 * Números de docs/relay-coop/02-protocol.md (Limits):
 *   m      120 por segundo (y si se pasa 3 s seguidos, se le corta)
 *   sig    60 por minuto
 *   join   5 por minuto, por IP y por cuenta
 * Extras del servidor: create 10 por minuto y cuenta, y 30 eventos de control
 * (member, path, start...) cada 10 s.
 */
'use strict';

function bucket(cap, windowMs, now = Date.now) {
  const map = new Map();
  const rate = cap / windowMs;
  function fill(b, t) {
    b.n = Math.min(cap, b.n + (t - b.at) * rate);
    b.at = t;
  }
  return {
    take(key) {
      const t = now();
      let b = map.get(key);
      if (!b) { b = { n: cap, at: t }; map.set(key, b); }
      fill(b, t);
      if (b.n < 1) return false;
      b.n -= 1;
      return true;
    },
    drop(key) { map.delete(key); },
    clean() {
      const t = now();
      for (const [k, b] of map) {
        fill(b, t);
        if (b.n >= cap) map.delete(k);
      }
    },
    get size() { return map.size; },
  };
}

// Cuenta cuánto tiempo seguido lleva un socket pasándose. Un segundo sin
// pasarse reinicia la cuenta.
function flood(limitMs, now = Date.now) {
  const map = new Map();
  return {
    over(key) {
      const t = now();
      let s = map.get(key);
      if (!s || t - s.last > 1000) { s = { since: t, last: t }; map.set(key, s); }
      s.last = t;
      return t - s.since >= limitMs;
    },
    drop(key) { map.delete(key); },
    clean() {
      const t = now();
      for (const [k, s] of map) if (t - s.last > 1000) map.delete(k);
    },
  };
}

const DEFAULTS = {
  m: [120, 1000],
  sig: [60, 60000],
  joinIp: [5, 60000],
  joinUid: [5, 60000],
  create: [10, 60000],
  ctl: [30, 10000],
};

// o: { now, <nombre>: [cap, windowMs] } para cambiar algún número (pruebas).
function createLimits(o = {}) {
  const now = o.now || Date.now;
  const all = {};
  for (const k of Object.keys(DEFAULTS)) {
    const [cap, ms] = o[k] || DEFAULTS[k];
    all[k] = bucket(cap, ms, now);
  }
  all.flood = flood(3000, now);
  all.clean = () => { for (const k of Object.keys(all)) if (all[k].clean) all[k].clean(); };
  return all;
}

module.exports = { bucket, flood, createLimits, DEFAULTS };
