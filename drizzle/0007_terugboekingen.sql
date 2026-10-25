ALTER TABLE `transactions` ADD `correction_of` text REFERENCES transactions(id) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `transactions` ADD `end_to_end_id` text;--> statement-breakpoint
CREATE INDEX `transactions_correction_idx` ON `transactions` (`correction_of`);--> statement-breakpoint
CREATE INDEX `transactions_end_to_end_idx` ON `transactions` (`counter_iban`,`end_to_end_id`);