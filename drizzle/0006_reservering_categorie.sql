ALTER TABLE `reservations` ADD `category_id` text REFERENCES categories(id) ON DELETE set null;--> statement-breakpoint
-- Bestaande reserveringen krijgen de categorie die de vaste last nu heeft
UPDATE `reservations` SET `category_id` = (SELECT r.`category_id` FROM `recurring` r WHERE r.`id` = `reservations`.`recurring_id`);
