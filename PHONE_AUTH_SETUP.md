# Phone login (OTP over WhatsApp)

Shop owners remember their phone number. They do not remember which Gmail their
nephew set up in 2016. So the login screen now asks for a phone number first, and
Google sits underneath as the second door.

**The code travels over WhatsApp, not SMS.** Real SMS OTP in India needs TRAI DLT
registration - the entity, a sender ID, and every template registered with the
operators, with fees and weeks of waiting. We already run a Meta WhatsApp Cloud
API number, every customer we sell to has WhatsApp, and an authentication message
costs about Rs 0.14. So there is no SMS provider in this stack at all.

Supabase still owns everything security-critical: it generates the 6-digit code,
sets the expiry, verifies it, rate-limits, and issues the session. Our function
only carries the code to the phone.

```
app  signInWithOtp({ phone })
      -> Supabase makes the code
      -> POSTs it to /.netlify/functions/auth-sms-hook
      -> we send it as a WhatsApp template
app  verifyOtp({ phone, token, type: "sms" })  -> real session
```

---

## 1. Create the WhatsApp template (Meta)

Meta Business Suite > WhatsApp Manager > **Message templates** > Create template.

- Category: **Authentication** (not Utility, not Marketing - the price and the
  approval speed both depend on this)
- Name: `login_code` (or anything, but it must match `WHATSAPP_OTP_TEMPLATE`)
- Language: English (`en`) - must match `WHATSAPP_OTP_LANG`
- Add the **copy-code / one-tap** button when offered

Meta writes the body text for authentication templates and will not let you edit
it. That is why these get approved in minutes rather than days.

## 2. Turn on phone auth (Supabase)

Dashboard > Authentication > **Providers > Phone**: enable it.

Leave the SMS provider fields alone - the hook below replaces them.

## 3. Point the Send SMS hook at our function

Dashboard > Authentication > **Hooks** > *Send SMS message* > enable, type
**HTTPS**, URL:

```
https://trackrakho.com/.netlify/functions/auth-sms-hook
```

Supabase shows a secret that starts with `v1,whsec_`. Copy it - it is shown once.

## 4. Enable manual identity linking

Dashboard > Authentication > **Sign In / Providers** (advanced settings) > turn
on **manual linking**. Without this the "Add Google" button in Setup fails with
*"manual linking is not enabled"*.

## 5. Netlify environment variables

```
SUPABASE_AUTH_HOOK_SECRET=v1,whsec_....   (from step 3)
WHATSAPP_OTP_TEMPLATE=login_code
WHATSAPP_OTP_LANG=en
```

`WHATSAPP_TOKEN` and `WHATSAPP_PHONE_ID` are already set for the enquiry inbox -
the same number sends the codes. `SUPABASE_SERVICE_KEY` must be set too, for
`auth-discard` (step 7).

## 6. Protect the spend

Every "Send code" tap costs about Rs 0.14, and an open OTP endpoint is a way for
a stranger to spend your money.

- Dashboard > Authentication > **Rate limits**: lower the SMS-per-hour limit to
  something a real shop would never exceed
- Dashboard > Authentication > **Attack protection**: turn on CAPTCHA

The app also refuses a resend for 45 seconds, but that is politeness, not
security - the server-side limits are the real control.

---

## 7. One account, two doors

This is the part that would otherwise bite. Supabase creates a **new user** for
every identifier it has not seen. A customer who has been signing in with Google
for months, and who types his phone number one day, would land in an empty
pipeline and believe the app lost his work.

Three things prevent that, and none of them ever copies data between accounts:

**Setup > "Login ke tareeke"** lets a signed-in user attach the missing door.
Adding a phone runs `updateUser({ phone })` then `verifyOtp({ type: "phone_change" })`;
adding Google runs `linkIdentity({ provider: "google" })`. Both stay on the same
`uid`, so `shop_data` never splits. **Tell every customer to do this once at
handover** - it takes twenty seconds and removes the problem permanently.

**The new-account guard.** When a phone number creates a brand new account with
no Google attached, the app asks once, before loading or seeding anything:
*"Is this a new shop account?"* Choosing *"No, I used Google before"* calls
`auth-discard`, which deletes the empty account it just made - freeing the number
- and sends the user back through Google to their real account, where Setup can
attach the same number properly.

**`auth-discard` refuses unless all four hold:** the caller's own JWT names the
account, it has no `shop_data` row at all, it was created in the last 24 hours,
and nothing else is linked to it. An account holding any work is never touched.
The uid comes from the token, never from the request body.

---

## Testing it

1. Sign in with a phone number that has never been used here. The guard appears -
   choose *"Yes, start fresh"*. The code should arrive on WhatsApp in seconds.
2. In Setup, add Google to that account. Log out, sign in with Google - the same
   pipeline should appear.
3. Log out, sign in with the phone number again - same pipeline again.
4. Now the important one: with a *second* Google account that has real data,
   sign in by an unused phone number, choose *"No, I used Google before"*, and
   confirm you land back on the Google account with everything intact.

## When it goes wrong

Every failure is logged by the function, and nothing logs the code itself.

| Symptom | Where to look |
|---|---|
| No message arrives | Netlify function log for `auth-sms-hook`. A Meta rejection is logged in full - wrong template name, wrong language code, or a parameter-shape mismatch all name themselves there. |
| "invalid signature" | `SUPABASE_AUTH_HOOK_SECRET` does not match the hook. Re-copy it, including the `v1,whsec_` prefix. |
| "hook not configured" | The env var is missing on Netlify. |
| Add-Google fails | Manual linking is off (step 4), or that Google account is already attached to a different TrackRakho account - the app says which. |
| Code rejected as expired | Supabase expires codes after 1 hour by default; the resend button issues a fresh one. |

## Cost

About **Rs 0.14 per login** (Meta authentication category, India, plus GST).
A hundred logins a month is roughly Rs 14. Multi-device or repeat logins by the
same owner cost the same each time, which is why the rate limits in step 6 matter.
