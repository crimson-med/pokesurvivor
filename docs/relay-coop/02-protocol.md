# Protocol

Two channels to the same server:

- **HTTP API** under `/api/`: accounts, saves, friends, rankings. JSON.
- **Socket** (socket.io 4) under `/socket.io/`: rooms, co-op, invites, online
  status.

Both are authenticated by the `ps_sid` cookie ([04-auth.md](04-auth.md)).

## HTTP rules

- Requests that change something (`POST`, `PUT`, `DELETE`) must send the header
  `X-PS: 1` and an `Origin` equal to `SITE_URL`. Others get `403 csrf`.
- Errors are `{ "error": "<code>" }` with a matching status. The client shows
  a localized text per code.
- Body limit 512 KB on `/api/save`, 16 KB everywhere else.

| Status | Codes |
| --- | --- |
| 400 | `invalid` |
| 401 | `signed-out` |
| 403 | `csrf`, `needs-email`, `banned`, `not-admin` |
| 404 | `not-found` |
| 409 | `conflict`, `taken` |
| 429 | `rate` (with `Retry-After`) |

## Accounts

| Method and path | Body | Answer |
| --- | --- | --- |
| `POST /api/auth/guest` | `{}` | `{ me }`, sets the cookie. With a session already, returns it. |
| `POST /api/auth/email` | `{ email }` | `204` always, so it never tells whether an email has an account. |
| `POST /api/auth/verify` | `{ email, code }` | `{ me, merged }`, sets the cookie. Errors `bad-code`, `expired`, `too-many`. |
| `POST /api/auth/logout` | `{}` | `204`, deletes this session. |
| `POST /api/auth/logout-all` | `{}` | `204`, deletes every session of the account. |
| `GET /api/me` | | `{ me }` or `401` |
| `DELETE /api/me` | `{}` | `204`. Deletes the account, its save, friendships and sessions. |

`me` is `{ uid, kind: 'guest' | 'email', name, email, admin }`. `email` is
masked (`m***@gmail.com`).

## Saves

| Method and path | Body | Answer |
| --- | --- | --- |
| `GET /api/save` | | `{ save, rev, updated }` or `404` |
| `PUT /api/save` | `{ save, rev }` | `{ rev }`. `409 { save, rev }` when the server copy moved on. |

`rev` works like today's `firestore.rules` check: a write passes only when it
names the server's current revision. On `409` the client runs `G.DB.merge` on
the two copies and writes again with the new `rev`.

## Nicknames, profiles, friends

| Method and path | Body | Answer |
| --- | --- | --- |
| `PUT /api/me/name` | `{ name }` | `{ me }`. Same rule as today (`VALID` in `social.js`). Errors `invalid`, `taken`. |
| `PUT /api/profile` | `{ profile }` | `204`. The shape `social.js` `profileData()` builds today. At most once a minute. |
| `GET /api/profile/:uid` | | `{ profile }` |
| `GET /api/friends` | | `[{ uid, name, status: 'ok' \| 'in' \| 'out', online }]` |
| `POST /api/friends` | `{ name }` | `204`. Sends a request (or accepts theirs if they asked first). `needs-email` for guests, `not-found`, `invalid` (yourself), `conflict` (already friends or asked), `too-many` (50 pending), `full` (200 friends). |
| `POST /api/friends/:uid/accept` | `{}` | `204`. `not-found`, `full` (either side has 200). |
| `DELETE /api/friends/:uid` | `{}` | `204`. Removes a friend or a request. |

## Rankings

| Method and path | Body | Answer |
| --- | --- | --- |
| `POST /api/runs` | `{ dex, shiny }` | `{ run }`. Solo run starts now on the server clock. |
| `POST /api/runs/:run/finish` | `{ t, lv, kills, dmg }` | `{ boards: [{ board, rank, best }] }` |
| `GET /api/boards/:board` | `?by=t\|d` | `{ top: [...50], me: { rank, entry } }` |
| `POST /api/reports` | `{ board, id, why }` | `204` |

Co-op runs are opened by the server when the host sends `start` on the socket,
with the room's members at that moment. The host finishes it with the same
`finish` call. See [11-step-7-rankings.md](11-step-7-rankings.md).

## Moderation

`/api/admin/*`, only for emails listed in `ADMIN_EMAILS`: reports, remove an
entry, ban and unban, purge entries over a time. Same features as
`mod-ui.js` today.

## Socket

### Handshake

```js
io({ auth: { v: 2, dex, shiny }, transports: ['websocket'] });
```

Same origin, so the browser sends the cookie. The server reads the session from
it, and the name comes from the account. Rejected with `connect_error`:

| `err.message` | Meaning |
| --- | --- |
| `old-version` | `v` too old. `updater.js` reloads the page. |
| `signed-out` | No valid session. |
| `banned` | Account banned. |
| `busy` | Server at its socket or room cap. |

`v` is 2 (PR 1 used 1, with a Firebase token). The server accepts the current
version and the one before it; a room never mixes versions.

The socket opens after sign-in and stays open in the menu, so online status
and invites are instant.

### Client to server

| Event | Payload | Ack | Who |
| --- | --- | --- | --- |
| `create` | `{ mode: 'direct' \| 'server' }` | `{ ok, code, room }` | Not in a room |
| `join` | `{ code, hideIp }` | `{ ok, room, sameNet }` or `{ ok: false, err }` | Not in a room |
| `leave` | `{}` | `{ ok }` | Member |
| `member` | `{ dex, shiny }` | none | Member |
| `start` | `{}` | `{ ok, run }` | Host |
| `end` | `{}` | `{ ok }` | Host |
| `kick` | `{ uid }` | `{ ok }` | Host |
| `path` | `(uid, 'direct' \| 'server')` | none | Host |
| `sig` | `(to, payload)` | none | Host to a guest; guest to the host |
| `m` | `(to, seq, bytes)` | none | Host to a guest; guest to the host |
| `ack` | `(seq)` | none | Guest, server path only |
| `invite` | `{ to }` | `{ ok }` or `{ ok: false, err }` | Host, to a friend |
| `invite-answer` | `{ from, accept }` | `{ ok, code }` | Invited friend |

`join` errors: `not-found`, `full`, `started`, `rate`. `invite` errors:
`not-friend`, `offline`, `rate`, `not-in-room`, `not-host`, `full`, `started`.
`invite-answer` errors: `expired`, `not-found` (the room is gone).

### Server to client

| Event | Payload | When |
| --- | --- | --- |
| `room` | `{ code, state, mode, host, directWaitMs, members: [{ uid, name, dex, shiny, online, path, sameNet, hideIp }] }` | Any room change |
| `sig` | `(from, payload)` | Forwarded setup message |
| `m` | `(from, seq, bytes)` | Forwarded match message |
| `ack` | `(from, seq)` | To the host |
| `peer` | `(uid, 'online' \| 'away' \| 'gone')` | A member drops, returns, or their slot expires |
| `closed` | `(why)` | `host-left`, `idle`, `kicked`, `server-restart` |
| `invite` | `{ from, name, dex, shiny, code }` | A friend invites you. Expires after 3 minutes. |
| `invite-answer` | `(uid, accept)` | To the host: the invited friend answered |
| `presence` | `(uid, online)` | A friend comes online or leaves |
| `friends` | `()` | Your friends list changed (a request, an accept or a removal): fetch `GET /api/friends` again |

`from` is always set by the server. Every event may carry a trailing socket.io
recovery offset: read arguments by position.

### Sequence numbers, acks, flow control

Unchanged from PR 6:

- Every match message between the host and a guest carries a per-pair counter
  on either path (`{ k: 'sq', n, d }` inside direct frames, the `seq` argument
  on the server path).
- The receiver drops repeats. The sender keeps the last 64 KB and resends what
  wasn't acked when the direct channel closes or a peer comes back.
- The guest sends `ack(seq)` every 5 messages and at least once a second on the
  server path. `G.Net.busy(u)` is true over 64 KB unacked.

## Limits

| Limit | Value | On breach |
| --- | --- | --- |
| Sign in codes per email | 3 per 15 min | `rate` |
| Sign in codes per IP | 10 per hour | `rate` |
| Wrong code tries | 5 per code | code burned, `too-many` |
| Guest accounts per IP | 10 per hour | `rate` |
| API requests per session | 120 per minute | `rate` |
| Socket `m` | 120 per second | dropped; disconnect after 3 s over |
| Socket `sig` | 60 per minute | dropped |
| `join` per IP and account | 5 per minute | `rate` |
| `create` per account | 10 per minute | `rate` |
| `invite` per account | 10 per minute | `rate` |
| Message size (`m`, `sig`) | 256 KB | dropped |
| Away slot | 30 s | slot freed, `peer(uid, 'gone')` |
| Idle lobby | 30 min | `closed('idle')` |
| Code reuse | 10 min after close | not picked |
| Heartbeat | ping 10 s, timeout 10 s | socket closed, `away` |
