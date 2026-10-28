import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.ts';
import { log } from '../log.ts';
import {
	MAX_SIGNED_FILE_BYTES,
	parseSignedShortcut,
	shortcutStatus,
	type ShortcutStatus
} from './shortcut.ts';

// De ondertekende opdracht zoals deze installatie hem aanbiedt (docs/ios-opdracht.md). Hij
// staat niet in de repo maar in het datavolume, naast de database: elke installatie ondertekent
// voor haar eigen domein. Geen bestand is gewoon "niet geïnstalleerd"; een bestand dat niet
// klopt, telt als niet aanwezig en komt één keer (zonder inhoud) in de log.
//
// Bij elke aanvraag een stat: verandert het bestand (tijd, grootte of inode), dan opnieuw
// inlezen (ook bij een andere ctime). Zo werkt een nieuw bestand meteen, zonder herstart.

type Loaded =
	| { state: 'missing' | 'invalid' }
	| { state: 'loaded'; url: string; validUntil: string; bytes: Buffer<ArrayBuffer> };

let cache: { key: string; loaded: Loaded } | undefined;

/** Waar de app het ondertekende bestand zoekt. */
export function signedShortcutPath(): string {
	const c = config();
	return c.SHORTCUT_PATH ?? join(dirname(c.DATABASE_PATH), 'shortcut-signed.json');
}

function load(path: string): Loaded {
	let fd: number;
	try {
		fd = openSync(path, 'r');
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code ?? 'onbekend';
		const key = `${path}\0${code}`;
		const loaded = { state: code === 'ENOENT' ? 'missing' : 'invalid' } as const;
		// Bijvoorbeeld geen leesrechten voor de gebruiker van de app; één keer loggen, niet bij
		// elke pagina
		if (loaded.state === 'invalid' && cache?.key !== key) {
			log.warn({ event: 'shortcut_unreadable', code }, 'ondertekende opdracht niet te lezen');
		}
		cache = { key, loaded };
		return loaded;
	}
	try {
		const stat = fstatSync(fd);
		const key = `${path}\0${stat.ino}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}`;
		if (cache?.key === key) return cache.loaded;
		const loaded = parse(fd, stat);
		cache = { key, loaded };
		return loaded;
	} finally {
		closeSync(fd);
	}
}

function parse(fd: number, stat: { isFile(): boolean; size: number }): Loaded {
	const result =
		!stat.isFile() || stat.size > MAX_SIGNED_FILE_BYTES
			? ({ ok: false, reason: 'size' } as const)
			: parseSignedShortcut(readFileSync(fd, 'utf8'));
	if (!result.ok) {
		log.warn(
			{ event: 'shortcut_invalid', reason: result.reason },
			'ondertekende opdracht geweigerd'
		);
		return { state: 'invalid' };
	}
	const { url, validUntil } = result.shortcut;
	return { state: 'loaded', url, validUntil, bytes: result.bytes };
}

/** Status van de geïnstalleerde opdracht voor deze app (ORIGIN) en nu, met de bytes als hij er is. */
export function currentShortcut(now = new Date()): {
	status: ShortcutStatus;
	bytes: Buffer<ArrayBuffer> | null;
} {
	const origin = new URL(config().origin).origin;
	const loaded = load(signedShortcutPath());
	if (loaded.state !== 'loaded') return { status: { state: loaded.state, origin }, bytes: null };
	return { status: shortcutStatus(loaded, config().origin, now), bytes: loaded.bytes };
}

/** Status van de geïnstalleerde opdracht voor deze app (ORIGIN) en nu. */
export function currentShortcutStatus(now = new Date()): ShortcutStatus {
	return currentShortcut(now).status;
}

/** Te downloaden: juiste host en het certificaat nog geldig. */
export const isDownloadable = (status: ShortcutStatus) =>
	status.state === 'ok' || status.state === 'expiring';

/**
 * Vraagt om actie: binnenkort of al verlopen. Een andere host of geen bestand is een keuze (of
 * nog niet ingesteld), geen herinnering.
 */
export const needsRenewal = (status: ShortcutStatus) =>
	status.state === 'expiring' || status.state === 'expired';
