// Minimal service worker — enables "Add to Home Screen" install.
// Network-first; this is a prototype, not an offline-first build.
const CACHE = "quotekaro-v2";

self.addEventListener("install", (e) => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(clients.claim());
});

self.addEventListener("fetch", (e) => {
  // Only handle same-origin GETs (the app shell). Everything else —
  // Supabase auth POSTs, Google APIs, function calls — must go straight
  // to the network: Safari fails re-dispatched POST bodies inside a SW
  // ("FetchEvent.respondWith" errors), which broke OAuth sign-in.
  if (e.request.method !== "GET") return;
  let url;
  try { url = new URL(e.request.url); } catch { return; }
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request).catch(async () => (await caches.match(e.request)) || Response.error())
  );
});
