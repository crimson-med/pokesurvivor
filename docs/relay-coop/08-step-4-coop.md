# Step 4: co-op over the socket

**Goal:** rooms, WebRTC setup and the server path all go through your server.
No Realtime Database, no TURN, no `?relay` flag.

**Depends on:** step 2. **Uses:** PR 1 (`relay.js`), PR 6 (`net.js`), PR 3
(`social.js` rooms). **Estimate:** 2 days.

## Steps

1. **`js/net/relay.js`** (PR 1):
   - Connect with `io({ auth: { v: 2, dex, shiny }, transports: ['websocket'] })`:
     same origin, no URL, no token, no `bad-token` retry.
   - `enabled` becomes "signed in and served over http(s)" (`G.DB.online`).
   - Open the socket right after sign-in, close it on logout. Reconnects on its
     own.
   - Error codes: `old-version`, `signed-out`, `banned`, `busy`, `unreachable`,
     `timeout`. Drop `disabled` and `bad-token`.
   - Delete `js/net/relay-config.js` and its script tag (`G.RELAY_URL` isn't
     needed on one origin).
   - Keep `ack` in `SERVER_EVENTS`; add `invite` and `presence` (step 6).
2. **`js/net/net.js`** (PR 6): keep the relay branch, delete the other:
   - Signaling only over `G.Relay` `sig`.
   - Delete TURN (`TURN_API`, `turnUser`, `turnNow`, `turnServers`, `checkTurn`,
     `needTurn`, `turnFirst`, `viaTurn`, `TURN_TIMEOUT`), the RTDB queue
     (`rtdb`, `qref`, `child_added`, the database half of `relayPush`, `slot`),
     the `failed` mode and `RETRY_MS`, and the STUN based same-network guess
     (`notePub`, `myPub`, `theirPub`, `publicIp`).
   - ICE servers from `/api/config` `stunUrls`.
   - Keep `lanCandidate`, `setLanIp`, `isLocalIp`, the codec, seq, resend, acks,
     `busy`, modes, `path`, `sameNet`.
   - Rewrite the file header: one server, two paths.
3. **`js/net/social.js` rooms** (PR 3): keep the server room mapping, delete the
   RTDB room code (`rtOn`, `rtOff`, `watchRoom`, `watchRoomDisconnect`,
   `rejoin`'s writes, every `rooms/*` path), and `findLocal`, `lanKey` (join
   by IP goes in step 5). `setLocal` only keeps the LAN IP for
   "Connect locally".
4. **`coop.js`**: update the `RATE_SLOW` comment (no `failed` mode anymore).
   No logic change.
5. **Server** (`relay/io.js`): `create { id }` (PR 5's temporary mode) goes;
   codes only. `start` also opens a co-op run for rankings (step 7 fills it in;
   here it just returns `run: null`).

## Tests

- `tests/net.test.cjs`: PR 6's relay tests become the main suite. Delete the
  TURN, RTDB queue and STUN same-network tests. Keep codec and Same Wi-Fi
  candidate tests.
- `tests/relay.test.cjs`: handshake without a token, new error codes.
- `tests/social-relay.test.cjs`: drop the "relay off" cases.
- `server/test/`: socket tests with real cookies from step 2.

## Done when

- Mac and Windows PC, local server, two email accounts: create, join with the
  code, play a run. Both direct and "Always through server".
- With browser IP hiding on: the guest lands on the server path and plays.
- `grep -rn "rooms/\|firebase\|TURN" js/net` finds nothing.
