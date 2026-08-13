# QuoteKaro - Tally connector setup

The app works fine **without** Tally. Follow this only when you (or your accountant)
want two things to happen automatically:

- Every quote you mark **Won** in QuoteKaro appears in TallyPrime as a **Sales Order**
  voucher - party ledger and stock item are created for you if they do not exist.
- Customer **outstanding balances** (Sundry Debtors closing balances) are read from
  Tally and sent to the app, so you see who owes you money while you chase quotes.

Tally runs on a PC in your office; the app runs in the cloud. They cannot talk to
each other directly, so a small **connector** program runs on the same PC as Tally
and carries messages both ways. It checks once a minute. Close it any time - the
app keeps working, and pending quotes simply wait until the connector runs again.

**It starts READ-ONLY.** Out of the box the connector only *reads* Tally
(balances, bills, dispatches) and writes nothing into it. Order push is opt-in,
later, when you are comfortable - see "Turning on order push" at the end.

**Whole setup is 3 steps, about 5 minutes.** No Notepad, no JSON, no commands.

## What you need

- **TallyPrime on a Windows PC** (the connector runs on the same PC).
- A **TrackRakho cloud account** (you sign in with Google in the app). The
  on-device-only mode has no cloud, so there is nothing for Tally to sync with.
- The `connector` folder from this project, copied anywhere on that PC
  (for example `C:\trackrakho-connector`). It contains three files:
  `quotekaro-tally-connector.mjs`, `config.example.json`, `start-connector.bat`.

Node.js is **not** something you install yourself - `start-connector.bat`
installs it the first time if the PC does not have it.

## Step 1 - Turn on the Tally gateway

TallyPrime has a built-in "gateway" that lets programs on the same PC talk to it.

1. Open TallyPrime and **open the company** you want the orders to go into.
   (Imports always land in the company that is open on screen.)
2. Press **F1 (Help) > Settings > Connectivity > Client/Server configuration**.
3. Set **"TallyPrime acts as"** to **Both**.
4. Leave the **port** as **9000** (if you change it, change `tallyUrl` in
   config.json to match).
5. Tally may ask to restart - let it. Leave Tally open with your company loaded.

Quick check: open a browser on the same PC and go to `http://localhost:9000` -
you should see a short "server is running" message.

## Step 2 - Get your connector key from the app

1. Open the TrackRakho app and sign in with Google.
2. Go to **Setup > Tally (BETA)** and tap **Get connector key**, then **Copy**.
   It looks like `tk_` followed by 40 letters and numbers.

This key is how the connector proves it is yours. Treat it like a password.

## Step 3 - Double-click start-connector.bat

On the Tally PC, open the `connector` folder and double-click
**`start-connector.bat`**. A black window opens and does the rest:

1. If Node.js is missing it installs it (about 2 minutes, one time only).
   On the rare PC where automatic install is unavailable it opens the
   nodejs.org download page and tells you to run the .bat again afterwards.
2. It asks for your **key** - paste it (right-click pastes in that window) and
   press Enter. It immediately checks the key against the cloud and prints
   your shop name so you know it is the right account.
3. It looks for Tally, then shows a numbered list of the **sales ledgers**
   found in your books. Type the number of the one your sales go into.
   (If Tally is not reachable it prints the exact port-9000 steps and waits.)
4. It writes `config.json` for you and starts syncing.

Leave the window open - that is the connector working. It prints one line per
action and checks once a minute. Close it to stop; nothing is lost, it picks up
where it left off next time.

To change the key or sales ledger later, run **`start-connector.bat --setup`**
(or right-click the .bat > Edit is *not* needed - you never edit files by hand).

Want a careful look before it syncs anything? In Command Prompt:

```
node quotekaro-tally-connector.mjs --once --dry-run
```

`--dry-run` prints the exact XML that WOULD go to Tally without sending
anything (and saves nothing to the cloud); `--once` does a single round.

## Step 4 - Background mode (recommended on a customer's PC)

Step 3 leaves a window open on screen. On a real shop PC that window will get
closed by someone, and syncing stops silently. Fix it once:

Double-click **`install-autostart.bat`**.

From then on the connector:

- starts by itself every time the PC is switched on,
- runs with **no window at all**,
- writes every line it would have printed into **`connector.log`** in the same
  folder (that is where you look if anything seems wrong; it is rotated at 2 MB).

To stop it completely (and remove the auto-start), double-click
**`stop-connector.bat`**. To start again, `install-autostart.bat`.

Two safety notes:

- **Only one connector can run on a PC.** If a second copy is started (or the
  same folder exists twice), it prints "Connector pehle se chal raha hai",
  names the folder that is running, and exits - it never double-imports.
- **Put the folder on the PC's own disk** (e.g. `C:\TrackRakho\connector`), not
  on a network/shared drive. A share may not be mounted yet when Windows starts,
  and the connector would not launch.

The connector does not need Tally to be open when the PC boots - it retries
every minute and starts syncing the moment TallyPrime is opened with a company.

## Turning on order push (later, optional)

The connector ships **read-only**: `"pushOrders": false`. When you want Won
quotes to land in Tally as **Sales Order** vouchers:

1. In TallyPrime, activate the Sales Order voucher type once:
   **Vouchers > F10 (Other Vouchers) > Show Inactive > Sales Order > Yes**.
   (Older releases: F11 Features > "Enable sales order processing" = Yes.)
2. Open `config.json` in the connector folder and set `"pushOrders": true`.
3. Restart the connector.

If the voucher type is not active, the connector logs that Tally parked the
voucher in **Import Exceptions** (O: Import > Import Exceptions in Tally).

## What the log lines mean

| Line | Meaning |
|---|---|
| `Cloud says 2 won quote(s) waiting for Tally` | The app has won quotes not yet in Tally. |
| `Sent to Tally: Apex Hydraulics - Gland Nut - Rs 34878` | A Sales Order was created in Tally. It will not be sent again. |
| `Tally rejected: ... <reason>` | Tally refused the voucher. The reason is Tally's own error text; the quote is retried on later rounds (up to 5 tries in total, then it is skipped so it cannot clog the queue). |
| `note: qty was missing, logged as 1 unit at the full amount` | The quote had no quantity, so the order was booked as 1 unit at the full amount to keep the maths right. |
| `note: qty 2.5 rounded to 3 ...` | Tally's Nos unit takes whole numbers, so the quantity was rounded; the total amount stays exactly as quoted. |
| `note: quote date was outside the Tally books ...` | The quote was older than the company's books-beginning date, so the order went in dated today instead of failing. |
| `Read 14 customer balance(s) from Tally (Sundry Debtors)` | Outstanding balances were read and will be shown in the app. Positive = the customer owes you. |
| `Saved to cloud: 2 sync result(s), 14 balance(s)` | The round finished and the app is up to date. |
| `Tally is not reachable - is TallyPrime open with the gateway on?` | Tally is closed or the gateway is off. The round is skipped; no harm done. |
| `Nothing to report to the cloud this round.` | No won quotes waiting and no balances to send. All quiet. |

## Troubleshooting

| Problem | Likely cause | Fix |
|---|---|---|
| `Cannot find config.json` | You have not created it yet | Copy `config.example.json` to `config.json` and fill in the key (Step 4). |
| `The connectorKey ... is missing or still the placeholder` | Key not pasted, or pasted wrongly | Copy the full key from app Setup > Tally. It must be `tk_` + 40 characters. |
| `Node.js is not installed on this PC` | Node missing | Install the LTS from https://nodejs.org and run the .bat again. |
| `Tally is not reachable` every round | TallyPrime closed, gateway off, or a different port | Open Tally with your company, then Step 1. Check `http://localhost:9000` in a browser. |
| `the cloud rejected the connector key` | Key was regenerated in the app, or a typo | Copy the current key from Setup > Tally into config.json. Regenerating in the app kills the old key on purpose. |
| `did not answer like QuoteKaro` | `cloudUrl` points somewhere wrong | Set `cloudUrl` back to your app address, e.g. `https://trackrakho.com`. |
| `Tally rejected: ... Voucher Type 'Sales Order' does not exist` (or similar) | Order vouchers not enabled in that company | Step 2 (F11 > enable sales order processing). Or set `voucherType` in config.json to a voucher type your company does have. |
| `Tally rejected: ... already exists` on a LEDGER or STOCKITEM | Not a problem | The connector treats "already exists" as success and continues. If you see it as a rejection reason for the voucher itself, tell support. |
| Orders land in the wrong company | Imports go into whichever company is open in Tally | Open the right company before starting the connector. |
| Quote shows a Tally error in the app | Same as the log line | Fix the cause in Tally; the quote is retried automatically (up to 5 tries). After 5 failed tries it is skipped - fix the cause, then message support to re-queue it (takes a minute). |
| A won quote never reaches Tally and there is no error | The quote has no amount | Quotes with amount 0 are never sent (Tally rejects zero-value vouchers). Put the amount on the quote in the app. |

Still stuck? WhatsApp support: +91 99106 05207.

## Security note

The connector key allows exactly two things: **reading your won quotes**
(customer, part, quantity, amount) and **writing back sync status plus customer
balance figures**. It cannot read your Tally data from outside (the connector
runs on your PC and only it talks to Tally), cannot see other users' data, and
cannot touch payments or passwords. If a key ever leaks, open the app
**Setup > Tally > Regenerate key** - the old key stops working immediately, then
paste the new one into config.json.


## Tally Insights page (added 2026-07-13)

The connector now also pulls, every cycle:
- **Debtor + creditor balances** (Sundry Debtors / Sundry Creditors, sub-groups included)
- **Sales + Purchase vouchers of the last 45 days** with item, quantity and unit
  (e.g. "12.5 MT") - one line per item.

The app turns this into the **Tally - seedha hisaab** page (Home > green Tally
card): money to collect, money to pay, tonnage shipped this month, recent
dispatches, and order-progress bars (won order qty in the app vs quantity
actually shipped in Tally, matched by customer name).

Nothing to configure - it rides the same connector key and `pullOutstanding`
flag. Run the updated `supabase/tally.sql` once (adds the `grp` column and the
`tally_vouchers` table). For order-progress bars to work, the customer name on
the app quote must match the Tally party ledger name (case-insensitive).

## Bill-wise outstandings (added 2026-07-28)

The connector now ALSO pulls every **open bill** under Sundry Debtors (Tally's
Bills Receivable, bill by bill): reference/bill no, bill date, due date
(computed as bill date + credit period), original amount and pending amount.
The app turns this into:
- the **"Paisa kahan atka hai"** aging bar (time hai / 1-30 / 31-60 / 60+ din late),
- the **"Har bill ka hisaab"** drill-down (tap a bill: debit, credit received,
  baki, item/qty via the matching voucher reference, party total),
- per-party overdue splits in the aane-wale list, and
- an overdue-bill credit flag in the dispatch planner.

Needs: run the updated `supabase/tally.sql` once more (creates `tally_bills`).
Two honest limits: bills exist only for parties whose Tally ledger has
**"Maintain balances bill-by-bill" = Yes** (an empty pull is normal, the app
just hides the aging view), and any "On Account" money (receipts never matched
to a bill) shows as its own line so totals still reconcile with the ledger
balance. Like everything here, exact XML tag names should be confirmed against
a real TallyPrime once before handing to a customer's accountant.
