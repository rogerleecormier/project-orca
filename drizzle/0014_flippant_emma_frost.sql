CREATE TABLE `marking_periods` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`label` text NOT NULL,
	`title` text NOT NULL,
	`period_number` integer NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`school_year` text NOT NULL,
	`status` text DEFAULT 'upcoming' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `marking_periods_org_idx` ON `marking_periods` (`organization_id`);--> statement-breakpoint
CREATE INDEX `marking_periods_org_year_idx` ON `marking_periods` (`organization_id`,`school_year`);--> statement-breakpoint
CREATE UNIQUE INDEX `marking_periods_org_number_year_unique` ON `marking_periods` (`organization_id`,`period_number`,`school_year`);--> statement-breakpoint
ALTER TABLE `assignments` ADD `marking_period_id` text REFERENCES marking_periods(id);--> statement-breakpoint
CREATE INDEX `assignments_marking_period_idx` ON `assignments` (`marking_period_id`);--> statement-breakpoint
ALTER TABLE `classes` ADD `marking_period_id` text REFERENCES marking_periods(id);--> statement-breakpoint
CREATE INDEX `classes_marking_period_idx` ON `classes` (`marking_period_id`);