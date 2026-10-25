import { startAuthentication } from '@simplewebauthn/browser';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { passkeyErrorMessage, postJson } from './api.ts';

export type ReauthResult = { ok: true } | { ok: false; message: string };

/**
 * Gevoelige acties vragen altijd opnieuw om je passkey (spec: Beveiliging, laag 3): passkeys
 * beheren, een herstelcode of een upload-token maken. De server onthoudt de bevestiging vijf
 * minuten voor deze sessie.
 */
export async function reauth(state: {
	/** Aantal actieve passkeys */
	passkeys: number;
	/** Of deze sessie net bevestigd is (na inloggen met de herstelcode) */
	reauthFresh: boolean;
}): Promise<ReauthResult> {
	// Na inloggen met de herstelcode is er nog geen passkey; die sessie is net bevestigd
	if (state.passkeys === 0) {
		return state.reauthFresh
			? { ok: true }
			: { ok: false, message: 'Voeg eerst een passkey toe bij Beveiliging.' };
	}
	const options = await postJson<PublicKeyCredentialRequestOptionsJSON>('/api/auth/reauth/options');
	if (!options.ok) return { ok: false, message: options.message };
	try {
		const response = await startAuthentication({ optionsJSON: options.data });
		const result = await postJson('/api/auth/reauth/verify', response);
		return result.ok ? { ok: true } : { ok: false, message: result.message };
	} catch (e) {
		return { ok: false, message: passkeyErrorMessage(e) };
	}
}
