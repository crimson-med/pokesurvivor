# Step 9: deploy

**Goal:** the image runs on a public `https://` address with a persistent
volume, real email, backups and an uptime check.

**Depends on:** step 8 (a staging deploy can happen after step 2).
**Estimate:** half a day.

Rooms live in memory and SQLite is one file, so run **exactly one instance**.
Prices and limits below are from memory: check each provider's pricing page
before signing up.

## What you need

- A domain (or the provider's free subdomain to start).
- An SMTP provider with your domain verified (SPF and DKIM records added).
- A random `CODE_PEPPER`: `openssl rand -base64 32`. Keep it secret and never
  change it (it would break every pending code and the ban list).

## Option A: any machine with Docker

```bash
docker build -f server/Dockerfile -t pokesurvivor .
docker run -d --name ps --restart unless-stopped -p 8787:8787 -v ps-data:/data \
  -e SITE_URL=https://play.example.com -e MAIL=smtp -e SMTP_URL=... -e MAIL_FROM=... \
  -e CODE_PEPPER=... -e ADMIN_EMAILS=you@example.com pokesurvivor
```

Put Caddy or nginx in front for HTTPS, with WebSocket upgrade on, and set
`TRUST_PROXY=1`.

## Option B: Fly.io

`fly.toml` at the repo root:

```toml
app = "pokesurvivor"
primary_region = "cdg"

[build]
  dockerfile = "server/Dockerfile"

[env]
  PORT = "8787"
  SITE_URL = "https://pokesurvivor.fly.dev"
  MAIL = "smtp"
  TRUST_PROXY = "1"

[[mounts]]
  source = "ps_data"
  destination = "/data"

[http_service]
  internal_port = 8787
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
  memory = "512mb"
```

```bash
fly launch --no-deploy
fly volumes create ps_data --size 1 --region cdg
fly secrets set CODE_PEPPER=... SMTP_URL=... MAIL_FROM=... ADMIN_EMAILS=...
fly deploy && fly scale count 1
fly certs add play.example.com     # optional custom domain
```

A volume belongs to one machine, which also keeps it at one instance.

## Option C: Railway

1. New project from the GitHub repo, Dockerfile `server/Dockerfile`.
2. Add a volume mounted at `/data`.
3. Variables as in option A (Railway sets `PORT`; set `TRUST_PROXY=1`).
4. One replica, sleeping off, health check `/healthz`.
5. Custom domain in the service settings.

## After the first deploy

- Sign in with the admin email, check "Moderation" shows.
- Uptime check on `/healthz` (the provider's, or a free external pinger).
- Spending limit on the hosting account.
- Check that `/data/backup/` fills up nightly ([03-data-model.md](03-data-model.md#backups)).

## Updating

`fly deploy` (or push, on Railway). The restart closes live rooms on the
server path: players go back to the menu with the run saved, and
`updater.js` moves everyone to the new build. Deploy when few people play.

## Cost

Traffic: only guests on the server path cost real bandwidth. Measure in step
10 with `/healthz`, then:

```
GB per month = guests_on_server_path x bytes_per_second x 3600 x room_hours / 1e9
```

The game files are about 75 MB in the repo, but players download only what
they play, and the service worker caches the art.
