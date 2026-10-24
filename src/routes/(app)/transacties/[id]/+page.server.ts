import { error, fail, redirect } from '@sveltejs/kit';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { parseAmount } from '#lib/money.ts';
import { db } from '#lib/server/db/index.ts';
import { categories, owed, rules, transactionSplits, transactions } from '#lib/server/db/schema.ts';
import { deleteTransaction, updateTransaction, ValidationError } from '#lib/server/transactions.ts';
import { transactionPatchSchema } from '#lib/server/validation.ts';
import type { Actions, PageServerLoad } from './$types';

const idSchema = z.uuid();

export const load: PageServerLoad = ({ params }) => {
	if (!idSchema.safeParse(params.id).success) error(404, 'Niet gevonden');
	const tx = db().select().from(transactions).where(eq(transactions.id, params.id)).get();
	if (!tx) error(404, 'Niet gevonden');
	return {
		tx,
		// De regel die de categorie gaf, zodat je ziet waarom hij er staat
		rule: tx.categoryRuleId
			? (db()
					.select({ field: rules.field, pattern: rules.pattern })
					.from(rules)
					.where(eq(rules.id, tx.categoryRuleId))
					.get() ?? null)
			: null,
		splits: db()
			.select()
			.from(transactionSplits)
			.where(eq(transactionSplits.transactionId, tx.id))
			.all(),
		owed: db().select().from(owed).where(eq(owed.sourceTransactionId, tx.id)).all(),
		categories: db()
			.select({ id: categories.id, name: categories.name, group: categories.group })
			.from(categories)
			.where(eq(categories.archived, false))
			.orderBy(asc(categories.sortOrder))
			.all()
	};
};

export const actions: Actions = {
	save: async ({ request, params }) => {
		const form = await request.formData();
		const amountText = String(form.get('amount') ?? '').trim();
		const direction = form.get('direction') === 'in' ? 1 : -1;
		const cents = amountText ? parseAmount(amountText) : undefined;
		if (cents === null) return fail(400, { message: 'Dat bedrag kan ik niet lezen.' });

		const patch = transactionPatchSchema.safeParse({
			amountCents: cents === undefined ? undefined : direction * cents,
			date: form.get('date') || undefined,
			counterparty: form.get('counterparty') ?? undefined,
			categoryId: form.get('categoryId') ? String(form.get('categoryId')) : null,
			note: form.get('note') ?? undefined
		});
		if (!patch.success) return fail(400, { message: 'Controleer de velden.' });
		try {
			if (!updateTransaction(db(), params.id, patch.data)) error(404, 'Niet gevonden');
		} catch (e) {
			if (e instanceof ValidationError) return fail(400, { message: e.message });
			throw e;
		}
		return { saved: true };
	},
	delete: async ({ params }) => {
		deleteTransaction(db(), params.id);
		redirect(303, '/transacties');
	}
};
