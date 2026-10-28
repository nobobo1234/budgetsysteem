import { desc, eq, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import {
	HISTORY_SHOWN,
	KEEP_QUESTIONS,
	QUESTIONS_PER_HOUR,
	type Clarification,
	type HistoryItem,
	type QuestionOutcome,
	type QuestionResult
} from '../../question.ts';
import { CAN_DO_EXAMPLES, refusalText } from '../../semantic/answer.ts';
import {
	MAX_QUESTION_CHARS,
	QuestionFormatSchema,
	QuerySchema,
	type Query,
	type QuestionFormat
} from '../../semantic/format.ts';
import { todayIn } from '../../semantic/period.ts';
import { findCounterparties } from '../../semantic/resolve.ts';
import { aiClient, type AiClient } from '../ai/client.ts';
import type { DB } from '../db/index.ts';
import { questions } from '../db/schema.ts';
import { ValidationError } from '../errors.ts';
import { log } from '../log.ts';
import { RateLimiter } from '../ratelimit.ts';
import { catalog, runQuery } from '../semantic.ts';
import { aiBudget, recordAiCall, recordAiWrong, type AiCallEvent } from '../telemetry/ai.ts';
import { telemetryDb, type TelemetryDB } from '../telemetry/db.ts';
import { describeError } from '../telemetry/errors.ts';
import type { AiOutcome } from '../telemetry/schema.ts';
import { translateQuestion, type FollowUp, type QuestionVariant } from './translator.ts';

// Het vraagveld (spec: Vragen en samenvattingen met AI → Vraagveld). Het model vertaalt de vraag
// naar het vraagformaat; code rekent het antwoord uit en schrijft de zin. Elke vraag komt in
// `questions` met haar soort, vraagformaat en aannames, nooit met het resultaat. Grenzen: 30
// vragen per uur en het maandbudget voor AI; is het op, dan zegt het vraagveld dat.

/** 30 vragen per uur; voor tests te legen. */
export const questionLimiter = new RateLimiter(QUESTIONS_PER_HOUR, 60 * 60 * 1000);

/** Waarom er nu geen vraag aan het model kan, of `null` als het kan. */
export type Unavailable = 'geen_sleutel' | 'budget';

export interface QuestionOptions {
	/** Standaard de client van de server; `null` is geen API-sleutel. Tests geven een nagebootste. */
	client?: AiClient | null;
	telemetry?: () => TelemetryDB;
	now?: Date;
	variant?: QuestionVariant;
}

/** Of het vraagveld nu een vraag kan stellen. Bij twijfel (geen telemetrie): niet. */
export function unavailable(opts: QuestionOptions = {}): Unavailable | null {
	const client = opts.client === undefined ? aiClient() : opts.client;
	if (!client) return 'geen_sleutel';
	try {
		if (!aiBudget((opts.telemetry ?? telemetryDb)(), opts.now ?? new Date()).available)
			return 'budget';
	} catch (e) {
		log.warn({ err: describeError(e) }, 'AI-budget niet te lezen');
		return 'budget';
	}
	return null;
}

const UNAVAILABLE_TEXT: Record<Unavailable, string> = {
	geen_sleutel: 'Het vraagveld is niet ingesteld: er is geen sleutel voor Claude.',
	budget: 'Het AI-budget van deze maand is op. Volgende maand kun je weer vragen stellen.'
};

const FAILED_TEXT = 'Deze vraag kon ik nu niet lezen. Probeer het anders te vragen.';

type Row = typeof questions.$inferSelect;

/** Het opgeslagen vraagformaat, of `null` als er geen (geldig) is. */
function formatOf(row: Row): QuestionFormat | null {
	const parsed = QuestionFormatSchema.safeParse(row.format);
	return parsed.success ? parsed.data : null;
}

const assumptionsSchema = z.array(z.string());

function save(
	db: DB,
	values: Omit<typeof questions.$inferInsert, 'id' | 'createdAt' | 'verdict'>
): string {
	const id = db.insert(questions).values(values).returning({ id: questions.id }).get().id;
	// Alleen de laatste 100 blijven bewaard
	const keep = db
		.select({ id: questions.id })
		.from(questions)
		.orderBy(desc(questions.createdAt), desc(questions.id))
		.limit(KEEP_QUESTIONS)
		.all()
		.map((r) => r.id);
	db.delete(questions).where(notInArray(questions.id, keep)).run();
	return id;
}

function record(
	telemetry: () => TelemetryDB,
	ref: string,
	usage: Omit<AiCallEvent, 'outcome'>,
	outcome: AiOutcome
) {
	try {
		recordAiCall(telemetry(), 'vraag', ref, { ...usage, outcome });
	} catch (e) {
		// Telemetrie mag een vraag nooit laten mislukken
		log.warn({ err: describeError(e) }, 'telemetrie vraag mislukt');
	}
}

/**
 * Rekent een vraag in het vraagformaat uit. Een weigering of verduidelijking door code (een
 * onbekende categorie, meer tegenpartijen) is een gewone uitkomst.
 */
function evaluate(
	db: DB,
	format: QuestionFormat,
	today: string,
	choice?: number
):
	| { kind: 'beantwoord'; result: Extract<ReturnType<typeof runQuery>, { ok: true }>['answer'] }
	| { kind: 'verduidelijken'; clarification: Clarification; reason: string | null }
	| { kind: 'kan_niet'; reason: string; code: string; example: string } {
	if (format.soort === 'verduidelijken')
		return {
			kind: 'verduidelijken',
			reason: null,
			clarification: { text: format.vraag, choices: format.keuzes, source: 'model' }
		};
	if (format.soort === 'kan_niet')
		return {
			kind: 'kan_niet',
			reason: format.reden,
			code: 'model',
			example: CAN_DO_EXAMPLES.standaard
		};
	const { soort: _, ...query } = format;
	const result = runQuery(db, query, today, { choice });
	if (result.ok) return { kind: 'beantwoord', result: result.answer };
	if (result.kind === 'verduidelijken')
		return {
			kind: 'verduidelijken',
			reason: result.refusal,
			clarification: {
				text: 'Welke tegenpartij bedoel je?',
				choices: result.choices,
				source: 'code'
			}
		};
	return {
		kind: 'kan_niet',
		reason: refusalText(result.refusal, result.detail),
		code: result.refusal,
		example: CAN_DO_EXAMPLES[query.maat]
	};
}

function toResult(
	id: string,
	question: string,
	e: ReturnType<typeof evaluate>,
	wrong = false
): QuestionResult {
	switch (e.kind) {
		case 'beantwoord':
			return { kind: 'beantwoord', id, question, answer: e.result, wrong };
		case 'verduidelijken':
			return { kind: 'verduidelijken', id, question, clarification: e.clarification };
		case 'kan_niet':
			return { kind: 'kan_niet', id, question, reason: e.reason, example: e.example };
	}
}

/** De soort voor `questions` en de telemetrie, en de aannames en reden om te bewaren. */
function stored(e: ReturnType<typeof evaluate>) {
	switch (e.kind) {
		case 'beantwoord':
			return {
				kind: 'beantwoord' as const,
				reason: null,
				assumptions: e.result.assumptions,
				rowCount: e.result.rows?.length ?? null
			};
		case 'verduidelijken':
			return {
				kind: 'verduidelijken' as const,
				reason: e.reason,
				assumptions: [],
				rowCount: null
			};
		case 'kan_niet':
			return { kind: 'kan_niet' as const, reason: e.code, assumptions: [], rowCount: null };
	}
}

/**
 * Stelt een vraag: het model vertaalt, code rekent. Gooit een `ValidationError` als de vraag te
 * lang is, de grens van dit uur bereikt is of er geen sleutel of budget is.
 */
export async function askQuestion(
	db: DB,
	text: string,
	opts: QuestionOptions & { followUp?: FollowUp } = {}
): Promise<QuestionResult> {
	const question = text.replace(/\s+/g, ' ').trim();
	if (question === '') throw new ValidationError('Typ eerst een vraag.');
	if (question.length > MAX_QUESTION_CHARS)
		throw new ValidationError(`Een vraag is hooguit ${MAX_QUESTION_CHARS} tekens.`);
	const blocked = unavailable(opts);
	if (blocked) throw new ValidationError(UNAVAILABLE_TEXT[blocked]);
	if (!questionLimiter.hit('vraag'))
		throw new ValidationError('Je stelde dit uur al dertig vragen. Probeer het straks weer.');

	const client = (opts.client === undefined ? aiClient() : opts.client)!;
	const telemetry = opts.telemetry ?? telemetryDb;
	const today = todayIn(opts.now ?? new Date());
	const cat = catalog(db);
	const translated = await translateQuestion(client, question, cat, today, {
		variant: opts.variant,
		followUp: opts.followUp
	});
	const ref = crypto.randomUUID();
	const shown = opts.followUp ? `${question} (${opts.followUp.choice})` : question;

	if (!translated.ok) {
		record(
			telemetry,
			ref,
			{ ...translated.usage, failure: translated.failure },
			translated.outcome
		);
		log.info({ outcome: translated.outcome, failure: translated.failure }, 'vraag niet gelezen');
		const id = save(db, {
			question: shown,
			kind: 'kan_niet',
			format: null,
			reason: translated.outcome,
			assumptions: [],
			rowCount: null,
			durationMs: translated.usage.durationMs,
			telemetryRef: ref
		});
		return {
			kind: 'kan_niet',
			id,
			question: shown,
			reason: FAILED_TEXT,
			example: CAN_DO_EXAMPLES.standaard
		};
	}

	const e = evaluate(db, translated.format, today);
	const s = stored(e);
	record(telemetry, ref, { ...translated.usage, failure: s.reason }, s.kind);
	log.info({ outcome: s.kind, reason: s.reason ?? undefined }, 'vraag beantwoord');
	const id = save(db, {
		question: shown,
		kind: s.kind,
		format: translated.format,
		reason: s.reason,
		assumptions: s.assumptions,
		rowCount: s.rowCount,
		durationMs: translated.usage.durationMs,
		telemetryRef: ref
	});
	return toResult(id, shown, e);
}

function load(db: DB, id: string): Row {
	const row = db.select().from(questions).where(eq(questions.id, id)).get();
	if (!row) throw new ValidationError('Deze vraag ken ik niet meer.');
	return row;
}

/**
 * Een eerdere vraag opnieuw: een beantwoorde vraag rekent code opnieuw uit met het bewaarde
 * vraagformaat, zonder model (de resultaten worden niet bewaard). Een andere vraag gaat opnieuw
 * naar het model.
 */
export async function askAgain(
	db: DB,
	id: string,
	opts: QuestionOptions = {}
): Promise<QuestionResult> {
	const row = load(db, id);
	const format = formatOf(row);
	if (row.kind === 'beantwoord' && format?.soort === 'vraag') {
		const today = todayIn(opts.now ?? new Date());
		return toResult(row.id, row.question, evaluate(db, format, today), row.verdict === 'fout');
	}
	return askQuestion(db, row.question, opts);
}

/**
 * Een keuze uit een verduidelijking. Van code (meer tegenpartijen): meteen uitrekenen met de
 * gekozen naam, en de vraag bewaren als beantwoord. Van het model: de vraag opnieuw stellen met
 * de keuze erbij.
 */
export async function choose(
	db: DB,
	id: string,
	index: number,
	opts: QuestionOptions = {}
): Promise<QuestionResult> {
	const row = load(db, id);
	const format = formatOf(row);
	if (row.kind !== 'verduidelijken' || !format)
		throw new ValidationError('Hier is niets te kiezen.');
	if (format.soort === 'verduidelijken') {
		const choice = format.keuzes[index];
		if (choice === undefined) throw new ValidationError('Deze keuze ken ik niet.');
		return askQuestion(db, row.question, {
			...opts,
			followUp: { clarification: format.vraag, choice }
		});
	}
	if (format.soort !== 'vraag') throw new ValidationError('Hier is niets te kiezen.');
	const today = todayIn(opts.now ?? new Date());
	const e = evaluate(db, format, today, index);
	if (e.kind !== 'beantwoord') return toResult(row.id, row.question, e);
	// Bewaar de gekozen naam, zodat de vraag later zonder keuze opnieuw uit te rekenen is
	const name = findCounterparties(format.filters.tegenpartij ?? '', catalog(db).counterparties)[
		index
	];
	const resolved = QuerySchema.parse({
		...stripKind(format),
		filters: { ...format.filters, tegenpartij: name ?? null }
	});
	db.update(questions)
		.set({
			kind: 'beantwoord',
			format: { soort: 'vraag', ...resolved },
			reason: null,
			assumptions: e.result.assumptions,
			rowCount: e.result.rows?.length ?? null
		})
		.where(eq(questions.id, row.id))
		.run();
	return toResult(row.id, row.question, e);
}

const stripKind = (f: Extract<QuestionFormat, { soort: 'vraag' }>): Query => {
	const { soort: _, ...query } = f;
	return query;
};

/**
 * "Klopt niet" op een antwoord: bewaard bij de vraag en geteld in de telemetrie, zonder de vraag
 * of het resultaat daarheen te sturen. Twee keer tikken telt één keer.
 */
export function markWrong(db: DB, id: string, telemetry: () => TelemetryDB = telemetryDb): void {
	const row = load(db, id);
	if (row.kind !== 'beantwoord') throw new ValidationError('Alleen een antwoord kan niet kloppen.');
	if (row.verdict === 'fout') return;
	db.update(questions).set({ verdict: 'fout' }).where(eq(questions.id, id)).run();
	if (!row.telemetryRef) return;
	try {
		recordAiWrong(telemetry(), row.telemetryRef);
	} catch (e) {
		log.warn({ err: describeError(e) }, 'telemetrie klopt niet mislukt');
	}
}

/** De laatste vragen onder het veld, nieuwste eerst: vraag, soort en aannames. */
export function questionHistory(db: DB, limit = HISTORY_SHOWN): HistoryItem[] {
	return db
		.select()
		.from(questions)
		.orderBy(desc(questions.createdAt), desc(questions.id))
		.limit(limit)
		.all()
		.map((r) => ({
			id: r.id,
			question: r.question,
			kind: r.kind as QuestionOutcome,
			assumptions: assumptionsSchema.catch([]).parse(r.assumptions),
			createdAt: r.createdAt
		}));
}
