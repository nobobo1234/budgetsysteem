// Web-vitals uit de PWA naar een eigen endpoint achter de sessie, in de telemetrie-database met
// de bewaartermijn van 90 dagen, en de statuspagina met p75 per week.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handle } from '../../src/hooks.server.ts';
import { POST as postVitals } from '../../src/routes/(app)/api/vitals/+server.ts';
import { load as statusLoad } from '../../src/routes/(app)/instellingen/status/+page.server.ts';
import { createSession, sessionCookieName } from '../../src/lib/server/auth/session.ts';
import type { DB } from '../../src/lib/server/db/index.ts';
import type { TelemetryDB } from '../../src/lib/server/telemetry/db.ts';
import { RETENTION_DAYS, pruneTelemetry } from '../../src/lib/server/telemetry/errors.ts';
import { webVitals } from '../../src/lib/server/telemetry/schema.ts';
import { recentVitals } from '../../src/lib/server/telemetry/vitals.ts';
import { fakeEvent, tempDatabase, tempTelemetry } from './helpers.ts';

let db: DB;
let telemetry: TelemetryDB;
let cleanups: (() => void)[];

beforeEach(() => {
	const main = tempDatabase();
	const t = tempTelemetry();
	db = main.db;
	telemetry = t.telemetry;
	cleanups = [main.cleanup, t.cleanup];
});
afterEach(() => cleanups.forEach((c) => c()));

async function status(run: () => Promise<Response> | Response): Promise<number> {
	try {
		return (await run()).status;
	} catch (e) {
		// error() van SvelteKit gooit een HttpError met een status
		if (e && typeof e === 'object' && 'status' in e) return (e as { status: number }).status;
		throw e;
	}
}

function post(body: unknown, headers?: Record<string, string>) {
	const event = fakeEvent({
		path: '/api/vitals',
		routeId: '/(app)/api/vitals',
		method: 'POST',
		body,
		headers
	});
	return () => postVitals(event as never);
}

const stored = () =>
	telemetry.select({ name: webVitals.name, value: webVitals.value }).from(webVitals).all();

describe('POST /api/vitals', () => {
	it('slaat geldige metingen op, alleen naam en waarde', async () => {
		const metrics = [
			{ name: 'LCP', value: 1840.2 },
			{ name: 'INP', value: 96 },
			{ name: 'CLS', value: 0.0123 }
		];
		expect(await status(post({ metrics }))).toBe(204);
		expect(stored()).toEqual(metrics);
		const columns = Object.keys(telemetry.select().from(webVitals).get()!).sort();
		expect(columns).toEqual(['at', 'id', 'name', 'value']);
	});

	it('weigert de hele batch als er één onzin-waarde in zit', async () => {
		const metrics = [
			{ name: 'LCP', value: 1840 },
			{ name: 'INP', value: -5 }
		];
		expect(await status(post({ metrics }))).toBe(400);
		expect(await status(post({ metrics: [{ name: 'LCP', value: 1e9 }] }))).toBe(400);
		expect(await status(post({ metrics: [{ name: 'Onzin', value: 1 }] }))).toBe(400);
		expect(await status(post({ metrics: [] }))).toBe(400);
		expect(await status(post({ metrics: [{ name: 'INP', value: 10, pagina: '/x' }] }))).toBe(400);
		expect(await status(post([{ name: 'INP', value: 10 }]))).toBe(400);
		expect(stored()).toEqual([]);
	});

	it('alleen JSON, en niet te groot', async () => {
		const asText = fakeEvent({
			path: '/api/vitals',
			routeId: '/(app)/api/vitals',
			method: 'POST',
			body: { metrics: [{ name: 'INP', value: 1 }] },
			headers: { 'content-type': 'text/plain' }
		});
		// fakeEvent zet application/json; overschrijf met een eigen request
		const request = new Request(asText.url, {
			method: 'POST',
			headers: { 'content-type': 'text/plain', origin: asText.url.origin },
			body: '{"metrics":[{"name":"INP","value":1}]}'
		});
		expect(await status(() => postVitals({ ...asText, request } as never))).toBe(415);
		const big = { metrics: [{ name: 'INP', value: 1 }], padding: 'x'.repeat(5000) };
		expect(await status(post(big))).toBe(413);
		expect(stored()).toEqual([]);
	});

	it('zonder sessie 401, en er wordt niets opgeslagen', async () => {
		const event = fakeEvent({
			path: '/api/vitals',
			routeId: '/(app)/api/vitals',
			method: 'POST',
			body: { metrics: [{ name: 'INP', value: 10 }] }
		});
		const response = await handle({
			event,
			resolve: () => postVitals(event as never)
		});
		expect(response.status).toBe(401);
		expect(stored()).toEqual([]);
	});

	it('met een sessie komt het verzoek door', async () => {
		const { token } = createSession(db, { passkeyId: null, deviceName: 'test' });
		const event = fakeEvent({
			path: '/api/vitals',
			routeId: '/(app)/api/vitals',
			method: 'POST',
			body: { metrics: [{ name: 'INP', value: 10 }] },
			cookies: { [sessionCookieName()]: token }
		});
		const response = await handle({ event, resolve: () => postVitals(event as never) });
		expect(response.status).toBe(204);
		expect(stored()).toEqual([{ name: 'INP', value: 10 }]);
	});
});

describe('bewaartermijn en p75 per week', () => {
	const NOW = new Date('2026-10-24T12:00:00.000Z');
	const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

	it('ruimt web-vitals ouder dan 90 dagen op', () => {
		telemetry
			.insert(webVitals)
			.values([
				{ at: daysAgo(RETENTION_DAYS + 1), name: 'INP', value: 1 },
				{ at: daysAgo(RETENTION_DAYS - 1), name: 'INP', value: 2 }
			])
			.run();
		pruneTelemetry(telemetry, NOW);
		expect(stored()).toEqual([{ name: 'INP', value: 2 }]);
	});

	it('de statuspagina toont alleen de laatste 8 weken', () => {
		telemetry
			.insert(webVitals)
			.values([
				{ at: daysAgo(0), name: 'INP', value: 100 },
				{ at: daysAgo(1), name: 'INP', value: 300 },
				{ at: daysAgo(14), name: 'LCP', value: 2000 },
				{ at: daysAgo(70), name: 'LCP', value: 9000 }
			])
			.run();
		const weeks = recentVitals(telemetry, NOW);
		expect(weeks.map((w) => w.weekStart)).toEqual(['2026-10-19', '2026-10-05']);
		expect(weeks[0]!.metrics.INP).toEqual({ p75: 300, count: 2, rating: 'matig' });
	});

	it('de statuspagina laadt health en web-vitals, zonder paden of persoonsgegevens', async () => {
		telemetry.insert(webVitals).values({ name: 'LCP', value: 1500 }).run();
		const data = (await statusLoad(
			fakeEvent({ path: '/instellingen/status', routeId: '/(app)/instellingen/status' }) as never
		)) as Exclude<Awaited<ReturnType<typeof statusLoad>>, void>;
		expect(Object.keys(data).sort()).toEqual(['attention', 'checkedAt', 'health', 'vitals']);
		expect(data.health.database).toBe(true);
		expect(data.vitals[0]!.metrics.LCP!.p75).toBe(1500);
		expect(JSON.stringify(data.health)).not.toContain('/');
	});
});
