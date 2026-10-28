import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { toIsoDate } from '#lib/dates.ts';
import { MAX_SENTENCES } from '#lib/summary.ts';
import { applyProposal, closeMonth, closingPage } from '#lib/server/closing.ts';
import { db } from '#lib/server/db/index.ts';
import { ValidationError } from '#lib/server/errors.ts';
import { markSentenceWrong, monthSummary, summaryAgain } from '#lib/server/summary/index.ts';
import type { Actions, PageServerLoad } from './$types';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function monthParam(value: string): string {
	if (!MONTH.test(value)) error(404, 'Deze maand ken ik niet.');
	return value;
}

export const load: PageServerLoad = ({ params }) => {
	const month = monthParam(params.maand);
	const today = toIsoDate(new Date());
	return {
		page: closingPage(db(), month, today),
		today,
		// Gestreamd: de pagina staat er meteen, de kaart Wat opviel volgt als Haiku klaar is
		summary: monthSummary(db(), month, today)
	};
};

const proposalSchema = z.object({ categoryId: z.uuid() });
const sentenceSchema = z.object({
	index: z.coerce
		.number()
		.int()
		.min(0)
		.max(MAX_SENTENCES - 1)
});

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
	},
	// "Opnieuw" op de kaart Wat opviel: hooguit vijf aanroepen per maand
	summaryAgain: async ({ params }) => {
		const month = monthParam(params.maand);
		try {
			await summaryAgain(db(), month, toIsoDate(new Date()));
		} catch (e) {
			if (e instanceof ValidationError) return fail(400, { message: e.message });
			throw e;
		}
		return { summaryAgain: true };
	},
	// "Klopt niet" op één zin: naar de telemetrie en bewaard voor de goudset
	summaryWrong: async ({ params, request }) => {
		const month = monthParam(params.maand);
		const parsed = sentenceSchema.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Deze zin ken ik niet.' });
		try {
			markSentenceWrong(db(), month, parsed.data.index);
		} catch (e) {
			if (e instanceof ValidationError) return fail(400, { message: e.message });
			throw e;
		}
		return { summaryWrong: parsed.data.index };
	}
};
