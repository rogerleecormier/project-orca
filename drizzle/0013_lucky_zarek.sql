CREATE TABLE `reward_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`tier_id` text NOT NULL,
	`track_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`status` text DEFAULT 'unclaimed' NOT NULL,
	`claimed_at` text,
	`delivered_at` text,
	`delivered_by_user_id` text,
	`parent_note` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tier_id`) REFERENCES `reward_tiers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`track_id`) REFERENCES `reward_tracks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`delivered_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reward_claims_tier_profile_unique` ON `reward_claims` (`tier_id`,`profile_id`);--> statement-breakpoint
CREATE INDEX `reward_claims_track_profile_idx` ON `reward_claims` (`track_id`,`profile_id`);--> statement-breakpoint
CREATE INDEX `reward_claims_org_status_idx` ON `reward_claims` (`organization_id`,`status`);--> statement-breakpoint
CREATE TABLE `reward_tiers` (
	`id` text PRIMARY KEY NOT NULL,
	`track_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`tier_number` integer NOT NULL,
	`xp_threshold` integer NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`icon` text DEFAULT '🎁',
	`reward_type` text DEFAULT 'treat' NOT NULL,
	`estimated_value` text,
	`is_bonus_tier` integer DEFAULT false,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`track_id`) REFERENCES `reward_tracks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reward_tiers_track_tier_unique` ON `reward_tiers` (`track_id`,`tier_number`);--> statement-breakpoint
CREATE INDEX `reward_tiers_track_idx` ON `reward_tiers` (`track_id`);--> statement-breakpoint
CREATE TABLE `reward_track_xp_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`track_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`xp_earned` integer DEFAULT 0 NOT NULL,
	`last_updated_at` text NOT NULL,
	FOREIGN KEY (`track_id`) REFERENCES `reward_tracks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reward_track_xp_snapshots_track_profile_unique` ON `reward_track_xp_snapshots` (`track_id`,`profile_id`);--> statement-breakpoint
CREATE TABLE `reward_tracks` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`is_active` integer DEFAULT false NOT NULL,
	`school_year` text,
	`started_at` text,
	`completed_at` text,
	`total_xp_goal` integer DEFAULT 5000 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `reward_tracks_org_idx` ON `reward_tracks` (`organization_id`);--> statement-breakpoint
CREATE INDEX `reward_tracks_profile_idx` ON `reward_tracks` (`profile_id`);