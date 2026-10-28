# Step 7: field test and tuning

**Goal:** prove it on real networks with real friends, and tune the direct
wait time from data.

**Depends on:** steps 5 and 6. **Estimate:** 1 to 2 days, spread over a week.

## Test matrix

Every row, with `?relay`, against the deployed server. Record the path and the
time from "Join" to "Connected".

| # | Setup | Expected path | Path seen | Join time | OK |
| --- | --- | --- | --- | --- | --- |
| 1 | Same Wi-Fi, browser IP hiding off | Direct (Same Wi-Fi) | | | |
| 2 | Same Wi-Fi, IP hiding on | Server, then Direct after "Connect locally" | | | |
| 3 | Two homes, different providers | Direct, Server if not | | | |
| 4 | Home Wi-Fi to phone on mobile data | Direct or Server | | | |
| 5 | Hotel, school or guest Wi-Fi (or a firewall allowing only 443) | Server | | | |
| 6 | "Always through server" room | Server for everyone | | | |
| 7 | 4 players, mixed paths | Each its own | | | |
| 8 | Slow phone, 6x CPU throttle | No regression | | | |
| 9 | Guest Wi-Fi off for 10 s mid-run | Back in the same run | | | |
| 10 | Direct channel killed mid-run (`G.Net` debug) | Moves to Server, no lost events | | | |
| 11 | Relay restarted mid-run | Direct guests keep playing; server-path guests back to menu, saved | | | |
| 12 | Old build against new server | "Update the game to play together" | | | |

## A full run

At least one 30 minute, 4 player run, with a rift and Arceus, with at least
one guest on the server path. Watch for desyncs, rubber-banding and growing
delay.

## Tuning

- From `/healthz` and the server logs: share of guests on each path, and how
  long direct took when it worked.
- If almost every direct success happens under 3 s, lower `DIRECT_WAIT_MS`.
- If many same-Wi-Fi pairs end on the server, make "Connect locally" more
  prominent.
- Write the final numbers into [02-protocol.md](02-protocol.md#limits) and the
  `relay/` env defaults.

## Done when

- Every row in the matrix is OK.
- The 30 minute run had no desync.
