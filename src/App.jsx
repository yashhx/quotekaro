import { useState, useEffect, useRef } from "react";

/* localStorage-backed storage shim — same async API the app expects,
   but works on any host (Vercel/Netlify). Each user's data stays on THEIR device. */
const storage = {
  get: async (k) => { const v = localStorage.getItem(k); return v == null ? null : { key: k, value: v }; },
  set: async (k, v) => { localStorage.setItem(k, v); return { key: k, value: v }; },
  delete: async (k) => { localStorage.removeItem(k); return { key: k, deleted: true }; },
};


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
};

/* ---------------- helpers ---------------- */
const inr = (n, d = 0) => "₹" + Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
const uid = () => Math.random().toString(36).slice(2, 9);
const KEY = "quotekaro:v4";
const AUTH_KEY = "quotekaro:auth:v1";

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
      { id: uid(), at: now - 2 * day, status: "won", customer: "Apex Hydraulics", part: "Gland Nut - 60mm", qty: 200, pricePc: 174.39, total: 34878 },
      { id: uid(), at: now - 0.2 * day, status: "pending", customer: "Krishna Pumps", part: "Bush Ø42", qty: 500, pricePc: 61.2, total: 30600 },
      { id: uid(), at: now - 6 * day, status: "lost", customer: "Om Forgings", part: 'Flange 6"', qty: 120, pricePc: 412.5, total: 49500 },
    ],
  };
};

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
  `*Total: ${inr(q.total)} + GST*\n` + `Valid ${validity} days\n- Sent via QuoteKaro`;

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
  doc.text("GENERATED WITH QUOTEKARO", W / 2, doc.internal.pageSize.getHeight() - 40, { align: "center" });

  doc.save(num + ".pdf");
  return true;
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
function Auth({ onAuthed }) {
  const [mode, setMode] = useState("otp"); // otp | password
  const [stage, setStage] = useState("enter"); // enter | code (for otp)
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState(["", "", "", ""]);
  const [uname, setUname] = useState("");
  const [pass, setPass] = useState("");
  const [err, setErr] = useState("");
  const otpRefs = useRef([]);

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
        <h1>QuoteKaro</h1>
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
        One underquoted job can cost more than a year of QuoteKaro. Prices per month, billed yearly. GST extra.
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
export default function App() {
  const [data, setData] = useState(null);
  const [tab, setTab] = useState("home");
  const [toast, setToast] = useState(null);
  const [draft, setDraft] = useState(null);
  const [step, setStep] = useState(1);
  const [doneQuote, setDoneQuote] = useState(null);
  const [quotesFilter, setQuotesFilter] = useState("all");
  const [account, setAccount] = useState(undefined); // undefined = loading, null = logged out, object = logged in
  const saveT = useRef(null);

  /* load account (auth) */
  useEffect(() => {
    (async () => {
      try { const r = await storage.get(AUTH_KEY); setAccount(r ? JSON.parse(r.value) : null); }
      catch { setAccount(null); }
    })();
  }, []);
  const saveAccount = (acc) => { setAccount(acc); storage.set(AUTH_KEY, JSON.stringify(acc)).catch(() => {}); };
  const logout = () => { setAccount(null); storage.delete(AUTH_KEY).catch(() => {}); setTab("home"); };
  const subscribe = (planId) => { const acc = { ...account, plan: planId, subAt: Date.now() }; saveAccount(acc); };

  useEffect(() => {
    (async () => {
      try { const r = await storage.get(KEY); setData(r ? JSON.parse(r.value) : seedData()); }
      catch { setData(seedData()); }
    })();
  }, []);
  useEffect(() => {
    if (!data) return;
    clearTimeout(saveT.current);
    saveT.current = setTimeout(() => { storage.set(KEY, JSON.stringify(data)).catch(() => {}); }, 400);
  }, [data]);

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

  if (!data || account === undefined)
    return (<div className="qk-root"><style>{CSS}</style><div className="app" style={{ alignItems: "center", justifyContent: "center" }}>
      <div className="mono" style={{ color: "var(--faint)", fontSize: 12, letterSpacing: ".2em" }}>LOADING...</div></div></div>);

  if (!account)
    return (<div className="qk-root"><style>{CSS}</style><div className="app"><Auth onAuthed={saveAccount} /></div></div>);

  const startQuote = () => {
    setDraft({ customer: "", part: "", qty: "", materialId: "", rawKg: "", machineId: data.machines[0]?.id || "",
      cycleMin: "", manualMin: "", setupMin: "", toolingPc: 5, overheadPct: data.settings.overheadPct, marginPct: data.settings.marginPct });
    setStep(1); setDoneQuote(null); setTab("new");
  };
  const saveQuote = (c) => {
    const q = { id: uid(), at: Date.now(), status: "pending", customer: draft.customer, part: draft.part, qty: +draft.qty, pricePc: c.pricePc, total: c.total };
    setData({ ...data, quotes: [q, ...data.quotes] }); setDoneQuote(q);
  };
  const setStatus = (id, status) => setData({ ...data, quotes: data.quotes.map((q) => (q.id === id ? { ...q, status } : q)) });
  const delQuote = (id) => setData({ ...data, quotes: data.quotes.filter((q) => q.id !== id) });
  const goQuotes = (f) => { setQuotesFilter(f || "all"); setTab("quotes"); };

  return (
    <div className="qk-root"><style>{CSS}</style>
      <div className="app">
        {toast && <div className="toast">{toast}</div>}

        {tab === "home" && <Home data={data} account={account} onNew={startQuote} goQuotes={goQuotes} openAnalytics={() => setTab("analytics")} goSetup={() => setTab("setup")} goSubscribe={() => setTab("subscribe")} />}
        {tab === "quotes" && <Quotes data={data} setStatus={setStatus} delQuote={delQuote} ping={ping} filter={quotesFilter} setFilter={setQuotesFilter} />}
        {tab === "setup" && <Setup data={data} setData={setData} ping={ping} account={account} goSubscribe={() => setTab("subscribe")} onLogout={logout} />}
        {tab === "help" && <Help data={data} ping={ping} />}
        {tab === "analytics" && <Analytics data={data} onBack={() => setTab("home")} goQuotes={goQuotes} />}
        {tab === "subscribe" && <Subscribe account={account} onSubscribe={(id) => { subscribe(id); ping("You're on the " + PLANS.find(p => p.id === id).name + " plan"); setTab("home"); }} onBack={() => setTab("home")} />}
        {tab === "new" && (<Wizard data={data} draft={draft} setDraft={setDraft} step={step} setStep={setStep}
          onExit={() => setTab("home")} onSave={saveQuote} doneQuote={doneQuote} ping={ping}
          onFinish={() => { setTab("home"); setDoneQuote(null); }} />)}

        {tab !== "new" && tab !== "analytics" && tab !== "subscribe" && (
          <nav className="navbar" ref={navRef}>
            <div className="nav-pill" style={pillStyle} />
            <button ref={setNavRef("home")} className={"nav-it " + (tab === "home" ? "on" : "")} onClick={() => setTab("home")}><I.home /><span>Home</span></button>
            <button ref={setNavRef("quotes")} className={"nav-it " + (tab === "quotes" ? "on" : "")} onClick={() => setTab("quotes")}><I.list /><span>Quotes</span></button>
            <button className="fab press" onClick={startQuote} aria-label="New quotation"><I.plus /></button>
            <button ref={setNavRef("setup")} className={"nav-it " + (tab === "setup" ? "on" : "")} onClick={() => setTab("setup")}><I.gear /><span>Setup</span></button>
            <button ref={setNavRef("help")} className={"nav-it " + (tab === "help" ? "on" : "")} onClick={() => setTab("help")}><I.help /><span>Help</span></button>
          </nav>
        )}
      </div>
    </div>
  );
}

/* ================= HOME ================= */
function Home({ data, account, onNew, goQuotes, openAnalytics, goSetup, goSubscribe }) {
  /* animated hero lines - flow speed tracks scroll velocity */
  const flowRefs = useRef([]);
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    const scroller = flowRefs.current[0] ? flowRefs.current[0].closest(".scr") : null;
    let off = 0, vel = 0, base = 0.35, lastY = scroller ? scroller.scrollTop : 0, raf;
    const onScroll = () => { const y = scroller ? scroller.scrollTop : 0; vel += Math.min(Math.abs(y - lastY) * 0.12, 6); lastY = y; };
    if (scroller) scroller.addEventListener("scroll", onScroll, { passive: true });
    const tick = () => {
      off -= base + vel;
      vel *= 0.92; /* smooth ease-out back to base speed */
      flowRefs.current.forEach((p, i) => { if (p) p.style.strokeDashoffset = (off * (1 + i * 0.18)).toFixed(1); });
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => { cancelAnimationFrame(raf); if (scroller) scroller.removeEventListener("scroll", onScroll); };
  }, []);

  const h = new Date().getHours();
  const greet = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  const m0 = new Date(); m0.setDate(1); m0.setHours(0, 0, 0, 0);
  const month = data.quotes.filter((q) => q.at >= m0.getTime());
  const value = month.reduce((s, q) => s + q.total, 0);
  const won = month.filter((q) => q.status === "won").length;
  const lost = month.filter((q) => q.status === "lost").length;
  const winRate = won + lost ? Math.round((won / (won + lost)) * 100) : null;
  const days = [...Array(7)].map((_, i) => {
    const d0 = new Date(); d0.setHours(0, 0, 0, 0); d0.setDate(d0.getDate() - (6 - i));
    const d1 = new Date(d0); d1.setDate(d1.getDate() + 1);
    return data.quotes.filter((q) => q.at >= d0 && q.at < d1).length;
  });
  const max = Math.max(1, ...days);
  const recent = data.quotes.slice(0, 3);

  return (
    <div className="scr"><div className="pagepad">
      <div className="anim-in" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <div className="microlbl">{new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short" })}</div>
          <div className="h-disp" style={{ fontSize: 26, fontWeight: 700, marginTop: 3 }}>{greet} 👋</div>
          <div style={{ fontSize: 14.5, color: "var(--dim)" }}>{data.shopName}</div>
        </div>
        <button onClick={goSetup} className="press" style={{ width: 48, height: 48, borderRadius: 15, background: "linear-gradient(135deg,#2E9E33,#155E18)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--mono)", fontWeight: 600, fontSize: 14, boxShadow: "var(--sh-s)", border: "none", cursor: "pointer" }}>
          {data.shopName.split(" ").map((w) => w[0]).slice(0, 2).join("")}
        </button>
      </div>

      {/* hero - bigger numbers + larger labels; whole strip tappable */}
      <div className="hero-card anim-in st1" style={{ padding: "24px 22px 22px", marginBottom: 14 }}>
        <div className="hero-lines" aria-hidden="true">
          <svg viewBox="0 0 400 220" preserveAspectRatio="none">
            <path ref={(el) => (flowRefs.current[0] = el)} d="M-20 40 C 80 10, 150 70, 240 40 S 420 30, 460 55" />
            <path ref={(el) => (flowRefs.current[1] = el)} d="M-20 95 C 70 70, 160 120, 250 92 S 410 88, 460 105" />
            <path ref={(el) => (flowRefs.current[2] = el)} d="M-20 150 C 90 130, 150 175, 250 148 S 420 140, 460 165" />
            <path ref={(el) => (flowRefs.current[3] = el)} d="M-20 200 C 80 185, 160 215, 260 195 S 410 192, 460 205" />
          </svg>
        </div>
        <button onClick={() => goQuotes("all")} style={{ all: "unset", cursor: "pointer", display: "block", width: "100%" }}>
          <div style={{ fontSize: 14, fontWeight: 600, letterSpacing: ".04em", color: "rgba(255,255,255,.85)", display: "flex", alignItems: "center", gap: 5 }}>QUOTED THIS MONTH <I.chev style={{ width: 15, opacity: .8 }} /></div>
          <div className="h-disp mono" style={{ fontSize: 46, fontWeight: 700, margin: "8px 0 18px" }}><CountUp value={value} /></div>
        </button>
        <div style={{ display: "flex", gap: 9, position: "relative", zIndex: 1 }}>
          <button onClick={() => goQuotes("all")} style={statBtn}>
            <div className="mono" style={{ fontSize: 26, fontWeight: 700 }}>{month.length}</div>
            <div style={{ fontSize: 12, fontWeight: 600, color: "rgba(255,255,255,.82)", marginTop: 3 }}>Quotes</div>
          </button>
          <button onClick={() => goQuotes("won")} style={statBtn}>
            <div className="mono" style={{ fontSize: 26, fontWeight: 700 }}>{winRate == null ? "-" : winRate + "%"}</div>
            <div style={{ fontSize: 12, fontWeight: 600, color: "rgba(255,255,255,.82)", marginTop: 3 }}>Win rate</div>
          </button>
          <button onClick={openAnalytics} style={{ ...statBtn, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 28 }}>
              {days.map((v, i) => (<i key={i} style={{ width: 5, borderRadius: 3, background: "rgba(255,255,255," + (v ? ".95" : ".28") + ")", height: 5 + (v / max) * 22, display: "block" }} />))}
            </div>
            <div style={{ fontSize: 12, fontWeight: 600, color: "rgba(255,255,255,.82)", marginTop: 4, display: "flex", alignItems: "center", gap: 3 }}>7 days <I.chev style={{ width: 13, opacity: .8 }} /></div>
          </button>
        </div>
      </div>

      <button className="btn btn-grn press anim-in st2" style={{ width: "100%", padding: 18 }} onClick={onNew}>
        <I.plus style={{ width: 19 }} /> New quotation
      </button>

      <div className="anim-in st3" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "26px 0 10px" }}>
        <span className="eyebrow">Recent quotes</span>
        <button onClick={() => goQuotes("all")} style={{ background: "none", border: "none", color: "var(--grn-d)", fontWeight: 600, fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center" }}>All <I.chev /></button>
      </div>

      {recent.map((q, i) => (
        <button key={q.id} onClick={() => goQuotes("all")} className={"card press anim-in st" + (4 + i)}
          style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 16px", marginBottom: 10, background: "#fff", border: "1px solid var(--line)", borderRadius: 22, width: "100%", boxShadow: "var(--sh-s)" }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 15.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{q.customer}</div>
            <div style={{ fontSize: 13.5, color: "var(--dim)", marginTop: 2 }}>{q.part} · {q.qty} pcs</div>
          </div>
          <div style={{ textAlign: "right", flexShrink: 0, marginLeft: 12 }}>
            <div className="mono" style={{ fontWeight: 600, fontSize: 15.5 }}>{inr(q.total)}</div>
            <span className={"pill " + (q.status === "won" ? "won" : q.status === "lost" ? "lost" : "pend")} style={{ marginTop: 4 }}><i className="dot" />{q.status.toUpperCase()}</span>
          </div>
        </button>
      ))}

      {!account?.plan && (
        <button onClick={goSubscribe} className="press anim-in st6" style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", width: "100%", marginTop: 6, display: "flex", alignItems: "center", gap: 12, padding: "15px 16px", borderRadius: 18, background: "linear-gradient(135deg,#1B7A20,#2E9E33)", color: "#fff", boxShadow: "var(--sh-m)" }}>
          <span style={{ flexShrink: 0 }}><I.crown /></span>
          <span style={{ flex: 1, fontSize: 13.5, fontWeight: 600 }}>Unlock unlimited quotes & analytics</span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 12, background: "rgba(255,255,255,.2)", padding: "5px 10px", borderRadius: 999 }}>From ₹2,500 ›</span>
        </button>
      )}

      <div className="card-tint anim-in st7" style={{ padding: "15px 16px", display: "flex", gap: 10, alignItems: "center", marginTop: 10 }}>
        <span style={{ color: "var(--grn)" }}><I.bolt /></span>
        <span style={{ fontSize: 13.5, color: "var(--dim)" }}>Your VMC 850's true rate is <b className="mono" style={{ color: "var(--grn-d)" }}>{inr(data.machines[0]?.rate || 0)}/hr</b> - every quote uses it automatically.</span>
      </div>
    </div></div>
  );
}
const statBtn = { all: "unset", boxSizing: "border-box", cursor: "pointer", flex: 1, background: "rgba(255,255,255,.13)", border: "1px solid rgba(255,255,255,.18)", borderRadius: 16, padding: "13px 10px", textAlign: "center" };

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
        <a className="btn btn-grn press" style={{ textDecoration: "none" }} href={"https://wa.me/?text=" + encodeURIComponent(msg)} target="_blank" rel="noreferrer"><I.wa /> WhatsApp</a>
      </div>
      <button className="btn btn-ghost press anim-in st6" style={{ width: "100%", marginTop: 10 }} onClick={pdf}><I.pdf /> Download PDF quotation</button>
      <button className="btn btn-soft press anim-in st7" style={{ width: "100%", marginTop: 10 }} onClick={onFinish}>Done - back to home</button>
      <div className="anim-in st8" style={{ fontSize: 12.5, color: "var(--faint)", marginTop: 14 }}>Saved as <b>Pending</b> - mark it Won or Lost from the Quotes tab.</div>
    </div></div>
  );
}

/* ================= QUOTES ================= */
function Quotes({ data, setStatus, delQuote, ping, filter, setFilter }) {
  const [open, setOpen] = useState(null);
  const list = data.quotes.filter((q) => filter === "all" || q.status === filter);
  const fdate = (t) => new Date(t).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

  return (
    <div className="scr"><div className="pagepad">
      <div className="anim-in" style={{ marginBottom: 16 }}>
        <span className="eyebrow">Pipeline</span>
        <div className="h-disp" style={{ fontSize: 26, fontWeight: 700, marginTop: 4 }}>Quotes</div>
      </div>
      <div className="anim-in st1" style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {["all", "pending", "won", "lost"].map((k) => (<button key={k} className={"fpill press " + (filter === k ? "on" : "")} onClick={() => setFilter(k)}>{k[0].toUpperCase() + k.slice(1)}</button>))}
      </div>
      {list.length === 0 && (<div className="card-tint anim-in st2" style={{ padding: 30, textAlign: "center", color: "var(--dim)", fontSize: 14.5 }}>Nothing here yet - tap <b style={{ color: "var(--grn-d)" }}>+</b> to make your first quotation.</div>)}
      {list.map((q, i) => (
        <div key={q.id} className={"card anim-in st" + Math.min(8, i + 2)} style={{ padding: "16px 16px", marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }} onClick={() => setOpen(open === q.id ? null : q.id)}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 15.5 }}>{q.customer}</div>
              <div style={{ fontSize: 13.5, color: "var(--dim)", marginTop: 2 }}>{q.part} · {q.qty} pcs · {fdate(q.at)}</div>
            </div>
            <div style={{ textAlign: "right", flexShrink: 0, marginLeft: 12 }}>
              <div className="mono" style={{ fontWeight: 600, fontSize: 15.5 }}>{inr(q.total)}</div>
              <span className={"pill " + (q.status === "won" ? "won" : q.status === "lost" ? "lost" : "pend")} style={{ marginTop: 4 }}><i className="dot" />{q.status.toUpperCase()}</span>
            </div>
          </div>
          {open === q.id && (
            <div className="anim-in" style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
              {q.status !== "won" && <button className="btn btn-sm btn-soft press" onClick={() => { setStatus(q.id, "won"); ping("Marked as Won 🎉"); }}>Mark Won</button>}
              {q.status !== "lost" && <button className="btn btn-sm btn-ghost press" onClick={() => { setStatus(q.id, "lost"); ping("Marked as Lost"); }}>Mark Lost</button>}
              {q.status !== "pending" && <button className="btn btn-sm btn-ghost press" onClick={() => { setStatus(q.id, "pending"); ping("Reopened"); }}>Reopen</button>}
              <button className="btn btn-sm btn-ghost press" onClick={async () => { ping("Preparing PDF..."); try { await downloadQuotePDF(q, data); ping("PDF downloaded"); } catch { ping("PDF needs internet"); } }}><I.pdf /> PDF</button>
              <button className="btn btn-sm btn-ghost press" onClick={async () => { try { await navigator.clipboard.writeText(waText(q, data.shopName, data.settings.validityDays)); ping("Message copied"); } catch { ping("Copy failed"); } }}><I.copy /></button>
              <button className="btn btn-sm btn-ghost press" style={{ color: "var(--red)" }} onClick={() => { delQuote(q.id); ping("Deleted"); }}><I.trash /></button>
            </div>
          )}
        </div>
      ))}
    </div></div>
  );
}

/* ================= ANALYTICS (opens from 7-days) ================= */
function Analytics({ data, onBack, goQuotes }) {
  const day = 86400000;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = [...Array(7)].map((_, i) => {
    const d0 = new Date(today); d0.setDate(d0.getDate() - (6 - i));
    const d1 = new Date(d0); d1.setDate(d1.getDate() + 1);
    const qs = data.quotes.filter((q) => q.at >= d0.getTime() && q.at < d1.getTime());
    return {
      label: d0.toLocaleDateString("en-IN", { weekday: "short" }),
      date: d0.toLocaleDateString("en-IN", { day: "numeric", month: "short" }),
      count: qs.length,
      value: qs.reduce((s, q) => s + q.total, 0),
      won: qs.filter((q) => q.status === "won").length,
      lost: qs.filter((q) => q.status === "lost").length,
      pending: qs.filter((q) => q.status === "pending").length,
    };
  });
  const maxVal = Math.max(1, ...days.map((d) => d.value));
  const totVal = days.reduce((s, d) => s + d.value, 0);
  const totCount = days.reduce((s, d) => s + d.count, 0);
  const totWon = days.reduce((s, d) => s + d.won, 0);
  const totLost = days.reduce((s, d) => s + d.lost, 0);
  const winRate = totWon + totLost ? Math.round((totWon / (totWon + totLost)) * 100) : null;
  const best = days.reduce((a, b) => (b.value > a.value ? b : a), days[0]);

  return (
    <div className="scr"><div className="pagepad">
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
        <button className="iconbtn press" onClick={onBack}><I.back /></button>
        <div><div className="microlbl">LAST 7 DAYS</div><div className="h-disp" style={{ fontSize: 23, fontWeight: 700 }}>Your week</div></div>
      </div>

      {/* summary trio */}
      <div className="anim-in st1" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 16 }}>
        {[[inr(totVal), "QUOTED"], [totCount, "QUOTES"], [winRate == null ? "-" : winRate + "%", "WON"]].map(([v, l], i) => (
          <div key={i} className="card" style={{ padding: "15px 12px", textAlign: "center" }}>
            <div className="h-disp mono" style={{ fontSize: 20, fontWeight: 700, color: "var(--grn-d)" }}>{v}</div>
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--faint)", marginTop: 3 }}>{l}</div>
          </div>
        ))}
      </div>

      {/* value-by-day bar chart */}
      <div className="card anim-in st2" style={{ padding: "20px 18px 16px", marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
          <span className="lbl" style={{ margin: 0 }}>Quoted value by day</span>
          <span style={{ color: "var(--grn)" }}><I.chart /></span>
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 8, height: 150 }}>
          {days.map((d, i) => {
            const hPct = (d.value / maxVal) * 100;
            return (
              <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 7, height: "100%", justifyContent: "flex-end" }}>
                <div className="mono" style={{ fontSize: 9.5, color: d.value ? "var(--grn-d)" : "transparent", fontWeight: 600, whiteSpace: "nowrap" }}>
                  {d.value >= 1000 ? "₹" + (d.value / 1000).toFixed(0) + "k" : d.value ? "₹" + d.value : "0"}
                </div>
                <div style={{ width: "100%", maxWidth: 30, flex: 1, display: "flex", alignItems: "flex-end" }}>
                  <div style={{ width: "100%", height: Math.max(hPct, d.value ? 6 : 2) + "%",
                    background: d.value ? "linear-gradient(180deg,#3FAE45,#1B7A20)" : "var(--line)",
                    borderRadius: 7, transition: "height .6s cubic-bezier(.2,.7,.3,1)",
                    boxShadow: d.value ? "0 4px 12px -4px rgba(34,139,34,.5)" : "none",
                    animation: "growBar .6s cubic-bezier(.2,.7,.3,1) both", animationDelay: (i * .05) + "s" }} />
                </div>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink)" }}>{d.label}</div>
              </div>
            );
          })}
        </div>
        <div style={{ borderTop: "1px solid var(--line)", marginTop: 14, paddingTop: 12, fontSize: 12.5, color: "var(--dim)", textAlign: "center" }}>
          {totCount ? <>Best day was <b style={{ color: "var(--grn-d)" }}>{best.label} ({best.date})</b> - {inr(best.value)} quoted.</> : "No quotes in the last 7 days yet."}
        </div>
      </div>

      {/* won/lost/pending stacked composition */}
      <div className="card anim-in st3" style={{ padding: "20px 18px 18px", marginBottom: 14 }}>
        <span className="lbl">Outcome of this week's quotes</span>
        <span className="hint">How the {totCount} quote{totCount === 1 ? "" : "s"} you sent are doing.</span>
        {totCount ? (<>
          <div className="segbar" style={{ height: 14, marginTop: 6 }}>
            <i style={{ width: (totWon / totCount) * 100 + "%", background: "#228B22" }} />
            <i style={{ width: (days.reduce((s, d) => s + d.pending, 0) / totCount) * 100 + "%", background: "#E0A53A" }} />
            <i style={{ width: (totLost / totCount) * 100 + "%", background: "#C0584F" }} />
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 12 }}>
            {[["#228B22", "Won", totWon], ["#E0A53A", "Pending", days.reduce((s, d) => s + d.pending, 0)], ["#C0584F", "Lost", totLost]].map(([c, l, n], i) => (
              <span key={i} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--dim)" }}>
                <i style={{ width: 11, height: 11, borderRadius: 3, background: c, display: "inline-block" }} /><b style={{ color: "var(--ink)" }}>{n}</b> {l}
              </span>
            ))}
          </div>
        </>) : <div style={{ fontSize: 13, color: "var(--faint)", marginTop: 8 }}>Send a quote to see this.</div>}
      </div>

      {/* daily detail list */}
      <span className="eyebrow anim-in st4" style={{ display: "block", marginBottom: 10 }}>Day by day</span>
      {[...days].reverse().map((d, i) => (
        <div key={i} className="card anim-in" style={{ animationDelay: (i * .04 + .2) + "s", padding: "13px 16px", marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center", opacity: d.count ? 1 : .55 }}>
          <div><div style={{ fontWeight: 600, fontSize: 14.5 }}>{d.label} <span style={{ color: "var(--faint)", fontWeight: 400, fontSize: 12.5 }}>{d.date}</span></div>
            <div style={{ fontSize: 12.5, color: "var(--dim)", marginTop: 1 }}>{d.count ? `${d.count} quote${d.count === 1 ? "" : "s"}` : "No quotes"}{d.won ? ` · ${d.won} won` : ""}</div></div>
          <div className="mono" style={{ fontWeight: 600, fontSize: 15, color: d.value ? "var(--grn-d)" : "var(--faint)" }}>{d.value ? inr(d.value) : "-"}</div>
        </div>
      ))}
      <button className="btn btn-soft press" style={{ width: "100%", marginTop: 10 }} onClick={() => goQuotes("all")}>See all quotes</button>
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
        <a className="press" href={"https://wa.me/" + waNum + "?text=" + encodeURIComponent("Hi, I need help with QuoteKaro")} target="_blank" rel="noreferrer"
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
      <div style={{ fontSize: 11.5, color: "var(--faint)", textAlign: "center", margin: "18px 0 6px" }} className="mono">QUOTEKARO · PROTOTYPE V4</div>
    </div></div>
  );
}

/* ================= SETUP ================= */
function Setup({ data, setData, ping, account, goSubscribe, onLogout }) {
  const [calcOpen, setCalcOpen] = useState(false);
  const [matPick, setMatPick] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const s = data.settings;
  const setS = (k, v) => setData({ ...data, settings: { ...s, [k]: v } });

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
                  {account?.method === "phone" ? account.phone : account?.username || "Signed in"}
                </div>
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

      {/* ===== Marketplace (concept / demo) ===== */}
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

      {/* data */}
      <div className="anim-in st6" style={{ margin: "26px 0 10px" }}><span className="eyebrow">Data</span></div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 8 }}>
        <button className="btn btn-ghost btn-sm press" onClick={() => { setData(seedData()); ping("Sample data loaded"); }}>Load sample</button>
        <button className="btn btn-ghost btn-sm press" style={{ color: "var(--red)" }} onClick={() => {
          if (!confirmClear) { setConfirmClear(true); setTimeout(() => setConfirmClear(false), 2500); return; }
          const d = seedData(); d.quotes = []; d.machines = []; d.shopName = "My Shop"; setData(d); setConfirmClear(false); ping("Cleared");
        }}>{confirmClear ? "Tap again to confirm" : "Clear everything"}</button>
      </div>
      <button className="btn btn-ghost btn-sm press" style={{ width: "100%", marginTop: 14, color: "var(--dim)" }} onClick={onLogout}><I.logout /> Log out</button>
      <div style={{ fontSize: 11.5, color: "var(--faint)", textAlign: "center", paddingBottom: 6, marginTop: 14 }} className="mono">QUOTEKARO · PROTOTYPE V5</div>
    </div></div>
  );
}
