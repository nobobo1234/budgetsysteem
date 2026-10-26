import { describe, expect, it } from 'vitest';
import { readStored } from './stored.ts';

// Teruglezen van bewaarde velden (spec: Datamodel → receipts).

const confidence = Object.fromEntries(
	['winkel', 'datum', 'totaal', 'valuta', 'betaalwijze'].map((f) => [
		f,
		{ status: 'zeker', model: 'zeker', note: '', failures: [], corrected: false }
	])
);

const fields = (lines: unknown[]) => ({
	store: 'Supermarkt Voorbeeld',
	date: '2026-10-20',
	totalCents: 368,
	currency: 'EUR',
	paymentMethod: 'pin',
	lines,
	linesSumCents: 368
});

describe('regels teruglezen', () => {
	it('een bon van voor de productgroepen houdt zijn regels, zonder groep', () => {
		const { fields: f } = readStored(
			fields([
				{ description: 'Brood', cents: 249, kind: 'artikel' },
				{ description: 'Melk', cents: 119, kind: 'artikel' }
			]),
			confidence
		);
		expect(f.store).toBe('Supermarkt Voorbeeld');
		expect(f.lines).toEqual([
			{ description: 'Brood', cents: 249, kind: 'artikel', group: null },
			{ description: 'Melk', cents: 119, kind: 'artikel', group: null }
		]);
	});

	it('een onbekende groep wordt leeg in plaats van de hele bon te verliezen', () => {
		const { fields: f } = readStored(
			fields([
				{ description: 'Brood', cents: 249, kind: 'artikel', group: 'bakkerij' },
				{ description: 'Melk', cents: 119, kind: 'artikel', group: 'zuivel_eieren' }
			]),
			confidence
		);
		expect(f.lines.map((l) => l.group)).toEqual([null, 'zuivel_eieren']);
		expect(f.totalCents).toBe(368);
	});
});
