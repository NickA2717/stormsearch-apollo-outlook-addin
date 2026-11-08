#!/usr/bin/env node
/**
 * Apollo add-in usage report: what the two Workers did, what failed and what was slow. Owner-only
 * and READ-ONLY: SELECTs against the production D1 log and one Analytics Engine query, nothing
 * written. What each column means: docs/RUNBOOK_USAGE_LOG.md.
 *
 * Usage (from the repo root):
 *   node scripts/usage-report.mjs                                   last 30 days, both Workers
 *   node scripts/usage-report.mjs --days 7 --tool /v1/contacts/search
 *   node scripts/usage-report.mjs --tool images
 *   node scripts/usage-report.mjs --health                          delivery health, independent of D1
 *
 * Auth: a Cloudflare API token in CLOUDFLARE_API_TOKEN that can read D1 and Analytics Engine on the
 * Workers' account (never printed). D1 is read through worker/'s pinned wrangler; run `npm ci` in
 * worker/ first on a fresh checkout. The account comes from worker/wrangler.toml.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
	parseArgs,
	buildSql,
	STATEMENTS,
	validateD1Response,
	formatReport,
	healthSql,
	formatHealth,
	formatPerformanceLog,
} from './usage-report-lib.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = path.join(REPO, 'worker');
const D1_NAME = 'apollo-addin-calls';

function accountId() {
	const m = /^account_id\s*=\s*"([0-9a-f]{32})"/m.exec(readFileSync(path.join(WORKER, 'wrangler.toml'), 'utf8'));
	if (!m) throw new Error('worker/wrangler.toml has no account_id');
	return m[1];
}

function runD1(sql) {
	const out = execFileSync(path.join(WORKER, 'node_modules/.bin/wrangler'), ['d1', 'execute', D1_NAME, '--remote', '--json', '--command', sql], {
		cwd: WORKER,
		encoding: 'utf8',
		maxBuffer: 32 * 1024 * 1024,
		timeout: 120_000,
	});
	return JSON.parse(out);
}

async function health() {
	const token = process.env.CLOUDFLARE_API_TOKEN;
	if (!token) throw new Error('CLOUDFLARE_API_TOKEN is not set; the health check needs it to read Analytics Engine.');
	const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId()}/analytics_engine/sql`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}` },
		body: healthSql(7),
		signal: AbortSignal.timeout(30_000),
	});
	const text = await res.text();
	// A dataset that has never been written answers 200 with zero rows, so every non-OK reply is a
	// real failure: never read one as "no writes".
	if (!res.ok) throw new Error(`Analytics Engine query failed (HTTP ${res.status}); health unknown, do not assume the log is fine.`);
	let data;
	try {
		data = JSON.parse(text).data;
	} catch {
		throw new Error('Analytics Engine answered with something that is not JSON; health unknown.');
	}
	if (!Array.isArray(data)) throw new Error('Analytics Engine answered without a data array; health unknown.');
	return formatHealth(data, 7);
}

async function main() {
	let o;
	try {
		o = parseArgs(process.argv.slice(2));
	} catch (e) {
		console.error(e.message);
		process.exit(2);
	}
	if (o.health) {
		try {
			const h = await health();
			console.log(h.text);
			if (!h.ok) process.exitCode = 1;
		} catch (e) {
			console.error(e.message);
			process.exitCode = 1;
		}
		return;
	}
	let results;
	try {
		results = validateD1Response(runD1(buildSql(o)), STATEMENTS);
	} catch (e) {
		const msg = `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}`;
		if (/no such column: call_id/.test(msg)) console.error('The usage-log columns are not in D1 yet: apply worker/migrations/0002_usage_log.sql first.');
		console.error(`D1 query failed:\n${msg.slice(0, 2000)}`);
		process.exit(1);
	}
	console.log(formatReport(o, results));
	// A missing or malformed performance log fails the run loudly, never a quiet skip.
	let perfText = null;
	try {
		perfText = readFileSync(path.join(REPO, 'docs/PERFORMANCE_LOG.md'), 'utf8');
	} catch (e) {
		if (e.code !== 'ENOENT') throw e;
	}
	const perf = formatPerformanceLog(perfText, o.tool);
	console.log('\n' + perf.text);
	if (!perf.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
