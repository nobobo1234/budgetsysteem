CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text,
	`hue` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text,
	CONSTRAINT "tags_start_format" CHECK("tags"."start_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "tags_end_format" CHECK("tags"."end_date" IS NULL OR "tags"."end_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "tags_period" CHECK("tags"."end_date" IS NULL OR "tags"."end_date" >= "tags"."start_date"),
	CONSTRAINT "tags_hue" CHECK("tags"."hue" BETWEEN 0 AND 359)
);
--> statement-breakpoint
CREATE INDEX `tags_start_idx` ON `tags` (`start_date`);--> statement-breakpoint
CREATE TABLE `transaction_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`transaction_id` text NOT NULL,
	`tag_id` text NOT NULL,
	`source` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "transaction_tags_auto_active" CHECK("transaction_tags"."source" = 'handmatig' OR "transaction_tags"."active" = 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transaction_tags_tx_tag_idx` ON `transaction_tags` (`transaction_id`,`tag_id`);--> statement-breakpoint
CREATE INDEX `transaction_tags_tag_idx` ON `transaction_tags` (`tag_id`);