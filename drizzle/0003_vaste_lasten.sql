CREATE TABLE `reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`recurring_id` text NOT NULL,
	`month` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`drawn_cents` integer DEFAULT 0 NOT NULL,
	`transaction_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`recurring_id`) REFERENCES `recurring`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "reservations_month_format" CHECK("reservations"."month" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "reservations_amounts" CHECK("reservations"."amount_cents" >= 0 AND "reservations"."drawn_cents" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reservations_recurring_month_idx` ON `reservations` (`recurring_id`,`month`);--> statement-breakpoint
CREATE INDEX `reservations_month_idx` ON `reservations` (`month`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_recurring` (
	`id` text PRIMARY KEY NOT NULL,
	`match_key` text NOT NULL,
	`counterparty` text NOT NULL,
	`counter_iban` text,
	`interval` text NOT NULL,
	`expected_day` integer NOT NULL,
	`median_cents` integer NOT NULL,
	`min_cents` integer NOT NULL,
	`max_cents` integer NOT NULL,
	`kind` text NOT NULL,
	`next_date` text,
	`last_date` text,
	`last_cents` integer,
	`spread` integer DEFAULT false NOT NULL,
	`category_id` text,
	`account_id` text,
	`status` text DEFAULT 'voorstel' NOT NULL,
	`signal` text,
	`signal_from_cents` integer,
	`signal_to_cents` integer,
	`stopped_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "recurring_expected_day" CHECK("expected_day" BETWEEN 1 AND 31),
	CONSTRAINT "recurring_amounts" CHECK("min_cents" >= 0 AND "median_cents" >= 0)
);
--> statement-breakpoint
-- Vóór deze migratie werd `recurring` nog niet gebruikt; bestaande rijen krijgen een eigen sleutel
INSERT INTO `__new_recurring`("id", "match_key", "counterparty", "counter_iban", "interval", "expected_day", "median_cents", "min_cents", "max_cents", "kind", "next_date", "category_id", "account_id", "status", "created_at") SELECT "id", 'oud:' || "id", "counterparty", "counter_iban", "interval", "expected_day", "median_cents", "min_cents", "max_cents", "kind", "next_date", "category_id", "account_id", "status", "created_at" FROM `recurring`;--> statement-breakpoint
DROP TABLE `recurring`;--> statement-breakpoint
ALTER TABLE `__new_recurring` RENAME TO `recurring`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `recurring_match_key_idx` ON `recurring` (`match_key`);--> statement-breakpoint
CREATE INDEX `recurring_status_idx` ON `recurring` (`status`);--> statement-breakpoint
ALTER TABLE `transactions` ADD `recurring_id` text REFERENCES recurring(id) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
CREATE INDEX `transactions_recurring_idx` ON `transactions` (`recurring_id`,`date`);