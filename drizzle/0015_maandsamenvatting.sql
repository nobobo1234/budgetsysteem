CREATE TABLE `month_summaries` (
	`id` text PRIMARY KEY NOT NULL,
	`month` text NOT NULL,
	`facts_key` text NOT NULL,
	`facts` text NOT NULL,
	`sentences` text NOT NULL,
	`source` text NOT NULL,
	`reason` text,
	`calls` integer DEFAULT 0 NOT NULL,
	`telemetry_ref` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text,
	CONSTRAINT "month_summaries_month_format" CHECK("month_summaries"."month" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "month_summaries_calls" CHECK("month_summaries"."calls" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `month_summaries_month_unique` ON `month_summaries` (`month`);