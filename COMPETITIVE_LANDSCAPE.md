# TrackRakho — Competitive Landscape (researched 2026-07-17)

Why this document exists: the founder saw "Industry 4.0" software and asked whether the
problem is already solved. Short answer: **the problem is solved for organized, larger
businesses at 10-100x TrackRakho's price — and unsolved for the micro/small shop that
still runs on a register, Excel and WhatsApp.** Competitors validate the market; the gap
they leave is the business. This file maps who does what, at what price, for whom — and
where TrackRakho wins or should not fight. Update it whenever a new competitor appears.

---

## 1. Machine monitoring / "Industry 4.0" (the scare that triggered this doc)

| Product | What it is | Price | Target |
|---|---|---|---|
| [LEANworx](https://leanworx.ai/) (Bangalore) | Auto CNC monitoring via controller/hardware, OEE, downtime | ~$36 (~Rs 3,000)/machine/month + plug hardware | 3-10+ machine shops with modern-ish CNCs |
| [ShopWorx / Entrib](https://shopworx.io/) (Pune) | Full MES, production tracking | Enterprise quotes | Organized plants (automotive, plastics) |
| [Fogwing SFactrix](https://www.fogwing.io/machine-monitoring/) | IoT MES, free entry tier then subscription | Freemium -> quotes | Small factories going digital |
| Global norm ([survey](https://www.globalreader.eu/blog/best-cnc-machine-monitoring-software-oee)) | Machine monitoring generally | $500-2,500/machine hardware + $50-300/machine/month | 20+ machine plants |

**The gap we live in:** these read data FROM the machine controller. A Faridabad job shop
runs 1998 Fanuc lathes, Traubs and manual machines with zero connectivity — retrofit
costs more than years of TrackRakho. Their buyer is a production manager; ours is an
owner-operator. Their floor module alone costs Rs 15,000+/month for 5 machines; our whole
app is Rs 999. **Do NOT compete on automatic data capture. Ever.** Our floor board is a
30-second manual habit that gives remote eyes. If a customer outgrows it, integrating
LEANworx data INTO TrackRakho beats building sensors.

## 2. SME manufacturing ERP (India)

| Product | What it is | Price | Notes |
|---|---|---|---|
| [TranZact](https://letstranzact.com/pricing) (Mumbai) | "Factory OS": sales, purchase, inventory, production; Tally+Excel+WhatsApp positioning | **Free-forever tier**, paid above | 10,000+ brands claimed. **Closest philosophical competitor for machining.** Sales-led, heavier onboarding, desktop-first. |
| [JobBOSS2 / E2](https://vendorbenchmark.com/vendors/jobboss2-pricing) (US) | Job-shop ERP | $85-200/user/month + ~$5k implementation | Western prices, English, irrelevant to micro shops |
| ProShop (US) | Paperless machine-shop ERP | Enterprise quotes | Same |

**Threat level: TranZact's free tier is real.** Their weakness: ERP complexity, weeks of
onboarding, desktop orientation, English UI, and they don't do the daily-pain layer
(follow-up chasing, WhatsApp inbox, machine floor as habit). We win on: phone-first,
Hinglish/Hindi, 30-second setup, one price, and being a TRACKER not an ERP.

## 3. Billing / quotation apps (the mass-market generics)

| Product | Price | Notes |
|---|---|---|
| [Vyapar](https://vyaparapp.in/) | Freemium, ~Rs 3-4k/yr | GST billing + estimates. Massive install base. Desktop/Android. **Not a tracker** - no pipeline, no follow-up discipline, no floor/trucks/Tally-insights. |
| [myBillBook](https://mybillbook.in/s/mybillbook-vs-vyapaarapp/) | Rs 33/mo basic; Rs 2,599/yr full | Cloud, multi-device, payroll etc. Same story: billing-first, not tracking-first. |

**The lesson, not a threat:** these prove Indian SMBs pay Rs 2-10k/year for utility apps
at scale. They own "make the invoice"; nobody owns "did the quote become an order?" —
that's our wedge and our demo line.

## 4. WhatsApp CRMs / lead trackers

| Product | Price | Notes |
|---|---|---|
| [Interakt](https://www.interakt.shop/pricing-us/) | Rs 999/mo+ | WhatsApp API + lightweight CRM, D2C/e-commerce flavored |
| [Privyr](https://www.privyr.com/intro/whatsapp-crm/) | Free/$15+/mo | Mobile lead follow-up for salespeople - generic leads, not trade-shaped |
| WATI etc | $49/mo+ | Same category |

**Overlap is the follow-up muscle only.** None of them speak manufacturing (qty, rate/pc,
MT, cycle time), none do costing/floor/trucks/Tally. But note: our Rs 999 price point is
literally Interakt's entry price - the market accepts it.

## 5. Vertical: furniture / interiors — **the real watchlist item**

| Product | Price | Notes |
|---|---|---|
| [FurniQuote](https://furniquote.in/) | Low subscription | **6,000+ carpenters claimed.** Furniture quotes as PDF in 2 min, WhatsApp send, payment reminders. Direct overlap with our furniture QuickLog+PDF story. |
| [Dzylo](https://dzylo.ai/) | Subscription | Interior-designer CRM: leads, quotes, projects, inventory. Aims up-market (designers/architects). |
| [Woodwize](https://woodwize.in/) | From Rs 2,000/mo | 3D drawings + cutlists + quotes for furniture manufacturers |

**Assessment:** FurniQuote validates furniture-vertical willingness to pay, and beats us
on furniture-specific quoting today. Our differentiators there: pipeline/follow-up
discipline, photo-first pipeline, and (when built) **AI photo search over delivered
orders** — nobody in this list has it. If furniture becomes our lead segment, study
FurniQuote's app teardown first.

## 6. Vertical: scrap / recycling + fleet

| Product | Price | Notes |
|---|---|---|
| [cieTrade](https://www.cietrade.com/scrap-metal-recycling-software/), [ScrapIT](https://www.scrapitsoftware.com/), ScrapRight | US enterprise | Scale-house/yard ERP for organized recyclers. Wrong country, wrong size. |
| [Petals Infotech](https://petalsinfotech.in/metal-recycling-management-system.html) | India, quotes | Scrap ERP for organized yards |
| [LocoNav](https://loconav.com/) etc | GPS hardware + subscription | Real fleet GPS. Complements rather than competes with our manual truck board; integration idea for later. |

**Assessment:** nobody serves the Hindi-speaking scrap trader with Tally + trucks + dues
in one phone app. This is our most open lane. GPS trackers are the "upgrade path"
question, same answer as machine monitoring: integrate later, never build hardware.

## 7. Printing vertical

| Product | Notes |
|---|---|
| [PrintPLANR](https://www.printplanr.com/) | Full Print MIS (estimating, CRM, web2print) - modular SaaS, aimed at organized print companies, priced per module |
| OnPrintShop, InkSoft etc | Web-to-print storefronts, not counter-shop trackers |

**Assessment:** Print MIS = organized printers with production workflows. The counter
shop doing 20 mixed jobs/day on WhatsApp has nothing. Our printing demo set already
speaks their day better than any MIS demo.

---

## Positioning summary (the sentence to remember)

> Everyone above sells to businesses that already have systems. TrackRakho sells the
> FIRST system to businesses that run on a register, Excel and WhatsApp — at the price
> of a Netflix subscription, in their language, on their phone, across the four trades
> nobody bundles: quotes + follow-ups + Tally + machines/trucks.

**Real threats to watch (re-check quarterly):**
1. **TranZact free tier** moving down-market with a simpler mobile app (machining).
2. **FurniQuote** expanding from quotes into tracking (furniture).
3. **Vyapar/myBillBook** adding a pipeline/follow-up module (all trades) - their distribution is enormous.

**Standing rules derived from this research:**
- Never build hardware or automatic machine/GPS data capture; integrate instead.
- Every new feature ships with a competitive paragraph in this file.
- Our moats to deepen: Hinglish/Hindi UX, WhatsApp-native flows, Tally connector,
  per-trade shaping, and (later) the photo-history data moat.
