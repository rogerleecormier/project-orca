CREATE TABLE `class_enrollments` (
	`id` text PRIMARY KEY NOT NULL,
	`class_id` text NOT NULL REFERENCES `classes`(`id`) ON DELETE cascade,
	`profile_id` text NOT NULL REFERENCES `profiles`(`id`) ON DELETE cascade,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `class_enrollments_class_profile_unique` ON `class_enrollments` (`class_id`, `profile_id`);
--> statement-breakpoint
CREATE INDEX `class_enrollments_class_idx` ON `class_enrollments` (`class_id`);
--> statement-breakpoint
CREATE INDEX `class_enrollments_profile_idx` ON `class_enrollments` (`profile_id`);
--> statement-breakpoint
INSERT INTO `class_enrollments` (`id`, `class_id`, `profile_id`, `created_at`)
SELECT lower(hex(randomblob(16))), `id`, `student_profile_id`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `classes`
WHERE `student_profile_id` IS NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS `classes_student_profile_idx`;
--> statement-breakpoint
ALTER TABLE `classes` DROP COLUMN `student_profile_id`;