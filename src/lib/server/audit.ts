import type { Conn, DB } from './db/index.ts';
import { auditLog } from './db/schema.ts';
import { log } from './log.ts';
import { notify, type NotifyMessage } from './push/notify.ts';

export type SecurityEvent =
	| 'login'
	| 'login_mislukt'
	| 'herstelcode_gebruikt'
	| 'passkey_toegevoegd'
	| 'passkey_verwijderd'
	| 'sessie_ingetrokken'
	| 'herstelcode_vernieuwd'
	| 'setup_token_gebruikt'
	| 'upload_token_aangemaakt'
	| 'upload_token_ingetrokken'
	| 'upload_token_gebruikt'
	| 'upload_token_geblokkeerd'
	| 'rate_limit';

// De belangrijkste gebeurtenissen krijgen ook een pushmelding (spec: OWASP A09, Passkeys):
// zo merk je het als iemand anders een passkey toevoegt of met je herstelcode binnenkomt.
const PUSH: Partial<Record<SecurityEvent, NotifyMessage>> = {
	passkey_toegevoegd: {
		text: 'Er is een passkey toegevoegd. Was jij dit niet? Verwijder hem bij Beveiliging.',
		url: '/instellingen/beveiliging'
	},
	herstelcode_gebruikt: {
		text: 'Er is ingelogd met je herstelcode. Was jij dit niet? Trek de sessie in bij Beveiliging.',
		url: '/instellingen/beveiliging'
	},
	upload_token_aangemaakt: {
		text: 'Er is een upload-token aangemaakt. Was jij dit niet? Trek hem in bij Apparaten.',
		url: '/instellingen/apparaten'
	},
	upload_token_geblokkeerd: {
		text: 'Een upload-token stuurde meer dan 30 bonnen in een uur en is een uur geblokkeerd.',
		url: '/instellingen/apparaten'
	}
};

/** Beveiligingsgebeurtenis: in het audit-log en als logregel, zonder geheimen of persoonsgegevens. */
export function securityEvent(db: DB, action: SecurityEvent, entityId?: string): void {
	db.insert(auditLog).values({ kind: 'beveiliging', action, entityId }).run();
	log.info({ event: action }, 'beveiliging');
	const message = PUSH[action];
	if (message) void notify('beveiliging', message, db);
}

/** Wijziging met oude en nieuwe waarde, zodat hij later ongedaan gemaakt kan worden. */
export function recordChange(
	db: Conn,
	action: string,
	entity: string,
	entityId: string,
	before: unknown,
	after: unknown
): void {
	db.insert(auditLog).values({ kind: 'wijziging', action, entity, entityId, before, after }).run();
}
