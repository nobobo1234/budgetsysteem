import type { LoadedReceipt } from './process.ts';
import { RECEIPT_FIELDS } from './stored.ts';

// Wat een pagina van een bon te zien krijgt: de gecontroleerde velden en per veld de zekerheid,
// nooit de ruwe uitvoer van Haiku. Notities van het model zijn gewone tekst (nooit `{@html}`).

export function receiptView(r: LoadedReceipt) {
	return {
		id: r.id,
		stage: r.stage,
		status: r.status,
		source: r.source,
		failure: r.failure,
		store: r.fields.store,
		date: r.fields.date,
		totalCents: r.fields.totalCents,
		currency: r.fields.currency,
		paymentMethod: r.fields.paymentMethod,
		lineCount: r.fields.lines.length,
		confidence: Object.fromEntries(
			RECEIPT_FIELDS.map((f) => {
				const c = r.confidence[f];
				return [f, { status: c.status, model: c.model, note: c.note, corrected: c.corrected }];
			})
		) as Record<
			(typeof RECEIPT_FIELDS)[number],
			{
				status: 'zeker' | 'controleren' | 'onzeker';
				model: 'zeker' | 'twijfel' | 'onleesbaar' | null;
				note: string;
				corrected: boolean;
			}
		>,
		transactionId: r.transactionId,
		createdAt: r.createdAt,
		readAt: r.readAt
	};
}

export type ReceiptView = ReturnType<typeof receiptView>;
