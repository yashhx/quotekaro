/* Send a WhatsApp message through the Cloud API (Netlify Functions v2).
   POST { to, text }                 -> free-form text (only valid inside the 24h
                                         customer-service window after they message you)
   POST { to, template:{...} }        -> an approved template (for business-initiated sends)
   Env vars (Netlify): WHATSAPP_TOKEN, WHATSAPP_PHONE_ID.
   To swap to a reseller (Interakt/Gupshup/WATI) change only the fetch() below. */
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

export default async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const token = process.env.WHATSAPP_TOKEN, phoneId = process.env.WHATSAPP_PHONE_ID;
  if (!token || !phoneId) return json({ error: "WhatsApp not configured (set WHATSAPP_TOKEN and WHATSAPP_PHONE_ID)" }, 501);

  let payload;
  try { payload = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  const to = String(payload.to || "").replace(/\D/g, "");
  if (!to) return json({ error: "missing 'to'" }, 400);

  const msg = payload.template
    ? { messaging_product: "whatsapp", to, type: "template", template: payload.template }
    : { messaging_product: "whatsapp", to, type: "text", text: { body: String(payload.text || "") } };

  try {
    console.log("send: ->", to, payload.template ? "template:" + (payload.template.name || "?") : "text");
    const r = await fetch("https://graph.facebook.com/v20.0/" + phoneId + "/messages", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify(msg),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) console.error("send: Meta API error", r.status, JSON.stringify(data && data.error ? data.error : data).slice(0, 400));
    else console.log("send: OK, message id", data.messages && data.messages[0] && data.messages[0].id);
    return json(data, r.ok ? 200 : r.status);
  } catch (e) {
    console.error("send: fetch failed -", e && e.message);
    return json({ error: "send failed" }, 502);
  }
};
