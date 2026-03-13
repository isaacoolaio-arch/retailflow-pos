var CACHE_NAME = 'oola-retailflow-v6';
var ASSETS = ['./', './index.html', './manifest.json'];

self.addEventListener('install', function(event) {
    event.waitUntil(caches.open(CACHE_NAME).then(function(cache) { return cache.addAll(ASSETS); }));
    self.skipWaiting();
});

self.addEventListener('activate', function(event) {
    event.waitUntil(caches.keys().then(function(keys) {
        return Promise.all(keys.filter(function(k) { return k !== CACHE_NAME; }).map(function(k) { return caches.delete(k); }));
    }));
    self.clients.claim();
});

self.addEventListener('fetch', function(event) {
    if (event.request.url.indexOf('script.google.com') !== -1 || event.request.url.indexOf('api.anthropic.com') !== -1) {
        event.respondWith(fetch(event.request).catch(function() {
            return new Response(JSON.stringify({error:'offline'}), {headers:{'Content-Type':'application/json'}});
        }));
        return;
    }
    if (event.request.method !== 'GET') return;
    event.respondWith(caches.match(event.request).then(function(c) { return c || fetch(event.request); }));
});
