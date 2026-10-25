import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSession, type Session } from '../../src/lib/server/auth/session.ts';
import { sessions } from '../../src/lib/server/db/schema.ts';
import { SIGNED_SHORTCUT } from '../../src/lib/server/receipts/shortcut-signed.ts';
import { GET } from '../../src/routes/(app)/instellingen/apparaten/opdracht/+server.ts';
import { fakeEvent, tempDatabase } from './helpers.ts';

let cleanup: () => void;
let session: Session;

beforeEach(() => {
	const temp = tempDatabase();
	cleanup = temp.cleanup;
	const { idHash } = createSession(temp.db, { passkeyId: null, deviceName: 'test' });
	session = temp.db.select().from(sessions).where(eq(sessions.idHash, idHash)).get()!;
});
afterEach(() => cleanup());

const download = (s: Session | null) =>
	GET(
		fakeEvent({
			path: '/instellingen/apparaten/opdracht',
			routeId: '/(app)/instellingen/apparaten/opdracht',
			session: s
		}) as never
	);

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
		let status = 0;
		try {
			await download(null);
		} catch (e) {
			status = (e as { status: number }).status;
		}
		expect(status).toBe(401);
	});
});
