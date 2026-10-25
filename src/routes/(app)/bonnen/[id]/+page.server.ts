import { error, fail, redirect } from '@sveltejs/kit';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { groupHue } from '#lib/categoryColor.ts';
import { isIsoDate } from '#lib/dates.ts';
import { parseAmount } from '#lib/money.ts';
import { db } from '#lib/server/db/index.ts';
import { accounts, transactions } from '#lib/server/db/schema.ts';
import { ValidationError } from '#lib/server/errors.ts';
import { isComplete } from '#lib/server/receipts/outcome.ts';
import {
	confirmReceipt,
	correctReceipt,
	defaultAccountId,
	deleteReceipt,
	loadReceipt,
	receiptCandidates,
	rereadReceipt,
	settleReceipt
} from '#lib/server/receipts/process.ts';
import { receiptView } from '#lib/server/receipts/view.ts';
import type { Actions, PageServerLoad } from './$types';

// Bon (spec: Schermen, Bonnetjes en koppelen): wat Haiku las met de zekerheid per veld, de
// koppellijst om te verwerken, en nakijken, aanpassen, opnieuw lezen of weggooien.

const idSchema = z.uuid();

export const load: PageServerLoad = ({ params, depends, setHeaders }) => {
	depends('app:bon');
	setHeaders({ 'cache-control': 'private, no-cache' });
	if (!idSchema.safeParse(params.id).success) error(404, 'Niet gevonden');
	const receipt = loadReceipt(db(), params.id);
	if (!receipt) error(404, 'Niet gevonden');
	const complete = isComplete(receipt.fields);
	const match = complete ? receiptCandidates(db(), receipt.fields) : null;
	const linked = receipt.transactionId
		? (db()
				.select({
					id: transactions.id,
					counterparty: transactions.counterparty,
					date: transactions.date,
					amountCents: transactions.amountCents,
					origAmountCents: transactions.origAmountCents,
					origCurrency: transactions.origCurrency,
					source: transactions.source,
					status: transactions.status
				})
				.from(transactions)
				.where(eq(transactions.id, receipt.transactionId))
				.get() ?? null)
		: null;
	return {
		receipt: receiptView(receipt),
		complete,
		candidates: (match?.candidates ?? []).map((c) => ({
			id: c.id,
			counterparty: c.counterparty,
			date: c.date,
			amountCents: c.amountCents,
			origAmountCents: c.origAmountCents,
			origCurrency: c.origCurrency,
			accountAlias: c.accountAlias,
			categoryName: c.categoryName,
			hue: c.categoryGroup ? groupHue(c.categoryGroup) : null,
			label: c.label,
			score: c.score
		})),
		preselect: match?.preselect ?? null,
		linked,
		accounts: db()
			.select({ id: accounts.id, name: accounts.name })
			.from(accounts)
			.orderBy(asc(accounts.createdAt))
			.all(),
		defaultAccount: defaultAccountId(db(), receipt.fields.currency)
	};
};

const correctSchema = z.object({
	store: z.string().trim().min(1).max(100),
	date: z.string().refine(isIsoDate),
	amount: z.string().trim().max(16),
	currency: z
		.string()
		.trim()
		.toUpperCase()
		.regex(/^[A-Z]{3}$/)
});
const settleSchema = z.object({
	// `transactie:<id>` voor een bestaande transactie, `nieuw` voor een nieuwe
	target: z.union([
		z.literal('nieuw'),
		z
			.string()
			.max(60)
			.transform((t) => t.split(':'))
			.pipe(z.tuple([z.literal('transactie'), z.uuid()]))
	]),
	accountId: z.uuid().optional()
});

function fromForm(form: FormData) {
	return Object.fromEntries([...form].map(([k, v]) => [k, typeof v === 'string' ? v : '']));
}

function guarded<T>(fn: () => T) {
	try {
		return fn();
	} catch (e) {
		if (e instanceof ValidationError) return fail(400, { message: `${e.message}.` });
		throw e;
	}
}

export const actions: Actions = {
	correct: async ({ params, request }) => {
		const parsed = correctSchema.safeParse(fromForm(await request.formData()));
		if (!parsed.success)
			return fail(400, { message: 'Vul een winkel, een datum, een bedrag en een valuta in.' });
		const cents = parseAmount(parsed.data.amount);
		if (cents === null || cents <= 0)
			return fail(400, { message: 'Dat bedrag kan ik niet lezen.' });
		return guarded(() => {
			correctReceipt(db(), params.id, {
				store: parsed.data.store,
				date: parsed.data.date,
				totalCents: cents,
				currency: parsed.data.currency
			});
			return { corrected: true };
		});
	},
	settle: async ({ params, request }) => {
		const parsed = settleSchema.safeParse(fromForm(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Kies een transactie of een nieuwe.' });
		const { target, accountId } = parsed.data;
		if (target === 'nieuw' && !accountId) return fail(400, { message: 'Kies een rekening.' });
		return guarded(() => {
			const transactionId = settleReceipt(
				db(),
				params.id,
				target === 'nieuw'
					? { kind: 'nieuw', accountId: accountId! }
					: { kind: 'koppelen', transactionId: target[1] }
			);
			return { settled: transactionId, created: target === 'nieuw' };
		});
	},
	confirm: ({ params }) =>
		guarded(() => {
			confirmReceipt(db(), params.id);
			return { confirmed: true };
		}),
	reread: ({ params }) =>
		guarded(() => {
			rereadReceipt(db(), params.id);
			return { reread: true };
		}),
	delete: async ({ params }) => {
		if (!idSchema.safeParse(params.id).success) return fail(404, { message: 'Niet gevonden.' });
		await deleteReceipt(db(), params.id);
		redirect(303, '/bonnen');
	}
};
