# MSMED delayed-payment leverage - research + feature plan (2026-08-09)

Trigger: MSMED (Amendment) Bill 2026 passed Lok Sabha 7-Aug / Rajya Sabha 3-Aug-2026.
Researched via 4-angle workflow (wf_9e736aa3); three agents converged on every
load-bearing claim with official sources. This doc is the product's memory of it.

## THE VERDICT

The delayed-payment leverage stack applies to MANUFACTURERS and service providers
only. It is a gift to the MACHINING segment and does NOT cover scrap TRADERS.
Build the features machining-first, gate them on Udyam + activity type, and never
put "MSME interest on your stuck money" in front of a trader - it would be false.

## Segment eligibility (the decision-critical fact)

- Micro + SMALL manufacturers/service providers = full protection (s.2(n) "supplier").
  Medium enterprises are NOT covered by s.15/16.
- TRADERS (NIC 45/46/47): Udyam registration allowed since July 2021 O.M.
  (5/2(2)/2021-E/P&G/Policy) "for Priority Sector Lending only". Samadhaan/ODR FAQ
  excludes trading units; facilitation councils have rejected trader claims; buyers
  of traders face no 43B(h) disallowance. The 2026 amendment did NOT change this.
- OPEN QUESTION (worth a CA opinion, not marketing): a scrap dealer who PROCESSES
  (sorting/cutting/baling) might register under NIC 38 "materials recovery" instead
  of trading - which would flip him into the protected class. Scattered MSEFC
  litigation exists where trader claims were entertained; do not build on it.
- Udyam must PREDATE the disputed invoice (Silpi Industries v. Kerala SRTC, SC 2021).
  Product hook: "Udyam aaj karo (free, 10 min) - aaj ke baad ka har invoice protected."

## The legal mechanics (all verified, Aug 2026)

- s.15: payment due within written agreed period, CAP 45 days from acceptance.
  NO WRITTEN AGREEMENT = 15 days ("appointed day"). Deemed acceptance: no written
  objection within 15 days of delivery. Demo bombshell: verbal/WhatsApp orders
  (most job shops) mean money is legally overdue on DAY 16.
- s.16: compound interest, MONTHLY rests, at 3x RBI Bank Rate, overriding any
  contract clause (void to that extent). Partial payments hit interest FIRST.
  Accrues AUTOMATICALLY by statute - no filing needed for the liability to exist.
- Rate NOW (Bank Rate 5.50%, Feb-2026 policy): 16.5% p.a. nominal = 1.375%/month
  = 17.81% effective. Formula: interest = P x ((1 + 0.165/12)^m - 1).
  Anchors: Rs 1L x 6mo ~ Rs 8,540; Rs 50k x 3mo ~ Rs 2,090; Rs 5L x 12mo ~ Rs 89,040.
  HISTORIC arrears use the rate notified per period (Bank Rate 6.75% Feb-23 to
  early-25 = 20.25%; then 6.50/6.25/5.75 -> 5.50). Any in-app calculator must
  compute month-wise with the period rates, never one flat rate.
- s.23: the interest is PERMANENTLY non-deductible for the buyer (Form 3CD cl.22;
  ~22-24% pre-tax equivalent cost at 25-30% tax).
- 43B(h) (Finance Act 2023): buyer's PRINCIPAL expense disallowed until actually
  paid when beyond the s.15 window; continues as s.37(2)(g) of the Income-tax Act
  2025 from 1-Apr-2026. Timing disallowance, distinct from s.23's permanent one.
- s.22: audited buyers must disclose unpaid MSE principal + interest in annual
  accounts EVERY year until paid; companies also Schedule III line items +
  half-yearly MSME Form-1 to MCA. The default is visible to the buyer's auditor.
- Appeal: 75% pre-deposit mandatory (s.19, Tirupati Steels). NEW 2026: if the
  challenge pends 6+ months, court MUST release at least 50% of deposit to supplier.
- NEW 2026 (s.18A): settlements/awards recoverable as ARREARS OF LAND REVENUE via
  District Collector; award = enforceable debt under IBC. The teeth Samadhaan lacked.
- NEW 2026 timelines: mediation 90 days from first appearance -> arbitration
  referral within 30 days -> award within 90 days of pleadings. ~7-month bounded
  process vs the old rot (since 2017: 2.57L applications, only ~24% ever disposed,
  ~32% rejected, ~17% never opened; <1% of eligible MSEs ever filed).

## Filing process (as of Oct 2025 - IMPORTANT)

- Samadhaan portal CLOSED for new filings 15-Oct-2025. New cases go to the
  MSME ODR portal: odr.msme.gov.in (two tiers: voluntary online mediation ->
  statutory MSEFC). Any feature/copy must say ODR portal, NOT Samadhaan.
- Filing is FREE. Requirements: Udyam number predating the invoice, OTP to the
  Udyam-REGISTERED mobile/email (stale mobile blocks filing - nudge users to
  update), work orders (max 3 PDFs, 1 MB each; affidavit if PO was oral),
  invoices (max 3 uploads, mergeable), acceptance proof (delivery challan,
  part-payment, email - all accepted). Practitioner extras: ledger, e-way bill,
  bank statement, interest computation.
- Competitive gap: NO receivables SaaS (CredFlow, Recordent) offers filing help.
  Space is manual legal consultancies (msmeodr.com, LegalBabu, LSO Legal) and
  private ODR platforms (Presolv360). Same empty-category pattern as scrap SaaS.

## Feature plan (build order)

1. KANOONI BYAJ COUNTER (small build, all data exists): machining-only + a
   "Udyam registered?" toggle in Setup (settings.udyam, default off, with the
   register-today nudge). On the Tally aging bar + bills drill + Pipeline 60+
   cards: "MSMED byaj banta: Rs X (indicative)". Month-wise computation with
   period rate table (hardcode the notified Bank Rate history; update on RBI
   changes). Disclosure line: indicative, manufacturer/service-provider only,
   Udyam-before-invoice required.
2. CHASE ESCALATION RUNG: opt-in firmer WhatsApp template in waFollowText -
   cites 45-day cap (15 without written agreement) + byaj amount + the buyer
   pain stack. Killer line: "Aapke CA se poochh lena - MSMED byaj tax mein
   deduct nahi hota aur har saal balance sheet mein dikhana padta hai."
3. ODR CASE PACK: per-party export - merged invoice PDF sized to 1 MB portal
   limits + ledger from tally_bills + month-wise interest computation + doc
   checklist (challan/e-way bill reminders). "Case karna hai ya sirf darana
   hai - hisaab ready hai."
4. MARKETING (machining site + demos): news-pegged. "Parliament ne kanoon badla
   - ab payment atkana buyer ko mehenga padega." Numbers: Rs 8.73 lakh crore
   stuck nationally; 16.5% compound; day-16 rule for verbal orders; Collector
   recovery. Scrap-trader marketing stays on ghata/trucks/Tally - NO legal claims.

## Do NOT build

- TReDS integration: 5 platforms (RXIL, M1xchange, Invoicemart, C2treds, DTX),
  seller-side free, but only ~3,400 buyers on the largest platform - works only
  when the user's specific customer is a CPSE (settlement now mandated via
  30-Jun-2026 notification) or a >Rs 250 cr corporate that actively transacts.
  Talking point in demos, not a feature.
- Legal-service marketplace / filing-as-a-service: partner with a consultancy
  later if users ask; the pack (feature 3) is the wedge.

## Scale context (Udyam dashboard, fetched 2026-08-09)

9.24 cr total registrations (5.21 cr Udyam + 4.03 cr informal UAP micros);
99.4% micro; activity split: trading 3.89 cr > services 3.51 cr > manufacturing
1.84 cr. Traders outnumber manufacturers 2:1 (supports trader-first for the
CORE app) - but ~44% of the headline is subsistence-scale UAP, not software buyers.
Micro limits since 1-Apr-2025: Rs 2.5 cr investment / Rs 10 cr turnover - every
TrackRakho-profile user fits in "micro".
