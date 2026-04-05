-- Add linkedAssignmentId column to assignments
ALTER TABLE `assignments` ADD `linked_assignment_id` text;
--> statement-breakpoint
CREATE INDEX `assignments_linked_idx` ON `assignments` (`linked_assignment_id`);
--> statement-breakpoint
-- Rename essay → report in content_type
-- SQLite does not support ALTER COLUMN, so we do an update in place.
-- The enum constraint is enforced by the application layer (Zod), not the DB.
UPDATE `assignments` SET `content_type` = 'report' WHERE `content_type` = 'essay';
