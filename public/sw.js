/* PokéStride service worker
 * - Caches the app shell + all same-origin assets (offline capable: Tesseract + self-hosted emulator core)
 * - Caches the emulator core / zip.js from the jsDelivr CDN so the first online launch also works offline later
 * - Handles the Web Share Target POST: stores shared images in a cache, then redirects
 *   to /?shared=N where the app picks them up.
 */
const VERSION = 'v2';
const SHELL_CACHE = `pokestride-shell-${VERSION}`;
const CDN_CACHE = 'pokestride-cdn-v1';
const SHARE_CACHE = 'pokestride-shared';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((c) => c.addAll(['/', '/index.html', '/manifest.json', '/icon-192.png', '/icon-512.png']))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith('pokestride-shell-') && k !== SHELL_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

async function handleShare(request) {
  try {
    const form = await request.formData();
    const files = form.getAll('image').filter((f) => f && typeof f !== 'string');
    const cache = await caches.open(SHARE_CACHE);
    for (const k of await cache.keys()) await cache.delete(k);
    let i = 0;
    for (const file of files) {
      await cache.put(
        `/shared/${i++}`,
        new Response(file, {
          headers: { 'Content-Type': file.type || 'image/png', 'X-Filename': encodeURIComponent(file.name || 'shared.png') },
        })
      );
    }
    return Response.redirect(`/?shared=${files.length}`, 303);
  } catch (e) {
    return Response.redirect('/', 303);
  }
}

// Cache-first for immutable, versioned CDN files (emulator core zip, zip.js)
async function cdnCacheFirst(request) {
  const cache = await caches.open(CDN_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method === 'POST' && url.pathname === '/share-target') {
    event.respondWith(handleShare(req));
    return;
  }
  if (req.method !== 'GET') return;

  if (url.origin !== self.location.origin) {
    if (url.hostname === 'cdn.jsdelivr.net') event.respondWith(cdnCacheFirst(req));
    return;
  }

  // Page navigations: network first, fall back to cached shell
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put('/index.html', copy));
          return res;
        })
        .catch(() => caches.match('/index.html').then((r) => r || caches.match('/')))
    );
    return;
  }

  // Assets: cache first, fill from network
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
    )
  );
});
