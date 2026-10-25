import { error, fail, redirect } from '@sveltejs/kit';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { isIsoDate, toIsoDate } from '#lib/dates.ts';
import { parseAmount } from '#lib/money.ts';
import { db } from '#lib/server/db/index.ts';
import { categories } from '#lib/server/db/schema.ts';
import { getRecurring, stopRecurring, updateRecurring } from '#lib/server/recurring.ts';
import { ValidationError } from '#lib/server/transactions.ts';
import type { Actions, PageServerLoad } from './$types';

const idSchema = z.uuid();

export const load: PageServerLoad = ({ params }) => {
	if (!idSchema.safeParse(params.id).success) error(404, 'Niet gevonden');
	const today = toIsoDate(new Date());
	const item = getRecurring(db(), params.id, today);
	if (!item) error(404, 'Niet gevonden');
	// Een voorstel bevestig je op het overzicht
	if (item.status === 'voorstel') redirect(303, '/vaste-lasten');
	return {
		today,
		item,
		categories: db()
			.select({ id: categories.id, name: categories.name, group: categories.group })
			.from(categories)
			.where(eq(categories.archived, false))
			.orderBy(asc(categories.sortOrder), asc(categories.name))
			.all()
	};
};

const saveSchema = z.object({
	counterparty: z.string().trim().min(1).max(100),
	amount: z.string().trim().max(16),
	kind: z.enum(['vast', 'wisselend']),
	interval: z.enum(['maand', 'kwartaal', 'halfjaar', 'jaar']),
	nextDate: z.string().refine(isIsoDate),
	categoryId: z.union([z.literal(''), z.uuid()]),
	spread: z.literal('on').optional()
});

export const actions: Actions = {
	save: async ({ request, params }) => {
		const parsed = saveSchema.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Controleer de velden.' });
		const cents = parseAmount(parsed.data.amount);
		if (cents === null || cents === 0)
			return fail(400, { message: 'Dat bedrag kan ik niet lezen.' });
		try {
			updateRecurring(db(), params.id, {
				counterparty: parsed.data.counterparty,
				medianCents: cents,
				kind: parsed.data.kind,
				interval: parsed.data.interval,
				nextDate: parsed.data.nextDate,
				categoryId: parsed.data.categoryId || null,
				spread: !!parsed.data.spread
			});
		} catch (e) {
			if (e instanceof ValidationError) return fail(400, { message: e.message });
			throw e;
		}
		return { saved: true };
	},
	stop: async ({ params }) => {
		try {
			stopRecurring(db(), params.id);
		} catch (e) {
			if (e instanceof ValidationError) return fail(400, { message: e.message });
			throw e;
		}
		redirect(303, '/vaste-lasten');
	}
};
