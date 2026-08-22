/* Supabase "Send SMS Hook" -> deliver the login code over WhatsApp.

   WHY WHATSAPP AND NOT SMS: real SMS OTP in India needs TRAI DLT registration
   (entity + sender ID + every template registered with the operators, fees and
   weeks of waiting). We already run a Meta WhatsApp Cloud API number, every shop
   owner we sell to has WhatsApp, and an authentication-category message costs
   about Rs 0.14. So Supabase keeps the security-critical half - it generates the
   code, sets the expiry, verifies it, rate-limits, and mints the session - and
   this function only carries the code to the phone.

   Supabase calls this on every signInWithOtp({phone}) and updateUser({phone}).
   Payload: { user: { id, phone, ... }, sms: { otp: "561166" } }

   Env (Netlify):
     SUPABASE_AUTH_HOOK_SECRET  the "v1,whsec_..." secret from the hook settings
     WHATSAPP_TOKEN             same token the rest of the app uses
     WHATSAPP_PHONE_ID          same sender number
     WHATSAPP_OTP_TEMPLATE      approved authentication template name (default "login_code")
     WHATSAPP_OTP_LANG          template language code (default "en")

   Returning a non-200 makes Supabase surface the failure to the caller, which is
   what we want - a user must never sit waiting for a code that was never sent. */
import crypto from "node:crypto";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

/* Standard Webhooks signature check.
   Signed value is `${id}.${timestamp}.${rawBody}`, HMAC-SHA256 with the
   base64-decoded secret. The header can carry several space-separated
   "v1,<sig>" values (secret rotation), so any match is a pass. */
function verify(secretRaw, headers, rawBody) {
  const id = headers.get("webhook-id");
  const ts = headers.get("webhook-timestamp");
  const sigHeader = headers.get("webhook-signature");
  if (!id || !ts || !sigHeader) return "missing webhook headers";

  /* replay window - a captured request must not be usable tomorrow */
  const ageSec = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(ageSec) || ageSec > 300) return "stale timestamp";

  const secret = Buffer.from(String(secretRaw).replace(/^v1,\s*/, "").replace(/^whsec_/, ""), "base64");
  if (!secret.length) return "bad secret";
  const expected = crypto.createHmac("sha256", secret).update(id + "." + ts + "." + rawBody).digest("base64");

  const ok = String(sigHeader).split(" ").some((part) => {
    const sig = part.indexOf(",") >= 0 ? part.slice(part.indexOf(",") + 1) : part;
    const a = Buffer.from(sig), b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
  return ok ? null : "signature mismatch";
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const secret = process.env.SUPABASE_AUTH_HOOK_SECRET;
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  if (!secret) { console.error("otp: SUPABASE_AUTH_HOOK_SECRET not set"); return json({ error: { message: "hook not configured" } }, 501); }
  if (!token || !phoneId) { console.error("otp: WhatsApp env missing"); return json({ error: { message: "WhatsApp not configured" } }, 501); }

  /* the signature is over the RAW body - read it as text, parse after */
  const raw = await req.text();
  const bad = verify(secret, req.headers, raw);
  if (bad) { console.warn("otp: rejected -", bad); return json({ error: { message: "invalid signature" } }, 401); }

  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: { message: "bad json" } }, 400); }

  const to = String((body.user && body.user.phone) || "").replace(/\D/g, "");
  const code = String((body.sms && body.sms.otp) || "");
  if (!to || !code) { console.error("otp: payload missing phone or otp"); return json({ error: { message: "missing phone or otp" } }, 400); }

  /* Meta authentication-category template. Body carries the code, and the
     one-tap/copy button carries it again - Meta fixes the wording for this
     category, which is why these templates get approved quickly. */
  const template = {
    name: process.env.WHATSAPP_OTP_TEMPLATE || "login_code",
    language: { code: process.env.WHATSAPP_OTP_LANG || "en" },
    components: [
      { type: "body", parameters: [{ type: "text", text: code }] },
      { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: code }] },
    ],
  };

  try {
    const r = await fetch("https://graph.facebook.com/v20.0/" + phoneId + "/messages", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "template", template }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      /* log the whole Meta error - template name/language/param-shape mistakes
         all land here and the message names the exact problem */
      console.error("otp: Meta rejected send", r.status, JSON.stringify(data && data.error ? data.error : data).slice(0, 600));
      return json({ error: { message: "could not send the code on WhatsApp" } }, 502);
    }
    /* never log the code itself */
    console.log("otp: sent to ..." + to.slice(-4), "msg", (data.messages && data.messages[0] && data.messages[0].id) || "?");
    return json({});
  } catch (e) {
    console.error("otp: send failed -", e && e.message);
    return json({ error: { message: "could not send the code on WhatsApp" } }, 502);
  }
};
