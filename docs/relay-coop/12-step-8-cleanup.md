# Step 8: remove Firebase and the original game's ties

**Goal:** nothing in the repo loads Firebase or points at the original game's
servers or domain. The site URL is config.

**Depends on:** steps 2 to 7. **Estimate:** 1 day.

## Firebase

- `js/core/firebase-config.js` and its script tag in `dev.html`.
- `js/core/db.js`: the SDK loader (`SDK`, `loadScript` calls for
  `firebase-*-compat.js`), `NAME_DOMAIN`, the Google and name+password code,
  emulator handling. Rewrite the header: server mode or local mode.
- `firebase.json`, `firestore.indexes.json`.
- `dev.html` CSP: drop `https://www.gstatic.com https://apis.google.com
  https://*.firebaseio.com https://*.firebasedatabase.app`; add
  `connect-src 'self'` (same origin covers `/api` and `wss:` on the same host).
  Drop the `gstatic` preconnect. Check `tools/make_seo_pages.py` writes the
  same CSP into the guide pages.
- `tests/db.test.cjs` and others: remove Firebase fakes.

## Original game's servers and domain

| Where | Today | Becomes |
| --- | --- | --- |
| `js/net/net.js` | `ice.pokesurvivor.com/v1/ice` | gone (step 4) |
| `js/net/ranking.js` | `ice.pokesurvivor.com/v1/seal` | gone (step 7) |
| `CNAME` | `pokesurvivor.com` | deleted (GitHub Pages only) |
| `dev.html` (12 mentions) | canonical, Open Graph, JSON-LD URLs | `{{SITE_URL}}`, filled by `tools/build.js` from `SITE_URL` |
| `tools/make_seo_pages.py`, `robots.txt`, `sitemap.xml` | `pokesurvivor.com` | `SITE_URL`, or drop the SEO pages if you don't want them |
| `js/noframe.js` | button to `pokesurvivor.com` | button to `location.origin` |
| `js/ui/login.js`, `js/core/db.js` | domain mentions | gone with the old login |
| `tools/activar_dominio.sh`, `docs/DOMINIO.md`, `docs/PUBLICAR.md` | the original game's domain and GitHub Pages steps | deleted; deploy is [13-step-9-deploy.md](13-step-9-deploy.md) |
| Contact email, support links (`contacto/`, `apoyar/`, `js/data/funding.js`) | the original game's | your own, or removed |

Keep the license files and the `Required Notice:` line
([README.md](README.md#license)).

## Other

- `sw.js`: return early for `/api/` and `/socket.io/` so the service worker
  never caches them. Update its header.
- `js/main.js` `MAINTENANCE`: keep. `?dev` still lets you in.
- `docs/MULTIPLAYER_PROTOCOL.md`: point to [02-protocol.md](02-protocol.md).
- The project's `CLAUDE.md` "Servidores" section describes the original
  game's Firebase project and Cloudflare. Replace it with your server, your
  deploy and your email provider (your call, it's your instructions file).
- **Changelog** (`js/data/changelog.js`, es and en, today's date): "Sign in
  with an email code or play as a guest", "Group play connects on every
  network: direct when possible, through the server otherwise", "Room codes
  with four Pokémon", "See when friends are online", "Hide my IP in co-op".
- **Build:** `node tools/build.js && node tools/export_data.js && python tools/make_seo_pages.py`.

## Done when

- `grep -rni "firebase\|gstatic\|pokesurvivor\.com" --exclude-dir=docs --exclude-dir=.git .`
  finds only the license notice and the changelog's history.
- Network tab on a full session (sign in, solo run, co-op run, rankings,
  friends): every request goes to your origin, plus STUN.
- `node --test tests/*.test.cjs` and `cd server && npm test` pass.
