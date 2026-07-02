/* Bridge between stored inbound WhatsApp messages and the app.
   GET  -> { enabled, enquiries:[...] }  (unhandled inbound messages, newest first)
   POST { id } -> mark one handled (removes it) once the app logs or dismisses it.
   Returns { enabled:false } gracefully when Blobs isn't available. */
import { getStore } from "@netlify/blobs";

const json = (code, obj) => ({ statusCode: code, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });

export const handler = async (event) => {
  let store;
  try { store = getStore("enquiries"); } catch { return json(200, { enabled: false, enquiries: [] }); }

  if (event.httpMethod === "GET") {
    try {
      const { blobs } = await store.list();
      const items = [];
      for (const b of blobs) {
        const v = await store.get(b.key, { type: "json" });
        if (v && !v.handled) items.push(v);
      }
      items.sort((a, b) => (b.at || 0) - (a.at || 0));
      return json(200, { enabled: true, enquiries: items });
    } catch {
      return json(200, { enabled: true, enquiries: [] });
    }
  }

  if (event.httpMethod === "POST") {
    try { const { id } = JSON.parse(event.body || "{}"); if (id) await store.delete("msg_" + id); } catch {}
    return json(200, { ok: true });
  }

  return json(405, { error: "method not allowed" });
};
