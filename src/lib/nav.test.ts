import { describe, expect, it } from 'vitest';
import { morphPlan, morphSelector } from './morph.ts';
import { activeTab, backTarget } from './nav.ts';

describe('terugknop', () => {
	it('gaat terug naar een bekende ouder, met haar zoekopdracht', () => {
		expect(backTarget('/transacties?q=ah', ['/transacties', '/'])).toEqual({
			href: '/transacties?q=ah',
			label: 'Transacties'
		});
		expect(backTarget('/', ['/instellingen', '/'])).toEqual({ href: '/', label: 'Overzicht' });
	});

	it('valt terug op de eerste ouder, ook als je van een andere subpagina komt', () => {
		// Personen en Te krijgen linken naar elkaar: geen lus
		expect(backTarget('/personen', ['/instellingen', '/'])).toEqual({
			href: '/instellingen',
			label: 'Meer'
		});
		expect(backTarget(null, ['/budget'])).toEqual({ href: '/budget', label: 'Budget' });
	});
});

describe('actieve tab', () => {
	it('een subpagina laat de tab van haar ouder actief', () => {
		expect(activeTab('/')).toBe('/');
		expect(activeTab('/vaste-lasten/0b7f3c52')).toBe('/budget');
		expect(activeTab('/regels')).toBe('/budget');
		expect(activeTab('/saldocheck')).toBe('/instellingen');
		expect(activeTab('/bonnen')).toBe('/instellingen');
		expect(activeTab('/bonnen/0b7f3c52-6a2e-4c8e-9a43-1f2d3e4c5b6a')).toBe('/instellingen');
		expect(activeTab('/instellingen/beveiliging')).toBe('/instellingen');
		expect(activeTab('/transacties/0b7f3c52')).toBe('/transacties');
		expect(activeTab('/te-controleren')).toBe('/');
		expect(activeTab('/import')).toBe('/instellingen');
		expect(activeTab('/analyses')).toBe('/analyses');
		expect(activeTab('/analyses/trend')).toBe('/analyses');
		// Geen voorvoegsel-fout: /te-krijgen is niet /te
		expect(activeTab('/bestaat-niet')).toBe('');
	});
});

describe('meeschuiven tussen pagina’s', () => {
	it('tegel op Meer naar de titel van zijn pagina, en terug', () => {
		const forward = morphPlan('/instellingen', '/saldocheck');
		expect(forward).toEqual({ source: '/instellingen', target: '/saldocheck', parts: ['titel'] });
		expect(morphPlan('/saldocheck', '/instellingen')).toEqual(forward);
		expect(morphSelector(forward!, '/instellingen', 'titel')).toBe(
			'[data-morph-to="/saldocheck"][data-morph-part="titel"]'
		);
		expect(morphSelector(forward!, '/saldocheck', 'titel')).toBe('[data-morph-head="titel"]');
	});

	it('het bedrag te krijgen schuift van het startscherm naar zijn pagina', () => {
		expect(morphPlan('/', '/te-krijgen')?.parts).toEqual(['bedrag']);
		expect(morphPlan('/te-controleren', '/')?.parts).toEqual(['bedrag']);
		expect(morphPlan('/budget', '/te-krijgen')).toBeNull();
	});

	it('een vaste last schuift uit Te bevestigen of de lijst naar zijn detailpagina', () => {
		const detail = '/vaste-lasten/0b7f3c52-6a2e-4c8e-9a43-1f2d3e4c5b6a';
		const plan = morphPlan('/', detail);
		expect(plan).toEqual({ source: '/', target: detail, parts: ['titel'] });
		expect(morphSelector(plan!, '/', 'titel')).toBe(
			`[data-morph-to="${detail}"][data-morph-part="titel"]`
		);
		expect(morphPlan(detail, '/vaste-lasten')?.source).toBe('/vaste-lasten');
		expect(morphPlan('/budget', detail)).toBeNull();
		expect(morphPlan('/', '/vaste-lasten/niet-een-id')).toBeNull();
	});
});
