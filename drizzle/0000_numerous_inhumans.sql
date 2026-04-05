CREATE TABLE `health_check` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`status` text DEFAULT 'ok' NOT NULL,
	`checked_at` text NOT NULL
);
