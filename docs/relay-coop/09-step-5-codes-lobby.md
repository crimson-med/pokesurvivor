# Step 5: room codes and lobby

**Goal:** the lobby from PR 4 is the only lobby. Join by IP and the Same Wi-Fi
tab go.

**Depends on:** step 4. **Uses:** PR 2 (codes), PR 4 (lobby). **Estimate:**
1 day.

## Steps

1. **PR 2 as is:** `tools/make_room_words.js`, `js/data/room-words.js` (759
   Pokémon, append only), `js/net/room-code.js` (`G.RoomCode`). The server's
   `relay/words.js` reads the same file.
2. **`js/ui/social-ui.js`** (PR 4): remove every `G.Relay.enabled` check; the new
   create and join screens, code chips, "Copy code", path badges,
   "Connect locally" and the error texts are always on.
3. **Remove** the Same Wi-Fi tab, join by IP, the `lanHint` banners, their
   markup in `dev.html`, styles in `css/style.css`, and their strings.
4. **Settings:** "Hide my IP in co-op" (`coopHideIp`) always visible for signed
   in players.
5. **Error texts:** add `signed-out` ("Sign in again to play together") and
   `banned`; drop `disabled` and `bad-token`.
6. **Invite button** in the lobby opens the friends list (step 6). Until step 6
   lands, it stays hidden.

## Tests

- `tests/room-code.test.cjs` (PR 2) unchanged.
- `tests/lobby-ui.test.cjs` (PR 4): drop the flag cases, add `signed-out`.
- `tests/i18n.test.cjs` passes after the string removals.

## Done when

- Create shows four Pokémon; typing them on the other machine joins, in any of
  the 7 languages.
- Badges match the real path in both room modes.
- No trace of "join by IP" in the UI or strings.
