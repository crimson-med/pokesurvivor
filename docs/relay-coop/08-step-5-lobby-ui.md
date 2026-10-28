# Step 5: lobby UI and strings

**Goal:** the screens players use: create a room with a connection choice,
join with a code, see who is direct and who goes through the server, and
"Connect locally" on the same Wi-Fi. All text in 7 languages.

**Depends on:** step 4. **Estimate:** 1.5 days.

## Screens

### Friends screen (`dev.html` `scr-friends`, `js/ui/social-ui.js`)

- **Create room**, with a two-option toggle:
  - "Direct first" (default): "Fastest. Uses the server only if needed."
  - "Always through server": "Your IP stays hidden from other players."
- **Join with code**: four inputs with autocomplete in the player's language
  (`G.Relay.suggest`). Pasting a whole code in any box fills all four. Button
  "Join".
- The **Same Wi-Fi** tab from `coop-misma-wifi` goes away when the relay is on
  (codes replace join-by-IP). Its "Where do I find my IP?" help moves to the
  "Connect locally" box.

### Lobby (`LobbyUI`)

- **Code**: four chips with sprite and name, plus "Copy code" (copies
  `pikachu-onix-mew-eevee` in English so it works for everyone).
- **Each player** shows a path badge:

  | Badge | When |
  | --- | --- |
  | Same Wi-Fi | `direct` and `sameNet` |
  | Direct | `direct` |
  | Server | `relay` |
  | Connecting… | `connecting` |
  | Reconnecting… | `away` |

- **Connect locally** (host only): shown when a guest has `sameNet` and is on
  the server path. IP input with the saved last IP (`ps.lanip`), calls
  `G.Social.setLocal(ip)`. Guests on that Wi-Fi reconnect direct.
- The "network blocked" hint and banners from `lanHint` / `renderHint` go away
  with the relay on.

### Settings

- "Hide my IP in co-op" (stored in the save's settings). When on, `join` sends
  `hideIp: true` and that guest always uses the server path.

### Errors

| Case | Text |
| --- | --- |
| `not-found` | "No room with that code. Check the four Pokémon and their order with your host." |
| `full` | "This room is full (4 players)." |
| `started` | "That room's run has already started." |
| `rate` | "Too many tries. Wait a minute and try again." |
| Server unreachable | "Can't reach the group play server. Check your internet connection." |
| `old-version` | "Update the game to play together." |

## Strings

- Each new Spanish string goes in `js/data/lang-en.js` and a row in
  `js/data/lang-updates.js` with `[es, fr, it, pt-BR, zh-Hans, zh-Hant]`.
- Templates use `{x}` for translated parts and `{name}` for names kept as is.
- `node --test tests/` regenerates `js/lang/*.js` and fails on anything
  missing.

## Changelog

`js/data/changelog.js`, today's date, es and en, under `new`:

> Co-op with room codes: create a room, share four Pokémon, and your friends
> join from any network. If a direct connection isn't possible, the game
> connects through the server automatically.

Only when the feature is on by default (step 8). Until then the flag hides it,
so no changelog entry.

## Tests

- `tests/i18n.test.cjs` passes (all strings in 7 languages).
- New UI test (pattern of `tests/runui.test.cjs`): badge text for each mode,
  paste-a-code fills four inputs.

## Manual check

- Phone width (375 px): code chips wrap, inputs stack 2 by 2.
- Each badge appears in a real lobby (use "Always through server" for Server,
  IP hiding on for "Connect locally").
- Switch the game to each language and look at the lobby once.

## Done when

- Every screen works at desktop and phone width, in all 7 languages.
- No em dashes or en dashes in any new string.
