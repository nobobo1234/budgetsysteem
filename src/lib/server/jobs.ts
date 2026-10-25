import { and, asc, eq, lte, notInArray } from 'drizzle-orm';
import type { Conn, DB } from './db/index.ts';
import { jobs } from './db/schema.ts';
import { log } from './log.ts';
import { describeError, recordError, telemetryDb } from './telemetry/index.ts';

// Achtergrondtaken in de `jobs`-tabel (spec: Architectuur): geen Redis of aparte queue. Eén
// proces, dus één worker; een taak wordt geclaimd door zijn status in één update te zetten.

export type JobHandler = (db: DB, payload: unknown, now: Date) => void;

const handlers = new Map<string, JobHandler>();
const MAX_ATTEMPTS = 3;
const TICK_MS = 60_000;

const declared = new Set<string>();

export function registerJob(kind: string, handler: JobHandler): void {
	handlers.set(kind, handler);
}

/**
 * Een soort taak die al in de wachtrij mag voordat er een handler is, zoals het lezen van een
 * bon (`bon_lezen`). Zulke taken blijven wachten tot `registerJob` hem invult, in plaats van
 * na drie pogingen te mislukken. Een onbekende soort die niet gedeclareerd is, mislukt wel.
 */
export function declareJob(kind: string): void {
	declared.add(kind);
}

/** Soorten die wel gedeclareerd zijn maar (nog) geen handler hebben: die slaan we over. */
function waitingForHandler(): string[] {
	return [...declared].filter((kind) => !handlers.has(kind));
}

export function enqueue(db: Conn, kind: string, runAt: Date, payload: unknown = null): string {
	return db
		.insert(jobs)
		.values({ kind, payload, runAt: runAt.toISOString() })
		.returning({ id: jobs.id })
		.get().id;
}

/** Plant een taak in als er nog geen wachtende van deze soort is. */
export function ensureScheduled(db: DB, kind: string, runAt: Date): void {
	const waiting = db
		.select({ id: jobs.id })
		.from(jobs)
		.where(and(eq(jobs.kind, kind), eq(jobs.status, 'wachtend')))
		.get();
	if (!waiting) enqueue(db, kind, runAt);
}

/**
 * Draait alle taken die aan de beurt zijn. Een fout zet de taak terug met een minuut
 * vertraging; na drie pogingen is hij mislukt. De foutmelding zelf kan data bevatten en
 * gaat niet de database in, alleen de soort fout.
 */
export function runDueJobs(db: DB, now = new Date()): number {
	const skip = waitingForHandler();
	const due = db
		.select()
		.from(jobs)
		.where(
			and(
				eq(jobs.status, 'wachtend'),
				lte(jobs.runAt, now.toISOString()),
				skip.length > 0 ? notInArray(jobs.kind, skip) : undefined
			)
		)
		.orderBy(asc(jobs.runAt))
		.limit(20)
		.all();
	let ran = 0;
	for (const job of due) {
		const claimed = db
			.update(jobs)
			.set({ status: 'bezig', attempts: job.attempts + 1 })
			.where(and(eq(jobs.id, job.id), eq(jobs.status, 'wachtend')))
			.run();
		if (claimed.changes !== 1) continue;
		const handler = handlers.get(job.kind);
		try {
			if (!handler) throw new Error(`Onbekende taak`);
			handler(db, job.payload, now);
			db.update(jobs).set({ status: 'klaar', lastError: null }).where(eq(jobs.id, job.id)).run();
			ran++;
		} catch (e) {
			const info = describeError(e);
			const failed = job.attempts + 1 >= MAX_ATTEMPTS;
			db.update(jobs)
				.set({
					status: failed ? 'mislukt' : 'wachtend',
					lastError: info.name,
					runAt: new Date(now.getTime() + TICK_MS).toISOString()
				})
				.where(eq(jobs.id, job.id))
				.run();
			const errorId = crypto.randomUUID();
			recordError(telemetryDb, {
				id: errorId,
				source: 'proces',
				error: e,
				route: `job:${job.kind}`
			});
			log.error({ errorId, job: job.kind, failed, err: info }, 'taak mislukt');
		}
	}
	return ran;
}

let timer: ReturnType<typeof setInterval> | undefined;

/** Start de worker: meteen één keer, daarna elke minuut. */
export function startJobs(db: () => DB): void {
	if (timer) return;
	// Een taak die bezig was toen het proces stopte, mag opnieuw
	db().update(jobs).set({ status: 'wachtend' }).where(eq(jobs.status, 'bezig')).run();
	const tick = () => {
		try {
			runDueJobs(db());
		} catch (e) {
			log.error({ err: describeError(e) }, 'taken draaien mislukt');
		}
	};
	tick();
	timer = setInterval(tick, TICK_MS);
	timer.unref();
}
