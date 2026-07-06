/* WhatsApp Cloud API webhook (Netlify Functions v2).
   GET  = Meta's one-time verification handshake (uses WHATSAPP_VERIFY_TOKEN).
   POST = incoming message events from Meta -> stored as "enquiries" (Netlify Blobs)
          so the app can pull them into the pipeline.
   Env vars (Netlify):
     WHATSAPP_VERIFY_TOKEN  - required; any secret you choose, same one entered in Meta.
     META_APP_SECRET        - optional; when set, every POST is authenticated against
                              Meta's X-Hub-Signature-256 header (rejects forged calls).
   Every code path logs to the Netlify Function log so failures are diagnosable. */
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const verifySignature = (raw, header, secret) => {
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", secret).update(raw, "utf8").digest("hex");
  const got = header.slice(7);
  if (got.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(expected, "hex"));
};

/* map one Cloud API message to the enquiry record the app renders.
   Returns null for types we deliberately skip (reactions, ephemeral). */
const toRecord = (msg, base) => {
  switch (msg.type) {
    case "text":
      return msg.text ? { ...base, type: "text", text: msg.text.body || "" } : null;
    case "image":
      // media bytes are fetched on demand via whatsapp-media.js using this id
      return msg.image ? { ...base, type: "image", text: msg.image.caption || "", mediaId: msg.image.id, mime: msg.image.mime_type || "image/jpeg" } : null;
    case "document":
      return msg.document ? { ...base, type: "document", text: msg.document.caption || "", mediaId: msg.document.id, mime: msg.document.mime_type || "", filename: msg.document.filename || "document" } : null;
    case "button": // quick-reply tap on a template message
      return msg.button ? { ...base, type: "text", text: msg.button.text || "(button reply)" } : null;
    case "interactive": { // reply to an interactive button/list message
      const i = msg.interactive || {};
      const title = (i.button_reply && i.button_reply.title) || (i.list_reply && i.list_reply.title) || "(interactive reply)";
      return { ...base, type: "text", text: title };
    }
    case "reaction": // an emoji reaction is not an enquiry - log only
      return null;
    default:
      // audio / video / sticker / location / contacts etc: show a placeholder card
      // so the enquiry never silently vanishes during a demo.
      return { ...base, type: "text", text: "[" + msg.type + " message - open WhatsApp to view it]" };
  }
};

export default async (req) => {
  const url = new URL(req.url);

  // ---- verification handshake ----
  if (req.method === "GET") {
    const p = url.searchParams;
    if (p.get("hub.mode") === "subscribe" && p.get("hub.verify_token") && p.get("hub.verify_token") === process.env.WHATSAPP_VERIFY_TOKEN) {
      console.log("webhook: Meta verification handshake OK");
      return new Response(p.get("hub.challenge") || "", { status: 200 });
    }
    console.warn("webhook: verification failed (verify_token mismatch or missing)");
    return new Response("forbidden", { status: 403 });
  }

  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const raw = await req.text();

  // ---- authenticate the caller when an app secret is configured ----
  const secret = process.env.META_APP_SECRET;
  if (secret) {
    if (!verifySignature(raw, req.headers.get("x-hub-signature-256"), secret)) {
      console.warn("webhook: rejected POST with bad/missing X-Hub-Signature-256");
      return new Response("bad signature", { status: 403 });
    }
  }

  // Always answer 200 quickly so Meta does not retry-storm on our errors.
  let stored = 0, statuses = 0, skipped = 0;
  try {
    const body = JSON.parse(raw);
    const store = getStore("enquiries");
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const contacts = value.contacts || [];
        const nameOf = (wa) => { const c = contacts.find((x) => x.wa_id === wa); return c && c.profile ? c.profile.name : ""; };

        // delivery/read/failed receipts for messages WE sent - log so failures are visible
        for (const st of value.statuses || []) {
          statuses++;
          if (st.status === "failed") console.error("webhook: outbound message FAILED", JSON.stringify(st.errors || st));
          else console.log("webhook: outbound status", st.status, "for", st.recipient_id);
        }

        for (const msg of value.messages || []) {
          const id = msg.id || (msg.from + "-" + msg.timestamp);
          const base = {
            id,
            from: msg.from, // sender's number, with country code
            name: nameOf(msg.from),
            at: msg.timestamp ? Number(msg.timestamp) * 1000 : Date.now(),
            handled: false,
            /* which business number this was sent TO - the multi-tenant routing key */
            phoneId: (value.metadata && value.metadata.phone_number_id) || "",
          };
          const rec = toRecord(msg, base);
          if (!rec) { skipped++; console.log("webhook: skipped", msg.type, "from", msg.from); continue; }
          try {
            await store.setJSON("msg_" + id, rec);
            stored++;
            console.log("webhook: stored", rec.type, "enquiry", id, "from", msg.from);
          } catch (e) {
            console.error("webhook: FAILED to store enquiry", id, "-", e && e.message);
          }
        }
      }
    }
    if (stored + statuses + skipped === 0) console.log("webhook: POST received but contained no messages/statuses", raw.slice(0, 300));
  } catch (e) {
    console.error("webhook: error processing payload -", e && e.message, "| body:", raw.slice(0, 300));
  }
  return new Response("ok", { status: 200 });
};
