/* ============ index.js: el servidor de PokéSurvivor ============
 * Un solo proceso: un http.Server con Express (el juego y la API /api/) y
 * socket.io (/socket.io/, relay/io.js) encima, y SQLite (db/). La
 * configuración sale de las variables de entorno (config.js).
 *
 *   GET /healthz      { ok, rooms, sockets, paths, bytes, db }
 *   GET /api/config   { stunUrls, directWaitMs, version } (público)
 *   /api/...          antes de nada, guard.csrf y guard.load (la sesión de la
 *                     cookie); luego un módulo por área en http/ (ROUTES),
 *                     cada uno con register(app, deps); cada paso toca sólo el suyo
 *   lo demás          los archivos del juego (http/static.js)
 *
 * Con SIGTERM o SIGINT: closed('server-restart') a las salas, se cierra el
 * socket, el HTTP y SQLite, y se sale.
 *
 * createServer(cfg, opts) -> { app, http, relay, store, guard, listen(port, host), close() }
 * para las pruebas (opts.store, opts.mailer, opts.limits: topes de guard.js,
 * opts.now: el reloj de las sesiones, los códigos y las partidas del ranking, opts.relay);
 * deps.rank = { openCoopRun, ... } (http/rank.js), también en las opciones de attach;
 * `node index.js` lo arranca con process.env.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { loadConfig } = require('./config');
const store = require('./db');
const guardMod = require('./http/guard');
const { createMailer } = require('./mail');
const staticFiles = require('./http/static');
const { attach } = require('./relay/io');

const ROUTES = ['auth', 'save', 'social', 'rank', 'admin'];

// La huella de la versión del juego (version.json de tools/build.js), si está.
function readVersion(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'version.json'), 'utf8')).v || null; } catch { return null; }
}

function createServer(cfg, opts = {}) {
  const db = opts.store || store.open(cfg.dbPath, { log: opts.log });
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', cfg.trustProxy);

  const server = http.createServer(app);
  const guard = guardMod.create({ cfg, db, limits: opts.limits, now: opts.now });
  const mailer = opts.mailer || createMailer(cfg);
  // Las partidas del ranking (http/rank.js): el socket abre las de grupo con openCoopRun.
  const rank = require('./http/rank').create({ cfg, db, guard, now: opts.now });
  const relay = attach(server, { cfg, sessionOf: guard.fromCookie, rank, db, ...opts.relay });
  const deps = { cfg, db, guard, relay, mailer, rank, now: opts.now };
  const version = readVersion(cfg.staticDir);

  app.get('/healthz', (req, res) => {
    const ok = db.ping();
    res.status(ok ? 200 : 503).set('Cache-Control', 'no-store')
      .json({ ok, ...relay.stats(), db: ok ? 'ok' : 'error' });
  });

  app.get('/api/config', (req, res) => {
    res.set('Cache-Control', 'no-cache')
      .json({ stunUrls: cfg.stunUrls, directWaitMs: cfg.directWaitMs, version });
  });

  app.use('/api', guard.csrf, guard.load);
  for (const name of ROUTES) require('./http/' + name).register(app, deps);

  app.use('/api', (req, res) => guard.fail(res, 404, 'not-found'));
  staticFiles.register(app, deps);

  // Un fallo sin capturar: 500 sin detalles para el jugador, el detalle al registro.
  app.use((err, req, res, next) => {
    console.error('[http] ' + req.method + ' ' + req.path + ': ' + (err && err.stack || err));
    if (req.path.startsWith('/api/')) return guard.fail(res, 500, 'server');
    if (!res.headersSent) res.status(500).type('text').send('error');
  });

  function listen(port = cfg.port, host) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve(server.address().port);
      });
    });
  }

  let closing = null;
  function close() {
    if (!closing) {
      closing = relay.close()   // cierra también el http.Server
        .catch(() => {})
        .then(() => { guard.close(); rank.close(); db.close(); });
    }
    return closing;
  }

  return { app, http: server, relay, store: db, guard, deps, listen, close };
}

module.exports = { createServer, ROUTES };

if (require.main === module) {
  let cfg, srv;
  try {
    cfg = loadConfig(process.env);
    srv = createServer(cfg);
  } catch (e) {
    console.error('[server] no arranca: ' + e.message);
    process.exit(1);
  }
  if (cfg.production && !process.env.SITE_URL) {
    console.warn('[server] sin SITE_URL: sólo se aceptan sockets desde ' + cfg.origin);
  }
  srv.listen(cfg.port).then(port => {
    console.log('[server] escuchando en el puerto ' + port + ' (' + (cfg.production ? 'producción' : 'desarrollo') +
      ', juego en ' + cfg.staticDir + ', base de datos en ' + cfg.dbPath + ')');
  }, e => {
    console.error('[server] no se pudo abrir el puerto: ' + e.message);
    process.exit(1);
  });

  let bye = false;
  const stop = sig => {
    if (bye) return;
    bye = true;
    console.log('[server] ' + sig + ': cerrando');
    srv.relay.shutdown('server-restart');
    // Un momento para que salga el aviso; si algo se cuelga, se sale igual.
    setTimeout(() => process.exit(0), 5000).unref();
    setTimeout(() => srv.close().then(() => process.exit(0)), 300);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}
