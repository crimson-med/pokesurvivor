# Security

| Risk | Mitigation | Where |
| --- | --- | --- |
| Guessing room codes | About 4.1 × 10^11 codes. `join` capped at 5 per minute per IP and per account. | `relay/limits.js` |
| Posing as another player | Identity only from the verified Firebase ID token. The server sets `from` on every forwarded `sig` and `m`. | `relay/auth.js`, `relay/server.js` |
| Guests messaging each other, or forging host messages | A guest's `sig` and `m` always go to the host. Only the host can address a uid. | `rooms.target` |
| IP exposure between players | Direct WebRTC shows your IP to the room's other players (as today). "Always through server" and "Hide my IP in co-op" avoid it. The server never sends an IP, only `sameNet` yes or no. | `relay/server.js`, lobby UI |
| Emulator tokens in production | `AUTH_EMULATOR=1` refuses to start when `NODE_ENV=production`. | `relay/auth.js` |
| Flooding | 256 KB per message, 120 `m` per second, 60 `sig` per minute per socket. Repeat offenders disconnected. | `relay/limits.js` |
| Room spam | One room per account, `MAX_ROOMS` global, 30 minute idle close. | `relay/rooms.js` |
| Other sites using the server | Origin allowlist plus the token check. | `ORIGINS` |
| Logging personal data | No message content logged. IPs only in the in-memory rate limiter, gone within a minute. Logs keep per-room duration, bytes, peak players and paths. | `relay/server.js` |
| Bill shock | Spending limit on the hosting account. `/healthz` shows relayed bytes. | [09-step-6-deploy.md](09-step-6-deploy.md) |
| Cheating | Unchanged: the host runs the match, ranking seals still come from the owner's server per player. | |
| Server down | Solo play unaffected. Co-op shows "Can't reach the group play server". New rooms need the server (it does the setup). | |
| Firebase costs | Token checks use Google's public keys. No Firebase Admin, no Identity Platform, no per-user billing. | `relay/auth.js` |
