import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { isIsoDate, toIsoDate } from '#lib/dates.ts';
import { MAX_CENTS, parseSignedAmount } from '#lib/money.ts';
import { balanceOverview, saveBalanceCheck, setBalanceAnchor } from '#lib/server/balance.ts';
import { db } from '#lib/server/db/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	const today = toIsoDate(new Date());
	return { today, accounts: balanceOverview(db(), today) };
};

const schema = z
	.object({
		accountId: z.uuid(),
		date: z.string().refine(isIsoDate),
		amount: z.string().trim().min(1).max(20)
	})
	.strict();

/** Leest het formulier; een saldo kan onder nul staan, maar niet in de toekomst liggen. */
async function readBalance(request: Request) {
	const parsed = schema.safeParse(Object.fromEntries(await request.formData()));
	if (!parsed.success) return { error: 'Controleer de invoer.', accountId: null };
	const { accountId, date, amount } = parsed.data;
	const amountCents = parseSignedAmount(amount);
	if (amountCents === null || Math.abs(amountCents) > MAX_CENTS) {
		return { error: 'Dat bedrag kan ik niet lezen.', accountId };
	}
	if (date < '2000-01-01' || date > toIsoDate(new Date())) {
		return { error: 'Kies een datum tot en met vandaag.', accountId };
	}
	return { input: { accountId, date, amountCents } };
}

export const actions: Actions = {
	check: async ({ request }) => {
		const result = await readBalance(request);
		if (!result.input)
			return fail(400, { message: result.error, accountId: result.accountId, kind: 'check' });
		if (!saveBalanceCheck(db(), result.input))
			return fail(404, { message: 'Onbekende rekening.', accountId: null, kind: 'check' });
		return { saved: 'check' as const, accountId: result.input.accountId };
	},
	anchor: async ({ request }) => {
		const result = await readBalance(request);
		if (!result.input)
			return fail(400, { message: result.error, accountId: result.accountId, kind: 'anchor' });
		if (!setBalanceAnchor(db(), result.input))
			return fail(404, { message: 'Onbekende rekening.', accountId: null, kind: 'anchor' });
		return { saved: 'anchor' as const, accountId: result.input.accountId };
	}
};
