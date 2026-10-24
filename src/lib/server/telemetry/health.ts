import { and, count, countDistinct, gte, sql } from 'drizzle-orm';
import { readdirSync, statSync, statfsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { DB } from '../db/index.ts';
import type { TelemetryDB } from './db.ts';
import { errors, starts } from './schema.ts';

// Uitgebreide health check (achter de login): werkt de database, hoe oud zijn de backups,
// hoeveel schijfruimte is er en is de container herstart. Alleen cijfers en tijden, geen data.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface Health {
	database: boolean;
	uptimeSeconds: number;
	backups: {
		/** Laatste wijziging in de lokale map van Litestream (laatste sync), in seconden. */
		litestreamAgeSeconds: number | null;
		/** Laatste geslaagde restic-backup (markering van deploy/backup.sh), in seconden. */
		resticAgeSeconds: number | null;
	};
	disk: { usedPercent: number; freeBytes: number } | null;
	starts: {
		last24h: number;
		last7d: number;
		/** Starts in 7 dagen met een versie die al eerder gestart was: herstarts, geen uitrol. */
		restarts7d: number;
	};
	errors: { last24h: number; kinds24h: number; last7d: number };
}

export interface HealthPaths {
	/** Map met de database (het datavolume). */
	dataDir: string;
	/** Lokale map van Litestream: `.<bestand>-litestream` naast de database. */
	litestreamDir: string;
	/** Bestand dat deploy/backup.sh aanraakt na een geslaagde restic-backup. */
	resticMarker: string;
}

export const RESTIC_MARKER = '.restic-laatste-backup';

export function healthPaths(databasePath: string): HealthPaths {
	const dataDir = dirname(databasePath);
	return {
		dataDir,
		litestreamDir: join(dataDir, `.${basename(databasePath)}-litestream`),
		resticMarker: join(dataDir, RESTIC_MARKER)
	};
}

function ageSeconds(mtimeMs: number | null, now: number): number | null {
	return mtimeMs === null ? null : Math.max(0, Math.round((now - mtimeMs) / 1000));
}

function mtime(path: string): number | null {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return null;
	}
}

/** Nieuwste wijziging in een map (recursief); `null` als de map er niet is. */
export function newestMtime(dir: string): number | null {
	let entries: string[];
	try {
		entries = readdirSync(dir, { recursive: true, encoding: 'utf8' });
	} catch {
		return null;
	}
	let newest: number | null = null;
	for (const entry of entries) {
		const m = mtime(join(dir, entry));
		if (m !== null && (newest === null || m > newest)) newest = m;
	}
	return newest;
}

export function diskUsage(dir: string): Health['disk'] {
	try {
		const s = statfsSync(dir);
		if (s.blocks === 0) return null;
		return {
			usedPercent: Math.round((1 - s.bavail / s.blocks) * 1000) / 10,
			freeBytes: s.bavail * s.bsize
		};
	} catch {
		return null;
	}
}

export function databaseOk(db: () => DB): boolean {
	try {
		return db().$client.prepare('select 1 as ok').get() !== undefined;
	} catch {
		return false;
	}
}

function startCounts(t: TelemetryDB, now: number): Health['starts'] {
	const since = (ms: number) => new Date(now - ms).toISOString();
	const last24h = t
		.select({ n: count() })
		.from(starts)
		.where(gte(starts.at, since(DAY)))
		.get()!.n;
	const last7d = t
		.select({ n: count() })
		.from(starts)
		.where(gte(starts.at, since(7 * DAY)))
		.get()!.n;
	const restarts7d = t
		.select({ n: count() })
		.from(starts)
		.where(
			and(
				gte(starts.at, since(7 * DAY)),
				// Vaste SQL zonder invoer; expliciet gekwalificeerd zodat de subquery naar de buitenste rij kijkt
				sql`exists (select 1 from starts as eerder where eerder.version = starts.version and eerder.id < starts.id)`
			)
		)
		.get()!.n;
	return { last24h, last7d, restarts7d };
}

function errorCounts(t: TelemetryDB, now: number): Health['errors'] {
	const day = new Date(now - DAY).toISOString();
	const week = new Date(now - 7 * DAY).toISOString();
	const recent = t
		.select({ n: count(), kinds: countDistinct(errors.fingerprint) })
		.from(errors)
		.where(gte(errors.at, day))
		.get()!;
	const last7d = t.select({ n: count() }).from(errors).where(gte(errors.at, week)).get()!.n;
	return { last24h: recent.n, kinds24h: recent.kinds, last7d };
}

export function collectHealth(deps: {
	db: () => DB;
	telemetry: TelemetryDB;
	paths: HealthPaths;
	now?: number;
	uptimeSeconds?: number;
}): Health {
	const now = deps.now ?? Date.now();
	return {
		database: databaseOk(deps.db),
		uptimeSeconds: Math.round(deps.uptimeSeconds ?? process.uptime()),
		backups: {
			litestreamAgeSeconds: ageSeconds(newestMtime(deps.paths.litestreamDir), now),
			resticAgeSeconds: ageSeconds(mtime(deps.paths.resticMarker), now)
		},
		disk: diskUsage(deps.paths.dataDir),
		starts: startCounts(deps.telemetry, now),
		errors: errorCounts(deps.telemetry, now)
	};
}
