# Step 2: signaling over the socket

**Goal:** with `?relay` in the URL, WebRTC offers, answers and ICE candidates
travel through the server instead of the Realtime Database queue. Rooms are
still created the old way (`social.js`), so the lobby works as today.

**Depends on:** step 1. **Estimate:** 1 day.

## Steps

1. **`js/vendor/socket.io.min.js`**: the socket.io 4.7.5 client build
   (`socket.io.min.js` from the npm package `socket.io-client`). Add
   `<script defer src="js/vendor/socket.io.min.js"></script>` to `dev.html`
   right before `js/net/social.js`, so `tools/build.js` bundles it into
   `app.min.js`. Keep its license header.
2. **`js/net/relay-config.js`**: `G.RELAY_URL = 'https://relay.example'` (set in
   step 6) and a commented local override, like `firebase-config.js`:

   ```js
   // G.RELAY_URL = 'http://192.168.1.20:8787';   // LOCAL ONLY: no subir
   ```

   Add it to `dev.html` next to `firebase-config.js`.
3. **`js/net/relay.js`** (`G.Relay`), loaded before `social.js`:
   - `enabled`: true when `G.RELAY_URL` is set and the URL has `?relay` (until
     step 8).
   - `connect()`: gets a fresh ID token from `G.DB.fb`, opens the socket with
     the handshake in [02-protocol.md](02-protocol.md#handshake), refreshes the
     token on every reconnect.
   - `request(ev, payload)`: emit with ack, returns a Promise, 8 s timeout.
   - `emit(ev, ...args)`, `on(ev, fn)`, `off(ev, fn)`, `state`
     (`'off' | 'connecting' | 'online' | 'offline'`).
   - Error mapping for `old-version`, `bad-token`, `busy` to the messages in
     the protocol doc.
4. **Server room for step 2 only**: when `G.Relay.enabled`, `social.js`
   `createRoom` and `joinRoom` also send `create { id: roomId }` and
   `join { code: roomId }` to the server (step 1's temporary id mode), and
   `leaveRoom` sends `leave`. The RTDB room stays the source of truth for the
   lobby in this step.
5. **`js/net/net.js`**:
   - `signal(to, sig)`: when `G.Relay.enabled`, `G.Relay.emit('sig', to, sig)`
     instead of `relayPush`.
   - In `open()`: when enabled, `G.Relay.on('sig', onRelaySig)` instead of the
     `qref` listener for `sig` messages. `onRelaySig(from, sig)` calls the
     existing `onSignal(from, sig)`.
   - In `close()`: `G.Relay.off('sig', onRelaySig)`.
   - The `start` message still goes through `relayPush` in this step.
6. Leave TURN alone for now.

## Tests

`tests/net.test.cjs`, with a fake `G.Relay` (an object with `emit` and `on`
that links two harnesses in memory):
- host and guest reach `direct` with the relay flag on, and no RTDB `q/` writes
  happen
- ICE batching still sends one `{ cs: [...] }` per 250 ms
- the Same Wi-Fi `lanCandidate` copy still goes out from the host only

## Manual check

- Mac and Windows PC, emulator, local relay, `?relay` on both.
- Network tab: no `rooms/<id>/q` writes during connect.
- With browser IP hiding off: lobby shows connected, the run plays.
- With IP hiding on: same failure as today (expected until step 3).

## Done when

- `node --test tests/` and `cd relay && npm test` pass.
- Without `?relay` nothing changed.
