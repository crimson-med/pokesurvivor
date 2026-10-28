# Step 8: cleanup, on by default

**Goal:** the relay is how co-op works for everyone. The old paths are gone.

**Depends on:** step 7. **Estimate:** 1 day.

## Steps

1. **Flag**: `G.Relay.enabled` becomes "`G.RELAY_URL` is set". Remove the
   `?relay` check.
2. **`js/net/net.js`**: remove
   - TURN: `TURN_API`, `turnUser`, `turnNow`, `turnServers`, `checkTurn`,
     `needTurn`, `turnFirst`, `viaTurn`, `TURN_TIMEOUT`
   - RTDB: `rtdb`, `qref`, the `child_added` listener, `relayPush`'s database
     write, `slot`
   - the `failed` mode and `RETRY_MS`
   - STUN-based same-network guessing (`notePub`, `myPub`, `theirPub`,
     `publicIp`), replaced by the server's `sameNet`
   - Keep: WebRTC, `lanCandidate`, `setLanIp`, `isLocalIp`, the codec.
3. **`js/net/social.js`**: remove `rtOn`, `rtOff`, `watchRoom`,
   `watchRoomDisconnect`, `rejoin`'s database writes, `findLocal`, `lanKey`
   and every `rooms/*` path. Update the file header (no Realtime Database).
4. **`js/ui/social-ui.js`**, `dev.html`, `css/style.css`: remove the Same Wi-Fi
   tab, join-by-IP, the `lanHint` banners, and their styles.
5. **Strings**: remove rows that no screen uses anymore from `lang-en.js` and
   `lang-updates.js`.
6. **Tests**: drop tests for removed code (TURN, RTDB queue, STUN
   same-network). Keep codec and Same Wi-Fi candidate tests.
7. **Changelog**: the entry from [08-step-5-lobby-ui.md](08-step-5-lobby-ui.md#changelog),
   with today's date, es and en.
8. **Docs**: update `docs/MULTIPLAYER_PROTOCOL.md` (signaling and the relay
   path now go through the server) and tick the status list in
   [README.md](README.md).
9. **Build**: `node tools/build.js && node tools/export_data.js && python tools/make_seo_pages.py`.

## For the owner (if this goes upstream)

- A relay deploy ([09-step-6-deploy.md](09-step-6-deploy.md)) and its address
  in `js/net/relay-config.js`.
- Realtime Database: no longer used by co-op. The `rooms` rules can stay
  until every player has updated, then go.
- `ice.pokesurvivor.com` keeps serving ranking seals. Its TURN credentials
  endpoint is no longer called.

## Done when

- `node --test tests/` and `cd relay && npm test` pass.
- `grep -rn "rooms/" js/net` finds nothing.
- The matrix in [10-step-7-field-test.md](10-step-7-field-test.md) still
  passes without `?relay`.
