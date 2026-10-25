import { describe, expect, it } from 'vitest';
import { attention } from './server/telemetry/status.ts';
import type { Health } from './server/telemetry/health.ts';
import {
	formatAge,
	formatBytes,
	formatCallDuration,
	formatDuration,
	formatPercent,
	formatTokens,
	formatUsd,
	formatVital
} from './status.ts';

describe('formatDuration', () => {
	it('kiest de grootste eenheid die past', () => {
		expect(formatDuration(0)).toBe('0 s');
		expect(formatDuration(59.4)).toBe('59 s');
		expect(formatDuration(60)).toBe('1 min');
		expect(formatDuration(3599)).toBe('59 min');
		expect(formatDuration(3600)).toBe('1 u');
		expect(formatDuration(3 * 3600 + 5 * 60)).toBe('3 u 5 min');
		expect(formatDuration(86_400)).toBe('1 d');
		expect(formatDuration(2 * 86_400 + 4 * 3600 + 59)).toBe('2 d 4 u');
	});

	it('nooit negatief', () => {
		expect(formatDuration(-5)).toBe('0 s');
	});
});

describe('formatAge', () => {
	it('zegt het als er niets is', () => {
		expect(formatAge(null)).toBe('Niet gevonden');
		expect(formatAge(720)).toBe('12 min geleden');
	});
});

describe('formatBytes en formatPercent', () => {
	it('in Nederlandse notatie', () => {
		expect(formatBytes(512)).toBe('512 B');
		expect(formatBytes(12_345_678_901)).toBe('12,3 GB');
		expect(formatPercent(43.25)).toBe('43,3%');
	});
});

describe('formatVital', () => {
	it('LCP in seconden, INP in milliseconden, CLS als score', () => {
		expect(formatVital('LCP', 1840)).toBe('1,8 s');
		expect(formatVital('INP', 96.4)).toBe('96 ms');
		expect(formatVital('TTFB', 1234)).toBe('1.234 ms');
		expect(formatVital('CLS', 0.0234)).toBe('0,02');
	});
});

describe('attention', () => {
	const healthy = (): Health => ({
		database: true,
		uptimeSeconds: 3600,
		backups: { litestreamAgeSeconds: 30, resticAgeSeconds: 3 * 3600 },
		disk: { usedPercent: 40, freeBytes: 10e9 },
		starts: { last24h: 0, last7d: 1, restarts7d: 0 },
		errors: { last24h: 0, kinds24h: 0, last7d: 2 }
	});

	it('niets als alles werkt', () => {
		expect(attention(healthy())).toEqual([]);
	});

	it('database, backups, schijf, herstarts en fouten', () => {
		const h = healthy();
		h.database = false;
		h.backups = { litestreamAgeSeconds: null, resticAgeSeconds: 26 * 3600 + 1 };
		h.disk = { usedPercent: 80.1, freeBytes: 1e9 };
		h.starts.restarts7d = 2;
		h.errors = { last24h: 1, kinds24h: 1, last7d: 1 };
		expect(attention(h)).toEqual([
			'De database is niet bereikbaar.',
			'Geen Litestream-replicatie gevonden.',
			'De laatste restic-backup is ouder dan een dag.',
			'De schijf is voor meer dan 80% vol.',
			'De app is deze week 2 keer herstart.',
			'Eén fout in de laatste 24 uur.'
		]);
	});

	it('precies 80% schijf en een restic-backup van 26 uur zijn nog goed', () => {
		const h = healthy();
		h.disk = { usedPercent: 80, freeBytes: 1e9 };
		h.backups.resticAgeSeconds = 26 * 3600;
		expect(attention(h)).toEqual([]);
	});

	it('een oude Litestream-sync alleen is geen probleem: hij schrijft alleen bij wijzigingen', () => {
		const h = healthy();
		h.backups.litestreamAgeSeconds = 3 * 86_400;
		expect(attention(h)).toEqual([]);
	});

	it('onbekende schijfruimte', () => {
		expect(attention({ ...healthy(), disk: null })).toEqual(['Schijfruimte onbekend.']);
	});
});

describe('bonnen lezen', () => {
	it('toont kosten, duur en tokens in gewone taal', () => {
		expect(formatUsd(0)).toBe('$ 0,00');
		expect(formatUsd(400_000_000)).toBe('$ 0,40');
		expect(formatUsd(1_234_000)).toBe('$ 0,001');
		expect(formatUsd(12_345_000_000)).toBe('$ 12,35');
		expect(formatCallDuration(4210)).toBe('4,2 s');
		expect(formatTokens(950)).toBe('950');
		expect(formatTokens(12_340)).toBe('12,3 k');
		expect(formatTokens(1_250_000)).toBe('1,3 mln');
	});
});
