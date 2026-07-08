/**
 * Inline-image host for the Push-to-Apollo Outlook add-in — Cloudflare Worker.
 *
 * Why this exists: signature logos in Outlook emails are usually embedded
 * INSIDE the email as cid: attachments. Pushed to Apollo as-is they render as
 * broken icons for recipients. The add-in extracts those attachment bytes via
 * Office.js, uploads them here, and rewrites the <img> src to this worker's
 * public URL — so the logo renders for everyone.
 *
 * Endpoints:
 *   POST /img          body = raw image bytes, Content-Type = image/*,
 *                      X-Api-Key = the user's Apollo API key (upload gate).
 *                      → { url } — content-addressed (SHA-256), so identical
 *                      logos dedupe and URLs are immutable.
 *   GET  /img/<hash>   → the image bytes, long-cache.
 *   GET  /health       → { ok: true }
 *
 * Security:
 *   - Uploads require a VALID Apollo API key: the worker calls Apollo's
 *     /v1/auth/health and requires is_logged_in=true. Random callers can't
 *     use this as a free file host.
 *   - Only image content types on a fixed allowlist (no SVG — script risk).
 *   - 2 MB per-image cap.
 *   - Keys are full SHA-256 hashes — not enumerable.
 *   - The key is used transiently for validation only; never stored.
 */

const MAX_BYTES = 2 * 1024 * 1024;

const ALLOWED_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/bmp",
]);

// Same origin allowlist as the CORS proxy (worker/src/index.js).
const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/nicka2717\.github\.io$/,
  /^https:\/\/outlook\.office\.com$/,
  /^https:\/\/outlook\.office365\.com$/,
  /^https:\/\/outlook\.cloud\.microsoft$/,
  /^https:\/\/[a-z0-9-]+\.officeapps\.live\.com$/,
  /^https:\/\/[a-z0-9-]+\.cdn\.office\.net$/,
];

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGIN_PATTERNS.some((re) => re.test(origin || ""))
    ? origin
    : "https://nicka2717.github.io";
  return {
    "Access-Control-Allow-Origin": allow,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Api-Key",
    "Access-Control-Max-Age": "86400",
  };
}

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

async function apolloKeyIsValid(apiKey) {
  if (!apiKey) return false;
  try {
    const res = await fetch("https://api.apollo.io/v1/auth/health", {
      headers: { "X-Api-Key": apiKey },
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data && data.is_logged_in === true;
  } catch (_) {
    return false;
  }
}

async function sha256Hex(buf) {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ ok: true, time: new Date().toISOString() }, 200, origin);
    }

    // ---- Serve a stored image ----
    const serveMatch = url.pathname.match(/^\/img\/([0-9a-f]{64})$/);
    if (request.method === "GET" && serveMatch) {
      const found = await env.IMG.getWithMetadata(serveMatch[1], "arrayBuffer");
      if (!found || !found.value) return json({ error: "not_found" }, 404, origin);
      const ct = (found.metadata && found.metadata.ct) || "image/png";
      return new Response(found.value, {
        status: 200,
        headers: {
          "Content-Type": ct,
          // Content-addressed → immutable forever.
          "Cache-Control": "public, max-age=31536000, immutable",
          ...corsHeaders(origin),
        },
      });
    }

    // ---- Upload ----
    if (request.method === "POST" && url.pathname === "/img") {
      const ct = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
      if (!ALLOWED_CONTENT_TYPES.has(ct)) {
        return json({ error: "unsupported_content_type", contentType: ct }, 415, origin);
      }

      if (!(await apolloKeyIsValid(request.headers.get("X-Api-Key")))) {
        return json({ error: "invalid_api_key" }, 401, origin);
      }

      const body = await request.arrayBuffer();
      if (body.byteLength === 0) return json({ error: "empty_body" }, 400, origin);
      if (body.byteLength > MAX_BYTES) {
        return json({ error: "too_large", maxBytes: MAX_BYTES }, 413, origin);
      }

      const key = await sha256Hex(body);
      // Dedupe: identical bytes → same key; skip rewrite if already stored.
      const existing = await env.IMG.get(key, "stream");
      if (!existing) {
        await env.IMG.put(key, body, { metadata: { ct } });
      }

      return json({ url: `${url.origin}/img/${key}`, key, deduped: !!existing }, 200, origin);
    }

    return json({ error: "not_found" }, 404, origin);
  },
};
