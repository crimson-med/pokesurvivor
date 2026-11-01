/* ============ http/guard.js: lo común de la API (errores, cuerpos, sesión) ============
 * Lo usan todos los módulos de http/ (llega en deps.guard, así una prueba
 * puede poner uno falso).
 *
 *   fail(res, status, code)  responde { error: code } con ese estado
 *   body(limit)              lee el JSON del cuerpo, como mucho `limit` bytes
 *                            (16 KB por defecto; /api/save usa SAVE_LIMIT).
 *                            Mal formado: 400 invalid; muy grande: 413 too-big
 *
 * Pendiente del paso 2 (docs/relay-coop/06-step-2-accounts.md). Por ahora
 * cierran el paso, para que nada quede abierto por error:
 *   needSession   sesión de la cookie ps_sid; deja req.user = me
 *                 ({ uid, kind, name, email, admin }). Sin sesión: 401 signed-out
 *   needEmail     detrás de needSession; un invitado: 403 needs-email
 *   needAdmin     detrás de needSession; si no es moderador: 403 not-admin
 *   csrf          POST, PUT y DELETE con X-PS: 1 y Origin === SITE_URL; si no, 403 csrf
 *                 (por ahora GET, HEAD y OPTIONS pasan y lo demás es 403 csrf)
 */
'use strict';

const express = require('express');

const API_LIMIT = 16 * 1024;
const SAVE_LIMIT = 512 * 1024;

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

// ---------- Paso 2: por ahora, siempre que no ----------
function needSession(req, res) { fail(res, 401, 'signed-out'); }
function needEmail(req, res) { fail(res, 403, 'needs-email'); }
function needAdmin(req, res) { fail(res, 403, 'not-admin'); }
function csrf(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  fail(res, 403, 'csrf');
}

module.exports = { fail, body, needSession, needEmail, needAdmin, csrf, API_LIMIT, SAVE_LIMIT };
