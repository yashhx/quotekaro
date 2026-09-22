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
  /* a floor-started job carries its whole definition, so the owner's app can
     materialise it as a real job (with ETA maths) instead of a bare note */
  if (kind === "start" && body.payload && typeof body.payload === "object") {
    const p = body.payload;
    row.payload = {
      part: String(p.part || "").slice(0, 60),
      customer: String(p.customer || "").slice(0, 40),
      qty: num(p.qty) || 0,
      cycleMin: num(p.cycleMin) || 0,
      manualMin: num(p.manualMin) || 0,
      units: Array.isArray(p.units) ? p.units.slice(0, 12).map((u) => String(u).slice(0, 60)) : [],
    };
  }

  const insert = (body2) => fetch(url + "/rest/v1/floor_events", {
    method: "POST", headers: { ...hdrs, prefer: "return=representation" }, body: JSON.stringify(body2),
  });
  try {
    let r = await insert(row);
    /* floor.sql adds `payload` later than the first release - if the column is
       not there yet, save the event anyway rather than blocking the floor */
    if (!r.ok && row.payload) {
      const why = await r.text();
      if (/payload/i.test(why)) {
        console.warn("floor-event: payload column missing - re-run supabase/floor.sql. Saving without it.");
        const { payload, ...rest } = row;
        r = await insert(rest);
      } else { console.error("floor-event: insert failed", r.status, why); return json({ ok: false, error: "could not save" }, 502); }
    }
    if (!r.ok) { console.error("floor-event: insert failed", r.status, await r.text()); return json({ ok: false, error: "could not save" }, 502); }
    const saved = (await r.json())[0] || row;
    console.log("floor-event:", kind, row.machine_uid || "", row.reason || "", "for user", dev.user_id);

    /* Everything the floor does buzzes EXCEPT piece counts: a job starting or
       finishing, work moved to another machine, a machine stopping or coming
       back, and a note written to the owner. Counts are the only high-frequency
       event, and a buzz per piece gets notifications muted within a day.

       This MUST be awaited. A serverless container freezes the moment the
       response is sent, so a floating promise here simply never ran - the
       Test button worked (it awaits inside the handler) while real
       breakdowns silently sent nothing. */
    const label = String(body.machineLabel || row.machine_uid || "Machine").slice(0, 40);
    const part = (row.payload && row.payload.part) || row.note || "Kaam";
    const who = row.payload && row.payload.customer ? " - " + row.payload.customer : "";
    let alert = null;
    if (kind === "down") {
      alert = { title: label + " band ho gaya",
        body: (REASON_TEXT[reason] || reason) + (row.note ? " - " + row.note : ""),
        tag: "floor-down-" + row.machine_uid };
    } else if (kind === "start") {
      alert = { title: label + ": naya kaam shuru",
        body: part + who + (row.qty ? " \u00b7 " + row.qty + " pcs" : ""),
        tag: "floor-start-" + row.job_id };
    } else if (kind === "done") {
      alert = { title: label + ": kaam khatam",
        body: (row.qty ? row.qty + " piece" : "Job poora") + (row.rej ? " - " + row.rej + " reject" : ""),
        tag: "floor-done-" + row.job_id };
    } else if (kind === "move") {
      alert = { title: "Kaam doosri machine par",
        body: (row.qty ? row.qty + " pcs " : "") + part + " \u2192 " + label,
        tag: "floor-move-" + row.job_id };
    } else if (kind === "up") {
      alert = { title: label + " wapas chalu", body: "Machine phir se chal rahi hai", tag: "floor-up-" + row.machine_uid };
    } else if (kind === "note") {
      alert = { title: "Shop floor", body: row.note || "", tag: "floor-note-" + saved.id };
    }
    if (alert) {
      try {
        const res = await sendToOwner(dev.user_id, { ...alert, url: "/?tab=floor" });
        console.log("floor-event: push", kind, "->", JSON.stringify(res));
      } catch (e) { console.warn("floor-event: push failed -", e && e.message); }
    }
    return json({ ok: true, event: saved });
  } catch (e) {
    console.error("floor-event: failed -", e && e.message);
    return json({ ok: false, error: "could not save" }, 502);
  }
};
