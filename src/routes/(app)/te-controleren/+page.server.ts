import { fail } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { groupHue } from '#lib/categoryColor.ts';
import { toIsoDate } from '#lib/dates.ts';
import { parseAmount } from '#lib/money.ts';
import { db } from '#lib/server/db/index.ts';
import { transactions } from '#lib/server/db/schema.ts';
import { ValidationError } from '#lib/server/errors.ts';
import { mergeImported } from '#lib/server/import/koppellijst.ts';
import { confirmExpected, skipExpected } from '#lib/server/recurring.ts';
import { inboxCount, leaveInInbox, reviewInbox } from '#lib/server/review.ts';
import { confirmReceived, creditToPayable } from '#lib/server/shares.ts';
import { updateTransaction } from '#lib/server/transactions.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ setHeaders }) => {
	const today = toIsoDate(new Date());
	setHeaders({ 'cache-control': 'private, no-cache' });
	const inbox = reviewInbox(db(), today);
	// Tinten voor monogrammen en bolletjes hier, zodat de pagina categoryColor.ts niet met het
	// startscherm deelt: dat gaf een extra chunk in de eerste bundel van het startscherm
	const hue = (name: string | null) => (name ? groupHue(name) : null);
	return {
		today,
		count: inboxCount(inbox),
		inbox: {
			missed: inbox.missed.map((i) => ({ ...i, hue: hue(i.categoryGroup) })),
			transactions: inbox.transactions.map((t) => ({
				...t,
				hue: hue(t.categoryGroup),
				own: t.own && {
					preselect: t.own.preselect,
					candidates: t.own.candidates.map((c) => ({ ...c, hue: hue(c.categoryGroup) }))
				}
			})),
			late: inbox.late.map((l) => ({ ...l, hue: groupHue(l.personName) })),
			credit: inbox.credit.map((c) => ({ ...c, hue: groupHue(c.personName) })),
			reminders: inbox.reminders.map((r) => ({
				...r,
				hue: groupHue(r.personName ?? 'Nog niet gekozen')
			}))
		}
	};
};

const idSchema = z.object({ id: z.uuid() });
const confirmSchema = z.object({ id: z.uuid(), amount: z.string().trim().max(16).optional() });
const skipSchema = z.object({ id: z.uuid(), reason: z.enum(['gemist', 'opgezegd']) });
const personSchema = z.object({ personId: z.uuid() });
// Koppellijst: je eigen invoer, of `nieuw` als de boeking er los naast hoort
const mergeSchema = z.object({ id: z.uuid(), target: z.union([z.literal('nieuw'), z.uuid()]) });
const leaveSchema = z.object({ kind: z.enum(['te_laat', 'herinnering', 'tegoed']), id: z.uuid() });

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
	// Gemist of opgezegd? Dezelfde acties als op het startscherm (ExpectedItem)
	confirmExpected: async ({ request }) => {
		const parsed = confirmSchema.safeParse(fromForm(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Deze post ken ik niet.' });
		const cents = parsed.data.amount === undefined ? undefined : parseAmount(parsed.data.amount);
		if (cents === null || cents === 0)
			return fail(400, { message: 'Dat bedrag kan ik niet lezen.' });
		return guarded(() => {
			confirmExpected(db(), parsed.data.id, cents);
			return { confirmed: parsed.data.id };
		});
	},
	skipExpected: async ({ request }) => {
		const parsed = skipSchema.safeParse(fromForm(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Deze post ken ik niet.' });
		return guarded(() => {
			skipExpected(db(), parsed.data.id, parsed.data.reason);
			return { skipped: parsed.data.id };
		});
	},
	// Een boeking klopt zoals hij is: van te controleren naar bevestigd
	confirm: async ({ request }) => {
		const parsed = idSchema.safeParse(fromForm(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Deze transactie ken ik niet.' });
		const t = db()
			.select({ status: transactions.status, amountCents: transactions.amountCents })
			.from(transactions)
			.where(eq(transactions.id, parsed.data.id))
			.get();
		if (!t) return fail(404, { message: 'Deze transactie bestaat niet meer.' });
		if (t.status !== 'te_controleren')
			return fail(400, { message: 'Deze transactie is al gecontroleerd.' });
		if (t.amountCents === 0)
			return fail(400, { message: 'Vul eerst het eurobedrag in bij de transactie.' });
		return guarded(() => {
			updateTransaction(db(), parsed.data.id, { amountCents: t.amountCents });
			return { confirmed: parsed.data.id };
		});
	},
	// Koppellijst bij een import: samenvoegen met je eigen invoer, of een nieuwe transactie
	merge: async ({ request }) => {
		const parsed = mergeSchema.safeParse(fromForm(await request.formData()));
		if (!parsed.success)
			return fail(400, { message: 'Kies je eigen invoer of een nieuwe transactie.' });
		const { id, target } = parsed.data;
		if (target === 'nieuw') {
			const t = db()
				.select({ status: transactions.status, amountCents: transactions.amountCents })
				.from(transactions)
				.where(eq(transactions.id, id))
				.get();
			if (!t || t.status !== 'te_controleren')
				return fail(400, { message: 'Deze boeking staat niet meer te controleren.' });
			return guarded(() => {
				updateTransaction(db(), id, { amountCents: t.amountCents });
				return { merged: id, differenceCents: null };
			});
		}
		return guarded(() => ({ merged: id, ...mergeImported(db(), id, target) }));
	},
	received: async ({ request }) => {
		const parsed = idSchema.safeParse(fromForm(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Deze post ken ik niet.' });
		return guarded(() => {
			confirmReceived(db(), parsed.data.id);
			return { received: parsed.data.id };
		});
	},
	payable: async ({ request }) => {
		const parsed = personSchema.safeParse(fromForm(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Deze persoon ken ik niet.' });
		return guarded(() => {
			creditToPayable(db(), parsed.data.personId);
			return { payable: parsed.data.personId };
		});
	},
	leave: async ({ request }) => {
		const parsed = leaveSchema.safeParse(fromForm(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Deze post ken ik niet.' });
		return guarded(() => {
			leaveInInbox(db(), parsed.data.kind, parsed.data.id);
			return { left: parsed.data.id };
		});
	}
};
