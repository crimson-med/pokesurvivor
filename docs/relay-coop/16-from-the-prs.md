# What we keep from PRs 1 to 6

The six PRs on `crimson-med/pokesurvivor` (base `coop-misma-wifi`) were built
for the earlier plan: an add-on to the original game, with Firebase and the old
paths kept behind `?relay`. Most of the code still fits. The Firebase parts
and the flag go.

| PR | What it is | Keep | Change | Drop |
| --- | --- | --- | --- | --- |
| [#5](https://github.com/crimson-med/pokesurvivor/pull/5) | Relay server `relay/` | `rooms.js`, `limits.js`, `words.js`, socket wiring, `TRUST_PROXY`, size cap, per-account limits, its 49 tests | Moves to `server/relay/`; `server.js` becomes `relay/io.js` on the shared HTTP server; auth reads the session cookie; handshake `v: 2`; Dockerfile becomes the multi-stage image; `fly.toml` gets a volume; socket.io to latest 4.x | `auth.js` (Firebase tokens with `jose`), `create { id }` mode, `ORIGINS` CORS list (same origin now, Origin check stays) |
| [#1](https://github.com/crimson-med/pokesurvivor/pull/1) | Client socket layer `G.Relay` | API shape (`connect`, `request`, `emit`, `on`, `off`, `room`, `state`), `ack` fix, error handling, reconnect logic, vendored socket.io client, tests | Connects to its own origin; `enabled` = signed in; error codes `signed-out`, `banned`; adds `invite`, `presence` | Firebase ID token and its refresh, `bad-token` retry, `disabled`, `relay-config.js` and `G.RELAY_URL`, the `?relay` check |
| [#2](https://github.com/crimson-med/pokesurvivor/pull/2) | Room code words, `G.RoomCode` | All of it | Nothing | Nothing |
| [#6](https://github.com/crimson-med/pokesurvivor/pull/6) | `net.js` socket setup and server path | Signaling over `sig`, server fallback, seq numbers, resend buffer, acks, `busy`, modes, `path`, `sameNet`, `hideIp`, its 18 tests | Becomes the only path; STUN list from `/api/config` | The non-relay branch, TURN, the RTDB queue, `failed`, STUN same-network guess, their tests |
| [#3](https://github.com/crimson-med/pokesurvivor/pull/3) | `social.js` server rooms | Server room mapping, room shape conversion, error codes, its 21 tests | Becomes the only room path; invites move from Firestore to the socket (step 6) | RTDB rooms, the relay-off branch, `findLocal`, `lanKey`, Firestore `inv/` with `code` |
| [#4](https://github.com/crimson-med/pokesurvivor/pull/4) | Lobby UI and strings | Create toggle, four code boxes, chips, "Copy code", path badges, "Connect locally", "Hide my IP", error mapping, strings | Always on; error texts add `signed-out`, `banned` | Flag checks, `disabled` text, the Same Wi-Fi tab and join by IP (step 5) |

## Branch plan

1. Merge the six PRs into `coop-misma-wifi` in this order: #5, #2, #1, #6,
   #3, #4. Expect small `dev.html` conflicts between #1, #2 and #4 (script
   lines in different places).
2. Create `standalone` from the result. Each step in this plan is one PR into
   `standalone`.
3. Steps 1, 4 and 5 rework the PR code as listed above. The rest is new.
4. `main` on the fork stays as the original game's copy, for reference.

## Old plan

The earlier relay add-on plan (13 docs) is in the commit `94f989f9` on
`coop-misma-wifi`, if you need to compare.
