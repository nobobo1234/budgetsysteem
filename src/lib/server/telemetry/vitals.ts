import { gte } from 'drizzle-orm';
import { z } from 'zod';
import { addDays, fromIsoDate, toIsoDate } from '../../dates.ts';
import type { TelemetryDB } from './db.ts';
import { VITAL_NAMES, webVitals, type VitalName } from './schema.ts';

// Snelheid in de praktijk (spec: Telemetrie en monitoring): de PWA stuurt INP, LCP en een paar
// andere web-vitals; de statuspagina toont p75 per week. Alleen naam en waarde.

const MINUTE = 60_000;

/** Wat een meting redelijkerwijs kan zijn; daarbuiten is het onzin en slaan we niets op. */
const RANGES: Record<VitalName, { min: number; minExclusive?: boolean; max: number }> = {
	LCP: { min: 0, minExclusive: true, max: MINUTE },
	FCP: { min: 0, minExclusive: true, max: MINUTE },
	INP: { min: 0, max: MINUTE },
	TTFB: { min: 0, max: MINUTE },
	CLS: { min: 0, max: 10 }
};

/** Grenzen van web.dev voor "goed" en "slecht" (p75). */
const THRESHOLDS: Record<VitalName, [good: number, poor: number]> = {
	LCP: [2500, 4000],
	FCP: [1800, 3000],
	INP: [200, 500],
	TTFB: [800, 1800],
	CLS: [0.1, 0.25]
};

export const MAX_METRICS = 10;

const metric = z
	.strictObject({ name: z.enum(VITAL_NAMES), value: z.number().finite() })
	.refine(({ name, value }) => {
		const r = RANGES[name];
		return (r.minExclusive ? value > r.min : value >= r.min) && value <= r.max;
	});

export const vitalsBody = z.strictObject({
	metrics: z.array(metric).min(1).max(MAX_METRICS)
});

export type Vital = z.infer<typeof metric>;

export function recordVitals(db: TelemetryDB, metrics: Vital[]): void {
	db.insert(webVitals)
		.values(metrics.map((m) => ({ name: m.name, value: m.value })))
		.run();
}

/** 75e percentiel met de nearest-rank-methode; `null` zonder metingen. */
export function p75(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.ceil(0.75 * sorted.length) - 1]!;
}

export type Rating = 'goed' | 'matig' | 'slecht';

export function rate(name: VitalName, value: number): Rating {
	const [good, poor] = THRESHOLDS[name];
	return value <= good ? 'goed' : value <= poor ? 'matig' : 'slecht';
}

/** Maandag van de week (lokale tijd) als `YYYY-MM-DD`. */
export function weekStart(d: Date): string {
	const iso = toIsoDate(d);
	return addDays(iso, -((fromIsoDate(iso).getDay() + 6) % 7));
}

export interface WeekVitals {
	/** Maandag van de week, `YYYY-MM-DD`. */
	weekStart: string;
	metrics: Partial<Record<VitalName, { p75: number; count: number; rating: Rating }>>;
}

/** p75 per week en per meting, nieuwste week eerst; alleen weken met metingen. */
export function weeklyP75(rows: readonly { at: string; name: VitalName; value: number }[]) {
	const byWeek = new Map<string, Map<VitalName, number[]>>();
	for (const row of rows) {
		const week = weekStart(new Date(row.at));
		const names = byWeek.get(week) ?? new Map<VitalName, number[]>();
		byWeek.set(week, names);
		const values = names.get(row.name) ?? [];
		names.set(row.name, values);
		values.push(row.value);
	}
	return [...byWeek.keys()]
		.sort()
		.reverse()
		.map((week): WeekVitals => {
			const metrics: WeekVitals['metrics'] = {};
			for (const [name, values] of byWeek.get(week)!) {
				const value = p75(values)!;
				metrics[name] = { p75: value, count: values.length, rating: rate(name, value) };
			}
			return { weekStart: week, metrics };
		});
}

/** Web-vitals van de laatste `weeks` weken, inclusief de lopende week. */
export function recentVitals(db: TelemetryDB, now = new Date(), weeks = 8): WeekVitals[] {
	const from = fromIsoDate(addDays(weekStart(now), -7 * (weeks - 1)));
	const rows = db
		.select({ at: webVitals.at, name: webVitals.name, value: webVitals.value })
		.from(webVitals)
		.where(gte(webVitals.at, from.toISOString()))
		.all();
	return weeklyP75(rows);
}
