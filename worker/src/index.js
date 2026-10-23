/**
 * Apollo API CORS proxy — Cloudflare Worker.
 *
 * Why this exists: api.apollo.io does not send Access-Control-Allow-Origin
 * for non-whitelisted origins (their own Chrome extension + Salesforce only).
 * Browser-side fetches from our Outlook add-in iframe therefore fail with
 * "Failed to fetch" before the request even hits Apollo.
 *
 * This worker:
 *   1. Receives the browser's request at https://<worker-host>/v1/<apollo-path>
 *   2. Forwards it verbatim to https://api.apollo.io/v1/<apollo-path>
 *   3. Returns Apollo's response with permissive CORS headers added
 *
 * Security:
 *   - The worker never sees or stores the user's API key in any persistent
 *     way — the X-Api-Key header passes through transiently, request-only.
 *   - The worker forwards ONLY a small allowlist of headers to Apollo, so
 *     stray cookies or auth tokens cannot leak.
 *   - Origin allowlist below restricts who can use the proxy. Add new
 *     Outlook iframe hosts as Microsoft introduces them.
 *
 * Call log (2026-10-23): one D1 row per proxied call, so what the add-in did is
 * on record: the method, the Apollo path, Apollo's status and the time taken.
 * Never the key, a body or a query string. Workers Logs stays off
 * (wrangler.toml) because it records request headers, and every call here
 * carries the user's key.
 */

const APOLLO_ORIGIN = "https://api.apollo.io";
const LOG_RETAIN_DAYS = 90;

// Best effort: a failed write never affects the call. Prunes rows past the
// retention window on about one write in a hundred.
function logCall(env, ctx, row) {
  if (!env.CALL_LOG) return;
  const now = Date.now();
  const stmts = [
    env.CALL_LOG.prepare(
      "INSERT INTO calls (ts, worker, method, endpoint, status, ms, detail) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(new Date(now).toISOString(), "proxy", row.method, row.endpoint.slice(0, 200), row.status, row.ms, row.detail || null),
  ];
  if (Math.random() < 0.01) {
    const cutoff = new Date(now - LOG_RETAIN_DAYS * 86400000).toISOString();
    stmts.push(env.CALL_LOG.prepare("DELETE FROM calls WHERE ts < ?").bind(cutoff));
  }
  ctx.waitUntil(env.CALL_LOG.batch(stmts).catch(() => {}));
}

// Origins that may invoke this proxy. Office Add-ins iframe under various
// Microsoft hosts; allow them all plus our own GitHub Pages.
const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/nicka2717\.github\.io$/,
  /^https:\/\/outlook\.office\.com$/,
  /^https:\/\/outlook\.office365\.com$/,
  /^https:\/\/outlook\.cloud\.microsoft$/,
  /^https:\/\/[a-z0-9-]+\.officeapps\.live\.com$/,
  /^https:\/\/[a-z0-9-]+\.cdn\.office\.net$/,
];

// Headers we forward from the browser to Apollo.
const FORWARDED_REQUEST_HEADERS = new Set([
  "content-type",
  "cache-control",
  "x-api-key",
]);

function isOriginAllowed(origin) {
  if (!origin) return false;
  return ALLOWED_ORIGIN_PATTERNS.some((re) => re.test(origin));
}

function corsHeaders(origin) {
  // If the origin is allowed, echo it back; otherwise omit (request will fail).
  const allow = isOriginAllowed(origin) ? origin : "https://nicka2717.github.io";
  return {
    "Access-Control-Allow-Origin": allow,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Cache-Control, X-Api-Key",
    "Access-Control-Max-Age": "86400",
  };
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";

    // CORS preflight short-circuit.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Health/info endpoint to confirm the worker is live.
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(
        JSON.stringify({ ok: true, target: APOLLO_ORIGIN, time: new Date().toISOString() }),
        { headers: { "Content-Type": "application/json", ...corsHeaders(origin) } }
      );
    }

    // Build the upstream Apollo URL: forward whatever path & query the caller used.
    const apolloUrl = APOLLO_ORIGIN + url.pathname + url.search;

    // Filter request headers down to the safe allowlist.
    const upstreamHeaders = new Headers();
    for (const [name, value] of request.headers.entries()) {
      if (FORWARDED_REQUEST_HEADERS.has(name.toLowerCase())) {
        upstreamHeaders.set(name, value);
      }
    }

    // Forward the body for non-GET/HEAD methods.
    const init = {
      method: request.method,
      headers: upstreamHeaders,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
    };

    const started = Date.now();
    let upstreamRes;
    try {
      upstreamRes = await fetch(apolloUrl, init);
    } catch (err) {
      // The URL is cut from the reason: its query can carry search terms.
      const reason = String(err).replace(/https?:\/\/[^\n]*/g, "<url>").slice(0, 120);
      logCall(env, ctx, {
        method: request.method, endpoint: url.pathname, status: 502,
        ms: Date.now() - started, detail: `upstream_fetch_failed: ${reason}`,
      });
      return new Response(
        JSON.stringify({ error: "upstream_fetch_failed", message: String(err) }),
        { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders(origin) } }
      );
    }
    logCall(env, ctx, {
      method: request.method, endpoint: url.pathname, status: upstreamRes.status, ms: Date.now() - started,
    });

    // Echo Apollo's response back, but strip cookies/redirects/CSP that don't apply
    // to the proxy's caller, and add our CORS headers.
    const respHeaders = new Headers();
    upstreamRes.headers.forEach((value, name) => {
      const n = name.toLowerCase();
      if (
        n === "set-cookie" ||
        n === "content-security-policy" ||
        n === "strict-transport-security" ||
        n === "x-frame-options"
      ) {
        return;
      }
      respHeaders.set(name, value);
    });
    Object.entries(corsHeaders(origin)).forEach(([k, v]) => respHeaders.set(k, v));

    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: respHeaders,
    });
  },
};
