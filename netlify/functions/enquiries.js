/* Bridge between stored inbound WhatsApp messages and the app (Netlify Functions v2).
   GET  -> { enabled, enquiries:[...] }  (unhandled inbound messages, newest first)
   POST { id } -> mark one handled (removes it) once the app logs or dismisses it.
   Returns { enabled:false } gracefully when Blobs isn't available. */
import { getStore } from "@netlify/blobs";

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

export default async (req) => {
  let store;
  try { store = getStore("enquiries"); } catch (e) { return json({ enabled: false, enquiries: [], error: "getStore: " + String(e && e.message) }); }

  if (req.method === "GET") {
    try {
      const { blobs } = await store.list();
      const items = [];
      for (const b of blobs) {
        const v = await store.get(b.key, { type: "json" });
        if (v && !v.handled) items.push(v);
      }
      items.sort((a, b) => (b.at || 0) - (a.at || 0));
      return json({ enabled: true, enquiries: items });
    } catch (e) {
      return json({ enabled: true, enquiries: [], error: "list: " + String(e && e.message) });
    }
  }

  if (req.method === "POST") {
    try { const { id } = await req.json(); if (id) await store.delete("msg_" + id); } catch {}
    return json({ ok: true });
  }

  return json({ error: "method not allowed" }, 405);
};
