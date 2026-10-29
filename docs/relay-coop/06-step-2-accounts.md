# Step 2: accounts

**Goal:** sign in with an email code or play as a guest. Firebase
Authentication is no longer used.

**Depends on:** step 1. **Estimate:** 2 days.

## Server

1. **`mail.js`**: `send(to, subject, text, html)`. `MAIL=console` logs
   `[mail] to=<email> code=<code>`. Templates in the 7 game languages
   (subject, one line, the code, the validity note).
2. **`http/guard.js`**:
   - `session(req)`: reads `ps_sid`, looks up `sha256` in `sessions`, loads
     the user, renews `seen` and the cookie after 7 days.
   - `needSession`, `needEmail`, `needAdmin` middlewares.
   - `csrf`: for `POST`, `PUT`, `DELETE`, require `X-PS: 1` and
     `Origin === SITE_URL`.
   - Rate limiters from `relay/limits.js`, keyed by IP, email or uid.
3. **`http/auth.js`**: the routes in
   [02-protocol.md](02-protocol.md#accounts), following
   [04-auth.md](04-auth.md). Guest upgrade and save merge
   (`server/save-merge.js`).
4. **`save-merge.js`**: a port of `G.DB.merge` from `js/core/db.js`. Test it
   with the same fixtures as the client so both stay identical. Better: make
   `merge` a plain function in a new `js/core/save-merge.js` that both the
   game and the server load (it already has no browser calls).
5. **Socket auth** (`relay/io.js`): `io.use` reads the cookie from
   `socket.request.headers.cookie`, finds the session, sets
   `socket.data.uid`, `name`, `kind`. Remove the step 1 `auth.dev` path.

## Client

1. **`js/net/api.js`** (`G.Api`), loaded before `db.js`:
   - `get(path)`, `post(path, body)`, `put(path, body)`, `del(path)`.
   - Same origin, `credentials: 'same-origin'`, `X-PS: 1`, JSON.
   - Resolves the parsed body; rejects an `Error` with `.code` (from
     `{ error }`) and `.status`. Network failure: `.code = 'offline'`.
2. **`js/core/db.js`**:
   - `ready()`: cloud mode when the page is served over http(s) and
     `GET /api/me` answers. `401` means signed out (show login). Network
     failure with a known previous user: play offline on the local copy, as
     cloud mode does today.
   - Replace `register`, `login`, `loginWithGoogle`, `linkGoogle` with
     `sendCode(email)`, `verifyCode(email, code)`, and keep `playAsGuest()`,
     which now calls `POST /api/auth/guest`.
   - `logout()` calls `/api/auth/logout`, then clears local session state.
   - `fb` getter goes. Add `get me()` (`{ uid, kind, name, email, admin }`).
   - `online` becomes "signed in and the server answered", for guests too.
     Add `get emailAccount()` for features that need it.
   - Keep `file://` local mode as it is (accounts in `localStorage`).
3. **`js/ui/login.js`** and the login screen in `dev.html`:
   - Step one: email field, "Send code", and "Play as guest".
   - Step two: 6 boxes for the code (paste fills them; on mobile
     `autocomplete="one-time-code"`, `inputmode="numeric"`), "Resend code"
     after 30 s, "Use another email".
   - Errors: `bad-code`, `expired`, `too-many`, `rate`, `mail`, `offline`.
   - Remove the password field, "Forgot password", Google and the "link Gmail"
     recovery popup (`scr-recover`).
4. **Settings**: show the email (masked), "Add an email" for guests, "Sign out",
   "Sign out everywhere", "Delete account".
5. **Strings** in all 7 languages; remove the ones for password, Google and
   recovery.

## Tests

Server:
- code sent (console mail captured), verified, cookie set, `/api/me` works
- wrong code 5 times burns it; expired code; resend replaces the old one
- `/api/auth/email` returns `204` for any email
- rate limits per email and per IP
- guest created, guest upgrades to a new email keeping its uid and save
- guest verifies an existing email: saves merged, guest deleted
- `POST` without `X-PS` or with another `Origin` gets `csrf`
- socket without a cookie gets `signed-out`
- logout and logout-all remove sessions; socket closed after logout

Client (`tests/`): `G.Api` error mapping; `db.js` signed-out, signed-in and
offline starts with a fake `G.Api`; login flow with fake `G.DB`.

## Done when

- Sign in on the Mac with an email (code from the server log), play, reload:
  still signed in. Same email on the Windows PC: same account.
- Guest on a phone, then "Add an email": same progress.
- No request to `gstatic.com`, `googleapis.com` or `firebaseio.com` in the
  network tab.
