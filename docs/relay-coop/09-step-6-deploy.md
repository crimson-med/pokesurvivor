# Step 6: deploy

**Goal:** the relay runs on a public `wss://` address, as **one** instance,
with an uptime check and a spending limit.

**Depends on:** step 1 (a staging deploy can happen any time after it).
**Estimate:** half a day.

Rooms live in memory, so the server must never run as two copies at once.
Two copies would split rooms between them.

Prices and limits below are from memory. Check each provider's pricing page
before signing up.

## Option A: Fly.io

1. Install `flyctl`, sign in, add a payment method, set a spending limit.
2. From `relay/`: `fly launch --no-deploy`. Pick the region closest to most
   players (for example `cdg` Paris or `mad` Madrid).
3. `relay/fly.toml`:

   ```toml
   app = "pokesurvivor-relay"
   primary_region = "cdg"

   [env]
     PORT = "8080"
     FIREBASE_PROJECT = "pokesurvivor-free"
     ORIGINS = "https://pokesurvivor.com,https://www.pokesurvivor.com"

   [http_service]
     internal_port = 8080
     force_https = true
     auto_stop_machines = false
     auto_start_machines = true
     min_machines_running = 1

   [[http_service.checks]]
     path = "/healthz"
     interval = "30s"
     timeout = "5s"

   [[vm]]
     size = "shared-cpu-1x"
     memory = "256mb"
   ```

4. `fly deploy`, then `fly scale count 1` (never more).
5. Address: `wss://pokesurvivor-relay.fly.dev`, or a custom domain with
   `fly certs add relay.<domain>`.

## Option B: Railway

1. New project, deploy from the GitHub repo, root directory `relay/`.
2. Start command `node server.js`, one replica, serverless sleep off.
3. Variables: `FIREBASE_PROJECT`, `ORIGINS` (Railway sets `PORT`).
4. Health check path `/healthz`.
5. Set a usage limit in the account.
6. Address: the generated `*.up.railway.app` domain, or a custom domain.

## Point the game at it

- `js/net/relay-config.js`: `G.RELAY_URL = 'https://<address>'`.
- Add the game's origins to `ORIGINS`. For testing from the fork's preview,
  add that origin too, and remove it afterwards.
- Deploys restart the process: rooms on the server path close and players go
  back to the menu with their run saved. Deploy when few people play.

## Cost

Only guests on the server path cost traffic. Formula, with the step 0 numbers:

```
GB per month = guests_on_server_path
             x (host_bytes_per_s + guest_bytes_per_s)
             x 3600 x room_hours_per_month / 1e9
```

Example with placeholder numbers (replace after step 0): 1500 bytes per host
message at 15 per second plus 300 bytes per guest message at 15 per second is
27 KB/s per guest on the server path, about 97 MB per guest hour. With 200 room
hours a month, 3 guests per room and a quarter of them on the server path,
that's about 15 GB a month.

## Done when

- `curl https://<address>/healthz` answers.
- Two players on different networks play a run with `?relay` against the
  deployed server.
- Uptime check and spending limit are set.
