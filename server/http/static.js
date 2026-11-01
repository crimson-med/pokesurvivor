/* ============ http/static.js: los archivos del juego y su caché ============
 * Sirve STATIC_DIR (la raíz del repositorio en desarrollo, /app/public en
 * Docker). Cabeceras de caché:
 *   version.json, *.html, sw.js   no-cache (updater.js tiene que ver cada versión)
 *   js/app.min.js, css/           una hora (el HTML ya los pide con ?v=<huella>)
 *   assets/                       un año, inmutable
 *   lo demás                      no-cache (el navegador pregunta con ETag)
 * En desarrollo, / es dev.html (el juego sin construir). Si STATIC_DIR es la
 * raíz del repositorio, server/ (código y base de datos) no se sirve, tampoco
 * con el nombre codificado (%73erver, server%2f...) o en mayúsculas.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');

const NO_CACHE = 'no-cache';
const SHORT = 'public, max-age=3600';
const LONG = 'public, max-age=31536000, immutable';
const SERVER_DIR = path.resolve(__dirname, '..');

const notFound = res => res.status(404).type('text').send('not found');

function cacheFor(rel) {
  const r = rel.split(path.sep).join('/');
  if (r === 'version.json' || r === 'sw.js' || r.endsWith('.html')) return NO_CACHE;
  if (r === 'js/app.min.js' || r.startsWith('css/')) return SHORT;
  if (r.startsWith('assets/')) return LONG;
  return NO_CACHE;
}

// Primera carpeta de la ruta tal y como la verá el disco (descodificada, sin
// mayúsculas ni puntos o espacios al final, que Windows y macOS ignoran).
function firstSegment(p) {
  let d;
  try { d = decodeURIComponent(p); } catch { return ''; }
  const first = d.replace(/\\/g, '/').split('/').filter(Boolean)[0] || '';
  return first.toLowerCase().replace(/[. ]+$/, '');
}

function register(app, deps) {
  const { cfg } = deps;
  const root = cfg.staticDir;

  const hidden = new Set(['node_modules']);
  if (path.resolve(root, 'server') === SERVER_DIR) hidden.add('server');
  app.use((req, res, next) => (hidden.has(firstSegment(req.path)) ? notFound(res) : next()));

  const devHtml = path.join(root, 'dev.html');
  if (cfg.dev && fs.existsSync(devHtml)) {
    app.get('/', (req, res) => {
      res.set('Cache-Control', NO_CACHE);
      res.sendFile(devHtml);
    });
  }

  app.use(express.static(root, {
    dotfiles: 'ignore',
    index: 'index.html',
    setHeaders(res, file) { res.set('Cache-Control', cacheFor(path.relative(root, file))); },
  }));

  app.use((req, res) => notFound(res));
}

module.exports = { register, cacheFor, firstSegment };
