import { fail } from '@sveltejs/kit';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '#lib/server/db/index.ts';
import { accounts, categories, recurring, transactions } from '#lib/server/db/schema.ts';
import { confirmExpected } from '#lib/server/recurring.ts';
import { isIsoDate, toIsoDate } from '#lib/dates.ts';
import {
	listWholeDays,
	spendingPerDay,
	summarizeTransactions,
	type ListFilter,
	transactionMonths,
	transferPairs,
	updateTransaction,
	ValidationError,
	withRefunds,
	withTransfers
} from '#lib/server/transactions.ts';
import type { Actions, PageServerLoad } from './$types';

// Bijladen per 50, tot 500 (spec: Schermen, Transacties)
const STEP = 50;
const MAX = 500;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const load: PageServerLoad = ({ url }) => {
	const q = (url.searchParams.get('q') ?? '').slice(0, 100);
	const monthParam = url.searchParams.get('maand') ?? '';
	const month = MONTH.test(monthParam) ? monthParam : '';
	const categoryParam = url.searchParams.get('categorie') ?? '';
	const categoryId = categoryParam === 'geen' || UUID.test(categoryParam) ? categoryParam : '';
	const status = url.searchParams.get('status') === 'te_controleren' ? 'te_controleren' : undefined;
	// Vanuit de saldocheck: één rekening in een periode
	const accountParam = url.searchParams.get('rekening') ?? '';
	const accountId = UUID.test(accountParam) ? accountParam : '';
	const date = (key: string) => {
		const value = url.searchParams.get(key) ?? '';
		return isIsoDate(value) ? value : '';
	};
	const from = date('van');
	const to = date('tot');
	// Eén dag, gekozen in het staafdiagram (binnen de maand van het diagram)
	const today = toIsoDate(new Date());
	const chartMonth = month || today.slice(0, 7);
	const dayParam = date('dag');
	const day = dayParam.slice(0, 7) === chartMonth ? dayParam : '';
	// Hoeveel rijen er staan, in stappen van STEP tot MAX. Het staat in de URL, zodat vegen, terug van
	// de detailpagina en verversen dezelfde lijst geven.
	const asked = Number.parseInt(url.searchParams.get('aantal') ?? '', 10) || STEP;
	const count = Math.min(MAX, Math.max(STEP, Math.ceil(asked / STEP) * STEP));

	const filter: ListFilter = {
		q,
		month: month || undefined,
		categoryId: categoryId || undefined,
		status,
		accountId: accountId || undefined,
		from: day || from || undefined,
		to: day || to || undefined
	};
	// Interne overboekingen als één rij: de bijschrijving staat bij de afschrijving, en het paar
	// telt niet als uitgave of inkomen
	const transfers = transferPairs(db(), filter);
	const { rows, hasMore } = listWholeDays(db(), { ...filter, excludeIds: transfers.hidden }, count);
	const summary = summarizeTransactions(db(), { ...filter, excludeIds: transfers.paired });

	return {
		filter: { q, month, categoryId, status, accountId, from, to, day },
		chart: {
			month: chartMonth,
			days: spendingPerDay(db(), {
				q,
				month: chartMonth,
				categoryId: categoryId || undefined,
				accountId: accountId || undefined
			})
		},
		accountName: accountId
			? (db().select({ name: accounts.name }).from(accounts).where(eq(accounts.id, accountId)).get()
					?.name ?? null)
			: null,
		list: { count, step: STEP, max: MAX, hasMore },
		transactions: withTransfers(withRefunds(db(), rows), transfers.pairs),
		summary: { ...summary, count: summary.count + transfers.pairs.size },
		months: transactionMonths(db()),
		today,
		categories: db()
			.select({ id: categories.id, name: categories.name, group: categories.group })
			.from(categories)
			.where(eq(categories.archived, false))
			.orderBy(asc(categories.sortOrder))
			.all()
	};
};

// Swipen op een rij (spec: Overige micro-interacties): naar rechts bevestigen, naar links een
// andere categorie. Dezelfde regels als op de detailpagina en het startscherm.
const categorySchema = z.object({ id: z.uuid(), categoryId: z.union([z.uuid(), z.literal('')]) });
const idSchema = z.object({ id: z.uuid() });

export const actions: Actions = {
	category: async ({ request }) => {
		const parsed = categorySchema.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Kies een categorie.' });
		try {
			const done = updateTransaction(db(), parsed.data.id, {
				categoryId: parsed.data.categoryId || null
			});
			if (!done) return fail(404, { message: 'Deze transactie bestaat niet meer.' });
		} catch (e) {
			if (e instanceof ValidationError) return fail(400, { message: `${e.message}.` });
			throw e;
		}
		return { categorized: parsed.data.id };
	},
	confirm: async ({ request }) => {
		const parsed = idSchema.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Deze transactie ken ik niet.' });
		const t = db()
			.select({
				status: transactions.status,
				amountCents: transactions.amountCents,
				kind: recurring.kind
			})
			.from(transactions)
			.leftJoin(recurring, eq(recurring.id, transactions.recurringId))
			.where(eq(transactions.id, parsed.data.id))
			.get();
		if (!t) return fail(404, { message: 'Deze transactie bestaat niet meer.' });
		try {
			if (t.status === 'verwacht' && t.kind === 'vast') confirmExpected(db(), parsed.data.id);
			else if (t.status === 'verwacht')
				return fail(400, { message: 'Vul eerst het echte bedrag in; dat kan op het overzicht.' });
			else if (t.status === 'te_controleren' && t.amountCents !== 0)
				updateTransaction(db(), parsed.data.id, { amountCents: t.amountCents });
			else if (t.status === 'te_controleren')
				return fail(400, { message: 'Vul eerst het eurobedrag in bij de transactie.' });
			else return fail(400, { message: 'Deze transactie is al bevestigd.' });
		} catch (e) {
			if (e instanceof ValidationError) return fail(400, { message: `${e.message}.` });
			throw e;
		}
		return { confirmed: parsed.data.id };
	}
};
