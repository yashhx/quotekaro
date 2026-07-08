/* Bridge between stored inbound WhatsApp messages and the app (Netlify Functions v2).
   GET  -> { enabled, enquiries:[...] }  (unhandled inbound messages, newest first)
   POST { id } -> mark one handled (removes it) once the app logs or dismisses it.

   MULTI-TENANT: when Supabase env vars are set, every call must carry a valid
   Supabase JWT, and a user only sees enquiries sent TO their assigned WhatsApp
   number (tenants.wa_phone_id). Admins (tenants.is_admin) see everything,
   including legacy/unrouted enquiries. Without Supabase env vars the function
   behaves like the original single-tenant prototype (open).

   Returns { enabled:false } gracefully when Blobs isn't available. */
import { getStore } from "@netlify/blobs";

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const MAX_RETURNED = 100;
const RETENTION_MS = 30 * 86400000; // 30 days

/* resolve the caller: {open:true} when Supabase isn't configured,
   {id} for a valid user, null for missing/invalid token */
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

/* the caller's tenant row: which WhatsApp number is theirs, and admin flag */
async function getTenant(userId) {
  const url = process.env.SUPABASE_URL, svc = process.env.SUPABASE_SERVICE_KEY;
  if (!svc) return { wa_phone_id: null, is_admin: false };
  /* legacy service_role JWTs go in both headers; new sb_secret_ keys in apikey only */
  const hdrs = svc.startsWith("sb_") ? { apikey: svc } : { apikey: svc, authorization: "Bearer " + svc };
  try {
    const r = await fetch(url + "/rest/v1/tenants?user_id=eq." + encodeURIComponent(userId) + "&select=wa_phone_id,is_admin",
      { headers: hdrs });
    if (!r.ok) console.warn("enquiries: getTenant REST failed", r.status, "- check SUPABASE_SERVICE_KEY");
    const rows = r.ok ? await r.json() : [];
    return rows[0] || { wa_phone_id: null, is_admin: false };
  } catch (e) { console.warn("enquiries: getTenant threw -", e && e.message); return { wa_phone_id: null, is_admin: false }; }
}

const canSee = (v, tenant) => {
  if (!tenant) return true;                       /* open (single-tenant) mode */
  if (tenant.is_admin) return true;               /* admin sees all, incl. unrouted */
  return !!v.phoneId && v.phoneId === tenant.wa_phone_id;
};

export default async (req) => {
  const user = await requireUser(req);
  if (!user) { console.warn("enquiries: rejected call without valid login"); return json({ enabled: false, enquiries: [], error: "login required" }, 401); }
  const tenant = user.open ? null : await getTenant(user.id);

  let store;
  try { store = getStore("enquiries"); }
  catch (e) { console.error("enquiries: getStore failed -", e && e.message); return json({ enabled: false, enquiries: [] }); }

  if (req.method === "GET") {
    try {
      const { blobs } = await store.list();
      const items = (await Promise.all(
        blobs.map((b) => store.get(b.key, { type: "json" }).catch((e) => { console.error("enquiries: get", b.key, "failed -", e && e.message); return null; }))
      )).filter((v) => v && !v.handled);
      items.sort((a, b) => (b.at || 0) - (a.at || 0));

      /* retention sweep: quietly drop anything older than 30 days */
      const cutoff = Date.now() - RETENTION_MS;
      const stale = items.filter((v) => (v.at || 0) < cutoff);
      if (stale.length) {
        console.log("enquiries: sweeping", stale.length, "stale blob(s)");
        await Promise.all(stale.map((v) => store.delete("msg_" + v.id).catch(() => {})));
      }

      const fresh = items.filter((v) => (v.at || 0) >= cutoff).filter((v) => canSee(v, tenant)).slice(0, MAX_RETURNED);
      return json({ enabled: true, enquiries: fresh });
    } catch (e) {
      console.error("enquiries: list failed -", e && e.message);
      return json({ enabled: true, enquiries: [] });
    }
  }

  if (req.method === "POST") {
    try {
      const { id } = await req.json();
      if (id) {
        /* ownership check: you can only mark YOUR enquiry handled */
        const rec = await store.get("msg_" + id, { type: "json" }).catch(() => null);
        if (rec && !canSee(rec, tenant)) { console.warn("enquiries: blocked cross-tenant delete of", id); return json({ error: "not yours" }, 403); }
        await store.delete("msg_" + id);
        console.log("enquiries: marked handled", id);
      }
    } catch (e) { console.error("enquiries: mark-handled failed -", e && e.message); }
    return json({ ok: true });
  }

  return json({ error: "method not allowed" }, 405);
};
