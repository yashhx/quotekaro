# QuoteKaro - Gmail RFQ inbox setup (BETA)

RFQ/enquiry emails land in the app's pipeline automatically - like the WhatsApp
inbox, but for Gmail. A scheduled function checks each connected inbox every
5 minutes for new mail containing RFQ-ish words (quote, quotation, rfq, enquiry,
rate, price, requirement, estimate) and turns matches into enquiry cards.

One-time setup ~10 minutes. Needs cloud accounts (SUPABASE_SETUP.md) done first.

## 1. Add the Gmail scope to your Google OAuth app (5 min)

You already made a Google OAuth client for login (SUPABASE_SETUP.md step 3).
Now it needs permission to READ Gmail:

1. console.cloud.google.com -> your QuoteKaro project -> **APIs & Services**.
2. **Library** -> search "Gmail API" -> **Enable**.
3. **OAuth consent screen -> Data access (Scopes) -> Add or remove scopes** ->
   tick `.../auth/gmail.readonly` -> Update -> Save.
4. **Audience / Test users**: keep the app in **Testing** and add every account
   that will connect Gmail (yours + demo customers) as a **test user**.

### The honest limitations (read this)
- `gmail.readonly` is a **restricted** Google scope. In **Testing** mode it works
  only for the test users you list (max 100) - fine for you and demos.
- **Testing-mode refresh tokens expire after 7 days.** The app shows
  "Reconnect needed" in Setup when that happens - one tap to reconnect.
- Serving strangers at scale needs Google's app **verification** (CASA security
  review) - same class of paperwork as Meta business verification. Later problem.

## 2. Netlify env vars (2 min)

Site configuration -> Environment variables -> add (values from the same Google
OAuth client you pasted into Supabase):

| Key | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | the OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | the OAuth client secret |

Then **Trigger deploy** (env changes need one).

## 3. Database column (1 min)

Supabase -> SQL Editor -> paste all of `supabase/gmail.sql` -> Run.

## 4. Connect (in the app)

Setup -> **Gmail (BETA)** -> **Connect Gmail** -> Google asks for read-only mail
permission -> approve. Done. New RFQ-looking mail appears under
"Incoming enquiries" in the Pipeline within ~5 minutes (or tap
**Check Gmail now** in Setup).

## How it works / privacy
- Flow: Google refresh token -> stored server-side in `tenants` (service role
  only; the browser never keeps it) -> `gmail-poll` (scheduled, netlify.toml)
  refreshes an access token, searches `in:inbox after:<last check> (quote OR
  rfq OR ...)`, stores matches in the same Netlify Blobs "enquiries" store the
  WhatsApp webhook uses, stamped with `userId` so only that user (and admin)
  sees them. `enquiries.js` routes by userId for Gmail records.
- Read-only scope: the app can never send, delete or label mail.
- Only matching mails are copied (subject + first ~1200 chars of text), and they
  auto-expire from the store after 30 days like all enquiries.
- Disconnect (Setup) wipes the token server-side immediately.

## Troubleshooting
| Symptom | Cause / fix |
|---|---|
| "Reconnect needed" in Setup | Testing-mode token expired (7 days) - tap Reconnect |
| Connect succeeds but nothing appears | Netlify logs -> `gmail-poll`; check GOOGLE_CLIENT_ID/SECRET set + deploy done |
| "could not save (run supabase/gmail.sql?)" | Step 3 not run |
| Google shows scary "unverified app" screen | Normal in Testing mode - click Continue |
| Wanted mail didn't match | It must contain an RFQ word (quote/rate/enquiry/...); tune RFQ_QUERY in gmail-poll.js |
