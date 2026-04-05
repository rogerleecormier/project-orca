CREATE TABLE `week_plan` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`assignment_id` text NOT NULL,
	`scheduled_date` text NOT NULL,
	`order_index` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assignment_id`) REFERENCES `assignments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `week_plan_profile_date_idx` ON `week_plan` (`profile_id`,`scheduled_date`);
--> statement-breakpoint
CREATE INDEX `week_plan_org_idx` ON `week_plan` (`organization_id`);
