CREATE TABLE `owed_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`transaction_id` text NOT NULL,
	`person_id` text NOT NULL,
	`owed_id` text,
	`amount_cents` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owed_id`) REFERENCES `owed`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "owed_payments_amount_positive" CHECK("owed_payments"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE INDEX `owed_payments_tx_idx` ON `owed_payments` (`transaction_id`);--> statement-breakpoint
CREATE INDEX `owed_payments_owed_idx` ON `owed_payments` (`owed_id`);--> statement-breakpoint
CREATE INDEX `owed_payments_person_idx` ON `owed_payments` (`person_id`);--> statement-breakpoint
CREATE TABLE `people` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `people_name_idx` ON `people` (lower("name"));--> statement-breakpoint
CREATE TABLE `people_ibans` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`iban` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `people_ibans_iban_unique` ON `people_ibans` (`iban`);--> statement-breakpoint
CREATE INDEX `people_ibans_person_idx` ON `people_ibans` (`person_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_owed` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text,
	`amount_cents` integer NOT NULL,
	`direction` text NOT NULL,
	`source_transaction_id` text,
	`description` text DEFAULT '' NOT NULL,
	`date` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`tikkie_url` text,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "owed_amount_positive" CHECK("__new_owed"."amount_cents" > 0),
	CONSTRAINT "owed_date_format" CHECK("__new_owed"."date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
);
--> statement-breakpoint
-- Bestaande posten hadden een naam als tekst. Elke naam wordt een persoon (hoofdletters maken
-- niet uit); "2 anderen" van `voor 3` zonder namen wordt een post zonder persoon.
INSERT INTO `people` (`id`, `name`)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), min(trim(`person`)) FROM `owed`
WHERE trim(`person`) != '' AND trim(`person`) NOT GLOB '[0-9]* anderen'
GROUP BY lower(trim(`person`));--> statement-breakpoint
INSERT INTO `__new_owed`("id", "person_id", "amount_cents", "direction", "source_transaction_id", "description", "date", "status", "note", "created_at")
SELECT o."id", p."id", o."amount_cents", o."direction", o."source_transaction_id",
	coalesce(t."counterparty", ''), coalesce(t."date", substr(o."created_at", 1, 10)), o."status", o."note", o."created_at"
FROM `owed` o
LEFT JOIN `people` p ON lower(p."name") = lower(trim(o."person"))
LEFT JOIN `transactions` t ON t."id" = o."source_transaction_id"
WHERE o."amount_cents" > 0;--> statement-breakpoint
-- Betaald-via-transactie wordt een betaling in `owed_payments`. Eerst apart zetten: het
-- verwijderen van de oude tabel zou een koppeling naar een post anders leegmaken.
CREATE TABLE `__owed_paid` AS
SELECT o."id" AS owed_id, o."paid_via_transaction_id" AS transaction_id, n."person_id" AS person_id, o."amount_cents" AS amount_cents
FROM `owed` o JOIN `__new_owed` n ON n."id" = o."id"
JOIN `transactions` t ON t."id" = o."paid_via_transaction_id"
WHERE n."person_id" IS NOT NULL AND o."status" = 'betaald';--> statement-breakpoint
DROP TABLE `owed`;--> statement-breakpoint
ALTER TABLE `__new_owed` RENAME TO `owed`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
INSERT INTO `owed_payments` (`id`, `transaction_id`, `person_id`, `owed_id`, `amount_cents`)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), transaction_id, person_id, owed_id, amount_cents FROM `__owed_paid`;--> statement-breakpoint
DROP TABLE `__owed_paid`;--> statement-breakpoint
CREATE INDEX `owed_person_status_idx` ON `owed` (`person_id`,`status`);--> statement-breakpoint
CREATE INDEX `owed_source_idx` ON `owed` (`source_transaction_id`);