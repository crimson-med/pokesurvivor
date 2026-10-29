# Data model

One SQLite file, `/data/ps.db` in the container (`DB_PATH`). Opened with
`better-sqlite3` in WAL mode, `foreign_keys = ON`, `busy_timeout = 5000`. One
server process, so no locking problems.

Times are milliseconds since 1970 (`Date.now()`). Ids are 16 random bytes in
base64url.

## Tables (`server/db/migrations/001-init.sql`)

```sql
CREATE TABLE users (
  uid         TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('guest', 'email')),
  email       TEXT UNIQUE,                 -- lower case; NULL for guests
  name        TEXT,                        -- public nickname
  name_lower  TEXT UNIQUE,
  created     INTEGER NOT NULL,
  seen        INTEGER NOT NULL,
  banned      INTEGER NOT NULL DEFAULT 0   -- banned from rankings
);

CREATE TABLE sessions (
  token_hash  BLOB PRIMARY KEY,            -- sha256 of the cookie value
  uid         TEXT NOT NULL REFERENCES users ON DELETE CASCADE,
  created     INTEGER NOT NULL,
  seen        INTEGER NOT NULL,
  agent       TEXT                         -- short user agent, for "your sessions"
);
CREATE INDEX sessions_uid ON sessions (uid);

CREATE TABLE codes (
  email       TEXT PRIMARY KEY,
  code_hash   BLOB NOT NULL,               -- sha256(code + email + CODE_PEPPER)
  expires     INTEGER NOT NULL,
  tries       INTEGER NOT NULL DEFAULT 0,
  guest_uid   TEXT                         -- guest asking to upgrade, if any
);

CREATE TABLE saves (
  uid         TEXT PRIMARY KEY REFERENCES users ON DELETE CASCADE,
  rev         INTEGER NOT NULL,
  body        TEXT NOT NULL,               -- the G.DB save as JSON
  updated     INTEGER NOT NULL
);

CREATE TABLE profiles (
  uid         TEXT PRIMARY KEY REFERENCES users ON DELETE CASCADE,
  body        TEXT NOT NULL,               -- social.js profileData() as JSON
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
  uids        TEXT NOT NULL,               -- JSON array, sorted
  team        TEXT NOT NULL,               -- JSON: names, dex, shiny per uid at start
  t0          INTEGER NOT NULL,            -- server clock at start
  finished    INTEGER
);

CREATE TABLE entries (
  board       TEXT NOT NULL,               -- same ids as ranking.js, e.g. s_d20261029
  id          TEXT NOT NULL,               -- uid, or sorted uids joined with "_"
  team        TEXT NOT NULL,               -- JSON: uids, names, dex, shiny
  t           INTEGER NOT NULL,            -- best survival time, seconds
  lv          INTEGER NOT NULL,
  kills       INTEGER NOT NULL,
  dmg         INTEGER NOT NULL DEFAULT 0,  -- best damage to Arceus
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
  email_hash  BLOB PRIMARY KEY,            -- sha256(email + CODE_PEPPER), kept after account deletion
  at          INTEGER NOT NULL
);

CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
```

## Notes

- **Boards** keep the ids `ranking.js` builds today (`s_` / `g_`, day, ISO week,
  month, all time, per Pokémon on all time, in Europe/Madrid time). The
  server computes them from its clock at `finish`, not from the client.
- **Top 50 and rank** come from the indexes: `ORDER BY t DESC LIMIT 50`, and a
  rank is `COUNT(*) WHERE t > mine` plus one. No summary documents needed:
  the Firestore cost tricks in `ranking.js` go.
- **Daily boards** older than 40 days are deleted every night, weekly after 20
  weeks, monthly after 24 months. All time stays.
- **Online status** is not stored: the server knows who has a socket open.
- **Invites** are not stored: they live in memory for 3 minutes.

## Migrations

`server/db/migrations/NNN-name.sql`, applied in order at start inside one
transaction each, version kept in `meta.schema`. Never edit a shipped
migration; add a new one.

## Backups

- Every night the server runs `VACUUM INTO '/data/backup/ps-YYYYMMDD.db'` and
  keeps the last 7.
- Fly.io and Railway volumes also have their own snapshots (check what your
  plan includes).
- For off-site copies, mount a second disk or copy `/data/backup` out with a
  cron job. Litestream to any S3 bucket is an option later.
- Restore: stop the server, put the backup file at `DB_PATH`, start.
