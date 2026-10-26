import { gte } from 'drizzle-orm';
import { z } from 'zod';
import { addDays, fromIsoDate, isIsoDate, toIsoDate } from '../../dates.ts';
import type { TelemetryDB } from './db.ts';
import { RETENTION_DAYS } from './errors.ts';
import { ENTRY_KINDS, usageEntries } from './schema.ts';
import { p75, weekStart } from './vitals.ts';

// Je eigen gebruik (spec: Telemetrie en monitoring, Volhouden): de PWA meldt elke invoer met
// alleen de dag, de soort en de tijd van openen tot opslaan. Daaruit: dagen met invoer per
// week, je reeks, en mediaan en p75 van openen tot opslaan. Alleen voor jezelf.

export const MAX_ENTRIES = 20;
/** Langer dan een half uur open is geen meting van invoeren meer; de client stuurt dan niets. */
export const MAX_DURATION_MS = 30 * 60_000;

const entry = z.strictObject({
	id: z.uuid(),
	day: z.string().refine(isIsoDate),
	kind: z.enum(ENTRY_KINDS),
	durationMs: z.number().int().min(0).max(MAX_DURATION_MS).nullable()
});

export const usageBody = z.strictObject({
	entries: z.array(entry).min(1).max(MAX_ENTRIES)
});

export type UsageEntry = z.infer<typeof entry>;

/**
 * Een dag ná morgen kan niet (morgen wel: de telefoon kan in een andere tijdzone staan dan de
 * server). Een dag van vóór de bewaartermijn slaan we stil over: die zou meteen weer opgeruimd
 * worden, en een oude invoer uit de wachtrij moet de rest niet tegenhouden.
 */
export function inFuture(entries: readonly UsageEntry[], today: string): boolean {
	return entries.some((e) => e.day > addDays(today, 1));
}

/** Slaat de invoer op; hetzelfde ID twee keer telt één keer. Geeft het aantal nieuwe rijen. */
export function recordUsage(
	db: TelemetryDB,
	entries: readonly UsageEntry[],
	today: string
): number {
	const from = addDays(today, -(RETENTION_DAYS - 1));
	const rows = entries.filter((e) => e.day >= from);
	if (rows.length === 0) return 0;
	return db
		.insert(usageEntries)
		.values(rows.map((e) => ({ id: e.id, day: e.day, kind: e.kind, durationMs: e.durationMs })))
		.onConflictDoNothing()
		.run().changes;
}

export function median(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

export interface UsageWeek {
	/** Maandag van de week, `YYYY-MM-DD`. */
	weekStart: string;
	/** Maandag tot en met zondag: had je die dag invoer? `null` voor een dag die nog komt. */
	days: (boolean | null)[];
	daysWithEntry: number;
	/** Dagen tot en met vandaag: 7, behalve in de lopende week. */
	daysSoFar: number;
	entries: number;
	/** Invoer met een gemeten tijd van openen tot opslaan. */
	timed: number;
	medianMs: number | null;
	p75Ms: number | null;
}

export interface UsageSummary {
	/** Nieuwste week eerst, vanaf de eerste week met invoer; leeg zonder invoer. */
	weeks: UsageWeek[];
	/** Dagen op rij met invoer tot en met vandaag; zolang vandaag nog loopt, telt gisteren mee. */
	streak: number;
	/** Langste reeks binnen de bewaartermijn. */
	longestStreak: number;
	/** Vandaag al iets ingevoerd? */
	today: boolean;
}

/** Dagen op rij in `days` vanaf `from`, in de richting van `step` (1 vooruit, -1 terug). */
function run(days: ReadonlySet<string>, from: string, step: 1 | -1): number {
	let n = 0;
	for (let d = from; days.has(d); d = addDays(d, step)) n++;
	return n;
}

/** Aggregaties voor de pagina Gebruik: puur, zodat ze los te testen zijn. */
export function summarizeUsage(
	rows: readonly { day: string; durationMs: number | null }[],
	today: string,
	weeks = 8
): UsageSummary {
	const days = new Set(rows.map((r) => r.day).filter((d) => d <= today));
	const hasToday = days.has(today);
	const streak = run(days, hasToday ? today : addDays(today, -1), -1);
	let longestStreak = 0;
	for (const d of days) {
		// Alleen vanaf het begin van een reeks vooruit tellen
		if (!days.has(addDays(d, -1))) longestStreak = Math.max(longestStreak, run(days, d, 1));
	}

	const current = weekStart(fromIsoDate(today));
	const oldest = addDays(current, -7 * (weeks - 1));
	const inRange = rows.filter((r) => r.day >= oldest && r.day <= today);
	if (inRange.length === 0) return { weeks: [], streak, longestStreak, today: hasToday };
	const first = weekStart(fromIsoDate(inRange.reduce((a, r) => (r.day < a ? r.day : a), today)));

	const result: UsageWeek[] = [];
	for (let week = current; week >= first; week = addDays(week, -7)) {
		const end = addDays(week, 6);
		const rowsOfWeek = inRange.filter((r) => r.day >= week && r.day <= end);
		const timed = rowsOfWeek.flatMap((r) => (r.durationMs === null ? [] : [r.durationMs]));
		const flags = Array.from({ length: 7 }, (_, i) => {
			const d = addDays(week, i);
			return d > today ? null : days.has(d);
		});
		result.push({
			weekStart: week,
			days: flags,
			daysWithEntry: flags.filter((f) => f === true).length,
			daysSoFar: flags.filter((f) => f !== null).length,
			entries: rowsOfWeek.length,
			timed: timed.length,
			medianMs: median(timed),
			p75Ms: p75(timed)
		});
	}
	return { weeks: result, streak, longestStreak, today: hasToday };
}

/** Gebruik binnen de bewaartermijn, met de laatste `weeks` weken. */
export function usageSummary(
	db: TelemetryDB,
	today = toIsoDate(new Date()),
	weeks = 8
): UsageSummary {
	const rows = db
		.select({ day: usageEntries.day, durationMs: usageEntries.durationMs })
		.from(usageEntries)
		.where(gte(usageEntries.day, addDays(today, -(RETENTION_DAYS - 1))))
		.all();
	return summarizeUsage(rows, today, weeks);
}
