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
 *                      → { url } — random public key; identical bytes dedupe
 *                      to the same stored object via an internal hash map.
 *   GET  /img/<key>    → the image bytes, long-cache, nosniff.
 *   GET  /health       → { ok: true }
 *
 * Security (hardened 2026-07-08 after Codex review):
 *   - Uploads require an Apollo API key belonging to THE FIRM's Apollo team
 *     (env.FIRM_TEAM_ID) — verified via /v1/users/api_profile. Any other
 *     Apollo customer's valid key is rejected. Fails closed on outage.
 *   - Public URLs are RANDOM (128-bit), not content hashes — knowing or
 *     guessing the bytes does not reveal the URL.
 *   - Image-only: declared content-type allowlist (no SVG) AND magic-byte
 *     validation of the actual bytes; the two must agree.
 *   - Oversize requests rejected from Content-Length before buffering;
 *     2 MB hard cap on the buffered body.
 *   - Daily upload quota (fails closed when exceeded).
 *   - 1-year retention (KV TTL) — matches the immutable cache header.
 *   - Served with X-Content-Type-Options: nosniff.
 *   - The key is used transiently for validation only; never stored.
 */

const MAX_BYTES = 2 * 1024 * 1024;
const DAILY_UPLOAD_CAP = 500;
const RETENTION_SECONDS = 365 * 24 * 3600;

// Declared content-type allowlist + the magic bytes each must carry.
const MAGIC = {
  "image/png": [[0x89, 0x50, 0x4e, 0x47]],
  "image/jpeg": [[0xff, 0xd8, 0xff]],
  "image/jpg": [[0xff, 0xd8, 0xff]],
  "image/gif": [[0x47, 0x49, 0x46, 0x38]], // GIF8
  "image/webp": [[0x52, 0x49, 0x46, 0x46]], // RIFF (WEBP tag checked below)
  "image/bmp": [[0x42, 0x4d]],
};

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
    headers: {
      "Content-Type": "application/json",
      "X-Content-Type-Options": "nosniff",
      ...corsHeaders(origin),
    },
  });
}

/**
 * The upload gate: the key must be a working Apollo key AND belong to the
 * firm's Apollo team. Any error/outage/shape-change → false (fail closed).
 */
async function apolloKeyIsFirm(apiKey, env) {
  if (!apiKey || !env.FIRM_TEAM_ID) return false;
  try {
    const res = await fetch("https://api.apollo.io/v1/users/api_profile", {
      headers: { "X-Api-Key": apiKey },
    });
    if (!res.ok) return false;
    const data = await res.json();
    const user = (data && data.user) || data;
    return !!user && user.team_id === env.FIRM_TEAM_ID;
  } catch (_) {
    return false;
  }
}

function magicMatches(ct, bytes) {
  const sigs = MAGIC[ct];
  if (!sigs) return false;
  const ok = sigs.some((sig) => sig.every((b, i) => bytes[i] === b));
  if (!ok) return false;
  // WEBP: RIFF container must actually carry the WEBP tag at offset 8.
  if (ct === "image/webp") {
    return bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  }
  return true;
}

function randomKey() {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
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

    // ---- Serve a stored image (random 32-hex public key) ----
    const serveMatch = url.pathname.match(/^\/img\/([0-9a-f]{32})$/);
    if (request.method === "GET" && serveMatch) {
      const found = await env.IMG.getWithMetadata(`i:${serveMatch[1]}`, "arrayBuffer");
      if (!found || !found.value) return json({ error: "not_found" }, 404, origin);
      const ct = (found.metadata && found.metadata.ct) || "image/png";
      return new Response(found.value, {
        status: 200,
        headers: {
          "Content-Type": ct,
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          "Cache-Control": "public, max-age=31536000, immutable",
          ...corsHeaders(origin),
        },
      });
    }

    // ---- Upload ----
    if (request.method === "POST" && url.pathname === "/img") {
      const ct = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
      if (!MAGIC[ct]) {
        return json({ error: "unsupported_content_type", contentType: ct }, 415, origin);
      }

      // Reject oversize before buffering anything.
      const declaredLen = parseInt(request.headers.get("Content-Length") || "0", 10);
      if (declaredLen > MAX_BYTES) {
        return json({ error: "too_large", maxBytes: MAX_BYTES }, 413, origin);
      }

      if (!(await apolloKeyIsFirm(request.headers.get("X-Api-Key"), env))) {
        return json({ error: "invalid_api_key" }, 401, origin);
      }

      // Daily quota — fail closed.
      const quotaKey = `q:${new Date().toISOString().slice(0, 10)}`;
      const used = parseInt((await env.IMG.get(quotaKey)) || "0", 10);
      if (used >= DAILY_UPLOAD_CAP) {
        return json({ error: "quota_exceeded" }, 429, origin);
      }

      const body = await request.arrayBuffer();
      if (body.byteLength === 0) return json({ error: "empty_body" }, 400, origin);
      if (body.byteLength > MAX_BYTES) {
        return json({ error: "too_large", maxBytes: MAX_BYTES }, 413, origin);
      }
      if (!magicMatches(ct, new Uint8Array(body))) {
        return json({ error: "content_mismatch" }, 415, origin);
      }

      // Dedupe via an internal hash→key map; the public key stays random.
      const hash = await sha256Hex(body);
      const existingKey = await env.IMG.get(`h:${hash}`);
      let key = existingKey;
      if (!key) {
        key = randomKey();
        await env.IMG.put(`i:${key}`, body, {
          metadata: { ct },
          expirationTtl: RETENTION_SECONDS,
        });
        await env.IMG.put(`h:${hash}`, key, { expirationTtl: RETENTION_SECONDS });
        await env.IMG.put(quotaKey, String(used + 1), { expirationTtl: 2 * 24 * 3600 });
      }

      return json({ url: `${url.origin}/img/${key}`, deduped: !!existingKey }, 200, origin);
    }

    return json({ error: "not_found" }, 404, origin);
  },
};
