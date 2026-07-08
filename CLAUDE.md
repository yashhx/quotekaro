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

**Current direction (tracker-first) — SHIPPED (2026-07):**
- The FAB opens a chooser: "Log a quote" (quick, primary path) vs "New quotation" (the full costing wizard, now the second path). Quotes tab is labeled **Pipeline**.
- `QuickLog` component — customer, WhatsApp number, part, amount, qty, status, follow-up date, note; fillable in under 30s. Has a "Paste" box that runs `parseEnquiry()` to prefill fields from a pasted WhatsApp/enquiry message. Logged quotes carry `source:"logged"`.
- **`parseEnquiry()` (2026-07, v2)** — Hinglish-aware regex extraction of customer ("this is X"/"from X"/short first line), part name (labels like "Part:", "quotation for X", "N pcs of X", "X chahiye"/"chahiye X ka"), qty ("500 pcs"/"qty: 500"/"1000 quantity"), per-pc rate ("82/pc", "@110 each" -> pricePc), total (currency amounts, skipping rate-looking ones; falls back to rate*qty), phone, and a mentioned date -> followUp ("by 15/8", "20 july", "tomorrow"; year-less past dates roll forward). Used by BOTH the QuickLog paste box and one-tap "Log as quote" on WhatsApp enquiries. Unit-test it in node when changing (extract the function, feed sample messages) — no lookbehind regex (old-Safari parse crash).
- **Follow-ups:** quotes have a `followUp` timestamp. `followState(q)` returns overdue/today/upcoming for pending quotes. Home shows a "follow-ups due" card; Pipeline has a Follow-ups filter, per-card badges, an inline date editor, and a one-tap "Chase on WhatsApp" button (`waFollowText` + `waLink`, defaults bare 10-digit numbers to +91).
- **Analytics** (`Analytics` + `Donut` + `buildBuckets`): range toggle 7d/30d/all; KPI grid (quoted / sent / won value / pending value); win-rate donut; adaptive value-trend bars with won-portion overlay; money funnel (won/pending/lost); top-customers bars. Reached from the Home hero "7 days" tile.
- **Excel/CSV pipeline I/O** (SheetJS lazy-loaded from CDN, same pattern as jsPDF): export `.xlsx`/`.csv`, import `.xlsx`/`.xls`/`.csv`. `rowToQuote()` maps loose column names (synonyms, comma amounts, dd/mm/yyyy or Excel-serial dates, spaced phones). CSV export needs no library so data can always get out. UI: one labeled "Excel" button (Pipeline header) + a full-width button below the list, both opening a plain-language bottom sheet (`xlOpen`) with "Bring quotes IN" / "Take quotes OUT (.xlsx)" / CSV fallback — no bare icon buttons.
- **Schema is now `quotekaro:v5`.** Quote objects gained `phone`, `followUp`, `source` (and `note` on logged quotes). Bump the key again if you add fields.
- Target price being tested in the field: ₹1,000/month. Target user hypothesis: traders first, small shops second.

**Validated future feature - photo similarity search (2026-07-09, user's own field insight):** a photo enquiry arrives -> vendor searches their own delivered-order history by image ("have I made this sofa before?") -> top matches with old price/customer/date. Observed real pain: sofa vendors scrolling months of WhatsApp groups to find one photo. Plan: persist enquiry/order photos to Supabase Storage (PREREQUISITE - do this whenever media code is next touched; Meta media links expire in days), Claude captions + multimodal embeddings (Voyage) in pgvector, brute-force similarity is fine at shop scale. Bootstrap trick: WhatsApp chat export (.zip with media) import = instant catalog from their old group chats. Moat: data accrues -> switching cost grows. Build AFTER furniture/printing demos confirm demand - not before.

**Do NOT build unless explicitly asked:** supplier marketplace (a demo section labeled CONCEPT exists in Setup — keep it labeled), CAD file parsing/geometry costing, real payments/SMS, live Excel add-ins. Excel is real file import/export, not a live add-in.

## WhatsApp backend (two-way) — SHIPPED, opt-in (2026-07)
The app is STILL fully client-side by default and deploys as a static PWA. A serverless layer adds real two-way WhatsApp when configured; when the functions are absent (e.g. `dist/` drag-drop or Vite dev) the app degrades to exactly the old behaviour.
- **Netlify Functions** in `netlify/functions/`: `whatsapp-webhook.js` (Meta verify + inbound receive; captures text/image/document, button/interactive replies as text, other types as placeholder cards, reactions log-only; optional HMAC auth via `META_APP_SECRET`; logs every store/skip/failure), `enquiries.js` (app polls this; GET list, newest-100, 30-day retention sweep / POST `{id}` to mark handled), `whatsapp-send.js` (Cloud API send: text or template; logs Meta errors), `whatsapp-media.js` (proxies inbound image/document bytes; `&name=` sets download filename; 401 on expired token). All are **Functions v2** (`export default`, Request/Response) - v1 handlers don't get the Blobs context; don't convert back. Config in `netlify.toml`.
- **Storage:** Netlify Blobs (`@netlify/blobs`, store name `"enquiries"`). No external DB/account.
- **Provider:** Meta WhatsApp Cloud API direct. Swap a reseller (Interakt/Gupshup/WATI/Twilio) by editing only the `fetch()` in `whatsapp-send.js` + parsing in `whatsapp-webhook.js`.
- **Env vars** (Netlify, see `.env.example`): `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`. Full runbook in `WHATSAPP_SETUP.md`.
- **Frontend hooks** (in App.jsx, above the storage shim / in App component): `fetchEnquiries` / `markEnquiryHandled` / `sendWhatsApp` against `/.netlify/functions`; a 30s poll effect (declared above early returns — Rules of Hooks; skips while `document.hidden`; sets `waOn` once the backend answers; filters a `handledIds` ref so cards can't resurrect if server delete fails). Pipeline > "Incoming on WhatsApp" shows a connected dot + manual refresh + an empty "connected, waiting" state when `waOn`; images render via `WaImage` (onError fallback for expired token); one-tap `logEnquiry` (runs `parseEnquiry`, quote gets `source:"whatsapp"`). Backend-absent is detected by a non-JSON/failed response, so nothing breaks offline.
- **Deploy caveat:** functions can't be drag-dropped — needs git-connected Netlify or `netlify deploy`. Outbound to customers still primarily uses `wa.me` links (owner's own number); the send function is for automation/templates. Payments (Razorpay) and cloud auth/sync were offered but NOT built.

## Cloud accounts (Supabase, opt-in) - SHIPPED (2026-07)
Multi-tenant mode. ACTIVE only when `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` are set at build time (`sb` client in App.jsx is null otherwise -> app behaves exactly like the original on-device prototype, simulated auth included). Setup runbook: `SUPABASE_SETUP.md`; SQL: `supabase/schema.sql`.
- **Auth:** Google via Supabase OAuth (`signInWithOAuth`), session via `onAuthStateChange` (uid-compare guard avoids reload loops on token refresh). Account = `{method:"google", uid, email, name}`. Simulated OTP/username auth still exists for local mode - do not remove.
- **Data:** whole `quotekaro:v5` blob in `shop_data` (user_id PK, data jsonb) with RLS `auth.uid() = user_id`. Offline-first: per-uid localStorage cache (`quotekaro:v5:<uid>`, cleared on logout), cloud upsert debounced 600ms, `sync` state (synced/saving/offline) shown in Setup. First login adopts legacy on-device data then deletes it (second user on same device must not inherit). Last-write-wins across devices (v1 tradeoff). Demo plan lives in `data.planId` in cloud mode (`accountView` merges it for components).
- **Tenants/WhatsApp routing:** `tenants` table (user_id, wa_phone_id unique, is_admin; auto-row on signup via trigger; writes only via service role). Webhook stamps each enquiry with `phoneId` (`value.metadata.phone_number_id`). `enquiries.js` requires a Supabase JWT when configured and filters by `phoneId === tenants.wa_phone_id` (admin sees all incl. unrouted); mark-handled has an ownership check. `parse-enquiry`/`read-media`/`whatsapp-send` are login-gated too (spend protection). All functions verify JWTs via `GET {SUPABASE_URL}/auth/v1/user` (no crypto deps); frontend attaches tokens via `authHeaders()`.
- Env: `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` (build), `SUPABASE_URL`/`SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_KEY` (functions; service key is SECRET and bypasses RLS).
- **Auth gotchas paid for (2026-07-07):** Supabase dashboard shows keys display-truncated - copying visible text yields "sb_publishable_" (15 chars) and "Invalid API key" at code exchange; always use the copy button. `exchangeCodeForSession` takes the bare `?code=` value, NOT the full URL ("invalid flow state" otherwise). The app runs manual PKCE exchange (`detectSessionInUrl:false`) and shows OAuth errors in a red box on the login screen - keep that; silent auth loops are undebuggable on a customer's phone.
- **Onboarding model (interim):** admin assigns each customer's `wa_phone_id` via SQL (SUPABASE_SETUP.md step 5). Self-serve "connect your WhatsApp" = Meta Embedded Signup + coexistence (Tech Provider onboarding or BSP) - designed but NOT built.

## Smart reading agent (AI, opt-in) - SHIPPED (2026-07)
- `netlify/functions/parse-enquiry.js`: POST `{text}` -> `{ok, fields:{customer, part, qty, rate, total, followUp}}`. Anthropic SDK, model `claude-haiku-4-5` (override via `ANTHROPIC_MODEL`), structured outputs (`output_config.format` json_schema so the reply is guaranteed-valid JSON). 501 when `ANTHROPIC_API_KEY` unset. Hinglish-aware system prompt with IST "today" for relative dates.
- Frontend: `aiParseEnquiry()` (strips Indian mobile numbers BEFORE sending - privacy promise; backend-absent -> null) + `mergeParsed(rx, ai)` (AI wins, regex fills gaps, phone always local). Used by QuickLog paste ("AI reading..." button state) and `logEnquiry`. Gated by `settings.aiParse` - toggle in Setup ("Smart reading (AI)") with plain-language disclosure; DEFAULT OFF. Regex parser is always the fallback; nothing breaks without key/backend.
- **Photo/PDF reader** `netlify/functions/read-media.js`: POST `{mediaId, caption}` -> fetches the WhatsApp media server-side (needs live `WHATSAPP_TOKEN`; mediaId-only API so strangers can't feed it arbitrary images) -> Claude VISION with handwriting-aware prompt (Hindi/Hinglish lists, drawings, POs; "wrong price is worse than empty field") -> same fields + `transcript` (goes into the quote note as "AI read: ..."). Vision model: best-first LADDER (env `ANTHROPIC_VISION_MODEL` -> opus-4-8 -> sonnet-5 -> haiku-4-5) stepping down on "not available on your plan" errors - the user's plan lacks Opus, so Sonnet 5 does the reading (~Rs 0.5-1/photo, verified excellent on real handwriting). Frontend `aiReadMedia()` used by `logEnquiry` for image/document enquiries (caption redacted like text; images themselves can't be redacted - disclosed in the toggle). Latency budget: media fetch + 7s AI timeout inside Netlify's 10s cap; timeout -> regex fallback, tap again to retry.

## Tally connector (two-way, opt-in BETA) - SHIPPED (2026-07-08)
Won quotes flow INTO TallyPrime as Sales Orders; customer outstanding balances (Sundry Debtors) flow OUT to the app. Runbook: `TALLY_SETUP.md`. Extra SQL: `supabase/tally.sql` (adds `tenants.connector_key`, `tally_sync`, `tally_ledgers` - RLS select-own only, writes via service role).
- **Desktop connector** `connector/quotekaro-tally-connector.mjs` (Node 18+, ZERO deps, + `config.example.json` + `start-connector.bat`): runs on the Tally PC, talks to Tally's local XML gateway (port 9000, `F1 > Settings > Connectivity`, needs F11 sales-order processing ON). Auto-creates masters (party ledger under Sundry Debtors, sales ledger under Sales Accounts via `config.salesLedger`, stock item, unit Nos; "already exists" = success). Voucher carries REMOTEID (stable identity), ACCOUNTINGALLOCATIONS to the sales ledger (real TallyPrime requires it), party amount negative. Field-hardening paid for in review: fractional qty rounded (Nos has 0 decimals), quote dates before "books beginning" retried once dated today, results reported to the cloud PER QUOTE immediately (batch-at-end would duplicate vouchers on a crash), ledger export uses CHILDOF+BELONGSTO Yes (sub-group debtors), XML prolog UTF-8 (Hindi text), `--once`/`--dry-run` flags. NOT yet run against a real TallyPrime - do that before handing to a customer's accountant.
- **Functions**: `tally-key.js` (JWT-gated; issues/regenerates `tk_`+40hex into `tenants.connector_key`) and `tally-sync.js` (auth = `x-connector-key` header; GET feeds won quotes: total>0 only, never-tried before failed retries, max 25, excludes status done and errors with attempts>=5 = given up so doomed quotes cannot starve the feed; POST upserts results with attempts increment + wholesale-replaces `tally_ledgers`). Re-queue a given-up quote: delete its tally_sync row (SQL in tally.sql comments).
- **App**: Setup > "Tally (BETA)" card (cloud mode only) shows/copies/regenerates the connector key; App loads `tally_ledgers` once per login (the effect CLEARS tallyBal first on account change - cross-tenant leak guard) and Pipeline cards show an amber "Tally baki Rs X" chip when the quote's customer matches a ledger name (case-insensitive) with balance > 0.
- Testing pattern: mock Tally + mock cloud HTTP servers + connector `--once`, plus function smoke tests with mocked Supabase REST (13 passing as of ship). Re-create in a scratchpad when touching this code.

## Marketing site (2026-07, REBUILT as TrackRakho 2026-07-08)
- `public/site/index.html` - standalone landing page branded TRACKRAKHO (app itself still says QuoteKaro - rename pending), live at `/site/`. DARK premium theme (near-black green #070B08 base, luminous #7CE383 accents - the ONE surface allowed to leave the app's white-base rule, per user decision 2026-07-08) with professional ENGLISH copy; Hindi lives only in the chat bubbles + one tagline stamp (user hated full-Hinglish copy - do not reintroduce it). Centrepiece: #ktrack scroll-driven WhatsApp-chat story (5200px sticky track, 10 beats, 3D phone tilt + app cards on nearer planes, reduced-motion static fallback, no scroll hijack). Tool-by-tool problem-first sections, Rs 1,000/month pricing card, Hinglish FAQ. Verified on 1280 + 375 viewports. (Netlify serves the directory index; in Vite dev use `/site/index.html`). Self-contained: inline CSS/JS, same design tokens/fonts as the app, no build step.
- Parallax via `--plxY` CSS variable (composes with each element's own transform - do NOT set el.style.transform directly), mouse-tilt 3D phone mock, IntersectionObserver reveals (threshold [0,.14] so tall cards reveal on small phones), reduced-motion + hidden-tab rAF pause handled.
- Copy is fact-checked against this file: costing example must keep summing to Rs 174.39/pc (51.00 + 54.90 + 12.33, +18%, +25%); never claim machining-time prediction; two-way WhatsApp is labeled "once connected"; pricing note says payment is arranged on WhatsApp, no automated checkout.

## Conventions & gotchas (bugs we already paid for)
- **Rules of Hooks:** every hook must sit above any early `return` in a component. A hooks-after-loading-return bug already crashed this app once.
- **No smart punctuation in source:** em-dashes (—), curly quotes ("" '') inside string literals have broken the parser before. Use ASCII (-, ', ") in code and string content.
- All styling stays inside the `CSS` template literal or inline styles — no CSS files, no Tailwind.
- Every backtick template must close; run a build (`npm run build`) after sizeable edits to catch parse errors early.
- Small, specific changes over sweeping rewrites. This file is the product's memory — update it when decisions change.
