# QuoteKaro — project context for Claude Code

Read this fully before making changes. It carries the context of six weeks of product work and field validation.

## What this is
A single-file React prototype of a SaaS for small Indian CNC job-shops (Delhi NCR).
Built by Yash — solo, bootstrapped, Faridabad. Everything lives in `src/App.jsx`.
It began as a **quotation maker**; field visits are pushing it toward a **quote TRACKER** (pipeline-first). See "Strategic context" — it decides what's worth building.

## Commands
- `npm install` — setup
- `npm run dev` — local dev server (Vite)
- `npm run build` — production build to `dist/`
- Deploy = drag `dist/` folder onto Netlify. PWA installable via Add to Home Screen.

## Architecture
- **One file:** `src/App.jsx` (~1,400 lines). All components, all CSS (in the `const CSS` template literal), all icons (inline SVGs in `const I`). Keep it single-file unless explicitly asked to refactor.
- **Storage:** localStorage via a small async `storage` shim at the top of App.jsx (`get/set/delete`). Keys: `quotekaro:v4` (shop data), `quotekaro:auth:v1` (account). If you change a schema, bump the key version to avoid stale-data crashes.
- **Auth is SIMULATED.** Any phone + any 4-digit OTP works; any username/password works. This is deliberate (no backend yet). Real Firebase/Razorpay hooks are marked with `/* HOOK */` comments. Do NOT wire real auth/payments unless explicitly asked.
- **PDF quotations:** jsPDF loaded from CDN at runtime. PDFs use "Rs " not "₹" (glyph missing in core PDF fonts) — keep it that way.
- **PWA:** `public/manifest.json`, `public/sw.js`, `icon-192/512.png`.
- **Subscription page** exists (Starter ₹2,500 / Growth ₹6,000 / Pro ₹12,000) — simulated, demo-labeled.

## Design system — do not drift
- White base + forest green. Tokens in CSS: `--grn #228B22`, `--grn-d #155E18`, `--grn-x #3FAE45`, ink `#16201A`.
- Fonts: Space Grotesk (display), Inter (body), IBM Plex Mono (numbers/micro-labels).
- Cards ~22px radius, pill buttons, green gradient hero cards, liquid-glass bottom nav (very transparent, blur) with a measured sliding pill highlight (it measures the active button — don't replace with hardcoded percentages).
- **Readability first:** users are older shop owners. Body text 15–17px minimum, big numbers, generous tap targets.
- Plain-language hints appear ONLY under: raw weight/piece, cycle time/piece, manual time/piece. Other fields stay clean.
- Copy is Hinglish-friendly. Help tab has Hindi audio FAQs via browser SpeechSynthesis — preserve.
- Support WhatsApp (real): `919910605207`.

## Domain logic (costing) — the math is settled, don't reinvent
- Quote per piece = material (kg × ₹/kg) + machine (cycleMin/60 × machine ₹/hr, + setupMin/60 × rate ÷ qty) + labour (manualMin/60 × labour rate) + tooling → + overhead% → + margin% → price/pc; total = price × qty (+ GST display).
- True hourly-rate calculator = depreciation + power (kW × ₹/unit) + operator + maintenance, all per monthly working hours. Seeded example: VMC 850 ≈ ₹366/hr.
- **Multi-machine rule (from a real shop visit):** when one operator runs N machines, his salary is split — `operator cost ÷ N` folds into the MACHINE hourly rate ("loaded rate"); manual/hands-on minutes stay at FULL labour rate (he's dedicated then). A "machines per operator" field in the rate calculator is a known TODO.
- The app does **not** predict cycle time. The user supplies it; the app does the money math. Never write UI copy claiming it calculates machining time.
- Keep seeded sample data consistent: Sharma Precision Works; Gland Nut — 60mm, 200 pcs, ₹174.39/pc, ₹34,878 total.

## Strategic context — read before building ANY feature
Three real shop visits taught us:
1. Shops already quote fine in **Excel**, and their clients often DEMAND the Excel format. A quoting-first app is weak against that.
2. What owners actually liked, unprompted: the **pipeline view** — all quotes with pending/won/lost status.
3. A micro-shop owner suggested the tool may fit **traders** (middlemen) better than shops.

**Current direction (pivot in progress):** tracker-first.
- Pipeline (pending/won/lost, follow-ups) becomes the HOME screen.
- The 4-step quote wizard gets demoted to one of two entry paths.
- Add a "+ Log a quote" quick form — customer, part, amount, status — fillable in under 30 seconds (for quotes made elsewhere, e.g. Excel).
- Target price being tested in the field: ₹1,000/month. Target user hypothesis: traders first, small shops second.

**Do NOT build unless explicitly asked:** supplier marketplace (a demo section labeled CONCEPT exists in Setup — keep it labeled), CAD file parsing/geometry costing, real backend/payments/SMS, live Excel add-ins. (Excel FILE import — reading an .xlsx to log a quote — is a plausible later feature.)

## Conventions & gotchas (bugs we already paid for)
- **Rules of Hooks:** every hook must sit above any early `return` in a component. A hooks-after-loading-return bug already crashed this app once.
- **No smart punctuation in source:** em-dashes (—), curly quotes ("" '') inside string literals have broken the parser before. Use ASCII (-, ', ") in code and string content.
- All styling stays inside the `CSS` template literal or inline styles — no CSS files, no Tailwind.
- Every backtick template must close; run a build (`npm run build`) after sizeable edits to catch parse errors early.
- Small, specific changes over sweeping rewrites. This file is the product's memory — update it when decisions change.
