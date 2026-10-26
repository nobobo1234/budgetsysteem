import { z } from 'zod';
import { MAX_CENTS } from '../../money.ts';
import type { CheckedField, CheckedListItem, CheckedReceipt, FieldStatus } from './checks.ts';
import { LINE_KINDS, MODEL_CONFIDENCE, PAYMENT_METHODS } from './schema.ts';

// Wat de lezer in `receipts` bewaart (spec: Datamodel → receipts): de gecontroleerde velden en de
// zekerheid per veld. De ruwe uitvoer staat apart en gaat nooit naar de pagina. Bij het teruglezen
// gaat alles opnieuw door een schema: de inhoud komt uiteindelijk van Haiku.

export const RECEIPT_FIELDS = ['winkel', 'datum', 'totaal', 'valuta', 'betaalwijze'] as const;
export type ReceiptField = (typeof RECEIPT_FIELDS)[number];

const FIELD_STATUS = ['zeker', 'controleren', 'onzeker'] as const;

const fieldConfidence = z.object({
	status: z.enum(FIELD_STATUS),
	/** Wat het model zelf zei; `null` als je het veld zelf invulde. */
	model: z.enum(MODEL_CONFIDENCE).nullable(),
	/** Notitie van het model: onbetrouwbare tekst, alleen als gewone tekst tonen. */
	note: z.string().max(300),
	failures: z.array(z.string().max(40)).max(10),
	/** Je hebt dit veld achteraf aangepast. */
	corrected: z.boolean().default(false)
});

export const StoredConfidenceSchema = z.object({
	winkel: fieldConfidence,
	datum: fieldConfidence,
	totaal: fieldConfidence,
	valuta: fieldConfidence,
	betaalwijze: fieldConfidence
});

export const StoredFieldsSchema = z.object({
	store: z.string().max(100).nullable(),
	date: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.nullable(),
	totalCents: z.number().int().min(-MAX_CENTS).max(MAX_CENTS).nullable(),
	currency: z
		.string()
		.regex(/^[A-Z]{3}$/)
		.nullable(),
	paymentMethod: z.enum(PAYMENT_METHODS).nullable(),
	lines: z
		.array(
			z.object({
				description: z.string().max(120),
				cents: z.number().int(),
				kind: z.enum(LINE_KINDS)
			})
		)
		.max(150),
	linesSumCents: z.number().int().nullable()
});

export type StoredFields = z.infer<typeof StoredFieldsSchema>;
export type StoredConfidence = z.infer<typeof StoredConfidenceSchema>;
export type StoredFieldConfidence = StoredConfidence[ReceiptField];

export function toStoredFields(checked: CheckedReceipt): StoredFields {
	return {
		store: checked.store.value,
		date: checked.date.value,
		totalCents: checked.totalCents.value,
		currency: checked.currency.value,
		paymentMethod: checked.paymentMethod.value,
		lines: checked.lines,
		linesSumCents: checked.linesSumCents
	};
}

export function toStoredConfidence(checked: CheckedReceipt): StoredConfidence {
	const one = (
		f: CheckedReceipt['store' | 'date' | 'totalCents' | 'currency' | 'paymentMethod']
	) => ({
		status: f.status,
		model: f.modelConfidence,
		note: f.note.slice(0, 300),
		failures: f.failures,
		corrected: false
	});
	return {
		winkel: one(checked.store),
		datum: one(checked.date),
		totaal: one(checked.totalCents),
		valuta: one(checked.currency),
		betaalwijze: one(checked.paymentMethod)
	};
}

/** Lege velden voor een bon die niet gelezen kon worden: alles zelf invullen. */
export function emptyFields(): StoredFields {
	return {
		store: null,
		date: null,
		totalCents: null,
		currency: null,
		paymentMethod: null,
		lines: [],
		linesSumCents: null
	};
}

export function emptyConfidence(): StoredConfidence {
	const one = (): StoredFieldConfidence => ({
		status: 'onzeker' as FieldStatus,
		model: null,
		note: '',
		failures: [],
		corrected: false
	});
	return {
		winkel: one(),
		datum: one(),
		totaal: one(),
		valuta: one(),
		betaalwijze: one()
	};
}

/** Teruglezen uit de database; wat niet klopt wordt leeg in plaats van een gok. */
export function readStored(
	fields: unknown,
	confidence: unknown
): { fields: StoredFields; confidence: StoredConfidence } {
	const f = StoredFieldsSchema.safeParse(fields);
	const c = StoredConfidenceSchema.safeParse(confidence);
	return {
		fields: f.success ? f.data : emptyFields(),
		confidence: c.success ? c.data : emptyConfidence()
	};
}

// Een transactie op een screenshot (tabel `receipt_items`): de waarden staan in kolommen, de
// zekerheid per veld als JSON, net als bij een bon.

export const LIST_FIELDS = ['datum', 'tegenpartij', 'bedrag', 'valuta'] as const;
export type ListField = (typeof LIST_FIELDS)[number];

export const StoredItemConfidenceSchema = z.object({
	datum: fieldConfidence,
	tegenpartij: fieldConfidence,
	bedrag: fieldConfidence,
	valuta: fieldConfidence
});
export type StoredItemConfidence = z.infer<typeof StoredItemConfidenceSchema>;

export interface StoredListItem {
	date: string | null;
	counterparty: string | null;
	/** Met teken, in centen van `currency`. */
	amountCents: number | null;
	currency: string | null;
	confidence: StoredItemConfidence;
}

function storedConfidence<T>(f: CheckedField<T>): StoredFieldConfidence {
	return {
		status: f.status,
		model: f.modelConfidence,
		note: f.note.slice(0, 300),
		failures: f.failures,
		corrected: false
	};
}

export function toStoredItem(item: CheckedListItem): StoredListItem {
	return {
		date: item.date.value,
		counterparty: item.counterparty.value?.slice(0, 100) ?? null,
		amountCents: item.amountCents.value,
		currency: item.currency.value,
		confidence: {
			datum: storedConfidence(item.date),
			tegenpartij: storedConfidence(item.counterparty),
			bedrag: storedConfidence(item.amountCents),
			valuta: storedConfidence(item.currency)
		}
	};
}

/** Zekerheid van een transactie teruglezen; wat niet klopt telt als onzeker. */
export function readItemConfidence(confidence: unknown): StoredItemConfidence {
	const c = StoredItemConfidenceSchema.safeParse(confidence);
	if (c.success) return c.data;
	const one = (): StoredFieldConfidence => ({
		status: 'onzeker',
		model: null,
		note: '',
		failures: [],
		corrected: false
	});
	return { datum: one(), tegenpartij: one(), bedrag: one(), valuta: one() };
}

/** Ruwe uitvoer zoals bewaard: de stopreden en de tekst van het model, ingekort. */
export interface RawOutput {
	stopReason: string | null;
	text: string | null;
}

export const MAX_RAW_CHARS = 64 * 1024;
