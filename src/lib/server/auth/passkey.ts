import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type AuthenticationResponseJSON,
	type PublicKeyCredentialCreationOptionsJSON,
	type PublicKeyCredentialRequestOptionsJSON,
	type RegistrationResponseJSON
} from '@simplewebauthn/server';
import { and, eq, isNull } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { config } from '../config.ts';
import type { DB } from '../db/index.ts';
import { passkeys } from '../db/schema.ts';

// Volgens de OWASP Passkey Security Cheat Sheet: onderhouden library, user verification
// vereist, eenmalige challenges (de library maakt 32 bytes), exacte origin en RP ID,
// geen attestation en geen terugval naar een zwakkere methode.

const RP_NAME = 'Budget';

/** Vaste user handle: er is één gebruiker, en dezelfde handle voorkomt dubbele passkeys. */
function userId(): Uint8Array<ArrayBuffer> {
	const hash = createHash('sha256').update(`budget-user:${config().rpId}`).digest();
	return new Uint8Array(hash.subarray(0, 16));
}

export type Passkey = typeof passkeys.$inferSelect;

export function activePasskeys(db: DB): Passkey[] {
	return db.select().from(passkeys).where(isNull(passkeys.revokedAt)).all();
}

export async function registrationOptions(db: DB): Promise<PublicKeyCredentialCreationOptionsJSON> {
	return generateRegistrationOptions({
		rpName: RP_NAME,
		rpID: config().rpId,
		userID: userId(),
		userName: 'budget',
		userDisplayName: 'Budget',
		attestationType: 'none',
		excludeCredentials: activePasskeys(db).map((p) => ({
			id: p.id,
			transports: p.transports ?? undefined
		})),
		authenticatorSelection: {
			residentKey: 'required',
			userVerification: 'required'
		}
	});
}

export async function verifyRegistration(
	db: DB,
	response: RegistrationResponseJSON,
	expectedChallenge: string,
	deviceName: string
): Promise<Passkey | null> {
	const result = await verifyRegistrationResponse({
		response,
		expectedChallenge,
		expectedOrigin: config().origin,
		expectedRPID: config().rpId,
		requireUserVerification: true
	});
	if (!result.verified) return null;
	const { credential, credentialDeviceType, credentialBackedUp } = result.registrationInfo;
	return db
		.insert(passkeys)
		.values({
			id: credential.id,
			publicKey: Buffer.from(credential.publicKey),
			counter: credential.counter,
			transports: credential.transports ?? null,
			deviceType: credentialDeviceType,
			backedUp: credentialBackedUp,
			deviceName: deviceName.slice(0, 60)
		})
		.returning()
		.get();
}

export async function authenticationOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
	return generateAuthenticationOptions({
		rpID: config().rpId,
		userVerification: 'required'
	});
}

/** Controleert een login of herbevestiging. Geeft de passkey terug, of `null`. */
export async function verifyAuthentication(
	db: DB,
	response: AuthenticationResponseJSON,
	expectedChallenge: string
): Promise<Passkey | null> {
	if (typeof response?.id !== 'string' || response.id.length > 1024) return null;
	const passkey = db
		.select()
		.from(passkeys)
		.where(and(eq(passkeys.id, response.id), isNull(passkeys.revokedAt)))
		.get();
	if (!passkey) return null;

	const result = await verifyAuthenticationResponse({
		response,
		expectedChallenge,
		expectedOrigin: config().origin,
		expectedRPID: config().rpId,
		requireUserVerification: true,
		credential: {
			id: passkey.id,
			publicKey: new Uint8Array(passkey.publicKey),
			counter: passkey.counter,
			transports: passkey.transports ?? undefined
		}
	});
	if (!result.verified) return null;

	db.update(passkeys)
		.set({ counter: result.authenticationInfo.newCounter, lastUsedAt: new Date().toISOString() })
		.where(eq(passkeys.id, passkey.id))
		.run();
	return passkey;
}
