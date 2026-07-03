/* Stream an inbound WhatsApp media file (image/document) to the browser (Netlify Functions v2).
   The Cloud API media URL is short-lived and requires the access token, so the
   client cannot fetch it directly - this proxies it.
   GET /.netlify/functions/whatsapp-media?id=MEDIA_ID&name=Invoice.pdf
   (name is optional - used for the download filename)
   Needs env var WHATSAPP_TOKEN. */
export default async (req) => {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) { console.warn("media: WHATSAPP_TOKEN not set"); return new Response("WhatsApp not configured", { status: 501 }); }

  const params = new URL(req.url).searchParams;
  const id = params.get("id");
  if (!id) return new Response("missing id", { status: 400 });
  // sanitize the optional filename for the content-disposition header
  const name = (params.get("name") || "").replace(/[^\w .()\-]/g, "_").slice(0, 120);

  try {
    // 1) resolve the temporary download URL for this media id
    const metaRes = await fetch("https://graph.facebook.com/v20.0/" + encodeURIComponent(id), {
      headers: { Authorization: "Bearer " + token },
    });
    const meta = await metaRes.json().catch(() => ({}));
    if (!meta || !meta.url) {
      console.error("media: URL lookup failed for", id, "-", metaRes.status, JSON.stringify(meta && meta.error ? meta.error : meta).slice(0, 300));
      // 401/190 from Meta = expired token; surface that as 401 so the UI can hint it
      const code = meta && meta.error && meta.error.code === 190 ? 401 : 404;
      return new Response(code === 401 ? "token expired" : "media not found", { status: code });
    }

    // 2) download the bytes (the token must be sent here too) and stream them back
    const bin = await fetch(meta.url, { headers: { Authorization: "Bearer " + token } });
    if (!bin.ok) { console.error("media: download failed for", id, "-", bin.status); return new Response("download failed", { status: bin.status }); }

    const headers = {
      "content-type": meta.mime_type || "application/octet-stream",
      "cache-control": "private, max-age=86400",
    };
    if (name) headers["content-disposition"] = 'inline; filename="' + name + '"';
    return new Response(bin.body, { status: 200, headers });
  } catch (e) {
    console.error("media: proxy error for", id, "-", e && e.message);
    return new Response("media fetch failed", { status: 502 });
  }
};
