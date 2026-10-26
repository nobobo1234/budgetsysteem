CREATE TABLE `receipt_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`receipt_id` text NOT NULL,
	`position` integer NOT NULL,
	`description` text NOT NULL,
	`kind` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`product_group` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`receipt_id`) REFERENCES `receipts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `receipt_lines_position_idx` ON `receipt_lines` (`receipt_id`,`position`);--> statement-breakpoint
-- Eenmalig: de regels van bonnen die al verwerkt waren (zeker, controleren of na de review-inbox),
-- uit de bewaarde gecontroleerde velden. Alleen als alle regels gelezen zijn en samen het totaal
-- vormen (binnen €0,05), net als `completeLines` in receipts/outcome.ts. Hun productgroep blijft
-- leeg: die las Haiku toen nog niet.
INSERT INTO `receipt_lines` (`id`, `receipt_id`, `position`, `description`, `kind`, `amount_cents`, `product_group`)
SELECT
	lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
		substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) ||
		substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
	r.`id`,
	CAST(l.`key` AS INTEGER),
	substr(json_extract(l.`value`, '$.description'), 1, 120),
	json_extract(l.`value`, '$.kind'),
	json_extract(l.`value`, '$.cents'),
	NULL
FROM `receipts` r,
	json_each(CASE WHEN json_valid(r.`checked_fields`) THEN r.`checked_fields` END, '$.lines') l
WHERE json_valid(r.`checked_fields`)
	AND r.`kind` = 'bon'
	AND (r.`status` IN ('zeker', 'controleren') OR (r.`status` != 'wordt_gelezen' AND r.`handled_at` IS NOT NULL))
	AND json_type(r.`checked_fields`, '$.lines') = 'array'
	AND json_type(r.`checked_fields`, '$.linesSumCents') = 'integer'
	AND json_type(r.`checked_fields`, '$.totalCents') = 'integer'
	AND abs(json_extract(r.`checked_fields`, '$.linesSumCents') - json_extract(r.`checked_fields`, '$.totalCents')) <= 5
	AND json_type(l.`value`, '$.cents') = 'integer'
	AND json_type(l.`value`, '$.description') = 'text'
	AND json_extract(l.`value`, '$.kind') IN ('artikel', 'korting', 'bonus', 'statiegeld', 'statiegeld_retour', 'fooi', 'overig');
