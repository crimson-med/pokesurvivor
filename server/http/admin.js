/* ============ http/admin.js: moderación ============
 * Sólo para los correos de ADMIN_EMAILS (guard.needAdmin). Lo mismo que la
 * pantalla de moderación del juego (js/ui/mod-ui.js); 02-protocol.md (Moderation):
 *
 *   GET  /api/admin/reports   { reports: [{ board, id, n, at, why: [...], entry | null }] }
 *                             juntos por marca, las más reportadas primero
 *   POST /api/admin/remove    { board, id }   { removed }: la marca de esa tabla y
 *                             de las tablas de ahora del mismo modo (también las
 *                             de cada Pokémon), y sus reportes
 *   POST /api/admin/ban       { uids: [...] } { removed }: users.banned, el correo
 *                             en bans y fuera sus marcas de las tablas de ahora
 *                             (periodos de ahora e histórico), con sus reportes
 *   POST /api/admin/unban     { uid }         204
 *   GET  /api/admin/bans      { bans: [{ uid, name, coins, t1, t10, owned }] }
 *   POST /api/admin/dismiss   { board, id }   204: borra los reportes de esa marca
 *   POST /api/admin/purge     { over }        { rows, boards }: fuera de todas las
 *                             tablas las marcas de más de `over` segundos
 *
 * register(app, deps): deps = { cfg, db, guard, relay, rank } (ver index.js).
 */
'use strict';

const R = require('../rank-fit');
const { rowOut } = require('./rank');

const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ID_MAX = 200;

function register(app, deps) {
  const { cfg, db, guard } = deps;
  const now = deps.now || Date.now;
  const b = guard.body();
  const admin = [guard.needSession, guard.needAdmin];

  const q = {
    reports: db.prep(`SELECT board, id, COUNT(*) AS n, MAX(at) AS at, json_group_array(why) AS why
                      FROM reports GROUP BY board, id ORDER BY n DESC, at DESC LIMIT 200`),
    entry: db.prep('SELECT * FROM entries WHERE board = ? AND id = ?'),
    delEntry: db.prep('DELETE FROM entries WHERE board = ? AND id = ?'),
    monBoards: db.prep('SELECT board FROM entries WHERE id = ? AND board GLOB ?'),
    delReports: db.prep('DELETE FROM reports WHERE board = ? AND id = ?'),
    user: db.prep('SELECT uid, email FROM users WHERE uid = ?'),
    ban: db.prep('UPDATE users SET banned = 1 WHERE uid = ?'),
    unban: db.prep('UPDATE users SET banned = 0 WHERE uid = ?'),
    addBan: db.prep('INSERT OR IGNORE INTO bans (email_hash, at) VALUES (?, ?)'),
    delBan: db.prep('DELETE FROM bans WHERE email_hash = ?'),
    // Las marcas de una cuenta (solitario o en un equipo), en cualquier tabla.
    entriesOf: db.prep(`SELECT board, id FROM entries e WHERE EXISTS
                        (SELECT 1 FROM json_each(e.team, '$.uids') j WHERE j.value = ?)`),
    bans: db.prep(`SELECT u.uid, u.name, s.body FROM users u LEFT JOIN saves s ON s.uid = u.uid
                   WHERE u.banned = 1 ORDER BY u.seen DESC LIMIT 100`),
    over: db.prep('SELECT COUNT(*) AS rows, COUNT(DISTINCT board) AS boards FROM entries WHERE t > ?'),
    purge: db.prep('DELETE FROM entries WHERE t > ?'),
    orphans: db.prep(`DELETE FROM reports WHERE NOT EXISTS
                      (SELECT 1 FROM entries e WHERE e.board = reports.board AND e.id = reports.id)`),
  };

  const emailHash = e => guard.sha256(e, cfg.codePepper);
  const boardOf = req => (req.body && R.parse(req.body.board) ? req.body.board : null);
  const idOf = req => {
    const id = req.body && req.body.id;
    return typeof id === 'string' && id && id.length <= ID_MAX ? id : null;
  };

  // Las tablas de ahora: los periodos de hoy de los dos modos; el histórico (y por Pokémon) siempre.
  function current() {
    const ids = R.boardIds(new Date(now()));
    const set = new Set();
    for (const m of ['s', 'g']) for (const p of ['d', 'w', 'm']) set.add(m + '_' + ids[p]);
    return b => set.has(b) || /^[sg]_all4(_p\d+)?$/.test(b);
  }

  function drop(board, id) {
    const n = q.delEntry.run(board, id).changes;
    q.delReports.run(board, id);
    return n;
  }

  app.get('/api/admin/reports', ...admin, (req, res) => {
    const out = q.reports.all().map(r => {
      const e = q.entry.get(r.board, r.id);
      let why = [];
      try { why = JSON.parse(r.why).filter(Boolean).slice(0, 5); } catch { why = []; }
      return { board: r.board, id: r.id, n: r.n, at: r.at, why, entry: e ? rowOut(e) : null };
    });
    res.set('Cache-Control', 'no-store').json({ reports: out });
  });

  app.post('/api/admin/remove', b, ...admin, (req, res) => {
    const board = boardOf(req), id = idOf(req);
    if (!board || !id) return guard.fail(res, 400, 'invalid');
    const mode = board[0], ids = R.boardIds(new Date(now()));
    const boards = new Set([board, ...['d', 'w', 'm', 'a'].map(p => mode + '_' + ids[p])]);
    let removed = 0;
    db.db.transaction(() => {
      for (const r of q.monBoards.all(id, mode + '_' + R.ALL + '_p*')) boards.add(r.board);
      for (const x of boards) removed += drop(x, id);
    })();
    res.json({ removed });
  });

  app.post('/api/admin/ban', b, ...admin, (req, res) => {
    const uids = req.body && Array.isArray(req.body.uids) ? req.body.uids : null;
    if (!uids || !uids.length || uids.length > 4 || !uids.every(u => typeof u === 'string' && UID_RE.test(u))) {
      return guard.fail(res, 400, 'invalid');
    }
    const isCurrent = current();
    let removed = 0;
    db.db.transaction(() => {
      for (const uid of uids) {
        const u = q.user.get(uid);
        if (!u) continue;
        q.ban.run(uid);
        if (u.email) q.addBan.run(emailHash(u.email), now());
        for (const e of q.entriesOf.all(uid)) if (isCurrent(e.board)) removed += drop(e.board, e.id);
      }
    })();
    res.json({ removed });
  });

  app.post('/api/admin/unban', b, ...admin, (req, res) => {
    const uid = req.body && req.body.uid;
    if (typeof uid !== 'string' || !UID_RE.test(uid)) return guard.fail(res, 400, 'invalid');
    const u = q.user.get(uid);
    if (!u) return guard.fail(res, 404, 'not-found');
    q.unban.run(uid);
    if (u.email) q.delBan.run(emailHash(u.email));
    res.status(204).end();
  });

  app.get('/api/admin/bans', ...admin, (req, res) => {
    const n = v => (Number.isFinite(+v) && +v > 0 ? Math.floor(+v) : 0);
    const out = q.bans.all().map(r => {
      let s = {};
      try { s = JSON.parse(r.body || '{}') || {}; } catch { s = {}; }
      const tk = s.tickets || {};
      return { uid: r.uid, name: r.name || '?', coins: n(s.coins), t1: n(tk.t1), t10: n(tk.t10),
               owned: s.owned && typeof s.owned === 'object' ? Object.keys(s.owned).length : 0 };
    });
    res.set('Cache-Control', 'no-store').json({ bans: out });
  });

  app.post('/api/admin/dismiss', b, ...admin, (req, res) => {
    const board = boardOf(req), id = idOf(req);
    if (!board || !id) return guard.fail(res, 400, 'invalid');
    q.delReports.run(board, id);
    res.status(204).end();
  });

  app.post('/api/admin/purge', b, ...admin, (req, res) => {
    const over = req.body && req.body.over;
    if (!Number.isInteger(over) || over < 60 || over > 86400) return guard.fail(res, 400, 'invalid');
    let r;
    db.db.transaction(() => {
      r = q.over.get(over);
      q.purge.run(over);
      q.orphans.run();
    })();
    res.json({ rows: r.rows, boards: r.boards });
  });
}

module.exports = { register };
