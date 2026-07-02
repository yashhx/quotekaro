// Minimal service worker — enables "Add to Home Screen" install.
// Network-first; this is a prototype, not an offline-first build.
const CACHE = "quotekaro-v1";

self.addEventListener("install", (e) => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(clients.claim());
});

self.addEventListener("fetch", (e) => {
  // Let the network handle everything; fall back to cache if offline.
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
