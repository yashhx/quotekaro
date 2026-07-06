# QuoteKaro — Cloud accounts setup (Supabase + Google login)

One-time setup, ~20 minutes. After this every customer gets their own private,
isolated account: Google login, quotes synced to the cloud (works offline too),
and WhatsApp enquiries visible only to the customer whose number they were sent to.

Nothing here costs money at your scale — Supabase free tier covers thousands of
users, and Google Sign-In is free.

## 1. Create the Supabase project (5 min)

1. Go to **supabase.com** → Sign up (your GitHub login works) → **New project**.
2. Name: `quotekaro`. Region: **Mumbai (ap-south-1)** — "data stays in India"
   is a selling point. Set a strong database password (store it somewhere safe;
   you rarely need it again).
3. When the project finishes provisioning, go to **Project Settings → API** and
   copy three values:
   - **Project URL** (like `https://abcdefgh.supabase.co`)
   - **anon public** key (safe to be public — it's in the app)
   - **service_role** key (SECRET — server only, never in the app)

## 2. Create the tables (2 min)

1. In Supabase: **SQL Editor → New query**.
2. Paste the entire contents of `supabase/schema.sql` from this repo → **Run**.
3. You should see "Success". This creates `shop_data` (per-user private data,
   row-level security) and `tenants` (WhatsApp number routing), plus a trigger
   that auto-creates a tenant row for every new signup.

## 3. Google login (10 min — the fiddly part)

Supabase needs a Google OAuth client to offer "Continue with Google":

1. Go to **console.cloud.google.com** → create a project (name: QuoteKaro).
2. **APIs & Services → OAuth consent screen**: External → app name QuoteKaro,
   your support email → save through the steps (no scopes to add, no test users
   needed once published; while in "Testing" mode add your and your demo
   customers' emails as test users).
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**
   - Authorized JavaScript origins: `https://quotekaroo.netlify.app`
   - Authorized redirect URIs: `https://YOUR-PROJECT-REF.supabase.co/auth/v1/callback`
     (shown verbatim in the next step's Supabase screen — copy from there)
   - Create → copy the **Client ID** and **Client secret**.
4. Back in Supabase: **Authentication → Providers → Google** → enable → paste
   Client ID + Client secret → Save. (This screen also shows the exact callback
   URL for step 3.)
5. In Supabase **Authentication → URL Configuration**: set Site URL to
   `https://quotekaroo.netlify.app`.

## 4. Netlify environment variables (3 min)

Site configuration → Environment variables → add **five** variables:

| Key | Value |
|---|---|
| `VITE_SUPABASE_URL` | the Project URL |
| `VITE_SUPABASE_ANON_KEY` | the anon public key |
| `SUPABASE_URL` | the Project URL (again — this copy is for the functions) |
| `SUPABASE_ANON_KEY` | the anon public key (again) |
| `SUPABASE_SERVICE_KEY` | the service_role key (SECRET) |

Then **Deploys → Trigger deploy → Deploy site**. The `VITE_` pair is baked into
the app at build time, so this deploy is what turns cloud mode ON.

## 5. Make yourself admin + assign WhatsApp numbers (1 min)

1. Open the app → log in with Google once (this creates your tenant row).
2. Supabase → SQL Editor:

```sql
-- you see every enquiry, incl. ones not routed to any customer yet
update public.tenants set is_admin = true
where user_id = (select id from auth.users where email = 'YOUR@GMAIL.COM');

-- give a customer their WhatsApp number (the Meta phone_number_id,
-- from Meta's API Setup page - NOT the phone number itself)
update public.tenants set wa_phone_id = '123456789012345'
where user_id = (select id from auth.users where email = 'CUSTOMER@GMAIL.COM');
```

## How the isolation works (for your own confidence)

- **Quotes**: each user's data is one row in `shop_data`, and row-level security
  policies (`auth.uid() = user_id`) are enforced by Postgres itself — the
  database refuses to return or accept another user's row, even if the app had
  a bug. The service key that CAN bypass this never leaves Netlify's env.
- **WhatsApp enquiries**: every inbound message records which business number it
  was sent TO (`phoneId`). The enquiries function only returns messages whose
  `phoneId` matches the caller's `tenants.wa_phone_id`. Admin sees everything.
- **Devices**: the offline cache is keyed per-account (`quotekaro:v5:<uid>`) and
  cleared on logout, so two people sharing a phone can't see each other's data.
- **Local dev / no env vars**: the app quietly runs as the original on-device
  prototype — nothing breaks.

## What changes for existing devices

The first time a device with old on-device data logs into Google, that data is
adopted into the account (one-time migration) and the old on-device copy is
removed. After that, the account is the source of truth on every device.
