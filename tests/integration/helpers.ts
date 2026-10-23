import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Cookies, RequestEvent } from '@sveltejs/kit';
import { openDatabase, useDatabase, type DB } from '../../src/lib/server/db/index.ts';
import type { Session } from '../../src/lib/server/auth/session.ts';

/** Verse database in een tijdelijk bestand, met migraties en startdata. */
export function tempDatabase(): { db: DB; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), 'budget-test-'));
	const db = openDatabase(join(dir, 'budget.db'), 'drizzle');
	useDatabase(db);
	return {
		db,
		cleanup: () => {
			db.$client.close();
			useDatabase(undefined);
			rmSync(dir, { recursive: true, force: true });
		}
	};
}

export function fakeCookies(
	initial: Record<string, string> = {}
): Cookies & { jar: Map<string, string> } {
	const jar = new Map(Object.entries(initial));
	return {
		jar,
		get: (name: string) => jar.get(name),
		getAll: () => [...jar].map(([name, value]) => ({ name, value })),
		set: (name: string, value: string) => void jar.set(name, value),
		delete: (name: string) => void jar.delete(name),
		serialize: () => ''
	} as unknown as Cookies & { jar: Map<string, string> };
}

export const ORIGIN = 'http://localhost:5173';

export function fakeEvent(opts: {
	path: string;
	routeId: string | null;
	method?: string;
	body?: unknown;
	headers?: Record<string, string>;
	cookies?: Record<string, string>;
	session?: Session | null;
	params?: Record<string, string>;
}): RequestEvent {
	const method = opts.method ?? 'GET';
	const url = new URL(opts.path, ORIGIN);
	const headers = new Headers({ origin: ORIGIN, ...opts.headers });
	if (opts.body !== undefined) headers.set('content-type', 'application/json');
	const request = new Request(url, {
		method,
		headers,
		body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
	});
	return {
		request,
		url,
		route: { id: opts.routeId },
		params: opts.params ?? {},
		cookies: fakeCookies(opts.cookies),
		locals: { session: opts.session ?? null },
		getClientAddress: () => '127.0.0.1',
		setHeaders: () => {},
		isDataRequest: false,
		isSubRequest: false,
		isRemoteRequest: false,
		platform: undefined,
		fetch
	} as unknown as RequestEvent;
}
