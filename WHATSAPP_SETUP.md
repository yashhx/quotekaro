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
  PO PDF and it shows in the app (image inline, document as a download chip); audio/video/stickers
  are ignored for now — extend the type checks in `whatsapp-webhook.js` to add them.
- Switching providers (Interakt / Gupshup / WATI / Twilio): change only the `fetch(...)` call in
  `whatsapp-send.js` and the parsing in `whatsapp-webhook.js`.
