/* Bridge between stored inbound WhatsApp messages and the app (Netlify Functions v2).
   GET  -> { enabled, enquiries:[...] }  (unhandled inbound messages, newest first)
   POST { id } -> mark one handled (removes it) once the app logs or dismisses it.
   Returns { enabled:false } gracefully when Blobs isn't available.
   Housekeeping: blobs older than 30 days are swept on GET so storage never
   accumulates unbounded; the newest 100 are returned. */
import { getStore } from "@netlify/blobs";

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const MAX_RETURNED = 100;
const RETENTION_MS = 30 * 86400000; // 30 days

export default async (req) => {
  let store;
  try { store = getStore("enquiries"); }
  catch (e) { console.error("enquiries: getStore failed -", e && e.message); return json({ enabled: false, enquiries: [] }); }

  if (req.method === "GET") {
    try {
      const { blobs } = await store.list();
      const items = (await Promise.all(
        blobs.map((b) => store.get(b.key, { type: "json" }).catch((e) => { console.error("enquiries: get", b.key, "failed -", e && e.message); return null; }))
      )).filter((v) => v && !v.handled);
      items.sort((a, b) => (b.at || 0) - (a.at || 0));

      // retention sweep: quietly drop anything older than 30 days
      const cutoff = Date.now() - RETENTION_MS;
      const stale = items.filter((v) => (v.at || 0) < cutoff);
      if (stale.length) {
        console.log("enquiries: sweeping", stale.length, "stale blob(s)");
        await Promise.all(stale.map((v) => store.delete("msg_" + v.id).catch(() => {})));
      }

      const fresh = items.filter((v) => (v.at || 0) >= cutoff).slice(0, MAX_RETURNED);
      return json({ enabled: true, enquiries: fresh });
    } catch (e) {
      console.error("enquiries: list failed -", e && e.message);
      return json({ enabled: true, enquiries: [] });
    }
  }

  if (req.method === "POST") {
    try {
      const { id } = await req.json();
      if (id) { await store.delete("msg_" + id); console.log("enquiries: marked handled", id); }
    } catch (e) { console.error("enquiries: mark-handled failed -", e && e.message); }
    return json({ ok: true });
  }

  return json({ error: "method not allowed" }, 405);
};
