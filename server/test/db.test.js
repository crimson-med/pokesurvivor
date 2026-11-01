/* ============ db.test.js: SQLite y migraciones ============ */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../db');

const TABLES = ['bans', 'codes', 'entries', 'friendships', 'meta', 'profiles', 'reports', 'runs', 'saves', 'sessions', 'users'];

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-db-'));
  return { dir, file: path.join(dir, 'sub', 'ps.db') };
}

test('en un archivo vacío se aplican las migraciones; la segunda vez se saltan', () => {
  const { dir, file } = tmp();
  try {
    const a = store.open(file, { log: false });
    assert.deepEqual(a.applied, [1]);
    assert.equal(a.schema(), 1);
    const names = a.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(r => r.name);
    assert.deepEqual(names, TABLES);
    a.prep("INSERT INTO users (uid, kind, created, seen) VALUES ('u1', 'guest', 1, 1)").run();
    a.close();

    const b = store.open(file, { log: false });
    assert.deepEqual(b.applied, []);
    assert.equal(b.schema(), 1);
    assert.equal(b.prep('SELECT COUNT(*) AS n FROM users').get().n, 1);
    b.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pragmas: WAL, claves ajenas y espera', () => {
  const { dir, file } = tmp();
  try {
    const s = store.open(file, { log: false });
    assert.equal(s.db.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(s.db.pragma('foreign_keys', { simple: true }), 1);
    assert.equal(s.db.pragma('busy_timeout', { simple: true }), 5000);
    // Borrar la cuenta borra su sesión (ON DELETE CASCADE).
    s.prep("INSERT INTO users (uid, kind, created, seen) VALUES ('u1', 'guest', 1, 1)").run();
    s.prep("INSERT INTO sessions (token_hash, uid, created, seen) VALUES (x'00', 'u1', 1, 1)").run();
    s.prep("DELETE FROM users WHERE uid = 'u1'").run();
    assert.equal(s.prep('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
    s.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('una migración nueva se aplica sola, en orden, y la que falla no deja nada', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-mig-'));
  try {
    for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations'))) {
      fs.copyFileSync(path.join(__dirname, '..', 'db', 'migrations', f), path.join(dir, f));
    }
    fs.writeFileSync(path.join(dir, '002-extra.sql'), 'CREATE TABLE extra (x INTEGER);');
    fs.writeFileSync(path.join(dir, '003-mal.sql'), 'CREATE TABLE otra (x INTEGER); ESTO NO ES SQL;');
    fs.writeFileSync(path.join(dir, 'notas.txt'), 'no es una migración');
    assert.deepEqual(store.migrations(dir).map(m => m.n), [1, 2, 3]);
    assert.throws(() => store.open(':memory:', { migrations: dir, log: false }));

    fs.rmSync(path.join(dir, '003-mal.sql'));
    const s = store.open(':memory:', { migrations: dir, log: false });
    assert.deepEqual(s.applied, [1, 2]);
    assert.equal(s.schema(), 2);
    s.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('prep guarda la sentencia preparada', () => {
  const s = store.open(':memory:', { log: false });
  assert.equal(s.prep('SELECT 1'), s.prep('SELECT 1'));
  assert.equal(s.ping(), true);
  s.close();
  assert.equal(s.ping(), false);
});
