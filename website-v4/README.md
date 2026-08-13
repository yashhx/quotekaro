# TrackRakho — marketing site v4 (design study)

**Not deployed.** Netlify publishes `dist/` (which only picks up `public/`), so
nothing in this folder can reach trackrakho.com. It exists to be judged side by
side with the current site before anything is swapped.

## Run it

    node <scratchpad>/serve-site.mjs      # or any static server rooted here
    open http://localhost:4173

There is no build step: five HTML files, one CSS file, one 45-line JS file.

## Structure — separate pages, not one long scroll

| Page | Job |
|---|---|
| `index.html` | The problem, the answer, the two trades, the Tally trust story |
| `machining.html` | Job shops: pipeline, costing, machine floor, receivables + MSMED interest |
| `scrap.html` | Yards: stock and kanta variance, fleet, receivables, dispatch planner |
| `platform.html` | Everything included — connector, WhatsApp, AI reading, exports, trust |
| `pricing.html` | One plan, what ₹999 sits next to, the real objections |

The header dropdown ("For your trade") switches between the two trade pages.

## Design decisions

- **Light, editorial, industrial.** White paper, forest green — the product's own
  tokens, so site and app read as one company.
- **Signature motif: the measurement rule.** Both trades live on measurement
  (microns and metric tonnes), so a machined steel-rule tick strip recurs as the
  divider and under stats. It is drawn in CSS, not an image.
- **Product shots are flat, straight-on HTML** — no tilted phones, no glow, no
  stock photography, no people, no metaphor objects.
- **Every mock is captioned** ("What you are seeing: ...") so nothing is
  mistaken for a claim.

## Content accuracy

Every number is one the product actually produces: the Gland Nut costing
(51.00 + 54.90 + 12.33, +18%, +25% → ₹174.39 × 200 = ₹34,878), the VMC 850 at
₹366/hr, the 8% floor allowance stated on screen, the −1.8 MT kanta variance,
₹7,08,700 / ₹2,78,500. Deliberate omissions and disclosures:

- Never claims to predict cycle time — says so in a callout.
- MSMED interest appears **only** on the machining page. Traders are excluded
  from the delayed-payment provisions by law, so the scrap page makes no such
  claim anywhere.
- Photo similarity search is described as in development, because it is.
- Tally connector labelled beta and read-only.
