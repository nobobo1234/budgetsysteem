import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { toIsoDate } from '#lib/dates.ts';
import { parseAmount } from '#lib/money.ts';
import { monthOverview } from '#lib/server/budgets.ts';
import { quickEntryContext } from '#lib/server/context.ts';
import { db } from '#lib/server/db/index.ts';
import {
	awaitingConfirmation,
	confirmExpected,
	proposalCount,
	skipExpected,
	upcomingThisMonth
} from '#lib/server/recurring.ts';
import { listTransactions, reviewCount, ValidationError } from '#lib/server/transactions.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ setHeaders }) => {
	const today = toIsoDate(new Date());
	const month = today.slice(0, 7);
	// Privé en niet zonder controle hergebruiken; wel bruikbaar als offline terugval
	setHeaders({ 'cache-control': 'private, no-cache' });
	return {
		today,
		overview: monthOverview(db(), month, today),
		recent: listTransactions(db(), { limit: 8 }),
		reviewCount: reviewCount(db()),
		expected: awaitingConfirmation(db(), today),
		upcoming: upcomingThisMonth(db(), today),
		proposals: proposalCount(db()),
		context: quickEntryContext(db())
	};
};

const confirmSchema = z.object({ id: z.uuid(), amount: z.string().trim().max(16).optional() });
const skipSchema = z.object({ id: z.uuid(), reason: z.enum(['gemist', 'opgezegd']) });

export const actions: Actions = {
	confirmExpected: async ({ request }) => {
		const parsed = confirmSchema.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Deze post ken ik niet.' });
		const cents = parsed.data.amount === undefined ? undefined : parseAmount(parsed.data.amount);
		if (cents === null || cents === 0)
			return fail(400, { message: 'Dat bedrag kan ik niet lezen.' });
		try {
			confirmExpected(db(), parsed.data.id, cents);
		} catch (e) {
			if (e instanceof ValidationError) return fail(400, { message: e.message });
			throw e;
		}
		return { confirmed: parsed.data.id };
	},
	skipExpected: async ({ request }) => {
		const parsed = skipSchema.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Deze post ken ik niet.' });
		try {
			skipExpected(db(), parsed.data.id, parsed.data.reason);
		} catch (e) {
			if (e instanceof ValidationError) return fail(400, { message: e.message });
			throw e;
		}
		return { skipped: parsed.data.id };
	}
};
