/* ============ http/social.js: apodos, perfiles y amigos ============
 * Lo que el juego guardaba en Firestore (names/, profiles/, friendships/),
 * ahora en SQLite. Rutas de docs/relay-coop/02-protocol.md (Nicknames,
 * profiles, friends):
 *
 *   PUT    /api/me/name             { name }     { me }; invalid, taken
 *   PUT    /api/profile             { profile }  204; como mucho una vez por minuto (429 rate)
 *   GET    /api/profile/:uid                     { profile } o 404 not-found
 *   GET    /api/friends                          [{ uid, name, status: 'ok'|'in'|'out', online }]
 *   POST   /api/friends             { name }     204: pide amistad (o acepta la que ya te
 *                                                pidió); not-found, invalid (tú mismo),
 *                                                conflict (ya está), too-many, full
 *   POST   /api/friends/:uid/accept {}           204; not-found, full
 *   DELETE /api/friends/:uid        {}           204: quita un amigo o una solicitud
 *
 * Apodo: el VALID de js/net/social.js (3 a 16 letras, números o _), único sin
 * mirar mayúsculas (users.name_lower). "Guest" y 4 cifras es el nombre por
 * defecto (auth.js) y nadie lo puede elegir. Al cambiarlo, el socket lo sabe
 * (relay.rename): la sala y las invitaciones usan el nuevo; a sus amigos les
 * llega 'friends' para que vean el nombre nuevo.
 *
 * Perfil: lo que arma profileData() en social.js, limpio aquí (números con
 * tope, textos cortos, como mucho 3 favoritos y 8 medallas). El nombre que
 * sale es siempre el de la cuenta, no el que mande el juego.
 *
 * Amigos: sólo cuentas con correo (los invitados reciben needs-email; a una
 * sala se les puede invitar igual, con el código). friendships guarda cada
 * pareja una vez (a < b), con quién la pidió (from_uid) y si está aceptada.
 * Como mucho 200 amigos (full, mirando los dos lados) y 50 solicitudes sin
 * contestar enviadas (too-many). "En línea" sólo se dice de los amigos
 * aceptados, y sale del socket (relay.online). Cada cambio avisa al otro por
 * el socket con 'friends' (vuelve a pedir la lista).
 *
 * register(app, deps): deps = { cfg, db, guard, relay } (ver index.js).
 */
'use strict';

// El de social.js (VALID): 3 a 16 letras, números o _.
const NAME_RE = /^[A-Za-z0-9_ñÑáéíóúÁÉÍÓÚ]{3,16}$/;
// Los nombres por defecto (Guest y 4 cifras) no se pueden elegir: son de otros.
const DEFAULT_RE = /^guest\d{4}$/i;
const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_FRIENDS = 200;
const MAX_OUT = 50;
const PROFILE_LIMIT = 8 * 1024;

const pairOf = (x, y) => (x < y ? [x, y] : [y, x]);

// Número entero entre 0 y max (lo demás, 0).
const int = (v, max) => (Number.isFinite(+v) && +v > 0 ? Math.min(Math.floor(+v), max) : 0);
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// El perfil, sólo con lo que el juego sabe pintar (social.js cleanProfile hace lo mismo al leerlo).
function cleanProfile(p) {
  const b = p && typeof p.best === 'object' && p.best ? p.best : {};
  const list = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
  return {
    title: str(p.title, 40),
    favs: list(p.favs, 3).filter(f => f && typeof f === 'object').map(f => ({ dex: int(f.dex, 100000), shiny: f.shiny === true }))
      .filter(f => f.dex > 0),
    best: {
      solo: int(b.solo, 86400), group: int(b.group, 86400), level: int(b.level, 999), bosses: int(b.bosses, 1e9),
      legends: int(b.legends, 999), kills: int(b.kills, 1e12), medals: int(b.medals, 999),
    },
    medals: list(p.medals, 8).map(m => str(m, 40)).filter(Boolean),
  };
}

function register(app, deps) {
  const { db, guard, relay } = deps;
  const now = deps.now || Date.now;
  const b = guard.body();
  const email = [guard.needSession, guard.needEmail];

  const q = {
    setName: db.prep('UPDATE users SET name = ?, name_lower = ? WHERE uid = ?'),
    nameTaken: db.prep('SELECT uid FROM users WHERE name_lower = ? AND uid <> ?'),
    byName: db.prep('SELECT uid, kind, name FROM users WHERE name_lower = ?'),
    putProfile: db.prep(`INSERT INTO profiles (uid, body, updated) VALUES (?, ?, ?)
                         ON CONFLICT (uid) DO UPDATE SET body = excluded.body, updated = excluded.updated`),
    profile: db.prep('SELECT p.body, u.name FROM profiles p JOIN users u ON u.uid = p.uid WHERE p.uid = ?'),
    pair: db.prep('SELECT from_uid, status FROM friendships WHERE a = ? AND b = ?'),
    list: db.prep(`SELECT f.from_uid, f.status, u.uid, u.name FROM friendships f
                   JOIN users u ON u.uid = CASE WHEN f.a = @uid THEN f.b ELSE f.a END
                   WHERE f.a = @uid OR f.b = @uid ORDER BY f.at`),
    okCount: db.prep("SELECT COUNT(*) AS n FROM friendships WHERE (a = @uid OR b = @uid) AND status = 'ok'"),
    outCount: db.prep("SELECT COUNT(*) AS n FROM friendships WHERE from_uid = ? AND status = 'pending'"),
    add: db.prep("INSERT INTO friendships (a, b, from_uid, status, at) VALUES (?, ?, ?, 'pending', ?)"),
    accept: db.prep("UPDATE friendships SET status = 'ok', at = ? WHERE a = ? AND b = ?"),
    del: db.prep('DELETE FROM friendships WHERE a = ? AND b = ?'),
    // Todos con los que hay algo (amigos y solicitudes en los dos sentidos).
    linked: db.prep('SELECT CASE WHEN a = @uid THEN b ELSE a END AS uid FROM friendships WHERE a = @uid OR b = @uid'),
  };

  const okCount = uid => q.okCount.get({ uid }).n;
  const tell = uid => { if (relay && relay.send) relay.send(uid, 'friends'); };

  // ---------- Apodo ----------
  app.put('/api/me/name', b, guard.needSession, (req, res) => {
    const name = req.body && typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!NAME_RE.test(name)) return guard.fail(res, 400, 'invalid');
    if (DEFAULT_RE.test(name)) return guard.fail(res, 409, 'taken');
    const lower = name.toLowerCase();
    if (q.nameTaken.get(lower, req.auth.uid)) return guard.fail(res, 409, 'taken');
    try {
      q.setName.run(name, lower, req.auth.uid);
    } catch (e) {
      if (/UNIQUE/.test(e.message)) return guard.fail(res, 409, 'taken');
      throw e;
    }
    if (relay && relay.rename) relay.rename(req.auth.uid, name);
    // Sus amigos (y solicitudes) ven el nombre nuevo en su lista.
    for (const r of q.linked.all({ uid: req.auth.uid })) tell(r.uid);
    res.json({ me: guard.meOf(guard.userOf(req.auth.uid)) });
  });

  // ---------- Perfil ----------
  app.put('/api/profile', b, ...email, guard.limit('profile', req => req.auth.uid), (req, res) => {
    const p = req.body && req.body.profile;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return guard.fail(res, 400, 'invalid');
    const body = JSON.stringify(cleanProfile(p));
    if (body.length > PROFILE_LIMIT) return guard.fail(res, 400, 'invalid');
    q.putProfile.run(req.auth.uid, body, now());
    res.status(204).end();
  });

  app.get('/api/profile/:uid', guard.needSession, (req, res) => {
    const uid = req.params.uid;
    const row = UID_RE.test(uid) ? q.profile.get(uid) : null;
    if (!row) return guard.fail(res, 404, 'not-found');
    let p = {};
    try { p = JSON.parse(row.body) || {}; } catch { p = {}; }
    res.set('Cache-Control', 'no-store').json({ profile: { name: row.name || '', ...cleanProfile(p) } });
  });

  // ---------- Amigos ----------
  app.get('/api/friends', ...email, (req, res) => {
    const me = req.auth.uid;
    const out = q.list.all({ uid: me }).map(r => {
      const status = r.status === 'ok' ? 'ok' : r.from_uid === me ? 'out' : 'in';
      return { uid: r.uid, name: r.name || '', status, online: status === 'ok' && !!(relay && relay.online && relay.online(r.uid)) };
    });
    res.set('Cache-Control', 'no-store').json(out);
  });

  // Acepta la solicitud que `other` le mandó a `me` (dentro de una transacción). -> código de error o null
  function acceptFrom(me, other) {
    const [a, c] = pairOf(me, other);
    const row = q.pair.get(a, c);
    if (!row || row.status !== 'pending' || row.from_uid !== other) return 'not-found';
    if (okCount(me) >= MAX_FRIENDS || okCount(other) >= MAX_FRIENDS) return 'full';
    q.accept.run(now(), a, c);
    return null;
  }
  const STATUS = { 'not-found': 404, full: 409, conflict: 409, 'too-many': 409, invalid: 400 };

  app.post('/api/friends', b, ...email, (req, res) => {
    const me = req.auth.uid;
    const name = req.body && typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!NAME_RE.test(name)) return guard.fail(res, 400, 'invalid');
    const other = q.byName.get(name.toLowerCase());
    // Un invitado no puede tener amigos: para los demás, como si no existiera.
    if (!other || other.kind !== 'email') return guard.fail(res, 404, 'not-found');
    if (other.uid === me) return guard.fail(res, 400, 'invalid');
    let err = null;
    db.db.transaction(() => {
      const [a, c] = pairOf(me, other.uid);
      const row = q.pair.get(a, c);
      if (row && row.status === 'pending' && row.from_uid === other.uid) { err = acceptFrom(me, other.uid); return; }
      if (row) { err = 'conflict'; return; }
      if (q.outCount.get(me).n >= MAX_OUT) { err = 'too-many'; return; }
      if (okCount(me) >= MAX_FRIENDS) { err = 'full'; return; }
      q.add.run(a, c, me, now());
    })();
    if (err) return guard.fail(res, STATUS[err], err);
    tell(other.uid);
    res.status(204).end();
  });

  app.post('/api/friends/:uid/accept', b, ...email, (req, res) => {
    const other = req.params.uid;
    if (!UID_RE.test(other)) return guard.fail(res, 404, 'not-found');
    let err = null;
    db.db.transaction(() => { err = acceptFrom(req.auth.uid, other); })();
    if (err) return guard.fail(res, STATUS[err], err);
    tell(other);
    res.status(204).end();
  });

  app.delete('/api/friends/:uid', b, ...email, (req, res) => {
    const other = req.params.uid;
    if (!UID_RE.test(other)) return res.status(204).end();
    const [a, c] = pairOf(req.auth.uid, other);
    if (q.del.run(a, c).changes) tell(other);
    res.status(204).end();
  });
}

module.exports = { register, cleanProfile, NAME_RE, DEFAULT_RE, MAX_FRIENDS, MAX_OUT };
