# Step 3: server path fallback

**Goal:** with `?relay`, a guest whose direct channel doesn't open in time
plays through the server. No "network blocked" state. This is the step that
fixes co-op.

**Depends on:** step 2. **Estimate:** 1.5 to 2 days.

`net.js` already has a relay path (`ALLOW_RELAY`, `useRelay`, `relayPush`,
and `send()` falling back when the channel isn't open). It was turned off
because the Realtime Database charged per GB. This step points it at the socket.

## Steps

1. **Transport for the relay path** (`js/net/net.js`):
   - `relayPush(to, env)`: when `G.Relay.enabled`, send
     `G.Relay.emit('m', to, seq, bytes)` where `bytes` is
     `G.NetCodec.encode(env.d)` for `k: 'f'` frames, else the JSON string.
     All players on the relay share one protocol version, so binary needs no
     `net-cap` handshake on this path.
   - In `open()`: `G.Relay.on('m', onRelayMsg)`, decode, then `deliver(from, msg)`.
   - `ALLOW_RELAY` becomes `G.Relay.enabled`.
2. **Timeouts**:
   - `DIRECT_TIMEOUT` becomes `room.directWaitMs` (6000), times 10/6 when
     the member has `sameNet`.
   - With the relay on, skip the TURN retry: `useRelay` goes straight to
     `mode = 'relay'`. Leave the TURN code in place for the flag-off path (it's
     removed in step 8).
   - Guest side: the 27 s "host never sent an offer" timer in `open()` becomes
     `directWaitMs + 3000` and ends in `relay`, not `failed`.
3. **Sequence numbers** (see [02-protocol.md](02-protocol.md#sequence-numbers)):
   - Per peer: `p.out` (next seq), `p.inSeen` (last delivered), `p.unacked`
     (list of `[seq, bytes, payload]`, trimmed to 64 KB).
   - Direct: wrap as `{ k: 'sq', n, d }` before encoding. Unwrap in
     `dc.onmessage`.
   - Receiver drops `n <= p.inSeen`.
   - `dc.onclose` mid-run: switch to `relay` and resend `p.unacked` over the
     socket.
4. **Acks and `busy`**:
   - Guest sends `G.Relay.emit('ack', seq)` every 5 messages, and once a second
     while messages arrive, on the server path only.
   - `busy(u)`: direct as today; relay when unacked bytes exceed 64 KB.
5. **Modes**:
   - `mode(u)`: `connecting · direct · relay · away · closed`. `failed` is only
     reachable with the flag off.
   - `G.Relay.on('peer')`: `away` sets `mode = 'away'`, `online` restores the
     previous mode, `gone` calls `drop(u)`.
   - `slow(u)`: true only for `away` and `connecting`, so relay guests get
     15 messages per second.
6. **Report the path**: the host sends `G.Relay.emit('path', u, p.mode)` when a
   guest settles on `direct` or `relay`.
7. **Same Wi-Fi**: `sameNetwork(u)` returns the server's `sameNet` for that
   member when the relay is on (STUN guessing stays for the flag-off path).
8. **`js/net/coop.js`**: comment on `RATE_SLOW` changes from the database relay
   to "away or still connecting". No logic change.

## Tests

`tests/net.test.cjs` with the fake relay:
- direct never opens: after `directWaitMs` the pair is `relay` and frames arrive
- `sameNet` member waits 10 s instead of 6 s
- direct closes mid-run: no frame is lost or delivered twice (send 100 numbered
  frames, kill the channel at 50)
- `busy` turns true at 64 KB unacked and false after an ack
- `slow` is false on `relay`
- with the flag off, behavior matches today (existing tests unchanged)

## Manual check

- Mac and Windows PC, browser IP hiding **on**, `?relay`: the guest joins and
  plays within about 6 s, lobby shows the server path.
- Same with "Connect locally": the guest moves to direct.
- Throttle the guest's network in devtools (Slow 4G) on the server path: no
  growing delay (the `busy` check works).
- Turn the guest's Wi-Fi off for 10 s mid-run: it comes back into the same run.

## Done when

- The manual checks pass and both test suites pass.
- The 30 minute run in [10-step-7-field-test.md](10-step-7-field-test.md) passes
  on the server path with the local relay.
