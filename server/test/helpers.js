/* ============ helpers.js: sesiones de verdad para las pruebas ============
 * sessionCookie(store, uid, o): crea la cuenta (si no existe) y una sesión en
 * la base de datos, igual que http/guard.js, y devuelve la cabecera Cookie.
 *   o.name  nombre de la cuenta (el uid si no se dice)
 *   o.kind  'guest' o 'email' ('guest')
 */
'use strict';

const crypto = require('crypto');

function sessionCookie(store, uid, o = {}) {
  const t = Date.now();
  const kind = o.kind || 'guest';
  store.prep('INSERT OR IGNORE INTO users (uid, kind, email, name, created, seen) VALUES (?, ?, ?, ?, ?, ?)')
    .run(uid, kind, kind === 'email' ? (o.email || uid + '@example.com') : null, o.name || uid, t, t);
  const token = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(token).digest();
  store.prep('INSERT INTO sessions (token_hash, uid, created, seen, agent) VALUES (?, ?, ?, ?, NULL)').run(hash, uid, t, t);
  return 'ps_sid=' + token;
}

module.exports = { sessionCookie };
