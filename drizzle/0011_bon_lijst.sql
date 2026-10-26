CREATE TABLE `receipt_items` (
	`id` text PRIMARY KEY NOT NULL,
	`receipt_id` text NOT NULL,
	`position` integer NOT NULL,
	`date` text,
	`counterparty` text,
	`amount_cents` integer,
	`currency` text,
	`confidence` text,
	`transaction_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`receipt_id`) REFERENCES `receipts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `receipt_items_position_idx` ON `receipt_items` (`receipt_id`,`position`);--> statement-breakpoint
CREATE INDEX `receipt_items_transaction_idx` ON `receipt_items` (`transaction_id`);--> statement-breakpoint
ALTER TABLE `receipts` ADD `kind` text DEFAULT 'bon' NOT NULL;