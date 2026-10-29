# Standalone PokéSurvivor: plan

A copy of the game you can deploy yourself: one Node server, one Docker image,
one SQLite file. No Firebase, and no calls to the original game's servers
(`pokesurvivor.com`, `ice.pokesurvivor.com`, `turn.pokesurvivor.com`).

- **Accounts:** sign in with a 6-digit code sent by email. The session lives in
  an `httpOnly` cookie. Guests play without an email.
- **Co-op:** the host's browser runs the match, as today. Guests connect
  straight to the host over WebRTC when they can, and through the server when
  they can't. Rooms use four-Pokémon codes.
- **Saves, friends, rankings:** on the same server, in SQLite.
- **Deploy:** `docker run` on any machine, or Fly.io / Railway with a volume.

Gameplay, `coop.js`, the binary codec, the save format and its merge logic
(`G.DB.merge`), and the screens stay.

## Documents

| File | What it covers |
| --- | --- |
| [01-architecture.md](01-architecture.md) | The one server, what talks to what, what leaves |
| [02-protocol.md](02-protocol.md) | HTTP API and socket events |
| [03-data-model.md](03-data-model.md) | SQLite tables, migrations, backups |
| [04-auth.md](04-auth.md) | Email codes, cookie sessions, guests |
| [05-step-1-server.md](05-step-1-server.md) | One server: game files, API, socket, SQLite, Docker |
| [06-step-2-accounts.md](06-step-2-accounts.md) | Sign in by email code, guests, login screen |
| [07-step-3-saves.md](07-step-3-saves.md) | Saves on the server, import of old browser saves |
| [08-step-4-coop.md](08-step-4-coop.md) | Co-op only through the server's socket |
| [09-step-5-codes-lobby.md](09-step-5-codes-lobby.md) | Room codes and lobby screens |
| [10-step-6-friends.md](10-step-6-friends.md) | Nicknames, profiles, friends, invites, online status |
| [11-step-7-rankings.md](11-step-7-rankings.md) | Leaderboards, server-timed runs, moderation |
| [12-step-8-cleanup.md](12-step-8-cleanup.md) | Remove Firebase and the original game's ties |
| [13-step-9-deploy.md](13-step-9-deploy.md) | Docker, Fly.io or Railway, email, domain, backups |
| [14-step-10-field-test.md](14-step-10-field-test.md) | Real networks, real players, tuning |
| [15-security.md](15-security.md) | Risks and limits |
| [16-from-the-prs.md](16-from-the-prs.md) | What we keep from PRs 1 to 6 |

## Status

Each step is one PR into `standalone` (see
[16-from-the-prs.md](16-from-the-prs.md#branch-plan)). The game keeps working
after every step.

- [ ] Step 1: one server
- [ ] Step 2: accounts
- [ ] Step 3: saves
- [ ] Step 4: co-op over the socket
- [ ] Step 5: room codes and lobby
- [ ] Step 6: friends and invites
- [ ] Step 7: rankings and moderation
- [ ] Step 8: cleanup
- [ ] Step 9: deploy
- [ ] Step 10: field test

Rough total: 14 to 16 working days.

## Decisions

| Question | Answer |
| --- | --- |
| Firebase | Removed: SDK, config, rules, emulators. |
| Sign in | 6-digit code by email, valid 10 minutes. No passwords, no Google. |
| Session | `httpOnly` cookie `ps_sid`, 180 days, renewed on use. |
| Guests | A real server account without an email, tied to the cookie. Can play solo and co-op and keeps a server save. Friends and rankings need an email. |
| Storage | SQLite (`better-sqlite3`), one file on a volume. |
| Server | Node 22, Express 4, socket.io 4. One process, one instance. |
| Email | SMTP through `nodemailer`, so any provider works. `MAIL=console` prints codes in development. |
| Ranking anti-cheat | The server times each run (start and finish both reach it). Replaces the original game's seals. |
| Co-op | Direct WebRTC first, server path as fallback. Host can force "Always through server". |
| TURN | None. The server path does that job. |
| Feature flag | None. This is the only stack in the fork. |
| Original game's domain | Becomes config (`SITE_URL`). `CNAME` and links to `pokesurvivor.com` go. |
| Upstream | Not a goal. |

## License

The code license ([LICENSE](../../LICENSE), PolyForm Noncommercial 1.0.0)
allows using, changing and sharing the game for noncommercial purposes. It
requires that anyone who gets a copy also gets the license terms and the
`Required Notice:` line. No selling, no charging to play, no ads. Read it
before deploying publicly.

## Ground rules (from the project's CLAUDE.md)

- Edit `dev.html`, never `index.html`. Build with
  `node tools/build.js && node tools/export_data.js && python tools/make_seo_pages.py`.
- Every game change gets a changelog entry in `js/data/changelog.js` (es and
  en). Server and hosting changes don't.
- New UI strings go in `js/data/lang-en.js` and `js/data/lang-updates.js`
  (all 7 languages). The i18n test fails if one is missing.
- Keep `js/core/updater.js` and the `version.json` write in `tools/build.js`.
  Players still update on their own, now from your server.
- Commits with no AI signature.
- Tests: `node --test tests/*.test.cjs` (Node 24 refuses a bare folder) and
  `cd server && npm test`.
- The "Servidores" section of the project's CLAUDE.md describes the original
  game's Firebase and Cloudflare setup. Step 8 replaces it.
