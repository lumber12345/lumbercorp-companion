# LumberCorp 2.0 — Render deploy kit

Contents:
- `lumbercorp-2/`   the PWA (static site) — includes the embedded rankwars
                    app (`lumbercorp-2/rankwars/`) that powers Live Wars
- `proxy/`          tiny proxy — Torn API v2 + FF Scouter + the Bazaar Scanner engine
                    (powers Live Wars and the Bazaar tab)
- `render.yaml`     Render Blueprint (deploys BOTH services in one click)

## Option A — Blueprint (recommended)
1. Push this folder to a GitHub repo (any name).
2. Render → **New → Blueprint** → pick the repo → **Apply**.
   Two services deploy: `lumbercorp2` (static) + `lumbercorp2-proxy` (node).
3. Copy the proxy's URL (e.g. `https://lumbercorp2-proxy.onrender.com`).
4. Static service → **Environment** → add `RW_PROXY_URL` = that URL → save.
   Static service → **Manual Deploy → Deploy latest reference**.
5. Open the site — Rank Wars tab auto-connects to the proxy.

## Option B — Manual (two web services)
1. **Static Site**: publish directory `lumbercorp-2`, no build command.
2. **Web Service**: runtime Node, build `(none)`, start `node proxy/server.js`,
   health check path `/api/ping`.
3. Set `RW_PROXY_URL` on the static site as above (or paste the proxy URL in
   the app: Rank Wars → ⚡ Connect live data — stored per browser).

## Notes
- Zero dependencies (Node 18+ only). Free tier friendly; services sleep after
  15 min idle — ping `/api/ping` with an uptime monitor to keep warm.
- API keys live in each visitor's browser; the proxy forwards them to
  api.torn.com / ffscouter.com only and never logs them.
