/* Pairs a shop-floor phone with an owner's account (Netlify Functions v2).
   Two callers, one endpoint:

   OWNER (Supabase JWT):
     POST { action:"create", name? } -> { ok, code, expires }   mint a 6-digit code
     GET                             -> { ok, devices: [...] }  list paired devices
     POST { action:"remove", id }    -> { ok }                  revoke one device

   WORKER DEVICE (no login at all):
     POST { action:"claim", code }   -> { ok, token, shopName }

   The device token is the ONLY thing a worker's phone ever holds - it can
   read the floor board and post floor events, and nothing else. It cannot
   read quotes, money or Tally, because those never leave the owner's app.

   A pairing code is single-use and dies after 15 minutes; claiming clears it
   in the same write, so two phones cannot claim the same code. */

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const PAIR_MINUTES = 15;

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

/* legacy service_role JWTs go in both headers; new sb_secret_ keys in apikey only */
function svcHeaders() {
  const svc = process.env.SUPABASE_SERVICE_KEY;
  if (!svc) return null;
  const h = svc.startsWith("sb_") ? { apikey: svc } : { apikey: svc, authorization: "Bearer " + svc };
  return { ...h, "content-type": "application/json" };
}

/* 6 digits from the crypto RNG (never Math.random), no leading zero so it
   reads back cleanly over a noisy shop floor */
function newCode() {
  const b = new Uint32Array(1);
  crypto.getRandomValues(b);
  return String(100000 + (b[0] % 900000));
}
function newToken() {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return "fl_" + Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("");
}

export default async (req) => {
  const url = process.env.SUPABASE_URL;
  const hdrs = svcHeaders();
  if (!url || !hdrs) return json({ ok: false, error: "needs cloud accounts" }, 501);
  const rest = url + "/rest/v1/floor_devices";

  let body = {};
  if (req.method === "POST") body = await req.json().catch(() => ({}));
  const action = String(body.action || (req.method === "GET" ? "list" : "")).toLowerCase();

  /* ---------- the worker's phone: one code, one token, no login ---------- */
  if (action === "claim") {
    const code = String(body.code || "").replace(/\D/g, "");
    if (code.length !== 6) return json({ ok: false, error: "bad code" }, 400);
    try {
      const q = rest + "?pair_code=eq." + code + "&select=id,user_id,pair_expires";
      const r = await fetch(q, { headers: hdrs });
      const rows = r.ok ? await r.json() : [];
      const row = rows[0];
      if (!row) { console.warn("floor-pair: claim with unknown code"); return json({ ok: false, error: "code not found" }, 404); }
      if (Number(row.pair_expires) < Date.now()) {
        console.warn("floor-pair: claim with expired code");
        return json({ ok: false, error: "code expired" }, 410);
      }
      const token = newToken();
      /* clearing pair_code in the same write makes the code single-use */
      const up = await fetch(rest + "?id=eq." + row.id + "&pair_code=eq." + code, {
        method: "PATCH", headers: { ...hdrs, prefer: "return=representation" },
        body: JSON.stringify({ token, pair_code: null, pair_expires: null, paired_at: new Date().toISOString(), last_seen: new Date().toISOString() }),
      });
      const done = up.ok ? await up.json() : [];
      if (!done.length) return json({ ok: false, error: "code already used" }, 409);

      /* the shop name is the one piece of owner data a floor phone may see */
      let shopName = "";
      try {
        const s = await fetch(url + "/rest/v1/shop_data?user_id=eq." + row.user_id + "&select=data", { headers: hdrs });
        const d = s.ok ? await s.json() : [];
        shopName = (d[0] && d[0].data && d[0].data.shopName) || "";
      } catch {}
      console.log("floor-pair: device paired for user", row.user_id);
      return json({ ok: true, token, shopName });
    } catch (e) {
      console.error("floor-pair: claim failed -", e && e.message);
      return json({ ok: false, error: "pairing failed" }, 502);
    }
  }

  /* ---------- everything else is the owner, and needs a login ---------- */
  const user = await requireUser(req);
  if (!user) { console.warn("floor-pair: rejected owner call without valid login"); return json({ ok: false, error: "login required" }, 401); }

  if (action === "list") {
    try {
      const r = await fetch(rest + "?user_id=eq." + user.id + "&select=id,name,paired_at,last_seen,pair_code,pair_expires&order=created_at.desc", { headers: hdrs });
      const rows = r.ok ? await r.json() : [];
      /* never hand the token back out, not even to the owner */
      return json({ ok: true, devices: rows.map((d) => ({ id: d.id, name: d.name, pairedAt: d.paired_at, lastSeen: d.last_seen, code: d.pair_code, expires: Number(d.pair_expires) || 0 })) });
    } catch (e) {
      console.error("floor-pair: list failed -", e && e.message);
      return json({ ok: false, error: "could not list devices" }, 502);
    }
  }

  if (action === "create") {
    const name = String(body.name || "").trim().slice(0, 40) || "Floor phone";
    try {
      /* clear any code this owner left hanging, so only one is ever live */
      await fetch(rest + "?user_id=eq." + user.id + "&token=is.null", { method: "DELETE", headers: hdrs });
      const code = newCode();
      const r = await fetch(rest, {
        method: "POST", headers: { ...hdrs, prefer: "return=representation" },
        body: JSON.stringify({ user_id: user.id, name, pair_code: code, pair_expires: Date.now() + PAIR_MINUTES * 60000 }),
      });
      if (!r.ok) { console.error("floor-pair: create failed", r.status, await r.text()); return json({ ok: false, error: "could not make a code" }, 502); }
      return json({ ok: true, code, expires: Date.now() + PAIR_MINUTES * 60000 });
    } catch (e) {
      console.error("floor-pair: create failed -", e && e.message);
      return json({ ok: false, error: "could not make a code" }, 502);
    }
  }

  if (action === "remove") {
    const id = String(body.id || "");
    if (!id) return json({ ok: false, error: "missing id" }, 400);
    try {
      /* user_id in the filter: an owner can only ever revoke his own device */
      const r = await fetch(rest + "?id=eq." + encodeURIComponent(id) + "&user_id=eq." + user.id, { method: "DELETE", headers: hdrs });
      if (!r.ok) return json({ ok: false, error: "could not remove" }, 502);
      console.log("floor-pair: device removed by owner", user.id);
      return json({ ok: true });
    } catch (e) {
      console.error("floor-pair: remove failed -", e && e.message);
      return json({ ok: false, error: "could not remove" }, 502);
    }
  }

  return json({ ok: false, error: "unknown action" }, 400);
};
