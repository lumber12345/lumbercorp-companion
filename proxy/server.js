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

/* ------------------------------------------------------------ ff scouter */
/* Proxy for ffscouter.com official API (v1) — copied from the rankwars app's
 * server so the embedded Live Wars tab keeps its FF Scouter feature.
 *   stats    GET /api/v1/get-stats?key&targets   (<=205 ids/call, 20/min/IP)
 *   check    GET /api/v1/check-key?key           (10/min/IP)
 *   register POST /api/v1/register               (3/min/IP, JSON body)
 * Env: FF_BASE/FF_PORT/FF_PROTOCOL (test overrides). */
const FF_BASE = process.env.FF_BASE || 'ffscouter.com';
const FF_PORT = Number(process.env.FF_PORT) || 443;
const FF_PROTOCOL = process.env.FF_PROTOCOL || 'https'; /* http only for tests */
function fetchFF(pathname, { method = 'GET', body = null, params = {} }) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(params);
    const options = {
      hostname: FF_BASE.split(':')[0],
      port: FF_BASE.includes(':') ? Number(FF_BASE.split(':')[1]) : FF_PORT,
      path: `${pathname}${qs.toString() ? '?' + qs.toString() : ''}`,
      method,
      headers: { accept: 'application/json', 'user-agent': 'LumberCorp2Proxy/1.0 (unofficial fan tool)' },
      timeout: 15000,
    };
    let payload = null;
    if (body) {
      payload = JSON.stringify(body);
      options.headers['content-type'] = 'application/json';
      options.headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = (FF_PROTOCOL === 'http' ? http : https).request(options, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size > 2 * 1024 * 1024) req.destroy(); else chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('FF Scouter timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

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
function sendRaw(res, status, text, extra) {
  res.writeHead(status, Object.assign({
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  }, extra || {}));
  res.end(text);
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

  if (u.pathname === '/api/ffscouter') {
    const key = u.searchParams.get('key') || '';
    const mode = u.searchParams.get('mode') || '';
    if (!key) return send(res, 400, { error: { error: 'Missing API key' } });
    if (!['stats', 'check', 'register'].includes(mode)) return send(res, 400, { error: { error: 'Unknown FF Scouter mode: ' + mode } });
    const mask = (s) => (s || '').split(key).join('***');
    const finish = (status, body) => sendRaw(res, status, key && body.includes(key) ? mask(body) : body);

    if (mode === 'stats') {
      const idsRaw = (u.searchParams.get('ids') || '').trim();
      if (!idsRaw) return send(res, 400, { error: { error: 'The targets parameter is required' } });
      const ids = idsRaw.split(',').map((x) => x.trim()).filter(Boolean);
      if (!ids.length || ids.length > 205) return send(res, 400, { error: { error: 'Between 1 and 205 target IDs required' } });
      if (!ids.every((x) => /^\d+$/.test(x))) return send(res, 400, { error: { error: 'All target IDs must be positive integers' } });
      const ck = 'ff:stats:' + ids.slice().sort((a, b) => a - b).join(',');
      const hit = cacheGet(ck);
      if (hit && u.searchParams.get('nocache') !== '1') return sendRaw(res, hit.status, key && hit.body.includes(key) ? mask(hit.body) : hit.body, { 'x-ff-cache': 'HIT' });
      fetchFF('/api/v1/get-stats', { params: { key, targets: ids.join(',') } })
        .then(({ status, body }) => { if (status >= 200 && status < 300) cacheSet(ck, status, body); finish(status, body); })
        .catch((e) => send(res, 504, { error: { error: 'FF Scouter request failed: ' + (e.message || 'unknown') } }));
      return;
    }

    if (mode === 'check') {
      const ck = 'ff:check:' + Buffer.from(key).toString('base64');
      const hit = cacheGet(ck);
      if (hit) return sendRaw(res, hit.status, key && hit.body.includes(key) ? mask(hit.body) : hit.body, { 'x-ff-cache': 'HIT' });
      fetchFF('/api/v1/check-key', { params: { key } })
        .then(({ status, body }) => { if (status >= 200 && status < 300) cacheSet(ck, status, body); finish(status, body); })
        .catch((e) => send(res, 504, { error: { error: 'FF Scouter request failed: ' + (e.message || 'unknown') } }));
      return;
    }

    // mode === 'register'
    fetchFF('/api/v1/register', { method: 'POST', body: { key, agree_to_data_policy: true, signup_source: 'LumberCorp2' } })
      .then(({ status, body }) => finish(status, body))
      .catch((e) => send(res, 504, { error: { error: 'FF Scouter request failed: ' + (e.message || 'unknown') } }));
    return;
  }

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
