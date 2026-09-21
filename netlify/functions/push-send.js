/* Web Push delivery (shared module, not an HTTP endpoint).
   sendToOwner(userId, { title, body, tag, url }) -> { sent, dropped }

   Used by floor-event.js when a machine goes down: that is the one thing on a
   shop floor that cannot wait until the owner next opens the app. Everything
   else stays in the in-app feed on purpose - a buzz per piece counted gets
   notifications muted within a day.

   Env vars (Netlify):
     VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY - generated once with web-push
     VAPID_SUBJECT                       - mailto: or https: identifying the sender
   Missing keys make this a quiet no-op: the event is still logged and the feed
   still shows it, the phone just does not buzz. */
import webpush from "web-push";

function svcHeaders() {
  const svc = process.env.SUPABASE_SERVICE_KEY;
  if (!svc) return null;
  const h = svc.startsWith("sb_") ? { apikey: svc } : { apikey: svc, authorization: "Bearer " + svc };
  return { ...h, "content-type": "application/json" };
}

let configured = null;
function vapidReady() {
  if (configured != null) return configured;
  const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) { configured = false; return false; }
  try {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:support@trackrakho.com", pub, priv);
    configured = true;
  } catch (e) {
    console.error("push-send: bad VAPID keys -", e && e.message);
    configured = false;
  }
  return configured;
}

export async function sendToOwner(userId, payload) {
  const url = process.env.SUPABASE_URL, hdrs = svcHeaders();
  if (!url || !hdrs) return { sent: 0, dropped: 0 };
  if (!vapidReady()) { console.warn("push-send: VAPID keys not set - notification skipped"); return { sent: 0, dropped: 0 }; }

  const r = await fetch(url + "/rest/v1/push_subs?user_id=eq." + userId + "&select=endpoint,p256dh,auth", { headers: hdrs });
  const subs = r.ok ? await r.json() : [];
  if (!subs.length) return { sent: 0, dropped: 0 };

  let sent = 0, dropped = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload),
        { TTL: 3600, urgency: "high" },
      );
      sent++;
    } catch (e) {
      /* 404/410 = the browser threw the subscription away; stop trying it */
      if (e && (e.statusCode === 404 || e.statusCode === 410)) {
        dropped++;
        fetch(url + "/rest/v1/push_subs?endpoint=eq." + encodeURIComponent(s.endpoint), { method: "DELETE", headers: hdrs }).catch(() => {});
      } else {
        console.warn("push-send: delivery failed", (e && e.statusCode) || "", (e && e.message) || "");
      }
    }
  }));
  console.log("push-send: sent", sent, "dropped", dropped, "for user", userId);
  return { sent, dropped };
}
