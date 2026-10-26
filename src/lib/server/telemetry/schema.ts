import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { ENTRY_KINDS } from '../../usage.ts';

// Telemetrie staat in een aparte database (spec: Telemetrie en monitoring) en wordt na
// 90 dagen opgeruimd. Nooit persoonsgegevens: geen foutmeldingen, geen invoer, alleen soort
// fout, route en stackframes.

const at = () =>
	text('at')
		.notNull()
		.default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`);

export const errors = sqliteTable(
	'errors',
	{
		// Zelfde ID als het errorId dat de client ziet, zodat je een melding kunt terugvinden
		id: text('id').primaryKey(),
		at: at(),
		source: text('source', { enum: ['verzoek', 'proces'] }).notNull(),
		// Klasse van de fout, zoals `TypeError`
		name: text('name').notNull(),
		route: text('route'),
		method: text('method'),
		// Hash van soort, route en bovenste stackframe: groepeert dezelfde fout
		fingerprint: text('fingerprint').notNull(),
		frames: text('frames')
	},
	(t) => [index('errors_at_idx').on(t.at), index('errors_fingerprint_idx').on(t.fingerprint)]
);

/** Elke start van de app. Vaker dan de uitrollen betekent dat de container herstart is. */
export const starts = sqliteTable(
	'starts',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		at: at(),
		version: text('version').notNull()
	},
	(t) => [index('starts_at_idx').on(t.at)]
);

/**
 * Web-vitals uit de PWA (spec: Telemetrie en monitoring, Snelheid in de praktijk): alleen de
 * naam van de meting en de waarde, geen pagina, apparaat of sessie.
 */
export const VITAL_NAMES = ['LCP', 'INP', 'CLS', 'FCP', 'TTFB'] as const;
export type VitalName = (typeof VITAL_NAMES)[number];

export const webVitals = sqliteTable(
	'web_vitals',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		at: at(),
		name: text('name', { enum: VITAL_NAMES }).notNull(),
		// Milliseconden; CLS is een score zonder eenheid
		value: real('value').notNull()
	},
	(t) => [index('web_vitals_at_idx').on(t.at)]
);

/**
 * Eén Haiku-aanroep per bon (spec: Telemetrie en monitoring, AI): tokens, kosten, duur en
 * uitkomst, en later of je velden corrigeerde. Alleen het ID van de bon, nooit wat erop staat.
 */
export const RECEIPT_OUTCOMES = [
	'zeker',
	'controleren',
	'onzeker',
	'weigering',
	'afgekapt',
	'ongeldig',
	'fout'
] as const;
export type ReceiptReadOutcome = (typeof RECEIPT_OUTCOMES)[number];

export const receiptReads = sqliteTable(
	'receipt_reads',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		at: at(),
		receiptId: text('receipt_id'),
		model: text('model').notNull(),
		parts: integer('parts').notNull(),
		inputTokens: integer('input_tokens').notNull(),
		outputTokens: integer('output_tokens').notNull(),
		// Nano-dollars, zodat er nooit afgerond hoeft te worden
		costNanoUsd: integer('cost_nano_usd').notNull(),
		durationMs: integer('duration_ms').notNull(),
		outcome: text('outcome', { enum: RECEIPT_OUTCOMES }).notNull(),
		// Achteraf gecorrigeerde velden, zoals `totaal,datum`; leeg als niets gecorrigeerd is
		corrected: text('corrected'),
		// Een veld dat Haiku zeker noemde en de controles haalde, was toch fout
		correctedSure: integer('corrected_sure', { mode: 'boolean' }).notNull().default(false)
	},
	(t) => [
		index('receipt_reads_at_idx').on(t.at),
		index('receipt_reads_receipt_idx').on(t.receiptId)
	]
);

/**
 * Je eigen gebruik (spec: Telemetrie en monitoring, Volhouden): één rij per invoer, met de dag
 * waarop je hem invoerde, de soort en hoe lang het duurde van het openen van de app tot het
 * opslaan. Nooit een bedrag, tegenpartij of welke transactie het was.
 */

export const usageEntries = sqliteTable(
	'usage_entries',
	{
		// Willekeurig ID van de client: opnieuw versturen telt niet dubbel
		id: text('id').primaryKey(),
		at: at(),
		// Dag van invoeren in lokale tijd (`YYYY-MM-DD`), ook als hij pas later synchroniseert
		day: text('day').notNull(),
		kind: text('kind', { enum: ENTRY_KINDS }).notNull(),
		// Van openen of terugkeren naar de voorgrond tot opslaan; leeg na de eerste invoer
		durationMs: integer('duration_ms')
	},
	(t) => [index('usage_entries_at_idx').on(t.at), index('usage_entries_day_idx').on(t.day)]
);
