/* Offline helper for "Where We Are All From" (Mo's Friends & Family Map).
   Upload this file to the same GitHub folder as "Mo Friends & Family.html".

   What it keeps on the phone so the map opens with no connection:
   - the page itself (always fetched fresh when online; saved copy used offline)
   - Leaflet map code, the fonts
   - map pictures (tiles) — every one you look at, plus a starter set the page
     downloads once (whole world zoomed out, North America closer in)

   Not saved: the Firebase code. Offline, the page uses the pins and trips
   it already keeps on the device instead.

   If you change this file, bump VERSION so phones pick up the new copy. */
const VERSION = 'v3';
const PAGE_CACHE = 'mo-map-page-' + VERSION;
const LIB_CACHE = 'mo-map-libs-' + VERSION;
const TILE_CACHE = 'mo-map-tiles';      // kept across versions — no need to re-download the map
const MAX_TILES = 3000;                 // roughly 40–60 MB at most; oldest are dropped first
const PAGE_WAIT_MS = 4000;              // weak signal: after this, show the saved page

const LIB_HOSTS = ['cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
// Map pictures and state flags: saved once, then used from the phone.
const TILE_HOSTS = ['server.arcgisonline.com', 'tile.openstreetmap.org', 'raw.githubusercontent.com',
                    'a.tile.opentopomap.org', 'b.tile.opentopomap.org', 'c.tile.opentopomap.org'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(PAGE_CACHE);
    try { await cache.add(new Request('./', { cache: 'reload' })); } catch (e) {}
    const libs = await caches.open(LIB_CACHE);
    await Promise.all([
      'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
      'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js'
    ].map(u => libs.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keep = [PAGE_CACHE, LIB_CACHE, TILE_CACHE];
    for (const name of await caches.keys()) {
      if (name.startsWith('mo-map-') && !keep.includes(name)) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

// The page asks to be saved under its own name (works for index.html or any other file name).
self.addEventListener('message', event => {
  const d = event.data || {};
  if (d.type === 'cache-page' && d.url) {
    event.waitUntil(caches.open(PAGE_CACHE).then(c => c.add(new Request(d.url, { cache: 'reload' }))).catch(() => {}));
  }
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // The page: try the internet first (so updates show up), saved copy if that fails.
  if (req.mode === 'navigate' && url.origin === self.location.origin) {
    event.respondWith(pageNetworkFirst(req));
    return;
  }
  // Map pictures: saved copy first, internet if not saved yet.
  if (TILE_HOSTS.includes(url.hostname)) {
    event.respondWith(tileCacheFirst(req));
    return;
  }
  // Map code and fonts: saved copy right away, refreshed in the background.
  if (LIB_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(req, LIB_CACHE));
    return;
  }
  // Everything else (Firebase, ZIP and city lookups) goes straight to the internet.
});

async function pageNetworkFirst(req) {
  const cache = await caches.open(PAGE_CACHE);
  try {
    const res = await Promise.race([
      fetch(req, { cache: 'no-store' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('slow')), PAGE_WAIT_MS))
    ]);
    // Save the page under its own address, whatever the file is called.
    if (res && res.ok) cache.put(req.url.split('#')[0].split('?')[0], res.clone());
    return res;
  } catch (e) {
    const saved = await cache.match(req, { ignoreSearch: true }) || await cache.match('./');
    if (saved) return saved;
    // Slow but not offline, and nothing saved yet: keep waiting on the network.
    return fetch(req);
  }
}

async function tileCacheFirst(req) {
  const cache = await caches.open(TILE_CACHE);
  const saved = await cache.match(req.url);
  if (saved) return saved;
  // Ask for the image the "CORS" way: such copies take their real size in
  // storage. (A plain image request is "opaque", and browsers count each of
  // those as several megabytes, which would fill the phone's allowance fast.)
  let res = null;
  try { res = await fetch(req.url, { mode: 'cors', credentials: 'omit' }); } catch (e) {}
  if (res && res.ok) {
    try { await cache.put(req.url, res.clone()); trimTiles(cache); } catch (e) {}
    return res;
  }
  // That map server doesn't allow it: show the image anyway, just don't save it.
  try { return await fetch(req); }
  catch (e) { return new Response('', { status: 504, statusText: 'Offline' }); }
}

let trimming = false;
async function trimTiles(cache) {
  if (trimming) return;
  trimming = true;
  try {
    const keys = await cache.keys();
    const extra = keys.length - MAX_TILES;
    for (let i = 0; i < extra; i++) await cache.delete(keys[i]);
  } finally {
    trimming = false;
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const saved = await cache.match(req);
  const fresh = fetch(req).then(res => {
    if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  return saved || (await fresh) || new Response('', { status: 504, statusText: 'Offline' });
}
