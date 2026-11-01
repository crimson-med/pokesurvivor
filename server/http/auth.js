/* ============ http/auth.js: cuentas y sesiones ============
 * Entrar con un código de 6 cifras por correo, o como invitado (una cuenta
 * del servidor sin correo, atada a la cookie). Todo según
 * docs/relay-coop/04-auth.md; las rutas, en 02-protocol.md (Accounts):
 *
 *   POST   /api/auth/guest       {}               { me }; con sesión, la misma
 *   POST   /api/auth/email       { email, lang }  204 siempre (no dice si hay cuenta)
 *   POST   /api/auth/verify      { email, code }  { me, merged }; bad-code, expired, too-many
 *   POST   /api/auth/logout      {}               204: borra esta sesión
 *   POST   /api/auth/logout-all  {}               204: borra todas las de la cuenta
 *   GET    /api/me                                { me } o 401
 *   DELETE /api/me               {}               204: la cuenta, su partida y sus sesiones
 *   (PUT /api/me/name, el apodo, está en social.js)
 *
 * Invitado que entra con un correo: si el correo es nuevo, el invitado pasa a
 * ser esa cuenta (mismo uid, misma partida); si ya tiene cuenta, se entra en
 * ella, su partida se junta con la del invitado (save-merge.js mergeInto, lo
 * mismo que hace el juego) y el invitado se borra (merged: true). Cuenta el
 * invitado que pidió el código (codes.guest_uid) y lo comprueba con su sesión.
 *
 * El nombre de una cuenta nueva es "Guest" y 4 cifras hasta que elija apodo
 * (social.js): no se reserva (name_lower NULL), así nunca se acaban, y nadie
 * puede elegir uno con esa forma.
 *
 * register(app, deps): deps = { cfg, db, guard, relay, mailer } (ver index.js).
 */
'use strict';

const crypto = require('crypto');
const { mergeInto } = require('../../js/core/save-merge.js');

const CODE_MS = 10 * 60 * 1000;
const MAX_TRIES = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const newUid = () => crypto.randomBytes(16).toString('base64url');
const defaultName = () => 'Guest' + String(crypto.randomInt(10000)).padStart(4, '0');

// Minúsculas, sin espacios alrededor, forma x@y.z y 254 caracteres como mucho.
function cleanEmail(e) {
  if (typeof e !== 'string') return null;
  const s = e.trim().toLowerCase();
  return s.length <= 254 && EMAIL_RE.test(s) ? s : null;
}

function register(app, deps) {
  const { cfg, db, guard, relay, mailer } = deps;
  const now = deps.now || Date.now;
  const b = guard.body();

  const q = {
    addUser: db.prep('INSERT INTO users (uid, kind, email, name, created, seen) VALUES (?, ?, ?, ?, ?, ?)'),
    byEmail: db.prep('SELECT uid, kind, email, name FROM users WHERE email = ?'),
    upgrade: db.prep("UPDATE users SET kind = 'email', email = ? WHERE uid = ? AND kind = 'guest'"),
    delUser: db.prep('DELETE FROM users WHERE uid = ?'),
    putCode: db.prep(`INSERT INTO codes (email, code_hash, expires, tries, guest_uid) VALUES (?, ?, ?, 0, ?)
                      ON CONFLICT (email) DO UPDATE SET code_hash = excluded.code_hash, expires = excluded.expires,
                      tries = 0, guest_uid = excluded.guest_uid`),
    getCode: db.prep('SELECT code_hash, expires, tries, guest_uid FROM codes WHERE email = ?'),
    tryCode: db.prep('UPDATE codes SET tries = tries + 1 WHERE email = ?'),
    delCode: db.prep('DELETE FROM codes WHERE email = ?'),
    oldCodes: db.prep('DELETE FROM codes WHERE expires < ?'),
    sessionsOf: db.prep('DELETE FROM sessions WHERE uid = ?'),
    linked: db.prep('SELECT CASE WHEN a = @uid THEN b ELSE a END AS uid FROM friendships WHERE a = @uid OR b = @uid'),
    save: db.prep('SELECT rev, body FROM saves WHERE uid = ?'),
    putSave: db.prep(`INSERT INTO saves (uid, rev, body, updated) VALUES (?, ?, ?, ?)
                      ON CONFLICT (uid) DO UPDATE SET rev = excluded.rev, body = excluded.body, updated = excluded.updated`),
  };

  const codeHash = (code, email) => guard.sha256(code, email, cfg.codePepper);
  const ipOf = req => req.ip || '';
  const emailOf = req => cleanEmail(req.body && req.body.email);
  const meOf = uid => guard.meOf(guard.userOf(uid));

  function createUser(kind, email) {
    const uid = newUid(), t = now();
    q.addUser.run(uid, kind, email, defaultName(), t, t);
    return uid;
  }

  // La partida del invitado, dentro de la de la cuenta (las dos en el servidor):
  // mergeInto, lo mismo que hace el juego en este caso (y con la misma etiqueta
  // de aparato, así juntarlo otra vez en el navegador no cuenta nada dos veces).
  function mergeSaves(intoUid, guestUid) {
    const g = q.save.get(guestUid);
    if (!g) return;
    let gs;
    try { gs = JSON.parse(g.body); } catch { return; }
    const m = q.save.get(intoUid);
    let ms = null;
    if (m) { try { ms = JSON.parse(m.body); } catch { ms = null; } }
    const out = mergeInto(ms, gs, 'g' + guestUid);
    q.putSave.run(intoUid, (m ? m.rev : 0) + 1, JSON.stringify(out), now());
  }

  // ---------- Invitado ----------
  app.post('/api/auth/guest', b, (req, res, next) => {
    if (req.me) return res.json({ me: req.me });
    next();
  }, guard.limit('guestIp', ipOf), (req, res) => {
    const uid = createUser('guest', null);
    guard.startSession(req, res, uid);
    res.json({ me: meOf(uid) });
  });

  // ---------- Pedir un código ----------
  app.post('/api/auth/email', b, (req, res, next) => {
    if (!emailOf(req)) return guard.fail(res, 400, 'invalid');
    next();
  }, guard.limit('codeIp', ipOf), guard.limit('codeEmail', emailOf), async (req, res, next) => {
    // (Express 4 no recoge los errores de una función async: van a next a mano.)
    try {
      const email = emailOf(req);
      const code = String(crypto.randomInt(1000000)).padStart(6, '0');
      const guest = req.me && req.me.kind === 'guest' ? req.me.uid : null;
      q.oldCodes.run(now());
      q.putCode.run(email, codeHash(code, email), now() + CODE_MS, guest);
      const lang = typeof req.body.lang === 'string' ? req.body.lang.slice(0, 10) : 'en';
      try {
        await mailer.sendCode(email, code, lang);
      } catch (e) {
        console.error('[mail] no se pudo mandar el código: ' + (e && e.message || e));
        q.delCode.run(email);
        return guard.fail(res, 502, 'mail');
      }
      res.status(204).end();
    } catch (e) { next(e); }
  });

  // ---------- Comprobar el código ----------
  app.post('/api/auth/verify', b, (req, res) => {
    const email = emailOf(req);
    const code = req.body && typeof req.body.code === 'string' ? req.body.code.trim() : '';
    if (!email || !/^\d{6}$/.test(code)) return guard.fail(res, 400, 'invalid');
    const row = q.getCode.get(email);
    if (!row) return guard.fail(res, 400, 'expired');
    if (row.expires < now()) { q.delCode.run(email); return guard.fail(res, 400, 'expired'); }
    // Quemado (5 fallos): ni el bueno vale hasta que se pida otro.
    if (row.tries >= MAX_TRIES) return guard.fail(res, 400, 'too-many');
    const want = Buffer.from(row.code_hash), got = codeHash(code, email);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) {
      q.tryCode.run(email);
      return guard.fail(res, 400, row.tries + 1 >= MAX_TRIES ? 'too-many' : 'bad-code');
    }
    q.delCode.run(email);

    const cur = req.auth;                         // sesión que traía (invitado o no)
    // El invitado que pidió el código, si es el que lo comprueba.
    const guest = req.me && req.me.kind === 'guest' && row.guest_uid === req.me.uid ? req.me.uid : null;
    let uid, merged = false, keep = false;
    db.db.transaction(() => {
      const acc = q.byEmail.get(email);
      if (acc) {
        uid = acc.uid;
        if (guest) { mergeSaves(uid, guest); q.delUser.run(guest); merged = true; }
      } else if (guest) {
        q.upgrade.run(email, guest);
        uid = guest;
        keep = true;                              // la misma cuenta: sigue su sesión
      } else {
        uid = createUser('email', email);
      }
    })();

    if (merged) relay.kick(guest);                // el invitado ya no existe
    if (!keep) {
      // Otra cuenta (o ninguna antes): la sesión vieja se cierra y empieza una nueva.
      if (cur && !merged) { guard.dropSession(cur.hash); relay.kick(cur.uid, cur.hash.toString('hex')); }
      res.removeHeader('Set-Cookie');          // (la renovación de la vieja, si la hubo)
      guard.startSession(req, res, uid);
    }
    res.json({ me: meOf(uid), merged });
  });

  // ---------- Salir ----------
  app.post('/api/auth/logout', b, (req, res) => {
    if (req.auth) {
      guard.endSession(res, req.auth.hash);
      relay.kick(req.auth.uid, req.auth.hash.toString('hex'));
    } else guard.clearCookie(res);
    res.status(204).end();
  });

  app.post('/api/auth/logout-all', b, guard.needSession, (req, res) => {
    q.sessionsOf.run(req.auth.uid);
    guard.clearCookie(res);
    relay.kick(req.auth.uid);
    res.status(204).end();
  });

  // ---------- La cuenta ----------
  app.get('/api/me', guard.needSession, (req, res) => {
    res.set('Cache-Control', 'no-store').json({ me: req.me });
  });

  app.delete('/api/me', b, guard.needSession, (req, res) => {
    // Sesiones, partida, perfil y amigos se van con la cuenta (ON DELETE CASCADE).
    // A sus amigos se les avisa después ('friends'): sin la cuenta ya no se sabe quiénes eran.
    const linked = q.linked.all({ uid: req.auth.uid }).map(r => r.uid);
    q.delUser.run(req.auth.uid);
    guard.clearCookie(res);
    relay.kick(req.auth.uid);
    if (relay.send) for (const u of linked) relay.send(u, 'friends');
    res.status(204).end();
  });
}

module.exports = { register, cleanEmail, CODE_MS, MAX_TRIES };
