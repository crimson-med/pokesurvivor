# Step 1: relay server (local)

**Goal:** a working server in `relay/` that runs on your Mac, with rooms,
signaling and message forwarding, covered by its own tests. The game doesn't
use it yet.

**Depends on:** step 0. **Estimate:** 1.5 to 2 days.

## Layout

```
relay/
  package.json        socket.io 4.7.5, jose; dev: socket.io-client 4.7.5
  server.js           http server + socket.io, reads env, /healthz
  rooms.js            room logic, no I/O (pure functions + Map), unit-testable
  auth.js             Firebase ID token check
  limits.js           rate limiter (token bucket per socket and per IP)
  words.js            re-exports js/data/room-words.js for Node
  Dockerfile
  fly.toml            (step 6)
  test/
    rooms.test.js     node --test, no network
    server.test.js    starts the server on a random port, real socket.io-client
```

The game's own `tests/` stay free of npm packages. Server tests live in
`relay/test/` and run with `cd relay && npm test`.

## Steps

1. **`relay/package.json`** with `"type": "commonjs"`, `"engines": { "node": ">=20" }`
   and `"scripts": { "start": "node server.js", "test": "node --test test/" }`.
   Pin exact versions.
2. **`rooms.js`**: the `Room` and `Member` shapes from
   [02-protocol.md](02-protocol.md) and these functions, with no sockets inside:
   - `create(uid, info, mode)`, `join(code, uid, info, pubIp)`, `leave(uid)`,
     `start(uid)`, `end(uid)`, `kick(host, uid)`, `markAway(uid)`,
     `markBack(uid)`, `expire(now)`
   - `target(fromUid, to)`: returns the member to forward to, applying "guests only
     reach the host".
   - `snapshot(room)`: what goes in the `room` event.
   - Codes: until step 4, `create` accepts `{ id }` and uses it as the room key
     (the host's uid, like today), so step 2 can test with the current lobby.
3. **`auth.js`**:
   - Production: verify with `jose.jwtVerify` against
     `https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com`
     (`createRemoteJWKSet`), issuer `https://securetoken.google.com/<project>`,
     audience `<project>`. `uid = payload.sub`.
   - Emulator: the Auth emulator signs nothing (`alg: none`). With
     `AUTH_EMULATOR=1`, decode without verifying and require
     `aud === 'demo-pokesurvivor'`. Refuse to start with `AUTH_EMULATOR=1` when
     `NODE_ENV=production`.
4. **`limits.js`**: token buckets with the numbers in
   [02-protocol.md](02-protocol.md#limits). One map per socket, one per IP,
   cleaned every minute.
5. **`server.js`**:
   - `new Server(http, { cors: { origin: ORIGINS }, maxHttpBufferSize: MAX_MSG_BYTES, pingInterval: 10000, pingTimeout: 10000, connectionStateRecovery: { maxDisconnectionDuration: 120000 } })`
   - `io.use` for the handshake: check `v`, then the token. Store `uid`, `name`,
     `dex`, `shiny` and the public IP on `socket.data`. Public IP: the first
     entry of `Fly-Client-IP`, else `X-Forwarded-For`, else the socket address.
   - Wire each event in [02-protocol.md](02-protocol.md) to `rooms.js`, emit
     `room` to all members after every change.
   - `sig` and `m`: look up `target`, emit with the server's `from`. Never
     inspect the payload.
   - `disconnect`: `markAway`, timer 30 s, then `gone`. A reconnect with the
     same `uid` within 30 s takes the slot back.
   - `GET /healthz`: `{ rooms, sockets, paths: { direct, server } }`.
   - On `SIGTERM`: emit `closed('server-restart')` to every room, then exit.
6. **Env**: `PORT` (8787 locally), `ORIGINS`, `FIREBASE_PROJECT`,
   `AUTH_EMULATOR`, `MAX_ROOMS`, `MAX_MSG_BYTES`, `DIRECT_WAIT_MS`.
7. **Dockerfile**: `node:20-alpine`, `npm ci --omit=dev`, `CMD ["node", "server.js"]`.

## Tests

`relay/test/rooms.test.js`:
- create, join up to 4, fifth gets `full`
- join a playing room gets `started`, unless it's a member coming back
- guest's `target` is always the host, whatever `to` says
- host leave closes the room, guest leave frees the slot
- away for 30 s frees the slot, back within 30 s keeps it
- idle lobby closes after 30 min (fake clock)

`relay/test/server.test.js` (real sockets on `127.0.0.1`):
- wrong `v` is refused with `old-version`
- emulator token accepted with `AUTH_EMULATOR=1`, garbage token refused
- host and guest exchange `sig` and `m`, `from` is the sender's uid
- a guest can't reach another guest
- a 300 KB `m` is dropped
- `join` 6 times in a minute gets `rate`
- `/healthz` answers

## Run it locally

```bash
cd relay && npm install && AUTH_EMULATOR=1 FIREBASE_PROJECT=demo-pokesurvivor ORIGINS=http://localhost:8000,http://127.0.0.1:8000 PORT=8787 npm start
```

For the Windows PC, add port 8787 to the port forwarder next to 8000, 9099,
8080 and 9000, and add its origin to `ORIGINS`.

## Done when

- `cd relay && npm test` passes.
- `curl localhost:8787/healthz` answers.
- Nothing in the game changed: `node --test tests/` still passes.
