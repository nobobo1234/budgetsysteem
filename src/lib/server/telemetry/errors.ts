import { lt } from 'drizzle-orm';
import { sha256 } from '../auth/crypto.ts';
import { log } from '../log.ts';
import type { TelemetryDB } from './db.ts';
import { errors, starts } from './schema.ts';

export const RETENTION_DAYS = 90;
const MAX_FRAMES = 10;
const MAX_FRAME_LENGTH = 300;

export interface ErrorInfo {
	name: string;
	/** Alleen stackframes (`at ...`), nooit de foutmelding: die kan data bevatten. */
	frames: string[];
}

/**
 * Soort fout en stackframes, zonder de foutmelding. De eerste regel van `stack` is
 * `Naam: melding`, en een melding kan over meerdere regels lopen; daarom alleen regels die
 * er als stackframe uitzien.
 */
export function describeError(error: unknown): ErrorInfo {
	const e = error instanceof Error ? error : undefined;
	const name = /^[A-Za-z_$][\w$]{0,63}$/.test(e?.name ?? '') ? e!.name : 'Onbekend';
	const frames = (e?.stack ?? '')
		.split('\n')
		.filter((line) => /^\s+at /.test(line))
		.slice(0, MAX_FRAMES)
		.map((line) => line.trim().slice(0, MAX_FRAME_LENGTH));
	return { name, frames };
}

/** Dezelfde fout op dezelfde plek geeft dezelfde vingerafdruk. */
export function fingerprint(info: ErrorInfo, route: string | null): string {
	return sha256(`${info.name}|${route ?? ''}|${info.frames[0] ?? ''}`).slice(0, 16);
}

/**
 * Schrijft een fout naar de `errors`-tabel. Telemetrie mag de foutafhandeling zelf nooit
 * breken: lukt het schrijven niet, dan alleen een logregel.
 */
export function recordError(
	db: () => TelemetryDB,
	entry: {
		id: string;
		source: 'verzoek' | 'proces';
		error: unknown;
		route?: string | null;
		method?: string | null;
	}
): void {
	try {
		const info = describeError(entry.error);
		db()
			.insert(errors)
			.values({
				id: entry.id,
				source: entry.source,
				name: info.name,
				route: entry.route ?? null,
				method: entry.method ?? null,
				fingerprint: fingerprint(info, entry.route ?? null),
				frames: info.frames.join('\n') || null
			})
			.run();
	} catch (e) {
		log.warn({ err: describeError(e) }, 'fout niet in telemetrie geschreven');
	}
}

/** Elke start van de app, met de versie van de build. */
export function recordStart(db: TelemetryDB, version: string): void {
	db.insert(starts).values({ version }).run();
}

/** Bewaartermijn van 90 dagen. */
export function pruneTelemetry(db: TelemetryDB, now = new Date()): void {
	const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86_400_000).toISOString();
	db.delete(errors).where(lt(errors.at, cutoff)).run();
	db.delete(starts).where(lt(starts.at, cutoff)).run();
}
