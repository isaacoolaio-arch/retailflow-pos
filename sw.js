// Oola RetailFlow — Service Worker v11
const CACHE_NAME = "oola-retailflow-v11";

// Core app files — must be cached for offline to work
const CORE_FILES = [
  "./",
  "./index.html",
  "./manifest.json",
];

// CDN scripts used by index.html — cached on install, served offline
const CDN_SCRIPTS = [
  "https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.23.9/babel.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/html5-qrcode/2.3.8/html5-qrcode.min.js",
];
// Note: cdn.tailwindcss.com blocks SW caching (CORS) — it will be cached on first page load instead

// ── INSTALL: cache everything needed to run offline ─────────────
self.addEventListener("install", (event) => {
  console.log("[SW] Installing", CACHE_NAME);
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    // 1. Cache core app files (must succeed)
    await cache.addAll(CORE_FILES);
    console.log("[SW] Core files cached ✓");

    // 2. Cache CDN scripts (failures are non-fatal)
    for (const url of CDN_SCRIPTS) {
      try {
        const res = await fetch(url, { mode: "cors" });
        if (res && res.ok) {
          await cache.put(url, res);
          console.log("[SW] CDN cached:", url.split("/").pop());
        }
      } catch (e) {
        console.warn("[SW] CDN cache skipped (non-fatal):", url.split("/").pop());
      }
    }
  })());
  self.skipWaiting();
});

// ── ACTIVATE: remove old caches ─────────────────────────────────
self.addEventListener("activate", (event) => {
  console.log("[SW] Activating", CACHE_NAME);
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => {
        console.log("[SW] Removed old cache:", k);
        return caches.delete(k);
      }))
    )
  );
  self.clients.claim();
});

// ── FETCH: cache-first, network fallback ────────────────────────
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Pass through: API calls always go to network (never cache)
  if (
    url.hostname.includes("script.google.com") ||
    url.hostname.includes("googleapis.com") ||
    url.hostname.includes("drive.google.com")
  ) return;

  event.respondWith((async () => {
    // 1. Try cache first
    const cached = await caches.match(event.request);
    if (cached) return cached;

    // 2. Not cached — try network
    try {
      const response = await fetch(event.request);
      if (response && response.status === 200) {
        // Cache this response for next time
        const cache = await caches.open(CACHE_NAME);
        cache.put(event.request, response.clone());
      }
      return response;
    } catch (networkError) {
      // 3. Network failed + not in cache
      // For page navigation: return the app shell so it loads offline
      if (event.request.mode === "navigate") {
        const shell = await caches.match("./index.html");
        if (shell) return shell;
      }
      // For other resources: return empty 503
      return new Response("Service unavailable offline", { status: 503 });
    }
  })());
});
