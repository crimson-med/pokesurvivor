/* ============ http/guard.js: lo común de la API (errores, cuerpos, sesión) ============
 * Lo usan todos los módulos de http/ (llega en deps.guard, así una prueba
 * puede poner uno falso). Cómo van las sesiones: docs/relay-coop/04-auth.md.
 *
 * Sueltas (no necesitan la base de datos):
 *   fail(res, status, code)  responde { error: code } con ese estado
 *   body(limit)              lee el JSON del cuerpo, como mucho `limit` bytes
 *                            (16 KB por defecto; /api/save usa SAVE_LIMIT).
 *                            Mal formado: 400 invalid; muy grande: 413 too-big
 *   sha256(...partes), maskEmail(correo)
 *
 * create({ cfg, db, limits, now }) -> el guard de verdad, con lo de arriba y:
 *   session(req, res)  la sesión de la cookie ps_sid: busca sha256(valor) en
 *                      sessions y carga la cuenta. -> { me, uid, hash } o null.
 *                      Con `res`, si su `seen` tiene más de 7 días, lo renueva
 *                      y manda la cookie otra vez (180 días desde ahí)
 *   load               middleware de /api: req.auth = session(req, res) y el
 *                      tope de 120 peticiones por minuto y sesión (429 rate)
 *   needSession        sin sesión: 401 signed-out. Deja req.me
 *                      ({ uid, kind, name, email, admin }, el correo enmascarado)
 *   needEmail          detrás de needSession; un invitado: 403 needs-email
 *   needAdmin          detrás de needSession; si no es moderador: 403 not-admin
 *   csrf               POST, PUT y DELETE con X-PS: 1 y Origin === SITE_URL
 *                      (en desarrollo, también localhost con otro puerto, como
 *                      el socket); si no, 403 csrf
 *   limit(nombre, clave(req))  middleware con uno de los topes de `limits`
 *                      (codeEmail, codeIp, guestIp, api, profile); pasado: 429 rate con
 *                      Retry-After
 *   startSession(req, res, uid)   sesión nueva y su cookie
 *   endSession(res, hash)         borra una sesión y la cookie (dropSession, sólo la sesión)
 *   clearCookie(res), meOf(fila de users), userOf(uid)
 *   fromCookie(cabecera)          para el socket: { uid, name, kind, hash } o null
 *   close()                       para los relojes de limpieza
 */
'use strict';

const crypto = require('crypto');
const express = require('express');
const { parseCookie, stringifySetCookie } = require('cookie');
const { bucket } = require('../relay/limits');
const { isLocalOrigin } = require('../config');

const API_LIMIT = 16 * 1024;
const SAVE_LIMIT = 512 * 1024;
const COOKIE = 'ps_sid';
const DAY = 24 * 3600 * 1000;
const SESSION_MS = 180 * DAY;
const RENEW_MS = 7 * DAY;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;     // 32 bytes en base64url
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

// Topes de docs/relay-coop/02-protocol.md (Limits): [cuántos, ventana en ms].
const LIMITS = {
  codeEmail: [3, 15 * 60 * 1000],   // códigos por correo
  codeIp: [10, 3600 * 1000],        // códigos por IP
  guestIp: [10, 3600 * 1000],       // invitados nuevos por IP
  api: [120, 60 * 1000],            // peticiones por sesión
  profile: [1, 60 * 1000],          // PUT /api/profile por cuenta
};

function fail(res, status, code, extra) {
  if (res.headersSent) return;
  res.status(status).set('Cache-Control', 'no-store').json({ ...extra, error: code });
}

function body(limit = API_LIMIT) {
  const parse = express.json({ limit, strict: true });
  return (req, res, next) => parse(req, res, err => {
    if (!err) return next();
    if (err.type === 'entity.too.large') return fail(res, 413, 'too-big');
    return fail(res, 400, 'invalid');
  });
}

const sha256 = (...parts) => {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(String(p));
  return h.digest();
};

// m***@gmail.com: la primera letra y el dominio.
function maskEmail(e) {
  if (!e) return null;
  const at = e.lastIndexOf('@');
  if (at < 1) return '***';
  return e[0] + '***' + e.slice(at);
}

function create(deps) {
  const { cfg, db } = deps;
  const now = deps.now || Date.now;
  const limits = {};
  for (const k of Object.keys(LIMITS)) {
    const [cap, ms] = (deps.limits && deps.limits[k]) || LIMITS[k];
    limits[k] = bucket(cap, ms, now);
  }
  const clean = setInterval(() => { for (const k in limits) limits[k].clean(); }, 60000);
  clean.unref();

  const q = {
    session: db.prep(`SELECT s.uid, s.seen, u.kind, u.email, u.name FROM sessions s JOIN users u ON u.uid = s.uid
                      WHERE s.token_hash = ?`),
    seen: db.prep('UPDATE sessions SET seen = ? WHERE token_hash = ?'),
    userSeen: db.prep('UPDATE users SET seen = ? WHERE uid = ?'),
    drop: db.prep('DELETE FROM sessions WHERE token_hash = ?'),
    add: db.prep('INSERT INTO sessions (token_hash, uid, created, seen, agent) VALUES (?, ?, ?, ?, ?)'),
    user: db.prep('SELECT uid, kind, email, name FROM users WHERE uid = ?'),
  };

  const meOf = u => ({
    uid: u.uid,
    kind: u.kind,
    name: u.name || null,
    email: maskEmail(u.email),
    admin: !!(u.email && cfg.adminEmails.includes(u.email)),
  });
  const userOf = uid => q.user.get(uid) || null;

  function setCookie(res, token) {
    res.append('Set-Cookie', stringifySetCookie({
      name: COOKIE, value: token, httpOnly: true, secure: cfg.secureCookie,
      sameSite: 'lax', path: '/', maxAge: SESSION_MS / 1000,
    }));
  }
  function clearCookie(res) {
    res.append('Set-Cookie', stringifySetCookie({
      name: COOKIE, value: '', httpOnly: true, secure: cfg.secureCookie,
      sameSite: 'lax', path: '/', maxAge: 0,
    }));
  }

  function tokenOf(header) {
    if (!header) return null;
    let c;
    try { c = parseCookie(String(header)); } catch { return null; }
    const t = c[COOKIE];
    return typeof t === 'string' && TOKEN_RE.test(t) ? t : null;
  }

  // La sesión de una cabecera Cookie. Caducada (180 días sin usarse): se borra.
  function lookup(header) {
    const token = tokenOf(header);
    if (!token) return null;
    const hash = sha256(token);
    const row = q.session.get(hash);
    if (!row) return null;
    const t = now();
    if (t - row.seen > SESSION_MS) { q.drop.run(hash); return null; }
    return { row, hash, token, t };
  }

  function session(req, res) {
    const s = lookup(req.headers.cookie);
    if (!s) return null;
    const { row, hash, token, t } = s;
    if (res && t - row.seen > RENEW_MS) {
      q.seen.run(t, hash);
      q.userSeen.run(t, row.uid);
      setCookie(res, token);
    }
    return { me: meOf(row), uid: row.uid, hash };
  }

  function fromCookie(header) {
    const s = lookup(header);
    if (!s) return null;
    return { uid: s.row.uid, name: s.row.name || s.row.uid, kind: s.row.kind, hash: s.hash.toString('hex') };
  }

  function rate(res, b, key) {
    const ms = b.wait(key);
    res.set('Retry-After', String(Math.max(1, Math.ceil(ms / 1000))));
    fail(res, 429, 'rate');
  }

  function loadInto(req, res) {
    if (req.auth === undefined) req.auth = session(req, res);
    req.me = req.auth ? req.auth.me : null;
  }

  function load(req, res, next) {
    loadInto(req, res);
    if (req.auth) {
      const key = req.auth.hash.toString('hex');
      if (!limits.api.take(key)) return rate(res, limits.api, key);
    }
    next();
  }

  function needSession(req, res, next) {
    loadInto(req, res);
    if (!req.me) return fail(res, 401, 'signed-out');
    next();
  }
  function needEmail(req, res, next) {
    if (!req.me || req.me.kind !== 'email') return fail(res, 403, 'needs-email');
    next();
  }
  function needAdmin(req, res, next) {
    if (!req.me || !req.me.admin) return fail(res, 403, 'not-admin');
    next();
  }

  const originOk = o => !!o && (o === cfg.origin || (!cfg.production && isLocalOrigin(o)));
  function csrf(req, res, next) {
    if (SAFE.has(req.method)) return next();
    if (req.get('x-ps') !== '1' || !originOk(req.get('origin'))) return fail(res, 403, 'csrf');
    next();
  }

  function limit(name, keyOf) {
    const b = limits[name];
    return (req, res, next) => {
      const key = keyOf(req);
      if (key != null && !b.take(key)) return rate(res, b, key);
      next();
    };
  }

  function startSession(req, res, uid) {
    const token = crypto.randomBytes(32).toString('base64url');
    const t = now();
    q.add.run(sha256(token), uid, t, t, String(req.get('user-agent') || '').slice(0, 120) || null);
    q.userSeen.run(t, uid);
    setCookie(res, token);
  }

  function dropSession(hash) { if (hash) q.drop.run(hash); }
  function endSession(res, hash) {
    dropSession(hash);
    clearCookie(res);
  }

  return {
    fail, body, sha256, maskEmail, API_LIMIT, SAVE_LIMIT, limits,
    session, load, needSession, needEmail, needAdmin, csrf, limit,
    startSession, endSession, dropSession, clearCookie, meOf, userOf, fromCookie, originOk,
    close() { clearInterval(clean); },
  };
}

module.exports = { create, fail, body, sha256, maskEmail, API_LIMIT, SAVE_LIMIT, LIMITS, COOKIE, SESSION_MS, RENEW_MS };
