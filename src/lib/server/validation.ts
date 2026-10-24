import { z } from 'zod';
import { addDays, isIsoDate, toIsoDate } from '../dates.ts';
import { MAX_CENTS } from '../money.ts';

// De server vertrouwt de parse van de snelinvoer niet: losse velden, strikt gevalideerd.

const isoDate = z.string().refine(isIsoDate, 'Ongeldige datum');
const name = z.string().trim().min(1).max(40);

/** Een datum niet ver in de toekomst en niet absurd ver terug. */
export function dateInRange(iso: string, today = toIsoDate(new Date())): boolean {
	return iso >= '2000-01-01' && iso <= addDays(today, 31);
}

export const newTransactionSchema = z
	.object({
		// Door de client gemaakt, zodat offline opnieuw versturen nooit dubbel boekt
		id: z.uuid(),
		amountCents: z.number().int().min(-MAX_CENTS).max(MAX_CENTS),
		date: isoDate,
		counterparty: z.string().trim().max(100),
		description: z.string().trim().max(300).default(''),
		categoryId: z.uuid().nullable(),
		accountId: z.uuid(),
		origAmountCents: z.number().int().min(-MAX_CENTS).max(MAX_CENTS).nullable().default(null),
		origCurrency: z.enum(['USD']).nullable().default(null),
		note: z.string().trim().max(500).default(''),
		share: z
			.object({
				people: z.number().int().min(2).max(50),
				with: z.array(name).max(20).default([])
			})
			.nullable()
			.default(null),
		// Ontvangen of terugbetaald: de gekozen post uit de koppellijst
		settle: z.object({ owedId: z.uuid() }).strict().nullable().default(null)
	})
	.strict()
	.refine((t) => (t.origAmountCents === null) === (t.origCurrency === null), {
		message: 'Vreemde valuta vraagt om bedrag én valuta'
	})
	.refine((t) => t.amountCents !== 0 || t.origCurrency !== null, {
		message: 'Bedrag mag niet nul zijn'
	})
	.refine((t) => t.share === null || t.amountCents < 0, {
		message: 'Alleen een uitgave kun je delen'
	})
	.refine((t) => t.share === null || t.share.with.length <= t.share.people - 1, {
		message: 'Aantal personen klopt niet met de namen'
	})
	.refine((t) => t.settle === null || (t.share === null && t.amountCents !== 0), {
		message: 'Een betaling koppelen kan alleen met een bedrag en zonder verdeling'
	});

export type NewTransaction = z.infer<typeof newTransactionSchema>;

export const transactionPatchSchema = z
	.object({
		amountCents: z
			.number()
			.int()
			.min(-MAX_CENTS)
			.max(MAX_CENTS)
			.refine((n) => n !== 0)
			.optional(),
		date: isoDate.optional(),
		counterparty: z.string().trim().max(100).optional(),
		categoryId: z.uuid().nullable().optional(),
		note: z.string().trim().max(500).optional()
	})
	.strict();

export type TransactionPatch = z.infer<typeof transactionPatchSchema>;
