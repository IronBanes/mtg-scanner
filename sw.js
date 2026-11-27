// App files: network-first, so a new deploy is picked up whole and never mixed with old files;
// the cache is only the offline fallback. OCR engine files (version-pinned URLs): cache-first.
const CACHE = 'mtgscan-v2';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const sameOrigin = url.origin === location.origin;
  const ocrAsset = /tesseract|tessdata/.test(url.href);
  if (!sameOrigin && !ocrAsset) return; // Scryfall API & images: always live
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    if (ocrAsset) {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const r = await fetch(e.request);
      if (r.ok) e.waitUntil(c.put(e.request, r.clone()));
      return r;
    }
    try {
      const r = await fetch(e.request, { cache: 'no-cache' });
      if (r.ok) e.waitUntil(c.put(e.request, r.clone()));
      return r;
    } catch (err) {
      const hit = await c.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
