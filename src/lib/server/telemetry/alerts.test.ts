import { describe, expect, it } from 'vitest';
import {
	DISK_ALERT_PERCENT,
	DISK_CLEAR_PERCENT,
	LITESTREAM_MAX_LAG_MS,
	RESTIC_MAX_AGE_MS,
	evaluateAlerts,
	type AlertInput
} from './alerts.ts';

const NOW = Date.UTC(2026, 9, 24, 12);
const HOUR = 3_600_000;

const healthy: AlertInput = {
	now: NOW,
	production: true,
	resticMtime: NOW - 2 * HOUR,
	litestreamMtime: NOW - 10_000,
	databaseMtime: NOW - 20_000,
	diskUsedPercent: 40
};

describe('evaluateAlerts', () => {
	it('alles in orde: alles opgelost', () => {
		expect(evaluateAlerts(healthy)).toEqual({ restic: false, litestream: false, disk: false });
	});

	it('restic ouder dan 26 uur', () => {
		expect(evaluateAlerts({ ...healthy, resticMtime: NOW - RESTIC_MAX_AGE_MS }).restic).toBe(false);
		expect(evaluateAlerts({ ...healthy, resticMtime: NOW - RESTIC_MAX_AGE_MS - 1 }).restic).toBe(
			true
		);
	});

	it('nooit een backup: in productie melden, lokaal niet', () => {
		const none = { ...healthy, resticMtime: null, litestreamMtime: null };
		expect(evaluateAlerts(none)).toMatchObject({ restic: true, litestream: true });
		expect(evaluateAlerts({ ...none, production: false })).toMatchObject({
			restic: false,
			litestream: false
		});
	});

	it('Litestream: achterstand op de database telt, niet de leeftijd', () => {
		// Rustige dag: niets gewijzigd, Litestream twee dagen stil, geen probleem
		const quiet = { ...healthy, litestreamMtime: NOW - 48 * HOUR, databaseMtime: NOW - 49 * HOUR };
		expect(evaluateAlerts(quiet).litestream).toBe(false);
		// Database gewijzigd, Litestream loopt meer dan een uur achter
		const behind = {
			...healthy,
			litestreamMtime: NOW - LITESTREAM_MAX_LAG_MS - 2,
			databaseMtime: NOW - 1
		};
		expect(evaluateAlerts(behind).litestream).toBe(true);
		expect(evaluateAlerts({ ...healthy, databaseMtime: null }).litestream).toBeNull();
	});

	it('schijf: melden boven 80%, opgelost onder 78%, daartussen niets veranderen', () => {
		expect(evaluateAlerts({ ...healthy, diskUsedPercent: DISK_ALERT_PERCENT + 0.1 }).disk).toBe(
			true
		);
		expect(evaluateAlerts({ ...healthy, diskUsedPercent: DISK_ALERT_PERCENT }).disk).toBeNull();
		expect(evaluateAlerts({ ...healthy, diskUsedPercent: DISK_CLEAR_PERCENT }).disk).toBeNull();
		expect(evaluateAlerts({ ...healthy, diskUsedPercent: DISK_CLEAR_PERCENT - 0.1 }).disk).toBe(
			false
		);
		expect(evaluateAlerts({ ...healthy, diskUsedPercent: null }).disk).toBeNull();
	});
});
