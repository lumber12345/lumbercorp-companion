[README.md](https://github.com/user-attachments/files/31874506/README.md)
# LumberCorp Companion — Abroad-Stock Aggregator

## ✨ LumberCorp 2.0 (`lumbercorp-2/`)

The next generation of the app lives in **`lumbercorp-2/`** — still a
zero-dependency, single-file PWA (`index.html` + `sw.js` + manifest + icons).

Run it:

```bash
cd lumbercorp-2
python3 -m http.server 8000     # or any static server; then open http://localhost:8000
```

New over 1.0:

- **Live bar ETAs** — energy/nerve/happy/life tick client-side with “full in …” countdowns
- **Flight planner** — pick destination + class (Standard/Airstrip/WLT/Business), see arrival/return
  times, begin a flight and get a live countdown + landing notification (persisted across reloads)
- **Restock ticker** — abroad markets restock on a fixed 15-min cycle; the bar shows the next one
- **Abroad profit table** — YATA shop cost vs market value → profit/unit and “total if cleared”
- **⌘K command palette** (or `/`) — jump to pages, flights, items, links
- **Notifications** — energy full, flight landed, cooldown finished
- **Theming** — dark/light + 5 accent finishes; **watchlist** stars; **export/reset**
- Demo mode by default; add a Torn API key in Settings → Live. Abroad stock still uses
  YATA with last-good caching (stale-while-revalidate), and honors the same optional
  `AGGREGATOR_URL` backend described below.

## Why this exists (v1)

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
