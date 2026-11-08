// The usage report's SQL and formatting, run against SQLite with the real migrations and rows the
// real writer produced, plus the health verdict and the performance-log check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	MIN_CALLS,
	STATEMENTS,
	bandOf,
	buildSql,
	formatHealth,
	formatPerformanceLog,
	formatReport,
	parseArgs,
	percentile,
	stat,
	validateD1Response,
} from '../../scripts/usage-report-lib.mjs';
import { finishStatement, startStatement } from '../src/usage-log.js';
import { VERSION, d1, sqlite } from './helpers.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function runReport(db, o) {
	const res = buildSql(o)
		.split(';\n')
		.map((sql) => ({ success: true, results: db.prepare(sql).all().map((r) => ({ ...r })) }));
	return validateD1Response(res, STATEMENTS);
}

async function seeded() {
	const db = sqlite();
	const D = d1(db);
	const now = Date.now();
	const iso = (ago) => new Date(now - ago).toISOString();
	let n = 0;
	const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
	for (let i = 0; i < 6; i++)
		await finishStatement(D, { call_id: id(), ts: iso(60_000 + i), worker: 'proxy', method: 'POST', endpoint: '/v1/contacts/search', outcome: 'success', version: VERSION, caller: 'outlook-addin', has_key: 1, status: 200, ms: 100 + i * 10, upstream_ms: 95 + i * 10 }).run();
	await finishStatement(D, { call_id: id(), ts: iso(50_000), worker: 'proxy', method: 'POST', endpoint: '/v1/contacts', outcome: 'error', version: VERSION, caller: 'outlook-addin', has_key: 1, status: 422, ms: 80, upstream_ms: 79, failure_category: 'input_validation', reply_reason: 'apollo_status' }).run();
	await finishStatement(D, { call_id: id(), ts: iso(40_000), worker: 'images', method: 'POST', endpoint: '/img', outcome: 'success', version: VERSION, caller: 'outlook-addin', has_key: 1, status: 200, ms: 300, upstream_ms: 250, key_check: 'firm', upstream_status: 200, content_type: 'image/png', upload_bytes: 20_000, deduped: 0 }).run();
	// A call that started an hour ago and never finished, and one still running.
	await startStatement(D, { call_id: id(), ts: iso(3_600_000), worker: 'proxy', method: 'PUT', endpoint: '/v1/emailer_messages/5f2b9c1e8d4a7b3c6e0f1a2b', version: VERSION, caller: 'outlook-addin', has_key: 1 }).run();
	await startStatement(D, { call_id: id(), ts: iso(1_000), worker: 'proxy', method: 'GET', endpoint: '/v1/email_accounts', version: VERSION, caller: 'outlook-addin', has_key: 1 }).run();
	// A row from before this log.
	db.prepare('INSERT INTO calls (ts, worker, method, endpoint, status, ms) VALUES (?, ?, ?, ?, ?, ?)').run(iso(86_400_000), 'proxy', 'GET', '/v1/email_accounts', 200, 3440);
	return db;
}

test('arguments', () => {
	assert.deepEqual(parseArgs([]), { days: 30, tool: null, health: false });
	assert.deepEqual(parseArgs(['--days', '7', '--tool', '/v1/contacts/{id}']), { days: 7, tool: '/v1/contacts/{id}', health: false });
	assert.deepEqual(parseArgs(['--tool', 'images']).tool, 'images');
	assert.equal(parseArgs(['--health']).health, true);
	for (const bad of [['--days', '0'], ['--days', 'x'], ['--tool', "/v1/'; DROP TABLE calls"], ['--tool', 'other'], ['--nope']]) assert.throws(() => parseArgs(bad));
});

test('the report SQL runs on the real schema and reads the real writer\'s rows', async () => {
	const db = await seeded();
	const r = runReport(db, { days: 30, tool: null });
	const [byOutcome, byCaller, successes, failures, slowest, interrupted, legacy, first] = r;
	assert.ok(byOutcome.some((x) => x.endpoint === '/v1/emailer_messages/{id}' && x.outcome === 'interrupted' && x.n === 1));
	assert.ok(byOutcome.some((x) => x.endpoint === '/v1/email_accounts' && x.outcome === 'started' && x.n === 1));
	assert.deepEqual(byCaller.map((x) => [x.worker, x.caller, x.n]).sort(), [['images', 'outlook-addin', 1], ['proxy', 'outlook-addin', 9]]);
	assert.equal(successes.length, 7);
	assert.deepEqual(failures.map((x) => [x.endpoint, x.category, x.reason, x.status]), [['/v1/contacts', 'input_validation', 'apollo_status', 422]]);
	assert.equal(slowest[0].endpoint, '/img');
	assert.deepEqual(interrupted.map((x) => [x.endpoint, x.n]), [['/v1/emailer_messages/{id}', 1]]);
	assert.deepEqual(legacy.map((x) => [x.worker, x.n]), [['proxy', 1]]);
	assert.ok(first[0].first);
	const text = formatReport({ days: 30, tool: null }, r);
	assert.match(text, /POST \/v1\/contacts\/search\s+p50 120, p90 150 \(6 calls\)/);
	assert.match(text, /images\s+upload 10-100 KB, new\s+0f5e3a52\s+too few calls \(1\)/);
	assert.match(text, /Rows from before this log/);
	const filtered = runReport(db, { days: 30, tool: 'images' });
	assert.equal(filtered[2].length, 1);
	assert.equal(runReport(db, { days: 30, tool: '/v1/contacts' })[3].length, 1);
});

test('percentiles carry their count and say "too few calls" below the bar', () => {
	assert.equal(MIN_CALLS, 5);
	assert.equal(percentile([], 50), null);
	assert.equal(percentile([5, 1, 3], 50), 3);
	assert.equal(stat([1, 2, 3, 4]), 'too few calls (4)');
	assert.equal(stat([1, 2, 3, 4, 5]), 'p50 3, p90 5 (5 calls)');
});

test('workload bands', () => {
	assert.equal(bandOf({ worker: 'proxy', method: 'POST', endpoint: '/v1/contacts/search' }), 'POST /v1/contacts/search');
	assert.equal(bandOf({ worker: 'images', method: 'POST', endpoint: '/img', upload_bytes: 900, deduped: 1 }), 'upload under 10 KB, deduped');
	assert.equal(bandOf({ worker: 'images', method: 'POST', endpoint: '/img', upload_bytes: 500_000, deduped: 0 }), 'upload 100 KB-2 MB, new');
});

test('health verdict: lost or unbound writes fail, none is not read as fine without saying why', () => {
	assert.equal(formatHealth([]).ok, true);
	assert.match(formatHealth([]).text, /No log writes recorded/);
	assert.equal(formatHealth([{ worker: 'proxy', kind: 'finish', result: 'written', n: 4 }]).ok, true);
	const bad = formatHealth([{ worker: 'images', kind: 'start', result: 'lost', n: 2 }]);
	assert.equal(bad.ok, false);
	assert.match(bad.text, /LOST WRITES: 2/);
	assert.equal(formatHealth([{ worker: 'proxy', kind: 'finish', result: 'no_binding', n: 1 }]).ok, false);
});

test('D1 response shape is checked', () => {
	assert.throws(() => validateD1Response([{ success: true, results: [] }], STATEMENTS));
	assert.throws(() => validateD1Response(null, 1));
});

test('the repo\'s performance log parses cleanly, and malformed entries fail loudly', () => {
	const real = formatPerformanceLog(readFileSync(path.join(REPO, 'docs/PERFORMANCE_LOG.md'), 'utf8'));
	assert.equal(real.ok, true, real.text);
	assert.equal(formatPerformanceLog(null).ok, false);
	const base = readFileSync(path.join(REPO, 'docs/PERFORMANCE_LOG.md'), 'utf8');
	const bad = formatPerformanceLog(base + '\n## P1: faster search\n\n- Status: live verified\n- Tool or path: /v1/contacts/search\n');
	assert.equal(bad.ok, false);
	assert.match(bad.text, /missing field "Merged"/);
	assert.match(bad.text, /needs Live before\/after/);
});
