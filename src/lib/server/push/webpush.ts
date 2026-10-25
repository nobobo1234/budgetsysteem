import {
	createCipheriv,
	createECDH,
	createPrivateKey,
	hkdfSync,
	randomBytes,
	sign,
	type KeyObject
} from 'node:crypto';

// Web Push zonder dependency: berichtversleuteling volgens RFC 8291 (aes128gcm, RFC 8188) en
// VAPID volgens RFC 8292, met alleen node:crypto. De unit-test controleert de versleuteling
// tegen het voorbeeld uit RFC 8291 (appendix A).

/** Abonnement zoals de browser het geeft (`PushSubscription.toJSON()`). */
export interface PushTarget {
	endpoint: string;
	/** Publieke sleutel van het apparaat: ongecomprimeerd P-256-punt, base64url. */
	p256dh: string;
	/** Auth-geheim van het apparaat (16 bytes), base64url. */
	auth: string;
}

export interface VapidKeys {
	publicKey: string;
	privateKey: string;
	subject: string;
}

/** Wat de push-dienst krijgt. De body is versleuteld; alleen het apparaat kan hem lezen. */
export interface PushRequest {
	url: string;
	headers: Record<string, string>;
	body: Uint8Array;
}

const RECORD_SIZE = 4096;
// Een push-dienst hoeft niet meer dan 4096 bytes aan te nemen; 86 bytes header, 16 bytes
// tag en 1 byte scheidingsteken gaan daar nog af.
export const MAX_PLAINTEXT = RECORD_SIZE - 86 - 16 - 1;

function b64(value: string): Buffer {
	return Buffer.from(value, 'base64url');
}

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
	return Buffer.from(hkdfSync('sha256', ikm, salt, info, length));
}

/**
 * Versleutelt een bericht voor één apparaat (RFC 8291, één record, zonder opvulling).
 * `salt` en `senderPrivateKey` zijn er alleen voor de test met de RFC-waarden; normaal zijn
 * ze elke keer nieuw en willekeurig.
 */
export function encryptPayload(
	plaintext: Uint8Array,
	target: Pick<PushTarget, 'p256dh' | 'auth'>,
	fixed: { salt?: Buffer; senderPrivateKey?: Buffer } = {}
): Buffer {
	if (plaintext.length > MAX_PLAINTEXT) throw new RangeError('Bericht te groot voor Web Push');
	const uaPublic = b64(target.p256dh);
	const authSecret = b64(target.auth);
	if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new TypeError('Ongeldige p256dh');
	if (authSecret.length !== 16) throw new TypeError('Ongeldig auth-geheim');

	const ecdh = createECDH('prime256v1');
	if (fixed.senderPrivateKey) ecdh.setPrivateKey(fixed.senderPrivateKey);
	else ecdh.generateKeys();
	const asPublic = ecdh.getPublicKey();
	const ecdhSecret = ecdh.computeSecret(uaPublic);
	const salt = fixed.salt ?? randomBytes(16);

	// RFC 8291 §3.4: geheim van het apparaat en de ECDH-uitkomst combineren
	const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
	const ikm = hkdf(authSecret, ecdhSecret, keyInfo, 32);
	// RFC 8188 §2.2 en §2.3: sleutel en nonce voor de inhoud
	const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
	const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);

	const cipher = createCipheriv('aes-128-gcm', cek, nonce);
	// 0x02: scheidingsteken van het laatste (en enige) record
	const ciphertext = Buffer.concat([
		cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])),
		cipher.final(),
		cipher.getAuthTag()
	]);

	const header = Buffer.alloc(16 + 4 + 1);
	salt.copy(header, 0);
	header.writeUInt32BE(RECORD_SIZE, 16);
	header.writeUInt8(asPublic.length, 20);
	return Buffer.concat([header, asPublic, ciphertext]);
}

/** Privésleutel als KeyObject, uit de ruwe base64url-waarden in de omgeving. */
export function vapidKeyObject(keys: Pick<VapidKeys, 'publicKey' | 'privateKey'>): KeyObject {
	const pub = b64(keys.publicKey);
	if (pub.length !== 65 || pub[0] !== 0x04) throw new TypeError('Ongeldige VAPID-sleutel');
	return createPrivateKey({
		format: 'jwk',
		key: {
			kty: 'EC',
			crv: 'P-256',
			d: keys.privateKey,
			x: pub.subarray(1, 33).toString('base64url'),
			y: pub.subarray(33).toString('base64url')
		}
	});
}

/** VAPID-header (RFC 8292): een JWT voor de origin van de push-dienst, 12 uur geldig. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, now = Date.now()): string {
	const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
	const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({
		aud: new URL(endpoint).origin,
		exp: Math.floor(now / 1000) + 12 * 3600,
		sub: keys.subject
	})}`;
	const signature = sign('sha256', Buffer.from(unsigned), {
		key: vapidKeyObject(keys),
		dsaEncoding: 'ieee-p1363'
	});
	return `vapid t=${unsigned}.${signature.toString('base64url')}, k=${keys.publicKey}`;
}

/** Het complete verzoek aan de push-dienst. */
export function buildPushRequest(
	target: PushTarget,
	payload: string,
	keys: VapidKeys,
	options: { ttlSeconds: number; urgency: 'low' | 'normal' | 'high'; topic?: string }
): PushRequest {
	const headers: Record<string, string> = {
		authorization: vapidAuthorization(target.endpoint, keys),
		'content-encoding': 'aes128gcm',
		'content-type': 'application/octet-stream',
		ttl: String(options.ttlSeconds),
		urgency: options.urgency
	};
	// Topic (RFC 8030 §5.4): een nieuwere melding met hetzelfde topic vervangt een oudere die
	// nog bij de push-dienst wacht. Hooguit 32 tekens uit het base64url-alfabet.
	if (options.topic && /^[A-Za-z0-9_-]{1,32}$/.test(options.topic)) headers.topic = options.topic;
	return {
		url: target.endpoint,
		headers,
		body: encryptPayload(Buffer.from(payload, 'utf8'), target)
	};
}

// Alleen de push-diensten van de grote browsers. Het endpoint komt van de client; zonder deze
// lijst zou de server naar elk adres kunnen posten (SSRF).
const PUSH_HOSTS = [
	/^fcm\.googleapis\.com$/,
	/^updates\.push\.services\.mozilla\.com$/,
	/^web\.push\.apple\.com$/,
	/^[a-z0-9-]+\.push\.apple\.com$/,
	/^[a-z0-9-]+\.notify\.windows\.com$/
];

export function isAllowedEndpoint(endpoint: string): boolean {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return false;
	}
	return (
		url.protocol === 'https:' &&
		url.port === '' &&
		url.username === '' &&
		url.password === '' &&
		PUSH_HOSTS.some((host) => host.test(url.hostname))
	);
}
