// Venue autocomplete for "מיקום האירוע".
//
// Two sources, in this order:
//   1. venues this band has already played — 5,000+ historical leads are a
//      better index of Israeli wedding halls than any general geocoder
//   2. Photon (photon.komoot.io), an OpenStreetMap geocoder built for
//      search-as-you-type. Free, no API key, no account.
//
// Photon's terms ask callers to be fair, so every query is cached and the client
// debounces. If this ever outgrows the public instance, POINT the base URL at a
// self-hosted Photon — it is the one constant below.
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const PHOTON = 'https://photon.komoot.io/api/';
// Most events are in Israel, so results near it rank first — this biases, it
// does not filter, so venues abroad still come back.
const BIAS = { lat: 31.5, lon: 34.9, scale: 0.4 };

// OSM types that are plausibly an event venue, best first. Photon returns the
// same place several times under different tags; this decides which wins.
const VENUE_RANK = {
  'amenity:events_venue': 0,
  'amenity:conference_centre': 1,
  'tourism:hotel': 2,
  'amenity:restaurant': 3,
  'leisure:garden': 4,
  'leisure:park': 5,
  'amenity:community_centre': 6,
  'amenity:place_of_worship': 7,
  'tourism:attraction': 8,
};
const rankOf = (p) => VENUE_RANK[`${p.osm_key}:${p.osm_value}`] ?? 50;

// ---- tiny TTL cache ---------------------------------------------------------
// Autocomplete repeats the same prefixes constantly ("גנ", "גני", "גני ה"), so a
// cache removes most upstream traffic on its own.
const CACHE = new Map();
const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ENTRIES = 800;

function cacheGet(key) {
  const hit = CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) { CACHE.delete(key); return null; }
  CACHE.delete(key); CACHE.set(key, hit); // refresh LRU order
  return hit.value;
}
function cacheSet(key, value) {
  CACHE.set(key, { value, at: Date.now() });
  while (CACHE.size > MAX_ENTRIES) CACHE.delete(CACHE.keys().next().value);
}

// ---- formatting -------------------------------------------------------------
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

function labelOf(p) {
  const where = [p.city || p.district, p.state, p.countrycode === 'IL' ? null : p.country]
    .filter(Boolean);
  // drop a "city" that just repeats the name ("תל אביב" in "תל אביב")
  const name = p.name || [p.street, p.housenumber].filter(Boolean).join(' ');
  const tail = where.filter(w => norm(w) !== norm(name));
  return [name, ...tail.slice(0, 2)].filter(Boolean).join(', ');
}

async function searchPhoton(q, signal) {
  const url = `${PHOTON}?q=${encodeURIComponent(q)}&limit=12` +
    `&lat=${BIAS.lat}&lon=${BIAS.lon}&location_bias_scale=${BIAS.scale}`;
  const rsp = await fetch(url, {
    signal,
    headers: { 'User-Agent': 'Zooglot.DB CRM (kolotband.co.il)' },
  });
  if (!rsp.ok) throw new Error(`photon ${rsp.status}`);
  const data = await rsp.json();

  const seen = new Map();
  for (const f of (data.features || [])) {
    const p = f.properties || {};
    if (!p.name && !p.street) continue;
    const label = labelOf(p);
    const key = norm(label);
    // the same venue comes back under several OSM tags — keep the most
    // venue-like one rather than whichever happened to be first
    const prev = seen.get(key);
    if (prev && rankOf(prev.raw) <= rankOf(p)) continue;
    seen.set(key, {
      label,
      country: p.countrycode || null,
      kind: `${p.osm_key}:${p.osm_value}`,
      lat: f.geometry?.coordinates?.[1] ?? null,
      lon: f.geometry?.coordinates?.[0] ?? null,
      raw: p,
    });
  }
  return [...seen.values()]
    .sort((a, b) => rankOf(a.raw) - rankOf(b.raw))
    .map(({ raw, ...rest }) => rest);
}

// Venues already in the CRM. Cached briefly — this is a full table scan of one
// narrow column, and the list barely moves.
let historyCache = { at: 0, list: [] };
async function venueHistory() {
  if (Date.now() - historyCache.at < 5 * 60 * 1000) return historyCache.list;
  const rows = await db.list('leads', { columns: 'event_location' });
  const counts = new Map();
  for (const r of rows) {
    const v = String(r.event_location || '').trim();
    if (v.length < 2) continue;
    const key = norm(v);
    const prev = counts.get(key);
    if (prev) prev.n++;
    else counts.set(key, { label: v, n: 1 });
  }
  historyCache = {
    at: Date.now(),
    list: [...counts.values()].sort((a, b) => b.n - a.n),
  };
  return historyCache.list;
}

async function suggest(q, { includeHistory }) {
  const query = String(q || '').trim();
  if (query.length < 2) return [];

  const out = [];
  const taken = new Set();
  const push = (item) => {
    const key = norm(item.label);
    if (!key || taken.has(key)) return;
    taken.add(key);
    out.push(item);
  };

  if (includeHistory) {
    const needle = norm(query);
    for (const v of await venueHistory()) {
      if (!norm(v.label).includes(needle)) continue;
      push({ label: v.label, source: 'history', used: v.n });
      if (out.length >= 5) break; // leave room for real geocoder results
    }
  }

  const cacheKey = `photon:${norm(query)}`;
  let remote = cacheGet(cacheKey);
  if (!remote) {
    // Never let a slow or down geocoder hang the field — the user's own history
    // is already in `out` and is the more useful half anyway.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 3500);
    try {
      remote = await searchPhoton(query, ac.signal);
      cacheSet(cacheKey, remote);
    } catch {
      remote = [];
    } finally {
      clearTimeout(timer);
    }
  }
  for (const r of remote) push({ ...r, source: 'osm' });
  return out.slice(0, 10);
}

// ---- routers ----------------------------------------------------------------
const authed = express.Router();
authed.use(requireAuth);
authed.get('/', async (req, res) => {
  res.json({ places: await suggest(req.query.q, { includeHistory: true }) });
});

// Used by the public lead form and the contract portal, where the visitor is a
// client rather than a team member. History is left out on purpose: the list of
// venues this band works is business information and would be enumerable by
// anyone who can load the form.
const publicRouter = express.Router();
publicRouter.get('/', async (req, res) => {
  res.json({ places: await suggest(req.query.q, { includeHistory: false }) });
});

module.exports = { authed, publicRouter, _suggest: suggest };
