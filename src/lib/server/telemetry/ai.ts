import { and, eq, gte, sql } from 'drizzle-orm';
import { shiftMonth } from '../../dates.ts';
import { TIME_ZONE, zonedParts, zonedTime } from '../../closing.ts';
import { config } from '../config.ts';
import type { TelemetryDB } from './db.ts';
import { aiCalls, receiptReads, type AiFeature, type AiOutcome } from './schema.ts';

// Telemetrie per samenvatting en (later) per vraag (spec: Telemetrie en monitoring, AI), en de
// AI-kosten van deze maand tegenover het maandbudget (spec: LLM06). Alleen tellingen, soorten en
// tijden; nooit de feiten, zinnen, vragen of resultaten.

const DAY = 86_400_000;

export interface AiCallEvent {
	model: string;
	inputTokens: number;
	outputTokens: number;
	costNanoUsd: number;
	durationMs: number;
	outcome: AiOutcome;
	/** Welke controle faalde (`cijfer`, `naam` ...), alleen bij `controle` */
	failure?: string | null;
}

export function recordAiCall(
	db: TelemetryDB,
	feature: AiFeature,
	ref: string,
	event: AiCallEvent
): void {
	db.insert(aiCalls)
		.values({
			ref,
			feature,
			model: event.model.slice(0, 64),
			inputTokens: event.inputTokens,
			outputTokens: event.outputTokens,
			costNanoUsd: event.costNanoUsd,
			durationMs: event.durationMs,
			outcome: event.outcome,
			failure: event.failure?.slice(0, 32) ?? null
		})
		.run();
}

/** Je tikte "klopt niet" op een zin of antwoord van deze aanroep. */
export function recordAiWrong(db: TelemetryDB, ref: string): void {
	db.update(aiCalls)
		.set({ wrong: sql`${aiCalls.wrong} + 1` })
		.where(eq(aiCalls.ref, ref))
		.run();
}

/** Mediaan van een lijst duren, of `null` zonder waarden. */
export function medianOf(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = values.toSorted((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

export interface AiCallSummary {
	days: number;
	calls: number;
	outcomes: Record<AiOutcome, number>;
	/** Aanroepen waarbij de vaste tekst er kwam omdat het model niet bruikbaar antwoordde */
	fallback: number;
	inputTokens: number;
	outputTokens: number;
	costNanoUsd: number;
	medianMs: number | null;
	/** Aanroepen met minstens één "klopt niet", en hoe vaak je in totaal tikte */
	wrongCalls: number;
	wrongTaps: number;
}

const SUCCESS: ReadonlySet<AiOutcome> = new Set([
	'geschreven',
	'beantwoord',
	'verduidelijken',
	'kan_niet'
]);

export function summarizeAiCalls(
	rows: readonly {
		outcome: AiOutcome;
		inputTokens: number;
		outputTokens: number;
		costNanoUsd: number;
		durationMs: number;
		wrong: number;
	}[],
	days: number
): AiCallSummary {
	const outcomes = {
		geschreven: 0,
		beantwoord: 0,
		verduidelijken: 0,
		kan_niet: 0,
		controle: 0,
		weigering: 0,
		afgekapt: 0,
		ongeldig: 0,
		fout: 0
	} satisfies Record<AiOutcome, number>;
	let fallback = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let costNanoUsd = 0;
	let wrongCalls = 0;
	let wrongTaps = 0;
	for (const r of rows) {
		outcomes[r.outcome]++;
		if (!SUCCESS.has(r.outcome)) fallback++;
		inputTokens += r.inputTokens;
		outputTokens += r.outputTokens;
		costNanoUsd += r.costNanoUsd;
		if (r.wrong > 0) wrongCalls++;
		wrongTaps += r.wrong;
	}
	return {
		days,
		calls: rows.length,
		outcomes,
		fallback,
		inputTokens,
		outputTokens,
		costNanoUsd,
		medianMs: medianOf(rows.map((r) => r.durationMs)),
		wrongCalls,
		wrongTaps
	};
}

/** Samenvatting van de laatste `days` dagen voor één functie, voor de statuspagina. */
export function aiCallSummary(
	db: TelemetryDB,
	feature: AiFeature,
	now = new Date(),
	days = 30
): AiCallSummary {
	const rows = db
		.select({
			outcome: aiCalls.outcome,
			inputTokens: aiCalls.inputTokens,
			outputTokens: aiCalls.outputTokens,
			costNanoUsd: aiCalls.costNanoUsd,
			durationMs: aiCalls.durationMs,
			wrong: aiCalls.wrong
		})
		.from(aiCalls)
		.where(
			and(
				eq(aiCalls.feature, feature),
				gte(aiCalls.at, new Date(now.getTime() - days * DAY).toISOString())
			)
		)
		.all();
	return summarizeAiCalls(rows, days);
}

export interface AiBudget {
	/** De kalendermaand in Nederland (`YYYY-MM`) */
	month: string;
	spentNanoUsd: number;
	budgetNanoUsd: number;
	/** Of er nog ruimte is voor een aanroep die niet voorgaat (alles behalve bonnen) */
	available: boolean;
}

/**
 * Wat alle AI-aanroepen samen deze maand kostten (bonnen, samenvattingen, vragen), tegenover
 * het maandbudget. De maand volgt de klok in Nederland; telemetrie blijft 90 dagen, dus de
 * lopende maand is er altijd helemaal.
 */
export function aiBudget(
	db: TelemetryDB,
	now = new Date(),
	budgetUsdCents = config().AI_MONTHLY_BUDGET_USD_CENTS
): AiBudget {
	const month = zonedParts(now, TIME_ZONE).date.slice(0, 7);
	const from = zonedTime(`${month}-01`, 0, TIME_ZONE).toISOString();
	const to = zonedTime(`${shiftMonth(month, 1)}-01`, 0, TIME_ZONE).toISOString();
	const sum = (table: typeof aiCalls | typeof receiptReads) =>
		db
			.select({ cost: sql<number | null>`SUM(${table.costNanoUsd})` })
			.from(table)
			.where(and(gte(table.at, from), sql`${table.at} < ${to}`))
			.get()?.cost ?? 0;
	const spentNanoUsd = sum(aiCalls) + sum(receiptReads);
	const budgetNanoUsd = budgetUsdCents * 10_000_000;
	return { month, spentNanoUsd, budgetNanoUsd, available: spentNanoUsd < budgetNanoUsd };
}
