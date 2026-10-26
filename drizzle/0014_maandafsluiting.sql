CREATE TABLE `month_closings` (
	`id` text PRIMARY KEY NOT NULL,
	`month` text NOT NULL,
	`closed_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`snapshot` text NOT NULL,
	`open_items` text NOT NULL,
	CONSTRAINT "month_closings_month_format" CHECK("month_closings"."month" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `month_closings_month_unique` ON `month_closings` (`month`);