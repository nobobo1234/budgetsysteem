import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { newRecoveryCode } from '../../src/lib/server/auth/recovery.ts';
import { createSession, type Session } from '../../src/lib/server/auth/session.ts';
import { resetConfig } from '../../src/lib/server/config.ts';
import type { DB } from '../../src/lib/server/db/index.ts';
import { sessions } from '../../src/lib/server/db/schema.ts';
import { meerNeedsAttention, meerTiles } from '../../src/lib/server/meer.ts';
import { SIGNED_SHORTCUT } from '../../src/lib/server/receipts/shortcut-signed.ts';
import { GET } from '../../src/routes/(app)/instellingen/apparaten/opdracht/+server.ts';
import { fakeEvent, tempDatabase, tempTelemetry } from './helpers.ts';

// De testomgeving heeft geen backups of schijfinfo; die punten van de statuspagina tellen hier
// niet mee, zodat de stip op Meer alleen van de opdracht afhangt
vi.mock('../../src/lib/server/telemetry/status.ts', () => ({ attention: () => [] }));

let db: DB;
let cleanup: () => void;
let cleanupTelemetry: () => void;
let session: Session;
const previousOrigin = process.env.ORIGIN;
const signedOrigin = new URL(SIGNED_SHORTCUT.url).origin;
const expires = new Date(`${SIGNED_SHORTCUT.validUntil}T00:00:00Z`).getTime();
const DAY = 24 * 60 * 60 * 1000;

function useOrigin(origin: string | undefined) {
	if (origin === undefined) delete process.env.ORIGIN;
	else process.env.ORIGIN = origin;
	resetConfig();
}

beforeAll(() => useOrigin(signedOrigin));
afterAll(() => useOrigin(previousOrigin));

beforeEach(() => {
	({ db, cleanup } = tempDatabase());
	cleanupTelemetry = tempTelemetry().cleanup;
	const { idHash } = createSession(db, { passkeyId: null, deviceName: 'test' });
	session = db.select().from(sessions).where(eq(sessions.idHash, idHash)).get()!;
	// Ruim binnen de geldigheid, tenzij een test de tijd verzet
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(expires - 200 * DAY);
});
afterEach(() => {
	vi.useRealTimers();
	useOrigin(signedOrigin);
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
		const bytes = Buffer.from(await response.arrayBuffer());
		expect(bytes.equals(Buffer.from(SIGNED_SHORTCUT.base64, 'base64'))).toBe(true);
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
		useOrigin('https://budget.example.test');
		try {
			await download(session);
			expect.unreachable('geen weigering');
		} catch (e) {
			const { status, body } = e as { status: number; body: { message: string } };
			expect(status).toBe(409);
			expect(body.message).toContain(new URL(SIGNED_SHORTCUT.url).host);
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
});
