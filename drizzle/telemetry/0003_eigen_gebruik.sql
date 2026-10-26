CREATE TABLE `usage_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`day` text NOT NULL,
	`kind` text NOT NULL,
	`duration_ms` integer
);
--> statement-breakpoint
CREATE INDEX `usage_entries_at_idx` ON `usage_entries` (`at`);--> statement-breakpoint
CREATE INDEX `usage_entries_day_idx` ON `usage_entries` (`day`);