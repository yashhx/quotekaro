/* What a shop-floor phone is allowed to see (Netlify Functions v2).
   GET with header x-floor-token -> { ok, shopName, machines, jobs, events }

   This is the ONLY read a worker device gets, and it is deliberately narrow.
   The owner's shop_data holds quotes, money, Tally balances and customers'
   outstanding - none of it leaves this function. Only machine units, the
   running jobs (part, customer, quantity, timing) and the floor's own event
   log are returned. Worker phones therefore store no shop data of their own.

   The device token maps to exactly one owner (floor_devices.token). */

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

function svcHeaders() {
  const svc = process.env.SUPABASE_SERVICE_KEY;
  if (!svc) return null;
  const h = svc.startsWith("sb_") ? { apikey: svc } : { apikey: svc, authorization: "Bearer " + svc };
  return { ...h, "content-type": "application/json" };
}

/* token -> device row (and its owner). Also stamps last_seen so the owner can
   see which floor phones are actually being used. */
export async function deviceFromToken(url, hdrs, token) {
  if (!/^fl_[0-9a-f]{40}$/.test(String(token || ""))) return null;
  const r = await fetch(url + "/rest/v1/floor_devices?token=eq." + token + "&select=id,user_id,name", { headers: hdrs });
  if (!r.ok) return null;
  const rows = await r.json();
  const dev = rows[0];
  if (!dev) return null;
  fetch(url + "/rest/v1/floor_devices?id=eq." + dev.id, {
    method: "PATCH", headers: hdrs, body: JSON.stringify({ last_seen: new Date().toISOString() }),
  }).catch(() => {});
  return dev;
}

/* the whole point of this function: hand back the floor, and nothing else */
export function floorSlice(data) {
  const d = data || {};
  const machines = [];
  (d.machines || []).forEach((m) => {
    const n = Math.max(1, Number(m.count) || 1);
    /* uid MUST match machineUnits() in the app exactly - always id#n, even for
       a single machine - or the worker and the owner would disagree about
       which machine is which */
    for (let i = 1; i <= n; i++) machines.push({ uid: m.id + "#" + i, label: m.name + (n > 1 ? " #" + i : "") });
  });
  const jobs = (d.jobs || []).filter((j) => !j.done).map((j) => ({
    id: j.id, part: j.part, customer: j.customer || "", qty: Number(j.qty) || 0,
    cycleMin: Number(j.cycleMin) || 0, manualMin: Number(j.manualMin) || 0,
    startedAt: j.startedAt || 0,
    alloc: (j.alloc || (j.units || []).map((u) => ({ uid: u }))).map((a) => ({ uid: a.uid, share: Number(a.share) || 0, startedAt: a.startedAt || j.startedAt || 0, pausedAt: a.pausedAt || null, pausedMin: Number(a.pausedMin) || 0, stopped: !!a.stopped })),
  }));
  return { shopName: d.shopName || "", machines, jobs };
}

export default async (req) => {
  const url = process.env.SUPABASE_URL;
  const hdrs = svcHeaders();
  if (!url || !hdrs) return json({ ok: false, error: "needs cloud accounts" }, 501);

  const token = req.headers.get("x-floor-token") || "";
  let dev;
  try { dev = await deviceFromToken(url, hdrs, token); }
  catch (e) { console.error("floor-board: token lookup failed -", e && e.message); return json({ ok: false, error: "lookup failed" }, 502); }
  if (!dev) { console.warn("floor-board: rejected call with unknown device token"); return json({ ok: false, error: "device not paired" }, 401); }

  try {
    const s = await fetch(url + "/rest/v1/shop_data?user_id=eq." + dev.user_id + "&select=data", { headers: hdrs });
    const rows = s.ok ? await s.json() : [];
    const slice = floorSlice(rows[0] && rows[0].data);

    /* the floor's own log - the last three days is plenty for a shift */
    const since = Date.now() - 3 * 86400000;
    const e = await fetch(url + "/rest/v1/floor_events?user_id=eq." + dev.user_id + "&at=gte." + since +
      "&select=id,kind,machine_uid,from_uid,job_id,qty,rej,reason,note,payload,at&order=id.desc&limit=400", { headers: hdrs });
    const events = e.ok ? await e.json() : [];

    return json({ ok: true, device: { id: dev.id, name: dev.name }, ...slice, events });
  } catch (err) {
    console.error("floor-board: read failed -", err && err.message);
    return json({ ok: false, error: "could not read the board" }, 502);
  }
};
