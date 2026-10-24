import type { Conn, DB } from './db/index.ts';
import { auditLog } from './db/schema.ts';
import { log } from './log.ts';

export type SecurityEvent =
	| 'login'
	| 'login_mislukt'
	| 'herstelcode_gebruikt'
	| 'passkey_toegevoegd'
	| 'passkey_verwijderd'
	| 'sessie_ingetrokken'
	| 'herstelcode_vernieuwd'
	| 'setup_token_gebruikt'
	| 'rate_limit';

/** Beveiligingsgebeurtenis: in het audit-log en als logregel, zonder geheimen of persoonsgegevens. */
export function securityEvent(db: DB, action: SecurityEvent, entityId?: string): void {
	db.insert(auditLog).values({ kind: 'beveiliging', action, entityId }).run();
	log.info({ event: action }, 'beveiliging');
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
