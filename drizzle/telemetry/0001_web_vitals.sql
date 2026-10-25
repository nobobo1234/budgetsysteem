CREATE TABLE `web_vitals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`name` text NOT NULL,
	`value` real NOT NULL
);
--> statement-breakpoint
CREATE INDEX `web_vitals_at_idx` ON `web_vitals` (`at`);