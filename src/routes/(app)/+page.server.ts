import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { toIsoDate } from '#lib/dates.ts';
import { parseAmount } from '#lib/money.ts';
import { balanceCheckDue } from '#lib/server/balance.ts';
import { monthOverview } from '#lib/server/budgets.ts';
import { closingSignal } from '#lib/server/closing.ts';
import { quickEntryContext } from '#lib/server/context.ts';
import { db } from '#lib/server/db/index.ts';
import { owedSummary } from '#lib/server/owed.ts';
import {
	awaitingConfirmation,
	confirmExpected,
	proposalCount,
	skipExpected,
	upcomingThisMonth
} from '#lib/server/recurring.ts';
import { inboxCount, reviewInbox } from '#lib/server/review.ts';
import { confirmReceived, dueReceipts } from '#lib/server/shares.ts';
import {
	frequentManual,
	listTransactions,
	ValidationError,
	withRefunds
} from '#lib/server/transactions.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ setHeaders }) => {
	const today = toIsoDate(new Date());
	const month = today.slice(0, 7);
	// Privé en niet zonder controle hergebruiken; wel bruikbaar als offline terugval
	setHeaders({ 'cache-control': 'private, no-cache' });
	const inbox = reviewInbox(db(), today);
	return {
		today,
		overview: monthOverview(db(), month, today),
		recent: withRefunds(db(), listTransactions(db(), { limit: 8, withoutExpected: true })),
		reviewCount: inboxCount(inbox),
		owed: owedSummary(db()),
		expected: awaitingConfirmation(db(), today),
		receipts: dueReceipts(db(), today),
		upcoming: upcomingThisMonth(db(), today),
		proposals: proposalCount(db()),
		balanceCheckDue: balanceCheckDue(db(), today),
		closing: closingSignal(db(), today, inbox),
		context: quickEntryContext(db()),
		suggestions: frequentManual(db(), today)
	};
};

const confirmSchema = z.object({ id: z.uuid(), amount: z.string().trim().max(16).optional() });
const receivedSchema = z.object({ id: z.uuid() });
const skipSchema = z.object({ id: z.uuid(), reason: z.enum(['gemist', 'opgezegd']) });

export const actions: Actions = {
	received: async ({ request }) => {
		const parsed = receivedSchema.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Deze post ken ik niet.' });
		try {
			confirmReceived(db(), parsed.data.id);
		} catch (e) {
			if (e instanceof ValidationError) return fail(400, { message: e.message });
			throw e;
		}
		return { received: parsed.data.id };
	},
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
