import { describe, expect, it } from 'vitest';
import { describeError, fingerprint } from './errors.ts';

describe('describeError', () => {
	it('neemt soort en stackframes over, nooit de foutmelding', () => {
		const e = new TypeError('kan NL91ABNA0417164300 met 12,50 niet lezen');
		const info = describeError(e);
		expect(info.name).toBe('TypeError');
		expect(info.frames.length).toBeGreaterThan(0);
		expect(info.frames.every((f) => f.startsWith('at '))).toBe(true);
		expect(JSON.stringify(info)).not.toContain('NL91ABNA0417164300');
		expect(JSON.stringify(info)).not.toContain('12,50');
	});

	it('laat ook een melding over meerdere regels weg', () => {
		const e = new Error('regel een\n    at NL91ABNA0417164300\nomschrijving: Albert Heijn');
		e.stack = `Error: regel een\nomschrijving: Albert Heijn\n    at f (file:///app/x.js:1:2)`;
		const info = describeError(e);
		expect(info.frames).toEqual(['at f (file:///app/x.js:1:2)']);
		expect(JSON.stringify(info)).not.toContain('Albert Heijn');
	});

	it('accepteert alleen een nette naam als soort fout', () => {
		const e = new Error('x');
		e.name = 'NL91ABNA0417164300 is geen naam';
		expect(describeError(e).name).toBe('Onbekend');
		expect(describeError('een string').name).toBe('Onbekend');
		expect(describeError(undefined)).toEqual({ name: 'Onbekend', frames: [] });
	});

	it('begrenst het aantal en de lengte van de frames', () => {
		const e = new Error('x');
		e.stack = ['Error: x', ...Array.from({ length: 50 }, () => `    at ${'f'.repeat(1000)}`)].join(
			'\n'
		);
		const info = describeError(e);
		expect(info.frames).toHaveLength(10);
		expect(info.frames.every((f) => f.length <= 300)).toBe(true);
	});
});

describe('fingerprint', () => {
	const info = { name: 'TypeError', frames: ['at f (x.js:1:2)', 'at g (y.js:3:4)'] };

	it('is gelijk voor dezelfde fout op dezelfde plek', () => {
		expect(fingerprint(info, '/(app)')).toBe(fingerprint({ ...info }, '/(app)'));
		expect(fingerprint(info, '/(app)')).toMatch(/^[0-9a-f]{16}$/);
	});

	it('verschilt per soort, route en bovenste frame', () => {
		const base = fingerprint(info, '/(app)');
		expect(fingerprint({ ...info, name: 'RangeError' }, '/(app)')).not.toBe(base);
		expect(fingerprint(info, '/(app)/budget')).not.toBe(base);
		expect(fingerprint({ ...info, frames: ['at h (z.js:1:1)'] }, '/(app)')).not.toBe(base);
		expect(fingerprint(info, null)).not.toBe(base);
	});
});
