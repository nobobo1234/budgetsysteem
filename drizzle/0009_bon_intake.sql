CREATE TABLE `upload_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`last_used_at` text,
	`blocked_until` text,
	`revoked_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `upload_tokens_token_hash_unique` ON `upload_tokens` (`token_hash`);--> statement-breakpoint
ALTER TABLE `receipts` ADD `media_type` text DEFAULT 'image/jpeg' NOT NULL;--> statement-breakpoint
ALTER TABLE `receipts` ADD `upload_token_id` text REFERENCES upload_tokens(id) ON DELETE set null;