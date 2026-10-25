import { error, fail, redirect } from '@sveltejs/kit';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { parseAmount } from '#lib/money.ts';
import { ibanLinkText } from '#lib/shares.ts';
import { db } from '#lib/server/db/index.ts';
import {
	accounts,
	categories,
	receipts,
	rules,
	transactionSplits,
	transactions
} from '#lib/server/db/schema.ts';
import {
	applyShare,
	matchCandidates,
	paymentLinks,
	postsOfTransaction,
	settlePayment,
	unlinkPayment
} from '#lib/server/owed.ts';
import {
	correctionCandidates,
	correctionInfo,
	linkCorrection,
	unlinkCorrection
} from '#lib/server/corrections.ts';
import { findOrCreatePerson, listPeople, personByIban } from '#lib/server/people.ts';
import { addIban } from '#lib/server/shares.ts';
import { deleteTransaction, updateTransaction, ValidationError } from '#lib/server/transactions.ts';
import { personName, transactionPatchSchema } from '#lib/server/validation.ts';
import type { Actions, PageServerLoad } from './$types';

const idSchema = z.uuid();

/**
 * Na een koppeling met een betaling van een onbekende IBAN: vragen of die bij de persoon hoort.
 * Alleen als de IBAN nog bij niemand hoort en geen eigen rekening is.
 */
function ibanSuggestion(transactionId: string, iban: string | null) {
	if (!iban || personByIban(db(), iban)) return null;
	if (db().select({ id: accounts.id }).from(accounts).where(eq(accounts.iban, iban)).get())
		return null;
	const people = new Map(
		paymentLinks(db(), transactionId).map((l) => [l.personId, l.personName] as const)
	);
	const [only, ...rest] = [...people];
	if (!only || rest.length > 0) return null;
	return { personId: only[0], name: only[1], iban };
}

const linkSchema = z.object({
	// `post:<id>` voor een openstaande post, `retour:<id>` voor de uitgave bij een retour
	target: z
		.string()
		.max(50)
		.transform((t) => t.split(':'))
		.pipe(z.tuple([z.enum(['post', 'retour']), z.uuid()])),
	mode: z.enum(['verhouding', 'mijn_deel']).optional(),
	categoryId: z.uuid().optional()
});

const shareSchema = z.object({
	mode: z.enum(['gelijk', 'bedrag']),
	names: z.array(personName).min(1).max(20),
	amounts: z.array(z.string().trim().max(16)).max(20)
});

export const load: PageServerLoad = ({ params }) => {
	if (!idSchema.safeParse(params.id).success) error(404, 'Niet gevonden');
	const tx = db().select().from(transactions).where(eq(transactions.id, params.id)).get();
	if (!tx) error(404, 'Niet gevonden');
	return {
		tx,
		// Bonnen die bij deze transactie horen
		receipts: db()
			.select({ id: receipts.id })
			.from(receipts)
			.where(eq(receipts.transactionId, tx.id))
			.all()
			.map((r) => r.id),
		// De regel die de categorie gaf, zodat je ziet waarom hij er staat
		rule: tx.categoryRuleId
			? (db()
					.select({ field: rules.field, pattern: rules.pattern })
					.from(rules)
					.where(eq(rules.id, tx.categoryRuleId))
					.get() ?? null)
			: null,
		splits: db()
			.select()
			.from(transactionSplits)
			.where(eq(transactionSplits.transactionId, tx.id))
			.all(),
		posts: postsOfTransaction(db(), tx.id),
		links: paymentLinks(db(), tx.id),
		match: tx.amountCents !== 0 && !tx.correctionOf ? matchCandidates(db(), tx.id) : null,
		// Terugboekingen: wat deze boeking verrekent, of wat erop terugkwam
		correction: correctionInfo(db(), tx.id),
		refundMatch:
			tx.amountCents !== 0 && !tx.correctionOf ? correctionCandidates(db(), tx.id) : null,
		people: listPeople(db()).filter((p) => p.active),
		ibanSuggestion: ibanSuggestion(tx.id, tx.counterIban),
		categories: db()
			.select({ id: categories.id, name: categories.name, group: categories.group })
			.from(categories)
			.where(eq(categories.archived, false))
			.orderBy(asc(categories.sortOrder))
			.all()
	};
};

export const actions: Actions = {
	save: async ({ request, params }) => {
		const form = await request.formData();
		const amountText = String(form.get('amount') ?? '').trim();
		const direction = form.get('direction') === 'in' ? 1 : -1;
		const cents = amountText ? parseAmount(amountText) : undefined;
		if (cents === null) return fail(400, { message: 'Dat bedrag kan ik niet lezen.' });

		const patch = transactionPatchSchema.safeParse({
			amountCents: cents === undefined ? undefined : direction * cents,
			date: form.get('date') || undefined,
			counterparty: form.get('counterparty') ?? undefined,
			categoryId: form.get('categoryId') ? String(form.get('categoryId')) : null,
			note: form.get('note') ?? undefined
		});
		if (!patch.success) return fail(400, { message: 'Controleer de velden.' });
		try {
			if (!updateTransaction(db(), params.id, patch.data)) error(404, 'Niet gevonden');
		} catch (e) {
			if (e instanceof ValidationError) return fail(400, { message: e.message });
			throw e;
		}
		return { saved: true };
	},
	share: async ({ request, params }) => {
		const form = await request.formData();
		const parsed = shareSchema.safeParse({
			mode: form.get('mode'),
			names: form.getAll('name').map(String),
			amounts: form.getAll('amount').map(String)
		});
		if (!parsed.success) return fail(400, { shareMessage: 'Kies minstens één persoon.' });
		const { mode, names } = parsed.data;
		let amounts: number[] | null = null;
		if (mode === 'bedrag') {
			if (parsed.data.amounts.length !== names.length)
				return fail(400, { shareMessage: 'Vul per persoon een bedrag in.' });
			amounts = [];
			for (const text of parsed.data.amounts) {
				const cents = parseAmount(text);
				if (cents === null || cents === 0)
					return fail(400, { shareMessage: `Het bedrag “${text}” kan ik niet lezen.` });
				amounts.push(cents);
			}
		}
		try {
			db().transaction((tx) => {
				const personIds = names.map((n) => findOrCreatePerson(tx, n));
				applyShare(tx, params.id, { personIds, amounts });
			});
		} catch (e) {
			if (e instanceof ValidationError) return fail(400, { shareMessage: `${e.message}.` });
			throw e;
		}
		return { shared: true };
	},
	unshare: async ({ params }) => {
		try {
			db().transaction((tx) => applyShare(tx, params.id, null));
		} catch (e) {
			if (e instanceof ValidationError) return fail(400, { shareMessage: `${e.message}.` });
			throw e;
		}
		return { unshared: true };
	},
	link: async ({ request, params }) => {
		const form = await request.formData();
		const target = linkSchema.safeParse({
			target: form.get('target'),
			mode: form.get('onlyMine') ? 'mijn_deel' : form.get('mode') || undefined,
			categoryId: form.get('categoryId') || undefined
		});
		if (!target.success) return fail(400, { linkMessage: 'Kies een post of uitgave.' });
		const [kind, id] = target.data.target;
		if (kind === 'retour') {
			try {
				db().transaction((tx) =>
					linkCorrection(tx, params.id, id, {
						mode: target.data.mode,
						categoryId: target.data.categoryId
					})
				);
			} catch (e) {
				if (e instanceof ValidationError) return fail(400, { linkMessage: `${e.message}.` });
				throw e;
			}
			return { linked: true };
		}
		const ok = db().transaction((tx) => settlePayment(tx, params.id, { owedId: id }));
		if (!ok) return fail(400, { linkMessage: 'Deze post past niet bij deze transactie.' });
		return { linked: true };
	},
	unlink: async ({ params }) => {
		db().transaction((tx) => unlinkPayment(tx, params.id));
		return { unlinked: true };
	},
	/** Andere verdeling van een retour: naar verhouding of alleen van jouw deel */
	correctionMode: async ({ request, params }) => {
		const mode = z
			.enum(['verhouding', 'mijn_deel'])
			.safeParse((await request.formData()).get('mode'));
		if (!mode.success) return fail(400, { linkMessage: 'Kies hoe de retour verdeeld wordt.' });
		const row = db().select().from(transactions).where(eq(transactions.id, params.id)).get();
		if (!row?.correctionOf) return fail(400, { linkMessage: 'Deze boeking is geen retour.' });
		try {
			db().transaction((tx) => linkCorrection(tx, row.id, row.correctionOf!, { mode: mode.data }));
		} catch (e) {
			if (e instanceof ValidationError) return fail(400, { linkMessage: `${e.message}.` });
			throw e;
		}
		return { linked: true };
	},
	/** Losmaken: een gewone boeking op te controleren */
	unlinkCorrection: async ({ params }) => {
		db().transaction((tx) => unlinkCorrection(tx, params.id));
		return { unlinked: true };
	},
	saveIban: async ({ params }) => {
		const tx = db().select().from(transactions).where(eq(transactions.id, params.id)).get();
		const suggestion = tx ? ibanSuggestion(tx.id, tx.counterIban) : null;
		if (!suggestion) return fail(400, { linkMessage: 'Er is geen IBAN om te bewaren.' });
		try {
			// Andere betalingen van dit IBAN die al binnen zijn worden meteen gekoppeld
			const { linked, unmatched } = addIban(db(), suggestion.personId, suggestion.iban);
			return {
				ibanSaved: true,
				ibanMessage:
					ibanLinkText(suggestion.name, linked, unmatched) ?? `IBAN bewaard bij ${suggestion.name}`
			};
		} catch (e) {
			if (e instanceof ValidationError) return fail(400, { linkMessage: `${e.message}.` });
			throw e;
		}
	},
	delete: async ({ params }) => {
		deleteTransaction(db(), params.id);
		redirect(303, '/transacties');
	}
};
