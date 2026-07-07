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

## What you need

- **TallyPrime on a Windows PC** (the connector runs on the same PC).
- **Node.js LTS** - free, from https://nodejs.org (click the big LTS button,
  install with all defaults). The connector is a small Node script with zero
  extra downloads.
- A **QuoteKaro cloud account** (you sign in with Google in the app). The
  on-device-only mode has no cloud, so there is nothing for Tally to sync with.
- The `connector` folder from this project, copied anywhere on that PC
  (for example `C:\quotekaro-connector`). It contains three files:
  `quotekaro-tally-connector.mjs`, `config.example.json`, `start-connector.bat`.

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

## Step 2 - Enable Sales Orders in Tally (one time)

The connector creates **Sales Order** vouchers. In many fresh Tally companies
order vouchers are switched off:

1. In TallyPrime press **F11** (Features).
2. Find **"Enable sales order processing"** (you may need "Show more features")
   and set it to **Yes**.

If you skip this, the connector will log `Tally rejected: ... Voucher Type
'Sales Order' ...` - just come back and do this step.

## Step 3 - Get your connector key from the app

1. Open the QuoteKaro app and sign in with Google.
2. Go to **Setup > Tally** and copy the **connector key**. It looks like
   `tk_` followed by 40 letters and numbers.

This key is how the connector proves it is yours. Treat it like a password.

## Step 4 - Fill in config.json

In the connector folder:

1. Copy `config.example.json` and rename the copy to **`config.json`**.
2. Open it in Notepad and paste your key into `connectorKey` (keep the quotes).
3. Leave everything else as it is unless you know you changed it
   (the `_help_...` lines explain each setting; the connector ignores them).

```json
{
  "cloudUrl": "https://quotekaroo.netlify.app",
  "connectorKey": "tk_your40characterkeyhere...",
  "tallyUrl": "http://localhost:9000",
  "intervalSec": 60,
  "voucherType": "Sales Order",
  "dryRun": false,
  "pullOutstanding": true
}
```

## Step 5 - Run it

Double-click **`start-connector.bat`**. A black window opens and stays open -
that is the connector working. It prints one line per action. Close the window
to stop syncing; nothing is lost, it continues where it left off next time.

Want a careful first test? Open Command Prompt in the connector folder and run:

```
node quotekaro-tally-connector.mjs --once --dry-run
```

`--dry-run` prints the exact XML that WOULD go to Tally without sending
anything (and saves nothing to the cloud); `--once` does a single round and
exits. When the output looks right, run the .bat normally.

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
| `did not answer like QuoteKaro` | `cloudUrl` points somewhere wrong | Set `cloudUrl` back to your app address, e.g. `https://quotekaroo.netlify.app`. |
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
