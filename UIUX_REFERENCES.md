# UI/UX reference apps to study (researched 2026-07-30)

Mapped to TrackRakho's surfaces. Every app here is cited for a SPECIFIC screen/pattern -
study that screen, not the whole app. Full research: workflow wf_6c1cbbb4-798 (4 lenses).
How to study: Mobbin.com (screenshot library of real app flows), App Store trials,
YouTube demo walkthroughs, and Jobber's PUBLIC design system at atlantis.getjobber.com.

## The must-study five (if time for nothing else)
1. **Jobber** (field service, Canada) - the quote -> job -> invoice object chain. Study the
   "Approve and Schedule" moment: marking won immediately offers the next step in the same
   sheet. Our "Floor pe bhejo" is this moment. Their design system (Atlantis) is public and
   built for exactly our demographic (non-technical trade owners).
2. **Pipedrive** (CRM, Estonia) - the canonical pipeline. Steal: the ROTTING-DEAL badge
   (deal untouched N days = visible red flag) and the schedule-next-activity prompt after
   every completed action. Rule to adopt: NO pending quote without a next follow-up date.
3. **Khatabook** (India) - the red/green two-number ledger + one-tap WhatsApp reminder.
   The mental model our Tally page must open with: aane wale (green) / dene wale (red),
   everything else behind a tap. Radical simplicity for the low-tech owner.
4. **QuickBooks mobile "Money Bar"** - segmented aging bar where EVERY segment is tappable
   and filters the bill list below. We built the bar; steal the tap-to-filter completeness
   and "45 din late" relative labels everywhere (never absolute dates alone).
5. **MachineMetrics** (US, machine monitoring) - the machine-tile grid: one tile per
   machine, color by status, time-in-status displayed. The template for our floor board's
   visual language (we compute from clock math, they use sensors - visual grammar same).

## By TrackRakho surface

### Pipeline (quotes pending/won/lost)
- **Pipedrive**: stage columns w/ Rs total + count in header; rotting indicator; mobile
  deal card redesign case study at rondesignlab.com.
- **Jobber**: client-facing quote approval page (view-tracked, one-tap approve, deposit);
  quote auto-converts to job.
- **ServiceM8** (AU, solo tradies): the JOB DIARY - every photo/note/message auto-files
  into one chronological thread per job. Our quote card note + photo is the seed of this.
  Also: automated quote follow-up sequences (5 nudges, stops on reply).
- **Tradify**: speed benchmark - full quote in 47 seconds; duplicate-past-quote for repeat
  parts (our repeat Gland Nut case).
- **Housecall Pro**: every status change asks ONE follow-on question (lost -> reason,
  won -> schedule). Guided dialogs, never dead-end status flips.
- **Attio** (craft details): 3px status edge-bar on cards, tabular numerals for all money,
  one color = one meaning.
- **HoneyBook**: single customer thread - one page per party showing all quotes/baki/last
  chase with one Chase button (our per-customer view when we build it).

### Home + money (Tally page, analytics)
- **Shopify mobile admin Home**: the best SMB "business at a glance" - 4-KPI strip,
  action-grouped counts ("3 orders to fulfill" = our "3 follow-ups due"), auto-insight
  cards that expire in 24h. Square Dashboard = the 5-second-glance standard (owners open
  ~12x/day); its cautionary tale: they added Home complexity and users revolted.
- **QuickBooks Money Bar** (above) + per-bill event timeline (invoice sent -> viewed ->
  paid) = our bill drill-down's future.
- **Upflow** (AR tool, designer-praised): per-bill chase history ("last reminder 4 days
  ago"), aging TREND over months, advances shown separately so totals reconcile - we
  already do the reconcile line; steal chase-state-per-bill.
- **Chaser**: escalating reminder ladder (polite -> firm), 2-3 steps - map to Hinglish
  WhatsApp chase templates.
- **Xero "Invoices owed to you" tile**: Home Tally card should become a live micro-tile:
  total + mini aging bar + oldest bill, chase action right on the tile.
- **Wave**: plain-language twin panels "owed to you / you owe" grouped by overdue days -
  validation of our aane/dene framing.
- **Agicap/Float**: forward-looking "expected in next 30 days" strip - computable TODAY
  from tally_bills due dates.
- **Stripe mobile**: daily-summary push notification as the retention loop (our future
  "aaj ka hisaab" WhatsApp/notification digest).

### Machine floor + truck board
- **MachineMetrics** (above): tile grid, color-by-threshold, time-in-status.
- **Fulcrum Pro** (modern job-shop ERP): operator job queue - dominant play/pause button,
  live actual-vs-estimated time per job. Our pause/transfer maps directly.
- **Katana MRP**: drag-to-reprioritize order list with traffic-light "startable?" row
  state; visual production board (design case study at rondesignlab.com).
- **Onfleet** (dispatch, praised): status-colored task grammar, one-big-verb driver cards
  ("Deliver" button) - our truck board's Deliver button validated.
- **Motive/Samsara**: driver-app ergonomics - big buttons, step-by-step stop workflow,
  proof-of-delivery photo (our trip + kanta photo future). Samsara home = widget grid
  where every KPI tile is a door.
- **Tulip / Prodsmart**: operator UIs - ONE instruction + ONE input per screen; repeat-
  last-job prefill; number-pad qty entry. For the floor job form.
- **ProShop ERP**: hyperlink-everything - every record links to related records
  (quote <-> floor job <-> bill <-> trip). Our object chain should feel like this.
- **Fleetio Go**: checklist inspection cards (big pass/fail + photo) - template for
  kanta-check flow.
- **Porter** (India): vernacular-first driver UX, voice input, video training - the
  India-specific low-tech playbook for anything driver/operator-facing.

### Bharat-first design foundations
- **Khatabook** (above) + **OkCredit**: binary full-width colored action buttons ("Maine
  diye / Maine liye") - status changes as two big colored buttons, not dropdowns. They
  field-tested exact vernacular microcopy per language.
- **Zerodha Kite**: the "3S" philosophy (speed, simplicity, sleekness) + public refusal
  to add clutter. Watchlist-as-home with in-row actions = our Pipeline list ideal.
- **Google Pay India (Tez)**: people-first home (faces, not features), per-contact
  transaction THREAD (our per-customer timeline), big verbose success states that build
  trust for low-confidence users.
- **Google Next Billion Users guidelines** (design.google) + Indrani Medhi's text-free UI
  research: graphical UI beat text UI 100% vs 0% for low-literacy users; minimize typing
  (voice/paste/choices); offline-first with VISIBLE sync state.
- **Meesho/ShareChat**: dense visual content in calm chrome; polished Devanagari type;
  sample-filled empty states; ethnography method - test in the shop, not the office.
- **PhonePe**: "relentless simplification" + alert-center pattern -> an "aaj ka kaam"
  tile aggregating follow-ups due + jobs finishing + bills crossing 60 din.
- **CRED**: the ANTI-pattern for this audience (dark, motion-heavy, English luxury) -
  except one lesson: a single crafted moment of delight when a quote turns WON.

## Patterns already validated by this research (we do them)
Aane/dene twin tiles (Khatabook/Wave), aging bar (QuickBooks), bill drill-down w/
reconcile (Upflow), Deliver button (Onfleet), WhatsApp chase (Vyapar/Khatabook),
collapsed planner (Square's Home-simplicity lesson).

## Top gaps this research exposes (future work, in priority order)
1. Rotting-quote badge + "no follow-up date" warning state (Pipedrive)
2. Won-moment flow: status change immediately offers next object (Jobber)
3. Per-customer thread page: all quotes + bills + dispatches + one Chase button
   (HoneyBook/GPay)
4. Chase-state per bill: "last chased 4 din pehle" (Upflow/Chaser)
5. Aging-bar segments tap-to-filter the bill list (QuickBooks)
6. "Expected in next 30 days" strip from bill due dates (Agicap)
7. One crafted WON moment (CRED lesson, used once)
