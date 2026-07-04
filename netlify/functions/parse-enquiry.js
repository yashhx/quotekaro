/* AI enquiry-reader agent (Netlify Functions v2).
   POST { text } -> { ok: true, fields: { customer, part, qty, rate, total, followUp } }
   Reads ONE enquiry message with Claude and returns the extracted fields.
   The app calls this only when the owner turns on "Smart reading (AI)" in Setup,
   and falls back to the built-in regex parser on any failure (or 501 when no key).

   Privacy: the app strips phone numbers from the text BEFORE calling this
   function; nothing else from the pipeline is ever sent.

   Env vars (Netlify):
     ANTHROPIC_API_KEY  - required to enable the agent (console.anthropic.com)
     ANTHROPIC_MODEL    - optional; defaults to claude-haiku-4-5 (fast + cheap,
                          ~Rs 0.10-0.25 per enquiry). */
import Anthropic from "@anthropic-ai/sdk";

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

/* structured-output schema: the API guarantees the reply matches this shape */
const FIELDS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["customer", "part", "qty", "rate", "total", "followUp"],
  properties: {
    customer: { type: "string", description: "Sender's name or firm if stated, else empty string" },
    part: { type: "string", description: "Item/part name only - no quantities or prices. Empty string if none." },
    qty: { type: "string", description: "Quantity as plain digits, no commas/units. Empty string if none." },
    rate: { type: "string", description: "Per-piece rate as plain digits (decimals ok). Empty string if none." },
    total: { type: "string", description: "Total amount as plain digits, no commas/currency. Empty string if none." },
    followUp: { type: "string", description: "Delivery/needed-by date as YYYY-MM-DD, resolved from today. Empty string if no date mentioned." },
  },
};

export default async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return json({ ok: false, error: "AI not configured (set ANTHROPIC_API_KEY)" }, 501);

  let body;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const text = String(body.text || "").slice(0, 2000).trim();
  if (!text) return json({ error: "missing text" }, 400);

  /* today in IST so "tomorrow" / "15/8" resolve the way the sender meant */
  const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

  /* single attempt, 8s cap: a retry chain would blow past Netlify's 10s function
     timeout and leave the app hanging instead of falling back to the regex parser */
  const client = new Anthropic({ apiKey: key, timeout: 8000, maxRetries: 0 });
  try {
    const msg = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5",
      max_tokens: 1024,
      system:
        "You extract order-enquiry fields from WhatsApp messages sent to Indian traders and machine shops. " +
        "Messages are often Hinglish (e.g. 'gland nut 60mm chahiye, 200 piece, rate batao'). " +
        "Today is " + today + " (IST). Rules: " +
        "1) Extract only what the message supports; use an empty string when a field is not present. " +
        "2) qty, rate and total are plain digit strings - no commas, units or currency symbols. " +
        "3) If a per-piece rate and a quantity are given but no total, compute total = rate * qty. " +
        "4) followUp is a delivery or needed-by date as YYYY-MM-DD, resolved relative to today " +
        "(e.g. 'kal'/'tomorrow' = today + 1 day; '15/8' is 15 August, DD/MM order; a year-less date already past rolls to next year). " +
        "5) part is the item name only, max 60 characters. " +
        "6) Phone numbers have been removed from the text; never invent one.",
      messages: [{ role: "user", content: text }],
      output_config: { format: { type: "json_schema", schema: FIELDS_SCHEMA } },
    });

    if (msg.stop_reason === "refusal" || msg.stop_reason === "max_tokens") {
      console.warn("parse-enquiry: unusable stop_reason", msg.stop_reason);
      return json({ ok: false, error: "ai gave no result" }, 502);
    }
    const block = msg.content.find((b) => b.type === "text");
    if (!block || !block.text) {
      console.warn("parse-enquiry: response had no text block");
      return json({ ok: false, error: "ai gave no result" }, 502);
    }
    const fields = JSON.parse(block.text);
    /* belt-and-braces normalisation: digits only where digits are expected */
    for (const k of ["qty", "rate", "total"]) fields[k] = String(fields[k] || "").replace(/[^\d.]/g, "");
    fields.customer = String(fields.customer || "").slice(0, 40);
    fields.part = String(fields.part || "").slice(0, 60);
    fields.followUp = /^\d{4}-\d{2}-\d{2}$/.test(String(fields.followUp || "")) ? fields.followUp : "";
    console.log("parse-enquiry: ok -", (msg.usage && (msg.usage.input_tokens + "in/" + msg.usage.output_tokens + "out")) || "no usage");
    return json({ ok: true, fields });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) {
      console.error("parse-enquiry: bad ANTHROPIC_API_KEY");
      return json({ ok: false, error: "AI key invalid" }, 501);
    }
    if (e instanceof Anthropic.RateLimitError) {
      console.warn("parse-enquiry: rate limited");
      return json({ ok: false, error: "AI busy" }, 429);
    }
    if (e instanceof Anthropic.APIError) {
      console.error("parse-enquiry: API error", e.status, e.message);
      return json({ ok: false, error: "ai error" }, 502);
    }
    console.error("parse-enquiry: failed -", e && e.message);
    return json({ ok: false, error: "ai parse failed" }, 502);
  }
};
