CREATE TABLE `errors` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`source` text NOT NULL,
	`name` text NOT NULL,
	`route` text,
	`method` text,
	`fingerprint` text NOT NULL,
	`frames` text
);
--> statement-breakpoint
CREATE INDEX `errors_at_idx` ON `errors` (`at`);--> statement-breakpoint
CREATE INDEX `errors_fingerprint_idx` ON `errors` (`fingerprint`);--> statement-breakpoint
CREATE TABLE `starts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`version` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `starts_at_idx` ON `starts` (`at`);