var CACHE_NAME = 'oola-retailflow-v8';

// Core files that MUST be cached for offline to work
var CORE_ASSETS = [
  './index.html',
  './manifest.json'
];

// ── Install: cache core files immediately ──────────────────────
self.addEventListener('install', function(event) {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(CORE_ASSETS).catch(function(err) {
        console.log('[SW] Core asset caching failed:', err);
      });
    })
  );
});

// ── Activate: delete ALL old caches ───────────────────────────
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.map(function(k) {
          if (k !== CACHE_NAME) {
            console.log('[SW] Deleting old cache:', k);
            return caches.delete(k);
          }
        })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

// ── Fetch: smart caching strategy ─────────────────────────────
self.addEventListener('fetch', function(event) {
  var url = event.request.url;
  var method = event.request.method;

  // Never intercept non-GET or API calls
  if (method !== 'GET') return;
  if (url.indexOf('script.google.com') !== -1) return;
  if (url.indexOf('api.anthropic.com') !== -1) return;

  // index.html and root URL: network first, fall back to cache
  var isHtmlPage = url.indexOf('index.html') !== -1 ||
                   url.endsWith('/') ||
                   url.endsWith('/retailflow-pos') ||
                   url.endsWith('/retailflow-pos/');

  if (isHtmlPage) {
    event.respondWith(
      fetch(event.request).then(function(response) {
        var clone = response.clone();
        caches.open(CACHE_NAME).then(function(cache) { cache.put(event.request, clone); });
        return response;
      }).catch(function() {
        return caches.match('./index.html').then(function(cached) {
          if (cached) return cached;
          return new Response('<h1>Offline</h1><p>Open the app online first to enable offline mode.</p>',
            { headers: { 'Content-Type': 'text/html' } });
        });
      })
    );
    return;
  }

  // CDN assets: cache first
  var isCDN = url.indexOf('cdnjs.cloudflare.com') !== -1 ||
              url.indexOf('cdn.tailwindcss.com') !== -1 ||
              url.indexOf('fonts.googleapis.com') !== -1 ||
              url.indexOf('fonts.gstatic.com') !== -1 ||
              url.indexOf('html5-qrcode') !== -1;

  if (isCDN) {
    event.respondWith(
      caches.match(event.request).then(function(cached) {
        if (cached) return cached;
        return fetch(event.request).then(function(response) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) { cache.put(event.request, clone); });
          return response;
        }).catch(function() { return new Response('', { status: 503 }); });
      })
    );
    return;
  }

  // Everything else: network first, cache fallback
  event.respondWith(
    fetch(event.request).catch(function() {
      return caches.match(event.request);
    })
  );
});
