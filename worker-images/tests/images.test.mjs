// The images Worker with its usage log: every reply byte-identical with logging on, off, failing
// and hanging; one row per upload and per failed request; nothing for a served image; nothing
// private in any row.
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { VERSION, allValues, analytics, context, d1, failingD1, fakeKey, hangingD1, snapshot, sqlite, stubFetch } from '../../worker/tests/helpers.mjs';

const BASE = 'https://apollo-addin-images.example';
const ADDIN = 'https://nicka2717.github.io';
const TEAM = 'team-firm';
const STORED = 'a'.repeat(32);
const PNG = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const STORED_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]);

// Keys the fake Apollo answers for: each built at run time, never a constant.
const keys = () => ({ firm: fakeKey(), other: fakeKey() + 'Other', refused: fakeKey() + 'Refused', limited: fakeKey() + 'Limited', down: fakeKey() + 'Down', garbled: fakeKey() + 'Garbled' });

function apollo(req) {
	const k = keys();
	const key = req.headers.get('x-api-key');
	if (key === k.down) throw new TypeError('fetch failed');
	if (key === k.refused) return new Response('{"error":"invalid"}', { status: 401 });
	if (key === k.limited) return new Response('{}', { status: 429 });
	if (key === k.garbled) return new Response('<html>', { status: 200 });
	const team = key === k.firm ? TEAM : 'team-elsewhere';
	return Response.json({ user: { team_id: team, email: 'someone@example.com', name: 'Jane Doe' } });
}

// A KV namespace in memory. Random public keys are made deterministic per run by the test.
function kv(seed = {}) {
	const m = new Map(Object.entries(seed));
	return {
		map: m,
		get: async (k) => (m.has(k) ? m.get(k).value : null),
		getWithMetadata: async (k) => (m.has(k) ? { value: m.get(k).value, metadata: m.get(k).metadata } : { value: null, metadata: null }),
		put: async (k, value, opts = {}) => void m.set(k, { value, metadata: opts.metadata }),
	};
}
const seededKv = () => kv({ [`i:${STORED}`]: { value: STORED_BYTES.buffer.slice(0), metadata: { ct: 'image/png' } } });

function requests() {
	const k = keys();
	const post = (key, ct, body, extra = {}) =>
		new Request(BASE + '/img', { method: 'POST', headers: { Origin: ADDIN, ...(ct ? { 'Content-Type': ct } : {}), ...(key ? { 'X-Api-Key': key } : {}), ...extra }, body });
	return [
		['preflight', new Request(BASE + '/img', { method: 'OPTIONS', headers: { Origin: ADDIN } })],
		['health', new Request(BASE + '/health')],
		['served image', new Request(BASE + `/img/${STORED}`, { headers: { Origin: 'https://outlook.office.com' } })],
		['missing image', new Request(BASE + `/img/${'0'.repeat(32)}`)],
		['malformed image path', new Request(BASE + '/img/someone@example.com')],
		['other path', new Request(BASE + '/admin?token=x')],
		['unsupported type', post(k.firm, 'text/plain', 'x')],
		['too large declared', post(k.firm, 'image/png', PNG(), { 'Content-Length': String(3 * 1024 * 1024) })],
		['no key', post(null, 'image/png', PNG())],
		['refused key', post(k.refused, 'image/png', PNG())],
		['rate limited check', post(k.limited, 'image/png', PNG())],
		['apollo down', post(k.down, 'image/png', PNG())],
		['garbled check', post(k.garbled, 'image/png', PNG())],
		['not firm', post(k.other, 'image/png', PNG())],
		['empty body', post(k.firm, 'image/png', new Uint8Array(0))],
		['content mismatch', post(k.firm, 'image/gif', PNG())],
		['upload', post(k.firm, 'image/png; charset=binary', PNG())],
		['upload again (dedupe)', post(k.firm, 'image/png', PNG())],
	];
}

async function runAll(logEnv, ctxFactory = context, envExtra = {}, impl = worker) {
	const stub = stubFetch(apollo);
	const realRandom = crypto.getRandomValues.bind(crypto);
	crypto.getRandomValues = (buf) => buf.fill(7); // deterministic public keys
	const env = { IMG: seededKv(), FIRM_TEAM_ID: TEAM, ...logEnv, ...envExtra };
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
		crypto.getRandomValues = realRandom;
	}
	return { out, ctxs, env, upstream: stub.seen };
}

const settleAll = (ctxs) => Promise.all(ctxs.map((c) => c.settle && c.settle()));
const on = (db, ae = analytics()) => ({ CALL_LOG: d1(db), USAGE_HEALTH: ae, CF_VERSION_METADATA: { id: VERSION } });

test('every reply is byte-identical with logging on, off, failing, hanging and with no waitUntil', async (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-08T12:00:00.000Z') });
	const off = await runAll({});
	const logged = await runAll(on(sqlite()));
	await settleAll(logged.ctxs);
	const failing = await runAll({ CALL_LOG: failingD1(), USAGE_HEALTH: analytics() });
	await settleAll(failing.ctxs);
	const throwing = await runAll({ CALL_LOG: failingD1('throw'), USAGE_HEALTH: { writeDataPoint: () => { throw new Error('x'); } } });
	await settleAll(throwing.ctxs);
	const hanging = await runAll({ CALL_LOG: hangingD1() });
	const bare = await runAll({ CALL_LOG: d1(sqlite()) }, () => ({}));
	for (const mode of [logged, failing, throwing, hanging, bare]) assert.deepEqual(mode.out, off.out);
	// The same KV writes and the same Apollo checks in every mode.
	const store = (r) => [...r.env.IMG.map.keys()].sort();
	const sent = (r) => r.upstream.map((q) => [q.method, q.url, q.headers.get('x-api-key')]);
	for (const mode of [logged, failing, throwing, hanging, bare]) {
		assert.deepEqual(store(mode), store(off));
		assert.deepEqual(sent(mode), sent(off));
	}
	// The key check is still fail-closed: every refusal answers the same 401.
	const replies = Object.fromEntries(off.out);
	for (const n of ['no key', 'refused key', 'rate limited check', 'apollo down', 'garbled check', 'not firm']) {
		assert.equal(replies[n].status, 401, n);
		assert.equal(Buffer.from(replies[n].body, 'base64').toString(), '{"error":"invalid_api_key"}', n);
	}
	assert.equal(replies['upload'].status, 200);
	assert.equal(replies['served image'].status, 200);
});

test('no team configured still refuses every upload, as before', async () => {
	const db = sqlite();
	const { out, ctxs } = await runAll(on(db), context, { FIRM_TEAM_ID: '' });
	await settleAll(ctxs);
	assert.equal(Object.fromEntries(out)['upload'].status, 401);
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM calls WHERE key_check = 'no_team_config' AND failure_category = 'internal'").get().n, 9);
});

test('rows: one per upload and per failed request, none for preflight, health or a served image', async () => {
	const db = sqlite();
	const ae = analytics();
	const { ctxs } = await runAll(on(db, ae));
	await settleAll(ctxs);
	const rows = db
		.prepare('SELECT method, endpoint, outcome, caller, has_key, status, failure_category, reply_reason, key_check, upstream_status, upstream_ms IS NOT NULL AS apollo_timed, content_type, upload_bytes, deduped FROM calls ORDER BY id')
		.all()
		.map((r) => Object.values(r));
	// Rows land in write order, not request order (a failed fetch writes only at its end).
	const sorted = (list) => list.map((r) => JSON.stringify(r)).sort();
	assert.deepEqual(sorted(rows), sorted([
		['GET', '/img/{id}', 'error', 'no-origin', 0, 404, 'input_validation', 'not_found', null, null, 0, null, null, null],
		['GET', '/img/?', 'error', 'no-origin', 0, 404, 'input_validation', 'not_found', null, null, 0, null, null, null],
		['GET', '/?', 'error', 'no-origin', 0, 404, 'input_validation', 'not_found', null, null, 0, null, null, null],
		['POST', '/img', 'error', 'outlook-addin', 1, 415, 'input_validation', 'unsupported_content_type', null, null, 0, '?', null, null],
		['POST', '/img', 'error', 'outlook-addin', 1, 413, 'input_validation', 'too_large', null, null, 0, 'image/png', null, null],
		['POST', '/img', 'error', 'outlook-addin', 0, 401, 'authentication', 'invalid_api_key', 'no_key', null, 0, 'image/png', null, null],
		['POST', '/img', 'error', 'outlook-addin', 1, 401, 'authentication', 'invalid_api_key', 'rejected', 401, 1, 'image/png', null, null],
		['POST', '/img', 'error', 'outlook-addin', 1, 401, 'rate_limit', 'invalid_api_key', 'rejected', 429, 1, 'image/png', null, null],
		['POST', '/img', 'error', 'outlook-addin', 1, 401, 'upstream_error', 'invalid_api_key', 'unreachable', null, 1, 'image/png', null, null],
		['POST', '/img', 'error', 'outlook-addin', 1, 401, 'upstream_error', 'invalid_api_key', 'unreadable', 200, 1, 'image/png', null, null],
		['POST', '/img', 'error', 'outlook-addin', 1, 401, 'authentication', 'invalid_api_key', 'not_firm', 200, 1, 'image/png', null, null],
		['POST', '/img', 'error', 'outlook-addin', 1, 400, 'input_validation', 'empty_body', 'firm', 200, 1, 'image/png', 0, null],
		['POST', '/img', 'error', 'outlook-addin', 1, 415, 'input_validation', 'content_mismatch', 'firm', 200, 1, 'image/gif', 12, null],
		['POST', '/img', 'success', 'outlook-addin', 1, 200, null, null, 'firm', 200, 1, 'image/png', 12, 0],
		['POST', '/img', 'success', 'outlook-addin', 1, 200, null, null, 'firm', 200, 1, 'image/png', 12, 1],
	]));
	for (const r of db.prepare('SELECT worker, version, ms, call_id, detail FROM calls').all()) {
		assert.equal(r.worker, 'images');
		assert.equal(r.version, VERSION);
		assert.ok(r.ms != null && r.call_id);
		assert.equal(r.detail, null);
	}
	// Uploads write start + finish; failed fetches write only their finished row.
	assert.equal(ae.points.length, 12 * 2 + 3);
	assert.ok(ae.points.every((p) => p.blobs[0] === 'images'));
});

test('a served image leaves no row and no health point, even when the fetch is the only request', async () => {
	const db = sqlite();
	const ae = analytics();
	const ctx = context();
	const res = await worker.fetch(new Request(BASE + `/img/${STORED}`, { headers: { Origin: ADDIN } }), { IMG: seededKv(), ...on(db, ae) }, ctx);
	assert.equal(res.status, 200);
	await ctx.settle();
	assert.equal(ctx.pending.length, 0);
	assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calls').get().n, 0);
	assert.equal(ae.points.length, 0);
});

test('a thrown upload is rethrown unchanged and leaves an internal error row', async () => {
	const db = sqlite();
	const ctx = context();
	const boom = new Error('KV exploded with someone@example.com');
	const env = { ...on(db), FIRM_TEAM_ID: TEAM, IMG: { ...seededKv(), get: () => Promise.reject(boom) } };
	const stub = stubFetch(apollo);
	try {
		const req = new Request(BASE + '/img', { method: 'POST', headers: { Origin: ADDIN, 'Content-Type': 'image/png', 'X-Api-Key': fakeKey() }, body: PNG() });
		await assert.rejects(worker.fetch(req, env, ctx), (e) => e === boom);
	} finally {
		stub.restore();
	}
	await ctx.settle();
	const r = db.prepare('SELECT outcome, status, failure_category, reply_reason, key_check, detail FROM calls').get();
	assert.deepEqual({ ...r }, { outcome: 'error', status: 500, failure_category: 'internal', reply_reason: 'thrown', key_check: 'firm', detail: null });
	assert.ok(!allValues(db).includes('exploded'));
});

test('no key, image, hash, public key, email, name or query reaches a row', async () => {
	const db = sqlite();
	const { ctxs, env } = await runAll(on(db));
	await settleAll(ctxs);
	const all = allValues(db);
	for (const key of Object.values(keys())) for (let i = 0; i + 8 <= key.length; i++) assert.ok(!all.includes(key.slice(i, i + 8)), 'a fragment of a key reached a row');
	const publicKeys = [...env.IMG.map.keys()].filter((k) => /^[ih]:/.test(k)).map((k) => k.slice(2));
	assert.ok(publicKeys.length >= 3);
	for (const k of [...publicKeys, STORED]) assert.ok(!all.includes(k.slice(0, 12)), 'an image or hash key reached a row');
	for (const banned of ['someone', '@', 'example', 'Jane', 'token=', 'admin', 'team-', 'charset', 'text/plain', 'nicka2717', 'office.com', 'bytes'])
		assert.ok(!all.includes(banned), `"${banned}" reached a row`);
});

// Optional: the Worker as it was before this log, run from a copy outside the repo
// (IMAGES_ORACLE=/path/to/old-index.mjs npm test). The old code is given no CALL_LOG, so it writes nothing.
const oraclePath = process.env.IMAGES_ORACLE;
test('replies match the Worker before this log', { skip: !oraclePath && 'set IMAGES_ORACLE to compare' }, async (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-08T12:00:00.000Z') });
	const before = (await import(pathToFileURL(oraclePath).href)).default;
	const old = await runAll({}, context, {}, before);
	const now = await runAll(on(sqlite()));
	await settleAll(now.ctxs);
	assert.deepEqual(now.out, old.out);
	assert.ok(old.out.length > 10);
});
