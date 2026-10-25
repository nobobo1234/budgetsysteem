import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { shiftMonth, toIsoDate } from '#lib/dates.ts';
import { MAX_CENTS, parseAmount } from '#lib/money.ts';
import { db } from '#lib/server/db/index.ts';
import { ValidationError } from '#lib/server/errors.ts';
import { forgiveOwed, unlinkPayment } from '#lib/server/owed.ts';
import { listPeople } from '#lib/server/people.ts';
import {
	acceptProposal,
	confirmReceived,
	creditToPayable,
	dismissProposal,
	dueReceipts,
	shareProposals,
	sharesOverview
} from '#lib/server/shares.ts';
import { personName } from '#lib/server/validation.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	const today = toIsoDate(new Date());
	return {
		today,
		overview: sharesOverview(db(), today),
		due: dueReceipts(db(), today),
		proposals: shareProposals(db(), today),
		people: listPeople(db()).filter((p) => p.active)
	};
};

const idSchema = z.object({ id: z.uuid() });
const personSchema = z.object({ personId: z.uuid() });
const keySchema = z.object({ key: z.string().regex(/^[0-9a-f]{32}$/) });
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

const acceptSchema = z.object({
	key: z.string().regex(/^[0-9a-f]{32}$/),
	recurringId: z.uuid(),
	personId: z.union([z.uuid(), z.literal('')]),
	newName: z.union([personName, z.literal('')]),
	amount: z.string().trim().min(1).max(16),
	receiveDay: z.coerce.number().int().min(1).max(31),
	startMonth: month
});

function fromForm(form: FormData) {
	return Object.fromEntries([...form].map(([k, v]) => [k, typeof v === 'string' ? v : '']));
}

function guarded<T>(fn: () => T) {
	try {
		return fn();
	} catch (e) {
		if (e instanceof ValidationError) return fail(400, { message: `${e.message}.` });
		throw e;
	}
}

export const actions: Actions = {
	received: async ({ request }) => {
		const parsed = idSchema.safeParse(fromForm(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Onbekende post.' });
		return guarded(() => {
			confirmReceived(db(), parsed.data.id);
			return { received: parsed.data.id };
		});
	},
	forgive: async ({ request }) => {
		const parsed = idSchema.safeParse(fromForm(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Onbekende post.' });
		return guarded(() => {
			forgiveOwed(db(), parsed.data.id);
			return { forgiven: parsed.data.id };
		});
	},
	unforgive: async ({ request }) => {
		const parsed = idSchema.safeParse(fromForm(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Onbekende post.' });
		return guarded(() => {
			forgiveOwed(db(), parsed.data.id, true);
			return { restored: true };
		});
	},
	unlink: async ({ request }) => {
		const parsed = idSchema.safeParse(fromForm(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Onbekende betaling.' });
		db().transaction((tx) => unlinkPayment(tx, parsed.data.id));
		return { unlinked: true };
	},
	payable: async ({ request }) => {
		const parsed = personSchema.safeParse(fromForm(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Onbekende persoon.' });
		return guarded(() => {
			creditToPayable(db(), parsed.data.personId);
			return { payable: true };
		});
	},
	accept: async ({ request }) => {
		const parsed = acceptSchema.safeParse(fromForm(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Controleer de velden.' });
		const cents = parseAmount(parsed.data.amount);
		if (cents === null || cents === 0 || cents > MAX_CENTS)
			return fail(400, { message: 'Dat bedrag kan ik niet lezen.' });
		const today = toIsoDate(new Date());
		if (parsed.data.startMonth > shiftMonth(today.slice(0, 7), 12))
			return fail(400, { message: 'De startmaand ligt te ver weg.' });
		return guarded(() => {
			acceptProposal(db(), {
				key: parsed.data.key,
				recurringId: parsed.data.recurringId,
				personId: parsed.data.personId || null,
				newName: parsed.data.newName || null,
				amountCents: cents,
				receiveDay: parsed.data.receiveDay,
				startMonth: parsed.data.startMonth
			});
			return { accepted: true };
		});
	},
	dismiss: async ({ request }) => {
		const parsed = keySchema.safeParse(fromForm(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Onbekend voorstel.' });
		return guarded(() => {
			dismissProposal(db(), parsed.data.key);
			return { dismissed: true };
		});
	}
};
