import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { QuestionResult } from '#lib/question.ts';
import { MAX_CHOICES, MAX_QUESTION_CHARS } from '#lib/semantic/format.ts';
import { db } from '#lib/server/db/index.ts';
import { ValidationError } from '#lib/server/errors.ts';
import {
	askAgain,
	askQuestion,
	choose,
	markWrong,
	questionHistory,
	unavailable
} from '#lib/server/question/index.ts';
import { QUESTION_VARIANT } from '#lib/server/question/translator.ts';
import type { Actions, PageServerLoad } from './$types';

// Vraag (spec: Vraagveld, Schermen): het vraagveld onder Analyses. Het model vertaalt de vraag,
// code rekent; het resultaat komt terug als actiedata en wordt nooit bewaard.

export const load: PageServerLoad = () => ({
	history: questionHistory(db()),
	unavailable: unavailable(),
	/** Welk model de vraag vertaalt, voor de laadstaat en de regel onder het antwoord */
	model: QUESTION_VARIANT.label
});

const askSchema = z.object({ vraag: z.string().max(MAX_QUESTION_CHARS * 2) });
const idSchema = z.object({ id: z.uuid() });
const chooseSchema = z.object({
	id: z.uuid(),
	keuze: z.coerce
		.number()
		.int()
		.min(0)
		.max(MAX_CHOICES - 1)
});

async function run(work: () => Promise<QuestionResult> | QuestionResult) {
	try {
		return { result: await work() };
	} catch (e) {
		if (e instanceof ValidationError) return fail(400, { message: e.message });
		throw e;
	}
}

export const actions: Actions = {
	ask: async ({ request }) => {
		const parsed = askSchema.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Typ eerst een vraag.' });
		return run(() => askQuestion(db(), parsed.data.vraag));
	},
	// Een eerdere vraag opnieuw: een antwoord rekent code opnieuw uit, zonder model
	again: async ({ request }) => {
		const parsed = idSchema.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Deze vraag ken ik niet meer.' });
		return run(() => askAgain(db(), parsed.data.id));
	},
	// Een keuze uit een verduidelijking
	choose: async ({ request }) => {
		const parsed = chooseSchema.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Deze keuze ken ik niet.' });
		return run(() => choose(db(), parsed.data.id, parsed.data.keuze));
	},
	// "Klopt niet" op een antwoord: naar de telemetrie en bewaard bij de vraag
	wrong: async ({ request }) => {
		const parsed = idSchema.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Deze vraag ken ik niet meer.' });
		try {
			markWrong(db(), parsed.data.id);
		} catch (e) {
			if (e instanceof ValidationError) return fail(400, { message: e.message });
			throw e;
		}
		return { wrong: parsed.data.id };
	}
};
