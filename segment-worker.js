// Cloudflare Worker: segment proxy
// Deploy this to Cloudflare Workers (free tier is fine).
// CF Workers use Cloudflare's globally distributed IPs — CDNs almost never
// block them, unlike Vercel/AWS datacenter IPs which get hard-blocked.
//
// After deploying, you'll get a URL like:
//   https://segment-proxy.<your-subdomain>.workers.dev
//
// Then update vercel.json to rewrite /api/segment to this worker.
// Your Player code never needs to change — it still calls /api/segment.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Range",
};

function jsonRes(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function rewriteM3u8(text, baseUrl, referer) {
  const proxyPrefix = `/api/segment?referer=${encodeURIComponent(referer)}&url=`;

  function proxyUrl(raw) {
    try {
      const absolute = new URL(raw, baseUrl).href;
      return proxyPrefix + encodeURIComponent(absolute);
    } catch {
      return raw;
    }
  }

  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (!trimmed.startsWith("#")) return proxyUrl(trimmed);
      if (trimmed.includes('URI="')) {
        return line.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${proxyUrl(uri)}"`);
      }
      return line;
    })
    .join("\n");
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== "GET") {
      return jsonRes({ error: "Method not allowed" }, 405);
    }

    const { searchParams } = new URL(request.url);
    const url = searchParams.get("url");
    const referer = searchParams.get("referer");

    if (!url) return jsonRes({ error: "Missing url parameter" }, 400);

    let decoded;
    try {
      decoded = decodeURIComponent(url);
      const parsed = new URL(decoded);
      if (parsed.protocol !== "https:") {
        return jsonRes({ error: "Only HTTPS URLs are allowed" }, 403);
      }
    } catch {
      return jsonRes({ error: "Invalid url parameter" }, 400);
    }

    let useReferer;
    if (referer) {
      useReferer = decodeURIComponent(referer);
    } else {
      try {
        useReferer = new URL(decoded).origin + "/";
      } catch {
        useReferer = decoded;
      }
    }

    try {
      const refererOrigin = new URL(useReferer).origin;

      const upstream = await fetch(decoded, {
        headers: {
          "Referer": useReferer,
          "Origin": refererOrigin,
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept": "*/*",
          "Accept-Language": "en-US,en;q=0.9",
          "Accept-Encoding": "identity",
          "DNT": "1",
          "Sec-Fetch-Dest": "empty",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "cross-site",
          "Sec-CH-UA": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
          "Sec-CH-UA-Mobile": "?0",
          "Sec-CH-UA-Platform": '"Windows"',
        },
      });

      if (!upstream.ok) {
        return jsonRes({ error: `Upstream returned ${upstream.status}` }, upstream.status);
      }

      const ct = upstream.headers.get("content-type") || "application/octet-stream";
      const isM3u8 =
        ct.includes("mpegurl") ||
        ct.includes("x-mpegurl") ||
        decoded.split("?")[0].endsWith(".m3u8");

      if (isM3u8) {
        const text = await upstream.text();
        const rewritten = rewriteM3u8(text, decoded, useReferer);
        return new Response(rewritten, {
          status: 200,
          headers: {
            ...CORS,
            "Content-Type": "application/vnd.apple.mpegurl",
            "Cache-Control": "no-cache",
          },
        });
      }

      // Stream binary segments directly — no buffering
      return new Response(upstream.body, {
        status: 200,
        headers: {
          ...CORS,
          "Content-Type": ct,
          "Cache-Control": "public, max-age=3600",
        },
      });
    } catch (err) {
      return jsonRes({ error: "Proxy fetch failed", details: err.message }, 500);
    }
  },
};
