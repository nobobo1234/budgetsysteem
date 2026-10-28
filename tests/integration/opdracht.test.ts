// TER REVIEW (Noah): de download van de ondertekende opdracht (upload/ingest), nu ingelezen uit
// het datavolume in plaats van uit de repo.
import { eq } from 'drizzle-orm';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { newRecoveryCode } from '../../src/lib/server/auth/recovery.ts';
import { createSession, type Session } from '../../src/lib/server/auth/session.ts';
import { resetConfig } from '../../src/lib/server/config.ts';
import type { DB } from '../../src/lib/server/db/index.ts';
import { sessions } from '../../src/lib/server/db/schema.ts';
import { meerNeedsAttention, meerTiles } from '../../src/lib/server/meer.ts';
import { log } from '../../src/lib/server/log.ts';
import {
	MAX_SIGNED_FILE_BYTES,
	shortcutSourceHash
} from '../../src/lib/server/receipts/shortcut.ts';
import {
	currentShortcutStatus,
	signedShortcutPath
} from '../../src/lib/server/receipts/shortcut-download.ts';
import { GET } from '../../src/routes/(app)/instellingen/apparaten/opdracht/+server.ts';
import { FAKE_SHORTCUT_BYTES, fakeShortcutJson } from '../fixtures/shortcut.ts';
import { fakeEvent, tempDatabase, tempTelemetry } from './helpers.ts';

// De testomgeving heeft geen backups of schijfinfo; die punten van de statuspagina tellen hier
// niet mee, zodat de stip op Meer alleen van de opdracht afhangt
vi.mock('../../src/lib/server/telemetry/status.ts', () => ({ attention: () => [] }));

let db: DB;
let cleanup: () => void;
let cleanupTelemetry: () => void;
let session: Session;
let dir: string;
const previous = {
	ORIGIN: process.env.ORIGIN,
	SHORTCUT_PATH: process.env.SHORTCUT_PATH,
	DATABASE_PATH: process.env.DATABASE_PATH
};
// Een neutraal testdomein; het bestand is nagemaakt (tests/fixtures/shortcut.ts)
const signedOrigin = 'https://budget.example.test';
const validUntil = '2027-11-18';
const expires = new Date(`${validUntil}T00:00:00Z`).getTime();
const DAY = 24 * 60 * 60 * 1000;

function useEnv(name: keyof typeof previous, value: string | undefined) {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
	resetConfig();
}
const useOrigin = (origin: string | undefined) => useEnv('ORIGIN', origin);

/** Zet een bestand neer zoals `docker compose cp` dat doet: in één keer, met een nieuwe inode. */
function install(content: string | Buffer, path = signedShortcutPath()) {
	const temp = `${path}.nieuw`;
	writeFileSync(temp, content);
	renameSync(temp, path);
}

beforeAll(() => useOrigin(signedOrigin));
afterAll(() => {
	for (const [name, value] of Object.entries(previous)) {
		useEnv(name as keyof typeof previous, value);
	}
});

beforeEach(() => {
	({ db, cleanup } = tempDatabase());
	cleanupTelemetry = tempTelemetry().cleanup;
	const { idHash } = createSession(db, { passkeyId: null, deviceName: 'test' });
	session = db.select().from(sessions).where(eq(sessions.idHash, idHash)).get()!;
	// Elke test een eigen datavolume, met een geldig bestand voor het testdomein
	dir = mkdtempSync(join(tmpdir(), 'budget-opdracht-'));
	useEnv('SHORTCUT_PATH', join(dir, 'shortcut-signed.json'));
	install(fakeShortcutJson(signedOrigin, { validUntil }));
	// Ruim binnen de geldigheid, tenzij een test de tijd verzet
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(expires - 200 * DAY);
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	useOrigin(signedOrigin);
	useEnv('SHORTCUT_PATH', undefined);
	rmSync(dir, { recursive: true, force: true });
	cleanupTelemetry();
	cleanup();
});

const download = (s: Session | null) =>
	GET(
		fakeEvent({
			path: '/instellingen/apparaten/opdracht',
			routeId: '/(app)/instellingen/apparaten/opdracht',
			session: s
		}) as never
	);

async function status(response: () => Response | Promise<Response>): Promise<number> {
	try {
		return (await response()).status;
	} catch (e) {
		// error() van SvelteKit gooit een HttpError met een status
		return (e as { status: number }).status;
	}
}

describe('GET /instellingen/apparaten/opdracht', () => {
	it('geeft het ondertekende bestand als download', async () => {
		const response = await download(session);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('application/octet-stream');
		expect(response.headers.get('content-disposition')).toBe(
			'attachment; filename="Bon naar Budget.shortcut"'
		);
		expect(response.headers.get('content-length')).toBe(String(FAKE_SHORTCUT_BYTES.length));
		const bytes = Buffer.from(await response.arrayBuffer());
		expect(bytes.equals(FAKE_SHORTCUT_BYTES)).toBe(true);
		expect(bytes.subarray(0, 4).toString('latin1')).toBe('AEA1');
	});

	it('zonder sessie niet', async () => {
		expect(await status(() => download(null))).toBe(401);
	});

	it('niet als de app op een andere host draait', async () => {
		useOrigin('https://budget.example.org');
		expect(await status(() => download(session))).toBe(409);
	});

	it('ook niet op dezelfde host via http of een andere poort', async () => {
		const signed = new URL(signedOrigin);
		for (const other of [`http://${signed.host}`, `https://${signed.hostname}:8443`]) {
			useOrigin(other);
			expect(await status(() => download(session)), other).toBe(409);
		}
	});

	it('de weigering noemt waar het bestand heen stuurt', async () => {
		useOrigin('https://ander.example.test');
		try {
			await download(session);
			expect.unreachable('geen weigering');
		} catch (e) {
			const { status, body } = e as { status: number; body: { message: string } };
			expect(status).toBe(409);
			expect(body.message).toContain(new URL(signedOrigin).host);
		}
	});

	it('een slash of pad aan het eind van ORIGIN maakt niet uit', async () => {
		for (const origin of [`${signedOrigin}/`, `${signedOrigin}/een/pad`]) {
			useOrigin(origin);
			expect(await status(() => download(session)), origin).toBe(200);
		}
	});

	it('in de laatste maand nog wel, na het verlopen niet meer', async () => {
		vi.setSystemTime(expires - DAY);
		expect(await status(() => download(session))).toBe(200);
		vi.setSystemTime(expires);
		expect(await status(() => download(session))).toBe(410);
	});

	it('zonder bestand: niet geïnstalleerd, geen fout', async () => {
		rmSync(signedShortcutPath());
		const warn = vi.spyOn(log, 'warn');
		expect(currentShortcutStatus()).toEqual({ state: 'missing', origin: signedOrigin });
		expect(await status(() => download(session))).toBe(404);
		expect(warn).not.toHaveBeenCalled();
		// Ook zonder datamap
		rmSync(dir, { recursive: true, force: true });
		expect(currentShortcutStatus().state).toBe('missing');
	});

	it('een nieuw of gewijzigd bestand telt meteen, zonder herstart', async () => {
		expect(await status(() => download(session))).toBe(200);
		install(fakeShortcutJson('https://ander.example.test'));
		expect(currentShortcutStatus()).toMatchObject({
			state: 'other-host',
			host: 'ander.example.test'
		});
		expect(await status(() => download(session))).toBe(409);
		rmSync(signedShortcutPath());
		expect(await status(() => download(session))).toBe(404);
		install(fakeShortcutJson(signedOrigin, { validUntil }));
		expect(await status(() => download(session))).toBe(200);
	});

	it('weigert een bestand dat niet bij de huidige definitie hoort', async () => {
		const sourceHash = shortcutSourceHash('https://ander.example.test/api/ingest');
		install(fakeShortcutJson(signedOrigin, { sourceHash }));
		expect(currentShortcutStatus()).toEqual({ state: 'invalid', origin: signedOrigin });
		expect(await status(() => download(session))).toBe(409);
	});

	it('weigert ongeldige JSON of een verkeerde vorm zonder te crashen', async () => {
		const valid = JSON.parse(fakeShortcutJson(signedOrigin)) as Record<string, unknown>;
		for (const content of [
			'',
			'{',
			'niet eens json',
			'[]',
			JSON.stringify({ ...valid, base64: undefined }),
			JSON.stringify({ ...valid, extra: true }),
			JSON.stringify({ ...valid, url: 'http://budget.example.test/api/ingest' }),
			JSON.stringify({ ...valid, base64: Buffer.from('geen archief').toString('base64') }),
			Buffer.from([0xff, 0xfe, 0x00, 0x7b])
		]) {
			install(content);
			expect(currentShortcutStatus().state, String(content)).toBe('invalid');
			expect(await status(() => download(session)), String(content)).toBe(409);
		}
		// Een map op die plek is ook geen bestand
		rmSync(signedShortcutPath());
		mkdirSync(signedShortcutPath());
		expect(currentShortcutStatus().state).toBe('invalid');
		expect(await status(() => download(session))).toBe(409);
	});

	it('weigert een te groot bestand', async () => {
		install(Buffer.alloc(MAX_SIGNED_FILE_BYTES + 1, 0x20));
		expect(currentShortcutStatus().state).toBe('invalid');
		expect(await status(() => download(session))).toBe(409);
	});

	it('logt een ongeldig bestand één keer, zonder inhoud', () => {
		const warn = vi.spyOn(log, 'warn');
		install(fakeShortcutJson(signedOrigin, { sourceHash: '0'.repeat(64) }));
		currentShortcutStatus();
		currentShortcutStatus();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]![0]).toEqual({ event: 'shortcut_invalid', reason: 'source' });
		const logged = JSON.stringify(warn.mock.calls);
		expect(logged).not.toContain('example.test');
		expect(logged).not.toContain(FAKE_SHORTCUT_BYTES.toString('base64').slice(0, 16));
	});

	it('zoekt standaard naast de database, in het datavolume', () => {
		useEnv('SHORTCUT_PATH', undefined);
		useEnv('DATABASE_PATH', '/data/budget.db');
		expect(signedShortcutPath()).toBe('/data/shortcut-signed.json');
		useEnv('DATABASE_PATH', join(dir, 'budget.db'));
		expect(signedShortcutPath()).toBe(join(dir, 'shortcut-signed.json'));
		expect(currentShortcutStatus().state).toBe('ok');
		useEnv('DATABASE_PATH', previous.DATABASE_PATH);
	});
});

describe('herinnering op Meer', () => {
	it('stip en tegeltekst vanaf een maand voor het verlopen', () => {
		// Verder niets dat aandacht vraagt: een herstelcode, geen rekeningen met een saldocheck
		newRecoveryCode(db);
		const today = '2026-01-15';
		vi.setSystemTime(expires - 31 * DAY);
		expect(meerTiles(db, today).uploadTokens.renewShortcut).toBe(false);
		expect(meerNeedsAttention(db, today)).toBe(false);

		vi.setSystemTime(expires - 29 * DAY);
		expect(meerTiles(db, today).uploadTokens.renewShortcut).toBe(true);
		expect(meerNeedsAttention(db, today)).toBe(true);

		vi.setSystemTime(expires + DAY);
		expect(meerTiles(db, today).uploadTokens.renewShortcut).toBe(true);
		expect(meerNeedsAttention(db, today)).toBe(true);
	});

	it('geen herinnering voor een opdracht van een ander domein', () => {
		useOrigin('https://budget.example.org');
		vi.setSystemTime(expires - DAY);
		expect(meerTiles(db, '2026-01-15').uploadTokens.renewShortcut).toBe(false);
	});

	it('geen herinnering zonder of met een ongeldig bestand', () => {
		newRecoveryCode(db);
		vi.setSystemTime(expires - DAY);
		rmSync(signedShortcutPath());
		expect(meerTiles(db, '2026-01-15').uploadTokens.renewShortcut).toBe(false);
		expect(meerNeedsAttention(db, '2026-01-15')).toBe(false);
		install('{');
		expect(meerTiles(db, '2026-01-15').uploadTokens.renewShortcut).toBe(false);
		expect(meerNeedsAttention(db, '2026-01-15')).toBe(false);
	});
});
