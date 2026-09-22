/* The owner's phone signs up for (or drops) breakdown notifications.
   GET                          -> { ok, key }   the VAPID public key the browser needs
   POST { subscription }        -> { ok }        save this browser's subscription
   DELETE { endpoint }          -> { ok }        stop notifying this browser

   POST/DELETE need the owner's Supabase login; the subscription is stored
   against his user_id so floor-event.js can find it when a machine stops.
   Rows are written with the service role - a browser can read its own rows
   (RLS) but never write someone else's. */

import { sendToOwner } from "./push-send.js";

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

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

function svcHeaders() {
  const svc = process.env.SUPABASE_SERVICE_KEY;
  if (!svc) return null;
  const h = svc.startsWith("sb_") ? { apikey: svc } : { apikey: svc, authorization: "Bearer " + svc };
  return { ...h, "content-type": "application/json" };
}

export default async (req) => {
  /* the public key is not a secret - it is meant to be handed to browsers */
  if (req.method === "GET") {
    const key = process.env.VAPID_PUBLIC_KEY || "";
    return json({ ok: !!key, key });
  }

  const url = process.env.SUPABASE_URL, hdrs = svcHeaders();
  if (!url || !hdrs) return json({ ok: false, error: "needs cloud accounts" }, 501);

  const user = await requireUser(req);
  if (!user) return json({ ok: false, error: "login required" }, 401);

  const body = await req.json().catch(() => ({}));

  if (req.method === "DELETE") {
    const endpoint = String(body.endpoint || "");
    if (!endpoint) return json({ ok: false, error: "missing endpoint" }, 400);
    try {
      await fetch(url + "/rest/v1/push_subs?endpoint=eq." + encodeURIComponent(endpoint) + "&user_id=eq." + user.id, { method: "DELETE", headers: hdrs });
      return json({ ok: true });
    } catch (e) {
      console.error("push-subscribe: delete failed -", e && e.message);
      return json({ ok: false, error: "could not remove" }, 502);
    }
  }

  if (req.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);

  /* "does this phone actually buzz?" - answers it without breaking a machine */
  if (body.test) {
    const r = await sendToOwner(user.id, {
      title: "TrackRakho", body: "Test - notification chalu hai", tag: "test", url: "/",
    });
    console.log("push-subscribe: test push ->", JSON.stringify(r));
    return json({ ok: r.sent > 0, sent: r.sent, dropped: r.dropped });
  }

  const sub = body.subscription || {};
  const endpoint = String(sub.endpoint || "");
  const p256dh = String((sub.keys && sub.keys.p256dh) || "");
  const auth = String((sub.keys && sub.keys.auth) || "");
  if (!endpoint || !p256dh || !auth) return json({ ok: false, error: "bad subscription" }, 400);

  try {
    /* endpoint is the primary key, so re-subscribing the same browser just
       moves the row to whoever is logged in now (shared phone, new owner) */
    const r = await fetch(url + "/rest/v1/push_subs", {
      method: "POST", headers: { ...hdrs, prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ endpoint, user_id: user.id, p256dh, auth }),
    });
    if (!r.ok) { console.error("push-subscribe: save failed", r.status, await r.text()); return json({ ok: false, error: "could not save" }, 502); }
    console.log("push-subscribe: subscribed a device for user", user.id);
    return json({ ok: true });
  } catch (e) {
    console.error("push-subscribe: save failed -", e && e.message);
    return json({ ok: false, error: "could not save" }, 502);
  }
};
