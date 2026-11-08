// The CORS proxy with its usage log: every reply byte-identical with logging on, off, failing and
// hanging; one complete row per proxied call; nothing private in any row.
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { VERSION, allValues, analytics, context, d1, failingD1, fakeKey, hangingD1, snapshot, sqlite, stubFetch } from './helpers.mjs';

const BASE = 'https://stormsearch-apollo-proxy.example';
const ADDIN = 'https://nicka2717.github.io';
const ID = '5f2b9c1e8d4a7b3c6e0f1a2b';
const EMAIL = 'someone@example.com';

// A fixed Apollo: answers by path, with the headers the proxy strips and keeps.
function apollo(req) {
	const u = new URL(req.url);
	const headers = {
		'content-type': 'application/json; charset=utf-8',
		'set-cookie': 'session=abc',
		'strict-transport-security': 'max-age=1',
		'x-frame-options': 'DENY',
		'content-security-policy': "default-src 'none'",
		'x-rate-limit-minute': '200',
	};
	if (u.pathname.endsWith('/fail')) throw new TypeError('fetch failed: connection reset');
	if (u.pathname === '/v1/auth/health') return new Response(JSON.stringify({ healthy: true, is_logged_in: !!req.headers.get('x-api-key') }), { status: 200, statusText: 'OK', headers });
	if (u.pathname === '/v1/contacts' && req.method === 'POST') return new Response('{"error":"bad input"}', { status: 422, statusText: 'Unprocessable Entity', headers });
	if (u.pathname.startsWith('/v1/rate')) return new Response('{}', { status: 429, statusText: 'Too Many Requests', headers });
	return new Response(JSON.stringify({ path: u.pathname, query: u.search, method: req.method }), { status: 200, statusText: 'OK', headers });
}

// The requests every mode is checked against.
function requests() {
	const key = fakeKey();
	const json = (method, path, body, extra = {}) =>
		new Request(BASE + path, {
			method,
			headers: { Origin: ADDIN, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'X-Api-Key': key, Cookie: 'x=1', ...extra },
			body: body == null ? undefined : JSON.stringify(body),
		});
	return [
		['preflight', new Request(BASE + '/v1/contacts/search', { method: 'OPTIONS', headers: { Origin: ADDIN } })],
		['preflight foreign', new Request(BASE + '/v1/contacts/search', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } })],
		['health', new Request(BASE + '/health', { headers: { Origin: ADDIN } })],
		['root', new Request(BASE + '/')],
		['search', json('POST', '/v1/contacts/search', { q_keywords: EMAIL, per_page: 5 })],
		['sequences', json('POST', '/v1/emailer_campaigns/search', { per_page: 100, page: 1 })],
		['accounts', json('GET', '/v1/email_accounts')],
		['contact by id with query', json('GET', `/v1/contacts/${ID}?email=${encodeURIComponent(EMAIL)}`)],
		['add to sequence', json('POST', `/v1/emailer_campaigns/${ID}/add_contact_ids`, { contact_ids: [ID], send_email_from_email_account_id: ID })],
		['update message', json('PUT', `/v1/emailer_messages/${ID}`, { body_html: `<p>Hi ${EMAIL}</p>` })],
		['create contact refused', json('POST', '/v1/contacts', { email: EMAIL })],
		['rate limited', json('GET', '/v1/rate')],
		['email in path', json('GET', `/v1/contacts/${EMAIL}`)],
		['keyless no origin', new Request(BASE + '/v1/auth/health')],
		['keyed office host', json('GET', '/v1/auth/health', null, { Origin: 'https://outlook.office.com' })],
		['foreign origin', json('GET', '/v1/auth/health', null, { Origin: 'https://evil.example' })],
		['apollo unreachable', json('GET', '/v1/fail')],
	];
}

async function runAll(env, ctxFactory = context, impl = worker) {
	const stub = stubFetch(apollo);
	const out = [];
	const ctxs = [];
	try {
		for (const [name, req] of requests()) {
			const ctx = ctxFactory();
			ctxs.push(ctx);
			out.push([name, await snapshot(await impl.fetch(req, env, ctx))]);
		}
	} finally {
		stub.restore();
	}
	return { out, ctxs, upstream: stub.seen };
}

const settleAll = (ctxs) => Promise.all(ctxs.map((c) => c.settle && c.settle()));

test('every reply is byte-identical with logging on, off, failing, hanging and with no waitUntil', async (t) => {
	// /health carries the time; freeze the clock so its body compares too.
	t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-08T12:00:00.000Z') });
	const off = await runAll({});
	const db = sqlite();
	const on = await runAll({ CALL_LOG: d1(db), USAGE_HEALTH: analytics(), CF_VERSION_METADATA: { id: VERSION } });
	await settleAll(on.ctxs);
	const failing = await runAll({ CALL_LOG: failingD1(), USAGE_HEALTH: analytics() });
	await settleAll(failing.ctxs);
	const throwing = await runAll({ CALL_LOG: failingD1('throw'), USAGE_HEALTH: { writeDataPoint: () => { throw new Error('x'); } } });
	await settleAll(throwing.ctxs);
	const hanging = await runAll({ CALL_LOG: hangingD1() });
	const bare = await runAll({ CALL_LOG: d1(sqlite()) }, () => ({}));
	for (const mode of [on, failing, throwing, hanging, bare]) assert.deepEqual(mode.out, off.out);
	// And the request Apollo saw is the same in every mode.
	const sent = (r) => r.upstream.map((q) => [q.method, q.url, [...q.headers].sort()]);
	for (const mode of [on, failing, throwing, hanging, bare]) assert.deepEqual(sent(mode), sent(off));
});

test('a thrown request is rethrown unchanged and leaves an error row', async () => {
	const db = sqlite();
	const ctx = context();
	const boom = new Error('body read failed');
	const req = new Request(BASE + '/v1/contacts', { method: 'POST', headers: { Origin: ADDIN }, body: '{}' });
	req.arrayBuffer = () => Promise.reject(boom);
	await assert.rejects(worker.fetch(req, { CALL_LOG: d1(db) }, ctx), (e) => e === boom);
	await ctx.settle();
	const r = db.prepare('SELECT outcome, failure_category, reply_reason, status FROM calls').get();
	assert.deepEqual({ ...r }, { outcome: 'error', failure_category: 'internal', reply_reason: 'thrown', status: null });
});

test('one complete row per proxied call, none for preflight or health', async () => {
	const db = sqlite();
	const ae = analytics();
	const { ctxs } = await runAll({ CALL_LOG: d1(db), USAGE_HEALTH: ae, CF_VERSION_METADATA: { id: VERSION } });
	await settleAll(ctxs);
	const rows = db.prepare('SELECT worker, method, endpoint, outcome, version, caller, has_key, status, failure_category, reply_reason, ms IS NOT NULL AS timed, upstream_ms IS NOT NULL AS apollo_timed, call_id IS NOT NULL AS has_id FROM calls ORDER BY id').all();
	const want = [
		['POST', '/v1/contacts/search', 'success', 'outlook-addin', 1, 200, null, null],
		['POST', '/v1/emailer_campaigns/search', 'success', 'outlook-addin', 1, 200, null, null],
		['GET', '/v1/email_accounts', 'success', 'outlook-addin', 1, 200, null, null],
		['GET', '/v1/contacts/{id}', 'success', 'outlook-addin', 1, 200, null, null],
		['POST', '/v1/emailer_campaigns/{id}/add_contact_ids', 'success', 'outlook-addin', 1, 200, null, null],
		['PUT', '/v1/emailer_messages/{id}', 'success', 'outlook-addin', 1, 200, null, null],
		['POST', '/v1/contacts', 'error', 'outlook-addin', 1, 422, 'input_validation', 'apollo_status'],
		['GET', '/v1/?', 'error', 'outlook-addin', 1, 429, 'rate_limit', 'apollo_status'],
		['GET', '/v1/contacts/?', 'success', 'outlook-addin', 1, 200, null, null],
		['GET', '/v1/auth/health', 'success', 'no-origin', 0, 200, null, null],
		['GET', '/v1/auth/health', 'success', 'office-host', 1, 200, null, null],
		['GET', '/v1/auth/health', 'success', 'other-origin', 1, 200, null, null],
		['GET', '/v1/?', 'error', 'outlook-addin', 1, 502, 'upstream_error', 'upstream_fetch_failed'],
	];
	assert.deepEqual(
		rows.map((r) => [r.method, r.endpoint, r.outcome, r.caller, r.has_key, r.status, r.failure_category, r.reply_reason]),
		want,
	);
	for (const r of rows) {
		assert.equal(r.worker, 'proxy');
		assert.equal(r.version, VERSION);
		assert.equal(r.timed, 1);
		assert.equal(r.apollo_timed, 1);
		assert.equal(r.has_id, 1);
	}
	assert.equal(ae.points.length, want.length * 2);
	assert.ok(ae.points.every((p) => p.blobs[0] === 'proxy' && p.blobs[2] === 'written'));
});

test('no key, body, query, email, cookie or error text reaches a row', async () => {
	const db = sqlite();
	const { ctxs } = await runAll({ CALL_LOG: d1(db), USAGE_HEALTH: analytics(), CF_VERSION_METADATA: { id: VERSION } });
	await settleAll(ctxs);
	const all = allValues(db);
	const key = fakeKey();
	for (let i = 0; i + 8 <= key.length; i++) assert.ok(!all.includes(key.slice(i, i + 8)), 'a fragment of the key reached a row');
	for (const banned of [EMAIL, 'someone', 'example.com', '@', 'q_keywords', 'per_page', 'body_html', 'email=', '?email', 'session=', 'x=1', 'connection reset', 'fetch failed', 'nicka2717', 'evil', 'office.com', ID])
		assert.ok(!all.includes(banned), `"${banned}" reached a row`);
	assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calls WHERE detail IS NOT NULL').get().n, 0);
});

// Optional: the Worker as it was before this log, run from a copy outside the repo
// (PROXY_ORACLE=/path/to/old-index.mjs npm test). The old code is given no CALL_LOG, so it writes nothing.
const oraclePath = process.env.PROXY_ORACLE;
test('replies match the Worker before this log', { skip: !oraclePath && 'set PROXY_ORACLE to compare' }, async (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-08T12:00:00.000Z') });
	const before = (await import(pathToFileURL(oraclePath).href)).default;
	const old = await runAll({}, context, before);
	const now = await runAll({ CALL_LOG: d1(sqlite()), USAGE_HEALTH: analytics(), CF_VERSION_METADATA: { id: VERSION } });
	await settleAll(now.ctxs);
	assert.deepEqual(now.out, old.out);
	assert.ok(old.out.length > 10);
});
