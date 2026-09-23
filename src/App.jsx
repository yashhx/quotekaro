import { useState, useEffect, useRef, Fragment } from "react";
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
/* reads a kanta parchi the owner just photographed. The image goes to our own
   function and on to Claude vision; nothing is saved server-side. Any failure
   returns a reason so the sheet can say why it stayed manual. */
async function aiReadParchi(blob) {
  try {
    const b64 = await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result || "").replace(/^data:[^,]+,/, ""));
      fr.onerror = () => rej(new Error("read failed"));
      fr.readAsDataURL(blob);
    });
    const r = await fetch(WA_API + "/read-parchi", {
      method: "POST", headers: { "content-type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify({ image: b64, mime: blob.type || "image/jpeg" }),
    });
    const ct = r.headers.get("content-type") || "";
    if (!ct.includes("application/json")) return { fields: null, why: "backend missing" };
    const d = await r.json().catch(() => null);
    if (d && d.ok && d.fields) return { fields: d.fields };
    const why = r.status === 401 ? "login needed" : r.status === 501 ? "AI not set up" : r.status === 429 ? "AI busy, try again" : "could not read it";
    return { fields: null, why };
  } catch { return { fields: null, why: "no internet" }; }
}

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
/* set just before linkIdentity() sends the user to Google, so that when the app
   reloads on the way back we know the redirect was a LINK and not a fresh login,
   and can report the outcome instead of silently doing nothing */
const LINK_FLAG = "quotekaro:link:google";
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
    if (d && d.ok) return { ok: true };
    return { ok: false, why: (d && d.error) || ("server said " + r.status) };
  } catch { return { ok: false, why: "no internet / backend missing" }; }
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
html,body{height:100%;}
/* iOS: the DOCUMENT must never scroll - only .scr does. 100vh is the
   toolbar-HIDDEN height there, so min-height:100vh left the page taller than
   the visible area and the whole app (nav bar included) slid up as you dragged. */
body{overflow:hidden; overscroll-behavior:none;}
.qk-root{height:100dvh; width:100%; display:flex; justify-content:center; overflow:hidden;
  background:radial-gradient(60% 40% at 50% 0%, rgba(34,139,34,.07), transparent 70%), linear-gradient(180deg,#F7FAF7,#EEF5EF);
  font-family:var(--sans); color:var(--ink);}
.app{width:100%; max-width:440px; height:100%; background:var(--bg);
  display:flex; flex-direction:column; position:relative; overflow:hidden;
  padding-top:env(safe-area-inset-top);
  box-shadow:0 0 0 1px var(--line), 0 50px 120px -40px rgba(21,94,24,.35);}
@media(min-width:520px){.app{height:min(calc(100dvh - 36px), 940px); margin:auto 0; border-radius:34px;}
  .qk-root{align-items:center; padding:18px 0;}}

.scr{flex:1; overflow-y:auto; overflow-x:hidden; -webkit-overflow-scrolling:touch; scrollbar-width:none;
  overscroll-behavior:contain;}
.scr::-webkit-scrollbar{display:none;}
.pagepad{padding:20px 18px calc(130px + env(safe-area-inset-bottom));}

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
/* Quotes filters: segmented status + one row (follow-ups, category dropdown) */
.segq{display:flex; gap:2px; background:var(--soft); border:1px solid var(--line); border-radius:16px; padding:4px;}
.segq button{flex:1; min-width:0; display:flex; align-items:center; justify-content:center; gap:5px; border:none; background:none;
  font-family:var(--sans); font-weight:600; font-size:14.5px; color:var(--dim); padding:11px 2px; border-radius:12px; cursor:pointer;
  white-space:nowrap; transition:background .2s, color .2s, box-shadow .2s;}
.segq button .mono{font-size:11.5px; font-weight:600; color:var(--faint);}
.segq button.on{background:#fff; color:var(--grn-d); box-shadow:var(--sh-s);}
.segq button.on .mono{color:var(--grn);}
.fuchip{display:inline-flex; align-items:center; gap:7px; flex:none; height:44px; padding:0 15px; border-radius:999px;
  font-family:var(--sans); font-size:14px; font-weight:600; border:1.5px solid var(--line2); background:#fff; color:var(--dim); cursor:pointer;}
.fuchip.hot{border-color:#F0DCB8; color:var(--amber);}
.fuchip.on{background:var(--amber-bg); border-color:#E8C98F; color:var(--amber);}
.selpill{position:relative; flex:1; min-width:0; display:block;}
.selpill select{appearance:none; -webkit-appearance:none; width:100%; height:44px; padding:0 38px 0 16px; border-radius:999px;
  border:1.5px solid var(--line2); background:#fff; font-family:var(--sans); font-size:14px; font-weight:600; color:var(--ink);
  cursor:pointer; outline:none; text-overflow:ellipsis; white-space:nowrap; overflow:hidden;}
.selpill select:focus-visible{border-color:var(--grn); box-shadow:0 0 0 4px rgba(34,139,34,.12);}
.selpill.on select{background:var(--grn-100); border-color:#CFE9D1; color:var(--grn-d);}
.selpill svg{position:absolute; right:14px; top:50%; transform:translateY(-50%) rotate(90deg); pointer-events:none; color:var(--faint);}
/* Empty-state preview: the SHAPE of the real screen, never fake numbers.
   It shows a new owner what the page becomes without pretending he has data. */
.ghost{background:var(--line); border-radius:6px; animation:ghostPulse 2.2s ease-in-out infinite;}
@keyframes ghostPulse{0%,100%{opacity:.55;} 50%{opacity:.3;}}
.ghost-card{background:#fff; border:1px solid var(--line); border-radius:22px; padding:16px; margin-bottom:10px;
  display:flex; align-items:center; gap:12px; box-shadow:var(--sh-s);}
.cat-scroll{-ms-overflow-style:none; scrollbar-width:none;}
.cat-scroll::-webkit-scrollbar{display:none;}
.cat-tile:active{transform:scale(.98);}

/* ---- liquid glass nav (Apple-style) ---- */
/* sits just above the screen edge. The home-indicator inset (~34px) must NOT
   be added on top of a gap - that left the bar floating halfway up the phone;
   the bar's own 8px padding already keeps the buttons off the indicator. */
.navbar{position:absolute; left:14px; right:14px; bottom:max(10px, calc(env(safe-area-inset-bottom) - 16px)); z-index:40; isolation:isolate;
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
/* six boxes now (Supabase issues 6-digit codes) - tighter gap and type so the
   row still fits a 375px phone without shrinking the tap targets */
.otp-row{display:flex; gap:6px; justify-content:space-between; margin:6px 0 4px;}
.otp-row input{width:100%; min-width:0; aspect-ratio:1; text-align:center; font-family:var(--mono); font-size:21px; font-weight:600; border:1.5px solid var(--line2); border-radius:12px; outline:none; transition:border-color .15s, box-shadow .15s; color:var(--ink); padding:0;}
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
/* which bottom-nav item owns each page. Work is a hub - the floor, the truck
   board and the yard all sit under it; pages missing here (setup/help, reached
   from the avatar sheet) hide the pill rather than leave it stranded. */
const NAV_OF = { home: "home", client: "home", quotes: "quotes", work: "work", floor: "work", trucks: "work", stock: "work", tally: "tally" };
const I = {
  home: (p) => (<svg width="23" height="23" viewBox="0 0 24 24" fill="none" {...p}><path d="M3.5 10.5 12 3.5l8.5 7v8.2a1.8 1.8 0 0 1-1.8 1.8h-3.4v-6.1H8.7v6.1H5.3a1.8 1.8 0 0 1-1.8-1.8v-8.2Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/></svg>),
  list: (p) => (<svg width="23" height="23" viewBox="0 0 24 24" fill="none" {...p}><path d="M8.5 6.5h11M8.5 12h11M8.5 17.5h11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/><circle cx="4.6" cy="6.5" r="1.3" fill="currentColor"/><circle cx="4.6" cy="12" r="1.3" fill="currentColor"/><circle cx="4.6" cy="17.5" r="1.3" fill="currentColor"/></svg>),
  gear: (p) => (<svg width="23" height="23" viewBox="0 0 24 24" fill="none" {...p}><circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.8"/><path d="M12 2.8v2.6M12 18.6v2.6M21.2 12h-2.6M5.4 12H2.8M18.5 5.5l-1.9 1.9M7.4 16.6l-1.9 1.9M18.5 18.5l-1.9-1.9M7.4 7.4 5.5 5.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>),
  /* Work - a machine on the floor (not a gear: gear reads as settings) */
  gear2: (p) => (<svg width="23" height="23" viewBox="0 0 24 24" fill="none" {...p}><rect x="3.3" y="5.6" width="17.4" height="8.4" rx="2.2" stroke="currentColor" strokeWidth="1.8"/><path d="M7.2 14v1.6M16.8 14v1.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/><circle cx="7.2" cy="18" r="2.1" stroke="currentColor" strokeWidth="1.8"/><circle cx="16.8" cy="18" r="2.1" stroke="currentColor" strokeWidth="1.8"/></svg>),
  /* Money - a rupee */
  rupee: (p) => (<svg width="23" height="23" viewBox="0 0 24 24" fill="none" {...p}><path d="M8.2 5.4h7.6M8.2 9.3h7.6M8.2 5.4c3.5 0 5.5 1.3 5.5 3.9s-2 3.9-5.5 3.9M8.4 13.2l6.9 5.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>),
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
/* MSMED reminder for a late Tally bill - the byaj counter's action button.
   TONE IS DELIBERATE (user correction 2026-08-10): "kanoon yaad dilana" is
   OFFENSIVE in this culture - a legal reminder reads as a threat and burns
   the relationship. The winning register is polite-but-informed: share the
   MSMED facts as information, explicitly say we would rather NOT press the
   claim, and humbly request payment. Never harden this copy. Rendered ONLY
   behind the machining + settings.udyam gate (traders are excluded from
   MSMED delayed-payment protection - MSMED_LEVERAGE.md). Byaj figure is the
   same understating estimate the counter shows. */
const msmedChaseText = (shop, ref, pending, lateDays, byaj) =>
  `Namaste, this is ${shop}.\n` +
  `A humble reminder: our bill ${ref ? `*${ref}* ` : ""}of ${inr(pending)} is ` +
  (lateDays > 0 ? `now ${lateDays} days past due.` : `pending beyond the 45-day period.`) + `\n` +
  `We are a small Udyam-registered unit, and timely payments keep our work running - your support means a lot to us.\n` +
  `Sirf aapki jaankari ke liye: MSMED niyam ke anusar MSE bills par 45 din ke baad byaj (ab tak lagbhag ${inr(byaj)}) apne aap judta hai. Hum ise claim karna bilkul nahi chahte - bas vinamra nivedan hai ki payment jaldi karwa dein.\n` +
  `We truly value our relationship with you. Thank you for your support. 🙏`;
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
  { id: "full", name: "TrackRakho", price: 999, tagline: "Ek plan - sab kuch included", popular: true,
    features: ["Unlimited quotes & pipeline", "All your companies in ONE plan - no per-firm charge", "WhatsApp + Gmail enquiries in one inbox", "Follow-up reminders & analytics", "Excel import / export & PDF quotations", "Machine floor - live job tracking", "Tally connector", "Priority WhatsApp support"], accent: "#228B22" },
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

/* ---- app language (Setup > Language): "en" | "hi-en" (Hinglish) | "hi" ----
   LANG is stamped from settings on every App render; tx() picks the variant.
   Missing variants fall back hindi -> hinglish -> english. */
let LANG = "hi-en";
const tx = (en, hg, hi) => (LANG === "en" ? en : LANG === "hi" ? (hi || hg || en) : (hg || en));

/* common machines on NCR shop floors - dropdown seeds for Setup > Add machine.
   Names only prefill the calculator; the true-rate math stays the owner's. */
const MACHINE_LIB = [
  "VMC 850", "VMC 1060", "CNC lathe / turning centre", "Traub (auto lathe)",
  "Sliding-head CNC", "Manual lathe", "Milling machine", "Surface grinder",
  "Cylindrical grinder", "Radial drill", "Wire-cut EDM", "Spark EDM",
  "Laser cutting", "Press brake (bending)", "Power press", "Shearing machine",
  "Tapping machine", "Hobbing machine", "Bandsaw",
];

/* every physical machine is its own unit: 3x VMC 850 -> #1 #2 #3 */
const machineUnits = (data) => ((data && data.machines) || []).flatMap((m) => {
  const n = Math.max(1, Math.floor(m.count || 1));
  return Array.from({ length: n }, (_, i) => ({
    uid: m.id + "#" + (i + 1), machineId: m.id, rate: m.rate,
    name: m.name + (n > 1 ? " #" + (i + 1) : ""),
  }));
});

/* ---- machine-floor job math ----
   min per pc = cycle + manual (manual asked only for small batches);
   qty splits across the chosen units; +8% breakdown / tool-change buffer.
   All progress derives from startedAt - no background process needed. */
const JOB_BUFFER = 1.08;
const jobShares = (job) => {
  const n = Math.max(1, (job.units || []).length);
  const q = Math.max(0, Math.floor(job.qty || 0));
  return (job.units || []).map((_, i) => Math.floor(q / n) + (i < q % n ? 1 : 0));
};
/* per-machine allocation. Legacy jobs (flat units array, even split) are
   normalised on the fly; pause/transfer write the explicit alloc form.
   pausedAt/pausedMin freeze a unit's clock; stopped = work moved elsewhere. */
const jobAlloc = (job) => job.alloc || (() => {
  const sh = jobShares(job);
  return (job.units || []).map((u, i) => ({ uid: u, share: sh[i], startedAt: job.startedAt, pausedMin: 0, pausedAt: null, stopped: false }));
})();
const unitElapsedMin = (job, a, now) => {
  const pausedNow = a.pausedAt ? (now - a.pausedAt) / 60000 : 0;
  return Math.max(0, (now - (a.startedAt || job.startedAt)) / 60000 - (a.pausedMin || 0) - pausedNow);
};
const jobStats = (job, now) => {
  const t = now || Date.now();
  const per = (+job.cycleMin || 0) + (+job.manualMin || 0);
  const denom = per * JOB_BUFFER;
  const units = jobAlloc(job).map((a) => {
    const totalMin = a.share * denom;
    const fin = job.done || a.stopped;
    const elapsed = unitElapsedMin(job, a, t);
    const pct = fin ? 100 : totalMin ? Math.min(100, (elapsed / totalMin) * 100) : 0;
    const pcsDone = fin ? a.share : denom > 0 ? Math.min(a.share, Math.floor(elapsed / denom)) : 0;
    return { uid: a.uid, share: a.share, totalMin, pct, pcsDone, paused: !!a.pausedAt && !fin, stopped: !!a.stopped, remainMin: fin ? 0 : Math.max(0, totalMin - elapsed) };
  });
  const live = units.filter((x) => !x.stopped);
  const remainMin = Math.max(0, ...live.map((x) => x.remainMin));
  return { units, remainMin, eta: t + remainMin * 60000, pcsDone: units.reduce((a2, x) => a2 + x.pcsDone, 0) };
};
const fmtDur = (min) => {
  const m = Math.round(min);
  if (m < 1) return tx("done", "khatam", "खत्म");
  if (m < 60) return m + " min";
  const h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d >= 1) return d + tx(" day ", " din ", " दिन ") + (h % 24) + " hr";
  return h + " hr" + (m % 60 ? " " + (m % 60) + " min" : "");
};
const fmtEta = (t) => {
  const d = new Date(t), today = new Date(); today.setHours(0, 0, 0, 0);
  const dd = Math.floor((t - today.getTime()) / 86400000);
  const hm = d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
  return dd === 0 ? tx("today ", "aaj ", "आज ") + hm : dd === 1 ? tx("tomorrow ", "kal ", "कल ") + hm : d.toLocaleDateString("en-IN", { day: "numeric", month: "short" }) + ", " + hm;
};

/* A BRAND NEW ACCOUNT STARTS EMPTY. It used to open on "Sharma Precision
   Works" with eight invented quotes and plausible-looking mobile numbers -
   a new customer's first impression was somebody else's business sitting in
   his account, which is exactly how trust dies on day one. Nothing in here
   belongs to a person: the material rates are commodity reference figures
   the owner edits, and everything else is his own from the first tap.
   The demo pipeline still exists - see `demoShop()` - but only when someone
   explicitly asks for it, and it is labelled SAMPLE wherever it shows. */
const seedData = () => ({
  shopName: "",            /* asked on the welcome screen */
  settings: { overheadPct: 18, marginPct: 25, labourRate: 80, validityDays: 7, gstPct: 18, lang: "hi-en" },
  machines: [],            /* his machines, with his own true hourly rate */
  jobs: [],
  trucks: [],
  trips: [],
  stock: { open: {}, ins: [], outs: [], counts: [] },
  materials: [
    { id: "a", name: "MS (EN8)", rate: 85 }, { id: "b", name: "SS 304", rate: 250 },
    { id: "c", name: "Alu 6061", rate: 300 }, { id: "d", name: "Brass", rate: 560 },
  ],
  quotes: [],
});

/* The demo shop, on request only. Every quote carries `seed: true`, which is
   what puts the SAMPLE chip on the card and the "remove the example data"
   bar on Home. Phone numbers are deliberately unusable (9000000001+) so that
   nobody ever WhatsApps a stranger from a demo row. */
const demoShop = (key) => {
  const base = seedData();
  const quotes = buildSampleQuotes(key) || [];
  return {
    ...base,
    machines: key === "machining" ? [{ id: "m1", name: "VMC 850", rate: 366, count: 2, seed: true }] : [],
    quotes: quotes.map((q, i) => ({ ...q, seed: true, phone: q.phone ? "90000000" + String(10 + i).slice(-2) : "" })),
  };
};

/* Everything the demo put in carries `seed: true`. One tap takes all of it
   back out - a demo the owner cannot remove is just somebody else's data. */
const hasDemo = (d) => !!d && (
  (d.quotes || []).some((q) => q.seed) || (d.trips || []).some((t) => t.seed) ||
  (d.machines || []).some((m) => m.seed) ||
  (((d.stock || {}).ins || []).some((x) => x.seed)) || (((d.stock || {}).outs || []).some((x) => x.seed)) ||
  (((d.stock || {}).counts || []).some((x) => x.seed))
);
const stripDemo = (d) => {
  const st = d.stock || {};
  const jobs = (d.jobs || []).filter((j) => !j.seed);
  /* a demo machine is only removed when nothing real is running on it */
  const used = new Set(jobs.flatMap((j) => (j.units || []).concat((j.alloc || []).map((a) => a.uid))));
  return {
    ...d,
    quotes: (d.quotes || []).filter((q) => !q.seed),
    jobs,
    machines: (d.machines || []).filter((m) => !m.seed || [...used].some((u) => String(u).split("#")[0] === m.id)),
    trucks: (d.trucks || []).filter((t) => !t.seed),
    trips: (d.trips || []).filter((t) => !t.seed),
    stock: { ...st, open: {}, ins: (st.ins || []).filter((x) => !x.seed), outs: (st.outs || []).filter((x) => !x.seed), counts: (st.counts || []).filter((x) => !x.seed) },
  };
};

/* ---- industry / trade focus ----
   The app is trade-agnostic at its core (pipeline, log, follow-ups); industry
   only tunes vocabulary, examples and which sample data a fresh account shows.
   emoji is intentional (matches the app's existing emoji use, e.g. Won toast). */
/* Trades OFFERED to new users (2026-09-17: focus on machining + scrap only).
   Printing/furniture stay fully defined in INDUSTRIES below - an account
   already set to one keeps working, and re-enabling is just adding the key
   back here. Order = order shown in the picker and the Setup switcher. */
const LIVE_TRADES = ["machining", "scrap"];
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
const industryOf = (data) => {
  const base = INDUSTRIES[data && data.industry] || INDUSTRIES.machining;
  const mine = (data && data.myCats && data.myCats[base.key]) || [];
  if (!mine.length) return base;
  const cats = [...base.cats.filter((c) => c.key !== "other"), ...mine, ...base.cats.filter((c) => c.key === "other")];
  return { ...base, cats };
};

/* per-trade suggestions for "add your own category" in Setup */
const CAT_SUGGEST = {
  machining: [
    { key: "dies", label: "Dies & moulds", emoji: "\u{1F9F0}" }, { key: "gears", label: "Gears", emoji: "\u{1F6DE}" },
    { key: "springs", label: "Springs", emoji: "\u{1F300}" }, { key: "casting", label: "Casting", emoji: "\u{1F3ED}" },
    { key: "forging", label: "Forging", emoji: "\u{1F528}" }, { key: "coating", label: "Powder coating", emoji: "\u{1F3A8}" },
    { key: "heattreat", label: "Heat treatment", emoji: "\u{1F525}" },
  ],
  printing: [
    { key: "tshirts", label: "T-shirt printing", emoji: "\u{1F455}" }, { key: "mugs", label: "Mugs & gifts", emoji: "\u2615" },
    { key: "led", label: "LED boards", emoji: "\u{1F4A1}" }, { key: "menus", label: "Menu cards", emoji: "\u{1F37D}\uFE0F" },
    { key: "calendars", label: "Calendars", emoji: "\u{1F4C5}" }, { key: "books", label: "Book printing", emoji: "\u{1F4DA}" },
  ],
  furniture: [
    { key: "kitchen", label: "Modular kitchen", emoji: "\u{1F373}" }, { key: "doors", label: "Doors", emoji: "\u{1F6AA}" },
    { key: "mattress", label: "Mattress", emoji: "\u{1F6CC}" }, { key: "outdoor", label: "Outdoor", emoji: "\u{1F33F}" },
    { key: "repair", label: "Repair & polish", emoji: "\u{1F527}" }, { key: "curtains", label: "Curtains & blinds", emoji: "\u{1FA9F}" },
  ],
  scrap: [
    { key: "paper", label: "Paper / raddi", emoji: "\u{1F4C4}" }, { key: "glass", label: "Glass", emoji: "\u{1F37E}" },
    { key: "tyre", label: "Tyre & rubber", emoji: "\u26AB" }, { key: "battery", label: "Batteries", emoji: "\u{1F50B}" },
    { key: "wood", label: "Wood", emoji: "\u{1FAB5}" },
  ],
};

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
/* ================= SHOP FLOOR (worker device) =================
   A paired floor phone holds ONE thing: a device token. It reads a narrow
   board (machines + running jobs, no money, no quotes) and appends events.
   It never touches shop_data - the owner's app stays the single writer of
   that blob, which is what keeps two devices from destroying each other's
   work (the blob is saved last-write-wins).

   `floorView` is deliberately shared: the worker's phone and the owner's app
   both fold the same event log over the same board, so they can never show
   different answers about which machine is down or how many pieces are done. */
const FLOOR_KEY = "trackrakho:floor:v1";
const floorSession = () => { try { return JSON.parse(localStorage.getItem(FLOOR_KEY) || "null"); } catch { return null; } };
const floorSave = (v) => { try { v ? localStorage.setItem(FLOOR_KEY, JSON.stringify(v)) : localStorage.removeItem(FLOOR_KEY); } catch {} };

/* the eight stop reasons, kept short on purpose: a long list turns the
   breakdown report to mush, and changeover / no-material cost a shop more
   hours than true breakdowns do */
const FLOOR_REASONS = [
  { key: "breakdown", emoji: "\u{1F527}", en: "Machine broke down", hi: "Machine kharab" },
  { key: "tool", emoji: "\u{1FA9B}", en: "Tool broke", hi: "Tool toot gaya" },
  { key: "power", emoji: "\u26A1", en: "No power", hi: "Bijli nahi" },
  { key: "material", emoji: "\u{1F4E6}", en: "No material", hi: "Maal nahi aaya" },
  { key: "operator", emoji: "\u{1F464}", en: "No operator", hi: "Operator nahi" },
  { key: "setting", emoji: "\u{1F6E0}\uFE0F", en: "Setting / setup", hi: "Setting chal rahi" },
  { key: "quality", emoji: "\u{1F50D}", en: "Quality check", hi: "Quality check" },
  { key: "break", emoji: "\u2615", en: "Break", hi: "Break" },
];
const reasonOf = (k) => FLOOR_REASONS.find((r) => r.key === k) || { key: k, emoji: "\u23F8\uFE0F", en: k, hi: k };

const floorApi = async (path, opts = {}) => {
  const sess = floorSession();
  const r = await fetch(WA_API + path, {
    ...opts,
    headers: { "content-type": "application/json", "x-floor-token": (sess && sess.token) || "", ...(opts.headers || {}) },
  });
  const ct = r.headers.get("content-type") || "";
  if (!ct.includes("application/json")) throw new Error("backend missing");
  const d = await r.json();
  if (!d.ok) throw new Error(d.error || "failed");
  return d;
};

/* ---- Web Push for the owner ----
   Only breakdowns push. iOS delivers these only to a PWA added to the home
   screen; everywhere else the browser handles it. Every step degrades to a
   readable reason instead of a dead button. */
const pushSupported = () => typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const urlB64ToUint8 = (b64) => {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
};
async function pushCurrent() {
  if (!pushSupported()) return null;
  try { const reg = await navigator.serviceWorker.ready; return await reg.pushManager.getSubscription(); } catch { return null; }
}
async function pushEnable() {
  if (!pushSupported()) return { ok: false, why: "not supported on this phone" };
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") {
      /* iOS shows the prompt ONCE - after a refusal the only way back is the
         phone's own settings, so say so instead of "refused" */
      return { ok: false, why: Notification.permission === "denied"
        ? tx("blocked - iPhone Settings > TrackRakho > Notifications", "band hai - iPhone Settings > TrackRakho > Notifications se chalu karein", "बंद है - iPhone Settings से चालू करें")
        : "permission refused" };
    }
    const kr = await fetch(WA_API + "/push-subscribe");
    const kd = await kr.json().catch(() => ({}));
    if (!kd.key) return { ok: false, why: "not set up on the server" };
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) ||
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(kd.key) }));
    const r = await fetch(WA_API + "/push-subscribe", {
      method: "POST", headers: { "content-type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify({ subscription: sub.toJSON ? sub.toJSON() : sub }),
    });
    const d = await r.json().catch(() => ({}));
    return d.ok ? { ok: true } : { ok: false, why: d.error || "could not save" };
  } catch (e) { return { ok: false, why: (e && e.message) || "failed" }; }
}
async function pushDisable() {
  const sub = await pushCurrent();
  if (!sub) return { ok: true };
  try {
    await fetch(WA_API + "/push-subscribe", {
      method: "DELETE", headers: { "content-type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
    await sub.unsubscribe();
  } catch {}
  return { ok: true };
}

/* board + event log -> what is actually happening right now.
   Rules, in order of precedence per machine:
     1. a `down` with no later `up` wins - a stopped machine is stopped
     2. a job running on it (from the owner's plan, or started here) shows work
     3. otherwise free
   Piece counts come only from what the floor entered; the owner's own
   time-based estimate is left alone on his page. */
function floorView(board) {
  const b = board || {};
  const evs = [...(b.events || [])].sort((x, y) => (x.at || 0) - (y.at || 0)); /* oldest first */
  const machines = {};
  (b.machines || []).forEach((m) => { machines[m.uid] = { ...m, status: "free", reason: "", since: 0, job: null, pcs: 0 }; });
  const jobs = {};
  (b.jobs || []).forEach((j) => {
    jobs[j.id] = { ...j, pcs: 0, rej: 0, done: false, adhoc: false };
    /* whatever the owner planned is already running unless the floor says otherwise */
    (j.alloc || []).forEach((a) => {
      if (!a.stopped && machines[a.uid]) { machines[a.uid].status = "run"; machines[a.uid].job = j.id; machines[a.uid].since = a.startedAt || j.startedAt || 0; }
    });
  });

  evs.forEach((e) => {
    const m = e.machine_uid ? machines[e.machine_uid] : null;
    if (e.kind === "start") {
      /* work the floor started itself. With a payload it is a FULL job - part,
         qty, cycle and handling time - which the owner's app materialises into
         a real job, ETA maths and all. */
      const p = e.payload || null;
      if (!jobs[e.job_id]) jobs[e.job_id] = { id: e.job_id, part: (p && p.part) || e.note || "Kaam", customer: (p && p.customer) || "",
        qty: (p && Number(p.qty)) || Number(e.qty) || 0, cycleMin: (p && Number(p.cycleMin)) || 0, manualMin: (p && Number(p.manualMin)) || 0,
        pcs: 0, rej: 0, done: false, adhoc: true, units: (p && p.units) || (e.machine_uid ? [e.machine_uid] : []), startedAt: e.at };
      const on = (p && p.units && p.units.length) ? p.units : (e.machine_uid ? [e.machine_uid] : []);
      on.forEach((uid2) => { const mm = machines[uid2]; if (mm && mm.status !== "down") { mm.status = "run"; mm.job = e.job_id; mm.since = e.at; } });
    } else if (e.kind === "count") {
      if (jobs[e.job_id]) jobs[e.job_id].pcs += Number(e.qty) || 0;
      if (m) m.pcs += Number(e.qty) || 0;
    } else if (e.kind === "done") {
      if (jobs[e.job_id]) { jobs[e.job_id].pcs += Number(e.qty) || 0; jobs[e.job_id].rej += Number(e.rej) || 0; jobs[e.job_id].done = true; }
      if (m && m.job === e.job_id) { m.job = null; m.pcs = 0; if (m.status === "run") m.status = "free"; }
    } else if (e.kind === "down") {
      if (m) { m.status = "down"; m.reason = e.reason || "breakdown"; m.since = e.at; m.note = e.note || ""; }
    } else if (e.kind === "up") {
      if (m && m.status === "down") { m.status = m.job ? "run" : "free"; m.reason = ""; m.since = e.at; m.note = ""; }
    } else if (e.kind === "move") {
      const from = e.from_uid ? machines[e.from_uid] : null;
      if (from && from.job === e.job_id) { from.job = null; if (from.status === "run") from.status = "free"; }
      if (m && m.status !== "down") { m.status = "run"; m.job = e.job_id; m.since = e.at; }
    }
  });

  const list = Object.values(machines);
  return {
    machines: list,
    jobs,
    down: list.filter((m) => m.status === "down"),
    running: list.filter((m) => m.status === "run"),
    free: list.filter((m) => m.status === "free"),
    /* today's pieces, the number an owner asks for first */
    todayPcs: evs.filter((e) => (e.kind === "count" || e.kind === "done") && e.at >= startOfDay(Date.now())).reduce((n, e) => n + (Number(e.qty) || 0), 0),
    todayRej: evs.filter((e) => e.kind === "done" && e.at >= startOfDay(Date.now())).reduce((n, e) => n + (Number(e.rej) || 0), 0),
  };
}
/* The day, added up. This is the part a WhatsApp message cannot give you:
   how long each machine actually stood still, and which reason ate the hours.
   Down time is measured from each `down` to its `up` (or to now, if it is
   still stopped), so it is real clock time, not someone's memory. */
function floorDay(events, from) {
  const since = from == null ? startOfDay(Date.now()) : from;
  const evs = [...(events || [])].filter((e) => e.at >= since).sort((a, b) => (a.at || 0) - (b.at || 0));
  const now = Date.now();
  const byMachine = {}, byReason = {};
  const openDown = {};
  let pcs = 0, rej = 0;
  const get = (uid2) => (byMachine[uid2] = byMachine[uid2] || { downMin: 0, pcs: 0, rej: 0, stops: 0 });
  evs.forEach((e) => {
    if (e.kind === "count" || e.kind === "done") {
      pcs += Number(e.qty) || 0; rej += Number(e.rej) || 0;
      if (e.machine_uid) { const m = get(e.machine_uid); m.pcs += Number(e.qty) || 0; m.rej += Number(e.rej) || 0; }
    } else if (e.kind === "down" && e.machine_uid) {
      openDown[e.machine_uid] = { at: e.at, reason: e.reason || "breakdown" };
      get(e.machine_uid).stops++;
    } else if (e.kind === "up" && e.machine_uid && openDown[e.machine_uid]) {
      const d = openDown[e.machine_uid], mins = Math.max(0, (e.at - d.at) / 60000);
      get(e.machine_uid).downMin += mins;
      byReason[d.reason] = (byReason[d.reason] || 0) + mins;
      delete openDown[e.machine_uid];
    }
  });
  /* machines still stopped keep counting against the day */
  Object.keys(openDown).forEach((uid2) => {
    const d = openDown[uid2], mins = Math.max(0, (now - d.at) / 60000);
    get(uid2).downMin += mins;
    byReason[d.reason] = (byReason[d.reason] || 0) + mins;
  });
  const downMin = Object.values(byMachine).reduce((n, m) => n + m.downMin, 0);
  const top = Object.keys(byReason).sort((a, b) => byReason[b] - byReason[a])[0] || "";
  return { pcs, rej, downMin, byMachine, byReason, topReason: top, topReasonMin: top ? byReason[top] : 0, stillDown: Object.keys(openDown).length };
}

/* one line per event, in the owner's feed and the worker's history */
function floorLine(e, machines) {
  const label = (machines && machines[e.machine_uid] && machines[e.machine_uid].label) || e.machine_uid || "";
  const from = (machines && machines[e.from_uid] && machines[e.from_uid].label) || e.from_uid || "";
  const q = Number(e.qty) || 0;
  if (e.kind === "start") return { icon: "\u25B6\uFE0F", text: label + ": " + (e.note || "kaam") + tx(" started", " shuru", " शुरू") };
  if (e.kind === "count") return { icon: "\u2795", text: label + ": " + q + tx(" pieces done", " piece hue", " पीस हुए") };
  /* qty on a `done` is what was added at the end, not the job's total - the
     counts before it are their own lines, so say "more" and never imply a total */
  if (e.kind === "done") return { icon: "\u2705", text: label + ": " + tx("job finished", "kaam khatam", "\u0915\u093E\u092E \u0916\u0924\u094D\u092E") + (q ? " - " + q + tx(" more ok", " aur piece sahi", " \u0914\u0930 \u092A\u0940\u0938 \u0938\u0939\u0940") : "") + (e.rej ? ", " + e.rej + tx(" reject", " reject", " \u0930\u093F\u091C\u0947\u0915\u094D\u091F") : "") };
  if (e.kind === "down") return { icon: "\u{1F6D1}", text: label + " " + tx("stopped", "band", "बंद") + " - " + (LANG === "en" ? reasonOf(e.reason).en : reasonOf(e.reason).hi) + (e.note ? " (" + e.note + ")" : ""), bad: true };
  if (e.kind === "up") return { icon: "\u25B6\uFE0F", text: label + " " + tx("running again", "wapas chalu", "फिर चालू") };
  if (e.kind === "move") return { icon: "\u21AA\uFE0F", text: (q ? q + tx(" pcs ", " pcs ", " पीस ") : "") + tx("moved ", "bheja ", "भेजा ") + (from ? from + " \u2192 " : "") + label };
  if (e.kind === "note") return { icon: "\u{1F4DD}", text: e.note || "" };
  return { icon: "\u2022", text: e.kind };
}

/* ================= PHOTO STORE (IndexedDB) =================
   Parchi photos are binary and there can be hundreds of them. Kept as base64
   inside the data blob they cost ~33% for the encoding plus 2 bytes per
   character in Safari's UTF-16 localStorage, and in cloud mode the whole blob
   - photos and all - is rewritten on every save. Here they are plain Blobs in
   IndexedDB: no encoding tax, far more room, and the synced blob stays small.
   The trade, stated in the UI: these images live on THIS device. The parchi
   entry itself (weight, party, slip no, date) still syncs normally.
   Every call degrades to false/null so a private window just falls back to
   the old inline photo. */
const IDB_NAME = "trackrakho", IDB_STORE = "photos";
let idbConn = null;
const idbOpen = () => {
  if (idbConn) return idbConn;
  idbConn = new Promise((res) => {
    try {
      if (!window.indexedDB) return res(null);
      const r = indexedDB.open(IDB_NAME, 1);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(IDB_STORE)) r.result.createObjectStore(IDB_STORE); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
      r.onblocked = () => res(null);
    } catch { res(null); }
  });
  return idbConn;
};
const idbRun = async (mode, fn) => {
  const db = await idbOpen();
  if (!db) return null;
  return new Promise((res) => {
    try {
      const tx = db.transaction(IDB_STORE, mode);
      const req = fn(tx.objectStore(IDB_STORE));
      tx.onabort = tx.onerror = () => res(null);
      tx.oncomplete = () => res(req ? req.result : true);
    } catch { res(null); }
  });
};
const photoPut = (key, blob) => idbRun("readwrite", (os) => os.put(blob, key));
const photoGet = (key) => idbRun("readonly", (os) => os.get(key));
const photoDel = (key) => idbRun("readwrite", (os) => os.delete(key));
const blobToDataUrl = (blob) => new Promise((res) => {
  try { const fr = new FileReader(); fr.onload = () => res(String(fr.result || "")); fr.onerror = () => res(""); fr.readAsDataURL(blob); }
  catch { res(""); }
});

/* WebP encodes the same picture ~30% smaller than JPEG. Safari only learned to
   ENCODE it in 16 - older phones fall back to JPEG, so this is asked once and
   never assumed. */
let WEBP_ENC = null;
const webpEncodes = () => {
  if (WEBP_ENC == null) {
    try {
      const c = document.createElement("canvas"); c.width = c.height = 1;
      WEBP_ENC = c.toDataURL("image/webp").indexOf("data:image/webp") === 0;
    } catch { WEBP_ENC = false; }
  }
  return WEBP_ENC;
};
/* opts.gray: for a kanta parchi - black print on white paper carries no colour
   information, and dropping it (plus a light contrast lift) shrinks the file a
   long way further while the digits stay crisp. */
const downscaleImage = (file, max = 820, quality = 0.6, opts = {}) => new Promise((resolve) => {
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
      const cx = cv.getContext("2d");
      if (opts.gray && "filter" in cx) {
        cx.filter = "grayscale(1) contrast(1.08)";
        cx.drawImage(img, 0, 0, w, h);
        cx.filter = "none";
      } else {
        cx.drawImage(img, 0, 0, w, h);
        /* older Safari has no canvas filter - do the luminance pass by hand */
        if (opts.gray) {
          try {
            const d = cx.getImageData(0, 0, w, h);
            const px = d.data;
            for (let i = 0; i < px.length; i += 4) {
              const g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
              px[i] = px[i + 1] = px[i + 2] = g;
            }
            cx.putImageData(d, 0, 0);
          } catch {}
        }
      }
      const type = webpEncodes() ? "image/webp" : "image/jpeg";
      if (opts.blob) cv.toBlob((b2) => resolve(b2 || null), type, quality);
      else resolve(cv.toDataURL(type, quality));
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
  /* WHICH action is running, not merely "something is": one shared boolean
     made the Google button say "Opening Google..." while the phone code was
     being sent. "" | "code" | "verify" | "google" */
  const [busy, setBusy] = useState("");
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
  /* Supabase issues 6-digit codes; the on-device demo keeps its old 4 */
  const [otp, setOtp] = useState(() => Array(sb ? 6 : 4).fill(""));
  const [uname, setUname] = useState("");
  const [pass, setPass] = useState("");
  const [err, setErr] = useState("");
  const otpRefs = useRef([]);
  /* resend cooldown - Supabase refuses a second code inside 60s anyway, and
     every send costs real money, so do not let the button invite it */
  const [cool, setCool] = useState(0);
  useEffect(() => {
    if (cool <= 0) return;
    const t = setTimeout(() => setCool((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cool]);
  const OTP_LEN = sb ? 6 : 4;
  const blankOtp = () => Array(OTP_LEN).fill("");

  /* shared by both modes - one box per digit, auto-advance and backspace */
  const onOtpChange = (i, v) => {
    if (!/^\d?$/.test(v)) return;
    const next = [...otp]; next[i] = v; setOtp(next);
    if (v && i < OTP_LEN - 1) otpRefs.current[i + 1]?.focus();
  };
  const onOtpKey = (i, e) => { if (e.key === "Backspace" && !otp[i] && i > 0) otpRefs.current[i - 1]?.focus(); };
  /* let the whole code be pasted into the first box (WhatsApp copy button) */
  const onOtpPaste = (e) => {
    const t = (e.clipboardData && e.clipboardData.getData("text") || "").replace(/\D/g, "").slice(0, OTP_LEN);
    if (!t) return;
    e.preventDefault();
    const next = blankOtp(); t.split("").forEach((d, i) => { next[i] = d; });
    setOtp(next);
    otpRefs.current[Math.min(t.length, OTP_LEN - 1)]?.focus();
  };

  /* cloud mode: phone is the main way in (a shop owner remembers his number, not
     which Gmail he used); Google stays as the second door. Both land on the SAME
     account once linked - see the "Login ke tareeke" card in Setup.
     This return sits BELOW every hook declaration, so hook order stays constant. */
  if (sb) {
    const e164 = () => "+91" + phone.replace(/\D/g, "");
    /* Supabase speaks English error strings; say something a shop owner can act on */
    const say = (e) => {
      const raw = String((e && e.message) || "").trim();
      const m = raw.toLowerCase();
      if (/rate|too many|60 seconds|security purposes/.test(m)) return tx("Too many attempts. Wait a minute and try again.", "Bahut baar try kiya. Ek minute ruk kar dobara karein.", "\u092C\u0939\u0941\u0924 \u092C\u093E\u0930 \u0915\u094B\u0936\u093F\u0936 \u0939\u0941\u0908\u0964 \u090F\u0915 \u092E\u093F\u0928\u091F \u092C\u093E\u0926 \u0926\u094B\u092C\u093E\u0930\u093E \u0915\u0930\u0947\u0902\u0964");
      if (/expired|invalid|incorrect|token/.test(m)) return tx("That code is wrong or has expired. Ask for a new one.", "Code galat hai ya purana ho gaya. Naya code mangwaein.", "\u092F\u0939 \u0915\u094B\u0921 \u0917\u0932\u0924 \u092F\u093E \u092A\u0941\u0930\u093E\u0928\u093E \u0939\u0948\u0964 \u0928\u092F\u093E \u0915\u094B\u0921 \u092E\u0902\u0917\u0935\u093E\u090F\u0902\u0964");
      if (/whatsapp|send|hook|template|delivery|sms/.test(m)) return tx("Could not send the code. Use Google instead, or check the number.", "Code nahi bhej paye. Google se login karein, ya number check karein.", "\u0915\u094B\u0921 \u0928\u0939\u0940\u0902 \u092D\u0947\u091C \u092A\u093E\u090F\u0964 Google \u0938\u0947 \u0932\u0949\u0917\u093F\u0928 \u0915\u0930\u0947\u0902\u0964");
      /* When the SMS hook fails Supabase can surface a bare "{}" or a raw JSON
         body. A shop owner can do nothing with that, so anything that is not a
         readable sentence becomes plain words instead. */
      const readable = raw.length >= 8 && /\s/.test(raw) && !/^[[{<]/.test(raw);
      return readable ? raw : tx("Could not send the code right now. Please use Google, or try again in a minute.", "Abhi code nahi bhej paye. Google se login karein, ya thodi der baad try karein.", "\u0905\u092D\u0940 \u0915\u094B\u0921 \u0928\u0939\u0940\u0902 \u092D\u0947\u091C \u092A\u093E\u090F\u0964 Google \u0938\u0947 \u0932\u0949\u0917\u093F\u0928 \u0915\u0930\u0947\u0902, \u092F\u093E \u0925\u094B\u0921\u093C\u0940 \u0926\u0947\u0930 \u092C\u093E\u0926 \u0915\u094B\u0936\u093F\u0936 \u0915\u0930\u0947\u0902\u0964");
    };
    const sendCode = async () => {
      if (phone.replace(/\D/g, "").length !== 10) {
        setErr(tx("Enter a valid 10-digit number", "Poora 10 digit ka number daalein", "\u092A\u0942\u0930\u093E 10 \u0905\u0902\u0915\u094B\u0902 \u0915\u093E \u0928\u0902\u092C\u0930 \u0921\u093E\u0932\u0947\u0902")); return;
      }
      setErr(""); setBusy("code");
      const { error } = await sb.auth.signInWithOtp({ phone: e164() });
      setBusy("");
      if (error) { setErr(say(error)); return; }
      setOtp(blankOtp()); setStage("code"); setCool(45);
      setTimeout(() => otpRefs.current[0]?.focus(), 100);
    };
    const verifyCode = async () => {
      const code = otp.join("");
      if (code.length < OTP_LEN) {
        setErr(tx("Enter the 6-digit code", "6 digit ka code daalein", "6 \u0905\u0902\u0915\u094B\u0902 \u0915\u093E \u0915\u094B\u0921 \u0921\u093E\u0932\u0947\u0902")); return;
      }
      setErr(""); setBusy("verify");
      const { error } = await sb.auth.verifyOtp({ phone: e164(), token: code, type: "sms" });
      setBusy("");
      /* on success onAuthStateChange takes over and the app opens itself */
      if (error) setErr(say(error));
    };
    const google = async () => {
      setBusy("google");
      try { await sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: window.location.origin } }); }
      catch { setBusy(""); }
    };
    return (
      <div className="auth">
        <div className="auth-top">
          <div className="auth-logo">TR</div>
          {/* NOT var(--grn): that is #228B22, the exact middle stop of this header's
    own gradient, so "Rakho" was invisible and the wordmark read "Track" */}
<h1>Track<span style={{ color: "#B9F2BE" }}>Rakho</span></h1>
          <p>{tx("Your whole business, in your pocket.", "Aapka poora business, aapki jeb mein.", "\u0906\u092A\u0915\u093E \u092A\u0942\u0930\u093E \u092C\u093F\u095B\u0928\u0947\u0938, \u0906\u092A\u0915\u0940 \u091C\u0947\u092C \u092E\u0947\u0902\u0964")}</p>
        </div>
        <div className="auth-body">
          {stage === "enter" ? (
            <div className="anim-in">
              <label className="lbl">{tx("Your mobile number", "Aapka mobile number", "\u0906\u092A\u0915\u093E \u092E\u094B\u092C\u093E\u0907\u0932 \u0928\u0902\u092C\u0930")}</label>
              {/* deliberately does NOT name the channel - the backend sends by
                  SMS or WhatsApp depending on OTP_CHANNEL, and the copy must
                  stay true whichever one carries it */}
              <span className="hint">{tx("We will send a 6-digit code to this number.", "Is number par 6 digit ka code aayega.", "\u0907\u0938 \u0928\u0902\u092C\u0930 \u092A\u0930 6 \u0905\u0902\u0915\u094B\u0902 \u0915\u093E \u0915\u094B\u0921 \u0906\u090F\u0917\u093E\u0964")}</span>
              <div className="phone-field">
                <span className="cc">+91</span>
                <input type="tel" inputMode="numeric" autoComplete="tel" placeholder="98xxxxxxxx" value={phone}
                  onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 10))}
                  onKeyDown={(e) => { if (e.key === "Enter") sendCode(); }} />
              </div>
              {err && <div style={{ color: "var(--red)", fontSize: 13, marginTop: 10 }}>{err}</div>}
              <button className="btn btn-grn press" style={{ width: "100%", marginTop: 18 }} onClick={sendCode} disabled={busy}>
                <I.phone2 /> {busy === "code" ? tx("Sending...", "Sending...", "\u092D\u0947\u091C \u0930\u0939\u0947 \u0939\u0948\u0902...") : tx("Send code", "Send code", "\u0915\u094B\u0921 \u092D\u0947\u091C\u0947\u0902")}
              </button>

              <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "18px 0 14px" }}>
                <i style={{ flex: 1, height: 1, background: "var(--line2)" }} />
                <span style={{ fontSize: 12, color: "var(--faint)" }}>{tx("or", "ya", "\u092F\u093E")}</span>
                <i style={{ flex: 1, height: 1, background: "var(--line2)" }} />
              </div>
              <button className="btn btn-ghost press" style={{ width: "100%", gap: 12 }} onClick={google} disabled={busy}>
                <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.7 1.22 9.19 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
                {busy === "google" ? "Opening Google..." : "Continue with Google"}
              </button>
              <div className="auth-note">{tx("Already used Google here? Sign in with Google once, then add your number in Setup - both will open the same account.", "Pehle Google se aate the? Ek baar Google se aayein, phir Setup mein apna number jodein - dono se wahi account khulega.", "\u092A\u0939\u0932\u0947 Google \u0938\u0947 \u0906\u0924\u0947 \u0925\u0947? \u090F\u0915 \u092C\u093E\u0930 Google \u0938\u0947 \u0906\u090F\u0902, \u092B\u093F\u0930 Setup \u092E\u0947\u0902 \u0905\u092A\u0928\u093E \u0928\u0902\u092C\u0930 \u091C\u094B\u0921\u093C\u0947\u0902 - \u0926\u094B\u0928\u094B\u0902 \u0938\u0947 \u0935\u0939\u0940 \u0905\u0915\u093E\u0909\u0902\u091F \u0916\u0941\u0932\u0947\u0917\u093E\u0964")}</div>
            </div>
          ) : (
            <div className="anim-in">
              <label className="lbl">{tx("Enter the code", "Code daalein", "\u0915\u094B\u0921 \u0921\u093E\u0932\u0947\u0902")}</label>
              <span className="hint">
                {tx("Sent to", "Bheja hai", "\u092D\u0947\u091C\u093E \u0939\u0948")} +91 {phone}.{" "}
                <button onClick={() => { setStage("enter"); setOtp(blankOtp()); setErr(""); }} style={{ border: "none", background: "none", color: "var(--grn-d)", fontWeight: 600, cursor: "pointer", fontSize: 12.5 }}>{tx("Change", "Badlein", "\u092C\u0926\u0932\u0947\u0902")}</button>
              </span>
              <div className="otp-row">
                {otp.map((d, i) => (
                  <input key={i} ref={(el) => (otpRefs.current[i] = el)} inputMode="numeric" autoComplete="one-time-code" maxLength={1} value={d}
                    onChange={(e) => onOtpChange(i, e.target.value)} onKeyDown={(e) => onOtpKey(i, e)} onPaste={onOtpPaste} />
                ))}
              </div>
              {err && <div style={{ color: "var(--red)", fontSize: 13, marginTop: 10 }}>{err}</div>}
              <button className="btn btn-grn press" style={{ width: "100%", marginTop: 18 }} onClick={verifyCode} disabled={busy}>
                <I.lock /> {busy === "verify" ? tx("Checking...", "Checking...", "\u091C\u093E\u0901\u091A \u0930\u0939\u0947 \u0939\u0948\u0902...") : tx("Verify & continue", "Verify karein", "\u0935\u0947\u0930\u093F\u092B\u093E\u0908 \u0915\u0930\u0947\u0902")}
              </button>
              <div className="auth-note">
                {cool > 0
                  ? tx("Resend in ", "Resend in ", "\u0926\u094B\u092C\u093E\u0930\u093E \u092D\u0947\u091C\u0947\u0902 ") + "0:" + String(cool).padStart(2, "0")
                  : <button onClick={sendCode} disabled={busy} style={{ border: "none", background: "none", color: "var(--grn-d)", fontWeight: 700, cursor: "pointer", fontSize: 13 }}>{tx("Send code again", "Send code again", "\u0915\u094B\u0921 \u0926\u094B\u092C\u093E\u0930\u093E \u092D\u0947\u091C\u0947\u0902")}</button>}
              </div>
            </div>
          )}

          {(authError || authErr) && <div style={{ marginTop: 14, padding: "11px 13px", borderRadius: 12, background: "var(--red-bg)", color: "var(--red)", fontSize: 13, lineHeight: 1.5 }}>Login error: {authError || authErr}</div>}
          <div style={{ marginTop: 12, display: "flex", gap: 9, alignItems: "flex-start", fontSize: 12.5, color: "var(--dim)", lineHeight: 1.55, background: "var(--grn-100)", borderRadius: 12, padding: "10px 12px" }}>
            <span aria-hidden="true">&#128274;</span>
            <span>{tx("Data safety is our top priority. Your quotes, rates and customers stay inside your shop's own account - no other shop can ever see them.", "Data safety hamari pehli priority hai. Aapke quotes, rate aur customer sirf aapki shop ke account mein rehte hain - kisi aur shop ko kabhi nahi dikhte.", "\u0921\u0947\u091F\u093E \u0915\u0940 \u0938\u0941\u0930\u0915\u094D\u0937\u093E \u0939\u092E\u093E\u0930\u0940 \u092A\u0939\u0932\u0940 \u092A\u094D\u0930\u093E\u0925\u092E\u093F\u0915\u0924\u093E \u0939\u0948\u0964 \u0906\u092A\u0915\u0947 \u0915\u094B\u091F\u0947\u0936\u0928, \u0930\u0947\u091F \u0914\u0930 \u0917\u094D\u0930\u093E\u0939\u0915 \u0938\u093F\u0930\u094D\u092B \u0906\u092A\u0915\u0940 \u0926\u0941\u0915\u093E\u0928 \u0915\u0947 \u0905\u0915\u093E\u0909\u0902\u091F \u092E\u0947\u0902 \u0930\u0939\u0924\u0947 \u0939\u0948\u0902 - \u0915\u093F\u0938\u0940 \u0914\u0930 \u0926\u0941\u0915\u093E\u0928 \u0915\u094B \u0915\u092D\u0940 \u0928\u0939\u0940\u0902 \u0926\u093F\u0916\u0924\u0947\u0964")}</span>
          </div>
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
  const verifyOtp = () => {
    if (otp.join("").length < OTP_LEN) { setErr("Enter the " + OTP_LEN + "-digit code"); return; }
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
        <div className="auth-logo">TR</div>
        {/* NOT var(--grn): that is #228B22, the exact middle stop of this header's
    own gradient, so "Rakho" was invisible and the wordmark read "Track" */}
<h1>Track<span style={{ color: "#B9F2BE" }}>Rakho</span></h1>
        <p>{tx("Your whole business, in your pocket.", "Aapka poora business, aapki jeb mein.", "\u0906\u092A\u0915\u093E \u092A\u0942\u0930\u093E \u092C\u093F\u095B\u0928\u0947\u0938, \u0906\u092A\u0915\u0940 \u091C\u0947\u092C \u092E\u0947\u0902\u0964")}</p>
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
            <div style={{ marginTop: 12, display: "flex", gap: 9, alignItems: "flex-start", fontSize: 12.5, color: "var(--dim)", lineHeight: 1.55, background: "var(--grn-100)", borderRadius: 12, padding: "10px 12px" }}>
              <span aria-hidden="true">&#128274;</span>
              <span>{tx("Data safety is our top priority. In this version everything stays on this phone - your quotes and rates never leave your device.", "Data safety hamari pehli priority hai. Is version mein sab kuch isi phone par rehta hai - aapke quotes aur rate device se bahar nahi jaate.", "\u0921\u0947\u091F\u093E \u0915\u0940 \u0938\u0941\u0930\u0915\u094D\u0937\u093E \u0939\u092E\u093E\u0930\u0940 \u092A\u0939\u0932\u0940 \u092A\u094D\u0930\u093E\u0925\u092E\u093F\u0915\u0924\u093E \u0939\u0948\u0964 \u0938\u092C \u0915\u0941\u091B \u0907\u0938\u0940 \u092B\u093C\u094B\u0928 \u092A\u0930 \u0930\u0939\u0924\u093E \u0939\u0948\u0964")}</span>
            </div>
          </div>
        )}

        {mode === "otp" && stage === "code" && (
          <div className="anim-in">
            <label className="lbl">Enter the code</label>
            <span className="hint">Sent to +91 {phone}. <button onClick={() => { setStage("enter"); setOtp(blankOtp()); setErr(""); }} style={{ border: "none", background: "none", color: "var(--grn-d)", fontWeight: 600, cursor: "pointer", fontSize: 12.5 }}>Change</button></span>
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
        <div><div className="microlbl">{tx("PRICING", "PRICING", "कीमत")}</div><div className="h-disp" style={{ fontSize: 23, fontWeight: 700 }}>{tx("One plan. Everything.", "One plan. Sab kuch.", "एक प्लान। सब कुछ।")}</div></div>
      </div>
      <p style={{ fontSize: 14, color: "var(--dim)", marginBottom: 22, lineHeight: 1.6 }}>
        {tx("One missed follow-up costs more than a year of TrackRakho. No tiers, no add-ons - every feature, one plan. GST extra.", "One missed follow-up costs more than a year of TrackRakho. No tiers, no add-ons - har feature, ek plan. GST extra.", "एक भूला फॉलो-अप TrackRakho के पूरे साल से महंगा पड़ता है। न टियर, न ऐड-ऑन - हर फीचर, एक प्लान। GST अलग।")}
      </p>

      {PLANS.map((pl) => (
        <div key={pl.id} className={"plan " + (pl.popular ? "pop" : "")}>
          {pl.popular && <span className="badge"><I.star /> MOST POPULAR</span>}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div><div className="pname">{pl.name}</div><div className="ptag">{tx("One plan - everything included", pl.tagline, "एक प्लान - सब कुछ शामिल")}</div></div>
            {current === pl.id && <span className="plan-current">CURRENT</span>}
          </div>
          <div className="prow"><span className="pcur">₹</span><span className="pamt">{pl.price.toLocaleString("en-IN")}</span><span className="pper">/ month</span></div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--faint)" }}>≈ ₹{(pl.price * 12).toLocaleString("en-IN")} / year</div>
          <ul>
            {pl.features.map((f, i) => (<li key={i}><span className="ci"><I.check2 /></span>{f}</li>))}
          </ul>
          <button className={"btn press " + (pl.popular ? "btn-grn" : "btn-ghost")} style={{ width: "100%" }}
            onClick={() => onSubscribe(pl.id)} disabled={current === pl.id}>
            {current === pl.id ? tx("Your current plan", "Your current plan", "आपका मौजूदा प्लान") : <>{tx("Start - ", "Start - ", "शुरू करें - ")}₹{pl.price.toLocaleString("en-IN")}{tx("/month", "/month", "/माह")}</>}
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
/* A greyed ghost of the page once it has data. Deliberately shows no numbers
   and no names - an empty screen should teach the layout, not invent a shop. */
function GhostPreview({ rows = 2, caption, tile = true }) {
  return (
    <div style={{ marginTop: 6 }}>
      {caption && (
        <div className="mono" style={{ fontSize: 10.5, letterSpacing: ".1em", color: "var(--faint)", textAlign: "center", margin: "0 0 10px" }}>
          {caption}
        </div>
      )}
      <div aria-hidden="true" style={{ opacity: .9, pointerEvents: "none" }}>
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="ghost-card" style={{ opacity: 1 - i * 0.28 }}>
            {tile && <span className="ghost" style={{ width: 52, height: 52, borderRadius: 14, flexShrink: 0 }} />}
            <span style={{ flex: 1, minWidth: 0 }}>
              <span className="ghost" style={{ display: "block", height: 12, width: "58%", marginBottom: 8 }} />
              <span className="ghost" style={{ display: "block", height: 10, width: "80%" }} />
            </span>
            <span style={{ textAlign: "right", flexShrink: 0 }}>
              <span className="ghost" style={{ display: "block", height: 13, width: 62, marginBottom: 8 }} />
              <span className="ghost" style={{ display: "block", height: 10, width: 40, marginLeft: "auto" }} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ================= WELCOME (first run) =================
   Two questions, in this order: what do you do, and what is your shop called.
   The name matters more than it looks - until it was asked, every new account
   opened on somebody else's business name with somebody else's quotes in it.
   The demo pipeline is offered here as a clearly-labelled choice, never as
   the default. */
function IndustryPicker({ onPick }) {
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const ind = key ? INDUSTRIES[key] : null;

  if (!key) return (
    <div className="qk-root"><style>{CSS}</style>
      <div className="app"><div className="scr"><div className="pagepad" style={{ paddingTop: 44 }}>
        <div className="microlbl">WELCOME</div>
        <div className="h-disp" style={{ fontSize: 27, fontWeight: 700, margin: "4px 0 6px" }}>{tx("What do you make?", "Aap kya kaam karte hain?", "आप क्या काम करते हैं?")}</div>
        <div style={{ color: "var(--dim)", fontSize: 15, marginBottom: 22, lineHeight: 1.55 }}>{tx("Pick your trade so the app speaks your language. You can change it anytime in Setup.", "Apna kaam chuniye taaki app aapki bhasha bole. Setup mein kabhi bhi badal sakte hain.", "अपना काम चुनें ताकि ऐप आपकी भाषा बोले।")}</div>
        {LIVE_TRADES.map((k) => INDUSTRIES[k]).map((x, i) => (
          <button key={x.key} className={"card press anim-in st" + (i + 1)} onClick={() => setKey(x.key)}
            style={{ display: "flex", alignItems: "center", gap: 15, width: "100%", textAlign: "left", padding: "18px 16px", marginBottom: 12, border: "1.5px solid var(--line2)", background: "#fff", cursor: "pointer" }}>
            <span style={{ width: 52, height: 52, borderRadius: 15, background: "var(--grn-100)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 27, flexShrink: 0 }}>{x.emoji}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", fontWeight: 700, fontSize: 17 }}>{x.label}</span>
              <span style={{ display: "block", fontSize: 13, color: "var(--dim)", marginTop: 2 }}>{x.tag}</span>
            </span>
            <I.chev style={{ color: "var(--faint)" }} />
          </button>
        ))}
      </div></div></div>
    </div>
  );

  return (
    <div className="qk-root"><style>{CSS}</style>
      <div className="app"><div className="scr"><div className="pagepad" style={{ paddingTop: 44 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
          <button className="iconbtn press" onClick={() => setKey("")}><I.back /></button>
          <div>
            <div className="microlbl">{ind.emoji} {ind.label}</div>
            <div className="h-disp" style={{ fontSize: 25, fontWeight: 700 }}>{tx("Your shop's name?", "Aapki shop ka naam?", "आपकी दुकान का नाम?")}</div>
          </div>
        </div>
        <input className="input" autoFocus placeholder={tx("e.g. Sharma Precision Works", "jaise Sharma Precision Works", "जैसे शर्मा प्रिसिजन वर्क्स")}
          value={name} onChange={(e) => setName(e.target.value)} style={{ fontSize: 17 }} />
        <span className="hint">{tx("It goes on your quotations and PDFs. Change it anytime in Setup.", "Ye aapke quotation aur PDF par chhapta hai. Setup mein kabhi bhi badal sakte hain.", "यह आपके कोटेशन और PDF पर छपता है।")}</span>

        <button className="btn btn-grn press" style={{ width: "100%", marginTop: 20, padding: 16 }}
          disabled={!name.trim()} onClick={() => onPick(key, { name: name.trim(), demo: false })}>
          {tx("Start", "Shuru karein", "शुरू करें")}
        </button>

        <div className="card" style={{ padding: 16, marginTop: 24, background: "var(--soft)" }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{tx("Just looking around?", "Pehle dekhna chahte hain?", "पहले देखना चाहते हैं?")}</div>
          <div style={{ fontSize: 13.5, color: "var(--dim)", lineHeight: 1.55, margin: "4px 0 12px" }}>
            {tx("Fill the app with example quotes so you can see how it works. Every example is marked SAMPLE and removed with one tap.",
                "App ko example quotes se bhar dein taaki aap dekh sakein ye kaam kaise karta hai. Har example par SAMPLE likha hoga aur ek tap mein hat jayega.",
                "उदाहरण कोटेशन भर दें ताकि आप देख सकें। हर उदाहरण पर SAMPLE लिखा होगा और एक टैप में हट जाएगा।")}
          </div>
          <button className="btn btn-ghost press" style={{ width: "100%" }} onClick={() => onPick(key, { name: name.trim(), demo: true })}>
            {tx("Show me example data", "Example data dikhaiye", "उदाहरण दिखाएं")}
          </button>
        </div>
      </div></div></div>
    </div>
  );
}


/* ================= GUIDED TUTORIALS ================= */
/* Pipedrive-style coach marks: a dark card anchored to a [data-tut] element
   with a spotlight cutout around it. Steps may auto-advance when the user
   actually performs the action (adv: "tab:x", watched in App). Strings are
   [en, hinglish, hindi] triplets rendered through tx() at display time. */
const TUTS = {
  walog: {
    name: ["Quote from WhatsApp - automatic", "WhatsApp se quote - apne aap", "\u0935\u094D\u0939\u093E\u091F\u094D\u0938\u090F\u092A \u0938\u0947 \u0915\u094B\u091F\u0947\u0936\u0928 - \u0905\u092A\u0928\u0947 \u0906\u092A"],
    steps: [
      { go: "quotes", target: "enq-card",
        t: ["A customer message just arrived", "Customer ka message aaya hai", "\u0917\u094D\u0930\u093E\u0939\u0915 \u0915\u093E \u092E\u0948\u0938\u0947\u091C \u0906\u092F\u093E \u0939\u0948"],
        b: ["This is a demo WhatsApp enquiry - real ones will appear exactly here once your WhatsApp is connected. Read it once, then Next.",
            "Ye demo WhatsApp enquiry hai - WhatsApp connect hone par asli enquiries bilkul aise hi yahan aayengi. Ek baar padho, phir Next.",
            "\u092F\u0939 \u0921\u0947\u092E\u094B \u0935\u094D\u0939\u093E\u091F\u094D\u0938\u090F\u092A \u092E\u0948\u0938\u0947\u091C \u0939\u0948 - \u0905\u0938\u0932\u0940 \u092D\u0940 \u0910\u0938\u0947 \u0939\u0940 \u092F\u0939\u093E\u0902 \u0906\u090F\u0902\u0917\u0940\u0964"] },
      { target: "enq-log", adv: "quote+",
        t: ["Now tap 'Log as quote'", "Ab 'Log as quote' dabao", "\u0905\u092C 'Log as quote' \u0926\u092C\u093E\u090F\u0902"],
        b: ["Watch what happens.", "Aur dekhte raho - jaadu hota hai.", "\u0914\u0930 \u0926\u0947\u0916\u0924\u0947 \u0930\u0939\u0947\u0902\u0964"] },
      { target: ["pipe-first", "pipe-list"],
        t: ["Look - everything filled itself", "Dekho - sab apne aap bhar gaya", "\u0926\u0947\u0916\u094B - \u0938\u092C \u0905\u092A\u0928\u0947 \u0906\u092A \u092D\u0930 \u0917\u092F\u093E"],
        b: ["Customer, part, 500 pcs, rate 61.20, total Rs 30,600 - even the 15 August follow-up. All read from the message. Open the new card and check.",
            "Customer, part, 500 pcs, rate 61.20, total Rs 30,600 - 15 August ka follow-up bhi. Sab message se khud bhar gaya. Naya card khol kar dekho.",
            "\u0915\u0938\u094D\u091F\u092E\u0930, \u092A\u093E\u0930\u094D\u091F, 500 pcs, \u0930\u0947\u091F 61.20 - \u0938\u092C \u092E\u0948\u0938\u0947\u091C \u0938\u0947 \u0916\u0941\u0926 \u092D\u0930 \u0917\u092F\u093E\u0964"] },
      { t: ["Do this with any message", "Ab kisi bhi message ke saath", "\u0915\u093F\u0938\u0940 \u092D\u0940 \u092E\u0948\u0938\u0947\u091C \u0915\u0947 \u0938\u093E\u0925"],
        b: ["Copy any customer message, tap +, use the Paste box - same magic. This demo quote stays for practice; open its card and delete it anytime.",
            "Koi bhi customer message copy karo, + dabao, Paste box mein daalo - wahi jaadu. Ye demo quote practice ke liye hai - card khol kar kabhi bhi delete kar do.",
            "\u0915\u094B\u0908 \u092D\u0940 \u092E\u0948\u0938\u0947\u091C \u0915\u0949\u092A\u0940 \u0915\u0930\u0947\u0902, + \u0926\u092C\u093E\u090F\u0902, \u092A\u0947\u0938\u094D\u091F \u092C\u0949\u0915\u094D\u0938 \u092E\u0947\u0902 \u0921\u093E\u0932\u0947\u0902 - \u0935\u0939\u0940 \u091C\u093E\u0926\u0942\u0964"] },
    ],
  },
  pipeline: {
    name: ["Pipeline & follow-ups", "Pipeline aur follow-ups", "\u092A\u093E\u0907\u092A\u0932\u093E\u0907\u0928 \u0914\u0930 \u092B\u0949\u0932\u094B-\u0905\u092A"],
    steps: [
      { go: "quotes",
        t: ["Your pipeline", "Aapki pipeline", "\u0906\u092A\u0915\u0940 \u092A\u093E\u0907\u092A\u0932\u093E\u0907\u0928"],
        b: ["Every quote lives here with its status - pending, won or lost. This is where stuck money becomes visible.",
            "Har quote yahan hai apne status ke saath - pending, won ya lost. Atka paisa yahin dikhta hai.",
            "\u0939\u0930 \u0915\u094B\u091F\u0947\u0936\u0928 \u092F\u0939\u093E\u0902 \u0939\u0948 \u0905\u092A\u0928\u0947 \u0938\u094D\u091F\u0947\u091F\u0938 \u0915\u0947 \u0938\u093E\u0925\u0964"] },
      { target: "pipe-filters",
        t: ["Filter with one tap", "Ek tap mein filter", "\u090F\u0915 \u091F\u0948\u092A \u092E\u0947\u0902 \u092B\u093C\u093F\u0932\u094D\u091F\u0930"],
        b: ["Pending shows whose answer is due. Follow-ups shows whom to chase TODAY - start your morning here.",
            "Pending mein jinka jawab aana hai. Follow-ups mein AAJ kisko chase karna hai - subah yahin se shuru karo.",
            "\u092A\u0947\u0902\u0921\u093F\u0902\u0917 \u092E\u0947\u0902 \u091C\u093F\u0928\u0915\u093E \u091C\u0935\u093E\u092C \u0906\u0928\u093E \u0939\u0948\u0964 \u092B\u0949\u0932\u094B-\u0905\u092A \u092E\u0947\u0902 \u0906\u091C \u0915\u093F\u0938\u0947 \u092B\u094B\u0928 \u0915\u0930\u0928\u093E \u0939\u0948\u0964"] },
      { target: ["pipe-first", "pipe-list"],
        t: ["Open any quote card", "Koi bhi quote kholo", "\u0915\u094B\u0908 \u092D\u0940 \u0915\u094B\u091F\u0947\u0936\u0928 \u0916\u094B\u0932\u0947\u0902"],
        b: ["Tap a card below: Mark Won / Lost, set the follow-up date, add a photo, or chase on WhatsApp - one tap each.",
            "Neeche kisi card par tap karo: Mark Won/Lost, follow-up date, photo, ya WhatsApp par chase - sab ek tap.",
            "\u0928\u0940\u091A\u0947 \u0915\u093F\u0938\u0940 \u0915\u093E\u0930\u094D\u0921 \u092A\u0930 \u091F\u0948\u092A \u0915\u0930\u0947\u0902 - \u0938\u092C \u090F\u0915 \u091F\u0948\u092A \u092E\u0947\u0902\u0964"] },
      { t: ["The daily habit", "Roz ki aadat", "\u0930\u094B\u091C\u093C \u0915\u0940 \u0906\u0926\u0924"],
        b: ["One minute every morning: open Follow-ups, chase whoever is due. A forgotten quote is a lost order.",
            "Roz subah ek minute: Follow-ups kholo, jiska din hai usko chase karo. Bhoola quote = gaya order.",
            "\u0930\u094B\u091C\u093C \u0938\u0941\u092C\u0939 \u090F\u0915 \u092E\u093F\u0928\u091F: \u092B\u0949\u0932\u094B-\u0905\u092A \u0916\u094B\u0932\u0947\u0902\u0964 \u092D\u0942\u0932\u093E \u0915\u094B\u091F\u0947\u0936\u0928 = \u0917\u092F\u093E \u0911\u0930\u094D\u0921\u0930\u0964"] },
    ],
  },
  fullquote: {
    name: ["Send a full quotation", "Poora quotation bhejna", "\u092A\u0942\u0930\u093E \u0915\u094B\u091F\u0947\u0936\u0928 \u092D\u0947\u091C\u0928\u093E"],
    mach: true,
    steps: [
      { t: ["A ready sample - watch the money math", "Sample taiyaar hai - paisa banta dekho", "\u0938\u0948\u0902\u092A\u0932 \u0924\u0948\u092F\u093E\u0930 \u0939\u0948"],
        b: ["We filled a real job for you: Gland Nut, 200 pcs, Apex Hydraulics. Tap Next through each screen and watch Costing - material + machine time + labour + overhead + margin = Rs 174.39/pc. At Review you get the PDF and a ready WhatsApp message. It's a demo - save it or leave it.",
            "Ek asli job bhar di hai: Gland Nut, 200 pcs, Apex Hydraulics. Har screen par Next dabate jao aur Costing dekho - material + machine + labour + overhead + margin = Rs 174.39/pc. Review par PDF aur ready WhatsApp message milega. Demo hai - save karo ya chhod do.",
            "\u090F\u0915 \u0905\u0938\u0932\u0940 \u091C\u0949\u092C \u092D\u0930 \u0926\u0940 \u0939\u0948: Gland Nut, 200 pcs\u0964 \u0939\u0930 \u0938\u094D\u0915\u094D\u0930\u0940\u0928 \u092A\u0930 Next \u0926\u092C\u093E\u0924\u0947 \u091C\u093E\u090F\u0902 - Rs 174.39/pc \u092C\u0928\u0924\u093E \u0926\u0947\u0916\u0947\u0902\u0964"] },
    ],
  },
};

function TutOverlay({ flow, step, tick, onNext, onBack, onClose }) {
  const st = TUTS[flow].steps[step];
  const [rect, setRect] = useState(null);
  useEffect(() => {
    let alive = true;
    setRect(null);
    if (!st || !st.target) return;
    const targets = [].concat(st.target);
    const findEl = () => { for (const k of targets) { const el = document.querySelector('[data-tut="' + k + '"]'); if (el) return el; } return null; };
    const measure = () => {
      const el = findEl();
      if (el && alive) setRect(el.getBoundingClientRect());
    };
    const t0 = setTimeout(() => {
      const el = findEl();
      if (!el) return;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      setTimeout(() => { if (alive) measure(); }, 380);
    }, 80); /* let the target tab render first */
    window.addEventListener("resize", measure);
    return () => { alive = false; clearTimeout(t0); window.removeEventListener("resize", measure); };
  }, [flow, step, tick]); /* eslint-disable-line */
  if (!st) return null;
  const total = TUTS[flow].steps.length;
  const vw = window.innerWidth, vh = window.innerHeight;
  const cardW = Math.min(340, vw - 32);
  let cardStyle;
  if (rect) {
    const left = Math.max(16, Math.min(rect.left + rect.width / 2 - cardW / 2, vw - 16 - cardW));
    cardStyle = rect.bottom < vh * 0.55 ? { top: rect.bottom + 14, left } : { bottom: vh - rect.top + 14, left };
  } else {
    cardStyle = { top: "50%", left: "50%", transform: "translate(-50%,-50%)" };
  }
  return (
    <>
      {rect
        ? <div key="tut-cut" style={{ position: "fixed", zIndex: 400, left: rect.left - 6, top: rect.top - 6, width: rect.width + 12, height: rect.height + 12, borderRadius: 18, boxShadow: "0 0 0 9999px rgba(10,16,11,.55)", pointerEvents: "none", transition: "left .25s, top .25s, width .25s, height .25s" }} />
        : <div key="tut-dim" style={{ position: "fixed", inset: 0, zIndex: 400, background: "rgba(10,16,11,.55)", pointerEvents: "none" }} />}
      <div style={{ position: "fixed", zIndex: 401, width: cardW, background: "#16201A", color: "#fff", borderRadius: 18, padding: "16px 16px 13px", boxShadow: "0 24px 60px -20px rgba(0,0,0,.55)", ...cardStyle }}>
        <button className="press" onClick={onClose} aria-label="Close tutorial" style={{ all: "unset", cursor: "pointer", position: "absolute", top: 10, right: 14, color: "rgba(255,255,255,.6)", fontSize: 19, lineHeight: 1, padding: 2 }}>&#215;</button>
        <div className="h-disp" style={{ fontSize: 15.5, fontWeight: 700, paddingRight: 24 }}>{tx(st.t[0], st.t[1], st.t[2])}</div>
        <div style={{ fontSize: 13.5, color: "rgba(255,255,255,.85)", lineHeight: 1.6, marginTop: 6 }}>{tx(st.b[0], st.b[1], st.b[2])}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 13 }}>
          <span className="mono" style={{ fontSize: 10.5, color: "rgba(255,255,255,.55)", flex: 1 }}>{step + 1} / {total}</span>
          {step > 0 && <button className="press" onClick={onBack} style={{ all: "unset", cursor: "pointer", fontSize: 13, fontWeight: 600, color: "rgba(255,255,255,.75)", padding: "7px 10px" }}>{tx("Back", "Back", "\u092A\u0940\u091B\u0947")}</button>}
          <button className="press" onClick={step + 1 >= total ? onClose : onNext} style={{ all: "unset", cursor: "pointer", fontSize: 13.5, fontWeight: 700, color: "#0F1A11", background: "#7CE383", borderRadius: 999, padding: "8px 18px" }}>{step + 1 >= total ? tx("Done", "Done", "\u0939\u094B \u0917\u092F\u093E") : tx("Next", "Next", "\u0906\u0917\u0947")}</button>
        </div>
      </div>
    </>
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
  const [floorDraft, setFloorDraft] = useState(null); /* quote -> machine floor prefill */
  const sendToFloor = (q) => { setFloorDraft({ part: q.part, customer: q.customer, qty: q.qty }); setTab("floor"); ping(tx("Quote sent to the Machine floor - pick machines", "Quote Machine floor par gaya - machines chuno", "कोटेशन मशीन फ्लोर पर गया - मशीनें चुनें")); };
  const [tut, setTut] = useState(null); /* guided tutorial: {flow, step} */
  const startTut = (flow, step = 0) => {
    const f = TUTS[flow]; if (!f) return;
    if (flow === "walog") {
      /* stage a demo enquiry so the user performs the REAL log-as-quote flow */
      const demoId = "demo_tut_enq";
      setEnquiries((list) => (list.some((x) => x.id === demoId) ? list : [{
        id: demoId, at: Date.now(), from: "9876501234", name: "Krishna Pumps", type: "text", demo: true,
        text: "Krishna Pumps se bol raha hu. 500 pcs Bush 42mm chahiye, EN8 material. Rate 61.20/pc final hai. 15 August tak delivery chahiye.",
      }, ...list]));
    }
    if (flow === "fullquote") {
      /* prefill the wizard with the settled Gland Nut sample (sums to Rs 174.39/pc) */
      setDraft({ customer: "Apex Hydraulics", phone: "", part: "Gland Nut - 60mm (demo)", qty: "200",
        materialId: (data.materials && data.materials[0] && data.materials[0].id) || "", rawKg: "0.6",
        machineId: (data.machines && data.machines[0] && data.machines[0].id) || "",
        cycleMin: "9", manualMin: "9.25", setupMin: "", toolingPc: 0,
        overheadPct: data.settings.overheadPct, marginPct: data.settings.marginPct });
      setStep(1); setDoneQuote(null); setTab("new");
    }
    const st = f.steps[step]; if (st && st.go) setTab(st.go); setFabOpen(false);
    setTut({ flow, step, qn: (data.quotes || []).length });
  };
  const tutClose = () => { setEnquiries((list) => list.filter((x) => !x.demo)); setTut(null); };
  const tutNext = () => { if (!tut) return; const n = tut.step + 1; if (n >= TUTS[tut.flow].steps.length) { tutClose(); return; } const st = TUTS[tut.flow].steps[n]; if (st.go) setTab(st.go); setTut({ flow: tut.flow, step: n, qn: (data.quotes || []).length }); };
  const tutBack = () => { if (tut && tut.step > 0) setTut({ flow: tut.flow, step: tut.step - 1 }); };
  /* ---- multi-company: Instagram-style switcher. Parked companies live as
     full blobs INSIDE the active v5 blob (additive - no schema bump, cloud
     sync carries all companies, per-account isolation preserved) ---- */
  const [coOpen, setCoOpen] = useState(false);
  const pendingOf = (qs) => (qs || []).filter((q) => q.status === "pending").reduce((s, q) => s + (Number(q.total) || 0), 0);
  const companyRows = () => {
    const cur = { id: (data && data._coId) || "co1", name: (data && data.shopName) || "My Shop", ind: data ? industryOf(data).label : "", pend: pendingOf(data && data.quotes), active: true };
    const parked = ((data && data._companies) || []).map((c) => ({
      id: c.id, name: (c.blob && c.blob.shopName) || "Company",
      ind: c.blob && c.blob.industry && INDUSTRIES[c.blob.industry] ? INDUSTRIES[c.blob.industry].label : "",
      pend: pendingOf(c.blob && c.blob.quotes), active: false,
    }));
    return [cur, ...parked];
  };
  const switchCompany = (id) => {
    const parked = (data._companies || []).find((c) => c.id === id);
    if (!parked) { setCoOpen(false); return; }
    const meBlob = { ...data }; delete meBlob._companies; delete meBlob._coId;
    const others = (data._companies || []).filter((c) => c.id !== id);
    const next = { ...parked.blob, _coId: id, _companies: [...others, { id: data._coId || "co1", blob: meBlob }] };
    setCoOpen(false); setTut(null); setTab("home");
    setData(next);
    ping(tx("Switched: ", "Switch ho gaya: ", "बदल गया: ") + ((parked.blob && parked.blob.shopName) || ""));
  };
  const addCompany = () => {
    if (companyRows().length >= 4) { ping(tx("Up to 4 companies for now", "Abhi 4 companies tak", "अभी 4 कंपनियों तक")); return; }
    const meBlob = { ...data }; delete meBlob._companies; delete meBlob._coId;
    /* new firm walks through the trade picker, but carries the owner's setup
       (rates, machines, materials, categories, language) - Zoho's duplicate-org
       lesson: re-entering config is the #1 friction of firm #2. Quotes/jobs/
       trucks stay empty. */
    const fresh = { ...seedData(), industry: null,
      shopName: tx("Company ", "Company ", "कंपनी ") + (companyRows().length + 1) + "", /* rename in Setup - identical names cause wrong-firm entries */
      /* udyam is a PER-LEGAL-ENTITY registration - a new firm must answer the
         Udyam question itself, never inherit the flag (byaj gate leak) */
      settings: { ...data.settings, udyam: false }, machines: (data.machines || []).map((m) => ({ ...m })),
      materials: (data.materials || []).map((m) => ({ ...m })), myCats: JSON.parse(JSON.stringify(data.myCats || {})) };
    const next = { ...fresh, _coId: uid(), _companies: [...(data._companies || []), { id: data._coId || "co1", blob: meBlob }] };
    setCoOpen(false); setTut(null); setTab("home");
    setData(next);
  };
  /* steps auto-advance when the user actually does the thing (Rules of Hooks:
     this sits above every early return) */
  useEffect(() => {
    if (!tut || !data) return;
    const st = TUTS[tut.flow].steps[tut.step];
    if (!st || !st.adv) return;
    const done = st.adv === "tab:" + tab || (st.adv === "quote+" && (data.quotes || []).length > (tut.qn || 0));
    if (done) {
      const n = tut.step + 1;
      if (n >= TUTS[tut.flow].steps.length) { setEnquiries((list) => list.filter((x) => !x.demo)); setTut(null); }
      else setTut({ flow: tut.flow, step: n, qn: (data.quotes || []).length });
    }
  }, [tab, tut, data]);
  const [enquiries, setEnquiries] = useState([]); // inbound WhatsApp messages (backend only)
  const [waOn, setWaOn] = useState(false); // true once the WhatsApp backend has answered
  const [sync, setSync] = useState(sb ? "synced" : "local"); // cloud sync state: local|synced|saving|offline
  const [authError, setAuthError] = useState(""); // OAuth return error, shown on the login screen
  const [guardOk, setGuardOk] = useState(false); // brand-new phone account answered "is this really new?"
  const [account, setAccount] = useState(undefined); // undefined = loading, null = logged out, object = logged in
  const [tallyBal, setTallyBal] = useState(null); // Tally outstanding by customer name (lowercased) - filled by the opt-in connector
  const [tallyRows, setTallyRows] = useState(null); // {vouchers, bills} from the same connector - null = no real Tally synced
  const [client, setClient] = useState(null); // party name open on the client page
  const [floorMode, setFloorMode] = useState(() => !!floorSession()); // this phone is a shop-floor device
  const [pairing, setPairing] = useState(false);
  const [floorEvents, setFloorEvents] = useState([]); // what the floor reported (cloud mode)
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
    /* one account can now hold BOTH a phone and a Google identity, so carry the
       provider list around - Setup uses it to offer the missing one, and the
       new-account guard uses it to spot a phone-only account. */
    const toAccount = (session) => {
      if (!session) return null;
      const u = session.user;
      const providers = (u.identities || []).map((i) => String(i.provider || "")).filter(Boolean);
      return {
        method: u.email ? "google" : "phone",
        uid: u.id,
        email: u.email || "",
        phone: u.phone ? "+" + String(u.phone).replace(/\D/g, "") : "",
        providers,
        createdAt: u.created_at || "",
        name: (u.user_metadata && (u.user_metadata.full_name || u.user_metadata.name)) || u.email || (u.phone ? "+" + u.phone : ""),
      };
    };
    let sub;
    (async () => {
      /* handle the OAuth redirect back from Google ourselves, capturing any error */
      try {
        const u = new URL(window.location.href);
        const hash = new URLSearchParams((u.hash || "").replace(/^#/, ""));
        const errDesc = u.searchParams.get("error_description") || hash.get("error_description") || u.searchParams.get("error") || hash.get("error");
        const code = u.searchParams.get("code");
        const linkIntent = !!localStorage.getItem(LINK_FLAG);
        if (errDesc) {
          const raw = String(errDesc).replace(/\+/g, " ");
          /* a failed LINK must not read like a failed login - the commonest
             cause is that the Google account is already attached elsewhere */
          if (linkIntent) {
            setToast(/already|linked|exists/i.test(raw)
              ? tx("That Google account is already linked to another TrackRakho account.", "Ye Google account pehle se kisi aur TrackRakho account se juda hai.", "यह Google अकाउंट पहले से किसी और TrackRakho अकाउंट से जुड़ा है।")
              : tx("Could not add Google: ", "Google nahi jud paya: ", "Google नहीं जुड़ पाया: ") + raw);
            setTimeout(() => setToast(null), 9000);
          } else setAuthError(raw);
          localStorage.removeItem(LINK_FLAG);
        } else if (code) {
          /* exchangeCodeForSession expects the bare code, not the URL */
          const gmailIntent = localStorage.getItem(GMAIL_FLAG) || u.searchParams.get("gmail_connect") === "1";
          const say = (m, ms) => { setToast(m); setTimeout(() => setToast(null), ms || 6000); };
          const netErr = (e) => /load failed|failed to fetch|network|timed? ?out/i.test((e && e.message) || "");
          let { data: xd, error } = await sb.auth.exchangeCodeForSession(code);
          if (error && netErr(error)) {
            /* Safari sometimes drops the first fetch fired right after an
               OAuth redirect lands; the code is still unused, so try again */
            await new Promise((r) => setTimeout(r, 900));
            ({ data: xd, error } = await sb.auth.exchangeCodeForSession(code));
          }
          if (error) {
            setAuthError((error.message || "sign-in failed") + " [exchange]");
            if (gmailIntent) say(netErr(error)
              ? "Your browser blocked the sign-in call (twice). Try in Chrome, or turn off content blockers / VPN for this site and retry."
              : "Gmail connect failed at sign-in: " + (error.message || "exchange error"), 12000);
          }
          /* returning from the "Connect Gmail" scoped consent? hand the refresh
             token to the server once, then forget it client-side */
          else if (gmailIntent) {
            const sess = xd && xd.session;
            const rt = sess && sess.provider_refresh_token;
            if (!rt) {
              say("Google didn't return a refresh token. Fix: open myaccount.google.com/permissions, REMOVE this app's access, then Connect Gmail again.", 12000);
            } else {
              const res = await gmailSave(rt, (sess.user && sess.user.email) || "");
              say(res.ok ? "Gmail connected - RFQ emails will appear in your pipeline" : "Gmail connect failed: " + res.why, res.ok ? 4000 : 10000);
            }
          }
          /* came back from "Add Google" in Setup and the exchange worked -
             the identity is now on the same uid, so just say so */
          else if (linkIntent) {
            say(tx("Google added. Both your number and Google now open this account.",
                   "Google jud gaya. Ab number aur Google dono se yahi account khulega.",
                   "Google जुड़ गया। अब नंबर और Google दोनों से यही अकाउंट खुलेगा।"), 7000);
          }
          localStorage.removeItem(GMAIL_FLAG);
          localStorage.removeItem(LINK_FLAG);
        }
        /* strip auth params from the address bar either way */
        if (code || errDesc || u.hash) window.history.replaceState({}, "", u.origin + u.pathname);
      } catch (e) { setAuthError((e && e.message ? e.message : "sign-in failed") + " [return]"); }

      try { const { data: d } = await sb.auth.getSession(); setAccount(toAccount(d && d.session)); }
      catch { setAccount(null); }
      const res = sb.auth.onAuthStateChange((_evt, session) => setAccount((prev) => {
        const next = toAccount(session);
        /* avoid pointless re-renders/reloads on token refresh for the same user.
           uid alone is NOT enough any more: linking a phone or a Google account
           keeps the uid and only changes phone/providers, and holding on to the
           stale object would leave Setup still offering a link that just
           succeeded. */
        const same = prev && next && prev.uid === next.uid
          && prev.phone === next.phone && prev.email === next.email
          && (prev.providers || []).join(",") === (next.providers || []).join(",");
        return same ? prev : next;
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
    /* brand-new phone account waiting on the "is this really new?" answer:
       touch nothing until it answers, so the account stays discardable */
    if (pendingNewAccount(account, guardOk)) return;
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
  }, [account ? account.uid : null, guardOk]);

  /* save shop data: local cache immediately, cloud row debounced */
  useEffect(() => {
    if (!data) return;
    clearTimeout(saveT.current);
    saveT.current = setTimeout(async () => {
      /* a full localStorage (parchi photos are the heavy thing) must never fail
         silently - the owner would keep working and lose the lot */
      if (!sb || !account) {
        storage.set(KEY, JSON.stringify(data)).catch(() => ping(tx(
          "Phone storage is full - could not save. Remove some parchi photos.",
          "Phone ki storage bhar gayi - save nahi hua. Kuch parchi photos hata dijiye.",
          "फोन की स्टोरेज भर गई - सेव नहीं हुआ। कुछ पर्ची फोटो हटाएं।")));
        return;
      }
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
    setTallyRows(null);
    if (!sb || !account || !account.uid) return;
    let alive = true;
    (async () => {
      try {
        /* grp keeps suppliers (money WE owe) out of "customer owes you" */
        let r0 = await sb.from("tally_ledgers").select("name,balance,grp");
        if (r0.error) r0 = await sb.from("tally_ledgers").select("name,balance");
        const { data: rows, error } = r0;
        if (!alive || error || !rows || !rows.length) return;
        const m = {};
        rows.forEach((r) => { if (Number(r.balance) > 0 && r.grp !== "creditor") m[partyKey(r.name)] = Number(r.balance); });
        setTallyBal(m);
        /* sales vouchers + open bills feed Home's ongoing orders and the
           client page. Missing tables (tally.sql not re-run) just mean empty. */
        const v = await sb.from("tally_vouchers").select("vdate,vtype,party,amount,item,qty,unit,vno,ref").order("vdate", { ascending: false }).limit(400);
        const b = await sb.from("tally_bills").select("party,ref,bdate,due,opening,pending").limit(600);
        if (!alive) return;
        setTallyRows({ vouchers: (!v.error && v.data) || [], bills: (!b.error && b.data) || [] });
      } catch {}
    })();
    return () => { alive = false; };
  }, [account ? account.uid : null]);

  /* the shop floor's own log. Read-only here: the worker's phone appends,
     this app only folds it into the view (and may add its own entries). */
  useEffect(() => {
    setFloorEvents([]);
    if (!sb || !account || !account.uid) return;
    let alive = true, t;
    const pull = async () => {
      try {
        const since = Date.now() - 3 * DAY;
        const r = await sb.from("floor_events").select("id,kind,machine_uid,from_uid,job_id,qty,rej,reason,note,payload,at,seen")
          .gte("at", since).order("id", { ascending: false }).limit(300);
        if (alive && !r.error && r.data) setFloorEvents(r.data);
      } catch {}
      if (alive) t = setTimeout(pull, 30000);
    };
    pull();
    return () => { alive = false; clearTimeout(t); };
  }, [account ? account.uid : null]);

  /* A job the floor started arrives as an event with the whole definition in
     it. The owner's app is the only writer of shop_data, so THIS is where it
     becomes a real job - with alloc, ETA and history like any other. Runs once
     per job id; a job the owner deleted is not resurrected (deletedFloor). */
  useEffect(() => {
    if (!data || !floorEvents.length) return;
    const have = new Set((data.jobs || []).map((j) => j.id));
    const gone = new Set(data.deletedFloor || []);
    const fresh = floorEvents.filter((e) => e.kind === "start" && e.payload && e.job_id && !have.has(e.job_id) && !gone.has(e.job_id));
    if (!fresh.length) return;
    const add = fresh.map((e) => {
      const p = e.payload || {};
      const units = (p.units && p.units.length ? p.units : [e.machine_uid]).filter(Boolean);
      const q = Math.max(0, Math.floor(Number(p.qty) || 0));
      const sh = jobShares({ qty: q, units });
      return { id: e.job_id, part: p.part || "Kaam", customer: p.customer || "", cycleMin: Number(p.cycleMin) || 0,
        manualMin: Number(p.manualMin) || 0, qty: q, units, startedAt: e.at, done: false, fromFloor: true,
        alloc: units.map((u, i) => ({ uid: u, share: sh[i], startedAt: e.at, pausedMin: 0, pausedAt: null, stopped: false })) };
    });
    setData((d) => ({ ...d, jobs: [...add, ...(d.jobs || [])] }));
  }, [floorEvents, data && data.jobs && data.jobs.length]);

  const markFloorSeen = async () => {
    const ids = floorEvents.filter((e) => !e.seen).map((e) => e.id);
    if (!ids.length || !sb) return;
    setFloorEvents((l) => l.map((e) => ({ ...e, seen: true })));
    try { await sb.from("floor_events").update({ seen: true }).in("id", ids); } catch {}
  };
  /* the owner can answer the floor from his own phone - marking a machine back
     up, or leaving a note. Same table, his own row, inserted under RLS. */
  const addFloorEvent = async (ev) => {
    if (!sb || !account || !account.uid) return;
    const row = { user_id: account.uid, kind: ev.kind, machine_uid: ev.machineUid || null, from_uid: ev.fromUid || null,
      job_id: ev.jobId || null, qty: ev.qty == null ? null : Number(ev.qty), rej: ev.rej == null ? null : Number(ev.rej),
      reason: ev.reason || null, note: ev.note || null, at: Date.now(), seen: true };
    try {
      const r = await sb.from("floor_events").insert(row).select();
      if (!r.error && r.data && r.data[0]) setFloorEvents((l) => [r.data[0], ...l]);
    } catch {}
  };

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
      /* sub-pages map onto the nav item that owns them (the floor/trucks/stock
         all live under Work); pages with no nav home hide the pill instead of
         leaving it stuck under the previously active item */
      const key = NAV_OF[tab];
      if (!key) { setPillStyle((p) => (p.opacity === 0 ? p : { opacity: 0 })); return; }
      const btn = navBtns.current[key], bar = navRef.current;
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

  /* A paired shop-floor phone never becomes the owner's app: no account, no
     shop data, just the board and the buttons. */
  if (floorMode) return <FloorApp onExit={() => setFloorMode(false)} />;
  if (pairing) return <FloorPair onPaired={() => { setPairing(false); setFloorMode(true); }} onBack={() => setPairing(false)} />;

  /* asked BEFORE any data is loaded or seeded, so the empty account stays
     discardable if this turns out to be a Google customer who typed his number */
  if (pendingNewAccount(account, guardOk))
    return <NewAccountGuard account={account} onKeep={() => {
      try { localStorage.setItem(NEWACCT_KEY + account.uid, "1"); } catch {}
      setGuardOk(true);
    }} />;

  if (account === undefined || (account && !data))
    return (<div className="qk-root"><style>{CSS}</style><div className="app" style={{ alignItems: "center", justifyContent: "center" }}>
      <div className="mono" style={{ color: "var(--faint)", fontSize: 12, letterSpacing: ".2em" }}>LOADING...</div></div></div>);

  if (!account)
    return (<div className="qk-root"><style>{CSS}</style><div className="app">
      <Auth onAuthed={saveAccount} authError={authError} />
      {/* the only door a floor worker ever uses */}
      <button className="press" onClick={() => setPairing(true)}
        style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", position: "absolute", left: 0, right: 0, bottom: "calc(10px + env(safe-area-inset-bottom))", textAlign: "center", fontSize: 13, color: "var(--faint)", padding: 10 }}>
        {tx("Shop floor phone? Pair it", "Shop floor ka phone? Yahan jodein", "\u0936\u0949\u092A \u092B\u094D\u0932\u094B\u0930 \u0915\u093E \u092B\u094B\u0928? \u092F\u0939\u093E\u0902 \u091C\u094B\u0921\u093C\u0947\u0902")}
      </button>
    </div></div>);

  /* first run: pick the trade. If the pipeline is still untouched seed/sample
     data, swap in this trade's examples; real data is never overwritten. */
  if (!data.industry)
    return <IndustryPicker onPick={(key, opts = {}) => setData((d) => {
      /* the demo pipeline arrives ONLY when it was asked for, and never
         overwrites anything the owner has already typed */
      const untouched = !d.quotes.length || d.quotes.every((q) => q.seed);
      const demo = opts.demo && untouched ? demoShop(key) : null;
      return {
        ...d,
        industry: key,
        shopName: opts.name || d.shopName || "",
        machines: demo && !(d.machines || []).length ? demo.machines : d.machines,
        quotes: demo ? demo.quotes : d.quotes,
      };
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
  LANG = (data && data.settings && data.settings.lang) || "hi-en";
  const accountView = account ? { ...account, plan: sb ? (data && data.planId) : account.plan } : account;

  return (
    <div className="qk-root"><style>{CSS}</style>
      <div className="app">
        {toast && <div className="toast">{toast}</div>}
        {tut && <TutOverlay flow={tut.flow} step={tut.step} tick={fabOpen ? 1 : 0} onNext={tutNext} onBack={tutBack} onClose={tutClose} />}

        {tab === "home" && <Home data={data} account={accountView} onNew={startQuote} onLog={startLog} goQuotes={goQuotes} openAnalytics={() => setTab("analytics")} openClient={(n) => { setClient(n); setTab("client"); }} tallyRows={tallyRows} tallyBal={tallyBal} goSetup={() => setTab("setup")} goSubscribe={() => setTab("subscribe")} openCo={() => setCoOpen(true)} clearDemo={() => { setData((d) => stripDemo(d)); ping(tx("Example data removed", "Example data hata diya", "उदाहरण डेटा हटा दिया")); }} startTut={startTut} dismissTut={() => setData({ ...data, settings: { ...data.settings, tutHomeDone: true } })} />}
        {tab === "quotes" && <Quotes data={data} setStatus={setStatus} updateQuote={updateQuote} delQuote={delQuote} importQuotes={importQuotes} ping={ping} filter={quotesFilter} setFilter={setQuotesFilter} cat={quotesCat} setCat={setQuotesCat} onLog={startLog} enquiries={enquiries} logEnquiry={logEnquiry} dismissEnquiry={dismissEnquiry} waOn={waOn} refreshEnquiries={refreshEnquiries} tallyBal={tallyBal} sendToFloor={sendToFloor} startTut={startTut} />}
        {tab === "log" && <QuickLog data={data} onSave={saveLogged} onExit={() => setTab("home")} ping={ping} startTut={startTut} />}
        {tab === "setup" && <Setup data={data} setData={setData} ping={ping} account={accountView} sync={sync} goSubscribe={() => setTab("subscribe")} onLogout={logout} />}
        {tab === "help" && <Help data={data} ping={ping} startTut={startTut} />}
        {tab === "analytics" && <Analytics data={data} onBack={() => setTab("home")} goQuotes={goQuotes} />}
        {tab === "client" && client && <ClientPage data={data} name={client} tallyRows={tallyRows} tallyBal={tallyBal} updateQuote={updateQuote} ping={ping} onBack={() => setTab("home")} goMoney={() => setTab("tally")} goTrucks={() => setTab("trucks")} />}
        {tab === "tally" && <TallyInsights data={data} updateQuote={updateQuote} ping={ping} onBack={() => setTab("home")} />}
        {/* WORK - machine shops land straight on the floor; traders get a hub
            for the truck board and the yard (both still open as their own tabs,
            which NAV_OF maps back under Work) */}
        {tab === "work" && industryOf(data).key !== "machining" && <WorkHub data={data} openTrucks={() => setTab("trucks")} openStock={() => setTab("stock")} />}
        {(tab === "floor" || (tab === "work" && industryOf(data).key === "machining")) && <MachineFloor data={data} setData={setData} ping={ping} onBack={() => setTab("home")} goSetup={() => setTab("setup")} draft={floorDraft} clearDraft={() => setFloorDraft(null)} floorEvents={floorEvents} onFloorSeen={markFloorSeen} addFloorEvent={addFloorEvent} />}
        {tab === "trucks" && <TruckBoard data={data} setData={setData} ping={ping} onBack={() => setTab("work")} goSetup={() => setTab("setup")} />}
        {tab === "stock" && <StockYard data={data} setData={setData} ping={ping} onBack={() => setTab("work")} />}
        {tab === "subscribe" && <Subscribe account={accountView} onSubscribe={(id) => { subscribe(id); ping("You're on the " + PLANS.find(p => p.id === id).name + " plan"); setTab("home"); }} onBack={() => setTab("home")} />}
        {tab === "new" && (<Wizard data={data} draft={draft} setDraft={setDraft} step={step} setStep={setStep}
          onExit={() => setTab("home")} onSave={saveQuote} doneQuote={doneQuote} ping={ping}
          onFinish={() => { setTab("home"); setDoneQuote(null); }} />)}

        {/* FAB chooser - quick log (tracker-first) vs full costing quote */}
        {coOpen && (
          <div onClick={() => setCoOpen(false)} style={{ position: "absolute", inset: 0, zIndex: 60, background: "rgba(16,26,20,.42)", backdropFilter: "blur(3px)", display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
            <div className="anim-in" onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: "26px 26px 0 0", padding: "22px 18px calc(20px + env(safe-area-inset-bottom))", boxShadow: "0 -20px 50px -20px rgba(21,94,24,.4)" }}>
              <div style={{ width: 40, height: 4, borderRadius: 3, background: "var(--line2)", margin: "0 auto 16px" }} />
              <div className="microlbl" style={{ marginLeft: 2 }}>{tx("YOUR COMPANIES", "AAPKI COMPANIES", "आपकी कंपनियाँ")}</div>
              <div className="h-disp" style={{ fontSize: 21, fontWeight: 700, margin: "3px 0 16px 2px" }}>{tx("Switch company", "Company badlo", "कंपनी बदलें")}</div>
              {companyRows().map((c) => (
                <button key={c.id} className="press" onClick={() => (c.active ? setCoOpen(false) : switchCompany(c.id))} style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", width: "100%", display: "flex", alignItems: "center", gap: 13, padding: "13px 14px", borderRadius: 16, border: c.active ? "1.5px solid var(--grn-x)" : "1px solid var(--line)", background: c.active ? "#F3FBF4" : "#fff", marginBottom: 9 }}>
                  <span style={{ width: 42, height: 42, borderRadius: 13, background: "linear-gradient(135deg,#2E9E33,#155E18)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--mono)", fontWeight: 600, fontSize: 13, flexShrink: 0 }}>{c.name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase()}</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontWeight: 700, fontSize: 15.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.name}</span>
                    <span className="mono" style={{ fontSize: 12, color: "var(--faint)" }}>{c.ind}{c.pend > 0 ? " · " : ""}{c.pend > 0 && <span style={{ color: "var(--amber)", fontWeight: 600 }}>{inr(c.pend)} pending</span>}</span>
                  </span>
                  {c.active && <span className="mono" style={{ flexShrink: 0, fontSize: 10, fontWeight: 700, color: "var(--grn-d)", background: "var(--grn-100)", borderRadius: 999, padding: "3px 9px" }}>ACTIVE</span>}
                </button>
              ))}
              <button className="btn btn-ghost press" style={{ width: "100%", marginTop: 4 }} onClick={addCompany}>+ {tx("Add a company", "Nayi company jodo", "नई कंपनी जोड़ें")}</button>
              <div className="hint" style={{ marginTop: 10, textAlign: "center" }}>{tx("Each company's quotes, Tally and settings stay fully separate.", "Har company ke quotes, Tally aur settings bilkul alag rehte hain.", "हर कंपनी का डेटा बिल्कुल अलग रहता है।")}</div>

              {/* Setup and Help live here now - the bottom bar is for the four
                  daily jobs, and these two are visited rarely */}
              <div style={{ borderTop: "1px solid var(--line)", marginTop: 16, paddingTop: 12 }}>
                {[["setup", <I.gear />, tx("Setup", "Setup", "सेटअप"), tx("Shop, machines, rates, Tally, login", "Shop, machines, rate, Tally, login", "दुकान, मशीन, रेट, Tally, लॉगिन")],
                  ["help", <I.help />, tx("Help", "Help", "मदद")], ].map(([k, icon, label, sub]) => (
                  <button key={k} className="press" onClick={() => { setCoOpen(false); setTab(k); }}
                    style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", width: "100%", display: "flex", alignItems: "center", gap: 13, padding: "12px 4px" }}>
                    <span style={{ width: 38, height: 38, borderRadius: 12, background: "var(--soft)", color: "var(--grn-d)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{icon}</span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: "block", fontWeight: 600, fontSize: 15.5 }}>{label}</span>
                      {sub && <span style={{ display: "block", fontSize: 12.5, color: "var(--dim)", marginTop: 1 }}>{sub}</span>}
                    </span>
                    <I.chev style={{ color: "var(--faint)", flexShrink: 0 }} />
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {fabOpen && (
          <div onClick={() => setFabOpen(false)} style={{ position: "absolute", inset: 0, zIndex: 60, background: "rgba(16,26,20,.42)", backdropFilter: "blur(3px)", display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
            <div className="anim-in" onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: "26px 26px 0 0", padding: "22px 18px calc(20px + env(safe-area-inset-bottom))", boxShadow: "0 -20px 50px -20px rgba(21,94,24,.4)" }}>
              <div style={{ width: 40, height: 4, borderRadius: 3, background: "var(--line2)", margin: "0 auto 16px" }} />
              <div className="microlbl" style={{ marginLeft: 2 }}>{tx("ADD TO PIPELINE", "ADD TO PIPELINE", "पाइपलाइन में जोड़ें")}</div>
              <div className="h-disp" style={{ fontSize: 21, fontWeight: 700, margin: "3px 0 16px 2px" }}>{tx("How do you want to add it?", "How do you want to add it?", "कैसे जोड़ना चाहेंगे?")}</div>
              <button className="press" data-tut="fab-log" onClick={startLog} style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", width: "100%", display: "flex", alignItems: "center", gap: 14, padding: "16px", borderRadius: 18, background: "linear-gradient(135deg,#1B7A20,#2E9E33)", color: "#fff", marginBottom: 10, boxShadow: "var(--sh-m)" }}>
                <span style={{ width: 42, height: 42, borderRadius: 13, background: "rgba(255,255,255,.18)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><I.bolt /></span>
                <span style={{ flex: 1 }}><span style={{ display: "block", fontWeight: 700, fontSize: 16 }}>{tx("Log a quote", "Log a quote", "कोटेशन लिखें")}</span><span style={{ fontSize: 12.5, color: "rgba(255,255,255,.85)" }}>{tx("Made it in Excel or on call? Add it in 30 seconds.", "Made it in Excel or on call? Add it in 30 seconds.", "Excel में या फोन पर बनाया? 30 सेकंड में जोड़ें।")}</span></span>
                <I.chev />
              </button>
              <button className="press" data-tut="fab-new" onClick={startQuote} style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", width: "100%", display: "flex", alignItems: "center", gap: 14, padding: "16px", borderRadius: 18, background: "#fff", border: "1.5px solid var(--line2)", boxShadow: "var(--sh-s)" }}>
                <span style={{ width: 42, height: 42, borderRadius: 13, background: "var(--grn-100)", color: "var(--grn-d)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><I.chart /></span>
                <span style={{ flex: 1 }}><span style={{ display: "block", fontWeight: 700, fontSize: 16 }}>{tx("New quotation", "New quotation", "नया कोटेशन")}</span><span style={{ fontSize: 12.5, color: "var(--dim)" }}>{tx("Full costing wizard - material, machine, margin.", "Full costing wizard - material, machine, margin.", "पूरा कॉस्टिंग विज़ार्ड - मटीरियल, मशीन, मार्जिन।")}</span></span>
                <I.chev style={{ color: "var(--faint)" }} />
              </button>
            </div>
          </div>
        )}

        {/* Home · Quotes · + · Work · Money. Setup and Help moved into the
            avatar sheet (top right) - the four tabs are the daily jobs. */}
        {tab !== "new" && tab !== "analytics" && tab !== "subscribe" && tab !== "log" && (
          <nav className="navbar" ref={navRef}>
            <div className="nav-pill" style={pillStyle} />
            <button ref={setNavRef("home")} className={"nav-it " + (NAV_OF[tab] === "home" ? "on" : "")} onClick={() => setTab("home")}><I.home /><span>{tx("Home", "Home", "होम")}</span></button>
            <button ref={setNavRef("quotes")} className={"nav-it " + (tab === "quotes" ? "on" : "")} onClick={() => setTab("quotes")}><I.list /><span>{tx("Quotes", "Quotes", "कोटेशन")}</span></button>
            <button className="fab press" data-tut="fab" onClick={() => (industryOf(data).key === "machining" ? setFabOpen(true) : startLog())} aria-label="Add a quote"><I.plus /></button>
            <button ref={setNavRef("work")} className={"nav-it " + (NAV_OF[tab] === "work" ? "on" : "")} onClick={() => setTab("work")} style={{ position: "relative" }}>
              <I.gear2 />
              {floorEvents.some((e) => !e.seen) && <i style={{ position: "absolute", top: 6, right: "50%", marginRight: -16, width: 8, height: 8, borderRadius: "50%", background: floorEvents.some((e) => !e.seen && e.kind === "down") ? "var(--red)" : "var(--grn-x)" }} />}
              <span>{tx("Work", "Work", "काम")}</span>
            </button>
            <button ref={setNavRef("tally")} className={"nav-it " + (tab === "tally" ? "on" : "")} onClick={() => setTab("tally")}><I.rupee /><span>{tx("Money", "Money", "पैसा")}</span></button>
          </nav>
        )}
      </div>
    </div>
  );
}

/* ================= WORK (traders) =================
   Machine shops get the floor itself on this tab. Traders have two work
   surfaces instead, so this is a small hub. */
function WorkHub({ data, openTrucks, openStock }) {
  const out = (data.trips || []).filter((t) => !t.delivered).length;
  const outMT = (data.trips || []).filter((t) => !t.delivered).reduce((s, t) => s + (Number(t.qty) || 0), 0);
  const trucks = (data.trucks || []).length;
  /* the GHATA warning moved here with the stock card - it must stay loud */
  const stk = stockCalc(data);
  const card = (onClick, emoji, title, sub, badge) => (
    <button onClick={onClick} className="press anim-in st1" style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", width: "100%", marginTop: 12, display: "flex", alignItems: "center", gap: 12, padding: "16px", borderRadius: 18, background: "#fff", border: "1px solid var(--line)", boxShadow: "var(--sh-s)" }}>
      <span style={{ width: 44, height: 44, borderRadius: 14, background: "var(--grn-100)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 21, flexShrink: 0 }}>{emoji}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontWeight: 700, fontSize: 16 }}>{title}</span>
        <span style={{ display: "block", fontSize: 12.5, color: "var(--dim)", marginTop: 2 }}>{sub}</span>
      </span>
      {badge}
      <I.chev style={{ color: "var(--faint)", flexShrink: 0 }} />
    </button>
  );
  return (
    <div className="scr"><div className="pagepad">
      <div className="microlbl">{tx("YOUR WORK", "AAPKA KAAM", "आपका काम")}</div>
      <div className="h-disp" style={{ fontSize: 26, fontWeight: 700, margin: "4px 0 4px" }}>{tx("The yard today", "Aaj ka kaam", "आज का काम")}</div>
      <div style={{ color: "var(--dim)", fontSize: 14.5, lineHeight: 1.55 }}>{tx("Trucks on the road and what the yard is holding.", "Gaadiyan kahan hain aur yard mein kitna maal hai.", "गाड़ियाँ कहाँ हैं और यार्ड में कितना माल है।")}</div>
      {card(openTrucks, "\u{1F69B}", tx("Truck board", "Truck board", "ट्रक बोर्ड"),
        trucks && out ? out + "/" + trucks + tx(" trucks out · ", " gaadiyan bahar · ", " गाड़ियां बाहर · ") + fmtQty(outMT) + tx(" MT on the road", " MT raste mein", " MT रास्ते में")
          : tx("Which truck is out, carrying what, for how long.", "Kaunsi gaadi bahar hai, kya le kar, kitni der se.", "कौन सी गाड़ी बाहर है, क्या लेकर।"),
        out > 0 ? <span className="mono" style={{ flexShrink: 0, fontSize: 10.5, fontWeight: 700, color: "var(--amber)", background: "var(--amber-bg, #FFF4E0)", borderRadius: 999, padding: "4px 10px" }}>{out} OUT</span> : null)}
      {card(openStock, "⚖️", tx("Yard stock", "Yard stock", "यार्ड स्टॉक"),
        stk.total > 0 ? fmtQty(stk.total) + tx(" MT in the yard", " MT yard mein", " MT यार्ड में") + (stk.outToday > 0 ? " · " + fmtQty(stk.outToday) + tx(" MT sent today", " MT aaj gaya", " MT आज गया") : "")
          : tx("Book stock vs the kanta - catch ghata early.", "Book stock vs kanta - ghata jaldi pakdo.", "बुक स्टॉक बनाम कांटा - घाटा जल्दी पकड़ें।"),
        stk.ghataTotal > 0 ? <span className="mono" style={{ flexShrink: 0, fontSize: 10.5, fontWeight: 700, color: "var(--red)", background: "var(--red-bg)", borderRadius: 999, padding: "4px 10px" }}>{tx("GHATA ", "GHATA ", "घाटा ")}{fmtQty(stk.ghataTotal)} MT</span> : null)}
    </div></div>
  );
}

/* ================= CLIENT PAGE =================
   One party, everything an owner gets asked on the phone: how much money is
   due, how much maal went, how much is still to go, and when each truck left.
   Opened from Home's ongoing orders. Money comes from Tally only (the app
   does not track payments) - without Tally it says so instead of guessing. */
function ClientPage({ data, name, tallyRows, tallyBal, updateQuote, ping, onBack, goMoney, goTrucks }) {
  const ind = industryOf(data);
  const u = ind.unit || "pcs";
  const pv = partyView(data, name, tallyRows, tallyBal);
  const now = Date.now();
  /* the tiles answer "what is still running", so closed orders sit in their
     own list below instead of skewing ORDER / GAYA / BAKI */
  const live = pv.orders.filter((o) => !o.closed);
  const shut = pv.orders.filter((o) => o.closed);
  const closeOrder = (o) => { updateQuote(o.q.id, { closedAt: Date.now(), closedSent: o.sent }); ping(tx("Order closed - off your Home screen", "Order band. Home se hat gaya.", "ऑर्डर बंद - होम से हट गया")); };
  const reopenOrder = (o) => { updateQuote(o.q.id, { closedAt: null, closedSent: null }); ping(tx("Order is open again", "Order phir se chalu", "ऑर्डर फिर से चालू")); };
  const ordered = live.reduce((s, o) => s + o.qty, 0);
  const sent = live.reduce((s, o) => s + o.sent, 0);
  const left = live.reduce((s, o) => s + o.remaining, 0);
  /* same aging rule as Money: from the due date, else the bill date */
  const lateBy = (b) => Math.floor((startOfDay(now) - startOfDay(Number(b.due) || Number(b.bdate))) / DAY);
  const bills = [...pv.bills].sort((a, b) => lateBy(b) - lateBy(a));
  const lateAmt = bills.filter((b) => lateBy(b) > 0).reduce((s, b) => s + Number(b.pending), 0);
  const okAmt = bills.filter((b) => lateBy(b) <= 0).reduce((s, b) => s + Number(b.pending), 0);
  const tallyOn = pv.balance != null;
  const others = pv.quotes.filter((q) => !pv.orders.some((o) => o.q.id === q.id));
  const chip = (bg, c) => ({ display: "inline-flex", alignItems: "center", fontSize: 11, fontWeight: 700, fontFamily: "var(--mono)", padding: "3px 9px", borderRadius: 999, background: bg, color: c, whiteSpace: "nowrap" });
  const title = (t, sub) => (
    <div style={{ marginBottom: 12 }}>
      <div className="h-disp" style={{ fontSize: 16.5, fontWeight: 700 }}>{t}</div>
      {sub && <div style={{ fontSize: 12, color: "var(--dim)", marginTop: 1 }}>{sub}</div>}
    </div>
  );

  return (
    <div className="scr"><div className="pagepad">
      <div className="anim-in" style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <button className="iconbtn press" onClick={onBack} aria-label="Back"><I.back /></button>
        <span className="mono" style={{ width: 44, height: 44, borderRadius: 14, background: "linear-gradient(135deg,#2E9E33,#155E18)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 600, flexShrink: 0 }}>{initialsOf(pv.name)}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="microlbl">{tx("CLIENT", "PARTY", "पार्टी")}</div>
          <div className="h-disp" style={{ fontSize: 22, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{pv.name}</div>
        </div>
        {pv.sample && <span className="demo-ribbon">SAMPLE</span>}
        {pv.phone && <a className="iconbtn press" href={waLink(pv.phone, "")} target="_blank" rel="noreferrer" aria-label="WhatsApp" style={{ color: "#128C4B", flexShrink: 0 }}><I.wa /></a>}
      </div>

      {/* money - Tally only */}
      <div className="card anim-in st1" style={{ padding: 16, marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
          <div>
            <div className="h-disp" style={{ fontSize: 16.5, fontWeight: 700 }}>{tx("Money due", "Paisa baki", "बाकी पैसा")}</div>
            <div style={{ fontSize: 12, color: "var(--dim)", marginTop: 1 }}>({tx("they owe you - from Tally", "inse lena hai - Tally se", "इनसे लेना है - Tally से")})</div>
          </div>
          <b className="h-disp mono" style={{ fontSize: 25, color: lateAmt > 0 ? "var(--red)" : "var(--ink)", whiteSpace: "nowrap" }}>{tallyOn ? inr(pv.balance) : "-"}</b>
        </div>
        {tallyOn && pv.balance > 0 && bills.length > 0 && (<>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
            {lateAmt > 0 && <span style={chip("var(--red-bg)", "var(--red)")}>{inr(lateAmt)} {tx("overdue", "late", "लेट")}</span>}
            {okAmt > 0 && <span style={chip("var(--grn-100)", "var(--grn-d)")}>{inr(okAmt)} {tx("not due yet", "abhi time hai", "अभी समय है")}</span>}
          </div>
          <div style={{ marginTop: 10 }}>
            {bills.slice(0, 4).map((b, i) => {
              const d = lateBy(b);
              return (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "10px 0", borderTop: "1px solid var(--line)" }}>
                  <span style={{ minWidth: 0 }}>
                    <span className="mono" style={{ display: "block", fontSize: 13, fontWeight: 600 }}>{b.ref ? "#" + b.ref : tx("Bill", "Bill", "बिल")}</span>
                    <span style={{ display: "block", fontSize: 12.5, color: d > 0 ? "var(--red)" : "var(--dim)" }}>
                      {d > 0 ? d + tx(" days late", " din late", " दिन लेट") : d === 0 ? tx("due today", "aaj due", "आज ड्यू")
                        : tx("due in " + -d + " days", -d + " din mein due", -d + " दिन में ड्यू")}
                    </span>
                  </span>
                  <b className="mono" style={{ fontSize: 15, flexShrink: 0 }}>{inr(b.pending)}</b>
                </div>
              );
            })}
          </div>
        </>)}
        {tallyOn && !(pv.balance > 0) && <div style={{ fontSize: 13.5, color: "var(--grn-d)", fontWeight: 600, marginTop: 8 }}>{tx("Nothing due - all clear", "Kuch baki nahi - hisaab saaf", "कुछ बाकी नहीं - हिसाब साफ")} ✓</div>}
        {!tallyOn && <div style={{ fontSize: 13, color: "var(--dim)", lineHeight: 1.55, marginTop: 8 }}>{tx("Connect Tally and this shows what they owe, bill by bill.", "Tally jodne par yahan dikhega inka baki paisa - bill-wise.", "Tally जोड़ने पर यहां दिखेगा इनका बाकी पैसा - बिल-वार।")}</div>}
        {tallyOn && (
          <button className="press" onClick={goMoney} style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 2, marginTop: 10, fontSize: 13.5, fontWeight: 600, color: "var(--grn-d)" }}>
            {tx("Full account on Money", "Money mein poora hisaab", "Money में पूरा हिसाब")} <I.chev style={{ width: 15 }} />
          </button>
        )}
      </div>

      {/* maal - orders vs dispatch */}
      <div className="card anim-in st2" style={{ padding: 16, marginBottom: 12 }}>
        {title(tx("Maal", "Maal", "माल"), "(" + tx("orders vs what went out", "order vs kitna gaya", "ऑर्डर बनाम कितना गया") + ")")}
        {live.length > 0 ? (<>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            {[[tx("ORDER", "ORDER", "ऑर्डर"), ordered, "var(--ink)"], [tx("SENT", "GAYA", "गया"), sent, "var(--grn-d)"], [tx("LEFT", "BAKI", "बाकी"), left, left > 0 ? "var(--amber)" : "var(--grn-d)"]].map(([l, v, c]) => (
              <div key={l} style={{ background: "var(--soft)", border: "1px solid var(--line)", borderRadius: 14, padding: "10px 11px" }}>
                <div className="h-disp mono" style={{ fontSize: 18, fontWeight: 700, color: c, whiteSpace: "nowrap" }}>{fmtQty(v)}<span style={{ fontSize: 11.5, marginLeft: 3 }}>{u}</span></div>
                <div className="mono" style={{ fontSize: 10.5, fontWeight: 600, color: "var(--faint)", letterSpacing: ".06em", marginTop: 2 }}>{l}</div>
              </div>
            ))}
          </div>
          {live.map((o) => {
            const pct = o.qty ? Math.min(100, (o.sent / o.qty) * 100) : 0;
            return (
              <div key={o.q.id} style={{ marginTop: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 14.5, fontWeight: 600, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{o.q.part}</span>
                  {o.done ? <span style={chip("var(--grn-100)", "var(--grn-d)")}>{tx("ALL SENT", "PURA GAYA", "पूरा गया")} ✓</span>
                    : <span className="mono" style={{ fontSize: 12.5, fontWeight: 600, color: "var(--dim)", flexShrink: 0 }}>{Math.round(pct)}%</span>}
                </div>
                <div style={{ height: 8, borderRadius: 99, background: "var(--soft)", border: "1px solid var(--line)", overflow: "hidden", marginTop: 7 }}>
                  <div style={{ height: "100%", width: pct + "%", minWidth: o.sent > 0 ? 6 : 0, borderRadius: 99, background: "linear-gradient(90deg,#2E9E33,#5DBB63)" }} />
                </div>
                <div className="mono" style={{ fontSize: 12, color: "var(--faint)", marginTop: 5 }}>
                  {fmtQty(o.sent)} / {fmtQty(o.qty)} {u} · {inr(o.q.total)} · {tx("won ", "order ", "ऑर्डर ")}{fdateShort(o.q.at)}
                </div>
                {/* the owner's own full stop: a part-cancelled or settled order
                    leaves Home without pretending the rest of the maal went */}
                {updateQuote && (
                  <button className="btn btn-ghost btn-sm press" style={{ marginTop: 9 }} onClick={() => closeOrder(o)}>
                    {o.done ? tx("Close this order", "Order band karo", "ऑर्डर बंद करें")
                      : tx("Order finished - close it", "Order poora hua - band karo", "ऑर्डर पूरा हुआ - बंद करें")}
                  </button>
                )}
              </div>
            );
          })}
        </>) : (
          <div style={{ fontSize: 13.5, color: "var(--dim)", lineHeight: 1.55 }}>{tx("No open order with this party.", "Is party ka koi chalu order nahi.", "इस पार्टी का कोई चालू ऑर्डर नहीं।")}</div>
        )}
      </div>

      {/* closed by hand - kept visible so a wrong tap is one tap back */}
      {shut.length > 0 && (
        <div className="card anim-in st2" style={{ padding: 16, marginBottom: 12 }}>
          <div className="h-disp" style={{ fontSize: 15.5, fontWeight: 700, marginBottom: 2 }}>{tx("Closed orders", "Band kiye orders", "बंद किए ऑर्डर")}</div>
          <div style={{ fontSize: 12, color: "var(--dim)", marginBottom: 4 }}>{tx("Not counted above and not on Home.", "Upar aur Home par nahi ginte.", "ऊपर और होम पर नहीं गिने जाते।")}</div>
          {shut.map((o) => (
            <div key={o.q.id} style={{ display: "flex", alignItems: "center", gap: 10, paddingTop: 11, marginTop: 11, borderTop: "1px solid var(--line)" }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 14.5, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{o.q.part}</span>
                <span className="mono" style={{ display: "block", fontSize: 11.5, color: "var(--faint)", marginTop: 2 }}>
                  {fmtQty(o.sent)} / {fmtQty(o.qty)} {u} {tx("sent", "gaya", "गया")} · {tx("closed ", "band ", "बंद ")}{fdateShort(o.q.closedAt)}
                </span>
              </span>
              {updateQuote && <button className="btn btn-ghost btn-sm press" style={{ flexShrink: 0 }} onClick={() => reopenOrder(o)}>{tx("Reopen", "Wapas kholo", "फिर खोलें")}</button>}
            </div>
          ))}
        </div>
      )}

      {/* when each load left */}
      <div className="anim-in st3" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", margin: "22px 0 10px" }}>
        <span className="eyebrow">{tx("Dispatches", "Kab kitna gaya", "कब कितना गया")}</span>
        {pv.dispatches.length > 0 && <span className="mono" style={{ fontSize: 10.5, letterSpacing: ".08em", color: "var(--faint)" }}>{pv.fromTally ? tx("FROM TALLY", "TALLY SE", "TALLY से") : tx("FROM TRUCK BOARD", "TRUCK BOARD SE", "ट्रक बोर्ड से")}</span>}
      </div>
      {pv.dispatches.length === 0 && (
        <div className="card-tint anim-in st3" style={{ padding: "16px 16px", fontSize: 13.5, color: "var(--dim)", lineHeight: 1.55 }}>
          {tx("Nothing sent yet. Send a truck from the Truck board and it shows up here on its own.", "Abhi tak kuch nahi gaya. Truck board se gaadi bhejo - yahan apne aap judega.", "अभी तक कुछ नहीं गया। ट्रक बोर्ड से गाड़ी भेजें - यहां अपने आप जुड़ेगा।")}
          {ind.key === "scrap" && <div><button className="btn btn-soft btn-sm press" style={{ marginTop: 12 }} onClick={goTrucks}>{tx("Open Truck board", "Truck board kholo", "ट्रक बोर्ड खोलें")}</button></div>}
        </div>
      )}
      {pv.dispatches.slice(0, 12).map((d, i, arr) => (<Fragment key={d.id || i}>
        {/* loads from before the first open order belong to older business -
            listed for history, not counted in GAYA above */}
        {!d.counted && (i === 0 || arr[i - 1].counted) && (
          <div style={{ fontSize: 12.5, color: "var(--faint)", margin: "14px 2px 8px" }}>{tx("Earlier loads (older orders - not counted above)", "Pehle ka maal (purane orders - upar nahi gina)", "पहले का माल (पुराने ऑर्डर - ऊपर नहीं गिना)")}</div>
        )}
        <div className={"card anim-in st" + Math.min(8, 3 + i)} style={{ padding: "11px 14px", marginBottom: 8, display: "grid", gridTemplateColumns: "58px 1fr auto", gap: 10, alignItems: "center", opacity: d.counted ? 1 : 0.6 }}>
          <span className="mono" style={{ fontSize: 12.5, color: "var(--dim)", whiteSpace: "nowrap" }}>{fdateShort(d.at)}</span>
          <span style={{ minWidth: 0 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
              <span className="mono" style={{ fontSize: 12.5, fontWeight: 700, color: "var(--grn-d)", background: "var(--grn-100)", padding: "2px 8px", borderRadius: 999, flexShrink: 0 }}>{fmtQty(d.qty)} {u}</span>
              <span style={{ fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{d.item}</span>
            </span>
            {(d.ref || d.truck) && <span className="mono" style={{ display: "block", fontSize: 11.5, color: "var(--faint)", marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{[d.ref ? "#" + d.ref : "", d.truck].filter(Boolean).join(" · ")}</span>}
          </span>
          <span style={{ flexShrink: 0 }}>
            {d.src === "tally" ? <b className="mono" style={{ fontSize: 14 }}>{inr(d.amount)}</b>
              : d.onRoad ? <span style={chip("var(--amber-bg)", "var(--amber)")}>{tx("ON ROAD", "RASTE MEIN", "रास्ते में")}</span>
              : d.src === "truck" ? <span style={chip("var(--grn-100)", "var(--grn-d)")}>{tx("DELIVERED", "PAHUNCHA", "पहुंचा")}</span> : null}
          </span>
        </div>
      </Fragment>))}

      {/* the rest of the relationship - quotes that are not open orders */}
      {others.length > 0 && (<>
        <div className="anim-in st4" style={{ margin: "22px 0 10px" }}><span className="eyebrow">{tx("Quotes", "Quotes", "कोटेशन")}</span></div>
        {others.map((q) => (
          <div key={q.id} className="card anim-in st4" style={{ padding: "12px 14px", marginBottom: 8, display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", fontSize: 14.5, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{q.part}</span>
              <span className="mono" style={{ display: "block", fontSize: 11.5, color: "var(--faint)", marginTop: 2 }}>{q.qty ? fmtQty(q.qty) + " " + u + " · " : ""}{fdateShort(q.at)}</span>
            </span>
            <span style={{ textAlign: "right", flexShrink: 0 }}>
              <b className="mono" style={{ display: "block", fontSize: 14.5 }}>{inr(q.total)}</b>
              <span className={"pill " + (q.status === "won" ? "won" : q.status === "lost" ? "lost" : "pend")} style={{ marginTop: 4 }}><i className="dot" />{q.status.toUpperCase()}</span>
            </span>
          </div>
        ))}
      </>)}
    </div></div>
  );
}

/* ================= FLOOR DEVICE: PAIRING =================
   Six digits, typed once. The phone gets a device token and nothing else. */
function FloorPair({ onPaired, onBack }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const go = async () => {
    if (code.replace(/\D/g, "").length !== 6) return setErr(tx("Enter all 6 digits", "Poore 6 digit daalein", "\u092A\u0942\u0930\u0947 6 \u0905\u0902\u0915 \u0921\u093E\u0932\u0947\u0902"));
    setErr(""); setBusy(true);
    try {
      const d = await floorApi("/floor-pair", { method: "POST", body: JSON.stringify({ action: "claim", code: code.replace(/\D/g, "") }) });
      floorSave({ token: d.token, shopName: d.shopName || "" });
      onPaired();
    } catch (e) {
      const m = String((e && e.message) || "");
      setErr(m === "code not found" ? tx("That code is wrong. Ask the owner to read it again.", "Ye code galat hai. Maalik se dobara poochhein.", "\u092F\u0939 \u0915\u094B\u0921 \u0917\u0932\u0924 \u0939\u0948\u0964")
        : m === "code expired" ? tx("That code has expired. Ask for a new one.", "Code purana ho gaya. Naya code maangein.", "\u0915\u094B\u0921 \u092A\u0941\u0930\u093E\u0928\u093E \u0939\u094B \u0917\u092F\u093E\u0964")
        : m === "code already used" ? tx("That code is already used.", "Ye code pehle use ho chuka hai.", "\u092F\u0939 \u0915\u094B\u0921 \u092A\u0939\u0932\u0947 \u0907\u0938\u094D\u0924\u0947\u092E\u093E\u0932 \u0939\u094B \u091A\u0941\u0915\u093E \u0939\u0948\u0964")
        : tx("Could not connect. Check the internet.", "Connect nahi ho paya. Internet dekh lein.", "\u0915\u0928\u0947\u0915\u094D\u091F \u0928\u0939\u0940\u0902 \u0939\u0941\u0906\u0964"));
      setBusy(false);
    }
  };
  return (
    <div className="qk-root"><style>{CSS}</style><div className="app">
      <div className="scr"><div className="pagepad">
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
          <button className="iconbtn press" onClick={onBack}><I.back /></button>
          <div>
            <div className="microlbl">{tx("SHOP FLOOR PHONE", "SHOP FLOOR PHONE", "\u0936\u0949\u092A \u092B\u094D\u0932\u094B\u0930 \u092B\u094B\u0928")}</div>
            <div className="h-disp" style={{ fontSize: 24, fontWeight: 700 }}>{tx("Pair this phone", "Ye phone jodein", "\u092F\u0939 \u092B\u094B\u0928 \u091C\u094B\u0921\u093C\u0947\u0902")}</div>
          </div>
        </div>
        <div className="card" style={{ padding: 18 }}>
          <div style={{ fontSize: 14.5, color: "var(--dim)", lineHeight: 1.6, marginBottom: 16 }}>
            {tx("Ask the owner for the 6-digit code from Setup > Shop floor phones.", "Maalik se 6 digit ka code maangein - Setup > Shop floor phone mein milega.", "\u092E\u093E\u0932\u093F\u0915 \u0938\u0947 6 \u0905\u0902\u0915 \u0915\u093E \u0915\u094B\u0921 \u092E\u093E\u0902\u0917\u0947\u0902\u0964")}
          </div>
          <input className="input mono" inputMode="numeric" maxLength={6} placeholder="123456" value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            style={{ fontSize: 30, letterSpacing: ".3em", textAlign: "center", padding: "16px 0" }} />
          {err && <div style={{ color: "var(--red)", fontSize: 13.5, marginTop: 12, lineHeight: 1.5 }}>{err}</div>}
          <button className="btn btn-grn press" style={{ width: "100%", marginTop: 16, padding: 16 }} disabled={busy} onClick={go}>
            {busy ? tx("Connecting...", "Connect ho raha hai...", "\u091C\u0941\u0921\u093C \u0930\u0939\u093E \u0939\u0948...") : tx("Connect", "Jodein", "\u091C\u094B\u0921\u093C\u0947\u0902")}
          </button>
          <div className="hint" style={{ marginTop: 12, textAlign: "center" }}>
            {tx("This phone will only show the machines and the work - no rates, no money.", "Is phone par sirf machine aur kaam dikhega - rate ya paisa kuch nahi.", "\u0907\u0938 \u092B\u094B\u0928 \u092A\u0930 \u0938\u093F\u0930\u094D\u092B \u092E\u0936\u0940\u0928 \u0914\u0930 \u0915\u093E\u092E \u0926\u093F\u0916\u0947\u0917\u093E\u0964")}
          </div>
        </div>
      </div></div>
    </div></div>
  );
}

/* ================= FLOOR DEVICE: THE WORKER'S APP =================
   Five things, each two taps: start work, count pieces, finish, stop a
   machine (with a reason), move the work elsewhere. Colour carries the
   status because it reads across a noisy floor faster than any label. */
function FloorApp({ onExit }) {
  const sess = floorSession() || {};
  const [board, setBoard] = useState(null);
  const [err, setErr] = useState("");
  const [now, setNow] = useState(Date.now());
  const [openM, setOpenM] = useState(null);  /* machine uid whose sheet is open */
  const [mode, setMode] = useState("");      /* start | count | done | down | move | note */
  const [f, setF] = useState({});
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [menu, setMenu] = useState(false);

  const load = async () => {
    try { const d = await floorApi("/floor-board"); setBoard(d); setErr(""); }
    catch (e) { setErr(String((e && e.message) || "")); }
  };
  useEffect(() => { load(); const t = setInterval(load, 20000); const w = () => { if (!document.hidden) load(); };
    document.addEventListener("visibilitychange", w); return () => { clearInterval(t); document.removeEventListener("visibilitychange", w); }; }, []);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t); }, []);

  const ping = (m) => { setToast(m); setTimeout(() => setToast(""), 1800); };
  const view = floorView(board);
  const byUid = {}; view.machines.forEach((m) => { byUid[m.uid] = m; });
  const machine = openM ? byUid[openM] : null;
  const job = machine && machine.job ? view.jobs[machine.job] : null;

  const post = async (ev, okMsg) => {
    setBusy(true);
    try {
      await floorApi("/floor-event", { method: "POST", body: JSON.stringify(ev) });
      await load();
      setOpenM(null); setMode(""); setF({});
      ping(okMsg);
    } catch (e) {
      ping(tx("Not saved - check the internet", "Save nahi hua - internet dekhein", "\u0938\u0947\u0935 \u0928\u0939\u0940\u0902 \u0939\u0941\u0906"));
    }
    setBusy(false);
  };

  const since = (t) => {
    if (!t) return "";
    const mins = Math.max(0, Math.round((now - t) / 60000));
    return mins < 60 ? mins + " min" : Math.floor(mins / 60) + " hr " + (mins % 60 ? (mins % 60) + " min" : "");
  };
  const COLOR = { run: { bg: "#EAF7EB", br: "#BFE3C3", fg: "var(--grn-d)" }, down: { bg: "#FBEAEA", br: "#EFC7C2", fg: "var(--red)" }, free: { bg: "#F4F8F4", br: "var(--line)", fg: "var(--faint)" } };
  const STATUS = { run: tx("RUNNING", "CHAL RAHI", "\u091A\u0932 \u0930\u0939\u0940"), down: tx("STOPPED", "BAND", "\u092C\u0902\u0926"), free: tx("FREE", "KHAALI", "\u0916\u093E\u0932\u0940") };

  const bigBtn = (label, sub, onClick, tone) => (
    <button className="press" onClick={onClick} style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", width: "100%", padding: "16px 16px", marginBottom: 10, borderRadius: 18, textAlign: "center",
      background: tone === "grn" ? "linear-gradient(135deg,#1B7A20,#2E9E33)" : tone === "red" ? "var(--red-bg)" : "#fff",
      color: tone === "grn" ? "#fff" : tone === "red" ? "var(--red)" : "var(--ink)",
      border: tone === "grn" ? "none" : "1.5px solid " + (tone === "red" ? "#EFC7C2" : "var(--line2)") }}>
      <span style={{ display: "block", fontWeight: 700, fontSize: 17 }}>{label}</span>
      {sub && <span style={{ display: "block", fontSize: 13, opacity: .8, marginTop: 2 }}>{sub}</span>}
    </button>
  );

  const sheet = (title, children) => (
    <div onClick={() => { setMode(""); setOpenM(null); setF({}); }} style={{ position: "absolute", inset: 0, zIndex: 70, background: "rgba(16,26,20,.45)", display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
      <div className="anim-in" onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: "26px 26px 0 0", padding: "18px 18px calc(18px + env(safe-area-inset-bottom))", maxHeight: "90%", overflowY: "auto" }}>
        <div style={{ width: 40, height: 4, borderRadius: 3, background: "var(--line2)", margin: "0 auto 14px" }} />
        <div className="h-disp" style={{ fontSize: 21, fontWeight: 700, marginBottom: 14 }}>{title}</div>
        {children}
      </div>
    </div>
  );

  return (
    <div className="qk-root"><style>{CSS}</style><div className="app">
      {toast && <div className="toast">{toast}</div>}
      <div className="scr"><div className="pagepad" style={{ paddingBottom: 40 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 14 }}>
          <div>
            <div className="microlbl">{tx("SHOP FLOOR", "SHOP FLOOR", "\u0936\u0949\u092A \u092B\u094D\u0932\u094B\u0930")}</div>
            <div className="h-disp" style={{ fontSize: 24, fontWeight: 700 }}>{sess.shopName || "TrackRakho"}</div>
          </div>
          <button className="iconbtn press" onClick={() => setMenu(true)} aria-label="Menu" style={{ flexShrink: 0 }}>&#8942;</button>
        </div>

        {/* the two numbers an owner asks for, kept in front of the worker too */}
        <div className="card" style={{ padding: "14px 16px", marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "center", background: "#F3FBF4", borderColor: "#CFE9D1" }}>
          <span>
            <span className="h-disp mono" style={{ fontSize: 24, fontWeight: 700, color: "var(--grn-d)" }}>{view.todayPcs}</span>
            <span style={{ fontSize: 13.5, color: "var(--dim)", marginLeft: 6 }}>{tx("pieces today", "piece aaj", "\u092A\u0940\u0938 \u0906\u091C")}</span>
          </span>
          {view.down.length > 0 && (
            <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: "var(--red)", background: "var(--red-bg)", padding: "5px 11px", borderRadius: 999 }}>
              {view.down.length} {tx("STOPPED", "BAND", "\u092C\u0902\u0926")}
            </span>
          )}
        </div>

        {/* always reachable - a busy floor has NO free machine to tap, and that
            is exactly the moment a new job needs starting */}
        <button className="btn btn-grn press" style={{ width: "100%", padding: 16, marginBottom: 14 }}
          onClick={() => { setOpenM(""); setMode("start"); setF({ units: [] }); }}>
          <I.plus style={{ width: 17 }} /> {tx("Start a new job", "Naya kaam shuru karein", "\u0928\u092F\u093E \u0915\u093E\u092E \u0936\u0941\u0930\u0942 \u0915\u0930\u0947\u0902")}
        </button>

        {err && (
          <div className="card" style={{ padding: 16, marginBottom: 12, background: "var(--amber-bg)", borderColor: "#F0DCB8", fontSize: 13.5, color: "#7A5510", lineHeight: 1.5 }}>
            {err === "device not paired"
              ? tx("This phone is no longer connected to the shop. Ask the owner to pair it again.", "Ye phone ab shop se juda nahi hai. Maalik se dobara jodne ko kahein.", "\u092F\u0939 \u092B\u094B\u0928 \u0905\u092C \u0936\u0949\u092A \u0938\u0947 \u091C\u0941\u0921\u093C\u093E \u0928\u0939\u0940\u0902 \u0939\u0948\u0964")
              : tx("No internet - showing the last update.", "Internet nahi hai - purana data dikh raha hai.", "\u0907\u0902\u091F\u0930\u0928\u0947\u091F \u0928\u0939\u0940\u0902 \u0939\u0948\u0964")}
          </div>
        )}

        {!board && !err && <div className="mono" style={{ color: "var(--faint)", fontSize: 12, letterSpacing: ".2em", textAlign: "center", padding: 30 }}>LOADING...</div>}

        {board && view.machines.length === 0 && (
          <div className="card-tint" style={{ padding: 22, textAlign: "center", fontSize: 14, color: "var(--dim)", lineHeight: 1.6 }}>
            {tx("The owner has not added any machines yet.", "Maalik ne abhi machine nahi jodi hain.", "\u092E\u093E\u0932\u093F\u0915 \u0928\u0947 \u0905\u092D\u0940 \u092E\u0936\u0940\u0928 \u0928\u0939\u0940\u0902 \u091C\u094B\u0921\u093C\u0940\u0902\u0964")}
          </div>
        )}

        {/* the board itself - colour first, machine number big enough to match
            the sticker on the machine */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {view.machines.map((m) => {
            const c = COLOR[m.status], j = m.job ? view.jobs[m.job] : null;
            return (
              <button key={m.uid} className="press" onClick={() => { setOpenM(m.uid); setMode(""); setF({}); }}
                style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", padding: "14px 13px", borderRadius: 18, minHeight: 124,
                  background: c.bg, border: "1.5px solid " + c.br, display: "flex", flexDirection: "column" }}>
                <span className="mono" style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: ".1em", color: c.fg }}>{STATUS[m.status]}</span>
                <span className="h-disp" style={{ fontSize: 17, fontWeight: 700, marginTop: 3, lineHeight: 1.2 }}>{m.label}</span>
                {m.status === "down" && <span style={{ fontSize: 12.5, color: "var(--red)", marginTop: 4 }}>{reasonOf(m.reason).emoji} {LANG === "en" ? reasonOf(m.reason).en : reasonOf(m.reason).hi}</span>}
                {j && <span style={{ fontSize: 12.5, color: "var(--dim)", marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{j.part}</span>}
                {j && j.customer && <span style={{ fontSize: 11.5, color: "var(--faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{j.customer}</span>}
                <span style={{ flex: 1 }} />
                {m.status !== "free" && <span className="mono" style={{ fontSize: 11, color: c.fg, fontWeight: 600 }}>{j ? j.pcs + "/" + (j.qty || "?") + " pcs \u00b7 " : ""}{since(m.since)}</span>}
              </button>
            );
          })}
        </div>

        {/* shift note + recent history */}
        <button className="btn btn-ghost press" style={{ width: "100%", marginTop: 14 }} onClick={() => { setOpenM(""); setMode("note"); setF({}); }}>
          {"\u{1F4DD} " + tx("Shift note", "Shift note likhein", "\u0936\u093F\u092B\u094D\u091F \u0928\u094B\u091F")}
        </button>

        {/* grouped by day - the board carries three days, and labelling
            yesterday's count "Aaj" is how a shift report starts lying */}
        {board && (board.events || []).length > 0 && (() => {
          const days = {};
          (board.events || []).slice(0, 40).forEach((e) => { const d = startOfDay(e.at); (days[d] = days[d] || []).push(e); });
          const today = startOfDay(Date.now());
          return Object.keys(days).sort((a2, b2) => b2 - a2).map((d) => (
            <div key={d}>
              <div style={{ margin: "22px 0 8px" }}>
                <span className="eyebrow">{Number(d) === today ? tx("Today", "Aaj", "\u0906\u091C") : Number(d) === today - DAY ? tx("Yesterday", "Kal", "\u0915\u0932") : fdateShort(Number(d))}</span>
              </div>
              {days[d].map((e) => {
                const l = floorLine(e, byUid);
                return (
                  <div key={e.id} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "9px 2px", borderBottom: "1px solid var(--line)" }}>
                    <span style={{ flexShrink: 0 }}>{l.icon}</span>
                    <span style={{ flex: 1, fontSize: 13.5, color: l.bad ? "var(--red)" : "var(--ink)", lineHeight: 1.45 }}>{l.text}</span>
                    <span className="mono" style={{ flexShrink: 0, fontSize: 11, color: "var(--faint)" }}>{new Date(e.at).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}</span>
                  </div>
                );
              })}
            </div>
          ));
        })()}
      </div></div>

      {/* ---------- machine sheet ---------- */}
      {openM && !mode && machine && sheet(machine.label, (<>
        {machine.status === "down" ? (<>
          <div style={{ fontSize: 14, color: "var(--red)", marginBottom: 14 }}>
            {reasonOf(machine.reason).emoji} {LANG === "en" ? reasonOf(machine.reason).en : reasonOf(machine.reason).hi} \u00b7 {since(machine.since)}
          </div>
          {bigBtn(tx("Machine is running again", "Machine wapas chalu", "\u092E\u0936\u0940\u0928 \u092B\u093F\u0930 \u091A\u093E\u0932\u0942"), "", () => post({ kind: "up", machineUid: machine.uid }, tx("Marked running", "Chalu ho gayi", "\u091A\u093E\u0932\u0942")), "grn")}
        </>) : (<>
          {job && (
            <div className="card" style={{ padding: "12px 14px", marginBottom: 14, background: "var(--soft)" }}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>{job.part}</div>
              {job.customer && <div style={{ fontSize: 13, color: "var(--dim)" }}>{job.customer}</div>}
              <div className="mono" style={{ fontSize: 12.5, color: "var(--grn-d)", marginTop: 4 }}>{job.pcs}{job.qty ? " / " + job.qty : ""} {tx("pieces done", "piece ho chuke", "\u092A\u0940\u0938 \u0939\u094B \u091A\u0941\u0915\u0947")}</div>
            </div>
          )}
          {job
            ? (<>
                {bigBtn(tx("Add pieces", "Piece jodein", "\u092A\u0940\u0938 \u091C\u094B\u0921\u093C\u0947\u0902"), tx("how many since last time", "pichhli baar se kitne hue", ""), () => { setMode("count"); setF({ n: 0 }); }, "grn")}
                {bigBtn(tx("Work finished", "Kaam khatam", "\u0915\u093E\u092E \u0916\u0924\u094D\u092E"), "", () => { setMode("done"); setF({ good: String((job && job.pcs) || ""), rej: "" }); })}
                {bigBtn(tx("Move to another machine", "Doosri machine par bhejein", "\u0926\u0942\u0938\u0930\u0940 \u092E\u0936\u0940\u0928 \u092A\u0930"), "", () => { setMode("move"); setF({}); })}
              </>)
            : bigBtn(tx("Start work", "Kaam shuru karein", "\u0915\u093E\u092E \u0936\u0941\u0930\u0942"), "", () => { setMode("start"); setF({ units: [machine.uid] }); }, "grn")}
          {bigBtn(tx("Machine stopped", "Machine band ho gayi", "\u092E\u0936\u0940\u0928 \u092C\u0902\u0926"), "", () => { setMode("down"); setF({}); }, "red")}
        </>)}
      </>))}

      {/* ---------- start work ---------- */}
      {mode === "start" && sheet(tx("What is running?", "Kya bana rahe hain?", "\u0915\u094D\u092F\u093E \u092C\u0928 \u0930\u0939\u093E \u0939\u0948?"), (<>
        {/* the owner's open jobs, if he planned any */}
        {Object.values(view.jobs).filter((j) => !j.done).map((j) => (
          <button key={j.id} className="press" onClick={() => post({ kind: "start", machineUid: (f.units || [])[0] || (machine && machine.uid), jobId: j.id, qty: j.qty, note: j.part,
              payload: { part: j.part, customer: j.customer || "", qty: j.qty || 0, cycleMin: j.cycleMin || 0, manualMin: j.manualMin || 0, units: (f.units || []).length ? f.units : [machine && machine.uid].filter(Boolean) } }, tx("Started", "Shuru ho gaya", "\u0936\u0941\u0930\u0942"))}
            disabled={!((f.units || []).length || machine)}
            style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", width: "100%", padding: "14px 15px", marginBottom: 9, borderRadius: 16, border: "1.5px solid var(--line2)", background: "#fff", opacity: ((f.units || []).length || machine) ? 1 : 0.5 }}>
            <span style={{ display: "block", fontWeight: 700, fontSize: 16 }}>{j.part}</span>
            <span style={{ display: "block", fontSize: 13, color: "var(--dim)", marginTop: 2 }}>{[j.customer, j.qty ? j.qty + " pcs" : ""].filter(Boolean).join(" \u00b7 ")}</span>
          </button>
        ))}

        {/* a new job, with everything the ETA maths needs - the floor can
            CREATE work, not only report on the owner's plan */}
        <div style={{ borderTop: Object.keys(view.jobs).length ? "1px solid var(--line)" : "none", marginTop: Object.keys(view.jobs).length ? 12 : 0, paddingTop: Object.keys(view.jobs).length ? 14 : 0 }}>
          <label className="lbl">{tx("New job", "Naya kaam", "\u0928\u092F\u093E \u0915\u093E\u092E")}</label>
          <input className="input" placeholder={tx("part name", "part ka naam", "\u092A\u093E\u0930\u094D\u091F \u0915\u093E \u0928\u093E\u092E")} value={f.part || ""} onChange={(e) => setF({ ...f, part: e.target.value })} />
          <input className="input" placeholder={tx("customer (optional)", "customer (optional)", "\u0917\u094D\u0930\u093E\u0939\u0915 (\u0935\u0948\u0915\u0932\u094D\u092A\u093F\u0915)")} value={f.customer || ""} onChange={(e) => setF({ ...f, customer: e.target.value })} style={{ marginTop: 10 }} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
            <div>
              <label className="lbl" style={{ fontSize: 12.5 }}>{tx("How many pieces", "Kitne piece", "\u0915\u093F\u0924\u0928\u0947 \u092A\u0940\u0938")}</label>
              <input className="input mono" type="number" inputMode="numeric" placeholder="200" value={f.qty || ""} onChange={(e) => setF({ ...f, qty: e.target.value })} />
            </div>
            <div>
              <label className="lbl" style={{ fontSize: 12.5 }}>{tx("Minutes per piece", "Ek piece ka time (min)", "\u090F\u0915 \u092A\u0940\u0938 \u0915\u093E \u0938\u092E\u092F")}</label>
              <input className="input mono" type="number" inputMode="decimal" placeholder="4.5" value={f.cycleMin || ""} onChange={(e) => setF({ ...f, cycleMin: e.target.value })} />
            </div>
          </div>
          <label className="lbl" style={{ fontSize: 12.5, marginTop: 10 }}>{tx("Handling per piece (min)", "Har piece par haath ka time (min)", "\u0939\u093E\u0925 \u0915\u093E \u0938\u092E\u092F")}</label>
          <input className="input mono" type="number" inputMode="decimal" placeholder="1" value={f.manualMin == null ? "1" : f.manualMin} onChange={(e) => setF({ ...f, manualMin: e.target.value })} />

          {/* WHICH MACHINES - the same picker the owner has */}
          <label className="lbl" style={{ fontSize: 12.5, marginTop: 12 }}>{tx("Which machines will run it?", "Kaun si machine par chalega?", "\u0915\u094C\u0928 \u0938\u0940 \u092E\u0936\u0940\u0928 \u092A\u0930?")}</label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {view.machines.map((x) => {
              const bad = x.status === "down" || (x.status === "run" && !(f.units || []).includes(x.uid));
              const on = (f.units || []).includes(x.uid);
              return (
                <button key={x.uid} disabled={bad} className={"fpill press " + (on ? "on" : "")} style={bad ? { opacity: 0.45 } : undefined}
                  onClick={() => setF({ ...f, units: on ? (f.units || []).filter((y) => y !== x.uid) : [...(f.units || []), x.uid] })}>
                  {x.label}{x.status === "down" ? tx(" - band", " - band", " - \u092C\u0902\u0926") : x.status === "run" && !on ? tx(" - busy", " - busy", " - \u0935\u094D\u092F\u0938\u094D\u0924") : ""}
                </button>
              );
            })}
          </div>
          {!(f.units || []).length && (
            <span className="hint">
              {view.free.length === 0
                ? tx("Every machine is busy or stopped. Finish the work on one first (tap it, then Kaam khatam), or move that job to another machine.",
                     "Saari machine busy ya band hain. Pehle kisi machine ka kaam khatam karein (machine dabao, phir 'Kaam khatam'), ya us job ko doosri machine par bhej dein.",
                     "\u0938\u093E\u0930\u0940 \u092E\u0936\u0940\u0928 \u0935\u094D\u092F\u0938\u094D\u0924 \u092F\u093E \u092C\u0902\u0926 \u0939\u0948\u0902\u0964")
                : tx("Pick at least one machine.", "Kam se kam ek machine chuniye.", "\u0915\u092E \u0938\u0947 \u0915\u092E \u090F\u0915 \u092E\u0936\u0940\u0928 \u091A\u0941\u0928\u0947\u0902\u0964")}
            </span>
          )}

          <button className="btn btn-grn press" style={{ width: "100%", marginTop: 12, padding: 15 }}
            disabled={busy || !String(f.part || "").trim() || !(Number(f.qty) > 0) || !(f.units || []).length}
            onClick={() => post({ kind: "start", machineUid: (f.units || [])[0], jobId: "fl_" + uid(), qty: Number(f.qty) || 0, note: String(f.part || "").trim(),
              payload: { part: String(f.part || "").trim(), customer: String(f.customer || "").trim(), qty: Number(f.qty) || 0,
                cycleMin: Number(f.cycleMin) || 0, manualMin: f.manualMin == null ? 1 : Number(f.manualMin) || 0,
                units: f.units || [] } }, tx("Started", "Shuru ho gaya", "\u0936\u0941\u0930\u0942"))}>
            {tx("Start this job", "Ye kaam shuru karein", "\u092F\u0939 \u0915\u093E\u092E \u0936\u0941\u0930\u0942 \u0915\u0930\u0947\u0902")}
          </button>
          <span className="hint">{tx("The owner's app turns this into a proper job with a finish time.", "Maalik ke app mein ye poora job ban jayega - khatam hone ka time ke saath.", "")}</span>
        </div>
      </>))}

      {/* ---------- count pieces ---------- */}
      {mode === "count" && machine && sheet(tx("How many pieces?", "Kitne piece hue?", "\u0915\u093F\u0924\u0928\u0947 \u092A\u0940\u0938 \u0939\u0941\u090F?"), (<>
        <div className="h-disp mono" style={{ fontSize: 44, fontWeight: 700, textAlign: "center", color: "var(--grn-d)", margin: "4px 0 14px" }}>{Number(f.n) || 0}</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, marginBottom: 12 }}>
          {[1, 5, 10, 50].map((n) => (
            <button key={n} className="press" onClick={() => setF({ ...f, n: (Number(f.n) || 0) + n })}
              style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", textAlign: "center", padding: "15px 0", borderRadius: 14, border: "1.5px solid var(--line2)", fontWeight: 700, fontSize: 16 }}>+{n}</button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input className="input mono" type="number" inputMode="numeric" value={f.n || ""} onChange={(e) => setF({ ...f, n: e.target.value })} style={{ flex: 1, fontSize: 18, textAlign: "center" }} />
          <button className="btn btn-ghost press" onClick={() => setF({ ...f, n: 0 })}>{tx("Clear", "Mitayein", "\u092E\u093F\u091F\u093E\u090F\u0902")}</button>
        </div>
        <button className="btn btn-grn press" style={{ width: "100%", marginTop: 14, padding: 16 }} disabled={busy || !(Number(f.n) > 0)}
          onClick={() => post({ kind: "count", machineUid: machine.uid, jobId: machine.job, qty: Number(f.n) }, Number(f.n) + tx(" pieces saved", " piece likh diye", " \u092A\u0940\u0938 \u0932\u093F\u0916\u0947"))}>
          {tx("Save", "Likh dein", "\u0932\u093F\u0916 \u0926\u0947\u0902")}
        </button>
      </>))}

      {/* ---------- finish ---------- */}
      {mode === "done" && machine && sheet(tx("Work finished", "Kaam khatam", "\u0915\u093E\u092E \u0916\u0924\u094D\u092E"), (<>
        <label className="lbl">{tx("Good pieces", "Sahi piece", "\u0938\u0939\u0940 \u092A\u0940\u0938")}</label>
        <input className="input mono" type="number" inputMode="numeric" value={f.good || ""} onChange={(e) => setF({ ...f, good: e.target.value })} style={{ fontSize: 20, textAlign: "center" }} />
        <label className="lbl" style={{ marginTop: 12 }}>{tx("Rejected pieces", "Reject piece", "\u0930\u093F\u091C\u0947\u0915\u094D\u091F \u092A\u0940\u0938")}</label>
        <input className="input mono" type="number" inputMode="numeric" placeholder="0" value={f.rej || ""} onChange={(e) => setF({ ...f, rej: e.target.value })} style={{ fontSize: 20, textAlign: "center" }} />
        <span className="hint">{tx("Reject count is never a complaint - it is how the owner prices the next job.", "Reject likhne par daant nahi padti - isi se maalik agla rate sahi lagata hai.", "")}</span>
        <button className="btn btn-grn press" style={{ width: "100%", marginTop: 14, padding: 16 }} disabled={busy}
          onClick={() => post({ kind: "done", machineUid: machine.uid, jobId: machine.job, qty: Math.max(0, (Number(f.good) || 0) - ((job && job.pcs) || 0)), rej: Number(f.rej) || 0 }, tx("Job closed", "Kaam khatam likh diya", "\u0915\u093E\u092E \u092A\u0942\u0930\u093E"))}>
          {tx("Finish", "Khatam karein", "\u0916\u0924\u094D\u092E \u0915\u0930\u0947\u0902")}
        </button>
      </>))}

      {/* ---------- stop the machine ---------- */}
      {mode === "down" && machine && sheet(tx("Why did it stop?", "Machine kyun band hui?", "\u092E\u0936\u0940\u0928 \u0915\u094D\u092F\u094B\u0902 \u092C\u0902\u0926 \u0939\u0941\u0908?"), (<>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9 }}>
          {FLOOR_REASONS.map((r) => (
            <button key={r.key} className="press" onClick={() => setF({ ...f, reason: r.key })}
              style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", textAlign: "center", padding: "15px 8px", borderRadius: 16,
                border: "1.5px solid " + (f.reason === r.key ? "var(--red)" : "var(--line2)"), background: f.reason === r.key ? "var(--red-bg)" : "#fff" }}>
              <span style={{ display: "block", fontSize: 22 }}>{r.emoji}</span>
              <span style={{ display: "block", fontWeight: 700, fontSize: 13.5, marginTop: 4 }}>{LANG === "en" ? r.en : r.hi}</span>
            </button>
          ))}
        </div>
        <input className="input" placeholder={tx("anything to add (optional)", "kuch kehna hai? (optional)", "\u0915\u0941\u091B \u0915\u0939\u0928\u093E \u0939\u0948?")} value={f.note || ""} onChange={(e) => setF({ ...f, note: e.target.value })} style={{ marginTop: 12 }} />
        <button className="btn press" style={{ width: "100%", marginTop: 14, padding: 16, background: "var(--red)", color: "#fff", border: "none" }} disabled={busy || !f.reason}
          onClick={() => post({ kind: "down", machineUid: machine.uid, machineLabel: machine.label, reason: f.reason, note: f.note || "" }, tx("Owner has been told", "Maalik ko bata diya", "\u092E\u093E\u0932\u093F\u0915 \u0915\u094B \u092C\u0924\u093E \u0926\u093F\u092F\u093E"))}>
          {tx("Tell the owner", "Maalik ko batayein", "\u092E\u093E\u0932\u093F\u0915 \u0915\u094B \u092C\u0924\u093E\u090F\u0902")}
        </button>
      </>))}

      {/* ---------- move the work ---------- */}
      {mode === "move" && machine && sheet(tx("Move to which machine?", "Kis machine par bhejein?", "\u0915\u093F\u0938 \u092E\u0936\u0940\u0928 \u092A\u0930?"), (<>
        {view.free.length === 0 && <div style={{ fontSize: 14, color: "var(--dim)", lineHeight: 1.6 }}>{tx("No machine is free right now.", "Abhi koi machine khaali nahi hai.", "\u0905\u092D\u0940 \u0915\u094B\u0908 \u092E\u0936\u0940\u0928 \u0916\u093E\u0932\u0940 \u0928\u0939\u0940\u0902\u0964")}</div>}
        {view.free.map((m2) => (
          <button key={m2.uid} className="press" onClick={() => post({ kind: "move", machineUid: m2.uid, fromUid: machine.uid, jobId: machine.job, qty: Math.max(0, (job && job.qty ? job.qty : 0) - (machine.pcs || 0)) }, tx("Moved", "Bhej diya", "\u092D\u0947\u091C \u0926\u093F\u092F\u093E"))}
            style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", width: "100%", padding: "16px 15px", marginBottom: 9, borderRadius: 16, border: "1.5px solid var(--line2)", background: "#fff", fontWeight: 700, fontSize: 16 }}>
            {m2.label}
          </button>
        ))}
      </>))}

      {/* ---------- shift note ---------- */}
      {mode === "note" && sheet(tx("Shift note", "Shift note", "\u0936\u093F\u092B\u094D\u091F \u0928\u094B\u091F"), (<>
        <textarea className="input" rows={4} placeholder={tx("Anything the owner should know", "Maalik ko kya batana hai", "\u092E\u093E\u0932\u093F\u0915 \u0915\u094B \u0915\u094D\u092F\u093E \u092C\u0924\u093E\u0928\u093E \u0939\u0948")} value={f.note || ""} onChange={(e) => setF({ ...f, note: e.target.value })} style={{ resize: "none", lineHeight: 1.5 }} />
        <button className="btn btn-grn press" style={{ width: "100%", marginTop: 12, padding: 15 }} disabled={busy || !String(f.note || "").trim()}
          onClick={() => post({ kind: "note", note: String(f.note || "").trim() }, tx("Sent", "Bhej diya", "\u092D\u0947\u091C \u0926\u093F\u092F\u093E"))}>
          {tx("Send to owner", "Maalik ko bhejein", "\u092E\u093E\u0932\u093F\u0915 \u0915\u094B \u092D\u0947\u091C\u0947\u0902")}
        </button>
      </>))}

      {/* ---------- device menu ---------- */}
      {menu && (
        <div onClick={() => setMenu(false)} style={{ position: "absolute", inset: 0, zIndex: 80, background: "rgba(16,26,20,.45)", display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
          <div className="anim-in" onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: "26px 26px 0 0", padding: "18px 18px calc(18px + env(safe-area-inset-bottom))" }}>
            <div style={{ width: 40, height: 4, borderRadius: 3, background: "var(--line2)", margin: "0 auto 16px" }} />
            <button className="btn btn-ghost press" style={{ width: "100%", marginBottom: 10 }} onClick={() => { setMenu(false); load(); }}>{tx("Refresh", "Refresh", "\u0930\u093F\u092B\u094D\u0930\u0947\u0936")}</button>
            <button className="btn btn-ghost press" style={{ width: "100%", color: "var(--red)" }} onClick={() => { floorSave(null); onExit(); }}>{tx("Remove this phone from the shop", "Is phone ko shop se hatayein", "\u0907\u0938 \u092B\u094B\u0928 \u0915\u094B \u0939\u091F\u093E\u090F\u0902")}</button>
            <div className="hint" style={{ textAlign: "center", marginTop: 12 }}>{tx("Nothing from the shop is stored on this phone.", "Is phone par shop ka koi data nahi rakha jaata.", "\u0907\u0938 \u092B\u094B\u0928 \u092A\u0930 \u0936\u0949\u092A \u0915\u093E \u0921\u0947\u091F\u093E \u0928\u0939\u0940\u0902 \u0930\u0939\u0924\u093E\u0964")}</div>
          </div>
        </div>
      )}
    </div></div>
  );
}

/* ================= HOME ================= */
function Home({ data, account, onNew, onLog, goQuotes, openAnalytics, openClient, tallyRows = null, tallyBal = null, goSetup, goSubscribe, openCo, startTut, dismissTut, clearDemo }) {
  const ind = industryOf(data);
  const isMach = ind.key === "machining";
  const h = new Date().getHours();
  const greet = h < 12 ? tx("Good morning", "Good morning", "सुप्रभात") : h < 17 ? tx("Good afternoon", "Good afternoon", "नमस्कार") : tx("Good evening", "Good evening", "शुभ संध्या");

  /* ---- the numbers that actually matter to an owner ---- */
  const m0 = new Date(); m0.setDate(1); m0.setHours(0, 0, 0, 0);
  const month = data.quotes.filter((q) => q.at >= m0.getTime());
  const monthQuoted = month.reduce((s, q) => s + q.total, 0);
  const monthWon = month.filter((q) => q.status === "won");
  const monthWonVal = monthWon.reduce((s, q) => s + q.total, 0);
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
  /* scrap: the day runs on open orders - how much maal went, how much is left */
  const isScrap = ind.key === "scrap";
  const ongoing = isScrap ? ongoingOrders(data, tallyRows, tallyBal) : [];

  /* category tiles: printing shows active ones, furniture shows the full range */
  const showCats = ind.key === "printing" || ind.key === "furniture";
  const catStats = showCats
    ? (ind.cats || []).filter((c) => c.key !== "other").map((c) => {
        const qs = data.quotes.filter((x) => catOf(x, ind) === c.key);
        return { ...c, total: qs.length, ongoing: qs.filter((x) => x.status === "pending").length };
      }).filter((c) => ind.key === "furniture" || c.total > 0)
    : [];

  const kpis = [
    [inr(pendingValue), tx("PENDING VALUE", "PENDING VALUE", "पेंडिंग रकम"), "var(--amber)", () => goQuotes("pending")],
    [inr(monthWonVal), tx("WON THIS MONTH", "WON THIS MONTH", "इस महीने जीते"), "#1B7A20", () => goQuotes("won")],
    [inr(monthQuoted), tx("QUOTED THIS MONTH", "QUOTED THIS MONTH", "इस महीने के कोटेशन"), "var(--grn-d)", () => goQuotes("all")],
    ["📊", tx("ANALYTICS", "ANALYTICS", "एनालिटिक्स"), "var(--grn-d)", openAnalytics],
  ];

  return (
    <div className="scr"><div className="pagepad">
      <div className="anim-in" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
        <div>
          <div className="microlbl">{new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short" })}</div>
          <div className="h-disp" style={{ fontSize: 25, fontWeight: 700, marginTop: 3 }}>{greet}</div>
          <div style={{ fontSize: 14, color: "var(--dim)" }}>{data.shopName} · {ind.label}</div>
        </div>
        <button onClick={openCo || goSetup} aria-label="Switch company" className="press" style={{ width: 46, height: 46, borderRadius: 15, background: "linear-gradient(135deg,#2E9E33,#155E18)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--mono)", fontWeight: 600, fontSize: 14, boxShadow: "var(--sh-s)", border: "none", cursor: "pointer" }}>
          {data.shopName.split(" ").map((w) => w[0]).slice(0, 2).join("")}
        </button>
      </div>

      {/* Example data is never allowed to pass itself off as the owner's own
          work - it says so, and it leaves in one tap. */}
      {hasDemo(data) && (
        <div className="card anim-in" style={{ padding: "13px 15px", marginBottom: 12, background: "var(--amber-bg)", borderColor: "#F0DCB8", display: "flex", alignItems: "center", gap: 11 }}>
          <span style={{ fontSize: 19, flexShrink: 0 }} aria-hidden="true">{"\u{1F441}\uFE0F"}</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: "block", fontWeight: 700, fontSize: 14, color: "#7A5510" }}>{tx("This is example data", "Ye example data hai", "\u092F\u0939 \u0909\u0926\u093E\u0939\u0930\u0923 \u0921\u0947\u091F\u093E \u0939\u0948")}</span>
            <span style={{ display: "block", fontSize: 12.5, color: "#7A5510", marginTop: 1, lineHeight: 1.45 }}>
              {tx("Not your customers. Remove it when you are ready to start.", "Ye aapke customer nahi hain. Apna kaam shuru karte waqt hata dijiye.", "\u092F\u0939 \u0906\u092A\u0915\u0947 \u0917\u094D\u0930\u093E\u0939\u0915 \u0928\u0939\u0940\u0902 \u0939\u0948\u0902\u0964")}
            </span>
          </span>
          {clearDemo && <button className="btn btn-sm btn-soft press" style={{ flexShrink: 0 }} onClick={clearDemo}>{tx("Remove", "Hata dein", "\u0939\u091F\u093E\u090F\u0902")}</button>}
        </div>
      )}

      {/* An empty app is not a broken app - but it must say what to do next.
          Three steps, each one tap away, gone the moment they are done. */}
      {(() => {
        const steps = [
          { k: "name", done: !!String(data.shopName || "").trim(), t: tx("Add your shop name", "Apni shop ka naam likhein", "\u0905\u092A\u0928\u0940 \u0926\u0941\u0915\u093E\u0928 \u0915\u093E \u0928\u093E\u092E"), go: goSetup },
          { k: "quote", done: (data.quotes || []).some((q) => !q.seed), t: tx("Log your first quote - 30 seconds", "Pehla quote likhein - 30 second", "\u092A\u0939\u0932\u093E \u0915\u094B\u091F\u0947\u0936\u0928 - 30 \u0938\u0947\u0915\u0902\u0921"), go: onLog },
          isMach
            ? { k: "mach", done: (data.machines || []).length > 0, t: tx("Add a machine and its hourly rate", "Apni machine aur uska rate jodein", "\u092E\u0936\u0940\u0928 \u0914\u0930 \u0930\u0947\u091F \u091C\u094B\u0921\u093C\u0947\u0902"), go: goSetup }
            : { k: "truck", done: (data.trucks || []).length > 0, t: tx("Add your trucks", "Apni gaadiyan jodein", "\u0905\u092A\u0928\u0940 \u0917\u093E\u0921\u093C\u093F\u092F\u093E\u0902 \u091C\u094B\u0921\u093C\u0947\u0902"), go: goSetup },
        ];
        const left = steps.filter((x) => !x.done).length;
        if (!left) return null;
        return (
          <div className="card anim-in st1" style={{ padding: "15px 16px", marginBottom: 12, border: "1.5px solid #CFE9D1", background: "#F7FCF8" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
              <span className="eyebrow">{tx("Get started", "Shuru karein", "\u0936\u0941\u0930\u0942 \u0915\u0930\u0947\u0902")}</span>
              <span className="mono" style={{ fontSize: 11, color: "var(--grn-d)", fontWeight: 600 }}>{steps.length - left}/{steps.length}</span>
            </div>
            {steps.map((x) => (
              <button key={x.k} className="press" onClick={x.done ? undefined : x.go} disabled={x.done}
                style={{ all: "unset", boxSizing: "border-box", cursor: x.done ? "default" : "pointer", width: "100%", display: "flex", alignItems: "center", gap: 11, padding: "9px 0" }}>
                <span style={{ width: 24, height: 24, borderRadius: "50%", flexShrink: 0, display: "grid", placeItems: "center", fontSize: 13, fontWeight: 700,
                  background: x.done ? "var(--grn-100)" : "#fff", border: "1.5px solid " + (x.done ? "#CFE9D1" : "var(--line2)"), color: x.done ? "var(--grn-d)" : "var(--faint)" }}>
                  {x.done ? "\u2713" : ""}
                </span>
                <span style={{ flex: 1, fontSize: 14.5, fontWeight: x.done ? 400 : 600, color: x.done ? "var(--faint)" : "var(--ink)", textDecoration: x.done ? "line-through" : "none" }}>{x.t}</span>
                {!x.done && <I.chev style={{ color: "var(--faint)", flexShrink: 0 }} />}
              </button>
            ))}
          </div>
        );
      })()}

      {/* at a glance - same KPI language as Analytics */}
      <div className="card anim-in st1" style={{ padding: "16px 16px 12px", marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <span className="eyebrow">{tx("At a glance", "At a glance", "एक नज़र में")}</span>
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
          <button className="btn btn-grn press" style={{ padding: 16 }} onClick={onLog}><I.bolt /> {tx("Log a quote", "Log a quote", "कोटेशन लिखें")}</button>
          <button className="btn btn-ghost press" style={{ padding: 16 }} onClick={onNew}><I.plus style={{ width: 17 }} /> {tx("Full quote", "Full quote", "पूरा कोटेशन")}</button>
        </div>
      ) : (
        <button className="btn btn-grn press anim-in st2" style={{ width: "100%", padding: 16 }} onClick={onLog}><I.bolt /> {tx("Log a quote", "Log a quote", "कोटेशन लिखें")}</button>
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
            <div style={{ fontSize: 13.5, fontWeight: 700, marginTop: 1 }}>{tx("RFQs open", "RFQs open", "RFQ खुले")}</div>
            <div className="mono" style={{ fontSize: 11.5, color: "var(--faint)", marginTop: 2 }}>{inr(pendingValue)}{tx(" on the table", " on the table", " दांव पर")}</div>
          </button>
          <button className="press" onClick={() => goQuotes("won")} style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", padding: "16px 15px", borderRadius: 20, background: "#fff", border: "1px solid var(--line)", boxShadow: "var(--sh-s)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ width: 40, height: 40, borderRadius: 12, background: "var(--grn-100)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 19 }}>📦</span>
              <I.chev style={{ color: "var(--faint)" }} />
            </div>
            <div className="h-disp mono" style={{ fontSize: 24, fontWeight: 700, marginTop: 10 }}>{wonQs.length}</div>
            <div style={{ fontSize: 13.5, fontWeight: 700, marginTop: 1 }}>{tx("Orders ongoing", "Orders ongoing", "ऑर्डर चालू")}</div>
            <div className="mono" style={{ fontSize: 11.5, color: "var(--faint)", marginTop: 2 }}>{inr(wonValue)}{tx(" won", " won", " जीते")}</div>
          </button>
        </div>
      )}

      {/* machine floor, truck board and yard stock live on the Work tab,
         Tally on Money - home is the morning glance only */}

      {dueList.length > 0 && (
        <button onClick={() => goQuotes("due")} className="press anim-in st3" style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", width: "100%", marginTop: 12, display: "flex", alignItems: "center", gap: 12, padding: "15px 16px", borderRadius: 18, background: "var(--amber-bg)", border: "1px solid #F0DCB8" }}>
          <span style={{ width: 40, height: 40, borderRadius: 12, background: "#fff", color: "var(--amber)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><I.bell /></span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: "block", fontWeight: 700, fontSize: 15, color: "var(--amber)" }}>{LANG === "hi" ? dueList.length + " फॉलो-अप बाकी" : dueList.length + " follow-up" + (dueList.length === 1 ? "" : "s") + " due"}</span>
            <span style={{ display: "block", fontSize: 13, color: "#7A5510", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{dueList.slice(0, 2).map((q) => q.customer).join(", ")}{dueList.length > 2 ? " +" + (dueList.length - 2) + " more" : ""}</span>
          </span>
          <I.chev style={{ color: "var(--amber)" }} />
        </button>
      )}


      {catStats.length > 0 && (<>
        <div className="anim-in st3" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "24px 0 10px" }}>
          <span className="eyebrow">{LANG === "hi" ? "श्रेणी से देखें" : "Browse by " + (ind.key === "furniture" ? "product" : "job type")}</span>
          <button onClick={() => goQuotes("all")} style={{ background: "none", border: "none", color: "var(--grn-d)", fontWeight: 600, fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center" }}>{tx("All", "All", "सभी")} <I.chev /></button>
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

      {startTut && !data.settings.tutHomeDone && (
        <div className="card anim-in st3" style={{ padding: "13px 15px", marginTop: 12, display: "flex", alignItems: "center", gap: 11, border: "1.5px solid #CFE9D1", background: "#F7FCF8" }}>
          <span style={{ fontSize: 20, flexShrink: 0 }} aria-hidden="true">&#127891;</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 14.5 }}>{tx("New here? Learn in 2 minutes", "Naye ho? 2 minute mein seekho", "\u0928\u090F \u0939\u0948\u0902? 2 \u092E\u093F\u0928\u091F \u092E\u0947\u0902 \u0938\u0940\u0916\u0947\u0902")}</div>
            <div style={{ fontSize: 12.5, color: "var(--dim)" }}>{tx("The app walks you through it, step by step.", "App khud aapko step-by-step sikhata hai.", "\u0910\u092A \u0916\u0941\u0926 \u0906\u092A\u0915\u094B \u0938\u094D\u091F\u0947\u092A-\u092C\u093E\u092F-\u0938\u094D\u091F\u0947\u092A \u0938\u093F\u0916\u093E\u0924\u093E \u0939\u0948\u0964")}</div>
          </div>
          <button className="btn btn-grn btn-sm press" onClick={() => startTut("walog")}>{tx("Start", "Seekho", "\u0938\u0940\u0916\u0947\u0902")}</button>
          <button className="press" onClick={dismissTut} aria-label="Dismiss" style={{ all: "unset", cursor: "pointer", color: "var(--faint)", fontSize: 18, padding: 4 }}>&#215;</button>
        </div>
      )}

      <div className="anim-in st3" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "24px 0 10px" }}>
        <span className="eyebrow">{isScrap ? tx("Ongoing orders", "Chalu orders", "चालू ऑर्डर") : tx("Recent quotes", "Recent quotes", "हाल के कोटेशन")}</span>
        <button onClick={() => goQuotes(isScrap ? "won" : "all")} style={{ background: "none", border: "none", color: "var(--grn-d)", fontWeight: 600, fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center" }}>{tx("All", "All", "सभी")} <I.chev /></button>
      </div>

      {/* scrap: every open order with a sent / left bar - tap = that client's page */}
      {isScrap && ongoing.length === 0 && (
        <div className="card-tint anim-in st4" style={{ padding: "18px 16px", fontSize: 14, color: "var(--dim)", lineHeight: 1.55, marginBottom: 10 }}>
          {tx("No order is open right now. Mark a quote WON and it shows up here - how much maal went, how much is left.",
              "Abhi koi order chalu nahi. Quote ko WON karo - yahan dikhega kitna maal gaya, kitna baki.",
              "अभी कोई ऑर्डर चालू नहीं। कोटेशन को WON करें - यहां दिखेगा कितना माल गया, कितना बाकी।")}
        </div>
      )}
      {isScrap && ongoing.slice(0, 5).map((o, i) => {
        const pct = o.qty ? Math.min(100, (o.sent / o.qty) * 100) : 0;
        return (
          <button key={o.q.id} onClick={() => openClient(o.q.customer)} className={"press anim-in st" + Math.min(8, 4 + i)}
            style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", display: "block", width: "100%", padding: "14px 15px 13px", marginBottom: 10, background: "#fff", border: "1px solid var(--line)", borderRadius: 22, boxShadow: "var(--sh-s)" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span className="mono" style={{ width: 44, height: 44, borderRadius: 13, background: "var(--grn-100)", color: "var(--grn-d)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 600, flexShrink: 0 }}>{initialsOf(o.q.customer)}</span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <span style={{ display: "block", fontWeight: 700, fontSize: 15.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{o.q.customer}</span>
                <span style={{ display: "block", fontSize: 13, color: "var(--dim)", marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{o.q.part}</span>
              </span>
              <span className="mono" style={{ fontWeight: 600, fontSize: 14.5, flexShrink: 0 }}>{fmtQty(o.qty)} {ind.unit}</span>
              <I.chev style={{ color: "var(--faint)", flexShrink: 0 }} />
            </span>
            <span style={{ display: "block", height: 8, borderRadius: 99, background: "var(--soft)", border: "1px solid var(--line)", overflow: "hidden", marginTop: 12 }}>
              <span style={{ display: "block", height: "100%", width: pct + "%", minWidth: o.sent > 0 ? 6 : 0, borderRadius: 99, background: "linear-gradient(90deg,#2E9E33,#5DBB63)" }} />
            </span>
            <span className="mono" style={{ display: "flex", justifyContent: "space-between", gap: 10, marginTop: 7, fontSize: 12.5, fontWeight: 600 }}>
              <span style={{ color: "var(--grn-d)" }}>{fmtQty(o.sent)} {ind.unit} {tx("sent", "gaya", "गया")}</span>
              <span style={{ color: "var(--amber)" }}>{fmtQty(o.remaining)} {ind.unit} {tx("left", "baki", "बाकी")}</span>
            </span>
            {o.onRoad > 0 && (
              <span style={{ display: "block", fontSize: 12.5, color: "var(--dim)", marginTop: 4 }}>
                {"\u{1F69A} " + fmtQty(o.onRoad) + " " + ind.unit + tx(" on the road right now", " abhi raste mein", " अभी रास्ते में")}
              </span>
            )}
          </button>
        );
      })}
      {isScrap && ongoing.length > 5 && (
        <button onClick={() => goQuotes("won")} className="btn btn-ghost btn-sm press" style={{ width: "100%", marginBottom: 10 }}>
          {"+" + (ongoing.length - 5) + tx(" more orders", " aur orders", " और ऑर्डर")}
        </button>
      )}

      {!isScrap && recent.map((q, i) => (
        <button key={q.id} onClick={() => goQuotes("all")} className={"card press anim-in st" + (4 + i)}
          style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", display: "flex", alignItems: "center", gap: 12, padding: "14px 15px", marginBottom: 10, background: "#fff", border: "1px solid var(--line)", borderRadius: 22, width: "100%", boxShadow: "var(--sh-s)" }}>
          {q.image ? (
            <img src={q.image} alt="" style={{ width: 54, height: 54, borderRadius: 13, objectFit: "cover", flexShrink: 0, border: "1px solid var(--line2)" }} />
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
          <span style={{ flex: 1, fontSize: 13.5, fontWeight: 600 }}>{tx("Unlock everything - one plan", "Sab kuch unlock karo - ek hi plan", "सब कुछ अनलॉक करें - एक ही प्लान")}</span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 12, background: "rgba(255,255,255,.2)", padding: "5px 10px", borderRadius: 999 }}>₹999/mo ›</span>
        </button>
      )}

      {isMach && data.machines[0] && (
        <div className="card-tint anim-in st7" style={{ padding: "15px 16px", display: "flex", gap: 10, alignItems: "center", marginTop: 10 }}>
          <span style={{ color: "var(--grn)" }}><I.bolt /></span>
          <span style={{ fontSize: 13.5, color: "var(--dim)" }}>{tx("Your ", "Your ", "आपकी ")}{data.machines[0].name}{tx("'s true rate is ", "'s true rate is ", " की असली दर है ")}<b className="mono" style={{ color: "var(--grn-d)" }}>{inr(data.machines[0].rate || 0)}/hr</b>{tx(" - every quote uses it automatically.", " - every quote uses it automatically.", " - हर कोटेशन में अपने आप लगती है।")}</span>
        </div>
      )}

      <div className="card-tint anim-in st7" style={{ padding: "15px 16px", display: "flex", gap: 10, alignItems: "center", marginTop: 10 }}>
        <span aria-hidden="true" style={{ flexShrink: 0 }}>&#128274;</span>
        <span style={{ fontSize: 13.5, color: "var(--dim)", lineHeight: 1.55 }}>{tx("Your data belongs only to your shop - nobody else can see it, and it is never shared or sold.", "Aapka data sirf aapki shop ka hai - kisi aur ko nahi dikhta, kabhi share ya sell nahi hota.", "आपका डेटा सिर्फ आपकी दुकान का है - किसी और को नहीं दिखता, कभी शेयर या बेचा नहीं जाता।")}</span>
      </div>
    </div></div>
  );
}

/* ================= QUICK LOG (tracker-first 30-second entry) ================= */
function QuickLog({ data, onSave, onExit, ping, startTut }) {
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
          <button className="btn btn-sm btn-soft press" data-tut="paste-btn" onClick={() => setPasteOpen(!pasteOpen)}><I.wa /> Paste</button>
          {startTut && <button className="btn btn-sm btn-ghost press" aria-label="Learn this screen" style={{ fontWeight: 700, minWidth: 40 }} onClick={() => startTut("walog")}>?</button>}
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
        <button className="btn btn-grn press" data-tut="ql-save" style={{ width: "100%" }} onClick={save} disabled={!ok}><I.check2 /> Save to pipeline</button>
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

function Quotes({ data, setStatus, updateQuote, delQuote, importQuotes, ping, filter, setFilter, cat = null, setCat, onLog, enquiries = [], logEnquiry, dismissEnquiry, waOn, refreshEnquiries, tallyBal = null, sendToFloor, startTut }) {
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
  /* a picked category stays in the list even when its last quote is gone */
  const catsPresent = (ind.cats || []).filter((c) => catCounts[c.key] || c.key === cat);
  const catAll = { machining: tx("Processes", "Processes", "प्रोसेस"), scrap: tx("Materials", "Materials", "मटीरियल"),
    printing: tx("All job types", "Saare job", "सभी जॉब"), furniture: tx("All products", "Saare product", "सभी प्रोडक्ट") }[ind.key] || tx("All types", "Saare types", "सभी प्रकार");
  /* status counts follow the category pick, so the numbers match the list */
  const inCat = data.quotes.filter((x) => !cat || catOf(x, ind) === cat);
  const segCount = { all: inCat.length, pending: 0, won: 0, lost: 0 };
  inCat.forEach((x) => { if (segCount[x.status] != null) segCount[x.status]++; });

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
        <div style={{ display: "flex", gap: 8 }}>
          {startTut && <button className="btn btn-sm btn-ghost press" aria-label="Learn this screen" style={{ fontWeight: 700, minWidth: 40 }} onClick={() => startTut("pipeline")}>?</button>}
          <button className="btn btn-sm btn-soft press" disabled={busy} onClick={() => setXlOpen(true)}>
            <I.sheet style={{ width: 16, height: 16 }} /> Excel
          </button>
        </div>
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
            <div key={e.id} data-tut={e.demo ? "enq-card" : undefined} className="card" style={{ padding: "14px 15px", marginTop: 10, border: "1px solid #CBEAD2", background: "#F3FBF4" }}>
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
                <button className="btn btn-sm btn-soft press" data-tut={e.demo ? "enq-log" : undefined} onClick={() => logEnquiry(e)}><I.bolt /> Log as quote</button>
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

      {/* filters - one segmented status control, then ONE row: follow-ups
          and a dropdown for the process/material (a wrapping pill cloud plus a
          sideways-scrolling chip row read as clutter to owners) */}
      <div className="anim-in st1" data-tut="pipe-filters" style={{ marginBottom: 16 }}>
        <div className="segq" role="tablist">
          {[["pending", tx("Pending", "Pending", "पेंडिंग")], ["won", tx("Won", "Won", "जीते")], ["lost", tx("Lost", "Lost", "गए")], ["all", tx("All", "All", "सभी")]].map(([k, l]) => (
            <button key={k} role="tab" aria-selected={filter === k} className={"press" + (filter === k ? " on" : "")} onClick={() => setFilter(k)}>
              {l}<span className="mono">{segCount[k]}</span>
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <button className={"fuchip press" + (filter === "due" ? " on" : dueCount ? " hot" : "")} onClick={() => setFilter(filter === "due" ? "all" : "due")}>
            <I.bell style={{ width: 16, height: 16 }} /> {tx("Follow-ups", "Follow-ups", "फॉलो-अप")}{dueCount ? " · " + dueCount : ""}
          </button>
          {catsPresent.length > 0 && setCat && (
            <label className={"selpill" + (cat ? " on" : "")}>
              <select aria-label={catAll} value={cat || ""} onChange={(e) => setCat(e.target.value || null)}>
                <option value="">{catAll}</option>
                {catsPresent.map((c) => <option key={c.key} value={c.key}>{c.emoji} {c.label} ({catCounts[c.key] || 0})</option>)}
              </select>
              <I.chev />
            </label>
          )}
        </div>
      </div>

      {/* heading above the quote list */}
      <div className="anim-in st2" data-tut="pipe-list" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", margin: "4px 0 10px" }}>
        <span className="eyebrow">{filter === "all" ? tx("All quotes", "All quotes", "सभी कोटेशन") : filter === "pending" ? tx("Pending quotes", "Pending quotes", "पेंडिंग कोटेशन") : filter === "won" ? tx("Won orders", "Won orders", "जीते ऑर्डर") : filter === "lost" ? tx("Lost quotes", "Lost quotes", "गए कोटेशन") : tx("Follow-ups due", "Follow-ups due", "फॉलो-अप बाकी")}</span>
        <span className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>{list.length}</span>
      </div>

      {/* Filtered-empty and truly-empty are different problems: one needs a
          different filter, the other needs a first quote. */}
      {list.length === 0 && (term || filter !== "all" || data.quotes.length > 0) && (
        <div className="card-tint anim-in st2" style={{ padding: 28, textAlign: "center", color: "var(--dim)", fontSize: 14.5 }}>
          {tx("No quotes match.", "Is filter mein kuch nahi hai.", "इस फ़िल्टर में कुछ नहीं है।")}
        </div>
      )}

      {/* A brand-new pipeline: the fastest route to a REAL first row is doing
          it once with the app guiding the hand, so that is the hero. Below it,
          the shape of the page - never invented numbers. */}
      {data.quotes.length === 0 && !term && (
        <div className="anim-in st2">
          {startTut && (
            <button className="press" onClick={() => startTut("walog")}
              style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", width: "100%", display: "flex", alignItems: "center", gap: 14, padding: 18, borderRadius: 20, background: "linear-gradient(135deg,#1B7A20,#2E9E33)", color: "#fff", boxShadow: "var(--sh-m)", marginBottom: 10 }}>
              <span style={{ fontSize: 26, flexShrink: 0 }} aria-hidden="true">{"\u{1F393}"}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontWeight: 700, fontSize: 16.5 }}>{tx("Show me how - 2 minutes", "2 minute mein seekhein", "2 मिनट में सीखें")}</span>
                <span style={{ display: "block", fontSize: 13, color: "rgba(255,255,255,.88)", marginTop: 2, lineHeight: 1.45 }}>
                  {tx("A real WhatsApp enquiry becomes your first quote, step by step.", "Ek asli WhatsApp enquiry se aapka pehla quote banega - step by step.", "एक असली WhatsApp एन्क्वायरी से आपका पहला कोटेशन बनेगा।")}
                </span>
              </span>
              <I.chev />
            </button>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <button className="btn btn-soft press" style={{ padding: 14, justifyContent: "center" }} onClick={onLog}>
              <I.bolt /> {tx("Log a quote", "Quote likhein", "कोटेशन लिखें")}
            </button>
            <button className="btn btn-ghost press" style={{ padding: 14, justifyContent: "center" }} onClick={() => setXlOpen(true)}>
              <I.sheet style={{ width: 16, height: 16 }} /> {tx("Bring from Excel", "Excel se laayein", "Excel से लाएं")}
            </button>
          </div>
          <div className="hint" style={{ textAlign: "center", marginTop: 10 }}>
            {tx("Already keep your quotes in a sheet? Bring them in and the pipeline fills itself.", "Excel mein pehle se quotes hain? Wahi le aayein - pipeline apne aap bhar jayegi.", "Excel में पहले से कोटेशन हैं? वही ले आएं।")}
          </div>
          <div style={{ marginTop: 22 }}>
            <GhostPreview rows={3} caption={tx("HOW IT WILL LOOK", "PEHLA QUOTE AATE HI AISA DIKHEGA", "पहला कोटेशन आते ही ऐसा दिखेगा")} />
          </div>
        </div>
      )}

      {list.map((q, i) => {
        const fs = followState(q);
        const pill = q.status === "won" ? "won" : q.status === "lost" ? "lost" : "pend";
        /* outstanding balance from Tally (via the opt-in connector), matched by customer name */
        const tBal = tallyBal && q.customer ? tallyBal[String(q.customer).trim().toLowerCase()] : null;
        return (
          <div key={q.id} data-tut={i === 0 ? "pipe-first" : undefined} className={"card anim-in st" + Math.min(8, i + 2)} style={{ padding: "16px 16px", marginBottom: 10, borderColor: fs === "overdue" ? "#F0DCB8" : undefined }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }} onClick={() => setOpen(open === q.id ? null : q.id)}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0, flex: 1 }}>
              {q.image ? (
                <img src={q.image} alt="" onClick={(ev) => { ev.stopPropagation(); setViewImg(q.image); }}
                  style={{ width: 62, height: 62, borderRadius: 14, objectFit: "cover", flexShrink: 0, border: "1px solid var(--line2)", cursor: "zoom-in" }} />
              ) : (
                <span style={{ width: 62, height: 62, borderRadius: 14, background: "var(--grn-100)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 26, flexShrink: 0 }}>{catMeta(ind, catOf(q, ind)).emoji}</span>
              )}
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                  <span style={{ fontWeight: 600, fontSize: 15.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{q.customer}</span>
                  {q.seed && <span className="mono" style={{ flexShrink: 0, fontSize: 9, fontWeight: 700, letterSpacing: ".08em", color: "var(--amber)", background: "var(--amber-bg)", padding: "2px 6px", borderRadius: 999 }}>SAMPLE</span>}
                </div>
                <div style={{ fontSize: 13.5, color: "var(--dim)", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{q.part}{q.qty ? " · " + fmtQty(q.qty) + " " + (ind.unit || "pcs") : ""} · {fdate(q.at)}</div>
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
                  {ind.key === "machining" && q.qty > 0 && sendToFloor && <button className="btn btn-sm btn-soft press" onClick={() => sendToFloor(q)}>🛠️ {tx("Send to floor", "Floor pe bhejo", "फ्लोर पर भेजें")}</button>}
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
/* ---- MSMED s.16 "kanooni byaj" on late bills (MSMED_LEVERAGE.md, 2026-08-09).
   3x RBI Bank Rate, compound with monthly rests, from the due date. s.15 caps
   credit at 45 days even with a written agreement, so interest starts at
   min(due, bill date + 45d) - and bill+45d when no due date exists. Both
   choices UNDERSTATE (no-written-agreement law says 15 days; interest on the
   CURRENT pending ignores that a bigger principal existed before part
   payments) - an andaza that is never an overclaim. Gating is a legal
   requirement, not a preference: TRADERS ARE EXCLUDED from the MSMED
   delayed-payment chapter, so this renders only for machining + settings.udyam.
   Rate table = RBI notified Bank Rate history; update when RBI moves. */
const MSMED_RATES = [
  /* full history back to the 2020 low: a carried-forward old bill must never
     be billed at a rate higher than what RBI actually notified in that month.
     Times before the first entry fall back to 4.25 - the historic low - so
     pre-2020 accrual can only understate. */
  [Date.UTC(2020, 4, 22), 4.25],
  [Date.UTC(2022, 4, 4), 4.65],
  [Date.UTC(2022, 5, 8), 5.15],
  [Date.UTC(2022, 7, 5), 5.65],
  [Date.UTC(2022, 8, 30), 6.15],
  [Date.UTC(2022, 11, 7), 6.5],
  [Date.UTC(2023, 1, 8), 6.75],
  [Date.UTC(2025, 1, 7), 6.5],
  [Date.UTC(2025, 3, 9), 6.25],
  [Date.UTC(2025, 5, 6), 5.75],
  [Date.UTC(2025, 9, 1), 5.5], /* held through the Feb-2026 RBI policy */
];
const bankRateAt = (ms) => { let r = MSMED_RATES[0][1]; for (const p of MSMED_RATES) { if (ms >= p[0]) r = p[1]; } return r; };
const MSMED_MONTH = 30.4375 * 86400000;
function msmedByaj(bill, nowMs) {
  const pending = Number(bill.pending) || 0;
  const bdate = Number(bill.bdate) || 0;
  if (!(pending > 0) || !bdate) return 0;
  const cap = bdate + 45 * 86400000;
  /* +1 day: s.16 runs interest from the day FOLLOWING the agreed/appointed
     date - and the strict boundary keeps the estimate an underclaim */
  const start = Math.min(Number(bill.due) || cap, cap) + 86400000;
  const now = nowMs || Date.now();
  if (start >= now) return 0;
  let base = pending, t = start;
  while (t < now) {
    const step = Math.min(MSMED_MONTH, now - t);
    /* min of the rate at both step edges: a mid-step RBI cut is applied
       early, not late - the bias always points DOWN */
    const rate = Math.min(bankRateAt(t), bankRateAt(t + step));
    base += base * ((rate * 3) / 100 / 12) * (step / MSMED_MONTH);
    t += step;
  }
  return Math.round(base - pending);
}
/* floor, never round up - this string sits inside legal-disclosure copy */
const msmedRateNow = () => String(Math.floor(bankRateAt(Date.now()) * 3 * 10) / 10);

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
    { d: 0.4, vtype: "Sales", party: "Apex Alloys", amount: 412500, item: "MS Scrap", qty: 12.5, unit: "MT", vno: "148", ref: "APX/PO-118" },
    { d: 1.2, vtype: "Sales", party: "Bharat Steels", amount: 278800, item: "CI Scrap", qty: 8.2, unit: "MT", vno: "147", ref: "" },
    { d: 2.1, vtype: "Purchase", party: "Yard Suppliers Co", amount: 560000, item: "Mixed Scrap", qty: 20, unit: "MT", vno: "P-88", ref: "" },
    { d: 3.5, vtype: "Sales", party: "Om Metals", amount: 455600, item: "Aluminium Scrap", qty: 3.4, unit: "MT", vno: "146", ref: "OM/2287" },
    { d: 5.0, vtype: "Sales", party: "Apex Alloys", amount: 660000, item: "MS Scrap", qty: 20, unit: "MT", vno: "145", ref: "APX/PO-112" },
    { d: 6.3, vtype: "Sales", party: "Shakti Traders", amount: 49600, item: "MS Scrap", qty: 1.5, unit: "MT", vno: "144", ref: "" },
    { d: 8.1, vtype: "Purchase", party: "Yard Suppliers Co", amount: 392000, item: "Mixed Scrap", qty: 14, unit: "MT" },
    { d: 9.4, vtype: "Sales", party: "Bharat Steels", amount: 340000, item: "CI Scrap", qty: 10, unit: "MT", vno: "143", ref: "BS/PO-1104" },
  ],
  progress: [
    { customer: "Apex Alloys", item: "MS Scrap", ordered: 50, unit: "MT", shipped: 32.5, atDays: 20, deadlineDays: 4, lastDays: 0.4, balance: 412000 },
    { customer: "Bharat Steels", item: "CI Scrap", ordered: 25, unit: "MT", shipped: 18.2, atDays: 12, deadlineDays: 10, lastDays: 1.2, balance: 185500 },
    { customer: "Om Metals", item: "Aluminium Scrap", ordered: 30, unit: "MT", shipped: 3.4, atDays: 16, deadlineDays: -1, lastDays: 3.5, balance: 96000 },
  ],
  /* bill-wise outstandings (Tally's Bills Receivable). d = bill age in days,
     dueIn = days until due (negative = overdue). Per-party pending sums MATCH
     the ledger balances above - keep it that way. */
  bills: [
    { party: "Apex Alloys", ref: "APX/PO-112", d: 23, dueIn: -8, opening: 660000, pending: 249500 },
    { party: "Apex Alloys", ref: "APX/PO-118", d: 0.4, dueIn: 15, opening: 412500, pending: 162500 },
    { party: "Bharat Steels", ref: "BS/PO-1104", d: 40, dueIn: -33, opening: 340000, pending: 90000 },
    { party: "Bharat Steels", ref: "147", d: 1.2, dueIn: 6, opening: 278800, pending: 95500 },
    { party: "Om Metals", ref: "OM/2214", d: 78, dueIn: -71, opening: 220000, pending: 42000 },
    { party: "Om Metals", ref: "OM/2287", d: 3.5, dueIn: 4, opening: 455600, pending: 54000 },
    { party: "Shakti Traders", ref: "ST/188", d: 55, dueIn: -48, opening: 49600, pending: 15200 },
  ],
};
const fmtQty = (n) => {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return v.toLocaleString("en-IN", { maximumFractionDigits: 2 });
};

/* ================= ORDERS x DISPATCH =================
   "Kitna maal gaya, kitna baki" per won order, and everything about one
   party on the client page. Three records can show a dispatch: Truck board
   trips, manual yard outs (stock.outs with a party) and Tally sales vouchers.
   The yard records and Tally describe the SAME trucks, so they are never
   added together - a party counts whichever side shows more (either can lag:
   the bill gets made late, or a truck never got logged).
   Sample Tally rows stand in ONLY for a party whose quotes are all sample
   data, and only while no real Tally is synced - a real customer is never
   shown sample money. */
const partyKey = (s) => String(s || "").trim().toLowerCase();
const initialsOf = (s) => String(s || "?").trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
const ORDER_WINDOW = 120 * DAY;  /* same window as the dispatch planner */
const ORDER_DONE = 0.99;         /* 1% weighbridge / moisture cut still counts as complete */
/* Tally quantities to tonnes; an unknown unit is skipped rather than guessed */
const toMT = (qty, unit) => {
  const u = String(unit || "").trim().toLowerCase().replace(/\.$/, "");
  const n = Number(qty) || 0;
  if (!u || /^(mt|ton|tons|tonne|tonnes|t)$/.test(u)) return n;
  if (/^kgs?$/.test(u)) return n / 1000;
  if (/^(qtl|qtls|quintal|quintals)$/.test(u)) return n / 10;
  return null;
};
function partyView(data, name, tallyRows, tallyBal) {
  const now = Date.now();
  const k = partyKey(name);
  const ind = industryOf(data);
  const isMT = ind.unit === "MT";
  const quotes = (data.quotes || []).filter((q) => partyKey(q.customer) === k).sort((a, b) => b.at - a.at);
  const won = quotes.filter((q) => q.status === "won" && Number(q.qty) > 0 && q.at > now - ORDER_WINDOW).sort((a, b) => a.at - b.at);
  const sample = !tallyRows && !tallyBal && quotes.length > 0 && quotes.every((q) => q.seed);
  const T = sample
    ? { vouchers: TALLY_SAMPLE.vouchers.map((x) => ({ ...x, vdate: now - x.d * DAY })),
        bills: TALLY_SAMPLE.bills.map((x) => ({ ...x, bdate: now - x.d * DAY, due: x.dueIn == null ? null : now + x.dueIn * DAY })) }
    : tallyRows;

  const yard = [
    ...(data.trips || []).filter((t) => partyKey(t.dealer) === k).map((t) => ({
      id: t.id, at: t.startedAt, qty: Number(t.qty) || 0, item: t.material || "", ref: t.ref || "", src: "truck", onRoad: !t.delivered,
      truck: ((data.trucks || []).find((x) => x.id === t.truckId) || {}).number || "" })),
    ...(((data.stock && data.stock.outs) || []).filter((o) => partyKey(o.party) === k).map((o) => ({
      id: o.id, at: o.at, qty: Number(o.qty) || 0, item: catMeta(ind, o.cat).label, ref: o.ref || "", src: "yard" }))),
  ];
  const tally = T ? (T.vouchers || []).filter((v) => !/purchase/i.test(String(v.vtype || "")) && partyKey(v.party) === k)
    .map((v, i) => ({ id: "t" + i, at: Number(v.vdate), qty: isMT ? toMT(v.qty, v.unit) : Number(v.qty) || 0, item: v.item || "", ref: v.ref || v.vno || "", amount: Number(v.amount) || 0, src: "tally" }))
    .filter((d) => d.qty != null && d.qty > 0) : [];

  /* the oldest open order fills first. Dispatches from before the day the
     first order was logged belong to older business (sample dates are made
     up, so sample parties have no floor) */
  const floor = won.length ? Math.min(...won.map((q) => (q.seed ? 0 : startOfDay(q.at)))) : Infinity;
  const sum = (xs) => xs.reduce((s, d) => s + d.qty, 0);
  const yardIn = yard.filter((d) => d.at >= floor), tallyIn = tally.filter((d) => d.at >= floor);
  const fromTally = sum(tallyIn) > sum(yardIn);
  const used = fromTally ? tallyIn : yardIn;
  let left = sum(used);
  const last = used.length ? Math.max(...used.map((d) => d.at)) : null;
  const orders = won.map((q) => {
    const qty = Number(q.qty);
    /* an order the owner closed by hand keeps exactly the maal it had at that
       moment (q.closedSent) and claims nothing more - without the freeze the
       next order would swallow those same trucks and read as already sent */
    const claim = q.closedAt ? Math.min(qty, Number(q.closedSent) || 0) : qty;
    const sent = Math.min(claim, left);
    left -= sent;
    return { q, qty, sent, closed: !!q.closedAt, remaining: q.closedAt ? 0 : Math.max(0, qty - sent),
      done: !!q.closedAt || sent >= qty * ORDER_DONE, last };
  });

  const bills = T ? (T.bills || []).filter((b) => partyKey(b.party) === k && Number(b.pending) > 0) : [];
  const ledger = sample ? TALLY_SAMPLE.ledgers.find((l) => l.grp !== "creditor" && partyKey(l.name) === k) : null;
  const balance = sample ? (ledger ? ledger.balance : 0) : tallyBal ? (tallyBal[k] || 0) : null;
  return {
    name: String(name || "").trim() || (quotes[0] && quotes[0].customer) || "", quotes, orders, sample,
    fromTally, dispatches: (fromTally ? tally : yard).map((d) => ({ ...d, counted: !won.length || d.at >= floor })).sort((a, b) => b.at - a.at),
    onRoad: yard.filter((d) => d.onRoad).reduce((s, d) => s + d.qty, 0),
    balance, bills, phone: (quotes.find((q) => q.phone) || {}).phone || "",
  };
}
/* every open (not yet fully dispatched) won order, newest first */
const ongoingOrders = (data, tallyRows, tallyBal) => {
  const now = Date.now();
  const names = [...new Set((data.quotes || []).filter((q) => q.status === "won" && Number(q.qty) > 0 && q.at > now - ORDER_WINDOW).map((q) => partyKey(q.customer)))];
  return names.flatMap((k) => {
    const pv = partyView(data, k, tallyRows, tallyBal);
    return pv.orders.filter((o) => !o.done).map((o) => ({ ...o, onRoad: pv.onRoad }));
  }).sort((a, b) => b.q.at - a.q.at);
};

function TallyInsights({ data, updateQuote, ping, onBack }) {
  const [led, setLed] = useState(null);   // ledger rows | null while loading
  const [vch, setVch] = useState(null);   // voucher rows
  const [bills, setBills] = useState([]); // bill-wise outstandings (tally_bills; [] when not synced)
  const [demo, setDemo] = useState(!sb);  // no cloud rows: nothing real to show
  /* A brand-new owner must NOT open Money onto somebody's 7,08,700 receivable.
     The sample runs only when he asked for example data (or taps to see it);
     otherwise the page shows its own shape and says where real numbers come
     from. Same rule as the pipeline. */
  const [showSample, setShowSample] = useState(false);
  const [view, setView] = useState(null); // null overview | "recv" | "pay" | "sent" | "bills" drill-down
  const [knowHow, setKnowHow] = useState(false); // planner "how it works" panel
  const [plannerOpen, setPlannerOpen] = useState(false); // dispatch planner collapsed by default (first-look clutter)
  const [openBill, setOpenBill] = useState(null); // expanded bill key in the bills drill-down
  const [billFilter, setBillFilter] = useState("all"); // aging-bucket filter in the bills drill-down
  /* confirm sheet before any reminder leaves - the owner reads the exact
     words first. The message itself is msmedChaseText(), unchanged. */
  const [nudge, setNudge] = useState(null); // {party, ref, pending, late, byaj, msg, phone}

  /* built once and rendered by every view - TallyInsights returns early per
     view, so a sheet living only in the overview return never appears in the
     bills drill where the reminder button actually is */
  const nudgeSheet = nudge ? (
        <div onClick={() => setNudge(null)} style={{ position: "fixed", inset: 0, zIndex: 80, background: "rgba(16,26,20,.45)", backdropFilter: "blur(3px)", display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
          <div className="anim-in" onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: "26px 26px 0 0", padding: "20px 18px calc(18px + env(safe-area-inset-bottom))", maxHeight: "88%", overflowY: "auto", boxShadow: "0 -20px 50px -20px rgba(21,94,24,.4)" }}>
            <div style={{ width: 40, height: 4, borderRadius: 3, background: "var(--line2)", margin: "0 auto 16px" }} />
            <div className="h-disp" style={{ fontSize: 22, fontWeight: 700 }}>{tx("A gentle reminder", "Ek vinamra yaad", "एक विनम्र याद")}</div>
            <div style={{ fontSize: 13.5, color: "var(--dim)", margin: "5px 0 14px", lineHeight: 1.55 }}>
              {tx("Your customer, your words. Read it before it goes.", "Aapka customer, aapke shabd. Bhejne se pehle padh lijiye.", "आपका ग्राहक, आपके शब्द। भेजने से पहले पढ़ लें।")}
            </div>

            <div className="card" style={{ padding: "12px 14px", marginBottom: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
                <span className="mono" style={{ fontSize: 12.5, color: "var(--dim)" }}>{nudge.ref || tx("bill", "bill", "बिल")}</span>
                <b style={{ fontSize: 14.5, textAlign: "right" }}>{nudge.party}</b>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, marginTop: 9, paddingTop: 9, borderTop: "1px solid var(--line)" }}>
                <span style={{ fontSize: 13.5, color: "var(--dim)" }}>{nudge.late > 0 ? tx("Overdue by ", "Late ", "देर ") + nudge.late + tx(" days", " din", " दिन") : tx("Pending", "Baki", "बाकी")}</span>
                <b className="mono" style={{ fontSize: 16, color: "var(--red)" }}>{inr(nudge.pending)}</b>
              </div>
              {nudge.byaj > 0 && (
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, marginTop: 6 }}>
                  <span style={{ fontSize: 12.5, color: "var(--dim)" }}>{tx("MSMED interest (est.)", "Kanooni byaj (andaza)", "कानूनी ब्याज (अंदाज़ा)")}</span>
                  <span className="mono" style={{ fontSize: 13, color: "#DC2626" }}>+{inr(nudge.byaj)}</span>
                </div>
              )}
            </div>

            <div style={{ background: "#EAF6EA", border: "1px solid #CFE3D1", borderRadius: "14px 14px 14px 4px", padding: "12px 13px", whiteSpace: "pre-wrap", fontSize: 13.5, lineHeight: 1.6, color: "#14261A" }}>{nudge.msg}</div>

            <div style={{ display: "flex", gap: 9, alignItems: "flex-start", marginTop: 11, fontSize: 12.5, color: "var(--dim)", lineHeight: 1.55 }}>
              <span aria-hidden="true" style={{ flexShrink: 0 }}>&#128274;</span>
              <span>{tx("Nothing is sent yet. WhatsApp opens with this text from your own number - you can edit it there.", "Abhi kuch nahi gaya. WhatsApp aapke apne number se khulega, text aap wahan badal bhi sakte hain.", "अभी कुछ नहीं भेजा गया। WhatsApp आपके अपने नंबर से खुलेगा।")}</span>
            </div>

            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              <button className="btn btn-ghost press" style={{ flex: 1, justifyContent: "center" }} onClick={() => setNudge(null)}>{tx("Cancel", "Rehne do", "रहने दें")}</button>
              <a className="btn btn-grn press" style={{ flex: 1.4, justifyContent: "center", textDecoration: "none", boxSizing: "border-box" }}
                href={waLink(nudge.phone, nudge.msg)} target="_blank" rel="noreferrer" onClick={() => setNudge(null)}>
                {tx("Open WhatsApp", "WhatsApp kholo", "WhatsApp खोलें")}
              </a>
            </div>
          </div>
        </div>
  ) : null;

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!sb) { setDemo(true); return; }
      try {
        const l = await sb.from("tally_ledgers").select("name,balance,grp,as_of");
        /* vno/ref columns arrive with supabase/tally.sql 2026-07-17 - fall back
           cleanly for tenants who have not run the migration yet */
        let v = await sb.from("tally_vouchers").select("vdate,vtype,party,amount,item,qty,unit,vno,ref").order("vdate", { ascending: false }).limit(400);
        if (v.error) v = await sb.from("tally_vouchers").select("vdate,vtype,party,amount,item,qty,unit").order("vdate", { ascending: false }).limit(400);
        /* tally_bills arrives with supabase/tally.sql 2026-07-28 - absent table
           just means no aging view, never an error state */
        const b = await sb.from("tally_bills").select("party,ref,bdate,due,opening,pending").limit(600);
        if (!alive) return;
        const lr = (!l.error && l.data) || [], vr = (!v.error && v.data) || [];
        if (!lr.length && !vr.length) { setDemo(true); return; }
        setLed(lr); setVch(vr); setBills((!b.error && b.data) || []); setDemo(false);
      } catch { if (alive) setDemo(true); }
    })();
    return () => { alive = false; };
  }, []);

  /* pick the data source: real rows or the labelled sample */
  const now = Date.now();
  const sample = demo && (hasDemo(data) || showSample);
  const L = sample ? TALLY_SAMPLE.ledgers : (led || []);
  const V = sample
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
  const balanceOf = (name) => {
    const hit = receivable.find((x) => String(x.name).trim().toLowerCase() === String(name).trim().toLowerCase());
    return hit ? Number(hit.balance) : 0;
  };

  /* ---- bill-wise aging (Tally's Bills Receivable / F6 age-wise logic:
          age counts from the DUE date, falling back to the bill date when
          the accountant never set a credit period) ---- */
  const B = (sample
    ? TALLY_SAMPLE.bills.map((x) => ({ ...x, bdate: now - x.d * DAY, due: x.dueIn == null ? null : now + x.dueIn * DAY }))
    : bills
  ).filter((x) => Number(x.pending) > 0);
  const billAge = (x) => Math.floor((startOfDay(now) - startOfDay(Number(x.due) || Number(x.bdate))) / DAY); /* +ve = days late */
  const AGE_BUCKETS = [
    { key: "ok", c: "#2E9E33", label: tx("Not due yet", "Time hai", "अभी समय है") },
    { key: "b30", c: "#D97706", label: tx("1-30 days late", "1-30 din late", "1-30 दिन लेट") },
    { key: "b60", c: "#EA580C", label: tx("31-60 days late", "31-60 din late", "31-60 दिन लेट") },
    { key: "b90", c: "#DC2626", label: tx("60+ days late", "60+ din late", "60+ दिन लेट") },
  ];
  const bucketOf = (x) => { const a = billAge(x); return a <= 0 ? "ok" : a <= 30 ? "b30" : a <= 60 ? "b60" : "b90"; };
  const ageSum = { ok: 0, b30: 0, b60: 0, b90: 0 }, ageCount = { ok: 0, b30: 0, b60: 0, b90: 0 };
  B.forEach((x) => { const k = bucketOf(x); ageSum[k] += Number(x.pending); ageCount[k]++; });
  const billsTotal = B.reduce((s, x) => s + Number(x.pending), 0);
  const overdueTotal = ageSum.b30 + ageSum.b60 + ageSum.b90;
  const overdueCount = ageCount.b30 + ageCount.b60 + ageCount.b90;
  /* MSMED byaj - machining + Udyam only (traders are excluded by law) */
  const isMachTrade = industryOf(data).key === "machining";
  const showByaj = isMachTrade && !!(data.settings && data.settings.udyam);
  const byajTotal = showByaj ? B.reduce((s, x) => s + msmedByaj(x, now), 0) : 0;
  const billsOf = (name) => B.filter((x) => String(x.party).trim().toLowerCase() === String(name).trim().toLowerCase())
    .sort((p, q) => billAge(q) - billAge(p));
  /* phone for the escalation button: reuse the pipeline's number for the same
     customer (Tally bills carry no phone) - empty string still works, wa.me
     without a number opens WhatsApp's pick-a-chat screen */
  const phoneFor = (name) => {
    const hit = (data.quotes || []).find((qq) => qq.phone && String(qq.customer).trim().toLowerCase() === String(name).trim().toLowerCase());
    return hit ? hit.phone : "";
  };
  /* tie a bill back to its dispatch voucher (item/qty) via reference or voucher no */
  const voucherForBill = (x) => V.find((v2) => (v2.ref && v2.ref === x.ref) || (v2.vno && v2.vno === x.ref));
  /* accordion identity - must be stable across renders (demo bdate is derived
     from Date.now() per render, so raw bdate would never match twice) */
  const bkeyOf = (x) => x.party + "|" + x.ref + "|" + Math.round(Number(x.bdate) / DAY) + "|" + x.pending;
  /* the green -> red money bar: one glance = how much is stuck, how badly */
  const AgeBar = ({ h = 14 }) => (
    <div style={{ display: "flex", height: h, borderRadius: 999, overflow: "hidden", background: "var(--soft)", border: "1px solid var(--line)" }}>
      {AGE_BUCKETS.filter((bk) => ageSum[bk.key] > 0).map((bk) => (
        <div key={bk.key} style={{ flexGrow: ageSum[bk.key], minWidth: 6, background: bk.c }} />
      ))}
    </div>
  );

  /* ---- open orders for the dispatch planner ---- */
  const orders = sample
    ? TALLY_SAMPLE.progress.map((p, i) => ({
        qid: "demo" + i, customer: p.customer, item: p.item, ordered: p.ordered, unit: p.unit,
        shipped: p.shipped, remaining: Math.max(0, p.ordered - p.shipped),
        at: now - p.atDays * DAY,
        deliverBy: p.deadlineDays == null ? null : now + p.deadlineDays * DAY,
        lastDispatchAt: now - p.lastDays * DAY, balance: p.balance,
      }))
    : (data.quotes || [])
      .filter((q) => q.status === "won" && q.qty > 0 && !q.closedAt && q.at > now - 120 * DAY)
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
    /* credit caution: when bill-wise data exists, overdue bills speak (Tally's
       own voucher-time credit gate); otherwise fall back to the flat threshold */
    const pb = billsOf(o.customer);
    const od = pb.filter((b2) => billAge(b2) > 0);
    if (od.length) {
      const odAmt = od.reduce((s, b2) => s + Number(b2.pending), 0);
      const oldest = Math.max(...od.map(billAge));
      score -= Math.min(25, odAmt / 40000 + oldest / 10);
      reasons.push({ t: oldest >= 60 ? inr(odAmt) + " ka bill " + oldest + " din se late - pehle payment" : inr(odAmt) + " overdue (" + oldest + " din) - dhyaan rakho", c: "red" });
    } else if (o.balance > 100000) { score -= Math.min(20, o.balance / 50000); reasons.push({ t: "Baki " + inr(o.balance) + " - payment ka dhyaan", c: "red" }); }
    return { ...o, score, reasons };
  }).sort((a, b) => b.score - a.score);

  const asOf = !demo && led && led.length ? led[0].as_of : null;

  /* No Tally, no example data: show what this page IS rather than what some
     other shop's ledger says. Every hook above has already run, so this early
     return is safe (Rules of Hooks). */
  if (demo && !sample && !loading) return (
    <div className="scr"><div className="pagepad">
      <div className="anim-in" style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
        <div style={{ flex: 1 }}>
          <div className="microlbl">{tx("MONEY", "PAISA", "\u092A\u0948\u0938\u093E")}</div>
          <div className="h-disp" style={{ fontSize: 24, fontWeight: 700 }}>{tx("Who owes you what", "Kiska kitna baki hai", "\u0915\u093F\u0938\u0915\u093E \u0915\u093F\u0924\u0928\u093E \u092C\u093E\u0915\u0940")}</div>
        </div>
      </div>
      <div style={{ fontSize: 14, color: "var(--dim)", lineHeight: 1.6, margin: "4px 0 16px" }}>
        {tx("This page reads your accountant's Tally - bill by bill, who is late and by how many days. Nothing is typed twice, and nothing is written back unless you allow it.",
            "Ye page aapke accountant ke Tally se aata hai - bill-wise, kiska payment kitne din late hai. Dobara kuch type nahi karna padta.",
            "\u092F\u0939 \u092A\u0947\u091C \u0906\u092A\u0915\u0947 Tally \u0938\u0947 \u0906\u0924\u093E \u0939\u0948 - \u092C\u093F\u0932-\u0935\u093E\u0930\u0964")}
      </div>
      <GhostPreview rows={2} caption={tx("TALLY CONNECTS AND THIS FILLS ITSELF", "TALLY JUDTE HI YE APNE AAP BHAR JAYEGA", "TALLY \u091C\u0941\u0921\u093C\u0924\u0947 \u0939\u0940 \u092F\u0939 \u092D\u0930 \u091C\u093E\u090F\u0917\u093E")} />
      <button className="btn btn-ghost press" style={{ width: "100%", marginTop: 18 }} onClick={() => setShowSample(true)}>
        {tx("Show me an example", "Example dekhein", "\u0909\u0926\u093E\u0939\u0930\u0923 \u0926\u0947\u0916\u0947\u0902")}
      </button>
      <div className="hint" style={{ textAlign: "center", marginTop: 10 }}>
        {tx("Connect Tally from Setup when you are ready - it only reads at first.", "Tally Setup se jodein jab taiyaar hon - pehle wo sirf padhta hai, likhta kuch nahi.", "Tally \u0915\u094B Setup \u0938\u0947 \u091C\u094B\u0921\u093C\u0947\u0902\u0964")}
      </div>
    </div></div>
  );
  const chipStyle = (c) => ({
    display: "inline-flex", alignItems: "center", fontSize: 11, fontWeight: 600, fontFamily: "var(--mono)",
    padding: "3px 9px", borderRadius: 12, marginRight: 6, marginTop: 6, lineHeight: 1.45, maxWidth: "100%",
    background: c === "red" ? "var(--red-bg)" : c === "amber" ? "var(--amber-bg)" : "var(--grn-100)",
    color: c === "red" ? "var(--red)" : c === "amber" ? "var(--amber)" : "var(--grn-d)",
  });

  /* ---------- drill-down: maal gaya - dealer-wise dispatches ---------- */
  if (view === "sent") {
    const byParty = {};
    monthSales.forEach((x) => { const k = String(x.party || "?").trim() || "?"; (byParty[k] = byParty[k] || []).push(x); });
    const groups = Object.keys(byParty).map((name) => ({
      name, rows: byParty[name],
      qty: byParty[name].reduce((s2, x) => s2 + (Number(x.qty) || 0), 0),
      amt: byParty[name].reduce((s2, x) => s2 + (Number(x.amount) || 0), 0),
    })).sort((a, b) => b.amt - a.amt);
    return (
      <div className="scr"><div className="pagepad">
        <div className="anim-in" style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
          <button className="iconbtn press" onClick={() => setView(null)}><I.back /></button>
          <div style={{ flex: 1 }}>
            <div className="microlbl">{tx("SENT THIS MONTH", "MAAL GAYA IS MAHINE", "इस महीने गया माल")}</div>
            <div className="h-disp" style={{ fontSize: 24, fontWeight: 700 }}>{tx("Where it went", "Kahan kitna gaya", "कहां कितना गया")}</div>
          </div>
          {sample && <span className="demo-ribbon">SAMPLE</span>}
        </div>
        <div className="card anim-in st1" style={{ padding: "16px 16px", margin: "12px 0 16px", background: "#F3FBF4", borderColor: "#CFE9D1", display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
          <span style={{ fontSize: 14.5, fontWeight: 600, color: "var(--dim)" }}>{monthSales.length} dispatch{monthSales.length === 1 ? "" : "es"} · {inr(monthValue)}</span>
          <b className="h-disp mono" style={{ fontSize: 24, color: "var(--grn-d)" }}>{monthQty > 0 ? fmtQty(monthQty) + " " + mainUnit : "-"}</b>
        </div>

        {/* weekly dispatch trend - the 45-day voucher window as 6 weekly bars:
            "maal barabar ja raha hai ya ruk gaya?" at a glance */}
        {(() => {
          const allSales = V.filter((x) => isSale(x.vtype));
          if (!allSales.length) return null;
          const wk = [0, 0, 0, 0, 0, 0];
          allSales.forEach((x) => { const w = Math.floor((startOfDay(now) - startOfDay(x.vdate)) / (7 * DAY)); if (w >= 0 && w < 6) wk[w] += Number(x.amount) || 0; });
          const bars = [5, 4, 3, 2, 1, 0].map((w) => ({ value: wk[w], label: w === 0 ? tx("this wk", "is hafte", "इस हफ्ते") : fdateShort(now - w * 7 * DAY) }));
          const mx = Math.max(...bars.map((b3) => b3.value), 1);
          return (
            <div className="card anim-in st2" style={{ padding: "18px 16px 14px", marginBottom: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                <span className="lbl" style={{ margin: 0 }}>{tx("Week-by-week sales", "Hafte-war maal gaya", "हफ्ते-वार गया माल")}</span>
                <span style={{ color: "var(--grn)" }}><I.chart /></span>
              </div>
              <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 8, height: 110 }}>
                {bars.map((b3, i) => (
                  <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6, height: "100%", justifyContent: "flex-end" }}>
                    <div className="mono" style={{ fontSize: 10.5, color: b3.value ? "var(--grn-d)" : "transparent", fontWeight: 600, whiteSpace: "nowrap" }}>
                      {b3.value >= 100000 ? "₹" + (b3.value / 100000).toFixed(1) + "L" : b3.value >= 1000 ? "₹" + (b3.value / 1000).toFixed(0) + "k" : b3.value ? "₹" + b3.value : "0"}
                    </div>
                    <div style={{ width: "100%", maxWidth: 34, flex: 1, display: "flex", alignItems: "flex-end" }}>
                      <div style={{ width: "100%", height: Math.max((b3.value / mx) * 100, b3.value ? 6 : 2) + "%",
                        background: b3.value ? "linear-gradient(180deg,#2E9E33,#7CCB80)" : "var(--line)", borderRadius: 7,
                        boxShadow: b3.value ? "0 4px 12px -4px rgba(34,139,34,.4)" : "none",
                        animation: "growBar .6s cubic-bezier(.2,.7,.3,1) both", animationDelay: (i * .05) + "s" }} />
                    </div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink)", whiteSpace: "nowrap" }}>{b3.label}</div>
                  </div>
                ))}
              </div>
              <div className="mono" style={{ fontSize: 10.5, color: "var(--faint)", marginTop: 10, textAlign: "center" }}>{tx("Last 6 weeks of Tally Sales vouchers", "Pichhle 6 hafte ke Tally Sales vouchers", "पिछले 6 हफ्ते के Tally सेल्स वाउचर")}</div>
            </div>
          );
        })()}

        {groups.length === 0 && <div className="card-tint" style={{ padding: 24, textAlign: "center", color: "var(--dim)", fontSize: 14 }}>{tx("Nothing sent yet this month.", "Is mahine abhi kuch nahi gaya.", "इस महीने अभी कुछ नहीं गया।")}</div>}
        {groups.map((g, gi) => (
          <div key={g.name} className={"card anim-in st" + Math.min(6, gi + 1)} style={{ padding: "15px 15px", marginBottom: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
              <div className="h-disp" style={{ fontWeight: 700, fontSize: 17, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{g.name}</div>
              <div style={{ flexShrink: 0, textAlign: "right" }}>
                <b className="mono" style={{ display: "block", fontSize: 16, color: "var(--grn-d)" }}>{inr(g.amt)}</b>
                {g.qty > 0 && <span className="mono" style={{ fontSize: 12.5, color: "var(--dim)" }}>{fmtQty(g.qty)} {g.rows[0].unit || ""} {tx("total", "total", "कुल")}</span>}
              </div>
            </div>
            <div style={{ borderTop: "1px solid var(--line)", marginTop: 10, paddingTop: 2 }}>
              {g.rows.map((x, ri) => (
                <div key={ri} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 0", borderBottom: ri < g.rows.length - 1 ? "1px dashed var(--line)" : "none" }}>
                  <span className="mono" style={{ flexShrink: 0, width: 52, fontSize: 13.5, fontWeight: 700 }}>{fdateShort(x.vdate)}</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                      {x.qty > 0 && <span className="mono" style={{ flexShrink: 0, fontSize: 12.5, fontWeight: 700, color: "var(--grn-d)", background: "var(--grn-100)", borderRadius: 8, padding: "2px 9px" }}>{fmtQty(x.qty)} {x.unit || ""}</span>}
                      <span style={{ fontSize: 14, color: "var(--dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{x.item || tx("sale", "sale", "बिक्री")}</span>
                    </span>
                    {(x.vno || x.ref) && <span className="mono" style={{ display: "block", fontSize: 11.5, color: "var(--faint)", marginTop: 3 }}>#{x.ref || x.vno}</span>}
                  </span>
                  <b className="mono" style={{ flexShrink: 0, fontSize: 15 }}>{inr(x.amount)}</b>
                </div>
              ))}
            </div>
          </div>
        ))}
        <div className="card-tint anim-in" style={{ padding: "13px 15px", fontSize: 12.5, color: "var(--dim)", lineHeight: 1.6, marginTop: 6 }}>
          {tx("These are this month's Sales vouchers from Tally - each with its voucher/reference number.", "Ye is mahine ke Tally Sales vouchers hain - har entry ke number/reference ke saath.", "ये इस महीने के Tally सेल्स वाउचर हैं - हर एंट्री का नंबर/रेफरेंस साथ में।")}
        </div>
      </div></div>
    );
  }

  /* ---------- drill-down: bill-by-bill khaata (Tally's Bills Receivable) ---------- */
  if (view === "bills") {
    const shown = (billFilter === "all" ? B : B.filter((x) => bucketOf(x) === billFilter))
      .slice().sort((p, q) => billAge(q) - billAge(p));
    const bucketC = (x) => AGE_BUCKETS.find((bk) => bk.key === bucketOf(x)).c;
    const parties = new Set(B.map((x) => String(x.party).trim().toLowerCase()));
    return (
      <div className="scr"><div className="pagepad">
        <div className="anim-in" style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
          <button className="iconbtn press" onClick={() => { setView(null); setBillFilter("all"); setOpenBill(null); }}><I.back /></button>
          <div style={{ flex: 1 }}>
            <div className="microlbl">{tx("BILL-WISE PENDING", "BILL-WISE BAKI", "बिल के हिसाब से बाकी")}</div>
            <div className="h-disp" style={{ fontSize: 24, fontWeight: 700 }}>{tx("Every bill, tracked", "Har bill ka hisaab", "हर बिल का हिसाब")}</div>
          </div>
          {sample && <span className="demo-ribbon">SAMPLE</span>}
        </div>

        <div className="card anim-in st1" style={{ padding: "16px 16px", margin: "12px 0 14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
            <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--dim)" }}>{B.length} bill{B.length === 1 ? "" : "s"} · {parties.size} part{parties.size === 1 ? "y" : "ies"}</span>
            <b className="h-disp mono" style={{ fontSize: 24, color: "var(--grn-d)" }}>{inr(billsTotal)}</b>
          </div>
          <div style={{ marginTop: 11 }}><AgeBar h={16} /></div>
          <div style={{ display: "grid", gap: 5, marginTop: 11 }}>
            {AGE_BUCKETS.map((bk) => (
              <button key={bk.key} className="press" onClick={() => setBillFilter(billFilter === bk.key ? "all" : bk.key)}
                style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", borderRadius: 10, background: billFilter === bk.key ? "var(--soft)" : "transparent", opacity: ageCount[bk.key] ? 1 : 0.4 }}>
                <span style={{ width: 10, height: 10, borderRadius: "50%", background: bk.c, flexShrink: 0 }} />
                <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{bk.label}</span>
                <span className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>{ageCount[bk.key]} bill{ageCount[bk.key] === 1 ? "" : "s"}</span>
                <b className="mono" style={{ fontSize: 13, color: ageSum[bk.key] > 0 && bk.key !== "ok" ? bk.c : "var(--ink)" }}>{inr(ageSum[bk.key])}</b>
              </button>
            ))}
          </div>
          {overdueTotal === 0 && <div style={{ marginTop: 10, fontSize: 13, color: "var(--grn-d)", fontWeight: 600 }}>{tx("Everything is on time. 🎉", "Sab time pe hai. 🎉", "सब समय पर है। 🎉")}</div>}
        </div>

        {shown.length === 0 && <div className="card-tint" style={{ padding: 24, textAlign: "center", color: "var(--dim)", fontSize: 14 }}>{tx("Nothing in this bucket.", "Is hisse mein kuch nahi.", "इस हिस्से में कुछ नहीं।")}</div>}
        {shown.map((x, i) => {
          const key = bkeyOf(x);
          const late = billAge(x);
          const opening = Number(x.opening) || 0, pending = Number(x.pending) || 0;
          const received = opening >= pending && opening > 0 ? opening - pending : null;
          const vhit = voucherForBill(x);
          const isOpen = openBill === key;
          const partyBills = billsOf(x.party);
          const partyPending = partyBills.reduce((s, p) => s + Number(p.pending), 0);
          const onAccount = balanceOf(x.party) - partyPending; /* receipts/sales never matched to a bill */
          return (
            <div key={key} className={"card anim-in st" + Math.min(6, i + 1)} style={{ padding: 0, marginBottom: 10, overflow: "hidden" }}>
              <button className="press" onClick={() => setOpenBill(isOpen ? null : key)} style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "13px 15px" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="mono" style={{ fontSize: 13.5, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>#{x.ref || tx("no ref", "bina ref", "बिना रेफरेंस")}</div>
                  <div style={{ fontSize: 12.5, color: "var(--dim)", marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{x.party}</div>
                </div>
                <div style={{ flexShrink: 0, textAlign: "right" }}>
                  <b className="mono" style={{ display: "block", fontSize: 15, color: late > 0 ? bucketC(x) : "var(--ink)" }}>{inr(pending)}</b>
                  <span className="mono" style={{ fontSize: 10.5, fontWeight: 600, color: late > 0 ? bucketC(x) : "var(--faint)" }}>
                    {late > 0 ? late + tx(" days late", " din late", " दिन लेट") : x.due ? tx("due ", "due ", "ड्यू ") + fdateShort(x.due) : tx("on time", "time pe", "समय पर")}
                  </span>
                </div>
                <I.chev style={{ width: 14, flexShrink: 0, color: "var(--faint)", transform: isOpen ? "rotate(90deg)" : "none", transition: "transform .2s" }} />
              </button>
              {isOpen && (
                <div style={{ borderTop: "1px solid var(--line)", padding: "12px 15px 14px", background: "#FBFDFB" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 12px" }}>
                    <div><div className="microlbl">{tx("BILL DATE", "BILL DATE", "बिल की तारीख")}</div><div className="mono" style={{ fontSize: 13.5, fontWeight: 600 }}>{fdateShort(x.bdate)}</div></div>
                    <div><div className="microlbl">{tx("DUE DATE", "DUE DATE", "ड्यू डेट")}</div><div className="mono" style={{ fontSize: 13.5, fontWeight: 600, color: late > 0 ? bucketC(x) : "var(--ink)" }}>{x.due ? fdateShort(x.due) : "-"}</div></div>
                    {opening > 0 && <div><div className="microlbl">{tx("BILLED", "BILL BANA (debit)", "बिल बना (डेबिट)")}</div><div className="mono" style={{ fontSize: 13.5, fontWeight: 600 }}>{inr(opening)}</div></div>}
                    {received != null && <div><div className="microlbl">{tx("RECEIVED", "AA GAYA (credit)", "आ गया (क्रेडिट)")}</div><div className="mono" style={{ fontSize: 13.5, fontWeight: 600, color: "var(--grn-d)" }}>{inr(received)}</div></div>}
                    <div><div className="microlbl">{tx("REMAINING", "BAKI", "बाकी")}</div><div className="mono" style={{ fontSize: 15, fontWeight: 700, color: late > 0 ? bucketC(x) : "var(--ink)" }}>{inr(pending)}</div></div>
                    {vhit && (vhit.qty > 0 || vhit.item) && <div><div className="microlbl">{tx("MAAL", "MAAL", "माल")}</div><div className="mono" style={{ fontSize: 13.5, fontWeight: 600 }}>{vhit.qty > 0 ? fmtQty(vhit.qty) + " " + (vhit.unit || "") : ""}{vhit.item ? (vhit.qty > 0 ? " · " : "") + vhit.item : ""}</div></div>}
                  </div>
                  {received != null && opening > 0 && (
                    <div style={{ height: 7, borderRadius: 999, background: "var(--soft)", border: "1px solid var(--line)", marginTop: 11, overflow: "hidden" }}>
                      <div style={{ width: Math.max(3, (received / opening) * 100) + "%", height: "100%", borderRadius: 999, background: "linear-gradient(90deg,#2E9E33,#7CCB80)" }} />
                    </div>
                  )}
                  {received != null && opening > 0 && <div className="mono" style={{ fontSize: 11, color: "var(--faint)", marginTop: 5 }}>{Math.round((received / opening) * 100)}% {tx("received", "aa chuka", "आ चुका")}</div>}
                  {/* gate on byaj > 0, NOT late > 0: with credit periods over
                      45 days the statutory clock runs from day 46 while the
                      bill is not yet "late" - the chip must still show so the
                      aging-card total always reconciles bill by bill */}
                  {showByaj && msmedByaj(x, now) > 0 && (<>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, marginTop: 10, padding: "8px 11px", borderRadius: 12, background: "#FEF2F2", border: "1px solid #FECACA" }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: "#991B1B" }}>{tx("MSMED interest (est.)", "Kanooni byaj (andaza)", "कानूनी ब्याज (अंदाज़ा)")} · {msmedRateNow()}{tx("% compound", "% compound", "% चक्रवृद्धि")}{late <= 0 ? tx(" (45-day rule)", " (45 din ka niyam)", " (45 दिन का नियम)") : ""}</span>
                      <b className="mono" style={{ fontSize: 13.5, color: "#DC2626", flexShrink: 0 }}>+{inr(msmedByaj(x, now))}</b>
                    </div>
                    <button className="btn btn-grn btn-sm press" style={{ width: "100%", boxSizing: "border-box", marginTop: 8, justifyContent: "center" }}
                      onClick={() => setNudge({ party: x.party, ref: x.ref, pending, late, byaj: msmedByaj(x, now), phone: phoneFor(x.party),
                        msg: msmedChaseText(data.shopName, x.ref, pending, late, msmedByaj(x, now)) })}>
                      {"🙏"} {tx("Send a polite reminder on WhatsApp", "WhatsApp par narmi se yaad dilao", "WhatsApp पर विनम्रता से याद दिलाएं")}
                    </button>
                  </>)}
                  <div style={{ fontSize: 12.5, color: "var(--dim)", marginTop: 10, borderTop: "1px dashed var(--line)", paddingTop: 9 }}>
                    {x.party}{tx(" owes in total ", " par total baki ", " पर कुल बाकी ")}<b className="mono">{inr(balanceOf(x.party))}</b>
                    {" · "}{partyBills.length} {tx("open bill(s)", "khule bill", "खुले बिल")}
                    {Math.abs(onAccount) > 1 && <span> · {tx("on account ", "on account ", "ऑन अकाउंट ")}<span className="mono">{inr(onAccount)}</span></span>}
                  </div>
                </div>
              )}
            </div>
          );
        })}
        <div className="card-tint anim-in" style={{ padding: "13px 15px", fontSize: 12.5, color: "var(--dim)", lineHeight: 1.6, marginTop: 6 }}>
          {tx("This comes from Tally's Bills Receivable - every open bill with its due date. Chasing a specific bill number gets paid faster than asking for a lump sum.", "Ye Tally ke Bills Receivable se aata hai - har khula bill uski due date ke saath. 'Bill no 142, Rs 84,500, 43 din' bol kar maangne se paisa jaldi aata hai.", "यह Tally के Bills Receivable से आता है - हर खुला बिल उसकी ड्यू डेट के साथ। खास बिल नंबर बताकर मांगने से पैसा जल्दी आता है।")}
          {showByaj && <span> {tx("Interest figures are estimates under MSMED s.16 for Udyam-registered manufacturer/service MSEs (Udyam must predate the bill); traders are not covered.", "Byaj ke aankde MSMED s.16 ka andaza hain - sirf Udyam-registered manufacturer/service MSE ke liye (Udyam bill se pehle ka ho); trader cover nahi hote.", "ब्याज के आंकड़े MSMED s.16 का अंदाज़ा हैं - सिर्फ उद्यम-पंजीकृत निर्माता/सेवा MSE के लिए (उद्यम बिल से पहले का हो); ट्रेडर कवर नहीं होते।")}</span>}
        </div>
        {nudgeSheet}
      </div></div>
    );
  }

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
          {sample && <span className="demo-ribbon">SAMPLE</span>}
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
                <span className="mono" style={{ fontSize: 11, color: "var(--faint)", whiteSpace: "nowrap", flexShrink: 0 }}>{Math.round(share)}% of total</span>
                {act && <span className="mono" style={{ fontSize: 11, color: "var(--faint)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{act}</span>}
              </div>
              {isRecv && (() => {
                /* bill-wise story under the party: overdue split + oldest open bills */
                const pb = billsOf(x.name);
                if (!pb.length) return null;
                const od = pb.filter((b2) => billAge(b2) > 0);
                const odAmt = od.reduce((s, b2) => s + Number(b2.pending), 0);
                return (
                  <div style={{ borderTop: "1px dashed var(--line)", marginTop: 9, paddingTop: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: odAmt > 0 ? "#DC2626" : "var(--grn-d)", marginBottom: 3 }}>
                      {odAmt > 0
                        ? inr(odAmt) + tx(" overdue (" + od.length + " bill" + (od.length === 1 ? "" : "s") + ")", " late chal raha (" + od.length + " bill)", " लेट चल रहा (" + od.length + " बिल)")
                        : tx("All bills within time", "Sab bill time ke andar", "सभी बिल समय के अंदर")}
                    </div>
                    {pb.slice(0, 3).map((b2, bi) => {
                      const a2 = billAge(b2);
                      return (
                        <div key={bi} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "3px 0" }}>
                          <span className="mono" style={{ fontSize: 11.5, color: "var(--dim)", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>#{b2.ref || "-"}</span>
                          <span className="mono" style={{ flexShrink: 0, fontSize: 11.5, fontWeight: 600, color: a2 > 0 ? "#DC2626" : "var(--faint)" }}>{inr(b2.pending)}{a2 > 0 ? " · " + a2 + tx("d late", " din", " दिन") : ""}</span>
                        </div>
                      );
                    })}
                    {pb.length > 3 && <button className="press" onClick={() => setView("bills")} style={{ all: "unset", cursor: "pointer", fontSize: 11.5, fontWeight: 600, color: "var(--grn-d)", marginTop: 2 }}>+{pb.length - 3} {tx("more bills", "aur bill", "और बिल")}</button>}
                  </div>
                );
              })()}
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
        {sample && <span className="demo-ribbon">SAMPLE</span>}
      </div>
      <div style={{ fontSize: 12.5, color: "var(--faint)", margin: "0 0 16px 46px" }}>
        {sample ? "Example numbers - connect Tally in Setup to see your own." : asOf ? "From your Tally, updated " + new Date(asOf).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "From your Tally."}
      </div>

      {loading && <div className="mono" style={{ color: "var(--faint)", fontSize: 12, letterSpacing: ".2em", textAlign: "center", padding: 30 }}>LOADING...</div>}
      {!loading && (<>

      {/* money in / money out - tap for the full party-wise story */}
      <div className="anim-in st1" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <button className="card press" onClick={() => setView("recv")} style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", minWidth: 0, padding: "18px 15px", borderRadius: 22, border: "1px solid #CFE9D1", background: "#F3FBF4", boxShadow: "var(--sh-s)" }}>
          <div className="h-disp" style={{ fontSize: 16.5, fontWeight: 700, color: "var(--grn-d)" }}>{tx("Aane wale paise", "Aane wale paise", "आने वाले पैसे")}</div>
          <div style={{ fontSize: 12, color: "var(--dim)", marginTop: 1 }}>{tx("(customers owe you)", "(customers owe you)", "(ग्राहक आपको देंगे)")}</div>
          <div className="h-disp mono" style={{ fontSize: 25, fontWeight: 700, color: "var(--grn-d)", marginTop: 8, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{inr(recvTotal)}</div>
          <div style={{ fontSize: 12.5, color: "var(--dim)", marginTop: 5, display: "flex", alignItems: "center", gap: 3 }}>{receivable.length} customer{receivable.length === 1 ? "" : "s"} <I.chev style={{ width: 13 }} /></div>
        </button>
        <button className="card press" onClick={() => setView("pay")} style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", minWidth: 0, padding: "18px 15px", borderRadius: 22, border: "1px solid #F0DCB8", background: "#FFFBF2", boxShadow: "var(--sh-s)" }}>
          <div className="h-disp" style={{ fontSize: 16.5, fontWeight: 700, color: "var(--amber)" }}>{tx("Dene wale paise", "Dene wale paise", "देने वाले पैसे")}</div>
          <div style={{ fontSize: 12, color: "var(--dim)", marginTop: 1 }}>{tx("(you owe suppliers)", "(you owe suppliers)", "(आपको सप्लायर को देने हैं)")}</div>
          <div className="h-disp mono" style={{ fontSize: 25, fontWeight: 700, color: "var(--amber)", marginTop: 8, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{inr(payTotal)}</div>
          <div style={{ fontSize: 12.5, color: "var(--dim)", marginTop: 5, display: "flex", alignItems: "center", gap: 3 }}>{payable.length} supplier{payable.length === 1 ? "" : "s"} <I.chev style={{ width: 13 }} /></div>
        </button>
      </div>

      {/* shipped this month - tap for the dealer-wise story */}
      <div className="hero-card anim-in st2 press" onClick={() => setView("sent")} style={{ padding: "20px 20px", marginTop: 12, cursor: "pointer" }} role="button" tabIndex={0}>
        <div className="h-disp" style={{ fontSize: 16.5, fontWeight: 700, color: "#fff", position: "relative", zIndex: 1 }}>{tx("Maal sent this month", "Maal gaya is mahine", "इस महीने गया माल")}</div>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,.85)", position: "relative", zIndex: 1 }}>{tx("(sales from Tally)", "(Tally ki sales)", "(Tally की सेल्स)")}</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, position: "relative", zIndex: 1 }}>
          <span className="h-disp mono" style={{ fontSize: 40, fontWeight: 700 }}>{monthQty > 0 ? fmtQty(monthQty) : monthSales.length}</span>
          <span className="h-disp" style={{ fontSize: 19, fontWeight: 700, color: "rgba(255,255,255,.9)" }}>{monthQty > 0 ? mainUnit : "dispatches"}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, fontSize: 13, color: "rgba(255,255,255,.88)", marginTop: 4, position: "relative", zIndex: 1 }}>
          <span>{monthSales.length} dispatch{monthSales.length === 1 ? "" : "es"} · {inr(monthValue)}{tx("", " ka maal", " का माल")}</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontWeight: 700, background: "rgba(255,255,255,.16)", border: "1px solid rgba(255,255,255,.28)", padding: "4px 11px", borderRadius: 999, fontSize: 12, flexShrink: 0 }}>{tx("Who got what", "Kahan gaya", "कहां गया")} <I.chev style={{ width: 13 }} /></span>
        </div>
      </div>

      {/* bill-wise aging - paisa kahan atka hai (needs bill data; never faked from balances) */}
      {B.length > 0 && (
        <button className="card press anim-in st3" onClick={() => setView("bills")} style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", display: "block", width: "100%", padding: "18px 16px", borderRadius: 22, border: "1px solid var(--line)", background: "#fff", boxShadow: "var(--sh-s)", marginTop: 12 }}>
          <div className="h-disp" style={{ fontSize: 16.5, fontWeight: 700 }}>{tx("Money stuck, by age", "Paisa kahan atka hai", "पैसा कहां अटका है")}</div>
          <div style={{ fontSize: 12, color: "var(--dim)", marginTop: 1 }}>{tx("(bill-wise, from your Tally)", "(bill-wise, Tally se)", "(बिल-वाइज़, Tally से)")}</div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, marginTop: 5 }}>
            {overdueTotal > 0 ? (
              <span className="h-disp mono" style={{ fontSize: 25, fontWeight: 700, color: "#DC2626" }}>{inr(overdueTotal)} <span style={{ display: "inline-block", fontSize: 13.5, fontFamily: "var(--sans)", fontWeight: 600, color: "var(--dim)" }}>{tx("running late", "late chal raha", "लेट चल रहा")}</span></span>
            ) : (
              <span className="h-disp" style={{ fontSize: 20, fontWeight: 700, color: "var(--grn-d)" }}>{tx("Everything on time", "Sab time pe hai", "सब समय पर है")} 🎉</span>
            )}
            <span className="mono" style={{ flexShrink: 0, fontSize: 12.5, color: "var(--dim)" }}>{overdueCount > 0 ? overdueCount + " / " : ""}{B.length} bill{B.length === 1 ? "" : "s"}</span>
          </div>
          <div style={{ marginTop: 10 }}><AgeBar /></div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginTop: 9 }}>
            <span style={{ display: "flex", flexWrap: "wrap", gap: "3px 10px" }}>
              {AGE_BUCKETS.filter((bk) => ageSum[bk.key] > 0).map((bk) => (
                <span key={bk.key} className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, color: "var(--dim)" }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: bk.c }} />{bk.label}
                </span>
              ))}
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 13.5, fontWeight: 700, color: "var(--grn-d)", flexShrink: 0 }}>{tx("Bill by bill", "Har bill", "हर बिल")} <I.chev style={{ width: 14 }} /></span>
          </div>
          {showByaj && byajTotal > 0 && (
            <div style={{ marginTop: 10, borderTop: "1px dashed var(--line)", paddingTop: 9 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--dim)" }}>{tx("MSMED interest owed to you (est.)", "MSMED kanooni byaj banta (andaza)", "MSMED कानूनी ब्याज बनता (अंदाज़ा)")}</span>
                <b className="mono" style={{ fontSize: 15, color: "#DC2626", flexShrink: 0 }}>+{inr(byajTotal)}</b>
              </div>
              <div style={{ fontSize: 10.5, color: "var(--faint)", marginTop: 4, lineHeight: 1.5 }}>{tx("Estimate at " + msmedRateNow() + "% compound (3x bank rate, s.16). For Udyam-registered manufacturer/service MSEs; Udyam must predate the bill. Traders are not covered.", msmedRateNow() + "% compound (3x bank rate, s.16) ka andaza. Sirf Udyam-registered manufacturer/service MSE - Udyam bill se pehle ka ho. Trader cover nahi hote.", msmedRateNow() + "% चक्रवृद्धि (3x बैंक रेट, s.16) का अंदाज़ा। सिर्फ उद्यम-पंजीकृत निर्माता/सेवा MSE - उद्यम बिल से पहले का हो। ट्रेडर कवर नहीं होते।")}</div>
            </div>
          )}
          {isMachTrade && !showByaj && overdueTotal > 0 && (
            <div style={{ marginTop: 9, fontSize: 11.5, color: "var(--faint)", borderTop: "1px dashed var(--line)", paddingTop: 8 }}>{tx("Udyam registered? Turn it on in Setup - the legal interest on late bills (3x bank rate) shows here.", "Udyam registration hai? Setup mein bata do - late bills par kanooni byaj (3x bank rate) yahan dikhega.", "उद्यम रजिस्ट्रेशन है? सेटअप में बता दो - लेट बिलों पर कानूनी ब्याज (3x बैंक रेट) यहां दिखेगा।")}</div>
          )}
        </button>
      )}

      {/* dispatch planner - kise pehle bhejein. Collapsed by default: the
          overview must not overwhelm a first-time viewer */}
      {planned.length > 0 && (
      <div className="card anim-in st4" style={{ padding: 0, marginTop: 12, overflow: "hidden" }}>
        <button className="press" onClick={() => setPlannerOpen(!plannerOpen)} style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "16px 16px" }}>
          <span style={{ fontSize: 20, flexShrink: 0 }}>&#128666;</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="h-disp" style={{ fontWeight: 700, fontSize: 16.5 }}>{tx("Whom to dispatch next?", "Agla dispatch kise bhejein?", "अगला डिस्पैच किसे भेजें?")}</div>
            <div style={{ fontSize: 13, color: "var(--dim)", marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {planned.length} {tx("open orders", "order baki", "ऑर्डर बाकी")} &#183; {tx("first: ", "pehla: ", "पहला: ")}{planned[0].customer}
            </div>
          </div>
          <I.chev style={{ width: 15, flexShrink: 0, color: "var(--faint)", transform: plannerOpen ? "rotate(90deg)" : "none", transition: "transform .2s" }} />
        </button>
        {plannerOpen && (<div style={{ padding: "0 14px 14px" }}>
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
          <button className="press" onClick={() => setKnowHow(!knowHow)} style={{ all: "unset", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 3, fontSize: 12, fontWeight: 600, color: "var(--grn-d)", fontFamily: "var(--mono)", padding: "3px 10px", borderRadius: 999, background: "var(--grn-100)", flexShrink: 0 }}>
            {tx("Know how", "Know how", "कैसे बनता है")} <I.chev style={{ width: 12, transform: knowHow ? "rotate(90deg)" : "none", transition: "transform .2s" }} />
          </button>
        </div>
        {knowHow && (
          <div className="card-tint anim-in" style={{ padding: "14px 16px", marginBottom: 12, fontSize: 13, color: "var(--dim)", lineHeight: 1.65 }}>
            <div style={{ fontWeight: 700, color: "var(--ink)", marginBottom: 6 }}>{tx("How this order is worked out", "Ye order kaise banta hai", "यह क्रम कैसे बनता है")}</div>
            {tx("Our AI calculator weighs four things for every open order - and shows every reason openly on the card:", "Hamara AI calculator har order par 4 cheezein jodta hai - aur har wajah card par saaf dikhti hai:", "हमारा AI कैलकुलेटर हर ऑर्डर पर 4 चीज़ें जोड़ता है - और हर वजह कार्ड पर साफ दिखती है:")}
            <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
              {[
                [tx("Deadline pressure", "Deadline ka dabav", "डेडलाइन का दबाव"), "50%", tx("The closer (or more crossed) the promised date, the higher the order climbs.", "Promised date jitni paas - ya nikal gayi - order utna upar.", "वादे की तारीख जितनी पास - या निकल गई - ऑर्डर उतना ऊपर।")],
                [tx("Waiting days", "Intezaar ke din", "इंतज़ार के दिन"), "30%", tx("Days since the last dispatch to that party. Nobody should feel forgotten.", "Us party ko aakhri dispatch ke baad ke din. Koi bhoola hua na lage.", "उस पार्टी को आखिरी डिस्पैच के बाद के दिन। कोई भूला हुआ न लगे।")],
                [tx("Remaining maal", "Bacha maal", "बचा माल"), "20%", tx("A nearly-finished order is worth finishing - the truck frees the commitment.", "Jo order lagbhag khatam hai use nipta do - commitment poori hoti hai.", "जो ऑर्डर लगभग खत्म है उसे निपटा दो - वादा पूरा होता है।")],
                [tx("Payment caution", "Payment ka dhyaan", "पेमेंट का ध्यान"), tx("minus", "minus", "माइनस"), tx("A party sitting on more than Rs 1 lakh baki slides DOWN until money moves.", "Jis party par Rs 1 lakh se zyada baki hai, wo NEECHE khisakti hai jab tak payment na aaye.", "जिस पार्टी पर 1 लाख से ज़्यादा बाकी है, वह नीचे खिसकती है जब तक पेमेंट न आए।")],
              ].map((r, i) => (
                <div key={i} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                  <span className="mono" style={{ flexShrink: 0, fontSize: 10.5, fontWeight: 700, color: "var(--grn-d)", background: "var(--grn-100)", borderRadius: 6, padding: "2px 7px", minWidth: 34, textAlign: "center" }}>{r[1]}</span>
                  <span><b style={{ color: "var(--ink)" }}>{r[0]}</b> - {r[2]}</span>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 8, fontSize: 12, color: "var(--faint)" }}>{tx("No black box: the same reasons appear as chips on each card below.", "Koi black box nahi: yehi wajahein neeche har card par chip ban kar dikhti hain.", "कोई ब्लैक बॉक्स नहीं: यही वजहें नीचे हर कार्ड पर चिप बनकर दिखती हैं।")}</div>
          </div>
        )}
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
        </div>)}
      </div>
      )}

      <div className="card-tint anim-in st5" style={{ padding: "14px 16px", display: "flex", gap: 10, alignItems: "flex-start", marginTop: 14, marginBottom: 8 }}>
        <span style={{ color: "var(--grn)", flexShrink: 0, marginTop: 1 }}><I.bolt /></span>
        <span style={{ fontSize: 13, color: "var(--dim)", lineHeight: 1.6 }}>
          Ye page aapke accountant ke Tally se apne aap banta hai - aapko Tally kholne ki zaroorat nahi. Setup mein "Tally (BETA)" se connect hota hai.
        </span>
      </div>
      <div className="card-tint anim-in st5" style={{ padding: "14px 16px", display: "flex", gap: 10, alignItems: "flex-start", marginTop: 10, marginBottom: 8 }}>
        <span aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }}>&#128274;</span>
        <span style={{ fontSize: 13, color: "var(--dim)", lineHeight: 1.6 }}>
          {tx("Your Tally numbers stay in your own account only. The connector just READS reports - your accountant's Tally is never changed, and your data is never shared or sold.", "Aapke Tally ke numbers sirf aapke account mein rehte hain. Connector sirf report PADHTA hai - accountant ka Tally kabhi badalta nahi, aur aapka data kabhi share ya sell nahi hota.", "आपके Tally के नंबर सिर्फ आपके अकाउंट में रहते हैं। कनेक्टर सिर्फ रिपोर्ट पढ़ता है - अकाउंटेंट का Tally कभी बदलता नहीं।")}
        </span>
      </div>
      </>)}

      {/* Read-before-you-send sheet. The message is msmedChaseText() word for
          word - this only shows it and asks. Nothing is sent by the app: the
          button hands the text to WhatsApp on the owner's own number. */}
      {nudgeSheet}
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

function Help({ data, ping, startTut }) {
  const isMach = industryOf(data).key === "machining";
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
      {startTut && (
        <div className="anim-in" style={{ marginBottom: 22 }}>
          <span className="eyebrow">{tx("Learn the app", "App seekho", "\u0910\u092A \u0938\u0940\u0916\u0947\u0902")}</span>
          <div className="card" style={{ marginTop: 10, padding: "4px 15px" }}>
            {Object.keys(TUTS).filter((k) => !TUTS[k].mach || isMach).map((k, i, arr) => (
              <div key={k} style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 0", borderBottom: i < arr.length - 1 ? "1px solid var(--line)" : "none" }}>
                <span style={{ flex: 1, fontSize: 14.5, fontWeight: 600, minWidth: 0 }}>{tx(TUTS[k].name[0], TUTS[k].name[1], TUTS[k].name[2])}</span>
                <button className="btn btn-sm btn-soft press" onClick={() => startTut(k)}>{tx("Show me", "Seekho", "\u0938\u0940\u0916\u0947\u0902")}</button>
              </div>
            ))}
          </div>
          <div className="hint" style={{ marginTop: 8 }}>{tx("The app guides you on screen, step by step - nothing to read, just follow.", "App screen par step-by-step guide karta hai - padhna nahi, bas follow karo.", "\u0910\u092A \u0938\u094D\u0915\u094D\u0930\u0940\u0928 \u092A\u0930 \u0938\u094D\u091F\u0947\u092A-\u092C\u093E\u092F-\u0938\u094D\u091F\u0947\u092A \u0917\u093E\u0907\u0921 \u0915\u0930\u0924\u093E \u0939\u0948\u0964")}</div>
        </div>
      )}

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
/* ================= MACHINE FLOOR (machining only) =================
   Which machine is running which part, % done, time remaining.
   Pure time math off startedAt - no background process. Estimates carry a
   +8% breakdown / tool-change buffer (JOB_BUFFER). */
function MachineFloor({ data, setData, ping, onBack, goSetup, draft, clearDraft, floorEvents = [], onFloorSeen, addFloorEvent }) {
  const [now, setNow] = useState(Date.now());
  const [formOpen, setFormOpen] = useState(false);
  const [f, setF] = useState({ part: "", customer: "", cycleMin: "", qty: "", manualMin: "1", units: [] });
  const [xfer, setXfer] = useState(null); /* { jobId, uid, targets: [] } */
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t); }, []);
  /* a quote sent over from the Pipeline prefills the job form */
  useEffect(() => {
    if (draft) {
      setF((x) => ({ ...x, part: draft.part || "", customer: draft.customer || "", qty: draft.qty ? String(draft.qty) : "", units: [] }));
      setFormOpen(true);
      if (clearDraft) clearDraft();
    }
  }, [draft]);

  const units = machineUnits(data);
  const jobs = data.jobs || [];
  /* the SAME reducer the worker's phone runs, over the same log - the two
     screens can never disagree about which machine is down */
  const fview = floorView({
    machines: units.map((u) => ({ uid: u.uid, label: u.name })),
    jobs: (data.jobs || []).filter((j) => !j.done).map((j) => ({ id: j.id, part: j.part, customer: j.customer, qty: j.qty, startedAt: j.startedAt, alloc: jobAlloc(j) })),
    events: floorEvents,
  });
  const downBy = {}; fview.down.forEach((m) => { downBy[m.uid] = m; });
  const unseenFloor = floorEvents.filter((e) => !e.seen).length;
  /* opening this page IS reading the feed */
  useEffect(() => { if (unseenFloor && onFloorSeen) { const t = setTimeout(onFloorSeen, 1200); return () => clearTimeout(t); } return undefined; }, [unseenFloor]);
  const active = jobs.filter((j) => !j.done);
  const doneJobs = jobs.filter((j) => j.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0)).slice(0, 5);
  const busy = {};
  active.forEach((j) => jobAlloc(j).forEach((a) => { if (!a.stopped && !busy[a.uid]) busy[a.uid] = j; }));

  const qty = Math.floor(+f.qty || 0);
  const per = (+f.cycleMin || 0) + (+f.manualMin || 0);
  const est = f.units.length && per > 0 && qty > 0
    ? jobStats({ cycleMin: +f.cycleMin || 0, manualMin: +f.manualMin || 0, qty, units: f.units, startedAt: now, done: false }, now)
    : null;

  const toggleUnit = (u) => setF((x) => ({ ...x, units: x.units.includes(u) ? x.units.filter((y) => y !== u) : [...x.units, u] }));
  const startJob = () => {
    if (!f.part.trim()) return ping(tx("Write the part name", "Part ka naam likho", "पार्ट का नाम लिखें"));
    if (!(+f.cycleMin > 0)) return ping(tx("Cycle time (min/piece) is needed", "Cycle time (min/piece) chahiye", "साइकिल टाइम (मिनट/पीस) चाहिए"));
    if (!(qty > 0)) return ping(tx("Write the quantity", "Quantity likho", "मात्रा लिखें"));
    if (!f.units.length) return ping(tx("Pick at least one machine", "Kam se kam ek machine chuno", "कम से कम एक मशीन चुनें"));
    const t0 = Date.now();
    const sh = jobShares({ qty, units: f.units });
    const job = { id: uid(), part: f.part.trim(), customer: f.customer.trim(), cycleMin: +f.cycleMin, manualMin: +f.manualMin || 0, qty, units: f.units, startedAt: t0, done: false,
      alloc: f.units.map((u, i) => ({ uid: u, share: sh[i], startedAt: t0, pausedMin: 0, pausedAt: null, stopped: false })) };
    setData({ ...data, jobs: [job, ...jobs] });
    setF({ part: "", customer: "", cycleMin: "", qty: "", manualMin: "1", units: [] });
    setFormOpen(false);
    ping(tx("Job started - ", "Job chalu - ", "काम चालू - ") + job.part);
  };
  /* the floor moved work to another machine. Their view is already right; this
     rewrites the job's allocation so this app's ETA maths agrees with it. */
  const applyFloorMove = (jobId, toUid, pcsDone) => {
    setJob(jobId, (j) => {
      const t0 = Date.now();
      const done = Math.max(0, Math.min(Number(pcsDone) || 0, j.qty || 0));
      const rem = Math.max(0, (j.qty || 0) - done);
      const alloc = j.alloc.map((a) => ({ ...a, share: a.uid === toUid ? a.share : Math.min(a.share, done), stopped: a.uid !== toUid, pausedAt: null }));
      const there = alloc.find((a) => a.uid === toUid);
      if (there) { there.share = rem; there.stopped = false; there.startedAt = t0; there.pausedMin = 0; }
      else alloc.push({ uid: toUid, share: rem, startedAt: t0, pausedMin: 0, pausedAt: null, stopped: false });
      return { ...j, alloc, units: alloc.filter((a) => !a.stopped).map((a) => a.uid) };
    });
    ping(tx("Plan updated", "Plan update ho gaya", "\u092A\u094D\u0932\u093E\u0928 \u0905\u092A\u0921\u0947\u091F"));
  };
  const markDone = (id) => { setData({ ...data, jobs: jobs.map((j) => j.id === id ? { ...j, done: true, doneAt: Date.now() } : j) }); ping(tx("Job complete!", "Job complete!", "काम पूरा हुआ!")); };
  const delJob = (id) => {
    /* a job the floor started lives in the event log too - remember the
       deletion or the next poll would bring it straight back */
    const wasFloor = (jobs.find((j) => j.id === id) || {}).fromFloor;
    setData({ ...data, jobs: jobs.filter((j) => j.id !== id), deletedFloor: wasFloor ? [...(data.deletedFloor || []), id] : (data.deletedFloor || []) });
    ping(tx("Job removed", "Job hataya", "काम हटाया"));
  };
  /* setJob deep-copies the alloc so mutating inside fn is safe */
  const setJob = (id, fn) => setData({ ...data, jobs: jobs.map((j) => j.id === id ? fn({ ...j, alloc: jobAlloc(j).map((a) => ({ ...a })) }) : j) });
  const pauseUnit = (jobId, u) => { setJob(jobId, (j) => ({ ...j, alloc: j.alloc.map((a) => a.uid === u && !a.stopped ? { ...a, pausedAt: Date.now() } : a) })); ping(tx("Paused - the clock is stopped", "Pause ho gaya - time ruk gaya", "रोक दिया - समय रुक गया")); };
  const resumeUnit = (jobId, u) => { setJob(jobId, (j) => ({ ...j, alloc: j.alloc.map((a) => a.uid === u && a.pausedAt ? { ...a, pausedMin: (a.pausedMin || 0) + (Date.now() - a.pausedAt) / 60000, pausedAt: null } : a) })); ping(tx("Running again", "Wapas chalu", "फिर चालू")); };
  const transferUnit = (jobId, u, targets) => {
    if (!targets.length) return;
    setJob(jobId, (j) => {
      const t0 = Date.now();
      const per = (+j.cycleMin || 0) + (+j.manualMin || 0);
      const denom = per * JOB_BUFFER;
      const src = j.alloc.find((a) => a.uid === u);
      if (!src || src.stopped) return j;
      const donePcs = denom > 0 ? Math.min(src.share, Math.floor(unitElapsedMin(j, src, t0) / denom)) : 0;
      const rem = Math.max(0, src.share - donePcs);
      if (!rem) return j;
      src.share = donePcs; src.stopped = true; src.pausedAt = null;
      targets.forEach((tu, i) => {
        const add = Math.floor(rem / targets.length) + (i < rem % targets.length ? 1 : 0);
        if (!add) return;
        const ex = j.alloc.find((a) => a.uid === tu && !a.stopped);
        if (ex) ex.share += add;
        else j.alloc.push({ uid: tu, share: add, startedAt: t0, pausedMin: 0, pausedAt: null, stopped: false });
      });
      return j;
    });
    setXfer(null);
    ping(tx("Remaining work moved", "Baki kaam transfer ho gaya", "बाकी काम भेज दिया"));
  };
  const startSample = () => {
    const u = units[0]; if (!u) return;
    /* 200 pcs x (4.5 cycle + 0.5 handling) x 1.08 = 18 hr; started 10.8 hr ago -> 60% */
    const job = { id: uid(), part: "Gland Nut - 60mm", customer: "Apex Hydraulics", cycleMin: 4.5, manualMin: 0.5, qty: 200, units: [u.uid], startedAt: Date.now() - 10.8 * 3600000, done: false, seed: true };
    setData({ ...data, jobs: [job, ...jobs] }); ping(tx("Sample job running - this is how it looks", "Sample job chalu - aise dikhta hai", "सैंपल काम चालू - ऐसा दिखता है"));
  };

  return (
    <div className="scr"><div className="pagepad">
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
        <button className="iconbtn press" onClick={onBack}><I.back /></button>
        <div style={{ flex: 1 }}>
          <div className="microlbl">{tx("SHOP FLOOR", "SHOP FLOOR", "शॉप फ्लोर")}</div>
          <div className="h-disp" style={{ fontSize: 23, fontWeight: 700 }}>{tx("Machine floor", "Machine floor", "मशीन फ्लोर")}</div>
        </div>
        {units.length > 0 && <button className="btn btn-sm btn-grn press" onClick={() => setFormOpen(!formOpen)}>{formOpen ? tx("Close", "Close", "बंद करें") : tx("+ New job", "+ Naya job", "+ नया काम")}</button>}
      </div>
      <div style={{ fontSize: 13.5, color: "var(--dim)", margin: "2px 0 16px" }}>
        {active.length ? active.length + tx(" running - ", " job chal rahe - ", " काम चालू - ") + Object.keys(busy).length + "/" + units.length + tx(" machines busy", " machines busy", " मशीनें व्यस्त") : units.length ? tx("All machines are free", "Sab machines free hain", "सब मशीनें खाली हैं") : tx("Add your machines first", "Pehle machines jodein", "पहले मशीनें जोड़ें")}
      </div>

      {!units.length && (
        <div className="card anim-in" style={{ padding: 22, textAlign: "center" }}>
          <div style={{ fontSize: 34, marginBottom: 8 }}>🛠️</div>
          <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6 }}>{tx("Add your machines first", "Pehle apni machines jodein", "पहले अपनी मशीनें जोड़ें")}</div>
          <div style={{ fontSize: 13.5, color: "var(--dim)", lineHeight: 1.55, marginBottom: 14 }}>{tx("Add machines in Setup - VMC, lathe, press, as many as you have. Then this page shows live what is running where.", "Setup me machine add karein - VMC, lathe, press, kitni bhi. Phir yahan live dikhega kaun si machine par kya chal raha hai.", "सेटअप में मशीन जोड़ें - VMC, लेथ, प्रेस, जितनी भी हों। फिर यहां लाइव दिखेगा कौन सी मशीन पर क्या चल रहा है।")}</div>
          <button className="btn btn-grn press" onClick={goSetup}>{tx("Open Setup", "Setup kholein", "सेटअप खोलें")}</button>
          <div style={{ marginTop: 18, textAlign: "left" }}>
            <GhostPreview rows={2} tile={false} caption={tx("HOW THE BOARD WILL LOOK", "MACHINE JUDTE HI AISA DIKHEGA", "मशीन जुड़ते ही ऐसा दिखेगा")} />
          </div>
        </div>
      )}

      {formOpen && (
        <div className="card anim-in" style={{ padding: 16, marginBottom: 14, border: "1.5px solid #CFE9D1" }}>
          <div className="lbl" style={{ color: "var(--grn-d)", marginBottom: 4 }}>{tx("What are you running?", "Kya chala rahe ho?", "क्या चला रहे हैं?")}</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div><label className="lbl" style={{ fontSize: 12.5 }}>{tx("Part / item", "Part / item", "पार्ट / आइटम")}</label><input className="input" placeholder="e.g. Gland Nut" value={f.part} onChange={(e) => setF({ ...f, part: e.target.value })} /></div>
            <div><label className="lbl" style={{ fontSize: 12.5 }}>{tx("Customer", "Customer", "ग्राहक")}</label><input className="input" placeholder="e.g. Apex Hydraulics" value={f.customer} onChange={(e) => setF({ ...f, customer: e.target.value })} /></div>
            <div><label className="lbl" style={{ fontSize: 12.5 }}>{tx("Cycle time (min / pc)", "Cycle time (min / pc)", "साइकिल टाइम (मिनट / पीस)")}</label><input className="input mono" type="number" inputMode="decimal" placeholder="4.5" value={f.cycleMin} onChange={(e) => setF({ ...f, cycleMin: e.target.value })} /></div>
            <div><label className="lbl" style={{ fontSize: 12.5 }}>{tx("Quantity (pcs)", "Quantity (pcs)", "मात्रा (पीस)")}</label><input className="input mono" type="number" inputMode="numeric" placeholder="200" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></div>
          </div>
          <span className="hint">{tx("How many minutes one piece runs on the machine - that is the cycle time.", "Ek piece machine par kitne minute chalta hai - wahi cycle time.", "एक पीस मशीन पर कितने मिनट चलता है - वही साइकिल टाइम।")}</span>
          <label className="lbl" style={{ marginTop: 10 }}>{tx("Handling per piece - load, deburr (min / pc)", "Har piece pe haath ka time - loading, deburr (min / pc)", "हर पीस पर हाथ का समय - लोडिंग, डीबरिंग (मिनट / पीस)")}</label>
          <input className="input mono" type="number" inputMode="decimal" placeholder="1" value={f.manualMin} onChange={(e) => setF({ ...f, manualMin: e.target.value })} />
          <span className="hint">{tx("Between every piece the machine waits - unload, deburr, load the next blank. Even 1 min per piece changes a big batch's finish time by hours, so it is counted on every piece.", "Har piece ke beech machine rukti hai - piece nikalna, deburr, agla blank lagana. 1 min/piece bhi bade batch ki ETA ghanton se badal deta hai, isliye har piece pe ginte hain.", "हर पीस के बीच मशीन रुकती है - पीस निकालना, डीबरिंग, अगला ब्लैंक लगाना। 1 मिनट/पीस भी बड़े बैच की ETA घंटों से बदल देता है, इसलिए हर पीस पर गिनते हैं।")}</span>

          <label className="lbl" style={{ marginTop: 12 }}>{tx("Which machines will run it? (tap to pick)", "Kitni machines par chalega? (tap karke chuno)", "कितनी मशीनों पर चलेगा? (चुनने के लिए दबाएं)")}</label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {units.map((u) => {
              const taken = !!busy[u.uid], down = !!downBy[u.uid];
              return (
                <button key={u.uid} disabled={taken || down} className={"fpill press " + (f.units.includes(u.uid) ? "on" : "")} style={taken || down ? { opacity: 0.45 } : undefined} onClick={() => toggleUnit(u.uid)}>
                  {u.name}{down ? tx(" - stopped", " - band", " - बंद") : taken ? tx(" - busy", " - busy", " - व्यस्त") : ""}
                </button>
              );
            })}
          </div>

          {est && (
            <div className="card-tint" style={{ padding: "13px 14px", marginTop: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13.5, fontWeight: 600 }}>
                <span>{f.units.length} machine{f.units.length > 1 ? "s" : ""} · {tx("~" + Math.ceil(qty / f.units.length) + " pcs each", "~" + Math.ceil(qty / f.units.length) + " pcs each", "~" + Math.ceil(qty / f.units.length) + " पीस प्रति मशीन")}</span>
                <b className="mono" style={{ color: "var(--grn-d)", flexShrink: 0 }}>{fmtDur(est.remainMin)}</b>
              </div>
              <div style={{ fontSize: 12.5, color: "var(--dim)", marginTop: 3 }}>{tx("Start now and it finishes by ", "Abhi chalu karo to ", "अभी चालू करें तो ")}<b>{fmtEta(est.eta)}</b>{tx(" (includes +8% breakdown buffer)", " tak khatam (+8% breakdown buffer ke saath)", " तक खत्म (+8% ब्रेकडाउन बफर सहित)")}</div>
            </div>
          )}
          <button className="btn btn-grn press" style={{ width: "100%", marginTop: 12 }} onClick={startJob}><I.bolt /> {tx("Start job", "Job chalu karo", "काम चालू करें")}</button>
        </div>
      )}

      {/* what the floor has told you: stopped machines first, because that is
          the one thing that costs money while you read it */}
      {fview.down.map((m) => (
        <div key={m.uid} className="card anim-in" style={{ padding: "14px 15px", marginBottom: 10, background: "var(--red-bg)", borderColor: "#EFC7C2" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
            <span style={{ minWidth: 0 }}>
              <span style={{ display: "block", fontWeight: 700, fontSize: 15.5, color: "var(--red)" }}>{m.label} {tx("stopped", "band hai", "बंद है")}</span>
              <span style={{ display: "block", fontSize: 13, color: "#7A2E2E", marginTop: 2 }}>
                {reasonOf(m.reason).emoji} {LANG === "en" ? reasonOf(m.reason).en : reasonOf(m.reason).hi}{m.note ? " - " + m.note : ""}
              </span>
              <span className="mono" style={{ display: "block", fontSize: 11.5, color: "#9B6B6B", marginTop: 3 }}>
                {fmtDur(Math.max(0, (now - m.since) / 60000))} {tx("so far", "se band", "से बंद")}
              </span>
            </span>
            {addFloorEvent && (
              <button className="btn btn-sm btn-soft press" style={{ flexShrink: 0 }} onClick={() => { addFloorEvent({ kind: "up", machineUid: m.uid }); ping(tx("Marked running", "Chalu mark kiya", "चालू किया")); }}>
                {tx("Running again", "Chalu ho gayi", "चालू")}
              </button>
            )}
          </div>
        </div>
      ))}

      {units.length > 0 && active.length === 0 && !formOpen && (
        <div className="card-tint anim-in" style={{ padding: 18, textAlign: "center", marginBottom: 12 }}>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>{tx("Nothing is running", "Koi job nahi chal raha", "कोई काम नहीं चल रहा")}</div>
          <div style={{ fontSize: 13, color: "var(--dim)", marginBottom: jobs.length ? 0 : 12 }}>{tx('Tap "+ New job" - part, cycle time, quantity. Done.', '"+ Naya job" dabao - part, cycle time, quantity. Bas.', '"+ नया काम" दबाएं - पार्ट, साइकिल टाइम, मात्रा। बस।')}</div>
          {!jobs.length && <button className="btn btn-ghost press" onClick={startSample}>{tx("Try a sample job", "Sample job chala ke dekho", "सैंपल काम चला कर देखें")}</button>}
        </div>
      )}

      {units.map((u) => {
        const fm = fview.machines.find((x) => x.uid === u.uid);
        /* the floor said this machine is stopped - that beats anything the
           plan in this app believes about it */
        if (fm && fm.status === "down") return (
          <div key={u.uid} className="card anim-in" style={{ padding: "13px 15px", marginBottom: 9, display: "flex", alignItems: "center", gap: 12, background: "var(--red-bg)", borderColor: "#EFC7C2" }}>
            <span style={{ width: 38, height: 38, borderRadius: 11, background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17 }}>{reasonOf(fm.reason).emoji}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", fontWeight: 700, fontSize: 15, color: "var(--red)" }}>{u.name}</span>
              <span style={{ display: "block", fontSize: 12.5, color: "#7A2E2E" }}>{LANG === "en" ? reasonOf(fm.reason).en : reasonOf(fm.reason).hi} · {fmtDur(Math.max(0, (now - fm.since) / 60000))}</span>
            </span>
            <span className="mono" style={{ fontSize: 10.5, letterSpacing: ".1em", color: "var(--red)" }}>{tx("STOPPED", "BAND", "\u092C\u0902\u0926")}</span>
          </div>
        );
        /* the floor moved the work here, or started something itself: show
           THEIR numbers, and offer to fold it into the plan so the ETA maths
           (which lives on the job's alloc) starts working again */
        const planned = busy[u.uid];
        const floorJob = fm && fm.job ? fview.jobs[fm.job] : null;
        if (floorJob && (!planned || planned.id !== fm.job)) {
          const inPlan = (data.jobs || []).find((j) => j.id === fm.job && !j.done);
          return (
            <div key={u.uid} className="card anim-in" style={{ padding: "14px 15px", marginBottom: 9, borderColor: "#CFE9D1", background: "#F7FCF8" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <span style={{ fontWeight: 700, fontSize: 15 }}>{u.name}</span>
                <span className="mono" style={{ fontSize: 10, letterSpacing: ".08em", color: "var(--grn-d)", background: "var(--grn-100)", padding: "3px 8px", borderRadius: 999 }}>{tx("FROM THE FLOOR", "FLOOR SE", "\u092B\u094D\u0932\u094B\u0930 \u0938\u0947")}</span>
              </div>
              <div style={{ fontSize: 13.5, color: "var(--dim)", margin: "3px 0 6px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {floorJob.part}{floorJob.customer ? " \u00b7 " + floorJob.customer : ""}
              </div>
              <div className="mono" style={{ fontSize: 12.5, color: "var(--grn-d)" }}>{floorJob.pcs}{floorJob.qty ? " / " + floorJob.qty : ""} {tx("pieces", "piece", "\u092A\u0940\u0938")} · {fmtDur(Math.max(0, (now - fm.since) / 60000))}</div>
              {inPlan && (
                <button className="btn btn-sm btn-soft press" style={{ marginTop: 10 }} onClick={() => applyFloorMove(fm.job, u.uid, floorJob.pcs)}>
                  {tx("Update the plan to match", "App ke plan mein bhi daal do", "\u092A\u094D\u0932\u093E\u0928 \u092E\u0947\u0902 \u092D\u0940 \u0921\u093E\u0932\u0947\u0902")}
                </button>
              )}
            </div>
          );
        }
        /* the floor moved this job elsewhere - this machine is not running it
           any more, whatever the plan in this app still says */
        const job = planned && (!fm || fm.job === planned.id) ? planned : null;
        if (!job) return (
          <div key={u.uid} className="card anim-in" style={{ padding: "13px 15px", marginBottom: 9, display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ width: 38, height: 38, borderRadius: 11, background: "var(--soft)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17 }}>💤</span>
            <span style={{ flex: 1, fontWeight: 600, fontSize: 15 }}>{u.name}</span>
            <span className="mono" style={{ fontSize: 10.5, letterSpacing: ".1em", color: "var(--faint)" }}>{tx("FREE", "FREE", "खाली")}</span>
          </div>
        );
        const st = jobStats(job, now);
        const us = st.units.find((x) => x.uid === u.uid) || { pct: 0, pcsDone: 0, share: 0, remainMin: 0, paused: false };
        const ready = us.pct >= 100 && !us.paused;
        return (
          <div key={u.uid} className="card anim-in" style={{ padding: "14px 15px", marginBottom: 9 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <span style={{ fontWeight: 700, fontSize: 15 }}>{u.name}</span>
              <span className="mono" style={{ fontSize: 12.5, fontWeight: 700, color: us.paused ? "var(--amber)" : ready ? "#1B7A20" : "var(--grn-d)" }}>{us.paused ? tx("PAUSED", "PAUSED", "रुका") + " \u00B7 " : ""}{Math.floor(us.pct)}%</span>
            </div>
            <div style={{ fontSize: 13.5, color: "var(--dim)", margin: "3px 0 9px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {job.part}{job.customer ? " \u00B7 " + job.customer : ""}{(() => { const n2 = jobAlloc(job).filter((a) => !a.stopped).length; return n2 > 1 ? " \u00B7 " + tx("split on " + n2 + " machines", n2 + " machines par batta", n2 + " मशीनों में बंटा") : ""; })()}
            </div>
            <div style={{ height: 8, borderRadius: 6, background: "var(--line)", overflow: "hidden" }}>
              <i style={{ display: "block", height: "100%", width: Math.min(100, us.pct) + "%", background: us.paused ? "var(--amber)" : ready ? "#1B7A20" : "linear-gradient(90deg,#3FAE45,#228B22)", borderRadius: 6, transition: "width .6s" }} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8, gap: 8 }}>
              <span className="mono" style={{ fontSize: 11.5, color: "var(--dim)" }}>~{us.pcsDone}/{us.share} pcs</span>
              <span className="mono" style={{ fontSize: 11.5, color: us.paused ? "var(--amber)" : ready ? "#1B7A20" : "var(--dim)", fontWeight: ready || us.paused ? 700 : 400, textAlign: "right" }}>
                {us.paused ? fmtDur(us.remainMin) + tx(" of work waiting", " ka kaam ruka hai", " का काम रुका है")
                  : ready ? tx("Should be done - check", "Ho gaya hoga - check karo", "हो गया होगा - जांच लें")
                  : fmtDur(us.remainMin) + tx(" left", " left", " बाकी") + " \u00B7 " + fmtEta(now + us.remainMin * 60000)}
              </span>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <button className={"btn btn-sm press " + (ready ? "btn-grn" : "btn-soft")} style={{ flex: 1 }} onClick={() => markDone(job.id)}>{tx("Mark done", "Mark done", "पूरा हुआ")}</button>
              {!us.paused && !ready && <button className="btn btn-sm btn-soft press" onClick={() => pauseUnit(job.id, u.uid)}>{tx("Pause", "Pause", "रोकें")}</button>}
              {us.paused && <button className="btn btn-sm btn-grn press" onClick={() => resumeUnit(job.id, u.uid)}>{tx("Resume", "Resume", "फिर चालू")}</button>}
              <button className="iconbtn press" style={{ width: 36, height: 36 }} onClick={() => delJob(job.id)} aria-label="Delete job"><I.trash /></button>
            </div>
            {us.paused && (() => {
              const remPcs = Math.max(0, us.share - us.pcsDone);
              const open = xfer && xfer.jobId === job.id && xfer.uid === u.uid;
              const targets = units.filter((t2) => {
                if (t2.uid === u.uid) return false;
                const bj = busy[t2.uid];
                if (bj && bj.id !== job.id) return false; /* running someone else's job */
                if (bj) { const a2 = st.units.find((x) => x.uid === t2.uid); if (!a2 || a2.stopped || a2.paused) return false; }
                return true;
              });
              if (!remPcs || !targets.length) return null;
              return (
                <div style={{ marginTop: 10, borderTop: "1px dashed var(--line2)", paddingTop: 10 }}>
                  {!open ? (
                    <button className="btn btn-sm btn-ghost press" style={{ width: "100%" }} onClick={() => setXfer({ jobId: job.id, uid: u.uid, targets: [] })}>
                      {tx("Move remaining " + remPcs + " pcs to another machine", "Baki " + remPcs + " pcs doosri machine par bhejo", "बाकी " + remPcs + " पीस दूसरी मशीन पर भेजें")}
                    </button>
                  ) : (
                    <>
                      <div className="lbl" style={{ fontSize: 12.5 }}>{tx("Where should the remaining " + remPcs + " pcs go?", "Baki " + remPcs + " pcs kahan bheje?", "बाकी " + remPcs + " पीस कहां भेजें?")}</div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {targets.map((t2) => (
                          <button key={t2.uid} className={"fpill press " + (xfer.targets.includes(t2.uid) ? "on" : "")}
                            onClick={() => setXfer({ ...xfer, targets: xfer.targets.includes(t2.uid) ? xfer.targets.filter((y) => y !== t2.uid) : [...xfer.targets, t2.uid] })}>
                            {t2.name}{busy[t2.uid] && busy[t2.uid].id === job.id ? tx(" (same job)", " (isi job par)", " (इसी काम पर)") : ""}
                          </button>
                        ))}
                      </div>
                      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                        <button className="btn btn-sm btn-grn press" style={{ flex: 1 }} disabled={!xfer.targets.length} onClick={() => transferUnit(job.id, u.uid, xfer.targets)}>{tx("Transfer", "Transfer karo", "भेज दो")}</button>
                        <button className="btn btn-sm btn-soft press" onClick={() => setXfer(null)}>{tx("Cancel", "Cancel", "रहने दो")}</button>
                      </div>
                    </>
                  )}
                </div>
              );
            })()}
          </div>
        );
      })}

      {doneJobs.length > 0 && (<>
        <div style={{ margin: "22px 0 8px" }}><span className="eyebrow">{tx("Completed", "Complete hue", "पूरे हुए")}</span></div>
        {doneJobs.map((j) => (
          <div key={j.id} className="card" style={{ padding: "12px 15px", marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
            <span style={{ minWidth: 0 }}>
              <span style={{ display: "block", fontWeight: 600, fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{j.part}</span>
              <span className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>{j.qty} pcs{j.customer ? " \u00B7 " + j.customer : ""}</span>
            </span>
            <span className="pill won" style={{ flexShrink: 0 }}><i className="dot" />DONE</span>
          </div>
        ))}
      </>)}

      {/* the day, added up - the reason logging is worth the taps */}
      {floorEvents.length > 0 && (() => {
        const day = floorDay(floorEvents);
        if (!day.pcs && !day.downMin && !day.rej) return null;
        return (
          <div className="card anim-in" style={{ padding: "15px 16px", marginTop: 18 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <span className="eyebrow">{tx("Today on the floor", "Aaj floor par", "आज फ्लोर पर")}</span>
              <span className="mono" style={{ fontSize: 10, letterSpacing: ".1em", color: "var(--faint)" }}>{new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short" }).toUpperCase()}</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 9 }}>
              {[[tx("MADE", "BANE", "बने"), String(day.pcs), "var(--grn-d)"],
                [tx("REJECT", "REJECT", "रिजेक्ट"), String(day.rej), day.rej > 0 ? "var(--red)" : "var(--ink)"],
                [tx("STOPPED", "BAND RAHI", "बंद रही"), day.downMin >= 1 ? fmtDur(day.downMin) : "0", day.downMin >= 30 ? "var(--red)" : "var(--ink)"]].map(([l, v, c]) => (
                <div key={l} style={{ background: "var(--soft)", border: "1px solid var(--line)", borderRadius: 14, padding: "11px 12px" }}>
                  <div className="h-disp mono" style={{ fontSize: 19, fontWeight: 700, color: c, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{v}</div>
                  <div className="mono" style={{ fontSize: 10, fontWeight: 600, color: "var(--faint)", letterSpacing: ".06em", marginTop: 2 }}>{l}</div>
                </div>
              ))}
            </div>
            {day.topReason && day.topReasonMin >= 1 && (
              <div style={{ fontSize: 13, color: "var(--dim)", marginTop: 11, lineHeight: 1.5 }}>
                {tx("Biggest loss today: ", "Sabse zyada time gaya: ", "सबसे ज़्यादा समय गया: ")}
                <b style={{ color: "var(--ink)" }}>{reasonOf(day.topReason).emoji} {LANG === "en" ? reasonOf(day.topReason).en : reasonOf(day.topReason).hi}</b>
                {" - " + fmtDur(day.topReasonMin)}
              </div>
            )}
          </div>
        );
      })()}

      {/* everything the floor reported, newest first */}
      {floorEvents.length > 0 && (<>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", margin: "24px 0 8px" }}>
          <span className="eyebrow">{tx("From the floor", "Floor se khabar", "फ्लोर से खबर")}</span>
          <span className="mono" style={{ fontSize: 10.5, color: "var(--faint)" }}>
            {fview.todayPcs > 0 ? fview.todayPcs + tx(" pcs today", " pcs aaj", " पीस आज") : ""}{fview.todayRej > 0 ? " \u00b7 " + fview.todayRej + tx(" reject", " reject", " रिजेक्ट") : ""}
          </span>
        </div>
        {floorEvents.slice(0, 15).map((e) => {
          const l = floorLine(e, Object.fromEntries(fview.machines.map((m) => [m.uid, m])));
          return (
            <div key={e.id} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 2px", borderBottom: "1px solid var(--line)", opacity: e.seen ? 1 : 1 }}>
              <span style={{ flexShrink: 0 }}>{l.icon}</span>
              <span style={{ flex: 1, fontSize: 13.5, lineHeight: 1.45, color: l.bad ? "var(--red)" : "var(--ink)", fontWeight: e.seen ? 400 : 600 }}>{l.text}</span>
              <span className="mono" style={{ flexShrink: 0, fontSize: 11, color: "var(--faint)" }}>{fdateShort(e.at) === fdateShort(Date.now()) ? new Date(e.at).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" }) : fdateShort(e.at)}</span>
            </div>
          );
        })}
      </>)}

      {units.length > 0 && <div style={{ marginTop: 14, textAlign: "center" }}><span className="hint" style={{ display: "inline" }}>{tx("Every estimate includes a +8% breakdown / tool-change buffer.", "Har estimate me +8% breakdown / tool-change buffer juda hai.", "हर अनुमान में +8% ब्रेकडाउन / टूल-चेंज बफर जुड़ा है।")}</span></div>}
    </div></div>
  );
}

/* ================= TRUCK BOARD (scrap only) =================
   Which truck is out, carrying how much (weighbridge MT), for which dealer.
   The yard's live view - deliberately separate from Tally Insights, which
   stays a pure Tally import. Trips live in data.trips (additive, v5). */
/* ---- yard stock math (scrap only) ----
   Book stock per material = baseline (last physical count or opening entry)
   + maal aaya (stock.ins) - manual outs (stock.outs) - Truck board trips
   (category inferred from the trip's material text). Entries BEFORE a
   material's baseline date are excluded - a physical count resets the clock.
   Ghata (shrinkage/theft) events are logged when a count disagrees with book. */
const tripCat = (t) => t.cat || guessCategory(t.material || "", "scrap");
/* ---- kanta parchi (weighbridge slip) ----
   A dharam kanta prints KILOGRAMS: gross (loaded truck), tare (the same truck
   empty, weighed again after unloading) and net = gross - tare, with a slip
   serial, the vehicle number and a timestamp. The yard works in tonnes, so a
   parchi is entered exactly as the slip reads and converted in ONE place. */
const KG_PER_MT = 1000;
const parchiMT = (p) => Math.round(((Number(p && p.kg) || 0) / KG_PER_MT) * 1000) / 1000;
/* rough bytes held by the photos - data URLs are base64, so ~3/4 of the string */
const parchiBytes = (list) => (list || []).reduce((n, p) => n + (Number(p.bytes) || (p.photo ? p.photo.length * 0.75 : 0)), 0);
const stockCalc = (data) => {
  const st = data.stock || {};
  const open = st.open || {};
  const cats = {};
  const base = (c) => (open[c] && Number(open[c].at)) || 0;
  const add = (c, k, q) => {
    if (!cats[c]) cats[c] = { qty: (open[c] && Number(open[c].qty)) || 0, inWk: 0, outWk: 0, ghata: 0 };
    cats[c][k] = (cats[c][k] || 0) + q;
  };
  Object.keys(open).forEach((c) => add(c, "noop", 0));
  const now = Date.now(), wk = now - 7 * DAY;
  const days = [0, 0, 0, 0, 0, 0, 0]; /* out MT per day, index 6 = today */
  const bump = (at, q) => { const d = Math.floor((startOfDay(now) - startOfDay(at)) / DAY); if (d >= 0 && d < 7) days[6 - d] += q; };
  (st.ins || []).forEach((e) => { if (e.at > base(e.cat)) { add(e.cat, "qty", Number(e.qty) || 0); if (e.at > wk) add(e.cat, "inWk", Number(e.qty) || 0); } });
  (st.outs || []).forEach((e) => { if (e.at > base(e.cat)) { add(e.cat, "qty", -(Number(e.qty) || 0)); if (e.at > wk) add(e.cat, "outWk", Number(e.qty) || 0); bump(e.at, Number(e.qty) || 0); } });
  (data.trips || []).forEach((t) => { const c = tripCat(t); if (t.startedAt > base(c)) { add(c, "qty", -(Number(t.qty) || 0)); if (t.startedAt > wk) add(c, "outWk", Number(t.qty) || 0); bump(t.startedAt, Number(t.qty) || 0); } });
  (st.counts || []).forEach((e) => { if (cats[e.cat]) cats[e.cat].ghata += Number(e.ghata) || 0; else { add(e.cat, "noop", 0); cats[e.cat].ghata += Number(e.ghata) || 0; } });
  const total = Object.values(cats).reduce((a, x) => a + Math.max(0, x.qty), 0);
  const ghataTotal = Object.values(cats).reduce((a, x) => a + Math.max(0, x.ghata), 0);
  const outToday = days[6], outWkTotal = days.reduce((a, b) => a + b, 0);
  return { cats, total, ghataTotal, days, outToday, outWkTotal };
};

function TruckBoard({ data, setData, ping, onBack, goSetup }) {
  const [now, setNow] = useState(Date.now());
  const [formOpen, setFormOpen] = useState(false);
  const [f, setF] = useState({ truckId: "", dealer: "", material: "", qty: "", ref: "" });
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60000); return () => clearInterval(t); }, []);

  const trucks = data.trucks || [];
  const trips = data.trips || [];
  const out = {};
  trips.forEach((t) => { if (!t.delivered && !out[t.truckId]) out[t.truckId] = t; });
  const outMT = Object.values(out).reduce((s2, t) => s2 + (Number(t.qty) || 0), 0);
  const freeTrucks = trucks.filter((t) => !out[t.id]);
  const history = trips.filter((t) => t.delivered).sort((a, b) => (b.deliveredAt || 0) - (a.deliveredAt || 0)).slice(0, 6);
  const dealers = [...new Set([...(data.quotes || []).map((q) => q.customer), ...trips.map((t) => t.dealer)].filter(Boolean))].slice(0, 25);

  const send = () => {
    if (!f.truckId) return ping(tx("Pick a truck", "Gaadi chuno", "गाड़ी चुनें"));
    if (!f.dealer.trim()) return ping(tx("Write the dealer name", "Kiske paas ja raha hai? Dealer likho", "डीलर का नाम लिखें"));
    if (!(+f.qty > 0)) return ping(tx("Write the weighbridge weight (MT)", "Kante ka weight (MT) likho", "कांटे का वज़न (MT) लिखें"));
    const trip = { id: uid(), truckId: f.truckId, dealer: f.dealer.trim(), material: f.material.trim(), qty: +f.qty, ref: f.ref.trim(), startedAt: Date.now(), delivered: false };
    setData({ ...data, trips: [trip, ...trips] });
    setF({ truckId: "", dealer: "", material: "", qty: "", ref: "" }); setFormOpen(false);
    ping(tx("Truck is out - ", "Gaadi nikal gayi - ", "गाड़ी निकल गई - ") + trip.dealer);
  };
  const deliver = (id) => { setData({ ...data, trips: trips.map((t) => t.id === id ? { ...t, delivered: true, deliveredAt: Date.now() } : t) }); ping(tx("Delivered!", "Deliver ho gaya!", "डिलीवर हो गया!")); };
  const delTrip = (id) => { setData({ ...data, trips: trips.filter((t) => t.id !== id) }); ping(tx("Trip removed", "Trip hataya", "ट्रिप हटाया")); };
  const sampleFleet = () => {
    const t1 = { id: uid(), number: "HR 38 AB 1234", capMT: 18 }, t2 = { id: uid(), number: "HR 55 C 7788", capMT: 12 };
    const trip = { id: uid(), truckId: t1.id, dealer: "Apex Alloys", material: "MS Scrap", qty: 12.5, ref: "SL/142", startedAt: Date.now() - 3 * 3600000, delivered: false, seed: true };
    setData({ ...data, trucks: [...trucks, t1, t2], trips: [trip, ...trips] });
    ping(tx("Sample fleet loaded - this is how it looks", "Sample gaadiyan aa gayin - aise dikhta hai", "सैंपल गाड़ियां आ गईं - ऐसा दिखता है"));
  };

  return (
    <div className="scr"><div className="pagepad">
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
        <button className="iconbtn press" onClick={onBack}><I.back /></button>
        <div style={{ flex: 1 }}>
          <div className="microlbl">{tx("YARD", "YARD", "यार्ड")}</div>
          <div className="h-disp" style={{ fontSize: 23, fontWeight: 700 }}>{tx("Truck board", "Truck board", "ट्रक बोर्ड")}</div>
        </div>
        {trucks.length > 0 && <button className="btn btn-sm btn-grn press" onClick={() => setFormOpen(!formOpen)}>{formOpen ? tx("Close", "Close", "बंद करें") : tx("+ Truck bhejo", "+ Truck bhejo", "+ ट्रक भेजें")}</button>}
      </div>
      <div style={{ fontSize: 13.5, color: "var(--dim)", margin: "2px 0 16px" }}>
        {Object.keys(out).length ? Object.keys(out).length + "/" + trucks.length + tx(" trucks out - ", " trucks bahar - ", " ट्रक बाहर - ") + fmtQty(outMT) + tx(" MT on the road", " MT ja raha hai", " MT जा रहा है") : trucks.length ? tx("All trucks are in the yard", "Sab gaadiyan yard me hain", "सब गाड़ियां यार्ड में हैं") : tx("Add trucks first", "Pehle gaadiyan jodo", "पहले गाड़ियां जोड़ें")}
      </div>

      {!trucks.length && (
        <div className="card anim-in" style={{ padding: 22, textAlign: "center" }}>
          <div style={{ fontSize: 34, marginBottom: 8 }}>🚚</div>
          <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6 }}>{tx("Add your trucks first", "Pehle apni gaadiyan jodo", "पहले अपनी गाड़ियां जोड़ें")}</div>
          <div style={{ fontSize: 13.5, color: "var(--dim)", lineHeight: 1.55, marginBottom: 14 }}>{tx("Add truck numbers in Setup. Then log every loading here - who it went to, how much maal, which truck.", "Setup me truck number jodo. Phir har loading yahan likho - kiske paas gayi, kitna maal, kaun si gaadi.", "सेटअप में ट्रक नंबर जोड़ें। फिर हर लोडिंग यहां लिखें - किसके पास गई, कितना माल, कौन सी गाड़ी।")}</div>
          <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
            <button className="btn btn-grn press" onClick={goSetup}>{tx("Open Setup", "Setup kholo", "सेटअप खोलें")}</button>
            <button className="btn btn-ghost press" onClick={sampleFleet}>{tx("Try a sample", "Sample dekho", "सैंपल देखें")}</button>
          </div>
        </div>
      )}

      {formOpen && (
        <div className="card anim-in" style={{ padding: 16, marginBottom: 14, border: "1.5px solid #CFE9D1" }}>
          <div className="lbl" style={{ color: "var(--grn-d)", marginBottom: 4 }}>{tx("What is going out?", "Kya bhej rahe ho?", "क्या भेज रहे हैं?")}</div>
          <label className="lbl" style={{ fontSize: 12.5 }}>{tx("Which truck? (free ones)", "Kaun si gaadi? (jo khaali hai)", "कौन सी गाड़ी? (जो खाली है)")}</label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {trucks.map((t) => {
              const busy2 = !!out[t.id];
              return <button key={t.id} disabled={busy2} className={"fpill press " + (f.truckId === t.id ? "on" : "")} style={busy2 ? { opacity: 0.45 } : undefined} onClick={() => setF({ ...f, truckId: t.id })}>{t.number}{busy2 ? tx(" - out", " - bahar", " - बाहर") : ""}</button>;
            })}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12 }}>
            <div><label className="lbl" style={{ fontSize: 12.5 }}>{tx("Dealer / party", "Dealer / party", "डीलर / पार्टी")}</label><input className="input" list="qk-dealers" placeholder="Apex Alloys" value={f.dealer} onChange={(e) => setF({ ...f, dealer: e.target.value })} /></div>
            <div><label className="lbl" style={{ fontSize: 12.5 }}>{tx("Material", "Maal", "माल")}</label><input className="input" placeholder="MS Scrap" value={f.material} onChange={(e) => setF({ ...f, material: e.target.value })} /></div>
            <div><label className="lbl" style={{ fontSize: 12.5 }}>{tx("Weighbridge weight (MT)", "Kanta weight (MT)", "कांटा वज़न (MT)")}</label><input className="input mono" type="number" inputMode="decimal" placeholder="12.5" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></div>
            <div><label className="lbl" style={{ fontSize: 12.5 }}>{tx("Bill / ref no (optional)", "Bill / ref no (optional)", "बिल / रेफ नंबर (वैकल्पिक)")}</label><input className="input mono" placeholder="SL/142" value={f.ref} onChange={(e) => setF({ ...f, ref: e.target.value })} /></div>
          </div>
          <datalist id="qk-dealers">{dealers.map((d2) => <option key={d2} value={d2} />)}</datalist>
          <button className="btn btn-grn press" style={{ width: "100%", marginTop: 12 }} onClick={send}><I.bolt /> {tx("Truck went out", "Gaadi nikli", "गाड़ी निकली")}</button>
        </div>
      )}

      {trucks.map((t) => {
        const trip = out[t.id];
        if (!trip) return (
          <div key={t.id} className="card anim-in" style={{ padding: "13px 15px", marginBottom: 9, display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ width: 38, height: 38, borderRadius: 11, background: "var(--soft)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17 }}>🚚</span>
            <span className="mono" style={{ flex: 1, fontWeight: 700, fontSize: 14.5, letterSpacing: ".04em" }}>{t.number}</span>
            <span className="mono" style={{ fontSize: 10.5, letterSpacing: ".1em", color: "var(--faint)" }}>{tx("IN YARD", "YARD ME", "यार्ड में")}</span>
          </div>
        );
        const hrs = (now - trip.startedAt) / 3600000;
        return (
          <div key={t.id} className="card anim-in" style={{ padding: "14px 15px", marginBottom: 9, borderColor: "#CFE9D1", background: "#F7FCF8" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <span className="mono" style={{ fontWeight: 700, fontSize: 14.5, letterSpacing: ".04em" }}>{t.number}</span>
              <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: "var(--grn-d)", background: "var(--grn-100)", padding: "3px 9px", borderRadius: 999 }}>{tx("OUT", "BAHAR", "बाहर")} · {hrs < 24 ? Math.round(hrs) + " hr" : Math.round(hrs / 24) + tx(" day", " din", " दिन")}</span>
            </div>
            <div style={{ fontSize: 14.5, fontWeight: 600, marginTop: 8 }}>{trip.dealer}</div>
            <div className="mono" style={{ fontSize: 12.5, color: "var(--grn-d)", marginTop: 2 }}>
              {fmtQty(trip.qty)} MT{trip.material ? " · " + trip.material : ""}{trip.ref ? " · #" + trip.ref : ""}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <button className="btn btn-sm btn-grn press" style={{ flex: 1 }} onClick={() => deliver(trip.id)}>{tx("Delivered", "Deliver ho gaya", "डिलीवर हो गया")}</button>
              <button className="iconbtn press" style={{ width: 36, height: 36 }} onClick={() => delTrip(trip.id)} aria-label="Delete trip"><I.trash /></button>
            </div>
          </div>
        );
      })}

      {trucks.length > 0 && Object.keys(out).length === 0 && !formOpen && (
        <div className="card-tint anim-in" style={{ padding: 18, textAlign: "center", marginTop: 4 }}>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>{tx("All trucks are home", "Sab gaadiyan ghar par", "सब गाड़ियां घर पर")}</div>
          <div style={{ fontSize: 13, color: "var(--dim)" }}>{tx('Loading a truck? Tap "+ Truck bhejo" - weighbridge weight, dealer, done.', 'Gaadi load ho rahi hai? "+ Truck bhejo" dabao - kanta weight, dealer, bas.', 'गाड़ी लोड हो रही है? "+ ट्रक भेजें" दबाएं - कांटा वज़न, डीलर, बस।')}</div>
        </div>
      )}

      {history.length > 0 && (<>
        <div style={{ margin: "22px 0 8px" }}><span className="eyebrow">{tx("Delivered", "Deliver hue", "डिलीवर हुए")}</span></div>
        {history.map((t) => {
          const tr = trucks.find((x) => x.id === t.truckId);
          return (
            <div key={t.id} className="card" style={{ padding: "12px 15px", marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: "block", fontWeight: 600, fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.dealer}</span>
                <span className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>{fmtQty(t.qty)} MT{t.material ? " · " + t.material : ""}{tr ? " · " + tr.number : ""} · {fdateShort(t.deliveredAt || t.startedAt)}</span>
              </span>
              <span className="pill won" style={{ flexShrink: 0 }}><i className="dot" />{tx("DONE", "DONE", "हुआ")}</span>
            </div>
          );
        })}
      </>)}

      {trucks.length > 0 && <div style={{ marginTop: 14, textAlign: "center" }}><span className="hint" style={{ display: "inline" }}>{tx("This is the yard's live board. Tally Insights stays a pure Tally import.", "Ye yard ka live board hai - Tally wala page sirf Tally ka saaf hisaab rehta hai.", "यह यार्ड का लाइव बोर्ड है - Tally वाला पेज सिर्फ Tally का साफ हिसाब रहता है।")}</span></div>}
    </div></div>
  );
}

/* Renders a parchi photo from wherever it lives: an IndexedDB blob (`img`) or
   an inline data URL (`photo`, how the first version saved them). */
function ParchiImg({ pc, style, onClick, alt = "" }) {
  const [src, setSrc] = useState(pc && pc.photo ? pc.photo : "");
  const key = pc ? (pc.photo ? "inline" : pc.img || "") : "";
  useEffect(() => {
    let dead = false, made = "";
    if (!pc) return undefined;
    if (pc.photo) { setSrc(pc.photo); return undefined; }
    if (!pc.img) { setSrc(""); return undefined; }
    photoGet(pc.img).then((blob) => {
      if (dead || !blob) return;
      made = URL.createObjectURL(blob);
      setSrc(made);
    });
    return () => { dead = true; if (made) URL.revokeObjectURL(made); };
  }, [key]);
  if (!src) return <span style={{ ...style, background: "var(--soft)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>{"\u{1F4C4}"}</span>;
  return <img src={src} alt={alt} onClick={onClick} style={style} />;
}

/* ================= YARD STOCK (scrap only) =================
   One page: kitna maal hai, roz kitna gaya, dene wale, aur GHATA -
   book stock vs kanta check. Built after a real yard lost ~17 MT to
   theft over six months without anyone noticing. */
function StockYard({ data, setData, ping, onBack }) {
  const [inOpen, setInOpen] = useState(false);
  const [outOpen, setOutOpen] = useState(false);
  const [countFor, setCountFor] = useState(null); /* cat key being counted */
  const [f, setF] = useState({ cat: "", qty: "", party: "", ref: "" });
  const [cQty, setCQty] = useState("");
  /* kanta parchi: the photo of the slip, then the questions it cannot answer */
  const [pDraft, setPDraft] = useState(null); /* {photo, dir, cat, gross, tare, kg, manualNet, party, ref, vehicle, at, apply} */
  const [viewP, setViewP] = useState(null);   /* parchi open full-screen */
  const [pBusy, setPBusy] = useState(false);
  const [pRead, setPRead] = useState(null); /* {busy} | {ok, mismatch} | {why} - AI reading of the slip */
  const parchiFile = useRef(null);
  const [pay, setPay] = useState(null); /* dene-wale total, cloud or sample */
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!sb) { if (alive) setPay(TALLY_SAMPLE.ledgers.filter((x) => x.grp === "creditor" && x.balance > 0).reduce((a, x) => a + x.balance, 0)); return; }
      try {
        const r = await sb.from("tally_ledgers").select("balance,grp");
        const rows = (!r.error && r.data) || [];
        if (!alive) return;
        if (!rows.length) setPay(TALLY_SAMPLE.ledgers.filter((x) => x.grp === "creditor" && x.balance > 0).reduce((a, x) => a + x.balance, 0));
        else setPay(rows.filter((x) => x.grp === "creditor" && x.balance > 0).reduce((a, x) => a + Number(x.balance), 0));
      } catch { if (alive) setPay(null); }
    })();
    return () => { alive = false; };
  }, []);

  const ind = industryOf(data);
  const cats = (ind.cats || []).filter((c) => c.key !== "other");
  const meta = (k) => cats.find((c) => c.key === k) || { key: k, label: k, emoji: "📦" };
  /* photos saved by the first version sit inline in the synced blob - move
     them into IndexedDB once, quietly, so the blob shrinks on its own */
  const migrated = useRef(false);
  useEffect(() => {
    if (migrated.current) return;
    const old = ((data.stock && data.stock.parchis) || []).filter((x) => x.photo && !x.img);
    if (!old.length) return;
    migrated.current = true;
    (async () => {
      const done = {};
      for (const x of old) {
        try {
          const blob = await (await fetch(x.photo)).blob();
          const key = "ph_" + x.id;
          if (await photoPut(key, blob)) done[x.id] = { img: key, bytes: blob.size };
        } catch {}
      }
      if (Object.keys(done).length) {
        setData((d) => ({ ...d, stock: { ...(d.stock || {}), parchis: ((d.stock && d.stock.parchis) || []).map((x) => (done[x.id] ? { ...x, ...done[x.id], photo: "" } : x)) } }));
      }
    })();
  }, [data.stock && data.stock.parchis]);
  const stk = stockCalc(data);
  const st = data.stock || { open: {}, ins: [], outs: [], counts: [] };
  const hasAny = Object.keys(stk.cats).length > 0;
  const dmax = Math.max(0.001, ...stk.days);

  const save = (patch) => setData({ ...data, stock: { open: {}, ins: [], outs: [], counts: [], parchis: [], ...st, ...patch } });
  const parchis = st.parchis || [];
  const logIn = () => {
    if (!f.cat) return ping(tx("Pick the material", "Maal chuno", "माल चुनें"));
    if (!(+f.qty > 0)) return ping(tx("Weighbridge weight (MT)?", "Kanta weight (MT) likho", "कांटा वज़न (MT) लिखें"));
    save({ ins: [{ id: uid(), cat: f.cat, qty: +f.qty, party: f.party.trim(), ref: f.ref.trim(), at: Date.now() }, ...(st.ins || [])] });
    setF({ cat: "", qty: "", party: "", ref: "" }); setInOpen(false);
    ping(tx("Stock added", "Maal aaya - stock me juda", "माल आया - स्टॉक में जुड़ा"));
  };
  const logOut = () => {
    if (!f.cat) return ping(tx("Pick the material", "Maal chuno", "माल चुनें"));
    if (!(+f.qty > 0)) return ping(tx("Weight (MT)?", "Kitna gaya (MT)?", "कितना गया (MT)?"));
    save({ outs: [{ id: uid(), cat: f.cat, qty: +f.qty, party: f.party.trim(), ref: f.ref.trim(), at: Date.now() }, ...(st.outs || [])] });
    setF({ cat: "", qty: "", party: "", ref: "" }); setOutOpen(false);
    ping(tx("Removed from stock", "Stock se nikla", "स्टॉक से निकला"));
  };
  const doCount = (catKey) => {
    const counted = +cQty;
    if (!(counted >= 0)) return ping(tx("Write the counted weight", "Kante ka weight likho", "कांटे का वज़न लिखें"));
    const book = (stk.cats[catKey] && stk.cats[catKey].qty) || 0;
    const ghata = Math.round((book - counted) * 100) / 100;
    save({
      open: { ...(st.open || {}), [catKey]: { qty: counted, at: Date.now() } },
      counts: [{ id: uid(), cat: catKey, qty: counted, book: Math.round(book * 100) / 100, ghata: ghata > 0 ? ghata : 0, at: Date.now() }, ...(st.counts || [])],
    });
    setCountFor(null); setCQty("");
    if (ghata > 0.05) ping(tx("GHATA of " + fmtQty(ghata) + " MT recorded!", "GHATA " + fmtQty(ghata) + " MT - record ho gaya!", "घाटा " + fmtQty(ghata) + " MT - दर्ज हुआ!"));
    else ping(tx("Stock verified - all good", "Kanta check done - sab barabar", "कांटा चेक हुआ - सब बराबर"));
  };
  /* ---- parchi handlers ----
     Nothing touches the yard total until the owner answers both questions:
     which way the maal moved, and whether this slip should move the stock. */
  const onParchiPick = async (e) => {
    const file = e.target.files && e.target.files[0]; e.target.value = "";
    if (!file) return;
    setPBusy(true);
    /* bigger than a quote thumbnail - the slip's numbers have to stay readable,
       and kept as a Blob so it can go straight into IndexedDB on save */
    const photo = await downscaleImage(file, 1100, 0.55, { gray: true, blob: true });
    setPBusy(false);
    if (!photo) return ping(tx("Could not read that photo", "Photo nahi padh paye", "फोटो नहीं पढ़ पाए"));
    if (pDraft && pDraft.url) URL.revokeObjectURL(pDraft.url);
    setPDraft({ blob: photo, url: URL.createObjectURL(photo), dir: "", cat: "", gross: "", tare: "", kg: "", manualNet: false, party: "", ref: "", vehicle: "", at: startOfDay(Date.now()) + 12 * 3600000, apply: true });
    setPRead(null);
    if (data.settings && data.settings.aiParse) runRead(photo);
  };
  const closeDraft = () => { if (pDraft && pDraft.url) URL.revokeObjectURL(pDraft.url); setPDraft(null); setPRead(null); };
  /* Claude reads the slip and PRE-FILLS - it never saves anything by itself.
     A weighbridge slip cannot say whether the maal came in or went out, so
     that question is still the owner's, and every number stays editable. */
  const runRead = async (blob) => {
    setPRead({ busy: true });
    const { fields, why } = await aiReadParchi(blob);
    if (!fields) { setPRead({ why: why || "could not read it" }); return; }
    const mul = fields.unit === "mt" ? 1000 : fields.unit === "qtl" ? 100 : 1;
    const kgOf = (v) => (v ? String(Math.round(Number(v) * mul * 100) / 100) : "");
    const cat = fields.material ? guessCategory(fields.material, "scrap") : "";
    setPDraft((d) => (d ? {
      ...d,
      gross: d.gross || kgOf(fields.gross),
      tare: d.tare || kgOf(fields.tare),
      /* net is only kept when the slip printed it and gross/tare did not
         already give us the subtraction */
      kg: d.kg || (fields.gross && fields.tare ? "" : kgOf(fields.net)),
      manualNet: d.manualNet || (!(fields.gross && fields.tare) && !!fields.net),
      party: d.party || fields.party || "",
      ref: d.ref || fields.slipNo || "",
      vehicle: d.vehicle || fields.vehicle || "",
      cat: d.cat || (cats.some((c) => c.key === cat) ? cat : ""),
      at: fields.date ? new Date(fields.date + "T12:00:00").getTime() : d.at,
    } : d));
    setPRead({ ok: true, mismatch: !!fields.mismatch });
  };
  const draftKg = (d) => {
    if (d.manualNet) return Number(d.kg) || 0;
    const g = Number(d.gross) || 0, t = Number(d.tare) || 0;
    return g > 0 && t > 0 ? Math.max(0, g - t) : (Number(d.kg) || 0);
  };
  /* create / remove the stock entry a parchi stands behind. The entry carries
     the parchi id, so the two can never drift apart. */
  const linkParchi = (pc, on, list) => {
    const key = pc.dir === "in" ? "ins" : "outs";
    const src = list || parchis;
    if (on) {
      const lid = uid();
      return {
        [key]: [{ id: lid, cat: pc.cat, qty: parchiMT(pc), party: pc.party, ref: pc.ref, at: pc.at, fromParchi: pc.id }, ...(st[key] || [])],
        parchis: src.map((x) => (x.id === pc.id ? { ...x, linkId: lid } : x)),
      };
    }
    return {
      [key]: (st[key] || []).filter((x) => x.id !== pc.linkId),
      parchis: src.map((x) => (x.id === pc.id ? { ...x, linkId: null } : x)),
    };
  };
  const saveParchi = async () => {
    const d = pDraft;
    if (!d.dir) return ping(tx("Is the maal coming in or going out?", "Maal aa raha hai ya ja raha hai?", "माल आ रहा है या जा रहा है?"));
    if (!d.cat) return ping(tx("Pick the material", "Maal chuno", "माल चुनें"));
    const kg = draftKg(d);
    if (!(kg > 0)) return ping(tx("Write the weight from the slip", "Parchi ka weight likho", "पर्ची का वज़न लिखें"));
    const id = uid(), key = "ph_" + id;
    /* the image goes to IndexedDB - only its key rides in the synced blob.
       No IndexedDB (private window) falls back to the old inline data URL. */
    const stored = await photoPut(key, d.blob);
    const inline = stored ? "" : await blobToDataUrl(d.blob);
    const pc = { id, img: stored ? key : "", photo: inline, bytes: d.blob.size, dir: d.dir, cat: d.cat, kg, gross: Number(d.gross) || 0, tare: Number(d.tare) || 0,
      party: d.party.trim(), ref: d.ref.trim(), vehicle: d.vehicle.trim().toUpperCase(), at: d.at, addedAt: Date.now(), linkId: null };
    const list = [pc, ...parchis];
    save(d.apply ? { parchis: list, ...linkParchi(pc, true, list) } : { parchis: list });
    closeDraft();
    const mt = fmtQty(parchiMT(pc));
    if (!d.apply) return ping(tx("Parchi saved - stock not changed", "Parchi save - stock nahi badla", "पर्ची सेव - स्टॉक नहीं बदला"));
    ping(d.dir === "in" ? tx(mt + " MT added to stock", mt + " MT stock me juda", mt + " MT स्टॉक में जुड़ा")
      : tx(mt + " MT removed from stock", mt + " MT stock se ghata", mt + " MT स्टॉक से घटा"));
  };
  const toggleParchi = (pc) => {
    const on = !pc.linkId;
    save(linkParchi(pc, on));
    setViewP({ ...pc, linkId: on ? "x" : null });
    ping(on ? (pc.dir === "in" ? tx("Added to stock", "Stock me juda", "स्टॉक में जुड़ा") : tx("Removed from stock", "Stock se ghata", "स्टॉक से घटा"))
      : tx("Stock change undone - parchi kept", "Stock wapas - parchi rahegi", "स्टॉक वापस - पर्ची रहेगी"));
  };
  const delParchi = (pc) => {
    const key = pc.dir === "in" ? "ins" : "outs";
    if (pc.img) photoDel(pc.img);
    save({ parchis: parchis.filter((x) => x.id !== pc.id), [key]: (st[key] || []).filter((x) => x.id !== pc.linkId) });
    setViewP(null);
    ping(tx("Parchi deleted", "Parchi hat gayi", "पर्ची हट गई"));
  };
  const dropPhoto = (pc) => {
    if (pc.img) photoDel(pc.img);
    save({ parchis: parchis.map((x) => (x.id === pc.id ? { ...x, photo: "", img: "", bytes: 0 } : x)) });
    setViewP({ ...pc, photo: "", img: "" });
    ping(tx("Photo removed - the entry stays", "Photo hata - entry rahegi", "फोटो हटा - एंट्री रहेगी"));
  };

  const sampleStock = () => {
    const now = Date.now();
    save({
      open: { ms: { qty: 42.5, at: now - 30 * DAY }, copper: { qty: 3.2, at: now - 30 * DAY }, alu: { qty: 8.4, at: now - 30 * DAY } },
      ins: [
        { id: uid(), cat: "ms", qty: 20, party: "Yard Suppliers Co", ref: "P-88", at: now - 2 * DAY, seed: true },
        { id: uid(), cat: "alu", qty: 4.5, party: "Local pickup", ref: "", at: now - 4 * DAY, seed: true },
      ],
      outs: [{ id: uid(), cat: "ms", qty: 6.2, party: "Shakti Traders", ref: "SL/144", at: now - 1 * DAY, seed: true }],
      counts: [{ id: uid(), cat: "ms", qty: 54.5, book: 56.3, ghata: 1.8, at: now - 1 * DAY, seed: true }],
    });
    ping(tx("Sample stock loaded", "Sample stock aa gaya - aise dikhta hai", "सैंपल स्टॉक आ गया"));
  };

  const chipRow = (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {cats.map((c) => (
        <button key={c.key} className={"fpill press " + (f.cat === c.key ? "on" : "")} onClick={() => setF({ ...f, cat: c.key })}>{c.emoji} {c.label}</button>
      ))}
    </div>
  );
  const formFields = (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12 }}>
      <div><label className="lbl" style={{ fontSize: 12.5 }}>{tx("Weighbridge weight (MT)", "Kanta weight (MT)", "कांटा वज़न (MT)")}</label><input className="input mono" type="number" inputMode="decimal" placeholder="12.5" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></div>
      <div><label className="lbl" style={{ fontSize: 12.5 }}>{tx("Party (optional)", "Party (optional)", "पार्टी (वैकल्पिक)")}</label><input className="input" placeholder="Yard Suppliers Co" value={f.party} onChange={(e) => setF({ ...f, party: e.target.value })} /></div>
    </div>
  );

  const kgNow = pDraft ? draftKg(pDraft) : 0;
  const mtNow = Math.round((kgNow / KG_PER_MT) * 1000) / 1000;
  const parties = [...new Set([...(data.quotes || []).map((q) => q.customer), ...(data.trips || []).map((t) => t.dealer), ...parchis.map((x) => x.party)].filter(Boolean))].slice(0, 25);
  /* three things that quietly corrupt a yard total, said out loud */
  const dupSlip = !!(pDraft && pDraft.ref.trim() && parchis.some((x) => x.ref && x.ref.toLowerCase() === pDraft.ref.trim().toLowerCase()));
  const truckSameDay = !!(pDraft && pDraft.dir === "out" && pDraft.party.trim() && (data.trips || []).some((t) =>
    partyKey(t.dealer) === partyKey(pDraft.party) && startOfDay(t.startedAt) === startOfDay(pDraft.at)));
  const beforeCount = !!(pDraft && pDraft.cat && st.open && st.open[pDraft.cat] && Number(st.open[pDraft.cat].at) > pDraft.at);
  const warn = (text) => (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 10, padding: "10px 12px", borderRadius: 12, background: "var(--amber-bg)", border: "1px solid #F0DCB8", fontSize: 12.5, color: "#7A5510", lineHeight: 1.5 }}>
      <span aria-hidden="true" style={{ flexShrink: 0 }}>{"\u26A0\uFE0F"}</span><span>{text}</span>
    </div>
  );
  const dirBtn = (key, label, sub) => (
    <button className="press" onClick={() => setPDraft({ ...pDraft, dir: key })} style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", flex: 1, textAlign: "center", padding: "14px 10px", borderRadius: 16,
      border: "1.5px solid " + (pDraft.dir === key ? "var(--grn-x)" : "var(--line2)"), background: pDraft.dir === key ? "#F3FBF4" : "#fff" }}>
      <span style={{ display: "block", fontWeight: 700, fontSize: 15.5, color: pDraft.dir === key ? "var(--grn-d)" : "var(--ink)" }}>{label}</span>
      <span style={{ display: "block", fontSize: 12, color: "var(--dim)", marginTop: 2 }}>{sub}</span>
    </button>
  );

  return (<>
    <div className="scr"><div className="pagepad">
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
        <button className="iconbtn press" onClick={onBack}><I.back /></button>
        <div style={{ flex: 1 }}>
          <div className="microlbl">{tx("YARD", "YARD", "यार्ड")}</div>
          <div className="h-disp" style={{ fontSize: 23, fontWeight: 700 }}>{tx("Stock", "Stock", "स्टॉक")}</div>
        </div>
        <button className="btn btn-sm btn-grn press" onClick={() => { setInOpen(!inOpen); setOutOpen(false); }}>{inOpen ? tx("Close", "Close", "बंद") : tx("+ Maal aaya", "+ Maal aaya", "+ माल आया")}</button>
      </div>
      <div style={{ fontSize: 13.5, color: "var(--dim)", margin: "2px 0 16px" }}>
        {tx("What should be in the yard vs what is - catch ghata before it grows.", "Yard me kitna hona chahiye vs kitna hai - ghata badhne se pehle pakdo.", "यार्ड में कितना होना चाहिए बनाम कितना है - घाटा बढ़ने से पहले पकड़ें।")}
      </div>

      {/* top tiles */}
      <div className="anim-in st1" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div className="card" style={{ padding: "14px 15px", background: "#F3FBF4", borderColor: "#CFE9D1" }}>
          <div className="microlbl" style={{ color: "var(--grn-d)" }}>{tx("IN THE YARD", "YARD ME MAAL", "यार्ड में माल")}</div>
          <div className="h-disp mono" style={{ fontSize: 24, fontWeight: 700, color: "var(--grn-d)", marginTop: 4 }}>{fmtQty(stk.total)} MT</div>
        </div>
        <div className="card" style={{ padding: "14px 15px", background: stk.ghataTotal > 0 ? "var(--red-bg)" : "var(--soft)", borderColor: stk.ghataTotal > 0 ? "#EFC7C2" : "var(--line)" }}>
          <div className="microlbl" style={{ color: stk.ghataTotal > 0 ? "var(--red)" : "var(--faint)" }}>{tx("GHATA (missing)", "GHATA", "घाटा")}</div>
          <div className="h-disp mono" style={{ fontSize: 24, fontWeight: 700, color: stk.ghataTotal > 0 ? "var(--red)" : "var(--ink)", marginTop: 4 }}>{stk.ghataTotal > 0 ? fmtQty(stk.ghataTotal) + " MT" : "0"}</div>
        </div>
      </div>
      <div className="anim-in st1" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
        <div className="card" style={{ padding: "14px 15px" }}>
          <div className="microlbl">{tx("SENT TODAY / 7 DIN", "AAJ GAYA / 7 DIN", "आज गया / 7 दिन")}</div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 10 }}>
            <div className="h-disp mono" style={{ fontSize: 24, fontWeight: 700, marginTop: 4 }}>{fmtQty(stk.outToday)} <span style={{ fontSize: 13 }}>MT</span></div>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 26, flex: 1, paddingBottom: 3 }}>
              {stk.days.map((v, i) => (<i key={i} style={{ flex: 1, borderRadius: 2, background: v ? "var(--grn)" : "var(--line2)", opacity: v ? 0.4 + (v / dmax) * 0.6 : 1, height: 4 + (v / dmax) * 20, display: "block" }} />))}
            </div>
          </div>
          <div className="mono" style={{ fontSize: 10.5, color: "var(--faint)", marginTop: 3 }}>{fmtQty(stk.outWkTotal)} MT {tx("this week", "is hafte", "इस हफ्ते")}</div>
        </div>
        <div className="card" style={{ padding: "14px 15px", background: "#FFFBF2", borderColor: "#F0DCB8" }}>
          <div className="microlbl" style={{ color: "var(--amber)" }}>{tx("YOU OWE (suppliers)", "DENE WALE", "देने वाले")}</div>
          <div className="h-disp mono" style={{ fontSize: 24, fontWeight: 700, color: "var(--amber)", marginTop: 4 }}>{pay == null ? "-" : inr(pay)}</div>
          <div className="mono" style={{ fontSize: 10, color: "var(--faint)", marginTop: 2 }}>{sb ? tx("from Tally", "Tally se", "Tally से") : tx("sample", "sample", "सैंपल")}</div>
        </div>
      </div>

      {/* the kanta slip itself - photo first, questions after */}
      {/* no `capture` attribute on purpose: iOS would then open the camera ONLY,
          and half these slips arrive as a photo the driver sent on WhatsApp */}
      <input ref={parchiFile} type="file" accept="image/*" onChange={onParchiPick} style={{ display: "none" }} />
      <button className="btn btn-grn press anim-in st2" style={{ width: "100%", marginTop: 12 }} disabled={pBusy} onClick={() => parchiFile.current && parchiFile.current.click()}>
        {pBusy ? tx("Reading photo...", "Photo padh rahe hain...", "फोटो पढ़ रहे हैं...") : "\u{1F4F7} " + tx("Add a kanta parchi", "Kanta parchi daalo", "कांटा पर्ची डालें")}
      </button>
      <div className="hint" style={{ textAlign: "center", marginTop: 6 }}>
        {tx("Photograph the weighbridge slip. The app asks in or out, then adds or subtracts it here.", "Kante ki parchi ki photo lo. App poochhega maal aaya ya gaya - phir yahi se juda ya ghata dega.", "कांटे की पर्ची की फोटो लें। ऐप पूछेगा माल आया या गया - फिर यहीं जोड़ या घटा देगा।")}
      </div>

      {(inOpen || outOpen) && (
        <div className="card anim-in" style={{ padding: 16, marginTop: 12, border: "1.5px solid #CFE9D1" }}>
          <div className="lbl" style={{ color: "var(--grn-d)", marginBottom: 8 }}>{inOpen ? tx("Material arrived (kanta done)", "Maal aaya (kanta ho gaya)", "माल आया (कांटा हो गया)") : tx("Material left WITHOUT truck board", "Maal gaya - bina Truck board ke", "माल गया - बिना ट्रक बोर्ड के")}</div>
          {chipRow}
          {formFields}
          {outOpen && <span className="hint" style={{ marginTop: 8 }}>{tx("If it went by truck, use the Truck board - it counts here automatically. This form is only for other outflows.", "Gaadi se gaya to Truck board me likho - wahan se yahan apne aap ginta hai. Ye sirf baki nikasi ke liye.", "गाड़ी से गया तो ट्रक बोर्ड में लिखें - वहां से यहां अपने आप गिनता है। यह सिर्फ बाकी निकासी के लिए।")}</span>}
          <button className="btn btn-grn press" style={{ width: "100%", marginTop: 12 }} onClick={inOpen ? logIn : logOut}>{inOpen ? tx("Add to stock", "Stock me jodo", "स्टॉक में जोड़ें") : tx("Remove from stock", "Stock se nikalo", "स्टॉक से निकालें")}</button>
        </div>
      )}

      {!hasAny && !inOpen && (
        <div className="card anim-in" style={{ padding: 22, textAlign: "center", marginTop: 12 }}>
          <div style={{ fontSize: 34, marginBottom: 8 }}>⚖️</div>
          <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6 }}>{tx("Start tracking your yard", "Yard ka hisaab shuru karo", "यार्ड का हिसाब शुरू करें")}</div>
          <div style={{ fontSize: 13.5, color: "var(--dim)", lineHeight: 1.55, marginBottom: 14 }}>{tx("A yard nearby lost 17 MT to theft over six months - nobody noticed. Log maal aaya / gaya, then verify with a kanta check. Ghata shows up the same day.", "Ek yard me 6 mahine me 17 MT chori ho gaya - kisi ko pata nahi chala. Maal aaya/gaya likho, phir kanta check karo. Ghata usi din dikh jayega.", "एक यार्ड में 6 महीने में 17 MT चोरी हो गया - किसी को पता नहीं चला। माल आया/गया लिखें, फिर कांटा चेक करें। घाटा उसी दिन दिख जाएगा।")}</div>
          <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
            <button className="btn btn-grn press" onClick={() => setInOpen(true)}>{tx("+ Maal aaya", "+ Maal aaya", "+ माल आया")}</button>
            <button className="btn btn-ghost press" onClick={sampleStock}>{tx("See a sample", "Sample dekho", "सैंपल देखें")}</button>
          </div>
        </div>
      )}

      {/* per-material cards */}
      {Object.keys(stk.cats).sort((a, b) => (stk.cats[b].qty || 0) - (stk.cats[a].qty || 0)).map((k) => {
        const c = stk.cats[k]; const m = meta(k);
        const counting = countFor === k;
        const lastCount = (st.counts || []).find((x) => x.cat === k);
        return (
          <div key={k} className="card anim-in" style={{ padding: "14px 15px", marginTop: 10, borderColor: c.ghata > 0 ? "#EFC7C2" : undefined }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ width: 40, height: 40, borderRadius: 12, background: "var(--grn-100)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 19, flexShrink: 0 }}>{m.emoji}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>{m.label}</div>
                <div className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>
                  {tx("in: ", "aaya: ", "आया: ")}{fmtQty(c.inWk || 0)} · {tx("out: ", "gaya: ", "गया: ")}{fmtQty(c.outWk || 0)} MT / {tx("wk", "hafta", "हफ्ता")}
                </div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <div className="h-disp mono" style={{ fontSize: 20, fontWeight: 700, color: "var(--grn-d)" }}>{fmtQty(Math.max(0, c.qty))} MT</div>
                {c.ghata > 0 && <div className="mono" style={{ fontSize: 10.5, fontWeight: 700, color: "var(--red)" }}>{tx("ghata ", "ghata ", "घाटा ")}{fmtQty(c.ghata)} MT</div>}
              </div>
            </div>
            {counting ? (
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <input className="input mono" type="number" inputMode="decimal" placeholder={tx("counted MT", "kante ka weight", "कांटे का वज़न")} value={cQty} onChange={(e) => setCQty(e.target.value)} style={{ flex: 1 }} />
                <button className="btn btn-sm btn-grn press" onClick={() => doCount(k)}>{tx("Verify", "Check", "जांचें")}</button>
                <button className="btn btn-sm btn-soft press" onClick={() => { setCountFor(null); setCQty(""); }}>{tx("Cancel", "Cancel", "रहने दो")}</button>
              </div>
            ) : (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 9 }}>
                <span className="mono" style={{ fontSize: 10.5, color: "var(--faint)" }}>{lastCount ? tx("last check ", "aakhri kanta check ", "आखिरी कांटा चेक ") + fdateShort(lastCount.at) : tx("never verified", "kabhi kanta check nahi hua", "कभी कांटा चेक नहीं हुआ")}</span>
                <button className="btn btn-sm btn-soft press" onClick={() => { setCountFor(k); setCQty(""); }}>⚖️ {tx("Kanta check", "Kanta check", "कांटा चेक")}</button>
              </div>
            )}
          </div>
        );
      })}

      {hasAny && (
        <button className="btn btn-ghost press" style={{ width: "100%", marginTop: 12 }} onClick={() => { setOutOpen(!outOpen); setInOpen(false); }}>{outOpen ? tx("Close", "Close", "बंद") : tx("- Maal gaya (without truck)", "- Maal gaya (bina gaadi)", "- माल गया (बिना गाड़ी)")}</button>
      )}

      {/* every parchi ever taken, newest day first */}
      {parchis.length > 0 && (() => {
        const days = {};
        [...parchis].sort((a2, b2) => b2.at - a2.at).forEach((pc) => { const d = startOfDay(pc.at); (days[d] = days[d] || []).push(pc); });
        const today = startOfDay(Date.now()), mb = parchiBytes(parchis) / 1048576;
        return (
          <div style={{ marginTop: 24 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
              <span className="eyebrow">{tx("Parchi folder", "Kante ki parchiyan", "कांटे की पर्चियां")}</span>
              <span className="mono" style={{ fontSize: 10.5, color: "var(--faint)" }}>{parchis.length}{mb >= 0.3 ? " \u00b7 " + mb.toFixed(1) + " MB" : ""}</span>
            </div>
            <div className="hint" style={{ marginTop: -4, marginBottom: 10 }}>
              {tx("The slips are kept on this phone. The entries themselves sync normally.", "Parchi ki photo isi phone me rehti hai - entry (weight, party, date) har jagah sync hoti hai.", "पर्ची की फोटो इसी फोन में रहती है।")}
            </div>
            {mb > 120 && (
              <div className="card" style={{ padding: "11px 13px", marginBottom: 10, background: "var(--amber-bg)", borderColor: "#F0DCB8", fontSize: 12.5, color: "#7A5510", lineHeight: 1.5 }}>
                {tx("The photos are taking a lot of room on this phone. Open an old parchi and remove just its photo - the entry stays.", "Photos is phone me kaafi jagah le rahi hain. Purani parchi kholo aur sirf photo hata do - entry rahegi.", "फोटो इस फोन में काफी जगह ले रही हैं।")}
              </div>
            )}
            {Object.keys(days).sort((a2, b2) => b2 - a2).map((d) => (
              <div key={d} style={{ marginBottom: 6 }}>
                <div className="mono" style={{ fontSize: 11, color: "var(--faint)", letterSpacing: ".08em", margin: "10px 2px 6px" }}>
                  {Number(d) === today ? tx("TODAY", "AAJ", "आज") : Number(d) === today - DAY ? tx("YESTERDAY", "KAL", "कल") : fdateShort(Number(d)).toUpperCase()}
                </div>
                {days[d].map((pc) => (
                  <button key={pc.id} className="press" onClick={() => setViewP(pc)} style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", display: "flex", alignItems: "center", gap: 11, width: "100%", padding: "10px 12px", marginBottom: 8, background: "#fff", border: "1px solid var(--line)", borderRadius: 16, boxShadow: "var(--sh-s)" }}>
                    <ParchiImg pc={pc} style={{ width: 46, height: 46, borderRadius: 11, objectFit: "cover", flexShrink: 0, border: "1px solid var(--line2)" }} />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                        <span className="mono" style={{ fontSize: 13.5, fontWeight: 700 }}>{fmtQty(parchiMT(pc))} MT</span>
                        <span className="mono" style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 999, background: pc.dir === "in" ? "var(--grn-100)" : "var(--amber-bg)", color: pc.dir === "in" ? "var(--grn-d)" : "var(--amber)" }}>
                          {pc.dir === "in" ? tx("IN", "AAYA", "आया") : tx("OUT", "GAYA", "गया")}
                        </span>
                      </span>
                      <span style={{ display: "block", fontSize: 12.5, color: "var(--dim)", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {[meta(pc.cat).label, pc.party, pc.ref ? "#" + pc.ref : "", pc.vehicle].filter(Boolean).join(" \u00b7 ")}
                      </span>
                    </span>
                    <span className="mono" style={{ flexShrink: 0, fontSize: 9.5, fontWeight: 700, letterSpacing: ".06em", color: pc.linkId ? "var(--grn-d)" : "var(--faint)" }}>
                      {pc.linkId ? tx("IN STOCK", "STOCK ME", "स्टॉक में") : tx("RECORD ONLY", "SIRF RECORD", "सिर्फ रिकॉर्ड")}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        );
      })()}

      {hasAny && <div style={{ marginTop: 14, textAlign: "center" }}><span className="hint" style={{ display: "inline" }}>{tx("Truck board dispatches subtract from stock automatically. Do a kanta check weekly - ghata hides in months, not days.", "Truck board ki nikasi stock se apne aap kat-ti hai. Hafte me ek baar kanta check karo - ghata mahino me chhupta hai, dino me nahi.", "ट्रक बोर्ड की निकासी स्टॉक से अपने आप कटती है। हफ्ते में एक बार कांटा चेक करें।")}</span></div>}
    </div></div>

    {/* ---- the questions a photo cannot answer ---- */}
    {pDraft && (
      <div onClick={closeDraft} style={{ position: "absolute", inset: 0, zIndex: 70, background: "rgba(16,26,20,.45)", backdropFilter: "blur(3px)", display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
        <div className="anim-in" onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: "26px 26px 0 0", padding: "18px 18px calc(18px + env(safe-area-inset-bottom))", maxHeight: "92%", overflowY: "auto", boxShadow: "0 -20px 50px -20px rgba(21,94,24,.4)" }}>
          <div style={{ width: 40, height: 4, borderRadius: 3, background: "var(--line2)", margin: "0 auto 14px" }} />
          <div className="h-disp" style={{ fontSize: 21, fontWeight: 700 }}>{tx("Kanta parchi", "Kante ki parchi", "\u0915\u093E\u0902\u091F\u0947 \u0915\u0940 \u092A\u0930\u094D\u091A\u0940")}</div>
          <img src={pDraft.url} alt="" onClick={() => setViewP({ id: "draft", photo: pDraft.url })}
            style={{ width: "100%", height: 150, objectFit: "cover", borderRadius: 14, margin: "12px 0 4px", border: "1px solid var(--line2)", cursor: "zoom-in" }} />
          {/* what the AI made of it - or why it stayed manual */}
          {pRead && pRead.busy && (
            <div style={{ display: "flex", alignItems: "center", gap: 9, margin: "10px 0 2px", padding: "10px 12px", borderRadius: 12, background: "var(--soft)", border: "1px solid var(--line)", fontSize: 13, color: "var(--dim)" }}>
              <span className="mono" style={{ color: "var(--grn-d)" }}>AI</span>
              {tx("Reading the parchi...", "Parchi padh rahe hain...", "पर्ची पढ़ रहे हैं...")}
            </div>
          )}
          {pRead && pRead.ok && (
            <div style={{ margin: "10px 0 2px", padding: "10px 12px", borderRadius: 12, background: pRead.mismatch ? "var(--amber-bg)" : "#F3FBF4", border: "1px solid " + (pRead.mismatch ? "#F0DCB8" : "#CFE9D1"), fontSize: 12.5, lineHeight: 1.5, color: pRead.mismatch ? "#7A5510" : "var(--grn-d)" }}>
              {pRead.mismatch
                ? tx("AI read the slip but gross - tare does not match the net it read. Check all three against the paper.", "AI ne parchi padhi, par gross - tare aur net aapas me match nahi kar rahe. Teeno number parchi se milaa lijiye.", "AI ने पर्ची पढ़ी, पर गिनती मेल नहीं खा रही - तीनों नंबर मिला लें।")
                : tx("AI read the slip - check the numbers against the paper before saving.", "AI ne parchi padh li - save karne se pehle number parchi se milaa lijiye.", "AI ने पर्ची पढ़ ली - सेव करने से पहले नंबर मिला लें।")}
            </div>
          )}
          {pRead && pRead.why && (
            <div style={{ margin: "10px 0 2px", padding: "10px 12px", borderRadius: 12, background: "var(--soft)", border: "1px solid var(--line)", fontSize: 12.5, lineHeight: 1.5, color: "var(--dim)" }}>
              {tx("Could not read it (", "Parchi padhi nahi ja saki (", "पर्ची पढ़ी नहीं जा सकी (") + pRead.why + tx(") - fill it in by hand.", ") - haath se bhar dijiye.", ") - हाथ से भरें।")}
            </div>
          )}
          {!pRead && (
            <button className="btn btn-soft btn-sm press" style={{ width: "100%", marginTop: 10 }} onClick={() => runRead(pDraft.blob)}>
              {"\u{1F4D6} " + tx("Let AI read this parchi", "AI se parchi padhwao", "AI से पर्ची पढ़वाएं")}
            </button>
          )}
          {!pRead && (
            <div className="hint" style={{ textAlign: "center", marginTop: 6 }}>
              {tx("The photo is sent to our server to be read. Turn on Smart reading in Setup to do this automatically.", "Padhne ke liye photo humare server par jaayegi. Setup me 'Smart reading' on karo to har parchi apne aap padhi jayegi.", "पढ़ने के लिए फोटो हमारे सर्वर पर जाएगी।")}
            </div>
          )}
          <div className="hint" style={{ textAlign: "center", marginBottom: 12, marginTop: 8 }}>{tx("Tap the photo to read it full-size", "Photo dabao - poori dikhegi", "\u092B\u094B\u091F\u094B \u0926\u092C\u093E\u090F\u0902 - \u092A\u0942\u0930\u0940 \u0926\u093F\u0916\u0947\u0917\u0940")}</div>

          <div className="lbl" style={{ marginBottom: 7 }}>{tx("1. Is this maal coming IN or going OUT?", "1. Ye maal aa raha hai ya ja raha hai?", "1. \u092F\u0939 \u092E\u093E\u0932 \u0906 \u0930\u0939\u093E \u0939\u0948 \u092F\u093E \u091C\u093E \u0930\u0939\u093E \u0939\u0948?")}</div>
          <div style={{ display: "flex", gap: 10 }}>
            {dirBtn("in", tx("Maal AAYA", "Maal AAYA", "\u092E\u093E\u0932 \u0906\u092F\u093E"), tx("into the yard", "yard me andar", "\u092F\u093E\u0930\u094D\u0921 \u092E\u0947\u0902 \u0905\u0902\u0926\u0930"))}
            {dirBtn("out", tx("Maal GAYA", "Maal GAYA", "\u092E\u093E\u0932 \u0917\u092F\u093E"), tx("out of the yard", "yard se bahar", "\u092F\u093E\u0930\u094D\u0921 \u0938\u0947 \u092C\u093E\u0939\u0930"))}
          </div>

          {pDraft.dir && (<>
            <div className="lbl" style={{ margin: "16px 0 7px" }}>{tx("2. Which material?", "2. Kaunsa maal?", "2. \u0915\u094C\u0928 \u0938\u093E \u092E\u093E\u0932?")}</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {cats.map((c) => (
                <button key={c.key} className={"fpill press " + (pDraft.cat === c.key ? "on" : "")} onClick={() => setPDraft({ ...pDraft, cat: c.key })}>{c.emoji} {c.label}</button>
              ))}
            </div>

            <div className="lbl" style={{ margin: "16px 0 7px" }}>{tx("3. Weight from the slip (kg)", "3. Parchi ka weight (kg)", "3. \u092A\u0930\u094D\u091A\u0940 \u0915\u093E \u0935\u091C\u093C\u0928 (kg)")}</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div><label className="lbl" style={{ fontSize: 12.5 }}>{tx("Gross (loaded)", "Gross (bhara)", "\u0917\u094D\u0930\u0949\u0938 (\u092D\u0930\u093E)")}</label>
                <input className="input mono" type="number" inputMode="decimal" placeholder={tx("e.g. 16540", "jaise 16540", "जैसे 16540")} value={pDraft.gross} onChange={(e) => setPDraft({ ...pDraft, gross: e.target.value, manualNet: false })} /></div>
              <div><label className="lbl" style={{ fontSize: 12.5 }}>{tx("Tare (empty)", "Tare (khaali)", "\u091F\u0947\u092F\u0930 (\u0916\u093E\u0932\u0940)")}</label>
                <input className="input mono" type="number" inputMode="decimal" placeholder={tx("e.g. 4000", "jaise 4000", "जैसे 4000")} value={pDraft.tare} onChange={(e) => setPDraft({ ...pDraft, tare: e.target.value, manualNet: false })} /></div>
            </div>
            <div style={{ marginTop: 10 }}>
              <label className="lbl" style={{ fontSize: 12.5 }}>{tx("Net (maal only)", "Net (sirf maal)", "\u0928\u0947\u091F (\u0938\u093F\u0930\u094D\u092B \u092E\u093E\u0932)")}</label>
              <input className="input mono" type="number" inputMode="decimal" placeholder={tx("e.g. 12540", "jaise 12540", "जैसे 12540")} value={pDraft.manualNet ? pDraft.kg : (kgNow || "")}
                onChange={(e) => setPDraft({ ...pDraft, kg: e.target.value, manualNet: true })} />
              <span className="hint">{tx("Net = gross - tare. If the slip already prints net, just type that.", "Net = gross - tare. Parchi par net likha ho to seedha wahi daalo.", "\u0928\u0947\u091F = \u0917\u094D\u0930\u0949\u0938 - \u091F\u0947\u092F\u0930\u0964")}</span>
            </div>
            <div className="card" style={{ padding: "12px 14px", marginTop: 10, background: "#F3FBF4", borderColor: "#CFE9D1", display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={{ fontSize: 13.5, color: "var(--dim)" }}>{fmtQty(kgNow)} kg =</span>
              <b className="h-disp mono" style={{ fontSize: 22, color: "var(--grn-d)" }}>{fmtQty(mtNow)} MT</b>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12 }}>
              <div><label className="lbl" style={{ fontSize: 12.5 }}>{tx("Party", "Party", "\u092A\u093E\u0930\u094D\u091F\u0940")}</label>
                <input className="input" list="qk-parties" placeholder="Apex Alloys" value={pDraft.party} onChange={(e) => setPDraft({ ...pDraft, party: e.target.value })} /></div>
              <div><label className="lbl" style={{ fontSize: 12.5 }}>{tx("Slip no", "Parchi no", "\u092A\u0930\u094D\u091A\u0940 \u0928\u0902\u092C\u0930")}</label>
                <input className="input mono" placeholder={tx("e.g. 4821", "jaise 4821", "जैसे 4821")} value={pDraft.ref} onChange={(e) => setPDraft({ ...pDraft, ref: e.target.value })} /></div>
              <div><label className="lbl" style={{ fontSize: 12.5 }}>{tx("Vehicle no", "Gaadi no", "\u0917\u093E\u0921\u093C\u0940 \u0928\u0902\u092C\u0930")}</label>
                <input className="input mono" placeholder="HR 38 AB 1234" value={pDraft.vehicle} onChange={(e) => setPDraft({ ...pDraft, vehicle: e.target.value })} /></div>
              <div><label className="lbl" style={{ fontSize: 12.5 }}>{tx("Date on the slip", "Parchi ki date", "\u092A\u0930\u094D\u091A\u0940 \u0915\u0940 \u0924\u093E\u0930\u0940\u0916")}</label>
                <input className="input mono" type="date" value={new Date(pDraft.at).toLocaleDateString("en-CA")}
                  onChange={(e) => { const v = e.target.value; if (v) setPDraft({ ...pDraft, at: new Date(v + "T12:00:00").getTime() }); }} /></div>
            </div>
            <datalist id="qk-parties">{parties.map((d2) => <option key={d2} value={d2} />)}</datalist>

            {dupSlip && warn(tx("A parchi with this slip number is already saved - check you are not entering it twice.", "Is parchi number ki entry pehle se hai - do baar to nahi daal rahe?", "\u0907\u0938 \u092A\u0930\u094D\u091A\u0940 \u0928\u0902\u092C\u0930 \u0915\u0940 \u090F\u0902\u091F\u094D\u0930\u0940 \u092A\u0939\u0932\u0947 \u0938\u0947 \u0939\u0948\u0964"))}
            {truckSameDay && warn(tx("The Truck board already has a trip for this party today and that one already subtracts from stock. Keep this as record only if it is the same load.", "Aaj isi party ki gaadi Truck board par bhi hai - wo pehle hi stock se kat chuki hai. Same load hai to 'sirf record' rakho.", "\u0906\u091C \u0907\u0938\u0940 \u092A\u093E\u0930\u094D\u091F\u0940 \u0915\u0940 \u0917\u093E\u0921\u093C\u0940 \u091F\u094D\u0930\u0915 \u092C\u094B\u0930\u094D\u0921 \u092A\u0930 \u092D\u0940 \u0939\u0948\u0964"))}
            {beforeCount && warn(tx("This parchi is older than the last kanta check for this material, so it will not change today's stock.", "Ye parchi is maal ke aakhri kanta check se purani hai - isse aaj ka stock nahi badlega.", "\u092F\u0939 \u092A\u0930\u094D\u091A\u0940 \u0906\u0916\u093F\u0930\u0940 \u0915\u093E\u0902\u091F\u093E \u091A\u0947\u0915 \u0938\u0947 \u092A\u0941\u0930\u093E\u0928\u0940 \u0939\u0948\u0964"))}

            <div className="lbl" style={{ margin: "16px 0 7px" }}>
              {pDraft.dir === "in" ? tx("4. Add this to the yard stock?", "4. Isko yard stock me jodein?", "4. \u0907\u0938\u0947 \u092F\u093E\u0930\u094D\u0921 \u0938\u094D\u091F\u0949\u0915 \u092E\u0947\u0902 \u091C\u094B\u0921\u093C\u0947\u0902?")
                : tx("4. Subtract this from the yard stock?", "4. Isko yard stock me se ghatayein?", "4. \u0907\u0938\u0947 \u092F\u093E\u0930\u094D\u0921 \u0938\u094D\u091F\u0949\u0915 \u0938\u0947 \u0918\u091F\u093E\u090F\u0902?")}
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button className="press" onClick={() => setPDraft({ ...pDraft, apply: true })} style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", flex: 1, textAlign: "center", padding: "12px 10px", borderRadius: 14, border: "1.5px solid " + (pDraft.apply ? "var(--grn-x)" : "var(--line2)"), background: pDraft.apply ? "#F3FBF4" : "#fff", fontWeight: 700, fontSize: 14.5, color: pDraft.apply ? "var(--grn-d)" : "var(--ink)" }}>
                {tx("Yes", "Haan", "\u0939\u093E\u0902")} \u00b7 {pDraft.dir === "in" ? "+" : "-"}{fmtQty(mtNow)} MT
              </button>
              <button className="press" onClick={() => setPDraft({ ...pDraft, apply: false })} style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", flex: 1, textAlign: "center", padding: "12px 10px", borderRadius: 14, border: "1.5px solid " + (!pDraft.apply ? "var(--ink)" : "var(--line2)"), background: !pDraft.apply ? "var(--soft)" : "#fff", fontWeight: 700, fontSize: 14.5 }}>
                {tx("No - record only", "Nahi - sirf record", "\u0928\u0939\u0940\u0902 - \u0938\u093F\u0930\u094D\u092B \u0930\u093F\u0915\u0949\u0930\u094D\u0921")}
              </button>
            </div>

            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              <button className="btn btn-ghost press" style={{ flex: 1, justifyContent: "center" }} onClick={closeDraft}>{tx("Cancel", "Rehne do", "\u0930\u0939\u0928\u0947 \u0926\u0947\u0902")}</button>
              <button className="btn btn-grn press" style={{ flex: 1.5, justifyContent: "center" }} onClick={saveParchi}>{tx("Save parchi", "Parchi save karo", "\u092A\u0930\u094D\u091A\u0940 \u0938\u0947\u0935 \u0915\u0930\u0947\u0902")}</button>
            </div>
          </>)}
        </div>
      </div>
    )}

    {/* ---- one parchi, full size ---- */}
    {viewP && (
      <div onClick={() => setViewP(null)} style={{ position: "absolute", inset: 0, zIndex: 80, background: "rgba(8,14,10,.92)", display: "flex", flexDirection: "column", padding: "calc(16px + env(safe-area-inset-top)) 14px calc(16px + env(safe-area-inset-bottom))", overflowY: "auto" }}>
        {viewP.photo || viewP.img
          ? <ParchiImg pc={viewP} onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxHeight: viewP.id === "draft" ? "100%" : "56%", objectFit: "contain", borderRadius: 12 }} />
          : <div style={{ padding: 30, textAlign: "center", color: "rgba(255,255,255,.6)", fontSize: 14 }}>{tx("Photo was removed", "Photo hata di gayi thi", "\u092B\u094B\u091F\u094B \u0939\u091F\u093E \u0926\u0940 \u0917\u0908 \u0925\u0940")}</div>}
        {viewP.id !== "draft" && (
          <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 20, padding: 16, marginTop: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
              <b className="h-disp mono" style={{ fontSize: 22 }}>{fmtQty(parchiMT(viewP))} MT</b>
              <span className="mono" style={{ fontSize: 11, fontWeight: 700, padding: "3px 9px", borderRadius: 999, background: viewP.dir === "in" ? "var(--grn-100)" : "var(--amber-bg)", color: viewP.dir === "in" ? "var(--grn-d)" : "var(--amber)" }}>
                {viewP.dir === "in" ? "MAAL AAYA" : "MAAL GAYA"}
              </span>
            </div>
            <div className="mono" style={{ fontSize: 12.5, color: "var(--dim)", marginTop: 6, lineHeight: 1.7 }}>
              {fmtQty(viewP.kg)} kg{viewP.gross > 0 && viewP.tare > 0 ? " (" + fmtQty(viewP.gross) + " - " + fmtQty(viewP.tare) + ")" : ""}<br />
              {[meta(viewP.cat).label, viewP.party, viewP.ref ? "#" + viewP.ref : "", viewP.vehicle].filter(Boolean).join(" \u00b7 ")}<br />
              {fdateShort(viewP.at)}
            </div>
            <div style={{ fontSize: 13, color: viewP.linkId ? "var(--grn-d)" : "var(--faint)", fontWeight: 600, marginTop: 8 }}>
              {viewP.linkId ? (viewP.dir === "in" ? tx("Counted in the yard stock", "Yard stock me juda hua hai", "\u092F\u093E\u0930\u094D\u0921 \u0938\u094D\u091F\u0949\u0915 \u092E\u0947\u0902 \u091C\u0941\u0921\u093C\u093E \u0939\u0948") : tx("Subtracted from the yard stock", "Yard stock se ghata hua hai", "\u092F\u093E\u0930\u094D\u0921 \u0938\u094D\u091F\u0949\u0915 \u0938\u0947 \u0918\u091F\u093E \u0939\u0948"))
                : tx("Record only - stock not changed", "Sirf record - stock nahi badla", "\u0938\u093F\u0930\u094D\u092B \u0930\u093F\u0915\u0949\u0930\u094D\u0921 - \u0938\u094D\u091F\u0949\u0915 \u0928\u0939\u0940\u0902 \u092C\u0926\u0932\u093E")}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
              <button className="btn btn-sm btn-grn press" onClick={() => toggleParchi(viewP)}>
                {viewP.linkId ? tx("Undo stock change", "Stock se wapas lo", "\u0938\u094D\u091F\u0949\u0915 \u0938\u0947 \u0935\u093E\u092A\u0938 \u0932\u0947\u0902")
                  : viewP.dir === "in" ? tx("Add to stock", "Stock me jodo", "\u0938\u094D\u091F\u0949\u0915 \u092E\u0947\u0902 \u091C\u094B\u0921\u093C\u0947\u0902") : tx("Subtract from stock", "Stock se ghatao", "\u0938\u094D\u091F\u0949\u0915 \u0938\u0947 \u0918\u091F\u093E\u090F\u0902")}
              </button>
              {(viewP.photo || viewP.img) && <button className="btn btn-sm btn-soft press" onClick={() => dropPhoto(viewP)}>{tx("Remove photo", "Photo hatao", "\u092B\u094B\u091F\u094B \u0939\u091F\u093E\u090F\u0902")}</button>}
              <button className="btn btn-sm btn-ghost press" style={{ color: "var(--red)" }} onClick={() => delParchi(viewP)}><I.trash /></button>
            </div>
          </div>
        )}
        <button className="btn btn-ghost press" style={{ marginTop: 14, background: "rgba(255,255,255,.14)", color: "#fff", border: "none", justifyContent: "center" }} onClick={() => setViewP(null)}>{tx("Close", "Band karo", "\u092C\u0902\u0926 \u0915\u0930\u0947\u0902")}</button>
      </div>
    )}
  </>);
}

/* ================= LOGIN METHODS (cloud mode only) =================
   One account, two doors. A shop owner remembers his phone number; his Gmail is
   something his nephew set up in 2016. So phone is the main login - but the
   accounts that already exist here were made with Google, and Supabase treats an
   unseen identifier as a NEW user. If a Google customer ever signs in by phone
   without linking first, he lands in an empty account and believes his data is
   gone (it is not - it is still on the Google account, which is exactly why we
   never copy anything between users).

   This card is the cure: from inside the account you already hold, attach the
   other door. Both then open the same uid, so shop_data never splits. */
/* ================= NEW-ACCOUNT GUARD (cloud mode only) =================
   Shown once, immediately after a phone number creates a BRAND NEW account that
   has no Google attached. It exists for one person: the customer who has been
   signing in with Google for months, types his phone number one day, and would
   otherwise be dropped into an empty pipeline convinced the app ate his data.

   Choosing "I used Google before" does NOT move any data. It throws away the
   empty account he just made (server-side, and only if it truly holds nothing),
   which frees his number, and sends him back through Google to his real account
   - where Setup will offer to attach the same number properly. */
const NEWACCT_KEY = "quotekaro:newacct:";
/* A phone-only account born in the last few minutes that has not yet answered
   the "is this really new?" question. While this is true the app must not load
   or seed shop_data for it: writing a row would make the account look used, and
   auth-discard rightly refuses to remove an account that holds anything. */
function pendingNewAccount(account, guardOk) {
  if (!sb || !account || guardOk) return false;
  if (account.email || (account.providers || []).includes("google")) return false;
  const born = Date.parse(account.createdAt || "");
  if (!Number.isFinite(born) || Date.now() - born > 10 * 60 * 1000) return false;
  try { if (localStorage.getItem(NEWACCT_KEY + account.uid)) return false; } catch {}
  return true;
}
function NewAccountGuard({ account, onKeep }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const useGoogleInstead = async () => {
    setErr(""); setBusy(true);
    try {
      const r = await fetch("/.netlify/functions/auth-discard", {
        method: "POST", headers: { "content-type": "application/json", ...(await authHeaders()) },
      });
      const j = await r.json().catch(() => ({}));
      if (!j.ok) {
        setBusy(false);
        setErr(j.why || tx("Could not do that. Try Google from the login screen.", "Ye nahi ho paya. Login screen se Google try karein.", "यह नहीं हो पाया। लॉगिन स्क्रीन से Google आज़माएं।"));
        return;
      }
      /* the empty account is gone - go straight to Google */
      try { await sb.auth.signOut(); } catch {}
      await sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: window.location.origin } });
    } catch {
      setBusy(false);
      setErr(tx("Network problem. Try again.", "Network ki dikkat. Dobara try karein.", "नेटवर्क की दिक्कत। दोबारा करें।"));
    }
  };

  return (
    <div className="qk-root"><style>{CSS}</style><div className="app">
      <div className="auth">
        <div className="auth-top">
          <div className="auth-logo">TR</div>
          <h1>{tx("One last thing", "Ek aakhri baat", "एक आखिरी बात")}</h1>
          <p>{account.phone || ""}</p>
        </div>
        <div className="auth-body">
          <label className="lbl">{tx("Is this a new shop account?", "Kya ye naya account hai?", "क्या यह नया अकाउंट है?")}</label>
          <span className="hint">
            {tx("This number has made a fresh account. If you used Google here before, your old data is safe on that account - pick the second option and we will join them.",
                "Is number se naya account bana hai. Agar aap pehle Google se aate the, to aapka purana data usi account mein surakshit hai - neeche doosra option chunein, hum dono ko jod denge.",
                "इस नंबर से नया अकाउंट बना है। अगर आप पहले Google से आते थे, तो पुराना डेटा उसी अकाउंट में सुरक्षित है - नीचे दूसरा विकल्प चुनें।")}
          </span>

          <button className="btn btn-grn press" style={{ width: "100%", marginTop: 16 }} onClick={onKeep} disabled={busy}>
            {tx("Yes, start fresh", "Haan, naya account hai", "हाँ, नया अकाउंट है")}
          </button>
          <button className="btn btn-ghost press" style={{ width: "100%", marginTop: 10 }} onClick={useGoogleInstead} disabled={busy}>
            {busy ? tx("Please wait...", "Rukiye...", "रुकिए...") : tx("No, I used Google before", "Nahi, main pehle Google se aata tha", "नहीं, मैं पहले Google से आता था")}
          </button>

          {err && <div style={{ marginTop: 14, padding: "11px 13px", borderRadius: 12, background: "var(--red-bg)", color: "var(--red)", fontSize: 13, lineHeight: 1.5 }}>{err}</div>}
          <div className="auth-note">
            {tx("Nothing is deleted either way - an account that has any saved work is never touched.",
                "Kisi bhi haalat mein kuch delete nahi hota - jis account mein kaam save hai, use haath nahi lagta.",
                "किसी भी हाल में कुछ डिलीट नहीं होता - जिस अकाउंट में काम सेव है, उसे हाथ नहीं लगाया जाता।")}
          </div>
        </div>
      </div>
    </div></div>
  );
}

function LoginMethods({ account, ping }) {
  const [openAdd, setOpenAdd] = useState(false);
  const [ph, setPh] = useState("");
  const [stage, setStage] = useState("enter");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (!sb || !account) return null;

  const provs = account.providers || [];
  const hasPhone = !!account.phone || provs.includes("phone");
  const hasGoogle = provs.includes("google") || !!account.email;
  const e164 = () => "+91" + ph.replace(/\D/g, "");

  const say = (e) => {
    const m = String((e && e.message) || "").toLowerCase();
    if (/already been registered|already registered|already exists|duplicate/.test(m))
      return tx("This number is already on another TrackRakho account. Log in with that number instead, or use a different one.",
                "Ye number pehle se kisi aur TrackRakho account par hai. Usi number se login karein, ya doosra number daalein.",
                "यह नंबर पहले से किसी और TrackRakho अकाउंट पर है। उसी नंबर से लॉगिन करें।");
    if (/identity is already linked|already linked/.test(m))
      return tx("That Google account is already linked to another TrackRakho account.",
                "Ye Google account pehle se kisi aur TrackRakho account se juda hai.",
                "यह Google अकाउंट पहले से किसी और TrackRakho अकाउंट से जुड़ा है।");
    if (/manual linking|not enabled/.test(m))
      return tx("Linking is switched off on the server. Tell us and we will turn it on.",
                "Server par linking band hai. Humein batayein, hum chalu kar denge.",
                "सर्वर पर लिंकिंग बंद है। हमें बताएं, हम चालू कर देंगे।");
    if (/rate|too many|security purposes/.test(m))
      return tx("Too many attempts. Wait a minute.", "Bahut baar try kiya. Ek minute ruk jaayein.", "बहुत बार कोशिश हुई। एक मिनट रुकें।");
    if (/expired|invalid|incorrect|token/.test(m))
      return tx("That code is wrong or has expired.", "Code galat hai ya purana ho gaya.", "कोड गलत या पुराना है।");
    return (e && e.message) || tx("Something went wrong.", "Kuch gadbad ho gayi.", "कुछ गडबड हुई।");
  };

  const sendCode = async () => {
    if (ph.replace(/\D/g, "").length !== 10) { setErr(tx("Enter a valid 10-digit number", "Poora 10 digit ka number daalein", "पूरा 10 अंकों का नंबर डालें")); return; }
    setErr(""); setBusy(true);
    /* updateUser({phone}) attaches the number to THIS user and sends a code to it */
    const { error } = await sb.auth.updateUser({ phone: e164() });
    setBusy(false);
    if (error) { setErr(say(error)); return; }
    setStage("code");
  };
  const confirmCode = async () => {
    const t = code.replace(/\D/g, "");
    if (t.length < 6) { setErr(tx("Enter the 6-digit code", "6 digit ka code daalein", "6 अंकों का कोड डालें")); return; }
    setErr(""); setBusy(true);
    const { error } = await sb.auth.verifyOtp({ phone: e164(), token: t, type: "phone_change" });
    if (!error) { try { await sb.auth.refreshSession(); } catch {} }
    setBusy(false);
    if (error) { setErr(say(error)); return; }
    setOpenAdd(false); setStage("enter"); setPh(""); setCode("");
    ping(tx("Number added. You can now log in with it.", "Number jud gaya. Ab isi se login kar sakte hain.", "नंबर जुड़ गया। अब इसी से लॉगिन कर सकते हैं।"));
  };
  const linkGoogle = async () => {
    setErr(""); setBusy(true);
    try {
      localStorage.setItem(LINK_FLAG, "1");
      const { error } = await sb.auth.linkIdentity({ provider: "google", options: { redirectTo: window.location.origin } });
      if (error) { localStorage.removeItem(LINK_FLAG); setErr(say(error)); setBusy(false); }
      /* on success the browser leaves for Google; the return is handled in App */
    } catch (e) { localStorage.removeItem(LINK_FLAG); setErr(say(e)); setBusy(false); }
  };

  /* one line per login method. `first` drops the divider so the list does not
     open with a stray rule under the description, the tick is a fixed 26px
     column so both rows align, and the action button never shrinks the text
     off the card (long emails ellipsis instead). */
  const row = (on, label, value, action, first) => (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 0", borderTop: first ? "none" : "1px solid var(--line)" }}>
      <span style={{ width: 26, height: 26, borderRadius: "50%", flex: "none", display: "grid", placeItems: "center", background: on ? "var(--grn-100)" : "var(--soft)", color: on ? "var(--grn-d)" : "var(--faint)", fontSize: 13, fontWeight: 700, lineHeight: 1 }}>{on ? "✓" : "+"}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.3 }}>{label}</div>
        <div style={{ fontSize: 12.5, color: "var(--dim)", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</div>
      </div>
      {action ? <span style={{ flex: "none" }}>{action}</span> : null}
    </div>
  );

  /* .card carries no padding of its own - without this the text sat on the border */
  return (
    <div className="card anim-in" style={{ marginTop: 18, padding: "16px 16px 4px" }}>
      <div className="h-disp" style={{ fontSize: 16.5, fontWeight: 700 }}>{tx("Ways to log in", "Login ke tareeke", "लॉगिन के तरीके")}</div>
      <div style={{ fontSize: 12.5, color: "var(--dim)", marginTop: 3, lineHeight: 1.55 }}>
        {tx("Attach both and either one opens this same account, with all your data.",
            "Dono jod lein - dono se yahi account khulega, saara data ke saath.",
            "दोनों जोड़ लें - दोनों से यही अकाउंट खुलेगा, सारे डेटा के साथ।")}
      </div>

      <div style={{ marginTop: 12 }} />
      {row(hasPhone, tx("Phone number", "Phone number", "फोन नंबर"),
        hasPhone ? account.phone || tx("Added", "Jud gaya", "जुड़ा हुआ") : tx("Not added yet", "Abhi nahi juda", "अभी नहीं जुड़ा"),
        !hasPhone && !openAdd ? <button className="btn btn-ghost btn-sm press" onClick={() => { setOpenAdd(true); setErr(""); }}>{tx("Add", "Jodein", "जोड़ें")}</button> : null, true)}

      {openAdd && !hasPhone && (
        <div className="anim-in" style={{ padding: "2px 0 12px" }}>
          {stage === "enter" ? (<>
            <div className="phone-field">
              <span className="cc">+91</span>
              <input type="tel" inputMode="numeric" placeholder="98xxxxxxxx" value={ph}
                onChange={(e) => setPh(e.target.value.replace(/\D/g, "").slice(0, 10))} />
            </div>
            <div style={{ fontSize: 12, color: "var(--dim)", marginTop: 7 }}>
              {tx("A 6-digit code will come to that number.", "Us number par 6 digit ka code aayega.", "उस नंबर पर 6 अंकों का कोड आएगा।")}
            </div>
            <button className="btn btn-grn btn-sm press" style={{ width: "100%", marginTop: 11 }} onClick={sendCode} disabled={busy}>
              {busy ? tx("Sending...", "Sending...", "भेज रहे हैं...") : tx("Send code", "Send code", "कोड भेजें")}
            </button>
          </>) : (<>
            <input className="input" inputMode="numeric" maxLength={6} placeholder="6 digit code" value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} style={{ fontFamily: "var(--mono)", letterSpacing: ".2em", textAlign: "center" }} />
            <button className="btn btn-grn btn-sm press" style={{ width: "100%", marginTop: 11 }} onClick={confirmCode} disabled={busy}>
              {busy ? tx("Checking...", "Checking...", "जाँच रहे हैं...") : tx("Confirm number", "Number confirm karein", "नंबर पक्का करें")}
            </button>
            <button className="btn btn-ghost btn-sm press" style={{ width: "100%", marginTop: 8 }} onClick={() => { setStage("enter"); setCode(""); setErr(""); }}>
              {tx("Change number", "Number badlein", "नंबर बदलें")}
            </button>
          </>)}
          {err && <div style={{ color: "var(--red)", fontSize: 12.5, marginTop: 10, lineHeight: 1.5 }}>{err}</div>}
        </div>
      )}

      {row(hasGoogle, "Google", hasGoogle ? account.email || tx("Added", "Jud gaya", "जुड़ा हुआ") : tx("Not added yet", "Abhi nahi juda", "अभी नहीं जुड़ा"),
        !hasGoogle ? <button className="btn btn-ghost btn-sm press" onClick={linkGoogle} disabled={busy}>{tx("Add", "Jodein", "जोड़ें")}</button> : null)}

      {!openAdd && err && <div style={{ color: "var(--red)", fontSize: 12.5, marginTop: 10, lineHeight: 1.5 }}>{err}</div>}
    </div>
  );
}

function Setup({ data, setData, ping, account, sync, goSubscribe, onLogout }) {
  const [calcOpen, setCalcOpen] = useState(false);
  const [matPick, setMatPick] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [tallyKey, setTallyKey] = useState(null);   // connector key, fetched on demand
  const [tallyBusy, setTallyBusy] = useState(false);
  const [gmail, setGmail] = useState(null);         // { connected, email, error } | null
  const [gmailBusy, setGmailBusy] = useState(false);
  const [devices, setDevices] = useState(null);     // floor phones: null while loading
  const [pairCode, setPairCode] = useState(null);   // { code, expires }
  const [devBusy, setDevBusy] = useState(false);
  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const cloudGoogle = !!(sb && account && account.method === "google");
  useEffect(() => { let alive = true; if (cloudGoogle) gmailStatus().then((d) => { if (alive) setGmail(d); }); return () => { alive = false; }; }, [cloudGoogle]);
  /* shop-floor phones + breakdown notifications (cloud mode only) */
  const loadDevices = async () => {
    try {
      const r = await fetch(WA_API + "/floor-pair", { headers: { accept: "application/json", ...(await authHeaders()) } });
      const d = await r.json().catch(() => ({}));
      setDevices(d.ok ? d.devices : []);
    } catch { setDevices([]); }
  };
  useEffect(() => { let alive = true; if (sb && account) { loadDevices(); pushCurrent().then((x) => { if (alive) setPushOn(!!x); }); } return () => { alive = false; }; }, [account ? account.uid : null]);
  const makeCode = async () => {
    setDevBusy(true);
    try {
      const r = await fetch(WA_API + "/floor-pair", { method: "POST", headers: { "content-type": "application/json", ...(await authHeaders()) }, body: JSON.stringify({ action: "create" }) });
      const d = await r.json().catch(() => ({}));
      if (d.ok) { setPairCode({ code: d.code, expires: d.expires }); loadDevices(); }
      else ping(tx("Could not make a code", "Code nahi ban paya", "कोड नहीं बना"));
    } catch { ping(tx("No internet", "Internet nahi hai", "इंटरनेट नहीं")); }
    setDevBusy(false);
  };
  const dropDevice = async (id) => {
    setDevBusy(true);
    try {
      await fetch(WA_API + "/floor-pair", { method: "POST", headers: { "content-type": "application/json", ...(await authHeaders()) }, body: JSON.stringify({ action: "remove", id }) });
      await loadDevices();
      ping(tx("Phone removed", "Phone hata diya", "फोन हटा दिया"));
    } catch { ping(tx("Could not remove", "Hata nahi paye", "हटा नहीं पाए")); }
    setDevBusy(false);
  };
  const togglePush = async () => {
    setPushBusy(true);
    if (pushOn) { await pushDisable(); setPushOn(false); ping(tx("Notifications off", "Notification band", "नोटिफिकेशन बंद")); }
    else {
      const r = await pushEnable();
      if (r.ok) { setPushOn(true); ping(tx("You will be told when a machine stops", "Machine band hone par pata chal jayega", "मशीन बंद होने पर पता चलेगा")); }
      else ping(tx("Could not turn on (", "Chalu nahi hua (", "चालू नहीं हुआ (") + r.why + ")");
    }
    setPushBusy(false);
  };
  const s = data.settings;
  const setS = (k, v) => setData({ ...data, settings: { ...s, [k]: v } });
  const ind = industryOf(data);
  const isMach = ind.key === "machining";

  /* owner-added categories (merged into ind.cats by industryOf) */
  const [catAdd, setCatAdd] = useState(false);
  const [catSel, setCatSel] = useState("");
  const [catName, setCatName] = useState("");
  const [catEmoji, setCatEmoji] = useState("");
  const isScrap = ind.key === "scrap";
  const [truckAdd, setTruckAdd] = useState(false);
  const [truckNo, setTruckNo] = useState("");
  const [truckCap, setTruckCap] = useState("");
  const addTruck = () => {
    const num = truckNo.trim().toUpperCase();
    if (!num) return ping(tx("Write the truck number", "Truck number likho", "ट्रक नंबर लिखें"));
    if ((data.trucks || []).some((t) => t.number === num)) return ping(tx("Already added", "Already added", "पहले से जुड़ा है"));
    setData({ ...data, trucks: [...(data.trucks || []), { id: uid(), number: num, capMT: +truckCap || 0 }] });
    setTruckNo(""); setTruckCap(""); setTruckAdd(false);
    ping("🚚 " + num + tx(" added", " added", " जुड़ गया"));
  };
  const myCats = (data.myCats && data.myCats[ind.key]) || [];
  const catSuggestions = (CAT_SUGGEST[ind.key] || []).filter((x) => !(ind.cats || []).some((c) => c.key === x.key));
  const saveMyCats = (list) => setData({ ...data, myCats: { ...(data.myCats || {}), [ind.key]: list } });
  const removeCat = (key) => { saveMyCats(myCats.filter((c) => c.key !== key)); ping("Category removed"); };
  const addCat = () => {
    let c = null;
    if (catSel && catSel !== "__custom") c = (CAT_SUGGEST[ind.key] || []).find((x) => x.key === catSel);
    else if (catSel === "__custom") {
      const label = catName.trim();
      if (!label) return ping(tx("Write a category name", "Category ka naam likho", "श्रेणी का नाम लिखें"));
      const key = "c_" + (label.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 18) || uid());
      c = { key, label, emoji: (catEmoji.trim() || "\u{1F4E6}").slice(0, 4) };
    } else return ping(tx("Pick from the list first", "Pehle list se chuno", "पहले सूची से चुनें"));
    if (!c || (ind.cats || []).some((x) => x.key === c.key)) return ping("Already added");
    saveMyCats([...myCats, c]);
    setCatSel(""); setCatName(""); setCatEmoji(""); setCatAdd(false);
    ping(c.emoji + " " + c.label + " added");
  };

  const [rc, setRc] = useState({ name: "", count: 1, price: 1500000, life: 8, hrsDay: 8, daysMo: 25, kw: 8, unit: 8, operator: 30000, maint: 75000 });
  const mh = rc.hrsDay * rc.daysMo;
  const dep = rc.price / rc.life / 12 / mh, pow = rc.kw * rc.unit, op = rc.operator / mh, mnt = rc.maint / 12 / mh;
  const rate = Math.ceil(dep + pow + op + mnt);
  const segs = [{ v: dep, c: "#155E18", l: "Depreciation" }, { v: pow, c: "#228B22", l: "Power" }, { v: op, c: "#3FAE45", l: "Operator" }, { v: mnt, c: "#7CCB80", l: "Maintenance" }];

  const addMachine = () => {
    if (!rc.name.trim()) return ping("Give the machine a name");
    const n = Math.max(1, Math.floor(rc.count || 1));
    setData({ ...data, machines: [...data.machines, { id: uid(), name: rc.name.trim(), rate, count: n }] });
    setCalcOpen(false); setRc({ ...rc, name: "", count: 1 }); ping((n > 1 ? n + "x " : "") + rc.name.trim() + " added at " + inr(rate) + "/hr");
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
        <span className="eyebrow">{tx("Your shop", "Your shop", "आपकी दुकान")}</span>
        <div className="h-disp" style={{ fontSize: 26, fontWeight: 700, marginTop: 4 }}>Setup</div>
      </div>

      {/* account + plan */}
      {(() => {
        const plan = PLANS.find((p) => p.id === account?.plan) || (account?.plan ? PLANS[0] : null);
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

      {/* one account, two doors - phone and Google both open this same shop */}
      <LoginMethods account={account} ping={ping} />

      <label className="lbl" style={{ marginTop: 18 }}>{tx("Shop name", "Shop name", "दुकान का नाम")}</label>
      <input className="input anim-in st1" value={data.shopName} onChange={(e) => setData({ ...data, shopName: e.target.value })} />

      {/* app language - the Hinglish/Hindi/English switch */}
      <label className="lbl anim-in st1" style={{ marginTop: 16 }}>{tx("Language", "Language / Bhasha", "भाषा")}</label>
      <div className="anim-in st1" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {[["en", "English"], ["hi-en", "Hinglish"], ["hi", "हिन्दी"]].map(([k, l]) => (
          <button key={k} className={"fpill press " + ((s.lang || "hi-en") === k ? "on" : "")} onClick={() => { setS("lang", k); ping(l); }}>{l}</button>
        ))}
      </div>

      {/* trade focus - tunes labels + examples */}
      <label className="lbl anim-in st1" style={{ marginTop: 16 }}>{tx("Your trade", "Your trade", "आपका काम")}</label>
      <div className="anim-in st1" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {/* live trades only - plus the account's current trade if it is a
            hidden one, so an existing printing/furniture shop still sees
            its own trade selected instead of nothing */}
        {(LIVE_TRADES.includes(ind.key) ? LIVE_TRADES : [...LIVE_TRADES, ind.key]).map((k) => INDUSTRIES[k]).map((it) => (
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
      <div className="anim-in st2" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "24px 0 10px" }}>
        <span className="eyebrow">{tx("Your categories", "Your categories", "आपकी श्रेणियां")}</span>
        <button className="btn btn-sm btn-soft press" onClick={() => setCatAdd(!catAdd)}>{catAdd ? tx("Close", "Close", "बंद करें") : tx("+ Add category", "+ Add category", "+ श्रेणी जोड़ें")}</button>
      </div>
      <div className="card" style={{ padding: "14px 15px" }}>
        <span className="hint" style={{ margin: "0 0 10px" }}>{tx("These power the tiles on your Home screen and the filters in your pipeline. Every quote is sorted into one automatically.", "These power the tiles on your Home screen and the filters in your pipeline. Every quote is sorted into one automatically.", "ये आपकी होम स्क्रीन की टाइलें और पाइपलाइन के फिल्टर चलाती हैं। हर कोटेशन अपने आप एक श्रेणी में जाता है।")}</span>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {(ind.cats || []).map((c) => {
            const mine = myCats.some((x) => x.key === c.key);
            return (
              <span key={c.key} style={{ display: "inline-flex", alignItems: "center", gap: 6, background: mine ? "var(--grn-100)" : "var(--soft)", border: "1px solid var(--line)", borderRadius: 999, padding: "7px 12px", fontSize: 13.5, fontWeight: 600 }}>
                <span style={{ fontSize: 14 }}>{c.emoji}</span> {c.label}
                {mine && <button onClick={() => removeCat(c.key)} aria-label="Remove" style={{ all: "unset", cursor: "pointer", color: "var(--faint)", fontSize: 15, lineHeight: 1, marginLeft: 2 }}>×</button>}
              </span>
            );
          })}
        </div>
        {catAdd && (
          <div className="anim-in" style={{ marginTop: 12, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
            <label className="lbl">{tx("Pick a common one", "Pick a common one", "आम में से चुनें")}</label>
            <select className="input" value={catSel} onChange={(e) => setCatSel(e.target.value)}>
              <option value="">{tx("Choose...", "Choose...", "चुनें...")}</option>
              {catSuggestions.map((x) => (<option key={x.key} value={x.key}>{x.emoji} {x.label}</option>))}
              <option value="__custom">{tx("Write your own (custom)", "Apna naam likho (custom)", "अपना नाम लिखें (कस्टम)")}</option>
            </select>
            {catSel === "__custom" && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 76px", gap: 9, marginTop: 9 }}>
                <div><label className="lbl" style={{ fontSize: 12.5 }}>{tx("Category name", "Category name", "श्रेणी का नाम")}</label><input className="input" placeholder="e.g. Gears" value={catName} onChange={(e) => setCatName(e.target.value)} /></div>
                <div><label className="lbl" style={{ fontSize: 12.5 }}>Emoji</label><input className="input" placeholder="📦" value={catEmoji} onChange={(e) => setCatEmoji(e.target.value)} style={{ textAlign: "center" }} /></div>
              </div>
            )}
            <button className="btn btn-grn press" style={{ width: "100%", marginTop: 10 }} onClick={addCat}>{tx("Add category", "Add category", "श्रेणी जोड़ें")}</button>
          </div>
        )}
      </div>

      {/* scrap: the truck fleet that feeds the Truck board */}
      {isScrap && (<>
      <div className="anim-in st2" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "24px 0 10px" }}>
        <span className="eyebrow">{tx("Trucks", "Trucks (gaadiyan)", "ट्रक (गाड़ियां)")}</span>
        <button className="btn btn-sm btn-soft press" onClick={() => setTruckAdd(!truckAdd)}>{truckAdd ? tx("Close", "Close", "बंद करें") : tx("+ Add truck", "+ Truck jodo", "+ ट्रक जोड़ें")}</button>
      </div>
      {(data.trucks || []).map((t) => (
        <div key={t.id} className="card" style={{ padding: "13px 15px", marginBottom: 9, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            <span style={{ fontSize: 18 }}>🚚</span>
            <span style={{ minWidth: 0 }}>
              <span className="mono" style={{ display: "block", fontWeight: 700, fontSize: 14.5, letterSpacing: ".04em" }}>{t.number}</span>
              {t.capMT > 0 && <span className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>~{t.capMT} MT</span>}
            </span>
          </span>
          <button className="iconbtn press" style={{ width: 34, height: 34 }} onClick={() => { setData({ ...data, trucks: (data.trucks || []).filter((x) => x.id !== t.id) }); ping(tx("Removed", "Removed", "हटाया")); }}><I.trash /></button>
        </div>
      ))}
      {(data.trucks || []).length === 0 && !truckAdd && (
        <div className="card-tint" style={{ padding: "13px 15px", fontSize: 13, color: "var(--dim)" }}>{tx("Add your trucks - the Truck board then shows which truck is out with how much maal.", "Apni gaadiyan jodo - Truck board par dikhega kaun si gaadi kitna maal leke bahar hai.", "अपनी गाड़ियां जोड़ें - ट्रक बोर्ड पर दिखेगा कौन सी गाड़ी कितना माल लेकर बाहर है।")}</div>
      )}
      {truckAdd && (
        <div className="card anim-in" style={{ padding: 16, border: "1.5px solid #CFE9D1" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 10 }}>
            <div><label className="lbl" style={{ fontSize: 12.5 }}>{tx("Truck number", "Truck number", "ट्रक नंबर")}</label><input className="input mono" placeholder="HR 38 AB 1234" value={truckNo} onChange={(e) => setTruckNo(e.target.value.toUpperCase())} /></div>
            <div><label className="lbl" style={{ fontSize: 12.5 }}>{tx("Capacity (MT)", "Capacity (MT)", "क्षमता (MT)")}</label><input className="input mono" type="number" inputMode="decimal" placeholder="18" value={truckCap} onChange={(e) => setTruckCap(e.target.value)} /></div>
          </div>
          <button className="btn btn-grn press" style={{ width: "100%", marginTop: 12 }} onClick={addTruck}>{tx("Save truck", "Truck save karo", "ट्रक सेव करें")}</button>
        </div>
      )}
      </>)}

      {isMach && (<>
      {/* machines */}
      <div className="anim-in st2" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "24px 0 10px" }}>
        <span className="eyebrow">{tx("Machines", "Machines", "मशीनें")}</span>
        <button className="btn btn-sm btn-soft press" onClick={() => setCalcOpen(!calcOpen)}>{calcOpen ? tx("Close", "Close", "बंद करें") : tx("+ Add machine", "+ Add machine", "+ मशीन जोड़ें")}</button>
      </div>
      {data.machines.map((m) => {
        const n = Math.max(1, Math.floor(m.count || 1));
        const bump = (v) => setData({ ...data, machines: data.machines.map((x) => x.id === m.id ? { ...x, count: Math.max(1, n + v) } : x) });
        return (
        <div key={m.id} className="card" style={{ padding: "14px 15px", marginBottom: 9, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
          <span style={{ fontWeight: 600, fontSize: 15, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{m.name}</span>
          <span style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 2, background: "var(--soft)", border: "1px solid var(--line)", borderRadius: 999, padding: "3px 5px" }}>
              <button className="press" onClick={() => bump(-1)} aria-label="One less" style={{ all: "unset", cursor: "pointer", width: 20, textAlign: "center", fontWeight: 700, color: n > 1 ? "var(--ink)" : "var(--line2)" }}>-</button>
              <span className="mono" style={{ fontSize: 12.5, fontWeight: 600 }}>×{n}</span>
              <button className="press" onClick={() => bump(1)} aria-label="One more" style={{ all: "unset", cursor: "pointer", width: 20, textAlign: "center", fontWeight: 700 }}>+</button>
            </span>
            <b className="mono" style={{ color: "var(--grn-d)" }}>{inr(m.rate)}/hr</b>
            <button className="iconbtn press" style={{ width: 34, height: 34 }} onClick={() => { setData({ ...data, machines: data.machines.filter((x) => x.id !== m.id) }); ping("Removed"); }}><I.trash /></button>
          </span>
        </div>
      );})}

      {calcOpen && (
        <div className="card anim-in" style={{ padding: 16, marginTop: 6, border: "1.5px solid #CFE9D1" }}>
          <div className="lbl" style={{ color: "var(--grn-d)", marginBottom: 4 }}>True hourly-rate calculator</div>
          <span className="hint">Fill these once - the app works out what one machine-hour really costs you.</span>
          <label className="lbl" style={{ marginTop: 8 }}>{tx("Pick a common NCR machine", "Pick a common NCR machine", "आम NCR मशीन चुनें")}</label>
          <select className="input" value="" onChange={(e) => { if (e.target.value) setRc({ ...rc, name: e.target.value }); }}>
            <option value="">{tx("Choose from the list...", "Choose from the list...", "सूची से चुनें...")}</option>
            {MACHINE_LIB.map((nm) => (<option key={nm} value={nm}>{nm}</option>))}
          </select>
          <label className="lbl" style={{ marginTop: 10 }}>{tx("Machine name", "Machine name", "मशीन का नाम")}</label>
          <input className="input" placeholder="e.g. VMC 850" value={rc.name} onChange={(e) => setRc({ ...rc, name: e.target.value })} />
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
          <label className="lbl" style={{ marginTop: 12 }}>{tx("How many of this machine? (same model)", "How many of this machine? (same model)", "यह मशीन कितनी हैं? (एक ही मॉडल)")}</label>
          <input className="input mono" type="number" inputMode="numeric" min="1" value={rc.count} onChange={(e) => setRc({ ...rc, count: Math.max(1, Math.floor(+e.target.value || 1)) })} />
          <span className="hint">{tx("Each machine becomes its own unit (#1, #2...) - shown separately on the Machine floor.", "Har machine alag unit banegi (#1, #2...) - Machine floor par sab alag dikhengi.", "हर मशीन अलग यूनिट बनेगी (#1, #2...) - मशीन फ्लोर पर सब अलग दिखेंगी।")}</span>
          <button className="btn btn-grn press" style={{ width: "100%", marginTop: 12 }} onClick={addMachine}>{tx("Save machine", "Save machine", "मशीन सेव करें")}</button>
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

      {/* ===== MSMED / Udyam - unlocks the kanooni-byaj counter on the Tally
          page. Machining ONLY: traders are excluded from the MSMED
          delayed-payment chapter by law, so the toggle must never render for
          scrap/trading users (MSMED_LEVERAGE.md). ===== */}
      {isMach && (<>
      <div className="anim-in" style={{ margin: "24px 0 10px" }}><span className="eyebrow">MSMED / Udyam</span></div>
      <div className="card" style={{ padding: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 14 }}>
          <div style={{ flex: 1 }}>
            <div className="lbl" style={{ margin: 0 }}>{tx("Udyam registered?", "Udyam registration hai?", "उद्यम रजिस्ट्रेशन है?")}</div>
            <span className="hint" style={{ margin: "5px 0 0" }}>
              {s.udyam
                ? tx("The legal interest owed to you on late bills (3x bank rate, compound - MSMED s.16) now shows on the Tally page. Manufacturers and service MSEs only; Udyam must be older than the bill.", "Late bills par aapka kanooni byaj (3x bank rate, compound - MSMED s.16) ab Tally page par dikhta hai. Sirf manufacturer/service MSE; Udyam bill se purana hona chahiye.", "लेट बिलों पर आपका कानूनी ब्याज (3x बैंक रेट, चक्रवृद्धि - MSMED s.16) अब Tally पेज पर दिखता है। सिर्फ निर्माता/सेवा MSE; उद्यम बिल से पुराना होना चाहिए।")
                : tx("Registration is free - udyamregistration.gov.in, 10 minutes. For manufacturer/service MSEs, invoices AFTER registration get legal cover: payment due in max 45 days, then 3x bank-rate compound interest applies by law. Trading businesses are not covered.", "Registration free hai - udyamregistration.gov.in, 10 minute. Manufacturer/service MSE ke liye, registration ke BAAD ke invoices ko kanooni cover milta hai: payment max 45 din, uske baad 3x bank rate ka compound byaj lagta hai. Trading business cover nahi hote.", "रजिस्ट्रेशन मुफ्त है - udyamregistration.gov.in, 10 मिनट। निर्माता/सेवा MSE के लिए, रजिस्ट्रेशन के बाद के इनवॉइस को कानूनी कवर मिलता है: पेमेंट अधिकतम 45 दिन, उसके बाद 3x बैंक रेट का चक्रवृद्धि ब्याज लगता है। ट्रेडिंग व्यवसाय कवर नहीं होते।")}
            </span>
          </div>
          <button onClick={() => { const on = !s.udyam; setS("udyam", on); ping(on ? tx("Byaj counter ON", "Byaj counter ON", "ब्याज काउंटर चालू") : tx("Byaj counter off", "Byaj counter off", "ब्याज काउंटर बंद")); }}
            aria-label="Toggle Udyam registered" aria-pressed={!!s.udyam}
            style={{ flexShrink: 0, width: 54, height: 32, borderRadius: 999, border: "none", cursor: "pointer", position: "relative", transition: "background .2s", background: s.udyam ? "linear-gradient(135deg,#2E9E33,#1B7A20)" : "var(--line2)" }}>
            <span style={{ position: "absolute", top: 3, left: s.udyam ? 25 : 3, width: 26, height: 26, borderRadius: "50%", background: "#fff", boxShadow: "0 2px 6px rgba(22,32,26,.25)", transition: "left .2s" }} />
          </button>
        </div>
      </div>
      </>)}

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
          <div className="card-tint" style={{ marginTop: 10, padding: "11px 13px", fontSize: 13.5, color: "var(--dim)", lineHeight: 1.6 }}>
            🔒 <b style={{ color: "var(--ink)" }}>Shuruaat READ-ONLY hoti hai:</b> connector aapke Tally ko sirf PADHTA hai - balances, bills, dispatches. Tally mein kuch nahi likha jaata. Jab aap taiyaar ho, order-push aap khud chalu karte ho (config mein pushOrders: true).
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
            1. Tally wale computer par <b>connector folder</b> copy karo.<br />
            2. <b>start-connector.bat</b> double-click karo.<br />
            3. Upar wali key paste kar do - bas, ho gaya.
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

      {/* ===== Shop floor phones (machining, cloud mode) ===== */}
      {isMach && sb && account && (<>
        <div className="anim-in st5" style={{ margin: "26px 0 6px" }}><span className="eyebrow">{tx("Shop floor phones", "Shop floor ke phone", "शॉप फ्लोर के फोन")}</span></div>
        <div className="card anim-in st5" style={{ padding: 16 }}>
          <div style={{ fontSize: 13.5, color: "var(--dim)", lineHeight: 1.6 }}>
            {tx("Give the floor a phone of its own. It shows only the machines and the work - no rates, no money, no customers' dues - and whatever is entered there reaches you here.",
                "Floor ko apna phone dein. Us par sirf machine aur kaam dikhta hai - rate, paisa, kisi ka baki kuch nahi - aur wahan jo likha jaata hai wo yahan aapko dikh jata hai.",
                "फ्लोर को अपना फोन दें। उस पर सिर्फ मशीन और काम दिखता है - रेट या पैसा नहीं।")}
          </div>

          {pairCode && (
            <div style={{ marginTop: 14, padding: "16px 14px", borderRadius: 16, background: "#F3FBF4", border: "1.5px solid #CFE9D1", textAlign: "center" }}>
              <div className="microlbl" style={{ color: "var(--grn-d)" }}>{tx("TYPE THIS ON THAT PHONE", "US PHONE PAR YE CODE DAALEIN", "उस फोन पर यह कोड डालें")}</div>
              <div className="h-disp mono" style={{ fontSize: 40, fontWeight: 700, letterSpacing: ".18em", color: "var(--grn-d)", margin: "8px 0 4px" }}>{pairCode.code}</div>
              <div style={{ fontSize: 12.5, color: "var(--dim)", lineHeight: 1.5 }}>
                {tx("On that phone open trackrakho.com and tap \"Shop floor phone? Pair it\" at the bottom. The code works once, for 15 minutes.",
                    "Us phone par trackrakho.com kholein aur neeche \"Shop floor ka phone? Yahan jodein\" dabayein. Code ek hi baar, 15 minute ke liye chalega.",
                    "उस फोन पर trackrakho.com खोलें और नीचे वाला बटन दबाएं। कोड एक बार, 15 मिनट चलेगा।")}
              </div>
            </div>
          )}

          <button className="btn btn-grn press" style={{ width: "100%", marginTop: 14 }} disabled={devBusy} onClick={makeCode}>
            {pairCode ? tx("New code", "Naya code", "नया कोड") : "+ " + tx("Add a floor phone", "Floor phone jodein", "फ्लोर फोन जोड़ें")}
          </button>

          {(devices || []).filter((d) => d.pairedAt).map((d) => (
            <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 10, paddingTop: 12, marginTop: 12, borderTop: "1px solid var(--line)" }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontWeight: 600, fontSize: 14.5 }}>{d.name || tx("Floor phone", "Floor phone", "फ्लोर फोन")}</span>
                <span className="mono" style={{ display: "block", fontSize: 11.5, color: "var(--faint)" }}>
                  {d.lastSeen ? tx("last used ", "aakhri baar ", "आखिरी बार ") + fdateShort(Date.parse(d.lastSeen)) : tx("never used", "abhi use nahi hua", "अभी इस्तेमाल नहीं")}
                </span>
              </span>
              <button className="btn btn-sm btn-ghost press" style={{ color: "var(--red)", flexShrink: 0 }} disabled={devBusy} onClick={() => dropDevice(d.id)}>
                {tx("Remove", "Hatao", "हटाएं")}
              </button>
            </div>
          ))}
          {devices && devices.filter((d) => d.pairedAt).length === 0 && !pairCode && (
            <div className="hint" style={{ marginTop: 10, textAlign: "center" }}>{tx("No floor phone yet.", "Abhi koi floor phone nahi juda.", "अभी कोई फ्लोर फोन नहीं जुड़ा।")}</div>
          )}
        </div>

        {/* breakdown alerts */}
        <div className="card anim-in st5" style={{ padding: 16, marginTop: 10, display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: "block", fontWeight: 700, fontSize: 15 }}>{tx("Tell me when a machine stops", "Machine band ho to batao", "मशीन बंद हो तो बताएं")}</span>
            <span style={{ display: "block", fontSize: 12.5, color: "var(--dim)", marginTop: 2, lineHeight: 1.5 }}>
              {tx("A notification for everything the floor does - job started or finished, work moved, a machine stopped or back up, a note for you. Only piece counts stay silent, or it would buzz all day.",
                  "Floor par jo bhi ho - kaam shuru ya khatam, kaam doosri machine par, machine band ya wapas chalu, ya koi note - sab ka notification aayega. Sirf piece ki ginti par nahi, warna din bhar bajta rahega.",
                  "फ्लोर पर जो भी हो - सबका नोटिफिकेशन। सिर्फ पीस की गिनती पर नहीं।")}
            </span>
          </span>
          <span style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
            <button className={"btn btn-sm press " + (pushOn ? "btn-grn" : "btn-ghost")} disabled={pushBusy} onClick={togglePush}>
              {pushOn ? tx("On", "Chalu", "चालू") : tx("Turn on", "Chalu karein", "चालू करें")}
            </button>
            {pushOn && (
              <button className="btn btn-sm btn-soft press" disabled={pushBusy} onClick={async () => {
                setPushBusy(true);
                try {
                  const r = await fetch(WA_API + "/push-subscribe", { method: "POST", headers: { "content-type": "application/json", ...(await authHeaders()) }, body: JSON.stringify({ test: true }) });
                  const d = await r.json().catch(() => ({}));
                  ping(d.ok ? (d.sent || 1) + tx(" phone notified - watch for it", " phone par bheja - dekhiye", " फोन पर भेजा")
                    : tx("0 phones registered - switch it off and on again", "0 phone registered - band karke dobara chalu karein", "0 फोन रजिस्टर - बंद करके फिर चालू करें"));
                } catch { ping(tx("No internet", "Internet nahi hai", "इंटरनेट नहीं")); }
                setPushBusy(false);
              }}>{tx("Test", "Test", "टेस्ट")}</button>
            )}
          </span>
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
      <div className="card-tint anim-in st6" style={{ padding: "13px 15px", display: "flex", gap: 10, alignItems: "flex-start", marginTop: 26 }}>
        <span aria-hidden="true">&#128274;</span>
        <span style={{ fontSize: 13, color: "var(--dim)", lineHeight: 1.6 }}>{tx("Data safety is our top priority. Your quotes, rates and customers stay inside your shop's own account - no other shop can ever see them, and Excel export means you can take everything out anytime.", "Data safety hamari pehli priority hai. Aapke quotes, rate aur customer sirf aapki shop ke account mein rehte hain - kisi aur shop ko kabhi nahi dikhte.", "\u0921\u0947\u091F\u093E \u0915\u0940 \u0938\u0941\u0930\u0915\u094D\u0937\u093E \u0939\u092E\u093E\u0930\u0940 \u092A\u0939\u0932\u0940 \u092A\u094D\u0930\u093E\u0925\u092E\u093F\u0915\u0924\u093E \u0939\u0948\u0964 \u0906\u092A\u0915\u0947 \u0915\u094B\u091F\u0947\u0936\u0928, \u0930\u0947\u091F \u0914\u0930 \u0917\u094D\u0930\u093E\u0939\u0915 \u0938\u093F\u0930\u094D\u092B \u0906\u092A\u0915\u0940 \u0926\u0941\u0915\u093E\u0928 \u0915\u0947 \u0905\u0915\u093E\u0909\u0902\u091F \u092E\u0947\u0902 \u0930\u0939\u0924\u0947 \u0939\u0948\u0902 - \u0915\u093F\u0938\u0940 \u0914\u0930 \u0926\u0941\u0915\u093E\u0928 \u0915\u094B \u0915\u092D\u0940 \u0928\u0939\u0940\u0902 \u0926\u093F\u0916\u0924\u0947\u0964")}</span>
      </div>
      <div className="anim-in st6" style={{ margin: "18px 0 10px" }}><span className="eyebrow">Data</span></div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 8 }}>
        <button className="btn btn-ghost btn-sm press" onClick={() => { const demo = demoShop(ind.key); setData({ ...data, machines: (data.machines || []).length ? data.machines : demo.machines, quotes: [...demo.quotes, ...(data.quotes || []).filter((q) => !q.seed)] }); ping(tx("Example data loaded - marked SAMPLE", "Example data aa gaya - SAMPLE likha hai", "उदाहरण डेटा आया - SAMPLE लिखा है")); }}>Load sample</button>
        <button className="btn btn-ghost btn-sm press" style={{ color: "var(--red)" }} onClick={() => {
          if (!confirmClear) { setConfirmClear(true); setTimeout(() => setConfirmClear(false), 2500); return; }
          const d = seedData(); d.quotes = []; d.machines = []; d.jobs = []; d.trucks = []; d.trips = []; d.stock = { open: {}, ins: [], outs: [], counts: [] }; d.shopName = ""; setData(d); setConfirmClear(false); ping("Cleared");
        }}>{confirmClear ? "Tap again to confirm" : "Clear everything"}</button>
      </div>
      <button className="btn btn-ghost btn-sm press" style={{ width: "100%", marginTop: 14, color: "var(--dim)" }} onClick={onLogout}><I.logout /> Log out</button>
      <div style={{ fontSize: 11.5, color: "var(--faint)", textAlign: "center", paddingBottom: 6, marginTop: 14 }} className="mono">TRACKRAKHO · EARLY ACCESS</div>
    </div></div>
  );
}
