// TER REVIEW (Noah): upload-validatie en token-scope voor bonnetjes (spec: Uploaden via het
// deelmenu, Toetsing aan best practices → Uploads). Token alleen als hash, alleen
// `POST /api/ingest`, alleen JPEG/PNG op handtekening, max 10 MB, 30 per uur.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RequestEvent } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handle } from '../../src/hooks.server.ts';
import {
	createSession,
	sessionCookieName,
	type Session
} from '../../src/lib/server/auth/session.ts';
import { sha256 } from '../../src/lib/server/auth/crypto.ts';
import { resetConfig } from '../../src/lib/server/config.ts';
import type { DB } from '../../src/lib/server/db/index.ts';
import {
	auditLog,
	jobs,
	receipts,
	sessions,
	uploadTokens
} from '../../src/lib/server/db/schema.ts';
import { registerJob, runDueJobs } from '../../src/lib/server/jobs.ts';
import { MAX_UPLOAD_BYTES } from '../../src/lib/server/receipts/image.ts';
import { READ_RECEIPT_JOB, receiptsDir } from '../../src/lib/server/receipts/store.ts';
import {
	MAX_UPLOADS_PER_HOUR,
	createUploadToken,
	resetUploadLimits,
	revokeUploadToken,
	verifyUploadToken
} from '../../src/lib/server/receipts/tokens.ts';
import { POST as ingest } from '../../src/routes/(ingest)/api/ingest/+server.ts';
import { POST as appUpload } from '../../src/routes/(app)/api/receipts/+server.ts';
import { ORIGIN, fakeCookies, tempDatabase } from './helpers.ts';

const INGEST = '/(ingest)/api/ingest';

let dir: string;
let db: DB;
let cleanup: () => void;
let jpeg: Buffer;
let png: Buffer;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'budget-receipts-'));
	process.env.RECEIPTS_DIR = dir;
	resetConfig();
	// Een foto met EXIF (copyright en een gedraaide oriëntatie), en een screenshot
	jpeg = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#fff' } })
		.jpeg()
		.withExif({ IFD0: { Copyright: 'geheim-exif' } })
		.withMetadata({ orientation: 6 })
		.toBuffer();
	png = await sharp({ create: { width: 30, height: 30, channels: 4, background: '#0f7b5f' } })
		.png()
		.toBuffer();
});
afterAll(() => {
	delete process.env.RECEIPTS_DIR;
	resetConfig();
	rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
	({ db, cleanup } = tempDatabase());
	resetUploadLimits();
});
afterEach(() => cleanup());

/** Een verzoek met een ruwe body, zoals de iOS-opdracht hem stuurt (zonder Origin). */
function rawEvent(opts: {
	path?: string;
	routeId?: string;
	method?: string;
	body?: Uint8Array;
	headers?: Record<string, string>;
	session?: Session | null;
}): RequestEvent {
	const url = new URL(opts.path ?? '/api/ingest', ORIGIN);
	const request = new Request(url, {
		method: opts.method ?? 'POST',
		headers: opts.headers,
		body: opts.body as BodyInit | undefined
	});
	return {
		request,
		url,
		route: { id: opts.routeId ?? INGEST },
		params: {},
		cookies: fakeCookies(),
		locals: { session: opts.session ?? null },
		getClientAddress: () => '127.0.0.1',
		setHeaders: () => {},
		isDataRequest: false,
		isSubRequest: false,
		isRemoteRequest: false,
		platform: undefined,
		fetch
	} as unknown as RequestEvent;
}

/** Zoals SvelteKit doet: een `error()` uit de route wordt een antwoord met die status. */
async function resolveIngest(event: RequestEvent): Promise<Response> {
	try {
		return await ingest(event as never);
	} catch (e) {
		if (e && typeof e === 'object' && 'status' in e && 'body' in e) {
			return Response.json((e as { body: unknown }).body, {
				status: (e as { status: number }).status
			});
		}
		throw e;
	}
}

/** Via de hook en de route, zoals een echt verzoek. */
async function upload(token: string, body: Uint8Array, contentType = 'image/jpeg') {
	const event = rawEvent({
		body,
		headers: { authorization: `Bearer ${token}`, 'content-type': contentType }
	});
	return handle({ event, resolve: resolveIngest });
}

async function status(promise: Response | Promise<Response>): Promise<number> {
	try {
		return (await promise).status;
	} catch (e) {
		if (e && typeof e === 'object' && 'status' in e) return (e as { status: number }).status;
		throw e;
	}
}

const neverResolve = async (): Promise<Response> => {
	throw new Error('resolve mag niet worden aangeroepen');
};

describe('upload-tokens', () => {
	it('is 256 bits uit een cryptografische bron en staat alleen als hash in de database', () => {
		const { id, token } = createUploadToken(db, 'iPhone');
		expect(token).toMatch(/^bon_[A-Za-z0-9_-]{43}$/);
		expect(Buffer.from(token.slice(4), 'base64url')).toHaveLength(32);
		const row = db.select().from(uploadTokens).where(eq(uploadTokens.id, id)).get()!;
		expect(row.tokenHash).toBe(sha256(token));
		// Het token zelf staat nergens in het bestand
		const file = readFileSync(db.$client.name);
		expect(file.includes(Buffer.from(token))).toBe(false);
		expect(createUploadToken(db, 'iPad').token).not.toBe(token);
	});

	it('herkent alleen een geldig, niet ingetrokken token', () => {
		const { id, token } = createUploadToken(db, 'iPhone');
		expect(verifyUploadToken(db, `Bearer ${token}`)?.id).toBe(id);
		expect(verifyUploadToken(db, token)).toBeNull();
		expect(verifyUploadToken(db, `Bearer ${token}x`)).toBeNull();
		expect(verifyUploadToken(db, `Bearer bon_${'A'.repeat(43)}`)).toBeNull();
		expect(verifyUploadToken(db, null)).toBeNull();
		expect(revokeUploadToken(db, id)).toBe(true);
		expect(verifyUploadToken(db, `Bearer ${token}`)).toBeNull();
		expect(revokeUploadToken(db, id)).toBe(false);
	});

	it('legt aanmaken, gebruik en intrekken vast in het audit-log, zonder het token', async () => {
		const { id, token } = createUploadToken(db, 'iPhone');
		expect((await upload(token, jpeg)).status).toBe(202);
		revokeUploadToken(db, id);
		const events = db
			.select()
			.from(auditLog)
			.where(and(eq(auditLog.kind, 'beveiliging'), eq(auditLog.entityId, id)))
			.all()
			.map((e) => e.action);
		expect(events).toEqual([
			'upload_token_aangemaakt',
			'upload_token_gebruikt',
			'upload_token_ingetrokken'
		]);
		expect(JSON.stringify(db.select().from(auditLog).all())).not.toContain(token);
	});
});

describe('token-scope', () => {
	it('POST /api/ingest zonder token geeft 401', async () => {
		const event = rawEvent({ body: jpeg, headers: { 'content-type': 'image/jpeg' } });
		expect((await handle({ event, resolve: neverResolve })).status).toBe(401);
	});

	it('een sessie opent /api/ingest niet: alleen het token telt', async () => {
		const { token } = createSession(db, { passkeyId: null, deviceName: 'test' });
		const event = rawEvent({
			body: jpeg,
			headers: {
				'content-type': 'image/jpeg',
				origin: ORIGIN,
				cookie: `${sessionCookieName()}=${token}`
			}
		});
		event.cookies.set(sessionCookieName(), token, { path: '/' });
		expect((await handle({ event, resolve: neverResolve })).status).toBe(401);
	});

	it('een ingetrokken token geeft 401', async () => {
		const { id, token } = createUploadToken(db, 'iPhone');
		revokeUploadToken(db, id);
		expect((await upload(token, jpeg)).status).toBe(401);
	});

	it('een browser van een andere origin wordt geweigerd, ook met token', async () => {
		const { token } = createUploadToken(db, 'iPhone');
		const event = rawEvent({
			body: jpeg,
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'image/jpeg',
				origin: 'https://evil.example'
			}
		});
		expect((await handle({ event, resolve: neverResolve })).status).toBe(403);
	});

	it('zonder Origin (iOS-opdracht) komt een geldig token door', async () => {
		const { token } = createUploadToken(db, 'iPhone');
		expect((await upload(token, jpeg)).status).toBe(202);
	});

	it('de route zelf weigert zonder token, ook als de hook overgeslagen zou worden', async () => {
		const event = rawEvent({ body: jpeg, headers: { 'content-type': 'image/jpeg' } });
		expect(await status(ingest(event as never))).toBe(401);
	});
});

describe('POST /api/ingest', () => {
	it('slaat de bon opnieuw gecodeerd op, zonder EXIF, en zet hem in de wachtrij', async () => {
		const { id: tokenId, token } = createUploadToken(db, 'iPhone');
		const response = await upload(token, jpeg);
		expect(response.status).toBe(202);
		const body = (await response.json()) as Record<string, unknown>;
		// Alleen "ontvangen" en een ID, nooit data
		expect(Object.keys(body).sort()).toEqual(['id', 'status']);
		expect(body.status).toBe('ontvangen');
		expect(response.headers.get('cache-control')).toBe('no-store');

		const receipt = db
			.select()
			.from(receipts)
			.where(eq(receipts.id, body.id as string))
			.get()!;
		expect(receipt).toMatchObject({
			source: 'deelmenu',
			status: 'wordt_gelezen',
			mediaType: 'image/jpeg',
			uploadTokenId: tokenId
		});
		expect(receipt.fileId).toMatch(/^[0-9a-f-]{36}$/);
		expect(receipt.fileId).not.toBe(receipt.id);

		const file = join(receiptsDir(), `${receipt.fileId}.jpg`);
		expect(receiptsDir()).toBe(dir);
		const stored = readFileSync(file);
		expect(stored.equals(jpeg)).toBe(false);
		expect(stored.includes(Buffer.from('geheim-exif'))).toBe(false);
		const meta = await sharp(stored).metadata();
		expect(meta.format).toBe('jpeg');
		expect(meta.exif).toBeUndefined();
		// De oriëntatie is toegepast voordat de EXIF eraf ging
		expect([meta.width, meta.height]).toEqual([20, 40]);

		const job = db.select().from(jobs).where(eq(jobs.kind, READ_RECEIPT_JOB)).get()!;
		expect(job.status).toBe('wachtend');
		expect(job.payload).toEqual({ receiptId: receipt.id });

		const token2 = db.select().from(uploadTokens).where(eq(uploadTokens.id, tokenId)).get()!;
		expect(token2.lastUsedAt).not.toBeNull();
	});

	it('een screenshot blijft PNG', async () => {
		const { token } = createUploadToken(db, 'iPhone');
		const response = await upload(token, png, 'image/png');
		expect(response.status).toBe(202);
		const { id } = (await response.json()) as { id: string };
		const receipt = db.select().from(receipts).where(eq(receipts.id, id)).get()!;
		expect(receipt.mediaType).toBe('image/png');
		const meta = await sharp(join(dir, `${receipt.fileId}.png`)).metadata();
		expect(meta.format).toBe('png');
	});

	describe('bestandshandtekening', () => {
		it.each([
			['PNG-bytes als JPEG', () => png, 'image/jpeg'],
			['JPEG-bytes als PNG', () => jpeg, 'image/png'],
			[
				'tekst als JPEG',
				() => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
				'image/jpeg'
			],
			['GIF als JPEG', () => Buffer.from('GIF89a\x01\x00\x01\x00'), 'image/jpeg'],
			['een JPEG als SVG', () => jpeg, 'image/svg+xml'],
			['een JPEG als formulier', () => jpeg, 'multipart/form-data; boundary=x'],
			['een JPEG zonder type', () => jpeg, '']
		])('weigert %s met 415', async (_name, bytes, type) => {
			const { token } = createUploadToken(db, 'iPhone');
			expect((await upload(token, bytes(), type)).status).toBe(415);
			expect(db.select().from(receipts).all()).toHaveLength(0);
		});

		it('weigert een kapotte JPEG met een geldige handtekening', async () => {
			const { token } = createUploadToken(db, 'iPhone');
			const broken = Buffer.concat([jpeg.subarray(0, 3), Buffer.alloc(200, 0x41)]);
			expect((await upload(token, broken)).status).toBe(422);
			expect(db.select().from(receipts).all()).toHaveLength(0);
			expect(db.select().from(jobs).where(eq(jobs.kind, READ_RECEIPT_JOB)).all()).toHaveLength(0);
		});

		it('weigert een lege body', async () => {
			const { token } = createUploadToken(db, 'iPhone');
			expect((await upload(token, new Uint8Array(0))).status).toBe(400);
		});

		it('weigert een decompressiebom (te veel pixels)', async () => {
			const { token } = createUploadToken(db, 'iPhone');
			const bomb = await sharp({
				create: { width: 10_000, height: 6_000, channels: 3, background: '#fff' }
			})
				.png({ compressionLevel: 9 })
				.toBuffer();
			expect(bomb.length).toBeLessThan(MAX_UPLOAD_BYTES);
			expect((await upload(token, bomb, 'image/png')).status).toBe(422);
		});
	});

	describe('groottelimiet', () => {
		it('weigert meer dan 10 MB op de Content-Length', async () => {
			const { token } = createUploadToken(db, 'iPhone');
			const big = Buffer.concat([jpeg, Buffer.alloc(MAX_UPLOAD_BYTES)]);
			expect((await upload(token, big)).status).toBe(413);
		});

		it('weigert meer dan 10 MB ook als de Content-Length ontbreekt', async () => {
			const { token } = createUploadToken(db, 'iPhone');
			const chunk = Buffer.concat([jpeg, Buffer.alloc(1024 * 1024)]);
			let sent = 0;
			const stream = new ReadableStream<Uint8Array>({
				pull(controller) {
					if (sent > MAX_UPLOAD_BYTES + chunk.length) return controller.close();
					sent += chunk.length;
					controller.enqueue(new Uint8Array(chunk));
				}
			});
			const event = rawEvent({
				headers: { authorization: `Bearer ${token}`, 'content-type': 'image/jpeg' }
			});
			Object.defineProperty(event, 'request', {
				value: new Request(event.url, {
					method: 'POST',
					headers: event.request.headers,
					body: stream,
					duplex: 'half'
				} as RequestInit)
			});
			expect(event.request.headers.get('content-length')).toBeNull();
			const response = await handle({ event, resolve: resolveIngest });
			expect(response.status).toBe(413);
			expect(sent).toBeLessThanOrEqual(MAX_UPLOAD_BYTES + 2 * chunk.length);
		});
	});

	describe('30 uploads per uur', () => {
		it('blokkeert het token een uur bij de 31e upload, ook na een herstart', async () => {
			const { id, token } = createUploadToken(db, 'iPhone');
			for (let i = 0; i < MAX_UPLOADS_PER_HOUR; i++) {
				expect((await upload(token, png, 'image/png')).status).toBe(202);
			}
			expect((await upload(token, png, 'image/png')).status).toBe(429);
			const row = db.select().from(uploadTokens).where(eq(uploadTokens.id, id)).get()!;
			const blockedFor = Date.parse(row.blockedUntil!) - Date.now();
			expect(blockedFor).toBeGreaterThan(59 * 60_000);
			expect(blockedFor).toBeLessThanOrEqual(60 * 60_000);
			expect(
				db.select().from(auditLog).where(eq(auditLog.action, 'upload_token_geblokkeerd')).all()
			).toHaveLength(1);

			// Het geheugen telt opnieuw, de blokkade in de database blijft
			resetUploadLimits();
			expect((await upload(token, png, 'image/png')).status).toBe(429);
			expect(db.select().from(receipts).all()).toHaveLength(MAX_UPLOADS_PER_HOUR);
		});

		it('telt per token: een ander token kan gewoon verder', async () => {
			const a = createUploadToken(db, 'iPhone');
			const b = createUploadToken(db, 'iPad');
			for (let i = 0; i <= MAX_UPLOADS_PER_HOUR; i++) await upload(a.token, png, 'image/png');
			expect((await upload(a.token, png, 'image/png')).status).toBe(429);
			expect((await upload(b.token, png, 'image/png')).status).toBe(202);
		});

		it('een geweigerd bestand telt ook mee', async () => {
			const { token } = createUploadToken(db, 'iPhone');
			for (let i = 0; i < MAX_UPLOADS_PER_HOUR; i++) {
				expect((await upload(token, Buffer.from('rommel'))).status).toBe(415);
			}
			expect((await upload(token, jpeg)).status).toBe(429);
		});
	});
});

describe('POST /api/receipts (vanuit de app)', () => {
	function session(): Session {
		const { idHash } = createSession(db, { passkeyId: null, deviceName: 'test' });
		return db.select().from(sessions).where(eq(sessions.idHash, idHash)).get()!;
	}

	it('slaat op met bron app, via dezelfde controles', async () => {
		const event = rawEvent({
			path: '/api/receipts',
			routeId: '/(app)/api/receipts',
			body: jpeg,
			headers: { 'content-type': 'image/jpeg', origin: ORIGIN },
			session: session()
		});
		const response = await appUpload(event as never);
		expect(response.status).toBe(202);
		const { id } = (await response.json()) as { id: string };
		const receipt = db.select().from(receipts).where(eq(receipts.id, id)).get()!;
		expect(receipt).toMatchObject({ source: 'app', uploadTokenId: null });
		expect(existsSync(join(dir, `${receipt.fileId}.jpg`))).toBe(true);
	});

	it('weigert een verkeerde handtekening', async () => {
		const event = rawEvent({
			path: '/api/receipts',
			routeId: '/(app)/api/receipts',
			body: png,
			headers: { 'content-type': 'image/jpeg', origin: ORIGIN },
			session: session()
		});
		expect(await status(appUpload(event as never))).toBe(415);
	});

	it('een upload-token opent deze route niet', async () => {
		const { token } = createUploadToken(db, 'iPhone');
		const event = rawEvent({
			path: '/api/receipts',
			routeId: '/(app)/api/receipts',
			body: jpeg,
			headers: { 'content-type': 'image/jpeg', origin: ORIGIN, authorization: `Bearer ${token}` }
		});
		expect((await handle({ event, resolve: neverResolve })).status).toBe(401);
	});
});

describe('taak bon_lezen', () => {
	it('blijft wachten zolang er geen lezer is, zonder andere taken op te houden', async () => {
		const { token } = createUploadToken(db, 'iPhone');
		await upload(token, jpeg);
		let ran = 0;
		registerJob('test_taak', () => void ran++);
		db.insert(jobs)
			.values({ kind: 'test_taak', runAt: new Date(0).toISOString() })
			.run();
		await runDueJobs(db, new Date(Date.now() + 60_000));
		expect(ran).toBe(1);
		const job = db.select().from(jobs).where(eq(jobs.kind, READ_RECEIPT_JOB)).get()!;
		expect(job).toMatchObject({ status: 'wachtend', attempts: 0 });
	});

	it('een onbekende soort zonder declaratie mislukt nog steeds', async () => {
		db.insert(jobs)
			.values({ kind: 'bestaat_niet', runAt: new Date(0).toISOString(), attempts: 2 })
			.run();
		await runDueJobs(db);
		expect(db.select().from(jobs).where(eq(jobs.kind, 'bestaat_niet')).get()!.status).toBe(
			'mislukt'
		);
	});
});

it('bewaart bonnen alleen in de eigen map, onder hun UUID', async () => {
	const { token } = createUploadToken(db, 'iPhone');
	await upload(token, jpeg);
	for (const name of readdirSync(dir)) expect(name).toMatch(/^[0-9a-f-]{36}\.(jpg|png)$/);
});

describe('scherm Apparaten', () => {
	async function act(name: 'create' | 'revoke', fields: Record<string, string>, reauth: boolean) {
		const { actions } =
			await import('../../src/routes/(app)/instellingen/apparaten/+page.server.ts');
		const { idHash } = createSession(db, { passkeyId: null, deviceName: 'test', reauth });
		const session = db.select().from(sessions).where(eq(sessions.idHash, idHash)).get()!;
		const event = rawEvent({
			path: `/instellingen/apparaten?/${name}`,
			routeId: '/(app)/instellingen/apparaten',
			session,
			body: new TextEncoder().encode(new URLSearchParams(fields).toString()),
			headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN }
		});
		try {
			return await actions[name]!(event as never);
		} catch (e) {
			if (e && typeof e === 'object' && 'status' in e)
				return { thrown: (e as { status: number }).status };
			throw e;
		}
	}

	it('een token aanmaken vraagt opnieuw om je passkey', async () => {
		expect(await act('create', { name: 'iPhone' }, false)).toEqual({ thrown: 403 });
		expect(db.select().from(uploadTokens).all()).toHaveLength(0);
	});

	it('toont het token één keer en bewaart alleen de hash', async () => {
		const result = (await act('create', { name: '  iPhone  ' }, true)) as {
			created: { id: string; name: string; token: string };
		};
		expect(result.created.name).toBe('iPhone');
		const row = db.select().from(uploadTokens).get()!;
		expect(row.tokenHash).toBe(sha256(result.created.token));
		expect(verifyUploadToken(db, `Bearer ${result.created.token}`)?.id).toBe(result.created.id);
	});

	it('weigert een lege naam', async () => {
		const result = await act('create', { name: '   ' }, true);
		expect(result).toMatchObject({ status: 400 });
	});

	it('intrekken kan zonder passkey, met één tik', async () => {
		const { id, token } = createUploadToken(db, 'iPhone');
		expect(await act('revoke', { id }, false)).toEqual({ revoked: true });
		expect(verifyUploadToken(db, `Bearer ${token}`)).toBeNull();
		expect(await act('revoke', { id }, false)).toMatchObject({ status: 404 });
	});
});
