CREATE TABLE `warranties` (
	`id` text PRIMARY KEY NOT NULL,
	`product` text DEFAULT '' NOT NULL,
	`transaction_id` text NOT NULL,
	`receipt_id` text,
	`purchase_date` text NOT NULL,
	`delivery_date` text NOT NULL,
	`factory_until` text,
	`lifetime_years` integer NOT NULL,
	`status` text DEFAULT 'actief' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`discarded_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`receipt_id`) REFERENCES `receipts`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "warranties_dates" CHECK("warranties"."purchase_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND "warranties"."delivery_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND ("warranties"."factory_until" IS NULL OR "warranties"."factory_until" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
	CONSTRAINT "warranties_lifetime" CHECK("warranties"."lifetime_years" BETWEEN 1 AND 30),
	CONSTRAINT "warranties_product" CHECK("warranties"."status" = 'afgewezen' OR length(trim("warranties"."product")) > 0)
);
--> statement-breakpoint
CREATE INDEX `warranties_transaction_idx` ON `warranties` (`transaction_id`);--> statement-breakpoint
CREATE INDEX `warranties_receipt_idx` ON `warranties` (`receipt_id`);--> statement-breakpoint
CREATE INDEX `warranties_status_idx` ON `warranties` (`status`);--> statement-breakpoint
ALTER TABLE `categories` ADD `tracks_warranty` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Standaard aan voor Elektronica (spec: Datamodel, categories)
UPDATE `categories` SET `tracks_warranty` = 1 WHERE `name` = 'Elektronica';