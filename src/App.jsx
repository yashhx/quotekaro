import { useState, useEffect, useRef } from "react";
import { createClient } from "@supabase/supabase-js";

/* ---- Cloud accounts (Supabase), optional ----
   When VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are set at build time the app
   runs in CLOUD mode: real Google login, quotes synced to the user's private
   row (enforced by row-level security), WhatsApp inbox filtered per tenant.
   When absent (local dev / drag-drop build) everything behaves exactly like
   the original on-device prototype - same graceful degradation as WhatsApp. */
const SB_URL = import.meta.env.VITE_SUPABASE_URL || "";
const SB_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY || "";
/* detectSessionInUrl:false -> we run the OAuth code exchange ourselves so its
   error is visible instead of being swallowed into the console */
const sb = SB_URL && SB_ANON ? createClient(SB_URL, SB_ANON, { auth: { flowType: "pkce", detectSessionInUrl: false, persistSession: true, autoRefreshToken: true } }) : null;

/* bearer token for our Netlify functions (they verify it with Supabase) */
async function authHeaders() {
  if (!sb) return {};
  try {
    const { data } = await sb.auth.getSession();
    const t = data && data.session && data.session.access_token;
    return t ? { authorization: "Bearer " + t } : {};
  } catch { return {}; }
}

/* localStorage-backed storage shim — same async API the app expects,
   but works on any host (Vercel/Netlify). Each user's data stays on THEIR device. */
const storage = {
  get: async (k) => { const v = localStorage.getItem(k); return v == null ? null : { key: k, value: v }; },
  set: async (k, v) => { localStorage.setItem(k, v); return { key: k, value: v }; },
  delete: async (k) => { localStorage.removeItem(k); return { key: k, deleted: true }; },
};

/* Optional WhatsApp backend (Netlify Functions). Absent on static / drag-drop deploys,
   in which case every call resolves to "not available" and the app behaves fully offline. */
const WA_API = "/.netlify/functions";
async function fetchEnquiries() {
  try {
    const r = await fetch(WA_API + "/enquiries", { headers: { accept: "application/json", ...(await authHeaders()) } });
    const ct = r.headers.get("content-type") || "";
    if (!r.ok || !ct.includes("application/json")) return null; // functions not deployed (e.g. Vite dev serves index.html)
    const d = await r.json();
    return d && d.enabled ? (d.enquiries || []) : null;
  } catch { return null; }
}
async function markEnquiryHandled(id) {
  try { await fetch(WA_API + "/enquiries", { method: "POST", headers: { "content-type": "application/json", ...(await authHeaders()) }, body: JSON.stringify({ id }) }); } catch {}
}
async function sendWhatsApp(to, text) {
  try {
    const r = await fetch(WA_API + "/whatsapp-send", { method: "POST", headers: { "content-type": "application/json", ...(await authHeaders()) }, body: JSON.stringify({ to, text }) });
    return r.ok;
  } catch { return false; }
}
/* Optional AI enquiry reader (opt-in via Setup > Smart reading). Sends ONE
   message's text to our parse-enquiry function (Anthropic behind it), with
   phone numbers stripped first. Any failure returns null -> regex fallback. */
async function aiParseEnquiry(text) {
  try {
    const redacted = String(text).replace(/(?:\+?91[\s\-]?)?[6-9]\d{4}[\s\-]?\d{5}(?!\d)/g, "[phone]");
    const r = await fetch(WA_API + "/parse-enquiry", { method: "POST", headers: { "content-type": "application/json", ...(await authHeaders()) }, body: JSON.stringify({ text: redacted }) });
    const ct = r.headers.get("content-type") || "";
    if (!r.ok || !ct.includes("application/json")) return null;
    const d = await r.json();
    return d && d.ok && d.fields ? d.fields : null;
  } catch { return null; }
}
/* AI photo/PDF reader: the server fetches the WhatsApp media by id and shows it
   to Claude vision (handwriting-aware). Caption is redacted like any text.
   Any failure returns null -> the caption/regex path is used instead. */
async function aiReadMedia(mediaId, caption) {
  try {
    const redacted = String(caption || "").replace(/(?:\+?91[\s\-]?)?[6-9]\d{4}[\s\-]?\d{5}(?!\d)/g, "[phone]");
    const r = await fetch(WA_API + "/read-media", { method: "POST", headers: { "content-type": "application/json", ...(await authHeaders()) }, body: JSON.stringify({ mediaId, caption: redacted }) });
    const ct = r.headers.get("content-type") || "";
    if (!ct.includes("application/json")) return { fields: null, why: "backend missing" };
    const d = await r.json().catch(() => null);
    if (d && d.ok && d.fields) return { fields: d.fields };
    /* tell the caller WHY so the user isn't left guessing */
    const why = r.status === 401 ? "WhatsApp token expired" : r.status === 501 ? "AI not set up" : r.status === 429 ? "AI busy, try again" : "could not read it";
    return { fields: null, why };
  } catch { return { fields: null, why: "no internet" }; }
}

/* ---- Gmail connector (opt-in, cloud mode) ----
   The refresh token is captured once after a scoped Google OAuth round-trip
   and handed straight to the server; the browser never stores it. */
const GMAIL_FLAG = "quotekaro:gmail:connecting";
async function gmailStatus() {
  try {
    const r = await fetch(WA_API + "/gmail-connect", { headers: { accept: "application/json", ...(await authHeaders()) } });
    if (!(r.headers.get("content-type") || "").includes("application/json")) return null;
    const d = await r.json().catch(() => null);
    return d && d.ok ? d : null;
  } catch { return null; }
}
async function gmailSave(refreshToken, email) {
  try {
    const r = await fetch(WA_API + "/gmail-connect", { method: "POST", headers: { "content-type": "application/json", ...(await authHeaders()) }, body: JSON.stringify({ refreshToken, email }) });
    const d = await r.json().catch(() => null);
    return !!(d && d.ok);
  } catch { return false; }
}
async function gmailDisconnect() {
  try { await fetch(WA_API + "/gmail-connect", { method: "DELETE", headers: { ...(await authHeaders()) } }); } catch {}
}
async function gmailPollNow() {
  try {
    const r = await fetch(WA_API + "/gmail-poll", { method: "POST", headers: { accept: "application/json", ...(await authHeaders()) } });
    const d = await r.json().catch(() => null);
    return d && d.ok ? (d.found || 0) : null;
  } catch { return null; }
}

/* AI wins where it found something; regex fills the gaps. Phone always comes
   from the regex/local side - it never went to the AI. Note: aiReadMedia's
   `transcript` is deliberately NOT merged here - the caller adds it to the
   quote's note itself. */
const mergeParsed = (rx, ai) => ({
  customer: ai.customer || rx.customer, part: ai.part || rx.part,
  qty: ai.qty || rx.qty, rate: ai.rate || rx.rate, total: ai.total || rx.total,
  phone: rx.phone,
  followUp: (ai.followUp && parseDate(ai.followUp)) || rx.followUp,
});


/* ================================================================
   QuoteKaro v4 - white + forest green
   Adds: larger readable type, tappable home stats, field help text,
   PDF quotation export, liquid-glass nav w/ active state,
   NCR material library + Setup adder, demo supplier marketplace.
================================================================ */

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');

:root{
  --bg:#FFFFFF; --soft:#F4F8F4; --tint:#EBF5EC;
  --ink:#16201A; --dim:#56655B; --faint:#86958B;
  --grn:#228B22; --grn-d:#155E18; --grn-x:#3FAE45; --grn-100:#E5F4E6;
  --line:#E1EAE2; --line2:#D2DFD4;
  --amber:#9A5408; --amber-bg:#FBEFDD;
  --red:#9B2C2C; --red-bg:#FBEAEA;
  --disp:'Space Grotesk',sans-serif; --sans:'Inter',sans-serif; --mono:'IBM Plex Mono',monospace;
  --sh-s:0 1px 2px rgba(22,32,26,.05), 0 8px 24px -12px rgba(22,32,26,.12);
  --sh-m:0 2px 4px rgba(22,32,26,.05), 0 18px 44px -18px rgba(21,94,24,.22);
  --sh-l:0 4px 10px rgba(22,32,26,.06), 0 36px 80px -28px rgba(21,94,24,.3);
}
*{box-sizing:border-box; margin:0; padding:0; -webkit-tap-highlight-color:transparent;}
.qk-root{min-height:100vh; width:100%; display:flex; justify-content:center;
  background:radial-gradient(60% 40% at 50% 0%, rgba(34,139,34,.07), transparent 70%), linear-gradient(180deg,#F7FAF7,#EEF5EF);
  font-family:var(--sans); color:var(--ink);}
.app{width:100%; max-width:440px; height:100vh; height:100dvh; background:var(--bg);
  display:flex; flex-direction:column; position:relative; overflow:hidden;
  box-shadow:0 0 0 1px var(--line), 0 50px 120px -40px rgba(21,94,24,.35);}
@media(min-width:520px){.app{height:min(100dvh, 940px); margin:auto 0; border-radius:34px;}
  .qk-root{align-items:center; padding:18px 0;}}

.scr{flex:1; overflow-y:auto; overflow-x:hidden; -webkit-overflow-scrolling:touch; scrollbar-width:none;}
.scr::-webkit-scrollbar{display:none;}
.pagepad{padding:20px 18px 130px;}

.h-disp{font-family:var(--disp); letter-spacing:-.025em; line-height:1.08;}
.mono{font-family:var(--mono);}
.eyebrow{font-family:var(--mono); font-size:11px; letter-spacing:.2em; font-weight:600; color:var(--grn); text-transform:uppercase;}
.microlbl{font-family:var(--mono); font-size:10.5px; letter-spacing:.14em; font-weight:600; color:var(--faint); text-transform:uppercase;}
.grad{background:linear-gradient(95deg,#0F5132,#228B22 55%,#3FAE45); -webkit-background-clip:text; background-clip:text; color:transparent;}

.card{background:#fff; border:1px solid var(--line); border-radius:22px; box-shadow:var(--sh-s);}
.card-tint{background:var(--soft); border:1px solid var(--line); border-radius:22px;}
.hero-card{border-radius:26px; color:#fff; position:relative; overflow:hidden;
  background:linear-gradient(135deg,#1B7A20 0%,#228B22 55%,#2E9E33 100%); box-shadow:var(--sh-m);}
.hero-card::after{content:''; position:absolute; inset:0; pointer-events:none;
  background:radial-gradient(80% 60% at 85% -10%, rgba(255,255,255,.22), transparent 60%);}
.hero-card::before{content:''; position:absolute; right:-30px; bottom:-46px; width:170px; height:170px;
  border:1.5px solid rgba(255,255,255,.16); border-radius:42px; transform:rotate(18deg); pointer-events:none;}
.hero-lines{position:absolute; inset:0; pointer-events:none; overflow:hidden; border-radius:26px; z-index:0;}
.hero-lines svg{position:absolute; inset:0; width:100%; height:100%;}
.hero-lines path{fill:none; stroke:rgba(255,255,255,.16); stroke-width:1.5; stroke-dasharray:7 13;}
.hero-card > *{position:relative; z-index:1;}

.press{transition:transform .14s ease, box-shadow .14s ease;}
.press:active{transform:scale(.97);}

.btn{display:flex; align-items:center; justify-content:center; gap:8px; font-weight:600; font-size:16px;
  padding:16px 22px; border-radius:999px; border:1px solid transparent; cursor:pointer; font-family:var(--sans);
  transition:transform .15s ease, box-shadow .15s ease, opacity .15s;}
.btn:disabled{opacity:.4; pointer-events:none;}
.btn-grn{background:linear-gradient(135deg,#2E9E33,#1B7A20 65%); color:#fff;
  box-shadow:0 10px 26px -10px rgba(34,139,34,.6), inset 0 1px 0 rgba(255,255,255,.28);}
.btn-grn:active{transform:scale(.97);}
.btn-ghost{background:#fff; border-color:var(--line2); color:var(--ink); box-shadow:var(--sh-s);}
.btn-soft{background:var(--grn-100); color:var(--grn-d); border-color:#CFE9D1;}
.btn-sm{padding:11px 16px; font-size:14px;}

.input{width:100%; border:1.5px solid var(--line2); border-radius:14px; padding:15px 15px; font-size:17px;
  font-family:var(--sans); color:var(--ink); background:#fff; outline:none; transition:border-color .15s, box-shadow .15s;}
.input:focus{border-color:var(--grn); box-shadow:0 0 0 4px rgba(34,139,34,.12);}
.input.mono{font-family:var(--mono);}
.lbl{display:block; font-family:var(--disp); font-size:15px; font-weight:600; color:var(--ink); margin:0 0 3px 2px;}
.hint{display:block; font-size:12.5px; color:var(--dim); line-height:1.5; margin:0 0 9px 2px;}
.suffix-wrap{position:relative;}
.suffix-wrap .sfx{position:absolute; right:15px; top:50%; transform:translateY(-50%);
  font-family:var(--mono); font-size:13px; color:var(--faint); pointer-events:none;}

.chip{display:inline-flex; flex-direction:column; gap:3px; padding:13px 14px; border-radius:15px;
  border:1.5px solid var(--line2); background:#fff; cursor:pointer; transition:all .15s ease; min-width:0;}
.chip .cn{font-size:15px; font-weight:600; color:var(--ink);}
.chip .cr{font-family:var(--mono); font-size:12px; color:var(--faint);}
.chip.on{border-color:var(--grn); background:var(--grn-100); box-shadow:0 0 0 3px rgba(34,139,34,.12);}
.chip.on .cr{color:var(--grn-d);}

.pill{display:inline-flex; align-items:center; gap:5px; font-family:var(--mono); font-size:10px;
  letter-spacing:.1em; font-weight:600; padding:5px 11px; border-radius:999px;}
.pill.won{background:var(--grn-100); color:var(--grn-d);}
.pill.lost{background:var(--red-bg); color:var(--red);}
.pill.pend{background:var(--amber-bg); color:var(--amber);}
.dot{width:5px; height:5px; border-radius:50%; background:currentColor;}

.fpill{font-family:var(--sans); font-size:14px; font-weight:600; padding:10px 17px; border-radius:999px;
  border:1.5px solid var(--line2); background:#fff; color:var(--dim); cursor:pointer; transition:all .15s;}
.fpill.on{background:var(--ink); color:#fff; border-color:var(--ink);}
.catchip{display:inline-flex; align-items:center; gap:6px; white-space:nowrap; flex:0 0 auto;
  font-family:var(--sans); font-size:13.5px; font-weight:600; padding:8px 14px; border-radius:999px;
  border:1.5px solid var(--line2); background:#fff; color:var(--dim); cursor:pointer; transition:all .15s;}
.catchip.on{background:var(--grn-100); color:var(--grn-d); border-color:#CFE9D1;}
.cat-scroll{-ms-overflow-style:none; scrollbar-width:none;}
.cat-scroll::-webkit-scrollbar{display:none;}
.cat-tile:active{transform:scale(.98);}

/* ---- liquid glass nav (Apple-style) ---- */
.navbar{position:absolute; left:14px; right:14px; bottom:14px; z-index:40; isolation:isolate;
  background:linear-gradient(180deg, rgba(255,255,255,.1) 0%, rgba(255,255,255,.03) 100%);
  backdrop-filter:blur(22px) saturate(1.8) brightness(1.02);
  -webkit-backdrop-filter:blur(22px) saturate(1.8) brightness(1.02);
  border:1px solid rgba(255,255,255,.45); border-radius:32px;
  box-shadow:
    0 1.5px 0 rgba(255,255,255,.75) inset,
    0 -10px 22px -12px rgba(255,255,255,.45) inset,
    0 1px 1px rgba(255,255,255,.5),
    0 0 0 .5px rgba(22,32,26,.06),
    0 26px 50px -16px rgba(21,94,24,.3),
    0 8px 18px -8px rgba(22,32,26,.22);
  display:flex; align-items:center; justify-content:space-around; padding:8px;}
/* glossy top-half highlight, like light catching curved glass */
.navbar::before{content:''; position:absolute; left:6px; right:6px; top:5px; height:44%; border-radius:28px 28px 60% 60%;
  background:linear-gradient(180deg, rgba(255,255,255,.32), rgba(255,255,255,0)); pointer-events:none; z-index:0;}
/* diagonal refraction sweep */
.navbar::after{content:''; position:absolute; inset:0; border-radius:32px; pointer-events:none; z-index:0; opacity:.85;
  background:linear-gradient(118deg, transparent 30%, rgba(255,255,255,.55) 50%, transparent 66%);}
.nav-it{position:relative; display:flex; flex-direction:column; align-items:center; gap:3px; padding:9px 4px;
  border-radius:18px; color:var(--ink); cursor:pointer; transition:color .2s ease; border:none; background:none;
  font-family:var(--sans); flex:1; z-index:2; min-width:0; opacity:.62;}
.nav-it span{font-size:10.5px; font-weight:600; letter-spacing:.005em;}
.nav-it.on{color:var(--grn-d); opacity:1;}
.nav-pill{position:absolute; top:6px; bottom:6px; border-radius:15px; z-index:1;
  transition:left .34s cubic-bezier(.5,1.3,.5,1), width .34s cubic-bezier(.5,1.3,.5,1), opacity .2s ease;
  background:linear-gradient(160deg, rgba(255,255,255,.55), rgba(63,174,69,.26) 55%, rgba(34,139,34,.2));
  border:1px solid rgba(255,255,255,.5);
  box-shadow:0 1px 0 rgba(255,255,255,.8) inset, 0 0 0 .5px rgba(34,139,34,.25), 0 6px 14px -7px rgba(34,139,34,.55);}
.fab{width:60px; height:60px; border-radius:50%; border:none; cursor:pointer; flex-shrink:0; position:relative; z-index:2;
  background:linear-gradient(135deg,#34B33A,#1B7A20); color:#fff; display:flex; align-items:center; justify-content:center;
  box-shadow:0 14px 30px -8px rgba(34,139,34,.75), 0 0 0 5px rgba(255,255,255,.45), inset 0 1.5px 0 rgba(255,255,255,.5);
  transform:translateY(-14px); transition:transform .15s ease;}
.fab:active{transform:translateY(-14px) scale(.94);}

.steps{display:flex; gap:6px;}
.steps i{flex:1; height:5px; border-radius:3px; background:var(--line); transition:background .3s;}
.steps i.on{background:linear-gradient(90deg,#228B22,#3FAE45);}

.rowline{display:flex; justify-content:space-between; align-items:baseline; padding:11px 0; border-bottom:1px solid var(--line); font-size:15px;}
.rowline:last-child{border-bottom:none;}
.rowline .rl{color:var(--ink);}
.rowline .rl em{font-style:normal; font-family:var(--mono); font-size:10.5px; color:var(--faint); margin-left:6px;}
.rowline .rv{font-family:var(--mono); font-weight:500;}
.rowline.strong{background:var(--tint); margin:0 -16px; padding:11px 16px; border-radius:10px; border-bottom:none;}
.rowline.strong .rl,.rowline.strong .rv{font-weight:600; color:var(--grn-d);}

.runbar{position:absolute; left:14px; right:14px; bottom:14px; z-index:40;
  background:linear-gradient(135deg,#1B7A20,#228B22); color:#fff; border-radius:22px;
  padding:15px 18px; display:flex; justify-content:space-between; align-items:center; box-shadow:var(--sh-m);}
.runbar .rt{font-family:var(--mono); font-size:9.5px; letter-spacing:.16em; color:rgba(255,255,255,.78);}
.runbar .rp{font-family:var(--mono); font-size:23px; font-weight:600;}

.toast{position:absolute; top:16px; left:50%; transform:translateX(-50%); z-index:90;
  background:var(--ink); color:#fff; font-size:14px; font-weight:500; padding:12px 20px;
  border-radius:999px; box-shadow:var(--sh-m); animation:toastIn .25s ease; white-space:nowrap; max-width:92%;}

.segbar{height:10px; border-radius:5px; background:var(--line); overflow:hidden; display:flex;}
.segbar i{height:100%; transition:width .6s cubic-bezier(.2,.7,.3,1);}

@keyframes fadeUp{from{opacity:0; transform:translateY(14px);} to{opacity:1; transform:none;}}
@keyframes toastIn{from{opacity:0; transform:translate(-50%,-8px);} to{opacity:1; transform:translate(-50%,0);}}
@keyframes popIn{0%{opacity:0; transform:scale(.6);} 70%{transform:scale(1.06);} 100%{opacity:1; transform:scale(1);}}
@keyframes drawRing{from{stroke-dashoffset:166;} to{stroke-dashoffset:0;}}
@keyframes drawTick{from{stroke-dashoffset:48;} to{stroke-dashoffset:0;}}
@keyframes haloPulse{0%{box-shadow:0 0 0 0 rgba(34,139,34,.35);} 100%{box-shadow:0 0 0 26px rgba(34,139,34,0);}}
@keyframes growBar{from{transform:scaleY(0); transform-origin:bottom;} to{transform:scaleY(1); transform-origin:bottom;}}
.anim-in{animation:fadeUp .35s cubic-bezier(.2,.7,.3,1) both;}
.st1{animation-delay:.03s;}.st2{animation-delay:.08s;}.st3{animation-delay:.13s;}.st4{animation-delay:.18s;}
.st5{animation-delay:.23s;}.st6{animation-delay:.28s;}.st7{animation-delay:.33s;}.st8{animation-delay:.38s;}

input[type=range]{-webkit-appearance:none; width:100%; height:7px; border-radius:4px;
  background:linear-gradient(90deg,#228B22 var(--fill,50%), var(--line) var(--fill,50%)); outline:none;}
input[type=range]::-webkit-slider-thumb{-webkit-appearance:none; width:28px; height:28px; border-radius:50%;
  background:#fff; border:2.5px solid var(--grn); box-shadow:0 4px 12px rgba(34,139,34,.4); cursor:pointer;}

.wa-prev{background:#E7F6E9; border:1px solid #CBEAD2; border-radius:16px 16px 16px 4px; padding:16px;
  font-size:14px; line-height:1.6; color:#143A1B; white-space:pre-wrap; box-shadow:var(--sh-s);}
.iconbtn{width:40px; height:40px; border-radius:12px; border:1px solid var(--line2); background:#fff;
  display:flex; align-items:center; justify-content:center; color:var(--dim); cursor:pointer;}
.iconbtn:active{transform:scale(.94);}

/* marketplace */
.supplier{display:flex; align-items:center; gap:12px; padding:13px 14px; border:1px solid var(--line); border-radius:16px; background:#fff; margin-bottom:9px;}
.supplier .slogo{width:42px; height:42px; border-radius:12px; flex-shrink:0; display:flex; align-items:center; justify-content:center;
  font-family:var(--mono); font-weight:600; font-size:14px; color:#fff;}
.supplier .smid{flex:1; min-width:0;}
.supplier .sname{font-weight:600; font-size:14.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;}
.supplier .smeta{font-size:12px; color:var(--dim); margin-top:1px;}
.supplier .sprice{text-align:right; flex-shrink:0;}
.supplier .sp{font-family:var(--mono); font-weight:600; font-size:15px; color:var(--grn-d);}
.supplier .spu{font-family:var(--mono); font-size:9.5px; color:var(--faint);}
.demo-ribbon{display:inline-flex; align-items:center; gap:6px; font-family:var(--mono); font-size:10px; letter-spacing:.12em;
  font-weight:600; color:var(--amber); background:var(--amber-bg); border:1px solid #F0DCB8; padding:6px 12px; border-radius:999px;}

/* ---- auth screen ---- */
.auth{flex:1; display:flex; flex-direction:column; overflow-y:auto; scrollbar-width:none;}
.auth::-webkit-scrollbar{display:none;}
.auth-top{padding:54px 28px 30px; background:linear-gradient(160deg,#1B7A20,#228B22 60%,#2E9E33); color:#fff; position:relative; overflow:hidden;
  border-radius:0 0 32px 32px;}
.auth-top::after{content:''; position:absolute; right:-40px; top:-40px; width:180px; height:180px; border:1.5px solid rgba(255,255,255,.18); border-radius:46px; transform:rotate(20deg);}
.auth-logo{width:60px; height:60px; border-radius:18px; background:rgba(255,255,255,.16); border:1px solid rgba(255,255,255,.3);
  display:flex; align-items:center; justify-content:center; font-family:var(--mono); font-weight:600; font-size:20px; margin-bottom:18px; backdrop-filter:blur(8px);}
.auth-top h1{font-family:var(--disp); font-size:30px; font-weight:700; letter-spacing:-.03em;}
.auth-top p{font-size:14.5px; color:rgba(255,255,255,.9); margin-top:6px; max-width:280px;}
.auth-body{padding:28px 24px 36px;}
.seg{display:flex; background:var(--soft); border:1px solid var(--line); border-radius:14px; padding:4px; margin-bottom:24px;}
.seg button{flex:1; border:none; background:none; font-family:var(--sans); font-weight:600; font-size:14px; padding:11px; border-radius:11px; cursor:pointer; color:var(--dim); transition:all .2s;}
.seg button.on{background:#fff; color:var(--grn-d); box-shadow:var(--sh-s);}
.otp-row{display:flex; gap:9px; justify-content:space-between; margin:6px 0 4px;}
.otp-row input{width:100%; aspect-ratio:1; text-align:center; font-family:var(--mono); font-size:24px; font-weight:600; border:1.5px solid var(--line2); border-radius:14px; outline:none; transition:border-color .15s, box-shadow .15s; color:var(--ink);}
.otp-row input:focus{border-color:var(--grn); box-shadow:0 0 0 4px rgba(34,139,34,.12);}
.phone-field{display:flex; align-items:center; border:1.5px solid var(--line2); border-radius:14px; overflow:hidden; transition:border-color .15s, box-shadow .15s;}
.phone-field:focus-within{border-color:var(--grn); box-shadow:0 0 0 4px rgba(34,139,34,.12);}
.phone-field .cc{padding:15px 12px; background:var(--soft); font-family:var(--mono); font-size:16px; color:var(--ink); border-right:1.5px solid var(--line2); font-weight:600;}
.phone-field input{flex:1; border:none; outline:none; padding:15px; font-size:17px; font-family:var(--mono); letter-spacing:.04em; color:var(--ink); background:#fff;}
.auth-note{font-size:12px; color:var(--faint); text-align:center; line-height:1.6; margin-top:18px;}
.demo-hint{font-size:11.5px; color:var(--grn-d); background:var(--grn-100); border:1px solid #CFE9D1; border-radius:10px; padding:9px 12px; text-align:center; margin-top:14px;}

/* ---- subscribe ---- */
.plan{position:relative; border-radius:24px; padding:24px 22px; margin-bottom:16px; background:#fff; border:1.5px solid var(--line); box-shadow:var(--sh-s); transition:transform .2s, box-shadow .2s;}
.plan.pop{border:1.5px solid transparent; background:linear-gradient(#fff,#fff) padding-box, linear-gradient(140deg,#3FAE45,#228B22 55%,#155E18) border-box; box-shadow:var(--sh-l);}
.plan .badge{position:absolute; top:-13px; left:24px; background:linear-gradient(135deg,#2E9E33,#1B7A20); color:#fff; font-family:var(--mono); font-size:9.5px; letter-spacing:.14em; font-weight:600; padding:6px 14px; border-radius:999px; display:flex; align-items:center; gap:5px; box-shadow:0 8px 20px -6px rgba(34,139,34,.6);}
.plan .pname{font-family:var(--disp); font-size:20px; font-weight:700;}
.plan .ptag{font-size:13px; color:var(--dim); margin-top:2px;}
.plan .prow{display:flex; align-items:baseline; gap:4px; margin:16px 0 4px;}
.plan .pcur{font-family:var(--disp); font-size:22px; font-weight:700; color:var(--grn-d);}
.plan .pamt{font-family:var(--disp); font-size:40px; font-weight:700; color:var(--grn-d); line-height:1;}
.plan .pper{font-size:13px; color:var(--faint);}
.plan ul{list-style:none; margin:18px 0 20px; display:flex; flex-direction:column; gap:11px;}
.plan li{display:flex; align-items:flex-start; gap:10px; font-size:14px; color:#39483D;}
.plan li .ci{width:20px; height:20px; border-radius:50%; background:var(--grn-100); color:var(--grn-d); display:flex; align-items:center; justify-content:center; flex-shrink:0; margin-top:1px;}
.plan-current{font-family:var(--mono); font-size:11px; letter-spacing:.1em; color:var(--grn-d); background:var(--grn-100); border:1px solid #CFE9D1; padding:5px 12px; border-radius:999px; font-weight:600;}
`;

/* ---------------- icons ---------------- */
const I = {
  home: (p) => (<svg width="23" height="23" viewBox="0 0 24 24" fill="none" {...p}><path d="M3.5 10.5 12 3.5l8.5 7v8.2a1.8 1.8 0 0 1-1.8 1.8h-3.4v-6.1H8.7v6.1H5.3a1.8 1.8 0 0 1-1.8-1.8v-8.2Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/></svg>),
  list: (p) => (<svg width="23" height="23" viewBox="0 0 24 24" fill="none" {...p}><path d="M8.5 6.5h11M8.5 12h11M8.5 17.5h11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/><circle cx="4.6" cy="6.5" r="1.3" fill="currentColor"/><circle cx="4.6" cy="12" r="1.3" fill="currentColor"/><circle cx="4.6" cy="17.5" r="1.3" fill="currentColor"/></svg>),
  gear: (p) => (<svg width="23" height="23" viewBox="0 0 24 24" fill="none" {...p}><circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.8"/><path d="M12 2.8v2.6M12 18.6v2.6M21.2 12h-2.6M5.4 12H2.8M18.5 5.5l-1.9 1.9M7.4 16.6l-1.9 1.9M18.5 18.5l-1.9-1.9M7.4 7.4 5.5 5.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>),
  plus: (p) => (<svg width="27" height="27" viewBox="0 0 24 24" fill="none" {...p}><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"/></svg>),
  back: (p) => (<svg width="21" height="21" viewBox="0 0 24 24" fill="none" {...p}><path d="m14.5 6-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>),
  wa: (p) => (<svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M12 2a9.9 9.9 0 0 0-8.5 15L2 22l5.2-1.4A9.9 9.9 0 1 0 12 2Zm5.6 14c-.24.66-1.4 1.3-1.93 1.34-.52.05-1 .24-3.4-.7-2.87-1.13-4.7-4.05-4.84-4.24-.14-.19-1.16-1.55-1.16-2.95s.74-2.09 1-2.38c.26-.28.57-.35.76-.35h.55c.18 0 .42-.06.65.5.24.57.8 1.97.87 2.11.07.14.12.31.02.5-.09.19-.14.3-.28.47-.14.17-.3.37-.43.5-.14.14-.29.3-.12.58.16.28.73 1.2 1.57 1.95 1.08.96 1.99 1.26 2.27 1.4.28.14.45.12.61-.07.17-.19.7-.82.89-1.1.19-.28.38-.23.64-.14.26.1 1.65.78 1.93.92.28.14.47.21.54.33.07.12.07.66-.17 1.32Z"/></svg>),
  copy: (p) => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...p}><rect x="8.5" y="8.5" width="11" height="11" rx="2.5" stroke="currentColor" strokeWidth="1.7"/><path d="M5.5 14.5h-.7A2.3 2.3 0 0 1 2.5 12.2V4.8A2.3 2.3 0 0 1 4.8 2.5h7.4a2.3 2.3 0 0 1 2.3 2.3v.7" stroke="currentColor" strokeWidth="1.7"/></svg>),
  pdf: (p) => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...p}><path d="M6.5 2.5h7l5 5v12.5a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 20V4a1.5 1.5 0 0 1 1.5-1.5Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/><path d="M13 2.5V8h5.5" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/><path d="M8.5 13.5h7M8.5 16.5h5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></svg>),
  trash: (p) => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...p}><path d="M4 6.5h16M9 6V4.6A1.6 1.6 0 0 1 10.6 3h2.8A1.6 1.6 0 0 1 15 4.6V6M6.2 6.5l.9 12.1a2 2 0 0 0 2 1.9h5.8a2 2 0 0 0 2-1.9l.9-12.1" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></svg>),
  bolt: (p) => (<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M13.2 2 4.5 13.4h6l-1.7 8.6 8.7-11.4h-6L13.2 2Z"/></svg>),
  chev: (p) => (<svg width="17" height="17" viewBox="0 0 24 24" fill="none" {...p}><path d="m9 6 6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>),
  store: (p) => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" {...p}><path d="M4 9.5 5.2 4.5h13.6L20 9.5M4 9.5h16M4 9.5v9a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 18.5v-9M4 9.5a2.2 2.2 0 0 0 4 1 2.2 2.2 0 0 0 4 0 2.2 2.2 0 0 0 4 0 2.2 2.2 0 0 0 4-1" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/></svg>),
  help: (p) => (<svg width="23" height="23" viewBox="0 0 24 24" fill="none" {...p}><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8"/><path d="M9.4 9.3a2.6 2.6 0 0 1 5 .9c0 1.7-2.4 2.1-2.4 3.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/><circle cx="12" cy="17" r="1.15" fill="currentColor"/></svg>),
  phone: (p) => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...p}><path d="M6.5 3.5h3l1.4 4-2 1.4a12 12 0 0 0 6.2 6.2l1.4-2 4 1.4v3a2 2 0 0 1-2.1 2A16 16 0 0 1 4.5 5.6 2 2 0 0 1 6.5 3.5Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/></svg>),
  chart: (p) => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...p}><path d="M4 20h16M7 20v-7M12 20V8M17 20v-4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"/></svg>),
  lock: (p) => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...p}><rect x="5" y="10.5" width="14" height="10" rx="2.5" stroke="currentColor" strokeWidth="1.8"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="1.8"/></svg>),
  user: (p) => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...p}><circle cx="12" cy="8" r="3.6" stroke="currentColor" strokeWidth="1.8"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>),
  check2: (p) => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" {...p}><path d="m5 12.5 4.5 4.5L19 6.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/></svg>),
  star: (p) => (<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" {...p}><path d="m12 2 2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 18l-6.1 3.4 1.4-6.8-5.1-4.7 6.9-.8L12 2Z"/></svg>),
  logout: (p) => (<svg width="17" height="17" viewBox="0 0 24 24" fill="none" {...p}><path d="M14 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-2M9 12h11m0 0-3-3m3 3-3 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>),
  crown: (p) => (<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M3 7l4 4 5-6 5 6 4-4-2 12H5L3 7Z"/></svg>),
  phone2: (p) => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...p}><rect x="6.5" y="2.5" width="11" height="19" rx="2.5" stroke="currentColor" strokeWidth="1.8"/><path d="M10.5 18.5h3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>),
  search: (p) => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...p}><circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8"/><path d="m20 20-3.6-3.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>),
  cal: (p) => (<svg width="17" height="17" viewBox="0 0 24 24" fill="none" {...p}><rect x="3.5" y="5" width="17" height="15.5" rx="2.5" stroke="currentColor" strokeWidth="1.7"/><path d="M3.5 9.5h17M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></svg>),
  sheet: (p) => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...p}><rect x="4" y="3.5" width="16" height="17" rx="2.5" stroke="currentColor" strokeWidth="1.7"/><path d="M4 9h16M4 14.5h16M9.5 9v11.5M14.5 9v11.5" stroke="currentColor" strokeWidth="1.5"/></svg>),
  down: (p) => (<svg width="17" height="17" viewBox="0 0 24 24" fill="none" {...p}><path d="M12 4v11m0 0 4-4m-4 4-4-4M5 19.5h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>),
  up: (p) => (<svg width="17" height="17" viewBox="0 0 24 24" fill="none" {...p}><path d="M12 20V9m0 0 4 4m-4-4-4 4M5 4.5h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>),
  bell: (p) => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...p}><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/><path d="M10 19a2 2 0 0 0 4 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></svg>),
  pen: (p) => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" {...p}><path d="M4 20h4L18.5 9.5a2 2 0 0 0 0-2.8l-1.2-1.2a2 2 0 0 0-2.8 0L4 16v4Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/></svg>),
};

/* ---------------- helpers ---------------- */
const inr = (n, d = 0) => "₹" + Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
const uid = () => Math.random().toString(36).slice(2, 9);
const KEY = "quotekaro:v5";
const AUTH_KEY = "quotekaro:auth:v1";

/* ---- date + number helpers ---- */
const DAY = 86400000;
const num = (v) => { const n = parseFloat(String(v).replace(/[^0-9.\-]/g, "")); return isNaN(n) ? 0 : n; };
const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const fdateShort = (t) => new Date(t).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
const isoDate = (t) => { const d = new Date(t); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
/* parse a loosely-formatted date cell (ISO, dd/mm/yyyy, dd-mm-yy, Excel serial) into ms, or null */
const parseDate = (v) => {
  if (v == null || v === "") return null;
  if (typeof v === "number" && v > 20000 && v < 90000) return Math.round((v - 25569) * DAY); /* Excel serial */
  const s = String(v).trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3]).getTime();
  const dmy = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/.exec(s);
  if (dmy) { let y = +dmy[3]; if (y < 100) y += 2000; return new Date(y, +dmy[2] - 1, +dmy[1]).getTime(); }
  const t = Date.parse(s); return isNaN(t) ? null : t;
};
/* follow-up state for a live (pending) quote: overdue | today | upcoming | null */
const followState = (q) => {
  if (!q.followUp || q.status !== "pending") return null;
  const today = startOfDay(Date.now()), fu = startOfDay(q.followUp);
  return fu < today ? "overdue" : fu === today ? "today" : "upcoming";
};

/* ---- WhatsApp helpers ---- */
const waLink = (phone, text) => {
  const p = (phone || "").replace(/\D/g, "");
  const digits = p && p.length === 10 ? "91" + p : p; /* default to +91 for bare 10-digit numbers */
  return "https://wa.me/" + digits + "?text=" + encodeURIComponent(text);
};
const waFollowText = (q, shop) =>
  `Hi, this is ${shop}.\n` +
  `Just following up on our quotation for *${q.part}*` + (q.qty ? ` (${q.qty} pcs)` : "") + `.\n` +
  `Quoted ${inr(q.total)}. Please let us know if we can proceed or if any change is needed.\nThank you.`;
/* Pull structured fields out of a pasted WhatsApp / enquiry message.
   Conservative, Hinglish-aware heuristics: every guess lands in an editable
   field, so prefer a decent guess over an empty box - the user checks anyway.
   Returns { customer, part, qty, rate, total, phone, followUp (ms or null) }. */
const MONTHS3 = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const cleanFrag = (s) => String(s || "").replace(/[*_~]/g, "").replace(/\s+/g, " ").replace(/^[\s:,\-]+|[\s:,\-.]+$/g, "").trim();
const parseEnquiry = (raw) => {
  const text = String(raw || "");
  const out = { customer: "", part: "", qty: "", rate: "", total: "", phone: "", followUp: null };

  /* phone: Indian mobile anywhere in the text, spaces/dashes tolerated */
  const ph = /(?:\+?91[\s\-]?)?([6-9]\d{4}[\s\-]?\d{5})(?!\d)/.exec(text);
  if (ph) out.phone = ph[1].replace(/\D/g, "");

  /* quantity: "500 pcs" / "qty: 500" / "quantity - 500" / "500 nos" */
  const q1 = /(?:qty|quantity)\s*[:\-=]?\s*([\d,]{1,7})/i.exec(text)
    || /([\d,]{1,7})\s*(?:pcs?\b|pieces?\b|nos?\b\.?|units?\b|qty\b|quantity\b)/i.exec(text);
  if (q1) out.qty = q1[1].replace(/,/g, "");

  /* rate per piece: "82/pc", "rs 82 per piece", "@110 each" */
  const r1 = /(?:rs\.?|inr|@|₹)?\s*([\d,]+(?:\.\d+)?)\s*(?:\/\s*(?:pcs?|piece|nos?|unit)|per\s*(?:pc|piece|unit|nos)|each\b)/i.exec(text);
  if (r1) out.rate = r1[1].replace(/,/g, "");

  /* total: currency amounts, skipping any that were actually a per-piece rate */
  const money = /(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d+)?)/gi;
  let m;
  while ((m = money.exec(text))) {
    const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 12);
    if (/^\s*(?:\/|per\b|each\b)/i.test(tail)) continue;
    out.total = m[1].replace(/,/g, "");
    break;
  }
  if (!out.total) {
    const t2 = /([\d,]{4,})\s*(?:\/\-|only\b|rupees\b|total\b)/i.exec(text);
    if (t2) out.total = t2[1].replace(/,/g, "");
  }
  if (!out.total && out.rate && out.qty) out.total = String(Math.round(parseFloat(out.rate) * parseInt(out.qty, 10)));

  /* a date in the message ("by 15/7", "delivery 20 July", "tomorrow") -> follow-up */
  const today = startOfDay(Date.now());
  let fu = null;
  const d1 = /(?:^|[^\d/\-.])(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2,4}))?(?![\d/\-.])/.exec(text);
  if (d1) {
    const dd = +d1[1], mo = +d1[2] - 1;
    if (dd >= 1 && dd <= 31 && mo >= 0 && mo <= 11) {
      const yy = d1[3] ? (+d1[3] < 100 ? +d1[3] + 2000 : +d1[3]) : new Date(today).getFullYear();
      let ts = new Date(yy, mo, dd).getTime();
      if (!d1[3] && ts < today) ts = new Date(yy + 1, mo, dd).getTime(); /* "by 15/1" said in Dec */
      /* reject dates that rolled over (31/2 would become 2-3 March) */
      if (new Date(ts).getDate() === dd) fu = ts;
    }
  }
  if (fu == null) {
    const d2 = /(\d{1,2})\s*(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/i.exec(text)
      || /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})\b/i.exec(text);
    if (d2) {
      const dd = +(/^\d+$/.test(d2[1]) ? d2[1] : d2[2]);
      const mo = MONTHS3[(/^\d+$/.test(d2[1]) ? d2[2] : d2[1]).slice(0, 3).toLowerCase()];
      if (dd >= 1 && dd <= 31 && mo != null) {
        let ts = new Date(new Date(today).getFullYear(), mo, dd).getTime();
        if (ts < today) ts = new Date(new Date(today).getFullYear() + 1, mo, dd).getTime();
        /* reject dates that rolled over ("31 feb") */
        if (new Date(ts).getDate() === dd) fu = ts;
      }
    }
  }
  if (fu == null && /\btomorrow\b/i.test(text)) fu = today + DAY;
  out.followUp = fu;

  /* part / item name - try explicit labels first, then sentence patterns */
  const p1 = /(?:part|item|product|drawing|job)\s*(?:name)?\s*[:\-]\s*([^\n,;.]{2,60})/i.exec(text);
  const p2 = /(?:quote|quotation|rate|price|estimate)\s+(?:for|of)\s+(?:the\s+)?([^\n,;.]{3,60})/i.exec(text);
  const p3 = /(?:pcs?|pieces?|nos?\.?|units?)\s+(?:of\s+)?([a-zA-Z][^\n,;.]{2,60})/i.exec(text);
  const p4 = /(?:need|want|require|order)\s+(?:a\s+|an\s+|some\s+)?([a-zA-Z][^\n,;.]{3,60})/i.exec(text);
  /* Hindi word orders: "spacer 18mm chahiye" (part BEFORE) and "chahiye gland nut ka" (part AFTER) */
  const p5 = /([a-zA-Z][^\n,;.]{2,60}?)\s+(?:chahiye|chaiye|banwana)/i.exec(text);
  const p6 = /(?:chahiye|chaiye|banwana)\s+([a-zA-Z][^\n,;.]{2,60}?)(?:\s+(?:ka|ki|ke)\b|\s*$)/im.exec(text);
  const p5ok = p5 && !/^(?:quote|quotation|rate|price|estimate|urgent)/i.test(cleanFrag(p5[1])) ? p5[1] : "";
  let part = cleanFrag((p1 && p1[1]) || (p2 && p2[1]) || (p3 && p3[1]) || (p4 && p4[1]) || p5ok || (p6 && p6[1]) || "");
  part = part.replace(/\s*(?:rs\.?|inr|@|₹)\s*[\d,]+.*$/i, "");                       /* cut price tails */
  part = part.replace(/\s*[\d,]{1,7}\s*(?:pcs?\b|pieces?\b|nos?\b\.?|units?\b|qty\b|quantity\b).*$/i, ""); /* cut qty tails */
  part = part.replace(/\s+(?:chahiye|chaiye|urgent(?:ly)?|asap|please|pls|kindly)\b.*$/i, "");
  part = part.replace(/\s+(?:ka|ki|ke)\s*$/i, ""); /* trailing Hindi possessive: "gland nut ka" */
  part = part.replace(/\s+(?:by|before|till|until|tak)\s+\d.*$/i, ""); /* date tails: "flange by 20/7" */
  out.part = cleanFrag(part).slice(0, 60);

  /* customer: "this is X" / "I am X" / "from X" / a plain short first line */
  const c1 = /(?:this is|i am|i'm|myself)\s+([a-zA-Z][a-zA-Z .&'()]{1,38})/i.exec(text);
  const c2 = /\bfrom\s+([A-Z][a-zA-Z .&'()]{2,38})/.exec(text);
  let customer = cleanFrag((c1 && c1[1]) || (c2 && c2[1]) || "");
  customer = cleanFrag(customer.split(/[.\n!?]/)[0]); /* stop at sentence end */
  customer = customer.replace(/\s+(?:here|need|want|require|regarding|about|please|pls|kindly|and|quote|quotation)\b.*$/i, "");
  if (!customer) {
    const firstLine = text.split(/\n/).map((l) => l.trim()).filter(Boolean)[0] || "";
    if (firstLine && firstLine.length < 42 && !/\d{3,}/.test(firstLine) &&
      !/(need|want|require|quote|quotation|rate|price|pcs|kindly|please|chahiye|urgent)/i.test(firstLine))
      customer = cleanFrag(firstLine.replace(/^(?:hi|hello|namaste|hey|dear)\b[,!\s]*/i, ""));
  }
  out.customer = customer.slice(0, 40);
  return out;
};

/* Subscription plans - prices are demo; wire real Razorpay/UPI at the marked hook before charging. */
const PLANS = [
  { id: "starter", name: "Starter", price: 2500, tagline: "For small shops finding their feet",
    features: ["Unlimited quotations", "WhatsApp & PDF export", "Customer & quote history", "1 user", "True hourly-rate calculator"], accent: "#3FAE45" },
  { id: "growth", name: "Growth", price: 6000, tagline: "For working shops quoting every week", popular: true,
    features: ["Everything in Starter", "Win / loss analytics", "Up to 3 users", "Material library + rate alerts", "Priority WhatsApp support"], accent: "#228B22" },
  { id: "pro", name: "Pro", price: 12000, tagline: "For multi-machine shops running daily",
    features: ["Everything in Growth", "Job / production tracking", "Unlimited users", "Multi-machine loaded rates", "Dedicated onboarding & support"], accent: "#155E18" },
];

/* NCR material library (editable seed rates - owner corrects to real) */
const MAT_LIB = [
  { name: "MS (EN8)", rate: 72 }, { name: "Mild Steel (EN1A)", rate: 60 },
  { name: "EN9", rate: 78 }, { name: "EN19", rate: 95 }, { name: "EN24", rate: 120 },
  { name: "EN31 (Bearing)", rate: 98 }, { name: "EN8D", rate: 80 },
  { name: "42CrMo4", rate: 130 }, { name: "IS2062 Plate", rate: 65 },
  { name: "SS 304", rate: 250 }, { name: "SS 316", rate: 330 }, { name: "SS 202", rate: 180 },
  { name: "Alu 6061", rate: 300 }, { name: "Alu 7075", rate: 520 }, { name: "Alu (scrap-grade)", rate: 210 },
  { name: "Brass", rate: 560 }, { name: "Copper", rate: 790 }, { name: "Cast Iron", rate: 70 },
  { name: "Nylon / POM", rate: 280 }, { name: "Gunmetal", rate: 620 },
];

/* demo marketplace suppliers (CONCEPT - not real vendors) */
const SUPPLIERS = [
  { co: "Faridabad Steel Syndicate", area: "Sector 24, Faridabad", mat: "EN8 / EN9 / EN31 round bar", rate: 70, unit: "/kg · 60-day terms", color: "#1B7A20" },
  { co: "Manesar Metals", area: "IMT Manesar", mat: "SS 304 / 316 bar & plate", rate: 244, unit: "/kg · cash", color: "#2E9E33" },
  { co: "Capital Alloys", area: "Wazirpur, Delhi", mat: "Aluminium 6061 / 7075", rate: 296, unit: "/kg · 30-day terms", color: "#155E18" },
  { co: "Sharma Non-Ferrous", area: "Ballabgarh", mat: "Brass / Copper / Gunmetal", rate: 555, unit: "/kg · cash", color: "#3FAE45" },
];

const seedData = () => {
  const now = Date.now(), day = 86400000;
  return {
    shopName: "Sharma Precision Works",
    settings: { overheadPct: 18, marginPct: 25, labourRate: 80, validityDays: 7, gstPct: 18 },
    machines: [{ id: "m1", name: "VMC 850", rate: 366 }],
    materials: [
      { id: "a", name: "MS (EN8)", rate: 85 }, { id: "b", name: "SS 304", rate: 250 },
      { id: "c", name: "Alu 6061", rate: 300 }, { id: "d", name: "Brass", rate: 560 },
    ],
    quotes: [
      { id: uid(), at: now - 2 * day, status: "won", customer: "Apex Hydraulics", phone: "9810012345", part: "Gland Nut - 60mm", qty: 200, pricePc: 174.39, total: 34878, followUp: null, source: "wizard" },
      { id: uid(), at: now - 0.2 * day, status: "pending", customer: "Krishna Pumps", phone: "9829098290", part: "Bush Ø42", qty: 500, pricePc: 61.2, total: 30600, followUp: now + 2 * day, source: "wizard" },
      { id: uid(), at: now - 6 * day, status: "lost", customer: "Om Forgings", phone: "", part: 'Flange 6"', qty: 120, pricePc: 412.5, total: 49500, followUp: null, source: "wizard" },
      { id: uid(), at: now - 4 * day, status: "pending", customer: "Bharat Traders", phone: "9911223344", part: "MS Hex Bar lot", qty: 0, pricePc: 0, total: 128000, followUp: now - 1 * day, source: "logged" },
      { id: uid(), at: now - 9 * day, status: "won", customer: "Singh Auto Parts", phone: "9876500011", part: "Spacer Ø18 (repeat)", qty: 1000, pricePc: 22.5, total: 22500, followUp: null, source: "logged" },
      { id: uid(), at: now - 13 * day, status: "pending", customer: "Verma Enterprises", phone: "9700011122", part: "SS 304 fittings", qty: 0, pricePc: 0, total: 76500, followUp: now, source: "excel" },
      { id: uid(), at: now - 40 * day, status: "won", customer: "Apex Hydraulics", phone: "9810012345", part: "End Cap - batch", qty: 300, pricePc: 96, total: 28800, followUp: null, source: "wizard" },
      { id: uid(), at: now - 52 * day, status: "lost", customer: "Om Forgings", phone: "", part: "Shaft turning job", qty: 60, pricePc: 780, total: 46800, followUp: null, source: "logged" },
    ].map((q) => ({ ...q, seed: true })),
  };
};

/* ---- industry / trade focus ----
   The app is trade-agnostic at its core (pipeline, log, follow-ups); industry
   only tunes vocabulary, examples and which sample data a fresh account shows.
   emoji is intentional (matches the app's existing emoji use, e.g. Won toast). */
const INDUSTRIES = {
  machining: { key: "machining", emoji: "⚙️", label: "Machine shop / Trader", tag: "CNC, turning, fabrication, trading", item: "Part / item", eg: "MS Hex Bar lot", unit: "pcs", tally: true,
    spec: { label: "Size / material / grade", eg: "Ø42 x 120mm · EN8" },
    cats: [
      { key: "turned", label: "Turned", emoji: "⚙️" }, { key: "milled", label: "Milled", emoji: "🔧" },
      { key: "sheet", label: "Sheet metal", emoji: "📐" }, { key: "fabrication", label: "Fabrication", emoji: "🏗️" },
      { key: "fasteners", label: "Fasteners", emoji: "🔩" }, { key: "trading", label: "Trading", emoji: "📦" },
      { key: "other", label: "Other", emoji: "🛠️" },
    ] },
  scrap: { key: "scrap", emoji: "♻️", label: "Scrap / Metal trading", tag: "MS, CI, aluminium - tonnes & trucks", item: "Material / lot", eg: "MS scrap (HMS-1) - 50 MT", unit: "MT", tally: true,
    spec: { label: "Grade / weight / rate", eg: "HMS-1 · 50 MT · 33/kg" },
    cats: [
      { key: "ms", label: "MS / Iron", emoji: "⚙️" }, { key: "ci", label: "Cast iron", emoji: "🔩" },
      { key: "alu", label: "Aluminium", emoji: "🥫" }, { key: "copper", label: "Copper / brass", emoji: "🔶" },
      { key: "ss", label: "Stainless", emoji: "🍴" }, { key: "plastic", label: "Plastic", emoji: "♻️" },
      { key: "ewaste", label: "E-waste", emoji: "💻" }, { key: "other", label: "Other", emoji: "📦" },
    ] },
  printing: { key: "printing", emoji: "🖨️", label: "Printing / Press", tag: "Flex, cards, boxes, signage", item: "Job", eg: "Flex banner 6x3 ft", unit: "pcs", tally: false,
    spec: { label: "Size / material / finish", eg: "6x3 ft · star flex · eyelets" },
    cats: [
      { key: "banner", label: "Flex banners", emoji: "🎏" }, { key: "signage", label: "Boards & signage", emoji: "🪧" },
      { key: "standee", label: "Standees", emoji: "📜" }, { key: "cards", label: "Visiting cards", emoji: "🪪" },
      { key: "flyers", label: "Pamphlets", emoji: "📄" }, { key: "posters", label: "Posters", emoji: "🖼️" },
      { key: "billbook", label: "Bill books", emoji: "🧾" }, { key: "stationery", label: "Letterheads", emoji: "✉️" },
      { key: "stickers", label: "Stickers & labels", emoji: "🏷️" }, { key: "invites", label: "Wedding cards", emoji: "💌" },
      { key: "boxes", label: "Boxes & packaging", emoji: "📦" }, { key: "other", label: "Other jobs", emoji: "🖨️" },
    ] },
  furniture: { key: "furniture", emoji: "🛋️", label: "Furniture / Interiors", tag: "Sofas, wardrobes, modular, fit-outs", item: "Piece / design", eg: "3-seater sofa, grey fabric", unit: "pcs", tally: false,
    spec: { label: "Size / wood / fabric", eg: "7ft x 3ft · teak · fabric F-12" },
    cats: [
      { key: "sofa", label: "Sofa", emoji: "🛋️" }, { key: "bed", label: "Bed", emoji: "🛏️" },
      { key: "wardrobe", label: "Wardrobe", emoji: "🚪" }, { key: "dining", label: "Dining", emoji: "🍽️" },
      { key: "tvunit", label: "TV unit", emoji: "📺" }, { key: "chair", label: "Chair", emoji: "🪑" },
      { key: "office", label: "Office", emoji: "🖥️" }, { key: "other", label: "Other", emoji: "🔨" },
    ] },
};
const industryOf = (data) => INDUSTRIES[data && data.industry] || INDUSTRIES.machining;

/* keyword -> category, per trade (so old/sample quotes categorize themselves) */
const CAT_RULES = {
  machining: [["turned", /turn|shaft|bush|nut|spacer|bar|rod|pin|bore|ø|dia/], ["milled", /mill|slot|pocket|face/], ["sheet", /sheet|laser|bend|press|plate/], ["fabrication", /fabricat|weld|structure|frame|grill|gate|railing/], ["fasteners", /bolt|screw|fastener|washer|stud|hex/], ["trading", /lot|supply|trading|resale/]],
  printing: [["standee", /standee|roll.?up|rollup/], ["banner", /banner|flex(?!i)/], ["signage", /hoarding|unipole|billboard|glow|acp|sun.?board|foam.?board|sign|led board|vinyl|one.?way/], ["cards", /visiting|business card|v\.?card/], ["billbook", /bill.?book|invoice book|challan|receipt book|ncr|carbonless/], ["posters", /poster/], ["flyers", /flyer|pamphlet|leaflet|brochure|menu/], ["stickers", /sticker|label|die.?cut/], ["boxes", /box|carton|packag|mono/], ["invites", /invit|wedding|shaadi/], ["stationery", /letterhead|envelope|stationery|certificate|id card/]],
  furniture: [["sofa", /sofa|couch|settee|recliner/], ["bed", /bed|mattress|cot|headboard/], ["wardrobe", /wardrobe|almirah|drawer|cupboard|closet/], ["dining", /dining|table|chair set/], ["tvunit", /tv unit|tv-unit|console|entertainment/], ["chair", /chair|stool|bench/], ["office", /office|desk|workstation|conference/]],
  scrap: [["ms", /\bms\b|\bhms\b|iron|loha|mild steel|angle|channel|girder/], ["ci", /\bci\b|cast iron|casting/], ["alu", /alu|aluminium|aluminum|taar|wire scrap/], ["copper", /copper|brass|tamba|pital|cable/], ["ss", /\bss\b|stainless|304|202|steel utensil/], ["plastic", /plastic|\bpet\b|hdpe|\bpp\b|polythene/], ["ewaste", /e.?waste|pcb|battery|motor scrap|electronic/]],
};
const guessCategory = (part, key) => {
  const rules = CAT_RULES[key] || CAT_RULES.machining;
  const p = String(part || "").toLowerCase();
  for (const [cat, re] of rules) if (re.test(p)) return cat;
  return "other";
};
const catOf = (q, ind) => q.category || guessCategory(q.part, ind.key);
const catMeta = (ind, key) => (ind.cats || []).find((c) => c.key === key) || { key: "other", label: "Other", emoji: "📦" };

/* self-contained SVG preview illustrations per category (data URIs, no network).
   Used to seed demo quotes so a fresh printing/furniture pipeline is visual
   immediately; real user quotes carry actual photos. */
const art = (inner, bg) => "data:image/svg+xml," + encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 120'><rect width='120' height='120' fill='" + (bg || "#EAF3EC") + "'/>" + inner + "</svg>");
const CAT_ART = {
  sofa: art("<rect x='14' y='52' width='16' height='36' rx='7' fill='#5B7590'/><rect x='90' y='52' width='16' height='36' rx='7' fill='#5B7590'/><rect x='22' y='40' width='76' height='30' rx='10' fill='#84A0BC'/><rect x='18' y='60' width='84' height='26' rx='8' fill='#6E88A3'/><rect x='24' y='86' width='8' height='10' fill='#3E5468'/><rect x='88' y='86' width='8' height='10' fill='#3E5468'/>", "#E7EEF4"),
  bed: art("<rect x='14' y='44' width='18' height='46' rx='5' fill='#6E5744'/><rect x='14' y='60' width='92' height='28' rx='6' fill='#8A6E57'/><rect x='38' y='62' width='30' height='16' rx='6' fill='#F1E7DA'/><rect x='18' y='88' width='7' height='10' fill='#4E3E30'/><rect x='97' y='88' width='7' height='10' fill='#4E3E30'/>", "#F3EEE6"),
  wardrobe: art("<rect x='30' y='22' width='60' height='78' rx='4' fill='#7A6A55'/><rect x='58' y='22' width='3' height='78' fill='#5E5142'/><circle cx='52' cy='62' r='3' fill='#F1E7DA'/><circle cx='68' cy='62' r='3' fill='#F1E7DA'/>", "#F1EDE6"),
  dining: art("<rect x='28' y='52' width='64' height='7' rx='3' fill='#8A6E57'/><rect x='34' y='59' width='5' height='28' fill='#6E5744'/><rect x='81' y='59' width='5' height='28' fill='#6E5744'/><circle cx='60' cy='47' r='9' fill='#E7EEF4'/><rect x='16' y='46' width='6' height='42' rx='3' fill='#5B7590'/><rect x='98' y='46' width='6' height='42' rx='3' fill='#5B7590'/>", "#F1EDE6"),
  tvunit: art("<rect x='34' y='30' width='52' height='30' rx='3' fill='#2E3A44'/><rect x='40' y='36' width='40' height='18' fill='#4B6076'/><rect x='56' y='60' width='8' height='6' fill='#2E3A44'/><rect x='20' y='66' width='80' height='22' rx='4' fill='#6E5744'/><rect x='30' y='72' width='18' height='10' rx='2' fill='#5A4636'/>", "#E9EDF0"),
  chair: art("<rect x='42' y='56' width='36' height='8' rx='3' fill='#6E88A3'/><rect x='42' y='30' width='9' height='34' rx='3' fill='#5B7590'/><rect x='46' y='64' width='5' height='24' fill='#3E5468'/><rect x='72' y='64' width='5' height='24' fill='#3E5468'/>", "#E7EEF4"),
  office: art("<rect x='18' y='58' width='84' height='7' rx='3' fill='#5B7590'/><rect x='24' y='65' width='6' height='27' fill='#3E5468'/><rect x='90' y='65' width='6' height='27' fill='#3E5468'/><rect x='60' y='34' width='34' height='22' rx='2' fill='#2E3A44'/><rect x='64' y='38' width='26' height='14' fill='#4B6076'/>", "#E7EEF4"),
  cards: art("<rect x='30' y='46' width='58' height='36' rx='5' fill='#C9D6E3'/><rect x='36' y='40' width='58' height='36' rx='5' fill='#F3F7FB'/><rect x='42' y='50' width='30' height='5' rx='2' fill='#155E18'/><rect x='42' y='60' width='22' height='3' rx='1' fill='#9AB0C4'/><rect x='42' y='66' width='26' height='3' rx='1' fill='#9AB0C4'/>", "#EAF1F7"),
  flyers: art("<rect x='36' y='22' width='48' height='74' rx='3' fill='#F6F9FC'/><rect x='44' y='30' width='32' height='22' rx='2' fill='#7CA9E0'/><rect x='44' y='58' width='32' height='3' fill='#9AB0C4'/><rect x='44' y='65' width='32' height='3' fill='#9AB0C4'/><rect x='44' y='72' width='20' height='3' fill='#9AB0C4'/>", "#EAF1F7"),
  banner: art("<rect x='58' y='20' width='4' height='80' fill='#8894A0'/><rect x='44' y='94' width='32' height='5' rx='2' fill='#6E7E74'/><rect x='30' y='22' width='60' height='58' rx='3' fill='#3FAE45'/><rect x='30' y='22' width='60' height='12' fill='#2E7A32'/><rect x='38' y='42' width='44' height='7' rx='2' fill='#ffffff'/><rect x='38' y='54' width='30' height='5' rx='2' fill='#DCF3DD'/>", "#EAF3EC"),
  hoarding: art("<rect x='16' y='24' width='88' height='42' rx='2' fill='#4B6076'/><rect x='24' y='30' width='34' height='30' fill='#7CA9E0'/><rect x='62' y='30' width='34' height='9' fill='#ffffff'/><rect x='62' y='44' width='28' height='6' fill='#B7C6D6'/><rect x='34' y='66' width='7' height='32' fill='#6E7E74'/><rect x='80' y='66' width='7' height='32' fill='#6E7E74'/>", "#E9EDF0"),
  boxes: art("<rect x='34' y='48' width='52' height='42' fill='#C79A6B'/><polygon points='34,48 60,36 86,48 60,60' fill='#DDB588'/><rect x='57' y='48' width='6' height='42' fill='#A87E52'/><rect x='34' y='62' width='52' height='4' fill='#B98C5E'/>", "#F3EEE6"),
  invites: art("<rect x='42' y='28' width='40' height='26' rx='2' fill='#ffffff'/><rect x='48' y='36' width='28' height='4' rx='1' fill='#C9A24B'/><rect x='30' y='42' width='60' height='40' rx='3' fill='#E7D9EE'/><polygon points='30,42 60,66 90,42' fill='#D3BFDE'/>", "#F0EAF3"),
  stationery: art("<rect x='36' y='22' width='48' height='74' rx='2' fill='#F6F9FC'/><rect x='44' y='30' width='22' height='7' rx='2' fill='#155E18'/><rect x='44' y='46' width='32' height='3' fill='#9AB0C4'/><rect x='44' y='53' width='32' height='3' fill='#9AB0C4'/><rect x='44' y='60' width='24' height='3' fill='#9AB0C4'/>", "#EAF1F7"),
  signage: art("<rect x='24' y='30' width='72' height='34' rx='5' fill='#1E2B36'/><rect x='30' y='36' width='60' height='22' rx='3' fill='#3FAE45'/><rect x='38' y='43' width='44' height='8' rx='2' fill='#ffffff'/><rect x='56' y='64' width='8' height='30' fill='#6E7E74'/><rect x='42' y='94' width='36' height='5' rx='2' fill='#8894A0'/>", "#E9EDF0"),
  standee: art("<rect x='38' y='20' width='44' height='66' rx='2' fill='#F6F9FC'/><rect x='44' y='27' width='32' height='20' rx='2' fill='#3FAE45'/><rect x='44' y='52' width='32' height='4' fill='#9AB0C4'/><rect x='44' y='60' width='24' height='4' fill='#9AB0C4'/><polygon points='38,86 46,98 74,98 82,86' fill='#6E7E74'/><rect x='34' y='84' width='52' height='5' rx='2' fill='#4E5A64'/>", "#EAF1F7"),
  posters: art("<rect x='32' y='20' width='56' height='78' rx='2' fill='#F6F9FC'/><rect x='38' y='26' width='44' height='34' rx='2' fill='#7CA9E0'/><circle cx='52' cy='40' r='7' fill='#F4C542'/><rect x='38' y='66' width='44' height='7' rx='2' fill='#2E3A44'/><rect x='38' y='78' width='32' height='4' fill='#9AB0C4'/>", "#EAF1F7"),
  billbook: art("<rect x='30' y='26' width='58' height='70' rx='3' fill='#F6F9FC'/><rect x='30' y='26' width='58' height='12' rx='3' fill='#3FAE45'/><rect x='38' y='46' width='42' height='3' fill='#9AB0C4'/><rect x='38' y='54' width='42' height='3' fill='#9AB0C4'/><rect x='38' y='62' width='42' height='3' fill='#9AB0C4'/><rect x='38' y='70' width='28' height='3' fill='#9AB0C4'/><rect x='62' y='82' width='18' height='6' rx='2' fill='#155E18'/><circle cx='36' cy='32' r='2' fill='#ffffff'/><circle cx='44' cy='32' r='2' fill='#ffffff'/>", "#EAF1F7"),
  stickers: art("<circle cx='48' cy='48' r='20' fill='#F4C542'/><circle cx='48' cy='48' r='13' fill='#ffffff'/><rect x='62' y='58' width='34' height='34' rx='6' fill='#7CA9E0' transform='rotate(12 79 75)'/><rect x='24' y='70' width='26' height='18' rx='4' fill='#3FAE45' transform='rotate(-8 37 79)'/>", "#F6F2E8"),
  ms: art("<rect x='22' y='62' width='76' height='10' rx='3' fill='#6B7A8C' transform='rotate(-8 60 67)'/><rect x='30' y='44' width='60' height='10' rx='3' fill='#8A99AB' transform='rotate(5 60 49)'/><rect x='26' y='78' width='68' height='10' rx='3' fill='#55636F'/><circle cx='84' cy='36' r='9' fill='#9AA9BB'/>", "#EBEEF2"),
  ci: art("<circle cx='45' cy='58' r='19' fill='#5A6570'/><circle cx='45' cy='58' r='8' fill='#39434C'/><rect x='62' y='44' width='34' height='28' rx='5' fill='#71808D' transform='rotate(10 79 58)'/><rect x='30' y='82' width='58' height='9' rx='3' fill='#4A555F'/>", "#EBEEF2"),
  alu: art("<rect x='30' y='34' width='24' height='52' rx='9' fill='#C3CDD6'/><rect x='30' y='42' width='24' height='6' fill='#9FB0BD'/><rect x='60' y='42' width='26' height='44' rx='8' fill='#D6DEE5' transform='rotate(9 73 64)'/><ellipse cx='58' cy='92' rx='30' ry='6' fill='#AEBBC6'/>", "#F0F3F5"),
  copper: art("<circle cx='48' cy='52' r='20' fill='#C97F4A'/><circle cx='48' cy='52' r='12' fill='#E8A56E'/><circle cx='48' cy='52' r='5' fill='#A96436'/><rect x='64' y='60' width='30' height='9' rx='4' fill='#B8763F' transform='rotate(14 79 64)'/><rect x='60' y='74' width='34' height='9' rx='4' fill='#D69257' transform='rotate(-6 77 78)'/>", "#F7EFE7"),
  ss: art("<rect x='34' y='30' width='14' height='58' rx='6' fill='#B9C4CE'/><circle cx='41' cy='36' r='9' fill='#CDD7DF'/><rect x='58' y='30' width='30' height='42' rx='6' fill='#D5DEE5'/><rect x='58' y='42' width='30' height='5' fill='#AEBBC6'/><rect x='64' y='78' width='18' height='12' rx='3' fill='#98A8B4'/>", "#F0F3F5"),
  plastic: art("<path d='M40 30h14l3 12c8 3 8 9 8 16v26a6 6 0 0 1-6 6H41a6 6 0 0 1-6-6V58c0-7 0-13 8-16Z' fill='#7CC5E8'/><rect x='40' y='30' width='14' height='7' rx='2' fill='#4E9FC4'/><rect x='64' y='52' width='26' height='34' rx='5' fill='#A5D8EF' transform='rotate(8 77 69)'/>", "#EAF4F9"),
  ewaste: art("<rect x='26' y='34' width='48' height='34' rx='4' fill='#3D4A54'/><rect x='31' y='39' width='38' height='24' fill='#5B903F'/><rect x='36' y='44' width='10' height='6' fill='#7CC96A'/><rect x='52' y='44' width='12' height='4' fill='#7CC96A'/><rect x='40' y='72' width='20' height='6' rx='2' fill='#55636F'/><rect x='68' y='56' width='26' height='36' rx='5' fill='#71808D'/><rect x='72' y='62' width='18' height='12' rx='2' fill='#9AD1F0'/>", "#EDF1F0"),
};

/* trade-specific sample quotes, shown only when a fresh account picks a trade
   (never overwrites real data - see the pick handler) */
const industrySamples = (key) => {
  if (key === "machining") return [
    { customer: "Apex Hydraulics", part: "Gland Nut - 60mm", spec: "EN8 · Ø60 · CNC turned", qty: 200, total: 34878, status: "won", fu: null, cat: "turned", note: "Repeat customer. PO mila, delivery 2 lots mein." },
    { customer: "Krishna Pumps", part: "Bush Ø42", spec: "EN8 · Ø42 x 55mm", qty: 500, total: 30600, status: "pending", fu: 2, cat: "turned", note: "Rate sheet bheji. Unke purchase se approval aana hai." },
    { customer: "Bharat Traders", part: "MS Hex Bar lot", spec: "EN1A · 24AF · 1.2 T", qty: 0, total: 128000, status: "pending", fu: -1, cat: "trading", note: "Advance pe atka hai. Mill rate badh gaya - shayad dobara quote karna pade." },
    { customer: "Gupta Fabricators", part: "Gate + railing job", spec: "MS 40x40 box · 22 ft", qty: 1, total: 58000, status: "pending", fu: 3, cat: "fabrication", note: "Site measure ho gaya. Design ki photo WhatsApp pe aayi hai." },
    { customer: "Verma Enterprises", part: "SS 304 fittings", spec: "SS 304 · assorted", qty: 0, total: 76500, status: "pending", fu: 0, cat: "fasteners", note: "Material rate confirm karke final karna hai." },
    { customer: "Singh Auto Parts", part: "Spacer Ø18 (repeat)", spec: "Alu 6061 · anodized", qty: 1000, total: 22500, status: "won", fu: null, cat: "turned", note: "Har mahine ka repeat order. Anodizing bahar se." },
    { customer: "Faridabad Auto Comp", part: "Laser cut brackets", spec: "CRC 2mm · nested", qty: 5000, total: 42000, status: "won", fu: null, cat: "sheet", note: "Nesting optimize kiya - margin theek hai." },
    { customer: "Om Forgings", part: "Flange 6 inch", spec: "MS forged · machined", qty: 120, total: 49500, status: "lost", fu: null, cat: "milled", note: "L1 nahi bane - Ludhiana wale ne 380/pc quote kiya." },
    { customer: "Mehta Industries", part: "Shaft turning job", spec: "EN19 · Ø35 x 400", qty: 60, total: 46800, status: "lost", fu: null, cat: "turned", note: "Cycle time zyada lag raha tha - capacity issue." },
  ];
  if (key === "printing") return [
    { customer: "Gupta Properties", part: "Shop opening flex banners", spec: "6x3 ft · star flex · eyelets", qty: 2, total: 1080, status: "pending", fu: 0, cat: "banner", note: "Aaj shaam 6 baje muhurat - 4 baje tak chahiye. Design final. Rs 30/sqft." },
    { customer: "CA Rohit Jain", part: "Visiting cards - premium", spec: "3.5x2 in · 350gsm · velvet lam + spot UV", qty: 500, total: 2250, status: "pending", fu: 0, cat: "cards", note: "Proof approved. Spot UV bahar se hoga - 2 din extra." },
    { customer: "Kapoor Family", part: "Wedding cards + inserts", spec: "mid-range card · gold foil inserts", qty: 300, total: 10500, status: "pending", fu: -1, cat: "invites", note: "3rd revision - naam ki spelling family check kar rahi hai. Shaadi 28 ki hai!" },
    { customer: "Mahajan Traders", part: "GST bill books", spec: "A5 · duplicate NCR · 50 sets/book", qty: 20, total: 5000, status: "pending", fu: -2, cat: "billbook", note: "Advance 2000 mila, baki delivery pe. Numbering 501-1500 continue karni hai." },
    { customer: "Royal Tutorials", part: "Admission pamphlets", spec: "A5 · 100gsm gloss art · both sides", qty: 5000, total: 5000, status: "pending", fu: -3, cat: "flyers", note: "Matter abhi tak nahi aaya - 3 din se unki taraf se pending." },
    { customer: "Bansal Coaching", part: "Admission banners - 4 locations", spec: "8x4 ft · normal flex 240gsm", qty: 4, total: 1550, status: "pending", fu: 1, cat: "banner", note: "Rs 12/sqft final. Fitting alag - bans ke saath 4 jagah lagwana hai." },
    { customer: "Aggarwal Sweets", part: "Glow sign board - shopfront", spec: "8x3 ft · backlit flex + LED box", qty: 1, total: 5500, status: "pending", fu: 1, cat: "signage", note: "Naya showroom. Frame + wiring included. Site measure ho gaya." },
    { customer: "Kwality Pickles", part: "Product labels", spec: "3in round · die-cut vinyl · gloss lam", qty: 2000, total: 3000, status: "pending", fu: 3, cat: "stickers", note: "Sample sheet approved. Online rate se compare kar rahe - 1.50/pc pe final hoga." },
    { customer: "Aggarwal Sweets", part: "Rakhi gift boxes", spec: "500g · duplex 300gsm · 4-color + gloss lam", qty: 2000, total: 8000, status: "pending", fu: 5, cat: "boxes", note: "Repeat customer. 40% advance mila. Die approval ke baad 15 din." },
    { customer: "Walk-in - Sunita ji", part: "Photo mugs - birthday gift", spec: "11oz ceramic · photo print", qty: 2, total: 400, status: "won", fu: null, cat: "other", note: "1 ghante mein ready karke diya." },
    { customer: "Krishna Pharma", part: "Roll-up standees - medical camp", spec: "2.5x6 ft · star flex + stand + bag", qty: 2, total: 2200, status: "won", fu: null, cat: "standee", note: "Kal subah camp tha - raat ko print karke diya. Repeat customer." },
    { customer: "Verma Hardware", part: "Visiting cards - repeat", spec: "3.5x2 in · 300gsm · matte lam", qty: 1000, total: 1800, status: "won", fu: null, cat: "cards", note: "Same as last time - sirf mobile number change. Purani CDR file mil gayi." },
    { customer: "Shri Ram Committee", part: "Jagran posters", spec: "A3 · 130gsm art paper", qty: 200, total: 3000, status: "won", fu: null, cat: "posters", note: "Overnight job. Cash payment ho gaya." },
    { customer: "Green Valley School", part: "Student ID cards", spec: "PVC CR80 · both sides + lace", qty: 450, total: 6750, status: "won", fu: null, cat: "stationery", note: "12 photo missing the - school se mangwaye. 5 naye admission ke card baad mein." },
    { customer: "Dr. Malhotra Clinic", part: "ACP board + acrylic LED letters", spec: "10x2.5 ft ACP · 12in letters", qty: 1, total: 17500, status: "lost", fu: null, cat: "signage", note: "Rate zyada laga - franchise vendor se 15k mein karwa liya." },
    { customer: "Sethi & Associates", part: "Letterheads + envelopes set", spec: "A4 100gsm bond · 9x4 lifafa", qty: 1000, total: 4500, status: "lost", fu: null, cat: "stationery", note: "Online print se karwa liya - hum Rs 500 zyada the." },
  ];
  if (key === "furniture") return [
    { customer: "Gupta Residence", part: "3-seater L-sofa, grey fabric", qty: 1, total: 62000, status: "pending", fu: 0, cat: "sofa", note: "Sent fabric options. Waiting on colour choice." },
    { customer: "Sharma Villa", part: "Tufted sofa set, same as photo", qty: 1, total: 95000, status: "pending", fu: -3, cat: "sofa", note: "Customer shared a photo, wants the same design. Followed up once." },
    { customer: "Cafe Bloom", part: "8 dining tables + 32 chairs", qty: 8, total: 176000, status: "pending", fu: -2, cat: "dining", note: "Bulk order. Comparing us with 2 other vendors - price sensitive." },
    { customer: "Sethi House", part: "King bed with hydraulic storage, teak", qty: 1, total: 58000, status: "pending", fu: 2, cat: "bed", note: "Wants delivery before house-warming." },
    { customer: "Verma Residence", part: "4 dining chairs, teak", qty: 4, total: 22000, status: "pending", fu: 0, cat: "chair", note: "Add-on to earlier table order." },
    { customer: "Mehta Interiors", part: "6-door wardrobe, laminate", qty: 1, total: 84000, status: "won", fu: null, cat: "wardrobe", note: "Confirmed. Measurement done." },
    { customer: "Singh Apartment", part: "TV unit + console, walnut", qty: 1, total: 45000, status: "won", fu: null, cat: "tvunit", note: "" },
    { customer: "Khanna Flat", part: "3-door wardrobe + dresser", qty: 1, total: 51000, status: "won", fu: null, cat: "wardrobe", note: "Repeat client." },
    { customer: "Rao Office", part: "12 modular workstations", qty: 12, total: 240000, status: "lost", fu: null, cat: "office", note: "Lost to a local carpenter on price." },
  ];
  if (key === "scrap") return [
    { customer: "Apex Alloys", part: "MS scrap (HMS-1)", spec: "HMS-1 · 50 MT · 33/kg", qty: 50, total: 1650000, status: "won", fu: null, cat: "ms", note: "Rate final 33/kg. Dispatch truck-by-truck, weighbridge slip ke saath. 30% advance mila." },
    { customer: "Bharat Steels", part: "CI scrap - foundry grade", spec: "CI · 25 MT · 34/kg", qty: 25, total: 850000, status: "won", fu: null, cat: "ci", note: "Unka truck aayega. Moisture cut 1% agreed. Payment 15 din." },
    { customer: "Om Metals", part: "Aluminium wire scrap", spec: "Alu taar · 30 MT · 134/kg", qty: 30, total: 4020000, status: "pending", fu: 0, cat: "alu", note: "Rate LME se linked - aaj final karna hai. Bada order, advance pakka lena." },
    { customer: "Shakti Traders", part: "MS turning boring", spec: "Turning · 10 MT · 27/kg", qty: 10, total: 270000, status: "pending", fu: -1, cat: "ms", note: "Kal se jawab nahi. Purana baki 15,200 pehle clear karwana hai." },
    { customer: "JMD Enterprises", part: "Copper cable scrap", spec: "Cable · 2 MT · 610/kg", qty: 2, total: 1220000, status: "pending", fu: 2, cat: "copper", note: "Sample dekh ke rate denge. High value - cash deal nahi, RTGS only." },
    { customer: "Verma Recyclers", part: "PET plastic lot", spec: "PET baled · 8 MT · 42/kg", qty: 8, total: 336000, status: "pending", fu: 4, cat: "plastic", note: "Baler ka time chahiye - agle hafte lot ready hoga." },
    { customer: "Gupta Industries", part: "SS 304 sheet cutting", spec: "SS 304 · 5 MT · 148/kg", qty: 5, total: 740000, status: "won", fu: null, cat: "ss", note: "Repeat party. Same rate as last lot." },
    { customer: "Delhi Metal Mart", part: "Mixed iron scrap", spec: "Mixed · 40 MT · 29/kg", qty: 40, total: 1160000, status: "lost", fu: null, cat: "ms", note: "Rate 1.50/kg se reh gaya - Ghaziabad wale ne utha liya." },
    { customer: "Tech Recycle Co", part: "E-waste - motor + PCB lot", spec: "Motors+PCB · 3 MT", qty: 3, total: 450000, status: "pending", fu: 1, cat: "ewaste", note: "GST bill mandatory. Unki compliance team approve karegi." },
  ];
  return null;
};
/* full quote objects for a trade's sample set (null for machining -> use seedData) */
const buildSampleQuotes = (key) => {
  const specs = industrySamples(key);
  if (!specs) return null;
  const now = Date.now();
  return specs.map((s, i) => ({
    id: uid(), at: now - i * 0.7 * DAY, status: s.status, customer: s.customer, phone: "",
    part: s.part, qty: s.qty, pricePc: s.qty ? s.total / s.qty : 0, total: s.total,
    followUp: s.fu == null ? null : now + s.fu * DAY, source: "sample", seed: true,
    image: CAT_ART[s.cat] || "", category: s.cat || "", note: s.note || "", spec: s.spec || "",
  }));
};

/* downscale a picked image to a small JPEG data URL for the pipeline thumbnail.
   Kept tiny (~240px) so many photos fit in localStorage / the synced blob;
   full-resolution photo storage -> Supabase Storage is the documented next step. */
const downscaleImage = (file, max = 240, quality = 0.55) => new Promise((resolve) => {
  if (!file || !/^image\//.test(file.type || "")) return resolve(null);
  const img = new Image();
  const url = URL.createObjectURL(file);
  img.onload = () => {
    URL.revokeObjectURL(url);
    let w = img.width, h = img.height;
    if (w >= h && w > max) { h = Math.round(h * max / w); w = max; }
    else if (h > w && h > max) { w = Math.round(w * max / h); h = max; }
    try {
      const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
      cv.getContext("2d").drawImage(img, 0, 0, w, h);
      resolve(cv.toDataURL("image/jpeg", quality));
    } catch { resolve(null); }
  };
  img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
  img.src = url;
});

const calcQuote = (d, data) => {
  const mat = data.materials.find((m) => m.id === d.materialId);
  const mc = data.machines.find((m) => m.id === d.machineId);
  const qty = +d.qty || 0;
  const matCost = mat && d.rawKg ? +d.rawKg * mat.rate : null;
  const machCost = mc && d.cycleMin ? (+d.cycleMin / 60) * mc.rate + (d.setupMin && qty ? ((+d.setupMin / 60) * mc.rate) / qty : 0) : null;
  const labour = d.manualMin ? (+d.manualMin / 60) * data.settings.labourRate : 0;
  const tooling = +d.toolingPc || 0;
  if (matCost == null || machCost == null || !qty) return { partial: (matCost || 0) + (machCost || 0) + labour + tooling, done: false };
  const sub = matCost + machCost + labour + tooling;
  const ovh = (sub * (+d.overheadPct || 0)) / 100;
  const cost = sub + ovh;
  const marg = (cost * (+d.marginPct || 0)) / 100;
  const pricePc = cost + marg;
  return { done: true, matCost, machCost, labour, tooling, sub, ovh, cost, marg, pricePc, total: pricePc * qty, qty };
};

const waText = (q, shop, validity) =>
  `*QUOTATION - ${shop}*\n` + `Part: ${q.part}\nQuantity: ${q.qty} pcs\nRate: ${inr(q.pricePc, 2)} / pc\n` +
  `*Total: ${inr(q.total)} + GST*\n` + `Valid ${validity} days\n- Sent via TrackRakho`;

/* ---- PDF: drawn with jsPDF and downloaded as a real .pdf file.
   No window.open / no print dialog, so it works inside the artifact sandbox. ---- */
let _jspdfPromise = null;
function loadJsPDF() {
  if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
  if (_jspdfPromise) return _jspdfPromise;
  _jspdfPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
    s.onload = () => resolve(window.jspdf.jsPDF);
    s.onerror = () => reject(new Error("cdn"));
    document.head.appendChild(s);
  });
  return _jspdfPromise;
}

/* rupee glyph isn't in the PDF core font - use "Rs " for crisp output */
const rs = (n, d = 0) => "Rs " + Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });

async function downloadQuotePDF(q, data) {
  const s = data.settings;
  const gst = q.total * ((s.gstPct || 18) / 100);
  const grand = q.total + gst;
  const today = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
  const num = "QK-" + new Date(q.at).getFullYear() + "-" + String(Math.floor(q.at / 1000) % 100000).padStart(5, "0");

  const JsPDF = await loadJsPDF();
  const doc = new JsPDF({ unit: "pt", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const M = 44;
  const G = [34, 139, 34], GD = [21, 94, 24], INK = [22, 32, 26], DIM = [86, 100, 96], LINE = [225, 234, 226];

  /* header */
  doc.setFont("helvetica", "bold").setFontSize(20).setTextColor(...INK);
  doc.text(data.shopName, M, 60);
  doc.setFont("helvetica", "normal").setFontSize(10).setTextColor(...DIM);
  doc.text("Precision CNC Job-Work  -  Faridabad / NCR", M, 76);
  doc.setFont("helvetica", "bold").setFontSize(22).setTextColor(...G);
  doc.text("QUOTATION", W - M, 60, { align: "right" });
  doc.setFont("courier", "normal").setFontSize(10).setTextColor(...DIM);
  doc.text(num, W - M, 76, { align: "right" });
  doc.setDrawColor(...G).setLineWidth(2.4).line(M, 90, W - M, 90);

  /* meta */
  const metaY = 124;
  const meta = [["BILLED TO", q.customer], ["DATE", today], ["VALID FOR", s.validityDays + " days"]];
  meta.forEach((m, i) => {
    const x = M + i * ((W - 2 * M) / 3);
    doc.setFont("courier", "normal").setFontSize(8.5).setTextColor(...DIM); doc.text(m[0], x, metaY);
    doc.setFont("helvetica", "bold").setFontSize(12).setTextColor(...INK); doc.text(String(m[1]), x, metaY + 17);
  });

  /* table header */
  let y = metaY + 48;
  doc.setFillColor(229, 244, 230).rect(M, y, W - 2 * M, 26, "F");
  doc.setFont("courier", "normal").setFontSize(9).setTextColor(...GD);
  doc.text("PART / DESCRIPTION", M + 12, y + 17);
  doc.text("QTY", W - M - 230, y + 17, { align: "right" });
  doc.text("RATE / PC", W - M - 120, y + 17, { align: "right" });
  doc.text("AMOUNT", W - M - 12, y + 17, { align: "right" });

  /* row */
  y += 26 + 24;
  doc.setFont("helvetica", "normal").setFontSize(12).setTextColor(...INK);
  doc.text(String(q.part), M + 12, y);
  doc.text(String(q.qty), W - M - 230, y, { align: "right" });
  doc.text(rs(q.pricePc, 2), W - M - 120, y, { align: "right" });
  doc.text(rs(q.total, 2), W - M - 12, y, { align: "right" });
  doc.setDrawColor(...LINE).setLineWidth(0.8).line(M, y + 14, W - M, y + 14);

  /* totals */
  y += 44;
  const tx = W - M - 220;
  doc.setFont("helvetica", "normal").setFontSize(11).setTextColor(...DIM);
  doc.text("Subtotal", tx, y); doc.setTextColor(...INK).text(rs(q.total, 2), W - M - 12, y, { align: "right" });
  y += 22;
  doc.setTextColor(...DIM).text("GST @ " + (s.gstPct || 18) + "%", tx, y);
  doc.setTextColor(...INK).text(rs(gst, 2), W - M - 12, y, { align: "right" });
  y += 16;
  doc.setFillColor(...G).roundedRect(tx - 14, y, W - M - (tx - 14), 38, 6, 6, "F");
  doc.setFont("helvetica", "bold").setFontSize(14).setTextColor(255, 255, 255);
  doc.text("TOTAL", tx, y + 25);
  doc.text(rs(grand, 2), W - M - 12, y + 25, { align: "right" });

  /* terms */
  y += 78;
  doc.setDrawColor(...LINE).setLineWidth(0.8).line(M, y, W - M, y);
  y += 20;
  doc.setFont("helvetica", "bold").setFontSize(10).setTextColor(...INK).text("Terms:", M, y);
  doc.setFont("helvetica", "normal").setTextColor(...DIM);
  const terms = doc.splitTextToSize(
    s.validityDays + "-day validity from the date above. Prices subject to final drawing and quantity confirmation. GST extra as applicable. Delivery as mutually agreed.",
    W - 2 * M - 44);
  doc.text(terms, M + 40, y);

  /* footer */
  doc.setFont("courier", "normal").setFontSize(9).setTextColor(134, 149, 139);
  doc.text("GENERATED WITH TRACKRAKHO", W / 2, doc.internal.pageSize.getHeight() - 40, { align: "center" });

  doc.save(num + ".pdf");
  return true;
}

/* ---------------- Excel / CSV pipeline I/O ----------------
   SheetJS is loaded from CDN at runtime (same pattern as jsPDF). CSV export
   works with no library at all so a shop can always get its data out. */
let _xlsxPromise = null;
function loadXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (_xlsxPromise) return _xlsxPromise;
  _xlsxPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => reject(new Error("cdn"));
    document.head.appendChild(s);
  });
  return _xlsxPromise;
}

const SHEET_COLS = ["Date", "Customer", "Phone", "Part", "Qty", "Rate/pc", "Total", "Status", "Follow-up"];
const quoteToRow = (q) => ({
  Date: isoDate(q.at), Customer: q.customer, Phone: q.phone || "", Part: q.part,
  Qty: q.qty || "", "Rate/pc": q.pricePc ? +Number(q.pricePc).toFixed(2) : "", Total: q.total || "",
  Status: q.status, "Follow-up": q.followUp ? isoDate(q.followUp) : "",
});

const csvCell = (v) => { const s = String(v == null ? "" : v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function exportQuotesCSV(quotes) {
  const rows = quotes.map(quoteToRow);
  const body = [SHEET_COLS, ...rows.map((r) => SHEET_COLS.map((c) => r[c]))].map((r) => r.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob(["﻿" + body], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = "TrackRakho-pipeline.csv"; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
async function exportQuotesXLSX(quotes) {
  const XLSX = await loadXLSX();
  const ws = XLSX.utils.json_to_sheet(quotes.map(quoteToRow), { header: SHEET_COLS });
  ws["!cols"] = [{ wch: 12 }, { wch: 22 }, { wch: 14 }, { wch: 24 }, { wch: 7 }, { wch: 10 }, { wch: 12 }, { wch: 9 }, { wch: 12 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Pipeline");
  XLSX.writeFile(wb, "TrackRakho-pipeline.xlsx");
}

/* map a spreadsheet row (any column casing / synonyms) to a quote */
const pickCol = (row, keys) => {
  const map = {}; Object.keys(row).forEach((k) => (map[String(k).toLowerCase().trim()] = row[k]));
  for (const key of keys) { const v = map[key]; if (v !== undefined && String(v).trim() !== "") return v; }
  return "";
};
const rowToQuote = (row) => {
  const customer = String(pickCol(row, ["customer", "client", "party", "name", "company", "buyer"])).trim();
  const part = String(pickCol(row, ["part", "item", "product", "description", "part name", "job"])).trim();
  if (!customer && !part) return null;
  const total = num(pickCol(row, ["total", "amount", "value", "quote amount", "grand total"]));
  const qty = num(pickCol(row, ["qty", "quantity", "pcs", "nos", "pieces"]));
  const rate = num(pickCol(row, ["rate/pc", "rate", "price/pc", "unit price", "rate per pc"]));
  let status = String(pickCol(row, ["status", "stage", "outcome"]) || "pending").toLowerCase().trim();
  status = ["won", "lost", "pending"].includes(status) ? status
    : status.startsWith("w") || status.includes("order") || status.includes("confirm") ? "won"
    : status.startsWith("l") || status.includes("reject") ? "lost" : "pending";
  const phone = String(pickCol(row, ["phone", "mobile", "whatsapp", "contact", "number"])).replace(/[^\d]/g, "");
  const at = parseDate(pickCol(row, ["date", "created", "quoted on", "quote date"])) || Date.now();
  const followUp = parseDate(pickCol(row, ["follow-up", "followup", "follow up", "next follow-up"]));
  return {
    id: uid(), at, status, customer: customer || "(no name)", part: part || "(no part)", phone,
    qty: qty || 0, pricePc: rate || (qty ? total / qty : 0), total: total || rate * qty || 0,
    followUp: followUp || null, source: "excel",
  };
};
async function parseSheetFile(file) {
  const XLSX = await loadXLSX();
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array", cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
  return rows.map(rowToQuote).filter(Boolean);
}

/* ---------------- count-up ---------------- */
function CountUp({ value, d = 0, dur = 700, prefix = "₹" }) {
  const [v, setV] = useState(value);
  const prev = useRef(value);
  useEffect(() => {
    const from = prev.current, to = value, t0 = performance.now();
    prev.current = value;
    if (from === to) return;
    let raf;
    const step = (t) => { const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3); setV(from + (to - from) * e); if (k < 1) raf = requestAnimationFrame(step); };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, dur]);
  return <>{prefix + Number(v).toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d })}</>;
}

/* ================= AUTH (phone OTP + username/password) =================
   DEMO ONLY: no real SMS or password check. Any 4-digit OTP / any login works.
   Wire a backend at the marked hooks before production. */
function Auth({ onAuthed, authError }) {
  const [mode, setMode] = useState("otp"); // otp | password
  const [stage, setStage] = useState("enter"); // enter | code (for otp)
  const [busy, setBusy] = useState(false); // cloud: opening Google
  const [authErr, setAuthErr] = useState("");
  /* surface OAuth errors that come back in the URL instead of looping silently */
  useEffect(() => {
    try {
      const qs = new URLSearchParams(window.location.search);
      const hs = new URLSearchParams((window.location.hash || "").replace(/^#/, ""));
      const desc = qs.get("error_description") || hs.get("error_description") || qs.get("error") || hs.get("error");
      if (desc) setAuthErr(String(desc).replace(/\+/g, " "));
    } catch {}
  }, []);
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState(["", "", "", ""]);
  const [uname, setUname] = useState("");
  const [pass, setPass] = useState("");
  const [err, setErr] = useState("");
  const otpRefs = useRef([]);

  /* cloud mode: the only real login is Google via Supabase. This return sits
     BELOW every hook declaration, so hook order stays constant. */
  if (sb) {
    const google = async () => {
      setBusy(true);
      try { await sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: window.location.origin } }); }
      catch { setBusy(false); }
    };
    return (
      <div className="auth">
        <div className="auth-top">
          <div className="auth-logo">QK</div>
          <h1>Track<span style={{ color: "var(--grn)" }}>Rakho</span></h1>
          <p>Quotations in five minutes - built for India's job-shops.</p>
        </div>
        <div className="auth-body">
          <label className="lbl">Sign in to your shop</label>
          <span className="hint">Your quotes live in your own private account - alag, surakshit, sirf aapke liye. Log in from any phone or computer.</span>
          <button className="btn btn-ghost press" style={{ width: "100%", marginTop: 14, gap: 12 }} onClick={google} disabled={busy}>
            <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.7 1.22 9.19 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
            {busy ? "Opening Google..." : "Continue with Google"}
          </button>
          {(authError || authErr) && <div style={{ marginTop: 14, padding: "11px 13px", borderRadius: 12, background: "var(--red-bg)", color: "var(--red)", fontSize: 13, lineHeight: 1.5 }}>Login error: {authError || authErr}</div>}
          <div className="auth-note">One tap, no password to remember. We only receive your name and email - nothing else from your Google account.</div>
        </div>
      </div>
    );
  }

  const sendOtp = () => {
    if (phone.replace(/\D/g, "").length < 10) { setErr("Enter a valid 10-digit number"); return; }
    setErr("");
    /* HOOK: call backend to send real OTP SMS here */
    setStage("code");
    setTimeout(() => otpRefs.current[0]?.focus(), 100);
  };
  const onOtpChange = (i, v) => {
    if (!/^\d?$/.test(v)) return;
    const next = [...otp]; next[i] = v; setOtp(next);
    if (v && i < 3) otpRefs.current[i + 1]?.focus();
  };
  const onOtpKey = (i, e) => { if (e.key === "Backspace" && !otp[i] && i > 0) otpRefs.current[i - 1]?.focus(); };
  const verifyOtp = () => {
    if (otp.join("").length < 4) { setErr("Enter the 4-digit code"); return; }
    /* HOOK: verify OTP with backend here. Demo accepts any code. */
    onAuthed({ method: "phone", phone: "+91 " + phone, name: "", createdAt: Date.now() });
  };
  const doPassword = () => {
    if (!uname.trim() || pass.length < 4) { setErr("Enter username and password (min 4 chars)"); return; }
    /* HOOK: authenticate username/password with backend here. Demo accepts any. */
    onAuthed({ method: "password", username: uname.trim(), name: uname.trim(), createdAt: Date.now() });
  };

  return (
    <div className="auth">
      <div className="auth-top">
        <div className="auth-logo">QK</div>
        <h1>Track<span style={{ color: "var(--grn)" }}>Rakho</span></h1>
        <p>Quotations in five minutes - built for India's job-shops.</p>
      </div>
      <div className="auth-body">
        <div className="seg">
          <button className={mode === "otp" ? "on" : ""} onClick={() => { setMode("otp"); setErr(""); setStage("enter"); }}>Phone OTP</button>
          <button className={mode === "password" ? "on" : ""} onClick={() => { setMode("password"); setErr(""); }}>Username</button>
        </div>

        {mode === "otp" && stage === "enter" && (
          <div className="anim-in">
            <label className="lbl">Mobile number</label>
            <span className="hint">We'll send a one-time code to verify it's you.</span>
            <div className="phone-field">
              <span className="cc">+91</span>
              <input type="tel" inputMode="numeric" placeholder="98xxxxxxxx" value={phone}
                onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 10))} />
            </div>
            {err && <div style={{ color: "var(--red)", fontSize: 13, marginTop: 10 }}>{err}</div>}
            <button className="btn btn-grn press" style={{ width: "100%", marginTop: 18 }} onClick={sendOtp}><I.phone2 /> Send OTP</button>
            <div className="demo-hint">Demo: enter any 10-digit number, then any 4-digit code.</div>
          </div>
        )}

        {mode === "otp" && stage === "code" && (
          <div className="anim-in">
            <label className="lbl">Enter the code</label>
            <span className="hint">Sent to +91 {phone}. <button onClick={() => { setStage("enter"); setOtp(["", "", "", ""]); setErr(""); }} style={{ border: "none", background: "none", color: "var(--grn-d)", fontWeight: 600, cursor: "pointer", fontSize: 12.5 }}>Change</button></span>
            <div className="otp-row">
              {otp.map((d, i) => (
                <input key={i} ref={(el) => (otpRefs.current[i] = el)} inputMode="numeric" maxLength={1} value={d}
                  onChange={(e) => onOtpChange(i, e.target.value)} onKeyDown={(e) => onOtpKey(i, e)} />
              ))}
            </div>
            {err && <div style={{ color: "var(--red)", fontSize: 13, marginTop: 10 }}>{err}</div>}
            <button className="btn btn-grn press" style={{ width: "100%", marginTop: 18 }} onClick={verifyOtp}><I.lock /> Verify & continue</button>
            <div className="auth-note">Didn't get it? <b style={{ color: "var(--grn-d)" }}>Resend</b> in 0:30</div>
          </div>
        )}

        {mode === "password" && (
          <div className="anim-in">
            <label className="lbl">Username</label>
            <div className="suffix-wrap" style={{ marginBottom: 14 }}>
              <input className="input" placeholder="your shop name or ID" value={uname} onChange={(e) => setUname(e.target.value)} />
            </div>
            <label className="lbl">Password</label>
            <input className="input" type="password" placeholder="••••••••" value={pass} onChange={(e) => setPass(e.target.value)} />
            {err && <div style={{ color: "var(--red)", fontSize: 13, marginTop: 10 }}>{err}</div>}
            <button className="btn btn-grn press" style={{ width: "100%", marginTop: 18 }} onClick={doPassword}><I.lock /> Log in</button>
            <div className="auth-note">New here? An account is created automatically on first login.</div>
            <div className="demo-hint">Demo: any username and password (4+ chars) works.</div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ================= SUBSCRIBE ================= */
function Subscribe({ account, onSubscribe, onBack }) {
  const current = account?.plan;
  return (
    <div className="scr"><div className="pagepad" style={{ paddingBottom: 40 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
        <button className="iconbtn press" onClick={onBack}><I.back /></button>
        <div><div className="microlbl">PLANS</div><div className="h-disp" style={{ fontSize: 23, fontWeight: 700 }}>Choose your plan</div></div>
      </div>
      <p style={{ fontSize: 14, color: "var(--dim)", marginBottom: 22, lineHeight: 1.6 }}>
        One underquoted job can cost more than a year of TrackRakho. Prices per month, billed yearly. GST extra.
      </p>

      {PLANS.map((pl) => (
        <div key={pl.id} className={"plan " + (pl.popular ? "pop" : "")}>
          {pl.popular && <span className="badge"><I.star /> MOST POPULAR</span>}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div><div className="pname">{pl.name}</div><div className="ptag">{pl.tagline}</div></div>
            {current === pl.id && <span className="plan-current">CURRENT</span>}
          </div>
          <div className="prow"><span className="pcur">₹</span><span className="pamt">{pl.price.toLocaleString("en-IN")}</span><span className="pper">/ month</span></div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--faint)" }}>≈ ₹{(pl.price * 12).toLocaleString("en-IN")} / year</div>
          <ul>
            {pl.features.map((f, i) => (<li key={i}><span className="ci"><I.check2 /></span>{f}</li>))}
          </ul>
          <button className={"btn press " + (pl.popular ? "btn-grn" : "btn-ghost")} style={{ width: "100%" }}
            onClick={() => onSubscribe(pl.id)} disabled={current === pl.id}>
            {current === pl.id ? "Your current plan" : <>Choose {pl.name}</>}
          </button>
        </div>
      ))}

      <div className="card-tint" style={{ padding: "16px 16px", marginTop: 8, display: "flex", gap: 10, alignItems: "flex-start" }}>
        <span style={{ color: "var(--grn)", flexShrink: 0, marginTop: 1 }}><I.lock /></span>
        <div style={{ fontSize: 12.5, color: "var(--dim)", lineHeight: 1.6 }}>
          Payment is simulated in this preview. Real UPI / card checkout (Razorpay) connects here before launch. Founding shops in NCR get a locked-for-life discount - ask on WhatsApp.
        </div>
      </div>
    </div></div>
  );
}

/* ================================================================ */
/* one-time trade chooser shown to a fresh account (changeable later in Setup) */
function IndustryPicker({ onPick }) {
  return (
    <div className="qk-root"><style>{CSS}</style>
      <div className="app"><div className="scr"><div className="pagepad" style={{ paddingTop: 44 }}>
        <div className="microlbl">WELCOME</div>
        <div className="h-disp" style={{ fontSize: 27, fontWeight: 700, margin: "4px 0 6px" }}>What do you make?</div>
        <div style={{ color: "var(--dim)", fontSize: 15, marginBottom: 22, lineHeight: 1.55 }}>Pick your trade so the app speaks your language and shows the right examples. You can change it anytime in Setup.</div>
        {Object.values(INDUSTRIES).map((ind, i) => (
          <button key={ind.key} className={"card press anim-in st" + (i + 1)} onClick={() => onPick(ind.key)}
            style={{ display: "flex", alignItems: "center", gap: 15, width: "100%", textAlign: "left", padding: "18px 16px", marginBottom: 12, border: "1.5px solid var(--line2)", background: "#fff", cursor: "pointer" }}>
            <span style={{ width: 52, height: 52, borderRadius: 15, background: "var(--grn-100)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 27, flexShrink: 0 }}>{ind.emoji}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", fontWeight: 700, fontSize: 17 }}>{ind.label}</span>
              <span style={{ display: "block", fontSize: 13, color: "var(--dim)", marginTop: 2 }}>{ind.tag}</span>
            </span>
            <I.chev style={{ color: "var(--faint)" }} />
          </button>
        ))}
      </div></div></div>
    </div>
  );
}

export default function App() {
  const [data, setData] = useState(null);
  const [tab, setTab] = useState("home");
  const [toast, setToast] = useState(null);
  const [draft, setDraft] = useState(null);
  const [step, setStep] = useState(1);
  const [doneQuote, setDoneQuote] = useState(null);
  const [quotesFilter, setQuotesFilter] = useState("all");
  const [quotesCat, setQuotesCat] = useState(null); // category filter set from Home tiles
  const [fabOpen, setFabOpen] = useState(false);
  const [enquiries, setEnquiries] = useState([]); // inbound WhatsApp messages (backend only)
  const [waOn, setWaOn] = useState(false); // true once the WhatsApp backend has answered
  const [sync, setSync] = useState(sb ? "synced" : "local"); // cloud sync state: local|synced|saving|offline
  const [authError, setAuthError] = useState(""); // OAuth return error, shown on the login screen
  const [account, setAccount] = useState(undefined); // undefined = loading, null = logged out, object = logged in
  const [tallyBal, setTallyBal] = useState(null); // Tally outstanding by customer name (lowercased) - filled by the opt-in connector
  const saveT = useRef(null);
  const cloudReadOk = useRef(false); /* cloud writes allowed only after a clean cloud read this session */
  /* ids already logged/dismissed locally - filters the poll so a card can never
     reappear even if the server-side mark-handled call failed */
  const handledIds = useRef(new Set());
  const aiTried = useRef(new Set()); /* media enquiries that already failed one AI read */

  /* poll the WhatsApp backend for incoming enquiries (no-op when not deployed).
     Declared with the other hooks, above any early return, per Rules of Hooks. */
  useEffect(() => {
    let alive = true, t;
    const poll = async () => {
      if (document.hidden) { t = setTimeout(poll, 30000); return; } // skip while backgrounded
      const list = await fetchEnquiries();
      if (!alive) return;
      if (list) { setWaOn(true); setEnquiries(list.filter((e) => !handledIds.current.has(e.id))); }
      t = setTimeout(poll, 30000);
    };
    poll();
    return () => { alive = false; clearTimeout(t); };
  }, []);
  const refreshEnquiries = async () => {
    const list = await fetchEnquiries();
    if (list) { setWaOn(true); setEnquiries(list.filter((e) => !handledIds.current.has(e.id))); return true; }
    return false;
  };

  /* load account (auth). Cloud mode: real Supabase session (Google login),
     kept fresh by onAuthStateChange. Local mode: the original simulated auth. */
  useEffect(() => {
    if (!sb) {
      (async () => {
        try { const r = await storage.get(AUTH_KEY); setAccount(r ? JSON.parse(r.value) : null); }
        catch { setAccount(null); }
      })();
      return;
    }
    const toAccount = (session) => session ? {
      method: "google", uid: session.user.id, email: session.user.email || "",
      name: (session.user.user_metadata && (session.user.user_metadata.full_name || session.user.user_metadata.name)) || session.user.email || "",
    } : null;
    let sub;
    (async () => {
      /* handle the OAuth redirect back from Google ourselves, capturing any error */
      try {
        const u = new URL(window.location.href);
        const hash = new URLSearchParams((u.hash || "").replace(/^#/, ""));
        const errDesc = u.searchParams.get("error_description") || hash.get("error_description") || u.searchParams.get("error") || hash.get("error");
        const code = u.searchParams.get("code");
        if (errDesc) {
          setAuthError(String(errDesc).replace(/\+/g, " "));
        } else if (code) {
          /* exchangeCodeForSession expects the bare code, not the URL */
          const { data: xd, error } = await sb.auth.exchangeCodeForSession(code);
          if (error) setAuthError((error.message || "sign-in failed") + " [exchange]");
          /* returning from the "Connect Gmail" scoped consent? hand the refresh
             token to the server once, then forget it client-side */
          else if (localStorage.getItem(GMAIL_FLAG) || u.searchParams.get("gmail_connect") === "1") {
            const sess = xd && xd.session;
            const rt = sess && sess.provider_refresh_token;
            if (rt) {
              const ok = await gmailSave(rt, (sess.user && sess.user.email) || "");
              setToast(ok ? "Gmail connected - RFQ emails will appear in your pipeline" : "Gmail connect failed - try again from Setup");
              setTimeout(() => setToast(null), 3000);
            }
          }
          localStorage.removeItem(GMAIL_FLAG);
        }
        /* strip auth params from the address bar either way */
        if (code || errDesc || u.hash) window.history.replaceState({}, "", u.origin + u.pathname);
      } catch (e) { setAuthError((e && e.message ? e.message : "sign-in failed") + " [return]"); }

      try { const { data: d } = await sb.auth.getSession(); setAccount(toAccount(d && d.session)); }
      catch { setAccount(null); }
      const res = sb.auth.onAuthStateChange((_evt, session) => setAccount((prev) => {
        const next = toAccount(session);
        /* avoid pointless re-renders/reloads on token refresh for the same user */
        return prev && next && prev.uid === next.uid ? prev : next;
      }));
      sub = res && res.data && res.data.subscription;
    })();
    return () => { if (sub) sub.unsubscribe(); };
  }, []);
  const saveAccount = (acc) => { setAccount(acc); if (!sb) storage.set(AUTH_KEY, JSON.stringify(acc)).catch(() => {}); };
  const logout = async () => {
    if (sb) {
      try { if (account && account.uid) localStorage.removeItem(KEY + ":" + account.uid); } catch {} /* shared-device hygiene */
      try { await sb.auth.signOut(); } catch {}
      setData(null); setSync("synced");
    } else { storage.delete(AUTH_KEY).catch(() => {}); }
    setAccount(null); setTab("home");
  };
  /* demo plan choice: on-device account blob locally; inside the synced shop
     data in cloud mode (the Supabase session object can't hold app fields) */
  const subscribe = (planId) => {
    if (sb) { setData((d) => d ? { ...d, planId, subAt: Date.now() } : d); }
    else saveAccount({ ...account, plan: planId, subAt: Date.now() });
  };

  /* load shop data. Cloud mode: the user's private shop_data row (RLS-enforced),
     with a per-uid localStorage cache for offline; first login migrates any
     on-device data into the account. Local mode: original behaviour. */
  useEffect(() => {
    if (!sb) {
      (async () => {
        try { const r = await storage.get(KEY); setData(r ? JSON.parse(r.value) : seedData()); }
        catch { setData(seedData()); }
      })();
      return;
    }
    if (account === undefined) return;      /* still resolving the session */
    if (!account) { setData(null); return; } /* logged out -> Auth screen */
    cloudReadOk.current = false;             /* no cloud writes until a clean read */
    let alive = true;
    (async () => {
      const cacheKey = KEY + ":" + account.uid;
      try {
        const { data: row, error } = await sb.from("shop_data").select("data").eq("user_id", account.uid).maybeSingle();
        if (!alive) return;
        if (error) throw error;
        if (row && row.data) {
          cloudReadOk.current = true;
          setData(row.data); setSync("synced");
          try { localStorage.setItem(cacheKey, JSON.stringify(row.data)); } catch {}
          return;
        }
        /* first login on this account: adopt this device's data (if any), else seed */
        let seed = null;
        try { const c = localStorage.getItem(cacheKey); if (c) seed = JSON.parse(c); } catch {}
        if (!seed) {
          try {
            const legacy = localStorage.getItem(KEY);
            if (legacy) {
              const parsed = JSON.parse(legacy);
              const n = (parsed.quotes || []).length;
              /* explicit consent: this device may have SOMEONE ELSE'S prototype
                 data - never silently absorb it into the wrong account */
              if (window.confirm("This device has TrackRakho data from before login (" + n + " quote" + (n === 1 ? "" : "s") + ", shop: " + (parsed.shopName || "unnamed") + "). Import it into THIS account?")) {
                seed = parsed; localStorage.removeItem(KEY);
              }
            }
          } catch {}
        }
        if (!seed) seed = seedData();
        setData(seed);
        /* ignoreDuplicates: if another device seeded this account first, do
           nothing - the next load will fetch the real row */
        const { error: e2 } = await sb.from("shop_data").upsert(
          { user_id: account.uid, data: seed, updated_at: new Date().toISOString() },
          { ignoreDuplicates: true });
        cloudReadOk.current = true;
        setSync(e2 ? "offline" : "synced");
        try { localStorage.setItem(cacheKey, JSON.stringify(seed)); } catch {}
      } catch {
        if (!alive) return;
        /* cloud unreachable: run from this account's local cache */
        let cached = null;
        try { const c = localStorage.getItem(cacheKey); if (c) cached = JSON.parse(c); } catch {}
        setData(cached || seedData()); setSync("offline");
      }
    })();
    return () => { alive = false; };
  }, [account ? account.uid : null]);

  /* save shop data: local cache immediately, cloud row debounced */
  useEffect(() => {
    if (!data) return;
    clearTimeout(saveT.current);
    saveT.current = setTimeout(async () => {
      if (!sb || !account) { storage.set(KEY, JSON.stringify(data)).catch(() => {}); return; }
      try { localStorage.setItem(KEY + ":" + account.uid, JSON.stringify(data)); } catch {}
      /* never push to the cloud in a session that couldn't read it - a stale
         cache or fresh seed must not clobber the user's real row */
      if (!cloudReadOk.current) { setSync("offline"); return; }
      setSync("saving");
      try {
        const { error } = await sb.from("shop_data").upsert({ user_id: account.uid, data, updated_at: new Date().toISOString() });
        setSync(error ? "offline" : "synced");
      } catch { setSync("offline"); }
    }, 600);
  }, [data, account]);

  /* Tally outstanding balances (opt-in connector, cloud mode only). Read-only;
     RLS limits the rows to this user. Errors are ignored silently - the feature
     simply stays invisible when the connector has never run. Declared above the
     early returns per Rules of Hooks. */
  useEffect(() => {
    setTallyBal(null); /* never carry one account's balances into the next (shared device) */
    if (!sb || !account || !account.uid) return;
    let alive = true;
    (async () => {
      try {
        const { data: rows, error } = await sb.from("tally_ledgers").select("name,balance");
        if (!alive || error || !rows || !rows.length) return;
        const m = {};
        rows.forEach((r) => { if (Number(r.balance) > 0) m[String(r.name).trim().toLowerCase()] = Number(r.balance); });
        setTallyBal(m);
      } catch {}
    })();
    return () => { alive = false; };
  }, [account ? account.uid : null]);

  const ping = (m) => { setToast(m); setTimeout(() => setToast(null), 1600); };

  /* measured nav pill - tracks the active button exactly. Declared BEFORE any early
     return so hook order stays constant across renders (Rules of Hooks). */
  const navRef = useRef(null);
  const navBtns = useRef({});
  const setNavRef = (k) => (el) => { if (el) navBtns.current[k] = el; };
  const [pillStyle, setPillStyle] = useState({ opacity: 0 });
  useEffect(() => {
    let tries = 0, raf, t;
    const measure = () => {
      const btn = navBtns.current[tab], bar = navRef.current;
      if (!btn || !bar) {
        /* layout not ready yet on first paint - keep retrying briefly */
        if (tries++ < 30) { t = setTimeout(measure, 40); }
        return;
      }
      const b = btn.getBoundingClientRect(), p = bar.getBoundingClientRect();
      if (b.width === 0) { if (tries++ < 30) { t = setTimeout(measure, 40); } return; }
      const inset = 10;
      setPillStyle({ left: (b.left - p.left + inset) + "px", width: Math.max(b.width - inset * 2, 36) + "px", opacity: 1 });
    };
    raf = requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
    return () => { cancelAnimationFrame(raf); clearTimeout(t); window.removeEventListener("resize", measure); };
  }, [tab, data]);

  if (account === undefined || (account && !data))
    return (<div className="qk-root"><style>{CSS}</style><div className="app" style={{ alignItems: "center", justifyContent: "center" }}>
      <div className="mono" style={{ color: "var(--faint)", fontSize: 12, letterSpacing: ".2em" }}>LOADING...</div></div></div>);

  if (!account)
    return (<div className="qk-root"><style>{CSS}</style><div className="app"><Auth onAuthed={saveAccount} authError={authError} /></div></div>);

  /* first run: pick the trade. If the pipeline is still untouched seed/sample
     data, swap in this trade's examples; real data is never overwritten. */
  if (!data.industry)
    return <IndustryPicker onPick={(key) => setData((d) => {
      const untouched = !d.quotes.length || d.quotes.every((q) => q.seed);
      const sq = buildSampleQuotes(key);
      return { ...d, industry: key, quotes: untouched && sq ? sq : d.quotes };
    })} />;

  const startQuote = () => {
    setFabOpen(false);
    setDraft({ customer: "", phone: "", part: "", qty: "", materialId: "", rawKg: "", machineId: data.machines[0]?.id || "",
      cycleMin: "", manualMin: "", setupMin: "", toolingPc: 5, overheadPct: data.settings.overheadPct, marginPct: data.settings.marginPct });
    setStep(1); setDoneQuote(null); setTab("new");
  };
  const startLog = () => { setFabOpen(false); setTab("log"); };
  const saveQuote = (c) => {
    const q = { id: uid(), at: Date.now(), status: "pending", customer: draft.customer, phone: (draft.phone || "").replace(/\D/g, ""),
      part: draft.part, qty: +draft.qty, pricePc: c.pricePc, total: c.total, followUp: null, source: "wizard" };
    setData({ ...data, quotes: [q, ...data.quotes] }); setDoneQuote(q);
  };
  const saveLogged = (q) => { setData({ ...data, quotes: [q, ...data.quotes] }); setTab("quotes"); setQuotesFilter("all"); ping("Quote logged"); };
  const importQuotes = (rows) => { setData({ ...data, quotes: [...rows, ...data.quotes] }); ping(rows.length + " quote" + (rows.length === 1 ? "" : "s") + " imported"); };
  /* turn an inbound WhatsApp enquiry into a pending pipeline quote */
  const logEnquiry = async (enq) => {
    /* claim the enquiry BEFORE the (up to ~8s) AI read so a second impatient
       tap can't log the same quote twice */
    if (handledIds.current.has(enq.id)) return;
    handledIds.current.add(enq.id);
    let p = parseEnquiry(enq.text || "");
    let transcript = "";
    const hasMedia = (enq.type === "image" || enq.type === "document") && enq.mediaId;
    if (data.settings.aiParse && hasMedia) {
      const what = enq.type === "image" ? "Photo" : "Document";
      ping("AI reading the " + what.toLowerCase() + "...");
      const res = await aiReadMedia(enq.mediaId, enq.text || "");
      if (res.fields) { p = mergeParsed(p, res.fields); transcript = res.fields.transcript || ""; }
      else if (!aiTried.current.has(enq.id)) {
        /* first failure: keep the card so a second tap can retry, instead of
           silently logging an empty quote */
        aiTried.current.add(enq.id);
        handledIds.current.delete(enq.id); /* release the double-tap claim */
        ping(what + " not read (" + res.why + ") - tap Log again to retry");
        return;
      } else {
        ping(what + " still not read - logging without AI details");
      }
    } else if (data.settings.aiParse && enq.text) {
      ping("AI reading the message...");
      const ai = await aiParseEnquiry(enq.text);
      if (ai) p = mergeParsed(p, ai);
    }
    /* gmail "from" is an email address, not a phone - only trust the parsed one there */
    const phone = enq.source === "gmail"
      ? String(p.phone || "").replace(/\D/g, "").replace(/^91(?=\d{10}$)/, "")
      : String(enq.from || p.phone || "").replace(/\D/g, "").replace(/^91(?=\d{10}$)/, "");
    const bits = [];
    if (enq.source === "gmail" && enq.from) bits.push("[Email: " + enq.from + "]");
    if (enq.type === "image") bits.push("[Photo on WhatsApp]");
    if (enq.type === "document") bits.push("[Doc: " + (enq.filename || "file") + "]");
    if (enq.text) bits.push(enq.text);
    if (transcript) bits.push("AI read: " + transcript);
    const qty = num(p.qty), total = num(p.total);
    const q = { id: uid(), at: enq.at || Date.now(), status: "pending",
      customer: enq.name || p.customer || "WhatsApp lead", phone,
      part: p.part || (enq.type === "document" && enq.filename ? enq.filename : "(from WhatsApp)"),
      qty, pricePc: p.rate ? num(p.rate) : (qty ? total / qty : 0), total,
      followUp: p.followUp || null, source: enq.source === "gmail" ? "gmail" : "whatsapp", note: bits.join(" ") };
    setData((d) => ({ ...d, quotes: [q, ...d.quotes] }));
    handledIds.current.add(enq.id);
    setEnquiries((list) => list.filter((x) => x.id !== enq.id));
    markEnquiryHandled(enq.id);
    setTab("quotes"); setQuotesFilter("all"); ping("Enquiry added to pipeline");
  };
  const dismissEnquiry = (enq) => { handledIds.current.add(enq.id); setEnquiries((list) => list.filter((x) => x.id !== enq.id)); markEnquiryHandled(enq.id); ping("Enquiry dismissed"); };
  const setStatus = (id, status) => setData({ ...data, quotes: data.quotes.map((q) => (q.id === id ? { ...q, status } : q)) });
  const updateQuote = (id, patch) => setData({ ...data, quotes: data.quotes.map((q) => (q.id === id ? { ...q, ...patch } : q)) });
  const delQuote = (id) => setData({ ...data, quotes: data.quotes.filter((q) => q.id !== id) });
  const goQuotes = (f, cat) => { setQuotesFilter(f || "all"); setQuotesCat(cat || null); setTab("quotes"); };

  /* in cloud mode the demo plan lives inside the synced data blob */
  const accountView = account ? { ...account, plan: sb ? (data && data.planId) : account.plan } : account;

  return (
    <div className="qk-root"><style>{CSS}</style>
      <div className="app">
        {toast && <div className="toast">{toast}</div>}

        {tab === "home" && <Home data={data} account={accountView} onNew={startQuote} onLog={startLog} goQuotes={goQuotes} openAnalytics={() => setTab("analytics")} openTally={() => setTab("tally")} goSetup={() => setTab("setup")} goSubscribe={() => setTab("subscribe")} />}
        {tab === "quotes" && <Quotes data={data} setStatus={setStatus} updateQuote={updateQuote} delQuote={delQuote} importQuotes={importQuotes} ping={ping} filter={quotesFilter} setFilter={setQuotesFilter} cat={quotesCat} setCat={setQuotesCat} onLog={startLog} enquiries={enquiries} logEnquiry={logEnquiry} dismissEnquiry={dismissEnquiry} waOn={waOn} refreshEnquiries={refreshEnquiries} tallyBal={tallyBal} />}
        {tab === "log" && <QuickLog data={data} onSave={saveLogged} onExit={() => setTab("home")} ping={ping} />}
        {tab === "setup" && <Setup data={data} setData={setData} ping={ping} account={accountView} sync={sync} goSubscribe={() => setTab("subscribe")} onLogout={logout} />}
        {tab === "help" && <Help data={data} ping={ping} />}
        {tab === "analytics" && <Analytics data={data} onBack={() => setTab("home")} goQuotes={goQuotes} />}
        {tab === "tally" && <TallyInsights data={data} updateQuote={updateQuote} ping={ping} onBack={() => setTab("home")} />}
        {tab === "subscribe" && <Subscribe account={accountView} onSubscribe={(id) => { subscribe(id); ping("You're on the " + PLANS.find(p => p.id === id).name + " plan"); setTab("home"); }} onBack={() => setTab("home")} />}
        {tab === "new" && (<Wizard data={data} draft={draft} setDraft={setDraft} step={step} setStep={setStep}
          onExit={() => setTab("home")} onSave={saveQuote} doneQuote={doneQuote} ping={ping}
          onFinish={() => { setTab("home"); setDoneQuote(null); }} />)}

        {/* FAB chooser - quick log (tracker-first) vs full costing quote */}
        {fabOpen && (
          <div onClick={() => setFabOpen(false)} style={{ position: "absolute", inset: 0, zIndex: 60, background: "rgba(16,26,20,.42)", backdropFilter: "blur(3px)", display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
            <div className="anim-in" onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: "26px 26px 0 0", padding: "22px 18px calc(20px + env(safe-area-inset-bottom))", boxShadow: "0 -20px 50px -20px rgba(21,94,24,.4)" }}>
              <div style={{ width: 40, height: 4, borderRadius: 3, background: "var(--line2)", margin: "0 auto 16px" }} />
              <div className="microlbl" style={{ marginLeft: 2 }}>ADD TO PIPELINE</div>
              <div className="h-disp" style={{ fontSize: 21, fontWeight: 700, margin: "3px 0 16px 2px" }}>How do you want to add it?</div>
              <button className="press" onClick={startLog} style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", width: "100%", display: "flex", alignItems: "center", gap: 14, padding: "16px", borderRadius: 18, background: "linear-gradient(135deg,#1B7A20,#2E9E33)", color: "#fff", marginBottom: 10, boxShadow: "var(--sh-m)" }}>
                <span style={{ width: 42, height: 42, borderRadius: 13, background: "rgba(255,255,255,.18)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><I.bolt /></span>
                <span style={{ flex: 1 }}><span style={{ display: "block", fontWeight: 700, fontSize: 16 }}>Log a quote</span><span style={{ fontSize: 12.5, color: "rgba(255,255,255,.85)" }}>Made it in Excel or on call? Add it in 30 seconds.</span></span>
                <I.chev />
              </button>
              <button className="press" onClick={startQuote} style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", width: "100%", display: "flex", alignItems: "center", gap: 14, padding: "16px", borderRadius: 18, background: "#fff", border: "1.5px solid var(--line2)", boxShadow: "var(--sh-s)" }}>
                <span style={{ width: 42, height: 42, borderRadius: 13, background: "var(--grn-100)", color: "var(--grn-d)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><I.chart /></span>
                <span style={{ flex: 1 }}><span style={{ display: "block", fontWeight: 700, fontSize: 16 }}>New quotation</span><span style={{ fontSize: 12.5, color: "var(--dim)" }}>Full costing wizard - material, machine, margin.</span></span>
                <I.chev style={{ color: "var(--faint)" }} />
              </button>
            </div>
          </div>
        )}

        {tab !== "new" && tab !== "analytics" && tab !== "subscribe" && tab !== "log" && tab !== "tally" && (
          <nav className="navbar" ref={navRef}>
            <div className="nav-pill" style={pillStyle} />
            <button ref={setNavRef("home")} className={"nav-it " + (tab === "home" ? "on" : "")} onClick={() => setTab("home")}><I.home /><span>Home</span></button>
            <button ref={setNavRef("quotes")} className={"nav-it " + (tab === "quotes" ? "on" : "")} onClick={() => setTab("quotes")}><I.list /><span>Pipeline</span></button>
            <button className="fab press" onClick={() => (industryOf(data).key === "machining" ? setFabOpen(true) : startLog())} aria-label="Add a quote"><I.plus /></button>
            <button ref={setNavRef("setup")} className={"nav-it " + (tab === "setup" ? "on" : "")} onClick={() => setTab("setup")}><I.gear /><span>Setup</span></button>
            <button ref={setNavRef("help")} className={"nav-it " + (tab === "help" ? "on" : "")} onClick={() => setTab("help")}><I.help /><span>Help</span></button>
          </nav>
        )}
      </div>
    </div>
  );
}

/* ================= HOME ================= */
function Home({ data, account, onNew, onLog, goQuotes, openAnalytics, openTally, goSetup, goSubscribe }) {
  const ind = industryOf(data);
  const isMach = ind.key === "machining";
  const h = new Date().getHours();
  const greet = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";

  /* ---- the numbers that actually matter to an owner ---- */
  const m0 = new Date(); m0.setDate(1); m0.setHours(0, 0, 0, 0);
  const month = data.quotes.filter((q) => q.at >= m0.getTime());
  const monthQuoted = month.reduce((s, q) => s + q.total, 0);
  const monthWon = month.filter((q) => q.status === "won");
  const monthWonVal = monthWon.reduce((s, q) => s + q.total, 0);
  const monthLost = month.filter((q) => q.status === "lost").length;
  const winRate = monthWon.length + monthLost ? Math.round((monthWon.length / (monthWon.length + monthLost)) * 100) : null;
  const pendingQs = data.quotes.filter((q) => q.status === "pending");
  const pendingValue = pendingQs.reduce((s, q) => s + q.total, 0);
  const wonQs = data.quotes.filter((q) => q.status === "won");
  const wonValue = wonQs.reduce((s, q) => s + q.total, 0);
  const days = [...Array(7)].map((_, i) => {
    const d0 = new Date(); d0.setHours(0, 0, 0, 0); d0.setDate(d0.getDate() - (6 - i));
    const d1 = new Date(d0); d1.setDate(d1.getDate() + 1);
    return data.quotes.filter((q) => q.at >= d0 && q.at < d1).length;
  });
  const dmax = Math.max(1, ...days);
  const dueList = data.quotes.filter((q) => { const st = followState(q); return st === "overdue" || st === "today"; })
    .sort((a, b) => a.followUp - b.followUp);
  const recent = data.quotes.slice(0, 3);

  /* category tiles: printing shows active ones, furniture shows the full range */
  const showCats = ind.key === "printing" || ind.key === "furniture";
  const catStats = showCats
    ? (ind.cats || []).filter((c) => c.key !== "other").map((c) => {
        const qs = data.quotes.filter((x) => catOf(x, ind) === c.key);
        return { ...c, total: qs.length, ongoing: qs.filter((x) => x.status === "pending").length };
      }).filter((c) => ind.key === "furniture" || c.total > 0)
    : [];

  const kpis = [
    [inr(pendingValue), "PENDING VALUE", "var(--amber)", () => goQuotes("pending")],
    [inr(monthWonVal), "WON THIS MONTH", "#1B7A20", () => goQuotes("won")],
    [inr(monthQuoted), "QUOTED THIS MONTH", "var(--grn-d)", () => goQuotes("all")],
    [winRate == null ? "—" : winRate + "%", "WIN RATE", "var(--ink)", openAnalytics],
  ];

  return (
    <div className="scr"><div className="pagepad">
      <div className="anim-in" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
        <div>
          <div className="microlbl">{new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short" })}</div>
          <div className="h-disp" style={{ fontSize: 25, fontWeight: 700, marginTop: 3 }}>{greet}</div>
          <div style={{ fontSize: 14, color: "var(--dim)" }}>{data.shopName} · {ind.label}</div>
        </div>
        <button onClick={goSetup} className="press" style={{ width: 46, height: 46, borderRadius: 15, background: "linear-gradient(135deg,#2E9E33,#155E18)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--mono)", fontWeight: 600, fontSize: 14, boxShadow: "var(--sh-s)", border: "none", cursor: "pointer" }}>
          {data.shopName.split(" ").map((w) => w[0]).slice(0, 2).join("")}
        </button>
      </div>

      {/* at a glance - same KPI language as Analytics */}
      <div className="card anim-in st1" style={{ padding: "16px 16px 12px", marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <span className="eyebrow">At a glance</span>
          <span className="mono" style={{ fontSize: 10, letterSpacing: ".12em", color: "var(--faint)" }}>{new Date().toLocaleDateString("en-IN", { month: "long" }).toUpperCase()}</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9 }}>
          {kpis.map(([v, l, c, fn], i) => (
            <button key={i} className="press" onClick={fn} style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", padding: "13px 13px", borderRadius: 15, background: "var(--soft)", border: "1px solid var(--line)" }}>
              <div className="h-disp mono" style={{ fontSize: 20, fontWeight: 700, color: c, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{v}</div>
              <div style={{ fontSize: 10.5, fontWeight: 600, color: "var(--faint)", marginTop: 3, letterSpacing: ".05em" }}>{l}</div>
            </button>
          ))}
        </div>
        <button className="press" onClick={openAnalytics} style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "11px 4px 4px", marginTop: 4 }}>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 26, flex: 1 }}>
            {days.map((v, i) => (<i key={i} style={{ flex: 1, borderRadius: 3, background: v ? "var(--grn)" : "var(--line2)", opacity: v ? 0.35 + (v / dmax) * 0.65 : 1, height: 5 + (v / dmax) * 20, display: "block" }} />))}
          </div>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--grn-d)", display: "flex", alignItems: "center", flexShrink: 0 }}>Analytics <I.chev style={{ width: 14 }} /></span>
        </button>
      </div>

      {/* actions */}
      {isMach ? (
        <div className="anim-in st2" style={{ display: "grid", gridTemplateColumns: "1.35fr 1fr", gap: 10 }}>
          <button className="btn btn-grn press" style={{ padding: 16 }} onClick={onLog}><I.bolt /> Log a quote</button>
          <button className="btn btn-ghost press" style={{ padding: 16 }} onClick={onNew}><I.plus style={{ width: 17 }} /> Full quote</button>
        </div>
      ) : (
        <button className="btn btn-grn press anim-in st2" style={{ width: "100%", padding: 16 }} onClick={onLog}><I.bolt /> Log a quote</button>
      )}

      {/* machining: the day runs on RFQs and orders */}
      {isMach && (
        <div className="anim-in st2" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12 }}>
          <button className="press" onClick={() => goQuotes("pending")} style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", padding: "16px 15px", borderRadius: 20, background: "#fff", border: "1px solid var(--line)", boxShadow: "var(--sh-s)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ width: 40, height: 40, borderRadius: 12, background: "var(--amber-bg)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 19 }}>📨</span>
              <I.chev style={{ color: "var(--faint)" }} />
            </div>
            <div className="h-disp mono" style={{ fontSize: 24, fontWeight: 700, marginTop: 10 }}>{pendingQs.length}</div>
            <div style={{ fontSize: 13.5, fontWeight: 700, marginTop: 1 }}>RFQs open</div>
            <div className="mono" style={{ fontSize: 11.5, color: "var(--faint)", marginTop: 2 }}>{inr(pendingValue)} on the table</div>
          </button>
          <button className="press" onClick={() => goQuotes("won")} style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", padding: "16px 15px", borderRadius: 20, background: "#fff", border: "1px solid var(--line)", boxShadow: "var(--sh-s)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ width: 40, height: 40, borderRadius: 12, background: "var(--grn-100)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 19 }}>📦</span>
              <I.chev style={{ color: "var(--faint)" }} />
            </div>
            <div className="h-disp mono" style={{ fontSize: 24, fontWeight: 700, marginTop: 10 }}>{wonQs.length}</div>
            <div style={{ fontSize: 13.5, fontWeight: 700, marginTop: 1 }}>Orders ongoing</div>
            <div className="mono" style={{ fontSize: 11.5, color: "var(--faint)", marginTop: 2 }}>{inr(wonValue)} won</div>
          </button>
        </div>
      )}

      {dueList.length > 0 && (
        <button onClick={() => goQuotes("due")} className="press anim-in st3" style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", width: "100%", marginTop: 12, display: "flex", alignItems: "center", gap: 12, padding: "15px 16px", borderRadius: 18, background: "var(--amber-bg)", border: "1px solid #F0DCB8" }}>
          <span style={{ width: 40, height: 40, borderRadius: 12, background: "#fff", color: "var(--amber)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><I.bell /></span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: "block", fontWeight: 700, fontSize: 15, color: "var(--amber)" }}>{dueList.length} follow-up{dueList.length === 1 ? "" : "s"} due</span>
            <span style={{ display: "block", fontSize: 13, color: "#7A5510", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{dueList.slice(0, 2).map((q) => q.customer).join(", ")}{dueList.length > 2 ? " +" + (dueList.length - 2) + " more" : ""}</span>
          </span>
          <I.chev style={{ color: "var(--amber)" }} />
        </button>
      )}

      {/* Tally insights - only for trades that actually run Tally */}
      {ind.tally && <button onClick={openTally} className="press anim-in st3" style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", width: "100%", marginTop: 12, display: "flex", alignItems: "center", gap: 12, padding: "15px 16px", borderRadius: 18, background: "linear-gradient(135deg,#10240F,#1B5E20)", color: "#fff", boxShadow: "var(--sh-m)" }}>
        <span style={{ width: 40, height: 40, borderRadius: 12, background: "rgba(255,255,255,.14)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 19, flexShrink: 0 }}>📒</span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "block", fontWeight: 700, fontSize: 15 }}>Tally - seedha hisaab</span>
          <span style={{ display: "block", fontSize: 12.5, color: "rgba(255,255,255,.8)" }}>Baki paisa, maal gaya, order kitna bacha - bina Tally khole.</span>
        </span>
        <I.chev style={{ color: "rgba(255,255,255,.8)" }} />
      </button>}

      {catStats.length > 0 && (<>
        <div className="anim-in st3" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "24px 0 10px" }}>
          <span className="eyebrow">Browse by {ind.key === "furniture" ? "product" : "job type"}</span>
          <button onClick={() => goQuotes("all")} style={{ background: "none", border: "none", color: "var(--grn-d)", fontWeight: 600, fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center" }}>All <I.chev /></button>
        </div>
        <div className="anim-in st3" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {catStats.map((c) => (
            <button key={c.key} onClick={() => goQuotes("all", c.key)} className="press cat-tile"
              style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", display: "flex", alignItems: "center", gap: 11, padding: "13px 12px", background: "#fff", border: "1px solid var(--line)", borderRadius: 20, boxShadow: "var(--sh-s)", minWidth: 0, opacity: c.total ? 1 : 0.65 }}>
              <span style={{ width: 44, height: 44, borderRadius: 13, background: "var(--grn-100)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, flexShrink: 0 }}>{c.emoji}</span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <span style={{ display: "block", fontWeight: 700, fontSize: 15, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.label}</span>
                <span style={{ display: "block", fontSize: 12, color: c.ongoing ? "var(--amber)" : "var(--faint)", fontWeight: 600, marginTop: 1 }}>{c.total ? (c.ongoing ? c.ongoing + " ongoing" : c.total + " done") : "—"}</span>
              </span>
            </button>
          ))}
        </div>
      </>)}

      <div className="anim-in st3" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "24px 0 10px" }}>
        <span className="eyebrow">Recent quotes</span>
        <button onClick={() => goQuotes("all")} style={{ background: "none", border: "none", color: "var(--grn-d)", fontWeight: 600, fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center" }}>All <I.chev /></button>
      </div>

      {recent.map((q, i) => (
        <button key={q.id} onClick={() => goQuotes("all")} className={"card press anim-in st" + (4 + i)}
          style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", display: "flex", alignItems: "center", gap: 12, padding: "14px 15px", marginBottom: 10, background: "#fff", border: "1px solid var(--line)", borderRadius: 22, width: "100%", boxShadow: "var(--sh-s)" }}>
          {q.image ? (
            <img src={q.image} alt="" style={{ width: 44, height: 44, borderRadius: 12, objectFit: "cover", flexShrink: 0, border: "1px solid var(--line2)" }} />
          ) : (
            <span style={{ width: 44, height: 44, borderRadius: 12, background: "var(--grn-100)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>{catMeta(ind, catOf(q, ind)).emoji}</span>
          )}
          <span style={{ minWidth: 0, flex: 1 }}>
            <span style={{ display: "block", fontWeight: 600, fontSize: 15, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{q.customer}</span>
            <span style={{ display: "block", fontSize: 13, color: "var(--dim)", marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{q.part}{q.qty ? " · " + q.qty + " " + (ind.unit || "pcs") : ""}</span>
          </span>
          <span style={{ textAlign: "right", flexShrink: 0 }}>
            <span className="mono" style={{ display: "block", fontWeight: 600, fontSize: 15 }}>{inr(q.total)}</span>
            <span className={"pill " + (q.status === "won" ? "won" : q.status === "lost" ? "lost" : "pend")} style={{ marginTop: 4 }}><i className="dot" />{q.status.toUpperCase()}</span>
          </span>
        </button>
      ))}

      {!account?.plan && (
        <button onClick={goSubscribe} className="press anim-in st6" style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", width: "100%", marginTop: 6, display: "flex", alignItems: "center", gap: 12, padding: "15px 16px", borderRadius: 18, background: "linear-gradient(135deg,#1B7A20,#2E9E33)", color: "#fff", boxShadow: "var(--sh-m)" }}>
          <span style={{ flexShrink: 0 }}><I.crown /></span>
          <span style={{ flex: 1, fontSize: 13.5, fontWeight: 600 }}>Unlock unlimited quotes & analytics</span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 12, background: "rgba(255,255,255,.2)", padding: "5px 10px", borderRadius: 999 }}>From ₹2,500 ›</span>
        </button>
      )}

      {isMach && data.machines[0] && (
        <div className="card-tint anim-in st7" style={{ padding: "15px 16px", display: "flex", gap: 10, alignItems: "center", marginTop: 10 }}>
          <span style={{ color: "var(--grn)" }}><I.bolt /></span>
          <span style={{ fontSize: 13.5, color: "var(--dim)" }}>Your {data.machines[0].name}'s true rate is <b className="mono" style={{ color: "var(--grn-d)" }}>{inr(data.machines[0].rate || 0)}/hr</b> - every quote uses it automatically.</span>
        </div>
      )}
    </div></div>
  );
}

/* ================= QUICK LOG (tracker-first 30-second entry) ================= */
function QuickLog({ data, onSave, onExit, ping }) {
  const [f, setF] = useState({ customer: "", phone: "", part: "", spec: "", total: "", qty: "", status: "pending", followUp: "", note: "", image: "", category: "" });
  const [pasteOpen, setPasteOpen] = useState(false);
  const [paste, setPaste] = useState("");
  const [reading, setReading] = useState(false); // AI reading in progress
  const photoRef = useRef(null);
  const ind = industryOf(data);
  const upd = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const ok = f.customer.trim() && num(f.total) > 0;
  const onPhoto = async (e) => {
    const file = e.target.files && e.target.files[0]; e.target.value = "";
    if (!file) return;
    const url = await downscaleImage(file);
    if (url) { upd("image", url); ping("Photo added"); } else ping("Could not read that image");
  };

  const applyPaste = async () => {
    let p = parseEnquiry(paste);
    if (data.settings.aiParse && paste.trim()) {
      setReading(true);
      const ai = await aiParseEnquiry(paste);
      setReading(false);
      if (ai) p = mergeParsed(p, ai);
    }
    setF((s) => ({ ...s, customer: p.customer || s.customer, phone: p.phone || s.phone,
      part: p.part || s.part, total: p.total || s.total, qty: p.qty || s.qty,
      followUp: p.followUp ? isoDate(p.followUp) : s.followUp }));
    setPasteOpen(false); setPaste(""); ping("Filled from message - check the fields");
  };
  const save = () => {
    if (!ok) return;
    const total = num(f.total), qty = num(f.qty);
    onSave({
      id: uid(), at: Date.now(), status: f.status, customer: f.customer.trim(), phone: f.phone.replace(/\D/g, ""),
      part: f.part.trim() || "(no part)", spec: f.spec.trim() || "", qty, pricePc: qty ? total / qty : 0, total,
      followUp: f.followUp ? new Date(f.followUp).getTime() : null, source: "logged", note: f.note.trim() || "", image: f.image || "",
      category: f.category || guessCategory(f.part, ind.key),
    });
  };

  return (
    <>
      <div className="scr"><div className="pagepad" style={{ paddingBottom: 130 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <button className="iconbtn press" onClick={onExit}><I.back /></button>
          <div style={{ flex: 1 }}>
            <div className="microlbl">QUICK ENTRY</div>
            <div className="h-disp" style={{ fontSize: 23, fontWeight: 700 }}>Log a quote</div>
          </div>
          <button className="btn btn-sm btn-soft press" onClick={() => setPasteOpen(!pasteOpen)}><I.wa /> Paste</button>
        </div>

        {pasteOpen && (
          <div className="card anim-in" style={{ padding: 14, marginBottom: 16, border: "1.5px solid #CFE9D1" }}>
            <div className="lbl" style={{ color: "var(--grn-d)", marginBottom: 4 }}>Paste a WhatsApp / enquiry message</div>
            <span className="hint">We'll try to pull out the customer, part name, amount, quantity, phone number and any date mentioned. Always check before saving.</span>
            <textarea className="input" style={{ minHeight: 90, resize: "vertical", fontFamily: "var(--sans)" }} placeholder="Paste the customer's message here..." value={paste} onChange={(e) => setPaste(e.target.value)} />
            <button className="btn btn-grn btn-sm press" style={{ width: "100%", marginTop: 10 }} onClick={applyPaste} disabled={!paste.trim() || reading}>{reading ? "AI reading..." : "Fill the form"}</button>
          </div>
        )}

        <label className="lbl">Customer</label>
        <input className="input" placeholder="e.g. Bharat Traders" value={f.customer} onChange={(e) => upd("customer", e.target.value)} />
        <div style={{ height: 14 }} />

        <label className="lbl">WhatsApp number <span style={{ fontWeight: 400, color: "var(--faint)", fontSize: 13 }}>(optional)</span></label>
        <div className="phone-field">
          <span className="cc">+91</span>
          <input type="tel" inputMode="numeric" placeholder="98xxxxxxxx" value={f.phone} onChange={(e) => upd("phone", e.target.value.replace(/\D/g, "").slice(0, 10))} />
        </div>
        <div style={{ height: 14 }} />

        <label className="lbl">{ind.item} <span style={{ fontWeight: 400, color: "var(--faint)", fontSize: 13 }}>(optional)</span></label>
        <input className="input" placeholder={"e.g. " + ind.eg} value={f.part} onChange={(e) => upd("part", e.target.value)} />
        <div style={{ height: 14 }} />

        {ind.spec && (<>
          <label className="lbl">{ind.spec.label} <span style={{ fontWeight: 400, color: "var(--faint)", fontSize: 13 }}>(optional)</span></label>
          <input className="input" placeholder={"e.g. " + ind.spec.eg} value={f.spec} onChange={(e) => upd("spec", e.target.value)} />
          <div style={{ height: 14 }} />
        </>)}

        <label className="lbl">Category</label>
        <div className="cat-scroll" style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4 }}>
          {(ind.cats || []).map((c) => (
            <button key={c.key} className={"catchip press " + (f.category === c.key ? "on" : "")} onClick={() => upd("category", f.category === c.key ? "" : c.key)}>
              <span style={{ fontSize: 14 }}>{c.emoji}</span> {c.label}
            </button>
          ))}
        </div>
        <div style={{ height: 14 }} />

        <label className="lbl">Photo <span style={{ fontWeight: 400, color: "var(--faint)", fontSize: 13 }}>(optional)</span></label>
        <span className="hint">Add the design or product photo - it shows on the pipeline card so you can spot it at a glance.</span>
        <input ref={photoRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }} onChange={onPhoto} />
        {f.image ? (
          <div style={{ position: "relative", width: 108, height: 108, borderRadius: 14, overflow: "hidden", border: "1px solid var(--line2)" }}>
            <img src={f.image} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            <button className="press" onClick={() => upd("image", "")} title="Remove photo"
              style={{ position: "absolute", top: 5, right: 5, width: 28, height: 28, borderRadius: "50%", border: "none", background: "rgba(16,26,20,.62)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}><I.trash style={{ width: 14, height: 14 }} /></button>
          </div>
        ) : (
          <button className="btn btn-soft btn-sm press" onClick={() => photoRef.current && photoRef.current.click()}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M4 8h3l1.5-2h7L18 8h2a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/><circle cx="12" cy="13" r="3.2" stroke="currentColor" strokeWidth="1.8"/></svg>
            Add photo
          </button>
        )}
        <div style={{ height: 14 }} />

        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 12 }}>
          <div>
            <label className="lbl">Quote amount</label>
            <div className="suffix-wrap"><input className="input mono" type="number" inputMode="decimal" placeholder="128000" value={f.total} onChange={(e) => upd("total", e.target.value)} /><span className="sfx">₹ TOTAL</span></div>
          </div>
          <div>
            <label className="lbl">Qty <span style={{ fontWeight: 400, color: "var(--faint)", fontSize: 12 }}>(opt)</span></label>
            <div className="suffix-wrap"><input className="input mono" type="number" inputMode="numeric" placeholder="—" value={f.qty} onChange={(e) => upd("qty", e.target.value)} /><span className="sfx">PCS</span></div>
          </div>
        </div>
        {num(f.total) > 0 && num(f.qty) > 0 && (
          <div style={{ fontSize: 12.5, color: "var(--dim)", margin: "8px 0 0 2px" }} className="mono">= {inr(num(f.total) / num(f.qty), 2)} / pc</div>
        )}
        <div style={{ height: 16 }} />

        <label className="lbl">Status</label>
        <div style={{ display: "flex", gap: 8 }}>
          {[["pending", "Pending", "pend"], ["won", "Won", "won"], ["lost", "Lost", "lost"]].map(([k, l]) => (
            <button key={k} className={"fpill press " + (f.status === k ? "on" : "")} style={{ flex: 1 }} onClick={() => upd("status", k)}>{l}</button>
          ))}
        </div>
        <div style={{ height: 16 }} />

        <label className="lbl">Follow-up date <span style={{ fontWeight: 400, color: "var(--faint)", fontSize: 13 }}>(optional)</span></label>
        <span className="hint">Set a date to chase this quote - it shows up on your Home screen when due.</span>
        <input className="input mono" type="date" value={f.followUp} onChange={(e) => upd("followUp", e.target.value)} />
        <div style={{ height: 14 }} />

        <label className="lbl">Note <span style={{ fontWeight: 400, color: "var(--faint)", fontSize: 13 }}>(optional)</span></label>
        <input className="input" placeholder="e.g. wants delivery by month-end" value={f.note} onChange={(e) => upd("note", e.target.value)} />
      </div></div>

      <div className="runbar" style={{ background: "#fff", border: "1px solid var(--line)", padding: 10 }}>
        <button className="btn btn-grn press" style={{ width: "100%" }} onClick={save} disabled={!ok}><I.check2 /> Save to pipeline</button>
      </div>
    </>
  );
}

/* ================= WIZARD ================= */
function Wizard({ data, draft, setDraft, step, setStep, onExit, onSave, doneQuote, onFinish, ping }) {
  const c = calcQuote(draft, data);
  const upd = (k, v) => setDraft({ ...draft, [k]: v });
  const ok1 = draft.customer.trim() && draft.part.trim() && +draft.qty > 0;
  const ok2 = draft.materialId && +draft.rawKg > 0;
  const ok3 = draft.machineId && +draft.cycleMin > 0;
  const titles = ["Job", "Material", "Machining", "Price"];

  if (doneQuote) return <Success q={doneQuote} data={data} onFinish={onFinish} ping={ping} />;

  return (
    <>
      <div className="scr"><div className="pagepad" style={{ paddingBottom: 150 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <button className="iconbtn press" onClick={() => (step > 1 ? setStep(step - 1) : onExit())}><I.back /></button>
          <div style={{ flex: 1 }}>
            <div className="microlbl">NEW QUOTATION · STEP {step} OF 4</div>
            <div className="h-disp" style={{ fontSize: 23, fontWeight: 700 }}>{titles[step - 1]}</div>
          </div>
        </div>
        <div className="steps" style={{ marginBottom: 22 }}>{[1, 2, 3, 4].map((i) => <i key={i} className={i <= step ? "on" : ""} />)}</div>

        {step === 1 && (
          <div key="s1" className="anim-in">
            <label className="lbl">Customer</label>
            <input className="input" placeholder="e.g. Apex Hydraulics" value={draft.customer} onChange={(e) => upd("customer", e.target.value)} />
            <div style={{ height: 16 }} />
            <label className="lbl">WhatsApp number <span style={{ fontWeight: 400, color: "var(--faint)", fontSize: 13 }}>(optional)</span></label>
            <div className="phone-field">
              <span className="cc">+91</span>
              <input type="tel" inputMode="numeric" placeholder="98xxxxxxxx" value={draft.phone || ""} onChange={(e) => upd("phone", e.target.value.replace(/\D/g, "").slice(0, 10))} />
            </div>
            <div style={{ height: 16 }} />
            <label className="lbl">Part name</label>
            <input className="input" placeholder="e.g. Gland Nut - 60mm" value={draft.part} onChange={(e) => upd("part", e.target.value)} />
            <div style={{ height: 16 }} />
            <label className="lbl">Quantity</label>
            <div className="suffix-wrap"><input className="input mono" type="number" inputMode="numeric" placeholder="200" value={draft.qty} onChange={(e) => upd("qty", e.target.value)} /><span className="sfx">PCS</span></div>
          </div>
        )}

        {step === 2 && (
          <div key="s2" className="anim-in">
            <label className="lbl">Material</label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9 }}>
              {data.materials.map((m) => (
                <button key={m.id} className={"chip press " + (draft.materialId === m.id ? "on" : "")} onClick={() => upd("materialId", m.id)}>
                  <span className="cn">{m.name}</span><span className="cr">{inr(m.rate)}/kg</span>
                </button>
              ))}
            </div>
            <div style={{ height: 18 }} />
            <label className="lbl">Raw weight per piece</label>
            <span className="hint">Weight of the raw blank for <b>one</b> piece before machining - bar or block, not the finished weight. Weigh one offcut if unsure.</span>
            <div className="suffix-wrap"><input className="input mono" type="number" inputMode="decimal" placeholder="0.60" value={draft.rawKg} onChange={(e) => upd("rawKg", e.target.value)} /><span className="sfx">KG</span></div>
            {draft.materialId && +draft.rawKg > 0 && (
              <div className="card-tint" style={{ padding: "13px 15px", marginTop: 14, display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontSize: 14, color: "var(--dim)" }}>Material cost / pc</span>
                <b className="mono" style={{ color: "var(--grn-d)" }}>{inr(+draft.rawKg * data.materials.find((m) => m.id === draft.materialId).rate, 2)}</b>
              </div>
            )}
          </div>
        )}

        {step === 3 && (
          <div key="s3" className="anim-in">
            <label className="lbl">Machine</label>
            <div style={{ display: "grid", gap: 9 }}>
              {data.machines.map((m) => (
                <button key={m.id} className={"chip press " + (draft.machineId === m.id ? "on" : "")} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }} onClick={() => upd("machineId", m.id)}>
                  <span className="cn">{m.name}</span><span className="cr mono">{inr(m.rate)}/hr</span>
                </button>
              ))}
            </div>

            <div style={{ height: 18 }} />
            <label className="lbl">Cycle time / piece <span style={{ fontWeight: 400, color: "var(--faint)", fontSize: 13 }}>(machine time)</span></label>
            <span className="hint">Time the <b>machine</b> takes for one piece - from Cycle Start until the part is done.</span>
            <div className="suffix-wrap"><input className="input mono" type="number" inputMode="decimal" placeholder="9" value={draft.cycleMin} onChange={(e) => upd("cycleMin", e.target.value)} /><span className="sfx">MIN</span></div>

            <div style={{ height: 16 }} />
            <label className="lbl">Manual time / piece <span style={{ fontWeight: 400, color: "var(--faint)", fontSize: 13 }}>(hand work · optional)</span></label>
            <span className="hint">Person's time per piece <b>while the machine is stopped</b> - loading, deburring, checking.</span>
            <div className="suffix-wrap"><input className="input mono" type="number" inputMode="decimal" placeholder="5.5" value={draft.manualMin} onChange={(e) => upd("manualMin", e.target.value)} /><span className="sfx">MIN</span></div>

            <div style={{ height: 16 }} />
            <label className="lbl">One-time setup <span style={{ fontWeight: 400, color: "var(--faint)", fontSize: 13 }}>(optional)</span></label>
            <div className="suffix-wrap"><input className="input mono" type="number" inputMode="decimal" placeholder="0" value={draft.setupMin} onChange={(e) => upd("setupMin", e.target.value)} /><span className="sfx">MIN</span></div>
          </div>
        )}

        {step === 4 && c.done && (
          <div key="s4">
            <div className="card anim-in" style={{ padding: "6px 16px 12px" }}>
              <div className="rowline anim-in st1"><span className="rl">Material <em>{draft.rawKg} KG</em></span><span className="rv">{inr(c.matCost, 2)}</span></div>
              <div className="rowline anim-in st2"><span className="rl">Machine <em>{draft.cycleMin} MIN</em></span><span className="rv">{inr(c.machCost, 2)}</span></div>
              <div className="rowline anim-in st3"><span className="rl">Labour + tooling</span><span className="rv">{inr(c.labour + c.tooling, 2)}</span></div>
              <div className="rowline anim-in st4"><span className="rl">Overhead <em>{draft.overheadPct}%</em></span><span className="rv">{inr(c.ovh, 2)}</span></div>
              <div className="rowline strong anim-in st5"><span className="rl">Cost / pc</span><span className="rv">{inr(c.cost, 2)}</span></div>
            </div>

            <div className="card anim-in st6" style={{ padding: "18px 16px", marginTop: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
                <span className="lbl" style={{ margin: 0 }}>Your margin</span>
                <b className="mono" style={{ color: "var(--grn-d)", fontSize: 15 }}>{draft.marginPct}% · {inr(c.marg, 2)}/pc</b>
              </div>
              <input type="range" min="5" max="60" value={draft.marginPct} style={{ "--fill": ((draft.marginPct - 5) / 55) * 100 + "%" }} onChange={(e) => upd("marginPct", +e.target.value)} />
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }} className="mono"><span style={{ fontSize: 11, color: "var(--faint)" }}>5%</span><span style={{ fontSize: 11, color: "var(--faint)" }}>60%</span></div>
            </div>

            <div className="hero-card anim-in st7" style={{ padding: "20px", marginTop: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div><div className="mono" style={{ fontSize: 9.5, letterSpacing: ".16em", color: "rgba(255,255,255,.78)" }}>PRICE / PC</div>
                <div className="mono" style={{ fontSize: 26, fontWeight: 600 }}><CountUp value={c.pricePc} d={2} /></div></div>
              <div style={{ textAlign: "right" }}><div className="mono" style={{ fontSize: 9.5, letterSpacing: ".16em", color: "rgba(255,255,255,.78)" }}>TOTAL · {c.qty} PCS</div>
                <div className="mono" style={{ fontSize: 26, fontWeight: 600 }}><CountUp value={c.total} /></div></div>
            </div>
          </div>
        )}
      </div></div>

      <div className="runbar" style={{ background: step === 4 ? "#fff" : undefined, border: step === 4 ? "1px solid var(--line)" : "none", padding: step === 4 ? 10 : undefined }}>
        {step < 4 ? (
          <>
            <div><div className="rt">{c.done ? "RUNNING PRICE / PC" : "COST SO FAR / PC"}</div><div className="rp"><CountUp value={c.done ? c.pricePc : c.partial} d={2} /></div></div>
            <button className="btn btn-sm press" style={{ background: "#fff", color: "var(--grn-d)", fontWeight: 700 }}
              disabled={(step === 1 && !ok1) || (step === 2 && !ok2) || (step === 3 && !ok3)} onClick={() => setStep(step + 1)}>Next <I.chev /></button>
          </>
        ) : (
          <button className="btn btn-grn press" style={{ width: "100%" }} onClick={() => onSave(c)}><I.wa /> Save &amp; prepare quotation</button>
        )}
      </div>
    </>
  );
}

/* ================= SUCCESS ================= */
function Success({ q, data, onFinish, ping }) {
  const msg = waText(q, data.shopName, data.settings.validityDays);
  const copy = async () => { try { await navigator.clipboard.writeText(msg); ping("Copied to clipboard"); } catch { ping("Long-press the preview to copy"); } };
  const pdf = async () => {
    ping("Preparing PDF...");
    try { await downloadQuotePDF(q, data); ping("PDF downloaded"); }
    catch { ping("PDF needs internet - check connection"); }
  };
  return (
    <div className="scr"><div className="pagepad" style={{ textAlign: "center", paddingTop: 44 }}>
      <div style={{ width: 92, height: 92, margin: "0 auto 18px", borderRadius: "50%", background: "var(--grn-100)", display: "flex", alignItems: "center", justifyContent: "center", animation: "popIn .45s cubic-bezier(.2,.8,.3,1.2) both, haloPulse 1.2s ease-out .3s" }}>
        <svg width="52" height="52" viewBox="0 0 52 52" fill="none">
          <circle cx="26" cy="26" r="23" stroke="#228B22" strokeWidth="3" strokeLinecap="round" strokeDasharray="166" strokeDashoffset="166" style={{ animation: "drawRing .55s ease-out .1s forwards" }} />
          <path d="M16 27.5 23 34l13-15" stroke="#155E18" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="48" strokeDashoffset="48" style={{ animation: "drawTick .4s ease-out .55s forwards" }} />
        </svg>
      </div>
      <div className="h-disp anim-in st2" style={{ fontSize: 27, fontWeight: 700 }}>Quotation ready</div>
      <div className="anim-in st3" style={{ color: "var(--dim)", fontSize: 15, margin: "6px 0 22px" }}>{q.part} · {q.qty} pcs · <b className="mono" style={{ color: "var(--grn-d)" }}>{inr(q.total)}</b></div>
      <div className="wa-prev anim-in st4" style={{ textAlign: "left" }}>{msg}</div>
      <div className="anim-in st5" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 16 }}>
        <button className="btn btn-ghost press" onClick={copy}><I.copy /> Copy text</button>
        <a className="btn btn-grn press" style={{ textDecoration: "none" }} href={waLink(q.phone, msg)} target="_blank" rel="noreferrer"><I.wa /> {q.phone ? "Send on WhatsApp" : "WhatsApp"}</a>
      </div>
      <button className="btn btn-ghost press anim-in st6" style={{ width: "100%", marginTop: 10 }} onClick={pdf}><I.pdf /> Download PDF quotation</button>
      <button className="btn btn-soft press anim-in st7" style={{ width: "100%", marginTop: 10 }} onClick={onFinish}>Done - back to home</button>
      <div className="anim-in st8" style={{ fontSize: 12.5, color: "var(--faint)", marginTop: 14 }}>Saved as <b>Pending</b> - mark it Won or Lost from the Quotes tab.</div>
    </div></div>
  );
}

/* ================= QUOTES / PIPELINE ================= */
/* inline WhatsApp image with graceful fallback (media proxy can 401 when the token expires) */
function WaImage({ src }) {
  const [err, setErr] = useState(false);
  if (err) return (
    <div style={{ marginTop: 8, padding: "11px 12px", border: "1px dashed var(--line2)", borderRadius: 12, background: "#fff", fontSize: 12.5, color: "var(--faint)", textAlign: "center" }}>
      Photo could not load - WhatsApp token may have expired. Open WhatsApp to view it.
    </div>
  );
  return (
    <a href={src} target="_blank" rel="noreferrer" style={{ display: "block", marginTop: 8 }}>
      <img src={src} alt="WhatsApp attachment" loading="lazy" onError={() => setErr(true)}
        style={{ width: "100%", maxHeight: 220, objectFit: "cover", borderRadius: 12, border: "1px solid #CBEAD2", display: "block" }} />
    </a>
  );
}

function Quotes({ data, setStatus, updateQuote, delQuote, importQuotes, ping, filter, setFilter, cat = null, setCat, onLog, enquiries = [], logEnquiry, dismissEnquiry, waOn, refreshEnquiries, tallyBal = null }) {
  const ind = industryOf(data);
  const [open, setOpen] = useState(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [xlOpen, setXlOpen] = useState(false); // Excel import/export bottom sheet
  const [viewImg, setViewImg] = useState(null); // tapped-to-enlarge pipeline photo
  const fileRef = useRef(null);
  const photoForRef = useRef(null); // hidden picker for attaching a photo to an existing quote
  const attachId = useRef(null);
  const fdate = (t) => new Date(t).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  const onAttachPhoto = async (e) => {
    const file = e.target.files && e.target.files[0]; e.target.value = "";
    if (!file || !attachId.current) return;
    const url = await downscaleImage(file);
    if (url) { updateQuote(attachId.current, { image: url }); ping("Photo added"); } else ping("Could not read that image");
    attachId.current = null;
  };

  const dueCount = data.quotes.filter((x) => { const s = followState(x); return s === "overdue" || s === "today"; }).length;
  const term = q.trim().toLowerCase();
  const list = data.quotes
    .filter((x) => filter === "all" || (filter === "due" ? (followState(x) === "overdue" || followState(x) === "today") : x.status === filter))
    .filter((x) => !cat || catOf(x, ind) === cat)
    .filter((x) => !term || (x.customer + " " + x.part).toLowerCase().includes(term));
  /* categories that actually have quotes, in the trade's defined order, with counts */
  const catCounts = data.quotes.reduce((m, x) => { const k = catOf(x, ind); m[k] = (m[k] || 0) + 1; return m; }, {});
  const catsPresent = (ind.cats || []).filter((c) => catCounts[c.key]);

  const doExport = async (kind) => {
    if (!data.quotes.length) return ping("No quotes to export yet");
    if (kind === "csv") { exportQuotesCSV(data.quotes); return ping("CSV downloaded"); }
    setBusy(true); ping("Building Excel...");
    try { await exportQuotesXLSX(data.quotes); ping("Excel downloaded"); }
    catch { exportQuotesCSV(data.quotes); ping("Saved as CSV (Excel needs internet)"); }
    finally { setBusy(false); }
  };
  const onFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true); ping("Reading file...");
    try {
      const rows = await parseSheetFile(file);
      if (!rows.length) ping("No quotes found - need a Customer or Part column");
      else importQuotes(rows);
    } catch { ping("Could not read that file - use .xlsx or .csv"); }
    finally { setBusy(false); }
  };

  return (<>
    <div className="scr"><div className="pagepad">
      <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" onChange={onFile} style={{ display: "none" }} />
      <input ref={photoForRef} type="file" accept="image/*" capture="environment" onChange={onAttachPhoto} style={{ display: "none" }} />
      <div className="anim-in" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
        <div><span className="eyebrow">Pipeline</span><div className="h-disp" style={{ fontSize: 26, fontWeight: 700, marginTop: 4 }}>All quotes</div></div>
        <button className="btn btn-sm btn-soft press" disabled={busy} onClick={() => setXlOpen(true)}>
          <I.sheet style={{ width: 16, height: 16 }} /> Excel
        </button>
      </div>

      {/* incoming WhatsApp enquiries (only present when the backend is deployed) */}
      {(enquiries.length > 0 || waOn) && (
        <div className="anim-in" style={{ marginBottom: 18 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span className="eyebrow" style={{ display: "flex", alignItems: "center", gap: 7, color: "#128C4B" }}>
              <I.wa /> Incoming enquiries{enquiries.length > 0 ? " · " + enquiries.length : ""}
              <i style={{ width: 7, height: 7, borderRadius: "50%", background: "#25A75B", display: "inline-block" }} title="Backend connected" />
            </span>
            <button className="iconbtn press" style={{ width: 32, height: 32 }} title="Check for new messages"
              onClick={async () => { const ok = await refreshEnquiries(); ping(ok ? "Inbox refreshed" : "Could not reach WhatsApp backend"); }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v4.5h-4.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
          </div>
          {enquiries.length === 0 && (
            <div style={{ marginTop: 10, padding: "13px 15px", border: "1px dashed #CBEAD2", borderRadius: 14, background: "#F7FCF8", fontSize: 13, color: "var(--dim)", lineHeight: 1.5 }}>
              Connected. When a customer messages your WhatsApp business number, the enquiry appears here within 30 seconds.
            </div>
          )}
          {enquiries.map((e) => (
            <div key={e.id} className="card" style={{ padding: "14px 15px", marginTop: 10, border: "1px solid #CBEAD2", background: "#F3FBF4" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <div style={{ fontWeight: 600, fontSize: 15, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.name || (e.source === "gmail" ? e.from : "+" + e.from)}</div>
                <span style={{ display: "flex", alignItems: "center", gap: 7, flexShrink: 0 }}>
                  <span className="mono" style={{ fontSize: 9, letterSpacing: ".1em", fontWeight: 600, color: e.source === "gmail" ? "#7A4FA8" : "#128C4B", background: e.source === "gmail" ? "#F3ECFA" : "#E7F6E9", border: "1px solid " + (e.source === "gmail" ? "#E2D3F0" : "#CBEAD2"), padding: "3px 8px", borderRadius: 999 }}>
                    {e.source === "gmail" ? "GMAIL" : "WHATSAPP"}
                  </span>
                  <span className="mono" style={{ fontSize: 11.5, color: "var(--faint)" }}>{fdateShort(e.at)}</span>
                </span>
              </div>
              {e.type === "image" && e.mediaId && (
                <WaImage src={WA_API + "/whatsapp-media?id=" + encodeURIComponent(e.mediaId)} />
              )}
              {e.type === "document" && e.mediaId && (
                <a className="press" href={WA_API + "/whatsapp-media?id=" + encodeURIComponent(e.mediaId) + "&name=" + encodeURIComponent(e.filename || "document")} target="_blank" rel="noreferrer"
                  style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8, padding: "11px 12px", border: "1px solid #CBEAD2", borderRadius: 12, background: "#fff", textDecoration: "none" }}>
                  <span style={{ color: "var(--grn-d)", flexShrink: 0 }}><I.pdf /></span>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 600, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.filename || "Document"}</span>
                  <span style={{ color: "var(--faint)", flexShrink: 0 }}><I.down /></span>
                </a>
              )}
              {(e.text || e.type !== "text") && (
                <div style={{ fontSize: 13.5, color: e.text ? "var(--dim)" : "var(--faint)", margin: "8px 0 12px", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
                  {e.text || (e.type === "image" ? "Photo, no caption" : e.type === "document" ? "Document, no message" : "")}
                </div>
              )}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button className="btn btn-sm btn-soft press" onClick={() => logEnquiry(e)}><I.bolt /> Log as quote</button>
                {e.source === "gmail"
                  ? <a className="btn btn-sm btn-ghost press" style={{ textDecoration: "none" }} href={"mailto:" + e.from} target="_blank" rel="noreferrer">✉️ Reply</a>
                  : <a className="btn btn-sm btn-ghost press" style={{ textDecoration: "none" }} href={waLink(e.from, "")} target="_blank" rel="noreferrer"><I.wa /> Reply</a>}
                <button className="btn btn-sm btn-ghost press" style={{ color: "var(--red)" }} onClick={() => dismissEnquiry(e)}><I.trash /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* search */}
      <div className="anim-in st1 suffix-wrap" style={{ marginBottom: 12 }}>
        <input className="input" style={{ paddingLeft: 42 }} placeholder="Search customer or part..." value={q} onChange={(e) => setQ(e.target.value)} />
        <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "var(--faint)" }}><I.search /></span>
      </div>

      {/* filters */}
      <div className="anim-in st1" style={{ display: "flex", gap: 8, marginBottom: catsPresent.length ? 10 : 14, flexWrap: "wrap" }}>
        {["all", "pending", "won", "lost"].map((k) => (<button key={k} className={"fpill press " + (filter === k ? "on" : "")} onClick={() => setFilter(k)}>{k[0].toUpperCase() + k.slice(1)}</button>))}
        <button className={"fpill press " + (filter === "due" ? "on" : "")} style={dueCount && filter !== "due" ? { borderColor: "#F0DCB8", color: "var(--amber)" } : undefined} onClick={() => setFilter("due")}>Follow-ups{dueCount ? " · " + dueCount : ""}</button>
      </div>

      {/* category chips - trade-specific, only categories that have quotes */}
      {catsPresent.length > 0 && setCat && (
        <div className="anim-in st1 cat-scroll" style={{ display: "flex", gap: 8, marginBottom: 14, overflowX: "auto", paddingBottom: 2 }}>
          <button className={"catchip press " + (!cat ? "on" : "")} onClick={() => setCat(null)}>All {ind.item.split(" ")[0].toLowerCase() === "part" ? "parts" : "types"}</button>
          {catsPresent.map((c) => (
            <button key={c.key} className={"catchip press " + (cat === c.key ? "on" : "")} onClick={() => setCat(cat === c.key ? null : c.key)}>
              <span style={{ fontSize: 14 }}>{c.emoji}</span> {c.label} <span className="mono" style={{ opacity: .6, fontSize: 11 }}>{catCounts[c.key]}</span>
            </button>
          ))}
        </div>
      )}

      {list.length === 0 && (
        <div className="card-tint anim-in st2" style={{ padding: 28, textAlign: "center", color: "var(--dim)", fontSize: 14.5 }}>
          {term || filter !== "all" ? "No quotes match." : <>Nothing here yet.<br /><button className="btn btn-soft btn-sm press" style={{ marginTop: 14 }} onClick={onLog}><I.bolt /> Log your first quote</button></>}
        </div>
      )}

      {list.map((q, i) => {
        const fs = followState(q);
        const pill = q.status === "won" ? "won" : q.status === "lost" ? "lost" : "pend";
        /* outstanding balance from Tally (via the opt-in connector), matched by customer name */
        const tBal = tallyBal && q.customer ? tallyBal[String(q.customer).trim().toLowerCase()] : null;
        return (
          <div key={q.id} className={"card anim-in st" + Math.min(8, i + 2)} style={{ padding: "16px 16px", marginBottom: 10, borderColor: fs === "overdue" ? "#F0DCB8" : undefined }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }} onClick={() => setOpen(open === q.id ? null : q.id)}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0, flex: 1 }}>
              {q.image ? (
                <img src={q.image} alt="" onClick={(ev) => { ev.stopPropagation(); setViewImg(q.image); }}
                  style={{ width: 48, height: 48, borderRadius: 12, objectFit: "cover", flexShrink: 0, border: "1px solid var(--line2)", cursor: "zoom-in" }} />
              ) : (
                <span style={{ width: 48, height: 48, borderRadius: 12, background: "var(--grn-100)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, flexShrink: 0 }}>{catMeta(ind, catOf(q, ind)).emoji}</span>
              )}
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 15.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{q.customer}</div>
                <div style={{ fontSize: 13.5, color: "var(--dim)", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{q.part}{q.qty ? " · " + q.qty + " pcs" : ""} · {fdate(q.at)}</div>
                {q.spec && (
                  <div className="mono" style={{ fontSize: 11.5, color: "var(--grn-d)", marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{q.spec}</div>
                )}
                {fs && (
                  <div style={{ marginTop: 6, display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 600, fontFamily: "var(--mono)", padding: "3px 9px", borderRadius: 999, background: fs === "overdue" ? "var(--red-bg)" : fs === "today" ? "var(--amber-bg)" : "var(--soft)", color: fs === "overdue" ? "var(--red)" : fs === "today" ? "var(--amber)" : "var(--dim)" }}>
                    <I.bell style={{ width: 12, height: 12 }} /> {fs === "overdue" ? "OVERDUE " + fdate(q.followUp) : fs === "today" ? "FOLLOW UP TODAY" : "FOLLOW " + fdate(q.followUp)}
                  </div>
                )}
              </div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0, marginLeft: 12 }}>
                <div className="mono" style={{ fontWeight: 600, fontSize: 15.5 }}>{inr(q.total)}</div>
                <span className={"pill " + pill} style={{ marginTop: 4 }}><i className="dot" />{q.status.toUpperCase()}</span>
                {tBal != null && (
                  <div style={{ marginTop: 5 }}>
                    <span className="mono" style={{ display: "inline-block", fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap", background: "var(--amber-bg)", color: "var(--amber)", border: "1px solid #F0DCB8", borderRadius: 999, padding: "3px 9px" }}>
                      Tally baki {inr(tBal)}
                    </span>
                  </div>
                )}
              </div>
            </div>
            {open === q.id && (
              <div className="anim-in" style={{ marginTop: 14 }}>
                {/* WhatsApp chase - front and centre for pending quotes */}
                {q.status === "pending" && (
                  <a className="btn btn-grn btn-sm press" style={{ width: "100%", textDecoration: "none", marginBottom: 10 }}
                    href={waLink(q.phone, waFollowText(q, data.shopName))} target="_blank" rel="noreferrer">
                    <I.wa /> {q.phone ? "Chase on WhatsApp" : "Follow up on WhatsApp"}
                  </a>
                )}
                {/* follow-up date setter */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                  <span style={{ color: "var(--dim)", flexShrink: 0 }}><I.cal /></span>
                  <input className="input mono" style={{ padding: "9px 11px", fontSize: 14 }} type="date" value={q.followUp ? isoDate(q.followUp) : ""}
                    onChange={(e) => { updateQuote(q.id, { followUp: e.target.value ? new Date(e.target.value).getTime() : null }); ping(e.target.value ? "Follow-up set" : "Follow-up cleared"); }} />
                  {q.followUp && <button className="iconbtn press" style={{ width: 38, height: 38 }} onClick={() => { updateQuote(q.id, { followUp: null }); ping("Follow-up cleared"); }}><I.trash /></button>}
                </div>
                {q.note && <div style={{ fontSize: 13, color: "var(--dim)", background: "var(--soft)", borderRadius: 12, padding: "10px 12px", marginBottom: 10 }}>{q.note}</div>}
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {q.status !== "won" && <button className="btn btn-sm btn-soft press" onClick={() => { setStatus(q.id, "won"); ping("Marked as Won 🎉"); }}>Mark Won</button>}
                  {q.status !== "lost" && <button className="btn btn-sm btn-ghost press" onClick={() => { setStatus(q.id, "lost"); ping("Marked as Lost"); }}>Mark Lost</button>}
                  {q.status !== "pending" && <button className="btn btn-sm btn-ghost press" onClick={() => { setStatus(q.id, "pending"); ping("Reopened"); }}>Reopen</button>}
                  {q.phone && <a className="btn btn-sm btn-ghost press" style={{ textDecoration: "none" }} href={"tel:+91" + q.phone}><I.phone /></a>}
                  <button className="btn btn-sm btn-ghost press" onClick={() => { attachId.current = q.id; photoForRef.current && photoForRef.current.click(); }}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M4 8h3l1.5-2h7L18 8h2a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/><circle cx="12" cy="13" r="3.2" stroke="currentColor" strokeWidth="1.8"/></svg>
                    {q.image ? "Change photo" : "Add photo"}
                  </button>
                  <button className="btn btn-sm btn-ghost press" onClick={async () => { ping("Preparing PDF..."); try { await downloadQuotePDF(q, data); ping("PDF downloaded"); } catch { ping("PDF needs internet"); } }}><I.pdf /> PDF</button>
                  <button className="btn btn-sm btn-ghost press" onClick={async () => { try { await navigator.clipboard.writeText(waText(q, data.shopName, data.settings.validityDays)); ping("Message copied"); } catch { ping("Copy failed"); } }}><I.copy /></button>
                  <button className="btn btn-sm btn-ghost press" style={{ color: "var(--red)" }} onClick={() => { delQuote(q.id); ping("Deleted"); }}><I.trash /></button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      <button className="btn btn-ghost press anim-in" style={{ width: "100%", marginTop: 6 }} disabled={busy} onClick={() => setXlOpen(true)}>
        <I.sheet /> Excel - import or download
      </button>
    </div></div>

    {/* Excel bottom sheet - plain-language import/export */}
    {xlOpen && (
      <div onClick={() => setXlOpen(false)} style={{ position: "absolute", inset: 0, zIndex: 60, background: "rgba(16,26,20,.42)", backdropFilter: "blur(3px)", display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
        <div className="anim-in" onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: "26px 26px 0 0", padding: "22px 18px calc(20px + env(safe-area-inset-bottom))", boxShadow: "0 -20px 50px -20px rgba(21,94,24,.4)" }}>
          <div style={{ width: 40, height: 4, borderRadius: 3, background: "var(--line2)", margin: "0 auto 16px" }} />
          <div className="microlbl" style={{ marginLeft: 2 }}>EXCEL / CSV</div>
          <div className="h-disp" style={{ fontSize: 21, fontWeight: 700, margin: "3px 0 16px 2px" }}>Move quotes in or out</div>

          <button className="press" disabled={busy} onClick={() => { setXlOpen(false); fileRef.current?.click(); }}
            style={{ all: "unset", boxSizing: "border-box", cursor: busy ? "default" : "pointer", opacity: busy ? .5 : 1, width: "100%", display: "flex", alignItems: "center", gap: 14, padding: "16px", borderRadius: 18, background: "#fff", border: "1.5px solid var(--line2)", boxShadow: "var(--sh-s)", marginBottom: 10 }}>
            <span style={{ width: 42, height: 42, borderRadius: 13, background: "var(--grn-100)", color: "var(--grn-d)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><I.up /></span>
            <span style={{ flex: 1 }}>
              <span style={{ display: "block", fontWeight: 700, fontSize: 16 }}>Bring quotes IN</span>
              <span style={{ fontSize: 12.5, color: "var(--dim)" }}>Import your Excel/CSV sheet - purani sheet bhi chalegi, columns match ho jaate hain.</span>
            </span>
            <I.chev style={{ color: "var(--faint)" }} />
          </button>

          <button className="press" disabled={busy || !data.quotes.length} onClick={() => { setXlOpen(false); doExport("xlsx"); }}
            style={{ all: "unset", boxSizing: "border-box", cursor: busy || !data.quotes.length ? "default" : "pointer", width: "100%", display: "flex", alignItems: "center", gap: 14, padding: "16px", borderRadius: 18, background: "linear-gradient(135deg,#1B7A20,#2E9E33)", color: "#fff", boxShadow: "var(--sh-m)", opacity: busy || !data.quotes.length ? .5 : 1 }}>
            <span style={{ width: 42, height: 42, borderRadius: 13, background: "rgba(255,255,255,.18)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><I.down /></span>
            <span style={{ flex: 1 }}>
              <span style={{ display: "block", fontWeight: 700, fontSize: 16 }}>Take quotes OUT (.xlsx)</span>
              <span style={{ fontSize: 12.5, color: "rgba(255,255,255,.85)" }}>Download the whole pipeline as an Excel file - date, customer, part, qty, status.</span>
            </span>
            <I.chev />
          </button>

          <button className="press" disabled={busy || !data.quotes.length} onClick={() => { setXlOpen(false); doExport("csv"); }}
            style={{ all: "unset", boxSizing: "border-box", cursor: busy || !data.quotes.length ? "default" : "pointer", opacity: busy || !data.quotes.length ? .5 : 1, width: "100%", textAlign: "center", padding: "14px 0 2px", fontSize: 13.5, fontWeight: 600, color: "var(--dim)" }}>
            Download as CSV instead <span style={{ color: "var(--faint)", fontWeight: 400 }}>(works even offline)</span>
          </button>
        </div>
      </div>
    )}

    {/* tap a pipeline photo to enlarge it */}
    {viewImg && (
      <div onClick={() => setViewImg(null)} style={{ position: "absolute", inset: 0, zIndex: 80, background: "rgba(16,26,20,.86)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
        <img src={viewImg} alt="" style={{ maxWidth: "100%", maxHeight: "100%", borderRadius: 16, boxShadow: "0 20px 60px -20px rgba(0,0,0,.6)" }} />
      </div>
    )}
    </>
  );
}

/* ================= ANALYTICS ================= */
/* adaptive time buckets: 7d -> daily, 30d -> 5-day blocks, all -> monthly */
function buildBuckets(quotes, range) {
  const now = Date.now();
  const bucketOf = (d0, d1, label) => {
    const qs = quotes.filter((q) => q.at >= d0 && q.at < d1);
    return { label, value: qs.reduce((s, q) => s + q.total, 0), count: qs.length,
      won: qs.filter((q) => q.status === "won").reduce((s, q) => s + q.total, 0) };
  };
  if (range === "7")
    return [...Array(7)].map((_, i) => { const d0 = startOfDay(now) - (6 - i) * DAY; return bucketOf(d0, d0 + DAY, new Date(d0).toLocaleDateString("en-IN", { weekday: "short" })); });
  if (range === "30") {
    const end = startOfDay(now) + DAY;
    return [...Array(6)].map((_, i) => { const d1 = end - (5 - i) * 5 * DAY, d0 = d1 - 5 * DAY; return bucketOf(d0, d1, fdateShort(d0)); });
  }
  const cur = new Date(); cur.setDate(1); cur.setHours(0, 0, 0, 0);
  return [...Array(6)].map((_, i) => {
    const d0 = new Date(cur.getFullYear(), cur.getMonth() - (5 - i), 1).getTime();
    const d1 = new Date(cur.getFullYear(), cur.getMonth() - (5 - i) + 1, 1).getTime();
    return bucketOf(d0, d1, new Date(d0).toLocaleDateString("en-IN", { month: "short" }));
  });
}

function Donut({ won, lost, pending }) {
  const total = won + lost + pending;
  const R = 52, C = 2 * Math.PI * R;
  const segs = [["#228B22", won], ["#E0A53A", pending], ["#C0584F", lost]];
  let acc = 0;
  const rate = won + lost ? Math.round((won / (won + lost)) * 100) : null;
  return (
    <div style={{ position: "relative", width: 138, height: 138, flexShrink: 0 }}>
      <svg width="138" height="138" viewBox="0 0 138 138">
        <circle cx="69" cy="69" r={R} fill="none" stroke="var(--line)" strokeWidth="15" />
        {total > 0 && segs.map(([c, v], i) => {
          const frac = v / total, len = frac * C, off = acc; acc += len;
          return <circle key={i} cx="69" cy="69" r={R} fill="none" stroke={c} strokeWidth="15" strokeLinecap="butt"
            strokeDasharray={len + " " + (C - len)} strokeDashoffset={-off} transform="rotate(-90 69 69)"
            style={{ transition: "stroke-dasharray .7s cubic-bezier(.2,.7,.3,1), stroke-dashoffset .7s cubic-bezier(.2,.7,.3,1)" }} />;
        })}
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <div className="h-disp mono" style={{ fontSize: 26, fontWeight: 700, color: "var(--grn-d)", lineHeight: 1 }}>{rate == null ? "-" : rate + "%"}</div>
        <div style={{ fontSize: 10, fontWeight: 600, color: "var(--faint)", letterSpacing: ".1em", marginTop: 2 }}>WIN RATE</div>
      </div>
    </div>
  );
}

function Analytics({ data, onBack, goQuotes }) {
  const [range, setRange] = useState("30");
  const from = range === "all" ? 0 : startOfDay(Date.now()) - (range === "7" ? 6 : 29) * DAY;
  const scoped = data.quotes.filter((q) => q.at >= from);

  const totVal = scoped.reduce((s, q) => s + q.total, 0);
  const wonQ = scoped.filter((q) => q.status === "won"), lostQ = scoped.filter((q) => q.status === "lost"), pendQ = scoped.filter((q) => q.status === "pending");
  const wonVal = wonQ.reduce((s, q) => s + q.total, 0), lostVal = lostQ.reduce((s, q) => s + q.total, 0), pendVal = pendQ.reduce((s, q) => s + q.total, 0);
  const winRate = wonQ.length + lostQ.length ? Math.round((wonQ.length / (wonQ.length + lostQ.length)) * 100) : null;
  const buckets = buildBuckets(scoped, range);
  const maxVal = Math.max(1, ...buckets.map((b) => b.value));
  const rangeLbl = range === "7" ? "Last 7 days" : range === "30" ? "Last 30 days" : "All time";

  /* top customers by quoted value */
  const byCust = {};
  scoped.forEach((q) => { const k = q.customer || "(no name)"; (byCust[k] = byCust[k] || { value: 0, won: 0, n: 0 }); byCust[k].value += q.total; byCust[k].n += 1; if (q.status === "won") byCust[k].won += 1; });
  const topCust = Object.entries(byCust).sort((a, b) => b[1].value - a[1].value).slice(0, 5);
  const maxCust = Math.max(1, ...topCust.map(([, v]) => v.value));

  return (
    <div className="scr"><div className="pagepad">
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <button className="iconbtn press" onClick={onBack}><I.back /></button>
        <div><div className="microlbl">ANALYTICS</div><div className="h-disp" style={{ fontSize: 23, fontWeight: 700 }}>Your numbers</div></div>
      </div>

      {/* range toggle */}
      <div className="seg anim-in" style={{ marginBottom: 16 }}>
        {[["7", "7 days"], ["30", "30 days"], ["all", "All time"]].map(([k, l]) => (
          <button key={k} className={range === k ? "on" : ""} onClick={() => setRange(k)}>{l}</button>
        ))}
      </div>

      {scoped.length === 0 ? (
        <div className="card-tint anim-in st1" style={{ padding: 34, textAlign: "center", color: "var(--dim)", fontSize: 14.5 }}>No quotes in this period yet.</div>
      ) : (<>

      {/* KPI grid */}
      <div className="anim-in st1" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
        {[[inr(totVal), "TOTAL QUOTED", "var(--grn-d)"], [scoped.length + "", "QUOTES SENT", "var(--ink)"], [inr(wonVal), "VALUE WON", "#1B7A20"], [inr(pendVal), "PENDING VALUE", "var(--amber)"]].map(([v, l, c], i) => (
          <div key={i} className="card" style={{ padding: "16px 14px" }}>
            <div className="h-disp mono" style={{ fontSize: 21, fontWeight: 700, color: c, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{v}</div>
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--faint)", marginTop: 4, letterSpacing: ".05em" }}>{l}</div>
          </div>
        ))}
      </div>

      {/* donut: win rate + outcome counts */}
      <div className="card anim-in st2" style={{ padding: "20px 18px", marginBottom: 14, display: "flex", alignItems: "center", gap: 18 }}>
        <Donut won={wonQ.length} lost={lostQ.length} pending={pendQ.length} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="lbl" style={{ marginBottom: 10 }}>Outcome</div>
          {[["#228B22", "Won", wonQ.length], ["#E0A53A", "Pending", pendQ.length], ["#C0584F", "Lost", lostQ.length]].map(([c, l, n], i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <i style={{ width: 11, height: 11, borderRadius: 3, background: c, flexShrink: 0 }} />
              <span style={{ fontSize: 13.5, color: "var(--dim)", flex: 1 }}>{l}</span>
              <b className="mono" style={{ fontSize: 14 }}>{n}</b>
            </div>
          ))}
        </div>
      </div>

      {/* value trend bars */}
      <div className="card anim-in st3" style={{ padding: "20px 18px 16px", marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
          <span className="lbl" style={{ margin: 0 }}>Quoted value{range === "all" ? " by month" : range === "30" ? " (5-day blocks)" : " by day"}</span>
          <span style={{ color: "var(--grn)" }}><I.chart /></span>
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 8, height: 150 }}>
          {buckets.map((b, i) => {
            const hPct = (b.value / maxVal) * 100, wonPct = b.value ? (b.won / b.value) * 100 : 0;
            return (
              <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 7, height: "100%", justifyContent: "flex-end" }}>
                <div className="mono" style={{ fontSize: 9.5, color: b.value ? "var(--grn-d)" : "transparent", fontWeight: 600, whiteSpace: "nowrap" }}>
                  {b.value >= 100000 ? "₹" + (b.value / 100000).toFixed(1) + "L" : b.value >= 1000 ? "₹" + (b.value / 1000).toFixed(0) + "k" : b.value ? "₹" + b.value : "0"}
                </div>
                <div style={{ width: "100%", maxWidth: 34, flex: 1, display: "flex", alignItems: "flex-end" }}>
                  <div title="green portion = won" style={{ width: "100%", height: Math.max(hPct, b.value ? 6 : 2) + "%", position: "relative", overflow: "hidden",
                    background: b.value ? "linear-gradient(180deg,#9FD9A2,#7CCB80)" : "var(--line)", borderRadius: 7,
                    boxShadow: b.value ? "0 4px 12px -4px rgba(34,139,34,.4)" : "none",
                    animation: "growBar .6s cubic-bezier(.2,.7,.3,1) both", animationDelay: (i * .05) + "s" }}>
                    <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: wonPct + "%", background: "linear-gradient(180deg,#2E9E33,#1B7A20)" }} />
                  </div>
                </div>
                <div style={{ fontSize: 10.5, fontWeight: 600, color: "var(--ink)", whiteSpace: "nowrap" }}>{b.label}</div>
              </div>
            );
          })}
        </div>
        <div style={{ borderTop: "1px solid var(--line)", marginTop: 14, paddingTop: 12, display: "flex", justifyContent: "center", gap: 16 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--dim)" }}><i style={{ width: 10, height: 10, borderRadius: 2, background: "#1B7A20" }} /> Won</span>
          <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--dim)" }}><i style={{ width: 10, height: 10, borderRadius: 2, background: "#7CCB80" }} /> Quoted</span>
        </div>
      </div>

      {/* money funnel: quoted -> won -> pending -> lost */}
      <div className="card anim-in st4" style={{ padding: "20px 18px 18px", marginBottom: 14 }}>
        <span className="lbl">Where the money is</span>
        <span className="hint">Of {inr(totVal)} quoted in this period.</span>
        {[["Won", wonVal, "#228B22"], ["Still pending", pendVal, "#E0A53A"], ["Lost", lostVal, "#C0584F"]].map(([l, v, c], i) => (
          <div key={i} style={{ marginTop: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 5 }}>
              <span style={{ color: "var(--dim)" }}>{l}</span><b className="mono" style={{ color: "var(--ink)" }}>{inr(v)}</b>
            </div>
            <div style={{ height: 10, borderRadius: 5, background: "var(--line)", overflow: "hidden" }}>
              <div style={{ height: "100%", width: (totVal ? (v / totVal) * 100 : 0) + "%", background: c, borderRadius: 5, transition: "width .6s cubic-bezier(.2,.7,.3,1)" }} />
            </div>
          </div>
        ))}
      </div>

      {/* top customers */}
      <div className="card anim-in st5" style={{ padding: "20px 18px 16px", marginBottom: 14 }}>
        <span className="lbl" style={{ marginBottom: 4 }}>Top customers</span>
        <span className="hint">By quoted value in this period.</span>
        {topCust.map(([name, v], i) => (
          <div key={i} style={{ marginTop: 13 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 5 }}>
              <span style={{ fontSize: 14, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "62%" }}>{name}</span>
              <span style={{ fontSize: 12, color: "var(--faint)" }}>{v.n} quote{v.n === 1 ? "" : "s"}{v.won ? " · " + v.won + " won" : ""}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ flex: 1, height: 9, borderRadius: 5, background: "var(--line)", overflow: "hidden" }}>
                <div style={{ height: "100%", width: (v.value / maxCust) * 100 + "%", background: "linear-gradient(90deg,#3FAE45,#1B7A20)", borderRadius: 5, transition: "width .6s cubic-bezier(.2,.7,.3,1)" }} />
              </div>
              <b className="mono" style={{ fontSize: 13, color: "var(--grn-d)", flexShrink: 0, width: 74, textAlign: "right" }}>{inr(v.value)}</b>
            </div>
          </div>
        ))}
      </div>

      </>)}

      <button className="btn btn-soft press" style={{ width: "100%", marginTop: 4 }} onClick={() => goQuotes("all")}>See all quotes</button>
      <div style={{ fontSize: 11.5, color: "var(--faint)", textAlign: "center", margin: "16px 0 6px" }} className="mono">{rangeLbl.toUpperCase()} · {scoped.length} QUOTES</div>
    </div></div>
  );
}

/* ================= TALLY INSIGHTS ================= */
/* The accountant works in Tally; the owner sees this. Reads the tally_ledgers
   + tally_vouchers tables the desktop connector fills (RLS: own rows only).
   With nothing connected it shows a clearly-labelled SAMPLE so the page can
   be demoed before any Tally exists. */
const TALLY_SAMPLE = {
  ledgers: [
    { name: "Apex Alloys", balance: 412000, grp: "debtor" },
    { name: "Bharat Steels", balance: 185500, grp: "debtor" },
    { name: "Om Metals", balance: 96000, grp: "debtor" },
    { name: "Shakti Traders", balance: 15200, grp: "debtor" },
    { name: "Yard Suppliers Co", balance: 240000, grp: "creditor" },
    { name: "Highway Transport Co", balance: 38500, grp: "creditor" },
  ],
  vouchers: [
    { d: 0.4, vtype: "Sales", party: "Apex Alloys", amount: 412500, item: "MS Scrap", qty: 12.5, unit: "MT" },
    { d: 1.2, vtype: "Sales", party: "Bharat Steels", amount: 278800, item: "CI Scrap", qty: 8.2, unit: "MT" },
    { d: 2.1, vtype: "Purchase", party: "Yard Suppliers Co", amount: 560000, item: "Mixed Scrap", qty: 20, unit: "MT" },
    { d: 3.5, vtype: "Sales", party: "Om Metals", amount: 455600, item: "Aluminium Scrap", qty: 3.4, unit: "MT" },
    { d: 5.0, vtype: "Sales", party: "Apex Alloys", amount: 660000, item: "MS Scrap", qty: 20, unit: "MT" },
    { d: 6.3, vtype: "Sales", party: "Shakti Traders", amount: 49600, item: "MS Scrap", qty: 1.5, unit: "MT" },
    { d: 8.1, vtype: "Purchase", party: "Yard Suppliers Co", amount: 392000, item: "Mixed Scrap", qty: 14, unit: "MT" },
    { d: 9.4, vtype: "Sales", party: "Bharat Steels", amount: 340000, item: "CI Scrap", qty: 10, unit: "MT" },
  ],
  progress: [
    { customer: "Apex Alloys", item: "MS Scrap", ordered: 50, unit: "MT", shipped: 32.5, atDays: 20, deadlineDays: 4, lastDays: 0.4, balance: 412000 },
    { customer: "Bharat Steels", item: "CI Scrap", ordered: 25, unit: "MT", shipped: 18.2, atDays: 12, deadlineDays: 10, lastDays: 1.2, balance: 185500 },
    { customer: "Om Metals", item: "Aluminium Scrap", ordered: 30, unit: "MT", shipped: 3.4, atDays: 16, deadlineDays: -1, lastDays: 3.5, balance: 96000 },
  ],
};
const fmtQty = (n) => {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return v.toLocaleString("en-IN", { maximumFractionDigits: 2 });
};

function TallyInsights({ data, updateQuote, ping, onBack }) {
  const [led, setLed] = useState(null);   // ledger rows | null while loading
  const [vch, setVch] = useState(null);   // voucher rows
  const [demo, setDemo] = useState(!sb);  // sample mode (no cloud / nothing synced)
  const [view, setView] = useState(null); // null overview | "recv" | "pay" drill-down

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!sb) { setDemo(true); return; }
      try {
        const [l, v] = await Promise.all([
          sb.from("tally_ledgers").select("name,balance,grp,as_of"),
          sb.from("tally_vouchers").select("vdate,vtype,party,amount,item,qty,unit").order("vdate", { ascending: false }).limit(400),
        ]);
        if (!alive) return;
        const lr = (!l.error && l.data) || [], vr = (!v.error && v.data) || [];
        if (!lr.length && !vr.length) { setDemo(true); return; }
        setLed(lr); setVch(vr); setDemo(false);
      } catch { if (alive) setDemo(true); }
    })();
    return () => { alive = false; };
  }, []);

  /* pick the data source: real rows or the labelled sample */
  const now = Date.now();
  const L = demo ? TALLY_SAMPLE.ledgers : (led || []);
  const V = demo
    ? TALLY_SAMPLE.vouchers.map((x) => ({ ...x, vdate: now - x.d * DAY }))
    : (vch || []);
  const loading = !demo && led === null;

  const isSale = (t) => !/purchase/i.test(String(t || ""));
  const receivable = L.filter((x) => x.grp !== "creditor" && x.balance > 0);
  const payable = L.filter((x) => x.grp === "creditor" && x.balance > 0);
  const recvTotal = receivable.reduce((s, x) => s + Number(x.balance), 0);
  const payTotal = payable.reduce((s, x) => s + Number(x.balance), 0);
  const m0 = new Date(); m0.setDate(1); m0.setHours(0, 0, 0, 0);
  const monthSales = V.filter((x) => isSale(x.vtype) && x.vdate >= m0.getTime());
  /* tonnage in the dominant unit this month (scrap shops live in MT) */
  const unitTotals = {};
  monthSales.forEach((x) => { if (x.qty > 0) { const u = x.unit || "?"; unitTotals[u] = (unitTotals[u] || 0) + Number(x.qty); } });
  const mainUnit = Object.keys(unitTotals).sort((a, b) => unitTotals[b] - unitTotals[a])[0] || "";
  const monthQty = mainUnit ? unitTotals[mainUnit] : 0;
  const monthValue = monthSales.reduce((s, x) => s + Number(x.amount), 0);
  const dispatches = V.filter((x) => isSale(x.vtype)).slice(0, 8);
  const balanceOf = (name) => {
    const hit = receivable.find((x) => String(x.name).trim().toLowerCase() === String(name).trim().toLowerCase());
    return hit ? Number(hit.balance) : 0;
  };

  /* ---- open orders for the dispatch planner ---- */
  const orders = demo
    ? TALLY_SAMPLE.progress.map((p, i) => ({
        qid: "demo" + i, customer: p.customer, item: p.item, ordered: p.ordered, unit: p.unit,
        shipped: p.shipped, remaining: Math.max(0, p.ordered - p.shipped),
        at: now - p.atDays * DAY,
        deliverBy: p.deadlineDays == null ? null : now + p.deadlineDays * DAY,
        lastDispatchAt: now - p.lastDays * DAY, balance: p.balance,
      }))
    : (data.quotes || [])
      .filter((q) => q.status === "won" && q.qty > 0 && q.at > now - 120 * DAY)
      .map((q) => {
        const ship = V.filter((x) => isSale(x.vtype) && x.vdate >= q.at &&
          String(x.party).trim().toLowerCase() === String(q.customer).trim().toLowerCase());
        const shipped = ship.reduce((s, x) => s + Number(x.qty), 0);
        return {
          qid: q.id, customer: q.customer, item: q.part, ordered: q.qty,
          unit: (ship[0] && ship[0].unit) || "", shipped,
          remaining: Math.max(0, q.qty - shipped), at: q.at,
          deliverBy: q.deliverBy || null,
          lastDispatchAt: ship.length ? Math.max(...ship.map((x) => x.vdate)) : null,
          balance: balanceOf(q.customer),
        };
      });

  /* ---- "kise pehle bhejein" scoring: deadline pressure + starvation +
          remaining share, minus a credit caution. Every factor is also
          SHOWN as a reason chip so the suggestion is never a black box. */
  const planned = orders.filter((o) => o.remaining > 0).map((o) => {
    const reasons = [];
    let score = 0;
    if (o.deliverBy) {
      const daysLeft = Math.round((startOfDay(o.deliverBy) - startOfDay(now)) / DAY);
      const pressure = Math.max(0, Math.min(1.2, 1 - daysLeft / 14));
      score += 50 * pressure;
      if (daysLeft < 0) reasons.push({ t: "Deadline nikal gayi (" + Math.abs(daysLeft) + " din)", c: "red" });
      else if (daysLeft <= 5) reasons.push({ t: "Deadline in " + daysLeft + " din", c: "amber" });
    } else {
      score += 50 * Math.min(1, (now - o.at) / (30 * DAY));
    }
    const waitFrom = o.lastDispatchAt || o.at;
    const waitDays = Math.round((now - waitFrom) / DAY);
    score += 30 * Math.min(1, waitDays / 14);
    if (waitDays >= 5) reasons.push({ t: o.lastDispatchAt ? waitDays + " din se koi dispatch nahi" : "Abhi tak kuch nahi bheja (" + waitDays + " din)", c: "amber" });
    const remFrac = o.remaining / o.ordered;
    score += 20 * remFrac;
    if (remFrac <= 0.25) reasons.push({ t: "Sirf " + fmtQty(o.remaining) + " " + (o.unit || "") + " bacha - khatam karo", c: "grn" });
    if (o.balance > 100000) { score -= Math.min(20, o.balance / 50000); reasons.push({ t: "Baki " + inr(o.balance) + " - payment ka dhyaan", c: "red" }); }
    return { ...o, score, reasons };
  }).sort((a, b) => b.score - a.score);

  const asOf = !demo && led && led.length ? led[0].as_of : null;
  const chipStyle = (c) => ({
    display: "inline-flex", alignItems: "center", fontSize: 11, fontWeight: 600, fontFamily: "var(--mono)",
    padding: "3px 9px", borderRadius: 999, marginRight: 6, marginTop: 6, whiteSpace: "nowrap",
    background: c === "red" ? "var(--red-bg)" : c === "amber" ? "var(--amber-bg)" : "var(--grn-100)",
    color: c === "red" ? "var(--red)" : c === "amber" ? "var(--amber)" : "var(--grn-d)",
  });

  /* ---------- drill-down: where the money is ---------- */
  if (view) {
    const isRecv = view === "recv";
    const rows = (isRecv ? receivable : payable).slice().sort((a, b) => b.balance - a.balance);
    const total = isRecv ? recvTotal : payTotal;
    const lastActivity = (name) => {
      const hit = V.find((x) => (isRecv ? isSale(x.vtype) : !isSale(x.vtype)) &&
        String(x.party).trim().toLowerCase() === String(name).trim().toLowerCase());
      if (!hit) return null;
      return (isRecv ? "Last dispatch " : "Last purchase ") + fdateShort(hit.vdate) +
        (hit.qty > 0 ? " · " + fmtQty(hit.qty) + " " + (hit.unit || "") : "") + " · " + inr(hit.amount);
    };
    return (
      <div className="scr"><div className="pagepad">
        <div className="anim-in" style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
          <button className="iconbtn press" onClick={() => setView(null)}><I.back /></button>
          <div style={{ flex: 1 }}>
            <div className="microlbl">{isRecv ? "AANE WALE PAISE" : "DENE WALE PAISE"}</div>
            <div className="h-disp" style={{ fontSize: 24, fontWeight: 700 }}>{isRecv ? "Kis-kis se lena hai" : "Kis-kis ko dena hai"}</div>
          </div>
          {demo && <span className="demo-ribbon">SAMPLE</span>}
        </div>
        <div className="card anim-in st1" style={{ padding: "16px 16px", margin: "12px 0 16px", background: isRecv ? "#F3FBF4" : "#FFFBF2", borderColor: isRecv ? "#CFE9D1" : "#F0DCB8", display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--dim)" }}>Total {isRecv ? "aayega" : "dena hai"}</span>
          <b className="h-disp mono" style={{ fontSize: 26, color: isRecv ? "var(--grn-d)" : "var(--amber)" }}>{inr(total)}</b>
        </div>
        {rows.length === 0 && <div className="card-tint" style={{ padding: 24, textAlign: "center", color: "var(--dim)", fontSize: 14 }}>Kuch nahi - sab clear hai. 🎉</div>}
        {rows.map((x, i) => {
          const share = total ? (Number(x.balance) / total) * 100 : 0;
          const act = lastActivity(x.name);
          return (
            <div key={i} className={"card anim-in st" + Math.min(6, i + 1)} style={{ padding: "14px 15px", marginBottom: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                <div style={{ fontWeight: 600, fontSize: 15, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{x.name}</div>
                <b className="mono" style={{ flexShrink: 0, fontSize: 15.5, color: isRecv ? "var(--grn-d)" : "var(--amber)" }}>{inr(x.balance)}</b>
              </div>
              <div style={{ height: 7, borderRadius: 999, background: "var(--soft)", border: "1px solid var(--line)", marginTop: 9, overflow: "hidden" }}>
                <div style={{ width: Math.max(3, share) + "%", height: "100%", borderRadius: 999, background: isRecv ? "linear-gradient(90deg,#2E9E33,#7CCB80)" : "linear-gradient(90deg,#C98A2B,#E8C173)" }} />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, gap: 8 }}>
                <span className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>{Math.round(share)}% of total</span>
                {act && <span className="mono" style={{ fontSize: 11, color: "var(--faint)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{act}</span>}
              </div>
            </div>
          );
        })}
        <div className="card-tint anim-in" style={{ padding: "13px 15px", fontSize: 12.5, color: "var(--dim)", lineHeight: 1.6, marginTop: 6 }}>
          {isRecv ? "Ye Tally ke Sundry Debtors se aata hai - jinke naam bill kata hai par payment aana baki hai." : "Ye Tally ke Sundry Creditors se aata hai - jin suppliers ka payment aapki taraf baki hai."}
        </div>
      </div></div>
    );
  }

  /* ---------- overview ---------- */
  return (
    <div className="scr"><div className="pagepad">
      <div className="anim-in" style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
        <button className="iconbtn press" onClick={onBack}><I.back /></button>
        <div style={{ flex: 1 }}>
          <div className="microlbl">TALLY · SEEDHA HISAAB</div>
          <div className="h-disp" style={{ fontSize: 24, fontWeight: 700 }}>Business at a glance</div>
        </div>
        {demo && <span className="demo-ribbon">SAMPLE</span>}
      </div>
      <div style={{ fontSize: 12.5, color: "var(--faint)", margin: "0 0 16px 46px" }}>
        {demo ? "Connect Tally in Setup to see your real numbers here." : asOf ? "From your Tally, updated " + new Date(asOf).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "From your Tally."}
      </div>

      {loading && <div className="mono" style={{ color: "var(--faint)", fontSize: 12, letterSpacing: ".2em", textAlign: "center", padding: 30 }}>LOADING...</div>}
      {!loading && (<>

      {/* money in / money out - tap for the full party-wise story */}
      <div className="anim-in st1" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <button className="card press" onClick={() => setView("recv")} style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", padding: "16px 15px", borderRadius: 22, border: "1px solid #CFE9D1", background: "#F3FBF4", boxShadow: "var(--sh-s)" }}>
          <div className="microlbl" style={{ color: "var(--grn-d)" }}>AANE WALE (customers owe you)</div>
          <div className="h-disp mono" style={{ fontSize: 27, fontWeight: 700, color: "var(--grn-d)", marginTop: 5 }}>{inr(recvTotal)}</div>
          <div style={{ fontSize: 12, color: "var(--dim)", marginTop: 3, display: "flex", alignItems: "center", gap: 3 }}>{receivable.length} customer{receivable.length === 1 ? "" : "s"} <I.chev style={{ width: 13 }} /></div>
        </button>
        <button className="card press" onClick={() => setView("pay")} style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", padding: "16px 15px", borderRadius: 22, border: "1px solid #F0DCB8", background: "#FFFBF2", boxShadow: "var(--sh-s)" }}>
          <div className="microlbl" style={{ color: "var(--amber)" }}>DENE WALE (you owe suppliers)</div>
          <div className="h-disp mono" style={{ fontSize: 27, fontWeight: 700, color: "var(--amber)", marginTop: 5 }}>{inr(payTotal)}</div>
          <div style={{ fontSize: 12, color: "var(--dim)", marginTop: 3, display: "flex", alignItems: "center", gap: 3 }}>{payable.length} supplier{payable.length === 1 ? "" : "s"} <I.chev style={{ width: 13 }} /></div>
        </button>
      </div>

      {/* shipped this month */}
      <div className="hero-card anim-in st2" style={{ padding: "20px 20px", marginTop: 12 }}>
        <div className="mono" style={{ fontSize: 10, letterSpacing: ".16em", color: "rgba(255,255,255,.82)", position: "relative", zIndex: 1 }}>MAAL GAYA IS MAHINE (sales)</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, position: "relative", zIndex: 1 }}>
          <span className="h-disp mono" style={{ fontSize: 40, fontWeight: 700 }}>{monthQty > 0 ? fmtQty(monthQty) : monthSales.length}</span>
          <span className="h-disp" style={{ fontSize: 19, fontWeight: 700, color: "rgba(255,255,255,.9)" }}>{monthQty > 0 ? mainUnit : "dispatches"}</span>
        </div>
        <div style={{ fontSize: 13, color: "rgba(255,255,255,.88)", marginTop: 4, position: "relative", zIndex: 1 }}>
          {monthSales.length} dispatch{monthSales.length === 1 ? "" : "es"} · {inr(monthValue)} ka maal
        </div>
      </div>

      {/* dispatch planner - kise pehle bhejein */}
      {planned.length > 0 && (<>
        <div className="anim-in st3" style={{ margin: "22px 0 4px" }}><span className="eyebrow">Agla dispatch kise bhejein?</span></div>
        <div style={{ fontSize: 12.5, color: "var(--faint)", marginBottom: 10 }}>Deadline, kitne din se intezaar, aur kitna baki hai - sab jod kar order suggest hota hai.</div>
        {planned.slice(0, 4).map((o, i) => {
          const pct = Math.min(100, Math.round((o.shipped / o.ordered) * 100));
          return (
            <div key={o.qid} className="card anim-in" style={{ padding: "14px 15px", marginBottom: 10, borderColor: i === 0 ? "#CFE9D1" : undefined, background: i === 0 ? "#F7FCF8" : "#fff" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span className="mono" style={{ flexShrink: 0, width: 26, height: 26, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12.5, fontWeight: 700, background: i === 0 ? "linear-gradient(135deg,#2E9E33,#1B7A20)" : "var(--soft)", color: i === 0 ? "#fff" : "var(--dim)", border: i === 0 ? "none" : "1px solid var(--line)" }}>{i + 1}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 15, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{o.customer}</div>
                  <div style={{ fontSize: 12.5, color: "var(--dim)", marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{o.item}</div>
                </div>
                <div className="mono" style={{ flexShrink: 0, fontSize: 13, fontWeight: 600, color: "var(--amber)" }}>{fmtQty(o.remaining)} {o.unit || ""} baki</div>
              </div>
              <div style={{ height: 8, borderRadius: 999, background: "var(--soft)", border: "1px solid var(--line)", marginTop: 10, overflow: "hidden" }}>
                <div style={{ width: pct + "%", height: "100%", borderRadius: 999, background: "linear-gradient(90deg,#2E9E33,#7CCB80)" }} />
              </div>
              <div className="mono" style={{ fontSize: 11, color: "var(--faint)", marginTop: 5 }}>{fmtQty(o.shipped)} / {fmtQty(o.ordered)} {o.unit} shipped ({pct}%)</div>
              <div style={{ display: "flex", flexWrap: "wrap" }}>
                {o.reasons.map((r, ri) => <span key={ri} style={chipStyle(r.c)}>{r.t}</span>)}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
                <span className="mono" style={{ fontSize: 10, letterSpacing: ".1em", color: "var(--faint)", flexShrink: 0 }}>DEADLINE</span>
                {demo ? (
                  <span className="mono" style={{ fontSize: 12.5, color: "var(--dim)" }}>{o.deliverBy ? fdateShort(o.deliverBy) : "-"} <span style={{ color: "var(--faint)" }}>(sample)</span></span>
                ) : (
                  <input className="input mono" type="date" style={{ padding: "7px 10px", fontSize: 13, flex: 1, maxWidth: 170 }}
                    value={o.deliverBy ? isoDate(o.deliverBy) : ""}
                    onChange={(e) => { updateQuote(o.qid, { deliverBy: e.target.value ? new Date(e.target.value).getTime() : null }); ping(e.target.value ? "Deadline set" : "Deadline hata di"); }} />
                )}
              </div>
            </div>
          );
        })}
      </>)}

      {/* top dues */}
      {receivable.length > 0 && (<>
        <div className="anim-in st3" style={{ margin: "22px 0 10px" }}><span className="eyebrow">Sabse zyada baki</span></div>
        <div className="card anim-in" style={{ padding: "4px 16px" }}>
          {receivable.slice().sort((a, b) => b.balance - a.balance).slice(0, 5).map((x, i) => (
            <div key={i} className="rowline" style={{ alignItems: "center" }}>
              <span className="rl" style={{ fontSize: 14.5, fontWeight: 600, color: "var(--ink)" }}>{x.name}</span>
              <b className="mono" style={{ color: "var(--red)", fontSize: 15 }}>{inr(x.balance)}</b>
            </div>
          ))}
        </div>
      </>)}

      {/* recent dispatches */}
      {dispatches.length > 0 && (<>
        <div className="anim-in st4" style={{ margin: "22px 0 10px" }}><span className="eyebrow">Recent dispatches</span></div>
        {dispatches.map((x, i) => (
          <div key={i} className="card anim-in" style={{ padding: "13px 15px", marginBottom: 9, display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ width: 42, height: 42, borderRadius: 12, background: "var(--grn-100)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>🚚</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{x.party || "(no party)"}</div>
              <div style={{ fontSize: 12.5, color: "var(--dim)", marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {x.qty > 0 ? fmtQty(x.qty) + " " + (x.unit || "") + (x.item ? " · " + x.item : "") : (x.item || "sale")} · {fdateShort(x.vdate)}
              </div>
            </div>
            <b className="mono" style={{ flexShrink: 0, fontSize: 14.5, color: "var(--grn-d)" }}>{inr(x.amount)}</b>
          </div>
        ))}
      </>)}

      <div className="card-tint anim-in st5" style={{ padding: "14px 16px", display: "flex", gap: 10, alignItems: "flex-start", marginTop: 14, marginBottom: 8 }}>
        <span style={{ color: "var(--grn)", flexShrink: 0, marginTop: 1 }}><I.bolt /></span>
        <span style={{ fontSize: 13, color: "var(--dim)", lineHeight: 1.6 }}>
          Ye page aapke accountant ke Tally se apne aap banta hai - aapko Tally kholne ki zaroorat nahi. Setup mein "Tally (BETA)" se connect hota hai.
        </span>
      </div>
      </>)}
    </div></div>
  );
}

/* ================= HELP ================= */
const FAQS = [
  { q: "What do I put in 'cycle time'?", a: "It's the machine's time for one piece - from pressing Cycle Start until the finished part comes out. On a CNC it's nearly the same every piece. The machine's control screen shows the last cycle time after each run.",
    hi: "साइकिल टाइम मतलब मशीन का समय - एक पीस के लिए, साइकिल स्टार्ट दबाने से लेकर पार्ट तैयार होने तक। सी एन सी पर ये हर पीस पर लगभग एक जैसा रहता है। मशीन की स्क्रीन पर हर रन के बाद ये दिख जाता है।" },
  { q: "What's the difference between cycle time and manual time?", a: "Cycle time is the machine working on its own, charged at the machine's rupee-per-hour rate. Manual time is a person's work while the machine is stopped - loading, deburring, checking - charged at the cheaper labour rate. Keeping them separate keeps the price accurate.",
    hi: "साइकिल टाइम वो है जब मशीन खुद चलती है, जो मशीन के प्रति घंटा रेट पर लगता है। मैनुअल टाइम वो है जब मशीन बंद रहती है और आदमी काम करता है - लोडिंग, डीबरिंग, चेकिंग - जो सस्ते लेबर रेट पर लगता है। दोनों अलग रखने से रेट सही बनता है।" },
  { q: "What is 'one-time setup' and why does it change small orders?", a: "Setup is everything done once before a batch runs - fixture, program, first trial piece. The app spreads that cost across the whole quantity. So a one-hour setup adds little per piece on 200 pieces, but a lot per piece on 20. That's why small orders should cost more each - and why gut quotes lose money on them.",
    hi: "सेटअप वो काम है जो बैच शुरू करने से पहले एक बार होता है - फिक्स्चर, प्रोग्राम, पहला ट्रायल पीस। ऐप इस खर्च को पूरी क्वांटिटी में बाँट देता है। तो एक घंटे का सेटअप दो सौ पीस पर थोड़ा बढ़ाता है, पर बीस पीस पर बहुत ज़्यादा। इसीलिए छोटे ऑर्डर का रेट ज़्यादा होना चाहिए।" },
  { q: "I don't know my machine's hourly rate. What now?", a: "Open Setup, then Add machine, then the true hourly-rate calculator. Enter machine price, electricity, operator salary and maintenance, and it works out the real rate for you. Most owners find it's far higher than they assumed.",
    hi: "सेटअप खोलिए, फिर ऐड मशीन, फिर ट्रू ऑवरली रेट कैलकुलेटर। मशीन की कीमत, बिजली, ऑपरेटर की सैलरी और मेंटेनेंस डालिए - ऐप आपका असली प्रति घंटा रेट निकाल देगा। ज़्यादातर मालिकों को ये उनकी सोच से कहीं ज़्यादा मिलता है।" },
  { q: "Where do material rates come from?", a: "From your Setup, in the Materials list. The starting rates are common NCR ballparks - change them to the exact price you buy at. Every quote then uses your numbers.",
    hi: "ये सेटअप में मटेरियल लिस्ट से आते हैं। शुरुआती रेट एन सी आर के आम भाव हैं - इन्हें अपनी असली खरीद कीमत पर बदल दीजिए। फिर हर कोटेशन आपके नंबर इस्तेमाल करेगा।" },
  { q: "Is my data private?", a: "Yes. Your rates, customers and quotes stay on your device for this prototype, and in the full product they're stored separately per shop - never shown to any other shop, never used to undercut you. You can clear everything anytime in Setup, under Data.",
    hi: "हाँ। आपके रेट, ग्राहक और कोटेशन आपके फ़ोन में रहते हैं। पूरे प्रोडक्ट में हर शॉप का डेटा अलग रखा जाता है - किसी और शॉप को नहीं दिखाया जाता, आपके खिलाफ़ इस्तेमाल नहीं होता। आप सेटअप में डेटा सेक्शन से कभी भी सब हटा सकते हैं।" },
  { q: "How do I send a quotation to a customer?", a: "Finish a quote and tap Save. You'll get a ready WhatsApp message to copy or open in WhatsApp, and a Download PDF quotation button that makes a clean, branded document you can send or print.",
    hi: "कोटेशन पूरा करके सेव दबाइए। आपको तैयार व्हाट्सएप मैसेज मिलेगा - कॉपी कीजिए या व्हाट्सएप में खोलिए - और एक पी डी एफ डाउनलोड बटन जो साफ़, प्रोफेशनल कागज़ बनाता है जो आप भेज या प्रिंट कर सकते हैं।" },
  { q: "Can I change a quote after sending?", a: "Make a new quote with the corrected numbers - it takes under a minute for a repeat part. Your old quote stays in history so you can compare.",
    hi: "सही नंबरों के साथ नया कोटेशन बना लीजिए - दोबारा वाले पार्ट के लिए एक मिनट से कम लगता है। आपका पुराना कोटेशन हिस्ट्री में रहता है ताकि आप तुलना कर सकें।" },
];

function Help({ data, ping }) {
  const [open, setOpen] = useState(0);
  const [speaking, setSpeaking] = useState(-1);
  const waNum = "919910605207"; // TODO: replace with real support number before launch

  const speakHi = (i) => {
    if (!("speechSynthesis" in window)) { ping("Audio not supported on this device"); return; }
    window.speechSynthesis.cancel();
    if (speaking === i) { setSpeaking(-1); return; }
    const u = new SpeechSynthesisUtterance(FAQS[i].hi);
    u.lang = "hi-IN"; u.rate = 0.95;
    const voices = window.speechSynthesis.getVoices();
    const hi = voices.find((v) => v.lang === "hi-IN") || voices.find((v) => v.lang && v.lang.startsWith("hi"));
    if (hi) u.voice = hi;
    u.onend = () => setSpeaking(-1);
    u.onerror = () => setSpeaking(-1);
    setSpeaking(i);
    window.speechSynthesis.speak(u);
  };
  useEffect(() => {
    if ("speechSynthesis" in window) window.speechSynthesis.getVoices();
    return () => { if ("speechSynthesis" in window) window.speechSynthesis.cancel(); };
  }, []);

  return (
    <div className="scr"><div className="pagepad">
      <div className="anim-in" style={{ marginBottom: 18 }}>
        <span className="eyebrow">We're here</span>
        <div className="h-disp" style={{ fontSize: 26, fontWeight: 700, marginTop: 4 }}>Help &amp; support</div>
        <div style={{ fontSize: 14.5, color: "var(--dim)", marginTop: 4 }}>Common questions - tap 🔊 to hear the answer in Hindi.</div>
      </div>

      <span className="eyebrow anim-in st1" style={{ display: "block", marginBottom: 12 }}>Frequently asked</span>
      {FAQS.map((f, i) => (
        <div key={i} className="card anim-in" style={{ animationDelay: (i * .03 + .08) + "s", marginBottom: 9, overflow: "hidden" }}>
          <button onClick={() => setOpen(open === i ? -1 : i)} style={{ all: "unset", boxSizing: "border-box", width: "100%", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "16px 16px" }}>
            <span style={{ fontWeight: 600, fontSize: 14.5, fontFamily: "var(--disp)", lineHeight: 1.3 }}>{f.q}</span>
            <span style={{ fontFamily: "var(--mono)", color: "var(--grn)", fontSize: 20, flexShrink: 0, transform: open === i ? "rotate(45deg)" : "none", transition: "transform .2s" }}>+</span>
          </button>
          {open === i && (
            <div className="anim-in" style={{ padding: "0 16px 16px" }}>
              <div style={{ fontSize: 14, color: "var(--dim)", lineHeight: 1.65, marginBottom: 12 }}>{f.a}</div>
              <button className="press" onClick={() => speakHi(i)}
                style={{ display: "inline-flex", alignItems: "center", gap: 8, border: "1.5px solid " + (speaking === i ? "var(--grn)" : "var(--line2)"), background: speaking === i ? "var(--grn-100)" : "#fff", color: speaking === i ? "var(--grn-d)" : "var(--ink)", borderRadius: 999, padding: "9px 15px", cursor: "pointer", fontFamily: "var(--sans)", fontWeight: 600, fontSize: 13.5 }}>
                <span style={{ fontSize: 15 }}>{speaking === i ? "⏹" : "🔊"}</span>
                {speaking === i ? "रोकिए" : "हिंदी में सुनिए"}
              </button>
            </div>
          )}
        </div>
      ))}

      {/* contact - at the bottom */}
      <span className="eyebrow anim-in" style={{ display: "block", margin: "26px 0 12px" }}>Talk to a person</span>
      <div className="anim-in" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <a className="press" href={"https://wa.me/" + waNum + "?text=" + encodeURIComponent("Hi, I need help with TrackRakho")} target="_blank" rel="noreferrer"
          style={{ textDecoration: "none", background: "linear-gradient(135deg,#2E9E33,#1B7A20)", color: "#fff", borderRadius: 20, padding: "18px 16px", display: "flex", flexDirection: "column", gap: 8, boxShadow: "var(--sh-m)" }}>
          <I.wa /><div><div style={{ fontWeight: 700, fontSize: 15 }}>Chat with us</div><div style={{ fontSize: 12, color: "rgba(255,255,255,.85)", marginTop: 1 }}>WhatsApp · in Hindi</div></div>
        </a>
        <a className="press" href={"tel:+" + waNum}
          style={{ textDecoration: "none", background: "#fff", color: "var(--ink)", border: "1px solid var(--line2)", borderRadius: 20, padding: "18px 16px", display: "flex", flexDirection: "column", gap: 8, boxShadow: "var(--sh-s)" }}>
          <span style={{ color: "var(--grn-d)" }}><I.phone /></span><div><div style={{ fontWeight: 700, fontSize: 15 }}>Call us</div><div style={{ fontSize: 12, color: "var(--dim)", marginTop: 1 }}>Mon-Sat · 10am-7pm</div></div>
        </a>
      </div>
      <div className="card-tint anim-in" style={{ padding: "16px 16px", marginTop: 12, textAlign: "center" }}>
        <div style={{ fontSize: 13.5, color: "var(--dim)" }}>Founding shops get priority support, in Hindi, from the people who built this.</div>
      </div>
      <div style={{ fontSize: 11.5, color: "var(--faint)", textAlign: "center", margin: "18px 0 6px" }} className="mono">TRACKRAKHO · EARLY ACCESS</div>
    </div></div>
  );
}

/* ================= SETUP ================= */
function Setup({ data, setData, ping, account, sync, goSubscribe, onLogout }) {
  const [calcOpen, setCalcOpen] = useState(false);
  const [matPick, setMatPick] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [tallyKey, setTallyKey] = useState(null);   // connector key, fetched on demand
  const [tallyBusy, setTallyBusy] = useState(false);
  const [gmail, setGmail] = useState(null);         // { connected, email, error } | null
  const [gmailBusy, setGmailBusy] = useState(false);
  const cloudGoogle = !!(sb && account && account.method === "google");
  useEffect(() => { let alive = true; if (cloudGoogle) gmailStatus().then((d) => { if (alive) setGmail(d); }); return () => { alive = false; }; }, [cloudGoogle]);
  const s = data.settings;
  const setS = (k, v) => setData({ ...data, settings: { ...s, [k]: v } });
  const ind = industryOf(data);
  const isMach = ind.key === "machining";

  const [rc, setRc] = useState({ name: "", price: 1500000, life: 8, hrsDay: 8, daysMo: 25, kw: 8, unit: 8, operator: 30000, maint: 75000 });
  const mh = rc.hrsDay * rc.daysMo;
  const dep = rc.price / rc.life / 12 / mh, pow = rc.kw * rc.unit, op = rc.operator / mh, mnt = rc.maint / 12 / mh;
  const rate = Math.ceil(dep + pow + op + mnt);
  const segs = [{ v: dep, c: "#155E18", l: "Depreciation" }, { v: pow, c: "#228B22", l: "Power" }, { v: op, c: "#3FAE45", l: "Operator" }, { v: mnt, c: "#7CCB80", l: "Maintenance" }];

  const addMachine = () => {
    if (!rc.name.trim()) return ping("Give the machine a name");
    setData({ ...data, machines: [...data.machines, { id: uid(), name: rc.name.trim(), rate }] });
    setCalcOpen(false); setRc({ ...rc, name: "" }); ping("Machine added at " + inr(rate) + "/hr");
  };
  const addMaterial = (m) => {
    if (data.materials.some((x) => x.name.toLowerCase() === m.name.toLowerCase())) { ping(m.name + " already added"); return; }
    setData({ ...data, materials: [...data.materials, { id: uid(), name: m.name, rate: m.rate }] }); ping(m.name + " added");
  };
  const libRemaining = MAT_LIB.filter((m) => !data.materials.some((x) => x.name.toLowerCase() === m.name.toLowerCase()));

  /* fetch (or regenerate) the Tally connector key from our Netlify function.
     Backend absent -> non-JSON response -> friendly toast, nothing breaks. */
  const fetchTallyKey = async (regen) => {
    if (regen && !window.confirm("Purani key kaam karna band kar degi. Nayi key banayein?")) return;
    setTallyBusy(true);
    try {
      const opts = regen
        ? { method: "POST", headers: { "content-type": "application/json", accept: "application/json", ...(await authHeaders()) }, body: JSON.stringify({ regenerate: true }) }
        : { headers: { accept: "application/json", ...(await authHeaders()) } };
      const r = await fetch(WA_API + "/tally-key", opts);
      const ct = r.headers.get("content-type") || "";
      if (!r.ok || !ct.includes("application/json")) { ping("Could not get key - check internet"); return; }
      const d = await r.json().catch(() => null);
      if (d && d.ok && d.key) setTallyKey(d.key);
      else ping("Could not get key - check internet");
    } catch { ping("Could not get key - check internet"); }
    finally { setTallyBusy(false); }
  };

  return (
    <div className="scr"><div className="pagepad">
      <div className="anim-in" style={{ marginBottom: 18 }}>
        <span className="eyebrow">Your shop</span>
        <div className="h-disp" style={{ fontSize: 26, fontWeight: 700, marginTop: 4 }}>Setup</div>
      </div>

      {/* account + plan */}
      {(() => {
        const plan = PLANS.find((p) => p.id === account?.plan);
        return (
          <div className="hero-card anim-in" style={{ padding: "20px 20px", marginBottom: 18 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", position: "relative", zIndex: 1 }}>
              <div>
                <div className="mono" style={{ fontSize: 9.5, letterSpacing: ".16em", color: "rgba(255,255,255,.78)" }}>CURRENT PLAN</div>
                <div className="h-disp" style={{ fontSize: 24, fontWeight: 700, marginTop: 4 }}>{plan ? plan.name : "No plan yet"}</div>
                <div style={{ fontSize: 13, color: "rgba(255,255,255,.85)", marginTop: 2 }}>
                  {account?.method === "google" ? (account.email || account.name) : account?.method === "phone" ? account.phone : account?.username || "Signed in"}
                </div>
                {sync && sync !== "local" && (
                  <div className="mono" style={{ fontSize: 10, letterSpacing: ".08em", marginTop: 7, display: "inline-flex", alignItems: "center", gap: 6, background: "rgba(255,255,255,.16)", border: "1px solid rgba(255,255,255,.28)", padding: "4px 10px", borderRadius: 999 }}>
                    <i style={{ width: 6, height: 6, borderRadius: "50%", background: sync === "synced" ? "#7CFF8A" : sync === "saving" ? "#FFD966" : "#FF9F7A" }} />
                    {sync === "synced" ? "SYNCED TO YOUR ACCOUNT" : sync === "saving" ? "SAVING..." : "OFFLINE - WILL SYNC"}
                  </div>
                )}
              </div>
              {plan && <div style={{ background: "rgba(255,255,255,.18)", border: "1px solid rgba(255,255,255,.3)", borderRadius: 12, padding: "8px 12px", textAlign: "right" }}>
                <div className="mono" style={{ fontSize: 18, fontWeight: 600 }}>₹{plan.price.toLocaleString("en-IN")}</div>
                <div className="mono" style={{ fontSize: 8.5, letterSpacing: ".12em", color: "rgba(255,255,255,.75)" }}>/ MONTH</div>
              </div>}
            </div>
            <button className="press" onClick={goSubscribe} style={{ position: "relative", zIndex: 1, width: "100%", marginTop: 16, background: "rgba(255,255,255,.95)", color: "var(--grn-d)", border: "none", borderRadius: 14, padding: "13px", fontWeight: 700, fontSize: 14.5, fontFamily: "var(--sans)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 7 }}>
              <I.crown /> {plan ? "Change plan" : "See plans & subscribe"}
            </button>
          </div>
        );
      })()}

      <label className="lbl">Shop name</label>
      <input className="input anim-in st1" value={data.shopName} onChange={(e) => setData({ ...data, shopName: e.target.value })} />

      {/* trade focus - tunes labels + examples */}
      <label className="lbl anim-in st1" style={{ marginTop: 16 }}>Your trade</label>
      <div className="anim-in st1" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {Object.values(INDUSTRIES).map((it) => (
          <button key={it.key} className={"fpill press " + (ind.key === it.key ? "on" : "")}
            onClick={() => {
              setData((d) => {
                /* fresh/untouched pipeline follows the trade; real data never overwritten */
                const untouched = !d.quotes.length || d.quotes.every((q) => q.seed);
                const sq = untouched ? buildSampleQuotes(it.key) : null;
                return { ...d, industry: it.key, quotes: sq || d.quotes };
              });
              ping(it.label);
            }}>{it.emoji} {it.label}</button>
        ))}
      </div>

      {/* categories that power the Home tiles + pipeline filter */}
      <div className="anim-in st2" style={{ margin: "24px 0 10px" }}><span className="eyebrow">Your categories</span></div>
      <div className="card" style={{ padding: "14px 15px" }}>
        <span className="hint" style={{ margin: "0 0 10px" }}>These power the tiles on your Home screen and the filters in your pipeline. Every quote is sorted into one automatically.</span>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {(ind.cats || []).map((c) => (
            <span key={c.key} style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "var(--soft)", border: "1px solid var(--line)", borderRadius: 999, padding: "7px 12px", fontSize: 13.5, fontWeight: 600 }}>
              <span style={{ fontSize: 14 }}>{c.emoji}</span> {c.label}
            </span>
          ))}
        </div>
      </div>

      {isMach && (<>
      {/* machines */}
      <div className="anim-in st2" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "24px 0 10px" }}>
        <span className="eyebrow">Machines</span>
        <button className="btn btn-sm btn-soft press" onClick={() => setCalcOpen(!calcOpen)}>{calcOpen ? "Close" : "+ Add machine"}</button>
      </div>
      {data.machines.map((m) => (
        <div key={m.id} className="card" style={{ padding: "14px 15px", marginBottom: 9, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontWeight: 600, fontSize: 15 }}>{m.name}</span>
          <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <b className="mono" style={{ color: "var(--grn-d)" }}>{inr(m.rate)}/hr</b>
            <button className="iconbtn press" style={{ width: 34, height: 34 }} onClick={() => { setData({ ...data, machines: data.machines.filter((x) => x.id !== m.id) }); ping("Removed"); }}><I.trash /></button>
          </span>
        </div>
      ))}

      {calcOpen && (
        <div className="card anim-in" style={{ padding: 16, marginTop: 6, border: "1.5px solid #CFE9D1" }}>
          <div className="lbl" style={{ color: "var(--grn-d)", marginBottom: 4 }}>True hourly-rate calculator</div>
          <span className="hint">Fill these once - the app works out what one machine-hour really costs you.</span>
          <label className="lbl" style={{ marginTop: 8 }}>Machine name</label>
          <input className="input" placeholder="e.g. VMC 850 #2" value={rc.name} onChange={(e) => setRc({ ...rc, name: e.target.value })} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12 }}>
            {[["price", "Machine price ₹"], ["life", "Life (years)"], ["hrsDay", "Hours / day"], ["daysMo", "Days / month"], ["kw", "Power (kW)"], ["unit", "₹ / unit"], ["operator", "Operator ₹/mo"], ["maint", "Maintenance ₹/yr"]].map(([k, l]) => (
              <div key={k}><label className="lbl" style={{ fontSize: 12.5 }}>{l}</label><input className="input mono" type="number" inputMode="decimal" value={rc[k]} onChange={(e) => setRc({ ...rc, [k]: +e.target.value || 0 })} /></div>
            ))}
          </div>
          <div className="segbar" style={{ marginTop: 16 }}>{segs.map((g, i) => <i key={i} style={{ width: (g.v / (rate || 1)) * 100 + "%", background: g.c }} />)}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 8 }}>
            {segs.map((g, i) => (<span key={i} className="mono" style={{ fontSize: 10.5, color: "var(--dim)", display: "flex", alignItems: "center", gap: 5 }}><i style={{ width: 9, height: 9, borderRadius: 2, background: g.c, display: "inline-block" }} />{g.l} {inr(g.v, 0)}</span>))}
          </div>
          <div className="hero-card" style={{ padding: "15px 18px", marginTop: 14, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span className="mono" style={{ fontSize: 10, letterSpacing: ".16em", color: "rgba(255,255,255,.82)" }}>TRUE RATE</span>
            <span className="mono" style={{ fontSize: 25, fontWeight: 600 }}><CountUp value={rate} />/hr</span>
          </div>
          <button className="btn btn-grn press" style={{ width: "100%", marginTop: 12 }} onClick={addMachine}>Save machine</button>
        </div>
      )}

      {/* materials + adder */}
      <div className="anim-in st3" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "24px 0 10px" }}>
        <span className="eyebrow">Materials (₹/kg)</span>
        <button className="btn btn-sm btn-soft press" onClick={() => setMatPick(!matPick)}>{matPick ? "Close" : "+ Add material"}</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9 }}>
        {data.materials.map((m) => (
          <div key={m.id} className="card" style={{ padding: "12px 13px", position: "relative" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{m.name}</div>
              <button onClick={() => { setData({ ...data, materials: data.materials.filter((x) => x.id !== m.id) }); ping("Removed"); }} style={{ border: "none", background: "none", color: "var(--faint)", cursor: "pointer", padding: 2 }}><I.trash style={{ width: 15, height: 15 }} /></button>
            </div>
            <div className="suffix-wrap" style={{ marginTop: 7 }}>
              <input className="input mono" style={{ padding: "9px 32px 9px 11px", fontSize: 15 }} type="number" inputMode="decimal" value={m.rate}
                onChange={(e) => setData({ ...data, materials: data.materials.map((x) => x.id === m.id ? { ...x, rate: +e.target.value || 0 } : x) })} />
              <span className="sfx" style={{ right: 11 }}>/kg</span>
            </div>
          </div>
        ))}
      </div>

      {matPick && (
        <div className="card anim-in" style={{ padding: 16, marginTop: 12, border: "1.5px solid #CFE9D1" }}>
          <div className="lbl" style={{ color: "var(--grn-d)", marginBottom: 4 }}>Add from NCR material library</div>
          <span className="hint">Common grades for Faridabad/Manesar shops. Rates are editable starting points - correct them to your real buying price.</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 6 }}>
            {libRemaining.map((m) => (
              <button key={m.name} className="press" onClick={() => addMaterial(m)}
                style={{ display: "flex", alignItems: "center", gap: 7, border: "1.5px solid var(--line2)", background: "#fff", borderRadius: 999, padding: "9px 14px", cursor: "pointer", fontFamily: "var(--sans)" }}>
                <span style={{ fontSize: 13.5, fontWeight: 600 }}>{m.name}</span>
                <span className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>~{inr(m.rate)}</span>
                <I.plus style={{ width: 14, height: 14, color: "var(--grn)" }} />
              </button>
            ))}
            {libRemaining.length === 0 && <span style={{ fontSize: 13, color: "var(--dim)" }}>All library materials added.</span>}
          </div>
        </div>
      )}
      </>)}

      {/* defaults */}
      <div className="anim-in st4" style={{ margin: "24px 0 10px" }}><span className="eyebrow">Defaults</span></div>
      <div className="card" style={{ padding: "4px 16px" }}>
        {[["overheadPct", "Overhead %", "%"], ["marginPct", "Margin %", "%"], ["labourRate", "Labour rate", "₹/hr"], ["validityDays", "Quote validity", "days"], ["gstPct", "GST %", "%"]].map(([k, l, u]) => (
          <div key={k} className="rowline" style={{ alignItems: "center" }}>
            <span className="rl">{l}</span>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input className="input mono" style={{ width: 90, padding: "9px 11px", fontSize: 15, textAlign: "right" }} type="number" inputMode="decimal" value={s[k] ?? ""} onChange={(e) => setS(k, +e.target.value || 0)} />
              <span className="mono" style={{ fontSize: 11, color: "var(--faint)", width: 38 }}>{u}</span>
            </span>
          </div>
        ))}
      </div>

      {/* ===== Smart reading (AI) - opt-in enquiry reader ===== */}
      <div className="anim-in" style={{ margin: "24px 0 10px" }}><span className="eyebrow">Smart reading (AI)</span></div>
      <div className="card" style={{ padding: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 14 }}>
          <div style={{ flex: 1 }}>
            <div className="lbl" style={{ margin: 0 }}>AI fills the form from messages</div>
            <span className="hint" style={{ margin: "5px 0 0" }}>
              Reads each pasted or incoming enquiry with AI (Anthropic) to fill the form - text, photos and PDFs, handwriting aur Hinglish bhi. Phone numbers are removed from text before sending; photos/documents are read as they are. Your quotes, rates and customer list never leave this device. Needs an AI key on the server - without one, the built-in reader keeps working. Turn off anytime.
            </span>
          </div>
          <button onClick={() => { const on = !s.aiParse; setS("aiParse", on); ping(on ? "Smart reading ON" : "Smart reading off"); }}
            aria-label="Toggle smart reading" aria-pressed={!!s.aiParse}
            style={{ flexShrink: 0, width: 54, height: 32, borderRadius: 999, border: "none", cursor: "pointer", position: "relative", transition: "background .2s", background: s.aiParse ? "linear-gradient(135deg,#2E9E33,#1B7A20)" : "var(--line2)" }}>
            <span style={{ position: "absolute", top: 3, left: s.aiParse ? 25 : 3, width: 26, height: 26, borderRadius: "50%", background: "#fff", boxShadow: "0 2px 6px rgba(22,32,26,.25)", transition: "left .2s" }} />
          </button>
        </div>
      </div>

      {/* ===== Tally connector (BETA) - cloud accounts only ===== */}
      {sb && account && account.method === "google" && (<>
        {ind.tally && (<>
        <div className="anim-in" style={{ margin: "24px 0 10px" }}><span className="eyebrow">Tally (BETA)</span></div>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 15, color: "var(--ink)", lineHeight: 1.55 }}>
            Won quotes seedha aapke accountant ke Tally mein - koi retyping nahi. Customer ka baki (outstanding) bhi pipeline mein dikhega.
          </div>
          <div className="lbl" style={{ marginTop: 14 }}>Connector key</div>
          {tallyKey ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div className="mono" style={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: 1.45, background: "var(--soft)", border: "1px solid var(--line2)", borderRadius: 12, padding: "11px 12px", overflowWrap: "anywhere" }}>{tallyKey}</div>
                <button className="btn btn-sm btn-soft press" style={{ flexShrink: 0 }}
                  onClick={async () => { try { await navigator.clipboard.writeText(tallyKey); ping("Key copied"); } catch { ping("Copy failed"); } }}>
                  <I.copy /> Copy
                </button>
              </div>
              <button className="btn btn-sm btn-ghost press" style={{ marginTop: 8 }} disabled={tallyBusy} onClick={() => fetchTallyKey(true)}>New key</button>
            </>
          ) : (
            <button className="btn btn-soft press" style={{ width: "100%" }} disabled={tallyBusy} onClick={() => fetchTallyKey(false)}>
              {tallyBusy ? "Getting key..." : "Get connector key"}
            </button>
          )}
          <div style={{ fontSize: 15, color: "var(--dim)", lineHeight: 1.7, marginTop: 14 }}>
            1. Tally wale computer par connector install karo (TALLY_SETUP.md file dekho).<br />
            2. Key ko config.json mein daalo.<br />
            3. start-connector.bat chalao.
          </div>
        </div>

        </>)}

        {/* ===== Gmail RFQ inbox (BETA) ===== */}
        <div className="anim-in" style={{ margin: "24px 0 10px" }}><span className="eyebrow">Gmail (BETA)</span></div>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 15, color: "var(--ink)", lineHeight: 1.55 }}>
            Email par aane wali RFQ/enquiry apne aap pipeline mein. Har 5 minute mein naye mail check hote hain - quote, rate, enquiry jaise words wale mail hi uthte hain.
          </div>
          {gmail && gmail.connected ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 7, background: "var(--grn-100)", border: "1px solid #CFE9D1", color: "var(--grn-d)", fontSize: 13, fontWeight: 600, padding: "7px 13px", borderRadius: 999 }}>
                  <i style={{ width: 7, height: 7, borderRadius: "50%", background: "#25A75B" }} /> {gmail.email || "Connected"}
                </span>
                {gmail.error && <span style={{ fontSize: 12.5, color: "var(--red)", fontWeight: 600 }}>Reconnect needed - token expire ho gaya</span>}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                <button className="btn btn-sm btn-soft press" disabled={gmailBusy} onClick={async () => {
                  setGmailBusy(true); const n = await gmailPollNow(); setGmailBusy(false);
                  ping(n == null ? "Check failed - dobara try karo" : n === 0 ? "Koi nayi RFQ mail nahi mili" : n + " nayi enquiry - Pipeline dekho");
                }}>{gmailBusy ? "Checking..." : "Check Gmail now"}</button>
                {gmail.error && <button className="btn btn-sm btn-soft press" onClick={() => {
                  localStorage.setItem(GMAIL_FLAG, "1");
                  sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: window.location.origin + "/?gmail_connect=1", scopes: "https://www.googleapis.com/auth/gmail.readonly", queryParams: { access_type: "offline", prompt: "consent" } } });
                }}>Reconnect</button>}
                <button className="btn btn-sm btn-ghost press" style={{ color: "var(--red)" }} onClick={async () => {
                  if (!window.confirm("Gmail disconnect karein? Purani enquiries pipeline mein rahengi.")) return;
                  await gmailDisconnect(); setGmail({ connected: false, email: "", error: "" }); ping("Gmail disconnected");
                }}>Disconnect</button>
              </div>
            </>
          ) : (
            <>
              <button className="btn btn-soft press" style={{ width: "100%", marginTop: 12 }} onClick={() => {
                localStorage.setItem(GMAIL_FLAG, "1");
                sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: window.location.origin + "/?gmail_connect=1", scopes: "https://www.googleapis.com/auth/gmail.readonly", queryParams: { access_type: "offline", prompt: "consent" } } });
              }}>Connect Gmail</button>
              <span className="hint" style={{ margin: "10px 0 0" }}>
                Google se dobara permission maangega (sirf mail READ karne ki - bhejne ya delete ki nahi). App sirf RFQ-jaisi mails uthata hai; aapke mail kahin store nahi hote, sirf enquiry card banta hai.
              </span>
            </>
          )}
        </div>
      </>)}

      {/* ===== Marketplace (concept / demo) - raw-material vendors, machining only ===== */}
      {isMach && (<>
        <div className="anim-in st5" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "26px 0 6px" }}>
          <span className="eyebrow" style={{ display: "flex", alignItems: "center", gap: 7 }}><I.store /> Local suppliers</span>
          <span className="demo-ribbon">CONCEPT</span>
        </div>
        <span className="hint" style={{ marginBottom: 12 }}>A preview of raw-material suppliers near you with live rates. Sample data only - not real vendors yet.</span>
        {SUPPLIERS.map((sp, i) => (
          <div key={i} className="supplier anim-in" style={{ animationDelay: (i * .05 + .1) + "s" }}>
            <div className="slogo" style={{ background: "linear-gradient(135deg," + sp.color + ",#0F4012)" }}>{sp.co.split(" ").map((w) => w[0]).slice(0, 2).join("")}</div>
            <div className="smid"><div className="sname">{sp.co}</div><div className="smeta">{sp.mat}</div><div className="smeta" style={{ color: "var(--faint)" }}>{sp.area}</div></div>
            <div className="sprice"><div className="sp">{inr(sp.rate)}</div><div className="spu">{sp.unit}</div></div>
          </div>
        ))}
        <button className="btn btn-ghost btn-sm press" style={{ width: "100%", marginTop: 4, color: "var(--faint)" }} disabled>Supplier marketplace - coming after launch</button>
      </>)}

      {/* data */}
      <div className="anim-in st6" style={{ margin: "26px 0 10px" }}><span className="eyebrow">Data</span></div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 8 }}>
        <button className="btn btn-ghost btn-sm press" onClick={() => { const base = seedData(); const sq = buildSampleQuotes(ind.key); setData({ ...base, industry: ind.key, quotes: sq || base.quotes }); ping("Sample data loaded"); }}>Load sample</button>
        <button className="btn btn-ghost btn-sm press" style={{ color: "var(--red)" }} onClick={() => {
          if (!confirmClear) { setConfirmClear(true); setTimeout(() => setConfirmClear(false), 2500); return; }
          const d = seedData(); d.quotes = []; d.machines = []; d.shopName = "My Shop"; setData(d); setConfirmClear(false); ping("Cleared");
        }}>{confirmClear ? "Tap again to confirm" : "Clear everything"}</button>
      </div>
      <button className="btn btn-ghost btn-sm press" style={{ width: "100%", marginTop: 14, color: "var(--dim)" }} onClick={onLogout}><I.logout /> Log out</button>
      <div style={{ fontSize: 11.5, color: "var(--faint)", textAlign: "center", paddingBottom: 6, marginTop: 14 }} className="mono">TRACKRAKHO · EARLY ACCESS</div>
    </div></div>
  );
}
