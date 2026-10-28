// Maakt een VAPID-sleutelpaar voor pushmeldingen (RFC 8292), zonder extra dependencies.
// Uitvoer in de vorm van .env-regels: de publieke sleutel als ongecomprimeerd P-256-punt
// (65 bytes) en de privésleutel (32 bytes), beide base64url. Dat is de vorm die
// src/lib/server/config.ts verwacht.
//
// In de draaiende app-container, zodat er geen Node op de VPS nodig is, en direct in .env:
//   docker compose exec -T app node --input-type=module < vapid-keys.mjs >> .env
// Of met Node 24 op je eigen machine: node vapid-keys.mjs
import { generateKeyPairSync } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pub = publicKey.export({ format: 'jwk' });
const raw = Buffer.concat([
	Buffer.from([4]),
	Buffer.from(pub.x, 'base64url'),
	Buffer.from(pub.y, 'base64url')
]);

console.log(`VAPID_PUBLIC_KEY=${raw.toString('base64url')}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey.export({ format: 'jwk' }).d}`);
