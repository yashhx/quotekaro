/* Send a WhatsApp message through the Cloud API.
   POST { to, text }                 -> free-form text (only valid inside the 24h
                                         customer-service window after they message you)
   POST { to, template:{...} }        -> an approved template (for business-initiated sends)
   Env vars (Netlify): WHATSAPP_TOKEN, WHATSAPP_PHONE_ID.
   To swap to a reseller (Interakt/Gupshup/WATI) change only the fetch() below. */
const json = (code, obj) => ({ statusCode: code, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "method not allowed" });

  const token = process.env.WHATSAPP_TOKEN, phoneId = process.env.WHATSAPP_PHONE_ID;
  if (!token || !phoneId) return json(501, { error: "WhatsApp not configured (set WHATSAPP_TOKEN and WHATSAPP_PHONE_ID)" });

  let payload;
  try { payload = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "bad json" }); }

  const to = String(payload.to || "").replace(/\D/g, "");
  if (!to) return json(400, { error: "missing 'to'" });

  const msg = payload.template
    ? { messaging_product: "whatsapp", to, type: "template", template: payload.template }
    : { messaging_product: "whatsapp", to, type: "text", text: { body: String(payload.text || "") } };

  try {
    const r = await fetch("https://graph.facebook.com/v20.0/" + phoneId + "/messages", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify(msg),
    });
    const data = await r.json().catch(() => ({}));
    return json(r.ok ? 200 : r.status, data);
  } catch {
    return json(502, { error: "send failed" });
  }
};
