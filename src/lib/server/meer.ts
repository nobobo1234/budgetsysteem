import { and, count, eq, isNull, ne } from 'drizzle-orm';
import { toIsoDate } from '#lib/dates.ts';
import { activePasskeys } from './auth/passkey.ts';
import { hasRecoveryCode } from './auth/recovery.ts';
import { balanceCheckDue } from './balance.ts';
import { config } from './config.ts';
import type { DB } from './db/index.ts';
import { db as appDb } from './db/index.ts';
import { accounts, categories, people, receipts, rules } from './db/schema.ts';
import { owedSummary } from './owed.ts';
import { currentShortcutStatus, needsRenewal } from './receipts/shortcut-download.ts';
import { activeUploadTokens, isBlocked } from './receipts/tokens.ts';
import { listDevices } from './push/subscriptions.ts';
import { recurringOverview } from './recurring.ts';
import { sharesOverview } from './shares.ts';
import { tagsTile } from './tags.ts';
import { collectHealth, healthPaths } from './telemetry/health.ts';
import { telemetryDb } from './telemetry/index.ts';
import { attention } from './telemetry/status.ts';

// Wat de tegels op Meer laten zien, en of de tab Meer een stip krijgt (spec: Schermen, Navigatie).
// Alleen tellingen en totalen; geen IBANs of omschrijvingen.

function statusAttention(): number {
	const health = collectHealth({
		db: appDb,
		telemetry: telemetryDb(),
		paths: healthPaths(config().DATABASE_PATH)
	});
	return attention(health).length;
}

/**
 * Vraagt iets in Meer aandacht: een saldocheck, een probleem op de statuspagina, geen herstelcode,
 * of de iOS-opdracht moet binnen een maand opnieuw ondertekend worden.
 */
export function meerNeedsAttention(db: DB, today = toIsoDate(new Date())): boolean {
	return (
		balanceCheckDue(db, today).length > 0 ||
		!hasRecoveryCode(db) ||
		statusAttention() > 0 ||
		needsRenewal(currentShortcutStatus())
	);
}

export function meerTiles(db: DB, today = toIsoDate(new Date())) {
	const owed = owedSummary(db);
	const fixed = recurringOverview(db, today);
	const shares = sharesOverview(db, today);
	const tokens = activeUploadTokens(db);
	return {
		owed,
		fixed: {
			perMonthCents: fixed.totalPerMonthCents,
			active: fixed.active.length,
			proposals: fixed.proposals.length
		},
		shares: { arrearsCents: shares.arrearsCents, lasts: shares.lasts.length },
		balanceDue: balanceCheckDue(db, today).map((a) => a.name),
		categories:
			db.select({ n: count() }).from(categories).where(eq(categories.archived, false)).get()?.n ??
			0,
		rules: db.select({ n: count() }).from(rules).get()?.n ?? 0,
		people: db.select({ n: count() }).from(people).where(eq(people.active, true)).get()?.n ?? 0,
		devices: listDevices(db).length,
		accounts: db
			.select({ name: accounts.name })
			.from(accounts)
			.all()
			.map((a) => a.name),
		passkeys: activePasskeys(db).length,
		uploadTokens: {
			count: tokens.length,
			blocked: tokens.some((t) => isBlocked(t)),
			renewShortcut: needsRenewal(currentShortcutStatus())
		},
		receipts: {
			total: db.select({ n: count() }).from(receipts).get()?.n ?? 0,
			waiting:
				db
					.select({ n: count() })
					.from(receipts)
					.where(and(isNull(receipts.handledAt), ne(receipts.status, 'wordt_gelezen')))
					.get()?.n ?? 0
		},
		tags: tagsTile(db, today),
		recoveryCode: hasRecoveryCode(db),
		statusAttention: statusAttention()
	};
}
