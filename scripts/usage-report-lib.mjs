// Pure parts of the usage report (scripts/usage-report.mjs): argument parsing, SQL, percentiles,
// formatting and the performance-log check. No I/O here, so worker/tests/usage-report.test.mjs can
// run all of it against a real SQLite copy of the schema. Every column it reads is metadata
// (docs/RUNBOOK_USAGE_LOG.md); nothing here can show a key, a body, an email or a name, because
// the log never holds one.

/** This repo's evidence bar (docs/PERFORMANCE_LOG.md Rules): fewer successful calls print "too few calls". */
export const MIN_CALLS = 5;
/** A `started` row older than this never finished: the report calls it interrupted. */
export const INTERRUPTED_AFTER_MIN = 15;
const USAGE = 'usage: node scripts/usage-report.mjs [--days N] [--tool proxy|images|<path shape>] | --health';

export function parseArgs(argv) {
	const o = { days: 30, tool: null, health: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--health') o.health = true;
		else if (a === '--days') {
			const n = Number(argv[++i]);
			if (!Number.isInteger(n) || n < 1 || n > 365) throw new Error('--days takes a whole number from 1 to 365');
			o.days = n;
		} else if (a === '--tool') {
			const t = argv[++i];
			// A Worker name or a path shape as the log stores it; the pattern admits no quote, so it is safe in SQL.
			if (!(t === 'proxy' || t === 'images' || /^\/[a-z0-9_{}?/]{0,120}$/.test(t ?? ''))) throw new Error(`--tool takes proxy, images or a path shape such as /v1/contacts/search\n${USAGE}`);
			o.tool = t;
		} else throw new Error(`unknown option ${a}\n${USAGE}`);
	}
	return o;
}

const since = (days) => `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${days} days')`;

/** One wrangler call, several statements; results come back in this order. Values are validated in parseArgs. */
export function buildSql({ days, tool }) {
	const filter = tool == null ? '' : tool === 'proxy' || tool === 'images' ? ` AND worker = '${tool}'` : ` AND endpoint = '${tool}'`;
	// Rows from before this log (no call_id) measured `ms` differently and carry no outcome: counted only.
	const w = `ts >= ${since(days)} AND call_id IS NOT NULL${filter}`;
	const outcome = `CASE WHEN outcome = 'started' AND ts < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${INTERRUPTED_AFTER_MIN} minutes') THEN 'interrupted' ELSE outcome END`;
	return [
		// 0 calls per endpoint and outcome
		`SELECT worker, method, endpoint, ${outcome} AS outcome, COUNT(*) AS n FROM calls WHERE ${w} GROUP BY 1, 2, 3, 4 ORDER BY 1, 5 DESC`,
		// 1 calls per caller class and whether a key was sent
		`SELECT worker, caller, COALESCE(has_key, '-') AS has_key, COUNT(*) AS n, MAX(ts) AS last FROM calls WHERE ${w} GROUP BY 1, 2, 3 ORDER BY 4 DESC`,
		// 2 successful calls, for percentiles and bands (computed in JS so every number has its count)
		`SELECT worker, method, endpoint, ms, upstream_ms, version, upload_bytes, deduped FROM calls WHERE ${w} AND outcome = 'success' AND ms IS NOT NULL`,
		// 3 failures by category, reason, status and key check
		`SELECT worker, method, endpoint, COALESCE(failure_category, '-') AS category, COALESCE(reply_reason, '-') AS reason, COALESCE(status, '-') AS status, COALESCE(key_check, '-') AS key_check, COALESCE(upstream_status, '-') AS apollo_status, COUNT(*) AS n, MAX(ts) AS last FROM calls WHERE ${w} AND outcome = 'error' GROUP BY 1, 2, 3, 4, 5, 6, 7, 8 ORDER BY 9 DESC`,
		// 4 slowest calls
		`SELECT ts, worker, method, endpoint, caller, ${outcome} AS outcome, status, ms, upstream_ms, upload_bytes, substr(version, 1, 8) AS version FROM calls WHERE ${w} AND ms IS NOT NULL ORDER BY ms DESC LIMIT 10`,
		// 5 calls that never finished
		`SELECT worker, method, endpoint, COUNT(*) AS n, MAX(ts) AS last FROM calls WHERE ${w} AND ${outcome} = 'interrupted' GROUP BY 1, 2, 3 ORDER BY 4 DESC`,
		// 6 rows from before this log, still in the table
		`SELECT worker, COUNT(*) AS n, MIN(ts) AS first, MAX(ts) AS last FROM calls WHERE ts >= ${since(days)} AND call_id IS NULL GROUP BY 1`,
		// 7 earliest row in the window
		`SELECT MIN(ts) AS first FROM calls WHERE ${w}`,
	].join(';\n');
}
export const STATEMENTS = 8;

export function validateD1Response(res, count) {
	if (!Array.isArray(res) || res.length !== count || res.some((r) => !r?.success || !Array.isArray(r.results)))
		throw new Error(`D1 returned an unexpected response shape (wanted ${count} result sets)`);
	return res.map((r) => r.results);
}

/** Nearest-rank percentile of a numeric list; null for an empty list. */
export function percentile(values, p) {
	if (!values.length) return null;
	const s = [...values].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

/** "p50 X, p90 Y (n calls)", or "too few calls (n)" below the evidence bar. */
export function stat(values, min = MIN_CALLS) {
	if (values.length < min) return `too few calls (${values.length})`;
	return `p50 ${percentile(values, 50)}, p90 ${percentile(values, 90)} (${values.length} calls)`;
}

/**
 * The workload band a successful call is compared in. A proxied call's time is Apollo's time for
 * that endpoint, so its band is the endpoint. An upload's work is its size and whether it was new
 * (a deduped upload skips the three KV writes).
 */
export function bandOf(row) {
	if (row.worker !== 'images' || row.endpoint !== '/img') return `${row.method} ${row.endpoint}`;
	const b = row.upload_bytes ?? 0;
	const size = b < 10 * 1024 ? 'under 10 KB' : b < 100 * 1024 ? '10-100 KB' : '100 KB-2 MB';
	return `upload ${size}, ${row.deduped ? 'deduped' : 'new'}`;
}

export function table(rows, columns) {
	if (!rows.length) return '  none';
	const cells = rows.map((r) => columns.map(([k]) => String(r[k] ?? '-')));
	const widths = columns.map(([, h], i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
	const line = (vals) => '  ' + vals.map((v, i) => v.padEnd(widths[i])).join('  ').trimEnd();
	return [line(columns.map(([, h]) => h)), ...cells.map(line)].join('\n');
}

export function formatReport(o, r) {
	const [byOutcome, byCaller, successes, failures, slowest, interrupted, legacy, first] = r;
	const out = [];
	out.push(`Apollo add-in usage, last ${o.days} days, ${o.tool ? `filter ${o.tool}` : 'both Workers'} (first row in window: ${first[0]?.first ?? 'none'})`);
	out.push(`Evidence bar: ${MIN_CALLS} successful calls; below it a percentile prints as "too few calls". Times in ms, sizes in bytes.`);

	out.push('\nCalls per endpoint and outcome (endpoint = path shape; record ids as {id}, unknown segments as ?)');
	out.push(table(byOutcome, [['worker', 'worker'], ['method', 'method'], ['endpoint', 'endpoint'], ['outcome', 'outcome'], ['n', 'calls']]));

	out.push("\nWho called (caller class from the Origin header, which the client claims; every teammate's own key is never used to tell them apart)");
	out.push(table(byCaller, [['worker', 'worker'], ['caller', 'caller'], ['has_key', 'key sent'], ['n', 'calls'], ['last', 'last (UTC)']]));

	out.push("\nSuccessful calls: total time against Apollo's time (our time is waiting outside Apollo, never CPU)");
	const per = new Map();
	for (const s of successes) {
		const k = `${s.worker}|${s.method}|${s.endpoint}`;
		if (!per.has(k)) per.set(k, []);
		per.get(k).push(s);
	}
	const speed = [...per].map(([k, list]) => {
		const [worker, method, endpoint] = k.split('|');
		return {
			worker,
			call: `${method} ${endpoint}`,
			total: stat(list.map((s) => s.ms)),
			apollo: stat(list.map((s) => s.upstream_ms ?? 0)),
			ours: stat(list.map((s) => Math.max(0, s.ms - (s.upstream_ms ?? 0)))),
		};
	});
	out.push(table(speed, [['worker', 'worker'], ['call', 'call'], ['total', 'total'], ['apollo', 'Apollo'], ['ours', 'our time']]));

	out.push('\nVersion comparison by workload band (successful calls; ms)');
	const bands = new Map();
	for (const s of successes) {
		const key = `${s.worker}|${bandOf(s)}|${s.version ?? '?'}`;
		if (!bands.has(key)) bands.set(key, []);
		bands.get(key).push(s.ms);
	}
	const bandRows = [...bands]
		.map(([key, ms]) => {
			const [worker, band, version] = key.split('|');
			return { worker, band, version: version.slice(0, 8), timing: stat(ms) };
		})
		.sort((a, b) => (a.worker + a.band + a.version).localeCompare(b.worker + b.band + b.version));
	out.push(table(bandRows, [['worker', 'worker'], ['band', 'band'], ['version', 'version'], ['timing', 'timing']]));

	out.push('\nFailures by category, reason and status (status = what the Worker answered; Apollo status = the upload gate\'s key check)');
	out.push(
		table(failures, [
			['worker', 'worker'],
			['method', 'method'],
			['endpoint', 'endpoint'],
			['category', 'category'],
			['reason', 'reason'],
			['status', 'status'],
			['key_check', 'key check'],
			['apollo_status', 'Apollo status'],
			['n', 'calls'],
			['last', 'last (UTC)'],
		]),
	);

	out.push(`\nCalls that never finished (started over ${INTERRUPTED_AFTER_MIN} minutes ago)`);
	out.push(table(interrupted, [['worker', 'worker'], ['method', 'method'], ['endpoint', 'endpoint'], ['n', 'calls'], ['last', 'last (UTC)']]));

	out.push('\nSlowest calls');
	out.push(
		table(slowest, [
			['ts', 'started (UTC)'],
			['worker', 'worker'],
			['method', 'method'],
			['endpoint', 'endpoint'],
			['caller', 'caller'],
			['outcome', 'outcome'],
			['status', 'status'],
			['ms', 'ms'],
			['upstream_ms', 'Apollo'],
			['upload_bytes', 'bytes'],
			['version', 'version'],
		]),
	);

	if (legacy.length) {
		out.push('\nRows from before this log (no call id, `ms` meant Apollo time on the proxy; counted, never timed)');
		out.push(table(legacy, [['worker', 'worker'], ['n', 'rows'], ['first', 'first (UTC)'], ['last', 'last (UTC)']]));
	}
	return out.join('\n');
}

// --- Delivery health (Analytics Engine, independent of D1) ---------------------------------------

export const HEALTH_DATASET = 'apollo_addin_usage_health';
export function healthSql(days = 7) {
	return `SELECT blob1 AS worker, blob2 AS kind, blob3 AS result, SUM(_sample_interval) AS n, MAX(timestamp) AS last FROM ${HEALTH_DATASET} WHERE timestamp > NOW() - INTERVAL '${days}' DAY GROUP BY worker, kind, result ORDER BY worker, kind, result`;
}

/** D1 rows in the health window, read only when Analytics Engine has no points, to tell "no use" from "no health points". */
export function healthD1CountSql(days = 7) {
	// Rows from before the usage log (no call_id) never came with health points, so they never count.
	return `SELECT COUNT(*) AS n FROM calls WHERE ts >= ${since(days)} AND call_id IS NOT NULL`;
}

/**
 * { text, ok }: ok is false when any write was lost or the D1 binding was missing, or when
 * Analytics Engine has no points while D1 holds rows in the same window (the Workers cannot
 * write health points). `d1Rows` is that D1 count, or null when it was not read.
 */
export function formatHealth(rows, days = 7, d1Rows = null) {
	const head = `Usage-log delivery health, last ${days} days (Analytics Engine ${HEALTH_DATASET}, independent of D1)`;
	if (!rows.length) {
		if (Number(d1Rows) > 0)
			return {
				ok: false,
				text: `${head}\n  NO HEALTH POINTS: D1 holds ${Number(d1Rows)} row(s) in this window but Analytics Engine has none, so the Workers cannot write health points (check the health binding). Points take a minute or more to arrive; re-run if the rows are only minutes old.`,
			};
		return {
			ok: true,
			text: `${head}\n  No log writes recorded, and D1 has no rows in this window either: nobody used the add-in. Points take a minute or more to arrive.`,
		};
	}
	const lost = rows.filter((r) => r.result === 'lost' || r.result === 'no_binding').reduce((n, r) => n + Number(r.n), 0);
	const verdict = lost ? `LOST WRITES: ${lost} log write(s) did not land (rows below). The calls themselves were answered.` : 'OK: no lost writes.';
	return { ok: !lost, text: [head, '  ' + verdict, table(rows, [['worker', 'worker'], ['kind', 'write'], ['result', 'result'], ['n', 'count'], ['last', 'last (UTC)']])].join('\n') };
}

// --- Performance log (docs/PERFORMANCE_LOG.md) ---------------------------------------------------

export const PERF_FIELDS = [
	'Status',
	'Tool or path',
	'What changed',
	'Branch',
	'Benchmark',
	'Branch before/after',
	'Rerun before/after',
	'Merged',
	'Version before/after',
	'Live before/after',
	'Affects',
	'Notes',
];
const MEASURED = ['Branch before/after', 'Rerun before/after', 'Live before/after'];
export const PERF_STATUSES = {
	planned: [],
	'in progress': ['Branch'],
	'claimed on branch': ['Benchmark', 'Branch before/after'],
	'merged, awaiting validation': ['Merged'],
	'merged, benchmark verified': ['Merged', 'Rerun before/after'],
	'deployed, awaiting live data': ['Merged', 'Version before/after'],
	'live verified': ['Merged', 'Version before/after', 'Live before/after'],
	'no gain': ['measured'],
	regression: ['measured'],
};
// "-" and "x -> -" both mean nothing measured yet on that side.
const filled = (v) => v != null && v !== '-' && !/->\s*-?\s*$/.test(v);

export function parsePerformanceLog(text) {
	const entries = [];
	const errors = [];
	let cur = null;
	let sawRules = false;
	let sawTable = false;
	for (const line of text.split('\n')) {
		if (/^## Rules\s*$/.test(line)) sawRules = true;
		if (/^\| `planned` \|/.test(line)) sawTable = true;
		const head = /^## (P\d+): (.+)$/.exec(line);
		if (head) {
			cur = { id: head[1], name: head[2].trim(), fields: {} };
			entries.push(cur);
			continue;
		}
		if (/^## /.test(line)) cur = null;
		const field = cur && /^- ([^:]+): (.*)$/.exec(line);
		if (field) cur.fields[field[1].trim()] = field[2].trim();
	}
	if (!sawRules) errors.push('the "## Rules" section is missing');
	if (!sawTable) errors.push('the status table is missing');
	const seen = new Set();
	for (const e of entries) {
		if (seen.has(e.id)) errors.push(`${e.id}: duplicate entry id`);
		seen.add(e.id);
		for (const f of PERF_FIELDS) if (!(f in e.fields)) errors.push(`${e.id}: missing field "${f}"`);
		for (const f of Object.keys(e.fields)) if (!PERF_FIELDS.includes(f)) errors.push(`${e.id}: unknown field "${f}"`);
		const status = e.fields.Status;
		const needs = PERF_STATUSES[status];
		if (!needs) {
			errors.push(`${e.id}: unknown status "${status ?? ''}"`);
			continue;
		}
		for (const need of needs) {
			if (need === 'measured') {
				if (!filled(e.fields.Merged) && !filled(e.fields.Branch)) errors.push(`${e.id}: "${status}" needs Merged or Branch`);
				if (!MEASURED.some((f) => filled(e.fields[f]))) errors.push(`${e.id}: "${status}" needs a measured before/after`);
			} else if (!filled(e.fields[need])) errors.push(`${e.id}: "${status}" needs ${need} filled in`);
		}
	}
	return { entries, errors };
}

export function formatPerformanceLog(text, tool = null) {
	const head = 'Performance changes (docs/PERFORMANCE_LOG.md)';
	if (text == null) return { text: `${head}\n  MISSING: docs/PERFORMANCE_LOG.md does not exist.`, ok: false };
	const { entries, errors } = parsePerformanceLog(text);
	const shown = tool ? entries.filter((e) => (e.fields['Tool or path'] ?? '').includes(tool)) : entries;
	const out = [head];
	out.push(
		shown.length
			? table(
					shown.map((e) => ({ id: e.id, status: e.fields.Status ?? '', tool: e.fields['Tool or path'] ?? '', name: e.name })),
					[['id', 'id'], ['status', 'status'], ['tool', 'tool or path'], ['name', 'change']],
				)
			: '  No entries yet: the log is collecting a baseline before the first speed change.',
	);
	if (errors.length) out.push('MALFORMED PERFORMANCE LOG, fix these:', ...errors.map((e) => '  ' + e));
	return { text: out.join('\n'), ok: !errors.length };
}
