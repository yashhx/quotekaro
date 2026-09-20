/* Kanta parchi reader (Netlify Functions v2).
   POST { image: "<base64>", mime } -> { ok, fields: { gross, tare, net, unit,
   slipNo, vehicle, party, material, date, transcript } }

   Unlike read-media.js (which only accepts a WhatsApp media id) this one takes
   the photo the owner just captured in the app, so it is strictly login-gated
   and size-capped: the app already downscales a slip to ~1100px grayscale, so
   anything much bigger is not a parchi.

   A weighbridge slip is printed, not handwritten - gross / tare / net in
   KILOGRAMS, a slip serial, the vehicle number and a timestamp. The one thing
   it can NEVER say is whether the maal was coming in or going out; the app
   asks the owner that, and this function must not guess it.

   Env vars (Netlify):
     ANTHROPIC_API_KEY      - required to enable the reader
     ANTHROPIC_VISION_MODEL - optional; the ladder below is tried in order */
import Anthropic from "@anthropic-ai/sdk";

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_BYTES = 3 * 1024 * 1024; /* a downscaled slip is ~25-150 KB */
let preferredModel = null; /* warm-instance memo, same trick as read-media */

const FIELDS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["gross", "tare", "net", "unit", "slipNo", "vehicle", "party", "material", "date", "transcript"],
  properties: {
    gross: { type: "string", description: "Gross / loaded weight as plain digits, no separators. Empty string if not printed or not certain." },
    tare: { type: "string", description: "Tare / empty-vehicle weight as plain digits. Empty string if not printed or not certain." },
    net: { type: "string", description: "Net / material weight as plain digits. Empty string if not printed or not certain." },
    unit: { type: "string", description: "The unit those three numbers are printed in: 'kg', 'mt' or 'qtl'. Use 'kg' when the slip shows no unit." },
    slipNo: { type: "string", description: "Slip / serial / ticket number exactly as printed. Empty string if absent." },
    vehicle: { type: "string", description: "Vehicle registration number, spaces normalised (e.g. HR 38 AB 1234). Empty string if absent." },
    party: { type: "string", description: "Party / customer / supplier name printed on the slip. Empty string if absent." },
    material: { type: "string", description: "Material as printed (e.g. MS scrap, CI, aluminium). Empty string if absent." },
    date: { type: "string", description: "Date printed on the slip as YYYY-MM-DD. Indian slips are DD/MM/YYYY. Empty string if absent or ambiguous." },
    transcript: { type: "string", description: "Every readable line of the slip, one per line, [?] for anything unclear. Max ~400 chars." },
  },
};

/* when Supabase is configured, only logged-in users may call this
   (protects the AI spend); otherwise open like the prototype */
async function requireUser(req) {
  const url = process.env.SUPABASE_URL, anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) return { open: true };
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  try {
    const r = await fetch(url + "/auth/v1/user", { headers: { apikey: anon, authorization: "Bearer " + token } });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? u : null;
  } catch { return null; }
}

/* digits only - a weight with a comma, a stray "KG" or an OCR space is still a
   weight, but anything that is not a number at all is dropped rather than guessed */
const digits = (v) => {
  const s = String(v == null ? "" : v).replace(/[^\d.]/g, "");
  if (!s || !/\d/.test(s)) return "";
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? String(Math.round(n * 100) / 100) : "";
};

export default async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const caller = await requireUser(req);
  if (!caller) { console.warn("read-parchi: rejected call without valid login"); return json({ ok: false, error: "login required" }, 401); }

  const aiKey = process.env.ANTHROPIC_API_KEY;
  if (!aiKey) return json({ ok: false, error: "not configured" }, 501);

  let body;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const mime = String(body.mime || "image/jpeg").toLowerCase();
  const b64 = String(body.image || "").replace(/^data:[^,]+,/, "");
  if (!b64) return json({ error: "missing image" }, 400);
  if (!IMAGE_TYPES.includes(mime)) return json({ ok: false, error: "unsupported type " + mime }, 415);
  if (b64.length * 0.75 > MAX_BYTES) return json({ ok: false, error: "image too large" }, 413);

  const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  const LADDER = [process.env.ANTHROPIC_VISION_MODEL, "claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5"]
    .filter(Boolean).filter((m, i, a) => a.indexOf(m) === i);
  const client = new Anthropic({ apiKey: aiKey, timeout: 8000, maxRetries: 0 });

  try {
    let msg, usedModel;
    const ladder = preferredModel ? [preferredModel, ...LADDER.filter((m) => m !== preferredModel)] : LADDER;
    for (const model of ladder) {
      try {
        usedModel = model;
        msg = await client.messages.create({
          model,
          max_tokens: 1200,
          system:
            "You read photographs of Indian weighbridge slips (dharam kanta parchi) for a scrap yard. Today is " + today + " (IST). " +
            "The slip is usually dot-matrix or thermal print on a small paper, often photographed at an angle, creased or faded. " +
            "Rules: 1) Read every digit individually and never guess - a wrong weight costs the owner real money, so an empty field is the correct answer when you are not certain. " +
            "2) Gross is the loaded vehicle, tare is the same vehicle empty, net is the material. If only two of the three are printed, return those two and leave the third empty - do NOT calculate it yourself. " +
            "3) Return the weights exactly as printed, as plain digits with no separators or units, and say in 'unit' whether the slip prints kg, MT or quintal. Indian slips are almost always kg. " +
            "4) Indian dates are DD/MM/YYYY - convert to YYYY-MM-DD, and leave it empty if the order is ambiguous. " +
            "5) Never infer whether the material was coming in or going out; the slip does not say it and the owner is asked separately. " +
            "6) Put every readable line into 'transcript' with [?] for anything unclear.",
          messages: [{
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mime, data: b64 } },
              { type: "text", text: "Read this kanta parchi." },
            ],
          }],
          output_config: { format: { type: "json_schema", schema: FIELDS_SCHEMA } },
        });
        preferredModel = model;
        break;
      } catch (e) {
        const planBlocked = e instanceof Anthropic.APIError &&
          (e.status === 403 || e.status === 404) && /not_available_on_plan|not_found/i.test(String(e.message));
        if (planBlocked && model !== ladder[ladder.length - 1]) {
          console.warn("read-parchi:", model, "not available on this plan - trying next");
          continue;
        }
        throw e;
      }
    }

    if (!msg || msg.stop_reason === "refusal" || msg.stop_reason === "max_tokens") {
      console.warn("read-parchi: unusable stop_reason", msg && msg.stop_reason);
      return json({ ok: false, error: "ai gave no result" }, 502);
    }
    const block = msg.content.find((b) => b.type === "text");
    if (!block || !block.text) return json({ ok: false, error: "ai gave no result" }, 502);

    const raw = JSON.parse(block.text);
    const fields = {
      gross: digits(raw.gross), tare: digits(raw.tare), net: digits(raw.net),
      unit: /^(kg|mt|qtl)$/i.test(String(raw.unit || "")) ? String(raw.unit).toLowerCase() : "kg",
      slipNo: String(raw.slipNo || "").trim().slice(0, 24),
      vehicle: String(raw.vehicle || "").trim().toUpperCase().slice(0, 20),
      party: String(raw.party || "").trim().slice(0, 40),
      material: String(raw.material || "").trim().slice(0, 40),
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.date || "")) ? raw.date : "",
      transcript: String(raw.transcript || "").slice(0, 500),
    };
    /* a slip whose own three numbers disagree was misread - hand back the
       readings but say so, and let the app ask the owner to check */
    const g = Number(fields.gross), t = Number(fields.tare), n = Number(fields.net);
    fields.mismatch = !!(g && t && n && Math.abs(g - t - n) > Math.max(2, n * 0.01));
    console.log("read-parchi: ok -", usedModel, "-", (msg.usage && (msg.usage.input_tokens + "in/" + msg.usage.output_tokens + "out")) || "no usage",
      fields.mismatch ? "- gross/tare/net disagree" : "");
    return json({ ok: true, fields });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) { console.error("read-parchi: bad ANTHROPIC_API_KEY"); return json({ ok: false, error: "AI key invalid" }, 501); }
    if (e instanceof Anthropic.RateLimitError) { console.warn("read-parchi: rate limited"); return json({ ok: false, error: "AI busy" }, 429); }
    if (e instanceof Anthropic.APIError) { console.error("read-parchi: API error", e.status, e.message); return json({ ok: false, error: "ai error", detail: e.status + " " + String(e.message).slice(0, 300) }, 502); }
    console.error("read-parchi: failed -", e && e.message);
    return json({ ok: false, error: "ai read failed" }, 502);
  }
};
