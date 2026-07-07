#!/usr/bin/env node
/* QuoteKaro -> TallyPrime desktop connector.

   Runs on the accountant's Windows PC (any PC with Node 18+ works). Every
   minute it:
     1. asks the QuoteKaro cloud for WON quotes that are not in Tally yet,
     2. pushes each one into TallyPrime as a Sales Order voucher (creating
        the party ledger and stock item first if they do not exist),
     3. optionally reads customer outstanding balances (Sundry Debtors)
        from Tally and sends them back to the app,
     4. reports per-quote success/failure back to the cloud so nothing is
        imported twice.

   ZERO npm dependencies - Node 18+ built-ins only (fetch, crypto, fs, path).
   Config lives in config.json NEXT TO THIS FILE (see config.example.json).

   Flags:
     --once      run a single sync cycle and exit (good for testing)
     --dry-run   print the Tally XML instead of sending it; nothing is
                 written to Tally or the cloud

   Runbook for owners: TALLY_SETUP.md at the repo root. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* ---------------------------------------------------------------- basics */

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(SCRIPT_DIR, "config.json");
const ARGS = process.argv.slice(2);
const ONCE = ARGS.includes("--once");
const DRY_FLAG = ARGS.includes("--dry-run");

const pad = (n) => String(n).padStart(2, "0");
const stamp = () => {
  const d = new Date();
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
    " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
};
const log = (...a) => console.log("[" + stamp() + "]", ...a);
const warn = (...a) => console.warn("[" + stamp() + "] WARN:", ...a);
const err = (...a) => console.error("[" + stamp() + "] ERROR:", ...a);

/* ---------------------------------------------------------------- config */

function die(lines) {
  console.error("");
  for (const l of lines) console.error(l);
  console.error("");
  process.exit(1);
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    die([
      "Cannot find config.json.",
      "Expected it here: " + CONFIG_PATH,
      "",
      "Fix: copy config.example.json to config.json (same folder), then open",
      "the QuoteKaro app > Setup > Tally, copy your connector key and paste",
      "it into config.json as connectorKey."
    ]);
  }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
  catch (e) {
    die([
      "config.json exists but is not valid JSON: " + (e && e.message),
      "Tip: every value needs double quotes, and no trailing commas."
    ]);
  }
  const cfg = {
    cloudUrl: String(raw.cloudUrl || "").trim().replace(/\/+$/, ""),
    connectorKey: String(raw.connectorKey || "").trim(),
    tallyUrl: String(raw.tallyUrl || "http://localhost:9000").trim().replace(/\/+$/, ""),
    intervalSec: Math.max(15, Number(raw.intervalSec) || 60),
    voucherType: String(raw.voucherType || "Sales Order").trim() || "Sales Order",
    salesLedger: String(raw.salesLedger || "Sales").trim() || "Sales",
    dryRun: !!raw.dryRun || DRY_FLAG,
    pullOutstanding: raw.pullOutstanding !== false
  };
  if (!/^https?:\/\//i.test(cfg.cloudUrl)) {
    die([
      "cloudUrl in config.json does not look like a web address: \"" + cfg.cloudUrl + "\"",
      "It should look like: https://quotekaroo.netlify.app"
    ]);
  }
  if (!cfg.connectorKey || /paste/i.test(cfg.connectorKey) || !/^tk_[0-9a-f]{40}$/.test(cfg.connectorKey)) {
    die([
      "The connectorKey in config.json is missing or still the placeholder.",
      "",
      "Fix: open the QuoteKaro app > Setup > Tally, copy your connector key",
      "(it looks like tk_ followed by 40 letters and numbers) and paste it",
      "into config.json. Keep the quotes around it."
    ]);
  }
  return cfg;
}

/* ------------------------------------------------------------- XML tools */

const xmlEsc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&apos;");

const xmlUnesc = (s) => String(s == null ? "" : s)
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
  .replace(/&amp;/g, "&");

const money = (n) => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);

/* quote.at is a ms epoch; Tally wants yyyyMMdd (local date on this PC) */
const tallyDate = (ms) => {
  const d = new Date(Number(ms) || Date.now());
  return "" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
};

const cleanName = (s, fallback) => {
  const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, 100);
  return t || fallback;
};

/* The widely-used Tally "Import Data" envelope. We deliberately OMIT
   SVCURRENTCOMPANY so everything lands in the company currently open in
   TallyPrime (that is what small shops expect). */
const XML_PROLOG = '<?xml version="1.0" encoding="UTF-8"?>';
const tallyMsg = (inner) => '<TALLYMESSAGE xmlns:UDF="TallyUDF">' + inner + "</TALLYMESSAGE>";
const importEnvelope = (reportName, messages) =>
  XML_PROLOG +
  "<ENVELOPE>" +
  "<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>" +
  "<BODY><IMPORTDATA>" +
  "<REQUESTDESC><REPORTNAME>" + reportName + "</REPORTNAME></REQUESTDESC>" +
  "<REQUESTDATA>" + messages + "</REQUESTDATA>" +
  "</IMPORTDATA></BODY>" +
  "</ENVELOPE>";

/* Masters for one quote: the unit "Nos", the party ledger under Sundry
   Debtors, the sales ledger the voucher allocates to, and the stock item.
   ACTION="Create" + treating "already exists" replies as success makes this
   safe to send every time. */
function mastersXml(q, salesLedger) {
  const party = xmlEsc(cleanName(q.customer, "Unknown Customer"));
  const item = xmlEsc(cleanName(q.part, "Job Work"));
  const sales = xmlEsc(cleanName(salesLedger, "Sales"));
  return importEnvelope("All Masters",
    tallyMsg('<UNIT NAME="Nos" ACTION="Create"><NAME>Nos</NAME><ISSIMPLEUNIT>Yes</ISSIMPLEUNIT><DECIMALPLACES>0</DECIMALPLACES></UNIT>') +
    tallyMsg('<LEDGER NAME="' + party + '" ACTION="Create"><NAME>' + party + "</NAME><PARENT>Sundry Debtors</PARENT></LEDGER>") +
    tallyMsg('<LEDGER NAME="' + sales + '" ACTION="Create"><NAME>' + sales + "</NAME><PARENT>Sales Accounts</PARENT></LEDGER>") +
    tallyMsg('<STOCKITEM NAME="' + item + '" ACTION="Create"><NAME>' + item + "</NAME><BASEUNITS>Nos</BASEUNITS></STOCKITEM>")
  );
}

/* One voucher (default type "Sales Order") for one won quote.
   dateOverrideMs lets the caller retry with today's date when Tally rejects
   the quote's own date (before "books beginning from" etc). */
function voucherXml(q, voucherType, salesLedger, dateOverrideMs) {
  const party = xmlEsc(cleanName(q.customer, "Unknown Customer"));
  const item = xmlEsc(cleanName(q.part, "Job Work"));
  const sales = xmlEsc(cleanName(salesLedger, "Sales"));
  const total = Number(q.total) || 0;
  let qty = Number(q.qty) || 0;
  let rate = Number(q.pricePc) || 0;
  let qtyNote = "";
  if (!(qty > 0)) {
    /* logged quotes sometimes carry only a lump-sum amount - fall back to
       1 unit at the full amount so the voucher still balances */
    qty = 1;
    rate = total;
    qtyNote = "qty was missing, logged as 1 unit at the full amount";
  } else if (!Number.isInteger(qty)) {
    /* the connector-created "Nos" unit has 0 decimal places, and most
       existing Tally companies have the same - fractional qty would be
       rejected forever */
    const rounded = Math.max(1, Math.round(qty));
    qtyNote = "qty " + qty + " rounded to " + rounded + " (Tally unit Nos takes whole numbers)";
    qty = rounded;
    rate = total / qty;
  } else if (!(rate > 0)) {
    rate = total / qty;
  }
  const amount = money(total);
  const date = tallyDate(dateOverrideMs != null ? dateOverrideMs : q.at);
  const ref = xmlEsc("QK-" + String(q.id || "").slice(0, 8));
  /* REMOTEID gives the voucher a stable identity inside Tally, so an
     accidental second import of the same quote is recognizable */
  const rid = xmlEsc("QK-" + String(q.id || ""));
  const vt = xmlEsc(voucherType);
  const voucher =
    '<VOUCHER VCHTYPE="' + vt + '" ACTION="Create" REMOTEID="' + rid + '" OBJVIEW="Invoice Voucher View">' +
    "<DATE>" + date + "</DATE>" +
    "<EFFECTIVEDATE>" + date + "</EFFECTIVEDATE>" +
    "<VOUCHERTYPENAME>" + vt + "</VOUCHERTYPENAME>" +
    "<REFERENCE>" + ref + "</REFERENCE>" +
    "<PARTYLEDGERNAME>" + party + "</PARTYLEDGERNAME>" +
    "<PARTYNAME>" + party + "</PARTYNAME>" +
    "<BASICBASEPARTYNAME>" + party + "</BASICBASEPARTYNAME>" +
    "<PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW>" +
    (q.note ? "<NARRATION>" + xmlEsc(String(q.note).slice(0, 250)) + "</NARRATION>" : "") +
    "<ALLINVENTORYENTRIES.LIST>" +
    "<STOCKITEMNAME>" + item + "</STOCKITEMNAME>" +
    "<ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>" +
    "<RATE>" + money(rate) + "/Nos</RATE>" +
    "<ACTUALQTY>" + qty + " Nos</ACTUALQTY>" +
    "<BILLEDQTY>" + qty + " Nos</BILLEDQTY>" +
    "<AMOUNT>" + amount + "</AMOUNT>" +
    "<ACCOUNTINGALLOCATIONS.LIST>" +
    "<LEDGERNAME>" + sales + "</LEDGERNAME>" +
    "<ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>" +
    "<AMOUNT>" + amount + "</AMOUNT>" +
    "</ACCOUNTINGALLOCATIONS.LIST>" +
    "</ALLINVENTORYENTRIES.LIST>" +
    "<ALLLEDGERENTRIES.LIST>" +
    "<LEDGERNAME>" + party + "</LEDGERNAME>" +
    "<ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>" +
    "<AMOUNT>-" + amount + "</AMOUNT>" +
    "</ALLLEDGERENTRIES.LIST>" +
    "</VOUCHER>";
  return { xml: importEnvelope("Vouchers", tallyMsg(voucher)), qtyNote };
}

/* TDL Collection export: all ledgers under Sundry Debtors with their
   closing balances. */
function ledgerExportXml() {
  return XML_PROLOG + "<ENVELOPE>" +
    "<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>QuoteKaro Debtors</ID></HEADER>" +
    "<BODY><DESC>" +
    "<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>" +
    "<TDL><TDLMESSAGE>" +
    '<COLLECTION NAME="QuoteKaro Debtors" ISMODIFY="No">' +
    "<TYPE>Ledger</TYPE>" +
    "<CHILDOF>Sundry Debtors</CHILDOF>" +
    "<BELONGSTO>Yes</BELONGSTO>" + /* include debtors filed under sub-groups too */
    "<NATIVEMETHOD>Name</NATIVEMETHOD>" +
    "<NATIVEMETHOD>ClosingBalance</NATIVEMETHOD>" +
    "<FETCH>NAME,CLOSINGBALANCE</FETCH>" +
    "</COLLECTION>" +
    "</TDLMESSAGE></TDL>" +
    "</DESC></BODY>" +
    "</ENVELOPE>";
}

/* ------------------------------------------------------ Tally XML parsing */

/* Tally import replies carry <IMPORTRESULT> counters plus <LINEERROR> texts. */
function parseImportReply(text) {
  const t = String(text || "");
  const num = (tag) => {
    const m = t.match(new RegExp("<" + tag + ">\\s*(-?\\d+)"));
    return m ? Number(m[1]) : 0;
  };
  const lineErrors = [];
  const re = /<LINEERROR>([\s\S]*?)<\/LINEERROR>/gi;
  let m;
  while ((m = re.exec(t))) {
    const msg = xmlUnesc(m[1]).replace(/\s+/g, " ").trim();
    if (msg) lineErrors.push(msg);
  }
  return { created: num("CREATED"), altered: num("ALTERED"), errors: num("ERRORS"), lineErrors };
}

const isDuplicateErr = (s) => /already exists|duplicated?\b/i.test(String(s));

/* Tally XML output is quirky: BOM, stray control characters, sometimes
   numeric character references for control chars. Scrub, then pick
   NAME / CLOSINGBALANCE pairs per <LEDGER> block with regex. */
function parseLedgers(rawText) {
  let t = String(rawText || "");
  t = t.replace(/^\uFEFF/, "");
  t = t.replace(/&#(\d+);/g, (full, d) => (Number(d) >= 32 ? String.fromCharCode(Number(d)) : ""));
  t = t.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  const out = [];
  const blockRe = /<LEDGER\b([^>]*)>([\s\S]*?)<\/LEDGER>/gi;
  let m;
  while ((m = blockRe.exec(t))) {
    const attrs = m[1] || "";
    const body = m[2] || "";
    let name = "";
    const an = attrs.match(/NAME="([^"]*)"/i);
    if (an) name = an[1];
    if (!name) {
      const bn = body.match(/<NAME>([\s\S]*?)<\/NAME>/i);
      if (bn) name = bn[1];
    }
    name = xmlUnesc(name).replace(/\s+/g, " ").trim();
    if (!name) continue;
    let raw = 0;
    const bm = body.match(/<CLOSINGBALANCE[^>]*>([\s\S]*?)<\/CLOSINGBALANCE>/i);
    if (bm) {
      const numTxt = xmlUnesc(bm[1]).replace(/,/g, "").trim();
      const n = parseFloat(numTxt);
      if (Number.isFinite(n)) {
        /* tolerate "1234.00 Dr" / "1234.00 Cr" style output too */
        if (/\bDr\b/i.test(numTxt)) raw = -Math.abs(n);
        else if (/\bCr\b/i.test(numTxt)) raw = Math.abs(n);
        else raw = n;
      }
    }
    /* Tally XML shows debit balances as NEGATIVE numbers. A debtor who owes
       money is a debit, so flip the sign: positive = customer owes money. */
    out.push({ name: name.slice(0, 80), balance: -raw });
  }
  return out;
}

/* ------------------------------------------------------------- transport */

async function tallyPing(cfg) {
  try {
    const res = await fetch(cfg.tallyUrl, { method: "GET", signal: AbortSignal.timeout(8000) });
    const text = (await res.text()).trim();
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: (e && e.message) || "no response" };
  }
}

async function tallyPost(cfg, xml) {
  const res = await fetch(cfg.tallyUrl, {
    method: "POST",
    headers: { "content-type": "text/xml; charset=utf-8" },
    body: xml,
    signal: AbortSignal.timeout(30000)
  });
  return await res.text();
}

async function cloudFetchPending(cfg) {
  let res;
  try {
    res = await fetch(cfg.cloudUrl + "/.netlify/functions/tally-sync", {
      headers: { "x-connector-key": cfg.connectorKey },
      signal: AbortSignal.timeout(20000)
    });
  } catch (e) {
    throw new Error("could not reach the cloud (" + ((e && e.message) || "network error") + ") - check the internet connection");
  }
  if (res.status === 401) throw new Error("the cloud rejected the connector key - open the app Setup > Tally, copy the current key and paste it into config.json");
  if (res.status === 501) throw new Error("the cloud app does not have accounts set up (server is missing its Supabase settings)");
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error("the address in cloudUrl did not answer like QuoteKaro - check cloudUrl in config.json"); }
  if (!res.ok || !data.ok) throw new Error("cloud error: " + (data.error || ("HTTP " + res.status)));
  return data;
}

async function cloudPostResults(cfg, body) {
  let res;
  try {
    res = await fetch(cfg.cloudUrl + "/.netlify/functions/tally-sync", {
      method: "POST",
      headers: { "x-connector-key": cfg.connectorKey, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000)
    });
  } catch (e) {
    throw new Error("could not reach the cloud (" + ((e && e.message) || "network error") + ")");
  }
  if (res.status === 401) throw new Error("the cloud rejected the connector key");
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error("unexpected reply from the cloud (not JSON) - check cloudUrl in config.json"); }
  if (!res.ok || !data.ok) throw new Error("cloud error: " + (data.error || ("HTTP " + res.status)));
  return data;
}

/* ------------------------------------------------------------- one quote */

const isDateErr = (s) => /date|period|books|beginning|financial year/i.test(String(s));

async function pushQuote(cfg, q) {
  const label = cleanName(q.customer, "Unknown Customer") + " - " + cleanName(q.part, "item");

  /* 1. masters first (party + sales ledger + stock item + unit). Duplicates are fine. */
  const mReply = parseImportReply(await tallyPost(cfg, mastersXml(q, cfg.salesLedger)));
  const realMasterErrors = mReply.lineErrors.filter((e) => !isDuplicateErr(e));
  if (realMasterErrors.length) {
    warn("masters for " + label + ": " + realMasterErrors.join(" | ") + " (trying the voucher anyway)");
  }

  /* 2. the voucher itself */
  const { xml, qtyNote } = voucherXml(q, cfg.voucherType, cfg.salesLedger);
  let vReply = parseImportReply(await tallyPost(cfg, xml));
  let dateNote = "";
  if (!(vReply.created > 0 || vReply.altered > 0) && vReply.lineErrors.some(isDateErr)) {
    /* old quotes (e.g. imported from last year's Excel) can predate the Tally
       company's books - retry once dated today instead of failing forever */
    dateNote = "quote date was outside the Tally books, so it went in dated today";
    const retry = voucherXml(q, cfg.voucherType, cfg.salesLedger, Date.now());
    vReply = parseImportReply(await tallyPost(cfg, retry.xml));
  }
  if (vReply.created > 0 || vReply.altered > 0) {
    let detail = cfg.voucherType + " created in Tally";
    if (qtyNote) detail += " (" + qtyNote + ")";
    if (dateNote) detail += " (" + dateNote + ")";
    log("Sent to Tally: " + label + " - Rs " + Math.round(Number(q.total) || 0));
    if (qtyNote) log("  note: " + qtyNote);
    if (dateNote) log("  note: " + dateNote);
    return { quoteId: q.id, ok: true, detail: detail.slice(0, 300) };
  }

  const reason =
    vReply.lineErrors[0] ||
    (realMasterErrors[0] ? "master failed: " + realMasterErrors[0] : "") ||
    "Tally accepted the request but created nothing (check the voucher type in Tally)";
  log("Tally rejected: " + label + " - " + reason);
  return { quoteId: q.id, ok: false, detail: reason.slice(0, 300) };
}

/* ------------------------------------------------------------- one cycle */

async function cycle(cfg) {
  /* a) is Tally awake? */
  const ping = await tallyPing(cfg);
  if (!ping.ok) {
    if (cfg.dryRun) {
      warn("Tally is not reachable - is TallyPrime open with the gateway on? (dry run continues so you can still see the XML)");
    } else {
      warn("Tally is not reachable - is TallyPrime open with the gateway on? Skipping this round.");
      return;
    }
  } else if (ping.text && !/running/i.test(ping.text)) {
    warn("something answered at " + cfg.tallyUrl + " but it does not look like Tally (reply: " + ping.text.slice(0, 60) + ")");
  }

  /* b) what does the cloud want us to import? */
  let data;
  try { data = await cloudFetchPending(cfg); }
  catch (e) { err("cloud check failed - " + e.message); return; }
  const pending = Array.isArray(data.pending) ? data.pending : [];
  log("Cloud says " + pending.length + " won quote(s) waiting for Tally" + (data.shopName ? " (shop: " + data.shopName + ")" : ""));

  /* c+d) push each quote, REPORTING EACH RESULT TO THE CLOUD IMMEDIATELY.
     If the report only happened at the end of the cycle, a crash or closed
     window in between would leave the quote "pending" and import the same
     voucher into Tally AGAIN next round. Immediate reporting shrinks that
     window to almost nothing; anything that still fails to report is kept
     and retried in the end-of-cycle batch. */
  const unreported = [];
  let pushed = 0;
  for (const q of pending) {
    if (!q || !q.id) { warn("skipping a pending entry without an id"); continue; }
    try {
      if (cfg.dryRun) {
        const { xml, qtyNote } = voucherXml(q, cfg.voucherType, cfg.salesLedger);
        log("DRY RUN - masters + voucher XML for " + cleanName(q.customer, "Unknown Customer") + ":");
        console.log(mastersXml(q, cfg.salesLedger));
        console.log(xml);
        if (qtyNote) log("  note: " + qtyNote);
        continue;
      }
      const r = await pushQuote(cfg, q);
      pushed++;
      try { await cloudPostResults(cfg, { results: [r] }); }
      catch (e) { warn("could not report " + q.id + " to the cloud yet - " + e.message); unreported.push(r); }
    } catch (e) {
      const msg = (e && e.message) || "connector error";
      err("failed on quote " + q.id + " - " + msg);
      unreported.push({ quoteId: q.id, ok: false, detail: String(msg).slice(0, 300) });
    }
  }

  /* e) customer outstanding balances from Tally */
  let ledgers = null;
  if (cfg.pullOutstanding && ping.ok) {
    try {
      const reply = await tallyPost(cfg, ledgerExportXml());
      ledgers = parseLedgers(reply).slice(0, 500);
      log("Read " + ledgers.length + " customer balance(s) from Tally (Sundry Debtors)");
    } catch (e) {
      warn("could not read outstanding balances from Tally - " + ((e && e.message) || "error"));
      ledgers = null;
    }
  }

  /* f) report anything still unreported, plus the balances */
  if (cfg.dryRun) {
    log("DRY RUN - nothing was sent to Tally and nothing was saved to the cloud" +
      (Array.isArray(ledgers) ? " (would have sent " + ledgers.length + " balances)" : ""));
    return;
  }
  if (!unreported.length && !Array.isArray(ledgers)) {
    if (pushed) log("All " + pushed + " result(s) already saved to the cloud.");
    else log("Nothing to report to the cloud this round.");
    return;
  }
  try {
    const body = { results: unreported };
    if (Array.isArray(ledgers)) body.ledgers = ledgers;
    const resp = await cloudPostResults(cfg, body);
    log("Saved to cloud: " + (resp.saved || 0) + " sync result(s), " + (resp.ledgers || 0) + " balance(s)");
  } catch (e) {
    err("could not save results to the cloud - " + e.message + " (the same quotes may be retried next round)");
  }
}

/* ------------------------------------------------------------------ main */

const cfg = loadConfig();
log("QuoteKaro Tally connector starting" + (cfg.dryRun ? " (DRY RUN - nothing will be written)" : ""));
log("Cloud: " + cfg.cloudUrl);
log("Tally: " + cfg.tallyUrl + " | voucher type: " + cfg.voucherType + " | every " + cfg.intervalSec + "s");

if (ONCE) {
  try { await cycle(cfg); }
  catch (e) { err("cycle failed - " + ((e && e.stack) || e)); }
  log("Done (--once), exiting.");
} else {
  const tick = async () => {
    try { await cycle(cfg); }
    catch (e) { err("cycle failed - " + ((e && e.stack) || e)); }
    setTimeout(tick, cfg.intervalSec * 1000);
  };
  tick();
}
