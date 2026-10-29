# Security

| Risk | Mitigation | Where |
| --- | --- | --- |
| Guessing sign in codes | 6 digits, 10 minutes, 5 tries per code, 3 codes per email per 15 min, 10 per IP per hour. | `http/auth.js` |
| Email bombing (using your server to flood an inbox) | Same per email and per IP limits; `204` for every email. | `http/auth.js` |
| Stolen session cookie | `HttpOnly` (scripts can't read it), `Secure`, only its hash stored, "Sign out everywhere". | `http/guard.js` |
| Cross-site requests | `SameSite=Lax`, `X-PS: 1` header and `Origin` check on every change, `Origin` check on the socket. | `http/guard.js`, `relay/io.js` |
| Script injection in the page | CSP `script-src 'self'`, `connect-src 'self'`; names and profile fields escaped in the UI (`G.U.esc`) and length-limited on the server. | `dev.html`, `http/social.js` |
| Guest account spam | 10 guests per IP per hour; guests can't send friend requests or post rankings. Guests unused for 90 days are deleted nightly. | `http/auth.js` |
| Guessing room codes | About 3.3 × 10^11 codes (759 Pokémon, 4 in order). `join` capped at 5 per minute per IP and per account. | `relay/limits.js` |
| Posing as another player | Identity only from the session. The server sets `from` on every forwarded message. | `relay/io.js` |
| Guests messaging each other | A guest's `sig` and `m` always go to the host. | `relay/rooms.js` |
| IP exposure between players | Direct WebRTC shows your IP to the room's other players. "Always through server" and "Hide my IP in co-op" avoid it. The server never sends an IP. | `relay/io.js`, lobby |
| Fake client IP | Proxy headers only trusted with `TRUST_PROXY=1`. | `index.js` |
| Flooding the socket | 256 KB per message, 120 `m` per second, 60 `sig` per minute; repeat offenders disconnected. | `relay/limits.js` |
| Ranking cheats | Server-timed runs, `fit` caps, one finish per run, reports and bans. Kills and damage still come from the client. | `http/rank.js` |
| Huge saves | 512 KB per save. | `http/save.js` |
| Logging personal data | No codes, cookies or message contents in logs (except `MAIL=console` in development). IPs only in the in-memory rate limiters. | everywhere |
| Lost database | Nightly `VACUUM INTO` backups kept 7 days, plus volume snapshots. | `db/index.js` |
| Secrets in the repo | `CODE_PEPPER`, `SMTP_URL` only as env or provider secrets. `.env` in `.gitignore`. | deploy |
| Dependency advisories | Exact pins, `npm audit` before each deploy. socket.io moves off 4.7.5. | `server/package.json` |
| Server down | The game still loads from the service worker cache and plays solo on the local copy; co-op, friends and rankings wait. | `sw.js`, `db.js` |
