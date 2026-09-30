/* LumberCorp 2.0 — tiny zero-dependency Torn API v2 proxy
 * Deployed as a free Render Web Service alongside the static app.
 * - Serves nothing but /api/ping and /api/torn (allow-listed faction/user paths)
 * - 10 s server-side cache so polling is gentle on the API
 * - CORS: open (*), so the static LumberCorp 2.0 site can call it cross-origin
 * - API keys are forwarded to api.torn.com only — never logged or stored
 *
 * Env: PORT (Render sets it), TORN_BASE (test override), CACHE_TTL_MS
 */
'use strict';
const http = require('http');
const https = require('https');
const { URL } = require('url');

const TORN_BASE = process.env.TORN_BASE || 'api.torn.com';
const TORN_PORT = Number(process.env.TORN_PORT) || 443;
const TORN_PROTOCOL = process.env.TORN_PROTOCOL || 'https'; /* http only for tests */
const PORT = Number(process.env.PORT) || 3001;
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS) || 10 * 1000;

/* ---------------------------------------------------------------- cache */
const cache = new Map(); // key -> { ts, status, body }
function cacheGet(k) {
  const hit = cache.get(k);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) { cache.delete(k); return null; }
  return hit;
}
function cacheSet(k, status, body) {
  if (cache.size > 500) cache.clear();
  cache.set(k, { ts: Date.now(), status, body });
}

/* ------------------------------------------------------------ validation */
const PATH_OK = [
  /^\/faction\/(basic|members|wars|warfareranked|rankedwars|rankedwarreport|attacks)$/,
  /^\/faction\/\d+\/(basic|members|wars|rankedwars|rankedwarreport|chain|attacks)$/,
  /^\/user\/(basic|profile)$/,
];
const PARAM_OK = new Set(['sort', 'from', 'to', 'limit', 'offset', 'cat', 'striptags', 'timestamp', 'filters']);

/* ---------------------------------------------------------------- send */
function send(res, status, obj, extra) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  }, extra || {}));
  res.end(body);
}

/* ------------------------------------------------------------ torn call */
function fetchTorn(v2path, params) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(params);
    qs.set('comment', 'LumberCorp2');
    const req = (TORN_PROTOCOL === 'http' ? http : https).request({
      hostname: TORN_BASE.split(':')[0],
      port: TORN_BASE.includes(':') ? Number(TORN_BASE.split(':')[1]) : TORN_PORT,
      path: `/v2${v2path}?${qs.toString()}`,
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': 'LumberCorp2Proxy/1.0 (unofficial fan tool)',
      },
      timeout: 12000,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > 4 * 1024 * 1024) req.destroy();   // sanity cap
        else chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('upstream timeout')));
    req.on('error', reject);
    req.end();
  });
}

/* ---------------------------------------------------------------- server */
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') {           // CORS preflight
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'content-type',
    });
    return res.end();
  }
  if (u.pathname === '/api/ping') return send(res, 200, { ok: true, ts: Date.now() });

  if (u.pathname === '/api/torn') {
    const path = u.searchParams.get('path') || '';
    const key = u.searchParams.get('key') || '';
    if (!PATH_OK.some((re) => re.test(path))) return send(res, 400, { error: { error: 'path not allowed' } });
    if (!key) return send(res, 400, { error: { error: 'missing key' } });
    const params = {};
    for (const [k, v] of u.searchParams) if (PARAM_OK.has(k) && v != null && v !== '') params[k] = v;

    const ck = path + '?' + new URLSearchParams(params).toString() + '&k=' + key;
    const hit = cacheGet(ck);
    if (hit) return send(res, hit.status, JSON.parse(hit.body), { 'x-cache': 'HIT' });

    fetchTorn(path, Object.assign({ key }, params))
      .then((r) => {
        cacheSet(ck, r.status, r.body);
        let body = r.body;
        try { body = JSON.parse(r.body); } catch (e) { /* keep raw */ }
        send(res, r.status, body, { 'x-cache': 'MISS' });
      })
      .catch((e) => send(res, 502, { error: { error: 'upstream error: ' + (e.message || 'unknown') } }));
    return;
  }
  send(res, 404, { error: { error: 'not found' } });
});
server.listen(PORT, '0.0.0.0', () => console.log(`[lumbercorp2-proxy] listening on http://0.0.0.0:${PORT}`));
