import { fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { toIsoDate } from '#lib/dates.ts';
import { parseAmount } from '#lib/money.ts';
import { db } from '#lib/server/db/index.ts';
import { transactions } from '#lib/server/db/schema.ts';
import { ValidationError } from '#lib/server/errors.ts';
import { mergeImported } from '#lib/server/import/koppellijst.ts';
import { confirmExpected, skipExpected } from '#lib/server/recurring.ts';
import { inboxCount, leaveInInbox, reviewInbox } from '#lib/server/review.ts';
import { confirmReceipt } from '#lib/server/receipts/process.ts';
import { confirmReceived, creditToPayable } from '#lib/server/shares.ts';
import { updateTransaction } from '#lib/server/transactions.ts';
import {
	createWarranty,
	discardWarranty,
	keepRefunded,
	rejectProposal
} from '#lib/server/warranty.ts';
import { startSchema } from '../garantie/form.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ setHeaders }) => {
	const today = toIsoDate(new Date());
	setHeaders({ 'cache-control': 'private, no-cache' });
	const inbox = reviewInbox(db(), today);
	return { today, inbox, count: inboxCount(inbox) };
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
	// Een verwerkte bon met twijfel klopt
	confirmReceipt: async ({ request }) => {
		const parsed = idSchema.safeParse(fromForm(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Deze bon ken ik niet.' });
		return guarded(() => {
			confirmReceipt(db(), parsed.data.id);
			return { receipt: parsed.data.id };
		});
	},
	// Garantie bijhouden? Met de naam van het product naar zijn pagina, of afwijzen
	warranty: async ({ request }) => {
		const parsed = startSchema.safeParse(fromForm(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Vul de naam van het product in.' });
		const result = guarded(() => createWarranty(db(), parsed.data));
		if (typeof result !== 'string') return result;
		redirect(303, `/garantie/${result}`);
	},
	rejectWarranty: async ({ request }) => {
		const parsed = z
			.object({ transactionId: z.uuid() })
			.safeParse(fromForm(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Dit voorstel ken ik niet.' });
		return guarded(() => {
			rejectProposal(db(), parsed.data.transactionId, toIsoDate(new Date()));
			return { rejected: parsed.data.transactionId };
		});
	},
	// Na een retour: het product is weg (afdanken) of nog in huis (laten staan)
	discardWarranty: async ({ request }) => {
		const parsed = idSchema.safeParse(fromForm(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Deze garantie ken ik niet.' });
		return guarded(() => {
			if (!discardWarranty(db(), parsed.data.id))
				return fail(404, { message: 'Deze garantie bestaat niet meer.' });
			return { discarded: parsed.data.id };
		});
	},
	keepWarranty: async ({ request }) => {
		const parsed = idSchema.safeParse(fromForm(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Deze garantie ken ik niet.' });
		return guarded(() => {
			keepRefunded(db(), parsed.data.id);
			return { kept: parsed.data.id };
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
