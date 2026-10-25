// TER REVIEW (Noah): test voor login-afscherming. Elke route zonder sessie geeft 401,
// behalve de routes in src/routes/(public). Nieuwe routes vallen hier automatisch onder.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handle } from '../../src/hooks.server.ts';
import { createSession, sessionCookieName } from '../../src/lib/server/auth/session.ts';
import { INGEST_ROUTE, isPublicRoute } from '../../src/lib/server/guard.ts';
import { createUploadToken } from '../../src/lib/server/receipts/tokens.ts';
import { fakeEvent, tempDatabase } from './helpers.ts';

const ROUTES = join(process.cwd(), 'src', 'routes');
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

interface Route {
	id: string;
	methods: string[];
}

function collectRoutes(dir = ROUTES): Route[] {
	const out: Route[] = [];
	const entries = readdirSync(dir, { withFileTypes: true });
	const files = entries.filter((e) => e.isFile()).map((e) => e.name);
	const id = '/' + relative(ROUTES, dir).split(sep).filter(Boolean).join('/');
	const methods = new Set<string>();
	if (files.some((f) => f.startsWith('+page.'))) {
		methods.add('GET');
		// Form actions zijn POST op de pagina
		if (
			files.includes('+page.server.ts') &&
			/export const actions/.test(readFileSync(join(dir, '+page.server.ts'), 'utf8'))
		) {
			methods.add('POST');
		}
	}
	if (files.includes('+server.ts')) {
		const source = readFileSync(join(dir, '+server.ts'), 'utf8');
		for (const m of METHODS)
			if (new RegExp(`export (const|async function|function) ${m}\\b`).test(source)) methods.add(m);
	}
	if (methods.size > 0) out.push({ id, methods: [...methods] });
	for (const e of entries) if (e.isDirectory()) out.push(...collectRoutes(join(dir, e.name)));
	return out;
}

/** Een pad bij een route-ID: groepen weg, parameters gevuld met een willekeurige UUID. */
function pathFor(id: string): string {
	const path = id
		.split('/')
		.filter((s) => s && !(s.startsWith('(') && s.endsWith(')')))
		.map((s) => (s.startsWith('[') ? crypto.randomUUID() : s))
		.join('/');
	return `/${path}`;
}

const routes = collectRoutes();
const neverResolve = async (): Promise<Response> => {
	throw new Error('resolve mag zonder sessie niet worden aangeroepen');
};

let cleanup: () => void;
beforeAll(() => {
	cleanup = tempDatabase().cleanup;
});
afterAll(() => cleanup());

describe('standaard alles dicht', () => {
	it('vindt de routes', () => {
		expect(routes.length).toBeGreaterThan(10);
	});

	it('alleen deze routes zijn publiek', () => {
		const pub = routes
			.filter((r) => isPublicRoute(r.id))
			.map((r) => r.id)
			.sort();
		expect(pub).toEqual([
			'/(public)/api/auth/login/options',
			'/(public)/api/auth/login/verify',
			'/(public)/api/auth/recover',
			'/(public)/api/auth/setup/options',
			'/(public)/api/auth/setup/verify',
			'/(public)/healthz',
			'/(public)/login',
			'/(public)/setup'
		]);
	});

	const closed = routes.filter((r) => !isPublicRoute(r.id));
	for (const route of closed) {
		for (const method of route.methods) {
			it(`${method} ${route.id} zonder sessie geeft 401`, async () => {
				for (const accept of ['text/html', 'application/json']) {
					const event = fakeEvent({
						path: pathFor(route.id),
						routeId: route.id,
						method,
						headers: { accept },
						body: method === 'GET' ? undefined : {}
					});
					const response = await handle({ event, resolve: neverResolve });
					expect(response.status).toBe(401);
					expect(response.headers.get('cache-control')).toBe('no-store');
				}
			});

			it(`${method} ${route.id} met een ongeldige sessie geeft 401`, async () => {
				const event = fakeEvent({
					path: pathFor(route.id),
					routeId: route.id,
					method,
					cookies: { [sessionCookieName()]: 'x'.repeat(43) },
					body: method === 'GET' ? undefined : {}
				});
				expect((await handle({ event, resolve: neverResolve })).status).toBe(401);
			});
		}
	}

	it('vindt het upload-endpoint, en dat is niet publiek', () => {
		expect(closed.map((r) => r.id)).toContain(INGEST_ROUTE);
	});

	// Het upload-token bereikt niets anders dan POST /api/ingest (spec: OWASP A01)
	for (const route of closed.filter((r) => r.id !== INGEST_ROUTE)) {
		for (const method of route.methods) {
			it(`${method} ${route.id} met alleen een upload-token geeft 401`, async () => {
				const { db } = await import('../../src/lib/server/db/index.ts');
				const { token } = createUploadToken(db(), 'test');
				const event = fakeEvent({
					path: pathFor(route.id),
					routeId: route.id,
					method,
					headers: { authorization: `Bearer ${token}` },
					body: method === 'GET' ? undefined : {}
				});
				expect((await handle({ event, resolve: neverResolve })).status).toBe(401);
			});
		}
	}

	it('een onbekende route (zonder route-ID) geeft ook 401', async () => {
		const event = fakeEvent({
			path: '/bestaat-niet',
			routeId: null,
			headers: { accept: 'text/html' }
		});
		const response = await handle({ event, resolve: neverResolve });
		expect(response.status).toBe(401);
		expect(await response.text()).toContain('url=/login');
	});

	it('met een geldige sessie komt het verzoek door, met security headers', async () => {
		const { db } = await import('../../src/lib/server/db/index.ts');
		const { token } = createSession(db(), { passkeyId: null, deviceName: 'test' });
		const event = fakeEvent({
			path: '/transacties',
			routeId: '/(app)/transacties',
			cookies: { [sessionCookieName()]: token }
		});
		const response = await handle({ event, resolve: async () => new Response('ok') });
		expect(response.status).toBe(200);
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(response.headers.get('referrer-policy')).toBe('same-origin');
		expect(response.headers.get('x-frame-options')).toBe('DENY');
	});

	it('weigert muterende verzoeken van een andere origin, ook met sessie', async () => {
		const { db } = await import('../../src/lib/server/db/index.ts');
		const { token } = createSession(db(), { passkeyId: null, deviceName: 'test' });
		const event = fakeEvent({
			path: '/api/transactions',
			routeId: '/(app)/api/transactions',
			method: 'POST',
			body: {},
			headers: { origin: 'https://evil.example' },
			cookies: { [sessionCookieName()]: token }
		});
		expect((await handle({ event, resolve: neverResolve })).status).toBe(403);
	});
});
