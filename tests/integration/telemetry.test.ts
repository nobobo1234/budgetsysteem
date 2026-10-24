// Telemetrie van fase 1: de `errors`-tabel via handleError in een aparte database met een
// bewaartermijn van 90 dagen, en de uitgebreide health check achter de login.
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleError } from '../../src/hooks.server.ts';
import type { DB } from '../../src/lib/server/db/index.ts';
import { GET as health } from '../../src/routes/(app)/api/health/+server.ts';
import {
	RETENTION_DAYS,
	pruneTelemetry,
	recordError,
	recordStart
} from '../../src/lib/server/telemetry/errors.ts';
import type { TelemetryDB } from '../../src/lib/server/telemetry/db.ts';
import {
	collectHealth,
	healthPaths,
	newestMtime,
	type Health
} from '../../src/lib/server/telemetry/health.ts';
import { errors, starts } from '../../src/lib/server/telemetry/schema.ts';
import { fakeEvent, tempDatabase, tempTelemetry } from './helpers.ts';

let db: DB;
let telemetry: TelemetryDB;
let dir: string;
let cleanups: (() => void)[];

beforeEach(() => {
	const main = tempDatabase();
	const t = tempTelemetry();
	db = main.db;
	telemetry = t.telemetry;
	dir = t.dir;
	cleanups = [main.cleanup, t.cleanup];
});
afterEach(() => cleanups.forEach((c) => c()));

type ErrorInput = Parameters<typeof handleError>[0];

function serverError(error: unknown, kind = 'unknown'): ErrorInput {
	return {
		kind,
		error,
		status: 500,
		message: 'Internal Error',
		event: fakeEvent({ path: '/budget', routeId: '/(app)/budget', method: 'POST', body: {} })
	} as unknown as ErrorInput;
}

describe('errors-tabel via handleError', () => {
	it('legt een onverwachte fout vast onder hetzelfde errorId, zonder de foutmelding', async () => {
		const result = await handleError(
			serverError(new TypeError('NL91ABNA0417164300 omschrijving Albert Heijn 12,50'))
		);
		const errorId = (result as { errorId: string }).errorId;
		const rows = telemetry.select().from(errors).all();
		expect(rows).toHaveLength(1);
		const row = rows[0]!;
		expect(row.id).toBe(errorId);
		expect(row.source).toBe('verzoek');
		expect(row.name).toBe('TypeError');
		expect(row.route).toBe('/(app)/budget');
		expect(row.method).toBe('POST');
		expect(row.fingerprint).toMatch(/^[0-9a-f]{16}$/);
		const stored = JSON.stringify(row);
		expect(stored).not.toContain('NL91ABNA0417164300');
		expect(stored).not.toContain('Albert Heijn');
		expect(stored).not.toContain('12,50');
	});

	it('de client krijgt alleen een errorId', async () => {
		const result = await handleError(serverError(new Error('geheim')));
		expect(result).toEqual({
			status: 500,
			message: 'Er ging iets mis.',
			errorId: expect.any(String)
		});
	});

	it('legt verwachte fouten (error(), 404 van SvelteKit) niet vast', async () => {
		await handleError(serverError({ status: 404, message: 'Not Found' }, 'framework'));
		await handleError(serverError({ status: 400, message: 'Ongeldig' }, 'app'));
		expect(telemetry.select().from(errors).all()).toHaveLength(0);
	});

	it('dezelfde fout op dezelfde plek krijgt dezelfde vingerafdruk', async () => {
		const fail = () => new RangeError('x');
		await handleError(serverError(fail()));
		await handleError(serverError(fail()));
		const prints = telemetry.select({ f: errors.fingerprint }).from(errors).all();
		expect(prints).toHaveLength(2);
		expect(prints[0]!.f).toBe(prints[1]!.f);
	});

	it('een kapotte telemetrie-database breekt de foutafhandeling niet', async () => {
		telemetry.$client.close();
		expect(() =>
			recordError(() => telemetry, {
				id: crypto.randomUUID(),
				source: 'proces',
				error: new Error()
			})
		).not.toThrow();
		cleanups[1] = () => {};
	});

	it('staat in een eigen bestand, los van de hoofddatabase', () => {
		expect(telemetry.$client.name).not.toBe(db.$client.name);
		const tables = db.$client
			.prepare(
				"select name from sqlite_master where type = 'table' and name in ('errors', 'starts')"
			)
			.all();
		expect(tables).toEqual([]);
	});
});

describe('bewaartermijn', () => {
	it('ruimt fouten en starts ouder dan 90 dagen op', () => {
		const now = new Date('2026-10-24T12:00:00.000Z');
		const old = new Date(now.getTime() - (RETENTION_DAYS + 1) * 86_400_000).toISOString();
		const recent = new Date(now.getTime() - (RETENTION_DAYS - 1) * 86_400_000).toISOString();
		for (const at of [old, recent]) {
			telemetry
				.insert(errors)
				.values({ id: crypto.randomUUID(), at, source: 'verzoek', name: 'Error', fingerprint: 'x' })
				.run();
			telemetry.insert(starts).values({ at, version: 'v1' }).run();
		}
		pruneTelemetry(telemetry, now);
		expect(telemetry.select({ at: errors.at }).from(errors).all()).toEqual([{ at: recent }]);
		expect(telemetry.select({ at: starts.at }).from(starts).all()).toEqual([{ at: recent }]);
	});
});

describe('uitgebreide health check', () => {
	const NOW = Date.parse('2026-10-24T12:00:00.000Z');
	const ago = (ms: number) => new Date(NOW - ms).toISOString();

	function check(paths = healthPaths(join(dir, 'budget.db'))): Health {
		return collectHealth({ db: () => db, telemetry, paths, now: NOW, uptimeSeconds: 42.4 });
	}

	it('meldt ontbrekende backups als null in plaats van te gokken', () => {
		const h = check();
		expect(h.database).toBe(true);
		expect(h.uptimeSeconds).toBe(42);
		expect(h.backups).toEqual({ litestreamAgeSeconds: null, resticAgeSeconds: null });
	});

	it('leeftijd van de laatste Litestream-sync en restic-backup', () => {
		const paths = healthPaths(join(dir, 'budget.db'));
		expect(paths.litestreamDir).toBe(join(dir, '.budget.db-litestream'));
		mkdirSync(join(paths.litestreamDir, 'ltx', '0'), { recursive: true });
		const older = join(paths.litestreamDir, 'ltx', '0', 'a.ltx');
		const newer = join(paths.litestreamDir, 'ltx', '0', 'b.ltx');
		writeFileSync(older, '');
		writeFileSync(newer, '');
		writeFileSync(paths.resticMarker, '');
		const s = (sec: number) => (NOW - sec * 1000) / 1000;
		utimesSync(older, s(600), s(600));
		utimesSync(newer, s(30), s(30));
		utimesSync(join(paths.litestreamDir, 'ltx', '0'), s(900), s(900));
		utimesSync(join(paths.litestreamDir, 'ltx'), s(900), s(900));
		utimesSync(paths.resticMarker, s(7200), s(7200));
		expect(check(paths).backups).toEqual({ litestreamAgeSeconds: 30, resticAgeSeconds: 7200 });
		expect(newestMtime(join(dir, 'bestaat-niet'))).toBeNull();
	});

	it('schijfruimte van het datavolume', () => {
		const disk = check().disk!;
		expect(disk.usedPercent).toBeGreaterThanOrEqual(0);
		expect(disk.usedPercent).toBeLessThanOrEqual(100);
		expect(disk.freeBytes).toBeGreaterThan(0);
	});

	it('telt herstarts: een tweede start van dezelfde versie, niet een uitrol', () => {
		telemetry
			.insert(starts)
			.values({ at: ago(10 * 86_400_000), version: 'v1' })
			.run();
		telemetry
			.insert(starts)
			.values({ at: ago(3 * 86_400_000), version: 'v1' })
			.run(); // herstart
		telemetry
			.insert(starts)
			.values({ at: ago(2 * 86_400_000), version: 'v2' })
			.run(); // uitrol
		telemetry
			.insert(starts)
			.values({ at: ago(3_600_000), version: 'v2' })
			.run(); // herstart
		telemetry
			.insert(starts)
			.values({ at: ago(60_000), version: 'v2' })
			.run(); // herstart
		expect(check().starts).toEqual({ last24h: 2, last7d: 4, restarts7d: 3 });
	});

	it('telt recente fouten en soorten fouten', () => {
		const add = (at: string, fingerprint: string) =>
			telemetry
				.insert(errors)
				.values({ id: crypto.randomUUID(), at, source: 'verzoek', name: 'Error', fingerprint })
				.run();
		add(ago(60_000), 'a');
		add(ago(120_000), 'a');
		add(ago(3_600_000), 'b');
		add(ago(3 * 86_400_000), 'c');
		expect(check().errors).toEqual({ last24h: 3, kinds24h: 2, last7d: 4 });
	});

	it('meldt een onbereikbare hoofddatabase', () => {
		const broken = () => {
			throw new Error('kan database niet openen');
		};
		const h = collectHealth({
			db: broken,
			telemetry,
			paths: healthPaths(join(dir, 'budget.db')),
			now: NOW
		});
		expect(h.database).toBe(false);
	});

	it('GET /api/health geeft alleen cijfers en tijden, zonder cache', async () => {
		recordStart(telemetry, 'v1');
		const response = await health(
			fakeEvent({ path: '/api/health', routeId: '/(app)/api/health' }) as never
		);
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		const body = (await response.json()) as Health;
		expect(Object.keys(body).sort()).toEqual(
			['backups', 'database', 'disk', 'errors', 'starts', 'uptimeSeconds'].sort()
		);
		expect(body.database).toBe(true);
		expect(body.starts.last24h).toBe(1);
		// Geen paden of andere configuratie in het antwoord
		expect(JSON.stringify(body)).not.toContain('/');
	});
});
