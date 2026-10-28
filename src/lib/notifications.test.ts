import { describe, expect, it } from 'vitest';
import {
	DEFAULT_SETTINGS,
	LOCKSCREEN_SETTING,
	NOTIFICATION_KINDS,
	NOTIFICATION_KIND_KEYS,
	isSwitchableSetting,
	kindEnabled,
	notificationBody
} from './notifications.ts';

describe('soorten meldingen', () => {
	it('heeft alle soorten uit de spec, met telemetrie en beveiliging', () => {
		expect(NOTIFICATION_KIND_KEYS.sort()).toEqual(
			[
				'backup',
				'beveiliging',
				'bon',
				'budget_90',
				'fout',
				'garantie',
				'maand',
				'schijf',
				'terugbetaling',
				'tikkie',
				'vaste_last'
			].sort()
		);
	});

	it('titels bevatten geen cijfers (geen bedragen op het vergrendelscherm)', () => {
		for (const kind of NOTIFICATION_KIND_KEYS) {
			expect(NOTIFICATION_KINDS[kind].title).not.toMatch(/\d/);
		}
	});
});

describe('schakelaars', () => {
	it('standaard alles aan, behalve bedragen en namen op het vergrendelscherm', () => {
		for (const kind of NOTIFICATION_KIND_KEYS) expect(DEFAULT_SETTINGS[kind]).toBe(true);
		expect(DEFAULT_SETTINGS[LOCKSCREEN_SETTING]).toBe(false);
	});

	it('een uitgezette soort gaat niet uit', () => {
		const settings = { ...DEFAULT_SETTINGS, bon: false };
		expect(kindEnabled(settings, 'bon')).toBe(false);
		expect(kindEnabled(settings, 'vaste_last')).toBe(true);
	});

	it('beveiliging gaat altijd uit, ook als de instelling uit staat', () => {
		expect(kindEnabled({ ...DEFAULT_SETTINGS, beveiliging: false }, 'beveiliging')).toBe(true);
	});

	it('alleen bestaande, schakelbare instellingen zijn te wijzigen', () => {
		expect(isSwitchableSetting('vaste_last')).toBe(true);
		expect(isSwitchableSetting('fout')).toBe(true);
		expect(isSwitchableSetting(LOCKSCREEN_SETTING)).toBe(true);
		expect(isSwitchableSetting('beveiliging')).toBe(false);
		expect(isSwitchableSetting('bestaat_niet')).toBe(false);
		expect(isSwitchableSetting('__proto__')).toBe(false);
		expect(isSwitchableSetting('toString')).toBe(false);
	});
});

describe('tekst op het vergrendelscherm', () => {
	const message = { text: 'Een vaste last wacht', detail: 'Vattenfall: € 84,20 wacht' };

	it('standaard zonder bedragen of namen', () => {
		expect(notificationBody(DEFAULT_SETTINGS, message)).toBe('Een vaste last wacht');
	});

	it('met bedragen en namen als dat aan staat', () => {
		const settings = { ...DEFAULT_SETTINGS, [LOCKSCREEN_SETTING]: true };
		expect(notificationBody(settings, message)).toBe('Vattenfall: € 84,20 wacht');
	});

	it('zonder detail altijd de gewone tekst', () => {
		const settings = { ...DEFAULT_SETTINGS, [LOCKSCREEN_SETTING]: true };
		expect(notificationBody(settings, { text: 'Backup te oud' })).toBe('Backup te oud');
	});
});
