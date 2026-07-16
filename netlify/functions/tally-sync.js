/* Cloud side of the Tally connector loop (Netlify Functions v2).
   The on-premise connector (connector/) calls this on an interval, sending
   the key issued by tally-key.js in the x-connector-key header. NO Netlify
   Blobs here - everything goes through Supabase REST with the service key.

   GET  -> { ok:true, shopName, pending:[{id, customer, phone, part, qty,
             pricePc, total, at, note}] }
           Won quotes not yet in Tally, oldest first, max 25 per pass.
   POST { results:[{quoteId, ok, detail?}], ledgers:[{name, balance}] }
        -> { ok:true, saved:n, ledgers:n }
           Records each push outcome in tally_sync and, when ledgers is an
           array, replaces the user's tally_ledgers rows wholesale.

   A quote leaves the pending feed only when a result says ok:true ("done");
   a failed push is stored as "error" and stays pending so the connector
   retries it - but only MAX_ATTEMPTS times. After that the quote is given up
   (visible in the tally_sync table) so a permanently-rejected quote can never
   monopolize the feed or hammer Tally forever. Quotes with no amount are
   never fed (Tally rejects zero-value vouchers), and never-tried quotes go
   ahead of failed retries so fresh wins are not starved. */

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const MAX_PENDING = 25;
const MAX_LEDGERS = 500;
const MAX_VOUCHERS = 500;
const MAX_DETAIL = 300;
const MAX_ATTEMPTS = 5;

/* legacy service_role JWTs go in both headers; new sb_secret_ keys in apikey only */
function svcHeaders() {
  const svc = process.env.SUPABASE_SERVICE_KEY;
  if (!svc) return null;
  return svc.startsWith("sb_") ? { apikey: svc } : { apikey: svc, authorization: "Bearer " + svc };
}

/* map the connector key to its owner; null when the key is unknown */
async function findTenant(url, hdrs, key) {
  try {
    const r = await fetch(url + "/rest/v1/tenants?connector_key=eq." + encodeURIComponent(key) + "&select=user_id", { headers: hdrs });
    if (!r.ok) { console.error("tally-sync: tenant lookup failed -", r.status); return null; }
    const rows = await r.json();
    return rows[0] || null;
  } catch (e) { console.error("tally-sync: tenant lookup failed -", e && e.message); return null; }
}

export default async (req) => {
  const url = process.env.SUPABASE_URL;
  const hdrs = svcHeaders();
  if (!url || !hdrs) { console.warn("tally-sync: Supabase not configured, Tally sync needs cloud accounts"); return json({ ok: false, error: "needs cloud accounts" }, 501); }

  const key = req.headers.get("x-connector-key") || "";
  if (!key.startsWith("tk_")) { console.warn("tally-sync: rejected call without a connector key"); return json({ ok: false, error: "connector key required" }, 401); }
  const tenant = await findTenant(url, hdrs, key);
  if (!tenant) { console.warn("tally-sync: rejected unknown connector key"); return json({ ok: false, error: "unknown connector key" }, 401); }
  const uid = encodeURIComponent(tenant.user_id);

  if (req.method === "GET") {
    try {
      const [dr, sr] = await Promise.all([
        fetch(url + "/rest/v1/shop_data?user_id=eq." + uid + "&select=data", { headers: hdrs }),
        fetch(url + "/rest/v1/tally_sync?user_id=eq." + uid + "&select=quote_id,status,attempts", { headers: hdrs }),
      ]);
      if (!dr.ok || !sr.ok) { console.error("tally-sync: read failed - shop_data", dr.status, "/ tally_sync", sr.status); return json({ ok: false, error: "could not read quotes" }, 500); }
      const data = ((await dr.json())[0] || {}).data || {};
      const tried = {}; /* quote_id -> {status, attempts} */
      (await sr.json()).forEach((s) => { if (s && s.quote_id != null) tried[String(s.quote_id)] = { status: s.status, attempts: Number(s.attempts) || 0 }; });
      const quotes = Array.isArray(data.quotes) ? data.quotes : [];
      let gaveUp = 0;
      const pending = quotes
        .filter((q) => {
          if (!q || q.status !== "won" || q.id == null) return false;
          if (!(Number(q.total) > 0)) return false; /* Tally rejects zero-value vouchers */
          const t = tried[String(q.id)];
          if (t && t.status === "done") return false;
          if (t && t.status === "error" && t.attempts >= MAX_ATTEMPTS) { gaveUp++; return false; }
          return true;
        })
        .sort((a, b) => {
          /* never-tried quotes first, so failed retries cannot starve fresh wins */
          const ea = tried[String(a.id)] ? 1 : 0, eb = tried[String(b.id)] ? 1 : 0;
          return ea - eb || (a.at || 0) - (b.at || 0);
        })
        .slice(0, MAX_PENDING)
        .map((q) => ({
          id: q.id, customer: q.customer || "", phone: q.phone || "", part: q.part || "",
          qty: Number(q.qty) || 0, pricePc: Number(q.pricePc) || 0, total: Number(q.total) || 0,
          at: q.at || 0, note: q.note || "",
        }));
      console.log("tally-sync: feeding", pending.length, "won quote(s) to the connector for", tenant.user_id, gaveUp ? "(" + gaveUp + " given up after " + MAX_ATTEMPTS + " failed tries)" : "");
      return json({ ok: true, shopName: data.shopName || "", pending });
    } catch (e) { console.error("tally-sync: pending feed failed -", e && e.message); return json({ ok: false, error: "could not read quotes" }, 500); }
  }

  if (req.method === "POST") {
    let body;
    try { body = await req.json(); } catch { console.warn("tally-sync: report body was not valid JSON"); return json({ ok: false, error: "bad json" }, 400); }

    /* 1. record push outcomes (upsert on the (user_id, quote_id) primary key).
          errors bump the attempts counter so the feed can give up after
          MAX_ATTEMPTS instead of retrying a doomed quote forever */
    const results = Array.isArray(body && body.results) ? body.results : [];
    const ids = results.filter((r) => r && r.quoteId != null && String(r.quoteId) !== "").map((r) => String(r.quoteId));
    let prevAttempts = {};
    if (ids.length) {
      try {
        const pr = await fetch(url + "/rest/v1/tally_sync?user_id=eq." + uid + "&quote_id=in.(" + ids.map((i) => '"' + encodeURIComponent(i).replace(/"/g, "") + '"').join(",") + ")&select=quote_id,attempts", { headers: hdrs });
        if (pr.ok) (await pr.json()).forEach((s) => { prevAttempts[String(s.quote_id)] = Number(s.attempts) || 0; });
      } catch (e) { console.warn("tally-sync: could not read previous attempts -", e && e.message); }
    }
    const rows = [];
    for (const r of results) {
      if (!r || r.quoteId == null || String(r.quoteId) === "") { console.warn("tally-sync: skipped a result row without a quoteId"); continue; }
      const qid = String(r.quoteId);
      rows.push({
        user_id: tenant.user_id,
        quote_id: qid,
        status: r.ok ? "done" : "error",
        detail: String(r.detail || "").slice(0, MAX_DETAIL),
        attempts: r.ok ? (prevAttempts[qid] || 0) : (prevAttempts[qid] || 0) + 1,
        synced_at: new Date().toISOString(),
      });
    }
    let saved = 0;
    if (rows.length) {
      try {
        const r = await fetch(url + "/rest/v1/tally_sync", {
          method: "POST",
          headers: { ...hdrs, "content-type": "application/json", prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify(rows),
        });
        if (!r.ok) { console.error("tally-sync: result upsert failed -", r.status, (await r.text()).slice(0, 200)); return json({ ok: false, error: "could not save results" }, 500); }
        saved = rows.length;
        console.log("tally-sync: saved", saved, "sync result(s) for", tenant.user_id);
      } catch (e) { console.error("tally-sync: result upsert failed -", e && e.message); return json({ ok: false, error: "could not save results" }, 500); }
    }

    /* 2. replace outstanding balances wholesale (old numbers are stale the
          moment Tally has newer ones) */
    let ledgers = 0;
    if (Array.isArray(body.ledgers)) {
      const seen = new Set();
      const lrows = [];
      for (const l of body.ledgers) {
        const name = l && l.name != null ? String(l.name).trim().slice(0, 80) : "";
        if (!name) { console.warn("tally-sync: skipped a ledger row without a name"); continue; }
        if (seen.has(name)) { console.warn("tally-sync: skipped duplicate ledger name", name); continue; }
        seen.add(name);
        lrows.push({ user_id: tenant.user_id, name, balance: Number(l.balance) || 0, grp: l.grp === "creditor" ? "creditor" : "debtor" });
        if (lrows.length >= MAX_LEDGERS) { console.warn("tally-sync: ledger list capped at", MAX_LEDGERS); break; }
      }
      try {
        const del = await fetch(url + "/rest/v1/tally_ledgers?user_id=eq." + uid, { method: "DELETE", headers: hdrs });
        if (!del.ok) {
          console.error("tally-sync: ledger clear failed -", del.status, "- keeping old balances");
        } else if (lrows.length) {
          const ins = await fetch(url + "/rest/v1/tally_ledgers", {
            method: "POST",
            headers: { ...hdrs, "content-type": "application/json", prefer: "return=minimal" },
            body: JSON.stringify(lrows),
          });
          if (!ins.ok) console.error("tally-sync: ledger insert failed -", ins.status, (await ins.text()).slice(0, 200));
          else { ledgers = lrows.length; console.log("tally-sync: stored", ledgers, "ledger balance(s) for", tenant.user_id); }
        } else {
          console.log("tally-sync: cleared ledger balances for", tenant.user_id, "(empty report)");
        }
      } catch (e) { console.error("tally-sync: ledger update failed -", e && e.message); }
    }

    /* 3. replace the recent-vouchers window (drives the Tally Insights page:
          tonnage shipped, recent dispatches, order progress) */
    let vouchers = 0;
    if (Array.isArray(body.vouchers)) {
      const seenV = new Set();
      const vrows = [];
      for (const v of body.vouchers) {
        const vkey = v && v.vkey != null ? String(v.vkey).trim().slice(0, 120) : "";
        if (!vkey || seenV.has(vkey)) continue;
        seenV.add(vkey);
        vrows.push({
          user_id: tenant.user_id, vkey,
          vdate: Number(v.vdate) || 0,
          vtype: String(v.vtype || "").slice(0, 30),
          vno: String(v.vno || "").trim().slice(0, 24),
          ref: String(v.ref || "").trim().slice(0, 32),
          party: String(v.party || "").trim().slice(0, 80),
          amount: Number(v.amount) || 0,
          item: String(v.item || "").trim().slice(0, 80),
          qty: Number(v.qty) || 0,
          unit: String(v.unit || "").trim().slice(0, 12),
          as_of: new Date().toISOString(),
        });
        if (vrows.length >= MAX_VOUCHERS) { console.warn("tally-sync: voucher list capped at", MAX_VOUCHERS); break; }
      }
      try {
        const del = await fetch(url + "/rest/v1/tally_vouchers?user_id=eq." + uid, { method: "DELETE", headers: hdrs });
        if (!del.ok) {
          console.error("tally-sync: voucher clear failed -", del.status, "- keeping old window (run supabase/tally.sql again?)");
        } else if (vrows.length) {
          const ins = await fetch(url + "/rest/v1/tally_vouchers", {
            method: "POST",
            headers: { ...hdrs, "content-type": "application/json", prefer: "return=minimal" },
            body: JSON.stringify(vrows),
          });
          if (!ins.ok) console.error("tally-sync: voucher insert failed -", ins.status, (await ins.text()).slice(0, 200));
          else { vouchers = vrows.length; console.log("tally-sync: stored", vouchers, "voucher(s) for", tenant.user_id); }
        }
      } catch (e) { console.error("tally-sync: voucher update failed -", e && e.message); }
    }

    return json({ ok: true, saved, ledgers, vouchers });
  }

  return json({ ok: false, error: "method not allowed" }, 405);
};
