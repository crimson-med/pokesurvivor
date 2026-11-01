/* ============ http/rank.js: rankings ============
 * Partidas cronometradas por el servidor y las tablas de siempre (los ids y
 * las reglas, en rank-fit.js). Todo según docs/relay-coop/11-step-7-rankings.md;
 * las rutas, en 02-protocol.md (Rankings):
 *
 *   POST /api/runs               { dex, shiny }      { run }: empieza ahora, con el reloj del servidor
 *   POST /api/runs/:run/finish   { t, lv, kills, dmg }
 *                                { id, boards: [{ board, period, rank, best }] }
 *        id: el de la marca (tu uid, o los del equipo ordenados y unidos con "_");
 *        rank: tu puesto por tiempo en esa tabla (null si no estás); best: esta
 *        partida ha mejorado tu marca allí. Errores: not-found, not-yours (en
 *        grupo, sólo el anfitrión), finished (una vez por partida), expired
 *        (más de 3 horas), too-long (t pasa del tiempo real más 10 s)
 *   GET  /api/boards/:board      ?by=t|d&friends=1   { top: [...50], me: { rank, entry } | null }
 *        friends=1: sólo tú y tus amigos (en el histórico, también fuera del top 50)
 *   POST /api/reports            { board, id, why }  204
 *
 * Las de menos de 2 minutos (MIN_T) no las manda el juego, pero valen igual.
 * Sin correo (invitados): needs-email. Una cuenta baneada (users.banned o su
 * correo en bans) termina la partida sin entrar en ninguna tabla; en grupo,
 * basta con uno baneado o sin correo.
 *
 * create({ cfg, db, guard, now }) -> { openCoopRun(room), openSoloRun(uid, dex, shiny),
 *   finish(run, uid, cuerpo), cleanup(), rowOut(fila), close() }
 *   openCoopRun(room): la llama el socket (relay/io.js) con el 'start' del
 *   anfitrión. room.host es su uid y room.members los jugadores (Map o lista
 *   de { uid, name, dex, shiny }). Devuelve el id de la partida (null si el
 *   anfitrión está solo en la sala), que vuelve al
 *   anfitrión en el ack de 'start' ({ ok, run }) y que él usa en finish.
 *   index.js lo pone en deps.rank.
 *
 * Cada noche (se mira cada hora) se borran las tablas diarias de hace más de
 * 40 días, las semanales de más de 20 semanas y las mensuales de más de 24
 * meses (03-data-model.md), las partidas de más de un día y las marcas de
 * las cuentas borradas.
 *
 * register(app, deps): deps = { cfg, db, guard, relay, rank } (ver index.js).
 */
'use strict';

const crypto = require('crypto');
const R = require('../rank-fit');
const { sha256 } = require('./guard');

const RUN_MS = 3 * 3600 * 1000;      // una partida se puede terminar durante 3 horas
const SLACK_S = 10;                  // margen del tiempo real (las pausas sólo lo alargan)
const RUN_KEEP = 24 * 3600 * 1000;   // las partidas, un día
const CLEAN_EVERY = 3600 * 1000;
const RUN_RE = /^[A-Za-z0-9_-]{22}$/;
const ID_MAX = 200;

const newRun = () => crypto.randomBytes(16).toString('base64url');
const int = (v, max) => (Number.isInteger(v) && v >= 0 && v <= max ? v : null);
const parseJson = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

// Una fila de entries tal como sale en la API.
function rowOut(e) {
  const tm = parseJson(e.team, {});
  const list = v => (Array.isArray(v) ? v : []);
  return {
    id: e.id, t: e.t, d: e.dmg, lv: e.lv, kills: e.kills,
    uids: list(tm.uids), names: list(tm.names), dex: list(tm.dex), shiny: list(tm.shiny).map(x => x === true),
  };
}

// Los jugadores de una sala, en una lista (rooms.js los tiene en un Map).
function membersOf(room) {
  const m = room && room.members;
  if (!m) return [];
  return [...(typeof m.values === 'function' && !Array.isArray(m) ? m.values() : m)].filter(x => x && typeof x.uid === 'string');
}

function create(deps) {
  const { cfg, db } = deps;
  const now = deps.now || Date.now;

  const q = {
    addRun: db.prep('INSERT INTO runs (run, mode, uids, team, t0, finished) VALUES (?, ?, ?, ?, ?, NULL)'),
    run: db.prep('SELECT run, mode, uids, team, t0, finished FROM runs WHERE run = ?'),
    close: db.prep('UPDATE runs SET finished = ? WHERE run = ? AND finished IS NULL'),
    oldRuns: db.prep('DELETE FROM runs WHERE t0 < ?'),
    user: db.prep('SELECT uid, kind, email, name, banned FROM users WHERE uid = ?'),
    banned: db.prep('SELECT 1 FROM bans WHERE email_hash = ?'),
    entry: db.prep('SELECT * FROM entries WHERE board = ? AND id = ?'),
    add: db.prep(`INSERT INTO entries (board, id, team, t, lv, kills, dmg, t_at, d_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT (board, id) DO UPDATE SET team = excluded.team, t = excluded.t, lv = excluded.lv,
                  kills = excluded.kills, dmg = excluded.dmg, t_at = excluded.t_at, d_at = excluded.d_at`),
    // Diario, semanal, mensual y por Pokémon: fuera lo que no está en ninguno de los dos top 50.
    trim: db.prep(`DELETE FROM entries WHERE board = @board
                   AND id NOT IN (SELECT id FROM entries WHERE board = @board ORDER BY t DESC, t_at LIMIT @top)
                   AND id NOT IN (SELECT id FROM entries WHERE board = @board AND dmg > 0 ORDER BY dmg DESC, d_at LIMIT @top)`),
    rankT: db.prep('SELECT COUNT(*) AS n FROM entries WHERE board = ? AND (t > ? OR (t = ? AND t_at < ?))'),
    rankD: db.prep('SELECT COUNT(*) AS n FROM entries WHERE board = ? AND dmg > 0 AND (dmg > ? OR (dmg = ? AND d_at < ?))'),
    boards: db.prep('SELECT DISTINCT board FROM entries'),
    dropBoard: db.prep('DELETE FROM entries WHERE board = ?'),
    dropReports: db.prep('DELETE FROM reports WHERE board = ?'),
    // Las marcas de cuentas que ya no existen (DELETE /api/me): fuera, con sus reportes.
    orphans: db.prep(`DELETE FROM entries WHERE EXISTS (SELECT 1 FROM json_each(entries.team, '$.uids') j
                      WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.uid = j.value))`),
    orphanReports: db.prep(`DELETE FROM reports WHERE NOT EXISTS
                            (SELECT 1 FROM entries e WHERE e.board = reports.board AND e.id = reports.id)`),
    getMeta: db.prep('SELECT v FROM meta WHERE k = ?'),
    setMeta: db.prep('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v'),
  };

  // Con correo y sin banear (users.banned o el correo en bans, que queda aunque se borre la cuenta).
  function standing(u) {
    if (!u || u.kind !== 'email' || !u.email) return 'needs-email';
    if (u.banned || q.banned.get(sha256(u.email, cfg.codePepper))) return 'banned';
    return 'ok';
  }

  function openRun(mode, members, host) {
    const ms = members.slice().sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
    const team = {
      host,
      names: ms.map(m => String(m.name || '').slice(0, 32)),
      dex: ms.map(m => (Number.isInteger(m.dex) && m.dex >= 0 ? m.dex : 0)),
      shiny: ms.map(m => m.shiny === true),
    };
    const run = newRun();
    q.addRun.run(run, mode, JSON.stringify(ms.map(m => m.uid)), JSON.stringify(team), now());
    return run;
  }

  function openSoloRun(uid, dex, shiny) {
    const u = q.user.get(uid);
    return openRun('s', [{ uid, name: u && u.name, dex, shiny }], uid);
  }

  /** El 'start' del anfitrión: una partida en grupo con los de la sala ahora (null si está solo). */
  function openCoopRun(room) {
    const ms = membersOf(room);
    if (ms.length < 2 || !room.host || !ms.some(m => m.uid === room.host)) return null;
    return openRun('g', ms, room.host);
  }

  // Guarda la marca en una tabla si mejora el tiempo o el daño. -> { board, period, rank, best }
  function put(board, period, id, team, f, at) {
    const dmg = period === 'p' ? 0 : f.dmg;
    const old = q.entry.get(board, id);
    const bt = f.t > (old ? old.t : 0), bd = dmg > (old ? old.dmg : 0);
    if (bt || bd) {
      // Lo mejor de cada cosa: nivel y derrotados, los del mejor tiempo.
      q.add.run(board, id, team,
        bt ? f.t : old.t, bt ? f.lv : old.lv, bt ? f.kills : old.kills, Math.max(dmg, old ? old.dmg : 0),
        bt ? at : old.t_at, bd ? at : (old ? old.d_at : null));
      if (R.TOP_ONLY.has(period)) q.trim.run({ board, top: R.TOP });
    }
    const cur = q.entry.get(board, id);
    return { board, period, rank: cur ? q.rankT.get(board, cur.t, cur.t, cur.t_at).n + 1 : null, best: (bt || bd) && !!cur };
  }

  class Fail extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }

  /** Termina una partida. -> { boards } o lanza Fail(estado, código). */
  function finish(runId, uid, body) {
    const row = typeof runId === 'string' && RUN_RE.test(runId) ? q.run.get(runId) : null;
    if (!row) throw new Fail(404, 'not-found');
    const team = parseJson(row.team, {});
    if (team.host !== uid) throw new Fail(403, 'not-yours');
    if (row.finished) throw new Fail(409, 'finished');
    const t = now();
    if (t - row.t0 > RUN_MS) throw new Fail(410, 'expired');
    const b = body && typeof body === 'object' ? body : {};
    if (!Number.isFinite(b.t) || b.t < 0) throw new Fail(400, 'invalid');
    const f = R.fit(b);
    if (f.t > (t - row.t0) / 1000 + SLACK_S) throw new Fail(400, 'too-long');
    if (q.close.run(t, runId).changes !== 1) throw new Fail(409, 'finished');

    const uids = parseJson(row.uids, []);
    if (!uids.length || (row.mode === 'g' && uids.length < 2)) return { boards: [] };
    const users = uids.map(u => q.user.get(u));
    const st = users.map(standing);
    if (st.includes('needs-email')) return { boards: [], skipped: 'needs-email' };
    if (st.includes('banned')) return { boards: [] };

    const entryTeam = JSON.stringify({
      uids,
      names: users.map((u, i) => String(u.name || (team.names || [])[i] || '').slice(0, 32)),
      dex: uids.map((u, i) => (team.dex || [])[i] || 0),
      shiny: uids.map((u, i) => (team.shiny || [])[i] === true),
    });
    const id = uids.join('_');
    const boards = R.boardsFor(row.mode, uids.map((u, i) => (team.dex || [])[i] || 0), f.t, new Date(t));
    const out = [];
    db.db.transaction(() => { for (const [board, period] of boards) out.push(put(board, period, id, entryTeam, f, t)); })();
    return { id, boards: out };
  }

  // ---------- Limpieza de cada noche ----------
  function cleanup() {
    const t = now();
    const gone = q.boards.all().map(r => r.board).filter(b => R.expired(b, t));
    db.db.transaction(() => {
      for (const b of gone) { q.dropBoard.run(b); q.dropReports.run(b); }
      if (q.orphans.run().changes) q.orphanReports.run();
      q.oldRuns.run(t - RUN_KEEP);
    })();
    return gone.length;
  }
  function nightly() {
    try {
      if (!db.db.open) return;
      const day = R.periodIds(new Date(now())).d;
      const last = q.getMeta.get('rank.clean');
      if (last && last.v === day) return;
      const n = cleanup();
      q.setMeta.run('rank.clean', day);
      if (n) console.log('[rank] tablas viejas borradas: ' + n);
    } catch (e) { console.error('[rank] limpieza: ' + (e && e.message || e)); }
  }
  // (La primera, un poco después de arrancar: con muchas marcas tarda y no tiene prisa.)
  const first = setTimeout(nightly, 5000);
  const timer = setInterval(nightly, CLEAN_EVERY);
  first.unref(); timer.unref();

  return { openCoopRun, openSoloRun, finish, cleanup, standing, rowOut, Fail,
           close() { clearTimeout(first); clearInterval(timer); } };
}

function register(app, deps) {
  const { db, guard } = deps;
  const rank = deps.rank || create(deps);
  const b = guard.body();

  const q = {
    entry: db.prep('SELECT * FROM entries WHERE board = ? AND id = ?'),
    topT: db.prep('SELECT * FROM entries WHERE board = ? ORDER BY t DESC, t_at LIMIT ?'),
    topD: db.prep('SELECT * FROM entries WHERE board = ? AND dmg > 0 ORDER BY dmg DESC, d_at LIMIT ?'),
    // Las de un grupo de cuentas (tú y tus amigos): las que tienen a alguno de ellos.
    circleT: db.prep(`SELECT * FROM entries e WHERE board = ? AND EXISTS (SELECT 1 FROM json_each(e.team, '$.uids') j
                      WHERE j.value IN (SELECT value FROM json_each(?))) ORDER BY t DESC, t_at LIMIT ?`),
    circleD: db.prep(`SELECT * FROM entries e WHERE board = ? AND dmg > 0 AND EXISTS (SELECT 1 FROM json_each(e.team, '$.uids') j
                      WHERE j.value IN (SELECT value FROM json_each(?))) ORDER BY dmg DESC, d_at LIMIT ?`),
    // Tu mejor marca en grupo (el id lleva tu uid: así casi ninguna fila hay que abrirla).
    mineT: db.prep(`SELECT * FROM entries e WHERE board = @board AND instr(e.id, @uid) > 0 AND EXISTS
                    (SELECT 1 FROM json_each(e.team, '$.uids') j WHERE j.value = @uid) ORDER BY t DESC, t_at LIMIT 1`),
    mineD: db.prep(`SELECT * FROM entries e WHERE board = @board AND dmg > 0 AND instr(e.id, @uid) > 0 AND EXISTS
                    (SELECT 1 FROM json_each(e.team, '$.uids') j WHERE j.value = @uid) ORDER BY dmg DESC, d_at LIMIT 1`),
    friends: db.prep(`SELECT CASE WHEN a = @uid THEN b ELSE a END AS uid FROM friendships
                      WHERE (a = @uid OR b = @uid) AND status = 'ok' LIMIT 200`),
    rankT: db.prep('SELECT COUNT(*) AS n FROM entries WHERE board = ? AND (t > ? OR (t = ? AND t_at < ?))'),
    rankD: db.prep('SELECT COUNT(*) AS n FROM entries WHERE board = ? AND dmg > 0 AND (dmg > ? OR (dmg = ? AND d_at < ?))'),
    addReport: db.prep('INSERT OR IGNORE INTO reports (board, id, by_uid, why, at) VALUES (?, ?, ?, ?, ?)'),
  };
  const now = deps.now || Date.now;

  // ---------- Partidas ----------
  app.post('/api/runs', b, guard.needSession, guard.needEmail, (req, res) => {
    const dex = int(req.body && req.body.dex, 100000);
    if (dex == null) return guard.fail(res, 400, 'invalid');
    res.json({ run: rank.openSoloRun(req.auth.uid, dex, req.body.shiny === true) });
  });

  app.post('/api/runs/:run/finish', b, guard.needSession, guard.needEmail, (req, res) => {
    try {
      res.json(rank.finish(req.params.run, req.auth.uid, req.body));
    } catch (e) {
      if (e instanceof rank.Fail) return guard.fail(res, e.status, e.code);
      throw e;
    }
  });

  // ---------- Tablas ----------
  app.get('/api/boards/:board', guard.needSession, (req, res) => {
    const board = req.params.board;
    const p = R.parse(board);
    if (!p) return guard.fail(res, 400, 'invalid');
    const by = req.query.by === 'd' ? 'd' : 't';
    res.set('Cache-Control', 'no-store');
    // El daño a Arceus no tiene tablas por Pokémon.
    if (by === 'd' && p.period === 'p') return res.json({ top: [], me: null });
    const uid = req.auth.uid;
    let top;
    if (req.query.friends === '1') {
      const circle = JSON.stringify([uid, ...q.friends.all({ uid }).map(r => r.uid)]);
      top = (by === 't' ? q.circleT : q.circleD).all(board, circle, R.TOP);
    } else top = (by === 't' ? q.topT : q.topD).all(board, R.TOP);

    // Tu marca: en solitario la de tu uid; en grupo, la mejor de un equipo con el tuyo.
    let mine;
    if (p.mode === 's') mine = q.entry.get(board, uid);
    else mine = (by === 't' ? q.mineT : q.mineD).get({ board, uid });
    if (mine && by === 'd' && !(mine.dmg > 0)) mine = null;
    let me = null;
    if (mine) {
      const n = by === 't' ? q.rankT.get(board, mine.t, mine.t, mine.t_at).n : q.rankD.get(board, mine.dmg, mine.dmg, mine.d_at).n;
      me = { rank: n + 1, entry: rowOut(mine) };
    }
    res.json({ top: top.map(rowOut), me });
  });

  // ---------- Reportes ----------
  app.post('/api/reports', b, guard.needSession, guard.needEmail, (req, res) => {
    const x = req.body || {};
    const id = typeof x.id === 'string' && x.id && x.id.length <= ID_MAX ? x.id : null;
    if (!R.parse(x.board) || !id) return guard.fail(res, 400, 'invalid');
    if (!q.entry.get(x.board, id)) return guard.fail(res, 404, 'not-found');
    const why = typeof x.why === 'string' ? x.why.trim().slice(0, 200) || null : null;
    q.addReport.run(x.board, id, req.auth.uid, why, now());
    res.status(204).end();
  });
}

module.exports = { register, create, rowOut, membersOf, RUN_MS, SLACK_S };
