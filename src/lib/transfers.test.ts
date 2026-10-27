import { describe, expect, it } from 'vitest';
import { pairTransfers, type TransferLeg } from './transfers.ts';

const leg = (id: string, amountCents: number, date: string, accountId: string): TransferLeg => ({
	id,
	amountCents,
	date,
	accountId
});

describe('pairTransfers', () => {
	it('koppelt een afschrijving aan de bijschrijving op een andere rekening', () => {
		const pairs = pairTransfers([
			leg('uit', -5000, '2026-10-03', 'sns'),
			leg('in', 5000, '2026-10-03', 'revolut')
		]);
		expect([...pairs]).toEqual([['uit', 'in']]);
	});

	it('koppelt niet op dezelfde rekening, bij een ander bedrag of te ver uit elkaar', () => {
		expect(
			pairTransfers([
				leg('a', -5000, '2026-10-03', 'sns'),
				leg('b', 5000, '2026-10-03', 'sns'),
				leg('c', 4999, '2026-10-03', 'revolut'),
				leg('d', 5000, '2026-10-07', 'revolut')
			]).size
		).toBe(0);
	});

	it('staat een weekend tussen de twee boekingen toe, ook over de maandgrens', () => {
		const pairs = pairTransfers([
			leg('uit', -2500, '2026-10-30', 'sns'),
			leg('in', 2500, '2026-11-02', 'revolut')
		]);
		expect(pairs.get('uit')).toBe('in');
	});

	it('kiest de dichtstbijzijnde datum en gebruikt elke boeking één keer', () => {
		const pairs = pairTransfers([
			leg('uit1', -5000, '2026-10-01', 'sns'),
			leg('uit2', -5000, '2026-10-03', 'sns'),
			leg('in1', 5000, '2026-10-01', 'revolut'),
			leg('in2', 5000, '2026-10-03', 'revolut'),
			leg('in3', 5000, '2026-10-04', 'revolut')
		]);
		expect(Object.fromEntries(pairs)).toEqual({ uit1: 'in1', uit2: 'in2' });
	});

	it('laat een tweede gelijke afschrijving zonder tegenhanger los', () => {
		const pairs = pairTransfers([
			leg('uit1', -1000, '2026-10-05', 'sns'),
			leg('uit2', -1000, '2026-10-05', 'sns'),
			leg('in', 1000, '2026-10-05', 'revolut')
		]);
		expect(pairs.size).toBe(1);
		expect(pairs.get('uit1')).toBe('in');
	});

	it('werkt in beide richtingen tussen rekeningen', () => {
		const pairs = pairTransfers([
			leg('terug', -3000, '2026-10-10', 'revolut'),
			leg('sns', 3000, '2026-10-11', 'sns')
		]);
		expect(pairs.get('terug')).toBe('sns');
	});
});
