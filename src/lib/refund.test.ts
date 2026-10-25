import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	assignLanes,
	describeRefund,
	threadGroups,
	threadLayout,
	type RefundInfo,
	type RefundTarget
} from './refund.ts';

const target = (label: string, over: Partial<RefundTarget> = {}): RefundTarget => ({
	transactionId: null,
	label,
	month: null,
	...over
});

const info = (over: Partial<RefundInfo> = {}): RefundInfo => ({
	direction: 'te_krijgen',
	people: ['Sanne'],
	targets: [target("Domino's")],
	creditCents: 0,
	...over
});

describe('label van een terugbetaling', () => {
	it('een Tikkie: de naam erbij, want die staat niet in de tegenpartij', () => {
		expect(describeRefund(info(), 'Tikkie')).toBe("Sanne · voor Domino's");
	});

	it('zonder naam als de tegenpartij de persoon al noemt', () => {
		expect(describeRefund(info(), 'Sanne de Vries')).toBe("Terug voor Domino's");
	});

	it('een maandaandeel met de maand', () => {
		const ziggo = info({ targets: [target('Ziggo', { month: '2026-10' })] });
		expect(describeRefund(ziggo, 'S DE VRIES')).toBe('Sanne · voor Ziggo okt');
	});

	it('meer maanden van dezelfde last, op volgorde', () => {
		const months = ['2026-10', '2026-09'].map((month) => target('Ziggo', { month }));
		expect(describeRefund(info({ targets: months }), 'sanne')).toBe('Terug voor Ziggo sep, okt');
		const many = ['2026-07', '2026-08', '2026-09', '2026-10'].map((month) =>
			target('Ziggo', { month })
		);
		expect(describeRefund(info({ targets: many }), 'sanne')).toBe('Terug voor Ziggo, 4 maanden');
	});

	it('een betaling voor twee posten noemt beide; meer dan twee als aantal', () => {
		const two = info({ targets: [target('Ziggo', { month: '2026-10' }), target("Domino's")] });
		expect(describeRefund(two, 'T BAKKER')).toBe("Sanne · voor Ziggo okt en Domino's");
		const three = info({ targets: [target('A'), target('B'), target('C')] });
		expect(describeRefund(three, 'sanne')).toBe('Terug voor 3 posten');
	});

	it('tegoed zonder post', () => {
		expect(describeRefund(info({ targets: [], creditCents: 2000 }), 'S DE VRIES')).toBe(
			'Tegoed van Sanne'
		);
		expect(
			describeRefund(info({ direction: 'te_betalen', targets: [], creditCents: 500 }), 'Tikkie')
		).toBe('Tegoed bij Sanne');
	});

	it('zelf terugbetaald', () => {
		const back = info({ direction: 'te_betalen', targets: [target('Bioscoop')] });
		expect(describeRefund(back, 'Sanne')).toBe('Terugbetaald voor Bioscoop');
	});

	it('twee personen in één betaling', () => {
		expect(describeRefund(info({ people: ['Sanne', 'Tim'] }), 'Tikkie')).toBe(
			"Sanne en Tim · voor Domino's"
		);
	});
});

describe('groepen voor de draad', () => {
	const pay = (id: string, ...sources: string[]) => ({
		id,
		refund: info({ targets: sources.map((s) => target('x', { transactionId: s })) })
	});

	it('per uitgave de betalingen op dezelfde lijst', () => {
		const rows = [pay('p2', 'u1'), pay('p1', 'u1'), { id: 'x' }, { id: 'u1' }];
		expect(threadGroups(rows)).toEqual([{ source: 'u1', payments: ['p2', 'p1'] }]);
	});

	it('een betaling voor twee uitgaven zit in twee groepen', () => {
		const rows = [pay('p', 'u1', 'u2'), { id: 'u1' }, { id: 'u2' }];
		expect(threadGroups(rows)).toEqual([
			{ source: 'u1', payments: ['p'] },
			{ source: 'u2', payments: ['p'] }
		]);
	});

	it('geen draad naar een uitgave buiten de lijst, of zonder uitgave', () => {
		const rows = [pay('p', 'elders'), { id: 'q', refund: info() }, { id: 'u' }];
		expect(threadGroups(rows)).toEqual([]);
	});

	it('twee maanden van dezelfde uitgave geven één verbinding', () => {
		const rows = [pay('p', 'u', 'u'), { id: 'u' }];
		expect(threadGroups(rows)).toEqual([{ source: 'u', payments: ['p'] }]);
	});
});

describe('banen', () => {
	it('draden die niet overlappen delen een baan', () => {
		expect(
			assignLanes(
				[
					{ top: 0, bottom: 2 },
					{ top: 3, bottom: 5 }
				],
				3
			)
		).toEqual([0, 0]);
	});

	it('overlappende draden naast elkaar, de kortste het dichtst bij de rijen', () => {
		expect(
			assignLanes(
				[
					{ top: 0, bottom: 9 },
					{ top: 2, bottom: 4 }
				],
				3
			)
		).toEqual([1, 0]);
	});

	it('draden die in dezelfde rij uitkomen krijgen elk een baan', () => {
		expect(
			assignLanes(
				[
					{ top: 0, bottom: 2 },
					{ top: 2, bottom: 4 }
				],
				3
			)
		).toEqual([0, 1]);
	});

	it('meer dan het maximum: geen draad', () => {
		const spans = [0, 1, 2, 3].map((i) => ({ top: i, bottom: 10 }));
		expect(assignLanes(spans, 3).filter((l) => l === null)).toHaveLength(1);
	});

	it('nooit twee overlappende draden in dezelfde baan, en nooit buiten het maximum', () => {
		const span = fc
			.tuple(fc.nat(60), fc.nat(20))
			.map(([top, length]) => ({ top, bottom: top + length }));
		fc.assert(
			fc.property(
				fc.array(span, { maxLength: 30 }),
				fc.integer({ min: 1, max: 4 }),
				(spans, max) => {
					const lanes = assignLanes(spans, max);
					spans.forEach((a, i) => {
						const la = lanes[i];
						if (la === null) return;
						expect(la).toBeLessThan(max);
						spans.forEach((b, j) => {
							if (i !== j && lanes[j] === la)
								expect(a.bottom < b.top || a.top > b.bottom).toBe(true);
						});
					});
				}
			)
		);
	});

	it('layout: banen uit de volgorde van de lijst', () => {
		const rows = [
			{ id: 'p', refund: info({ targets: [target('x', { transactionId: 'u' })] }) },
			{ id: 'a' },
			{ id: 'u' }
		];
		expect(threadLayout(rows)).toEqual({
			groups: [{ source: 'u', payments: ['p'], lane: 0 }],
			lanes: 1
		});
		expect(threadLayout([{ id: 'a' }])).toEqual({ groups: [], lanes: 0 });
	});
});
