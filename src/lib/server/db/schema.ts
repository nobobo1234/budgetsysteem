import { sql } from 'drizzle-orm';
import {
	blob,
	check,
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex
} from 'drizzle-orm/sqlite-core';

// Alle ID's zijn willekeurige UUID's; bedragen altijd hele centen in euro.

const id = () =>
	text('id')
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID());
const createdAt = () =>
	text('created_at')
		.notNull()
		.default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`);

export const accounts = sqliteTable('accounts', {
	id: id(),
	name: text('name').notNull(),
	iban: text('iban').unique(),
	kind: text('kind', { enum: ['sns', 'revolut', 'anders'] }).notNull(),
	// Kort label voor snelinvoer, zoals `sns` of `rev`
	alias: text('alias').notNull().unique(),
	createdAt: createdAt()
});

export const categories = sqliteTable('categories', {
	id: id(),
	name: text('name').notNull().unique(),
	group: text('group').notNull(),
	countsForBudget: integer('counts_for_budget', { mode: 'boolean' }).notNull().default(true),
	sortOrder: integer('sort_order').notNull().default(0),
	archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
	createdAt: createdAt()
});

export const importBatches = sqliteTable('import_batches', {
	id: id(),
	format: text('format', { enum: ['camt053', 'csv', 'revolut'] }).notNull(),
	newCount: integer('new_count').notNull(),
	duplicateCount: integer('duplicate_count').notNull(),
	periodStart: text('period_start'),
	periodEnd: text('period_end'),
	createdAt: createdAt()
});

export const transactions = sqliteTable(
	'transactions',
	{
		id: id(),
		// Negatief is uitgaand, positief is inkomend
		amountCents: integer('amount_cents').notNull(),
		date: text('date').notNull(),
		counterparty: text('counterparty').notNull().default(''),
		counterIban: text('counter_iban'),
		description: text('description').notNull().default(''),
		categoryId: text('category_id').references(() => categories.id, { onDelete: 'set null' }),
		// Wie de categorie koos. Regels mogen een categorie van een regel overschrijven en
		// terugzetten, maar blijven af van een handmatige keuze en van eigen overboekingen.
		categorySource: text('category_source', { enum: ['handmatig', 'regel', 'intern'] }),
		categoryRuleId: text('category_rule_id').references(() => rules.id, { onDelete: 'set null' }),
		accountId: text('account_id')
			.notNull()
			.references(() => accounts.id),
		source: text('source', { enum: ['import', 'handmatig', 'bon', 'verwacht'] }).notNull(),
		bankReference: text('bank_reference').unique(),
		dedupeHash: text('dedupe_hash').unique(),
		importBatchId: text('import_batch_id').references(() => importBatches.id),
		origAmountCents: integer('orig_amount_cents'),
		origCurrency: text('orig_currency'),
		status: text('status', { enum: ['bevestigd', 'verwacht', 'te_controleren'] })
			.notNull()
			.default('bevestigd'),
		note: text('note').notNull().default(''),
		// De vaste last waar deze (verwachte) post bij hoort
		recurringId: text('recurring_id').references(() => recurring.id, { onDelete: 'set null' }),
		createdAt: createdAt(),
		updatedAt: text('updated_at')
	},
	(t) => [
		index('transactions_date_idx').on(t.date),
		index('transactions_recurring_idx').on(t.recurringId, t.date),
		index('transactions_category_date_idx').on(t.categoryId, t.date),
		index('transactions_counterparty_idx').on(t.counterparty),
		index('transactions_account_date_idx').on(t.accountId, t.date),
		check(
			'transactions_date_format',
			sql`${t.date} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`
		),
		check(
			'transactions_orig_currency',
			sql`(${t.origAmountCents} IS NULL) = (${t.origCurrency} IS NULL)`
		)
	]
);

export const transactionSplits = sqliteTable(
	'transaction_splits',
	{
		id: id(),
		transactionId: text('transaction_id')
			.notNull()
			.references(() => transactions.id, { onDelete: 'cascade' }),
		categoryId: text('category_id').references(() => categories.id, { onDelete: 'set null' }),
		amountCents: integer('amount_cents').notNull(),
		note: text('note').notNull().default('')
	},
	(t) => [index('transaction_splits_tx_idx').on(t.transactionId)]
);

export const rules = sqliteTable(
	'rules',
	{
		id: id(),
		field: text('field', { enum: ['tegenpartij', 'iban', 'omschrijving'] }).notNull(),
		// Genormaliseerd patroon; tegenpartij en omschrijving matchen op "bevat", IBAN exact
		pattern: text('pattern').notNull(),
		categoryId: text('category_id')
			.notNull()
			.references(() => categories.id, { onDelete: 'cascade' }),
		priority: integer('priority').notNull().default(100),
		createdAt: createdAt()
	},
	(t) => [uniqueIndex('rules_field_pattern_idx').on(t.field, t.pattern)]
);

export const budgets = sqliteTable(
	'budgets',
	{
		id: id(),
		month: text('month').notNull(),
		categoryId: text('category_id')
			.notNull()
			.references(() => categories.id, { onDelete: 'cascade' }),
		limitCents: integer('limit_cents').notNull()
	},
	(t) => [
		uniqueIndex('budgets_month_category_idx').on(t.month, t.categoryId),
		check('budgets_month_format', sql`${t.month} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'`),
		check('budgets_limit_positive', sql`${t.limitCents} >= 0`)
	]
);

export const receipts = sqliteTable('receipts', {
	id: id(),
	// Bestandsnaam is altijd een eigen UUID, nooit een pad uit invoer
	fileId: text('file_id').notNull(),
	source: text('source', { enum: ['app', 'deelmenu'] }).notNull(),
	status: text('status', { enum: ['wordt_gelezen', 'zeker', 'controleren', 'onzeker', 'fout'] })
		.notNull()
		.default('wordt_gelezen'),
	rawAiOutput: text('raw_ai_output', { mode: 'json' }),
	checkedFields: text('checked_fields', { mode: 'json' }),
	fieldConfidence: text('field_confidence', { mode: 'json' }),
	transactionId: text('transaction_id').references(() => transactions.id, {
		onDelete: 'set null'
	}),
	createdAt: createdAt()
});

export const recurring = sqliteTable(
	'recurring',
	{
		id: id(),
		// Genormaliseerde tegenpartij en tegen-IBAN: één vaste last (of voorstel) per sleutel
		matchKey: text('match_key').notNull(),
		counterparty: text('counterparty').notNull(),
		counterIban: text('counter_iban'),
		interval: text('interval', { enum: ['maand', 'kwartaal', 'halfjaar', 'jaar'] }).notNull(),
		expectedDay: integer('expected_day').notNull(),
		// Positieve centen: wat er afgaat
		medianCents: integer('median_cents').notNull(),
		minCents: integer('min_cents').notNull(),
		maxCents: integer('max_cents').notNull(),
		kind: text('kind', { enum: ['vast', 'wisselend'] }).notNull(),
		nextDate: text('next_date'),
		// Vorige afschrijving: voor halfjaarlijkse lasten met ongelijke semesters
		lastDate: text('last_date'),
		// Laatst bevestigde bedrag, voor het signaal prijsverhoging
		lastCents: integer('last_cents'),
		// Uitsmeren met een reservering per maand; maandelijkse lasten nooit
		spread: integer('spread', { mode: 'boolean' }).notNull().default(false),
		categoryId: text('category_id').references(() => categories.id, { onDelete: 'set null' }),
		accountId: text('account_id').references(() => accounts.id),
		status: text('status', { enum: ['voorstel', 'actief', 'gestopt', 'afgewezen'] })
			.notNull()
			.default('voorstel'),
		signal: text('signal', { enum: ['prijsverhoging', 'uitschieter'] }),
		signalFromCents: integer('signal_from_cents'),
		signalToCents: integer('signal_to_cents'),
		stoppedAt: text('stopped_at'),
		createdAt: createdAt(),
		updatedAt: text('updated_at')
	},
	(t) => [
		uniqueIndex('recurring_match_key_idx').on(t.matchKey),
		index('recurring_status_idx').on(t.status),
		check('recurring_expected_day', sql`${t.expectedDay} BETWEEN 1 AND 31`),
		check('recurring_amounts', sql`${t.minCents} >= 0 AND ${t.medianCents} >= 0`)
	]
);

// Reservering per vaste last per maand (spec: Vaste lasten die niet elke maand komen). Telt
// vanaf de eerste van de maand als uitgave in de categorie, maar is geen transactie.
export const reservations = sqliteTable(
	'reservations',
	{
		id: id(),
		recurringId: text('recurring_id')
			.notNull()
			.references(() => recurring.id, { onDelete: 'cascade' }),
		month: text('month').notNull(),
		// Opzij gezet in deze maand
		amountCents: integer('amount_cents').notNull(),
		// Uit de reservering gehaald in deze maand: bij de afschrijving, of bij stoppen
		drawnCents: integer('drawn_cents').notNull().default(0),
		// De afschrijving, alleen in de afschrijfmaand
		transactionId: text('transaction_id').references(() => transactions.id, {
			onDelete: 'set null'
		}),
		// De categorie van de vaste last in deze maand. Verandert die later, dan blijft een
		// afgesloten maand staan zoals hij was.
		categoryId: text('category_id').references(() => categories.id, { onDelete: 'set null' }),
		createdAt: createdAt()
	},
	(t) => [
		uniqueIndex('reservations_recurring_month_idx').on(t.recurringId, t.month),
		index('reservations_month_idx').on(t.month),
		check('reservations_month_format', sql`${t.month} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'`),
		check('reservations_amounts', sql`${t.amountCents} >= 0 AND ${t.drawnCents} >= 0`)
	]
);

// Personen met wie je geld voorschiet of deelt. Een IBAN hoort bij hooguit één persoon en is
// nooit een eigen rekening (gecontroleerd in people.ts). IBANs van anderen nooit in logs.
export const people = sqliteTable(
	'people',
	{
		id: id(),
		name: text('name').notNull(),
		active: integer('active', { mode: 'boolean' }).notNull().default(true),
		createdAt: createdAt()
	},
	(t) => [uniqueIndex('people_name_idx').on(sql`lower(${t.name})`)]
);

export const peopleIbans = sqliteTable(
	'people_ibans',
	{
		id: id(),
		personId: text('person_id')
			.notNull()
			.references(() => people.id, { onDelete: 'cascade' }),
		iban: text('iban').notNull().unique(),
		createdAt: createdAt()
	},
	(t) => [index('people_ibans_person_idx').on(t.personId)]
);

// Een openstaande post: wat iemand jou nog moet (te krijgen) of jij iemand (te betalen).
// Zonder persoon als je `voor 3` typte zonder namen; die kies je later op het overzicht.
// Betaald is wat in `owed_payments` staat; de status volgt daaruit.
export const owed = sqliteTable(
	'owed',
	{
		id: id(),
		personId: text('person_id').references(() => people.id),
		amountCents: integer('amount_cents').notNull(),
		direction: text('direction', { enum: ['te_krijgen', 'te_betalen'] }).notNull(),
		sourceTransactionId: text('source_transaction_id').references(() => transactions.id, {
			onDelete: 'set null'
		}),
		description: text('description').notNull().default(''),
		// Vanaf wanneer de post openstaat
		date: text('date').notNull(),
		status: text('status', { enum: ['open', 'deels', 'betaald', 'kwijtgescholden'] })
			.notNull()
			.default('open'),
		tikkieUrl: text('tikkie_url'),
		note: text('note').notNull().default(''),
		createdAt: createdAt()
	},
	(t) => [
		index('owed_person_status_idx').on(t.personId, t.status),
		index('owed_source_idx').on(t.sourceTransactionId),
		check('owed_amount_positive', sql`${t.amountCents} > 0`),
		check('owed_date_format', sql`${t.date} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`)
	]
);

// Wie wat betaalde voor welke post. Eén betaling kan meerdere posten dekken en een post kan
// uit meerdere betalingen komen. Zonder post is het tegoed, dat naar de volgende post gaat.
export const owedPayments = sqliteTable(
	'owed_payments',
	{
		id: id(),
		transactionId: text('transaction_id')
			.notNull()
			.references(() => transactions.id, { onDelete: 'cascade' }),
		personId: text('person_id')
			.notNull()
			.references(() => people.id),
		owedId: text('owed_id').references(() => owed.id, { onDelete: 'set null' }),
		amountCents: integer('amount_cents').notNull(),
		createdAt: createdAt()
	},
	(t) => [
		index('owed_payments_tx_idx').on(t.transactionId),
		index('owed_payments_owed_idx').on(t.owedId),
		index('owed_payments_person_idx').on(t.personId),
		check('owed_payments_amount_positive', sql`${t.amountCents} > 0`)
	]
);

export const passkeys = sqliteTable('passkeys', {
	// Credential-ID (base64url) zoals de authenticator hem teruggeeft
	id: text('id').primaryKey(),
	publicKey: blob('public_key', { mode: 'buffer' }).notNull(),
	counter: integer('counter').notNull().default(0),
	transports: text('transports', { mode: 'json' }).$type<string[]>(),
	deviceType: text('device_type').notNull(),
	backedUp: integer('backed_up', { mode: 'boolean' }).notNull(),
	deviceName: text('device_name').notNull(),
	createdAt: createdAt(),
	lastUsedAt: text('last_used_at'),
	revokedAt: text('revoked_at')
});

export const sessions = sqliteTable(
	'sessions',
	{
		// SHA-256 van het sessie-ID; het ID zelf staat alleen in de cookie
		idHash: text('id_hash').primaryKey(),
		passkeyId: text('passkey_id').references(() => passkeys.id),
		deviceName: text('device_name').notNull(),
		createdAt: createdAt(),
		expiresAt: text('expires_at').notNull(),
		lastUsedAt: text('last_used_at'),
		// Laatste keer dat de passkey opnieuw is bevestigd, voor gevoelige acties
		reauthAt: text('reauth_at'),
		revokedAt: text('revoked_at')
	},
	(t) => [index('sessions_expires_idx').on(t.expiresAt)]
);

export const recoveryCodes = sqliteTable('recovery_codes', {
	id: id(),
	codeHash: text('code_hash').notNull(),
	createdAt: createdAt(),
	usedAt: text('used_at')
});

export const setupTokens = sqliteTable('setup_tokens', {
	tokenHash: text('token_hash').primaryKey(),
	expiresAt: text('expires_at').notNull(),
	usedAt: text('used_at'),
	createdAt: createdAt()
});

export const jobs = sqliteTable(
	'jobs',
	{
		id: id(),
		kind: text('kind').notNull(),
		payload: text('payload', { mode: 'json' }),
		status: text('status', { enum: ['wachtend', 'bezig', 'klaar', 'mislukt'] })
			.notNull()
			.default('wachtend'),
		attempts: integer('attempts').notNull().default(0),
		runAt: text('run_at').notNull(),
		lastError: text('last_error'),
		createdAt: createdAt()
	},
	(t) => [index('jobs_status_run_at_idx').on(t.status, t.runAt)]
);

export const auditLog = sqliteTable(
	'audit_log',
	{
		id: id(),
		at: createdAt(),
		kind: text('kind', { enum: ['wijziging', 'beveiliging'] }).notNull(),
		action: text('action').notNull(),
		entity: text('entity'),
		entityId: text('entity_id'),
		before: text('before', { mode: 'json' }),
		after: text('after', { mode: 'json' })
	},
	(t) => [index('audit_log_at_idx').on(t.at)]
);

// Saldocheck (spec: Dagelijks gebruik). Het anker is het startsaldo van een rekening: het saldo
// aan het eind van `date`. Het verwachte saldo is het anker plus alles wat daarna geboekt is.
export const balanceAnchors = sqliteTable(
	'balance_anchors',
	{
		id: id(),
		accountId: text('account_id')
			.notNull()
			.unique()
			.references(() => accounts.id, { onDelete: 'cascade' }),
		date: text('date').notNull(),
		amountCents: integer('amount_cents').notNull(),
		source: text('source', { enum: ['import', 'handmatig'] }).notNull(),
		importBatchId: text('import_batch_id').references(() => importBatches.id, {
			onDelete: 'set null'
		}),
		createdAt: createdAt(),
		updatedAt: text('updated_at')
	},
	(t) => [
		check(
			'balance_anchors_date_format',
			sql`${t.date} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`
		)
	]
);

/** Het echte saldo volgens de bank, aan het eind van `date`. Het verschil rekent de app live uit. */
export const balanceChecks = sqliteTable(
	'balance_checks',
	{
		id: id(),
		accountId: text('account_id')
			.notNull()
			.references(() => accounts.id, { onDelete: 'cascade' }),
		date: text('date').notNull(),
		amountCents: integer('amount_cents').notNull(),
		createdAt: createdAt(),
		updatedAt: text('updated_at')
	},
	(t) => [
		uniqueIndex('balance_checks_account_date_idx').on(t.accountId, t.date),
		check(
			'balance_checks_date_format',
			sql`${t.date} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`
		)
	]
);

// Pushmeldingen (spec: Dagelijks gebruik → Meldingen). Eén abonnement per apparaat; endpoint en
// sleutels komen van de push-dienst van de browser en staan nooit in een logregel.
export const pushSubscriptions = sqliteTable('push_subscriptions', {
	id: id(),
	endpoint: text('endpoint').notNull().unique(),
	// Publieke sleutel (P-256) en auth-geheim van het apparaat, base64url
	p256dh: text('p256dh').notNull(),
	auth: text('auth').notNull(),
	deviceName: text('device_name').notNull(),
	// Sessie van het apparaat. Is die verlopen of ingetrokken (telefoon kwijt), dan krijgt het
	// apparaat geen meldingen meer en wordt het abonnement opgeruimd.
	sessionIdHash: text('session_id_hash').references(() => sessions.idHash, {
		onDelete: 'cascade'
	}),
	createdAt: createdAt(),
	lastSentAt: text('last_sent_at')
});

// Schakelaar per soort melding, plus `vergrendelscherm` (bedragen en namen tonen). Ontbreekt een
// rij, dan geldt de standaard uit src/lib/notifications.ts.
export const notificationSettings = sqliteTable('notification_settings', {
	key: text('key').primaryKey(),
	enabled: integer('enabled', { mode: 'boolean' }).notNull()
});

// Ontdubbelen: een melding met dezelfde soort en sleutel gaat maar één keer uit, tot de sleutel
// is vrijgegeven (bij telemetrie: als het probleem is opgelost). Na 90 dagen opgeruimd.
export const notificationsSent = sqliteTable(
	'notifications_sent',
	{
		kind: text('kind').notNull(),
		key: text('key').notNull(),
		sentAt: createdAt()
	},
	(t) => [
		uniqueIndex('notifications_sent_kind_key_idx').on(t.kind, t.key),
		index('notifications_sent_at_idx').on(t.sentAt)
	]
);
