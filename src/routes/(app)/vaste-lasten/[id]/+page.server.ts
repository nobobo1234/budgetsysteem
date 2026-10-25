import { error, fail, redirect } from '@sveltejs/kit';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { isIsoDate, toIsoDate } from '#lib/dates.ts';
import { parseAmount } from '#lib/money.ts';
import { db } from '#lib/server/db/index.ts';
import { categories, recurringShares } from '#lib/server/db/schema.ts';
import { findOrCreatePerson, listPeople } from '#lib/server/people.ts';
import { getRecurring, stopRecurring, updateRecurring } from '#lib/server/recurring.ts';
import {
	changeShareAmount,
	createShare,
	deleteShare,
	listShares,
	updateShare
} from '#lib/server/shares.ts';
import { personName } from '#lib/server/validation.ts';
import { ValidationError } from '#lib/server/transactions.ts';
import type { Actions, PageServerLoad } from './$types';

const idSchema = z.uuid();

export const load: PageServerLoad = ({ params }) => {
	if (!idSchema.safeParse(params.id).success) error(404, 'Niet gevonden');
	const today = toIsoDate(new Date());
	const item = getRecurring(db(), params.id, today);
	if (!item) error(404, 'Niet gevonden');
	// Een voorstel bevestig je op het overzicht
	if (item.status === 'voorstel') redirect(303, '/vaste-lasten');
	return {
		today,
		item,
		shares: listShares(db(), params.id, today),
		people: listPeople(db()).filter((p) => p.active),
		categories: db()
			.select({ id: categories.id, name: categories.name, group: categories.group })
			.from(categories)
			.where(eq(categories.archived, false))
			.orderBy(asc(categories.sortOrder), asc(categories.name))
			.all()
	};
};

const saveSchema = z.object({
	counterparty: z.string().trim().min(1).max(100),
	amount: z.string().trim().max(16),
	kind: z.enum(['vast', 'wisselend']),
	interval: z.enum(['maand', 'kwartaal', 'halfjaar', 'jaar']),
	nextDate: z.string().refine(isIsoDate),
	categoryId: z.union([z.literal(''), z.uuid()]),
	spread: z.literal('on').optional()
});

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

const shareSchema = z.object({
	personId: z.union([z.uuid(), z.literal('')]),
	newName: z.union([personName, z.literal('')]),
	kind: z.enum(['vast', 'percentage']),
	amount: z.string().trim().min(1).max(16),
	receiveDay: z.coerce.number().int().min(1).max(31),
	startMonth: month,
	endMonth: z.union([month, z.literal('')])
});

const changeSchema = z.object({
	shareId: z.uuid(),
	amount: z.string().trim().min(1).max(16),
	fromMonth: month
});

const endSchema = z.object({
	shareId: z.uuid(),
	receiveDay: z.coerce.number().int().min(1).max(31),
	endMonth: z.union([month, z.literal('')])
});

/**
 * Bedrag of percentage naar hele centen of hele basispunten: `25` en `33,33` (procent) worden
 * 2500 en 3333, zonder parseFloat.
 */
function shareTerms(kind: 'vast' | 'percentage', text: string) {
	const n = parseAmount(text);
	if (n === null || n === 0) return null;
	if (kind === 'percentage') return n > 10_000 ? null : { basisPoints: n };
	return { amountCents: n };
}

function shareFail(e: unknown) {
	if (e instanceof ValidationError) return fail(400, { shareMessage: `${e.message}.` });
	throw e;
}

export const actions: Actions = {
	addShare: async ({ request, params }) => {
		const parsed = shareSchema.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) return fail(400, { shareMessage: 'Controleer de velden.' });
		const { personId, newName, kind, receiveDay, startMonth, endMonth } = parsed.data;
		const terms = shareTerms(kind, parsed.data.amount);
		if (!terms)
			return fail(400, {
				shareMessage:
					kind === 'percentage' ? 'Vul een percentage tot 100 in.' : 'Dat bedrag kan ik niet lezen.'
			});
		if (!personId && !newName) return fail(400, { shareMessage: 'Kies een persoon.' });
		try {
			const who = personId || db().transaction((tx) => findOrCreatePerson(tx, newName));
			createShare(db(), {
				recurringId: params.id,
				personId: who,
				kind,
				...terms,
				receiveDay,
				startMonth,
				endMonth: endMonth || null
			});
		} catch (e) {
			return shareFail(e);
		}
		return { shareAdded: true };
	},
	changeShare: async ({ request }) => {
		const parsed = changeSchema.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) return fail(400, { shareMessage: 'Controleer de velden.' });
		const share = listShareKind(parsed.data.shareId);
		if (!share) return fail(400, { shareMessage: 'Onbekend aandeel.' });
		const terms = shareTerms(share, parsed.data.amount);
		if (!terms) return fail(400, { shareMessage: 'Dat bedrag kan ik niet lezen.' });
		try {
			changeShareAmount(db(), parsed.data.shareId, terms, parsed.data.fromMonth);
		} catch (e) {
			return shareFail(e);
		}
		return { shareSaved: true };
	},
	updateShare: async ({ request }) => {
		const parsed = endSchema.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) return fail(400, { shareMessage: 'Controleer de velden.' });
		try {
			updateShare(db(), parsed.data.shareId, {
				receiveDay: parsed.data.receiveDay,
				endMonth: parsed.data.endMonth || null
			});
		} catch (e) {
			return shareFail(e);
		}
		return { shareSaved: true };
	},
	deleteShare: async ({ request }) => {
		const parsed = z
			.object({ shareId: z.uuid() })
			.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) return fail(400, { shareMessage: 'Onbekend aandeel.' });
		try {
			deleteShare(db(), parsed.data.shareId);
		} catch (e) {
			return shareFail(e);
		}
		return { shareDeleted: true };
	},
	save: async ({ request, params }) => {
		const parsed = saveSchema.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Controleer de velden.' });
		const cents = parseAmount(parsed.data.amount);
		if (cents === null || cents === 0)
			return fail(400, { message: 'Dat bedrag kan ik niet lezen.' });
		try {
			updateRecurring(db(), params.id, {
				counterparty: parsed.data.counterparty,
				medianCents: cents,
				kind: parsed.data.kind,
				interval: parsed.data.interval,
				nextDate: parsed.data.nextDate,
				categoryId: parsed.data.categoryId || null,
				spread: !!parsed.data.spread
			});
		} catch (e) {
			if (e instanceof ValidationError) return fail(400, { message: e.message });
			throw e;
		}
		return { saved: true };
	},
	stop: async ({ params }) => {
		try {
			stopRecurring(db(), params.id);
		} catch (e) {
			if (e instanceof ValidationError) return fail(400, { message: e.message });
			throw e;
		}
		redirect(303, '/vaste-lasten');
	}
};

function listShareKind(id: string): 'vast' | 'percentage' | null {
	return (
		db()
			.select({ kind: recurringShares.kind })
			.from(recurringShares)
			.where(eq(recurringShares.id, id))
			.get()?.kind ?? null
	);
}
