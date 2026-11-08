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
 *
 * Usage log (2026-11-08, after the 2026-10-23 call log): one D1 row per upload
 * and per failed image request, in the table the CORS proxy logs to, written
 * by the proxy's usage-log.js: outcome, the Worker's fixed error code, the
 * upload gate's result as a code, Apollo's time and status for that check,
 * the upload's type and size, and whether it deduped. Never the key, the
 * image, its hash or its public key. Successful image fetches are NOT logged:
 * each one is a recipient opening an email, and this log is not a read
 * tracker. Workers Logs stays off (wrangler.toml) because it records request
 * headers, and uploads carry the user's key.
 */

import { beginCall } from "../../worker/src/usage-log.js";

const MAX_BYTES = 2 * 1024 * 1024;
const DAILY_UPLOAD_CAP = 500;
const RETENTION_SECONDS = 365 * 24 * 3600;

// Failure category of each of this Worker's own error codes (the usage log's fixed list).
const CATEGORY = {
  unsupported_content_type: "input_validation",
  too_large: "input_validation",
  empty_body: "input_validation",
  content_mismatch: "input_validation",
  not_found: "input_validation",
  quota_exceeded: "rate_limit",
};
// Failure category of each upload-gate result that answers 401 invalid_api_key.
const KEY_CATEGORY = {
  no_key: "authentication",
  rejected: "authentication",
  not_firm: "authentication",
  unreadable: "upstream_error",
  unreachable: "upstream_error",
  no_team_config: "internal",
};
// Apollo refused the key check: a 429 or 5xx is Apollo's trouble, anything else the key's.
const rejectedCategory = (status) => (status === 429 ? "rate_limit" : status >= 500 ? "upstream_error" : "authentication");

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
 * firm's Apollo team. Any error/outage/shape-change → not "firm" (fail closed).
 * Returns the result as a usage-log code; only "firm" lets an upload through.
 * `note` receives Apollo's status and time for the log.
 */
async function apolloKeyCheck(apiKey, env, note) {
  if (!apiKey) return "no_key";
  if (!env.FIRM_TEAM_ID) return "no_team_config";
  const started = Date.now();
  let stage = "unreachable";
  try {
    const res = await fetch("https://api.apollo.io/v1/users/api_profile", {
      headers: { "X-Api-Key": apiKey },
    });
    note({ upstream_status: res.status, upstream_ms: Date.now() - started });
    if (!res.ok) return "rejected";
    stage = "unreadable";
    const data = await res.json();
    note({ upstream_ms: Date.now() - started });
    const user = (data && data.user) || data;
    return !!user && user.team_id === env.FIRM_TEAM_ID ? "firm" : "not_firm";
  } catch (_) {
    note({ upstream_ms: Date.now() - started });
    return stage;
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
  async fetch(request, env, ctx) {
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
      // No row is started here: a fetch that finds its image must leave no trace.
      const call = beginCall(env, ctx, "images", request, url.pathname, { start: false });
      const found = await env.IMG.getWithMetadata(`i:${serveMatch[1]}`, "arrayBuffer");
      if (!found || !found.value) {
        call.set({ status: 404, reply_reason: "not_found", failure_category: CATEGORY.not_found });
        call.end();
        return json({ error: "not_found" }, 404, origin);
      }
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
      // Every upload outcome leaves one call-log row.
      const call = beginCall(env, ctx, "images", request, url.pathname);
      const done = (res, code, more) => {
        call.set({ status: res.status, ...(code ? { reply_reason: code, failure_category: CATEGORY[code] } : {}), ...more });
        call.end();
        return res;
      };
      try {
        const ct = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
        call.set({ content_type: ct });
        if (!MAGIC[ct]) {
          return done(json({ error: "unsupported_content_type", contentType: ct }, 415, origin), "unsupported_content_type");
        }

        // Reject oversize before buffering anything.
        const declaredLen = parseInt(request.headers.get("Content-Length") || "0", 10);
        if (declaredLen > MAX_BYTES) {
          return done(json({ error: "too_large", maxBytes: MAX_BYTES }, 413, origin), "too_large");
        }

        const gate = {};
        const keyCheck = await apolloKeyCheck(request.headers.get("X-Api-Key"), env, (f) => {
          Object.assign(gate, f);
          call.set(f);
        });
        if (keyCheck !== "firm") {
          return done(json({ error: "invalid_api_key" }, 401, origin), "invalid_api_key", {
            key_check: keyCheck,
            failure_category: keyCheck === "rejected" ? rejectedCategory(gate.upstream_status) : KEY_CATEGORY[keyCheck],
          });
        }
        call.set({ key_check: keyCheck });

        // Daily quota — fail closed.
        const quotaKey = `q:${new Date().toISOString().slice(0, 10)}`;
        const used = parseInt((await env.IMG.get(quotaKey)) || "0", 10);
        if (used >= DAILY_UPLOAD_CAP) {
          return done(json({ error: "quota_exceeded" }, 429, origin), "quota_exceeded");
        }

        const body = await request.arrayBuffer();
        call.set({ upload_bytes: body.byteLength });
        if (body.byteLength === 0) return done(json({ error: "empty_body" }, 400, origin), "empty_body");
        if (body.byteLength > MAX_BYTES) {
          return done(json({ error: "too_large", maxBytes: MAX_BYTES }, 413, origin), "too_large");
        }
        if (!magicMatches(ct, new Uint8Array(body))) {
          return done(json({ error: "content_mismatch" }, 415, origin), "content_mismatch");
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

        return done(
          json({ url: `${url.origin}/img/${key}`, deduped: !!existingKey }, 200, origin),
          null,
          { deduped: !!existingKey }
        );
      } catch (err) {
        call.set({ status: 500, reply_reason: "thrown", failure_category: "internal" });
        call.end({ thrown: true });
        throw err;
      }
    }

    // Any other request: one complete row, written only because it failed.
    const miss = beginCall(env, ctx, "images", request, url.pathname, { start: false });
    miss.set({ status: 404, reply_reason: "not_found", failure_category: CATEGORY.not_found });
    miss.end();
    return json({ error: "not_found" }, 404, origin);
  },
};
