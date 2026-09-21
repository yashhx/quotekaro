// Minimal service worker — enables "Add to Home Screen" install.
// Network-first; this is a prototype, not an offline-first build.
const CACHE = "quotekaro-v2";

self.addEventListener("install", (e) => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(clients.claim());
});

/* Web Push: a machine going down is the one floor event that cannot wait for
   the owner to open the app. Payload is JSON from push-send.js. */
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: "TrackRakho", body: (e.data && e.data.text()) || "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "TrackRakho", {
    body: d.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: d.tag || "trackrakho",
    renotify: true,
    data: { url: d.url || "/" },
  }));
});

/* tapping the notification focuses the open app instead of opening a second copy */
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil((async () => {
    const all = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if (c.url.indexOf(self.location.origin) === 0) { await c.focus(); if (c.navigate) await c.navigate(target).catch(() => {}); return; }
    }
    await clients.openWindow(target);
  })());
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
