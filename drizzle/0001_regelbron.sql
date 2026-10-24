ALTER TABLE `transactions` ADD `category_source` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `category_rule_id` text REFERENCES rules(id) ON DELETE set null;--> statement-breakpoint
-- Bestaande categorieën een bron geven. Eerst wat je zelf hebt gewijzigd (volgens het audit-log),
-- dan eigen overboekingen, dan de rest van de import (die kon alleen van een regel komen).
UPDATE `transactions` SET `category_source` = 'handmatig'
WHERE `category_id` IS NOT NULL AND `id` IN (
	SELECT `entity_id` FROM `audit_log`
	WHERE `entity` = 'transactions' AND `action` = 'gewijzigd'
		AND json_extract(`before`, '$.categoryId') IS NOT json_extract(`after`, '$.categoryId')
);--> statement-breakpoint
UPDATE `transactions` SET `category_source` = 'intern'
WHERE `category_source` IS NULL AND `source` = 'import'
	AND `category_id` = (SELECT `id` FROM `categories` WHERE `name` = 'Interne overboeking')
	AND `counter_iban` IN (SELECT `iban` FROM `accounts` WHERE `iban` IS NOT NULL);--> statement-breakpoint
UPDATE `transactions` SET `category_source` = 'regel'
WHERE `category_source` IS NULL AND `source` = 'import' AND `category_id` IS NOT NULL;--> statement-breakpoint
UPDATE `transactions` SET `category_source` = 'handmatig'
WHERE `category_source` IS NULL AND `category_id` IS NOT NULL;
