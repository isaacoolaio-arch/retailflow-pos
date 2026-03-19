var CACHE_NAME = 'oola-retailflow-v9';

// ALL assets needed to run the app offline — cached during install
var CORE_ASSETS = [
  './index.html',
  './manifest.json',
  // React
  'https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js',
  // Babel (needed to compile JSX in browser)
  'https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.23.9/babel.min.js',
  // Barcode scanner
  'https://cdnjs.cloudflare.com/ajax/libs/html5-qrcode/2.3.8/html5-qrcode.min.js',
  // Tailwind CDN (dynamic but we try — offline fallback uses cached version)
  'https://cdn.tailwindcss.com'
];

// ── Install: pre-cache all core assets ────────────────────────
self.addEventListener('install', function(event) {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      // Cache each asset individually so one failure doesn't block others
      var promises = CORE_ASSETS.map(function(url) {
        return cache.add(url).catch(function(err) {
          console.log('[SW] Failed to cache:', url, err.message);
        });
      });
      return Promise.all(promises);
    })
  );
});

// ── Activate: wipe ALL old caches ─────────────────────────────
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

// ── Fetch handler ─────────────────────────────────────────────
self.addEventListener('fetch', function(event) {
  var url = event.request.url;
  var method = event.request.method;

  // Pass through: non-GET and API calls always go to network
  if (method !== 'GET') return;
  if (url.indexOf('script.google.com') !== -1) return;
  if (url.indexOf('api.anthropic.com') !== -1) return;

  // index.html: network-first so updates deploy immediately, cache as fallback
  var isHtmlPage = url.indexOf('index.html') !== -1 ||
                   url.endsWith('/') ||
                   url.endsWith('/retailflow-pos') ||
                   url.endsWith('/retailflow-pos/');

  if (isHtmlPage) {
    event.respondWith(
      fetch(event.request).then(function(response) {
        // Fresh from network — update the cache
        var clone = response.clone();
        caches.open(CACHE_NAME).then(function(cache) {
          cache.put(event.request, clone);
        });
        return response;
      }).catch(function() {
        // Offline — serve cached version
        return caches.match('./index.html').then(function(cached) {
          return cached || new Response(
            '<h1 style="font-family:sans-serif;padding:20px">Offline</h1><p style="font-family:sans-serif;padding:0 20px">Open the app online at least once to enable offline mode.</p>',
            { headers: { 'Content-Type': 'text/html' } }
          );
        });
      })
    );
    return;
  }

  // All other assets (CDN scripts, fonts, etc): cache-first
  // If not cached yet, fetch and cache for next time
  event.respondWith(
    caches.match(event.request).then(function(cached) {
      if (cached) return cached;
      return fetch(event.request).then(function(response) {
        if (response.ok) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(event.request, clone);
          });
        }
        return response;
      }).catch(function() {
        return new Response('', { status: 503, statusText: 'Offline' });
      });
    })
  );
});
