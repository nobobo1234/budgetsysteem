ALTER TABLE `receipts` ADD `failure` text;--> statement-breakpoint
ALTER TABLE `receipts` ADD `read_at` text;--> statement-breakpoint
ALTER TABLE `receipts` ADD `handled_at` text;--> statement-breakpoint
CREATE INDEX `receipts_transaction_idx` ON `receipts` (`transaction_id`);--> statement-breakpoint
CREATE INDEX `receipts_status_idx` ON `receipts` (`status`,`handled_at`);