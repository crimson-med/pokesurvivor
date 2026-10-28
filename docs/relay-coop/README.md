# Relay co-op: plan

Co-op that connects on the first try on any network, and stays as fast as
possible when friends share a Wi-Fi.

- **Host direct, like old-school console hosting.** The host's browser runs the
  match (as today) and guests connect straight to it over WebRTC.
- **The server is the middleman.** A small socket.io server on Fly.io or Railway
  always handles rooms, room codes and the connection setup. It carries match
  traffic only for guests who can't reach the host directly.
- **No more "your network doesn't allow group play".** A guest whose direct
  connection doesn't open in time plays through the server instead.

Gameplay, `coop.js`, the binary codec, saves, friends and rankings don't change.

Visual version of this spec (with a room code demo):
<https://claude.ai/artifact/NsVzVkq1qb7GThtJrttntt>

## Documents

| File | What it covers |
| --- | --- |
| [01-architecture.md](01-architecture.md) | The two paths, what stays, what goes |
| [02-protocol.md](02-protocol.md) | Every socket.io event, limits, sequences |
| [03-step-0-measure.md](03-step-0-measure.md) | Measure real traffic before building |
| [04-step-1-server.md](04-step-1-server.md) | The `relay/` server, run locally |
| [05-step-2-signaling.md](05-step-2-signaling.md) | WebRTC setup over the socket instead of the Realtime Database |
| [06-step-3-server-path.md](06-step-3-server-path.md) | Fallback: match traffic through the server |
| [07-step-4-room-codes.md](07-step-4-room-codes.md) | Rooms on the server, four-Pokémon codes |
| [08-step-5-lobby-ui.md](08-step-5-lobby-ui.md) | Create/join screens, path badges, strings |
| [09-step-6-deploy.md](09-step-6-deploy.md) | Fly.io or Railway |
| [10-step-7-field-test.md](10-step-7-field-test.md) | Real networks, tuning |
| [11-step-8-cleanup.md](11-step-8-cleanup.md) | Remove TURN and RTDB code, turn it on by default |
| [12-security.md](12-security.md) | Risks and limits |

## Status

Each step lands as its own commit (or PR) and keeps the game working. Until
step 8, everything new sits behind the `?relay` URL flag, so the live behavior
doesn't change.

- [ ] Step 0: measure traffic
- [ ] Step 1: relay server (local)
- [ ] Step 2: signaling over the socket
- [ ] Step 3: server path fallback
- [ ] Step 4: rooms and codes on the server
- [ ] Step 5: lobby UI and strings
- [ ] Step 6: deploy
- [ ] Step 7: field test and tuning
- [ ] Step 8: cleanup, on by default

Rough total: 8 to 11 working days.

## Decisions

| Question | Answer |
| --- | --- |
| Web app or Electron? | Web app. Electron is out of scope. |
| Keep WebRTC direct? | Yes, tried first. |
| Server library | socket.io 4. uWebSockets.js only if load ever needs it (socket.io can run on it without client changes). |
| Hosting | Fly.io or Railway, one instance. **Pick one before step 6.** |
| Room codes | Four Pokémon, stored as Pokédex numbers, shown localized, order matters. |
| Upgrade from server to direct mid-run | No. The next lobby tries direct again. |
| Host migration | Out. If the host leaves, the run ends, as today. |
| `coop-misma-wifi` branch | Kept: its "Connect locally" feature is the same-Wi-Fi speed boost. Join-by-IP is replaced by codes in step 8. |
| Fork or upstream | Open. Real accounts only work on the owner's site (see [01-architecture.md](01-architecture.md#fork-constraint)). |

## Ground rules (from the project's CLAUDE.md)

- Edit `dev.html`, never `index.html`. Build with
  `node tools/build.js && node tools/export_data.js && python tools/make_seo_pages.py`.
- Every game change gets a changelog entry in `js/data/changelog.js` (es and en).
  Server and hosting changes don't.
- New UI strings go in `js/data/lang-en.js` and `js/data/lang-updates.js`
  (all 7 languages). `node --test tests/` fails if one is missing.
- Never enable Firebase Identity Platform. The server checks tokens with public
  keys only.
- Keep `js/core/updater.js` and the `version.json` write in `tools/build.js`.
