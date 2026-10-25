export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

/** POST met JSON naar onze eigen API. Netwerkfouten geven status 0. */
export function postJson<T = unknown>(url: string, body: unknown = {}): Promise<ApiResult<T>> {
	return sendJson<T>('POST', url, body);
}

/** Verzoek met JSON naar onze eigen API. Netwerkfouten geven status 0. */
export async function sendJson<T = unknown>(
	method: 'POST' | 'DELETE',
	url: string,
	body: unknown = {}
): Promise<ApiResult<T>> {
	let response: Response;
	try {
		response = await fetch(url, {
			method,
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
			credentials: 'same-origin'
		});
	} catch {
		return { ok: false, status: 0, message: 'Geen verbinding' };
	}
	const data = (await response.json().catch(() => null)) as { message?: string } | null;
	if (!response.ok) {
		return { ok: false, status: response.status, message: data?.message ?? 'Er ging iets mis' };
	}
	return { ok: true, data: data as T };
}

/** Meldingen van de passkey-API van de browser in gewone taal. */
export function passkeyErrorMessage(e: unknown): string {
	const name = e instanceof Error ? e.name : '';
	if (name === 'NotAllowedError' || name === 'AbortError') return 'Geannuleerd of verlopen.';
	if (name === 'InvalidStateError') return 'Deze passkey staat al op dit apparaat.';
	if (name === 'NotSupportedError') return 'Deze browser ondersteunt geen passkeys.';
	return 'De passkey werkte niet. Probeer het opnieuw.';
}
