import { and, desc, eq, gte } from 'drizzle-orm';
import type { ReceiptTelemetry } from '../receipts/reader.ts';
import type { TelemetryDB } from './db.ts';
import { receiptReads, type ReceiptReadOutcome } from './schema.ts';

// Telemetrie per Haiku-aanroep (spec: Telemetrie en monitoring, AI): tokens, kosten, duur,
// uitkomst en of je velden achteraf corrigeerde. Zo zie je de nauwkeurigheid over tijd. Alleen
// het ID van de bon en namen van velden; nooit wat er op de bon staat.

const DAY = 86_400_000;

/** Velden waarvan een correctie telt; dezelfde als in de eval. */
export const CORRECTABLE_FIELDS = ['winkel', 'datum', 'totaal', 'valuta'] as const;
export type CorrectableField = (typeof CORRECTABLE_FIELDS)[number];

export function recordReceiptRead(
	db: TelemetryDB,
	receiptId: string | null,
	event: ReceiptTelemetry
): void {
	db.insert(receiptReads)
		.values({
			receiptId,
			model: event.model.slice(0, 64),
			parts: event.parts,
			inputTokens: event.inputTokens,
			outputTokens: event.outputTokens,
			costNanoUsd: event.costNanoUsd,
			durationMs: event.durationMs,
			outcome: event.outcome
		})
		.run();
}

/**
 * Legt vast welke velden je achteraf corrigeerde, op de laatste aanroep voor deze bon. Een
 * volgende correctie voegt velden toe; `sure` blijft waar als het één keer waar was.
 */
export function recordCorrection(
	db: TelemetryDB,
	receiptId: string,
	fields: readonly CorrectableField[],
	sure: boolean
): void {
	if (fields.length === 0) return;
	const last = db
		.select({
			id: receiptReads.id,
			corrected: receiptReads.corrected,
			sure: receiptReads.correctedSure
		})
		.from(receiptReads)
		.where(eq(receiptReads.receiptId, receiptId))
		.orderBy(desc(receiptReads.id))
		.get();
	if (!last) return;
	const all = new Set([...(last.corrected ? last.corrected.split(',') : []), ...fields]);
	db.update(receiptReads)
		.set({
			corrected: CORRECTABLE_FIELDS.filter((f) => all.has(f)).join(','),
			correctedSure: last.sure || sure
		})
		.where(eq(receiptReads.id, last.id))
		.run();
}

export interface ReceiptReadSummary {
	days: number;
	calls: number;
	outcomes: Record<ReceiptReadOutcome, number>;
	inputTokens: number;
	outputTokens: number;
	costNanoUsd: number;
	/** Mediaan van de duur, of `null` zonder aanroepen. */
	medianMs: number | null;
	/** Aanroepen waarvan je achteraf minstens één veld corrigeerde. */
	corrected: number;
	/** Daarvan met een veld dat zeker heette: het getal dat laag moet blijven. */
	correctedSure: number;
	/** Hoe vaak per veld gecorrigeerd. */
	correctedFields: Record<CorrectableField, number>;
}

export function summarizeReceiptReads(
	rows: readonly {
		outcome: ReceiptReadOutcome;
		inputTokens: number;
		outputTokens: number;
		costNanoUsd: number;
		durationMs: number;
		corrected: string | null;
		correctedSure: boolean;
	}[],
	days: number
): ReceiptReadSummary {
	const outcomes = {
		zeker: 0,
		controleren: 0,
		onzeker: 0,
		weigering: 0,
		afgekapt: 0,
		ongeldig: 0,
		fout: 0
	} satisfies Record<ReceiptReadOutcome, number>;
	const correctedFields = { winkel: 0, datum: 0, totaal: 0, valuta: 0 } satisfies Record<
		CorrectableField,
		number
	>;
	let inputTokens = 0;
	let outputTokens = 0;
	let costNanoUsd = 0;
	let corrected = 0;
	let correctedSure = 0;
	for (const r of rows) {
		outcomes[r.outcome]++;
		inputTokens += r.inputTokens;
		outputTokens += r.outputTokens;
		costNanoUsd += r.costNanoUsd;
		if (r.corrected) {
			corrected++;
			for (const f of r.corrected.split(',')) {
				if (Object.hasOwn(correctedFields, f)) correctedFields[f as CorrectableField]++;
			}
		}
		if (r.correctedSure) correctedSure++;
	}
	const durations = rows.map((r) => r.durationMs).sort((a, b) => a - b);
	const mid = Math.floor(durations.length / 2);
	const medianMs =
		durations.length === 0
			? null
			: durations.length % 2 === 1
				? durations[mid]!
				: Math.round((durations[mid - 1]! + durations[mid]!) / 2);
	return {
		days,
		calls: rows.length,
		outcomes,
		inputTokens,
		outputTokens,
		costNanoUsd,
		medianMs,
		corrected,
		correctedSure,
		correctedFields
	};
}

/** Samenvatting van de laatste `days` dagen, voor de statuspagina. */
export function receiptReadSummary(
	db: TelemetryDB,
	now = new Date(),
	days = 30
): ReceiptReadSummary {
	const rows = db
		.select({
			outcome: receiptReads.outcome,
			inputTokens: receiptReads.inputTokens,
			outputTokens: receiptReads.outputTokens,
			costNanoUsd: receiptReads.costNanoUsd,
			durationMs: receiptReads.durationMs,
			corrected: receiptReads.corrected,
			correctedSure: receiptReads.correctedSure
		})
		.from(receiptReads)
		.where(and(gte(receiptReads.at, new Date(now.getTime() - days * DAY).toISOString())))
		.all();
	return summarizeReceiptReads(rows, days);
}
