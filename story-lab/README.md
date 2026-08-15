# Story lab — scroll-told pages (prototype, not deployed)

Lives outside `public/`, so Netlify cannot publish it. Open the file directly
in a browser — there is no build step and no server needed.

    open "story-lab/machining.html"

## machining.html — "One part. Start to paid."

An answer to: can a TrackRakho page feel like a story instead of a brochure?

The device is the one the Pear site uses — **a single object carries the whole
film**. Here it is a Gland Nut 60 mm: drawn as a technical drawing in the
opening frame, cut on the machine in act three, sitting inside the overdue bill
in act four, ringed as paid in act five.

Acts (each is a tall section with a sticky stage):

| Act | Beat |
|---|---|
| 0 | The part draws itself on. "One part. Start to paid." |
| 1 | 11:42 pm — the WhatsApp enquiry becomes a tracked quotation |
| 2 | The rate — costing stacks up and totals as you scroll |
| 3 | The floor — spindle turns, 0 → 200 pieces, ETA counts down |
| 4 | The wait — days tick to 88, the bar reddens, interest starts at day 46 |
| 5 | Paid — one polite reminder, ₹34,878 received |
| 6 | Close — CTA |

## How it works

One `requestAnimationFrame` loop writes each act's 0–1 scroll progress into a
CSS custom property (`--p`) plus a handful of JS-driven numbers. Everything
animated is transform/opacity only. SVG line art draws itself on via
`pathLength="1"` and a `stroke-dashoffset` bound to progress.

`prefers-reduced-motion` unpins every act and shows all end states — the page
becomes an ordinary document.

**Reviewing a single frame:** `machining.html?act=4&p=0.7` freezes one act at one
scroll position. Inert without the query string.

## Tokens

Identical to the live site (`public/site/index.html`) — `#070B08` base,
`#7CE383` green, Space Grotesk / Inter / IBM Plex Mono — so an approved act can
be lifted straight into it.

## Verified

Costing lands on the product's real figures (51.00 + 54.90 + 12.33 = 118.23,
+18% = 139.51, +25% = 174.39, ×200 = 34,878). Floor counts 200 pieces and
states the 8% allowance. Interest accrues only after day 45 and reaches ₹679 at
day 88, matching the app's own compounding.

## Open question for the next pass

Total scroll is roughly 17 screens. That is deliberate for a story, but it is
the first thing to tune if it feels long — every act's length is one `height`
value on the section.
