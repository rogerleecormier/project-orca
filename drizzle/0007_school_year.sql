ALTER TABLE `classes` ADD `school_year` text;
--> statement-breakpoint
CREATE INDEX `classes_school_year_idx` ON `classes` (`school_year`);
