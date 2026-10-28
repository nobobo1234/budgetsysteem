import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
	FACT_KINDS,
	fixedSentences,
	MAX_CALLS_PER_MONTH,
	type MonthSummary,
	type SummaryReason,
	type SummarySentence,
	type SummarySource
} from '../../summary.ts';
import { aiClient, type AiClient } from '../ai/client.ts';
import { hasMonthData } from '../closing.ts';
import type { DB } from '../db/index.ts';
import { monthSummaries } from '../db/schema.ts';
import { ValidationError } from '../errors.ts';
import { log } from '../log.ts';
import { aiBudget, recordAiCall, recordAiWrong } from '../telemetry/ai.ts';
import { telemetryDb } from '../telemetry/db.ts';
import { describeError } from '../telemetry/errors.ts';
import type { TelemetryDB } from '../telemetry/db.ts';
import { monthFacts } from './facts.ts';
import { writeSummary } from './writer.ts';

// Maandsamenvatting (spec: Vragen en samenvattingen met AI → Maandsamenvatting, Wanneer). Eén
// keer bij het openen van een afsluiting, daarna bewaard in `month_summaries`. Opnieuw alleen als
// de feiten veranderen (een late import geeft een andere sleutel) of met "Opnieuw", hooguit vijf
// aanroepen per maand. Zonder sleutel, met het AI-budget op of na vijf keer: de vaste tekst.

export type { MonthSummary, SummaryReason, SummarySentence, SummarySource };

const cents = z.number().int();
const factSchema = z.object({
	id: z.string().regex(/^f\d{1,2}$/),
	soort: z.enum(FACT_KINDS),
	naam: z.string().max(60),
	nu: cents,
	gem3: cents,
	gem6: cents,
	verschil: cents,
	richting: z.enum(['hoger', 'lager']),
	sinds: z
		.string()
		.regex(/^\d{4}-\d{2}$/)
		.nullable(),
	nieuw: z.boolean()
});
const sentenceSchema = z.object({
	tekst: z.string().max(400),
	delen: z.array(z.object({ text: z.string().max(400), num: z.boolean() })),
	feiten: z.array(z.string()),
	wrong: z.boolean().default(false)
});

function parse(row: typeof monthSummaries.$inferSelect): MonthSummary {
	return {
		month: row.month,
		source: row.source,
		reason: row.reason,
		facts: z.array(factSchema).parse(row.facts),
		sentences: z.array(sentenceSchema).parse(row.sentences),
		callsLeft: Math.max(0, MAX_CALLS_PER_MONTH - row.calls)
	};
}

function load(db: DB, month: string) {
	return db.select().from(monthSummaries).where(eq(monthSummaries.month, month)).get();
}

function save(
	db: DB,
	values: Omit<typeof monthSummaries.$inferInsert, 'id' | 'createdAt' | 'updatedAt'>
): MonthSummary {
	const row = db
		.insert(monthSummaries)
		.values(values)
		.onConflictDoUpdate({
			target: monthSummaries.month,
			set: { ...values, updatedAt: new Date().toISOString() }
		})
		.returning()
		.get();
	return parse(row);
}

export interface SummaryOptions {
	/** Standaard de client van de server; `null` is geen API-sleutel. Tests geven een nagebootste. */
	client?: AiClient | null;
	telemetry?: () => TelemetryDB;
	now?: Date;
	/** "Opnieuw": ook schrijven als de feiten niet veranderden */
	again?: boolean;
}

/** Waarom er geen aanroep mag, of `null` als het mag. Bij twijfel (geen telemetrie): niet. */
function blocked(
	client: AiClient | null,
	calls: number,
	telemetry: () => TelemetryDB,
	now: Date
): SummaryReason | null {
	if (!client) return 'geen_sleutel';
	if (calls >= MAX_CALLS_PER_MONTH) return 'limiet';
	try {
		if (!aiBudget(telemetry(), now).available) return 'budget';
	} catch (e) {
		log.warn({ err: describeError(e) }, 'AI-budget niet te lezen');
		return 'budget';
	}
	return null;
}

async function produce(db: DB, month: string, opts: SummaryOptions): Promise<MonthSummary> {
	const telemetry = opts.telemetry ?? telemetryDb;
	const now = opts.now ?? new Date();
	const client = opts.client === undefined ? aiClient() : opts.client;
	const { facts, names, key } = monthFacts(db, month);
	const row = load(db, month);
	const calls = row?.calls ?? 0;
	// Een vaste tekst omdat er geen sleutel of budget was, probeert het later vanzelf opnieuw
	const waited =
		row?.source === 'vast' && (row.reason === 'budget' || row.reason === 'geen_sleutel');
	if (row && row.factsKey === key && !opts.again && !waited) return parse(row);

	const base = { month, factsKey: key, facts, calls, telemetryRef: null };
	if (facts.length === 0) return save(db, { ...base, sentences: [], source: 'leeg', reason: null });

	const reason = blocked(client, calls, telemetry, now);
	if (reason) {
		// "Opnieuw" zonder dat het mag laat de bestaande tekst staan
		if (row && row.factsKey === key) return parse(row);
		return save(db, { ...base, sentences: fixedSentences(facts, month), source: 'vast', reason });
	}

	const result = await writeSummary(client!, facts, month, { names });
	const ref = crypto.randomUUID();
	try {
		recordAiCall(telemetry(), 'samenvatting', ref, {
			...result.usage,
			outcome: result.ok ? 'geschreven' : result.outcome,
			failure: result.ok ? null : result.failure
		});
	} catch (e) {
		// Telemetrie mag de samenvatting nooit laten mislukken
		log.warn({ err: describeError(e) }, 'telemetrie samenvatting mislukt');
	}
	log.info(
		{
			outcome: result.ok ? 'geschreven' : result.outcome,
			failure: result.ok ? undefined : result.failure
		},
		'samenvatting geschreven'
	);
	return save(db, {
		...base,
		calls: calls + 1,
		telemetryRef: ref,
		...(result.ok
			? { sentences: result.sentences, source: 'haiku', reason: null }
			: { sentences: fixedSentences(facts, month), source: 'vast', reason: result.outcome })
	});
}

// Eén aanroep tegelijk per maand: twee keer snel openen geeft niet twee aanroepen
const inFlight = new Map<string, Promise<MonthSummary>>();

/**
 * De samenvatting van een afgelopen maand: bewaard als de feiten gelijk zijn, anders nieuw. Voor
 * een lopende maand of een maand zonder gegevens `null`: daar staat geen kaart.
 */
export function monthSummary(
	db: DB,
	month: string,
	today: string,
	opts: SummaryOptions = {}
): Promise<MonthSummary | null> {
	if (month >= today.slice(0, 7) || !hasMonthData(db, month)) return Promise.resolve(null);
	const running = inFlight.get(month);
	if (running) return running;
	const next = produce(db, month, opts).finally(() => inFlight.delete(month));
	inFlight.set(month, next);
	return next;
}

/** "Opnieuw": een nieuwe aanroep, als dat mag. Zegt anders waarom niet. */
export async function summaryAgain(
	db: DB,
	month: string,
	today: string,
	opts: Omit<SummaryOptions, 'again'> = {}
): Promise<MonthSummary> {
	const row = load(db, month);
	if (!row || row.source === 'leeg')
		throw new ValidationError('Er is niets om opnieuw te schrijven.');
	const client = opts.client === undefined ? aiClient() : opts.client;
	const reason = blocked(client, row.calls, opts.telemetry ?? telemetryDb, opts.now ?? new Date());
	if (reason === 'limiet')
		throw new ValidationError('Deze maand is al vijf keer geschreven; de tekst blijft zo staan.');
	if (reason === 'budget') throw new ValidationError('Het AI-budget van deze maand is op.');
	if (reason === 'geen_sleutel') throw new ValidationError('Haiku is niet ingesteld.');
	const summary = await monthSummary(db, month, today, { ...opts, again: true });
	if (!summary) throw new ValidationError('Deze maand heeft geen samenvatting.');
	return summary;
}

/**
 * "Klopt niet" op één zin: bewaard bij de samenvatting (voor de goudset) en geteld in de
 * telemetrie, zonder de zin zelf daarheen te sturen. Twee keer tikken telt één keer.
 */
export function markSentenceWrong(
	db: DB,
	month: string,
	index: number,
	telemetry: () => TelemetryDB = telemetryDb
): void {
	const row = load(db, month);
	if (!row) throw new ValidationError('Deze samenvatting ken ik niet.');
	const summary = parse(row);
	const sentence = summary.sentences[index];
	if (!sentence) throw new ValidationError('Deze zin ken ik niet.');
	if (sentence.wrong) return;
	const sentences = summary.sentences.map((s, i) => (i === index ? { ...s, wrong: true } : s));
	db.update(monthSummaries)
		.set({ sentences, updatedAt: new Date().toISOString() })
		.where(eq(monthSummaries.id, row.id))
		.run();
	if (!row.telemetryRef) return;
	try {
		recordAiWrong(telemetry(), row.telemetryRef);
	} catch (e) {
		log.warn({ err: describeError(e) }, 'telemetrie klopt niet mislukt');
	}
}
