// Each release is cached as one unit. Bump VERSION (and the ?v= on app.js/style.css in index.html)
// on every deploy: the browser sees sw.js changed, installs the new set with cache.addAll (all files
// or nothing), and only then switches over. Pages are always served from one complete release,
// so a failed download can never mix old and new files.
const VERSION = '3';
const CACHE = 'mtgscan-r' + VERSION;
const SHELL = ['./', 'index.html', `style.css?v=${VERSION}`, `app.js?v=${VERSION}`, 'manifest.webmanifest',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k.startsWith('mtgscan') && k !== CACHE && k !== 'mtgscan-ocr').map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const ocrAsset = /tesseract|tessdata/.test(url.href);
  if (ocrAsset) { // version-pinned CDN files: cache-first in their own long-lived cache
    e.respondWith(caches.open('mtgscan-ocr').then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const r = await fetch(e.request);
      if (r.ok) e.waitUntil(c.put(e.request, r.clone()));
      return r;
    }));
    return;
  }
  if (url.origin !== location.origin) return; // Scryfall API & images: always live
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const key = e.request.mode === 'navigate' ? './' : e.request;
    return (await c.match(key, { ignoreSearch: e.request.mode === 'navigate' })) || fetch(e.request);
  }));
});
