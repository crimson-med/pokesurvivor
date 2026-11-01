-- ============ 001-init.sql: el esquema entero de la base de datos ============
-- Tablas de docs/relay-coop/03-data-model.md. Los tiempos son milisegundos
-- desde 1970 (Date.now()); los ids, 16 bytes al azar en base64url.
-- Una migración que ya salió no se cambia nunca: se añade otra (002-...).

CREATE TABLE users (
  uid         TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('guest', 'email')),
  email       TEXT UNIQUE,                 -- en minúsculas; NULL en los invitados
  name        TEXT,                        -- apodo público
  name_lower  TEXT UNIQUE,
  created     INTEGER NOT NULL,
  seen        INTEGER NOT NULL,
  banned      INTEGER NOT NULL DEFAULT 0   -- fuera de los rankings
);

CREATE TABLE sessions (
  token_hash  BLOB PRIMARY KEY,            -- sha256 del valor de la cookie
  uid         TEXT NOT NULL REFERENCES users ON DELETE CASCADE,
  created     INTEGER NOT NULL,
  seen        INTEGER NOT NULL,
  agent       TEXT                         -- navegador, corto, para "tus sesiones"
);
CREATE INDEX sessions_uid ON sessions (uid);

CREATE TABLE codes (
  email       TEXT PRIMARY KEY,
  code_hash   BLOB NOT NULL,               -- sha256(código + correo + CODE_PEPPER)
  expires     INTEGER NOT NULL,
  tries       INTEGER NOT NULL DEFAULT 0,
  guest_uid   TEXT                         -- invitado que pide pasar a cuenta, si lo hay
);

CREATE TABLE saves (
  uid         TEXT PRIMARY KEY REFERENCES users ON DELETE CASCADE,
  rev         INTEGER NOT NULL,
  body        TEXT NOT NULL,               -- la partida de G.DB en JSON
  updated     INTEGER NOT NULL
);

CREATE TABLE profiles (
  uid         TEXT PRIMARY KEY REFERENCES users ON DELETE CASCADE,
  body        TEXT NOT NULL,               -- profileData() de social.js en JSON
  updated     INTEGER NOT NULL
);

CREATE TABLE friendships (
  a           TEXT NOT NULL REFERENCES users ON DELETE CASCADE,   -- a < b
  b           TEXT NOT NULL REFERENCES users ON DELETE CASCADE,
  from_uid    TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('pending', 'ok')),
  at          INTEGER NOT NULL,
  PRIMARY KEY (a, b)
);
CREATE INDEX friendships_b ON friendships (b);

CREATE TABLE runs (
  run         TEXT PRIMARY KEY,
  mode        TEXT NOT NULL CHECK (mode IN ('s', 'g')),
  uids        TEXT NOT NULL,               -- JSON, lista ordenada
  team        TEXT NOT NULL,               -- JSON: nombre, dex y shiny de cada uid al empezar
  t0          INTEGER NOT NULL,            -- reloj del servidor al empezar
  finished    INTEGER
);

CREATE TABLE entries (
  board       TEXT NOT NULL,               -- los ids de ranking.js, p. ej. s_d20261029
  id          TEXT NOT NULL,               -- uid, o los uids ordenados unidos con "_"
  team        TEXT NOT NULL,               -- JSON: uids, nombres, dex, shiny
  t           INTEGER NOT NULL,            -- mejor tiempo, en segundos
  lv          INTEGER NOT NULL,
  kills       INTEGER NOT NULL,
  dmg         INTEGER NOT NULL DEFAULT 0,  -- mejor daño a Arceus
  t_at        INTEGER NOT NULL,
  d_at        INTEGER,
  PRIMARY KEY (board, id)
);
CREATE INDEX entries_t ON entries (board, t DESC, t_at);
CREATE INDEX entries_d ON entries (board, dmg DESC, d_at);

CREATE TABLE reports (
  board       TEXT NOT NULL,
  id          TEXT NOT NULL,
  by_uid      TEXT NOT NULL,
  why         TEXT,
  at          INTEGER NOT NULL,
  PRIMARY KEY (board, id, by_uid)
);

CREATE TABLE bans (
  email_hash  BLOB PRIMARY KEY,            -- sha256(correo + CODE_PEPPER); queda aunque se borre la cuenta
  at          INTEGER NOT NULL
);

CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
