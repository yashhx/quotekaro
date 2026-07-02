/* WhatsApp Cloud API webhook (Netlify Functions v2).
   GET  = Meta's one-time verification handshake (uses WHATSAPP_VERIFY_TOKEN).
   POST = incoming message events from Meta -> stored as "enquiries" (Netlify Blobs)
          so the app can pull them into the pipeline.
   Set env vars in Netlify: WHATSAPP_VERIFY_TOKEN (any secret you choose). */
import { getStore } from "@netlify/blobs";

export default async (req) => {
  const url = new URL(req.url);

  // ---- verification handshake ----
  if (req.method === "GET") {
    const p = url.searchParams;
    if (p.get("hub.mode") === "subscribe" && p.get("hub.verify_token") && p.get("hub.verify_token") === process.env.WHATSAPP_VERIFY_TOKEN) {
      return new Response(p.get("hub.challenge") || "", { status: 200 });
    }
    return new Response("forbidden", { status: 403 });
  }

  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  // Always answer 200 quickly so Meta does not retry-storm on our errors.
  try {
    const body = await req.json();
    const store = getStore("enquiries");
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const contacts = value.contacts || [];
        const nameOf = (wa) => { const c = contacts.find((x) => x.wa_id === wa); return c && c.profile ? c.profile.name : ""; };
        for (const msg of value.messages || []) {
          const id = msg.id || (msg.from + "-" + msg.timestamp);
          const base = {
            id,
            from: msg.from,                                   // sender's number, with country code
            name: nameOf(msg.from),
            at: msg.timestamp ? Number(msg.timestamp) * 1000 : Date.now(),
            handled: false,
          };
          let rec = null;
          if (msg.type === "text" && msg.text) {
            rec = { ...base, type: "text", text: msg.text.body || "" };
          } else if (msg.type === "image" && msg.image) {
            // media bytes are fetched on demand via whatsapp-media.js using this id
            rec = { ...base, type: "image", text: msg.image.caption || "", mediaId: msg.image.id, mime: msg.image.mime_type || "image/jpeg" };
          } else if (msg.type === "document" && msg.document) {
            rec = { ...base, type: "document", text: msg.document.caption || "", mediaId: msg.document.id, mime: msg.document.mime_type || "", filename: msg.document.filename || "document" };
          }
          // other types (audio/video/sticker/location) are ignored for now
          if (rec) await store.setJSON("msg_" + id, rec);
        }
      }
    }
  } catch (e) {
    // swallow - we still return 200 below
  }
  return new Response("ok", { status: 200 });
};
