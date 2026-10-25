CREATE TABLE `recurring_shares` (
	`id` text PRIMARY KEY NOT NULL,
	`recurring_id` text NOT NULL,
	`person_id` text NOT NULL,
	`kind` text NOT NULL,
	`amount_cents` integer,
	`basis_points` integer,
	`receive_day` integer NOT NULL,
	`start_month` text NOT NULL,
	`end_month` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text,
	FOREIGN KEY (`recurring_id`) REFERENCES `recurring`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "recurring_shares_amount" CHECK(("recurring_shares"."kind" = 'vast' AND "recurring_shares"."amount_cents" > 0 AND "recurring_shares"."basis_points" IS NULL) OR ("recurring_shares"."kind" = 'percentage' AND "recurring_shares"."basis_points" BETWEEN 1 AND 10000 AND "recurring_shares"."amount_cents" IS NULL)),
	CONSTRAINT "recurring_shares_receive_day" CHECK("recurring_shares"."receive_day" BETWEEN 1 AND 31),
	CONSTRAINT "recurring_shares_months" CHECK("recurring_shares"."start_month" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND ("recurring_shares"."end_month" IS NULL OR ("recurring_shares"."end_month" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND "recurring_shares"."end_month" >= "recurring_shares"."start_month")))
);
--> statement-breakpoint
CREATE INDEX `recurring_shares_recurring_idx` ON `recurring_shares` (`recurring_id`);--> statement-breakpoint
CREATE INDEX `recurring_shares_person_idx` ON `recurring_shares` (`person_id`);--> statement-breakpoint
CREATE TABLE `share_dismissals` (
	`id` text PRIMARY KEY NOT NULL,
	`recurring_id` text NOT NULL,
	`counter_iban` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`recurring_id`) REFERENCES `recurring`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `share_dismissals_idx` ON `share_dismissals` (`recurring_id`,`counter_iban`);--> statement-breakpoint
-- Geen nieuwe tabel voor `owed`: de migrator draait met foreign keys aan in één transactie,
-- en dan zou het weggooien van de oude tabel de koppelingen in `owed_payments` leegmaken.
ALTER TABLE `owed` ADD `share_id` text REFERENCES recurring_shares(id);--> statement-breakpoint
ALTER TABLE `owed` ADD `month` text CONSTRAINT "owed_share_month" CHECK(("share_id" IS NULL) = ("month" IS NULL));--> statement-breakpoint
CREATE UNIQUE INDEX `owed_share_month_idx` ON `owed` (`share_id`,`month`);