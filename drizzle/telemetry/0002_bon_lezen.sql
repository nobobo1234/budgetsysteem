CREATE TABLE `receipt_reads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`receipt_id` text,
	`model` text NOT NULL,
	`parts` integer NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cost_nano_usd` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`outcome` text NOT NULL,
	`corrected` text,
	`corrected_sure` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `receipt_reads_at_idx` ON `receipt_reads` (`at`);--> statement-breakpoint
CREATE INDEX `receipt_reads_receipt_idx` ON `receipt_reads` (`receipt_id`);