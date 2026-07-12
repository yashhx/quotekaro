/* Gmail poller (Functions v2) - runs every 5 minutes on a Netlify schedule
   (see netlify.toml) and also on demand from the app.

   For every tenant with a stored Gmail refresh token:
     1. refresh a Google access token (GOOGLE_CLIENT_ID/SECRET env),
     2. search THEIR inbox for new RFQ-looking mail since the last check,
     3. store matches in the same "enquiries" Blobs store the WhatsApp webhook
        uses - stamped with userId so enquiries.js routes them privately,
     4. advance the per-tenant checkpoint (gmail_last_ts).

   Invocations:
     - Netlify schedule (no auth header): polls ALL connected tenants.
     - POST with a Supabase JWT (the app's "Check Gmail now"): polls only the
       caller and returns { ok, found }.

   A dead/expired refresh token (Google "Testing" consent screens expire them
   after 7 days) sets tenants.gmail_error so the Setup card can say
   "reconnect needed" instead of failing silently. */
import { getStore } from "@netlify/blobs";

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const MAX_MSGS_PER_USER = 10;
const MAX_BODY_CHARS = 1200;
/* what counts as an RFQ-ish mail - tune freely; Gmail search is case-insensitive */
const RFQ_QUERY = "(quote OR quotation OR rfq OR enquiry OR inquiry OR rate OR price OR requirement OR estimate)";

function svcHeaders() {
  const svc = process.env.SUPABASE_SERVICE_KEY;
  if (!svc) return null;
  return svc.startsWith("sb_") ? { apikey: svc } : { apikey: svc, authorization: "Bearer " + svc };
}
async function requireUser(req) {
  const url = process.env.SUPABASE_URL, anon = process.env.SUPABASE_ANON_KEY;
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!url || !anon || !token) return null;
  try {
    const r = await fetch(url + "/auth/v1/user", { headers: { apikey: anon, authorization: "Bearer " + token } });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? u : null;
  } catch { return null; }
}

/* exchange the stored refresh token for a short-lived access token */
async function accessToken(refreshToken) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken, grant_type: "refresh_token",
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) {
    const why = (d && (d.error_description || d.error)) || ("HTTP " + r.status);
    const dead = d && (d.error === "invalid_grant" || d.error === "invalid_client");
    return { token: null, dead, why };
  }
  return { token: d.access_token };
}

/* pull a readable text body out of a Gmail message payload */
function bodyText(payload) {
  const decode = (b64) => {
    try { return Buffer.from(String(b64).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"); }
    catch { return ""; }
  };
  const walk = (part, want) => {
    if (!part) return "";
    if (part.mimeType === want && part.body && part.body.data) return decode(part.body.data);
    for (const p of part.parts || []) { const t = walk(p, want); if (t) return t; }
    return "";
  };
  let text = walk(payload, "text/plain");
  if (!text) {
    const html = walk(payload, "text/html");
    if (html) text = html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  }
  return (text || "").slice(0, MAX_BODY_CHARS);
}

async function pollTenant(t, store, hdrs, sbUrl) {
  const { token, dead, why } = await accessToken(t.gmail_refresh_token);
  const patch = async (obj) => {
    await fetch(sbUrl + "/rest/v1/tenants?user_id=eq." + encodeURIComponent(t.user_id), {
      method: "PATCH", headers: { ...hdrs, "content-type": "application/json" }, body: JSON.stringify(obj),
    }).catch(() => {});
  };
  if (!token) {
    console.warn("gmail-poll:", t.user_id, "token refresh failed -", why);
    if (dead) await patch({ gmail_error: "reconnect needed" });
    return 0;
  }
  const gh = { authorization: "Bearer " + token };
  const sinceSec = Math.max(1, Math.floor((Number(t.gmail_last_ts) || Date.now()) / 1000));
  const q = encodeURIComponent("in:inbox after:" + sinceSec + " " + RFQ_QUERY);
  const list = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=" + MAX_MSGS_PER_USER + "&q=" + q, { headers: gh });
  const ld = await list.json().catch(() => ({}));
  if (!list.ok) { console.error("gmail-poll:", t.user_id, "list failed", list.status, JSON.stringify(ld).slice(0, 150)); return 0; }
  const ids = (ld.messages || []).map((m) => m.id);
  let stored = 0, newest = Number(t.gmail_last_ts) || 0;
  for (const id of ids) {
    try {
      const mr = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/" + id + "?format=full", { headers: gh });
      if (!mr.ok) continue;
      const m = await mr.json();
      const hdr = (name) => { const h = ((m.payload || {}).headers || []).find((x) => x.name.toLowerCase() === name); return h ? h.value : ""; };
      const fromRaw = hdr("from"); /* "Name <a@b.com>" or bare address */
      const fm = /^(.*?)\s*<([^>]+)>\s*$/.exec(fromRaw);
      const senderName = ((fm ? fm[1] : "").replace(/^"|"$/g, "") || (fromRaw.split("@")[0] || "")).trim();
      const senderEmail = (fm ? fm[2] : fromRaw).trim();
      const at = Number(m.internalDate) || Date.now();
      const subject = hdr("subject") || "(no subject)";
      const rec = {
        id: "gm_" + id, type: "text",
        text: subject + "\n\n" + bodyText(m.payload),
        from: senderEmail, name: senderName, at, handled: false,
        userId: t.user_id, source: "gmail", phoneId: "",
      };
      await store.setJSON("msg_gm_" + id, rec);
      stored++;
      if (at > newest) newest = at;
      console.log("gmail-poll: stored", "gm_" + id, "for", t.user_id, "-", subject.slice(0, 60));
    } catch (e) { console.error("gmail-poll: message", id, "failed -", e && e.message); }
  }
  /* advance checkpoint even with zero matches so the search window stays small;
     +1s so the newest stored mail is not re-fetched forever */
  await patch({ gmail_last_ts: stored ? newest + 1000 : Date.now() - 60000, gmail_error: "" });
  return stored;
}

export default async (req) => {
  const sbUrl = process.env.SUPABASE_URL, hdrs = svcHeaders();
  if (!sbUrl || !hdrs) { console.warn("gmail-poll: Supabase not configured"); return json({ ok: false, error: "needs cloud accounts" }, 501); }
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) { console.warn("gmail-poll: GOOGLE_CLIENT_ID/SECRET not set"); return json({ ok: false, error: "google keys missing" }, 501); }

  let store;
  try { store = getStore("enquiries"); }
  catch (e) { console.error("gmail-poll: getStore failed -", e && e.message); return json({ ok: false, error: "no blob store" }, 500); }

  /* manual "check now" from the app: poll just the caller */
  const caller = await requireUser(req);
  const filter = caller
    ? "&user_id=eq." + encodeURIComponent(caller.id)
    : "";
  try {
    const r = await fetch(sbUrl + "/rest/v1/tenants?gmail_refresh_token=not.is.null&select=user_id,gmail_refresh_token,gmail_last_ts&limit=20" + filter, { headers: hdrs });
    const tenants = r.ok ? await r.json() : [];
    let total = 0;
    for (const t of tenants) total += await pollTenant(t, store, hdrs, sbUrl);
    console.log("gmail-poll: done -", tenants.length, "inbox(es),", total, "new enquiry(ies)", caller ? "(manual)" : "(scheduled)");
    return json({ ok: true, found: total });
  } catch (e) {
    console.error("gmail-poll: failed -", e && e.message);
    return json({ ok: false, error: "poll failed" }, 500);
  }
};
