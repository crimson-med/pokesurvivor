/* ============ http/save.js: la partida guardada en el servidor ============
 * Paso 3 (docs/relay-coop/07-step-3-saves.md). Una fila de `saves` por cuenta
 * (también los invitados): la partida de G.DB en JSON y su versión (rev).
 *
 *   GET /api/save   -> { save, rev, updated }; sin partida, 404 not-found
 *   PUT /api/save   { save, rev } -> { rev }
 *     Pasa sólo si nombra la versión que hay ahora (rev de la fila, o 0 si no
 *     hay fila), y la guardada queda en rev + 1. Si no: 409 conflict con
 *     { save, rev } de la fila (save null si no hay), y el juego las junta
 *     (G.DB.merge) y vuelve a escribir. Es la regla de `saves` de
 *     firestore.rules de antes.
 *     400 invalid: el cuerpo no es { save: objeto con v numérico, rev: entero >= 0 }.
 *     413 too-big: la partida en JSON pasa de guard.SAVE_LIMIT (512 KB).
 *   El contenido no se revisa: la partida es del jugador y los rankings no se
 *   fían de ella (paso 7).
 *
 * register(app, deps): deps = { cfg, db, guard, relay, now } (ver index.js).
 */
'use strict';

function register(app, deps) {
  const { db, guard } = deps;
  const now = deps.now || Date.now;
  const LIMIT = guard.SAVE_LIMIT;

  const q = {
    get: db.prep('SELECT rev, body, updated FROM saves WHERE uid = ?'),
    add: db.prep('INSERT INTO saves (uid, rev, body, updated) VALUES (?, ?, ?, ?)'),
    set: db.prep('UPDATE saves SET rev = ?, body = ?, updated = ? WHERE uid = ? AND rev = ?'),
  };

  // Mirar la versión y escribir, todo en una transacción.
  const put = db.db.transaction((uid, rev, text, t) => {
    const row = q.get.get(uid);
    if (row ? row.rev !== rev : rev !== 0) return { row: row || null };
    if (row) q.set.run(rev + 1, text, t, uid, rev);
    else q.add.run(uid, rev + 1, text, t);
    return { rev: rev + 1 };
  });

  // El cuerpo se guarda tal cual llegó (JSON válido): se manda sin volver a leerlo.
  const answer = row => '{"save":' + row.body + ',"rev":' + row.rev + ',"updated":' + row.updated + '}';

  app.get('/api/save', guard.needSession, (req, res) => {
    const row = q.get.get(req.me.uid);
    if (!row) return guard.fail(res, 404, 'not-found');
    res.set('Cache-Control', 'no-store').type('json').send(answer(row));
  });

  // (El cuerpo entero lleva también rev: un poco más de margen que la partida.)
  app.put('/api/save', guard.csrf, guard.needSession, guard.body(LIMIT + 1024), (req, res) => {
    const b = req.body;
    const save = b && typeof b === 'object' && !Array.isArray(b) ? b.save : null;
    const rev = b ? b.rev : null;
    if (!save || typeof save !== 'object' || Array.isArray(save) || typeof save.v !== 'number' || !Number.isFinite(save.v) ||
        !Number.isSafeInteger(rev) || rev < 0) {
      return guard.fail(res, 400, 'invalid');
    }
    const text = JSON.stringify(save);
    if (Buffer.byteLength(text) > LIMIT) return guard.fail(res, 413, 'too-big');
    const r = put(req.me.uid, rev, text, now());
    if (r.row === undefined) return res.set('Cache-Control', 'no-store').json({ rev: r.rev });
    const row = r.row;
    res.status(409).set('Cache-Control', 'no-store').type('json')
      .send(row ? '{"save":' + row.body + ',"rev":' + row.rev + ',"error":"conflict"}' : '{"save":null,"rev":0,"error":"conflict"}');
  });
}

module.exports = { register };
