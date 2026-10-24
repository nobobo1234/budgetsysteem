import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
