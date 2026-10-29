# Step 7: rankings and moderation

**Goal:** the leaderboards work on your server, with the same boards, and the
server times every run instead of asking the original game's seal service.

**Depends on:** steps 2 and 4. **Estimate:** 2 days.

## Today

- Boards in Firestore: a summary document per board (top 50) and one entry per
  player or team (see the `ranking.js` header).
- `fit(r)` caps time, level, kills and damage to plausible values.
- Each run needs a seal from `ice.pokesurvivor.com/v1/seal`, asked at the
  start and checked at upload.
- Moderation: reports, remove an entry, ban, purge long times. Admin is a
  hard-coded uid.

## Server-timed runs (replaces the seals)

- **Solo:** the game calls `POST /api/runs { dex, shiny }` when the run starts.
  The server stores `t0` from its own clock.
- **Co-op:** the host's socket `start` opens the run with the room's members
  and their Pokémon; the ack returns `run`, and the host passes it to
  `coop.js`'s end of run report.
- **Finish:** `POST /api/runs/:run/finish { t, lv, kills, dmg }`, from the
  solo player or the co-op host only.
  - `t` must be at most the real time since `t0` plus 10 s (pause screens make
    real time longer, never shorter).
  - The server runs `fit` (ported to `server/rank-fit.js`, same caps as
    `ranking.js`).
  - One finish per run; runs older than 3 hours can't be finished.
  - Banned players and guests are skipped (guests: `needs-email`, the game
    says "Add an email to appear in the rankings").
- **Boards:** the server computes the board ids from its clock in
  Europe/Madrid and upserts the entry where it improves `t` or `dmg`, with the
  same rules as today: daily, weekly and monthly keep only top 50; all time
  keeps everyone; the per-Pokémon board only on all time.

This doesn't stop a modified client from lying about kills, but it stops the
easy cheat (claiming more time than really passed), which is what the seals
did.

## Client `js/net/ranking.js`

- Delete Firestore reads and writes, the summary documents and their cost
  tricks, `SEAL_API` and the seal retries.
- `GET /api/boards/:board?by=t|d` for each tab. Keep the 2 hour browser cache
  only for past periods; current boards refresh on open.
- Run start and finish through the API. Keep the local "best so far" memory to
  show "New record!" without a request.
- `report` posts `/api/reports`.
- `isAdmin` becomes `G.DB.me.admin`.

## Moderation

- **Server `http/admin.js`**: list reports (most reported first), remove an
  entry, ban (sets `users.banned`, adds to `bans`, removes their entries from
  current boards), unban, dismiss a report, purge entries over N seconds.
- **`js/ui/mod-ui.js`**: same screen, calls the admin API. Texts stay
  Spanish-only as today (admin screen).

## Tests

Server: solo run timed, finish with `t` over real time refused, double finish
refused, co-op run from `start` with the right members, only the host can
finish, board ids for a date in each period, top 50 trimming, rank outside the
top 50 on all time, ban removes entries, admin routes refuse non-admins.

Client: `ranking.js` with a fake `G.Api`: tabs load, record detection, report.

## Done when

- A solo run and a co-op run appear on the right boards on both machines.
- A finish with a faked `t` from the console is refused.
- The admin email sees "Moderation" and can remove an entry.
- `grep -rn "ice.pokesurvivor\|seal" js/net/ranking.js` finds nothing.
