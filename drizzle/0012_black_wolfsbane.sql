CREATE TABLE `skill_trees` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`class_id` text,
	`profile_id` text,
	`title` text NOT NULL,
	`description` text,
	`grade_level` text,
	`subject` text,
	`school_year` text,
	`viewport_x` integer DEFAULT 0 NOT NULL,
	`viewport_y` integer DEFAULT 0 NOT NULL,
	`viewport_scale` integer DEFAULT 100 NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`class_id`) REFERENCES `classes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `skill_trees_org_idx` ON `skill_trees` (`organization_id`);
--> statement-breakpoint
CREATE INDEX `skill_trees_class_idx` ON `skill_trees` (`class_id`);
--> statement-breakpoint
CREATE INDEX `skill_trees_profile_idx` ON `skill_trees` (`profile_id`);
--> statement-breakpoint
CREATE TABLE `skill_tree_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`tree_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`subject` text,
	`icon` text,
	`color_ramp` text DEFAULT 'blue' NOT NULL,
	`node_type` text DEFAULT 'lesson' NOT NULL,
	`xp_reward` integer DEFAULT 100 NOT NULL,
	`position_x` integer DEFAULT 0 NOT NULL,
	`position_y` integer DEFAULT 0 NOT NULL,
	`radius` integer DEFAULT 28 NOT NULL,
	`is_required` integer DEFAULT false NOT NULL,
	`ai_generated_description` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tree_id`) REFERENCES `skill_trees`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `skill_tree_nodes_tree_idx` ON `skill_tree_nodes` (`tree_id`);
--> statement-breakpoint
CREATE INDEX `skill_tree_nodes_org_idx` ON `skill_tree_nodes` (`organization_id`);
--> statement-breakpoint
CREATE TABLE `skill_tree_edges` (
	`id` text PRIMARY KEY NOT NULL,
	`tree_id` text NOT NULL,
	`source_node_id` text NOT NULL,
	`target_node_id` text NOT NULL,
	`edge_type` text DEFAULT 'required' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tree_id`) REFERENCES `skill_trees`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_node_id`) REFERENCES `skill_tree_nodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_node_id`) REFERENCES `skill_tree_nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `skill_tree_edges_tree_idx` ON `skill_tree_edges` (`tree_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_tree_edges_source_target_unique` ON `skill_tree_edges` (`source_node_id`,`target_node_id`);
--> statement-breakpoint
CREATE TABLE `skill_tree_node_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`assignment_id` text NOT NULL,
	`order_index` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `skill_tree_nodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assignment_id`) REFERENCES `assignments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `skill_tree_node_assignments_node_idx` ON `skill_tree_node_assignments` (`node_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_tree_node_assignments_node_assignment_unique` ON `skill_tree_node_assignments` (`node_id`,`assignment_id`);
--> statement-breakpoint
CREATE TABLE `skill_tree_node_progress` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`tree_id` text NOT NULL,
	`status` text DEFAULT 'locked' NOT NULL,
	`xp_earned` integer DEFAULT 0 NOT NULL,
	`completed_at` text,
	`mastery_at` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `skill_tree_nodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tree_id`) REFERENCES `skill_trees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_tree_node_progress_node_profile_unique` ON `skill_tree_node_progress` (`node_id`,`profile_id`);
--> statement-breakpoint
CREATE INDEX `skill_tree_node_progress_tree_profile_idx` ON `skill_tree_node_progress` (`tree_id`,`profile_id`);
