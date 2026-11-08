// Usage log for both add-in Workers (2026-11-08): one D1 row per proxied Apollo call (this folder's
// index.js) and per image upload or failed image request (../../worker-images/src/index.js), in
// the shared `calls` table. Schema: ../migrations/. What each column means: docs/RUNBOOK_USAGE_LOG.md
// at the repo root. Report: scripts/usage-report.mjs.
//
// METADATA ONLY. Never an Apollo key or any part or hash of one, a request or reply body, a query
// string, an email address, an image or its public key, an Origin value or error text. Every text
// field is re-checked against a fixed list or a strict pattern before it is written, and anything
// else is stored as `?` or null. A successful image fetch never writes anything, because each one
// is a recipient opening an email.
//
// Delivery: a `started` row when a call begins and the full row when it ends (an upsert on
// call_id, so the two writes may land in either order and a call that never ended stays
// `started`). Both writes run in waitUntil, the finish after a timer tick, and every error is
// swallowed: logging never delays, fails or changes a reply. Each write also leaves one Analytics
// Engine point (USAGE_HEALTH), so lost writes are visible without D1.

export const WORKERS = ["proxy", "images"];
/** `started` is the row written when a call begins; the report reads an old one as interrupted. */
export const OUTCOMES = ["started", "success", "error"];
/**
 * Who called, from the request's Origin header only (never stored itself). Every teammate sends
 * their own Apollo key, and the key is never used to tell anyone apart, so no person can be named.
 * Origin is what the client claims: a browser sets it truthfully, a script can send anything.
 */
export const CALLERS = ["outlook-addin", "office-host", "other-origin", "no-origin"];
export const FAILURE_CATEGORIES = ["input_validation", "authentication", "rate_limit", "upstream_timeout", "upstream_error", "internal"];
/**
 * Why a call answered with an error, as a code. The proxy: `apollo_status` (Apollo answered 4xx
 * or 5xx and the proxy passed it on), `upstream_fetch_failed` (Apollo could not be reached).
 * The images Worker: its own fixed error codes. Both: `thrown`.
 */
export const REPLY_REASONS = [
  "apollo_status",
  "upstream_fetch_failed",
  "thrown",
  "not_found",
  "unsupported_content_type",
  "too_large",
  "invalid_api_key",
  "quota_exceeded",
  "empty_body",
  "content_mismatch",
];
/** The images Worker's upload gate, as a code; every value but `firm` answers 401 invalid_api_key. */
export const KEY_CHECKS = ["no_key", "no_team_config", "unreachable", "rejected", "unreadable", "not_firm", "firm"];
/** The images Worker's accepted upload types (its MAGIC table); anything else is stored as `?`. */
export const CONTENT_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp", "image/bmp"];
export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];
/**
 * Path words kept as they are: the Apollo resources the add-in calls, the read-only auth check,
 * and the images Worker's route. A 24-hex Apollo record id or a 32-hex image key becomes `{id}`;
 * any other segment becomes `?`, so no name, email or search term can reach a row.
 */
export const PATH_WORDS = [
  "v1",
  "api",
  "auth",
  "health",
  "contacts",
  "search",
  "emailer_campaigns",
  "add_contact_ids",
  "emailer_messages",
  "email_accounts",
  "users",
  "api_profile",
  "img",
];

/** Every column the finished row writes, in order. Pinned by worker/tests against the migrations. */
export const COLUMNS = [
  "call_id",
  "ts",
  "worker",
  "method",
  "endpoint",
  "outcome",
  "version",
  "caller",
  "has_key",
  "status",
  "ms",
  "upstream_ms",
  "upstream_status",
  "failure_category",
  "reply_reason",
  "key_check",
  "content_type",
  "upload_bytes",
  "deduped",
];
const START_COLUMNS = ["call_id", "ts", "worker", "method", "endpoint", "outcome", "version", "caller", "has_key"];

export const RETAIN_DAYS = 365;
/** Rows written before this log (no call_id) keep the 90 days they were promised. */
export const LEGACY_RETAIN_DAYS = 90;
export const PRUNE_ODDS = 0.01;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RECORD_ID = /^(?:[0-9a-f]{24}|[0-9a-f]{32})$/;
const MAX_SEGMENTS = 8;

// The add-in's own GitHub Pages origin (the task pane runs there) and the Microsoft hosts both
// Workers already allow (their ALLOWED_ORIGIN_PATTERNS).
const ADDIN_ORIGIN = "https://nicka2717.github.io";
const OFFICE_ORIGINS = [
  /^https:\/\/outlook\.office\.com$/,
  /^https:\/\/outlook\.office365\.com$/,
  /^https:\/\/outlook\.cloud\.microsoft$/,
  /^https:\/\/[a-z0-9-]+\.officeapps\.live\.com$/,
  /^https:\/\/[a-z0-9-]+\.cdn\.office\.net$/,
];

const inList = (list, v, fallback) => (v == null ? null : list.includes(v) ? v : fallback);
const int = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
const httpStatus = (v) => (Number.isInteger(v) && v >= 100 && v <= 599 ? v : null);
const flag = (v) => (v == null ? null : v ? 1 : 0);

/** The path as a shape: allowlisted words kept, record ids as `{id}`, everything else `?`. */
export function pathShape(pathname) {
  try {
    if (typeof pathname !== "string" || !pathname.startsWith("/")) return "?";
    const segments = pathname.slice(1).split("/");
    if (segments.length > MAX_SEGMENTS) return "?";
    return "/" + segments.map((s) => (s === "" ? "" : PATH_WORDS.includes(s) ? s : RECORD_ID.test(s) ? "{id}" : "?")).join("/");
  } catch {
    return "?";
  }
}

/** The caller class from the Origin header; the header's value is never kept. */
export function callerOf(origin) {
  if (!origin) return "no-origin";
  if (origin === ADDIN_ORIGIN) return "outlook-addin";
  return OFFICE_ORIGINS.some((re) => re.test(origin)) ? "office-host" : "other-origin";
}

/** The Worker version from CF_VERSION_METADATA, or null. */
export function versionOf(env) {
  try {
    const id = env && env.CF_VERSION_METADATA && env.CF_VERSION_METADATA.id;
    return typeof id === "string" && UUID.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** An HTTP status as a failure category (the proxy's mapping; the images Worker sets its own). */
export function categoryOfStatus(status) {
  if (status == null || status < 400) return null;
  if (status === 401 || status === 403) return "authentication";
  if (status === 429) return "rate_limit";
  if (status === 408 || status === 504 || status === 524) return "upstream_timeout";
  return status >= 500 ? "upstream_error" : "input_validation";
}

/** Every value re-checked against its list or pattern, so no caller can store free text. */
export function sanitizeRow(row) {
  return {
    call_id: typeof row.call_id === "string" && UUID.test(row.call_id) ? row.call_id : crypto.randomUUID(),
    ts: typeof row.ts === "string" && ISO.test(row.ts) ? row.ts : new Date().toISOString(),
    worker: inList(WORKERS, row.worker, "?") ?? "?",
    method: inList(METHODS, row.method, "?") ?? "?",
    endpoint: pathShape(row.endpoint),
    outcome: inList(OUTCOMES, row.outcome, "error") ?? "error",
    version: row.version == null ? null : UUID.test(row.version) ? row.version : "?",
    caller: inList(CALLERS, row.caller, "?") ?? "?",
    has_key: flag(row.has_key),
    status: httpStatus(row.status),
    ms: int(row.ms),
    upstream_ms: int(row.upstream_ms),
    upstream_status: httpStatus(row.upstream_status),
    failure_category: inList(FAILURE_CATEGORIES, row.failure_category, "internal"),
    reply_reason: inList(REPLY_REASONS, row.reply_reason, "thrown"),
    key_check: inList(KEY_CHECKS, row.key_check, "?"),
    content_type: inList(CONTENT_TYPES, row.content_type, "?"),
    upload_bytes: int(row.upload_bytes),
    deduped: flag(row.deduped),
  };
}

const placeholders = (n) => Array.from({ length: n }, () => "?").join(", ");

/** The `started` row; a finished row that landed first is left alone. */
export function startStatement(db, row) {
  const r = sanitizeRow({ ...row, outcome: "started" });
  return db
    .prepare(`INSERT INTO calls (${START_COLUMNS.join(", ")}) VALUES (${placeholders(START_COLUMNS.length)}) ON CONFLICT(call_id) DO NOTHING`)
    .bind(...START_COLUMNS.map((c) => r[c] ?? null));
}

/** The finished row; it replaces a `started` row and never a finished one (a replayed write is harmless). */
export function finishStatement(db, row) {
  const r = sanitizeRow(row);
  const set = COLUMNS.filter((c) => c !== "call_id")
    .map((c) => `${c} = excluded.${c}`)
    .join(", ");
  return db
    .prepare(
      `INSERT INTO calls (${COLUMNS.join(", ")}) VALUES (${placeholders(COLUMNS.length)}) ` +
        `ON CONFLICT(call_id) DO UPDATE SET ${set} WHERE calls.outcome = 'started'`
    )
    .bind(...COLUMNS.map((c) => r[c] ?? null));
}

export function pruneStatements(db, now = Date.now()) {
  const cutoff = (days) => new Date(now - days * 86_400_000).toISOString();
  return [
    db.prepare("DELETE FROM calls WHERE ts < ?").bind(cutoff(RETAIN_DAYS)),
    db.prepare("DELETE FROM calls WHERE call_id IS NULL AND ts < ?").bind(cutoff(LEGACY_RETAIN_DAYS)),
  ];
}

// --- Delivery health, outside D1 -----------------------------------------------------------------

export const HEALTH_KINDS = ["start", "finish"];
/** `written`, `lost`, or `no_binding` (CALL_LOG missing). */
export const HEALTH_RESULTS = ["written", "lost", "no_binding"];

/** One Analytics Engine point per log write. Synchronous, buffered by the runtime, never throws. */
export function noteHealth(ae, worker, kind, result, version) {
  try {
    if (ae)
      ae.writeDataPoint({
        blobs: [WORKERS.includes(worker) ? worker : "?", kind, result, version && UUID.test(version) ? version : ""],
        doubles: [1],
        indexes: [WORKERS.includes(worker) ? worker : "?"],
      });
  } catch {
    // Health is best effort too.
  }
}

/** Never rejects. */
export async function writeStart(env, row) {
  if (!env.CALL_LOG) return noteHealth(env.USAGE_HEALTH, row.worker, "start", "no_binding", row.version);
  try {
    await startStatement(env.CALL_LOG, row).run();
    noteHealth(env.USAGE_HEALTH, row.worker, "start", "written", row.version);
  } catch {
    noteHealth(env.USAGE_HEALTH, row.worker, "start", "lost", row.version);
  }
}

/** Never rejects. Prunes on a small share of writes. */
export async function writeFinish(env, row, now = Date.now(), roll = Math.random()) {
  if (!env.CALL_LOG) return noteHealth(env.USAGE_HEALTH, row.worker, "finish", "no_binding", row.version);
  try {
    await finishStatement(env.CALL_LOG, row).run();
    noteHealth(env.USAGE_HEALTH, row.worker, "finish", "written", row.version);
  } catch {
    noteHealth(env.USAGE_HEALTH, row.worker, "finish", "lost", row.version);
    return;
  }
  if (roll < PRUNE_ODDS) {
    try {
      await env.CALL_LOG.batch(pruneStatements(env.CALL_LOG, now));
    } catch {
      // The next prune catches up.
    }
  }
}

// --- One logged call -----------------------------------------------------------------------------

/** What `end` works out from the fields a Worker set. Pure, so tests can pin it. */
export function finishFields(fields, thrown) {
  const status = httpStatus(fields.status);
  if (thrown) {
    return { outcome: "error", failure_category: fields.failure_category ?? "internal", reply_reason: fields.reply_reason ?? "thrown" };
  }
  if (status == null || status >= 400) {
    return {
      outcome: "error",
      failure_category: fields.failure_category ?? categoryOfStatus(status) ?? "internal",
      reply_reason: fields.reply_reason ?? "apollo_status",
    };
  }
  return { outcome: "success", failure_category: null, reply_reason: null };
}

const NOOP_CALL = { set() {}, end() {} };

/**
 * Starts a logged call and returns `{ set(fields), end({ thrown }) }`. `set` merges metadata into
 * the pending row; `end` closes it once (later calls do nothing) and writes the finished row after
 * a timer tick. `start: false` writes nothing until `end`, for a request that must leave no row
 * unless it fails (an image fetch). Nothing here can throw into the caller.
 */
export function beginCall(env, ctx, worker, request, pathname, { start = true } = {}) {
  try {
    const started = Date.now();
    const waitUntil = (p) => {
      try {
        ctx.waitUntil(p);
      } catch {
        // No waitUntil: the write is simply lost, never the reply.
      }
    };
    const base = {
      call_id: crypto.randomUUID(),
      ts: new Date(started).toISOString(),
      worker,
      method: request.method,
      endpoint: pathname,
      outcome: "started",
      version: versionOf(env),
      caller: callerOf(request.headers.get("Origin")),
      has_key: !!request.headers.get("X-Api-Key"),
    };
    const fields = {};
    let ended = false;
    if (start) waitUntil(writeStart(env, base));
    return {
      set(more) {
        try {
          Object.assign(fields, more);
        } catch {
          // As below.
        }
      },
      end({ thrown = false } = {}) {
        try {
          if (ended) return;
          ended = true;
          const row = { ...base, ...fields, ms: Date.now() - started, ...finishFields(fields, thrown) };
          waitUntil(new Promise((r) => setTimeout(r, 0)).then(() => writeFinish(env, row)).catch(() => {}));
        } catch {
          // Never let logging touch the reply.
        }
      },
    };
  } catch {
    return NOOP_CALL;
  }
}
