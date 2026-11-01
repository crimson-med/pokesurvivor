/* ============ ranking.js: tiempo aguantado y daño a Arceus ============
 * Las tablas viven en el servidor del juego (server/http/rank.js, SQLite), que
 * cronometra cada partida con su reloj: al empezar se abre la partida y al
 * acabar se manda el resultado, y el servidor no acepta más tiempo que el que
 * ha pasado de verdad (más 10 s). Todo por G.Api:
 *
 *   POST /api/runs { dex, shiny }              al empezar en solitario -> { run }
 *   en grupo, el 'start' del anfitrión por el socket abre la partida con los
 *   de la sala; su id llega aquí con setCoopRun(run)
 *   POST /api/runs/:run/finish { t, lv, kills, dmg }   al acabar (solitario, o
 *                                              el anfitrión en grupo) -> { boards }
 *   GET  /api/boards/:tabla?by=t|d[&friends=1] { top, me: { rank, entry } }
 *   POST /api/reports { board, id, why }
 *   /api/admin/*                               la moderación (js/ui/mod-ui.js)
 *
 * tabla = modo + periodo (los ids los calcula también el servidor, en
 * server/rank-fit.js: tienen que ser los mismos):
 *   s_d20261008a   solitario, hoy             g_...      en grupo
 *   s_w2026-41a    semana ISO                 s_m202610a mes
 *   s_all4         histórico                  s_all4_p25 histórico sólo con Pikachu
 * Diario, semanal, mensual y por Pokémon guardan sólo el top 50 (de tiempo o
 * de daño): fuera, "aún no estás en el top 50". El histórico guarda a todos y
 * da tu puesto exacto. El daño a Arceus no tiene tablas por Pokémon.
 * id = tu uid (solitario) o los uid del equipo ordenados y unidos con "_".
 * Los periodos se cuentan en hora de España (Europe/Madrid).
 *
 * En el navegador:
 *   - tus mejores marcas por tabla: si una partida no mejora ninguna, no se
 *     manda nada, y el aviso de "nueva mejor marca" sale de la respuesta
 *   - lo leído de tablas de periodos ya pasados se guarda 2 h; las de ahora se
 *     leen cada vez que se abren
 * Las partidas de menos de 2 minutos no se mandan. Los invitados (sin correo)
 * no entran: "Añade un correo para salir en el ranking."
 */
G.Ranking = (() => {
  const TZ = 'Europe/Madrid';
  const PERIODS = [['d', 'Diario'], ['w', 'Semanal'], ['m', 'Mensual'], ['a', 'Histórico']];
  // Periodos en los que sólo se guarda el top 50 ('p' = histórico de un Pokémon).
  const TOP_ONLY = new Set(['d', 'w', 'm', 'p']);
  const TOP = 50;
  const MIN_T = 120;          // menos de 2 minutos no se manda
  const MIN_T_MON = 600;      // el histórico de cada Pokémon, desde 10 minutos
  const TTL = 2 * 3600 * 1000;

  const me = () => (G.DB.online && G.DB.me) || null;
  const uidOf = () => (me() ? me().uid : '');
  const hasEmail = () => !!me() && me().kind === 'email';

  // ---------------- periodos ----------------

  function madridDate(date) {
    const p = {};
    for (const x of new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)) p[x.type] = x.value;
    return { y: +p.year, m: +p.month, d: +p.day };
  }

  /** Semana ISO (lunes a domingo) de una fecha y-m-d. */
  function isoWeek(y, m, d) {
    const t = new Date(Date.UTC(y, m - 1, d));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return { year: t.getUTCFullYear(), week: Math.ceil(((t - y0) / 86400000 + 1) / 7) };
  }

  const ALL = 'all4';                     // histórico
  /** Los periodos de una fecha, sin la letra de las tablas (también para las misiones, progress.js). */
  function periodIds(date = new Date()) {
    const { y, m, d } = madridDate(date);
    const w = isoWeek(y, m, d);
    const p2 = n => String(n).padStart(2, '0');
    return { d: 'd' + y + p2(m) + p2(d), w: 'w' + w.year + '-' + p2(w.week), m: 'm' + y + p2(m), y: 'y' + y, a: ALL };
  }

  // Nombres de las tablas: los de periodIds() con una "a" detrás (el histórico ya cambia de nombre, ALL).
  const GEN = 'a';
  function boardIds(date) {
    const p = periodIds(date);
    return Object.assign({}, p, { d: p.d + GEN, w: p.w + GEN, m: p.m + GEN, y: p.y + GEN });
  }

  /** El filtro por Pokémon sólo existe en el histórico. */
  function board(mode, period, dex, date) {
    return mode + '_' + boardIds(date)[period] + (dex && period === 'a' ? '_p' + dex : '');
  }

  /** Las tablas de una partida: cada periodo y, desde 10 min, el histórico de cada Pokémon. */
  function boardsFor(mode, dexes, t, date) {
    const ids = boardIds(date);
    const out = PERIODS.map(([p]) => [mode + '_' + ids[p], p]);
    if (t >= MIN_T_MON) for (const d of new Set(dexes)) out.push([mode + '_' + ALL + '_p' + d, 'p']);
    return out;
  }

  /** ¿Es una tabla de los periodos de ahora (o histórica)? Si no, ya no cambia. */
  function isCurrent(b) {
    if (/^[sg]_all4(_p\d+)?$/.test(b)) return true;
    const cur = Object.values(boardIds());
    return cur.some(p => b.split('_')[1] === p);
  }

  // ---------------- caché en el navegador (sólo periodos pasados) ----------------

  const mem = new Map();                 // clave -> { at, v }
  function cacheGet(k) {
    let c = mem.get(k);
    if (!c) { try { c = JSON.parse(localStorage.getItem('ps.rk.c.' + k) || 'null'); } catch (e) { c = null; } if (c) mem.set(k, c); }
    return c && Date.now() - c.at < TTL ? c.v : undefined;
  }
  function cacheSet(k, v) {
    const c = { at: Date.now(), v };
    mem.set(k, c);
    try { localStorage.setItem('ps.rk.c.' + k, JSON.stringify(c)); } catch (e) { /* lleno */ }
  }
  /** Borra lo caducado (la caché del navegador no crece sin límite). */
  function cachePrune() {
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith('ps.rk.c.')) continue;
        const c = JSON.parse(localStorage.getItem(k) || 'null');
        if (!c || Date.now() - c.at > TTL) localStorage.removeItem(k);
      }
    } catch (e) { /* nada */ }
  }
  cachePrune();

  // Tus mejores marcas por tabla: "tabla:id" el tiempo y "tabla:id#d" el daño a Arceus.
  const bestKey = () => 'ps.rk.best3.' + uidOf();
  function bests() { try { return JSON.parse(localStorage.getItem(bestKey()) || '{}'); } catch (e) { return {}; } }
  function saveBests(b) {
    // Sólo se conservan las tablas de los periodos actuales y las históricas.
    for (const k of Object.keys(b)) if (!isCurrent(k.split(':')[0])) delete b[k];
    try { localStorage.setItem(bestKey(), JSON.stringify(b)); } catch (e) { /* lleno */ }
  }

  // ---------------- partidas ----------------

  /*
   * Nivel, derrotados y daño a Arceus dentro de lo posible: los mismos topes que
   * aplica el servidor (server/rank-fit.js). Aquí sólo sirven para recordar tu
   * marca tal como la guarda él.
   */
  function fit(r) {
    const t = Math.min(86400, Math.max(1, r.t | 0));
    // Daño a Arceus: sólo desde el minuto 30, hasta 50.000 por segundo de Sentencia.
    const dmg = t < 1800 ? 0 : Math.max(0, Math.min(Math.floor(r.dmg || 0), (t - 1799) * 50000));
    return { t, lv: Math.max(1, Math.min(r.lv | 0, 10 + Math.floor(t / 4))), kills: Math.max(0, Math.min(r.kills | 0, 100 + t * 12)), dmg };
  }

  let solo = null;            // la partida en solitario de ahora: promesa del id (o null)
  let coopRun = null;         // la partida en grupo (la abre el 'start' del anfitrión)

  /** Al empezar a jugar: en solitario, abre la partida en el servidor (en grupo, info = null). */
  function runStarted(info) {
    solo = null;
    if (!info) return;
    coopRun = null;
    if (!hasEmail()) return;
    solo = G.Api.post('/api/runs', { dex: info.dex | 0, shiny: !!info.shiny }).then(r => (r && r.run) || null, () => null);
  }

  /** Anfitrión en grupo: el id de la partida del ack de 'start' (social.js). */
  function setCoopRun(run) { coopRun = typeof run === 'string' && run ? run : null; }

  function noServer() { G.UI.toast('Esta partida no ha podido entrar en el ranking: no se pudo conectar con el servidor.', 4200); }
  function needsEmail() { G.UI.toast('Añade un correo para salir en el ranking.', 4200); }

  function announce(better) {
    if (!better.length) return;
    const names = { d: 'de hoy', w: 'de la semana', m: 'del mes', a: 'histórico' };
    const best = PERIODS.map(p => p[0]).filter(p => better.includes(p)).pop();
    G.UI.toast('¡Nueva mejor marca ' + names[best] + ' en el ranking!', 3400);
  }

  /** ¿Mejora alguna tabla según lo que sabe este navegador? */
  function improves(boards, id, f) {
    const known = bests();
    return boards.some(([b, p]) => f.t > (known[b + ':' + id] || 0) || (p !== 'p' && f.dmg > (known[b + ':' + id + '#d'] || 0)));
  }

  /** Manda el final de la partida y apunta lo que ha quedado. -> periodos mejorados */
  async function finish(run, boards, id, r) {
    const f = fit(r);
    if (!improves(boards, id, f)) return [];
    let res;
    try {
      res = await G.Api.post('/api/runs/' + encodeURIComponent(run) + '/finish', { t: r.t | 0, lv: r.lv | 0, kills: r.kills | 0, dmg: Math.floor(r.dmg || 0) });
    } catch (e) {
      if (e.code === 'needs-email') needsEmail();
      else if (e.code === 'offline' || e.code === 'http' || e.code === 'server' || e.code === 'rate') noServer();
      else console.warn('[Ranking] no entra:', e.code || e.message);
      return [];
    }
    if (res && res.skipped === 'needs-email') return [];
    // (En grupo, el id que dice el servidor: los de la sala al empezar, aunque alguno se haya ido.)
    if (res && typeof res.id === 'string' && res.id) id = res.id;
    const known = bests();
    const better = [];
    for (const x of (res && res.boards) || []) {
      const k = x.board + ':' + id, p = x.period;
      known[k] = Math.max(known[k] || 0, f.t);
      if (p !== 'p') known[k + '#d'] = Math.max(known[k + '#d'] || 0, f.dmg);
      if (x.best && p && p !== 'p' && !better.includes(p)) better.push(p);
    }
    saveBests(known);
    announce(better);
    return better;
  }

  async function submitSolo(r) {
    const run = solo;
    solo = null;
    if (!me() || r.t < MIN_T) return [];
    if (!hasEmail()) { needsEmail(); return []; }
    const id = await run;
    if (!id) { noServer(); return []; }
    return finish(id, boardsFor('s', [r.dex], r.t), uidOf(), r);
  }

  /** La manda el anfitrión; el servidor ya sabe quién jugaba (lo apuntó en 'start'). */
  async function submitGroup(r) {
    // (Si social.js aún no llama a setCoopRun, el id que guarde él del ack de 'start'.)
    const run = coopRun || (G.Social && typeof G.Social.runId === 'string' ? G.Social.runId : null);
    coopRun = null;
    if (!me() || r.t < MIN_T) return [];
    if (!hasEmail()) { needsEmail(); return []; }
    // Sin partida: la sala no la abrió (el anfitrión solo, o el servidor sin rankings).
    if (!run) { console.warn('[Ranking] partida en grupo sin id del servidor'); return []; }
    const ms = (r.members || []).slice().sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
    return finish(run, boardsFor('g', ms.map(m => m.dex), r.t), ms.map(m => m.uid).join('_'), r);
  }

  // ---------------- leer ----------------

  // Fila de otro jugador: todo limpio (ver G.U.int / str), venga lo que venga.
  const rowOf = v => {
    const U = G.U; v = v || {};
    return { id: U.str(String(v.id || ''), 200), t: U.int(v.t, 86400), d: U.int(v.d, 1e15), uids: U.list(v.uids, 4).map(x => U.str(x, 128)),
             names: U.list(v.names, 4).map(x => U.str(x, 24)), dex: U.list(v.dex, 4).map(x => U.int(x, 2000)),
             shiny: U.list(v.shiny, 4).map(x => x === true), lv: U.int(v.lv, 999) || 1, kills: U.int(v.kills, 1e9) };
  };

  /** Una tabla: { top: [filas], me: { rank, entry } | null }. Las de ahora, siempre del servidor. */
  const inflight = new Map();             // url -> lectura en curso (la lista y tu puesto la comparten)
  function fetchBoard(b, by, friends) {
    const url = '/api/boards/' + encodeURIComponent(b) + '?by=' + by + (friends ? '&friends=1' : '');
    const past = !isCurrent(b);
    const ck = 'B:' + uidOf() + ':' + url;
    if (past) { const c = cacheGet(ck); if (c !== undefined) return Promise.resolve(c); }
    if (!inflight.has(url)) {
      inflight.set(url, G.Api.get(url).then(res => {
        const v = { top: ((res && res.top) || []).map(rowOf),
                    me: res && res.me && res.me.entry ? { rank: G.U.int(res.me.rank, 1e9), entry: rowOf(res.me.entry) } : null };
        if (past) cacheSet(ck, v);
        return v;
      }).finally(() => inflight.delete(url)));
    }
    return inflight.get(url);
  }

  /**
   * Mejores marcas de una tabla (por tiempo).
   * @param friendsOnly  sólo tú y tus amigos (en el histórico, también fuera del top 50)
   */
  async function top(mode, period, dex, friendsOnly) {
    if (!me()) return [];
    return (await fetchBoard(board(mode, period, dex), 't', !!friendsOnly)).top.slice(0, TOP);
  }

  /** Tu puesto por tiempo (aunque no salgas en el top). -> { pos, t, row } | { out: true } | null */
  async function myRank(mode, period, dex) {
    if (!me()) return null;
    const { me: m } = await fetchBoard(board(mode, period, dex), 't', false);
    const topOnly = TOP_ONLY.has(period) || !!dex;
    if (!m) return topOnly ? { out: true } : null;
    if (topOnly && m.rank > TOP) return { out: true };
    return { pos: m.rank, t: m.entry.t, row: m.entry };
  }

  /** Daño a Arceus: el top 50 y tu puesto. No hay por Pokémon. -> { rows, me: { pos, d } | { out } | null } */
  async function topDmg(mode, period, friendsOnly) {
    if (!me()) return { rows: [], me: null };
    const b = board(mode, period);
    const [list, mine] = await Promise.all([fetchBoard(b, 'd', !!friendsOnly), friendsOnly ? fetchBoard(b, 'd', false) : null]);
    const m = (mine || list).me;
    return { rows: list.top.slice(0, TOP), me: m && m.rank <= TOP ? { pos: m.rank, d: m.entry.d } : { out: true } };
  }

  /** Al borrar la cuenta: olvida lo de este navegador (el servidor quita sus marcas en la limpieza de cada noche). */
  async function removeMine() {
    try { localStorage.removeItem(bestKey()); localStorage.removeItem(repKey()); } catch (e) { /* nada */ }
  }

  // ---------------- reportes y moderación ----------------

  /** Reporta una marca sospechosa (una vez por marca y jugador). -> true si se ha enviado (o ya lo estaba) */
  const repKey = () => 'ps.rk.rep.' + uidOf();
  function reported() { try { return new Set(JSON.parse(localStorage.getItem(repKey()) || '[]')); } catch (e) { return new Set(); } }
  async function report(b, row) {
    if (!hasEmail()) return false;
    const key = b + '__' + row.id;
    const done = reported();
    if (!done.has(key)) {
      // (Si ya lo habías reportado desde otro aparato, el servidor lo cuenta una vez: da igual.)
      try { await G.Api.post('/api/reports', { board: b, id: row.id, why: '' }); } catch (e) { return false; }
      done.add(key);
      try { localStorage.setItem(repKey(), JSON.stringify([...done].slice(-300))); } catch (e) { /* lleno */ }
    }
    return true;
  }

  // Moderación: los correos de ADMIN_EMAILS del servidor (G.DB.me.admin). La pantalla, js/ui/mod-ui.js.
  const isAdmin = () => !!(G.DB.me && G.DB.me.admin);

  /** Admin: los reportes, juntos por marca (los más reportados primero). */
  async function reports() {
    const res = await G.Api.get('/api/admin/reports');
    return ((res && res.reports) || []).map(g => ({
      board: G.U.str(g.board, 40), e: G.U.str(g.id, 200), n: G.U.int(g.n, 1e6), at: G.U.int(g.at, 1e15),
      why: G.U.list(g.why, 5).map(x => G.U.str(x, 200)), info: g.entry ? rowOf(g.entry) : null
    }));
  }

  /** Admin: quita una marca de su tabla y de las de ahora del mismo modo (y sus reportes). */
  function removeEntry(b, e) { return G.Api.post('/api/admin/remove', { board: b, id: e }); }
  /** Admin: banea a estas cuentas del ranking (y fuera sus marcas de las tablas de ahora). */
  function ban(uids) { return G.Api.post('/api/admin/ban', { uids }); }
  /** Admin: vuelve a dejar que una cuenta salga en el ranking. */
  function unban(uid) { return G.Api.post('/api/admin/unban', { uid }); }
  /** Admin: borra los reportes de una marca. */
  function dismiss(b, e) { return G.Api.post('/api/admin/dismiss', { board: b, id: e }); }
  /** Admin: quita de todas las tablas las marcas de más de `maxT` segundos. -> { rows, boards } */
  function purgeAbove(maxT) { return G.Api.post('/api/admin/purge', { over: maxT }); }
  /** Admin: cuentas baneadas del ranking. */
  async function bannedAccounts() {
    const res = await G.Api.get('/api/admin/bans');
    return ((res && res.bans) || []).map(a => ({ uid: G.U.str(a.uid, 128), name: G.U.str(a.name, 24) || '?', coins: G.U.int(a.coins),
      t1: G.U.int(a.t1), t10: G.U.int(a.t10), owned: G.U.int(a.owned) }));
  }

  return { PERIODS, periodIds, boardIds, board, boardsFor, fit, runStarted, setCoopRun, submitSolo, submitGroup, top, topDmg, myRank,
           removeMine, report, reported, isAdmin, reports, removeEntry, ban, unban, dismiss, purgeAbove, bannedAccounts };
})();
