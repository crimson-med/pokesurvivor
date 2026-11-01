# Step 1: one server

**Goal:** `server/` serves the game, has SQLite and the socket relay, and
builds into one Docker image. No accounts yet (step 2).

**Uses:** PR 5 (`relay/`), moved to `server/relay/`.
**Estimate:** 1.5 days.

## Steps

1. **Move** `relay/` to `server/`, socket code into `server/relay/` (`rooms.js`,
   `limits.js`, `words.js` unchanged; `server.js` becomes `relay/io.js`
   exporting `attach(httpServer, deps)`).
2. **`server/package.json`** (exact pins, check current versions when
   installing): `express` 4, `socket.io` 4 (latest 4.x, which clears the
   `ws` and `cookie` advisories `npm audit` found on 4.7.5), `better-sqlite3`,
   `nodemailer`, `cookie`. Drop `jose` (no more Firebase tokens). Scripts:
   `start` (`node index.js`), `dev` (serves the repo root), `test`
   (`node --test test/*.test.js`).
3. **`config.js`**: every env var with its default, read once.

   | Env | Default | Use |
   | --- | --- | --- |
   | `PORT` | `8787` | |
   | `SITE_URL` | `http://localhost:8787` | Origin check, cookie `Secure`, links in emails |
   | `DB_PATH` | `.data/ps.db` (`/data/ps.db` in Docker) | |
   | `STATIC_DIR` | `..` in dev, `/app/public` in Docker | Game files |
   | `MAIL`, `SMTP_URL`, `MAIL_FROM` | `console` | [04-auth.md](04-auth.md#email-sender) |
   | `CODE_PEPPER` | required in production | Hashing codes and banned emails |
   | `ADMIN_EMAILS` | empty | |
   | `STUN_URLS` | `stun:stun.l.google.com:19302` | Sent to clients in `/api/config` |
   | `TRUST_PROXY` | `0` | Read the client IP from proxy headers (from PR 5) |
   | `MAX_ROOMS`, `MAX_SOCKETS`, `DIRECT_WAIT_MS` | from PR 5 | |

4. **`db/index.js`**: open SQLite, pragmas, run migrations
   ([03-data-model.md](03-data-model.md)). Export prepared statements per
   module.
5. **`http/static.js`**:
   - `version.json`, `*.html`, `sw.js`: `Cache-Control: no-cache`.
   - `js/app.min.js`, `css/`: short cache (the build already adds `?v=<hash>`).
   - `assets/`: one year, immutable.
   - In dev, `/` serves `dev.html`.
6. **`GET /api/config`**: `{ stunUrls, directWaitMs, version }`. Public.
7. **`GET /healthz`**: `{ ok, rooms, sockets, paths, db: 'ok' }`.
8. **`index.js`**: one `http.Server`, Express on it, `relay/io.js` attached,
   `trust proxy` from `TRUST_PROXY`. On `SIGTERM`: tell rooms
   `closed('server-restart')`, close SQLite, exit.
9. **Temporary socket auth** until step 2: the handshake accepts
   `auth.dev = '<name>'` only when `NODE_ENV !== 'production'`, so the PR 5
   tests keep running.
10. **`server/Dockerfile`**, multi-stage, built from the repo root (`docker build -f server/Dockerfile .`):

    ```dockerfile
    FROM node:22-bookworm-slim AS build
    WORKDIR /src
    COPY . .
    RUN node tools/build.js && node tools/export_data.js
    RUN cd server && npm ci --omit=dev

    FROM node:22-bookworm-slim
    WORKDIR /app
    COPY --from=build /src/server ./server
    COPY --from=build /src/index.html /src/version.json /src/sw.js /src/manifest.webmanifest /src/favicon.ico ./public/
    COPY --from=build /src/js ./public/js
    COPY --from=build /src/css ./public/css
    COPY --from=build /src/assets ./public/assets
    ENV NODE_ENV=production STATIC_DIR=/app/public DB_PATH=/data/ps.db
    VOLUME /data
    EXPOSE 8787
    CMD ["node", "server/index.js"]
    ```

    - `bookworm-slim`, not Alpine: `better-sqlite3` ships prebuilt binaries for
      glibc.
    - `tools/build.js` runs `npx --yes terser@5` and
      `javascript-obfuscator@4.1.1`, so the build stage needs network.
    - Add the SEO pages and guide folders to `public/` only if you keep them
      (step 8).
    - `.dockerignore`: `node_modules`, `server/.data`, `.git`, `.claude`, `docs`.

## Tests (`server/test/`)

- PR 5's room and socket tests, moved.
- static: `version.json` has `no-cache`, an asset has the long cache, `/api/x`
  unknown is `404` JSON.
- migrations run on an empty file and are skipped the second time.
- `/healthz` and `/api/config` answer.

## Done when

- `cd server && npm test` passes.
- `MAIL=console npm run dev`, open `http://localhost:8787`: the game loads and
  plays solo (still in local mode until step 2).
- `docker build -f server/Dockerfile -t ps . && docker run -p 8787:8787 -v ps-data:/data -e CODE_PEPPER=<a long random secret> ps`
  serves the built game. The image runs with `NODE_ENV=production`, so it
  refuses to start without `CODE_PEPPER`.
- `node --test tests/*.test.cjs` passes.
