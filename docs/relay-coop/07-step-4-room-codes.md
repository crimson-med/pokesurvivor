# Step 4: rooms and codes on the server

**Goal:** with `?relay`, rooms live on the server and are joined with a
four-Pokémon code. The Realtime Database isn't used for co-op anymore.
Friends and invites stay in Firestore.

**Depends on:** step 3. **Estimate:** 1.5 days.

## The word list

1. **`tools/make_room_words.js`** builds `js/data/room-words.js` from
   `js/data/pokedex.js` and the name files (`lang-*-names.js`, plus the
   es/en names in the Pokédex):
   - keep a Pokédex number only if its name in **every** language is 3 to 10
     letters, after removing accents, with no spaces, dots, apostrophes,
     dashes or gender signs (Chinese names are checked for length 1 to 5
     characters instead),
   - per language, drop the later of two names with the same first 5 letters
     or one letter apart,
   - output a frozen array of Pokédex numbers in Pokédex order, plus `VERSION`.
2. The file loads in both places: in the game (`G.RoomWords`) and in Node
   (`relay/words.js` reads and evaluates the same file, like the game's tests
   do with `new Function('G', source)`).
3. **Append only.** Re-running the script may add numbers at the end; it fails
   if an existing entry would move or vanish.

Expected size: around 800 (with 800, there are 800^4 ≈ 4.1 × 10^11 codes).

## Server

1. `rooms.create` picks 4 random indexes with `crypto.randomInt`, rejects the
   pick if that code is live or closed within the last 10 minutes, and retries
   (at most 20 times, then `busy`).
2. Code key: the four Pokédex numbers joined with `-`. Order matters.
3. Drop the temporary `create { id }` mode from step 1.
4. One room per account: `create` from someone who already hosts closes the
   old room first.

## Client

1. **Code helpers** (`js/net/relay.js`):
   - `codeNames(code, lang)`: names in the player's language (falls back to
     English).
   - `parseCode(text)`: accepts `pikachu-onix-mew-eevee`, spaces, commas,
     any case, with or without accents, in the player's language or English.
     Returns 4 Pokédex numbers or `null`.
   - `suggest(prefix, lang)`: up to 8 names for autocomplete.
2. **`js/net/social.js`**, when `G.Relay.enabled`:
   - `createRoom(mode)`: `request('create', { mode })`. `room` becomes
     `{ id: codeKey, code, mode, host, isHost, members }`.
   - `joinRoom(code)`: `request('join', { code, hideIp })`. Error strings for
     `not-found`, `full`, `started`, `rate` (step 5 adds translations).
   - `leaveRoom`, `refreshMember`, `dropMember`, `setPlaying` map to
     `leave`, `member`, `kick`, `start`/`end`.
   - `setOpen` becomes a no-op: the server closes joins while playing.
   - Room changes come from the `room` event instead of `watchRoom`.
   - Host disconnect: the server sends `closed('host-left')` after the 30 s
     grace period, mapped to today's `emit('room-closed')`.
   - `rtOn` / `rtOff` and all `rooms/*` reads and writes are skipped.
3. **Invites**: `invite(other)` writes the code into `inv/{to_from}` as `code`
   (next to today's `room`, so old clients still see something).
   `acceptInvite(from)` calls `joinRoom(code)`.
4. **`net.js`**: `open(roomId, isHost, hostUid)` gets the code key as `roomId`.
   Nothing else changes, since signaling and the server path already use the
   socket.

## Tests

- `tests/room-words.test.cjs`: no duplicates, every name valid in every
  language, list order matches the Pokédex.
- `relay/test/rooms.test.js`: codes are unique among live rooms, a closed code
  isn't reused for 10 minutes, order matters.
- `tests/` parse tests: `parseCode` with English, Spanish, French and Chinese
  input, mixed case, accents, wrong count.

## Done when

- Two browsers, `?relay`, create and join by code, play a run.
- Network tab shows no Realtime Database traffic during co-op.
- A friend invite joins the right room.
