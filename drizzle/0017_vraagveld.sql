CREATE TABLE `questions` (
	`id` text PRIMARY KEY NOT NULL,
	`question` text NOT NULL,
	`kind` text NOT NULL,
	`format` text,
	`reason` text,
	`assumptions` text NOT NULL,
	`row_count` integer,
	`duration_ms` integer NOT NULL,
	`verdict` text,
	`telemetry_ref` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "questions_question_length" CHECK(length("questions"."question") <= 400)
);
--> statement-breakpoint
CREATE INDEX `questions_created_idx` ON `questions` (`created_at`);