/* Issues the secret key the on-premise Tally connector uses to talk to the
   cloud (Netlify Functions v2). The app calls this while the OWNER is logged
   in; the key is then pasted into the connector's config.json and comes back
   on every connector call as the x-connector-key header (see tally-sync.js).

   GET                      -> { ok:true, key }  (existing key, or a fresh one minted and saved)
   POST { regenerate:true } -> { ok:true, key }  (force a new key; the old one stops working)

   Cloud accounts are required: 501 when SUPABASE_URL / SUPABASE_ANON_KEY are
   unset, 401 without a valid Supabase login. The key lives in
   tenants.connector_key and is written via the service role only (users have
   no write access to the tenants table). */

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

/* resolve the caller from the Supabase JWT; null for missing/invalid token */
async function requireUser(req) {
  const url = process.env.SUPABASE_URL, anon = process.env.SUPABASE_ANON_KEY;
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  try {
    const r = await fetch(url + "/auth/v1/user", { headers: { apikey: anon, authorization: "Bearer " + token } });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? u : null;
  } catch { return null; }
}

/* legacy service_role JWTs go in both headers; new sb_secret_ keys in apikey only */
function svcHeaders() {
  const svc = process.env.SUPABASE_SERVICE_KEY;
  if (!svc) return null;
  return svc.startsWith("sb_") ? { apikey: svc } : { apikey: svc, authorization: "Bearer " + svc };
}

/* "tk_" + 40 lowercase hex chars from the crypto RNG (never Math.random) */
function newKey() {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return "tk_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export default async (req) => {
  const url = process.env.SUPABASE_URL, anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) {
    console.warn("tally-key: Supabase not configured, connector keys need cloud accounts");
    return json({ ok: false, error: "needs cloud accounts" }, 501);
  }

  const user = await requireUser(req);
  if (!user) { console.warn("tally-key: rejected call without valid login"); return json({ ok: false, error: "login required" }, 401); }

  const hdrs = svcHeaders();
  if (!hdrs) { console.error("tally-key: SUPABASE_SERVICE_KEY is not set, cannot read/write tenants"); return json({ ok: false, error: "server missing service key" }, 500); }

  if (req.method !== "GET" && req.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);

  let regenerate = false;
  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    regenerate = !!(body && body.regenerate);
  }

  /* return the existing key unless the caller asked for a new one */
  if (!regenerate) {
    try {
      const r = await fetch(url + "/rest/v1/tenants?user_id=eq." + encodeURIComponent(user.id) + "&select=connector_key", { headers: hdrs });
      if (!r.ok) { console.error("tally-key: tenant read failed -", r.status); return json({ ok: false, error: "could not read key" }, 500); }
      const rows = await r.json();
      if (rows[0] && rows[0].connector_key) return json({ ok: true, key: rows[0].connector_key });
    } catch (e) { console.error("tally-key: tenant read failed -", e && e.message); return json({ ok: false, error: "could not read key" }, 500); }
  }

  /* mint and save a new key (first ask, or forced regenerate) */
  const key = newKey();
  try {
    const r = await fetch(url + "/rest/v1/tenants?user_id=eq." + encodeURIComponent(user.id), {
      method: "PATCH",
      headers: { ...hdrs, "content-type": "application/json", prefer: "return=representation" },
      body: JSON.stringify({ connector_key: key }),
    });
    const rows = r.ok ? await r.json() : [];
    if (!r.ok) { console.error("tally-key: key save failed -", r.status); return json({ ok: false, error: "could not save key" }, 500); }
    if (!rows.length) { console.error("tally-key: no tenant row for", user.id, "- signup trigger missing?"); return json({ ok: false, error: "could not save key" }, 500); }
    console.log("tally-key:", regenerate ? "regenerated" : "issued", "connector key for", user.id);
    return json({ ok: true, key });
  } catch (e) {
    console.error("tally-key: key save failed -", e && e.message);
    return json({ ok: false, error: "could not save key" }, 500);
  }
};
