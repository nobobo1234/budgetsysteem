import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { toIsoDate } from '#lib/dates.ts';
import { applyProposal, closeMonth, closingPage } from '#lib/server/closing.ts';
import { db } from '#lib/server/db/index.ts';
import { ValidationError } from '#lib/server/errors.ts';
import type { Actions, PageServerLoad } from './$types';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function monthParam(value: string): string {
	if (!MONTH.test(value)) error(404, 'Deze maand ken ik niet.');
	return value;
}

export const load: PageServerLoad = ({ params }) => {
	const month = monthParam(params.maand);
	const today = toIsoDate(new Date());
	return { page: closingPage(db(), month, today), today };
};

const proposalSchema = z.object({ categoryId: z.uuid() });

export const actions: Actions = {
	close: ({ params }) => {
		const month = monthParam(params.maand);
		try {
			closeMonth(db(), month, toIsoDate(new Date()));
		} catch (e) {
			if (e instanceof ValidationError) return fail(400, { message: e.message });
			throw e;
		}
		return { closed: month };
	},
	proposal: async ({ params, request }) => {
		const month = monthParam(params.maand);
		const parsed = proposalSchema.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Deze categorie ken ik niet.' });
		try {
			const cents = applyProposal(db(), month, parsed.data.categoryId, toIsoDate(new Date()));
			return { applied: parsed.data.categoryId, cents };
		} catch (e) {
			if (e instanceof ValidationError) return fail(400, { message: e.message });
			throw e;
		}
	}
};
