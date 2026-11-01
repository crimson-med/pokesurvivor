/* ============ save-merge.js: fusionar dos versiones de una partida ============
 * Lo usan el juego (G.SaveMerge, lo carga dev.html antes de db.js) y el
 * servidor (require: server/http/auth.js, al juntar la partida de un invitado
 * con la de la cuenta en la que entra). Sin nada del navegador: sólo datos.
 *
 *   merge(a, b)        la fusión de G.DB.merge (abajo, cómo junta cada cosa)
 *   mergeInto(cuenta, invitado, etiqueta)  la partida de otra cuenta dentro de esta
 *   ledOf(s, dev)      la libreta de una partida, sin tocarla
 *   addTo, ledSum, curKeys, curSet, isCurKey, num, isObj
 *                      piezas de la libreta que db.js usa en fold y sanitize
 */
(() => {
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  /** Un entero >= 0 (lo raro, negativo o que no es un número, 0). */
  const num = v => (Number.isFinite(+v) && +v > 0 ? Math.floor(+v) : 0);

  /*
   * LIBRETA de monedas y tickets (14-10-2026). Antes las monedas y los tickets
   * eran "los de la versión más reciente": si un aparato con datos viejos (el
   * móvil con la pestaña abierta de ayer) guardaba algo, su número ganaba y se
   * perdía lo conseguido en el otro (un jugador pasó de 36 tickets a 3).
   * Ahora cada aparato apunta en save.led[aparato] lo que ha ganado y gastado
   * de cada cosa ([ganado, gastado], sólo crecen) y el saldo es la suma de
   * todos: al fusionar se toma el mayor de cada apunte y no se pierde nada.
   *   led.base: el saldo que había antes de la libreta (o al empezar).
   *   led.old:  cambios de una versión anterior del juego (pestañas sin actualizar).
   */
  const CUR = {
    c: [s => s.coins, (s, v) => { s.coins = v; }],
    t1: [s => s.tickets.t1, (s, v) => { s.tickets.t1 = v; }],
    t10: [s => s.tickets.t10, (s, v) => { s.tickets.t10 = v; }]
  };
  /*
   * Desde el 20-10-2026 también la Mochila y las MT (Tienda Kecleon), con la misma
   * libreta: 'b:<objeto>' (save.bag) y 'm:<movimiento>' (save.tms). Así una Menta
   * gastada en un aparato no vuelve a aparecer al fusionar con el otro.
   */
  const isCurKey = k => !!CUR[k] || /^b:[a-z0-9]{1,12}$/.test(k) || /^m:[a-z0-9-]{1,40}$/.test(k);
  const SUB = { b: 'bag', m: 'tms' };
  function curGet(s, k) {
    if (CUR[k]) return CUR[k][0](s);
    const o = s[SUB[k[0]]];
    return o ? o[k.slice(2)] : 0;
  }
  function curSet(s, k, v) {
    if (CUR[k]) { CUR[k][1](s, v); return; }
    const o = s[SUB[k[0]]] = s[SUB[k[0]]] || {};
    if (v > 0) o[k.slice(2)] = Math.min(999, v); else delete o[k.slice(2)];
  }
  /** Todas las cosas con saldo de una partida (y de su libreta). */
  function curKeys(s, led) {
    const ks = new Set(Object.keys(CUR));
    for (const id of Object.keys(s.bag || {})) ks.add('b:' + id);
    for (const id of Object.keys(s.tms || {})) ks.add('m:' + id);
    for (const dev in led || {}) for (const k in led[dev]) if (isCurKey(k)) ks.add(k);
    return [...ks];
  }
  const balOf = (s, led) => { const o = {}; for (const k of curKeys(s, led)) o[k] = num(curGet(s, k)); return o; };
  function ledSum(led, k) {
    let t = 0;
    for (const dev in led) { const e = led[dev] && led[dev][k]; if (e) t += num(e[0]) - num(e[1]); }
    return t;
  }
  function addTo(led, dev, k, d) {
    if (!d) return;
    const e = led[dev] = led[dev] || {};
    const p = e[k] = e[k] || [0, 0];
    if (d > 0) p[0] = num(p[0]) + d; else p[1] = num(p[1]) - d;
  }
  /** La libreta de una partida (sin tocarla); lo que no cuadre, a `dev`. */
  function ledOf(s, dev) {
    if (!isObj(s.led)) {
      const b = balOf(s), base = {};
      for (const k in b) base[k] = [b[k], 0];
      return { base };
    }
    const led = JSON.parse(JSON.stringify(s.led)), b = balOf(s, led);
    // Un saldo en negativo (lo mismo gastado en dos aparatos sin conexión) se ve como 0.
    for (const k in b) addTo(led, dev, k, b[k] - Math.max(0, ledSum(led, k)));
    return led;
  }

  /**
   * Fusiona dos versiones de la misma partida (p. ej. una jugada sin
   * conexión y la de la nube). Nunca se pierde nada conseguido:
   *   - colecciones (owned, shiny): unión
   *   - mejoras y estadísticas: el máximo de cada una
   *   - monedas, tickets, Mochila y MT: la libreta (arriba)
   *   - compañero, pity...: los de la versión más reciente
   * Es idempotente: fusionar dos veces da lo mismo.
   */
  function merge(a, b) {
    if (!a) return b;
    if (!b) return a;
    const newer = (a.updated || 0) >= (b.updated || 0) ? a : b;
    const older = newer === a ? b : a;
    const r = JSON.parse(JSON.stringify(newer));
    // Monedas y tickets: el mayor de cada apunte de cada aparato, y el saldo es la suma.
    const la = ledOf(a, 'old'), lb = ledOf(b, 'old'), led = {};
    for (const src of [la, lb]) for (const dev in src) for (const k in src[dev]) {
      const p = ((led[dev] = led[dev] || {})[k] = led[dev][k] || [0, 0]), q = src[dev][k];
      p[0] = Math.max(p[0], num(q[0])); p[1] = Math.max(p[1], num(q[1]));
    }
    r.led = led;
    r.tickets = r.tickets || { t1: 0, t10: 0 };
    r.bag = {}; r.tms = {};
    for (const k of curKeys({ bag: {}, tms: {} }, led)) curSet(r, k, Math.max(0, ledSum(led, k)));
    // MT aprendidas: nunca se olvidan (unión). Naturaleza y habilidad: la elegida más tarde.
    r.ptm = r.ptm || {};
    for (const d in older.ptm || {}) r.ptm[d] = [...new Set((r.ptm[d] || []).concat(older.ptm[d] || []))];
    for (const k of ['pnat', 'pabil', 'pskin']) {
      r[k] = r[k] || {};
      for (const d in older[k] || {}) if (!r[k][d] || (+older[k][d][1] || 0) > (+r[k][d][1] || 0)) r[k][d] = older[k][d];
    }
    for (const coll of ['owned', 'shiny']) {
      r[coll] = r[coll] || {};
      for (const k in older[coll] || {}) {
        if (!r[coll][k] || (older[coll][k].at || 0) < (r[coll][k].at || 0)) r[coll][k] = older[coll][k];
      }
    }
    r.upgrades = r.upgrades || {};
    for (const k in older.upgrades || {}) r.upgrades[k] = Math.max(r.upgrades[k] || 0, older.upgrades[k]);
    r.pupg = r.pupg || {};
    for (const d in older.pupg || {}) {
      const mine = r.pupg[d] = r.pupg[d] || {};
      for (const k in older.pupg[d]) mine[k] = Math.max(mine[k] || 0, older.pupg[d][k]);
    }
    r.pupgDone = r.pupgDone || older.pupgDone;
    // Favoritos: gana lo último que se hizo con cada uno (poner o quitar), en
    // cualquier aparato. Partidas con cada Pokémon: el mayor de los dos.
    r.dfav = r.dfav || {};
    for (const d in older.dfav || {}) if (Math.abs(+older.dfav[d] || 0) > Math.abs(+r.dfav[d] || 0)) r.dfav[d] = older.dfav[d];
    r.pused = r.pused || {};
    for (const d in older.pused || {}) r.pused[d] = Math.max(+r.pused[d] || 0, +older.pused[d] || 0);
    // Movimiento inicial: el de la versión más reciente; si no lo tenía elegido, el de la otra.
    for (const k of ['pstart', 'pstart2']) {
      r[k] = r[k] || {};
      for (const d in older[k] || {}) if (!(d in r[k])) r[k][d] = older[k][d];
    }
    // Lo conseguido nunca se pierde: unión de legendarios, arenas, objetos, logros...
    for (const coll of ['legends', 'arenas', 'itemsFound', 'evoMoves', 'ach', 'skins']) {
      r[coll] = r[coll] || {};
      for (const k in older[coll] || {}) if (!r[coll][k]) r[coll][k] = older[coll][k];
    }
    // Misiones del mismo día/semana: el mayor progreso y lo ya recogido.
    const mo = older.missions || {}, mr = r.missions = r.missions || {};
    for (const [per, list] of [['day', 'daily'], ['week', 'weekly']]) {
      if (mr[per] !== mo[per] || !mr[list] || !mo[list]) continue;
      mr[list].forEach((m, i) => {
        const o = mo[list][i];
        if (!o || o.id !== m.id) return;
        m.prog = Math.max(m.prog || 0, o.prog || 0);
        m.claimed = m.claimed || o.claimed;
        m.told = m.told || o.told;
      });
    }
    r.stats = r.stats || {};
    for (const k in older.stats || {}) r.stats[k] = Math.max(r.stats[k] || 0, older.stats[k] || 0);
    if (r.starter == null) r.starter = older.starter;
    if (r.personality == null) r.personality = older.personality;
    if (r.partner == null || !r.owned[r.partner]) { r.partner = older.partner; r.partnerShiny = older.partnerShiny; }
    r.created = Math.min(a.created || Date.now(), b.created || Date.now());
    r.updated = Math.max(a.updated || 0, b.updated || 0);
    return r;
  }

  /**
   * Junta la partida de OTRA cuenta (un invitado que entra en una cuenta que ya
   * existía) dentro de `account`. Distinto de merge, que es para dos copias de
   * la misma partida:
   *   - la libreta del invitado va con otro nombre de aparato (`tag`): si los
   *     dos jugaron en este navegador, el mayor de cada apunte se comía lo del
   *     invitado; así se suma
   *   - nombre, compañero, pity...: los de la cuenta (como si fuera la más nueva)
   */
  function mergeInto(account, guest, tag) {
    if (!guest) return account;
    const g = JSON.parse(JSON.stringify(guest));
    const led = {}, src = ledOf(g, 'old');
    for (const dev in src) led[tag + '.' + dev] = src[dev];
    g.led = led;
    if (!account) return g;
    g.updated = Math.min(g.updated || 0, (account.updated || 0) - 1);
    const r = merge(account, g);
    r.updated = Math.max(account.updated || 0, guest.updated || 0);
    return r;
  }

  const api = { merge, mergeInto, ledOf, addTo, ledSum, curKeys, curSet, isCurKey, num, isObj };
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else G.SaveMerge = api;
})();
