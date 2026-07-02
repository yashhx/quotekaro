/* Stream an inbound WhatsApp media file (image/document) to the browser (Netlify Functions v2).
   The Cloud API media URL is short-lived and requires the access token, so the
   client cannot fetch it directly - this proxies it.
   GET /.netlify/functions/whatsapp-media?id=MEDIA_ID
   Needs env var WHATSAPP_TOKEN. */
export default async (req) => {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) return new Response("WhatsApp not configured", { status: 501 });

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return new Response("missing id", { status: 400 });

  try {
    // 1) resolve the temporary download URL for this media id
    const metaRes = await fetch("https://graph.facebook.com/v20.0/" + encodeURIComponent(id), {
      headers: { Authorization: "Bearer " + token },
    });
    const meta = await metaRes.json().catch(() => ({}));
    if (!meta || !meta.url) return new Response("media not found", { status: 404 });

    // 2) download the bytes (the token must be sent here too) and stream them back
    const bin = await fetch(meta.url, { headers: { Authorization: "Bearer " + token } });
    if (!bin.ok) return new Response("download failed", { status: bin.status });

    return new Response(bin.body, {
      status: 200,
      headers: {
        "content-type": meta.mime_type || "application/octet-stream",
        "cache-control": "private, max-age=86400",
      },
    });
  } catch {
    return new Response("media fetch failed", { status: 502 });
  }
};
