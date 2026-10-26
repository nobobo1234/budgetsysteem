import { describe, expect, it } from 'vitest';
import type { MatchLabel } from '../../match.ts';
import {
	isComplete,
	isItemComplete,
	matchQueryFor,
	planListItems,
	planReceipt,
	receiptStage,
	type ListItemInput
} from './outcome.ts';
import { emptyFields, type StoredFields } from './stored.ts';

// Wat er met een gelezen bon gebeurt (spec: Verwerking stap 5, Koppellijst).

const fields = (overrides: Partial<StoredFields> = {}): StoredFields => ({
	...emptyFields(),
	store: 'Supermarkt Voorbeeld',
	date: '2026-10-20',
	totalCents: 737,
	currency: 'EUR',
	paymentMethod: 'pin',
	...overrides
});

const ranked = (labels: MatchLabel[], preselect: string | null = null) => ({
	candidates: labels.map((label) => ({ label })),
	preselect
});

describe('planReceipt', () => {
	it('zeker met een duidelijke voorloper: koppelen en klaar', () => {
		expect(planReceipt('zeker', fields(), ranked(['waarschijnlijk'], 'tx-1'))).toEqual({
			action: 'koppelen',
			transactionId: 'tx-1',
			handled: true
		});
	});

	it('zeker zonder iets dat erop lijkt: nieuwe transactie, bevestigd en klaar', () => {
		expect(planReceipt('zeker', fields(), ranked([]))).toEqual({
			action: 'nieuw',
			handled: true,
			status: 'bevestigd'
		});
		// Alleen onwaarschijnlijke kandidaten tellen niet als twijfel
		expect(
			planReceipt('zeker', fields(), ranked(['onwaarschijnlijk', 'onwaarschijnlijk']))
		).toEqual({ action: 'nieuw', handled: true, status: 'bevestigd' });
	});

	it('zeker met kandidaten maar zonder voorloper: zelf kiezen, nooit gokken', () => {
		expect(planReceipt('zeker', fields(), ranked(['waarschijnlijk', 'mogelijk']))).toEqual({
			action: 'inbox',
			reason: 'kiezen'
		});
		expect(planReceipt('zeker', fields(), ranked(['mogelijk']))).toEqual({
			action: 'inbox',
			reason: 'kiezen'
		});
	});

	it('controleren: verwerkt zoals zeker, maar niet klaar en een nieuwe op te controleren', () => {
		expect(planReceipt('controleren', fields(), ranked(['waarschijnlijk'], 'tx-1'))).toEqual({
			action: 'koppelen',
			transactionId: 'tx-1',
			handled: false
		});
		expect(planReceipt('controleren', fields(), ranked([]))).toEqual({
			action: 'nieuw',
			handled: false,
			status: 'te_controleren'
		});
		expect(planReceipt('controleren', fields(), ranked(['mogelijk']))).toEqual({
			action: 'inbox',
			reason: 'kiezen'
		});
	});

	it('onzeker: altijd de review-inbox, ook met een voorloper', () => {
		expect(planReceipt('onzeker', fields(), ranked(['waarschijnlijk'], 'tx-1'))).toEqual({
			action: 'inbox',
			reason: 'onzeker'
		});
		expect(planReceipt('onzeker', fields(), ranked([]))).toEqual({
			action: 'inbox',
			reason: 'onzeker'
		});
	});

	it('zonder winkel, datum, totaal of valuta wordt er niets geboekt', () => {
		for (const missing of [
			{ store: null },
			{ store: '  ' },
			{ date: null },
			{ totalCents: null },
			{ totalCents: 0 },
			{ currency: null }
		]) {
			expect(planReceipt('zeker', fields(missing), ranked([])), JSON.stringify(missing)).toEqual({
				action: 'inbox',
				reason: 'onzeker'
			});
		}
	});
});

describe('matchQueryFor en isComplete', () => {
	it('vraagt de koppellijst met het positieve totaal, de datum en de winkel', () => {
		expect(matchQueryFor(fields())).toEqual({
			amountCents: 737,
			date: '2026-10-20',
			name: 'Supermarkt Voorbeeld'
		});
		expect(matchQueryFor(fields({ store: null }))).toMatchObject({ name: '' });
		expect(matchQueryFor(fields({ date: null }))).toBeNull();
		expect(matchQueryFor(fields({ totalCents: -5 }))).toBeNull();
	});

	it('is pas compleet met winkel, datum, positief totaal en valuta', () => {
		expect(isComplete(fields())).toBe(true);
		expect(isComplete(fields({ currency: 'USD' }))).toBe(true);
		expect(isComplete(emptyFields())).toBe(false);
	});
});

describe('receiptStage', () => {
	const base = { transactionId: null, handledAt: null };
	it('volgt status, koppeling en afhandeling', () => {
		expect(receiptStage({ ...base, status: 'wordt_gelezen' })).toBe('wordt_gelezen');
		expect(receiptStage({ ...base, status: 'fout' })).toBe('fout');
		expect(receiptStage({ ...base, status: 'onzeker' })).toBe('onzeker');
		expect(receiptStage({ ...base, status: 'zeker' })).toBe('kiezen');
		expect(receiptStage({ ...base, status: 'controleren' })).toBe('kiezen');
		expect(receiptStage({ ...base, status: 'controleren', transactionId: 't' })).toBe('nakijken');
		expect(
			receiptStage({ status: 'controleren', transactionId: 't', handledAt: '2026-10-21' })
		).toBe('klaar');
		expect(receiptStage({ status: 'fout', transactionId: 't', handledAt: '2026-10-21' })).toBe(
			'klaar'
		);
	});

	it('een screenshot met transacties wacht als lijst tot je hem bevestigt', () => {
		const list = { ...base, kind: 'lijst' as const };
		expect(receiptStage({ ...list, status: 'wordt_gelezen' })).toBe('wordt_gelezen');
		expect(receiptStage({ ...list, status: 'zeker' })).toBe('lijst');
		expect(receiptStage({ ...list, status: 'onzeker' })).toBe('lijst');
		expect(receiptStage({ ...list, status: 'fout' })).toBe('fout');
		expect(receiptStage({ ...list, status: 'zeker', handledAt: '2026-10-21' })).toBe('klaar');
		expect(receiptStage({ ...base, kind: 'bon', status: 'zeker' })).toBe('kiezen');
	});
});

describe('planListItems', () => {
	const item = (overrides: Partial<ListItemInput> = {}): ListItemInput => ({
		date: '2026-10-20',
		counterparty: 'Supermarkt Voorbeeld',
		amountCents: -2345,
		currency: 'EUR',
		outcome: 'zeker',
		ranked: ranked([]),
		...overrides
	});

	it('niets dat erop lijkt: nieuw en aangevinkt, behalve als hij onzeker is', () => {
		expect(planListItems([item(), item({ ranked: ranked(['onwaarschijnlijk']) })])).toEqual([
			{ action: 'nieuw', checked: true },
			{ action: 'nieuw', checked: true }
		]);
		expect(planListItems([item({ outcome: 'controleren' }), item({ outcome: 'onzeker' })])).toEqual(
			[
				{ action: 'nieuw', checked: true },
				{ action: 'nieuw', checked: false }
			]
		);
	});

	it('een duidelijke voorloper wordt gekoppeld; zonder voorloper kies je zelf', () => {
		expect(
			planListItems([
				item({ ranked: ranked(['waarschijnlijk'], 'tx-1') }),
				item({ ranked: ranked(['mogelijk', 'mogelijk']) })
			])
		).toEqual([
			{ action: 'koppelen', transactionId: 'tx-1', checked: true },
			{ action: 'kiezen', checked: false }
		]);
	});

	it('koppelt twee regels nooit aan dezelfde transactie', () => {
		const same = ranked(['waarschijnlijk'], 'tx-1');
		expect(planListItems([item({ ranked: same }), item({ ranked: same })])).toEqual([
			{ action: 'koppelen', transactionId: 'tx-1', checked: true },
			{ action: 'kiezen', checked: false }
		]);
	});

	it('een onvolledige regel is niet te boeken', () => {
		for (const missing of [
			{ date: null },
			{ counterparty: null },
			{ counterparty: '  ' },
			{ amountCents: null },
			{ amountCents: 0 },
			{ currency: null }
		]) {
			expect(isItemComplete(item(missing)), JSON.stringify(missing)).toBe(false);
			expect(
				planListItems([item({ ...missing, ranked: ranked(['waarschijnlijk'], 'tx-1') })])
			).toEqual([{ action: 'onvolledig', checked: false }]);
		}
		expect(isItemComplete(item({ amountCents: 215000 }))).toBe(true);
	});
});
