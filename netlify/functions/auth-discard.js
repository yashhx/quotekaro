/* Discard an EMPTY, just-created account so its phone number can be attached to
   the user's real account instead.

   THE PROBLEM THIS SOLVES. Supabase makes a new user for every identifier it has
   not seen. A shop owner who has been signing in with Google, and who one day
   types his phone number instead, lands in a brand new account with an empty
   pipeline - his real data is still sitting safely on the Google account, but he
   cannot see it, and it looks to him like the app lost everything.

   The fix is not to move his data (that would mean copying rows between users -
   easy to get wrong, impossible to undo). It is to throw away the empty account
   he just made by accident, which frees the phone number, send him back in
   through Google, and let him attach the same phone to his REAL account from
   Setup. Nothing is ever merged, and nothing that holds work is ever touched.

   DELETION GUARDS - all four must hold, or we refuse:
     1. the caller presents a valid JWT, and we only ever delete that same uid
     2. the account has no shop_data row at all (it has never saved any work)
     3. the account was created in the last 24 hours
     4. the account has no google identity (nothing is linked to it)

   Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY (secret). */
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

export default async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  const service = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !anon || !service) return json({ ok: false, why: "cloud not configured" }, 501);

  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ ok: false, why: "login required" }, 401);

  /* 1. who is calling - the token is the only thing that decides the uid, never
        anything the client sends in the body */
  let user;
  try {
    const r = await fetch(url + "/auth/v1/user", { headers: { apikey: anon, authorization: "Bearer " + jwt } });
    if (!r.ok) return json({ ok: false, why: "login required" }, 401);
    user = await r.json();
  } catch { return json({ ok: false, why: "could not verify login" }, 502); }
  if (!user || !user.id) return json({ ok: false, why: "login required" }, 401);

  const admin = { apikey: service, authorization: "Bearer " + service, "content-type": "application/json" };

  /* 2. never delete an account that holds work */
  try {
    const r = await fetch(url + "/rest/v1/shop_data?user_id=eq." + encodeURIComponent(user.id) + "&select=user_id", { headers: admin });
    if (!r.ok) { console.error("discard: shop_data check failed", r.status); return json({ ok: false, why: "could not check the account" }, 502); }
    const rows = await r.json().catch(() => null);
    if (!Array.isArray(rows)) return json({ ok: false, why: "could not check the account" }, 502);
    if (rows.length) { console.warn("discard: refused - account has saved data"); return json({ ok: false, why: "this account already has saved data" }, 409); }
  } catch { return json({ ok: false, why: "could not check the account" }, 502); }

  /* 3. only a freshly created account - anything older is somebody's real login */
  const created = Date.parse(user.created_at || "");
  if (!Number.isFinite(created) || Date.now() - created > 24 * 60 * 60 * 1000) {
    console.warn("discard: refused - account is not new");
    return json({ ok: false, why: "this account is not a new one" }, 409);
  }

  /* 4. and nothing may be linked to it */
  const providers = (user.identities || []).map((i) => String(i.provider || ""));
  if (providers.some((p) => p !== "phone")) {
    console.warn("discard: refused - account has linked identities:", providers.join(","));
    return json({ ok: false, why: "this account already has another login linked" }, 409);
  }

  try {
    const r = await fetch(url + "/auth/v1/admin/users/" + encodeURIComponent(user.id), { method: "DELETE", headers: admin });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      console.error("discard: delete failed", r.status, t.slice(0, 300));
      return json({ ok: false, why: "could not remove the empty account" }, 502);
    }
    console.log("discard: removed empty account", user.id);
    return json({ ok: true });
  } catch (e) {
    console.error("discard: delete threw -", e && e.message);
    return json({ ok: false, why: "could not remove the empty account" }, 502);
  }
};
