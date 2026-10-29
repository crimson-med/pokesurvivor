# Accounts and sessions

## Two kinds of account

| | Guest | Email |
| --- | --- | --- |
| Sign up | "Play as guest", one tap | Email, then a 6-digit code |
| Lives in | The cookie on this browser | The email address |
| Solo, co-op, save on the server | Yes | Yes |
| Friends, rankings | No (`needs-email`) | Yes |
| Other devices | No | Yes, sign in with the same email |
| Lost if | Browser data is cleared | Never (until deleted) |

A guest can add an email at any time and keeps the same account and save.

## Sign in by email code

```
player  -> POST /api/auth/email { email }
server     make code, store hash, send email         -> 204
player  -> POST /api/auth/verify { email, code }
server     check, find or create user, new session   -> { me }, Set-Cookie
```

- **Code:** 6 digits from `crypto.randomInt`, valid 10 minutes. Only
  `sha256(code + email + CODE_PEPPER)` is stored. A new request replaces the
  old code.
- **Tries:** 5 wrong tries burn the code (`too-many`). Compare with
  `crypto.timingSafeEqual`.
- **Email check:** lower case, trimmed, a basic `x@y.z` shape, at most 254
  characters. No other validation; the code proves it.
- **No account lookup leak:** `/api/auth/email` answers `204` whether or not
  the email has an account.
- **Email text:** subject "Your PokéSurvivor code: 123456", the code in large
  type, "valid for 10 minutes", "if you didn't ask for this, ignore it". In the
  player's game language (the client sends `lang`). Plain text plus simple
  HTML, no images, no tracking.

## Guest upgrade

When a guest verifies an email:

- **Email is new:** the guest row becomes `kind = 'email'` with that email.
  Same uid, same save.
- **Email already has an account:** the player signs in to that account. The
  server merges the guest's save into it (the same rules as `G.DB.merge`,
  ported to `server/save-merge.js` and tested against the client version), then
  deletes the guest. `merged: true` in the answer, and the game shows "Your
  guest progress was added to this account".

## Session cookie

```
Set-Cookie: ps_sid=<32 random bytes, base64url>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=15552000
```

- Only `sha256(token)` is stored in `sessions`.
- 180 days. When a session is used and its `seen` is over 7 days old, the
  server updates `seen` and sends the cookie again, so active players never
  get signed out.
- `Secure` is off only when `SITE_URL` starts with `http://localhost`.
- **Logout** deletes the row and clears the cookie. "Sign out everywhere"
  deletes all rows of the account.
- **Socket:** the handshake carries the cookie (same origin). `io.use` looks
  up the session once; the socket is closed if the session is deleted.

## Cross-site protection

- `SameSite=Lax` keeps the cookie off cross-site `POST`s.
- Every request that changes something needs `X-PS: 1` (a custom header, so a
  cross-site form can't send it) and `Origin === SITE_URL`.
- The socket handshake checks `Origin === SITE_URL` too.

## Email sender

`nodemailer` over SMTP, so any provider with SMTP works (Resend, Postmark,
Amazon SES, Brevo, a mailbox's own SMTP).

| Env | Example |
| --- | --- |
| `MAIL` | `smtp` or `console` |
| `SMTP_URL` | `smtps://user:pass@smtp.example.com:465` |
| `MAIL_FROM` | `PokéSurvivor <codes@play.example.com>` |

- `MAIL=console` prints the code in the server log (development and tests).
- The sending domain needs SPF and DKIM records from the provider, or codes
  end up in spam.
- If sending fails, `/api/auth/email` answers `502 mail` and the login screen
  says "Couldn't send the email. Try again in a minute".

## Admins

`ADMIN_EMAILS=a@example.com,b@example.com`. `me.admin` is true for those
accounts. Replaces the hard-coded uid in `ranking.js`.

## Deleting an account

`DELETE /api/me`, behind a confirm in Settings: deletes the user, sessions,
save, profile and friendships (cascade). Ranking entries are anonymized
(name becomes "Deleted player"). Banned accounts can still delete themselves;
their email can't come back to the rankings (the `bans` table keeps only a
hash of the email).
