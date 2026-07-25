/**
 * Offline cache.
 *
 * Because every tool runs client-side, the site genuinely works with no
 * connection once visited — that is a real capability here, not a token PWA
 * gesture. The cache holds the site's own code only; audio files are never
 * touched by it.
 */

const VERSION = 'v1';
const PAGES = `pages-${VERSION}`;
const ASSETS = `assets-${VERSION}`;

self.addEventListener('install', (event) => {
  // Take over promptly so a first-time visitor gets offline support without
  // needing a second visit.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => !key.endsWith(VERSION)).map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // The ffmpeg core is 31 MB. Caching it would blow most browsers' storage
  // quota and evict everything useful, so it always goes to the network.
  if (url.pathname.startsWith('/ffmpeg/')) return;

  // Navigations: network first, so content updates land immediately, with the
  // cache as the offline fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          const cache = await caches.open(PAGES);
          cache.put(request, response.clone());
          return response;
        } catch {
          const cached = await caches.match(request);
          return cached ?? (await caches.match('/')) ?? Response.error();
        }
      })()
    );
    return;
  }

  // Hashed build assets and fonts: cache first, since their URL changes when
  // their content does.
  if (
    url.pathname.startsWith('/_astro/') ||
    url.pathname.startsWith('/fonts/') ||
    url.pathname.endsWith('.svg')
  ) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(ASSETS);
          cache.put(request, response.clone());
        }
        return response;
      })()
    );
  }
});
