// Test stand-ins for the Cloudflare bindings both Workers use, with no network and no credential.
// D1 is a real SQLite database (node:sqlite) built from this folder's migrations, so the Workers'
// real SQL runs against the real schema.
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

export function migrationFiles() {
	return readdirSync(MIGRATIONS)
		.filter((f) => f.endsWith('.sql'))
		.sort();
}

/** A SQLite database with the given migrations applied (all of them by default). */
export function sqlite(files = migrationFiles()) {
	const db = new DatabaseSync(':memory:');
	for (const f of files) db.exec(readFileSync(path.join(MIGRATIONS, f), 'utf8'));
	return db;
}

const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v);

/** The slice of the D1 API the Workers use: prepare().bind().run() and batch(). */
export function d1(db) {
	const stmt = (sql, values = []) => ({
		bind: (...v) => stmt(sql, v),
		run: async () => {
			db.prepare(sql).run(...values.map(norm));
			return { success: true };
		},
		_run: () => db.prepare(sql).run(...values.map(norm)),
	});
	return {
		prepare: (sql) => stmt(sql),
		batch: async (stmts) => {
			db.exec('BEGIN');
			try {
				for (const s of stmts) s._run();
				db.exec('COMMIT');
			} catch (e) {
				db.exec('ROLLBACK');
				throw e;
			}
			return stmts.map(() => ({ success: true }));
		},
	};
}

/** A D1 whose every call fails, synchronously or by rejecting. */
export function failingD1(mode = 'reject') {
	const boom = () => {
		throw new Error('D1_ERROR: database unavailable');
	};
	const stmt = { bind: () => stmt, run: () => (mode === 'throw' ? boom() : Promise.reject(new Error('D1_ERROR'))) };
	return { prepare: () => (mode === 'throw' ? boom() : stmt), batch: () => Promise.reject(new Error('D1_ERROR')) };
}

/** A D1 that never answers. */
export function hangingD1() {
	const never = () => new Promise(() => {});
	const stmt = { bind: () => stmt, run: never };
	return { prepare: () => stmt, batch: never };
}

export function analytics() {
	const points = [];
	return { points, writeDataPoint: (p) => points.push(p) };
}

export function context() {
	const pending = [];
	return { pending, waitUntil: (p) => pending.push(p), settle: () => Promise.all(pending) };
}

export const VERSION = '0f5e3a52-8a64-4c1e-9d7b-2a1f6c3e9b10';

/** An Apollo-shaped key built at run time, so no key-like constant sits in the source. */
export const fakeKey = () => ['apk', 'Fixture', '7c9e2b14d0a6f3'].join('_');

/** Every column value of every row, as one string, for privacy checks. */
export function allValues(db) {
	return JSON.stringify(db.prepare('SELECT * FROM calls').all().map((r) => Object.values(r)));
}

/** A Response as plain data: status, status text, sorted headers and the body bytes. */
export async function snapshot(res) {
	return {
		status: res.status,
		statusText: res.statusText,
		headers: [...res.headers].sort(([a], [b]) => a.localeCompare(b)),
		body: Buffer.from(await res.arrayBuffer()).toString('base64'),
	};
}

/** Replaces global fetch for one test; returns the recorded requests and a restore function. */
export function stubFetch(handler) {
	const real = globalThis.fetch;
	const seen = [];
	globalThis.fetch = async (input, init) => {
		const req = new Request(input, init);
		seen.push(req);
		return handler(req);
	};
	return { seen, restore: () => (globalThis.fetch = real) };
}
