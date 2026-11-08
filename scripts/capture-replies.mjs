#!/usr/bin/env node
/**
 * Captures the two Workers' replies to a fixed set of harmless requests, so a deploy can be proven
 * to change nothing a user sees: run it before and after, then diff the two files.
 *
 * It never writes to Apollo and never uploads an image. The requests: CORS preflights (an allowed
 * and a foreign origin), each Worker's /health, keyless proxied calls, one read-only Apollo GET
 * (GET /v1/auth/health, no credits) sent with and without the add-in's Origin, a missing image, a
 * malformed image path, and two uploads the images Worker refuses before reading the body or
 * calling Apollo (an unsupported content type, and a PNG with no key).
 *
 * What it stores, never Apollo content: status, status text, every header name, the value of
 * headers that do not change per request (volatile ones become "<volatile>"), and the SHA-256 and
 * length of each body with its timestamps masked.
 *
 * Usage: node scripts/capture-replies.mjs <out.json> [--key-file <path>]
 * The key file holds the Apollo key either alone or as an APOLLO_API_KEY=... line. The key is sent
 * only to the proxy, in the X-Api-Key header, and is never printed or written.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const PROXY = 'https://stormsearch-apollo-proxy.jyurk.workers.dev';
const IMAGES = 'https://apollo-addin-images.jyurk.workers.dev';
const ADDIN_ORIGIN = 'https://nicka2717.github.io';
const FOREIGN_ORIGIN = 'https://example.com';
const MISSING_IMAGE = '0'.repeat(32);

// Headers whose value differs on every request (edge ids, clocks, rate-limit counters).
const VOLATILE = /^(date|cf-ray|report-to|nel|server-timing|x-request-id|x-runtime|etag|age|alt-svc|x-amzn-trace-id|x-transaction-id|x-envoy-upstream-service-time|x-.*-request-id|.*rate-?limit.*|x-.*-remaining|x-.*-usage|set-cookie|cf-cache-status|via)$/i;

function readKey(file) {
	const text = readFileSync(file, 'utf8');
	const line = text.split('\n').find((l) => /^\s*APOLLO_API_KEY\s*=/.test(l));
	const raw = (line ? line.split('=').slice(1).join('=') : text).trim().replace(/^['"]|['"]$/g, '');
	if (!raw) throw new Error('no key found in the key file');
	return raw;
}

const mask = (s) => s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<time>');

async function capture(name, url, init = {}) {
	const res = await fetch(url, { redirect: 'manual', ...init });
	const body = Buffer.from(await res.arrayBuffer());
	const text = mask(body.toString('utf8'));
	const headers = {};
	for (const [k, v] of [...res.headers].sort(([a], [b]) => a.localeCompare(b))) headers[k] = VOLATILE.test(k) ? '<volatile>' : v;
	return {
		name,
		status: res.status,
		statusText: res.statusText,
		headers,
		bodyLength: body.length,
		bodySha256: createHash('sha256').update(text).digest('hex'),
	};
}

async function main() {
	const [out, ...rest] = process.argv.slice(2);
	if (!out) throw new Error('usage: node scripts/capture-replies.mjs <out.json> [--key-file <path>]');
	const i = rest.indexOf('--key-file');
	const key = i >= 0 ? readKey(rest[i + 1]) : null;

	const cases = [
		['proxy preflight, add-in origin', `${PROXY}/v1/emailer_campaigns/search`, { method: 'OPTIONS', headers: { Origin: ADDIN_ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-api-key' } }],
		['proxy preflight, foreign origin', `${PROXY}/v1/emailer_campaigns/search`, { method: 'OPTIONS', headers: { Origin: FOREIGN_ORIGIN, 'Access-Control-Request-Method': 'POST' } }],
		['proxy health', `${PROXY}/health`, { headers: { Origin: ADDIN_ORIGIN } }],
		['proxy keyless GET auth/health', `${PROXY}/v1/auth/health`, { headers: { Origin: ADDIN_ORIGIN } }],
		['proxy keyless GET email_accounts', `${PROXY}/v1/email_accounts`, { headers: { Origin: ADDIN_ORIGIN, 'Cache-Control': 'no-cache' } }],
		['images preflight, add-in origin', `${IMAGES}/img`, { method: 'OPTIONS', headers: { Origin: ADDIN_ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-api-key' } }],
		['images preflight, foreign origin', `${IMAGES}/img`, { method: 'OPTIONS', headers: { Origin: FOREIGN_ORIGIN, 'Access-Control-Request-Method': 'POST' } }],
		['images health', `${IMAGES}/health`, { headers: { Origin: ADDIN_ORIGIN } }],
		['images missing image', `${IMAGES}/img/${MISSING_IMAGE}`, {}],
		['images malformed image path', `${IMAGES}/img/not-a-key`, {}],
		['images refused upload, unsupported type', `${IMAGES}/img`, { method: 'POST', headers: { Origin: ADDIN_ORIGIN, 'Content-Type': 'text/plain' }, body: 'x' }],
		['images refused upload, no key', `${IMAGES}/img`, { method: 'POST', headers: { Origin: ADDIN_ORIGIN, 'Content-Type': 'image/png' }, body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }],
	];
	if (key) {
		cases.push(['proxy GET auth/health with key, add-in origin', `${PROXY}/v1/auth/health`, { headers: { Origin: ADDIN_ORIGIN, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'X-Api-Key': key } }]);
		cases.push(['proxy GET auth/health with key, no origin', `${PROXY}/v1/auth/health`, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'X-Api-Key': key } }]);
	}
	const results = [];
	for (const [name, url, init] of cases) results.push(await capture(name, url, init));
	writeFileSync(out, JSON.stringify(results, null, 1) + '\n');
	console.log(`${results.length} replies captured to ${out}`);
}

main().catch((e) => {
	console.error(e.message);
	process.exit(1);
});
