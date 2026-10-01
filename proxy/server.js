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
const crypto = require('crypto');

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
  /^\/user\/(basic|profile)$/,  /^\/user\/(bars|cooldowns|travel|money|networth|personalstats)$/,
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


/* ==================================================== bazaar scanner =====
 * Ported from lumber12345/bazaar (server.js) so the embedded Scanner tab
 * works through this single proxy. Holds the scanner key in memory only,
 * throttles Torn v2 bazaar calls (~85/min), caches facets/prices/listings.
 * Endpoints: GET /api/scan · GET|POST /api/key · GET /api/item/asks
 * Env: BZ_API_ROOT (test override of https://api.torn.com).
 * ======================================================================= */
const API_ROOT = process.env.BZ_API_ROOT || 'https://api.torn.com';

const TICK_MS = 700;            // min spacing between Torn API calls (~85/min)
const FACETS_TTL = 5 * 60e3;    // bazaar/facets cache lifetime
const PRICES_TTL = 45e3;        // bazaar/prices cache lifetime
const REQUEUE_MS = 4 * 60e3;    // re-scan each item's listings every ~4 min
const LOOKBACK_MS = 3600e3;     // consider trades from the last hour
const SPARK_BUCKETS = 48;       // 75 s buckets for trend sparklines
const TOP_ASKS = 8;             // cheapest open asks kept per item

/* ---------------- state ---------------- */

let apiKey = '';
let keyUser = null;             // { player_id, username }
let keyBad = null;              // message if Torn rejected the key
let pausedUntil = 0;            // backoff until (ms epoch)
let lastCallAt = 0;
let minuteStart = Date.now();
let callsPerMin = 0;

let facets = { data: null, ts: 0 };
let prices = { data: null, ts: 0 };
const listings = new Map();     // facetId -> { asks, count, totalQty, ts }
const queue = [];               // facet ids waiting for a listings scan
const inQueue = new Set();
const scannedOnce = new Set();
let lastFullScanAt = 0;

/* item metadata (for icons) — one request, cached 1h */
let itemsMeta = { data: null, ts: 0 };
const ITEMS_TTL = 60 * 60e3;

/* full listings cache for the "every bazaar offer" drill-down */
const fullAsks = new Map();     // facetId -> { asks, ts }
const FULL_ASKS_TTL = 60e3;
const FULL_ASKS_MAX = 60;

/* ---------------- helpers ---------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class TornError extends Error {
  constructor(code, message) {
    super(message || 'Torn API error ' + code);
    this.code = code;
  }
}

function bumpMinute() {
  const now = Date.now();
  if (now - minuteStart > 60e3) {
    minuteStart = now;
    callsPerMin = 0;
  }
  callsPerMin++;
}

/** Serialize all Torn API traffic through a simple throttle. */
async function throttle() {
  for (;;) {
    const now = Date.now();
    if (now < pausedUntil) {
      await sleep(Math.min(pausedUntil - now, 2000));
      continue;
    }
    const wait = lastCallAt + TICK_MS - now;
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    bumpMinute();
    return;
  }
}

async function tornGet(endpoint, params = {}) {
  if (!apiKey) throw new TornError(1, 'No API key set');
  const url = new URL(API_ROOT + '/' + endpoint);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  // Documented method: ?key=... (all official examples use the query param).
  // Header kept as well in case the server reads that instead.
  url.searchParams.set('key', apiKey);
  await throttle();
  let res;
  try {
    res = await fetch(url, {
      headers: { 'X-Torn-Api-Key': apiKey },
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    throw new TornError(0, 'Network error talking to api.torn.com: ' + (e && e.message));
  }
  let json;
  try {
    json = await res.json();
  } catch {
    throw new TornError(0, 'Non-JSON response from Torn API (HTTP ' + res.status + ')');
  }
  if (json && json.error) {
    const code = json.error.code;
    // 2 = incorrect key. Stop hammering — repeated bad keys can IP-ban you.
    if (code === 2 || code === 18 || code === 13) {
      keyBad = json.error.error;
    }
    // 5 = too many requests, 8 = IP block -> back off.
    if (code === 5 || code === 8) {
      pausedUntil = Date.now() + 90e3;
    }
    throw new TornError(code, json.error.error);
  }
  if (keyBad) keyBad = null;
  return json;
}

function resetData() {
  facets = { data: null, ts: 0 };
  prices = { data: null, ts: 0 };
  itemsMeta = { data: null, ts: 0 };
  fullAsks.clear();
  listings.clear();
  queue.length = 0;
  inQueue.clear();
  scannedOnce.clear();
  lastFullScanAt = 0;
}

/* ---------------- data fetchers ---------------- */

async function getFacets(force = false) {
  if (facets.data && Date.now() - facets.ts < FACETS_TTL && !force) return facets.data;
  const json = await tornGet('bazaar/facets');
  facets = { data: Array.isArray(json.facets) ? json.facets : [], ts: Date.now() };
  return facets.data;
}

/** One request returns the last hour of trades for ALL listed facets. */
async function getPrices(force = false) {
  if (prices.data && Date.now() - prices.ts < PRICES_TTL && !force) return prices.data;
  const f = await getFacets();
  if (!f.length) return (prices.data = {});
  const json = await tornGet('bazaar/prices', { facets: f.map((x) => x.id).join(',') });
  prices = { data: json && typeof json === 'object' ? json : {}, ts: Date.now() };
  return prices.data;
}

/** One request returns ALL items in the game (id, name, image, ...) — used for icons. */
async function getItemsMeta() {
  if (itemsMeta.data && Date.now() - itemsMeta.ts < ITEMS_TTL) return itemsMeta.data;
  const json = await tornGet('items');
  const arr = Array.isArray(json.items) ? json.items : Array.isArray(json) ? json : [];
  itemsMeta = { data: arr, ts: Date.now() };
  return arr;
}

/* ---------------- background listings scanner ---------------- */

async function scanLoop() {
  for (;;) {
    await sleep(350);
    if (!apiKey || keyBad) continue;
    if (Date.now() < pausedUntil) continue;
    try {
      const now = Date.now();
      // Warm item metadata (icons) in the background once.
      if (!itemsMeta.data) getItemsMeta().catch(() => {});
      // Top the queue with due facet ids (never scanned first, then oldest first;
      // commodities are scanned before items so fast movers fill in first).
      if (queue.length < 100) {
        const f = facets.data ? facets.data : await getFacets();
        const due = f
          .filter((x) => {
            if (inQueue.has(x.id)) return false;
            const e = listings.get(x.id);
            return !e || now - e.ts > REQUEUE_MS;
          })
          .sort((a, b) => {
            const ta = listings.get(a.id) ? listings.get(a.id).ts : 0;
            const tb = listings.get(b.id) ? listings.get(b.id).ts : 0;
            if (ta !== tb) return ta - tb;
            const ca = a.is_commodity ? 0 : 1;
            const cb = b.is_commodity ? 0 : 1;
            if (ca !== cb) return ca - cb;
            return a.id - b.id;
          })
          .map((x) => x.id);
        for (const id of due.slice(0, 100)) {
          queue.push(id);
          inQueue.add(id);
        }
      }
      if (!queue.length) continue;
      const id = queue.shift();
      inQueue.delete(id);
      const json = await tornGet('bazaar/items', { item_id: id });
      const items = (Array.isArray(json.items) ? json.items : []).sort((a, b) => a.price - b.price);
      listings.set(id, {
        asks: items.slice(0, TOP_ASKS).map((it) => ({
          p: Number(it.price),
          q: Number(it.quantity || 1),
          u: it.user_id != null ? it.user_id : null,
          t: it.timestamp || null,
          locked: !!it.is_locked,
        })),
        count: items.length,
        totalQty: items.reduce((s, it) => s + Number(it.quantity || 0), 0),
        ts: Date.now(),
      });
      if (!scannedOnce.has(id)) {
        scannedOnce.add(id);
        if (facets.data && scannedOnce.size >= facets.data.length) lastFullScanAt = Date.now();
      }
    } catch (e) {
      if (e instanceof TornError && (e.code === 2 || e.code === 18 || e.code === 13)) {
        // invalid key: handled via keyBad; do nothing else.
      }
      // rate limit / network hiccups: just wait for the next tick.
    }
  }
}

async function pricesLoop() {
  for (;;) {
    await sleep(5000);
    if (!apiKey || keyBad || Date.now() < pausedUntil) continue;
    try {
      await getPrices();
    } catch {
      /* retried on next loop */
    }
  }
}

/* ---------------- view builder ---------------- */

function sparkline(trades) {
  const now = Date.now();
  const start = now - LOOKBACK_MS;
  const w = LOOKBACK_MS / SPARK_BUCKETS;
  const sums = new Array(SPARK_BUCKETS).fill(0);
  const qs = new Array(SPARK_BUCKETS).fill(0);
  for (const t of trades) {
    const ts = Number(t.timestamp) * 1000;
    if (!ts || ts < start) continue;
    const p = Number(t.price);
    const q = Number(t.quantity || 1);
    if (!isFinite(p) || !q) continue;
    const i = Math.min(SPARK_BUCKETS - 1, Math.floor((ts - start) / w));
    sums[i] += p * q;
    qs[i] += q;
  }
  return sums.map((s, i) => (qs[i] ? Math.round((s / qs[i]) * 100) / 100 : null));
}

function tradesFor(facetId) {
  if (!prices.data) return [];
  const arr = prices.data[facetId] || prices.data[String(facetId)];
  return Array.isArray(arr) ? arr : [];
}

function buildView() {
  const now = Date.now();
  const start = now - LOOKBACK_MS;
  /* id -> relative staticfiles image path, from the cached items metadata.
     (Upstream referenced `imgById` without ever defining it — fixed here.) */
  let imgById = null;
  if (itemsMeta.data && Array.isArray(itemsMeta.data)) {
    imgById = new Map();
    for (const it of itemsMeta.data) {
      if (it && it.id != null && it.image) imgById.set(+it.id, String(it.image));
    }
  }
  const out = {
    ok: true,
    hasKey: !!apiKey,
    keyUser,
    keyBad,
    api: {
      state: keyBad ? 'key_error' : Date.now() < pausedUntil ? 'paused' : 'ok',
      pausedUntil,
      callsPerMin,
    },
    meta: {
      totalFacets: facets.data ? facets.data.length : 0,
      scanned: listings.size,
      lastFullScanAt,
      facetsAgeMs: facets.data ? now - facets.ts : null,
      pricesAgeMs: prices.data ? now - prices.ts : null,
      serverTime: now,
    },
    rows: [],
  };
  if (!apiKey) return out;
  if (!facets.data) return out;

  for (const f of facets.data) {
    const trades = tradesFor(f.id).filter((t) => Number(t.timestamp) * 1000 >= start);
    let min = Infinity, max = -Infinity, sum = 0, qty = 0, count = 0, vol = 0;
    let buys = 0, sells = 0;
    for (const t of trades) {
      const p = Number(t.price);
      const q = Number(t.quantity || 1);
      if (!isFinite(p) || !q) continue;
      if (p < min) min = p;
      if (p > max) max = p;
      sum += p * q;
      qty += q;
      vol += p * q;
      count++;
      if (t.action === 'sell') sells++;
      else buys++;
    }
    const avg = qty ? sum / qty : null;
    const base = Number(f.price) || 0;
    const lastSale = Number(f.last_sale_price) || 0;
    const lst = listings.get(f.id) || null;
    const buyable = lst ? lst.asks.filter((a) => !a.locked) : [];
    const ask = buyable.length ? buyable[0].p : null;
    // "market value": prefer the live 1h weighted average, then last sale, then base.
    const market = avg != null ? avg : lastSale > 0 ? lastSale : base;
    const marketSource = avg != null ? 'avg1h' : lastSale > 0 ? 'last' : 'base';
    const spread = ask != null && market != null ? market - ask : null;
    const roi = spread != null && ask > 0 ? spread / ask : null;

    const relImg = imgById ? imgById.get(f.id) : null;
    out.rows.push({
      id: f.id,
      name: f.name,
      type: f.is_item ? 'item' : 'commodity',
      image: relImg ? 'https://staticfiles.torn.com/' + relImg : null,
      base,
      lastSale,
      market: market != null ? Math.round(market * 100) / 100 : null,
      marketSource,
      min: qty ? Math.round(min * 100) / 100 : null,
      max: qty ? Math.round(max * 100) / 100 : null,
      count,
      buys,
      sells,
      vol: Math.round(vol),
      ask,
      asks: buyable.slice(0, TOP_ASKS),
      listCount: lst ? lst.count : null,
      listQty: lst ? lst.totalQty : null,
      scannedAt: lst ? lst.ts : null,
      spread: spread != null ? Math.round(spread * 100) / 100 : null,
      roi,
      suggest: market ? Math.ceil(market * 1.05 * 10) / 10 : null,
      spark: sparkline(tradesFor(f.id)),
    });
  }
  return out;
}

/* ---------------- key management ---------------- */

async function setKey(key) {
  key = String(key || '').trim();
  if (!key) {
    apiKey = '';
    keyUser = null;
    keyBad = null;
    resetData();
    return { ok: true, cleared: true };
  }
  apiKey = key;
  keyBad = null;
  resetData();
  try {
    // bazaar/facets is the validation gate — it's what the app actually needs.
    // NOTE: bazaar market data requires at least Limited Access; lower-level
    // keys get error 16 here even though the key itself is valid.
    const f = await tornGet('bazaar/facets');
    const facetCount = Array.isArray(f.facets) ? f.facets.length : 0;
    // Username is a nice-to-have only: tolerate insufficient access levels.
    try {
      const u = await tornGet('user', { selector: 'player_id,username' });
      keyUser = { player_id: u.player_id != null ? u.player_id : null, username: u.username || u.name || null };
    } catch (e) {
      if (!(e instanceof TornError) || (e.code !== 16 && e.code !== 7 && e.code !== 4 && e.code !== 5)) throw e;
      keyUser = { player_id: null, username: null };
    }
    return { ok: true, user: keyUser, facets: facetCount };
  } catch (e) {
    const msg = e instanceof TornError ? `${e.code}: ${e.message}` : String(e && e.message || e);
    keyBad = msg;
    const out = { ok: false, error: msg };
    // If the key is valid but lacks bazaar permission (16), probe what the
    // key CAN do so the user gets a precise diagnosis + fix.
    if (e instanceof TornError && e.code === 16) {
      try {
        const u = await tornGet('user', { selector: 'player_id,username' });
        out.diag = {
          keyValid: true,
          playerId: u.player_id != null ? u.player_id : null,
          username: u.username || u.name || null,
        };
      } catch (e2) {
        // Not a rate-limit hiccup -> the key is valid (16 proves it), just
        // locked down on personal selections too.
        if (!(e2 instanceof TornError) || (e2.code !== 4 && e2.code !== 5)) {
          out.diag = { keyValid: true, playerId: null, username: null };
        }
      }
    }
    return out;
  }
}

function json(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readBody(req, limit = 10e3) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ------------------------------------------------- web push (installed PWA)
 * Zero-dependency web push (RFC 8291 aes128gcm + RFC 8292 VAPID) so the
 * installed phone app gets background alerts: energy full, hospital out,
 * flight landed, life critical. One Torn v1 poll per subscriber per 2 min.
 * Subscriptions + poll key + VAPID key persist to PUSH_DB (default /tmp —
 * memory-only semantics like everything else; survives restarts only when
 * the disk does). Browsers re-subscribe automatically when the VAPID key
 * changes. Env: PUSH_DB, VAPID_SUB, PUSH_POLL_MS.
 */
const PUSH_DB = process.env.PUSH_DB || '/tmp/lc2-push-subs.json';
const VAPID_SUB = process.env.VAPID_SUB || 'mailto:lumbercorp2@users.noreply.github.com';
const PUSH_POLL_MS = Number(process.env.PUSH_POLL_MS) || 120e3;
const b64u = (b) => Buffer.from(b).toString('base64url');
const hkdf = (ikm, salt, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));

let vapid = null;      /* { rawPub (65B), d (32B) } */
let subs = new Map();  /* endpoint -> { endpoint, p256dh, auth, tornKey, flags, fails } */
function saveDb() {
  try {
    require('fs').writeFileSync(PUSH_DB, JSON.stringify({
      vapid: { rawPub: vapid.rawPub.toString('base64'), d: vapid.d.toString('base64') },
      subs: [...subs.values()].map(({ endpoint, p256dh, auth, tornKey }) => ({ endpoint, p256dh, auth, tornKey })),
    }));
  } catch (e) { /* best effort */ }
}
(function loadDb() {
  try {
    const db = JSON.parse(require('fs').readFileSync(PUSH_DB, 'utf8'));
    if (db.vapid && db.vapid.rawPub && db.vapid.d) vapid = { rawPub: Buffer.from(db.vapid.rawPub, 'base64'), d: Buffer.from(db.vapid.d, 'base64') };
    (db.subs || []).forEach((s) => subs.set(s.endpoint, Object.assign({ flags: {}, fails: 0 }, s)));
  } catch (e) { /* fresh start */ }
  if (!vapid) {
    const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const j = kp.publicKey.export({ format: 'jwk' });
    vapid = {
      rawPub: Buffer.concat([Buffer.from([4]), Buffer.from(j.x, 'base64url'), Buffer.from(j.y, 'base64url')]),
      d: Buffer.from(kp.privateKey.export({ format: 'jwk' }).d, 'base64url'),
    };
    saveDb();
  }
})();
function vapidPrivKey() {
  return crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', x: vapid.rawPub.subarray(1, 33).toString('base64url'), y: vapid.rawPub.subarray(33, 65).toString('base64url'), d: vapid.d.toString('base64url') },
    format: 'jwk',
  });
}
function derToRaw(sig) { /* ASN.1 DER ECDSA signature -> 64-byte r||s */
  const rLen = sig[3];
  const rest = sig.subarray(4 + rLen);
  const sLen = rest[1];
  const r = sig.subarray(4, 4 + rLen), s = rest.subarray(2, 2 + sLen);
  const out = Buffer.alloc(64);
  r.copy(out, 32 - Math.min(32, r.length), Math.max(0, r.length - 32));
  s.copy(out, 64 - Math.min(32, s.length), Math.max(0, s.length - 32));
  return out;
}
function vapidAuth(endpoint) { /* RFC 8292 Authorization header */
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1e3) + 12 * 3600, sub: VAPID_SUB }));
  const der = crypto.sign('sha256', Buffer.from(head + '.' + body), vapidPrivKey());
  return 'vapid t=' + head + '.' + body + '.' + b64u(derToRaw(der)) + ', k=' + b64u(vapid.rawPub);
}
function encryptFor(sub, text) { /* RFC 8291 aes128gcm */
  const clientPub = Buffer.from(sub.p256dh, 'base64url');
  const auth = Buffer.from(sub.auth, 'base64url');
  const as = crypto.createECDH('prime256v1');
  as.generateKeys();
  const asPub = as.getPublicKey();
  const prk = hkdf(as.computeSecret(clientPub), auth, Buffer.concat([Buffer.from('WebPush: info\0'), clientPub, asPub]), 32);
  const salt = crypto.randomBytes(16);
  const cek = hkdf(prk, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(prk, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const pt = Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from([2])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([cipher.update(pt), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  const header = Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub]);
  return Buffer.concat([header, ct]);
}
async function sendPush(sub, note) {
  const payload = encryptFor(sub, JSON.stringify(Object.assign({ title: '🪵 LumberCorp 2.0', body: '', tag: 'lc2', url: './index.html?from=push' }, note)));
  const r = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      TTL: '86400',
      Urgency: 'normal',
      Authorization: vapidAuth(sub.endpoint),
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
    },
    body: new Uint8Array(payload),
  });
  return r.status;
}
async function notifySub(sub, note) {
  try {
    const st = await sendPush(sub, note);
    if (st === 404 || st === 410) { subs.delete(sub.endpoint); saveDb(); }
  } catch (e) {
    sub.fails = (sub.fails || 0) + 1;
    if (sub.fails > 20) { subs.delete(sub.endpoint); saveDb(); }
  }
}
async function pollSub(sub) {
  let j;
  try {
    const qs = new URLSearchParams({ selections: 'bars,travel,hospital', key: sub.tornKey, comment: 'LumberCorp2' });
    const r = await fetch(TORN_PROTOCOL + '://' + TORN_BASE + '/user/?' + qs.toString(), { signal: AbortSignal.timeout(12e3) });
    j = JSON.parse(await r.text());
  } catch (e) {
    sub.fails = (sub.fails || 0) + 1;
    if (sub.fails > 20) { subs.delete(sub.endpoint); saveDb(); }
    return;
  }
  if (!j || j.error) {
    if (j && j.error && j.error.code === 2 && sub.tornKey) {
      sub.tornKey = ''; saveDb();
      notifySub(sub, { title: '⚠️ Push paused', body: 'Your Torn API key was rejected — open the app and re-enable push.', tag: 'lc2-key' });
    }
    return;
  }
  sub.fails = 0;
  const f = sub.flags || (sub.flags = {});
  const notes = [];
  const nowS = Math.floor(Date.now() / 1e3);
  const en = j.bars && j.bars.energy;
  if (en) {
    if (en.fulltime === 0 && en.current >= en.maximum) {
      if (!f.energyFull) { f.energyFull = true; notes.push({ title: '⚡ Energy full', body: en.current + '/' + en.maximum + ' — time to hit the chainsaw.', tag: 'lc2-energy' }); }
    } else if (en.current < en.maximum) f.energyFull = false;
  }
  const life = j.bars && j.bars.life;
  if (life) {
    if (life.current < 0.25 * life.maximum) {
      if (!f.lifeLow) { f.lifeLow = true; notes.push({ title: '🩸 Life critical', body: life.current + '/' + life.maximum + ' — patch up!', tag: 'lc2-life' }); }
    } else if (life.current >= 0.5 * life.maximum) f.lifeLow = false;
  }
  if (j.hospital) {
    if (j.hospital.time > nowS) f.hospNoted = true;
    else if (f.hospNoted) { f.hospNoted = false; notes.push({ title: '🏥 Out of hospital', body: 'Patched up and released.', tag: 'lc2-hosp' }); }
  }
  if (j.travel) {
    if (j.travel.time > nowS) f.travNoted = true;
    else if (f.travNoted) { f.travNoted = false; notes.push({ title: '🛬 Flight landed', body: j.travel.destination && j.travel.destination !== 'Torn' ? 'Arrived in ' + j.travel.destination + '.' : 'Back in Torn.', tag: 'lc2-travel' }); }
  }
  for (const n of notes) await notifySub(sub, n);
  if (notes.length) saveDb();
}
function pollOnce() {
  for (const sub of [...subs.values()]) if (sub.tornKey) pollSub(sub).catch(() => {});
}

/* ---------------------------------------------------------------- server */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  if (req.method === 'OPTIONS') {           // CORS preflight
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization',
    });
    return res.end();
  }
  if (u.pathname === '/api/ping') return send(res, 200, { ok: true, ts: Date.now() });

  /* ---- web push (installed PWA background alerts) ---- */
  if (p === '/api/push/key') return send(res, 200, { publicKey: b64u(vapid.rawPub) });
  if (p === '/api/push/status') return send(res, 200, { ok: true, count: subs.size, pollMs: PUSH_POLL_MS });
  if (req.method === 'POST' && p === '/api/push/subscribe') {
    const raw = await readBody(req);
    let b; try { b = JSON.parse(raw); } catch (e) { return send(res, 400, { error: { error: 'bad json' } }); }
    const s = b && b.subscription;
    if (!s || !s.endpoint || !s.keys || !s.keys.p256dh || !s.keys.auth) return send(res, 400, { error: { error: 'bad subscription' } });
    subs.set(s.endpoint, { endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth, tornKey: String(b.tornKey || '').trim(), flags: {}, fails: 0 });
    saveDb();
    return send(res, 200, { ok: true, count: subs.size });
  }
  if (req.method === 'POST' && p === '/api/push/unsubscribe') {
    const raw = await readBody(req);
    try { const b = JSON.parse(raw); if (b && b.endpoint) { subs.delete(b.endpoint); saveDb(); } } catch (e) { /* ignore */ }
    return send(res, 200, { ok: true, count: subs.size });
  }
  if (req.method === 'POST' && p === '/api/push/test') {
    const raw = await readBody(req).catch(() => '{}');
    let endpoint = null; try { endpoint = (JSON.parse(raw) || {}).endpoint || null; } catch (e) { /* all */ }
    const targets = [...subs.values()].filter((s) => !endpoint || s.endpoint === endpoint);
    if (!targets.length) return send(res, 404, { error: { error: 'no subscriptions on this server' } });
    const results = [];
    for (const s of targets) {
      try {
        const st = await sendPush(s, { title: '🔔 LumberCorp 2.0', body: 'Test push — the pipe works. Background alerts are live.', tag: 'lc2-test' });
        results.push({ endpoint: s.endpoint.slice(-16), ok: st >= 200 && st < 300, status: st });
      } catch (e) { results.push({ endpoint: s.endpoint.slice(-16), ok: false, error: String(e.message || e) }); }
    }
    return send(res, 200, { results });
  }

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
  /* ---- bazaar scanner (ported from lumber12345/bazaar) ---- */
  if (p === '/api/scan' || p === '/api/key' || p === '/api/item/asks') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'GET' && p === '/api/scan') {
      json(res, buildView());
      return;
    }
    if (req.method === 'GET' && p === '/api/key') {
      json(res, { set: !!apiKey, user: keyUser, bad: keyBad });
      return;
    }
    if (req.method === 'GET' && p === '/api/item/asks') {
      const id = parseInt(u.searchParams.get('facet_id') || '', 10);
      if (!Number.isFinite(id) || id <= 0) {
        json(res, { ok: false, error: 'facet_id (number) required' }, 400);
        return;
      }
      const fresh = u.searchParams.get('fresh') === '1';
      const cached = fullAsks.get(id);
      if (cached && !fresh && Date.now() - cached.ts < FULL_ASKS_TTL) {
        json(res, { ok: true, asks: cached.asks, ts: cached.ts, cached: true });
        return;
      }
      if (!cached && Date.now() < pausedUntil) {
        const secs = Math.ceil((pausedUntil - Date.now()) / 1000);
        json(res, { ok: false, error: 'rate-limit pause — retry in ' + secs + 's' }, 503);
        return;
      }
      try {
        const data = await tornGet('bazaar/items', { item_id: id });
        const items = (Array.isArray(data.items) ? data.items : []).sort((a, b) => a.price - b.price);
        const asks = items.map((it) => ({
          p: Number(it.price),
          q: Number(it.quantity || 1),
          u: it.user_id != null ? it.user_id : null,
          t: it.timestamp || null,
          locked: !!it.is_locked,
        }));
        if (fullAsks.size >= FULL_ASKS_MAX) {
          let oldest = null, oldTs = Infinity;
          for (const [k, v] of fullAsks) if (v.ts < oldTs) { oldTs = v.ts; oldest = k; }
          if (oldest != null) fullAsks.delete(oldest);
        }
        fullAsks.set(id, { asks, ts: Date.now() });
        json(res, { ok: true, asks, ts: Date.now() });
      } catch (e) {
        json(res, { ok: false, error: e instanceof TornError ? e.message : String((e && e.message) || e) }, 502);
      }
      return;
    }
    if (req.method === 'POST' && p === '/api/key') {
      const raw = await readBody(req);
      let key = '';
      try {
        key = JSON.parse(raw || '{}').key;
      } catch (e) {
        /* treated as empty */
      }
      json(res, await setKey(key));
      return;
    }
  }

  send(res, 404, { error: { error: 'not found' } });
});
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of fullAsks) if (now - v.ts > 10 * 60e3) fullAsks.delete(k);
}, 5 * 60e3);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[lumbercorp2-proxy] listening on http://0.0.0.0:${PORT}`);
  scanLoop();
  pricesLoop();
  pollOnce();
  setInterval(pollOnce, PUSH_POLL_MS);
});
