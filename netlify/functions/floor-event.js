/* A shop-floor phone reports something (Netlify Functions v2).
   POST with header x-floor-token
     { kind, machineUid?, fromUid?, jobId?, qty?, rej?, reason?, note? }
     -> { ok, event }

   Append-only: the worker can add to the log and can never edit or delete it,
   and nothing here writes to the owner's shop_data (one writer - his own app -
   is what keeps the synced blob safe).

   A "down" event also pushes a notification to the owner's phone, because a
   stopped machine is the one thing that cannot wait until he opens the app.
   Counts and finished jobs stay silent on purpose: an alert per piece would
   get the notifications muted within a day. */

import { deviceFromToken } from "./floor-board.js";
import { sendToOwner } from "./push-send.js";

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

const KINDS = ["start", "count", "done", "down", "up", "move", "note"];
/* the eight stop reasons the worker app offers - anything else is rejected so
   the owner's breakdown report can never turn to mush */
const REASONS = ["breakdown", "tool", "power", "material", "operator", "setting", "quality", "break"];
const REASON_TEXT = {
  breakdown: "machine kharab", tool: "tool toot gaya", power: "bijli nahi", material: "maal nahi aaya",
  operator: "operator nahi", setting: "setting chal rahi", quality: "quality check", break: "break",
};

function svcHeaders() {
  const svc = process.env.SUPABASE_SERVICE_KEY;
  if (!svc) return null;
  const h = svc.startsWith("sb_") ? { apikey: svc } : { apikey: svc, authorization: "Bearer " + svc };
  return { ...h, "content-type": "application/json" };
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null; };

export default async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
  const url = process.env.SUPABASE_URL;
  const hdrs = svcHeaders();
  if (!url || !hdrs) return json({ ok: false, error: "needs cloud accounts" }, 501);

  const token = req.headers.get("x-floor-token") || "";
  let dev;
  try { dev = await deviceFromToken(url, hdrs, token); }
  catch (e) { console.error("floor-event: token lookup failed -", e && e.message); return json({ ok: false, error: "lookup failed" }, 502); }
  if (!dev) { console.warn("floor-event: rejected call with unknown device token"); return json({ ok: false, error: "device not paired" }, 401); }

  const body = await req.json().catch(() => ({}));
  const kind = String(body.kind || "").toLowerCase();
  if (!KINDS.includes(kind)) return json({ ok: false, error: "unknown kind" }, 400);
  const reason = String(body.reason || "").toLowerCase();
  if (kind === "down" && !REASONS.includes(reason)) return json({ ok: false, error: "unknown reason" }, 400);

  const row = {
    user_id: dev.user_id, device_id: dev.id, kind,
    machine_uid: String(body.machineUid || "").slice(0, 60) || null,
    from_uid: String(body.fromUid || "").slice(0, 60) || null,
    job_id: String(body.jobId || "").slice(0, 60) || null,
    qty: num(body.qty), rej: num(body.rej),
    reason: kind === "down" ? reason : null,
    note: String(body.note || "").slice(0, 300) || null,
    at: Date.now(),
  };

  try {
    const r = await fetch(url + "/rest/v1/floor_events", {
      method: "POST", headers: { ...hdrs, prefer: "return=representation" }, body: JSON.stringify(row),
    });
    if (!r.ok) { console.error("floor-event: insert failed", r.status, await r.text()); return json({ ok: false, error: "could not save" }, 502); }
    const saved = (await r.json())[0] || row;
    console.log("floor-event:", kind, row.machine_uid || "", row.reason || "", "for user", dev.user_id);

    if (kind === "down") {
      /* machine label, not the internal uid - "VMC 850 #2 band ho gaya" */
      const label = String(body.machineLabel || row.machine_uid || "Machine").slice(0, 40);
      sendToOwner(dev.user_id, {
        title: label + " band ho gaya",
        body: (REASON_TEXT[reason] || reason) + (row.note ? " - " + row.note : ""),
        tag: "floor-down-" + row.machine_uid,
        url: "/?tab=floor",
      }).catch((e) => console.warn("floor-event: push failed -", e && e.message));
    }
    return json({ ok: true, event: saved });
  } catch (e) {
    console.error("floor-event: failed -", e && e.message);
    return json({ ok: false, error: "could not save" }, 502);
  }
};
