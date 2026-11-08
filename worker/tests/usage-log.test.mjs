// The shared usage-log module: schema and vocabularies pinned, values re-checked, both landing
// orders of the two writes, pruning, and delivery health.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	CALLERS,
	COLUMNS,
	CONTENT_TYPES,
	FAILURE_CATEGORIES,
	HEALTH_KINDS,
	HEALTH_RESULTS,
	KEY_CHECKS,
	METHODS,
	OUTCOMES,
	PATH_WORDS,
	REPLY_REASONS,
	WORKERS,
	beginCall,
	callerOf,
	categoryOfStatus,
	finishFields,
	finishStatement,
	pathShape,
	pruneStatements,
	sanitizeRow,
	startStatement,
	versionOf,
	writeFinish,
	writeStart,
} from '../src/usage-log.js';
import { VERSION, analytics, context, d1, failingD1, hangingD1, migrationFiles, sqlite } from './helpers.mjs';

test('schema: the migrations give exactly the legacy columns plus COLUMNS, all new ones nullable', () => {
	const db = sqlite();
	const cols = db.prepare('PRAGMA table_info(calls)').all();
	const names = cols.map((c) => c.name);
	assert.deepEqual(names, ['id', 'ts', 'worker', 'method', 'endpoint', 'status', 'ms', 'detail', ...COLUMNS.filter((c) => !['ts', 'worker', 'method', 'endpoint', 'status', 'ms'].includes(c))]);
	for (const c of cols.filter((c) => !['id', 'ts', 'worker', 'method', 'endpoint'].includes(c.name))) assert.equal(c.notnull, 0, `${c.name} must be nullable`);
	const indexes = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'calls'").all();
	assert.ok(indexes.some((i) => i.name === 'calls_call_id' && /UNIQUE/.test(i.sql)));
	assert.deepEqual(migrationFiles(), ['0001_calls.sql', '0002_usage_log.sql']);
});

test('schema: the version before this log can still insert its seven-column rows after the migration', () => {
	const db = sqlite();
	db.prepare('INSERT INTO calls (ts, worker, method, endpoint, status, ms, detail) VALUES (?, ?, ?, ?, ?, ?, ?)').run('2026-11-08T00:00:00.000Z', 'proxy', 'GET', '/v1/email_accounts', 200, 10, null);
	db.prepare('INSERT INTO calls (ts, worker, method, endpoint, status, ms, detail) VALUES (?, ?, ?, ?, ?, ?, ?)').run('2026-11-08T00:00:01.000Z', 'proxy', 'GET', '/v1/email_accounts', 200, 10, null);
	assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calls').get().n, 2);
});

test('vocabularies are pinned', () => {
	assert.deepEqual(WORKERS, ['proxy', 'images']);
	assert.deepEqual(OUTCOMES, ['started', 'success', 'error']);
	assert.deepEqual(CALLERS, ['outlook-addin', 'office-host', 'other-origin', 'no-origin']);
	assert.deepEqual(FAILURE_CATEGORIES, ['input_validation', 'authentication', 'rate_limit', 'upstream_timeout', 'upstream_error', 'internal']);
	assert.deepEqual(REPLY_REASONS, ['apollo_status', 'upstream_fetch_failed', 'thrown', 'not_found', 'unsupported_content_type', 'too_large', 'invalid_api_key', 'quota_exceeded', 'empty_body', 'content_mismatch']);
	assert.deepEqual(KEY_CHECKS, ['no_key', 'no_team_config', 'unreachable', 'rejected', 'unreadable', 'not_firm', 'firm']);
	assert.deepEqual(CONTENT_TYPES, ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/bmp']);
	assert.deepEqual(METHODS, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
	assert.deepEqual(HEALTH_KINDS, ['start', 'finish']);
	assert.deepEqual(HEALTH_RESULTS, ['written', 'lost', 'no_binding']);
	assert.deepEqual(PATH_WORDS, ['v1', 'api', 'auth', 'health', 'contacts', 'search', 'emailer_campaigns', 'add_contact_ids', 'emailer_messages', 'email_accounts', 'users', 'api_profile', 'img']);
});

test('path shape: every path the add-in calls, record ids as {id}, anything else as ?', () => {
	const id = '5f2b9c1e8d4a7b3c6e0f1a2b';
	const cases = {
		'/v1/emailer_campaigns/search': '/v1/emailer_campaigns/search',
		'/v1/email_accounts': '/v1/email_accounts',
		'/v1/contacts/search': '/v1/contacts/search',
		'/v1/contacts': '/v1/contacts',
		[`/v1/emailer_campaigns/${id}/add_contact_ids`]: '/v1/emailer_campaigns/{id}/add_contact_ids',
		[`/v1/contacts/${id}`]: '/v1/contacts/{id}',
		'/v1/emailer_messages/search': '/v1/emailer_messages/search',
		[`/v1/emailer_messages/${id}`]: '/v1/emailer_messages/{id}',
		'/v1/auth/health': '/v1/auth/health',
		'/api/v1/users/api_profile': '/api/v1/users/api_profile',
		[`/img/${'a'.repeat(32)}`]: '/img/{id}',
		'/img': '/img',
		'/v1/contacts/someone@example.com': '/v1/contacts/?',
		'/v1/contacts/Jane%20Doe': '/v1/contacts/?',
		'/v1/people/match': '/v1/?/?',
		'/v1/contacts/': '/v1/contacts/',
		'/a/b/c/d/e/f/g/h/i': '?',
		'v1/contacts': '?',
	};
	for (const [p, want] of Object.entries(cases)) assert.equal(pathShape(p), want, p);
	assert.equal(pathShape(null), '?');
});

test('caller class from the Origin header only', () => {
	assert.equal(callerOf('https://nicka2717.github.io'), 'outlook-addin');
	assert.equal(callerOf('https://outlook.office.com'), 'office-host');
	assert.equal(callerOf('https://abc-1.officeapps.live.com'), 'office-host');
	assert.equal(callerOf('https://evil.example'), 'other-origin');
	assert.equal(callerOf('https://nicka2717.github.io.evil.example'), 'other-origin');
	assert.equal(callerOf(''), 'no-origin');
	assert.equal(callerOf(null), 'no-origin');
});

test('version only as a UUID from CF_VERSION_METADATA', () => {
	assert.equal(versionOf({ CF_VERSION_METADATA: { id: VERSION } }), VERSION);
	assert.equal(versionOf({ CF_VERSION_METADATA: { id: 'not-a-version' } }), null);
	assert.equal(versionOf({}), null);
	assert.equal(versionOf(undefined), null);
	assert.equal(
		versionOf({
			get CF_VERSION_METADATA() {
				throw new Error('x');
			},
		}),
		null,
	);
});

test('status mapping and outcome rules are pinned', () => {
	const map = { 200: null, 204: null, 302: null, 400: 'input_validation', 401: 'authentication', 403: 'authentication', 404: 'input_validation', 408: 'upstream_timeout', 422: 'input_validation', 429: 'rate_limit', 500: 'upstream_error', 502: 'upstream_error', 504: 'upstream_timeout', 524: 'upstream_timeout' };
	for (const [s, c] of Object.entries(map)) assert.equal(categoryOfStatus(Number(s)), c, s);
	assert.deepEqual(finishFields({ status: 200 }, false), { outcome: 'success', failure_category: null, reply_reason: null });
	assert.deepEqual(finishFields({ status: 422 }, false), { outcome: 'error', failure_category: 'input_validation', reply_reason: 'apollo_status' });
	assert.deepEqual(finishFields({ status: 429 }, false), { outcome: 'error', failure_category: 'rate_limit', reply_reason: 'apollo_status' });
	assert.deepEqual(finishFields({ status: 502, failure_category: 'upstream_error', reply_reason: 'upstream_fetch_failed' }, false), { outcome: 'error', failure_category: 'upstream_error', reply_reason: 'upstream_fetch_failed' });
	assert.deepEqual(finishFields({}, true), { outcome: 'error', failure_category: 'internal', reply_reason: 'thrown' });
	assert.deepEqual(finishFields({}, false), { outcome: 'error', failure_category: 'internal', reply_reason: 'apollo_status' });
});

test('sanitizeRow turns anything off-list into ? or null', () => {
	const r = sanitizeRow({
		call_id: 'nope',
		ts: 'yesterday',
		worker: 'someone@example.com',
		method: 'BREW',
		endpoint: '/v1/contacts/someone@example.com',
		outcome: 'fine',
		version: 'v2',
		caller: 'https://evil.example',
		has_key: 'yes',
		status: 999,
		ms: -5,
		upstream_ms: 'slow',
		upstream_status: 42,
		failure_category: 'kaboom',
		reply_reason: 'Error: something with text',
		key_check: 'maybe',
		content_type: 'text/html',
		upload_bytes: 1.5e3,
		deduped: 0,
	});
	assert.match(r.call_id, /^[0-9a-f-]{36}$/);
	assert.match(r.ts, /^\d{4}-\d{2}-\d{2}T/);
	assert.deepEqual(
		{ ...r, call_id: 'x', ts: 'x' },
		{
			call_id: 'x',
			ts: 'x',
			worker: '?',
			method: '?',
			endpoint: '/v1/contacts/?',
			outcome: 'error',
			version: '?',
			caller: '?',
			has_key: 1,
			status: null,
			ms: null,
			upstream_ms: null,
			upstream_status: null,
			failure_category: 'internal',
			reply_reason: 'thrown',
			key_check: '?',
			content_type: '?',
			upload_bytes: 1500,
			deduped: 0,
		},
	);
});

const row = (over = {}) => ({
	call_id: '3b0c6f3e-1d2a-4c5b-8e9f-0a1b2c3d4e5f',
	ts: '2026-11-08T12:00:00.000Z',
	worker: 'proxy',
	method: 'GET',
	endpoint: '/v1/email_accounts',
	outcome: 'success',
	version: VERSION,
	caller: 'outlook-addin',
	has_key: true,
	status: 200,
	ms: 40,
	upstream_ms: 38,
	...over,
});

test('start then finish, and finish then start, both leave one complete row', async () => {
	for (const order of ['start-first', 'finish-first']) {
		const db = sqlite();
		const D = d1(db);
		const steps = [() => startStatement(D, row()).run(), () => finishStatement(D, row()).run()];
		if (order === 'finish-first') steps.reverse();
		for (const s of steps) await s();
		const rows = db.prepare('SELECT * FROM calls').all();
		assert.equal(rows.length, 1, order);
		assert.equal(rows[0].outcome, 'success', order);
		assert.equal(rows[0].ms, 40, order);
		assert.equal(rows[0].upstream_ms, 38, order);
		assert.equal(rows[0].detail, null, order);
	}
});

test('a replayed finish never overwrites a finished row', async () => {
	const db = sqlite();
	const D = d1(db);
	await finishStatement(D, row()).run();
	await finishStatement(D, row({ status: 500, ms: 9999 })).run();
	const r = db.prepare('SELECT status, ms FROM calls').get();
	assert.deepEqual({ ...r }, { status: 200, ms: 40 });
});

test('prune: 365 days for new rows, the promised 90 for rows from before this log', async () => {
	const db = sqlite();
	const D = d1(db);
	const now = Date.parse('2026-11-08T00:00:00.000Z');
	const day = 86_400_000;
	const legacy = (ts) => db.prepare('INSERT INTO calls (ts, worker, method, endpoint, status, ms) VALUES (?, ?, ?, ?, ?, ?)').run(ts, 'proxy', 'GET', '/v1/email_accounts', 200, 1);
	legacy(new Date(now - 100 * day).toISOString());
	legacy(new Date(now - 10 * day).toISOString());
	await finishStatement(D, row({ ts: new Date(now - 100 * day).toISOString() })).run();
	await finishStatement(D, row({ call_id: 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d', ts: new Date(now - 400 * day).toISOString() })).run();
	await D.batch(pruneStatements(D, now));
	const left = db.prepare('SELECT call_id IS NULL AS legacy, ts FROM calls ORDER BY ts').all();
	assert.deepEqual(
		left.map((r) => ({ ...r })),
		[
			{ legacy: 0, ts: new Date(now - 100 * day).toISOString() },
			{ legacy: 1, ts: new Date(now - 10 * day).toISOString() },
		],
	);
});

test('delivery health: one point per write, written, lost or no_binding, never a throw', async () => {
	const ae = analytics();
	await writeStart({ CALL_LOG: d1(sqlite()), USAGE_HEALTH: ae }, row());
	await writeFinish({ CALL_LOG: failingD1(), USAGE_HEALTH: ae }, row());
	await writeFinish({ CALL_LOG: failingD1('throw'), USAGE_HEALTH: ae }, row());
	await writeStart({ USAGE_HEALTH: ae }, row({ worker: 'images' }));
	await writeFinish({ USAGE_HEALTH: { writeDataPoint: () => { throw new Error('ae down'); } } }, row());
	assert.deepEqual(
		ae.points.map((p) => p.blobs),
		[
			['proxy', 'start', 'written', VERSION],
			['proxy', 'finish', 'lost', VERSION],
			['proxy', 'finish', 'lost', VERSION],
			['images', 'start', 'no_binding', VERSION],
		],
	);
	assert.deepEqual(ae.points[0].indexes, ['proxy']);
});

test('the finish prune runs on its own share of writes and a failed prune is swallowed', async () => {
	const db = sqlite();
	const D = d1(db);
	let batches = 0;
	const counting = { ...D, batch: async (s) => (batches++, D.batch(s)) };
	await writeFinish({ CALL_LOG: counting }, row(), Date.now(), 0.5);
	assert.equal(batches, 0);
	await writeFinish({ CALL_LOG: counting }, row({ call_id: 'b1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d' }), Date.now(), 0.001);
	assert.equal(batches, 1);
	await writeFinish({ CALL_LOG: { ...D, batch: () => Promise.reject(new Error('x')) } }, row({ call_id: 'c1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d' }), Date.now(), 0);
});

test('beginCall never throws: no ctx, no waitUntil, a hostile request', async () => {
	const req = new Request('https://x.example/v1/email_accounts');
	for (const ctx of [undefined, {}, { waitUntil: () => { throw new Error('no'); } }]) {
		const call = beginCall({ CALL_LOG: d1(sqlite()) }, ctx, 'proxy', req, '/v1/email_accounts');
		call.set({ status: 200 });
		call.end();
		call.end({ thrown: true });
	}
	const call = beginCall({}, context(), 'proxy', { method: 'GET', get headers() { throw new Error('bad'); } }, '/x');
	call.set({ status: 200 });
	call.end();
});

test('end is once only, and start: false writes nothing until end', async () => {
	const db = sqlite();
	const ctx = context();
	const env = { CALL_LOG: d1(db) };
	const req = new Request('https://x.example/img/' + 'a'.repeat(32), { headers: { Origin: 'https://nicka2717.github.io' } });
	const quiet = beginCall(env, ctx, 'images', req, '/img/' + 'a'.repeat(32), { start: false });
	await ctx.settle();
	assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calls').get().n, 0);
	quiet.set({ status: 404, reply_reason: 'not_found', failure_category: 'input_validation' });
	quiet.end();
	quiet.end({ thrown: true });
	await ctx.settle();
	const rows = db.prepare('SELECT worker, method, endpoint, outcome, caller, status, reply_reason, failure_category FROM calls').all();
	assert.deepEqual(
		rows.map((r) => ({ ...r })),
		[{ worker: 'images', method: 'GET', endpoint: '/img/{id}', outcome: 'error', caller: 'outlook-addin', status: 404, reply_reason: 'not_found', failure_category: 'input_validation' }],
	);
});

test('a hanging D1 never holds up beginCall or end', async () => {
	const ctx = context();
	const t = Date.now();
	const call = beginCall({ CALL_LOG: hangingD1() }, ctx, 'proxy', new Request('https://x.example/v1/contacts'), '/v1/contacts');
	call.set({ status: 200 });
	call.end();
	assert.ok(Date.now() - t < 50);
	assert.equal(ctx.pending.length, 2);
});
