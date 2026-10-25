import { fail } from '@sveltejs/kit';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { isIsoDate, toIsoDate } from '#lib/dates.ts';
import { db } from '#lib/server/db/index.ts';
import { categories } from '#lib/server/db/schema.ts';
import {
	chargesThisMonth,
	confirmProposal,
	dismissSignal,
	recurringOverview,
	rejectProposal
} from '#lib/server/recurring.ts';
import { ValidationError } from '#lib/server/transactions.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	const today = toIsoDate(new Date());
	return {
		today,
		overview: recurringOverview(db(), today),
		charges: chargesThisMonth(db(), today),
		categories: db()
			.select({ id: categories.id, name: categories.name, group: categories.group })
			.from(categories)
			.where(eq(categories.archived, false))
			.orderBy(asc(categories.sortOrder), asc(categories.name))
			.all()
	};
};

const idSchema = z.object({ id: z.uuid() });

const confirmSchema = z.object({
	id: z.uuid(),
	nextDate: z.string().refine(isIsoDate),
	categoryId: z.union([z.literal(''), z.uuid()]),
	spread: z.literal('on').optional()
});

export const actions: Actions = {
	confirm: async ({ request }) => {
		const parsed = confirmSchema.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Controleer de datum.', id: null });
		const { id, nextDate, categoryId, spread } = parsed.data;
		try {
			confirmProposal(db(), id, { nextDate, categoryId: categoryId || null, spread: !!spread });
		} catch (e) {
			if (e instanceof ValidationError) return fail(400, { message: e.message, id });
			throw e;
		}
		return { confirmed: id };
	},
	reject: async ({ request }) => {
		const parsed = idSchema.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Onbekend voorstel.', id: null });
		try {
			rejectProposal(db(), parsed.data.id);
		} catch (e) {
			if (e instanceof ValidationError)
				return fail(400, { message: e.message, id: parsed.data.id });
			throw e;
		}
		return { rejected: parsed.data.id };
	},
	dismissSignal: async ({ request }) => {
		const parsed = idSchema.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Onbekende vaste last.', id: null });
		dismissSignal(db(), parsed.data.id);
		return { dismissed: parsed.data.id };
	}
};
