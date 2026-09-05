/* Supabase "Send SMS Hook" -> deliver the login code to the customer's phone.

   Supabase keeps the security half - it generates the 6-digit code, sets the
   expiry, verifies it, rate-limits, and mints the session. This function only
   carries the code to the phone. That split does not change no matter which
   carrier we use.

   TWO CHANNELS, because India made us have two:
     sms       - MSG91 (or any Indian provider). Bills in INR through normal
                 UPI/netbanking, needs TRAI DLT registration.
     whatsapp  - Meta Cloud API. Cheaper and nicer, BUT Meta bills by card and
                 its Indian card support is poor (RBI e-mandate); we hit
                 error 131042 "Business eligibility payment issue" in
                 production because no Indian card would attach.

   Pick with OTP_CHANNEL = "sms" | "whatsapp" | "auto".
   "auto" tries WhatsApp first and falls back to SMS, so the day Meta billing
   starts working you flip one variable instead of editing code.
   With OTP_CHANNEL unset we use whichever provider is configured, preferring
   SMS when both are.

   Env (Netlify):
     SUPABASE_AUTH_HOOK_SECRET  the "v1,whsec_..." from the hook settings
     OTP_CHANNEL                sms | whatsapp | auto        (optional)
     -- SMS (MSG91) --
     MSG91_AUTHKEY              from MSG91 dashboard
     MSG91_TEMPLATE_ID          the MSG91 flow/template id carrying the code
     MSG91_OTP_VAR              variable name in that template (default "OTP")
     -- WhatsApp (Meta) --
     WHATSAPP_TOKEN, WHATSAPP_PHONE_ID
     WHATSAPP_OTP_TEMPLATE      approved authentication template (default "login_code")
     WHATSAPP_OTP_LANG          template language code (default "en")

   Returning a non-200 makes Supabase surface the failure to the caller, which
   is what we want - a user must never sit waiting for a code that was never
   sent. The code itself is NEVER logged. */
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

/* ---------------------------------------------------------------- SMS */
const smsReady = () => !!(process.env.MSG91_AUTHKEY && process.env.MSG91_TEMPLATE_ID);

/* MSG91 Flow API. We deliberately do NOT use MSG91's own /otp endpoint - that
   would have MSG91 generate and verify the code, taking the security half away
   from Supabase and leaving two systems disagreeing about what is valid. */
async function sendSms(to, code) {
  const body = {
    template_id: process.env.MSG91_TEMPLATE_ID,
    short_url: "0",
    recipients: [{ mobiles: to, [process.env.MSG91_OTP_VAR || "OTP"]: code }],
  };
  const r = await fetch("https://control.msg91.com/api/v5/flow/", {
    method: "POST",
    headers: { authkey: process.env.MSG91_AUTHKEY, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  /* MSG91 answers 200 with {type:"error"} for template/DLT problems, so an
     HTTP 200 alone is not success - read the body too */
  const ok = r.ok && String(data.type || "").toLowerCase() !== "error";
  if (!ok) throw new Error("msg91 " + r.status + " " + JSON.stringify(data).slice(0, 300));
  return (data.request_id || data.message || "sent");
}

/* ----------------------------------------------------------- WhatsApp */
const waReady = () => !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID);

async function sendWhatsApp(to, code) {
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
  const r = await fetch("https://graph.facebook.com/v20.0/" + process.env.WHATSAPP_PHONE_ID + "/messages", {
    method: "POST",
    headers: { Authorization: "Bearer " + process.env.WHATSAPP_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "template", template }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("meta " + r.status + " " + JSON.stringify(data && data.error ? data.error : data).slice(0, 300));
  return (data.messages && data.messages[0] && data.messages[0].id) || "sent";
}

/* Which carrier, in which order. Explicit OTP_CHANNEL wins; otherwise use
   whatever is configured, preferring SMS when both are. */
function plan() {
  const want = String(process.env.OTP_CHANNEL || "").toLowerCase();
  const sms = { name: "sms", ready: smsReady(), send: sendSms };
  const wa = { name: "whatsapp", ready: waReady(), send: sendWhatsApp };
  if (want === "sms") return [sms];
  if (want === "whatsapp") return [wa];
  if (want === "auto") return [wa, sms].filter((c) => c.ready);
  return [sms, wa].filter((c) => c.ready);
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const secret = process.env.SUPABASE_AUTH_HOOK_SECRET;
  if (!secret) { console.error("otp: SUPABASE_AUTH_HOOK_SECRET not set"); return json({ error: { message: "hook not configured" } }, 501); }

  const channels = plan();
  if (!channels.length) { console.error("otp: no delivery channel configured"); return json({ error: { message: "no SMS/WhatsApp provider configured" } }, 501); }

  /* the signature is over the RAW body - read it as text, parse after */
  const raw = await req.text();
  const bad = verify(secret, req.headers, raw);
  if (bad) { console.warn("otp: rejected -", bad); return json({ error: { message: "invalid signature" } }, 401); }

  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: { message: "bad json" } }, 400); }

  const to = String((body.user && body.user.phone) || "").replace(/\D/g, "");
  const code = String((body.sms && body.sms.otp) || "");
  if (!to || !code) { console.error("otp: payload missing phone or otp"); return json({ error: { message: "missing phone or otp" } }, 400); }

  const tail = to.slice(-4);
  let lastErr = "";
  for (const ch of channels) {
    if (!ch.ready) continue;
    try {
      const ref = await ch.send(to, code);          /* never log the code itself */
      console.log("otp: sent via " + ch.name + " to ..." + tail + " ref " + ref);
      return json({});
    } catch (e) {
      lastErr = (e && e.message) || String(e);
      console.error("otp: " + ch.name + " failed for ..." + tail + " -", lastErr);
      /* fall through to the next channel, if there is one */
    }
  }
  return json({ error: { message: "could not send the code" } }, 502);
};
