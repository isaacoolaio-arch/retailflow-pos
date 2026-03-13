var CACHE_NAME = 'oola-retailflow-v7';
var ASSETS = ['./manifest.json'];

self.addEventListener('install', function(event) {
  // Force this new SW to activate immediately, don't wait
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(ASSETS);
    })
  );
});

self.addEventListener('activate', function(event) {
  // Delete ALL old caches immediately
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.map(function(k) {
          console.log('[SW] Deleting old cache:', k);
          return caches.delete(k);
        })
      );
    }).then(function() {
      // Take control of all pages immediately
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function(event) {
  var url = event.request.url;

  // Never intercept API calls
  if (url.indexOf('script.google.com') !== -1 || url.indexOf('api.anthropic.com') !== -1) {
    event.respondWith(
      fetch(event.request).catch(function() {
        return new Response(JSON.stringify({error:'offline'}), {
          headers: {'Content-Type': 'application/json'}
        });
      })
    );
    return;
  }

  // Only handle GET requests
  if (event.request.method !== 'GET') return;

  // index.html: ALWAYS fetch fresh from network, fall back to cache only if offline
  if (url.indexOf('index.html') !== -1 || url.endsWith('/retailflow-pos/') || url.endsWith('/retailflow-pos')) {
    event.respondWith(
      fetch(event.request).then(function(response) {
        // Got fresh copy - update cache and return it
        var clone = response.clone();
        caches.open(CACHE_NAME).then(function(cache) { cache.put(event.request, clone); });
        return response;
      }).catch(function() {
        // Offline - serve from cache
        return caches.match(event.request);
      })
    );
    return;
  }

  // Everything else: cache first, network fallback
  event.respondWith(
    caches.match(event.request).then(function(cached) {
      return cached || fetch(event.request).then(function(response) {
        var clone = response.clone();
        caches.open(CACHE_NAME).then(function(cache) { cache.put(event.request, clone); });
        return response;
      });
    })
  );
});
