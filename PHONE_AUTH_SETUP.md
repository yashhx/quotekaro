# Phone login (OTP)

Shop owners remember their phone number. They do not remember which Gmail their
nephew set up in 2016. So the login screen asks for a phone number first, and
Google sits underneath as the second door.

**Supabase owns the security half** - it generates the 6-digit code, sets the
expiry, verifies it, rate-limits, and issues the session. Our Netlify function
only carries the code to the phone. That split never changes, whichever carrier
delivers it.

```
app  signInWithOtp({ phone })
      -> Supabase makes the code
      -> POSTs it to /.netlify/functions/auth-sms-hook
      -> we hand it to SMS or WhatsApp
app  verifyOtp({ phone, token, type: "sms" })  -> real session
```

## Two channels, and why

`OTP_CHANNEL` picks one: `sms`, `whatsapp`, or `auto` (try WhatsApp, fall back
to SMS). Unset, we use whichever provider is configured, preferring SMS.

**SMS (MSG91) is the working channel today.** It bills in INR through ordinary
UPI/netbanking.

**WhatsApp is cheaper and nicer but Meta's billing blocked us.** The whole chain
was proven working in production - signature verified, template approved, Meta
accepted the send - and then Meta refused to *deliver*, returning
`131042 Business eligibility payment issue`, because no Indian card would
attach to the business portfolio. RBI's e-mandate rules mean Indian debit cards
essentially never work and credit cards only on some banks. The code is still
there and tested; the day a card attaches, set `OTP_CHANNEL=auto` and WhatsApp
takes over with no code change.

---

# Setting up SMS (MSG91)

## 1. Account and DLT

Sign up at msg91.com. Then complete **TRAI DLT registration** - this is the part
that takes days, not minutes, and it is mandatory for anyone sending SMS to
Indian numbers. MSG91 walks you through it and files on your behalf.

You will register three things:

- **Entity** - your business. Udyam/MSME certificate and PAN are accepted;
  the legal name must match exactly (`TRACKRAKHO`).
- **Sender ID** - the 6-letter code the SMS appears to come from, e.g. `TRKRKO`.
- **Template** - the exact message text, with the code as a variable:

  ```
  {#var#} is your TrackRakho login code. Do not share it with anyone.
  ```

  The delivered text must match the registered template character for
  character, or the carrier drops it silently.

## 2. Build the MSG91 flow

In the MSG91 dashboard create a **Flow** using that approved DLT template. It
gives you a **template id** - that is `MSG91_TEMPLATE_ID`. Note the variable
name you used for the code (default expected here is `OTP`).

## 3. Netlify environment variables

🔗 Site configuration → Environment variables

```
OTP_CHANNEL        = sms
MSG91_AUTHKEY      = from MSG91 dashboard
MSG91_TEMPLATE_ID  = the flow/template id from step 2
MSG91_OTP_VAR      = OTP        (only if your variable is named something else)
```

Then trigger a redeploy - Netlify only reads new variables on a fresh build.

## 4. Supabase (unchanged, already done)

- **Auth → Providers → Phone**: enabled. The Twilio boxes hold dummy values and
  are ignored, because the hook overrides the provider.
- **Auth → Hooks → Send SMS message**: HTTPS →
  `https://trackrakho.com/.netlify/functions/auth-sms-hook`, secret pasted into
  Netlify as `SUPABASE_AUTH_HOOK_SECRET`.
- **Auth → Sign In / Providers**: *Allow manual linking* ON.
- **Auth → Rate Limits**: SMS/OTP per hour lowered. This is the only thing
  stopping a stranger spending your money.
- **Auth → Sessions**: time-box and inactivity both `0` (never). This is what
  makes "log in once, stay logged in" true.
- **Auth → Attack Protection**: CAPTCHA **OFF**. It requires the client to send
  an hCaptcha token on every auth call, which this app does not do - turning it
  on locks every user out, including you.

---

# Setting up WhatsApp (parked until billing works)

1. Meta → WhatsApp Manager → Message templates → **Authentication** category,
   name `login_code`, language **English** (`en`, not `en_US`), delivery
   **Copy code** (never one-tap or zero-tap - those need a native Android app
   with a package name and signature hash, and this is a PWA).
2. Netlify: `WHATSAPP_OTP_TEMPLATE=login_code`, `WHATSAPP_OTP_LANG=en`.
   `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_ID` are shared with the enquiry inbox -
   **`WHATSAPP_PHONE_ID` must be the phone number ID of the number the template
   lives on.** Ours was stale (the old test number) and produced
   `#132001 Template name does not exist` for a template that plainly existed.
3. Attach a payment method at 🔗 business.facebook.com/billing_hub/accounts.
   Without one Meta accepts the API call and then drops the message with
   `131042`.
4. Set `OTP_CHANNEL=auto` and redeploy.

---

# One account, two doors

This is the part that would otherwise bite. Supabase creates a **new user** for
every identifier it has not seen. A customer who has been signing in with Google
for months, and who types his phone number one day, would land in an empty
pipeline and believe the app lost his work.

Three things prevent that, and **none of them ever copies data between
accounts** - merging rows is the kind of mistake you cannot undo:

**Setup → "Login ke tareeke"** attaches the missing door from inside the account
you already hold. Phone via `updateUser({ phone })` then
`verifyOtp({ type: "phone_change" })`; Google via `linkIdentity()`. Same `uid`,
so `shop_data` never splits. **Tell every customer to do this once at handover.**

**The new-account guard.** A phone number creating a brand new account with no
Google attached is asked once, *before anything is loaded or seeded*: "Is this a
new shop account?" Choosing "No, I used Google before" calls `auth-discard`,
which deletes the empty account it just made - freeing the number - and sends
the user back through Google to their real account.

**`auth-discard` refuses unless all four hold:** the caller's own JWT names the
account, it has no `shop_data` row at all, it was created in the last 24 hours,
and nothing else is linked to it. An account holding any work is never touched.
The uid comes from the token, never from the request body.

---

# Testing and troubleshooting

Every failure is logged by the function, and **the code itself is never logged**.

🔗 app.netlify.com/sites/quotekaroo/logs/functions → `auth-sms-hook`

| Log line | Meaning |
|---|---|
| `otp: sent via sms to ...5207 ref ...` | Delivered to MSG91 |
| `otp: sms failed ... msg91 200 {"type":"error"...}` | DLT template mismatch, wrong template id, or no balance. MSG91 answers HTTP 200 with an error body, which we treat as failure. |
| `otp: whatsapp failed ... 131042` | Meta billing - no payment method |
| `otp: whatsapp failed ... 132001` | Wrong template name, wrong language, or `WHATSAPP_PHONE_ID` pointing at a different number |
| `otp: rejected - signature mismatch` | `SUPABASE_AUTH_HOOK_SECRET` does not match the Supabase hook |
| `otp: rejected - stale timestamp` | Replay guard; clock skew over 5 minutes |
| nothing at all | Supabase is not calling the hook - check the hook URL |

Adversarial checks that should always refuse:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  -H "content-type: application/json" -d '{}' \
  https://trackrakho.com/.netlify/functions/auth-sms-hook     # expect 401
```

`501 hook not configured` means `SUPABASE_AUTH_HOOK_SECRET` is missing;
`501 no SMS/WhatsApp provider configured` means neither carrier is set up.

## Cost

SMS in India runs roughly **₹0.15–0.25 per message** plus DLT overheads.
WhatsApp authentication messages are about **₹0.14**. Either way the Supabase
rate limit is what keeps the bill honest.
