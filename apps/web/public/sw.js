const CACHE_VERSION = 'live-admin-v2';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const PAGE_CACHE = `${CACHE_VERSION}-pages`;
const DEV_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);
const IS_DEV_HOST = DEV_HOSTS.has(self.location.hostname);

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    IS_DEV_HOST
      ? caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
      : caches.open(STATIC_CACHE)
  );
});

self.addEventListener('activate', (event) => {
  if (IS_DEV_HOST) {
    event.waitUntil(
      caches.keys()
        .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
        .then(() => self.registration.unregister())
        .then(() => self.clients.claim())
    );
    return;
  }

  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => ![STATIC_CACHE, PAGE_CACHE].includes(key))
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

function isStaticAsset(pathname) {
  return (
    pathname.startsWith('/_next/static/') ||
    pathname === '/icon.svg' ||
    pathname === '/manifest.webmanifest' ||
    /\.(?:css|js|png|jpg|jpeg|svg|webp|gif|woff2?)$/i.test(pathname)
  );
}

self.addEventListener('fetch', (event) => {
  if (IS_DEV_HOST) return;

  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(PAGE_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          if (cached) return cached;
          return caches.match('/login');
        })
    );
    return;
  }

  if (!isStaticAsset(url.pathname)) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;

      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});
