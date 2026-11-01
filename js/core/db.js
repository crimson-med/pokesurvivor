/* ============ db.js: base de datos, el servidor del juego (nube) o local ============
 * TODO el acceso a datos persistentes pasa por aquí. El resto del juego sólo
 * usa G.DB.*.
 *
 * Dos modos (se decide en ready()):
 *
 *   NUBE  (el servidor del juego, server/, por G.Api)
 *     Si el juego se abre desde una web (http/https) y GET /api/me contesta.
 *     Se entra con un código de 6 cifras que llega al correo (sendCode y
 *     verifyCode) o como invitado (playAsGuest: una cuenta del servidor sin
 *     correo, a la que luego se le puede poner uno). La sesión es una cookie
 *     del servidor (httpOnly): aquí sólo se guarda quién eres (ps.me), para
 *     poder jugar sin conexión con la copia de la última vez.
 *       ps.me            la cuenta de la última vez ({ uid, kind, name, email, admin })
 *       ps.cloud.<uid>   la partida de esa cuenta en este navegador
 *     paso 3: la partida también en el servidor (ver MODO NUBE).
 *     Al juntar dos copias se FUSIONAN (G.SaveMerge.merge, js/core/save-merge.js):
 *     las colecciones se unen y nunca se pierde un Pokémon ni un shiny.
 *
 *   LOCAL (localStorage)
 *     Si se abre con doble clic (file://) o la web no tiene el servidor del
 *     juego. Igual que antes: cuentas y partidas sólo en este navegador.
 *       ps.accounts      { clave: { name, salt, hash, created } }
 *       ps.save.<clave>  partida de esa cuenta
 *       ps.session       última cuenta con sesión iniciada
 *     El modo invitado juega con una partida en memoria que no se guarda.
 */
G.DB = (() => {
  const K_ACC = 'ps.accounts', K_SES = 'ps.session', K_SAVE = 'ps.save.';
  const K_CLOUD = 'ps.cloud.', K_ME = 'ps.me';
  // Cerró sesión sin conexión: la cookie sigue valiendo, así que al volver se cierra de verdad.
  const K_OUT = 'ps.out';
  const VERSION = 3;
  const START_COINS = 500;

  let mode = 'local';       // 'cloud' | 'local'
  let localReason = '';     // por qué no hay nube: 'file' | 'config' | 'dev' | 'error'
  let user = null;          // nombre visible
  let key = null;           // clave local (minúsculas) o uid de la cuenta del servidor
  let guest = false;        // invitado en memoria (sólo en modo local): no se guarda
  let save = null;
  let storageOk = true;

  // ---------------- almacenamiento local seguro ----------------

  function read(k) {
    try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; }
    catch (e) { storageOk = false; return null; }
  }
  function write(k, v) {
    const s = JSON.stringify(v);
    try { localStorage.setItem(k, s); return true; }
    catch (e) {
      // Navegador lleno (sobre todo por lo que guarda el ranking): se libera lo
      // prescindible y se reintenta. Antes la copia de la partida dejaba de
      // guardarse sin avisar y, al recargar, se volvía a la de la nube.
      try {
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const key = localStorage.key(i);
          if (key && /^ps\.rk\.c\./.test(key)) localStorage.removeItem(key);
        }
        localStorage.setItem(k, s); return true;
      } catch (e2) { storageOk = false; return false; }
    }
  }
  function remove(k) { try { localStorage.removeItem(k); } catch (e) { /* nada */ } }

  // La libreta y la fusión son las de js/core/save-merge.js (también las usa el servidor).
  const { ledOf, addTo, ledSum, curKeys, curSet, isCurKey, num, isObj } = G.SaveMerge;

  // ---------------- partida ----------------

  function newSave(name) {
    return {
      v: VERSION,
      name,
      created: Date.now(),
      updated: Date.now(),    // última modificación (para fusionar)
      coins: START_COINS,
      owned: {},              // dex -> { at, from: 'starter'|'gacha'|'wild' }
      shiny: {},              // dex -> { at, from } — variantes shiny conseguidas
      partner: null,          // dex del Pokémon con el que juegas
      partnerShiny: false,    // jugar con su versión shiny (si la tienes)
      starter: null,          // dex que te tocó en el test
      personality: null,      // { trait, scores }
      upgrades: {},           // (antiguo) mejoras de la cuenta; ahora van por Pokémon
      pupg: {},               // dex -> { id -> nivel }: mejoras de cada Pokémon
      dfav: {},               // dex -> fecha: favorito de la colección (negativa = quitado entonces)
      pused: {},              // dex -> partidas jugadas con él (orden "más usados")
      pstart: {},             // dex -> movimiento inicial elegido (Mejoras → Movimiento inicial)
      pstart2: {},            // dex -> segundo movimiento inicial (Mejoras → Segundo movimiento inicial)
      // Tienda Kecleon (20-10-2026, ver data/shop.js y systems/mons.js):
      bag: {},                // Mochila: id -> cuántos (mint, cap, caph); en la libreta, como las monedas
      tms: {},                // MT sin usar: movimiento -> cuántas; también en la libreta
      ptm: {},                // dex -> [movimientos aprendidos con MT] (para siempre)
      pnat: {},               // dex -> [naturaleza, fecha]: la cambiada con Menta (si no, la que le tocó)
      pabil: {},              // dex -> [0|1|2, fecha]: la habilidad cambiada con Cápsula (2 = oculta)
      // Halloween (25-10-2026, core/skins.js): los caramelos van en bag.candy.
      skins: {},              // id -> fecha: skins compradas (para siempre)
      pskin: {},              // dex -> [id, fecha]: la que lleva puesta ('' = ninguna; gana la elegida más tarde)
      tickets: { t1: 0, t10: 0 },   // tickets del gacha (x1 y x10)
      pity: {},               // generación del banner -> tiradas sin ★5
      legends: {},            // dex -> fecha: legendarios vencidos en grietas
      arenas: {},             // tipo -> fecha: arenas de grieta ganadas
      itemsFound: {},         // id -> fecha: objetos equipables encontrados
      evoMoves: {},           // id -> fecha: movimientos evolucionados alguna vez
      ach: {},                // id -> fecha: logros conseguidos
      missions: {},           // misiones del día / semana (systems/progress.js)
      profile: { favs: [], title: '' },   // perfil público: 3 favoritos y título
      stats: { runs: 0, bestTime: 0, bestLevel: 0, totalKills: 0, pulls: 0, coinsEarned: 0, shinies: 0,
               bossesTotal: 0, riftWins: 0, evolutions: 0, missionsDone: 0, groupRuns: 0, bestGroupTime: 0 }
    };
  }

  /** Rellena campos que falten en partidas de versiones anteriores. */
  function migrate(s, name) {
    const base = newSave(name || s.name);
    for (const k in base) if (s[k] == null) s[k] = base[k];
    for (const k in base.stats) if (s.stats[k] == null) s.stats[k] = base.stats[k];
    // v1 -> v2: había un único banner (Kanto) con el pity como número.
    if (typeof s.pity === 'number') s.pity = { 1: s.pity };
    // v2 -> v3: las mejoras eran de la cuenta; pasan al compañero de entonces.
    if (!s.pupgDone) {
      if (s.partner && Object.values(s.upgrades || {}).some(v => v > 0)) {
        s.pupg[s.partner] = Object.assign({}, s.upgrades);
      }
      s.pupgDone = true;
    }
    s.tickets = Object.assign({ t1: 0, t10: 0 }, s.tickets);
    sanitize(s);
    s.v = VERSION;
    return s;
  }

  /**
   * Quita lo imposible de una partida editada a mano (la copia del navegador
   * se puede tocar): números negativos o raros, mejoras por encima del
   * máximo y Pokémon que no existen. Lo que sí sea posible no se frena aquí
   * (los rankings no se fían de la partida: paso 7).
   */
  function sanitize(s) {
    s.coins = num(s.coins);
    s.tickets.t1 = num(s.tickets.t1);
    s.tickets.t10 = num(s.tickets.t10);
    if (isObj(s.led)) {
      for (const dev of Object.keys(s.led)) {
        const e = s.led[dev];
        if (!isObj(e)) { delete s.led[dev]; continue; }
        for (const k of Object.keys(e)) {
          if (!isCurKey(k) || !Array.isArray(e[k])) { delete e[k]; continue; }
          e[k] = [num(e[k][0]), num(e[k][1])];
        }
      }
    } else delete s.led;
    if (G.DEX_BY) for (const coll of ['owned', 'shiny', 'dfav', 'pused']) {
      for (const d of Object.keys(s[coll] || {})) if (!G.DEX_BY[d]) delete s[coll][d];
    }
    for (const coll of ['dfav', 'pused']) {
      if (!isObj(s[coll])) { s[coll] = {}; continue; }
      for (const d of Object.keys(s[coll])) if (!Number.isFinite(+s[coll][d])) delete s[coll][d];
    }
    for (const k of ['pstart', 'pstart2']) {
      if (!isObj(s[k])) s[k] = {};
      for (const d of Object.keys(s[k])) {
        if (typeof s[k][d] !== 'string' || (G.DEX_BY && !G.DEX_BY[d]) || (G.Moves && !G.Moves.BY_ID[s[k][d]])) delete s[k][d];
      }
    }
    // Mochila y MT: cuántas de cada cosa que exista (tope 999).
    for (const [k, ok] of [['bag', id => !G.Shop || G.Shop.ITEMS[id]], ['tms', id => !G.Moves || G.Moves.BY_ID[id]]]) {
      if (!isObj(s[k])) s[k] = {};
      for (const id of Object.keys(s[k])) {
        s[k][id] = Math.min(999, num(s[k][id]));
        if (!s[k][id] || !ok(id)) delete s[k][id];
      }
    }
    // MT aprendidas: movimientos que existen, sin repetir.
    if (!isObj(s.ptm)) s.ptm = {};
    for (const d of Object.keys(s.ptm)) {
      const l = Array.isArray(s.ptm[d]) ? s.ptm[d] : [];
      s.ptm[d] = [...new Set(l.filter(id => typeof id === 'string' && (!G.Moves || G.Moves.BY_ID[id])))];
      if (!s.ptm[d].length || (G.DEX_BY && !G.DEX_BY[d])) delete s.ptm[d];
    }
    // Naturaleza y habilidad elegidas: [valor, fecha].
    for (const [k, ok] of [['pnat', v => typeof v === 'string' && (!G.NATURE_BY || G.NATURE_BY[v])], ['pabil', v => v === 0 || v === 1 || v === 2]]) {
      if (!isObj(s[k])) s[k] = {};
      for (const d of Object.keys(s[k])) {
        const e = s[k][d];
        if (!Array.isArray(e) || !ok(e[0]) || (G.DEX_BY && !G.DEX_BY[d])) delete s[k][d];
        else s[k][d] = [e[0], num(e[1])];
      }
    }
    // Skins: las que existen; la puesta, de ese Pokémon ('' = ninguna) y con su fecha.
    if (!isObj(s.skins)) s.skins = {};
    for (const id of Object.keys(s.skins)) if ((G.Skins && !G.Skins.SKINS[id]) || !Number.isFinite(+s.skins[id])) delete s.skins[id];
    if (!isObj(s.pskin)) s.pskin = {};
    for (const d of Object.keys(s.pskin)) {
      const e = s.pskin[d], id = Array.isArray(e) ? e[0] : null;
      if (typeof id !== 'string' || (id && G.Skins && (!G.Skins.SKINS[id] || G.Skins.SKINS[id].dex !== +d))) delete s.pskin[d];
      else s.pskin[d] = [id, num(e[1])];
    }
    // Atajos: 4 huecos con un movimiento que exista (o null), sin repetir.
    if (s.pbind && typeof s.pbind === 'object') {
      for (const d of Object.keys(s.pbind)) {
        const l = Array.isArray(s.pbind[d]) ? s.pbind[d].slice(0, 4) : [];
        const seen = new Set();
        s.pbind[d] = [0, 1, 2, 3].map(i => {
          const id = l[i];
          if (typeof id !== 'string' || (G.Moves && !G.Moves.BY_ID[id]) || seen.has(id)) return null;
          seen.add(id); return id;
        });
      }
    } else s.pbind = {};
    // Veto: listas de movimientos que existen, sin repetir, como mucho 3.
    if (s.pban && typeof s.pban === 'object') {
      for (const d of Object.keys(s.pban)) {
        const l = Array.isArray(s.pban[d]) ? s.pban[d] : [];
        s.pban[d] = [...new Set(l.filter(id => typeof id === 'string' && (!G.Moves || G.Moves.BY_ID[id])))].slice(0, 3);
      }
    } else s.pban = {};
    if (G.Upgrades) for (const d of Object.keys(s.pupg || {})) {
      const u = s.pupg[d];
      if (!u || typeof u !== 'object') { delete s.pupg[d]; continue; }
      for (const id of Object.keys(u)) {
        if (!G.Upgrades.BY[id]) delete u[id];
        else u[id] = Math.min(G.Upgrades.BY[id].max, num(u[id]));
      }
    }
  }

  /*
   * LIBRETA de monedas y tickets (14-10-2026, js/core/save-merge.js): cada
   * aparato apunta en save.led[aparato] lo que ha ganado y gastado de cada cosa
   * y el saldo es la suma de todos, así al fusionar no se pierde nada.
   */
  // Este aparato (navegador): un nombre al azar que se queda guardado.
  const DEV = (() => {
    let d = read('ps.dev');
    if (typeof d !== 'string' || !/^[a-z0-9]{6,12}$/.test(d)) { d = 'd' + Math.random().toString(36).slice(2, 10); write('ps.dev', d); }
    return d;
  })();
  /** Apunta en la libreta de ESTE aparato lo que ha cambiado desde la última vez. */
  function fold(s) {
    if (!s) return s;
    // Libreta en negativo (lo mismo gastado en dos aparatos): antes se veía 0,
    // pero lo ganado después se volvía a apuntar en cada guardado (y en cada
    // aparato) y los tickets crecían solos (25-10-2026). Ahora lo debido se
    // perdona una vez en led.fix: como cada apunte, al juntar se toma el mayor,
    // así que dos aparatos que ven la misma deuda no la perdonan dos veces.
    if (isObj(s.led)) for (const k of curKeys(s, s.led)) {
      const owed = -ledSum(s.led, k);
      if (owed > 0) addTo(s.led, 'fix', k, owed);
    }
    s.led = ledOf(s, DEV);
    // Y el saldo es siempre el de la libreta.
    for (const k of curKeys(s, s.led)) curSet(s, k, Math.max(0, ledSum(s.led, k)));
    return s;
  }

  /**
   * Fusiona dos versiones de la misma partida (la de este navegador y otra):
   * G.SaveMerge.merge, la misma que usa el servidor. Es idempotente.
   */
  function merge(a, b) { return G.SaveMerge.merge(a, b); }

  /*
   * Copia `s` sobre la partida SIN cambiar los objetos de dentro (mejoras,
   * Pokémon...): las pantallas abiertas y otros módulos guardan referencias a
   * ellos. Antes se sustituían y una compra hecha justo después de subir la
   * partida se apuntaba en la copia vieja: se cobraban las monedas y la mejora
   * se perdía.
   */
  function assignDeep(dst, src) {
    for (const k of Object.keys(dst)) if (!(k in src)) delete dst[k];
    for (const k in src) {
      if (isObj(src[k]) && isObj(dst[k])) assignDeep(dst[k], src[k]);
      else dst[k] = src[k];
    }
  }
  function applyInPlace(s) { assignDeep(save, s); }

  const VALID = /^[A-Za-z0-9_ñÑáéíóúÁÉÍÓÚ]{3,16}$/;

  // =====================================================================
  //                               MODO LOCAL
  // =====================================================================

  async function hash(pass, salt) {
    const text = salt + ':' + pass;
    if (window.crypto && crypto.subtle) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
    }
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677);
    }
    return 'f' + (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16);
  }

  function randomSalt() {
    const a = new Uint8Array(12);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(a);
    else for (let i = 0; i < a.length; i++) a[i] = Math.random() * 256;
    return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function loadLocal(k, name) {
    const s = read(K_SAVE + k);
    return s ? migrate(s, name) : newSave(name);
  }

  function beginLocal(k, name) {
    key = k; user = name; guest = false;
    save = fold(loadLocal(k, name));
    write(K_SES, k);
  }

  async function registerLocal(name, pass) {
    const accs = read(K_ACC) || {};
    const k = name.toLowerCase();
    if (accs[k]) return { ok: false, error: 'Ese nombre ya existe.' };
    const salt = randomSalt();
    accs[k] = { name, salt, hash: await hash(pass, salt), created: Date.now() };
    if (!write(K_ACC, accs)) return { ok: false, error: 'El navegador no deja guardar datos (¿modo incógnito?).' };
    beginLocal(k, name);
    write(K_SAVE + k, save);
    return { ok: true, isNew: true };
  }

  async function loginLocal(name, pass) {
    const accs = read(K_ACC) || {};
    const acc = accs[name.toLowerCase()];
    if (!acc || acc.hash !== await hash(pass || '', acc.salt)) {
      return { ok: false, error: 'Usuario o contraseña incorrectos.' };
    }
    beginLocal(name.toLowerCase(), acc.name);
    return { ok: true, isNew: !save.partner };
  }

  function restoreLocal() {
    const k = read(K_SES);
    if (!k) return false;
    const accs = read(K_ACC) || {};
    if (!accs[k]) { remove(K_SES); return false; }
    beginLocal(k, accs[k].name);
    return true;
  }

  // =====================================================================
  //                               MODO NUBE
  // =====================================================================

  /*
   * La cuenta es del servidor del juego (server/, docs/relay-coop/04-auth.md):
   * se entra con un código de 6 cifras por correo o como invitado, y la sesión
   * es una cookie httpOnly que el navegador manda solo (G.Api). Aquí sólo se
   * sabe quién eres (me, de GET /api/me) y se guarda la partida.
   *
   * paso 3: la partida en el servidor (GET y PUT /api/save con rev, ver
   * docs/relay-coop/07-step-3-saves.md). Hasta entonces sólo está la copia de
   * este navegador (ps.cloud.<uid>): se guarda al momento, Guardar no sube
   * nada y al cerrar sesión se queda aquí para cuando vuelvas a entrar. La
   * subida de antes (Firestore: rev + 1, juntar al rechazarla, Guardar con
   * espera, reintentos) está en js/core/db.js del commit 8179399a.
   */
  let uid = null;
  let me = null;              // { uid, kind: 'guest' | 'email', name, email (enmascarado), admin }
  let serverOk = false;       // el servidor contestó (no se juega sin conexión)
  let pending = false;
  let syncState = 'local';    // 'ok' | 'syncing' | 'pending' | 'offline' | 'local'
  const listeners = new Set();

  function setSync(s) { syncState = s; listeners.forEach(fn => { try { fn(s); } catch (e) { /* nada */ } }); }

  /*
   * Otra pestaña de este navegador ha guardado su copia (25-10-2026). Las dos
   * apuntan en la misma entrada de la libreta (es el mismo aparato), y al
   * juntarlas ganaba la mayor: lo ganado o gastado en una se perdía. Ahora cada
   * pestaña junta al momento lo de la otra, y si tenía algo que la otra no,
   * vuelve a dejar la copia completa (la otra la junta y ya no cambia nada).
   */
  function fromOtherTab(e) {
    if (mode !== 'cloud' || guest || !save || !uid || e.key !== K_CLOUD + uid || !e.newValue) return;
    let other;
    try { other = migrate(JSON.parse(e.newValue)); } catch (x) { return; }
    const before = canon(save);
    applyInPlace(fold(merge(plain(fold(save)), other)));
    const now = canon(save);
    // (Más nueva que la de la otra, para que al juntarla se quede con esta.)
    if (now !== canon(other)) { save.updated = Math.max(Date.now(), (other.updated || 0) + 1); write(K_CLOUD + uid, save); }
    if (now === before) return;
    // paso 3: aquí quedaba pendiente de subir (pending = true; setSync('pending')).
    if (G.UI && G.UI.refreshCoins) G.UI.refreshCoins();
  }

  const plain = s => JSON.parse(JSON.stringify(s));
  // La partida en texto con las claves ordenadas: para comparar dos.
  const canon = v => JSON.stringify(v, (k, x) => (isObj(x) ? Object.keys(x).sort().reduce((o, k2) => (o[k2] = x[k2], o), {}) : x));

  /**
   * Abre la partida de la cuenta `m` (recién comprobada o la de la última vez,
   * sin conexión). opts.from: la partida de un invitado (opts.fromUid) que
   * entra en una cuenta que ya existía: se junta con la de la cuenta
   * (G.SaveMerge.mergeInto, igual que el servidor).
   */
  function openAccount(m, opts = {}) {
    me = m; uid = m.uid; key = uid; guest = false;
    write(K_ME, me);
    remove(K_OUT);
    const cached = read(K_CLOUD + uid);
    let s = cached ? fold(migrate(cached)) : null;
    if (opts.from) {
      s = G.SaveMerge.mergeInto(s, migrate(opts.from), 'g' + opts.fromUid);
      if (!cached) s.name = m.name || s.name;   // (el nombre es el de la cuenta, no el del invitado)
    }
    // paso 3: aquí se lee la del servidor (GET /api/save) y se junta: s = merge(s, remota).
    if (!s) s = newSave(m.name || 'Entrenador');
    save = fold(migrate(s, s.name));
    user = save.name;
    write(K_CLOUD + uid, save);
    pending = false;
    setSync('local');
  }

  // Sin conexión al abrir: se vuelve a preguntar quién eres, con espera creciente.
  let meT = 0, meTries = 0;
  function meLater() {
    clearTimeout(meT);
    if (meTries >= 10) return;
    meT = setTimeout(retryMe, Math.min(10 * 60e3, 10e3 * Math.pow(2, meTries++)));
  }
  async function retryMe() {
    if (mode !== 'cloud' || !me || serverOk) return;
    const u = uid;
    try {
      const r = await G.Api.get('/api/me');
      if (uid !== u || !r || !r.me || r.me.uid !== u) return;
      me = r.me; serverOk = true; write(K_ME, me);
    } catch (e) {
      // Sesión cerrada desde otro sitio: se sigue con la copia; al recargar, a entrar.
      if (e.status !== 401 && e.status !== 403) meLater();
    }
  }

  // Sin respuesta del servidor (sin red, caído o un proxy que no llega a él).
  const unreachable = e => e.code === 'offline' || (e.status >= 500 && e.code === 'http');

  /** Código de error del servidor para la pantalla de entrar. */
  const codeOf = e => (e && e.code) || 'error';

  // =====================================================================
  //                           API PÚBLICA
  // =====================================================================

  let readyP = null;

  /** Arranca la base de datos y recupera la sesión anterior. → true si hay sesión. */
  function ready() {
    if (readyP) return readyP;
    readyP = (async () => {
      if (!/^https?:$/.test(location.protocol)) localReason = 'file';
      // dev.html (el código sin encerrar: G en la consola, con todo a mano) sólo usa la
      // nube en este ordenador. En la web iba con la cuenta de quien la abriera y se
      // podía poner las monedas, tickets o Pokémon que quisiera y guardarlo (26-10-2026).
      else if (!G.BUILT && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) localReason = 'dev';
      else if (!G.Api) localReason = 'config';
      if (localReason) { mode = 'local'; setSync('local'); return restoreLocal(); }
      if (window.addEventListener) window.addEventListener('storage', fromOtherTab);
      // Cerró sesión sin conexión: ahora sí se borra la sesión del servidor.
      if (read(K_OUT)) {
        try { await G.Api.post('/api/auth/logout', {}); remove(K_OUT); }
        catch (e) { if (e.status === 404 && e.code === 'http') { localReason = 'config'; mode = 'local'; setSync('local'); return restoreLocal(); } }
        mode = 'cloud'; serverOk = !read(K_OUT); remove(K_ME);
        return false;
      }
      try {
        const r = await G.Api.get('/api/me');
        mode = 'cloud'; serverOk = true;
        openAccount(r.me);
        return true;
      } catch (e) {
        if (e.status === 401) { mode = 'cloud'; serverOk = true; remove(K_ME); return false; }
        // Esta web no tiene el servidor del juego.
        if (e.status === 404 && e.code === 'http') { localReason = 'config'; mode = 'local'; setSync('local'); return restoreLocal(); }
        const last = read(K_ME);
        if (last && last.uid && read(K_CLOUD + last.uid)) {
          // Sin conexión (o el servidor contesta con un error, como rate), con
          // alguien que ya entró aquí: se juega con su copia y se vuelve a preguntar.
          mode = 'cloud'; serverOk = false;
          openAccount(last);
          setSync('offline');
          meTries = 0; meLater();
          return true;
        }
        if (!unreachable(e)) { mode = 'cloud'; serverOk = true; return false; }   // contesta: a entrar
        // No contesta y no hay nadie de antes.
        console.warn('[DB] sin nube:', e.code, e.status);
        localReason = 'error';
        mode = 'local'; setSync('local');
        return restoreLocal();
      }
    })();
    return readyP;
  }

  // Un cierre de sesión que quedó pendiente (sin conexión), antes de entrar con otra.
  async function settleOut() {
    if (!read(K_OUT)) return;
    try { await G.Api.post('/api/auth/logout', {}); } catch (e) { if (e.status !== 401) throw e; }
    remove(K_OUT);
  }

  /** Paso 1 para entrar: manda el código al correo. → { ok } o { ok: false, code } */
  async function sendCode(email) {
    if (mode !== 'cloud') return { ok: false, code: 'local' };
    try {
      await settleOut();
      await G.Api.post('/api/auth/email', { email: String(email || '').trim(), lang: (G.I18n && G.I18n.lang) || 'es' });
      serverOk = true;
      return { ok: true };
    } catch (e) { return { ok: false, code: codeOf(e), retry: e.retry }; }
  }

  /**
   * Paso 2: comprueba el código y entra. Si eras invitado y el correo ya
   * tenía cuenta, tu partida de invitado se junta con la suya (merged).
   * → { ok, isNew, merged } o { ok: false, code }
   */
  async function verifyCode(email, code) {
    if (mode !== 'cloud') return { ok: false, code: 'local' };
    let r;
    try { r = await G.Api.post('/api/auth/verify', { email: String(email || '').trim(), code: String(code || '') }); }
    catch (e) { return { ok: false, code: codeOf(e) }; }
    serverOk = true;
    // La partida de la cuenta de antes (un invitado que pone su correo), al día en este navegador.
    const prev = me;
    if (save && !guest && uid) { commit(); }
    let from = null;
    if (prev && prev.kind === 'guest' && prev.uid !== r.me.uid) {
      from = read(K_CLOUD + prev.uid);
      remove(K_CLOUD + prev.uid);         // ese invitado ya no existe
    }
    if (prev && prev.uid !== r.me.uid) for (const fn of leaveHooks) { try { await fn('logout'); } catch (e) { /* nada */ } }
    openAccount(r.me, { from, fromUid: prev && prev.uid });
    return { ok: true, isNew: !save.partner, merged: !!r.merged };
  }

  /** Cambia el nombre que se ve en la partida (al elegir apodo). */
  function setName(n) {
    if (!save || guest) return;
    save.name = n; user = n;
    commit();
  }

  /**
   * Jugar sin correo. Con el servidor, una cuenta de invitado de verdad (se
   * guarda y luego se le puede poner un correo); sin él (modo local), una
   * partida en memoria que no se guarda.
   * → { ok, isNew } o { ok: false, code } (promesa con el servidor)
   */
  function playAsGuest() {
    if (mode === 'cloud') {
      return settleOut().then(() => G.Api.post('/api/auth/guest', {})).then(r => {
        serverOk = true;
        openAccount(r.me);
        return { ok: true, isNew: !save.partner };
      }, e => ({ ok: false, code: codeOf(e) }));
    }
    user = 'Invitado'; key = null; guest = true; uid = null; me = null;
    save = newSave('Invitado');
    remove(K_SES);
    return { ok: true, isNew: true };
  }

  /**
   * Guarda la partida actual (no hace nada en modo invitado). En el navegador,
   * al momento. (Algunos lo llaman con 'run' o true, de cuando se subía antes
   * lo urgente: ya no cambia nada.)
   */
  function commit() {
    if (guest || !key || !save) return false;
    save.updated = Date.now();
    fold(save);
    if (mode === 'local') return write(K_SAVE + key, save);
    // paso 3: además queda pendiente de subir (pending = true; setSync('pending')).
    return write(K_CLOUD + uid, save);
  }

  /** Subir lo pendiente (updater.js, antes de recargar). paso 3: PUT /api/save. */
  function flush() { return Promise.resolve(); }

  /**
   * Botón Guardar. → { ok, why?: 'local'|'guest'|... }. paso 3: sube a la
   * nube; hasta entonces la partida ya está guardada en este navegador.
   */
  async function saveNow() {
    if (guest || !save) return { ok: false, why: 'guest' };
    commit();
    return { ok: true, why: 'local' };
  }

  /** Funciones que se ejecutan al cerrar sesión o borrar la cuenta (amigos, salas...). */
  const leaveHooks = [];

  function clearSession() {
    clearTimeout(meT);
    remove(K_ME);
    user = key = save = uid = me = null; guest = false; pending = false;
    setSync('local');
  }

  /**
   * Cerrar sesión. Con el servidor, la copia de la partida se queda en este
   * navegador (vuelve al entrar otra vez con la misma cuenta).
   * @param all  cerrarla también en todos los demás aparatos
   */
  async function logout(all) {
    for (const fn of leaveHooks) { try { await fn('logout'); } catch (e) { /* nada */ } }
    if (mode === 'cloud') {
      if (save && !guest) commit();
      if (all) {
        try { await G.Api.post('/api/auth/logout-all', {}); }
        catch (e) { if (e.status !== 401) return { ok: false, code: codeOf(e) }; }
      } else {
        // Sin conexión, la cookie sigue valiendo: se apunta y se cierra al volver (ready).
        try { await G.Api.post('/api/auth/logout', {}); } catch (e) { if (e.status !== 401) write(K_OUT, 1); }
      }
      clearSession();
      return { ok: true };
    }
    if (!guest) { commit(); remove(K_SES); }
    clearSession();
    return { ok: true };
  }

  /** Borra la cuenta y la partida (en el servidor o en este navegador). → { ok } o { ok: false, error } */
  async function deleteAccount() {
    if (guest || !key) return { ok: false, error: 'No hay cuenta que borrar.' };
    if (mode === 'local') {
      const accs = read(K_ACC) || {};
      delete accs[key];
      write(K_ACC, accs);
      remove(K_SAVE + key); remove(K_SES);
      user = key = save = null;
      return { ok: true };
    }
    try { await G.Api.del('/api/me', {}); }
    catch (e) {
      if (e.status !== 401) return { ok: false, error: e.code === 'offline' ? 'Sin conexión a internet.' : 'No se pudo borrar la cuenta. Vuelve a probar en un momento.' };
    }
    for (const fn of leaveHooks) { try { await fn('delete'); } catch (e) { /* nada */ } }
    remove(K_CLOUD + uid);
    clearSession();
    return { ok: true };
  }

  /** Sólo en modo local (file://): cuentas de nombre y contraseña de este navegador. */
  const MIN_PASS = 4;
  async function register(name, pass) {
    if (mode !== 'local') return { ok: false, error: 'Error: local' };
    name = (name || '').trim();
    if (!VALID.test(name)) return { ok: false, error: 'El nombre debe tener 3-16 letras, números o _.' };
    if ((pass || '').length < MIN_PASS) return { ok: false, error: `La contraseña debe tener al menos ${MIN_PASS} caracteres.` };
    return registerLocal(name, pass);
  }
  async function login(name, pass) {
    if (mode !== 'local') return { ok: false, error: 'Error: local' };
    return loginLocal((name || '').trim(), pass);
  }

  // ---------------- helpers de partida ----------------

  function owns(dex) { return !!(save && save.owned[dex]); }

  function grant(dex, from) {
    if (!save.owned[dex]) save.owned[dex] = { at: Date.now(), from };
  }

  function ownsShiny(dex) { return !!(save && save.shiny && save.shiny[dex]); }

  /** Favoritos de la colección. */
  function isFav(dex) { return !!(save && save.dfav && +save.dfav[dex] > 0); }
  function setFav(dex, on) {
    if (!save) return;
    save.dfav = save.dfav || {};
    save.dfav[dex] = on ? Date.now() : -Date.now();
    commit();
  }

  /** Mejoras compradas para un Pokémon: { id -> nivel }. */
  function upgradesOf(dex) {
    if (!save) return {};
    save.pupg = save.pupg || {};
    return save.pupg[dex] || (save.pupg[dex] = {});
  }

  /** Da la versión shiny (y la normal, si no la tenía). Devuelve true si es nueva. */
  function grantShiny(dex, from) {
    grant(dex, from);
    if (save.shiny[dex]) return false;
    save.shiny[dex] = { at: Date.now(), from };
    return true;
  }

  return {
    ready, sendCode, verifyCode, playAsGuest, logout, commit, deleteAccount, flush, saveNow,
    register, login,
    owns, grant, ownsShiny, grantShiny, merge, setName, upgradesOf, isFav, setFav,
    onSync(fn) { listeners.add(fn); },
    onLeave(fn) { leaveHooks.push(fn); },
    /** Firebase ya no se usa (paso 2): los módulos de red que aún lo leen se quedan sin nube. */
    fb: null,
    /** La cuenta del servidor ({ uid, kind, name, email, admin }) o null (modo local, sin sesión). */
    get me() { return mode === 'cloud' ? me : null; },
    /** ¿Está disponible lo online? Sesión en el servidor y el servidor ha contestado (también invitados). */
    get online() { return mode === 'cloud' && serverOk && !!me && !!save; },
    /** ¿Cuenta con correo? (amigos y rankings la necesitan; los invitados no.) */
    get emailAccount() { return mode === 'cloud' && !!me && me.kind === 'email'; },
    /** ¿Cuenta de invitado del servidor? (se guarda; sin correo, sólo en este navegador.) */
    get guestAccount() { return mode === 'cloud' && !!me && me.kind === 'guest'; },
    get mode() { return mode; },
    get localReason() { return localReason; },
    get syncState() { return syncState; },
    get user() { return user; },
    get guest() { return guest; },
    get save() { return save; },
    get loggedIn() { return !!save; },
    get storageOk() { return storageOk; },
    START_COINS
  };
})();
