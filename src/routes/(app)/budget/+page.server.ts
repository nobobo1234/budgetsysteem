import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { shiftMonth, toIsoDate } from '#lib/dates.ts';
import { parseAmount } from '#lib/money.ts';
import { monthOverview, setBudget } from '#lib/server/budgets.ts';
import { db } from '#lib/server/db/index.ts';
import type { Actions, PageServerLoad } from './$types';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function monthFrom(value: string | null): string {
	const current = toIsoDate(new Date()).slice(0, 7);
	return value && MONTH.test(value) ? value : current;
}

export const load: PageServerLoad = ({ url }) => {
	const month = monthFrom(url.searchParams.get('maand'));
	const today = toIsoDate(new Date());
	return {
		overview: monthOverview(db(), month, today),
		previous: shiftMonth(month, -1),
		next: shiftMonth(month, 1),
		isCurrent: month === today.slice(0, 7)
	};
};

const schema = z.object({
	month: z.string().regex(MONTH),
	categoryId: z.uuid(),
	limit: z.string().max(16)
});

export const actions: Actions = {
	limit: async ({ request }) => {
		const parsed = schema.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Controleer de invoer.', categoryId: null });
		const text = parsed.data.limit.trim();
		const cents = text === '' ? 0 : parseAmount(text);
		if (cents === null)
			return fail(400, {
				message: 'Dat bedrag kan ik niet lezen.',
				categoryId: parsed.data.categoryId
			});
		setBudget(db(), parsed.data.month, parsed.data.categoryId, cents);
		return { saved: parsed.data.categoryId };
	}
};
