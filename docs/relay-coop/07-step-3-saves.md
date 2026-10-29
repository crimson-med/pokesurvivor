# Step 3: saves on the server

**Goal:** the save that `db.js` keeps in Firestore today lives in SQLite.
Offline play and the merge stay as they are.

**Depends on:** step 2. **Estimate:** 1.5 days.

## How `db.js` saves today

- A local copy in `localStorage` (`ps.cloud.<uid>`) for offline play.
- `saves/{uid}` in Firestore with `rev`. A write sends `rev + 1` and only passes
  when the cloud is still at `rev` (see the comment near line 504 of
  `db.js`). On conflict it reads the cloud copy, runs `merge`, writes again.
- Writes are batched (`commit`, `flush`, `saveNow`), and pending writes go out
  before `updater.js` reloads the page.

Only the transport changes.

## Steps

1. **Server `http/save.js`**:
   - `GET /api/save`: the row or `404`.
   - `PUT /api/save { save, rev }`: in one transaction, if the row's `rev`
     equals `rev` (or there is no row and `rev` is 0), write with `rev + 1`
     and answer `{ rev }`. Otherwise `409 { save, rev }` with the current row.
   - Checks: body is an object, `JSON.stringify` under 512 KB, `v` is a number.
     The server doesn't validate game content (the save is the player's own;
     rankings don't trust it).
2. **Client `db.js`**: replace the Firestore calls (`docRef().get()`,
   `set(...)` with `rev`) with `G.Api.get('/api/save')` and
   `G.Api.put('/api/save', ...)`. On `409`, the same merge and retry as
   today. Keep the local copy, batching and the leave hooks.
3. **`updater.js`**: unchanged; it already calls `G.DB.flush` before reload.
4. **Import old browser saves:** on the first sign-in on a browser, if
   `localStorage` has a save from the original game (`ps.cloud.*` from
   cloud mode, or `ps.save.*` from local mode), show "Found progress from
   before on this browser. Add it to this account?". Yes: `merge` it into the
   current save and push. No: keep it, ask again never
   (`ps.import.no`).
   - This only helps if the old game ran on the same origin, because
     `localStorage` is per origin. Players coming from `pokesurvivor.com` to
     your domain start fresh. Say so in the release notes.
5. The `rev` check above replaces the `saves` rule in `firestore.rules`. The
   rules file itself goes in step 8.

## Tests

Server: create, update with the right `rev`, `409` with the wrong `rev`,
size limit, guest and email accounts.

Client (`tests/db.test.cjs`): with a fake `G.Api`, a conflict runs `merge` and
retries once; offline writes queue in the local copy and go out when the server
answers again; import offer shown once.

## Done when

- Play on the Mac, catch a Pokémon, open the Windows PC with the same email:
  it's there.
- Play offline (server stopped), restart the server: progress uploads, nothing
  lost.
- Two tabs on one account: both keep their Pokémon (merge).
