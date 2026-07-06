var CACHE_NAME = 'oola-retailflow-v28';

// All assets needed for offline operation (including CDN scripts)
var ASSETS = [
    './',
    './index.html',
    './manifest.json',
    'https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.23.9/babel.min.js',
    'https://cdn.tailwindcss.com',
    'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap'
];

self.addEventListener('install', function(event) {
    event.waitUntil(
        caches.open(CACHE_NAME).then(function(cache) {
            // Cache each asset individually so one failure doesn't break all
            return Promise.allSettled(ASSETS.map(function(url) {
                return cache.add(url).catch(function(err) {
                    console.warn('Failed to cache:', url, err);
                });
            }));
        })
    );
    self.skipWaiting();
});

self.addEventListener('activate', function(event) {
    event.waitUntil(
        caches.keys().then(function(keys) {
            return Promise.all(keys.filter(function(k) { return k !== CACHE_NAME; }).map(function(k) { return caches.delete(k); }));
        })
    );
    self.clients.claim();
});

self.addEventListener('fetch', function(event) {
    var url = event.request.url;

    // API calls (Google Apps Script / Anthropic) — network only, return error JSON if offline
    if (url.indexOf('script.google.com') !== -1 || url.indexOf('api.anthropic.com') !== -1) {
        event.respondWith(
            fetch(event.request).catch(function() {
                return new Response(JSON.stringify({error:'offline'}), {headers:{'Content-Type':'application/json'}});
            })
        );
        return;
    }

    // Only handle GET for caching
    if (event.request.method !== 'GET') return;

    // Cache-first strategy: serve from cache, fall back to network, cache new responses
    event.respondWith(
        caches.match(event.request).then(function(cached) {
            if (cached) return cached;
            return fetch(event.request).then(function(response) {
                // Cache successful responses (CDN scripts, fonts) for future offline use
                if (response && response.status === 200) {
                    var clone = response.clone();
                    caches.open(CACHE_NAME).then(function(cache) {
                        cache.put(event.request, clone).catch(function(){});
                    });
                }
                return response;
            }).catch(function() {
                // Network failed and not in cache — for navigation, return index.html
                if (event.request.mode === 'navigate') {
                    return caches.match('./index.html');
                }
                return new Response('Offline', { status: 503 });
            });
        })
    );
});
