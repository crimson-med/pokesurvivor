/* ============ config.js: la configuración del servidor (variables de entorno) ============
 * Se lee una sola vez al arrancar. Cada variable tiene su valor por defecto,
 * pensado para desarrollo en local; la imagen de Docker pone lo suyo.
 *
 *   PORT            puerto (8787)
 *   SITE_URL        origen público del juego: comprobación de Origin, cookie
 *                   Secure y enlaces de los correos (http://localhost:<PORT>)
 *   DB_PATH         archivo de SQLite (server/.data/ps.db; /data/ps.db en Docker)
 *   STATIC_DIR      archivos del juego (la raíz del repositorio; /app/public en Docker)
 *   MAIL            'console' (los códigos salen en el registro) o 'smtp'
 *   SMTP_URL        smtps://usuario:clave@smtp.ejemplo.com:465 (con MAIL=smtp)
 *   MAIL_FROM       remitente de los correos
 *   CODE_PEPPER     secreto para los resúmenes de códigos y correos baneados
 *                   (obligatorio con NODE_ENV=production)
 *   ADMIN_EMAILS    correos de los moderadores, separados por comas
 *   STUN_URLS       servidores STUN para el cooperativo directo, separados por
 *                   comas (vacío = sin STUN). Se mandan en /api/config
 *   TRUST_PROXY     proxies de confianza delante del servidor (0). Con 1 o más,
 *                   la IP del jugador sale de X-Forwarded-For (la que puso el
 *                   último proxy): sólo detrás de proxies que la pongan, si no
 *                   cualquiera se la inventa
 *   MAX_ROOMS       salas a la vez (1000)
 *   MAX_SOCKETS     conexiones a la vez (4000)
 *   MAX_MSG_BYTES   tamaño máximo de un sig o m (262144); más grande, se tira
 *   DIRECT_WAIT_MS  espera de la conexión directa que se manda a las salas (6000)
 *   NODE_ENV        'production' en la imagen; si no, modo de desarrollo
 *
 * loadConfig(env) devuelve un objeto congelado; si algo no vale, lanza un error
 * (el servidor no arranca). index.js la llama una vez con process.env.
 */
'use strict';

const path = require('path');

const DEFAULT_STUN = 'stun:stun.l.google.com:19302';
const LOCAL_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

// http://localhost, 127.0.0.1 o [::1], con cualquier puerto: desarrollo.
const isLocalOrigin = o => LOCAL_ORIGIN_RE.test(String(o || ''));

function list(s) {
  return String(s || '').split(',').map(x => x.trim()).filter(Boolean);
}

const num = (v, d) => (v != null && v !== '' && Number.isFinite(+v) && +v > 0 ? +v : d);

function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || '';
  const production = nodeEnv === 'production';
  const port = num(env.PORT, 8787);
  const siteUrl = String(env.SITE_URL || 'http://localhost:' + port).replace(/\/+$/, '');
  let origin;
  try { origin = new URL(siteUrl).origin; } catch { throw new Error('SITE_URL no es una URL: ' + siteUrl); }

  const mail = (env.MAIL || 'console').toLowerCase();
  if (mail !== 'console' && mail !== 'smtp') throw new Error('MAIL tiene que ser console o smtp');
  if (mail === 'smtp' && !env.SMTP_URL) throw new Error('Con MAIL=smtp hace falta SMTP_URL');

  const codePepper = env.CODE_PEPPER || '';
  if (production && !codePepper) throw new Error('Falta CODE_PEPPER (obligatorio con NODE_ENV=production)');

  const hops = Number.isInteger(+env.TRUST_PROXY) && +env.TRUST_PROXY > 0 ? +env.TRUST_PROXY : 0;

  return Object.freeze({
    nodeEnv,
    production,
    dev: !production,
    port,
    siteUrl,
    origin,
    // Secure en la cookie salvo en http://localhost (desarrollo).
    secureCookie: !isLocalOrigin(origin),
    dbPath: env.DB_PATH || path.join(__dirname, '.data', 'ps.db'),
    staticDir: path.resolve(__dirname, env.STATIC_DIR || '..'),
    mail,
    smtpUrl: env.SMTP_URL || '',
    mailFrom: env.MAIL_FROM || 'PokéSurvivor <no-reply@localhost>',
    codePepper,
    adminEmails: Object.freeze(list(env.ADMIN_EMAILS).map(e => e.toLowerCase())),
    // Sin la variable, el STUN gratis de Google; vacía a propósito, ninguno.
    stunUrls: Object.freeze(env.STUN_URLS == null ? [DEFAULT_STUN] : list(env.STUN_URLS)),
    trustProxy: hops,
    maxRooms: num(env.MAX_ROOMS, 1000),
    maxSockets: num(env.MAX_SOCKETS, 4000),
    maxMsgBytes: num(env.MAX_MSG_BYTES, 256 * 1024),
    directWaitMs: num(env.DIRECT_WAIT_MS, 6000),
  });
}

module.exports = { loadConfig, isLocalOrigin, DEFAULT_STUN };
