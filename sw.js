const CACHE_NAME = 'retailflow-v1';
const ASSETS = [
    './',
    './index.html',
    './RetailPOS.jsx',
    './manifest.json',
    'https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.23.9/babel.min.js',
    'https://cdn.tailwindcss.com',
    'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap'
];

// Install — cache all core assets
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            return cache.addAll(ASSETS).catch(err => {
                console.warn('Some assets failed to cache:', err);
                // Cache what we can
                return Promise.allSettled(ASSETS.map(url => cache.add(url)));
            });
        })
    );
    self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

// Fetch — network first for API, cache first for assets
self.addEventListener('fetch', event => {
    const url = event.request.url;

    // API calls (Google Apps Script & Anthropic) — network first
    if (url.includes('script.google.com') || url.includes('api.anthropic.com')) {
        event.respondWith(
            fetch(event.request)
                .catch(() => {
                    // API failed — return offline indicator
                    return new Response(
                        JSON.stringify({ error: 'offline', message: 'No internet connection' }),
                        { headers: { 'Content-Type': 'application/json' } }
                    );
                })
        );
        return;
    }

    // Everything else — cache first, fallback to network
    event.respondWith(
        caches.match(event.request).then(cached => {
            if (cached) return cached;
            return fetch(event.request).then(response => {
                // Cache successful responses for future offline use
                if (response.ok) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                }
                return response;
            }).catch(() => {
                // Both cache and network failed
                if (event.request.destination === 'document') {
                    return caches.match('./index.html');
                }
                return new Response('Offline', { status: 503 });
            });
        })
    );
});
