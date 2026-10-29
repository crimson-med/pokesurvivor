# Step 6: nicknames, profiles, friends, invites

**Goal:** everything `social.js` keeps in Firestore today moves to the server:
unique nicknames, public profiles, friend requests, invites. Online status
comes back (the original game removed it to save Firebase costs).

**Depends on:** steps 2 and 4. **Estimate:** 1.5 days.

## Today (Firestore, see the `social.js` header)

| Firestore | Becomes |
| --- | --- |
| `names/{lower}` | `users.name_lower UNIQUE` |
| `profiles/{uid}` | `profiles` table, `GET/PUT /api/profile` |
| `friendships/{a_b}` | `friendships` table, `/api/friends` |
| `inv/{to_from}` | socket `invite` / `invite-answer`, 3 minutes in memory |
| `pres/{uid}` (removed upstream) | socket `presence`, from open sockets |

## Server

1. **`http/social.js`**: the routes in
   [02-protocol.md](02-protocol.md#nicknames-profiles-friends).
   - Nickname: same `VALID` regex as `social.js`, unique case-insensitive.
     Guests get "Guest" plus 4 digits until they pick one.
   - Friend request by nickname. Guests get `needs-email` (they can still be
     invited to rooms by code).
   - Max 200 friends, max 50 pending outgoing.
2. **`relay/io.js`**:
   - On connect and disconnect, send `presence(uid, online)` to that player's
     friends who are online.
   - `invite { to }`: must be a friend and online; the server sends `invite`
     with the host's room code; expires in 3 minutes; same friend at most once
     every 20 s (today's `REINVITE_MS`).
   - `invite-answer { from, accept }`: tells the host; on accept the guest
     joins with the code as usual.

## Client

1. **`js/net/social.js`**: replace the Firestore reads and writes with `G.Api`
   calls and socket events. Keep the public API the UI uses
   (`G.Social.on(fn)`, `me`, friends list, `invite`, `acceptInvite`,
   `publishProfile`). The 6 hour throttle on `publishProfile` can drop to the
   server's once a minute.
2. **`measureSkew`** stays (invite expiry is server side now, but other
   timers use it).
3. **Friends screen**: online dot from `presence`. Guests see "Add an email to
   have friends" with a button to Settings.

## Tests

Server: unique names, friend request, accept, remove, guest refused, presence
to friends only, invite to a non-friend refused, invite expiry and repeat limit.

Client: `social.js` with a fake `G.Api` and fake `G.Relay`: friends list,
invite received and accepted joins the code.

## Done when

- Two email accounts become friends; each sees the other online and offline.
- Invite from the lobby pops up on the friend's screen; accepting joins.
- No Firestore code left in `social.js`.
