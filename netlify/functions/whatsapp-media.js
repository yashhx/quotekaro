/* Stream an inbound WhatsApp media file (image/document) to the browser.
   The Cloud API media URL is short-lived and requires the access token, so the
   client cannot fetch it directly - this proxies it.
   GET /.netlify/functions/whatsapp-media?id=MEDIA_ID
   Needs env var WHATSAPP_TOKEN. */
export const handler = async (event) => {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) return { statusCode: 501, body: "WhatsApp not configured" };

  const id = (event.queryStringParameters || {}).id;
  if (!id) return { statusCode: 400, body: "missing id" };

  try {
    // 1) resolve the temporary download URL for this media id
    const metaRes = await fetch("https://graph.facebook.com/v20.0/" + encodeURIComponent(id), {
      headers: { Authorization: "Bearer " + token },
    });
    const meta = await metaRes.json().catch(() => ({}));
    if (!meta || !meta.url) return { statusCode: 404, body: "media not found" };

    // 2) download the bytes (the token must be sent here too)
    const bin = await fetch(meta.url, { headers: { Authorization: "Bearer " + token } });
    if (!bin.ok) return { statusCode: bin.status, body: "download failed" };
    const buf = Buffer.from(await bin.arrayBuffer());

    return {
      statusCode: 200,
      headers: {
        "content-type": meta.mime_type || "application/octet-stream",
        "cache-control": "private, max-age=86400",
      },
      body: buf.toString("base64"),
      isBase64Encoded: true,
    };
  } catch {
    return { statusCode: 502, body: "media fetch failed" };
  }
};
