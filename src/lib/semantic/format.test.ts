import { describe, expect, it } from 'vitest';
import { modelTextFailure } from './format.ts';

// Tekst van het model in beeld (spec: Vraagveld, Geen terugweg naar het model): geen cijfers,
// opmaak, links of domeinen. Bij twijfel weigeren.

describe('gewone tekst van het model', () => {
	it('gewone zinnen mogen', () => {
		expect(modelTextFailure('uit eten = de categorie Uit eten en bezorgen')).toBeNull();
		expect(modelTextFailure('Bedoel je boodschappen of uit eten?')).toBeNull();
		expect(modelTextFailure("Zonder café's van vorig jaar")).toBeNull();
	});

	it('geen cijfers: geen enkel getal in beeld komt uit het model', () => {
		expect(modelTextFailure('ongeveer 120 euro')).toBe('cijfer');
		expect(modelTextFailure('sinds 2025')).toBe('cijfer');
		expect(modelTextFailure('de helft, ½')).toBe('cijfer');
	});

	it('geen links, e-mailadressen, domeinen of opmaak', () => {
		expect(modelTextFailure('kijk op example.com')).toBe('domein');
		expect(modelTextFailure('mail naar iemand@example')).toBe('domein');
		expect(modelTextFailure('ga naar www.voorbeeld')).toBe('domein');
		expect(modelTextFailure('<b>vet</b>')).toBe('teken');
		expect(modelTextFailure('[klik](hier)')).toBe('teken');
		expect(modelTextFailure('twee\nregels')).toBe('teken');
	});

	it('leeg of te lang', () => {
		expect(modelTextFailure('   ')).toBe('leeg');
		expect(modelTextFailure('a'.repeat(201))).toBe('te_lang');
		expect(modelTextFailure('a'.repeat(61), 60)).toBe('te_lang');
	});
});
