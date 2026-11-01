/* ============ db/index.js: la base de datos (SQLite) ============
 * Abre el archivo con better-sqlite3 (WAL, claves ajenas, espera de 5 s) y
 * aplica las migraciones de db/migrations en orden: NNN-nombre.sql, cada una
 * en su transacción, y el número de la última en meta.schema. Las que ya
 * están aplicadas se saltan.
 *
 * open(file, opts) -> { db, prep(sql), schema(), close() }
 *   file  ruta del archivo (se crea la carpeta) o ':memory:' (pruebas)
 *   prep  sentencia preparada, guardada por texto: cada módulo de http/
 *         prepara las suyas (const q = deps.db.prep('SELECT ...')), así los
 *         pasos siguientes no tocan este archivo.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const MIGRATIONS = path.join(__dirname, 'migrations');
const NAME_RE = /^(\d{3})-[\w-]+\.sql$/;

function migrations(dir = MIGRATIONS) {
  return fs.readdirSync(dir)
    .map(f => { const m = NAME_RE.exec(f); return m ? { n: +m[1], file: path.join(dir, f) } : null; })
    .filter(Boolean)
    .sort((a, b) => a.n - b.n);
}

function schemaOf(db) {
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  if (!has) return 0;
  const row = db.prepare("SELECT v FROM meta WHERE k = 'schema'").get();
  return row ? +row.v || 0 : 0;
}

// Aplica las que faltan; devuelve los números aplicados ahora.
function migrate(db, dir = MIGRATIONS) {
  const done = [];
  for (const m of migrations(dir)) {
    if (m.n <= schemaOf(db)) continue;
    const sql = fs.readFileSync(m.file, 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO meta (k, v) VALUES ('schema', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").run(String(m.n));
    })();
    done.push(m.n);
  }
  return done;
}

function open(file, opts = {}) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  const applied = migrate(db, opts.migrations);
  if (applied.length && opts.log !== false) console.log('[db] migraciones aplicadas: ' + applied.join(', '));

  const cache = new Map();
  const prep = sql => {
    let s = cache.get(sql);
    if (!s) { s = db.prepare(sql); cache.set(sql, s); }
    return s;
  };
  return {
    db,
    applied,
    prep,
    schema: () => schemaOf(db),
    // Para /healthz: la base de datos contesta.
    ping() {
      try { return prep('SELECT 1 AS x').get().x === 1; } catch { return false; }
    },
    close() { if (db.open) db.close(); },
  };
}

module.exports = { open, migrate, migrations };
