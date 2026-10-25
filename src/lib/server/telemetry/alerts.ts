import { and, desc, eq, gte, max, notInArray } from 'drizzle-orm';
import { statSync } from 'node:fs';
import type { DB } from '../db/index.ts';
import { notificationsSent } from '../db/schema.ts';
import { log } from '../log.ts';
import { notify, pruneNotifications, releaseNotification } from '../push/notify.ts';
import type { TelemetryDB } from './db.ts';
import { describeError } from './errors.ts';
import { diskUsage, newestMtime, type HealthPaths } from './health.ts';
import { errors } from './schema.ts';

// Telemetrie-meldingen (spec: Telemetrie en monitoring): een nieuw soort fout, een te oude
// backup en meer dan 80% schijfgebruik. Eén melding per soort tot het opgelost is: de
// ontdubbel-sleutel van `notify` blijft staan tot de check weer goed is.

const HOUR = 3_600_000;

/** Restic draait dagelijks; met dezelfde marge als de externe backup-check (1 dag + 2 uur). */
export const RESTIC_MAX_AGE_MS = 26 * HOUR;
/**
 * Litestream schrijft alleen als de database verandert, dus de leeftijd zegt weinig op een
 * rustige dag. Daarom de achterstand: hoe lang de database al gewijzigd is zonder dat
 * Litestream iets heeft weggeschreven.
 */
export const LITESTREAM_MAX_LAG_MS = 1 * HOUR;
export const DISK_ALERT_PERCENT = 80;
/** Pas onder deze grens is het opgelost, zodat een schijf rond 80% niet blijft melden. */
export const DISK_CLEAR_PERCENT = 78;
/** Hooguit zoveel nieuwe soorten fouten per ronde; de rest volgt de ronde erna. */
export const MAX_ERROR_ALERTS = 3;
export const CHECK_INTERVAL_MS = 5 * 60_000;

export interface AlertInput {
	now: number;
	production: boolean;
	resticMtime: number | null;
	litestreamMtime: number | null;
	/** Laatste wijziging aan de database of het WAL-bestand. */
	databaseMtime: number | null;
	diskUsedPercent: number | null;
}

/** `true`: melden, `false`: opgelost, `null`: niets veranderen. */
export interface AlertState {
	restic: boolean | null;
	litestream: boolean | null;
	disk: boolean | null;
}

/** Pure beoordeling, los van bestanden en tijd, zodat hij te testen is. */
export function evaluateAlerts(input: AlertInput): AlertState {
	// Ontbreekt de markering of de Litestream-map, dan is er in productie nooit een backup
	// gemaakt; lokaal en in tests is dat normaal.
	const restic =
		input.resticMtime === null
			? input.production
			: input.now - input.resticMtime > RESTIC_MAX_AGE_MS;

	let litestream: boolean | null;
	if (input.litestreamMtime === null) litestream = input.production;
	else if (input.databaseMtime === null) litestream = null;
	else litestream = input.databaseMtime - input.litestreamMtime > LITESTREAM_MAX_LAG_MS;

	let disk: boolean | null = null;
	if (input.diskUsedPercent !== null) {
		if (input.diskUsedPercent > DISK_ALERT_PERCENT) disk = true;
		else if (input.diskUsedPercent < DISK_CLEAR_PERCENT) disk = false;
	}
	return { restic, litestream, disk };
}

function mtime(path: string): number | null {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return null;
	}
}

function hours(ms: number): number {
	return Math.round(ms / HOUR);
}

export interface AlertDeps {
	db: DB;
	telemetry: TelemetryDB;
	paths: HealthPaths;
	databasePath: string;
	production: boolean;
	now?: number;
}

/** Eén ronde: backups, schijf en nieuwe soorten fouten. */
export async function checkAlerts(deps: AlertDeps): Promise<void> {
	const now = deps.now ?? Date.now();
	const resticMtime = mtime(deps.paths.resticMarker);
	const litestreamMtime = newestMtime(deps.paths.litestreamDir);
	const db = Math.max(mtime(deps.databasePath) ?? 0, mtime(`${deps.databasePath}-wal`) ?? 0);
	const disk = diskUsage(deps.paths.dataDir);
	const state = evaluateAlerts({
		now,
		production: deps.production,
		resticMtime,
		litestreamMtime,
		databaseMtime: db || null,
		diskUsedPercent: disk?.usedPercent ?? null
	});

	const pending: Promise<unknown>[] = [];
	const toggle = (
		on: boolean | null,
		kind: 'backup' | 'schijf',
		key: string,
		text: () => string
	) => {
		if (on === true) pending.push(notify(kind, { key, text: text() }, deps.db));
		else if (on === false) releaseNotification(kind, key, deps.db);
	};

	toggle(state.restic, 'backup', 'restic', () =>
		resticMtime === null
			? 'Er is nog geen restic-backup gemaakt.'
			: `De laatste restic-backup is ${hours(now - resticMtime)} uur oud.`
	);
	toggle(state.litestream, 'backup', 'litestream', () =>
		litestreamMtime === null
			? 'Litestream heeft nog niets gerepliceerd.'
			: 'Litestream loopt meer dan een uur achter op de database.'
	);
	toggle(
		state.disk,
		'schijf',
		'schijf',
		() => `De schijf is voor ${Math.round(disk!.usedPercent)}% vol.`
	);

	pending.push(alertNewErrors(deps.db, deps.telemetry, now));
	await Promise.all(pending);
}

/**
 * Een melding per nieuw soort fout (vingerafdruk) van het afgelopen etmaal. Soort fout en
 * route zijn veilig: geen foutmelding, geen invoer (zie errors.ts).
 */
export async function alertNewErrors(db: DB, telemetry: TelemetryDB, now = Date.now()) {
	const known = db
		.select({ key: notificationsSent.key })
		.from(notificationsSent)
		.where(eq(notificationsSent.kind, 'fout'))
		.all()
		.map((r) => r.key);
	const since = new Date(now - 24 * HOUR).toISOString();
	const fresh = telemetry
		.select({ fingerprint: errors.fingerprint, name: max(errors.name), route: max(errors.route) })
		.from(errors)
		.where(
			and(gte(errors.at, since), known.length ? notInArray(errors.fingerprint, known) : undefined)
		)
		.groupBy(errors.fingerprint)
		.orderBy(desc(max(errors.at)))
		.limit(MAX_ERROR_ALERTS)
		.all();
	for (const e of fresh) {
		const where = e.route
			? ` op ${e.route.replace(/\/\([^/]+\)/g, '') || '/'}`
			: ' buiten een verzoek';
		await notify('fout', { key: e.fingerprint, text: `Nieuw soort fout: ${e.name}${where}.` }, db);
	}
}

let timer: ReturnType<typeof setInterval> | undefined;
let soon: ReturnType<typeof setTimeout> | undefined;
let current: (() => AlertDeps) | undefined;

async function run(): Promise<void> {
	if (!current) return;
	try {
		const deps = current();
		pruneNotifications(deps.db);
		await checkAlerts(deps);
	} catch (e) {
		log.warn({ err: describeError(e) }, 'telemetrie-meldingen mislukt');
	}
}

/** Bij het starten van de server: direct een ronde en daarna elke vijf minuten. */
export function startAlerts(deps: () => AlertDeps): void {
	if (timer) return;
	current = deps;
	void run();
	timer = setInterval(() => void run(), CHECK_INTERVAL_MS);
	timer.unref();
}

/**
 * Na een onverwachte fout: binnen enkele seconden een ronde, zodat een nieuw soort fout niet
 * vijf minuten op zich laat wachten. Meerdere fouten kort na elkaar geven één ronde. Doet niets
 * zolang de meldingen niet gestart zijn (zoals in tests).
 */
export function alertSoon(): void {
	if (!current || soon) return;
	soon = setTimeout(() => {
		soon = undefined;
		void run();
	}, 5_000);
	soon.unref();
}
