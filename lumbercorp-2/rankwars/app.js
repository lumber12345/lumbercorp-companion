/* ============================================================================
 * Torn Rank Wars — frontend (vanilla JS, no dependencies)
 * Data source: official Torn API v2, proxied through /api/torn
 *   /faction/warfareranked      → all (ongoing/scheduled) ranked wars
 *   /faction/wars               → your faction's current war (fallback)
 *   /faction/{id}/members       → rosters with live status
 *   /faction/{id}/rankedwars    → war history
 *   /faction/{warId}/rankedwarreport → finished-war report w/ member scores
 *   /faction/basic              → detect key owner's faction
 * ==========================================================================*/
'use strict';

/* ---- environment guards ----------------------------------------------------
 * The app may run inside a sandboxed preview iframe where localStorage access
 * throws a SecurityError (opaque origin). Fall back to in-memory storage so the
 * app always boots; persistence returns when opened in a normal browser tab.
 * -------------------------------------------------------------------------- */
const store = (() => {
  try {
    const t = '__rw_probe__';
    window.localStorage.setItem(t, '1');
    window.localStorage.removeItem(t);
    return window.localStorage;
  } catch (e) {
    const mem = new Map();
    return new Proxy({}, {
      get(_, k) {
        if (k === 'getItem') return (x) => (mem.has(String(x)) ? mem.get(String(x)) : null);
        if (k === 'setItem') return (x, v) => { mem.set(String(x), String(v)); };
        if (k === 'removeItem') return (x) => { mem.delete(String(x)); };
        if (k === 'key') return (i) => ([...mem.keys()][i] ?? null);
        if (k === 'clear') return () => mem.clear();
        return mem.has(k) ? mem.get(k) : undefined;
      },
      set(_, k, v) { mem.set(String(k), String(v)); return true; },
    });
  }
})();
window.addEventListener('error', (e) => {
  try {
    const el = document.querySelector('#errbar');
    if (el) { el.hidden = false; el.innerHTML = `<span>⚠ App error: ${String(e.message || e).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</span><button class="x" onclick="location.reload()" title="Reload">✕</button>`; }
  } catch (_) {}
});


/* ---------------------------------------------------------------- helpers */
const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
const view = $('#view');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const fmtInt = (n) => (Number.isFinite(+n) ? Math.round(+n).toLocaleString('en-US') : '—');
const fmtF1 = (n) => (Number.isFinite(+n) ? (+n).toLocaleString('en-US', { maximumFractionDigits: 1 }) : '—');
function trim3(x) { return x >= 100 ? String(Math.round(x)) : x >= 10 ? String(Math.round(x * 10) / 10) : String(Math.round(x * 100) / 100); }
function fmtBS(n) { // human battle-stat formatting: 2.99b / 6.75m / 812k
  if (!Number.isFinite(+n) || +n <= 0) return '—';
  const v = +n, a = Math.abs(v);
  if (a >= 1e12) return trim3(v / 1e12) + 't';
  if (a >= 1e9) return trim3(v / 1e9) + 'b';
  if (a >= 1e6) return trim3(v / 1e6) + 'm';
  if (a >= 1e3) return trim3(v / 1e3) + 'k';
  return String(Math.round(v));
}
const pct = (a, b) => (b > 0 ? Math.min(100, Math.round((a / b) * 100)) : 0);

function pad2(n) { return String(n).padStart(2, '0'); }
function fmtDur(ms) { // "13h 22m 05s" style, drops leading zero units
  if (ms == null) return '—';
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  if (d > 0) return `${d}d ${pad2(h)}:${pad2(m)}:${pad2(ss)}`;
  if (h > 0) return `${h}h ${pad2(m)}:${pad2(ss)}`;
  if (m > 0) return `${m}m ${pad2(ss)}s`;
  return `${ss}s`;
}
function fmtDurShort(ms) {
  if (ms == null) return '—';
  if (ms < 0) ms = 0;
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${pad2(mm)}m`;
  if (mm > 0) return `${mm}m`;
  return '≤1m';
}
function fmtDate(ts, withTime) { // ts seconds
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  const opts = { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  let s = d.toLocaleDateString('en-GB', opts);
  if (withTime) s += ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  return s;
}
function ago(ts) { return fmtDurShort(Date.now() - ts * 1000) + ' ago'; }

/* ---- LumberCorp 2.0 embed: route API calls through the companion proxy.
 * Priority: live override written by the companion (rw_proxy_override) →
 * deploy-time window.RW_PROXY_URL (config.js) → same-origin /api (standalone).
 * -------------------------------------------------------------------------- */
const RW_API_BASE = (() => {
  try {
    const o = String(store.rw_proxy_override || '').trim().replace(/\/+$/, '');
    if (o) return o;
  } catch (e) { /* ignore */ }
  return String(window.RW_PROXY_URL || '').trim().replace(/\/+$/, '');
})();

/* ------------------------------------------------------------------ state */
const S = {
  key: store.rw_key || '',
  demo: store.rw_demo === '1',
  interval: parseInt(store.rw_interval || '15', 10),
  tab: 'wars',
  chains: {},
  warkills: {},
  warkillsErr: null,
  wkBusy: false,
  pin: store.rw_pin || '',
  pinAuto: false,
  pinAutoTried: false,
  wars: [],            // normalized wars (live + upcoming + recent)
  warsLoaded: false,
  warsSort: store.rw_sort || 'ending',
  warsSearch: '',
  room: { warId: parseInt(store.rw_lastwar || '0', 10) || null, sortBy: 'level', sortDir: -1, filter: 'all', search: '', rosterA: null, rosterB: null, rosterErr: {} },
  hist: { faction: store.rw_histfaction || '', rows: null, loading: false, err: null },
  report: { warId: null, data: null, loading: false, err: null },
  myFaction: null,
  hits: { search: '', copiedAt: 0, side: {} },
  wrep: { faction: store.rw_wrepfaction || '', rows: null, warId: null, data: null, loading: false, loadingWar: false, err: null, sort: 'kills' },
  ff: { status: null, statusErr: null, checking: false, registering: false, scouting: false, scoutProg: null, data: {}, err: null, sort: 'est', dir: 1, consent: store.rw_ff_consent === '1', autoTried: false, lastScoutAt: 0, match: { preset: 'all', min: '', max: '' }, myId: null, myName: null, myEst: null, popup: null, squadSearch: '', discCopiedAt: 0, myEstTriedAt: 0, myNoEst: false },
  err: null,
  nextAt: 0,
  busy: false,
  focus: null,         // {id, start, end} to restore input focus after re-render
};

/* ---- LumberCorp 2.0 embed: boot into ?tab= and follow companion sub-tabs ---- */
try {
  const __t = new URLSearchParams(location.search).get('tab');
  if (['wars', 'room', 'hits', 'wrep', 'history', 'about'].includes(__t)) S.tab = __t;
} catch (e) { /* ignore */ }
window.addEventListener('message', (e) => {
  const d = e && e.data;
  if (!d || typeof d.rwtab !== 'string') return;
  if (!['wars', 'room', 'hits', 'wrep', 'history', 'about'].includes(d.rwtab)) return;
  S.tab = d.rwtab;
  if (S.tab === 'history') {
    S.report = { warId: null, data: null, loading: false, err: null };
    if (!S.hist.rows && S.hist.faction) loadHistory(S.hist.faction);
  }
  renderTabs(); renderView();
  if (S.tab === 'wrep' && (S.key || S.demo) && !S.wrep.rows && !S.wrep.loading) loadWarReportWars();
  if ((S.tab === 'room' || S.tab === 'hits') && (S.key || S.demo)) refreshData();
});

function persist() {
  store.rw_key = S.key;
  store.rw_demo = S.demo ? '1' : '0';
  store.rw_interval = String(S.interval);
  store.rw_pin = S.pin;
  store.rw_sort = S.warsSort;
  store.rw_histfaction = S.hist.faction;
  if (S.room.warId) store.rw_lastwar = String(S.room.warId);
}

/* --------------------------------------------------------------- API calls */
async function torn(pathname, params = {}) {
  if (S.demo) return Demo.fetch(pathname, params);
  if (!S.key) throw { error: { error: 'No API key set. Add your key in the top bar (a Public key is enough).' } };
  const q = new URLSearchParams({ path: pathname, key: S.key });
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') q.set(k, v);
  let res;
  try {
    res = await fetch(RW_API_BASE + '/api/torn?' + q.toString());
  } catch (e) {
    throw { error: { error: 'Network error reaching the proxy server.' } };
  }
  let data;
  try { data = await res.json(); } catch (e) { throw { error: { error: `Proxy returned HTTP ${res.status}` } }; }
  if (data && data.error) throw data;
  return data;
}

/* --------------------------------------------------------- war normalizing */
function normalizeWar(w) {
  if (!w) return null;
  const factions = (w.factions || []).map((f) => ({ id: +f.id, name: f.name || 'Unknown', score: +f.score || 0, chain: +f.chain || 0 }));
  const start = +w.start || 0;
  const end = +w.end || 0;
  return {
    id: +(w.id || w.war_id) || 0,
    start, end,
    target: +w.target || 0,
    winner: w.winner == null || w.winner === 0 ? 0 : +w.winner,
    factions,
  };
}
function warPhase(w) {
  const now = Date.now() / 1000;
  if (w.winner) return 'done';
  if (w.start > now) return 'soon';
  if (!w.end || w.end > now) return 'live';
  return 'ending';
}

/* ------------------------------------------------------------ demo engine */
const Demo = (() => {
  const rand = (a, b) => a + Math.random() * (b - a);
  const ri = (a, b) => Math.floor(rand(a, b + 1));
  const NAMES = ['Draven', 'Kaldo', 'Nix', 'Saber', 'Volkov', 'Mantis', 'Riggs', 'Echo', 'Ferrox', 'Jaxx', 'Onyx', 'Piper', 'Rictus', 'Sable', 'Talon', 'Vex', 'Wraith', 'Zephyr', 'Bruiser', 'Cinder', 'Dagger', 'Ember', 'Flint', 'Grimm', 'Havoc', 'Ivory', 'Junker', 'Karma', 'Lowkey', 'Moxie', 'Nemesis', 'Orion', 'Pyro', 'Quill', 'Rogue', 'Slade', 'Tempo', 'Umbra', 'Vandal', 'Wolfe'];
  const POS = ['Leader', 'Co-leader', 'Right Hand', 'Lieutenant', 'Soldier', 'Soldier', 'Soldier', 'Muscle', 'Muscle', 'Courier'];
  const REVIVE = ['Everyone', 'No one', 'Friends and faction', 'Donators'];

  const FAC = [
    { id: 33421, name: 'Midnight Syndicate', tag: 'MSY' },
    { id: 41190, name: 'Iron Vanguard', tag: 'IRON' },
    { id: 12877, name: 'The Raven Company', tag: 'RAVN' },
    { id: 50233, name: 'Glass Cannons', tag: 'GLAS' },
    { id: 21984, name: 'Hollow Point', tag: 'HOLLOW' },
    { id: 47210, name: 'Crimson Pact', tag: 'CRIM' },
    { id: 30155, name: 'Night Reapers', tag: 'REAP' },
    { id: 45902, name: 'Static Noise', tag: 'STAT' },
  ];
  const fac = (id) => FAC.find((f) => f.id === id);

  // seeded rng for stable rosters
  function mulberry(seed) { return function () { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  function makeRoster(facId) {
    const rng = mulberry(facId * 7919);
    const n = 11 + Math.floor(rng() * 5);
    const used = new Set();
    const out = [];
    for (let i = 0; i < n; i++) {
      let nm = NAMES[Math.floor(rng() * NAMES.length)];
      if (used.has(nm)) nm += ri(1, 99);
      used.add(nm);
      out.push({
        id: 100000 + ((facId * 31 + i * 137) % 899999),
        name: nm,
        position: POS[Math.floor(rng() * POS.length)],
        level: 28 + Math.floor(rng() * 62),
        days_in_faction: 3 + Math.floor(rng() * 900),
        is_revivable: rng() < 0.25,
        is_on_wall: false,
        is_in_oc: rng() < 0.3,
        has_early_discharge: false,
        revive_setting: REVIVE[Math.floor(rng() * REVIVE.length)],
        last_action: { status: rng() < 0.5 ? 'Online' : 'Idle', timestamp: 0, relative: '' },
        status: { description: 'Okay', details: null, state: 'Okay', until: 0, color: 'green' },
      });
    }
    return out;
  }

  const rosters = {};
  FAC.forEach((f) => { rosters[f.id] = makeRoster(f.id); });

  // simulated chains (own faction + first enemy) — ticks down, random hits keep them alive
  const chains = {
    33421: { current: 137, max: 150, modifier: 1.1, timeout: 58, cooldown: 0 },
    41190: { current: 61, max: 100, modifier: 1.2, timeout: 33, cooldown: 0 },
  };
  function tickChains(secElapsed) {
    const nowS = Date.now() / 1000;
    Object.values(chains).forEach((c) => {
      if (c.cooldown > nowS) return; // cooling down — timer paused
      c.timeout -= secElapsed;
      if (c.timeout <= 0) { c.current = 0; c.timeout = 0; } // chain broke
      if (c.current > 0 && Math.random() < 0.45) {
        c.current += 1;
        c.timeout = 85; // someone hit — timer resets
        if (c.current >= c.max) { c.cooldown = Math.floor(nowS + 600); c.max = c.current + 50; } // milestone cooldown
      }
    });
  }

  const NOW = Date.now() / 1000;
  const wars = [
    { id: 9121, start: NOW - 43 * 3600, end: NOW + 13.4 * 3600, target: 16500, winner: 0, factions: [{ id: 33421, score: 9412, chain: 12, rate: 11.5 }, { id: 41190, score: 8204, chain: 0, rate: 9.2 }], _sched: 3.6 * 86400 },
    { id: 9122, start: NOW - 22 * 3600, end: NOW + 30.5 * 3600, target: 8000, winner: 0, factions: [{ id: 12877, score: 6104, chain: 0, rate: 7.1 }, { id: 50233, score: 3402, chain: 33, rate: 5.6 }], _sched: 3.6 * 86400 },
    { id: 9123, start: NOW - 20 * 3600, end: NOW + 85 * 60, target: 4000, winner: 0, factions: [{ id: 21984, score: 3701, chain: 5, rate: 4.2 }, { id: 47210, score: 2915, chain: 0, rate: 3.7 }], _sched: 1.1 * 86400 },
    { id: 9124, start: NOW + 8 * 3600, end: NOW + 8 * 3600 + 3.6 * 86400, target: 6000, winner: 0, factions: [{ id: 30155, score: 0, chain: 0, rate: 0 }, { id: 45902, score: 0, chain: 0, rate: 0 }], _sched: 3.6 * 86400 },
  ].map((w) => ({ ...w, factions: w.factions.map((f) => ({ ...f, name: fac(f.id).name })) }));

  function seedStatuses() {
    const now = Date.now() / 1000;
    FAC.forEach((f, fi) => {
      rosters[f.id].forEach((m, i) => {
        const r = (mulberry(f.id * 131 + i * 17 + 5))();
        m.last_action.timestamp = Math.floor(now - rand(60, 72000));
        m.last_action.relative = '';
        if (r < 0.45) Object.assign(m.status, { state: 'Okay', description: 'Okay', until: 0, color: 'green', details: null });
        else if (r < 0.85) { const t = Math.floor(now + rand(90, 5400)); Object.assign(m.status, { state: 'Hospital', description: `In hospital for ${fmtDurShort(t * 1000 - Date.now())}`, until: t, color: 'red', details: 'Hospitalized' }); }
        else if (r < 0.9) { const t = Math.floor(now + rand(300, 7200)); Object.assign(m.status, { state: 'Jail', description: `In jail for ${fmtDurShort(t * 1000 - Date.now())}`, until: t, color: 'red', details: 'Jailed' }); }
        else if (r < 0.97) Object.assign(m.status, { state: 'Traveling', description: 'Traveling away', until: 0, color: 'blue', details: null });
        else Object.assign(m.status, { state: 'Abroad', description: 'In Mexico', until: 0, color: 'blue', details: null });
      });
    });
  }
  seedStatuses();

  let lastTick = Date.now();
  function tick() {
    const now = Date.now();
    const secElapsed = Math.min((now - lastTick) / 1000, 120);
    const mins = secElapsed / 60; // cap catch-up
    lastTick = now;
    tickChains(secElapsed);
    const nowS = now / 1000;
    wars.forEach((w) => {
      if (w.start > nowS) return;
      w.factions.forEach((f) => {
        if (f.rate > 0) {
          f.score += Math.round(f.rate * mins * rand(0.55, 1.5));
          if (Math.random() < 0.25) f.chain = Math.max(0, f.chain + ri(-3, 6));
        }
      });
      if (w.end && w.end <= nowS && !w.winner) w.winner = (w.factions[0].score >= w.factions[1].score ? w.factions[0].id : w.factions[1].id);
    });
    // statuses evolve
    FAC.forEach((f) => rosters[f.id].forEach((m) => {
      if (m.status.until && m.status.until <= nowS) {
        Object.assign(m.status, { state: 'Okay', description: 'Okay', until: 0, color: 'green', details: null });
      } else if (m.status.state === 'Okay' && Math.random() < 0.02) {
        const t = Math.floor(nowS + rand(120, 3600));
        Object.assign(m.status, { state: 'Hospital', description: 'In hospital', until: t, color: 'red', details: 'Hospitalized' });
      }
      if (Math.random() < 0.06) m.last_action.timestamp = Math.floor(nowS - rand(30, 40000));
      m.is_on_wall = Math.random() < 0.08;
    }));
  }

  const finished = (() => {
    const mk = (id, daysAgo, durDays, a, b, winnerId, target) => ({
      id, start: NOW - daysAgo * 86400 - durDays * 86400, end: NOW - daysAgo * 86400, target, winner: winnerId,
      factions: [
        { id: a.id, name: fac(a.id).name, score: a.score, chain: 0 },
        { id: b.id, name: fac(b.id).name, score: b.score, chain: 0 },
      ],
    });
    return [
      mk(8988, 6, 3.5, { id: 33421, score: 8412 }, { id: 50233, score: 6110 }, 33421, 8000),
      mk(8854, 18, 3.5, { id: 33421, score: 5418 }, { id: 41190, score: 7233 }, 41190, 7000),
      mk(8701, 31, 2.5, { id: 33421, score: 3987 }, { id: 21984, score: 2104 }, 33421, 4000),
    ];
  })();

  function memberReport(facId, totalScore, winner) {
    const rng = mulberry(facId * 3571 + 11);
    const base = rosters[facId].filter((_, i) => i < 12);
    const ws = base.map(() => 0.2 + rng() * rng());
    const sum = ws.reduce((a, b) => a + b, 0);
    let scoreSum = 0;
    const members = base.map((m, i) => {
      let sc = Math.max(0, Math.round((totalScore * ws[i] / sum) * 10) / 10);
      scoreSum += sc;
      return { id: m.id, name: m.name, level: m.level, attacks: Math.round(sc / rand(18, 42)), score: sc };
    });
    const diff = totalScore - scoreSum;
    members[0].score = Math.round((members[0].score + diff) * 10) / 10;
    return members.sort((x, y) => y.score - x.score);
  }

  const RANKS = ['Unranked', 'Bronze 4', 'Bronze 2', 'Silver 3', 'Silver 1', 'Gold 4', 'Gold 2', 'Platinum 3', 'Diamond 1'];
  function reportFor(warId) {
    const w = finished.find((x) => x.id === warId);
    if (!w) return null;
    const rng = mulberry(warId);
    return {
      id: w.id, start: w.start, end: w.end, winner: w.winner, forfeit: false,
      factions: w.factions.map((f, idx) => {
        const won = f.id === w.winner;
        const bi = Math.floor(rng() * RANKS.length);
        return {
          id: f.id, name: f.name, score: f.score, attacks: 120 + Math.floor(rng() * 300),
          rank: { before: RANKS[bi], after: won ? RANKS[Math.min(RANKS.length - 1, bi + 1)] : RANKS[Math.max(0, bi - 1)] },
          rewards: won
            ? { respect: 200 + Math.floor(rng() * 300), points: 10 + Math.floor(rng() * 50), items: [{ id: 64, name: 'Xanax', quantity: 2 }, { id: 197, name: 'Premium Package', quantity: 1 }] }
            : { respect: 40 + Math.floor(rng() * 80), points: 2 + Math.floor(rng() * 10), items: [] },
          members: memberReport(f.id, f.score, won),
        };
      }),
    };
  }

  function hitSeed() {
    const foe = rosters[41190].slice().sort((a, b) => b.level - a.level).slice(0, 3);
    const notes = ['big stats — chain them first', 'reviver, leave for last', ''];
    const claimed = ['Kaldo', '', ''];
    return foe.map((m, i) => ({ id: m.id, name: m.name, level: m.level, priority: i + 1, note: notes[i], claimed: claimed[i], addedAt: Date.now() }));
  }


  function ffApi(mode, params = {}) {
    if (mode === 'check') {
      return Promise.resolve({ key: 'demo', is_registered: true, registered_at: Math.floor(NOW - 200 * 86400), last_used: Math.floor(NOW), policy_version: 2, policy_update_required: false, is_premium: true, premium_expires_at: Math.floor(NOW + 30 * 86400), faction_id: 33421 });
    }
    if (mode === 'register') return Promise.resolve({ ok: true, message: 'registered (demo)' });
    if (mode === 'stats') {
      const ids = String(params.ids || '').split(',').map((x) => +x).filter(Boolean);
      const dists = [
        ['STR (60%) SPD (30%)', { strength: 60, speed: 30 }],
        ['DEF (55%) DEX (25%)', { defense: 55, dexterity: 25 }],
        ['SPD (50%) STR (30%)', { speed: 50, strength: 30 }],
        ['DEX (45%) DEF (35%)', { dexterity: 45, defense: 35 }],
      ];
      return new Promise((resolve) => setTimeout(() => {
        resolve(ids.map((id) => {
          const rng = mulberry(id * 977 + 3);
          const hasSpy = rng() < 0.55;
          const total = Math.round(Math.pow(10, 5.2 + rng() * 4.3)); // ~150k ... ~30b
          const pct = dists[Math.floor(rng() * dists.length)];
          let spy = null;
          if (hasSpy) {
            const w = [0.15 + rng() * 0.35, 0.15 + rng() * 0.35, 0.15 + rng() * 0.35];
            const sum = w.reduce((a, b) => a + b, 0);
            const shares = w.map((x) => x / sum); // 4th stat gets the remainder
            const keys = ['strength', 'defense', 'speed', 'dexterity'];
            spy = { total, last_updated: Math.floor(NOW - rng() * 30 * 86400), source: rng() < 0.5 ? 'tornstats' : 'yata', source_faction_id: 33421 };
            keys.forEach((k, i) => { spy[k] = Math.max(5000, Math.round(total * (i < 3 ? shares[i] : (1 - shares[0] - shares[1] - shares[2])))); });
          }
          return {
            player_id: id,
            fair_fight: Math.round((1 + rng() * 2) * 100) / 100,
            bs_estimate: total,
            bs_estimate_human: fmtBS(total),
            bss_public: hasSpy ? Math.round(total / (2500 + rng() * 5000)) : null,
            last_updated: Math.floor(NOW - rng() * 20 * 86400),
            source: hasSpy ? 'spies' : 'bss',
            distribution: hasSpy ? null : { last_updated: Math.floor(NOW - rng() * 15 * 86400), distribution_human: pct[0], stats_percentage: pct[1] },
            spies: spy ? [spy] : [],
            available_estimates: { bss: null, premium: null, spies: null },
          };
        }));
      }, 250));
    }
    return Promise.reject({ error: { error: 'Demo: unsupported FF mode ' + mode } });
  }

  async function fetch(pathname, params = {}) {
    await new Promise((r) => setTimeout(r, 90));
    tick();
    if (pathname === '/faction/warfareranked') return { warfareranked: wars };
    if (pathname === '/faction/wars') { const w = wars.find((x) => x.id === 9121); return { wars: { ranked: w ? { war_id: w.id, start: w.start, end: w.end, target: w.target, winner: w.winner, factions: w.factions.map(({ id, name, score, chain }) => ({ id, name, score, chain })) } : null, raids: [], territory: [] }, pacts: [] }; }
    if (pathname === '/faction/basic') { const f = fac(33421); return { basic: { id: f.id, name: f.name, tag: f.tag, leader: 1, 'co-leader': 2, respect: 125000, age: 1900, capacity: 25, best_chain: 241, rank: { level: 3, name: 'Silver', division: 1, position: 42, wins: 12 } } }; }
    let m = pathname.match(/^\/faction\/(\d+)\/members$/);
    if (m) return { members: rosters[+m[1]] };
    m = pathname.match(/^\/faction\/(\d+)\/chain$/);
    if (m) {
      const c = chains[+m[1]];
      if (!c || !c.current) return { chain: null };
      return { chain: { id: 1, current: c.current, max: c.max, timeout: c.timeout, modifier: c.modifier, cooldown: c.cooldown, start: Math.floor(NOW - 3600), end: 0 } };
    }
    m = pathname.match(/^\/faction\/(\d+)\/rankedwars$/);
    if (m) return { rankedwars: finished.filter((w) => w.factions.some((f) => f.id === +m[1])) };
    m = pathname.match(/^\/faction\/(\d+)\/rankedwarreport$/);
    if (m) { const r = reportFor(+m[1]); if (!r) throw { error: { error: 'Ranked war report not found' } }; return { rankedwarreport: r }; }
    throw { error: { error: 'Demo: unsupported path ' + pathname } };
  }

  function myId() { return rosters[33421][0].id; }

  return { fetch, DEMO_PIN: 33421, hitSeed, ffApi, myId };
})();

/* ------------------------------------------------------------- data loads */
async function loadWars() {
  const data = await torn('/faction/warfareranked', { sort: 'DESC', limit: 100 });
  let list = (data.warfareranked || []).map(normalizeWar).filter(Boolean);
  try {
    // the key owner's current war — authoritative even when the global list lags
    const own = await torn('/faction/wars');
    const r = own && own.wars && own.wars.ranked;
    if (r && !r.winner) {
      const nw = normalizeWar(r);
      if (nw && !list.some((w) => w.id === nw.id)) { nw.own = true; list.unshift(nw); }
      else { const ex = list.find((w) => w.id === nw.id); if (ex) ex.own = true; }
    }
  } catch (e) { /* no war / no access — fine */ }
  S.wars = list;
  S.warsLoaded = true;
}

async function loadRosters(war) {
  const jobs = war.factions.map(async (f) => {
    try {
      const d = await torn(`/faction/${f.id}/members`, { striptags: 'true' });
      const arr = Array.isArray(d.members) ? d.members : Array.isArray(d) ? d : [];
      return [f.id, arr];
    } catch (e) {
      S.room.rosterErr[f.id] = (e && e.error && (e.error.error || e.error.code)) || 'failed';
      return [f.id, null];
    }
  });
  const res = await Promise.all(jobs);
  res.forEach(([id, arr]) => {
    if (arr) {
      if (war.factions[0] && +war.factions[0].id === id) S.room.rosterA = arr;
      else if (war.factions[1] && +war.factions[1].id === id) S.room.rosterB = arr;
      delete S.room.rosterErr[id];
    }
  });
}

/* ------------------------------------------------------------------ chart */
function histKey(warId) { return `rw_hist_${warId}`; }
function histPush(warId, a, b) {
  try {
    const k = histKey(warId);
    const arr = JSON.parse(store.getItem(k) || '[]');
    const last = arr[arr.length - 1];
    if (!last || last.a !== a || last.b !== b) {
      arr.push({ t: Date.now(), a, b });
      while (arr.length > 900) arr.shift();
      store.setItem(k, JSON.stringify(arr));
    }
    return arr;
  } catch (e) { return []; }
}
function drawSpark(war, data) {
  const cv = $('#spark');
  if (!cv || !war) return;
  const ctx = typeof cv.getContext === 'function' ? cv.getContext('2d') : null;
  if (!ctx) return; // e.g. non-canvas environments
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 600, H = cv.clientHeight || 130;
  cv.width = W * dpr; cv.height = H * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  const padL = 46, padR = 8, padT = 10, padB = 16;
  const iw = W - padL - padR, ih = H - padT - padB;
  let lo = 0, hi = Math.max(war.target, 1);
  const pts = data.filter((p) => p.a != null && p.b != null);
  if (!pts.length) {
    ctx.fillStyle = '#5d646f'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('score progression will appear here as the war room polls…', W / 2, H / 2);
    return;
  }
  const t0 = pts[0].t, t1 = Math.max(pts[pts.length - 1].t, t0 + 1000);
  const X = (t) => padL + ((t - t0) / (t1 - t0)) * iw;
  const Y = (v) => padT + ih - (v / hi) * ih;
  // grid
  ctx.strokeStyle = '#232830'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padT + (ih * i) / 4;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.fillStyle = '#5d646f'; ctx.font = '10px ui-monospace,monospace'; ctx.textAlign = 'right';
    ctx.fillText(fmtInt(Math.round((hi * (4 - i)) / 4)), padL - 6, y + 3);
  }
  // target line
  ctx.strokeStyle = '#f0b54199'; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(padL, Y(war.target)); ctx.lineTo(W - padR, Y(war.target)); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#f0b541'; ctx.font = '10px sans-serif'; ctx.textAlign = 'left';
  ctx.fillText('TARGET', padL + 4, Y(war.target) - 4);
  const line = (key, color) => {
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
    pts.forEach((p, i) => { const x = X(p.t), y = Y(p[key]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
    // end dot
    const lp = pts[pts.length - 1];
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(X(lp.t), Y(lp[key]), 3, 0, Math.PI * 2); ctx.fill();
  };
  line('a', '#63c74d');
  line('b', '#e8453c');
}

/* ----------------------------------------------------------- status utils */
function statusInfo(m) {
  const st = m.status || {};
  const state = st.state || (st.description || 'Okay');
  const until = +st.until || 0;
  let cls = 'other', label = String(st.description || state);
  const key = String(state).toLowerCase();
  if (key.includes('okay')) { cls = 'ok'; label = 'Okay'; }
  else if (key.includes('hospital')) { cls = 'hosp'; label = 'Hosp ' + (until ? `<span data-cd="${until}" data-short="1">${fmtDurShort(until * 1000 - Date.now())}</span>` : ''); }
  else if (key.includes('jail')) { cls = 'jail'; label = 'Jail ' + (until ? `<span data-cd="${until}" data-short="1">${fmtDurShort(until * 1000 - Date.now())}</span>` : ''); }
  else if (key.includes('travel')) { cls = 'trav'; label = 'Traveling'; }
  else if (key.includes('abroad')) { cls = 'trav'; label = 'Abroad'; }
  return { cls, label, state, until, okay: key.includes('okay') };
}
function availabilityRank(m) {
  return availRankSI(statusInfo(m));
}

/* -------------------------------------------------------------- rendering */
function saveFocus() {
  const ae = document.activeElement;
  if (ae && ae.id && (ae.tagName === 'INPUT' || ae.tagName === 'SELECT')) {
    S.focus = { id: ae.id, start: ae.selectionStart, end: ae.selectionEnd };
  } else S.focus = null;
}
function restoreFocus() {
  if (!S.focus) return;
  const el = document.getElementById(S.focus.id);
  if (el) {
    try { el.focus(); if (S.focus.start != null && el.setSelectionRange) el.setSelectionRange(S.focus.start, S.focus.end); } catch (e) {}
  }
  S.focus = null;
}

function renderTabs() {
  $$('#tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === S.tab));
  $('#demo-badge').hidden = !S.demo;
  const dot = $('#key-dot');
  dot.className = 'dot' + (S.key ? ' on' : '') ;
  $('#demo-toggle').checked = S.demo;
  $('#interval-select').value = String(S.interval);
}

function renderErr() {
  const el = $('#errbar');
  if (!S.err) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = `<span>⚠ ${esc(S.err)}</span><button class="x" data-action="dismiss-err" title="Dismiss">✕</button>`;
}

/* ----- wars tab ----- */
function warCard(w) {
  const [a, b] = w.factions;
  const phase = warPhase(w);
  const total = a.score + b.score;
  const shareL = total > 0 ? (a.score / total) * 100 : 50;
  const youA = +S.pin === a.id, youB = +S.pin === b.id;
  const chip = phase === 'live' ? '<span class="chip live">LIVE</span>'
    : phase === 'soon' ? `<span class="chip soon">STARTS <span data-cd="${w.start}" data-short="1">${fmtDurShort(w.start * 1000 - Date.now())}</span></span>`
    : phase === 'ending' ? '<span class="chip">ENDING…</span>' : '<span class="chip done">FINISHED</span>';
  const timer = w.end
    ? (phase === 'soon' ? `starts <span data-cd="${w.start}" data-short="1">${fmtDurShort(w.start * 1000 - Date.now())}</span>`
      : `ends in <span data-cd="${w.end}" data-short="1">${fmtDurShort(w.end * 1000 - Date.now())}</span>`)
    : 'no scheduled end';
  const progA = pct(a.score, w.target), progB = pct(b.score, w.target);
  return `
  <div class="panel warcard" data-action="open-war" data-war="${w.id}" role="button" tabindex="0">
    <div class="wc-top">${chip}${w.own ? '<span class="chip you">YOUR WAR</span>' : ''}<span class="wc-timer">${timer}</span></div>
    <div class="wc-factions">
      <div class="wc-f left">
        <div class="wc-fname" title="${esc(a.name)}">${youA ? '<span class="chip you">YOU</span> ' : ''}${esc(a.name)}</div>
        <div class="wc-fscore">${fmtInt(a.score)}</div>
        <div class="wc-sub">${progA}% of target ${a.chain ? `· ⚡ ${fmtInt(a.chain)}` : ''}</div>
      </div>
      <div class="wc-vs">VS</div>
      <div class="wc-f right">
        <div class="wc-fname" title="${esc(b.name)}">${esc(b.name)}${youB ? ' <span class="chip you">YOU</span>' : ''}</div>
        <div class="wc-fscore">${fmtInt(b.score)}</div>
        <div class="wc-sub">${progB}% of target ${b.chain ? `· ⚡ ${fmtInt(b.chain)}` : ''}</div>
      </div>
    </div>
    <div class="wc-dom">
      <div class="l" style="width:${shareL}%"></div><div class="r" style="width:${100 - shareL}%"></div>
    </div>
    <div class="targetline"><div class="fill" style="width:${Math.max(progA, progB)}%"></div></div>
    <div class="wc-foot">
      <span class="muted tiny">War #${w.id}</span>
      <span class="muted tiny">target ${fmtInt(w.target)}</span>
      ${w.winner ? `<span class="chip ${w.winner === a.id ? 'win' : 'loss'}">W: ${esc((a.id === w.winner ? a : b).name)}</span>` : ''}
      <span class="spacer"></span><span class="muted tiny">open war room →</span>
    </div>
  </div>`;
}

function sortedWars() {
  const now = Date.now() / 1000;
  let list = S.wars.filter((w) => warPhase(w) !== 'done');
  if (S.warsSearch) {
    const q = S.warsSearch.toLowerCase();
    list = list.filter((w) => w.factions.some((f) => f.name.toLowerCase().includes(q)) || String(w.id).includes(q));
  }
  const phaseOrder = { live: 0, ending: 0, soon: 1 };
  const sorters = {
    ending: (x, y) => (phaseOrder[warPhase(x)] - phaseOrder[warPhase(y)]) || ((x.end || Infinity) - (y.end || Infinity)),
    target: (x, y) => (phaseOrder[warPhase(x)] - phaseOrder[warPhase(y)]) || (Math.max(...y.factions.map((f) => f.score / (y.target || 1))) - Math.max(...x.factions.map((f) => f.score / (x.target || 1)))),
    started: (x, y) => y.start - x.start,
    name: (x, y) => (x.factions[0] || {}).name.localeCompare((y.factions[0] || {}).name),
  };
  return list.sort(sorters[S.warsSort] || sorters.ending);
}

function renderWars() {
  if (!S.key && !S.demo) { renderWelcome(); return; }
  if (!S.warsLoaded) {
    view.innerHTML = S.err
      ? `<div class="panel pad center" style="padding:40px"><div class="muted">⚠ ${esc(String(S.err))}</div><div style="margin-top:14px"><button class="btn primary" data-action="refresh-now">Retry</button></div></div>`
      : '<div class="skeleton blink">LOADING RANKED WARS…</div>';
    return;
  }
  const list = sortedWars();
  const live = list.filter((w) => warPhase(w) === 'live').length;
  const soon = list.filter((w) => warPhase(w) === 'soon').length;
  view.innerHTML = `
    <div class="toolbar">
      <span class="muted tiny">${live} live · ${soon} scheduled</span>
      <span class="spacer"></span>
      <input type="text" id="wars-search" placeholder="Search faction or war id…" value="${esc(S.warsSearch)}" style="width:220px">
      <label class="muted tiny">sort</label>
      <select id="wars-sort">
        <option value="ending" ${S.warsSort === 'ending' ? 'selected' : ''}>ending soonest</option>
        <option value="target" ${S.warsSort === 'target' ? 'selected' : ''}>closest to target</option>
        <option value="started" ${S.warsSort === 'started' ? 'selected' : ''}>newest</option>
        <option value="name" ${S.warsSort === 'name' ? 'selected' : ''}>name</option>
      </select>
    </div>
    ${list.length ? `<div class="grid-wars">${list.map(warCard).join('')}</div>`
      : `<div class="panel pad center muted" style="padding:40px">No ongoing or scheduled ranked wars found for this key.${S.demo ? '' : '<br><span class="tiny">Wars appear here as soon as factions enlist. Your own faction\u2019s live war is picked up even if the global list lags.</span>'}</div>`}
    <p class="muted tiny" style="margin-top:12px">Click a war to open the war room (scoreboards, countdowns, rosters, live statuses). The target bar (amber) shows the leading faction\u2019s progress; the green/red bar shows score dominance.</p>`;
  restoreFocus();
}

function renderWelcome() {
  view.innerHTML = `
  <div class="welcome">
    <div class="panel">
      <h1>⚔ TORN RANK WARS</h1>
      <p class="muted">A live tracker for Torn ranked wars — global war list, scoreboards, targets, countdowns, rosters with hospital timers, and full finished-war reports.</p>
      <ol class="steps">
        <li>Grab your API key: <b>Torn → Settings → API keys</b> (<a href="https://www.torn.com/preferences.php#tab=api" target="_blank" rel="noopener">open</a>) — create a <b>Public</b> key, that\u2019s enough.</li>
        <li>Paste it in the key field at the top and hit <kbd>Save</kbd>.</li>
        <li>Wars refresh automatically every ${S.interval}s.</li>
      </ol>
      <div class="row" style="margin-top:18px">
        <button class="btn primary" data-action="goto-demo">Explore in demo mode</button>
        <button class="btn" data-action="set-tab" data-tab="about">Setup &amp; about</button>
      </div>
      <div class="note">No key? Demo mode runs the whole app on simulated data so you can look around.</div>
    </div>
  </div>`;
}

/* ----- war room ----- */
function pickDefaultWar() {
  if (S.room.warId && S.wars.some((w) => w.id === S.room.warId)) return S.room.warId;
  const mine = S.wars.filter((w) => warPhase(w) !== 'done' && w.factions.some((f) => +f.id === +S.pin));
  if (mine.length) return mine[0].id;
  const live = S.wars.filter((w) => warPhase(w) === 'live').sort((a, b) => (a.end || Infinity) - (b.end || Infinity));
  if (live.length) return live[0].id;
  const any = S.wars.filter((w) => warPhase(w) !== 'done');
  return any.length ? any[0].id : null;
}

function rosterTable(faction, roster, war, isEnemySide) {
  const head = (key, label, cls) => `<th data-action="roster-sort" data-key="${key}" class="${cls || ''}">${label}${S.room.sortBy === key ? (S.room.sortDir < 0 ? ' ▾' : ' ▴') : ''}</th>`;
  let rows = (roster || []).slice();
  const q = S.room.search.toLowerCase();
  if (q) rows = rows.filter((m) => m.name.toLowerCase().includes(q) || String(m.id).includes(q));
  const f = S.room.filter;
  if (f === 'okay') rows = rows.filter((m) => statusInfo(m).okay);
  else if (f === 'hosp') rows = rows.filter((m) => statusInfo(m).state === 'Hospital');
  else if (f === 'avail') rows = rows.filter((m) => { const si = statusInfo(m); return si.okay || (si.state === 'Hospital' && si.until && si.until - Date.now() / 1000 < 600); });
  const dir = S.room.sortDir;
  const sorters = {
    level: (a, b) => dir * (b.level - a.level),
    name: (a, b) => dir * a.name.localeCompare(b.name),
    status: (a, b) => { const [ax, ay] = availabilityRank(a), [bx, by] = availabilityRank(b); return dir * (ax - bx || ay - by); },
    action: (a, b) => dir * ((b.last_action && b.last_action.timestamp) - (a.last_action && a.last_action.timestamp)),
  };
  rows.sort(sorters[S.room.sortBy] || sorters.level);
  const body = rows.map((m, i) => {
    const si = statusInfo(m);
    return `<tr>
      <td class="muted num">${i + 1}</td>
      <td><a href="https://www.torn.com/profiles.php?XID=${m.id}" target="_blank" rel="noopener">${esc(m.name)}</a>${m.is_on_wall ? ' <span class="chip you" title="On territory wall">WALL</span>' : ''}${m.position ? `<div class="muted tiny">${esc(m.position)}</div>` : ''}</td>
      <td class="num">${m.level}</td>
      <td class="status-${si.cls}">${si.label}${m.has_early_discharge ? ' <span class="chip" title="Eligible for early discharge">ED</span>' : ''}</td>
      <td class="muted tiny">${m.last_action && m.last_action.timestamp ? ago(m.last_action.timestamp) : '—'}</td>
    </tr>`;
  }).join('');
  const err = S.room.rosterErr[faction.id];
  return `
    <div class="panel roster">
      <div class="roster-head ${isEnemySide ? 'enemy' : 'own'}">
        <div class="row wrap">
          <span class="sb-name"><a href="https://www.torn.com/factions.php?step=profile&ID=${faction.id}" target="_blank" rel="noopener" style="color:inherit">${esc(faction.name)}</a></span>
          <span class="rf-score mono">${fmtInt(faction.score)}</span>
          <span class="spacer"></span>
          ${faction.chain ? `<span class="chip chain">⚡ CHAIN ${fmtInt(faction.chain)}</span>` : ''}
          ${+S.pin === faction.id ? '<span class="chip you">YOU</span>' : ''}
        </div>
        <div class="statrow">${rosterStats(roster)}</div>
      </div>
      ${err ? `<div class="pad muted tiny">Couldn\u2019t load roster: ${esc(String(err))}</div>`
        : `<div class="tblscroll"><table class="tbl">
            <thead><tr>${head('name', 'Player')}${head('level', 'Lvl', 'num')}${head('status', 'Status')}${head('action', 'Last action')}</tr></thead>
            <tbody>${body || '<tr><td colspan="5" class="muted pad center">no members match</td></tr>'}</tbody>
          </table></div>`}
    </div>`;
}

function rosterStats(roster) {
  if (!roster || !roster.length) return '<span class="muted tiny">no roster data</span>';
  let ok = 0, hosp = 0, trav = 0, rev = 0, lvl = 0;
  roster.forEach((m) => {
    const si = statusInfo(m);
    if (si.okay) ok++;
    else if (si.state === 'Hospital') hosp++;
    else if (si.cls === 'trav') trav++;
    if (m.is_revivable) rev++;
    lvl += m.level || 0;
  });
  const soon = roster.filter((m) => { const si = statusInfo(m); return si.state === 'Hospital' && si.until && si.until * 1000 - Date.now() < 10 * 60000; }).length;
  return `
    <span class="chip"><span class="status-ok">● ${ok}</span>&nbsp;okay</span>
    <span class="chip"><span class="status-hosp">✚ ${hosp}</span>&nbsp;hosp${soon ? ` · ${soon} &lt;10m` : ''}</span>
    <span class="chip"><span class="status-trav">✈ ${trav}</span>&nbsp;away</span>
    <span class="chip">⚑ ${rev} revivable</span>
    <span class="chip">ø lvl ${Math.round(lvl / roster.length)}</span>`;
}

function renderRoom() {
  if (!S.key && !S.demo) { renderWelcome(); return; }
  if (!S.warsLoaded) {
    view.innerHTML = S.err
      ? `<div class="panel pad center" style="padding:40px"><div class="muted">⚠ ${esc(String(S.err))}</div><div style="margin-top:14px"><button class="btn primary" data-action="refresh-now">Retry</button></div></div>`
      : '<div class="skeleton blink">LOADING…</div>';
    return;
  }
  const warId = pickDefaultWar();
  if (warId && S.room.warId !== warId) S.room.warId = warId; // keep handlers in sync
  if (!warId) {
    view.innerHTML = `<div class="panel pad center muted" style="padding:40px">No ranked war available for this key yet.<br><span class="tiny">Open the LIVE WARS tab — as soon as any war is running it can be inspected here.</span></div>`;
    return;
  }
  const war = S.wars.find((w) => w.id === warId);
  if (!war) { view.innerHTML = '<div class="skeleton blink">LOADING WAR…</div>'; return; }
  const [a, b] = war.factions;
  const phase = warPhase(war);
  const lead = a.score === b.score ? null : (a.score > b.score ? a : b);
  const trail = lead ? (lead === a ? b : a) : null;
  const opts = warSelectOptions();
  const timerTxt = phase === 'soon'
    ? `starts in <span class="big-timer" data-cd="${war.start}">${fmtDur(war.start * 1000 - Date.now())}</span>`
    : war.end
      ? `<span class="big-timer" data-cd="${war.end}">${fmtDur(war.end * 1000 - Date.now())}</span>`
      : '<span class="big-timer">∞</span>';
  const share = a.score + b.score > 0 ? (a.score / (a.score + b.score)) * 100 : 50;
  view.innerHTML = `
    <div class="toolbar">
      <select id="room-select" style="min-width:260px">${opts}</select>
      <span class="chip ${phase === 'live' ? 'live' : phase === 'soon' ? 'soon' : 'done'}">${phase === 'live' ? 'LIVE' : phase === 'soon' ? 'SCHEDULED' : phase.toUpperCase()}</span>
      ${war.own ? '<span class="chip you">YOUR WAR</span>' : ''}
      <span class="muted tiny">War #${war.id}</span>
      <span class="spacer"></span>
      <span class="muted tiny">${war.end ? 'ends in' : 'war end'} ${timerTxt}</span>
    </div>
    <div class="panel scorebox pad room-head" style="flex:1 1 auto">
      <div class="sb-grid">
        <div class="sb-f left">
          <div class="sb-name" title="${esc(a.name)}">${+S.pin === a.id ? '<span class="chip you">YOU</span> ' : ''}${esc(a.name)}</div>
          <div class="sb-score">${fmtInt(a.score)}</div>
          <div class="wc-sub">${pct(a.score, war.target)}% of ${fmtInt(war.target)}</div>
        </div>
        <div class="center">
          <div class="muted tiny" style="letter-spacing:.2em">TARGET</div>
          <div class="mono" style="font-weight:800">${fmtInt(war.target)}</div>
          ${lead ? `<div class="sb-lead tiny" style="margin-top:6px">▲ ${esc(lead.name)} +${fmtInt(lead.score - trail.score)}</div>` : '<div class="muted tiny" style="margin-top:6px">dead even</div>'}
        </div>
        <div class="sb-f right">
          <div class="sb-name" title="${esc(b.name)}">${esc(b.name)}${+S.pin === b.id ? ' <span class="chip you">YOU</span>' : ''}</div>
          <div class="sb-score">${fmtInt(b.score)}</div>
          <div class="wc-sub">${pct(b.score, war.target)}% of ${fmtInt(war.target)}</div>
        </div>
      </div>
      <div class="wc-dom" style="margin:12px 0 0"><div class="l" style="width:${share}%"></div><div class="r" style="width:${100 - share}%"></div></div>
    </div>
    <div class="panel chartbox" style="margin-top:14px">
      <div class="row tiny muted" style="margin-bottom:4px"><span style="color:#63c74d;font-weight:800">■</span> ${esc(a.name)} &nbsp;<span style="color:#e8453c;font-weight:800">■</span> ${esc(b.name)} <span class="spacer"></span><span>score progression (this session)</span></div>
      <canvas id="spark" height="130"></canvas>
    </div>
    <h2 class="sect">Rosters &amp; live status</h2>
    <div class="toolbar">
      <input type="text" id="room-search" placeholder="Filter players…" value="${esc(S.room.search)}" style="width:200px">
      <label class="muted tiny">show</label>
      <select id="room-filter">
        <option value="all" ${S.room.filter === 'all' ? 'selected' : ''}>everyone</option>
        <option value="avail" ${S.room.filter === 'avail' ? 'selected' : ''}>attackable (okay / out of hosp &lt;10m)</option>
        <option value="okay" ${S.room.filter === 'okay' ? 'selected' : ''}>okay only</option>
        <option value="hosp" ${S.room.filter === 'hosp' ? 'selected' : ''}>hospital only</option>
      </select>
      <span class="muted tiny">sort</span>
      <select id="room-sortcol">
        <option value="level" ${S.room.sortBy === 'level' ? 'selected' : ''}>level</option>
        <option value="status" ${S.room.sortBy === 'status' ? 'selected' : ''}>availability</option>
        <option value="action" ${S.room.sortBy === 'action' ? 'selected' : ''}>last action</option>
        <option value="name" ${S.room.sortBy === 'name' ? 'selected' : ''}>name</option>
      </select>
      <span class="spacer"></span>
      <span class="muted tiny">ℹ Torn\u2019s API does not expose live <i>per-member</i> war scores — faction totals only. Member scores appear in finished-war reports (HISTORY tab).</span>
    </div>
    <div class="rosters">
      ${rosterTable(a, S.room.rosterA, war, false)}
      ${rosterTable(b, S.room.rosterB, war, true)}
    </div>`;
  restoreFocus();
  requestAnimationFrame(() => drawSpark(war, readHist(warId)));
}

function readHist(warId) {
  try { return JSON.parse(store.getItem(histKey(warId)) || '[]'); } catch (e) { return []; }
}

/* ----- the hit club: per-war target list (localStorage) ----- */
function hitsKey(warId) { return 'rw_hits_' + warId; }
function hitsGet(warId) {
  try { const v = JSON.parse(store.getItem(hitsKey(warId)) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}
function hitsSet(warId, arr) {
  try { store.setItem(hitsKey(warId), JSON.stringify(arr.slice(0, 50))); } catch (e) { /* storage full/blocked */ }
}
function availRankSI(si) {
  if (!si) return [3, 0];
  if (si.okay) return [0, 0];
  if (si.state === 'Hospital' && si.until) return [1, si.until];
  return [2, si.until || 90000000000];
}
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch (e) {}
  try {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) { return false; }
}

/* ----- ff scouter (ffscouter.com official API, proxied via /api/ffscouter) ----- */
const FF_TTL = 6 * 3600 * 1000; // local cache per player
async function ffApi(mode, params = {}) {
  if (S.demo) return Demo.ffApi(mode, params);
  if (!S.key) throw { error: { error: 'No API key set.' } };
  const q = new URLSearchParams({ mode, key: S.key });
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') q.set(k, v);
  let res;
  try { res = await fetch(RW_API_BASE + '/api/ffscouter?' + q.toString()); }
  catch (e) { throw { error: { error: 'Network error reaching the proxy server.' } }; }
  let data;
  try { data = await res.json(); }
  catch (e) { throw { error: { error: `Proxy returned HTTP ${res.status}` } }; }
  if (data && data.error) throw data;
  return data;
}
function ffCacheGet(id) {
  try {
    const v = JSON.parse(store.getItem('rw_ff_' + id) || 'null');
    return v && v.at && v.d ? v : null;
  } catch (e) { return null; }
}
function ffCacheSet(id, d) {
  try { store.setItem('rw_ff_' + id, JSON.stringify({ at: Date.now(), d })); } catch (e) {}
}
function ffDataFor(id) { // memory first (freshest), then localStorage within TTL
  if (S.ff.data[id]) return S.ff.data[id];
  const c = ffCacheGet(id);
  if (c && Date.now() - c.at < FF_TTL) return c;
  return null;
}
function ffEst(rec) { const v = rec && rec.d ? rec.d.bs_estimate : null; return v != null && Number.isFinite(+v) && +v > 0 ? +v : null; }
function ffFf(rec) { const v = rec && rec.d ? rec.d.fair_fight : null; return v != null && Number.isFinite(+v) && +v >= 1 ? +v : null; }
function ffScalePct(est) { // log scale 1k → 1t
  if (!est) return 0;
  const l = Math.log10(est);
  return Math.max(3, Math.min(100, ((l - 3) / 9) * 100));
}
function ffBand(rec) {
  const est = ffEst(rec);
  if (!est) return { cls: 'none', label: 'no data' };
  const p = ffScalePct(est);
  if (p < 25) return { cls: 'weak', label: 'very weak' };
  if (p < 50) return { cls: 'mid', label: 'weak' };
  if (p < 75) return { cls: 'strong', label: 'strong' };
  return { cls: 'tank', label: 'very strong' };
}
function ffStatDetail(rec) {
  const d = rec && rec.d;
  if (!d) return { html: '<span class="muted">—</span>' };
  const spy = Array.isArray(d.spies) && d.spies[0];
  if (spy) {
    return {
      html: `<span class="mono tiny ffstats">STR ${fmtBS(spy.strength)} · DEF ${fmtBS(spy.defense)} · SPD ${fmtBS(spy.speed)} · DEX ${fmtBS(spy.dexterity)}</span>`
        + `<div class="tiny muted">spy: ${esc(spy.source || '?')} · ${ago(spy.last_updated || d.last_updated)}</div>`,
    };
  }
  if (d.distribution && d.distribution.distribution_human) {
    return {
      html: `<span class="tiny">${esc(d.distribution.distribution_human)}</span>`
        + `<div class="tiny muted">distribution · ${ago(d.distribution.last_updated || d.last_updated)}</div>`,
    };
  }
  return { html: `<span class="muted tiny">estimate only</span><div class="tiny muted">${d.last_updated ? ago(d.last_updated) : ''}</div>` };
}
function ffSourceChip(rec) {
  const d = rec && rec.d;
  if (!d) return '';
  const src = d.source || '?';
  const cls = src === 'spies' ? 'win' : src === 'premium' ? 'chain' : '';
  return `<span class="chip ${cls}" title="estimate source">${esc(src)}</span>`;
}
async function ffCheck() {
  S.ff.checking = true; S.ff.statusErr = null; renderView();
  try {
    S.ff.status = await ffApi('check', {});
    S.ff.statusErr = null;
  } catch (e) {
    S.ff.status = null;
    S.ff.statusErr = (e && e.error && (e.error.error || e.error.code)) || 'Check failed';
  }
  S.ff.checking = false;
  renderView();
  if (S.ff.status && S.ff.status.is_registered && S.tab === 'hits') scoutFaction(false);
}
async function ffRegister() {
  if (!S.ff.consent) { S.ff.statusErr = 'Tick the box after reading the FF Scouter data policy & terms first.'; renderView(); return; }
  S.ff.registering = true; S.ff.statusErr = null; renderView();
  try {
    await ffApi('register', {});
  } catch (e) {
    S.ff.statusErr = (e && e.error && (e.error.error || e.error.code)) || 'Registration failed';
  }
  S.ff.registering = false;
  S.ff.myId = null; // re-anchor after registration (FF now knows the key owner)
  ensureMyIdentity();
  renderView();
  ffCheck();
}
async function scoutFaction(force = false) {
  const war = S.wars.find((w) => w.id === S.room.warId);
  if (!war) return;
  // scout the whole war: enemy targets AND your own squad (per-member matchup anchors)
  const all = (S.room.rosterA || []).concat(S.room.rosterB || []);
  if (!all.length) { renderView(); return; } // rosters not in yet — next poll will retry
  const ids = all.map((m) => m.id);
  if (S.ff.myId && !ids.includes(S.ff.myId)) ids.push(S.ff.myId); // scout ourselves too → powers "my est" anchor
  const need = force ? ids : ids.filter((id) => !ffDataFor(id));
  if (!need.length) { S.ff.lastScoutAt = Date.now(); renderView(); return; }
  if (S.ff.scouting) return;
  S.ff.scouting = true; S.ff.err = null;
  S.ff.scoutProg = { done: 0, total: need.length };
  renderView();
  try {
    for (let i = 0; i < need.length; i += 200) {
      const chunk = need.slice(i, i + 200);
      const arr = await ffApi('stats', { ids: chunk.join(',') });
      const list = Array.isArray(arr) ? arr : (arr && arr.targets) || [];
      list.forEach((d) => {
        if (d && d.player_id != null) {
          const rec = { at: Date.now(), d };
          S.ff.data[d.player_id] = rec;
          ffCacheSet(d.player_id, d);
        }
      });
      S.ff.scoutProg.done += chunk.length;
      if (S.ff.myId && S.ff.myEst == null && S.ff.data[S.ff.myId]) {
        S.ff.myEst = ffEst(S.ff.data[S.ff.myId]);
        if (S.ff.myEst == null) S.ff.myNoEst = true;
      }
      if (i + 200 < need.length) await new Promise((r) => setTimeout(r, 3500)); // stay under 20 req/min
    }
    S.ff.lastScoutAt = Date.now();
  } catch (e) {
    S.ff.err = (e && e.error && (e.error.error || e.error.code)) || 'FF Scouter request failed';
  }
  S.ff.scouting = false; S.ff.scoutProg = null;
  renderView();
}
function ffRangeSummary(roster) {
  const ests = roster.map((m) => ffEst(ffDataFor(m.id))).filter((x) => x);
  if (!ests.length) return null;
  ests.sort((a, b) => a - b);
  const med = ests[Math.floor(ests.length / 2)];
  return { min: ests[0], max: ests[ests.length - 1], med, n: ests.length };
}

function warSelectOptions() {
  return S.wars.filter((w) => warPhase(w) !== 'done')
    .map((w) => `<option value="${w.id}" ${w.id === S.room.warId ? 'selected' : ''}>${w.own ? '★ ' : ''}#${w.id} — ${esc(w.factions[0].name)} vs ${esc(w.factions[1].name)}${w.own ? ' (your war)' : ''}</option>`).join('');
}

/* ----- per-member war kill tally (faction attacks feed, Limited key) ----- */
const WK_PAGES_PER_CYCLE = 6;
const WK_WIN_RESULTS = ['Attacked', 'Mugged', 'Hospitalized', 'Arrested', 'Looted', 'Bounty', 'Special'];
function wkKey(warId, facId) { return 'rw_wk_' + warId + '_' + facId; }
function wkLoad(facId, warId) {
  try {
    const v = JSON.parse(store.getItem(wkKey(warId, facId)) || 'null');
    return v && v.counts ? v : { counts: {}, lastTs: 0, done: false };
  } catch (e) { return { counts: {}, lastTs: 0, done: false }; }
}
function wkSave(facId, warId, st) { try { store.setItem(wkKey(warId, facId), JSON.stringify(st)); } catch (e) {} }
function wkState(war, facId) {
  const key = war.id + '_' + facId;
  if (!S.warkills[key]) S.warkills[key] = wkLoad(facId, war.id);
  return S.warkills[key];
}
async function loadWarKills(war, facId, enemyIds) {
  if (!facId || !enemyIds || !enemyIds.size) return;
  const st = wkState(war, facId);
  const warOngoing = warPhase(war) !== 'done';
  if (warOngoing && st.lastTry && Date.now() - st.lastTry < 30000) return; // throttle catch-up polling
  if (S.demo) {
    if (!st.done) {
      const side = war.factions.findIndex((f) => +f.id === +facId);
      const roster = side === 0 ? S.room.rosterA : S.room.rosterB;
      (roster || []).forEach((m) => { st.counts[m.id] = 3 + (m.id % 41); });
      st.done = true;
      wkSave(facId, war.id, st);
    }
    return;
  }
  if (st.done || S.wkBusy) return;
  S.wkBusy = true;
  try {
    let from = st.lastTs ? st.lastTs + 1 : (+war.start || 0);
    for (let page = 0; page < WK_PAGES_PER_CYCLE; page++) {
      // v2 only exposes the key owner's faction attacks feed — which is exactly whose kills we tally
      const d = await torn('/faction/attacks', { filters: 'outgoing', from, sort: 'ASC', limit: 100 });
      const arr = (d && d.attacks) || [];
      arr.forEach((a) => {
        if (a && a.is_ranked_war && a.defender && enemyIds.has(+a.defender.id) && WK_WIN_RESULTS.includes(a.result)) {
          const atk = a.attacker && +a.attacker.id;
          if (atk) st.counts[atk] = (st.counts[atk] || 0) + 1;
        }
      });
      const last = arr[arr.length - 1];
      if (!last || arr.length < 100) {
        // caught up with the feed — for ongoing wars keep polling (throttled) so new kills count
        st.done = !warOngoing;
        st.lastTry = Date.now();
        break;
      }
      st.lastTs = +last.started || 0;
      from = st.lastTs + 1;
      wkSave(facId, war.id, st);
      if (from > Date.now() / 1000 + 5) { st.done = !warOngoing; st.lastTry = Date.now(); break; }
    }
    wkSave(facId, war.id, st);
    S.warkillsErr = null;
  } catch (e) {
    const code = e && e.error && e.error.code;
    const msg = String((e && e.error && e.error.error) || '');
    if (code === 7 || /incorrect permission|access.*limited|limited.*required/i.test(msg)) S.warkillsErr = 'limited';
    /* else: transient — retried on the next refresh cycle */
  }
  S.wkBusy = false;
}

/* ----- faction chain meters (GET /faction/{id}/chain, public) ----- */
function fmtMS(sec) {
  sec = Math.max(0, Math.floor(sec));
  return Math.floor(sec / 60) + ':' + pad2(sec % 60);
}
async function loadChains(war) {
  const jobs = war.factions.map(async (f) => {
    try {
      const d = await torn(`/faction/${f.id}/chain`);
      const c = d && d.chain;
      if (!c || !+c.current) { S.chains[f.id] = { none: true, at: Date.now() }; return; }
      S.chains[f.id] = {
        none: false,
        current: +c.current || 0,
        max: +c.max || 0,
        modifier: +c.modifier || 1,
        timeoutAt: +c.timeout > 0 ? Date.now() + (+c.timeout) * 1000 : 0,
        cooldownAt: +c.cooldown > Date.now() / 1000 ? (+c.cooldown) * 1000 : 0,
        at: Date.now(),
      };
    } catch (e) { /* chain data is optional — leave previous state */ }
  });
  await Promise.all(jobs);
}
function chainMeterHTML(war) {
  return war.factions.map((f) => {
    const mine = !!S.pin && +f.id === +S.pin;
    const c = S.chains[f.id];
    const active = c && !c.none;
    return `<div class="chainmeter" data-chmeter="${f.id}">
      <div class="cm-top">
        <span class="cm-tag ${mine ? 'you' : 'enemy'}">${mine ? 'OUR CHAIN' : 'THEIR CHAIN'}</span>
        <span class="cm-name" title="${esc(f.name)}">${esc(f.name)}</span>
        <span class="spacer"></span>
        ${active ? `<span class="cm-count">${fmtInt(c.current)}</span><span class="cm-max">/ ${fmtInt(c.max)}</span>` : '<span class="muted tiny">no chain</span>'}
      </div>
      <div class="cm-bar"><div class="fill"></div></div>
      <div class="cm-sub">
        <span class="cm-timer">—</span>
        <span class="cm-cool"></span>
        <span class="spacer"></span>
        ${active && c.modifier && c.modifier !== 1 ? `<span class="cm-mod">×${c.modifier} respect</span>` : ''}
      </div>
    </div>`;
  }).join('');
}
function tickChainMeters() {
  const now = Date.now();
  $$('[data-chmeter]').forEach((el) => {
    const c = S.chains[+el.dataset.chmeter];
    const bar = el.querySelector('.cm-bar .fill');
    const timer = el.querySelector('.cm-timer');
    const cool = el.querySelector('.cm-cool');
    if (!c || c.none) {
      if (timer) timer.textContent = 'no active chain';
      if (bar) bar.style.width = '0%';
      el.classList.remove('flash');
      return;
    }
    const cooling = c.cooldownAt && c.cooldownAt > now;
    if (cooling) {
      if (cool) cool.textContent = 'cooldown ' + fmtMS((c.cooldownAt - now) / 1000);
      if (timer) timer.textContent = 'timer paused';
      if (bar) bar.style.width = '100%';
      el.classList.remove('flash');
      el.classList.add('cooling');
      return;
    }
    el.classList.remove('cooling');
    if (cool) cool.textContent = '';
    let rem = c.timeoutAt ? Math.floor((c.timeoutAt - now) / 1000) : 0;
    if (rem < 0) rem = 0;
    if (timer) timer.textContent = rem > 0 ? fmtMS(rem) + ' to break' : '0:00 — broke?';
    if (bar) bar.style.width = Math.max(0, Math.min(100, (rem / 90) * 100)) + '%';
    el.classList.toggle('flash', rem > 0 && rem <= 60); // FLASH at <= 1 minute
  });
}

function hitSideIdx(war) {
  const [a, b] = war.factions;
  if (+S.pin === a.id) return 1;
  if (+S.pin === b.id) return 0;
  const saved = S.hits.side[war.id];
  return saved === 0 || saved === 1 ? saved : 1;
}



/* ----- target matcher: match war targets within a stat range (FF Scouter data) ----- */
function parseStat(str) { // "2.5b", "800m", "1.2t", "5000000" -> number | null
  const m = String(str || '').trim().toLowerCase().match(/^([\d.]+)\s*([kmbt])?/);
  if (!m) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[m[2]] || 1;
  const v = parseFloat(m[1]) * mult;
  return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
}
function ffMatchBounds() {
  const p = S.ff.match.preset;
  const my = S.ff.myEst;
  if (p === 'custom') {
    const lo = parseStat(S.ff.match.min), hi = parseStat(S.ff.match.max);
    return { mode: 'est', min: lo || null, max: hi || null, anchor: 'custom' };
  }
  if (p === 'soft') return my
    ? { mode: 'est', min: null, max: Math.round(my * 0.5), anchor: 'est' }
    : { mode: 'ff', min: null, max: 1.33, anchor: 'ff' };
  if (p === 'fair') return my
    ? { mode: 'est', min: Math.round(my * 0.5), max: Math.round(my * 1.5), anchor: 'est' }
    : { mode: 'ff', min: 1.33, max: 2.33, anchor: 'ff' };
  if (p === 'hard') return my
    ? { mode: 'est', min: Math.round(my * 1.5), max: null, anchor: 'est' }
    : { mode: 'ff', min: 2.33, max: null, anchor: 'ff' };
  return { mode: 'est', min: null, max: null, anchor: 'all' };
}
function ffInRange(rec, b) {
  if (!b || (b.mode === 'est' && b.min == null && b.max == null)) return true;
  if (!rec || !rec.d) return false;
  if (b.mode === 'est') {
    const e = ffEst(rec);
    if (e == null) return false;
    if (b.min != null && e < b.min) return false;
    if (b.max != null && e > b.max) return false;
    return true;
  }
  const f = ffFf(rec);
  if (f == null) return false;
  if (b.min != null && f < b.min) return false;
  if (b.max != null && f > b.max) return false;
  return true;
}
function ffRangeLabel(b) {
  if (!b || b.anchor === 'all') return 'all members';
  if (b.mode === 'est') {
    const lo = b.min != null ? fmtBS(b.min) : '0';
    const hi = b.max != null ? fmtBS(b.max) : '∞';
    return `est ${lo} → ${hi}`;
  }
  const lo = b.min != null ? 'FF ≥ ' + b.min.toFixed(2) : '';
  const hi = b.max != null ? 'FF ≤ ' + b.max.toFixed(2) : '';
  return [lo, hi].filter(Boolean).join(' & ');
}
async function ensureMyIdentity() {
  if (S.demo) {
    if (!S.ff.myId) {
      S.ff.myId = Demo.myId();
      S.ff.myName = 'you (demo)';
      S.ff.myEst = ffEst(ffDataFor(S.ff.myId));
      if (S.tab === 'hits') renderView();
    }
    return;
  }
  if (!S.key) return;
  // identity (once)
  if (!S.ff.myId && !S.ff.myIdLoading) {
    S.ff.myIdLoading = true;
    try {
      const d = await torn('/user/basic');
      const prof = (d && (d.profile || d.basic)) || d || {};
      if (prof.id || prof.player_id) {
        S.ff.myId = +(prof.id || prof.player_id);
        S.ff.myName = prof.name || null;
      }
    } catch (e) { /* identity anchor is optional */ }
    S.ff.myIdLoading = false;
  }
  if (!S.ff.myId) return;
  // own estimate: cached from scouting, else retry (throttled) — e.g. first try raced key registration
  if (S.ff.myEst == null && !S.ff.myNoEst) {
    const rec = ffDataFor(S.ff.myId);
    if (rec) {
      S.ff.myEst = ffEst(rec);
      if (S.ff.myEst == null) S.ff.myNoEst = true; // FF simply has no estimate for us
    } else if (Date.now() - S.ff.myEstTriedAt > 60000) {
      S.ff.myEstTriedAt = Date.now();
      try {
        const arr = await ffApi('stats', { ids: String(S.ff.myId) });
        const d = Array.isArray(arr) ? arr[0] : null;
        if (d && d.player_id) {
          const r = { at: Date.now(), d };
          S.ff.data[d.player_id] = r;
          ffCacheSet(d.player_id, d);
          S.ff.myEst = ffEst(r);
          if (S.ff.myEst == null) S.ff.myNoEst = true;
        }
      } catch (e) { /* retried on the next refresh cycle */ }
    }
  }
  if (S.tab === 'hits') renderView();
}

function ffPanel(war, roster, enemy) {
  const st = S.ff.status;
  const registered = !!(st && st.is_registered);
  const rosterArr = roster || [];
  const listedSet = new Set(hitsGet(war.id).map((x) => x.id));
  const scouted = rosterArr.filter((m) => ffDataFor(m.id)).length;

  const th = (key, label, cls) => `<th data-action="ff-sort" data-key="${key}" class="${cls || ''}">${label}${S.ff.sort === key ? (S.ff.dir < 0 ? ' ▾' : ' ▴') : ''}</th>`;
  const dir = S.ff.dir;
  const rows = rosterArr.map((m) => ({ m, rec: ffDataFor(m.id) }));
  const sorters = {
    est: (a, b) => dir * ((ffEst(a.rec) == null ? Infinity : ffEst(a.rec)) - (ffEst(b.rec) == null ? Infinity : ffEst(b.rec))),
    ff: (a, b) => dir * ((ffFf(a.rec) == null ? -1 : ffFf(a.rec)) - (ffFf(b.rec) == null ? -1 : ffFf(b.rec))),
    level: (a, b) => dir * (b.m.level - a.m.level),
    name: (a, b) => dir * a.m.name.localeCompare(b.m.name),
  };
  rows.sort(sorters[S.ff.sort] || sorters.est);

  let bounds = ffMatchBounds();
  let ffFallbackAll = false;
  if (bounds.mode === 'ff' && rows.length) {
    const ffKnown = rows.filter((r) => ffFf(r.rec) != null).length;
    if (!ffKnown) {
      // no member has a personalized FF value — filtering would hide everyone; show all + explain
      ffFallbackAll = true;
      bounds = { mode: 'est', min: null, max: null, anchor: 'all' };
    }
  }
  const matched = rows.filter((r) => ffInRange(r.rec, bounds));

  const trs = matched.map(({ m, rec }) => {
    const si = statusInfo(m);
    const band = ffBand(rec);
    const est = ffEst(rec);
    const ffv = ffFf(rec);
    const det = ffStatDetail(rec);
    const listed = listedSet.has(m.id);
    return `<tr>
      <td><a href="https://www.torn.com/profiles.php?XID=${m.id}" target="_blank" rel="noopener">${esc(m.name)}</a>${m.is_revivable ? ' <span class="tiny" style="color:var(--cyan)">⚑</span>' : ''}<div class="muted tiny">#${m.id}</div></td>
      <td class="num">${m.level}</td>
      <td class="status-${si.cls} tiny">${si.label}</td>
      <td class="num mono">${ffv != null ? ffv.toFixed(2) : '—'}</td>
      <td style="min-width:140px">${est ? `<span class="estnum">${fmtBS(est)}</span><span class="fftag ${band.cls}">${band.label}</span><div class="ffbar ${band.cls}"><div class="fill" style="width:${ffScalePct(est)}%"></div></div>` : '<span class="muted tiny">no data</span>'}</td>
      <td>${det.html}</td>
      <td>${ffSourceChip(rec)}</td>
      <td class="num">
        <a class="btn small icon attack" href="https://www.torn.com/loader.php?sid=attack&user2ID=${m.id}" target="_blank" rel="noopener" title="Attack ${esc(m.name)}">⚔</a>
        ${listed ? '<span class="chip listed">listed</span>' : `<button class="chip addable" data-action="add-hit" data-pid="${m.id}" title="Add to hit list">+ list</button>`}
      </td>
    </tr>`;
  }).join('');

  let statusHtml;
  if (S.ff.checking) statusHtml = '<span class="muted tiny blink">checking key…</span>';
  else if (registered) {
    statusHtml = `<span class="chip win">✓ registered</span>${st.is_premium ? '<span class="chip chain">premium</span>' : ''}${st.faction_id ? `<span class="chip">faction #${st.faction_id} linked</span>` : ''}`;
  } else {
    statusHtml = `
      <label class="tiny" style="display:flex;align-items:center;gap:6px;color:var(--dim);cursor:pointer">
        <input type="checkbox" id="ff-consent" ${S.ff.consent ? 'checked' : ''}>
        <span>I have read the <a href="https://ffscouter.com/" target="_blank" rel="noopener">FF Scouter data policy &amp; terms</a></span>
      </label>
      <button class="btn small primary" data-action="ff-register" ${S.ff.registering ? 'disabled' : ''}>${S.ff.registering ? 'registering…' : 'Register key'}</button>
      ${S.ff.statusErr ? `<span class="tiny" style="color:#ffb4ad">${esc(String(S.ff.statusErr))}</span>` : ''}`;
  }

  return `
  <div class="panel" style="margin-bottom:14px">
    <div class="pad" style="padding-bottom:8px">
      <div class="row wrap" style="gap:8px">
        <span class="muted tiny" style="letter-spacing:.14em;font-weight:800">FF SCOUTER · TARGET STATS — ${esc(enemy.name)}</span>
        ${statusHtml}
        <span class="spacer"></span>
        <button class="btn small" data-action="ff-check" ${S.ff.checking ? 'disabled' : ''}>${S.ff.checking ? 'checking…' : 'Check key'}</button>
        <button class="btn small" data-action="ff-scout" ${(registered || S.demo) && !S.ff.scouting ? '' : 'disabled'} title="Fetch FF Scouter estimates for the whole target roster">${S.ff.scouting ? `scouting ${S.ff.scoutProg ? S.ff.scoutProg.done + '/' + S.ff.scoutProg.total : '…'}…` : rosterArr.length ? 'Scout faction' : 'Scout (waiting for roster…)'}</button>
        <button class="btn small" data-action="ff-rescout" ${(registered || S.demo) && !S.ff.scouting ? '' : 'disabled'} title="Force-refresh all estimates (bypasses local cache)">↻ re-scout</button>
      </div>
      ${!registered && !S.ff.checking && !st ? `<div class="tiny muted" style="margin-top:6px">Stat estimates come from <a href="https://ffscouter.com/" target="_blank" rel="noopener">ffscouter.com</a>. Your key must be registered there once — check it, then register right here (consent box above) if needed.</div>` : ''}
      ${!rosterArr.length ? '<div class="tiny muted blink" style="margin-top:6px">waiting for roster…</div>'
        : `<div class="tiny muted" style="margin-top:6px">${scouted}/${rosterArr.length} scouted${S.ff.lastScoutAt ? ' · updated ' + ago(Math.floor(S.ff.lastScoutAt / 1000)) : ''} · cached ~6h${S.demo ? ' · demo data' : ''} · key level: public is enough</div>`}
      ${S.ff.err ? `<div class="tiny" style="color:#ffb4ad;margin-top:4px">⚠ ${esc(String(S.ff.err))}</div>` : ''}
      ${(S.room.rosterErr && S.room.rosterErr[enemy.id]) ? `<div class="tiny" style="color:#ffb4ad;margin-top:4px">⚠ roster load failed: ${esc(String(S.room.rosterErr[enemy.id]))} — will retry on next refresh</div>` : ''}
    </div>
    <div class="row wrap" style="gap:8px;padding:10px 16px;border-top:1px solid var(--line);background:var(--panel2)">
      <span class="muted tiny" style="letter-spacing:.14em;font-weight:800">MATCH TARGETS IN STAT RANGE</span>
      <select id="ff-preset" title="Anchor the range to your own FF Scouter estimate">
        <option value="all" ${S.ff.match.preset === 'all' ? 'selected' : ''}>all members</option>
        <option value="soft" ${S.ff.match.preset === 'soft' ? 'selected' : ''}>soft — well below my stats</option>
        <option value="fair" ${S.ff.match.preset === 'fair' ? 'selected' : ''}>fair fight — near my stats</option>
        <option value="hard" ${S.ff.match.preset === 'hard' ? 'selected' : ''}>tough — above my stats</option>
        <option value="custom" ${S.ff.match.preset === 'custom' ? 'selected' : ''}>custom range</option>
      </select>
      <input class="cellin" id="ff-min" style="max-width:110px" placeholder="min e.g. 250m" value="${esc(S.ff.match.min)}" spellcheck="false">
      <span class="muted tiny">→</span>
      <input class="cellin" id="ff-max" style="max-width:110px" placeholder="max e.g. 1.5b" value="${esc(S.ff.match.max)}" spellcheck="false">
      <span class="chip">${matched.length}/${rows.length} in range · ${esc(ffRangeLabel(bounds))}</span>
      ${S.ff.myEst ? `<span class="chip you" title="Your own FF Scouter estimate (auto-detected from your key)">my est ${fmtBS(S.ff.myEst)}</span>`
        : ffFallbackAll ? '<span class="chip soon" title="FF Scouter has no estimate for you yet and members have no personalized FF values — nothing would match, so everyone is shown">your estimate pending — showing all members</span>'
        : `<span class="chip soon" title="Matching by FF bands (FF ≤ 1.33 soft · 1.33–2.33 fair · > 2.33 tough) until your own estimate is available">anchor: FF bands${S.ff.myNoEst ? ' (no estimate for you yet)' : ' (pending…)'}</span>`}
      <span class="spacer"></span>
      <button class="btn small" data-action="ff-add-matches" ${matched.length && (registered || S.demo) ? '' : 'disabled'} title="Add every matching member to the hit list (P2)">＋ list all matches</button>
    </div>
    ${scouted && !matched.length ? `<div class="pad center muted tiny" style="padding:18px">no members match this stat range — widen it or ↻ re-scout${bounds.mode === 'ff' ? '<br><span class="tiny">note: with FF-band matching, members without a personalized FF value (common until your battlestats are registered with FF Scouter) cannot be rated</span>' : ''}</div>` : ''}
    ${scouted && matched.length ? `
    <div class="tblscroll" style="max-height:430px"><table class="tbl">
      <thead><tr>${th('name', 'Member')}${th('level', 'Lvl', 'num')}${th('status', 'Status')}${th('ff', 'FF', 'num')}${th('est', 'Est total')}${'<th>Stat detail</th>'}${'<th>Src</th>'}${'<th></th>'}</tr></thead>
      <tbody>${trs}</tbody>
    </table></div>
    <div class="tiny muted pad" style="padding-top:6px">Sorted weakest → strongest by default · bar is log scale (1k → 1t) · <b>FF</b> = fair-fight multiplier vs your battle stats (higher = more respect per hit). Stat detail shows exact spy values when your faction has them, otherwise FF Scouter's stat distribution.</div>`
    : ''}
  </div>`;
}


function squadBounds(memberEst) {
  const p = S.ff.match.preset;
  if (p === 'custom') return ffMatchBounds();
  if (!memberEst) return null;
  if (p === 'soft') return { mode: 'est', min: null, max: Math.round(memberEst * 0.5), anchor: 'est' };
  if (p === 'fair') return { mode: 'est', min: Math.round(memberEst * 0.5), max: Math.round(memberEst * 1.5), anchor: 'est' };
  if (p === 'hard') return { mode: 'est', min: Math.round(memberEst * 1.5), max: null, anchor: 'est' };
  return { mode: 'est', min: null, max: null, anchor: 'all' };
}
function squadMatches(memberEst, enemyRoster, listedSet) {
  const b = squadBounds(memberEst);
  return (enemyRoster || []).filter((m) => !listedSet.has(m.id) && ffInRange(ffDataFor(m.id), b));
}
function squadPanel(war, ownFac, ownRoster, enemyRoster) {
  if (!ownFac) {
    return `<div class="panel pad muted tiny" style="margin-bottom:14px">Squad matchups need your faction — detected: <b>none</b>. It is auto-detected from your key, or pin a faction id in SETUP &amp; ABOUT.</div>`;
  }
  const listedSet = new Set(hitsGet(war.id).map((x) => x.id));
  const dir = S.ff.dir;
  const q = (S.ff.squadSearch || '').toLowerCase().trim();
  const allRows = (ownRoster || []).slice();
  const rows = q
    ? allRows.filter((m) => m.name.toLowerCase().includes(q) || String(m.id).includes(q))
    : allRows;
  const enriched = rows.map((m) => ({ m, rec: ffDataFor(m.id), est: ffEst(ffDataFor(m.id)) }));
  enriched.sort((a, b) => dir * ((a.est == null ? Infinity : a.est) - (b.est == null ? Infinity : b.est)));
  const scoutedOwn = enriched.filter((x) => x.rec).length;
  const totalOwn = allRows.length;
  const wk = wkState(war, ownFac.id);
  const wkTotal = Object.values(wk.counts || {}).reduce((a, b) => a + b, 0);
  const trs = enriched.map(({ m, rec, est }) => {
    const si = statusInfo(m);
    const band = ffBand(rec);
    const matches = squadMatches(est, enemyRoster, listedSet);
    const open = S.ff.popup === m.id;
    return `<tr class="${open ? 'popup-open' : ''}">
      <td><button class="btnlink" data-action="open-member" data-pid="${m.id}" title="Open FF Scouter card + targets in stat range for ${esc(m.name)}">${esc(m.name)}</button><div class="muted tiny">#${m.id}</div></td>
      <td class="num mono" title="Won attacks vs war opponents — live tally from the faction attacks feed">${wk.counts && wk.counts[m.id] ? '<b>' + fmtInt(wk.counts[m.id]) + '</b>' : '<span class="muted">0</span>'}</td>
      <td class="num">${m.level}</td>
      <td class="status-${si.cls} tiny">${si.label}</td>
      <td class="num mono">${est ? fmtBS(est) : '—'}</td>
      <td>${est ? `<span class="fftag ${band.cls}">${band.label}</span>` : '<span class="muted tiny">no data</span>'}</td>
      <td class="num">${rec ? `<button class="chip ${matches.length ? 'addable' : 'listed'}" data-action="open-member" data-pid="${m.id}">${matches.length} in range</button>` : '—'}</td>
    </tr>`;
  }).join('');
  return `
  <div class="panel" style="margin-bottom:14px">
    <div class="pad" style="padding-bottom:8px">
      <div class="row wrap" style="gap:8px">
        <span class="muted tiny" style="letter-spacing:.14em;font-weight:800">YOUR SQUAD — ${esc(ownFac.name)} · CLICK A MEMBER FOR FF SCOUTER CARD + WHO THEY SHOULD HIT</span>
        <input type="text" id="squad-search" placeholder="Search member (name or id)…" value="${esc(S.ff.squadSearch || '')}" spellcheck="false" style="width:200px;background:var(--panel2);border:1px solid var(--line);color:var(--txt);border-radius:8px;padding:6px 10px;font-size:12.5px;outline:none">
        ${q ? `<button class="btn small icon del" data-action="clear-squad-search" title="Clear search">✕</button>` : ''}
        <span class="spacer"></span>
        ${S.warkillsErr === 'limited' ? '<span class="chip soon" title="The faction attacks feed needs a Limited (or better) API key — kills cannot be tallied with a Public key">⚠ kills need Limited key</span>'
          : `<span class="chip" title="Won attacks vs war opponents, tallied live from the faction attacks feed">⚔ ${fmtInt(wkTotal)} war kills${wk.done ? '' : ' (counting…)'}</span>`}
        <span class="muted tiny">${q ? enriched.length + ' of ' + totalOwn + ' shown · ' : ''}${scoutedOwn}/${totalOwn} scouted · range preset follows the selector above</span>
      </div>
      ${!totalOwn ? '<div class="tiny muted blink" style="margin-top:6px">waiting for your faction roster…</div>'
        : !rows.length ? `<div class="tiny muted" style="margin-top:6px">no members match &quot;${esc(q)}&quot;</div>` : ''}
    </div>
    ${rows.length ? `
    <div class="tblscroll" style="max-height:330px"><table class="tbl">
      <thead><tr><th>Member</th><th class="num" title="Won attacks vs war opponents this war — live tally from the faction attacks feed (Limited key)">KILLS</th><th class="num">Lvl</th><th>Status</th><th class="num">Est total</th><th>Band</th><th class="num">Enemy targets</th></tr></thead>
      <tbody>${trs}</tbody>
    </table></div>` : ''}
  </div>`;
}

function memberDiscordText() {
  const war = S.wars.find((w) => w.id === S.room.warId);
  if (!war || !S.ff.popup) return null;
  const sideIdx = hitSideIdx(war);
  const enemyRoster = sideIdx === 0 ? S.room.rosterA : S.room.rosterB;
  const enemy = war.factions[sideIdx];
  const ownFac = S.pin ? war.factions.find((f) => +f.id === +S.pin) : null;
  const all = (S.room.rosterA || []).concat(S.room.rosterB || []);
  const m = all.find((x) => x.id === S.ff.popup);
  if (!m || !enemyRoster) return null;
  const rec = ffDataFor(m.id);
  const est = ffEst(rec);
  const band = ffBand(rec);
  const si = statusInfo(m);
  const strip = (s) => String(s).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  const b = squadBounds(est);
  const listedSet = new Set(hitsGet(war.id).map((x) => x.id));
  const matches = enemyRoster
    .map((x) => ({ x, rec2: ffDataFor(x.id), est2: ffEst(ffDataFor(x.id)) }))
    .filter((r) => !listedSet.has(r.x.id) && ffInRange(r.rec2, b))
    .sort((a, c) => (a.est2 || Infinity) - (c.est2 || Infinity));
  const lines = [];
  lines.push(`\u2620 FF SCOUTER CARD \u2014 ${m.name} [lvl ${m.level}] (#${m.id})`);
  lines.push(`${ownFac ? ownFac.name + ' vs ' : ''}${enemy.name} \u2014 War #${war.id}${war.target ? ' \u00b7 target ' + fmtInt(war.target) : ''}`);
  lines.push(`Est total: ${est ? fmtBS(est) + ' (' + band.label + ')' : 'no data'}${rec && rec.d.source ? ' \u00b7 source: ' + rec.d.source : ''}${rec && rec.d.last_updated ? ' \u00b7 updated ' + ago(rec.d.last_updated) : ''}`);
  lines.push(`Status: ${strip(si.label)}`);
  const spy = rec && Array.isArray(rec.d.spies) && rec.d.spies[0];
  if (spy) {
    lines.push(`Spy: STR ${fmtBS(spy.strength)} \u00b7 DEF ${fmtBS(spy.defense)} \u00b7 SPD ${fmtBS(spy.speed)} \u00b7 DEX ${fmtBS(spy.dexterity)} \u2014 ${spy.source || '?'}${spy.last_updated ? ' (' + ago(spy.last_updated) + ')' : ''}`);
  } else if (rec && rec.d.distribution && rec.d.distribution.distribution_human) {
    lines.push(`Distribution: ${rec.d.distribution.distribution_human}`);
  }
  lines.push('');
  lines.push(`\ud83c\udfaf TARGETS IN STAT RANGE (${ffRangeLabel(b)}): ${matches.length}`);
  matches.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.x.name} [lvl ${r.x.level}] #${r.x.id} \u2014 ${r.est2 ? 'est ' + fmtBS(r.est2) : 'no est'} \u2014 ${strip(statusInfo(r.x).label)}${ffFf(r.rec2) != null ? ' \u2014 FF ' + ffFf(r.rec2).toFixed(2) : ''} \u2014 https://www.torn.com/loader.php?sid=attack&user2ID=${r.x.id}`);
  });
  if (!matches.length) lines.push('(no unlisted enemies in range)');
  lines.push('');
  lines.push(`profile: https://www.torn.com/profiles.php?XID=${m.id}`);
  return lines.join('\n');
}

function memberPopup(war, enemy, enemyRoster, ownFac) {
  const pid = S.ff.popup;
  const all = (S.room.rosterA || []).concat(S.room.rosterB || []);
  const m = all.find((x) => x.id === pid);
  if (!m) return '';
  const rec = ffDataFor(m.id);
  const si = statusInfo(m);
  const est = ffEst(rec);
  const band = ffBand(rec);
  const det = ffStatDetail(rec);
  const listedSet = new Set(hitsGet(war.id).map((x) => x.id));
  const matches = enemyRoster
    .map((x) => ({ x, rec2: ffDataFor(x.id), est2: ffEst(ffDataFor(x.id)) }))
    .filter((r) => !listedSet.has(r.x.id) && ffInRange(r.rec2, squadBounds(est)))
    .sort((a, b) => (a.est2 || Infinity) - (b.est2 || Infinity));
  const b = squadBounds(est);
  return `
  <div class="overlay" data-action="close-member">
    <div class="modal">
      <div class="modal-head">
        <span class="chip win">FF SCOUTER CARD</span>
        <span class="sb-name"><a href="https://www.torn.com/profiles.php?XID=${m.id}" target="_blank" rel="noopener" style="color:inherit">${esc(m.name)}</a></span>
        <span class="muted tiny">lvl ${m.level} · #${m.id} · ${esc(ownFac ? ownFac.name : '')}</span>
        <span class="spacer"></span>
        <button class="btn small" data-action="copy-member-discord" title="Copy this FF Scouter card + its targets formatted for Discord">${Date.now() - S.ff.discCopiedAt < 2200 ? 'COPIED \u2713' : '\u29c9 Discord'}</button>
        <button class="btn small icon del" data-action="close-member" title="Close">✕</button>
      </div>
      <div class="modal-body">
        <div class="row wrap" style="gap:7px;margin-bottom:10px">
          <span class="chip ${si.cls === 'ok' ? 'win' : ''}">status: ${si.label}</span>
          ${est ? `<span class="chip">est total <b>${fmtBS(est)}</b></span><span class="fftag ${band.cls}">${band.label}</span>${ffSourceChip(rec)}` : '<span class="chip">no FF Scouter data yet — use ↻ re-scout</span>'}
          ${rec && rec.d.last_updated ? `<span class="muted tiny">updated ${ago(rec.d.last_updated)}</span>` : ''}
        </div>
        ${rec ? `<div style="margin-bottom:12px">${det.html}</div>` : ''}
        <div class="row wrap" style="gap:8px;margin-bottom:6px">
          <span class="muted tiny" style="letter-spacing:.14em;font-weight:800">TARGETS IN STAT RANGE FOR ${esc(m.name).toUpperCase()} — ${esc(enemy.name)}</span>
          <span class="chip">${matches.length} match${matches.length === 1 ? '' : 'es'} · ${esc(ffRangeLabel(b))}</span>
        </div>
        ${matches.length ? matches.map(({ x, rec2, est2 }) => {
          const xsi = statusInfo(x);
          return `<div class="matchrow">
            <span class="mono tiny">${est2 ? fmtBS(est2) : '—'}</span>
            <a href="https://www.torn.com/profiles.php?XID=${x.id}" target="_blank" rel="noopener">${esc(x.name)}</a>
            <span class="muted tiny">lvl ${x.level}</span>
            <span class="status-${xsi.cls} tiny">${xsi.label}</span>
            ${ffFf(rec2) != null ? `<span class="muted tiny">FF ${ffFf(rec2).toFixed(2)} (vs you)</span>` : ''}
            <span class="spacer"></span>
            <a class="btn small icon attack" href="https://www.torn.com/loader.php?sid=attack&user2ID=${x.id}" target="_blank" rel="noopener" title="Attack ${esc(x.name)}">⚔</a>
            <button class="chip addable" data-action="add-hit" data-pid="${x.id}">+ list</button>
          </div>`;
        }).join('') : '<div class="muted tiny" style="padding:8px 0">no unlisted enemies in this range — widen the preset above</div>'}
      </div>
    </div>
  </div>`;
}

function renderHits() {
  if (!S.key && !S.demo) { renderWelcome(); return; }
  if (!S.warsLoaded) {
    view.innerHTML = S.err
      ? `<div class="panel pad center" style="padding:40px"><div class="muted">⚠ ${esc(String(S.err))}</div><div style="margin-top:14px"><button class="btn primary" data-action="refresh-now">Retry</button></div></div>`
      : '<div class="skeleton blink">LOADING…</div>';
    return;
  }
  const warId = pickDefaultWar();
  if (warId && S.room.warId !== warId) S.room.warId = warId; // keep handlers in sync
  if (!warId) {
    view.innerHTML = `<div class="panel pad center muted" style="padding:40px">☠ The Hit Club needs a war first.<br><span class="tiny">Open the LIVE WARS tab — as soon as a ranked war is running or scheduled, you can build your hit list here.</span></div>`;
    return;
  }
  const war = S.wars.find((w) => w.id === warId);
  if (!war) { view.innerHTML = '<div class="skeleton blink">LOADING WAR…</div>'; return; }
  const sideIdx = hitSideIdx(war);
  const enemy = war.factions[sideIdx];
  const mw = myWar();
  const isMyWar = !!(mw && mw.id === war.id);
  const myFacInWar = S.pin ? war.factions.find((f) => +f.id === +S.pin) : null;
  const ownFac = myFacInWar;
  const roster = sideIdx === 0 ? S.room.rosterA : S.room.rosterB;
  const otherRoster = sideIdx === 0 ? S.room.rosterB : S.room.rosterA;
  const ownRoster = ownFac ? otherRoster : null;
  if (S.ff.popup && !(ownRoster || []).some((m) => m.id === S.ff.popup)) S.ff.popup = null;
  const mapE = {}; (roster || []).forEach((m) => { mapE[m.id] = m; });
  const mapO = {}; (otherRoster || []).forEach((m) => { mapO[m.id] = m; });
  const maps = [mapE, mapO];

  const entries = hitsGet(warId);
  const listed = new Set(entries.map((x) => x.id));
  const withStatus = entries.map((en) => ({ en, si: entryStatus(en, maps) }));
  withStatus.sort((x, y) => {
    const p = x.en.priority - y.en.priority;
    if (p) return p;
    const ax = availRankSI(x.si), ay = availRankSI(y.si);
    return ax[0] - ay[0] || ax[1] - ay[1] || y.en.level - x.en.level;
  });

  const suggestions = (roster || [])
    .filter((m) => !listed.has(m.id))
    .map((m) => ({ m, si: statusInfo(m) }))
    .filter((x) => x.si.okay)
    .sort((a, b) => b.m.level - a.m.level)
    .slice(0, 6);

  const q = S.hits.search.toLowerCase();
  const matches = q
    ? (roster || []).filter((m) => !listed.has(m.id) && (m.name.toLowerCase().includes(q) || String(m.id).includes(q))).slice(0, 8)
    : [];

  const nOkay = withStatus.filter((x) => x.si && x.si.okay).length;
  const nHosp = withStatus.filter((x) => x.si && x.si.state === 'Hospital').length;
  const nP1 = entries.filter((e) => e.priority === 1).length;
  const copied = Date.now() - S.hits.copiedAt < 2200;
  const ffRange = ffRangeSummary(roster || []);
  const ffPanelHtml = ffPanel(war, roster, enemy);

  const matchRows = matches.map((m) => {
    const si = statusInfo(m);
    return `<div class="matchrow">
      <a href="https://www.torn.com/profiles.php?XID=${m.id}" target="_blank" rel="noopener">${esc(m.name)}</a>
      <span class="muted tiny">lvl ${m.level}</span>
      <span class="status-${si.cls} tiny">${si.label}</span>
      <span class="spacer"></span>
      <button class="chip addable" data-action="add-hit" data-pid="${m.id}">+ add to hit list</button>
    </div>`;
  }).join('');

  const hitBounds = ffMatchBounds();
  const hitRows = withStatus.map(({ en, si }, i) => {
    const live = mapE[en.id] || mapO[en.id];
    return `<tr class="${ffInRange(ffDataFor(en.id), hitBounds) ? 'inrange' : ''}">
      <td class="muted num">${i + 1}</td>
      <td><button class="pri pri${en.priority}" data-action="hit-pri" data-pid="${en.id}" title="Priority — click to cycle P1 → P2 → P3">P${en.priority}</button></td>
      <td><a href="https://www.torn.com/profiles.php?XID=${en.id}" target="_blank" rel="noopener">${esc(en.name)}</a><div class="muted tiny">lvl ${en.level} · #${en.id}</div></td>
      <td class="status-${si ? si.cls : 'other'}">${si ? si.label : '—'}</td>
      <td class="mono tiny">${(() => { const fr = ffDataFor(en.id); return fr && fr.d && fr.d.bs_estimate_human ? `${esc(fr.d.bs_estimate_human)} / ${ffFf(fr) != null ? ffFf(fr).toFixed(2) : '—'}` : '—'; })()}</td>
      <td class="muted tiny">${live && live.last_action && live.last_action.timestamp ? ago(live.last_action.timestamp) : '—'}</td>
      <td><input class="cellin" id="hit-note-${en.id}" data-hit="${warId}" data-pid="${en.id}" data-field="note" value="${esc(en.note || '')}" placeholder="note (weak stats, reviver…)" spellcheck="false"></td>
      <td><input class="cellin" id="hit-claim-${en.id}" data-hit="${warId}" data-pid="${en.id}" data-field="claimed" value="${esc(en.claimed || '')}" placeholder="who's on it?" spellcheck="false"></td>
      <td><a class="btn small icon attack" href="https://www.torn.com/loader.php?sid=attack&user2ID=${en.id}" target="_blank" rel="noopener" title="Attack ${esc(en.name)}">⚔</a></td>
      <td><button class="btn small icon del" data-action="del-hit" data-pid="${en.id}" title="Remove from hit list">✕</button></td>
    </tr>`;
  }).join('');

  view.innerHTML = `
    <div class="toolbar">
      <select id="room-select" style="min-width:240px">${warSelectOptions()}</select>
      <label class="muted tiny" title="${S.pin && myFacInWar ? 'auto-set to the opponent of ' + esc(myFacInWar.name) : 'pick which side to target'}">target side${S.pin && myFacInWar ? ' (auto)' : ''}</label>
      <select id="hits-side" ${S.pin && myFacInWar ? 'title="Auto-set to the opponent of your faction — change only if you want to flip it"' : ''}>
        <option value="0" ${sideIdx === 0 ? 'selected' : ''}>${esc(war.factions[0].name)}</option>
        <option value="1" ${sideIdx === 1 ? 'selected' : ''}>${esc(war.factions[1].name)}</option>
      </select>
      <span class="spacer"></span>
      <button class="btn small" data-action="copy-hits" ${entries.length ? '' : 'disabled'}>${copied ? 'COPIED ✓' : '⧉ Copy for Discord'}</button>
      <button class="btn small del" data-action="clear-hits" ${entries.length ? '' : 'disabled'}>Clear all</button>
    </div>

    <div class="row wrap" style="gap:7px;margin:2px 0 12px">
      ${isMyWar && myFacInWar ? `<span class="chip you" title="Hit Club locked onto the war your faction is fighting">⚔ your faction's war — fighting for ${esc(myFacInWar.name)} vs ${esc(enemy.name)}</span>` : ''}
      ${S.pin && !mw ? '<span class="chip" title="Auto-detected from your key">your faction has no active ranked war — browsing other wars</span>' : ''}
      ${S.pin && mw && !isMyWar ? `<span class="chip soon">not your war</span> <button class="btn small primary" data-action="goto-my-war">→ your war: #${mw.id} ${esc(mw.factions.map((f) => f.name).join(' vs '))}</button>` : ''}
      <span class="chip"><span class="skull">☠</span>&nbsp;${entries.length} targets</span>
      <span class="chip"><span class="status-ok">● ${nOkay}</span>&nbsp;okay now</span>
      <span class="chip"><span class="status-hosp">✚ ${nHosp}</span>&nbsp;in hosp</span>
      <span class="chip pri1" style="border-radius:999px">P1 × ${nP1}</span>
      ${ffRange ? `<span class="chip" title="FF Scouter battle-stat estimates across the target roster">roster range ${fmtBS(ffRange.min)} → ${fmtBS(ffRange.max)} · med ${fmtBS(ffRange.med)}</span>` : ''}
      ${enemy.chain ? `<span class="chip chain">⚡ enemy chain ${fmtInt(enemy.chain)}</span>` : ''}
    </div>

    <div class="panel pad" style="margin-bottom:14px">
      <div class="row wrap" style="gap:8px">
        <span class="muted tiny" style="letter-spacing:.14em;font-weight:800">ADD TARGETS</span>
        <input type="text" id="hits-search" placeholder="Search ${esc(enemy.name)} roster (name or id)…" value="${esc(S.hits.search)}" style="width:250px;background:var(--panel2);border:1px solid var(--line);color:var(--txt);border-radius:8px;padding:7px 10px;font-size:13px;outline:none">
        <span class="muted tiny">suggested — okay right now, highest level:</span>
        ${roster
          ? (suggestions.length
            ? suggestions.map((x) => `<button class="chip addable" data-action="add-hit" data-pid="${x.m.id}" title="lvl ${x.m.level} · ${esc(x.si.label)}">+ ${esc(x.m.name)} <span class="muted">(${x.m.level})</span></button>`).join('')
            : '<span class="muted tiny">no okay members right now</span>')
          : '<span class="muted tiny blink">loading roster…</span>'}
      </div>
      ${q ? (matchRows ? `<div style="margin-top:8px">${matchRows}</div>` : '<div class="muted tiny" style="margin-top:8px">no unlisted members match</div>') : ''}
    </div>

    <div class="row wrap" style="gap:10px;margin:-6px 0 14px">
      <span class="muted tiny" style="letter-spacing:.14em;font-weight:800">CHAIN METER</span>
      ${chainMeterHTML(war)}
    </div>

    ${ffPanelHtml}

    ${squadPanel(war, ownFac, ownRoster, roster)}

    ${entries.length ? `
    <div class="panel tblscroll">
      <table class="tbl">
        <thead><tr><th>#</th><th>Pri</th><th>Target</th><th>Status</th><th>Est / FF</th><th>Last action</th><th>Note</th><th>On it</th><th></th><th></th></tr></thead>
        <tbody>${hitRows}</tbody>
      </table>
    </div>
    <p class="muted tiny" style="margin-top:10px">Priority cycles P1 → P2 → P3 on click. Notes &amp; “on it” save as you type (stored per war in your browser). ⚔ opens the attack screen against that player.</p>`
      : `<div class="panel pad center muted" style="padding:34px">☠ No targets yet — search the ${esc(enemy.name)} roster above, add a suggested target, or use the squad matchups.</div>`}
    ${S.ff.popup ? memberPopup(war, enemy, roster, ownFac) : ''}`;
  restoreFocus();
}

function entryStatus(en, maps) {
  for (const map of maps) if (map[en.id]) return statusInfo(map[en.id]);
  return null;
}

function seedDemoHits() {
  const seed = Demo.hitSeed();
  if (seed && seed.length && !hitsGet(9121).length) hitsSet(9121, seed);
}

/* ----- the war report tab ----- */
async function loadWarReportWars(fidRaw) {
  const fid = parseInt(fidRaw || S.wrep.faction || S.pin, 10);
  if (!fid) { S.wrep.err = 'Enter a faction id (or set your pin) to load its war reports.'; renderView(); return; }
  S.wrep.loading = true; S.wrep.err = null; renderView();
  try {
    const d = await torn(`/faction/${fid}/rankedwars`, { sort: 'DESC', limit: 100 });
    S.wrep.rows = (d.rankedwars || []).map(normalizeWar).filter(Boolean);
    S.wrep.faction = String(fid);
    try { store.rw_wrepfaction = String(fid); } catch (e) {}
    const def = S.wrep.rows.find((w) => warPhase(w) !== 'done') || S.wrep.rows[0] || null;
    S.wrep.data = null;
    S.wrep.warId = def ? def.id : null;
    S.wrep.loading = false;
    renderView();
    if (def && warPhase(def) === 'done') await loadWarReport(def.id);
  } catch (e) {
    S.wrep.err = (e && e.error && (e.error.error || e.error.code)) || 'Failed to load war list';
    S.wrep.loading = false;
    renderView();
  }
}
async function loadWarReport(warId) {
  S.wrep.warId = +warId;
  S.wrep.loadingWar = true; S.wrep.err = null; renderView();
  try {
    const d = await torn(`/faction/${warId}/rankedwarreport`);
    S.wrep.data = d.rankedwarreport || d;
  } catch (e) {
    S.wrep.data = null;
    S.wrep.err = (e && e.error && (e.error.error || e.error.code)) || 'Failed to load war report';
  }
  S.wrep.loadingWar = false;
  renderView();
}
function wrepMemberRows(f, sortKey) {
  const rows = (f.members || []).slice();
  rows.sort((a, b) => sortKey === 'score' ? b.score - a.score : (b.attacks - a.attacks) || (b.score - a.score));
  return rows;
}
function renderWarReport() {
  if (!S.key && !S.demo) { renderWelcome(); return; }
  const w = S.wrep;
  const fid = w.faction || S.pin;
  let body = '';
  if (w.loading) body = '<div class="skeleton blink">LOADING WARS…</div>';
  else if (w.err) body = `<div class="panel pad muted">⚠ ${esc(String(w.err))}</div>`;
  else if (!w.rows) body = `<div class="panel pad center muted" style="padding:34px">Pick a faction and load its war reports.<br><span class="tiny">Defaults to your own faction (auto-detected from your key).</span></div>`;
  else if (!w.rows.length) body = '<div class="panel pad center muted">No ranked wars found for this faction.</div>';
  else {
    const war = w.rows.find((x) => x.id === w.warId) || w.rows[0];
    const opts = w.rows.map((x) => `<option value="${x.id}" ${x.id === war.id ? 'selected' : ''}>#${x.id} — ${esc(x.factions.map((f) => f.name).join(' vs '))}${warPhase(x) !== 'done' ? ' (in progress)' : ''}</option>`).join('');
    const ongoing = warPhase(war) !== 'done';
    let inner = '';
    if (w.loadingWar) inner = '<div class="skeleton blink">LOADING REPORT…</div>';
    else if (ongoing) {
      inner = `
      <div class="panel pad" style="padding:22px">
        <div class="row wrap" style="gap:10px;margin-bottom:10px">
          <span class="chip live">IN PROGRESS</span>
          <span class="muted tiny">war started ${fmtDate(war.start, true)} · target ${fmtInt(war.target)}</span>
        </div>
        <div class="sb-grid">
          ${war.factions.map((f, i) => `<div class="sb-f ${i ? 'right' : 'left'}">
            <div class="sb-name">${+S.pin === f.id ? '<span class="chip you">YOU</span> ' : ''}${esc(f.name)}</div>
            <div class="sb-score">${fmtInt(f.score)}</div>
            <div class="wc-sub">${pct(f.score, war.target)}% of target ${f.chain ? `· ⚡ ${fmtInt(f.chain)}` : ''}</div>
          </div>`).join('<div class="center muted tiny" style="letter-spacing:.2em">VS</div>')}
        </div>
        <p class="muted tiny" style="margin-bottom:0">Torn publishes per-member kills, assets and respect only when the war ends and the report is generated. This page fills in automatically — until then, live per-member target stats live in THE HIT CLUB.</p>
      </div>`;
    } else if (!w.data || w.data.id !== war.id) {
      inner = '<div class="skeleton blink">LOADING REPORT…</div>';
    } else {
      const rep = w.data;
      const winner = rep.factions.find((f) => f.id === rep.winner);
      const assetBlocks = rep.factions.map((f) => `
        <div class="panel pad" style="flex:1 1 320px">
          <div class="row wrap" style="gap:8px;margin-bottom:6px">
            <b>${esc(f.name)}</b>
            <span class="chip ${rep.winner === f.id ? 'win' : 'loss'}">${rep.winner === f.id ? 'WINNER' : 'LOST'}</span>
            <span class="spacer"></span>
            <span class="muted tiny">rank ${esc(f.rank.before)} <span class="rankarrow">${rep.winner === f.id ? '▲' : '▼'}</span> ${esc(f.rank.after)}</span>
          </div>
          <div class="row wrap" style="gap:7px">
            <span class="chip" title="Respect awarded to the faction">💰 respect <b>${fmtInt(f.rewards.respect)}</b></span>
            <span class="chip" title="Points awarded to the faction">⭐ points <b>${fmtInt(f.rewards.points)}</b></span>
            <span class="chip" title="Total attacks by this faction">⚔ attacks <b>${fmtInt(f.attacks)}</b></span>
            ${(f.rewards.items || []).map((it) => `<span class="reward-chip">📦 ${esc(it.name)} ×${fmtInt(it.quantity)}</span>`).join('') || '<span class="muted tiny">no item assets</span>'}
          </div>
        </div>`).join('');
      const tables = rep.factions.map((f) => {
        const rows = wrepMemberRows(f, w.sort);
        const totA = rows.reduce((a, m) => a + (m.attacks || 0), 0);
        const totS = rows.reduce((a, m) => a + (m.score || 0), 0);
        const maxScore = Math.max(...rows.map((m) => m.score), 1);
        return `
        <div class="panel" style="flex:1 1 460px">
          <div class="rf-head">
            <span class="sb-name">${esc(f.name)}</span>
            <span class="rf-score mono">${fmtInt(f.score)}</span>
            <span class="spacer"></span>
            <span class="muted tiny">${rows.length} members</span>
          </div>
          <div class="tblscroll" style="max-height:430px"><table class="tbl">
            <thead><tr><th>#</th><th>Member</th><th class="num">Lvl</th><th class="num" title="Attacks recorded for this member in the war">KILLS*</th><th class="num" title="Member's war score (contribution points)">RESPECT*</th><th>Share</th></tr></thead>
            <tbody>${rows.map((m, i) => `<tr>
              <td class="muted num">${i + 1}</td>
              <td><a href="https://www.torn.com/profiles.php?XID=${m.id}" target="_blank" rel="noopener">${esc(m.name)}</a></td>
              <td class="num">${m.level}</td>
              <td class="num mono"><b>${fmtInt(m.attacks)}</b></td>
              <td class="num mono">${fmtF1(m.score)}</td>
              <td class="barcell"><span class="bg" style="width:${Math.max(2, (m.score / maxScore) * 100)}%"></span>&nbsp;${Math.round((m.score / (f.score || 1)) * 100)}%</td>
            </tr>`).join('')}
            <tr><td></td><td><b>TOTAL</b></td><td></td><td class="num mono"><b>${fmtInt(totA)}</b></td><td class="num mono"><b>${fmtInt(totS)}</b></td><td></td></tr>
            </tbody>
          </table></div>
        </div>`;
      }).join('');
      inner = `
        <div class="row wrap" style="gap:8px;margin:0 0 12px">
          <span class="chip ${rep.winner ? 'win' : 'draw'}">${winner ? 'WINNER: ' + esc(winner.name) : 'NO CONTEST'}</span>
          <span class="muted tiny">${fmtDate(rep.start, true)} → ${fmtDate(rep.end, true)} · lasted ${fmtDurShort((rep.end - rep.start) * 1000)} · target ${fmtInt(war.target)}${rep.forfeit ? ' · <b>FORFEIT</b>' : ''}</span>
          <span class="spacer"></span>
          <label class="muted tiny">sort members by</label>
          <select id="wrep-sort">
            <option value="kills" ${w.sort === 'kills' ? 'selected' : ''}>kills</option>
            <option value="score" ${w.sort === 'score' ? 'selected' : ''}>respect</option>
          </select>
        </div>
        <div class="row wrap" style="gap:10px;margin-bottom:14px">${assetBlocks}</div>
        <div class="row wrap" style="gap:14px;align-items:flex-start">${tables}</div>
        <p class="muted tiny" style="margin-top:10px">* Torn's official war report records each member's <b>attacks</b> (shown as kills) and <b>war score</b> (shown as respect). Separate per-member kill counts, mugged assets and respect splits are not published by the API — faction-wide respect, points and item rewards are shown in the asset strips above.</p>`;
    }
    body = `
      <div class="toolbar">
        <input type="number" id="wrep-faction" placeholder="Faction id" value="${esc(w.faction)}" style="width:140px">
        <button class="btn small" data-action="wrep-load">Load</button>
        ${S.pin && +S.pin !== +w.faction ? `<button class="btn small" data-action="wrep-use-pin">use pinned (${esc(S.pin)})</button>` : ''}
        <span class="spacer"></span>
        <label class="muted tiny">war</label>
        <select id="wrep-war" style="min-width:250px">${opts}</select>
      </div>
      ${inner}`;
  }
  view.innerHTML = body;
  restoreFocus();
}

/* ----- history tab ----- */
function renderHistory() {
  if (!S.key && !S.demo) { renderWelcome(); return; }
  const h = S.hist;
  let table = '';
  if (h.loading) table = '<div class="skeleton blink">LOADING WAR HISTORY…</div>';
  else if (h.err) table = `<div class="panel pad muted">⚠ ${esc(String(h.err))}</div>`;
  else if (h.rows) {
    if (!h.rows.length) table = '<div class="panel pad center muted">No ranked wars found for this faction id.</div>';
    else {
      table = `<div class="panel tblscroll"><table class="tbl hist-table">
      <thead><tr><th>War</th><th>Started</th><th>Ended</th><th>Opponent</th><th>Result</th><th class="num">Us</th><th class="num">Them</th><th class="num">Target</th><th></th></tr></thead>
      <tbody>${h.rows.map((r) => `<tr class="clickrow" data-action="open-report" data-war="${r.w.id}" title="Open war report">
        <td class="mono">#${r.w.id}</td>
        <td>${fmtDate(r.w.start, true)}</td>
        <td>${fmtDate(r.w.end, true)}</td>
        <td>${esc(r.opp.name)}</td>
        <td><span class="chip ${r.result === 'WIN' ? 'win' : r.result === 'LOSS' ? 'loss' : 'draw'}">${r.result}</span></td>
        <td class="num">${fmtInt(r.us.score)}</td>
        <td class="num">${fmtInt(r.opp.score)}</td>
        <td class="num muted">${fmtInt(r.w.target)}</td>
        <td class="muted">report →</td>
      </tr>`).join('')}</tbody></table></div>`;
    }
  } else table = '<div class="panel pad center muted">Enter a faction id and load its ranked war history.<br><span class="tiny">Tip: finished wars include the full member score report.</span></div>';
  view.innerHTML = `
    <div class="toolbar">
      <input type="number" id="hist-faction" placeholder="Faction id" value="${esc(h.faction)}" style="width:140px">
      <button class="btn small" data-action="load-history">Load history</button>
      ${S.pin ? `<button class="btn small" data-action="hist-use-pin">use pinned (${esc(S.pin)})</button>` : ''}
      <span class="spacer"></span>
      <span class="muted tiny">history is static data — no auto-refresh needed</span>
    </div>
    ${table}`;
  restoreFocus();
}

function renderReport() {
  const r = S.report;
  if (r.loading) { view.innerHTML = '<div class="skeleton blink">LOADING WAR REPORT…</div>'; return; }
  if (r.err) { view.innerHTML = `<div class="panel pad muted">⚠ ${esc(String(r.err))}</div><div class="row" style="margin-top:12px"><button class="btn" data-action="back-history">← back to history</button></div>`; return; }
  const rep = r.data;
  if (!rep) { view.innerHTML = ''; return; }
  const dur = (rep.end - rep.start) * 1000;
  const panels = rep.factions.map((f) => {
    const won = rep.winner === f.id;
    const maxScore = Math.max(...f.members.map((m) => m.score), 1);
    return `
    <div class="panel rep-fact ${won ? 'winner' : ''}">
      <div class="rf-head">
        <span class="sb-name">${esc(f.name)}</span>
        <span class="rf-score mono">${fmtInt(f.score)}</span>
        <span class="spacer"></span>
        <span class="chip ${won ? 'win' : 'loss'}">${won ? 'WINNER' : 'LOST'}</span>
      </div>
      <div class="rf-meta">
        <span class="k">Attacks</span><span class="v mono">${fmtInt(f.attacks)}</span>
        <span class="k">Rank</span><span class="v">${esc(f.rank.before)} <span class="rankarrow">${won ? '▲' : '▼'}</span> ${esc(f.rank.after)}</span>
        <span class="k">Respect</span><span class="v mono">${fmtInt(f.rewards.respect)}</span>
        <span class="k">Points</span><span class="v mono">${fmtInt(f.rewards.points)}</span>
      </div>
      ${f.rewards.items && f.rewards.items.length ? `<div class="pad" style="padding-bottom:4px">${f.rewards.items.map((it) => `<span class="reward-chip">${esc(it.name)} ×${it.quantity}</span>`).join('')}</div>` : ''}
      <div class="tblscroll"><table class="tbl">
        <thead><tr><th>#</th><th>Member</th><th class="num">Lvl</th><th class="num">Attacks</th><th class="num">Score</th><th>Share</th></tr></thead>
        <tbody>${f.members.map((m, i) => `<tr>
          <td class="muted num">${i + 1}</td>
          <td><a href="https://www.torn.com/profiles.php?XID=${m.id}" target="_blank" rel="noopener">${esc(m.name)}</a></td>
          <td class="num">${m.level}</td>
          <td class="num">${fmtInt(m.attacks)}</td>
          <td class="num mono">${fmtF1(m.score)}</td>
          <td class="barcell"><span class="bg" style="width:${Math.max(2, (m.score / maxScore) * 100)}%"></span>&nbsp;</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>`;
  }).join('');
  view.innerHTML = `
    <div class="toolbar">
      <button class="btn small" data-action="back-history">← history</button>
      <span class="muted tiny">War #${rep.id} · ${fmtDate(rep.start, true)} → ${fmtDate(rep.end, true)} · lasted ${fmtDurShort(dur)}${rep.forfeit ? ' · <b>FORFEIT</b>' : ''}</span>
      <span class="spacer"></span>
      <span class="chip win">WINNER: ${esc((rep.factions.find((f) => f.id === rep.winner) || { name: 'draw/no contest' }).name)}</span>
    </div>
    <div class="rep-facts">${panels}</div>`;
}

/* ----- about / setup ----- */
function renderAbout() {
  view.innerHTML = `
  <div class="info-grid">
    <div class="panel pad">
      <h2 class="sect" style="margin-top:0">API key setup</h2>
      <ol class="steps">
        <li>Open <a href="https://www.torn.com/preferences.php#tab=api" target="_blank" rel="noopener">torn.com → preferences → API keys</a>.</li>
        <li>Create a new key of type <b>Public</b> — all features of this app work with it (war lists, rosters, reports).</li>
        <li>Paste it in the top bar and press <kbd>Save</kbd>. It is kept in your browser\u2019s localStorage only.</li>
      </ol>
      <div class="note">Requests go from your browser → this app\u2019s small proxy → <span class="mono">api.torn.com</span>. Nothing else sees the key.</div>
    </div>
    <div class="panel pad">
      <h2 class="sect" style="margin-top:0">Your faction</h2>
      <p class="muted tiny" style="margin-top:0">Your faction is <b>auto-detected from your key</b> (<span class="mono">/faction/basic</span>) — the Hit Club then locks onto the war your faction is fighting and targets its opponent. You can still pin a different faction id here to follow another war instead.</p>
      <div class="row">
        <input type="number" id="pin-input" placeholder="Faction id" value="${esc(S.pin)}" style="width:150px;background:var(--panel);border:1px solid var(--line);color:var(--txt);border-radius:8px;padding:8px 10px">
        <button class="btn small" data-action="save-pin">Save</button>
        <button class="btn small" data-action="detect-faction">Detect from key</button>
      </div>
      ${S.myFaction ? `<p class="tiny" style="color:var(--green)">detected: ${esc(S.myFaction.name)} (#${S.myFaction.id})</p>` : ''}
      <p class="muted tiny">Rosters load for both sides of every war — a Public key can read any faction\u2019s public data.</p>
    </div>
    <div class="panel pad">
      <h2 class="sect" style="margin-top:0">What the app shows</h2>
      <ul class="steps" style="list-style:disc">
        <li><b>Live wars</b> — every ongoing &amp; scheduled ranked war: scores, chains, target %, countdowns.</li>
        <li><b>War room</b> — scoreboard, lead, score-progression chart, both rosters with hospital/jail timers, last actions, “attackable” filter.</li>
        <li><b>The Hit Club</b> — powered by <a href=\"https://ffscouter.com/\" target=\"_blank\" rel=\"noopener\">FF Scouter</a>: stat estimates &amp; fair-fight for every enemy member, ranked weakest → strongest, plus a <b>stat-range matcher</b> (presets anchored to your own estimate, or custom min→max) that filters targets and bulk-adds matches to a priority hit list with notes, claims, hospital timers, attack links and Discord export.: mark targets P1–P3, watch their live hospital timers, assign notes and who’s on it, one-click attack links, and copy the whole list for Discord. Saved per war in your browser.</li>
        <li><b>History &amp; reports</b> — past wars of any faction and the full report: member scores, attacks, rank movement, rewards.</li>
      </ul>
    </div>
    <div class="panel pad">
      <h2 class="sect" style="margin-top:0">Notes &amp; limits</h2>
      <ul class="steps" style="list-style:disc">
        <li>Torn\u2019s API does <b>not</b> publish live per-member war scores — only faction totals while a war runs. Member scores appear once the war report exists.</li>
        <li>Default poll: every ${S.interval}s (changeable up top). Server-side 10s cache keeps you well inside Torn\u2019s rate limits.</li>
        <li>Scores in the war-room chart are sampled while the tab is open (stored locally per war).</li>
        <li>Demo mode simulates everything locally — no API calls.</li>
      </ul>
      <p class="muted tiny">Unofficial fan tool. Not affiliated with Torn or Chedburn.</p>
    </div>
  </div>`;
  restoreFocus();
}

/* ------------------------------------------------------------- controller */
function renderView() {
  saveFocus();
  renderTabs();
  renderErr();
  if (S.tab === 'wars') renderWars();
  else if (S.tab === 'room') renderRoom();
  else if (S.tab === 'hits') renderHits();
  else if (S.tab === 'wrep') renderWarReport();
  else if (S.tab === 'history') {
    if (S.report.loading || S.report.err || S.report.data) renderReport();
    else renderHistory();
  }
  else if (S.tab === 'about') renderAbout();
}

async function refreshData() {
  if (S.busy) return;
  S.busy = true;
  try {
    if (S.tab === 'wars') {
      await loadWars();
      autoDetectFaction();
    } else if (S.tab === 'room' || S.tab === 'hits') {
      await loadWars();
      const warId = pickDefaultWar();
      if (warId) {
        S.room.warId = warId;
        const war = S.wars.find((w) => w.id === warId);
        if (war && war.factions.length === 2) {
          await loadRosters(war); // also useful before the war starts (prep view)
          if (S.tab === 'hits') {
            await loadChains(war);
            const of_ = S.pin ? war.factions.find((f) => +f.id === +S.pin) : null;
            if (of_) {
              const enemySide = war.factions.find((f) => +f.id !== +of_.id);
              const eRoster = enemySide && +enemySide.id === +war.factions[0].id ? S.room.rosterA : S.room.rosterB;
              if (eRoster && eRoster.length) loadWarKills(war, +of_.id, new Set(eRoster.map((m) => +m.id)));
            }
          }
          if (S.tab === 'hits' && (S.key || S.demo)) {
            ensureMyIdentity(); // non-blocking: anchor stat-range matching to your own estimate
            if (!S.ff.autoTried) { S.ff.autoTried = true; ffCheck(); }
            else {
              const registered = S.demo || !!(S.ff.status && S.ff.status.is_registered);
              const rr = (S.room.rosterA || []).concat(S.room.rosterB || []);
              if (registered && !S.ff.scouting && rr.length && rr.some((m) => !ffDataFor(m.id))) scoutFaction(false);
            }
          }
          if (S.tab === 'room' && warPhase(war) !== 'soon') histPush(warId, war.factions[0].score, war.factions[1].score);
        }
      }
    } else if (S.tab === 'history' && S.hist.rows === null && S.hist.faction && !S.hist.loading) {
      await loadHistory(S.hist.faction);
    }
    S.err = null;
  } catch (e) {
    S.err = (e && e.error && (e.error.error || e.error.code)) || 'Unknown error';
    if (String(S.err).toLowerCase().includes('incorrect key')) { /* keep key, show error */ }
  }
  S.busy = false;
  S.nextAt = Date.now() + S.interval * 1000;
  renderView();
}

async function loadHistory(fid) {
  fid = String(fid || '').trim();
  if (!fid) { S.hist.err = 'Enter a faction id'; renderView(); return; }
  S.hist.loading = true; S.hist.err = null; renderView();
  try {
    const d = await torn(`/faction/${parseInt(fid, 10)}/rankedwars`, { sort: 'DESC', limit: 100 });
    const rows = (d.rankedwars || []).map(normalizeWar).filter(Boolean).map((w) => {
      const me = w.factions.find((f) => f.id === parseInt(fid, 10));
      const opp = w.factions.find((f) => f.id !== parseInt(fid, 10)) || w.factions[0];
      const result = w.winner === 0 ? 'DRAW' : w.winner === (me || {}).id ? 'WIN' : 'LOSS';
      return { w, us: me || w.factions[0], opp: opp || w.factions[1], result };
    });
    S.hist.rows = rows;
    S.hist.faction = fid;
  } catch (e) {
    S.hist.err = (e && e.error && (e.error.error || e.error.code)) || 'Failed to load history';
  }
  S.hist.loading = false;
  renderView();
}

async function openReport(warId) {
  S.tab = 'history';
  S.report = { warId, data: null, loading: true, err: null };
  renderTabs(); renderView();
  try {
    const d = await torn(`/faction/${warId}/rankedwarreport`);
    S.report.data = d.rankedwarreport || d;
    S.report.err = null;
  } catch (e) {
    S.report.err = (e && e.error && (e.error.error || e.error.code)) || 'Failed to load report';
  }
  S.report.loading = false;
  renderView();
}

async function autoDetectFaction() {
  if (S.demo || !S.key || S.pin || S.pinAutoTried) return;
  S.pinAutoTried = true;
  try {
    const d = await torn('/faction/basic');
    const b = (d && (d.basic || d)) || {};
    const id = b.id || b.ID;
    if (id) {
      S.pin = String(id);
      S.pinAuto = true;
      S.myFaction = { id: +id, name: b.name || 'Faction #' + id };
      persist();
      if (S.tab === 'hits' || S.tab === 'room' || S.tab === 'wrep') { if (S.tab === 'wrep' && !S.wrep.rows) loadWarReportWars(); else refreshData(); }
      else renderView();
    }
  } catch (e) { /* key has no faction or can't read it — manual pin still available */ }
}
function myWar() {
  if (!S.pin) return null;
  return S.wars.find((w) => warPhase(w) !== 'done' && w.factions.some((f) => +f.id === +S.pin)) || null;
}

async function detectFaction() {
  try {
    const d = await torn('/faction/basic');
    const b = d.basic || d;
    const id = b.id || b.ID;
    if (id) {
      S.myFaction = { id: +id, name: b.name || 'Faction #' + id };
      if (!S.pin) S.pin = String(id);
      persist();
      S.err = null;
    }
  } catch (e) {
    S.err = (e && e.error && (e.error.error || e.error.code)) || 'Could not detect faction from this key';
  }
  renderView();
}

function setDemo(on) {
  S.demo = on;
  if (on && !S.pin) S.pin = String(Demo.DEMO_PIN);
  if (on) { S.wars = []; S.warsLoaded = false; S.room.rosterA = S.room.rosterB = null; S.hist.rows = null; seedDemoHits(); }
  persist();
  renderTabs();
  if (!on) S.nextAt = Date.now() + 400;
  else refreshData().then(() => { if (S.tab === 'room') {} });
}

/* ------------------------------------------------------------------ ticker */
setInterval(() => {
  const now = Date.now();
  $$('[data-cd]').forEach((el) => {
    const ts = +el.dataset.cd * 1000;
    const rem = ts - now;
    if (el.dataset.short) el.textContent = fmtDurShort(rem);
    else el.textContent = rem <= 0 ? 'ENDED' : fmtDur(rem);
  });
  tickChainMeters();
  const nr = $('#next-refresh');
  if (nr) {
    if (!['wars', 'room', 'hits'].includes(S.tab) || (!S.key && !S.demo)) nr.textContent = '—';
    else nr.textContent = `refresh in ${Math.max(0, Math.ceil((S.nextAt - now) / 1000))}s`;
  }
  if (['wars', 'room', 'hits'].includes(S.tab) && (S.key || S.demo) && !document.hidden && now >= S.nextAt && !S.busy) {
    refreshData();
  }
  // refresh relative "last action" cells occasionally
}, 1000);

window.addEventListener('resize', () => {
  if (S.tab === 'room' && S.room.warId) {
    const war = S.wars.find((w) => w.id === S.room.warId);
    if (war) drawSpark(war, readHist(war.id));
  }
});

/* ------------------------------------------------------------------ events */
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const act = el.dataset.action;
  if (act === 'set-tab') {
    S.tab = el.dataset.tab;
    if (S.tab === 'history') {
      S.report = { warId: null, data: null, loading: false, err: null };
      if (!S.hist.rows && S.hist.faction) loadHistory(S.hist.faction);
    }
    renderView();
    if (S.tab === 'wrep' && (S.key || S.demo) && !S.wrep.rows && !S.wrep.loading) loadWarReportWars();
    if ((S.tab === 'room' || S.tab === 'hits') && (S.key || S.demo)) refreshData(); // load immediately, don't wait for the poll tick
  }
  else if (act === 'open-war') { S.room.warId = +el.dataset.war; S.room.rosterA = S.room.rosterB = null; S.room.rosterErr = {}; S.tab = 'room'; refreshData(); }
  else if (act === 'open-report') { openReport(+el.dataset.war); }
  else if (act === 'back-history') { S.report = { warId: null, data: null, loading: false, err: null }; renderView(); }
  else if (act === 'save-key') {
    S.key = $('#key-input').value.trim();
    persist(); renderTabs();
    if (S.key) { S.err = null; S.warsLoaded = false; refreshData(); }
  }
  else if (act === 'refresh-now') { S.nextAt = 0; refreshData(); }
  else if (act === 'dismiss-err') { S.err = null; renderErr(); }
  else if (act === 'goto-demo') { $('#demo-toggle').checked = true; setDemo(true); }
  else if (act === 'load-history') { loadHistory($('#hist-faction').value); }
  else if (act === 'hist-use-pin') { loadHistory(S.pin); }
  else if (act === 'roster-sort') {
    const key = el.dataset.key;
    if (S.room.sortBy === key) S.room.sortDir *= -1;
    else { S.room.sortBy = key; S.room.sortDir = key === 'name' ? 1 : -1; }
    renderView();
  }
  else if (act === 'save-pin') { S.pin = $('#pin-input').value.trim(); persist(); renderView(); }
  else if (act === 'detect-faction') { detectFaction(); }
  else if (act === 'add-hit') {
    const pid = +el.dataset.pid;
    const war = S.wars.find((w) => w.id === S.room.warId);
    if (!war) return;
    const arr = hitsGet(war.id);
    if (arr.some((x) => x.id === pid)) return;
    const m = (S.room.rosterA || []).concat(S.room.rosterB || []).find((x) => x.id === pid);
    if (!m) return;
    arr.push({ id: m.id, name: m.name, level: m.level, priority: 2, note: '', claimed: '', addedAt: Date.now() });
    hitsSet(war.id, arr);
    S.hits.search = '';
    renderView();
  }
  else if (act === 'del-hit') {
    const war = S.wars.find((w) => w.id === S.room.warId);
    if (!war) return;
    hitsSet(war.id, hitsGet(war.id).filter((x) => x.id !== +el.dataset.pid));
    renderView();
  }
  else if (act === 'hit-pri') {
    const war = S.wars.find((w) => w.id === S.room.warId);
    if (!war) return;
    const arr = hitsGet(war.id);
    const entry = arr.find((x) => x.id === +el.dataset.pid);
    if (entry) entry.priority = (entry.priority % 3) + 1;
    hitsSet(war.id, arr);
    renderView();
  }
  else if (act === 'copy-hits') {
    const war = S.wars.find((w) => w.id === S.room.warId);
    if (!war) return;
    const maps = [{}, {}];
    (S.room.rosterA || []).forEach((m) => { maps[0][m.id] = m; });
    (S.room.rosterB || []).forEach((m) => { maps[1][m.id] = m; });
    const lines = hitsGet(war.id)
      .slice()
      .sort((x, y) => x.priority - y.priority)
      .map((en) => {
        const si = entryStatus(en, maps);
        const st = si ? String(si.label).replace(/<[^>]*>/g, '').trim() : 'status unknown';
        const fr = ffDataFor(en.id);
        const estbit = fr && fr.d && fr.d.bs_estimate_human ? ` — est ${fr.d.bs_estimate_human}/FF ${ffFf(fr) != null ? ffFf(fr).toFixed(2) : '?'}` : '';
        return `P${en.priority} — ${en.name} [lvl ${en.level}] (#${en.id}) — ${st}${estbit}` +
          (en.note ? ` — ${en.note}` : '') + (en.claimed ? ` — on it: ${en.claimed}` : '');
      });
    const txt = `☠ THE HIT CLUB — War #${war.id}: ${war.factions[0].name} vs ${war.factions[1].name} (target ${fmtInt(war.target)})` +
      (war.end ? ` — ends ${new Date(war.end * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : '') +
      '\n' + lines.join('\n');
    copyText(txt).then((ok) => {
      if (ok) {
        S.hits.copiedAt = Date.now();
        renderView();
        setTimeout(() => { if (S.tab === 'hits') renderView(); }, 2300);
      } else {
        S.err = 'Clipboard blocked by the browser — open the list and copy manually.';
        renderErr();
      }
    });
  }
  else if (act === 'clear-hits') {
    const war = S.wars.find((w) => w.id === S.room.warId);
    if (war) hitsSet(war.id, []);
    renderView();
  }
  else if (act === 'clear-squad-search') { S.ff.squadSearch = ''; renderView(); }
  else if (act === 'wrep-load') { loadWarReportWars($('#wrep-faction').value); }
  else if (act === 'wrep-use-pin') { loadWarReportWars(S.pin); }
  else if (act === 'open-member') { S.ff.popup = +el.dataset.pid; renderView(); }
  else if (act === 'close-member') { if (el === e.target) { S.ff.popup = null; renderView(); } }
  else if (act === 'copy-member-discord') {
    const txt = memberDiscordText();
    if (!txt) return;
    copyText(txt).then((ok) => {
      if (ok) {
        S.ff.discCopiedAt = Date.now();
        renderView();
        setTimeout(() => { if (S.ff.popup) renderView(); }, 2300);
      } else {
        S.err = 'Clipboard blocked by the browser — select the text manually instead.';
        renderErr();
      }
    });
  }
  else if (act === 'goto-my-war') {
    const mw = myWar();
    if (mw) { S.room.warId = mw.id; S.room.rosterA = S.room.rosterB = null; S.room.rosterErr = {}; refreshData(); }
  }
  else if (act === 'ff-check') { ffCheck(); }
  else if (act === 'ff-register') { ffRegister(); }
  else if (act === 'ff-scout') { scoutFaction(false); }
  else if (act === 'ff-rescout') { scoutFaction(true); }
  else if (act === 'ff-add-matches') {
    const war = S.wars.find((w) => w.id === S.room.warId);
    if (!war) return;
    const roster = (S.room.rosterA || []).concat(S.room.rosterB || []);
    const bounds = ffMatchBounds();
    const arr = hitsGet(war.id);
    let added = 0;
    roster.forEach((m) => {
      if (arr.some((x) => x.id === m.id)) return;
      if (!ffInRange(ffDataFor(m.id), bounds)) return;
      arr.push({ id: m.id, name: m.name, level: m.level, priority: 2, note: '', claimed: '', addedAt: Date.now() });
      added++;
    });
    if (added) { hitsSet(war.id, arr); S.hits.search = ''; }
    renderView();
  }
  else if (act === 'ff-sort') {
    const key = el.dataset.key;
    if (S.ff.sort === key) S.ff.dir *= -1;
    else { S.ff.sort = key; S.ff.dir = key === 'est' || key === 'ff' ? 1 : -1; }
    renderView();
  }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'demo-toggle') setDemo(t.checked);
  else if (t.id === 'interval-select') { S.interval = parseInt(t.value, 10) || 15; persist(); S.nextAt = Date.now() + S.interval * 1000; }
  else if (t.id === 'wars-sort') { S.warsSort = t.value; persist(); renderView(); }
  else if (t.id === 'room-select') { S.room.warId = +t.value; S.room.rosterA = S.room.rosterB = null; S.room.rosterErr = {}; refreshData(); }
  else if (t.id === 'room-filter') { S.room.filter = t.value; renderView(); }
  else if (t.id === 'room-sortcol') { S.room.sortBy = t.value; renderView(); }
  else if (t.id === 'ff-preset') { S.ff.match.preset = t.value; renderView(); }
  else if (t.id === 'ff-consent') { S.ff.consent = t.checked; try { store.rw_ff_consent = t.checked ? '1' : '0'; } catch (e) {} }
  else if (t.id === 'wrep-war') { const war = (S.wrep.rows || []).find((x) => x.id === +t.value); if (war && warPhase(war) === 'done') loadWarReport(war.id); else { S.wrep.warId = +t.value; S.wrep.data = null; renderView(); } }
  else if (t.id === 'wrep-sort') { S.wrep.sort = t.value; renderView(); }
  else if (t.id === 'hits-side') {
    const war = S.wars.find((w) => w.id === S.room.warId);
    if (war) S.hits.side[war.id] = +t.value;
    S.hits.search = '';
    renderView();
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'wars-search') { S.warsSearch = t.value; renderView(); }
  else if (t.id === 'room-search') { S.room.search = t.value; renderView(); }
  else if (t.id === 'hits-search') { S.hits.search = t.value; renderView(); }
  else if (t.id === 'squad-search') { S.ff.squadSearch = t.value; renderView(); }
  else if (t.id === 'ff-min' || t.id === 'ff-max') {
    S.ff.match[t.id === 'ff-min' ? 'min' : 'max'] = t.value;
    if (S.ff.match.preset !== 'custom') S.ff.match.preset = 'custom';
    renderView();
  }
  else if (t.dataset && (t.dataset.field === 'note' || t.dataset.field === 'claimed')) {
    // silent save while typing — no re-render, keeps the caret in place
    const war = S.wars.find((w) => w.id === +t.dataset.hit);
    if (!war) return;
    const arr = hitsGet(war.id);
    const entry = arr.find((x) => x.id === +t.dataset.pid);
    if (entry) { entry[t.dataset.field] = t.value; hitsSet(war.id, arr); }
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && S.ff.popup) { S.ff.popup = null; renderView(); return; }
  if (e.key === 'Enter') {
    const t = e.target;
    if (t.id === 'key-input') { S.key = t.value.trim(); persist(); renderTabs(); if (S.key) { S.warsLoaded = false; refreshData(); } }
    else if (t.id === 'hist-faction') loadHistory(t.value);
    else if (t.id === 'wrep-faction') loadWarReportWars(t.value);
    else if (t.id === 'pin-input') { S.pin = t.value.trim(); persist(); renderView(); }
  }
  if (e.key === 'Enter' && e.target.closest && e.target.closest('.warcard')) {
    const el = e.target.closest('[data-action="open-war"]');
    if (el) { S.room.warId = +el.dataset.war; S.tab = 'room'; refreshData(); }
  }
});

/* -------------------------------------------------------------------- init */
(function init() {
  $('#key-input').value = S.key;
  renderTabs();
  renderErr();
  if (!S.key && !S.demo) { renderView(); return; }
  if (S.demo && !S.pin) { S.pin = String(Demo.DEMO_PIN); }
  if (S.demo) seedDemoHits();
  S.nextAt = 0;
  refreshData();
})();

/* ----- matrix rain background (canvas, self-contained) ----- */
(function matrixRain() {
  const cv = document.getElementById('matrixcv');
  if (!cv || !cv.getContext) return;
  const ctx = cv.getContext('2d');
  if (!ctx) return; // no canvas support (tests / exotic embeds) — app runs unchanged
  const GLYPHS = 'アカサタナハマヤラワイキシチニヒミリウクスツヌフムユルエケセテネヘメレオコソトノホモヨロヴ0123456789ABCDEFXYZ$#@*+=<>';
  const FS = 16;                       // column width / font size (CSS px)
  const FRAME_MS = 45;                 // ~22 fps — readable but cheap
  let cols = 0, drops = [], w = 0, h = 0, raf = 0, last = 0, hidden = false;
  const reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  function resize() {
    w = window.innerWidth; h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    cv.width = Math.floor(w * dpr); cv.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0b0e11';
    ctx.fillRect(0, 0, w, h);
    cols = Math.ceil(w / FS);
    drops = Array.from({ length: cols }, () => Math.floor(Math.random() * (h / FS)));
    ctx.font = (FS - 2) + 'px ui-monospace, Menlo, Consolas, monospace';
    ctx.textBaseline = 'top';
  }
  function frame(anim) {
    ctx.fillStyle = 'rgba(11, 14, 17, 0.10)';   // fade in the app's own bg color
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < cols; i++) {
      const y = drops[i] * FS;
      ctx.fillStyle = Math.random() < 0.06 ? '#b9ffb0' : '#63c74d';  // rare bright head, theme-green body
      ctx.fillText(GLYPHS[(Math.random() * GLYPHS.length) | 0], i * FS, y);
      if (y > h && Math.random() > 0.975) drops[i] = 0;
      else drops[i]++;
    }
  }
  function loop(ts) {
    raf = requestAnimationFrame(loop);
    if (hidden || ts - last < FRAME_MS) return;
    last = ts;
    frame(true);
  }
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => { hidden = document.hidden; });
  resize();
  if (reduce) { for (let i = 0; i < Math.ceil(h / FS) + 10; i++) frame(false); return; } // one static frame
  raf = requestAnimationFrame(loop);
})();
