# Step 10: field test and tuning

**Goal:** prove it on real networks with real players, measure the traffic,
tune the direct wait.

**Depends on:** step 9. **Estimate:** 1 to 2 days, spread over a week.

## Accounts and saves

| # | Case | Expected | OK |
| --- | --- | --- | --- |
| 1 | Sign in with a Gmail, Outlook and a work address | Code arrives within a minute, not in spam | |
| 2 | Wrong code 5 times | Code burned, new one works | |
| 3 | Guest, then add an email | Same progress | |
| 4 | Guest, then an email that already has an account | Progress merged, message shown | |
| 5 | Same account on two devices | Saves merge, nothing lost | |
| 6 | Server stopped mid session | Plays offline, uploads when back | |
| 7 | Deploy a new build while in the menu | Reloads within 5 min, still signed in | |

## Co-op

Record the path and the time from "Join" to "Connected".

| # | Setup | Expected path | Path seen | Join time | OK |
| --- | --- | --- | --- | --- | --- |
| 8 | Same Wi-Fi, browser IP hiding off | Direct (Same Wi-Fi) | | | |
| 9 | Same Wi-Fi, IP hiding on | Server, then Direct after "Connect locally" | | | |
| 10 | Two homes, different providers | Direct, Server if not | | | |
| 11 | Home Wi-Fi to a phone on mobile data | Direct or Server | | | |
| 12 | Hotel, school or guest Wi-Fi | Server | | | |
| 13 | "Always through server" room | Server for everyone | | | |
| 14 | 4 players, mixed paths | Each its own | | | |
| 15 | Slow phone | No regression | | | |
| 16 | Guest Wi-Fi off for 10 s mid run | Back in the same run | | | |
| 17 | Server restarted mid run | Direct guests keep playing; server path guests back to menu, saved | | | |

## Friends and rankings

| # | Case | Expected | OK |
| --- | --- | --- | --- |
| 18 | Friend request, accept, online dot | Works both ways | |
| 19 | Invite from the lobby | Pops up, accept joins | |
| 20 | Solo and co-op run | On the right boards | |
| 21 | Faked time from the console | Refused | |
| 22 | Report, then remove as admin | Entry gone | |

## A full run

At least one 30 minute, 4 player run with a rift and Arceus, one guest on the
server path. Watch for desyncs, rubber-banding and growing delay.

## Tuning

- From `/healthz`: share of guests per path, bytes relayed per room hour. Put
  the real numbers in the cost formula in
  [13-step-9-deploy.md](13-step-9-deploy.md#cost).
- If direct almost always opens under 3 s, lower `DIRECT_WAIT_MS`.
- Write final limits into [02-protocol.md](02-protocol.md#limits) and the
  server defaults.

## Done when

- Every row is OK, and the 30 minute run had no desync.
