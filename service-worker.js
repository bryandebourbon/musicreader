const CACHE_VERSION = '1.0.2';
const CACHE_NAME = 'emusicreader-cache-v' + CACHE_VERSION;
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './ddd.xml',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './jszip.min.js'
];

console.log('[SW CHECKPOINT] Service Worker loading, version:', CACHE_VERSION);

self.addEventListener('install', event => {
  console.log('[SW CHECKPOINT] Install event triggered');
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW CHECKPOINT] Cache opened, adding assets:', ASSETS.length);
        return cache.addAll(ASSETS);
      })
      .then(() => {
        console.log('[SW CHECKPOINT] All assets cached successfully');
      })
      .catch(err => {
        console.error('[SW CHECKPOINT] Cache addAll failed:', err?.message || err);
      })
  );
});

self.addEventListener('activate', event => {
  console.log('[SW CHECKPOINT] Activate event triggered');
  event.waitUntil(
    caches.keys().then(keys => {
      console.log('[SW CHECKPOINT] Found cache keys:', keys);
      const oldKeys = keys.filter(k => k !== CACHE_NAME);
      console.log('[SW CHECKPOINT] Deleting old caches:', oldKeys);
      return Promise.all(oldKeys.map(k => caches.delete(k)));
    }).then(() => {
      console.log('[SW CHECKPOINT] Old caches deleted, claiming clients');
      return self.clients.claim();
    }).then(() => {
      console.log('[SW CHECKPOINT] Clients claimed');
    })
  );
});

self.addEventListener('fetch', event => {
  const requestUrl = new URL(event.request.url);
  const isSameOrigin = requestUrl.origin === location.origin;
  const pathname = requestUrl.pathname;
  
  if (event.request.url.includes('/index.html') || event.request.url.endsWith('/')) {
    console.log('[SW CHECKPOINT] Fetch (network-first):', pathname);
    event.respondWith(
      fetch(event.request)
        .then(response => {
          console.log('[SW CHECKPOINT] Fetch success:', pathname, { status: response.status, type: response.type });
          if (response.ok && isSameOrigin) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then(cache => {
              cache.put(event.request, responseClone);
            });
          }
          return response;
        })
        .catch(err => {
          console.log('[SW CHECKPOINT] Fetch failed, serving from cache:', pathname, err?.message);
          return caches.match(event.request);
        })
    );
  } else if (!isSameOrigin) {
    console.log('[SW CHECKPOINT] Fetch (passthrough, cross-origin):', requestUrl.href);
    event.respondWith(fetch(event.request));
  } else {
    console.log('[SW CHECKPOINT] Fetch (cache-first):', pathname);
    event.respondWith(
      caches.match(event.request).then(response => {
        if (response) {
          console.log('[SW CHECKPOINT] Cache hit:', pathname);
          return response;
        }
        console.log('[SW CHECKPOINT] Cache miss, fetching:', pathname);
        return fetch(event.request).then(fetchResponse => {
          console.log('[SW CHECKPOINT] Fetched:', pathname, { status: fetchResponse.status, type: fetchResponse.type });
          if (fetchResponse.ok && fetchResponse.type !== 'opaque') {
            return caches.open(CACHE_NAME).then(cache => {
              cache.put(event.request, fetchResponse.clone());
              return fetchResponse;
            });
          }
          return fetchResponse;
        });
      })
    );
  }
});
