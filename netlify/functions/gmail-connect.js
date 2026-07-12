/* Gmail connector - store/clear the caller's Gmail refresh token (Functions v2).
   The app obtains a Google refresh token client-side by re-running the Google
   OAuth flow with the gmail.readonly scope (Supabase exposes it as
   session.provider_refresh_token) and hands it here ONCE; from then on only
   the server ever sees it. gmail-poll.js uses it on a schedule.

   GET    -> { ok, connected, email, error }   (status for the Setup card)
   POST   { refreshToken, email } -> { ok }    (connect / update)
   DELETE -> { ok }                            (disconnect)

   Cloud accounts required: 501 without Supabase env, 401 without a valid login. */

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

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

export default async (req) => {
  const url = process.env.SUPABASE_URL, anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) { console.warn("gmail-connect: Supabase not configured"); return json({ ok: false, error: "needs cloud accounts" }, 501); }
  const user = await requireUser(req);
  if (!user) { console.warn("gmail-connect: rejected call without valid login"); return json({ ok: false, error: "login required" }, 401); }
  const hdrs = svcHeaders();
  if (!hdrs) { console.error("gmail-connect: SUPABASE_SERVICE_KEY missing"); return json({ ok: false, error: "server missing service key" }, 500); }
  const uid = encodeURIComponent(user.id);

  if (req.method === "GET") {
    try {
      const r = await fetch(url + "/rest/v1/tenants?user_id=eq." + uid + "&select=gmail_refresh_token,gmail_email,gmail_error", { headers: hdrs });
      const rows = r.ok ? await r.json() : [];
      const t = rows[0] || {};
      return json({ ok: true, connected: !!t.gmail_refresh_token, email: t.gmail_email || "", error: t.gmail_error || "" });
    } catch (e) { console.error("gmail-connect: status read failed -", e && e.message); return json({ ok: false, error: "could not read status" }, 500); }
  }

  if (req.method === "POST") {
    let body;
    try { body = await req.json(); } catch { return json({ ok: false, error: "bad json" }, 400); }
    const rt = String(body.refreshToken || "").trim();
    if (!rt || rt.length < 20) return json({ ok: false, error: "missing refresh token" }, 400);
    try {
      const r = await fetch(url + "/rest/v1/tenants?user_id=eq." + uid, {
        method: "PATCH",
        headers: { ...hdrs, "content-type": "application/json", prefer: "return=representation" },
        body: JSON.stringify({
          gmail_refresh_token: rt,
          gmail_email: String(body.email || user.email || "").slice(0, 120),
          gmail_error: "",
          gmail_last_ts: Date.now(), /* only NEW mail from connect time onward */
        }),
      });
      const rows = r.ok ? await r.json() : [];
      if (!r.ok || !rows.length) { console.error("gmail-connect: save failed -", r.status); return json({ ok: false, error: "could not save (run supabase/gmail.sql?)" }, 500); }
      console.log("gmail-connect: connected Gmail for", user.id);
      return json({ ok: true });
    } catch (e) { console.error("gmail-connect: save failed -", e && e.message); return json({ ok: false, error: "could not save" }, 500); }
  }

  if (req.method === "DELETE") {
    try {
      await fetch(url + "/rest/v1/tenants?user_id=eq." + uid, {
        method: "PATCH",
        headers: { ...hdrs, "content-type": "application/json" },
        body: JSON.stringify({ gmail_refresh_token: null, gmail_email: "", gmail_error: "" }),
      });
      console.log("gmail-connect: disconnected Gmail for", user.id);
      return json({ ok: true });
    } catch (e) { console.error("gmail-connect: disconnect failed -", e && e.message); return json({ ok: false, error: "could not disconnect" }, 500); }
  }

  return json({ ok: false, error: "method not allowed" }, 405);
};
