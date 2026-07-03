# QuoteKaro — Two-way WhatsApp setup

The app works with **no** backend (WhatsApp stays send-only via `wa.me` links). Follow this
only when you want incoming customer messages to land in the pipeline automatically and to
send messages from the server.

## What the backend does
- `netlify/functions/whatsapp-webhook.js` — receives incoming WhatsApp messages from Meta and
  stores them (Netlify Blobs).
- `netlify/functions/enquiries.js` — the app polls this every 30s; shows new messages under
  **Pipeline > Incoming on WhatsApp**, where one tap logs them as a quote.
- `netlify/functions/whatsapp-send.js` — sends a WhatsApp message (text within the 24h window,
  or an approved template) through the Meta Cloud API.
- `netlify/functions/whatsapp-media.js` — streams an inbound image/document (drawings, POs) to
  the browser, since the Cloud API media URL needs the access token.

## 1. Deploy on Netlify with functions
Drag-and-drop of `dist/` will **not** include functions. Instead:
- Push this repo to GitHub and "Import from Git" in Netlify (build `npm run build`, publish `dist`,
  functions `netlify/functions` — already set in `netlify.toml`), or
- Run `npx netlify deploy --build --prod` from the project root.

Your function URLs will be:
`https://YOUR-SITE.netlify.app/.netlify/functions/whatsapp-webhook` (and `/enquiries`, `/whatsapp-send`).

## 2. Meta WhatsApp Cloud API (free tier)
1. Create an app at https://developers.facebook.com > add the **WhatsApp** product.
2. In **WhatsApp > API Setup**, note the **Phone number ID** and a **temporary access token**
   (later generate a permanent token via a System User).
3. In **Configuration > Webhook**:
   - Callback URL = your `.../whatsapp-webhook` URL
   - Verify token = the same secret you set as `WHATSAPP_VERIFY_TOKEN`
   - Subscribe to the **messages** field.

## 3. Environment variables (Netlify > Site settings > Environment variables)
See `.env.example`:
- `WHATSAPP_VERIFY_TOKEN` — any secret you invent (must match the value typed into Meta's webhook).
- `WHATSAPP_TOKEN` — the Cloud API access token.
- `WHATSAPP_PHONE_ID` — the phone number ID.

Redeploy after setting them.

## 4. Notes & limits
- **Inbound** works as soon as the webhook is verified — text messages appear in the app.
- **Free-form outbound** is only allowed within 24h of the customer's last message. For
  business-initiated messages outside that window, use an **approved template**: send
  `{ "to": "...", "template": { "name": "...", "language": { "code": "en" } } }` to `whatsapp-send`.
- **Text, image and document** messages are captured. A customer can send a drawing photo or a
  PO PDF and it shows in the app (image inline, document as a download chip). Template quick-reply
  buttons and interactive list/button replies arrive as text. Audio/video/sticker/location arrive
  as a placeholder card ("[audio message - open WhatsApp to view it]") so nothing silently vanishes;
  emoji reactions are logged but not shown.
- Switching providers (Interakt / Gupshup / WATI / Twilio): change only the `fetch(...)` call in
  `whatsapp-send.js` and the parsing in `whatsapp-webhook.js`.

## 5. Troubleshooting: webhook verified, but messages never arrive

Symptom: the callback URL verified fine (green check), yet sending a WhatsApp
message to the number produces ZERO invocations in Netlify's Function log.
An empty function log means Meta never called - work through these in order:

1. **The `messages` field is not subscribed** (most common). "Verify and save"
   subscribes you to NOTHING - it only tests the URL. Go to
   App Dashboard > WhatsApp > Configuration > Webhook fields and toggle
   **Subscribe** on the `messages` row. Use the **Test** button next to it to
   fire a sample payload and confirm it lands in the Function log.
2. **The WABA is not bound to your app** ("shadow delivery"). Even with the URL
   verified and the field subscribed, the WhatsApp Business Account itself must
   be subscribed to the app. Check in Graph API Explorer
   (developers.facebook.com/tools/explorer):
   `GET /{WABA_ID}/subscribed_apps` - if `data` is empty, run
   `POST /{WABA_ID}/subscribed_apps` with your app selected. The WABA ID is on
   the WhatsApp > API Setup page.
3. **Webhook saved under the wrong object.** On the generic Products > Webhooks
   page the dropdown must say "WhatsApp Business Account" - a URL verified under
   "User" or "Page" never receives WhatsApp events. Safest: configure only via
   WhatsApp > Configuration.
4. **Wrong app / webhook override.** If you have several Meta apps, the number
   may be bound to another app's webhook. `GET /{PHONE_NUMBER_ID}?fields=webhook_configuration`
   shows the effective URL, including any phone-level override.
5. **Old messages are never replayed.** After fixing any of the above, send a
   FRESH message - events from before the subscription existed are gone.
6. Development mode is fine for the test number (no need to go Live), and the
   5-recipient allow-list only limits OUTBOUND sends, not inbound webhooks.
7. An expired `WHATSAPP_TOKEN` does NOT stop inbound webhooks (delivery is a
   push from Meta) - but it breaks media preview and sending. Meta error
   `code 190 / Authentication Error` = replace the token (see permanent token
   steps above).

With the improved logging, every webhook call now writes a line to
Netlify > Logs > Functions > whatsapp-webhook - if you see "stored text enquiry ..."
the backend is fine and any remaining issue is in the app/polling.
