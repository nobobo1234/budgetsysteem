import { error, fail, redirect } from '@sveltejs/kit';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { groupHue } from '#lib/categoryColor.ts';
import { isIsoDate } from '#lib/dates.ts';
import { parseAmount } from '#lib/money.ts';
import { PRODUCT_GROUPS } from '#lib/productGroups.ts';
import { db } from '#lib/server/db/index.ts';
import { accounts, transactions } from '#lib/server/db/schema.ts';
import { ValidationError } from '#lib/server/errors.ts';
import {
	confirmList,
	defaultListAccount,
	linkedTransactions,
	listWithMatches,
	type ListChoice
} from '#lib/server/receipts/list.ts';
import { receiptLinesOf, setLineGroup } from '#lib/server/receipts/lines.ts';
import { isComplete } from '#lib/server/receipts/outcome.ts';
import {
	confirmReceipt,
	correctReceipt,
	defaultAccountId,
	deleteReceipt,
	loadReceipt,
	receiptCandidates,
	rereadReceipt,
	settleReceipt
} from '#lib/server/receipts/process.ts';
import { MAX_LIST_ITEMS } from '#lib/server/receipts/schema.ts';
import { receiptView } from '#lib/server/receipts/view.ts';
import { createWarranty, warrantiesOf } from '#lib/server/warranty.ts';
import { productName } from '../../garantie/form.ts';
import type { Actions, PageServerLoad } from './$types';

// Bon (spec: Schermen, Bonnetjes en koppelen): wat Haiku las met de zekerheid per veld, de
// koppellijst om te verwerken, en nakijken, aanpassen, opnieuw lezen of weggooien. Een screenshot
// met transacties toont een lijst met per regel de koppellijst, om in één keer te bevestigen.

const idSchema = z.uuid();

export const load: PageServerLoad = ({ params, depends, setHeaders }) => {
	depends('app:bon');
	setHeaders({ 'cache-control': 'private, no-cache' });
	if (!idSchema.safeParse(params.id).success) error(404, 'Niet gevonden');
	const receipt = loadReceipt(db(), params.id);
	if (!receipt) error(404, 'Niet gevonden');
	const list = receipt.kind === 'lijst' ? listData(receipt) : null;
	const complete = !list && isComplete(receipt.fields);
	const match = complete ? receiptCandidates(db(), receipt.fields) : null;
	const linked = receipt.transactionId
		? (db()
				.select({
					id: transactions.id,
					counterparty: transactions.counterparty,
					date: transactions.date,
					amountCents: transactions.amountCents,
					origAmountCents: transactions.origAmountCents,
					origCurrency: transactions.origCurrency,
					source: transactions.source,
					status: transactions.status,
					correctionOf: transactions.correctionOf
				})
				.from(transactions)
				.where(eq(transactions.id, receipt.transactionId))
				.get() ?? null)
		: null;
	return {
		receipt: receiptView(receipt, list?.items.length ?? 0),
		complete,
		candidates: (match?.candidates ?? []).map((c) => ({
			id: c.id,
			counterparty: c.counterparty,
			date: c.date,
			amountCents: c.amountCents,
			origAmountCents: c.origAmountCents,
			origCurrency: c.origCurrency,
			accountAlias: c.accountAlias,
			categoryName: c.categoryName,
			hue: c.categoryGroup ? groupHue(c.categoryGroup) : null,
			label: c.label,
			score: c.score
		})),
		preselect: match?.preselect ?? null,
		linked,
		// Garantie: de producten bij de transactie van deze bon, of zelf bijhouden
		warranties: linked ? warrantiesOf(db(), [linked.id]) : [],
		canWarranty:
			receipt.kind === 'bon' &&
			!!linked &&
			linked.amountCents < 0 &&
			!linked.correctionOf &&
			linked.status !== 'verwacht',
		accounts: db()
			.select({ id: accounts.id, name: accounts.name })
			.from(accounts)
			.orderBy(asc(accounts.createdAt))
			.all(),
		defaultAccount: list?.defaultAccount ?? defaultAccountId(db(), receipt.fields.currency),
		items: list?.items ?? [],
		// De regels van een verwerkte bon, met de productgroep per artikel (aan te passen)
		lines: list ? [] : receiptLinesOf(db(), receipt.id)
	};
};

type Loaded = NonNullable<ReturnType<typeof loadReceipt>>;

/** Een screenshot: per transactie de gelezen velden, de koppellijst en het voorstel. */
function listData(receipt: Loaded) {
	const items = listWithMatches(db(), receipt.id);
	const linked = linkedTransactions(db(), items);
	return {
		items: items.map((i) => ({
			id: i.id,
			date: i.date,
			counterparty: i.counterparty,
			amountCents: i.amountCents,
			currency: i.currency,
			outcome: i.outcome,
			complete: i.complete,
			confidence: Object.fromEntries(
				Object.entries(i.confidence).map(([k, c]) => [
					k,
					{ status: c.status, model: c.model, note: c.note }
				])
			) as Record<
				'datum' | 'tegenpartij' | 'bedrag' | 'valuta',
				{
					status: 'zeker' | 'controleren' | 'onzeker';
					model: 'zeker' | 'twijfel' | 'onleesbaar' | null;
					note: string;
				}
			>,
			plan: i.plan,
			candidates: i.candidates.map((c) => ({
				id: c.id,
				counterparty: c.counterparty,
				date: c.date,
				amountCents: c.amountCents,
				origAmountCents: c.origAmountCents,
				origCurrency: c.origCurrency,
				source: c.source,
				label: c.label
			})),
			linked: i.transactionId ? (linked.get(i.transactionId) ?? null) : null
		})),
		defaultAccount: defaultListAccount(db(), items)
	};
}

const correctSchema = z.object({
	store: z.string().trim().min(1).max(100),
	date: z.string().refine(isIsoDate),
	amount: z.string().trim().max(16),
	currency: z
		.string()
		.trim()
		.toUpperCase()
		.regex(/^[A-Z]{3}$/)
});
// `transactie:<id>` voor een bestaande transactie, `nieuw` voor een nieuwe
const targetSchema = z.union([
	z.literal('nieuw'),
	z
		.string()
		.max(60)
		.transform((t) => t.split(':'))
		.pipe(z.tuple([z.literal('transactie'), z.uuid()]))
]);
const groupSchema = z.object({
	lineId: z.uuid(),
	group: z.enum(PRODUCT_GROUPS)
});
const settleSchema = z.object({
	target: targetSchema,
	accountId: z.uuid().optional()
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
	correct: async ({ params, request }) => {
		const parsed = correctSchema.safeParse(fromForm(await request.formData()));
		if (!parsed.success)
			return fail(400, { message: 'Vul een winkel, een datum, een bedrag en een valuta in.' });
		const cents = parseAmount(parsed.data.amount);
		if (cents === null || cents <= 0)
			return fail(400, { message: 'Dat bedrag kan ik niet lezen.' });
		return guarded(() => {
			correctReceipt(db(), params.id, {
				store: parsed.data.store,
				date: parsed.data.date,
				totalCents: cents,
				currency: parsed.data.currency
			});
			return { corrected: true };
		});
	},
	settle: async ({ params, request }) => {
		const parsed = settleSchema.safeParse(fromForm(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Kies een transactie of een nieuwe.' });
		const { target, accountId } = parsed.data;
		if (target === 'nieuw' && !accountId) return fail(400, { message: 'Kies een rekening.' });
		return guarded(() => {
			const transactionId = settleReceipt(
				db(),
				params.id,
				target === 'nieuw'
					? { kind: 'nieuw', accountId: accountId! }
					: { kind: 'koppelen', transactionId: target[1] }
			);
			return { settled: transactionId, created: target === 'nieuw' };
		});
	},
	confirmList: async ({ params, request }) => {
		const form = await request.formData();
		const ids = z.array(z.uuid()).max(MAX_LIST_ITEMS).safeParse(form.getAll('item'));
		if (!ids.success) return fail(400, { message: 'Deze lijst kan ik niet lezen.' });
		const choices: ListChoice[] = [];
		for (const itemId of ids.data) {
			const target = targetSchema.safeParse(form.get(`target-${itemId}`));
			if (!target.success)
				return fail(400, { message: 'Kies bij elke aangevinkte regel wat hij is.' });
			choices.push({
				itemId,
				target:
					target.data === 'nieuw'
						? { kind: 'nieuw' }
						: { kind: 'koppelen', transactionId: target.data[1] }
			});
		}
		const account = z.uuid().safeParse(form.get('accountId'));
		return guarded(() => {
			const done = confirmList(db(), params.id, choices, account.success ? account.data : null);
			return { listed: done };
		});
	},
	group: async ({ params, request }) => {
		if (!idSchema.safeParse(params.id).success) return fail(404, { message: 'Niet gevonden.' });
		const parsed = groupSchema.safeParse(fromForm(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Kies een productgroep.' });
		return guarded(() => {
			setLineGroup(db(), params.id, parsed.data.lineId, parsed.data.group);
			return { grouped: parsed.data.lineId };
		});
	},
	confirm: ({ params }) =>
		guarded(() => {
			confirmReceipt(db(), params.id);
			return { confirmed: true };
		}),
	reread: ({ params }) =>
		guarded(() => {
			rereadReceipt(db(), params.id);
			return { reread: true };
		}),
	warranty: async ({ params, request }) => {
		if (!idSchema.safeParse(params.id).success) return fail(404, { message: 'Niet gevonden.' });
		const product = productName.safeParse((await request.formData()).get('product'));
		if (!product.success) return fail(400, { message: 'Vul de naam van het product in.' });
		const receipt = loadReceipt(db(), params.id);
		if (!receipt?.transactionId)
			return fail(400, { message: 'Verwerk de bon eerst bij een transactie.' });
		const id = guarded(() =>
			createWarranty(db(), {
				transactionId: receipt.transactionId!,
				receiptId: receipt.id,
				product: product.data
			})
		);
		if (typeof id !== 'string') return id;
		redirect(303, `/garantie/${id}`);
	},
	delete: async ({ params }) => {
		if (!idSchema.safeParse(params.id).success) return fail(404, { message: 'Niet gevonden.' });
		try {
			await deleteReceipt(db(), params.id);
		} catch (e) {
			if (e instanceof ValidationError) return fail(400, { message: `${e.message}.` });
			throw e;
		}
		redirect(303, '/bonnen');
	}
};
