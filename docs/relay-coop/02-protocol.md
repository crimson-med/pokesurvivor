# Protocol

socket.io v4. Room and control events carry small JSON. `sig` carries WebRTC
setup payloads (the same objects `net.js` writes to the Realtime Database
today). `m` carries match traffic on the server path: the existing
`G.NetCodec` binary (or JSON when the codec falls back), which the server never
reads.

## Handshake

```js
io(G.RELAY_URL, {
  auth: { v: 1, token: firebaseIdToken, name, dex, shiny },
  transports: ['websocket'],        // no long-polling
});
```

Rejected with `connect_error` and one of:

| `err.message` | Meaning | Client shows |
| --- | --- | --- |
| `old-version` | `v` doesn't match the server | "Update the game to play together" (`updater.js` reloads) |
| `bad-token` | Token missing, expired or for another project | Refreshes the token once, then "Sign in again" |
| `busy` | `MAX_ROOMS` or socket cap reached | "Group play is full right now. Try again in a few minutes" |

On reconnect the client sends a fresh token (they last one hour).

## Client to server

| Event | Payload | Ack | Who |
| --- | --- | --- | --- |
| `create` | `{ mode: 'direct' \| 'server' }` | `{ ok, code: [d1,d2,d3,d4], room }` | Not in a room |
| `join` | `{ code, hideIp }` | `{ ok, room, sameNet }` or `{ ok: false, err }` | Not in a room |
| `leave` | `{}` | `{ ok }` | Member |
| `member` | `{ name, dex, shiny }` | none | Member |
| `start` | `{}` | `{ ok }` | Host |
| `end` | `{}` | `{ ok }` | Host |
| `kick` | `{ uid }` | `{ ok }` | Host |
| `path` | `(uid, 'direct' \| 'server')` | none | Host |
| `sig` | `(to, payload)` | none | Host to a guest; guest to the host only |
| `m` | `(to, seq, bytes)` | none | Host to a guest; guest to the host only |
| `ack` | `(seq)` | none | Guest to host, server path only |

`join` errors: `not-found`, `full`, `started`, `rate`.

Old API to new event:

| `G.Social` today | Event |
| --- | --- |
| `createRoom` | `create` |
| `joinRoom` | `join` |
| `leaveRoom` | `leave` |
| `refreshMember` | `member` |
| `setPlaying(true / false)` | `start` / `end` |
| `setOpen` | folded into `start` / `end` (a playing room is closed to new joins) |
| `dropMember` | `kick` |

## Server to client

| Event | Payload | When |
| --- | --- | --- |
| `room` | `{ code, state, mode, host, directWaitMs, members: [{ uid, name, dex, shiny, online, path, sameNet }] }` | Any change. Full snapshot, small. |
| `sig` | `(from, payload)` | Forwarded setup message |
| `m` | `(from, seq, bytes)` | Forwarded match message |
| `peer` | `(uid, 'online' \| 'away' \| 'gone')` | A member drops, returns, or their slot expires |
| `closed` | `(why)` | `host-left`, `idle`, `kicked`, `server-restart` |

`from` is always set by the server from the verified token. Clients ignore any
`from` inside payloads.

`sameNet` on a member means "same public IP as the host". The server never
sends an IP address.

## Join sequence, direct first

```
guest  -> join {code}                  ack {room, sameNet}
host   <- room (new member)
host   -> sig {sdp: offer}   -> guest
guest  -> sig {sdp: answer}  -> host
both   -> sig {ice: [...]}   (batched 250 ms, as today)

data channel open within directWaitMs (x 10/6 if sameNet)?
  yes: host -> path(uid, 'direct'),  m over WebRTC
  no:  host -> path(uid, 'server'),  m over the socket
```

In an "Always through server" room the host skips the offer and sends
`path(uid, 'server')` at once.

## Sequence numbers

Every match message between the host and a guest carries a per-pair counter,
starting at 1 when the pair opens and going up by one per message, on either
path.

- The receiver drops any message with `seq` at or below the last it delivered.
- When a direct channel closes mid-run, the sender resends on the server path
  from the oldest message not yet acked (it keeps the last 64 KB). The receiver
  drops the duplicates.
- On the direct path the seq rides inside the frame:
  `{ k: 'sq', n: seq, d: msg }` before encoding. On the server path it's the
  `m` argument.

## Flow control

| Path | `G.Net.busy(u)` is true when |
| --- | --- |
| Direct | `dc.bufferedAmount > 64 KB` (as today) |
| Server | more than 64 KB sent to `u` and not acked yet |

The guest sends `ack(seq)` after every 5 messages, and at least once a second
while messages arrive.

## Limits

| Limit | Value | On breach |
| --- | --- | --- |
| Message size (`m`, `sig`) | 256 KB | Dropped |
| `m` per socket | 120 per second | Dropped; disconnect after 3 seconds over |
| `sig` per socket | 60 per minute | Dropped |
| `join` per IP and per account | 5 per minute | `err: 'rate'` |
| Rooms per account | 1 | `create` closes the old one |
| Away slot | 30 s | Slot freed, `peer(uid, 'gone')` |
| Idle lobby | 30 min | `closed('idle')` |
| Code reuse | 10 min after close | Not picked |
| Heartbeat | ping 10 s, timeout 10 s | Socket closed, `away` |

## Versioning

`v` starts at 1. Any change that an old client can't handle bumps it. The
server accepts the current version and the one before it, so players still on
the old build (in a run, or before `updater.js` reloads them, within 5
minutes) keep playing. Deploy the server first, then the game build. A room
never mixes versions: `join` with a different `v` than the host's gets
`old-version`.
