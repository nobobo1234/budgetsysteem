import { createECDH, createPublicKey, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	MAX_PLAINTEXT,
	buildPushRequest,
	encryptPayload,
	isAllowedEndpoint,
	vapidAuthorization
} from './webpush.ts';

// Voorbeeld uit RFC 8291, §5 en appendix A: publieke testwaarden uit de RFC, geen echte
// sleutels. Secret-scanners herkennen ze als sleutel; de markering op de regel zegt gitleaks en
// GitGuardian dat het een bekende testwaarde is. Alleen de afzendersleutel is nodig om het
// voorbeeld byte voor byte na te maken.
const RFC = {
	plaintext: 'When I grow up, I want to be a watermelon',
	uaPublic:
		'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
	asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', // gitleaks:allow ggignore (RFC 8291)
	auth: 'BTBZMqHH6r4Tts7J_aSIgg', // gitleaks:allow ggignore (RFC 8291)
	salt: 'DGv6ra1nlYgDCS1FRnbzlw',
	body:
		'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
		'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
		'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'
};

/** Testsleutels, elke run nieuw: nooit echte VAPID-sleutels in de repo. */
function testVapid() {
	const ecdh = createECDH('prime256v1');
	ecdh.generateKeys();
	return {
		publicKey: ecdh.getPublicKey().toString('base64url'),
		// Altijd 32 bytes: getPrivateKey laat een voorloopnul weg
		privateKey: Buffer.concat([
			Buffer.alloc(32 - ecdh.getPrivateKey().length),
			ecdh.getPrivateKey()
		]).toString('base64url'),
		subject: 'https://budget.example'
	};
}

function testDevice() {
	const ecdh = createECDH('prime256v1');
	ecdh.generateKeys();
	return {
		p256dh: ecdh.getPublicKey().toString('base64url'),
		auth: randomBytes(16).toString('base64url')
	};
}

describe('encryptPayload (RFC 8291)', () => {
	it('geeft precies het voorbeeld uit de RFC', () => {
		const body = encryptPayload(
			Buffer.from(RFC.plaintext),
			{ p256dh: RFC.uaPublic, auth: RFC.auth },
			{
				salt: Buffer.from(RFC.salt, 'base64url'),
				senderPrivateKey: Buffer.from(RFC.asPrivate, 'base64url')
			}
		);
		expect(body.toString('base64url')).toBe(RFC.body);
	});

	it('gebruikt elke keer een nieuwe salt en sleutel', () => {
		const target = testDevice();
		const a = encryptPayload(Buffer.from('x'), target);
		const b = encryptPayload(Buffer.from('x'), target);
		expect(a.subarray(0, 16).equals(b.subarray(0, 16))).toBe(false);
		expect(a.subarray(21, 86).equals(b.subarray(21, 86))).toBe(false);
	});

	it('weigert te grote berichten en ongeldige sleutels', () => {
		const target = testDevice();
		expect(() => encryptPayload(Buffer.alloc(MAX_PLAINTEXT + 1), target)).toThrow(RangeError);
		expect(() => encryptPayload(Buffer.from('x'), { ...target, auth: 'AAAA' })).toThrow(TypeError);
		expect(() => encryptPayload(Buffer.from('x'), { ...target, p256dh: 'AAAA' })).toThrow(
			TypeError
		);
	});
});

describe('VAPID (RFC 8292)', () => {
	it('tekent een JWT voor de origin van de push-dienst, controleerbaar met de publieke sleutel', () => {
		const keys = testVapid();
		const now = Date.UTC(2026, 9, 24, 12);
		const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, now);
		const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
		expect(match).not.toBeNull();
		const [, h, p, s, k] = match!;
		expect(k).toBe(keys.publicKey);
		expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({
			typ: 'JWT',
			alg: 'ES256'
		});
		expect(JSON.parse(Buffer.from(p!, 'base64url').toString())).toEqual({
			aud: 'https://fcm.googleapis.com',
			exp: now / 1000 + 12 * 3600,
			sub: 'https://budget.example'
		});
		const pub = Buffer.from(keys.publicKey, 'base64url');
		const publicKey = createPublicKey({
			format: 'jwk',
			key: {
				kty: 'EC',
				crv: 'P-256',
				x: pub.subarray(1, 33).toString('base64url'),
				y: pub.subarray(33).toString('base64url')
			}
		});
		const ok = verify(
			'sha256',
			Buffer.from(`${h}.${p}`),
			{ key: publicKey, dsaEncoding: 'ieee-p1363' },
			Buffer.from(s!, 'base64url')
		);
		expect(ok).toBe(true);
	});

	it('weigert een publieke sleutel die niet bij de vorm past', () => {
		const keys = { ...testVapid(), publicKey: 'AAAA' };
		expect(() => vapidAuthorization('https://fcm.googleapis.com/x', keys)).toThrow();
	});

	it('de privésleutel komt nergens in het verzoek', () => {
		const keys = testVapid();
		const request = buildPushRequest(
			{ endpoint: 'https://web.push.apple.com/abc', ...testDevice() },
			'{"title":"x"}',
			keys,
			{ ttlSeconds: 60, urgency: 'normal', topic: 'fout' }
		);
		expect(JSON.stringify(request.headers)).not.toContain(keys.privateKey);
		expect(request.headers).toMatchObject({
			'content-encoding': 'aes128gcm',
			ttl: '60',
			urgency: 'normal',
			topic: 'fout'
		});
	});

	it('laat een ongeldig topic weg', () => {
		const request = buildPushRequest(
			{ endpoint: 'https://web.push.apple.com/abc', ...testDevice() },
			'{}',
			testVapid(),
			{ ttlSeconds: 60, urgency: 'low', topic: 'met spatie' }
		);
		expect(request.headers.topic).toBeUndefined();
	});

	it('werkt met een sleutelpaar uit generateKeyPairSync', () => {
		const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
		const jwk = privateKey.export({ format: 'jwk' });
		const pub = publicKey.export({ format: 'jwk' });
		const raw = Buffer.concat([
			Buffer.from([4]),
			Buffer.from(pub.x!, 'base64url'),
			Buffer.from(pub.y!, 'base64url')
		]);
		const keys = {
			publicKey: raw.toString('base64url'),
			privateKey: jwk.d!,
			subject: 'mailto:x@y.z'
		};
		expect(vapidAuthorization('https://fcm.googleapis.com/x', keys)).toMatch(/^vapid t=/);
	});
});

describe('isAllowedEndpoint', () => {
	it('staat de push-diensten van de grote browsers toe', () => {
		for (const url of [
			'https://fcm.googleapis.com/fcm/send/abc',
			'https://updates.push.services.mozilla.com/wpush/v2/abc',
			'https://web.push.apple.com/QGx',
			'https://wns2-db5p.notify.windows.com/w/?token=abc'
		]) {
			expect(isAllowedEndpoint(url), url).toBe(true);
		}
	});

	it('weigert al het andere', () => {
		for (const url of [
			'http://fcm.googleapis.com/fcm/send/abc',
			'https://fcm.googleapis.com:8443/x',
			'https://user:pw@fcm.googleapis.com/x',
			'https://fcm.googleapis.com.evil.example/x',
			'https://evilfcm.googleapis.com/x',
			'https://localhost/x',
			'https://127.0.0.1/x',
			'https://169.254.169.254/latest',
			'file:///etc/passwd',
			'geen url'
		]) {
			expect(isAllowedEndpoint(url), url).toBe(false);
		}
	});
});
