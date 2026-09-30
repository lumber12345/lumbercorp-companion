[README.md](https://github.com/user-attachments/files/31874506/README.md)
# LumberCorp Companion — Abroad-Stock Aggregator

## Why this exists

Foreign stock in Torn City is **crowd-sourced** — Torn's official API does not
expose it. The only clean public JSON feed is YATA (`yata.yt`), and YATA goes
down. A static site can't survive that: it can only cache what each browser has
already seen.

This service is the fix. It is a tiny always-on proxy/cache that:

| Tier | What it does | Value |
|------|--------------|-------|
| 1 — Cache | Polls YATA every 60s and persists the last-good feed to disk | Survives YATA outages *and* restarts; never returns blank |
| 2 — Stale-while-revalidate | Always returns 200 with data, flagged `stale` when upstream is down | The app keeps working, honestly labelled |
| 3 — Crowd-source | Accepts `POST /report` from your own users | Over time becomes an **independent** source of truth, no longer dependent on YATA |

## Endpoints

- `GET /health` → `{ ok, uptime, cached, stale }`
- `GET /api/abroad-stock` → `{ ok, source, updatedAt, stale, reports, stocks }`
  (`stocks` matches YATA's shape: `{ mex: { stocks: [{name, quantity, cost}], update } }`)
- `POST /report` → body `{ country: "japan", stock: { "Cherry Blossom": { quantity, cost } } }`

All responses carry `Access-Control-Allow-Origin: *`, so the static client can
call them cross-origin.

## Run locally

```bash
cd server
node server.js          # PORT=10000 by default
```

Env vars: `PORT`, `POLL_MS`, `REPORT_TTL`.

## Deploy on Render (Web Service)

1. In Render: **New → Web Service**, point at this repo (or just the `server/` dir).
2. Runtime **Node**, build command `npm install` (or empty — no deps), start command `node server.js`.
3. Set env `PORT` (Render sets it automatically).
4. Attach a **persistent disk** mounted at `/opt/render/project/src` (or wherever
   `cache.json` lives) so the cache survives deploys. Without a disk, Render's
   ephemeral filesystem is wiped on each deploy — the service still works, but
   cold-starts from empty cache.

> Note: the app itself stays a **Static Site** (unchanged). This is a *second*
> Render service. See `render.yaml` for a two-service Blueprint.

## Wire-up in the app

In `index.html`, set `AGGREGATOR_URL` to your service URL, e.g.
`https://lumbercorp-aggregator.onrender.com`. The client then fetches:

1. YATA directly (fastest, freshest)
2. On failure → your aggregator (which serves cached/stale data)
3. On failure → browser-local last-good cache (already implemented)

## Roadmap / future

- Add Prombot (`prombot.co.uk`) as a second upstream if/when it exposes JSON.
- Normalize country codes between YATA and the app's `YATA_CODES` map.
- Auth on `/report` (a shared token) so only your users can contribute.
