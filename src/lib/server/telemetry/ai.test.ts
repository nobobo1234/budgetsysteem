import { describe, expect, it } from 'vitest';
import { medianOf, summarizeAiCalls } from './ai.ts';

// Telemetrie per samenvatting: tellingen en tijden, geen inhoud.

const row = (outcome: Parameters<typeof summarizeAiCalls>[0][number]['outcome'], extra = {}) => ({
	outcome,
	inputTokens: 800,
	outputTokens: 100,
	costNanoUsd: 130_000,
	durationMs: 1_000,
	wrong: 0,
	...extra
});

describe('samenvattingen op de statuspagina', () => {
	it('telt uitkomsten, vaste tekst, kosten en klopt niet', () => {
		const s = summarizeAiCalls(
			[
				row('geschreven', { wrong: 2, durationMs: 900 }),
				row('geschreven', { durationMs: 1_500 }),
				row('controle', { durationMs: 1_100 }),
				row('fout', { inputTokens: 0, outputTokens: 0, costNanoUsd: 0, durationMs: 30_000 })
			],
			30
		);
		expect(s).toMatchObject({
			calls: 4,
			fallback: 2,
			inputTokens: 2_400,
			outputTokens: 300,
			costNanoUsd: 390_000,
			medianMs: 1_300,
			wrongCalls: 1,
			wrongTaps: 2
		});
		expect(s.outcomes).toMatchObject({ geschreven: 2, controle: 1, fout: 1, weigering: 0 });
	});

	it('mediaan zonder waarden is leeg', () => {
		expect(medianOf([])).toBeNull();
		expect(medianOf([5, 1, 3])).toBe(3);
	});
});
