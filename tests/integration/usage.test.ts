// Je eigen gebruik uit de PWA naar een eigen endpoint achter de sessie, in de
// telemetrie-database met de bewaartermijn van 90 dagen, en de pagina Gebruik.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handle } from '../../src/hooks.server.ts';
import { POST as postUsage } from '../../src/routes/(app)/api/usage/+server.ts';
import { load as usageLoad } from '../../src/routes/(app)/instellingen/gebruik/+page.server.ts';
import { createSession, sessionCookieName } from '../../src/lib/server/auth/session.ts';
import { addDays, toIsoDate } from '../../src/lib/dates.ts';
import type { DB } from '../../src/lib/server/db/index.ts';
import { meerTiles } from '../../src/lib/server/meer.ts';
import type { TelemetryDB } from '../../src/lib/server/telemetry/db.ts';
import { RETENTION_DAYS, pruneTelemetry } from '../../src/lib/server/telemetry/errors.ts';
import { usageEntries } from '../../src/lib/server/telemetry/schema.ts';
import { MAX_DURATION_MS, usageSummary } from '../../src/lib/server/telemetry/usage.ts';
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

const event = (body: unknown, cookies?: Record<string, string>) =>
	fakeEvent({ path: '/api/usage', routeId: '/(app)/api/usage', method: 'POST', body, cookies });

const post = (body: unknown) => () => postUsage(event(body) as never);

const stored = () =>
	telemetry
		.select({ day: usageEntries.day, kind: usageEntries.kind, durationMs: usageEntries.durationMs })
		.from(usageEntries)
		.all();

const today = () => toIsoDate(new Date());
const entry = (over: Record<string, unknown> = {}) => ({
	id: crypto.randomUUID(),
	day: today(),
	kind: 'snelinvoer',
	durationMs: 8400,
	...over
});

describe('POST /api/usage', () => {
	it('slaat geldige invoer op, alleen dag, soort en tijd', async () => {
		const entries = [
			entry(),
			entry({ kind: 'verwacht', durationMs: null }),
			entry({ kind: 'bon' })
		];
		expect(await status(post({ entries }))).toBe(204);
		expect(stored()).toEqual(
			entries.map(({ day, kind, durationMs }) => ({ day, kind, durationMs }))
		);
		const columns = Object.keys(telemetry.select().from(usageEntries).get()!).sort();
		expect(columns).toEqual(['at', 'day', 'durationMs', 'id', 'kind']);
	});

	it('hetzelfde ID opnieuw versturen telt één keer', async () => {
		const once = entry();
		expect(await status(post({ entries: [once] }))).toBe(204);
		expect(await status(post({ entries: [once, entry()] }))).toBe(204);
		expect(stored()).toHaveLength(2);
	});

	it('offline invoer van eerder telt op de dag van invoeren', async () => {
		const yesterday = addDays(today(), -1);
		expect(await status(post({ entries: [entry({ day: yesterday })] }))).toBe(204);
		expect(stored()[0]!.day).toBe(yesterday);
	});

	it('weigert de hele batch bij één waarde buiten de grenzen', async () => {
		for (const bad of [
			entry({ durationMs: -1 }),
			entry({ durationMs: MAX_DURATION_MS + 1 }),
			entry({ durationMs: 1.5 }),
			entry({ durationMs: '8400' }),
			entry({ day: addDays(today(), 2) }),
			entry({ day: '2026-13-01' }),
			entry({ kind: 'import' }),
			entry({ id: '1' }),
			entry({ amountCents: -1250 }),
			entry({ counterparty: 'Albert Heijn' })
		]) {
			expect(await status(post({ entries: [entry(), bad] })), JSON.stringify(bad)).toBe(400);
		}
		expect(await status(post({ entries: [] }))).toBe(400);
		expect(await status(post({ entries: Array.from({ length: 21 }, () => entry()) }))).toBe(400);
		expect(await status(post([entry()]))).toBe(400);
		expect(stored()).toEqual([]);
	});

	it('slaat een dag van vóór de bewaartermijn stil over', async () => {
		const old = entry({ day: addDays(today(), -RETENTION_DAYS) });
		expect(await status(post({ entries: [old, entry()] }))).toBe(204);
		expect(stored()).toHaveLength(1);
	});

	it('alleen JSON, en niet te groot', async () => {
		const asText = event({ entries: [entry()] });
		const request = new Request(asText.url, {
			method: 'POST',
			headers: { 'content-type': 'text/plain', origin: asText.url.origin },
			body: JSON.stringify({ entries: [entry()] })
		});
		expect(await status(() => postUsage({ ...asText, request } as never))).toBe(415);
		expect(await status(post({ entries: [entry()], padding: 'x'.repeat(5000) }))).toBe(413);
		expect(stored()).toEqual([]);
	});

	it('zonder sessie 401, en er wordt niets opgeslagen', async () => {
		const e = event({ entries: [entry()] });
		const response = await handle({ event: e, resolve: async () => postUsage(e as never) });
		expect(response.status).toBe(401);
		expect(stored()).toEqual([]);
	});

	it('met een sessie komt het verzoek door', async () => {
		const { token } = createSession(db, { passkeyId: null, deviceName: 'test' });
		const e = event({ entries: [entry()] }, { [sessionCookieName()]: token });
		const response = await handle({ event: e, resolve: async () => postUsage(e as never) });
		expect(response.status).toBe(204);
		expect(stored()).toHaveLength(1);
	});
});

describe('bewaartermijn, pagina Gebruik en de tegel op Meer', () => {
	const NOW = new Date('2026-10-28T12:00:00.000Z');
	const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

	it('ruimt invoer ouder dan 90 dagen op', () => {
		telemetry
			.insert(usageEntries)
			.values([
				{
					id: crypto.randomUUID(),
					at: daysAgo(RETENTION_DAYS + 1),
					day: '2026-07-29',
					kind: 'bon'
				},
				{ id: crypto.randomUUID(), at: daysAgo(1), day: '2026-10-27', kind: 'bon' }
			])
			.run();
		pruneTelemetry(telemetry, NOW);
		expect(stored().map((r) => r.day)).toEqual(['2026-10-27']);
	});

	it('de samenvatting rekent per week vanuit de database', () => {
		telemetry
			.insert(usageEntries)
			.values([
				{ id: crypto.randomUUID(), day: '2026-10-26', kind: 'snelinvoer', durationMs: 4000 },
				{ id: crypto.randomUUID(), day: '2026-10-27', kind: 'verwacht', durationMs: 6000 },
				{ id: crypto.randomUUID(), day: '2026-10-28', kind: 'bon', durationMs: null }
			])
			.run();
		const usage = usageSummary(telemetry, '2026-10-28');
		expect(usage).toMatchObject({ streak: 3, today: true });
		expect(usage.weeks[0]).toMatchObject({ daysWithEntry: 3, daysSoFar: 3, medianMs: 5000 });
	});

	it('de pagina laadt alleen tellingen en tijden', async () => {
		telemetry
			.insert(usageEntries)
			.values({ id: crypto.randomUUID(), day: today(), kind: 'snelinvoer', durationMs: 5200 })
			.run();
		const data = (await usageLoad(
			fakeEvent({ path: '/instellingen/gebruik', routeId: '/(app)/instellingen/gebruik' }) as never
		)) as Exclude<Awaited<ReturnType<typeof usageLoad>>, void>;
		expect(Object.keys(data)).toEqual(['usage']);
		expect(data.usage).toMatchObject({ streak: 1, today: true });
		expect(data.usage.weeks[0]).toMatchObject({ entries: 1, medianMs: 5200 });
		expect(JSON.stringify(data)).not.toContain('snelinvoer');
	});

	it('de tegel op Meer: niets gemeten, dan de week, dan de reeks', () => {
		const t = today();
		expect(meerTiles(db, t).usage).toBeNull();
		telemetry
			.insert(usageEntries)
			.values({ id: crypto.randomUUID(), day: t, kind: 'snelinvoer' })
			.run();
		expect(meerTiles(db, t).usage).toMatchObject({ streak: 1, days: 1 });
		telemetry
			.insert(usageEntries)
			.values({ id: crypto.randomUUID(), day: addDays(t, -1), kind: 'verwacht' })
			.run();
		expect(meerTiles(db, t).usage).toMatchObject({ streak: 2 });
	});
});
