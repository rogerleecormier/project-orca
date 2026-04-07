import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const healthCheck = sqliteTable("health_check", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  status: text("status").notNull().default("ok"),
  checkedAt: text("checked_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    emailVerified: integer("email_verified", { mode: "boolean" })
      .notNull()
      .default(false),
    username: text("username"),
    passwordHash: text("password_hash"),
    name: text("name").notNull(),
    image: text("image"),
    parentPin: text("parent_pin"),
    parentPinLength: integer("parent_pin_length"),
    role: text("role").notNull().default("user"),
    banned: integer("banned", { mode: "boolean" }).notNull().default(false),
    banReason: text("ban_reason"),
    banExpires: text("ban_expires"),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("users_email_unique").on(table.email),
    uniqueIndex("users_username_unique").on(table.username),
  ],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    expiresAt: text("expires_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    activeOrganizationId: text("active_organization_id"),
    activeTeamId: text("active_team_id"),
    impersonatedBy: text("impersonated_by"),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("sessions_token_unique").on(table.token),
    index("sessions_user_idx").on(table.userId),
  ],
);

export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: text("access_token_expires_at"),
    refreshTokenExpiresAt: text("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("accounts_provider_account_unique").on(
      table.providerId,
      table.accountId,
    ),
    index("accounts_user_idx").on(table.userId),
  ],
);

export const verifications = sqliteTable(
  "verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [index("verifications_identifier_idx").on(table.identifier)],
);

export const authOrganizations = sqliteTable(
  "auth_organizations",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    logo: text("logo"),
    metadata: text("metadata"),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [uniqueIndex("auth_organizations_slug_unique").on(table.slug)],
);

export const authMembers = sqliteTable(
  "auth_members",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => authOrganizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("auth_members_org_user_unique").on(table.organizationId, table.userId),
    index("auth_members_org_idx").on(table.organizationId),
  ],
);

export const authInvitations = sqliteTable(
  "auth_invitations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => authOrganizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull(),
    status: text("status").notNull().default("pending"),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    teamId: text("team_id"),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index("auth_invitations_org_idx").on(table.organizationId),
    index("auth_invitations_email_idx").on(table.email),
  ],
);

export const organizations = sqliteTable(
  "organizations",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [uniqueIndex("organizations_slug_unique").on(table.slug)],
);

export const memberships = sqliteTable(
  "memberships",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", {
      enum: ["admin", "parent", "student"],
    }).notNull(),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("memberships_org_user_unique").on(
      table.organizationId,
      table.userId,
    ),
    index("memberships_org_idx").on(table.organizationId),
  ],
);

export const profiles = sqliteTable(
  "profiles",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    parentUserId: text("parent_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    gradeLevel: text("grade_level"),
    birthDate: text("birth_date"),
    pinHash: text("pin_hash").notNull(),
    status: text("status", {
      enum: ["active", "archived"],
    })
      .notNull()
      .default("active"),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [index("profiles_org_idx").on(table.organizationId)],
);

export const markingPeriods = sqliteTable(
  "marking_periods",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    label: text("label").notNull(), // "Q1", "MP1", "Semester 1"
    title: text("title").notNull(), // "First Quarter"
    periodNumber: integer("period_number").notNull(), // 1, 2, 3, or 4
    startDate: text("start_date").notNull(), // ISO date "2025-09-01"
    endDate: text("end_date").notNull(), // ISO date "2025-11-15"
    schoolYear: text("school_year").notNull(), // "2025-2026"
    status: text("status", {
      enum: ["upcoming", "active", "completed"],
    })
      .notNull()
      .default("upcoming"),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index("marking_periods_org_idx").on(table.organizationId),
    index("marking_periods_org_year_idx").on(table.organizationId, table.schoolYear),
    uniqueIndex("marking_periods_org_number_year_unique").on(
      table.organizationId,
      table.periodNumber,
      table.schoolYear,
    ),
  ],
);

export const classes = sqliteTable(
  "classes",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    markingPeriodId: text("marking_period_id").references(
      () => markingPeriods.id,
      { onDelete: "set null" },
    ),
    title: text("title").notNull(),
    description: text("description"),
    schoolYear: text("school_year"),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index("classes_org_idx").on(table.organizationId),
    index("classes_school_year_idx").on(table.schoolYear),
    index("classes_marking_period_idx").on(table.markingPeriodId),
  ],
);

export const classEnrollments = sqliteTable(
  "class_enrollments",
  {
    id: text("id").primaryKey(),
    classId: text("class_id")
      .notNull()
      .references(() => classes.id, { onDelete: "cascade" }),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("class_enrollments_class_profile_unique").on(
      table.classId,
      table.profileId,
    ),
    index("class_enrollments_class_idx").on(table.classId),
    index("class_enrollments_profile_idx").on(table.profileId),
  ],
);

export const assignments = sqliteTable(
  "assignments",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    classId: text("class_id")
      .notNull()
      .references(() => classes.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    contentType: text("content_type", {
      enum: ["text", "file", "url", "video", "quiz", "essay_questions", "report", "movie"],
    }).notNull(),
    contentRef: text("content_ref"),
    markingPeriodId: text("marking_period_id").references(
      () => markingPeriods.id,
      { onDelete: "set null" },
    ),
    linkedAssignmentId: text("linked_assignment_id"),
    dueAt: text("due_at"),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index("assignments_org_idx").on(table.organizationId),
    index("assignments_class_idx").on(table.classId),
    index("assignments_linked_idx").on(table.linkedAssignmentId),
    index("assignments_marking_period_idx").on(table.markingPeriodId),
  ],
);

export const assignmentTemplates = sqliteTable(
  "assignment_templates",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    title: text("title").notNull(),
    description: text("description"),
    contentType: text("content_type", {
      enum: ["text", "file", "url", "video", "quiz", "essay_questions", "report", "movie"],
    }).notNull(),
    contentRef: text("content_ref"),
    tags: text("tags").notNull().default("[]"),
    isPublic: integer("is_public", { mode: "boolean" }).notNull().default(false),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    index("assignment_templates_org_idx").on(table.organizationId),
    index("assignment_templates_user_idx").on(table.createdByUserId),
    index("assignment_templates_public_idx").on(table.isPublic),
    index("assignment_templates_content_type_idx").on(table.contentType),
  ],
);

export const weekPlan = sqliteTable(
  "week_plan",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    assignmentId: text("assignment_id")
      .notNull()
      .references(() => assignments.id, { onDelete: "cascade" }),
    scheduledDate: text("scheduled_date").notNull(), // ISO date string: "2026-04-07"
    orderIndex: integer("order_index").notNull().default(0),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index("week_plan_profile_date_idx").on(table.profileId, table.scheduledDate),
    index("week_plan_org_idx").on(table.organizationId),
  ],
);

export const submissions = sqliteTable(
  "submissions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    assignmentId: text("assignment_id")
      .notNull()
      .references(() => assignments.id, { onDelete: "cascade" }),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    submittedByUserId: text("submitted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    assetKey: text("asset_key"),
    textResponse: text("text_response"),
    status: text("status", {
      enum: ["draft", "submitted", "graded", "returned"],
    })
      .notNull()
      .default("submitted"),
    score: integer("score"),
    submittedAt: text("submitted_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    feedbackJson: text("feedback_json"),
    reviewedAt: text("reviewed_at"),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("submissions_assignment_profile_unique").on(
      table.assignmentId,
      table.profileId,
    ),
    index("submissions_org_idx").on(table.organizationId),
  ],
);

export const skillTrees = sqliteTable(
  "skill_trees",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    classId: text("class_id").references(() => classes.id, {
      onDelete: "cascade",
    }),
    profileId: text("profile_id").references(() => profiles.id, {
      onDelete: "cascade",
    }),
    title: text("title").notNull(),
    description: text("description"),
    gradeLevel: text("grade_level"),
    subject: text("subject"),
    schoolYear: text("school_year"),
    viewportX: integer("viewport_x").notNull().default(0),
    viewportY: integer("viewport_y").notNull().default(0),
    viewportScale: integer("viewport_scale").notNull().default(100),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index("skill_trees_org_idx").on(table.organizationId),
    index("skill_trees_class_idx").on(table.classId),
    index("skill_trees_profile_idx").on(table.profileId),
  ],
);

export const skillTreeNodes = sqliteTable(
  "skill_tree_nodes",
  {
    id: text("id").primaryKey(),
    treeId: text("tree_id")
      .notNull()
      .references(() => skillTrees.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    subject: text("subject"),
    icon: text("icon"),
    colorRamp: text("color_ramp").notNull().default("blue"),
    nodeType: text("node_type", {
      enum: ["lesson", "milestone", "boss", "branch", "elective"],
    })
      .notNull()
      .default("lesson"),
    xpReward: integer("xp_reward").notNull().default(100),
    positionX: integer("position_x").notNull().default(0),
    positionY: integer("position_y").notNull().default(0),
    radius: integer("radius").notNull().default(28),
    isRequired: integer("is_required", { mode: "boolean" })
      .notNull()
      .default(false),
    aiGeneratedDescription: text("ai_generated_description"),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index("skill_tree_nodes_tree_idx").on(table.treeId),
    index("skill_tree_nodes_org_idx").on(table.organizationId),
  ],
);

export const skillTreeEdges = sqliteTable(
  "skill_tree_edges",
  {
    id: text("id").primaryKey(),
    treeId: text("tree_id")
      .notNull()
      .references(() => skillTrees.id, { onDelete: "cascade" }),
    sourceNodeId: text("source_node_id")
      .notNull()
      .references(() => skillTreeNodes.id, { onDelete: "cascade" }),
    targetNodeId: text("target_node_id")
      .notNull()
      .references(() => skillTreeNodes.id, { onDelete: "cascade" }),
    edgeType: text("edge_type", {
      enum: ["required", "optional", "bonus"],
    })
      .notNull()
      .default("required"),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index("skill_tree_edges_tree_idx").on(table.treeId),
    uniqueIndex("skill_tree_edges_source_target_unique").on(
      table.sourceNodeId,
      table.targetNodeId,
    ),
  ],
);

export const skillTreeNodeAssignments = sqliteTable(
  "skill_tree_node_assignments",
  {
    id: text("id").primaryKey(),
    nodeId: text("node_id")
      .notNull()
      .references(() => skillTreeNodes.id, { onDelete: "cascade" }),
    assignmentId: text("assignment_id")
      .notNull()
      .references(() => assignments.id, { onDelete: "cascade" }),
    orderIndex: integer("order_index").notNull().default(0),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index("skill_tree_node_assignments_node_idx").on(table.nodeId),
    uniqueIndex("skill_tree_node_assignments_node_assignment_unique").on(
      table.nodeId,
      table.assignmentId,
    ),
  ],
);

export const rewardTracks = sqliteTable(
  "reward_tracks",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    description: text("description"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(false),
    schoolYear: text("school_year"),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    totalXpGoal: integer("total_xp_goal").notNull().default(5000),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index("reward_tracks_org_idx").on(table.organizationId),
    index("reward_tracks_profile_idx").on(table.profileId),
  ],
);

export const rewardTiers = sqliteTable(
  "reward_tiers",
  {
    id: text("id").primaryKey(),
    trackId: text("track_id")
      .notNull()
      .references(() => rewardTracks.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    tierNumber: integer("tier_number").notNull(),
    xpThreshold: integer("xp_threshold").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    icon: text("icon").default("🎁"),
    rewardType: text("reward_type").notNull().default("treat"),
    estimatedValue: text("estimated_value"),
    isBonusTier: integer("is_bonus_tier", { mode: "boolean" }).default(false),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("reward_tiers_track_tier_unique").on(table.trackId, table.tierNumber),
    index("reward_tiers_track_idx").on(table.trackId),
  ],
);

export const rewardClaims = sqliteTable(
  "reward_claims",
  {
    id: text("id").primaryKey(),
    tierId: text("tier_id")
      .notNull()
      .references(() => rewardTiers.id, { onDelete: "cascade" }),
    trackId: text("track_id")
      .notNull()
      .references(() => rewardTracks.id, { onDelete: "cascade" }),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("unclaimed"),
    claimedAt: text("claimed_at"),
    deliveredAt: text("delivered_at"),
    deliveredByUserId: text("delivered_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    parentNote: text("parent_note"),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("reward_claims_tier_profile_unique").on(table.tierId, table.profileId),
    index("reward_claims_track_profile_idx").on(table.trackId, table.profileId),
    index("reward_claims_org_status_idx").on(table.organizationId, table.status),
  ],
);

export const rewardTrackXpSnapshots = sqliteTable(
  "reward_track_xp_snapshots",
  {
    id: text("id").primaryKey(),
    trackId: text("track_id")
      .notNull()
      .references(() => rewardTracks.id, { onDelete: "cascade" }),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    xpEarned: integer("xp_earned").notNull().default(0),
    lastUpdatedAt: text("last_updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("reward_track_xp_snapshots_track_profile_unique").on(
      table.trackId,
      table.profileId,
    ),
  ],
);

export const skillTreeNodeProgress = sqliteTable(
  "skill_tree_node_progress",
  {
    id: text("id").primaryKey(),
    nodeId: text("node_id")
      .notNull()
      .references(() => skillTreeNodes.id, { onDelete: "cascade" }),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    treeId: text("tree_id")
      .notNull()
      .references(() => skillTrees.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: ["locked", "available", "in_progress", "complete", "mastery"],
    })
      .notNull()
      .default("locked"),
    xpEarned: integer("xp_earned").notNull().default(0),
    completedAt: text("completed_at"),
    masteryAt: text("mastery_at"),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("skill_tree_node_progress_node_profile_unique").on(
      table.nodeId,
      table.profileId,
    ),
    index("skill_tree_node_progress_tree_profile_idx").on(
      table.treeId,
      table.profileId,
    ),
  ],
);
