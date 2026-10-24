import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { POST as createTx } from '../../src/routes/(app)/api/transactions/+server.ts';
import { POST as loginVerify } from '../../src/routes/(public)/api/auth/login/verify/+server.ts';
import { createSession, type Session } from '../../src/lib/server/auth/session.ts';
import type { DB } from '../../src/lib/server/db/index.ts';
import { accounts, sessions, transactions } from '../../src/lib/server/db/schema.ts';
import { fakeEvent, tempDatabase } from './helpers.ts';

let db: DB;
let cleanup: () => void;
let session: Session;
let sns: string;

beforeEach(() => {
	({ db, cleanup } = tempDatabase());
	const { idHash } = createSession(db, { passkeyId: null, deviceName: 'test' });
	session = db.select().from(sessions).where(eq(sessions.idHash, idHash)).get()!;
	sns = db.select().from(accounts).where(eq(accounts.alias, 'sns')).get()!.id;
});
afterEach(() => cleanup());

async function status(promise: Promise<Response> | Response): Promise<number> {
	try {
		return (await promise).status;
	} catch (e) {
		// error() van SvelteKit gooit een HttpError met een status
		if (e && typeof e === 'object' && 'status' in e) return (e as { status: number }).status;
		throw e;
	}
}

const valid = () => ({
	id: crypto.randomUUID(),
	amountCents: -1250,
	date: '2026-10-20',
	counterparty: 'Albert Heijn',
	categoryId: null,
	accountId: sns,
	origAmountCents: null,
	origCurrency: null,
	description: '',
	note: '',
	share: null
});

const post = (body: unknown) =>
	createTx(
		fakeEvent({
			path: '/api/transactions',
			routeId: '/(app)/api/transactions',
			method: 'POST',
			body,
			session
		}) as never
	);

describe('POST /api/transactions', () => {
	it('maakt een transactie en is idempotent', async () => {
		const body = valid();
		expect(await status(post(body))).toBe(201);
		expect(await status(post(body))).toBe(200);
		expect(db.select().from(transactions).all()).toHaveLength(1);
	});

	it.each([
		['bedrag als kommagetal', { amountCents: 12.5 }],
		['bedrag als tekst', { amountCents: '1250' }],
		['te groot bedrag', { amountCents: -100_000_001 }],
		['ongeldige datum', { date: '2026-02-30' }],
		['onbekend veld', { isAdmin: true }],
		['geen UUID', { id: '1' }],
		['te lange naam', { counterparty: 'x'.repeat(101) }],
		['valuta zonder bedrag', { origCurrency: 'USD' }],
		['delen van inkomen', { amountCents: 1000, share: { people: 2, with: [] } }]
	])('weigert %s', async (_name, override) => {
		expect(await status(post({ ...valid(), ...override }))).toBe(400);
		expect(db.select().from(transactions).all()).toHaveLength(0);
	});

	it('weigert een niet-JSON body', async () => {
		const event = fakeEvent({
			path: '/api/transactions',
			routeId: '/(app)/api/transactions',
			method: 'POST',
			session
		});
		expect(await status(createTx(event as never))).toBe(415);
	});
});

describe('POST /api/auth/login/verify', () => {
	it('zonder challenge geen sessie', async () => {
		const event = fakeEvent({
			path: '/api/auth/login/verify',
			routeId: '/(public)/api/auth/login/verify',
			method: 'POST',
			body: { id: 'x' }
		});
		expect(await status(loginVerify(event as never))).toBe(400);
		expect(db.select().from(sessions).all()).toHaveLength(1);
	});
});
