import { config } from '../config.ts';
import { shortcutStatus, type ShortcutStatus } from './shortcut.ts';
import { SIGNED_SHORTCUT } from './shortcut-signed.ts';

// De ondertekende opdracht zoals deze installatie hem aanbiedt (docs/ios-opdracht.md).

export const shortcutBytes = Buffer.from(SIGNED_SHORTCUT.base64, 'base64');

/** Status van de meegeleverde opdracht voor deze app (ORIGIN) en nu. */
export function currentShortcutStatus(now = new Date()): ShortcutStatus {
	return shortcutStatus(SIGNED_SHORTCUT, config().origin, now);
}

/** Te downloaden: juiste host en het certificaat nog geldig. */
export const isDownloadable = (status: ShortcutStatus) =>
	status.state === 'ok' || status.state === 'expiring';

/** Vraagt om actie: binnenkort of al verlopen. Een andere host is een keuze, geen herinnering. */
export const needsRenewal = (status: ShortcutStatus) =>
	status.state === 'expiring' || status.state === 'expired';
