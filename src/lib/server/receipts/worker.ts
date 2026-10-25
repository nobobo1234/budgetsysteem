import type Anthropic from '@anthropic-ai/sdk';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { centsToInput, formatCents } from '../../money.ts';
import { budgetCheckSoon } from '../budget-notify.ts';
import type { DB } from '../db/index.ts';
import { registerJob } from '../jobs.ts';
import { log } from '../log.ts';
import { notify } from '../push/notify.ts';
import { recordReceiptRead } from '../telemetry/receipts.ts';
import { telemetryDb } from '../telemetry/index.ts';
import { prepareImage, type Variant } from './images.ts';
import { loadReceipt, markReadFailed, saveReading, type SavedReading } from './process.ts';
import { processReceipt, type ReceiptClient, type ReceiptTelemetry } from './reader.ts';
import { READ_RECEIPT_JOB, receiptPath } from './store.ts';
import { MAX_RAW_CHARS, toStoredConfidence, toStoredFields, type RawOutput } from './stored.ts';

// De taak `bon_lezen` (spec: Bonnetjes en koppelen, Verwerking stap 3 tot 5): de opgeslagen bon
// voorbereiden, door Haiku laten lezen, controleren en opslaan, en verwerken als dat zonder
// twijfel kan. Een fout van de API gooit hij door: de job-worker probeert het twee keer opnieuw
// en legt de fout vast (zonder melding of data); na de laatste poging staat de bon op fout.

/**
 * 2576 px aan de lange kant, en lange bonnen (meer dan 3,5 keer zo lang als breed) in
 * overlappende stukken. Uit de eval op 22 eigen bonnen: 2576 px haalde 100% bij "zeker" op
 * winkel, datum, totaal en valuta, 1600 px las één winkel zeker maar fout (spec: Beeldkwaliteit).
 */
export const READ_VARIANT: Variant = 'stukken';

const payloadSchema = z.object({ receiptId: z.uuid() });

/** Haalt de ruwe uitvoer uit het antwoord, zonder de lezer zelf te veranderen. */
function capturing(client: ReceiptClient): { client: ReceiptClient; raw: () => RawOutput | null } {
	let message: Anthropic.Message | null = null;
	const create = (async (...args: Parameters<ReceiptClient['messages']['create']>) => {
		const result = (await client.messages.create(...args)) as Anthropic.Message;
		message = result;
		return result;
	}) as ReceiptClient['messages']['create'];
	return {
		client: { messages: { create } },
		raw: () => {
			if (!message) return null;
			const m: Anthropic.Message = message;
			const text = m.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text;
			return {
				stopReason: m.stop_reason,
				text: text === undefined ? null : text.slice(0, MAX_RAW_CHARS)
			};
		}
	};
}

function telemetryHook(receiptId: string) {
	return (event: ReceiptTelemetry) => recordReceiptRead(telemetryDb(), receiptId, event);
}

/** Leest één bon. Exporteert los van de job, zodat de integratietest hem direct kan aanroepen. */
export async function readStoredReceipt(
	db: DB,
	client: ReceiptClient,
	receiptId: string,
	now = new Date()
): Promise<SavedReading | null> {
	const receipt = loadReceipt(db, receiptId);
	// Weggegooid of al gelezen: niets te doen
	if (!receipt || receipt.status !== 'wordt_gelezen') return null;
	const input = await readFile(receiptPath(receipt.fileId, receipt.mediaType));
	const parts = await prepareImage(input, READ_VARIANT);
	const capture = capturing(client);
	const result = await processReceipt(capture.client, parts, new Date(receipt.createdAt), {
		onTelemetry: telemetryHook(receiptId)
	});
	const raw = capture.raw();
	const saved = saveReading(
		db,
		receiptId,
		result.ok
			? {
					ok: true,
					outcome: result.checked.outcome,
					fields: toStoredFields(result.checked),
					confidence: toStoredConfidence(result.checked),
					raw: raw ?? { stopReason: null, text: null }
				}
			: { ok: false, reason: result.reason, raw },
		now
	);
	if (saved) {
		log.info({ receipt: receiptId, status: saved.status, stage: saved.stage }, 'bon gelezen');
		if (saved.transactionId) budgetCheckSoon();
		void notifyRead(db, receiptId, saved, now);
	}
	return saved;
}

function amountText(cents: number, currency: string | null): string {
	return currency === null || currency === 'EUR'
		? formatCents(cents)
		: `${currency} ${centsToInput(cents)}`;
}

/**
 * Pushmelding zodra een bon gelezen is (spec: Meldingen, Uploaden via het deelmenu). Standaard
 * zonder bedragen of namen; de winkel en het bedrag alleen als dat aanstaat.
 */
export function notifyRead(db: DB, receiptId: string, saved: SavedReading, at: Date) {
	const { fields, stage } = saved;
	const what =
		fields.store && fields.totalCents !== null
			? `${fields.store.slice(0, 40)}: ${amountText(fields.totalCents, fields.currency)}`
			: null;
	const texts: Record<typeof stage, { text: string; detail: string | null }> = {
		klaar: {
			text: 'Een bon is gelezen en verwerkt',
			detail: what && `${what} verwerkt`
		},
		nakijken: {
			text: 'Een bon is gelezen; kijk hem even na',
			detail: what && `${what}; kijk hem even na`
		},
		kiezen: {
			text: 'Een bon is gelezen; kies waar hij bij hoort',
			detail: what && `${what}; kies waar hij bij hoort`
		},
		onzeker: { text: 'Een bon heeft je controle nodig', detail: null },
		fout: { text: 'Een bon kon niet gelezen worden', detail: null },
		wordt_gelezen: { text: 'Een bon wordt gelezen', detail: null }
	};
	const t = texts[stage];
	return notify(
		'bon',
		{
			// Eén melding per keer lezen; opnieuw lezen mag weer een melding geven
			key: `${receiptId}:${at.toISOString()}`,
			text: t.text,
			...(t.detail ? { detail: t.detail } : {}),
			url: `/bonnen/${receiptId}`
		},
		db
	);
}

/**
 * Registreert de lezer als handler voor `bon_lezen`. Zonder client (geen API-sleutel) blijven
 * de taken wachten, zoals voordat de lezer er was.
 */
export function registerReceiptReader(client: () => ReceiptClient): void {
	registerJob(
		READ_RECEIPT_JOB,
		async (db, payload) => {
			const parsed = payloadSchema.safeParse(payload);
			if (!parsed.success) return;
			// Het moment van lezen is wanneer Haiku klaar is, niet het begin van de ronde
			await readStoredReceipt(db, client(), parsed.data.receiptId);
		},
		{
			onGiveUp: (db, payload, now) => {
				const parsed = payloadSchema.safeParse(payload);
				if (!parsed.success) return;
				if (markReadFailed(db, parsed.data.receiptId, now)) {
					const saved = loadReceipt(db, parsed.data.receiptId);
					if (saved)
						void notifyRead(
							db,
							saved.id,
							{
								status: 'fout',
								plan: null,
								fields: saved.fields,
								stage: 'fout',
								transactionId: null
							},
							now
						);
				}
			}
		}
	);
}
