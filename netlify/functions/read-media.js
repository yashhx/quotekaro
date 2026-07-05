/* AI photo/document reader (Netlify Functions v2).
   POST { mediaId, caption? } -> { ok, fields: { customer, part, qty, rate, total, followUp, transcript } }
   Fetches ONE inbound WhatsApp image or PDF by media id (so the endpoint cannot
   be abused with arbitrary uploads), shows it to Claude vision, and returns the
   extracted quote fields plus a line-by-line transcript of what it could read -
   including messy handwriting (Hindi/English/Hinglish parts lists).

   Called by the app only when "Smart reading (AI)" is ON; any failure makes the
   app fall back to caption/regex parsing, so nothing breaks.

   Env vars (Netlify):
     WHATSAPP_TOKEN         - required (fetches the media bytes from Meta)
     ANTHROPIC_API_KEY      - required to enable the reader
     ANTHROPIC_VISION_MODEL - optional; defaults to claude-opus-4-8 (best
                              handwriting reading, ~Rs 2-4 per photo). Set to
                              claude-haiku-4-5 for cheaper/faster but weaker. */
import Anthropic from "@anthropic-ai/sdk";

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_BYTES = 8 * 1024 * 1024; // keep request + latency sane

const FIELDS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["customer", "part", "qty", "rate", "total", "followUp", "transcript"],
  properties: {
    customer: { type: "string", description: "Name/firm if visible (letterhead, signature, 'from ...'), else empty string" },
    part: { type: "string", description: "Main item name; if several items, a short summary like '5 items: hex bolts, flanges'. Empty if unreadable." },
    qty: { type: "string", description: "Total quantity as plain digits ONLY if one clear quantity applies to the enquiry; else empty string" },
    rate: { type: "string", description: "Per-piece rate as plain digits, only if clearly stated; else empty string" },
    total: { type: "string", description: "Total amount as plain digits, only if clearly stated; else empty string" },
    followUp: { type: "string", description: "Any delivery/needed-by date as YYYY-MM-DD resolved from today; empty string if none" },
    transcript: { type: "string", description: "Everything readable, line by line; one item per line with its size/qty. Use [?] for unreadable words. Max ~500 chars." },
  },
};

export default async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const waToken = process.env.WHATSAPP_TOKEN;
  const aiKey = process.env.ANTHROPIC_API_KEY;
  if (!waToken || !aiKey) return json({ ok: false, error: "not configured" }, 501);

  let body;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const mediaId = String(body.mediaId || "").trim();
  if (!mediaId) return json({ error: "missing mediaId" }, 400);
  const caption = String(body.caption || "").slice(0, 500);

  /* 1) fetch the media bytes from Meta (same two-step dance as whatsapp-media.js) */
  let mime, b64;
  try {
    /* v20.0 to match the other WhatsApp functions; hard timeouts so a slow Meta
       CDN can't eat the whole 10s function budget */
    const metaRes = await fetch("https://graph.facebook.com/v20.0/" + encodeURIComponent(mediaId), {
      headers: { Authorization: "Bearer " + waToken }, signal: AbortSignal.timeout(3000),
    });
    const meta = await metaRes.json().catch(() => ({}));
    if (!meta || !meta.url) {
      const expired = meta && meta.error && meta.error.code === 190;
      console.error("read-media: media lookup failed", metaRes.status, JSON.stringify(meta && meta.error ? meta.error : meta).slice(0, 200));
      return json({ ok: false, error: expired ? "whatsapp token expired" : "media not found" }, expired ? 401 : 404);
    }
    if (meta.file_size && meta.file_size > MAX_BYTES) return json({ ok: false, error: "file too large" }, 413);
    mime = meta.mime_type || "";
    const bin = await fetch(meta.url, { headers: { Authorization: "Bearer " + waToken }, signal: AbortSignal.timeout(4000) });
    if (!bin.ok) { console.error("read-media: download failed", bin.status); return json({ ok: false, error: "download failed" }, 502); }
    /* size gate BEFORE buffering: meta.file_size can be absent */
    const clen = Number(bin.headers.get("content-length") || 0);
    if (clen > MAX_BYTES) return json({ ok: false, error: "file too large" }, 413);
    const buf = Buffer.from(await bin.arrayBuffer());
    if (buf.length > MAX_BYTES) return json({ ok: false, error: "file too large" }, 413);
    b64 = buf.toString("base64");
  } catch (e) {
    console.error("read-media: media fetch error -", e && e.message);
    return json({ ok: false, error: "media fetch failed" }, 502);
  }

  const isPdf = mime === "application/pdf";
  if (!isPdf && !IMAGE_TYPES.includes(mime)) return json({ ok: false, error: "unsupported type " + mime }, 415);

  /* 2) show it to Claude vision with a handwriting-aware prompt */
  const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  /* best-first model ladder: some plans don't include Opus-tier - when the API
     says "not available on your plan" we step down instead of failing */
  const LADDER = [process.env.ANTHROPIC_VISION_MODEL, "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"].filter(Boolean)
    .filter((m, i, a) => a.indexOf(m) === i);
  /* budget: media fetch already spent ~1-2s; Netlify kills the function at 10s */
  const client = new Anthropic({ apiKey: aiKey, timeout: 7000, maxRetries: 0 });

  const mediaBlock = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }
    : { type: "image", source: { type: "base64", media_type: mime, data: b64 } };

  try {
    let msg, usedModel;
    for (const model of LADDER) {
      try {
        usedModel = model;
        msg = await client.messages.create({
          model,
          max_tokens: 2000, /* headroom for a long transcript inside the JSON */
      system:
        "You read photos and documents sent on WhatsApp to Indian traders and machine shops: " +
        "handwritten parts lists (Hindi, English or Hinglish, often rushed handwriting on notebook paper or chits), " +
        "engineering drawings, photos of machine parts, printed POs and price lists. Today is " + today + " (IST). " +
        "Rules: 1) Transcribe carefully line by line into 'transcript' (write Hindi script in Latin letters); use [?] for anything unreadable - never guess. " +
        "2) Read numbers digit by digit; Indian conventions apply (lakh = 100000, '1,20,000' = 120000, 'k'/'hazar' = thousand). " +
        "3) A wrong price is worse than an empty field: fill qty/rate/total only when clearly readable. " +
        "4) qty/rate/total are plain digit strings - no commas, units or currency symbols. " +
        "5) followUp only if a delivery/needed-by date is visible, as YYYY-MM-DD resolved from today. " +
        "6) For a drawing with no list, put the part name/dimensions in 'part' and describe key dimensions in 'transcript'.",
      messages: [{
        role: "user",
        content: [
          mediaBlock,
          { type: "text", text: caption ? "Sender's caption: " + caption : "No caption - read the attachment." },
        ],
      }],
          output_config: { format: { type: "json_schema", schema: FIELDS_SCHEMA } },
        });
        break; /* success - stop stepping down */
      } catch (e) {
        const planBlocked = e instanceof Anthropic.APIError &&
          (e.status === 403 || e.status === 404) && /not_available_on_plan|not_found/i.test(String(e.message));
        if (planBlocked && model !== LADDER[LADDER.length - 1]) {
          console.warn("read-media:", model, "not available on this plan - trying next");
          continue;
        }
        throw e;
      }
    }
    console.log("read-media: used model", usedModel);

    if (msg.stop_reason === "refusal" || msg.stop_reason === "max_tokens") {
      console.warn("read-media: unusable stop_reason", msg.stop_reason);
      return json({ ok: false, error: "ai gave no result" }, 502);
    }
    const block = msg.content.find((b) => b.type === "text");
    if (!block || !block.text) {
      console.warn("read-media: response had no text block");
      return json({ ok: false, error: "ai gave no result" }, 502);
    }
    const fields = JSON.parse(block.text);
    for (const k of ["qty", "rate", "total"]) fields[k] = String(fields[k] || "").replace(/[^\d.]/g, "");
    fields.customer = String(fields.customer || "").slice(0, 40);
    fields.part = String(fields.part || "").slice(0, 60);
    fields.transcript = String(fields.transcript || "").slice(0, 600);
    fields.followUp = /^\d{4}-\d{2}-\d{2}$/.test(String(fields.followUp || "")) ? fields.followUp : "";
    console.log("read-media: ok -", mime, "-", (msg.usage && (msg.usage.input_tokens + "in/" + msg.usage.output_tokens + "out")) || "no usage");
    return json({ ok: true, fields });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) { console.error("read-media: bad ANTHROPIC_API_KEY"); return json({ ok: false, error: "AI key invalid" }, 501); }
    if (e instanceof Anthropic.RateLimitError) { console.warn("read-media: rate limited"); return json({ ok: false, error: "AI busy" }, 429); }
    if (e instanceof Anthropic.APIError) { console.error("read-media: API error", e.status, e.message); return json({ ok: false, error: "ai error", detail: e.status + " " + String(e.message).slice(0, 300) }, 502); }
    console.error("read-media: failed -", e && e.message);
    return json({ ok: false, error: "ai read failed" }, 502);
  }
};
