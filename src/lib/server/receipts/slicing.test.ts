import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	fitSize,
	fitsModel,
	MAX_LONG_EDGE,
	MAX_SLICES,
	MAX_VISUAL_TOKENS,
	planSlices,
	SLICE_OVERLAP,
	SLICE_SHORT_EDGE,
	visualTokens
} from './slicing.ts';

describe('visualTokens', () => {
	it('telt blokken van 28×28 px, naar boven afgerond (voorbeelden uit de vision-docs)', () => {
		expect(visualTokens(200, 200)).toBe(64);
		expect(visualTokens(1000, 1000)).toBe(1296);
		expect(visualTokens(1920, 1080)).toBe(2691);
		expect(visualTokens(2576, 1449)).toBe(MAX_VISUAL_TOKENS);
	});
});

describe('fitSize', () => {
	it('vergroot nooit', () => {
		expect(fitSize({ width: 800, height: 600 })).toEqual({ width: 800, height: 600 });
	});

	it('verkleint 4K tot precies de grens uit de docs', () => {
		expect(fitSize({ width: 3840, height: 2160 })).toEqual({ width: 2576, height: 1449 });
	});

	it('houdt een telefoonfoto (4:3) binnen de tokengrens, niet alleen binnen 2576 px', () => {
		const out = fitSize({ width: 3024, height: 4032 });
		expect(out.height).toBeLessThan(MAX_LONG_EDGE);
		expect(fitsModel(out.width, out.height)).toBe(true);
		// Zo groot mogelijk: één stap groter past niet meer
		expect(visualTokens(out.width + 28, out.height + 28)).toBeGreaterThan(MAX_VISUAL_TOKENS);
	});

	it('verkleint tot 1600 px aan de lange kant voor die variant', () => {
		expect(fitSize({ width: 3024, height: 4032 }, 1600)).toEqual({ width: 1200, height: 1600 });
	});

	it('weigert onzinnige formaten', () => {
		expect(() => fitSize({ width: 0, height: 10 })).toThrow(RangeError);
		expect(() => fitSize({ width: 1.5, height: 10 })).toThrow(RangeError);
	});
});

describe('planSlices', () => {
	it('snijdt een gewone bon niet', () => {
		const plan = planSlices({ width: 1000, height: 3000 });
		expect(plan.pieces).toEqual([{ left: 0, top: 0, width: 859, height: 2576 }]);
	});

	it('snijdt een lange bon in overlappende stukken op volle breedte', () => {
		const plan = planSlices({ width: 900, height: 4500 });
		expect(plan.scaled).toEqual({ width: 900, height: 4500 });
		expect(plan.pieces).toEqual([
			{ left: 0, top: 0, width: 900, height: 2576 },
			{ left: 0, top: 1924, width: 900, height: 2576 }
		]);
	});

	it('maakt een brede scan eerst smaller', () => {
		const plan = planSlices({ width: 2400, height: 12000 });
		expect(plan.scaled.width).toBe(SLICE_SHORT_EDGE);
		expect(plan.pieces.length).toBeGreaterThan(1);
	});

	it('wordt smaller in plaats van meer dan het maximum aantal stukken te maken', () => {
		const plan = planSlices({ width: 1000, height: 40000 });
		expect(plan.pieces).toHaveLength(MAX_SLICES);
		expect(plan.scaled.width).toBeLessThan(1000);
	});

	it('snijdt een liggende lange strook over de breedte', () => {
		const plan = planSlices({ width: 5000, height: 1000 });
		expect(plan.pieces.length).toBeGreaterThan(1);
		for (const p of plan.pieces) expect(p.top).toBe(0);
	});

	it('houdt zich voor elk formaat aan de grenzen, dekt de hele bon en overlapt genoeg', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 6000 }),
				fc.integer({ min: 1, max: 60000 }),
				fc.boolean(),
				(a, b, flip) => {
					const size = flip ? { width: b, height: a } : { width: a, height: b };
					const plan = planSlices(size);
					const vertical = plan.scaled.height >= plan.scaled.width;
					const long = vertical ? plan.scaled.height : plan.scaled.width;

					expect(plan.pieces.length).toBeGreaterThanOrEqual(1);
					expect(plan.pieces.length).toBeLessThanOrEqual(MAX_SLICES);
					// Nooit vergroten
					expect(plan.scaled.width).toBeLessThanOrEqual(size.width);
					expect(plan.scaled.height).toBeLessThanOrEqual(size.height);

					let covered = 0;
					for (const [i, p] of plan.pieces.entries()) {
						expect(fitsModel(p.width, p.height)).toBe(true);
						expect(p.left + p.width).toBeLessThanOrEqual(plan.scaled.width);
						expect(p.top + p.height).toBeLessThanOrEqual(plan.scaled.height);
						const start = vertical ? p.top : p.left;
						const length = vertical ? p.height : p.width;
						if (i > 0) {
							// Overlap met het vorige stuk: minstens de afgesproken marge
							expect(covered - start).toBeGreaterThanOrEqual(
								Math.round(length * SLICE_OVERLAP) - 1
							);
						} else {
							expect(start).toBe(0);
						}
						covered = start + length;
					}
					expect(covered).toBe(long);
				}
			),
			{ numRuns: 500 }
		);
	});
});
