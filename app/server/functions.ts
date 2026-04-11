import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import { and, count, desc, eq, gte, inArray, isNull, lte, or, sql, sum } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { getDb } from "../db/client";
import {
  assignments,
  assignmentTemplates,
  classEnrollments,
  classes,
  healthCheck,
  markingPeriods,
  memberships,
  organizations,
  profiles,
  rewardClaims,
  rewardTiers,
  rewardTrackXpSnapshots,
  rewardTracks,
  skillTreeEdges,
  skillTreeNodeAssignments,
  skillTreeNodeProgress,
  skillTreeNodes,
  skillTrees,
  submissions,
  users,
  weekPlan,
} from "../db/schema";
import { auth, getRoleContext, requireActiveRole } from "../lib/auth";
import {
  fetchYoutubeTranscript,
  fetchYoutubeTranscriptWithMeta,
  generateBranchCluster,
  generateChapterCluster,
  generateCurriculumSpine,
  generateAssignmentsForNode,
  generateNodeAssignments,
  type AssignmentPrefs,
  type GeneratedAssignment,
  generateCurriculumTree,
  generateCurriculumWebFromSpine,
  generateNodeExpansion,
  generateQuizDraft,
  generateRewardSuggestions,
  generateRewardSuggestionForTier,
  generateWeekPlanWithAI as aiGenerateWeekPlan,
  type PlannerAssignment,
  type PlannerSkillContext,
  gradeSubmission,
  layoutForceDirected,
  reweaveCurriculumTree,
  searchYoutubeForVideos,
  recommendCurriculumCourses,
  generateLessonReading,
  type CourseRecommendation,
} from "../lib/ai";

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 8;
const DEFAULT_PBKDF2_ITERATIONS = 100000;
const PASSWORD_HASH_VERSION = "pbkdf2_sha256";
const MIN_PBKDF2_ITERATIONS = 50000;
const MAX_PBKDF2_ITERATIONS = 600000;
type SkillTreeNodeRow = typeof skillTreeNodes.$inferSelect;
type SkillTreeEdgeRow = typeof skillTreeEdges.$inferSelect;
type SkillTreeNodeProgressRow = typeof skillTreeNodeProgress.$inferSelect;
const subtleCrypto = crypto.subtle as SubtleCrypto & {
  timingSafeEqual(a: BufferSource, b: BufferSource): boolean;
};

function buildCookie(name: string, value: string, maxAgeSeconds = COOKIE_MAX_AGE_SECONDS) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${maxAgeSeconds}`;
}

function resolveParentPinLength(
  value: number | null | undefined,
) {
  if (value === 4 || value === 5 || value === 6) {
    return value;
  }

  return null;
}

function getPasswordHashIterations() {
  const configuredIterations = Number(
    (env as Env & { PASSWORD_PBKDF2_ITERATIONS?: string }).PASSWORD_PBKDF2_ITERATIONS,
  );

  if (!Number.isInteger(configuredIterations)) {
    return DEFAULT_PBKDF2_ITERATIONS;
  }

  return Math.min(MAX_PBKDF2_ITERATIONS, Math.max(MIN_PBKDF2_ITERATIONS, configuredIterations));
}

async function derivePasswordHash(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const passwordBytes = new TextEncoder().encode(password);
  const importedKey = await crypto.subtle.importKey("raw", passwordBytes, "PBKDF2", false, [
    "deriveBits",
  ]);
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      hash: "SHA-256",
      iterations,
    },
    importedKey,
    256,
  );

  return new Uint8Array(derivedBits);
}

function toBase64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...Array.from(bytes)));
}

function fromBase64(value: string) {
  return new Uint8Array(atob(value).split("").map((char) => char.charCodeAt(0)));
}

function parseStoredPasswordHash(storedHash: string) {
  if (storedHash.startsWith(`${PASSWORD_HASH_VERSION}$`)) {
    const [, iterationsRaw, saltB64, hashB64] = storedHash.split("$");
    const iterations = Number(iterationsRaw);

    if (!Number.isInteger(iterations) || !saltB64 || !hashB64) {
      return null;
    }

    return {
      iterations,
      salt: fromBase64(saltB64),
      hash: fromBase64(hashB64),
    };
  }

  const [saltB64, hashB64] = storedHash.split(":");
  if (!saltB64 || !hashB64) {
    return null;
  }

  return {
    iterations: DEFAULT_PBKDF2_ITERATIONS,
    salt: fromBase64(saltB64),
    hash: fromBase64(hashB64),
  };
}

// Password hashing using PBKDF2 (Web Standard API)
async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = getPasswordHashIterations();
  const derivedKeyBytes = await derivePasswordHash(password, salt, iterations);

  return `${PASSWORD_HASH_VERSION}$${iterations}$${toBase64(salt)}$${toBase64(derivedKeyBytes)}`;
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  try {
    const parsedHash = parseStoredPasswordHash(storedHash);
    if (!parsedHash) return false;

    const computedHash = await derivePasswordHash(password, parsedHash.salt, parsedHash.iterations);
    return subtleCrypto.timingSafeEqual(
      computedHash as BufferSource,
      parsedHash.hash as BufferSource,
    );
  } catch {
    return false;
  }
}

async function hashParentPin(pin: string): Promise<string> {
  const encoded = new TextEncoder().encode(pin);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return toHex(digest);
}


function setRoleSessionCookies(payload: {
  role: "parent" | "admin" | "student";
  userId: string;
  organizationId: string;
  profileId?: string;
  isAdminParent?: boolean;
  impersonatingStudentId?: string;
}) {
  const cookies = [
    buildCookie("proorca_role", payload.role),
    buildCookie("proorca_user_id", payload.userId),
    buildCookie("proorca_org_id", payload.organizationId),
    buildCookie("proorca_profile_id", payload.profileId ?? ""),
    buildCookie("proorca_is_admin_parent", payload.isAdminParent ? "1" : "0"),
    buildCookie("proorca_impersonating_student_id", payload.impersonatingStudentId ?? ""),
  ];

  setResponseHeader("set-cookie", cookies);
}

function clearRoleSessionCookies() {
  const cookies = [
    buildCookie("proorca_role", "", 0),
    buildCookie("proorca_user_id", "", 0),
    buildCookie("proorca_org_id", "", 0),
    buildCookie("proorca_profile_id", "", 0),
    buildCookie("proorca_is_admin_parent", "", 0),
    buildCookie("proorca_impersonating_student_id", "", 0),
  ];

  setResponseHeader("set-cookie", cookies);
}
export const getViewerContext = createServerFn({ method: "POST" }).handler(async () => {
  const roleContext = await getRoleContext();

  return {
    isAuthenticated: roleContext.isAuthenticated,
    activeRole: roleContext.activeRole,
    isAdminParent: roleContext.isAdminParent,
    profileId: roleContext.profileId ?? null,
  };
});

export const getParentSettingsData = createServerFn({ method: "GET" }).handler(async () => {
  const session = await requireActiveRole(["parent", "admin"]);
  const db = getDb();

  const userRecord = await db.query.users.findFirst({
    where: eq(users.id, session.user.id),
  });

  if (!userRecord) {
    throw new Error("FORBIDDEN");
  }

  const organizationId = await resolveActiveOrganizationId(
    session.user.id,
    session.session.activeOrganizationId,
  );

  const org = organizationId
    ? await db.query.organizations.findFirst({
        where: eq(organizations.id, organizationId),
      })
    : null;

  return {
    name: userRecord.name ?? "",
    email: userRecord.email ?? "",
    username: userRecord.username ?? "",
    parentPinLength: resolveParentPinLength(userRecord.parentPinLength),
    schoolWeekDays: (org?.schoolWeekDays ?? 5) as 4 | 5 | 6 | 7,
    timezone: org?.timezone ?? "America/New_York",
  };
});

const updateParentSettingsInput = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email(),
  username: z
    .string()
    .trim()
    .min(3)
    .max(20)
    .regex(/^[a-zA-Z0-9_]+$/),
});

export const updateParentSettings = createServerFn({ method: "POST" })
  .inputValidator((data) => updateParentSettingsInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["parent", "admin"]);
    const db = getDb();

    const normalizedEmail = data.email.trim().toLowerCase();
    const normalizedUsername = data.username.trim().toLowerCase();
    const displayName = data.name.trim();

    const [emailOwner, usernameOwner] = await Promise.all([
      db.query.users.findFirst({
        where: eq(users.email, normalizedEmail),
      }),
      db.query.users.findFirst({
        where: eq(users.username, normalizedUsername),
      }),
    ]);

    if (emailOwner && emailOwner.id !== session.user.id) {
      throw new Error("EMAIL_ALREADY_EXISTS");
    }

    if (usernameOwner && usernameOwner.id !== session.user.id) {
      throw new Error("USERNAME_ALREADY_EXISTS");
    }

    await db
      .update(users)
      .set({
        name: displayName,
        email: normalizedEmail,
        username: normalizedUsername,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(users.id, session.user.id));

    return { success: true };
  });

export const updateSchoolWeekDays = createServerFn({ method: "POST" })
  .inputValidator((data) =>
    z.object({ schoolWeekDays: z.union([z.literal(4), z.literal(5), z.literal(6), z.literal(7)]) }).parse(data),
  )
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["parent", "admin"]);
    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    if (!organizationId) {
      throw new Error("NO_ORGANIZATION");
    }

    const db = getDb();
    await db
      .update(organizations)
      .set({ schoolWeekDays: data.schoolWeekDays, updatedAt: new Date().toISOString() })
      .where(eq(organizations.id, organizationId));

    return { success: true };
  });

export const updateTimezone = createServerFn({ method: "POST" })
  .inputValidator((data) =>
    z.object({ timezone: z.string().min(1).max(60) }).parse(data),
  )
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["parent", "admin"]);
    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );
    if (!organizationId) throw new Error("NO_ORGANIZATION");
    const db = getDb();
    await db
      .update(organizations)
      .set({ timezone: data.timezone, updatedAt: new Date().toISOString() })
      .where(eq(organizations.id, organizationId));
    return { success: true };
  });

const changeParentPinInput = z.object({
  currentPin: z.string().regex(/^\d{4,6}$/),
  newPin: z.string().regex(/^\d{4,6}$/),
});

export const changeParentPin = createServerFn({ method: "POST" })
  .inputValidator((data) => changeParentPinInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["parent", "admin"]);
    const db = getDb();

    await verifyParentPinForSession(session.user.id, data.currentPin);

    const nextPinHash = await hashParentPin(data.newPin);
    try {
      await db
        .update(users)
        .set({
          parentPin: nextPinHash,
          parentPinLength: data.newPin.length,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(users.id, session.user.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("no such column") && message.includes("parent_pin_length")) {
        throw new Error("PIN_LENGTH_MIGRATION_REQUIRED");
      }
      throw error;
    }

    return {
      success: true,
      parentPinLength: data.newPin.length,
    };
  });

const resetParentPinWithPasswordInput = z.object({
  accountPassword: z.string().min(8).max(128),
  newPin: z.string().regex(/^\d{4,6}$/),
});

export const resetParentPinWithPassword = createServerFn({ method: "POST" })
  .inputValidator((data) => resetParentPinWithPasswordInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["parent", "admin"]);
    const db = getDb();

    const userRecord = await db.query.users.findFirst({
      where: eq(users.id, session.user.id),
    });

    if (!userRecord?.passwordHash) {
      throw new Error("PASSWORD_NOT_AVAILABLE");
    }

    const isPasswordValid = await verifyPassword(data.accountPassword, userRecord.passwordHash);
    if (!isPasswordValid) {
      throw new Error("INVALID_PASSWORD");
    }

    const nextPinHash = await hashParentPin(data.newPin);
    try {
      await db
        .update(users)
        .set({
          parentPin: nextPinHash,
          parentPinLength: data.newPin.length,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(users.id, session.user.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("no such column") && message.includes("parent_pin_length")) {
        throw new Error("PIN_LENGTH_MIGRATION_REQUIRED");
      }
      throw error;
    }

    return {
      success: true,
      parentPinLength: data.newPin.length,
    };
  });

const contentResetWithPinInput = z.object({
  parentPin: z.string().regex(/^\d{4,6}$/),
});

// Each student gets 2-3 courses tailored to their grade level.
const DEMO_STUDENTS: Array<{
  displayName: string;
  gradeLevel: string;
  subjects: string[];
}> = [
  { displayName: "Ava Rivers",  gradeLevel: "4", subjects: ["Math", "Language Arts"] },
  { displayName: "Noah Chen",   gradeLevel: "6", subjects: ["Math", "Earth Science", "US History"] },
  { displayName: "Mia Patel",   gradeLevel: "8", subjects: ["Pre-Algebra", "Literature", "Life Science"] },
];

// Exported preview so the settings UI can display accurate counts before seeding.
export const DEMO_SEED_PREVIEW = (() => {
  const totalCourses = DEMO_STUDENTS.reduce((s, st) => s + st.subjects.length, 0);
  return {
    students: DEMO_STUDENTS.map((s) => ({
      name: s.displayName,
      grade: s.gradeLevel,
      subjects: s.subjects,
    })),
    totalStudents: DEMO_STUDENTS.length,
    totalCourses,
    studentPin: "1111",
  };
})();

function getCurrentSchoolYearLabel() {
  const now = new Date();
  const year = now.getFullYear();
  const start = now.getMonth() >= 7 ? year : year - 1;
  return `${start}-${start + 1}`;
}

function chunkIds(ids: string[], chunkSize = 50): string[][] {
  if (ids.length === 0) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    chunks.push(ids.slice(i, i + chunkSize));
  }
  return chunks;
}

// ── Demo seed data ────────────────────────────────────────────────────────────
//
// Node assignment structure follows the updated curriculum instruction set:
//
//  milestone  → chapter overview text (250-350w) + diagnostic pre-quiz +
//               2 intro videos + checkpoint quiz + chapter reflection essay
//  lesson     → reading (400-600w) + 2 videos + formative check quiz +
//               practice response (essay_questions)
//  elective   → deep-dive reading (500-750w) + 2 videos + analysis quiz +
//               hands-on project (report)
//  boss       → comprehensive unit review (600-900w) + 3 summative quizzes +
//               analytical essay
//
// D1 write limits: ~1 000 SQL statements per Worker invocation (free tier).
// We batch row inserts per table and flush in phases of ≤ 80 rows each,
// yielding control between phases with a microtask tick so the runtime
// can breathe between batches.

async function batchInsert<T extends Record<string, unknown>>(
  db: ReturnType<typeof getDb>,
  table: Parameters<ReturnType<typeof getDb>["insert"]>[0],
  rows: T[],
  batchSize = 80,
) {
  for (let i = 0; i < rows.length; i += batchSize) {
    const slice = rows.slice(i, i + batchSize);
    if (slice.length > 0) {
      await db.insert(table).values(slice as Parameters<ReturnType<typeof getDb>["insert"]>[0]["_"]["inferInsert"][]);
    }
    // yield to runtime between batches
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

// ── Per-subject curriculum data ───────────────────────────────────────────────

type SubjectSpec = {
  chapters: Array<{
    title: string;
    icon: string;
    colorRamp: "teal" | "blue" | "purple" | "amber" | "coral" | "green";
    lessons: Array<{ title: string; icon: string; type: "lesson" | "elective" }>;
  }>;
};

const DEMO_CURRICULA: Record<string, SubjectSpec> = {
  // ── Grade 4 Math ──────────────────────────────────────────────────────────────
  Math: {
    chapters: [
      {
        title: "Multiplication & Division", icon: "✖️", colorRamp: "teal",
        lessons: [
          { title: "Multiplication Facts Fluency", icon: "🔢", type: "lesson" },
          { title: "Area Models & Arrays", icon: "⬛", type: "lesson" },
          { title: "Multi-Digit Multiplication", icon: "📐", type: "lesson" },
          { title: "Understanding Division", icon: "➗", type: "lesson" },
          { title: "Division with Remainders", icon: "🔄", type: "lesson" },
          { title: "Mental Math Shortcuts", icon: "🧠", type: "elective" },
        ],
      },
      {
        title: "Fractions & Mixed Numbers", icon: "½", colorRamp: "purple",
        lessons: [
          { title: "Fractions on a Number Line", icon: "📏", type: "lesson" },
          { title: "Equivalent Fractions", icon: "⚖️", type: "lesson" },
          { title: "Comparing & Ordering Fractions", icon: "🔀", type: "lesson" },
          { title: "Mixed Numbers & Improper Fractions", icon: "🔢", type: "lesson" },
          { title: "Adding Fractions with Like Denominators", icon: "➕", type: "lesson" },
          { title: "Fractions in Real Life", icon: "🍕", type: "elective" },
        ],
      },
      {
        title: "Geometry & Measurement", icon: "📐", colorRamp: "blue",
        lessons: [
          { title: "Lines, Rays & Angles", icon: "📐", type: "lesson" },
          { title: "Classifying Triangles & Quadrilaterals", icon: "🔷", type: "lesson" },
          { title: "Perimeter & Area", icon: "⬜", type: "lesson" },
          { title: "Units of Measurement & Conversions", icon: "📏", type: "lesson" },
          { title: "Symmetry & Patterns", icon: "🪞", type: "elective" },
        ],
      },
    ],
  },

  // ── Grade 4 Language Arts ─────────────────────────────────────────────────────
  "Language Arts": {
    chapters: [
      {
        title: "Reading Comprehension", icon: "📖", colorRamp: "teal",
        lessons: [
          { title: "Finding the Main Idea", icon: "🎯", type: "lesson" },
          { title: "Making Inferences", icon: "💭", type: "lesson" },
          { title: "Author's Purpose & Point of View", icon: "👁️", type: "lesson" },
          { title: "Text Features & Nonfiction", icon: "📰", type: "lesson" },
          { title: "Summarizing & Retelling", icon: "📝", type: "lesson" },
          { title: "Reading Poetry Closely", icon: "🌸", type: "elective" },
        ],
      },
      {
        title: "Writing Workshop", icon: "✍️", colorRamp: "amber",
        lessons: [
          { title: "The Writing Process", icon: "🔄", type: "lesson" },
          { title: "Narrative Writing: Story Structure", icon: "📕", type: "lesson" },
          { title: "Descriptive Details & Word Choice", icon: "🎨", type: "lesson" },
          { title: "Informational Writing: Paragraphs", icon: "📄", type: "lesson" },
          { title: "Opinion Writing: Claim & Evidence", icon: "💬", type: "lesson" },
          { title: "Revision & Editing Strategies", icon: "✏️", type: "elective" },
        ],
      },
      {
        title: "Grammar & Vocabulary", icon: "🔤", colorRamp: "green",
        lessons: [
          { title: "Nouns, Verbs & Adjectives", icon: "📚", type: "lesson" },
          { title: "Sentence Types & Punctuation", icon: "❗", type: "lesson" },
          { title: "Prefixes, Suffixes & Root Words", icon: "🌱", type: "lesson" },
          { title: "Figurative Language", icon: "🌈", type: "lesson" },
          { title: "Context Clues & Dictionary Skills", icon: "🔍", type: "elective" },
        ],
      },
    ],
  },

  // ── Grade 6 Math ──────────────────────────────────────────────────────────────
  "Pre-Algebra": {
    chapters: [
      {
        title: "Ratios & Proportional Reasoning", icon: "⚖️", colorRamp: "teal",
        lessons: [
          { title: "Understanding Ratios", icon: "📊", type: "lesson" },
          { title: "Unit Rates & Unit Pricing", icon: "🛒", type: "lesson" },
          { title: "Proportions & Cross-Multiplication", icon: "✖️", type: "lesson" },
          { title: "Percents & Conversions", icon: "%", type: "lesson" },
          { title: "Scaling & Similar Figures", icon: "📐", type: "lesson" },
          { title: "Ratio Applications: Maps & Scale", icon: "🗺️", type: "elective" },
        ],
      },
      {
        title: "Expressions & Equations", icon: "🔣", colorRamp: "blue",
        lessons: [
          { title: "Variables & Expressions", icon: "x", type: "lesson" },
          { title: "Writing & Evaluating Expressions", icon: "✏️", type: "lesson" },
          { title: "Properties of Operations", icon: "⚙️", type: "lesson" },
          { title: "One-Step Equations", icon: "=", type: "lesson" },
          { title: "Inequalities on a Number Line", icon: "📏", type: "lesson" },
          { title: "Patterns & Function Tables", icon: "📈", type: "elective" },
        ],
      },
      {
        title: "Geometry & Statistics", icon: "📐", colorRamp: "purple",
        lessons: [
          { title: "Area of Triangles & Quadrilaterals", icon: "🔷", type: "lesson" },
          { title: "Area of Composite Figures", icon: "⬜", type: "lesson" },
          { title: "Volume of Rectangular Prisms", icon: "📦", type: "lesson" },
          { title: "Mean, Median, Mode & Range", icon: "📊", type: "lesson" },
          { title: "Box Plots & Histograms", icon: "📉", type: "elective" },
        ],
      },
    ],
  },

  // ── Grade 6 Earth Science ─────────────────────────────────────────────────────
  "Earth Science": {
    chapters: [
      {
        title: "Earth's Structure & Plate Tectonics", icon: "🌋", colorRamp: "coral",
        lessons: [
          { title: "Layers of the Earth", icon: "🌍", type: "lesson" },
          { title: "Tectonic Plate Boundaries", icon: "🗺️", type: "lesson" },
          { title: "Earthquakes: Causes & Measurement", icon: "📳", type: "lesson" },
          { title: "Volcanoes & Volcanic Landforms", icon: "🌋", type: "lesson" },
          { title: "Mountain Building & Erosion", icon: "⛰️", type: "lesson" },
          { title: "The Rock Cycle", icon: "🪨", type: "elective" },
        ],
      },
      {
        title: "Weather & Climate", icon: "🌦️", colorRamp: "blue",
        lessons: [
          { title: "The Water Cycle", icon: "💧", type: "lesson" },
          { title: "Air Masses & Weather Fronts", icon: "🌬️", type: "lesson" },
          { title: "Reading Weather Maps", icon: "🗺️", type: "lesson" },
          { title: "Severe Weather: Hurricanes & Tornadoes", icon: "🌀", type: "lesson" },
          { title: "Climate Zones & Global Patterns", icon: "🌐", type: "lesson" },
          { title: "Climate Change & Evidence", icon: "🌡️", type: "elective" },
        ],
      },
      {
        title: "Astronomy & Space", icon: "🔭", colorRamp: "purple",
        lessons: [
          { title: "Earth's Rotation & Revolution", icon: "🌍", type: "lesson" },
          { title: "Phases of the Moon & Tides", icon: "🌙", type: "lesson" },
          { title: "The Solar System", icon: "🪐", type: "lesson" },
          { title: "Stars & the Life Cycle of Stars", icon: "⭐", type: "lesson" },
          { title: "Space Exploration History", icon: "🚀", type: "elective" },
        ],
      },
    ],
  },

  // ── Grade 6 US History ────────────────────────────────────────────────────────
  "US History": {
    chapters: [
      {
        title: "Colonial America & the Revolution", icon: "⛵", colorRamp: "teal",
        lessons: [
          { title: "Why Europeans Settled in America", icon: "🗺️", type: "lesson" },
          { title: "The Thirteen Colonies", icon: "🏘️", type: "lesson" },
          { title: "Taxation Without Representation", icon: "💰", type: "lesson" },
          { title: "Key Battles of the Revolution", icon: "⚔️", type: "lesson" },
          { title: "The Declaration of Independence", icon: "📜", type: "lesson" },
          { title: "Loyalists vs. Patriots", icon: "🗣️", type: "elective" },
        ],
      },
      {
        title: "Founding the Republic", icon: "🏛️", colorRamp: "blue",
        lessons: [
          { title: "Articles of Confederation & Its Failures", icon: "📄", type: "lesson" },
          { title: "The Constitutional Convention", icon: "✍️", type: "lesson" },
          { title: "Separation of Powers & Checks and Balances", icon: "⚖️", type: "lesson" },
          { title: "The Bill of Rights", icon: "📋", type: "lesson" },
          { title: "Washington & Hamilton: The First Government", icon: "🎩", type: "lesson" },
          { title: "Federalists vs. Anti-Federalists", icon: "📰", type: "elective" },
        ],
      },
      {
        title: "Expansion & Conflict", icon: "🦅", colorRamp: "amber",
        lessons: [
          { title: "Louisiana Purchase & Western Expansion", icon: "🗺️", type: "lesson" },
          { title: "The Trail of Tears & Native Displacement", icon: "🌿", type: "lesson" },
          { title: "Manifest Destiny", icon: "🌄", type: "lesson" },
          { title: "Causes of the Civil War", icon: "💣", type: "lesson" },
          { title: "The Abolitionist Movement", icon: "✊", type: "elective" },
        ],
      },
    ],
  },

  // ── Grade 8 Life Science ──────────────────────────────────────────────────────
  "Life Science": {
    chapters: [
      {
        title: "Cells: The Building Blocks of Life", icon: "🧬", colorRamp: "green",
        lessons: [
          { title: "Cell Theory & the History of Microscopy", icon: "🔬", type: "lesson" },
          { title: "Prokaryotic vs. Eukaryotic Cells", icon: "🔵", type: "lesson" },
          { title: "Cell Organelles & Their Functions", icon: "⚙️", type: "lesson" },
          { title: "Cell Membrane & Transport", icon: "🚪", type: "lesson" },
          { title: "Mitosis: Cell Division & Growth", icon: "✂️", type: "lesson" },
          { title: "Meiosis & Sexual Reproduction", icon: "🔄", type: "elective" },
        ],
      },
      {
        title: "Genetics & Heredity", icon: "🧬", colorRamp: "purple",
        lessons: [
          { title: "DNA Structure & Function", icon: "🔬", type: "lesson" },
          { title: "Genes, Traits & Inheritance", icon: "👨‍👩‍👧", type: "lesson" },
          { title: "Punnett Squares & Probability", icon: "⬛", type: "lesson" },
          { title: "Dominant vs. Recessive Traits", icon: "⚖️", type: "lesson" },
          { title: "Mutations & Genetic Variation", icon: "🔀", type: "lesson" },
          { title: "Genetic Engineering & Biotechnology", icon: "🧪", type: "elective" },
        ],
      },
      {
        title: "Evolution & Natural Selection", icon: "🦕", colorRamp: "amber",
        lessons: [
          { title: "Darwin & the Theory of Evolution", icon: "🐢", type: "lesson" },
          { title: "Evidence for Evolution: Fossils & Anatomy", icon: "🦴", type: "lesson" },
          { title: "Natural Selection: Survival of the Fittest", icon: "🦁", type: "lesson" },
          { title: "Adaptation & Speciation", icon: "🦋", type: "lesson" },
          { title: "Human Evolution", icon: "🧑‍🔬", type: "elective" },
        ],
      },
    ],
  },

  // ── Grade 8 Literature ────────────────────────────────────────────────────────
  Literature: {
    chapters: [
      {
        title: "Narrative Fiction & Story Craft", icon: "📕", colorRamp: "coral",
        lessons: [
          { title: "Plot Structure: Freytag's Pyramid", icon: "📈", type: "lesson" },
          { title: "Character Analysis: Motivation & Change", icon: "🎭", type: "lesson" },
          { title: "Setting & Atmosphere", icon: "🏚️", type: "lesson" },
          { title: "Point of View & Narrative Voice", icon: "👁️", type: "lesson" },
          { title: "Theme vs. Moral: The Big Idea", icon: "💡", type: "lesson" },
          { title: "Unreliable Narrators", icon: "❓", type: "elective" },
        ],
      },
      {
        title: "Literary Devices & Craft", icon: "🖊️", colorRamp: "blue",
        lessons: [
          { title: "Figurative Language: Simile, Metaphor, Personification", icon: "🌈", type: "lesson" },
          { title: "Symbolism & Imagery", icon: "🎨", type: "lesson" },
          { title: "Foreshadowing & Flashback", icon: "⏳", type: "lesson" },
          { title: "Irony: Dramatic, Verbal & Situational", icon: "😏", type: "lesson" },
          { title: "Tone vs. Mood", icon: "🎵", type: "lesson" },
          { title: "Allusion & Intertextuality", icon: "🔗", type: "elective" },
        ],
      },
      {
        title: "Analytical Writing", icon: "✍️", colorRamp: "teal",
        lessons: [
          { title: "The Literary Essay: Thesis & Evidence", icon: "📄", type: "lesson" },
          { title: "Citing Textual Evidence", icon: "📌", type: "lesson" },
          { title: "Analyzing Author's Craft", icon: "🔍", type: "lesson" },
          { title: "Compare & Contrast Texts", icon: "⚖️", type: "lesson" },
          { title: "Peer Review & Revision", icon: "✏️", type: "elective" },
        ],
      },
    ],
  },
};

// ── Assignment builders per node type ────────────────────────────────────────

type AssignmentRow = {
  id: string;
  organizationId: string;
  classId: string;
  title: string;
  description: string | null;
  contentType: "text" | "video" | "quiz" | "essay_questions" | "report" | "url" | "file" | "movie";
  contentRef: string | null;
  linkedAssignmentId: string | null;
  dueAt: string | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

function makeId() { return crypto.randomUUID(); }

// Subject+chapter-specific checkpoint quiz questions.
// Each entry is [question, optionA, optionB, optionC, optionD, correctIndex (0-based), explanation]
type QuizSpec = [string, string, string, string, string, number, string];

const CHAPTER_QUIZ_BANK: Record<string, QuizSpec[]> = {
  "Multiplication & Division": [
    ["What does 7 × 8 equal?", "48", "54", "56", "63", 2, "7 × 8 = 56. Tip: 7 × 7 = 49, plus one more 7 = 56."],
    ["Which is the correct area model for 4 × 23?", "4 × 20 + 4 × 3", "4 × 2 + 4 × 3", "4 + 20 + 3", "4 × 23 = 4 + 23", 0, "Area models break 23 into 20 + 3, then multiply each part by 4: 80 + 12 = 92."],
    ["84 ÷ 7 = ?", "11", "12", "13", "14", 1, "7 × 12 = 84, so 84 ÷ 7 = 12."],
    ["Which equation shows the relationship between multiplication and division?", "6 × 8 = 48, so 48 ÷ 6 = 8", "6 + 8 = 14, so 14 ÷ 6 = 8", "6 × 8 = 48, so 48 ÷ 8 = 6 only", "Division and multiplication are unrelated", 0, "Multiplication and division are inverse operations: if 6 × 8 = 48, then 48 ÷ 6 = 8 AND 48 ÷ 8 = 6."],
    ["A class has 96 crayons shared equally among 8 tables. How many crayons per table?", "8", "10", "12", "14", 2, "96 ÷ 8 = 12 crayons per table."],
  ],
  "Fractions & Mixed Numbers": [
    ["Which fraction is equivalent to 2/3?", "4/9", "4/6", "3/4", "6/8", 1, "2/3 = 4/6 because both numerator and denominator are multiplied by 2."],
    ["Which correctly converts 7/4 to a mixed number?", "1 3/4", "1 1/2", "2 1/4", "1 2/4", 0, "7 ÷ 4 = 1 remainder 3, so 7/4 = 1 and 3/4."],
    ["3/5 + 1/5 = ?", "4/10", "4/5", "3/10", "2/5", 1, "When denominators are the same, add the numerators: 3 + 1 = 4, so 4/5."],
    ["Which fraction is greater: 3/4 or 5/8?", "They are equal", "5/8", "3/4", "Cannot compare", 2, "Convert 3/4 to 6/8. Since 6/8 > 5/8, the fraction 3/4 is greater."],
    ["A pizza is cut into 8 slices. You eat 3 slices. What fraction did you eat?", "3/5", "5/8", "3/8", "1/3", 2, "You ate 3 out of 8 slices, which is 3/8."],
  ],
  "Geometry & Measurement": [
    ["What is the area of a rectangle that is 6 cm wide and 9 cm long?", "30 cm²", "54 cm²", "54 cm", "15 cm²", 1, "Area = length × width = 9 × 6 = 54 cm²."],
    ["An angle that measures exactly 90° is called a:", "Acute angle", "Obtuse angle", "Right angle", "Straight angle", 2, "A right angle measures exactly 90°, like the corner of a square."],
    ["A triangle with all three sides the same length is called:", "Scalene", "Isosceles", "Equilateral", "Right", 2, "Equilateral triangles have all three sides equal in length."],
    ["Which unit would you use to measure the weight of a textbook?", "Millimeters", "Liters", "Pounds", "Degrees", 2, "Pounds (or kilograms) measure weight. Millimeters and liters are for length and volume."],
    ["What is the perimeter of a square with side length 7 cm?", "28 cm", "49 cm", "14 cm", "21 cm", 0, "Perimeter of a square = 4 × side = 4 × 7 = 28 cm."],
  ],
  "Reading Comprehension": [
    ["The main idea of a passage is best described as:", "The first sentence of each paragraph", "The most important point the author is making", "A detail that supports an argument", "The title of the article", 1, "The main idea is the central message or argument the author wants you to take away."],
    ["When you make an inference, you:", "Copy a sentence directly from the text", "Use text evidence plus what you already know to figure something out", "Summarize the whole passage", "Look up a word in the dictionary", 1, "Inferences are conclusions we draw by combining text clues with our own background knowledge."],
    ["Author's purpose refers to:", "The topic of the text", "Why the author wrote the text (to inform, persuade, entertain)", "The author's favorite subject", "The length of the text", 1, "Authors write for specific reasons: to inform, persuade, or entertain."],
    ["A nonfiction text feature that helps you find information quickly is:", "A simile", "A plot twist", "An index or table of contents", "Dialogue between characters", 2, "Indexes and tables of contents help readers navigate nonfiction books quickly."],
    ["Which best describes a summary of a passage?", "A list of all the details", "A short retelling of only the most important ideas", "A copy of the first paragraph", "A new story about the same topic", 1, "A summary captures the key points briefly — not every detail, just the essentials."],
  ],
  "Writing Workshop": [
    ["Which is the correct order of the writing process?", "Draft, Prewrite, Revise, Edit, Publish", "Prewrite, Draft, Revise, Edit, Publish", "Edit, Draft, Prewrite, Revise, Publish", "Publish, Prewrite, Draft, Edit, Revise", 1, "Writers plan (prewrite), then draft, revise for ideas, edit for mechanics, then publish."],
    ["A narrative essay is best described as:", "A text that argues a position with evidence", "A story that uses vivid details and a clear sequence of events", "A list of facts about a topic", "A text that compares two things", 1, "Narrative writing tells a story using descriptive details, characters, and a clear sequence."],
    ["What is the purpose of a topic sentence?", "To end the paragraph", "To introduce the main idea of a paragraph", "To provide the most interesting detail", "To transition between paragraphs", 1, "A topic sentence tells the reader what the paragraph is going to be about."],
    ["In opinion writing, what must you always include to support your claim?", "Rhyming language", "Evidence and reasons", "A character's name", "A question for the reader", 1, "Strong opinion writing backs every claim with evidence — facts, examples, or expert opinions."],
    ["Which sentence uses the most vivid word choice?", "The dog walked.", "The old dog moved slowly.", "The arthritic beagle limped across the frosty yard.", "The dog went across the yard.", 2, "Vivid word choice uses specific, sensory details that paint a clear picture in the reader's mind."],
  ],
  "Grammar & Vocabulary": [
    ["In the sentence 'The quick brown fox jumps over the lazy dog,' which word is an adjective?", "jumps", "fox", "quick", "over", 2, "'Quick' describes the noun 'fox,' making it an adjective."],
    ["Which sentence is punctuated correctly?", "What time is it", "What time is it?", "What time is it!", "What, time is it?", 1, "Questions end with a question mark."],
    ["The prefix 'un-' means:", "again", "before", "not or opposite of", "half", 2, "Un- reverses the meaning: 'unhappy' means not happy."],
    ["Which is an example of a metaphor?", "Her smile was as bright as the sun.", "The thunder growled angrily.", "Time is a thief.", "She ran quickly.", 2, "A metaphor directly equates two things: 'Time IS a thief' (not 'like' a thief, which would be a simile)."],
    ["Using context clues, what does 'arid' most likely mean in this sentence: 'The desert was so arid that no plants could survive.'?", "cold", "crowded", "very dry", "beautiful", 2, "Context clue: 'no plants could survive' tells us arid means extremely dry."],
  ],
  "Ratios & Proportional Reasoning": [
    ["A recipe uses 2 cups of flour for every 3 cups of sugar. What is the ratio of flour to sugar?", "3:2", "2:3", "2:5", "5:2", 1, "The ratio of flour to sugar is 2:3, reading the order given in the problem."],
    ["If 4 apples cost $2.00, what is the unit price per apple?", "$0.25", "$0.50", "$0.75", "$1.00", 1, "Unit price = total cost ÷ quantity = $2.00 ÷ 4 = $0.50 per apple."],
    ["What percent is equivalent to 3/4?", "34%", "43%", "75%", "25%", 2, "3 ÷ 4 = 0.75 = 75%."],
    ["A map uses the scale 1 inch = 50 miles. Two cities are 4 inches apart on the map. How far apart are they really?", "54 miles", "150 miles", "200 miles", "46 miles", 2, "4 inches × 50 miles/inch = 200 miles."],
    ["Which proportion is correctly set up to solve: if 5 workers finish a job in 8 days, how long for 10 workers?", "5/8 = 10/x", "5/10 = x/8", "5 × 8 = 10 × x", "8/5 = x/10", 2, "More workers → fewer days (inverse). 5 × 8 = 10 × x gives x = 4 days."],
  ],
  "Expressions & Equations": [
    ["What is the value of 3x + 5 when x = 4?", "12", "17", "20", "7", 1, "3(4) + 5 = 12 + 5 = 17."],
    ["Which property allows you to rewrite 4 × (6 + 3) as 4 × 6 + 4 × 3?", "Commutative property", "Associative property", "Distributive property", "Identity property", 2, "The distributive property lets you multiply a factor by each addend: 4(6+3) = 24+12 = 36."],
    ["Solve: x − 9 = 14. What is x?", "5", "23", "126", "−5", 1, "Add 9 to both sides: x = 14 + 9 = 23."],
    ["Which inequality describes all numbers greater than 7?", "x < 7", "x = 7", "x > 7", "x ≤ 7", 2, "The symbol '>' means 'greater than.' So x > 7 means x is any number bigger than 7."],
    ["If f(x) = 2x − 1, what is f(5)?", "8", "9", "10", "11", 1, "f(5) = 2(5) − 1 = 10 − 1 = 9."],
  ],
  "Geometry & Statistics": [
    ["What is the area of a triangle with base 10 cm and height 6 cm?", "60 cm²", "30 cm²", "16 cm²", "32 cm²", 1, "Area of a triangle = ½ × base × height = ½ × 10 × 6 = 30 cm²."],
    ["A rectangular prism has length 5, width 4, and height 3. What is its volume?", "12", "60", "47", "120", 1, "Volume = l × w × h = 5 × 4 × 3 = 60 cubic units."],
    ["A data set is: 4, 7, 3, 9, 7. What is the median?", "3", "4", "7", "9", 2, "Order the data: 3, 4, 7, 7, 9. The middle value is 7."],
    ["What is the range of the data set: 12, 5, 18, 9, 3?", "15", "8", "10", "13", 0, "Range = highest − lowest = 18 − 3 = 15."],
    ["In a histogram, the bars represent:", "Individual data points", "Frequencies of data within intervals", "The median of the data", "The mean of the data", 1, "Histograms show how often data falls within a given range (interval)."],
  ],
  "Earth's Structure & Plate Tectonics": [
    ["Which layer of the Earth is the thinnest?", "Inner core", "Outer core", "Mantle", "Crust", 3, "Earth's crust is the thinnest layer — only 5–70 km thick compared to the 2,900 km mantle."],
    ["At a convergent plate boundary, the two plates:", "Move apart from each other", "Slide past each other horizontally", "Move toward each other and collide", "Do not move relative to each other", 2, "Convergent boundaries involve plates colliding, which can form mountains or ocean trenches."],
    ["The Richter scale measures:", "The speed of a tectonic plate", "The duration of an earthquake", "The magnitude (energy released) of an earthquake", "The depth of a volcano", 2, "The Richter scale measures the energy released by an earthquake."],
    ["Most volcanoes are located:", "Randomly across the globe", "Near the center of tectonic plates", "At tectonic plate boundaries", "Only in tropical regions", 2, "Volcanoes form where tectonic plates diverge or converge, releasing magma."],
    ["Which type of rock forms when lava cools and solidifies?", "Sedimentary", "Metamorphic", "Igneous", "Mineral", 2, "Igneous rock forms from cooled magma or lava."],
  ],
  "Weather & Climate": [
    ["During which stage of the water cycle does water vapor become liquid water in clouds?", "Evaporation", "Condensation", "Precipitation", "Transpiration", 1, "Condensation turns water vapor into tiny water droplets that form clouds."],
    ["A cold front occurs when:", "Warm air slides up over cold air", "Cold air pushes under warm air, lifting it rapidly", "Two air masses of the same temperature meet", "High pressure moves into an area", 1, "Cold fronts bring cold air undercutting warm air, often causing severe thunderstorms."],
    ["What drives Earth's global wind patterns?", "Ocean currents alone", "Unequal heating of Earth's surface and the Coriolis effect", "The tilt of Earth's axis only", "Volcanic activity", 1, "Uneven solar heating + the Coriolis effect from Earth's rotation creates the global wind belts."],
    ["Which best describes the difference between weather and climate?", "They mean the same thing", "Weather is long-term; climate is short-term", "Weather is short-term; climate is long-term patterns", "Climate only refers to temperature", 2, "Weather = current conditions; climate = average patterns over 30+ years."],
    ["Hurricanes get their energy from:", "Cold Arctic air masses", "Warm ocean water", "High-altitude jet streams", "Desert heat", 1, "Hurricanes are powered by the evaporation of warm ocean water (≥26°C)."],
  ],
  "Astronomy & Space": [
    ["Earth completes one full rotation on its axis in approximately:", "365 days", "28 days", "24 hours", "12 hours", 2, "Earth rotates once every ~24 hours, which gives us day and night."],
    ["A lunar month (full cycle of moon phases) takes approximately:", "7 days", "14 days", "28–29 days", "365 days", 2, "The moon takes about 29.5 days to complete all its phases as it orbits Earth."],
    ["What causes the seasons on Earth?", "Earth's distance from the Sun", "The tilt of Earth's axis relative to its orbit", "The speed of Earth's rotation", "Sunspot activity", 1, "Earth's 23.5° axial tilt causes different hemispheres to receive more/less direct sunlight throughout the year."],
    ["Which planet is the largest in our solar system?", "Saturn", "Neptune", "Earth", "Jupiter", 3, "Jupiter is the largest planet — it's so big that all other planets could fit inside it."],
    ["A star's life cycle ends as a:", "Planet", "Galaxy", "White dwarf, neutron star, or black hole, depending on its mass", "Comet", 2, "Massive stars end as supernovae leaving neutron stars or black holes; smaller stars become white dwarfs."],
  ],
  "Colonial America & the Revolution": [
    ["Which document declared the American colonies independent from Britain?", "The Magna Carta", "The Constitution", "The Declaration of Independence", "The Mayflower Compact", 2, "The Declaration of Independence, adopted July 4, 1776, formally declared independence from Britain."],
    ["The slogan 'No taxation without representation' expressed colonial anger over:", "Being forced to house British soldiers", "Paying taxes to a parliament where they had no elected delegates", "Losing trade rights with France", "Being denied freedom of religion", 1, "Colonists were taxed by the British Parliament but had no vote or representation in that body."],
    ["The Battle of Lexington and Concord is significant because:", "It was the last major battle of the Revolution", "It was the first military conflict of the American Revolution", "George Washington won a decisive victory there", "It took place in Philadelphia", 1, "The 'shot heard round the world' — the first shots of the Revolution were fired at Lexington in 1775."],
    ["Which best describes the difference between Patriots and Loyalists?", "Patriots wanted independence; Loyalists wanted to remain under British rule", "Loyalists wanted independence; Patriots supported the king", "Both groups supported independence", "Patriots were farmers; Loyalists were city dwellers", 0, "Patriots sought independence from Britain; Loyalists (Tories) believed in remaining loyal to the Crown."],
    ["Thomas Jefferson is most famous for:", "Winning the Battle of Yorktown", "Being the first Chief Justice", "Writing the Declaration of Independence", "Commanding the Continental Navy", 2, "Jefferson was the primary author of the Declaration of Independence."],
  ],
  "Founding the Republic": [
    ["The Articles of Confederation failed primarily because:", "They gave Congress too much power", "The central government was too weak with no power to tax or enforce laws", "The states refused to sign them", "They were only meant to be temporary", 1, "Under the Articles, Congress could not tax citizens or compel states to follow federal law — making the government ineffective."],
    ["The principle of 'checks and balances' ensures that:", "All three branches have equal budgets", "No single branch of government becomes too powerful", "The President can override the Supreme Court", "Congress makes all final decisions", 1, "Each branch has powers that limit the others, preventing any one from dominating."],
    ["The Bill of Rights was added to the Constitution primarily to:", "Reduce the size of government", "Protect individual freedoms from government overreach", "Define the powers of the President", "Establish the Supreme Court", 1, "The first 10 amendments protect freedoms like speech, religion, and due process."],
    ["Federalists like Hamilton believed:", "The states should have more power than the federal government", "A strong central government was necessary", "The Constitution should not be ratified", "America should remain a confederation", 1, "Federalists argued that a strong national government was essential for stability and effective governance."],
    ["George Washington set an important precedent by:", "Serving three terms as President", "Refusing to leave office", "Voluntarily stepping down after two terms", "Declaring himself king", 2, "Washington's voluntary retirement after two terms established the two-term tradition (later codified in the 22nd Amendment)."],
  ],
  "Expansion & Conflict": [
    ["The Louisiana Purchase doubled the size of the United States. Who sold this territory?", "Spain", "Britain", "France", "Mexico", 2, "Napoleon Bonaparte sold the Louisiana Territory to the U.S. in 1803 for $15 million."],
    ["The Trail of Tears refers to:", "A trade route between New England and the Mississippi", "The forced removal of Cherokee and other Native nations from their lands to Oklahoma", "The march of soldiers to fight in the Mexican-American War", "The westward path of the Oregon Trail", 1, "President Jackson's Indian Removal Act forced thousands of Native Americans west; thousands died on the journey."],
    ["Manifest Destiny was the 19th-century belief that:", "The U.S. should limit its territory to the original 13 colonies", "It was America's God-given right to expand across the continent to the Pacific", "Western territories should remain wilderness", "Native Americans should receive full citizenship", 1, "Manifest Destiny justified westward expansion as divinely ordained — with devastating consequences for Native peoples."],
    ["The primary cause of the Civil War was:", "Disagreements over tariff policy alone", "The issue of slavery and its expansion into new territories", "Britain's interference in American trade", "Disputes over the construction of railroads", 1, "While multiple factors played roles, slavery — particularly its expansion into western territories — was the central cause."],
    ["Frederick Douglass was significant because:", "He led the Confederate army", "He was an escaped slave who became a leading abolitionist and speaker", "He wrote the Emancipation Proclamation", "He was the first Black senator", 1, "Douglass used his powerful speeches and autobiography to expose the brutal reality of slavery and argue for abolition."],
  ],
  "Cells: The Building Blocks of Life": [
    ["Which scientist first observed cells using a microscope?", "Charles Darwin", "Louis Pasteur", "Robert Hooke", "Gregor Mendel", 2, "Robert Hooke coined the term 'cell' in 1665 after observing cork tissue under a microscope."],
    ["Which organelle is called the 'powerhouse of the cell'?", "Nucleus", "Ribosome", "Cell membrane", "Mitochondria", 3, "Mitochondria produce ATP (the cell's energy currency) through cellular respiration."],
    ["What is the main difference between prokaryotic and eukaryotic cells?", "Only eukaryotes have cell membranes", "Prokaryotes lack a membrane-bound nucleus; eukaryotes have one", "Prokaryotes are always larger than eukaryotes", "Only prokaryotes have ribosomes", 1, "Prokaryotes (like bacteria) have no nuclear membrane; eukaryotes (animals, plants, fungi) have a true nucleus."],
    ["The cell membrane's job is to:", "Produce energy for the cell", "Control what enters and exits the cell", "Store the cell's DNA", "Make proteins", 1, "The cell membrane is selectively permeable — it controls which substances pass in and out."],
    ["During mitosis, the result is:", "One cell with half the original chromosomes", "Two identical daughter cells with the same number of chromosomes", "Four genetically unique cells", "The destruction of the parent cell", 1, "Mitosis produces two genetically identical daughter cells — used for growth and repair."],
  ],
  "Genetics & Heredity": [
    ["DNA is shaped like:", "A straight ladder", "A single strand", "A double helix", "A sphere", 2, "DNA has a double helix structure — like a twisted ladder — discovered by Watson and Crick in 1953."],
    ["In a Punnett square cross of Tt × Tt, what fraction of offspring will be dominant (TT or Tt)?", "1/4", "1/2", "3/4", "All of them", 2, "The Punnett square gives TT, Tt, Tt, tt — 3 out of 4 (75%) show the dominant phenotype."],
    ["An organism's genotype refers to:", "Its observable physical traits", "Its genetic makeup (the alleles it carries)", "The environment it lives in", "How healthy it is", 1, "Genotype = the actual alleles (Aa, BB, etc.). Phenotype = the physical trait you can see."],
    ["Which of the following is an example of a recessive trait being expressed?", "A person with one allele for brown eyes and one for blue eyes having brown eyes", "Two parents with brown eyes having a blue-eyed child", "A parent passing a dominant allele to every child", "A single allele controlling many traits", 1, "A blue-eyed child from brown-eyed parents means both parents carry a hidden recessive allele (Bb × Bb → bb)."],
    ["A gene mutation is:", "Always harmful to the organism", "A permanent change in the DNA sequence", "The same as a genetic disease", "Impossible to inherit", 1, "Mutations are changes in the DNA sequence — they can be harmful, neutral, or occasionally beneficial."],
  ],
  "Evolution & Natural Selection": [
    ["Charles Darwin's voyage on the HMS Beagle led him to observe:", "That all species were created separately and never change", "That species vary and those best adapted to their environment survive and reproduce", "That Earth is only a few thousand years old", "That evolution happens within a single lifetime", 1, "Darwin's Galápagos observations showed that populations adapt over generations through natural selection."],
    ["Which provides evidence for evolution?", "The fact that all organisms need food", "Fossil records, DNA similarities, and homologous structures in different species", "The existence of different colors of flowers", "Organisms reproducing quickly", 1, "Multiple lines of evidence — fossils, DNA, anatomy — all point to common ancestry and evolution."],
    ["Natural selection acts on:", "Genotypes directly", "Individual organisms' choices", "Random mutations in a population", "Phenotypes — observable traits that affect survival and reproduction", 3, "Selection acts on what you can see (phenotype). Traits that help survival get passed on more often."],
    ["Two populations of the same species that become isolated and no longer interbreed may eventually become:", "The same species forever", "Extinct immediately", "Separate species through speciation", "More similar over time", 2, "Geographic or reproductive isolation leads to divergence — eventually the two populations become distinct species."],
    ["The phrase 'survival of the fittest' means:", "The strongest animal always wins", "The fastest animal always wins", "Organisms best adapted to their environment are most likely to reproduce", "Only predators survive", 2, "'Fitness' in biology means reproductive success — leaving behind offspring. A camouflaged moth is 'fit' for its environment."],
  ],
  "Narrative Fiction & Story Craft": [
    ["Freytag's Pyramid places the climax:", "At the very beginning of the story", "At the rising action", "At the peak of the pyramid, where tension is highest", "In the resolution", 2, "The climax is the story's turning point — the moment of highest tension before the conflict is resolved."],
    ["A dynamic character is one who:", "Appears in many scenes", "Remains the same throughout the story", "Undergoes significant change by the end", "Is the most powerful character", 2, "Dynamic characters grow, change, or learn something significant. Static characters stay the same."],
    ["Setting affects a story primarily by:", "Determining the protagonist's name", "Creating mood and influencing character behavior and plot", "Deciding the theme", "Having no impact on the plot", 1, "Setting shapes atmosphere, creates obstacles or advantages, and reflects characters' inner states."],
    ["In first-person narration, the narrator:", "Knows the thoughts of every character", "Is a character within the story, using 'I' and 'me'", "Tells the story from outside without being in it", "Speaks directly to another character only", 1, "First-person narrators are characters in the story — we experience events through their limited perspective."],
    ["Theme is best described as:", "A one-word topic like 'friendship'", "The setting of the story", "A universal message or insight about life conveyed by the story", "The summary of what happens", 2, "Theme is the 'so what?' — the deeper truth or insight about human experience the story reveals."],
  ],
  "Literary Devices & Craft": [
    ["'The classroom was a battlefield' is an example of:", "Simile", "Alliteration", "Metaphor", "Personification", 2, "A metaphor compares two unlike things directly (without 'like' or 'as'): the classroom IS a battlefield."],
    ["Which is an example of personification?", "Her laugh was like music.", "The storm roared and howled in fury.", "He ran as fast as a cheetah.", "The mountains stood tall.", 1, "Personification gives human qualities to non-human things. A storm can't literally roar in fury — that's a human action."],
    ["Foreshadowing in a story serves to:", "Confuse the reader deliberately", "Give hints about what will happen later in the story", "Explain what already happened", "Reveal the theme directly", 1, "Foreshadowing plants clues that make later events feel inevitable — it creates tension and rewards re-reading."],
    ["Dramatic irony occurs when:", "A character says something funny", "The reader knows something a character doesn't", "The opposite of what's expected happens", "Two characters disagree", 1, "Dramatic irony creates tension because we (the audience) know something the character doesn't — like knowing the villain is behind the door."],
    ["The tone of a piece of writing refers to:", "The overall emotion the reader feels", "The author's attitude toward the subject or audience", "The speed at which the plot moves", "The number of literary devices used", 1, "Tone = the author's attitude (ironic, melancholic, celebratory). Mood = how the reader feels."],
  ],
  "Analytical Writing": [
    ["A strong thesis statement for a literary essay should:", "State a plot summary", "Make an arguable claim about the text's meaning or craft", "Ask a question for the reader to answer", "List the literary devices used", 1, "A thesis stakes a specific, defensible claim about what the text means or how it works — not just what happens."],
    ["Textual evidence is most effectively used when:", "You quote as many long passages as possible", "You select a specific quote and then explain how it supports your claim", "You paraphrase everything without quotes", "You only cite the beginning and end of the text", 1, "The best evidence = specific quote + explanation of how it proves your point (the 'quote sandwich')."],
    ["When analyzing an author's craft, you should focus on:", "Whether you liked the book", "How literary choices (imagery, structure, word choice) create meaning or effect", "The author's biography", "A summary of the events", 1, "Craft analysis asks: why did the author make this choice, and what effect does it have on the reader?"],
    ["A compare-contrast essay requires you to:", "Only describe similarities between two texts", "Find and analyze both similarities and differences to reveal a deeper insight", "Summarize both texts completely before comparing", "Only discuss which text is better", 1, "Strong compare-contrast essays go beyond listing similarities/differences — they use comparison to argue a point."],
    ["The revision stage of writing differs from editing because revision focuses on:", "Correcting grammar and spelling errors", "Big-picture changes: ideas, structure, argument clarity, and evidence", "Formatting the document correctly", "Adding a title and author name", 1, "Revision = rethinking content and argument. Editing = fixing mechanics. Do them in that order."],
  ],
};

function getChapterQuizQuestions(chapterTitle: string, subject: string): QuizSpec[] {
  return CHAPTER_QUIZ_BANK[chapterTitle] ?? [
    [`What is the central focus of "${chapterTitle}" in ${subject}?`, "Optional enrichment only", "Core foundational concepts that build throughout the course", "Historical trivia unrelated to other topics", "Vocabulary terms only", 1, `${chapterTitle} covers essential concepts that support everything else in ${subject}.`],
    [`How does ${chapterTitle} connect to real-world situations?`, "It has no real-world applications", "The concepts apply to everyday situations and problems", "Only professionals use these ideas", "It only applies inside a classroom", 1, `${subject} concepts — including those in ${chapterTitle} — show up constantly in the real world.`],
    ["Which learning strategy works best when studying a new chapter?", "Read once and hope it sticks", "Re-read difficult sections and connect ideas to what you already know", "Skip sections that seem hard", "Memorize definitions without understanding them", 1, "Active reading — re-reading, connecting, questioning — dramatically improves retention and understanding."],
    [`What should you be able to do after completing ${chapterTitle}?`, "Recite facts from memory alone", "Explain key ideas in your own words with examples", "Copy definitions from the text", "Recognize vocabulary words only", 1, "True understanding means you can explain and apply concepts, not just repeat them."],
    ["How will you know you've mastered this chapter?", "You finished all the assignments", "You can explain the main ideas clearly to someone who hasn't studied them", "You got 100% on every quiz", "You read everything twice", 1, "The Feynman technique — teaching a concept in simple terms — is one of the best mastery checks."],
  ];
}

function milestoneAssignments(
  ctx: { orgId: string; classId: string; userId: string; now: string },
  chapterTitle: string,
  subject: string,
  gradeLevel: string,
): AssignmentRow[] {
  const base = { organizationId: ctx.orgId, classId: ctx.classId, createdByUserId: ctx.userId, createdAt: ctx.now, updatedAt: ctx.now, linkedAssignmentId: null, dueAt: null };
  const preQuizId = makeId();
  const checkpointQuizId = makeId();
  return [
    // 1. Chapter overview reading
    {
      ...base, id: makeId(),
      title: `Chapter Intro: ${chapterTitle}`,
      description: `Overview of what we'll explore in this chapter.`,
      contentType: "text",
      contentRef: `<p>Welcome to <strong>${chapterTitle}</strong>! In this chapter you will explore the key ideas, people, and events that shape our understanding of ${subject}. As you work through each lesson, look for connections between topics and ask yourself: <em>why does this matter?</em></p><p><strong>By the end of this chapter you will be able to:</strong></p><ul><li>Explain the core concepts in your own words</li><li>Give examples from real life</li><li>Connect what you learn here to other things you know</li></ul><p>Take your time with each lesson — understanding matters more than speed.</p><p>Before you begin, think about what you already know about <strong>${chapterTitle}</strong>. Write down one question you hope this chapter will answer. Keep it nearby — you can check it off when you find the answer!</p>`,
    },
    // 2. Diagnostic pre-assessment (activates prior knowledge)
    {
      ...base, id: preQuizId,
      title: `Warm-Up: What Do You Know About ${chapterTitle}?`,
      description: `Diagnostic check — not graded, just shows what you already know.`,
      contentType: "quiz",
      contentRef: JSON.stringify({
        title: `Pre-Assessment: ${chapterTitle}`,
        questions: [
          { question: `What comes to mind when you hear "${chapterTitle}"?`, options: ["Something familiar", "Completely new topic", "Heard of it, not sure", "Studied this before"], answerIndex: 3, explanation: "This is a diagnostic question — any answer helps us understand your starting point." },
          { question: `Which best describes what you think ${chapterTitle} involves?`, options: ["Facts and vocabulary", "Processes and steps", "People and events", "All of the above"], answerIndex: 3, explanation: "Great ${subject} chapters involve all of these!" },
          { question: "How confident do you feel about this topic right now?", options: ["Very confident", "A little confident", "Not very confident", "I've never heard of this"], answerIndex: 1, explanation: "Your confidence will grow as you work through the lessons." },
          { question: `Which question are you most curious about in ${subject}?`, options: ["How things work", "Why things happened", "Who was involved", "What effects it had"], answerIndex: 2, explanation: "All of these are great lenses for studying ${subject}." },
          { question: "What is the best way to learn something new?", options: ["Read and listen", "Practice and apply", "Teach someone else", "All of the above"], answerIndex: 3, explanation: "Research shows combining all three strategies leads to the best retention." },
        ],
      }),
    },
    // 3. Intro video 1
    {
      ...base, id: makeId(),
      title: `Watch: ${chapterTitle} Overview`,
      description: `Broad introduction video for grade ${gradeLevel} level.`,
      contentType: "video",
      contentRef: JSON.stringify({ videos: [{ videoId: `demo-${chapterTitle.toLowerCase().replace(/\W+/g, "-")}-overview`, title: `${chapterTitle} — Introduction`, channel: "Khan Academy", description: `A grade-${gradeLevel} overview of ${chapterTitle}.`, thumbnail: "https://i.ytimg.com/vi/demo/hqdefault.jpg", transcript: `This video introduces the key ideas in ${chapterTitle} for ${subject}.` }] }),
    },
    // 4. Intro video 2
    {
      ...base, id: makeId(),
      title: `Watch: ${chapterTitle} — Key Concepts`,
      description: `Second intro video focusing on the first major concept.`,
      contentType: "video",
      contentRef: JSON.stringify({ videos: [{ videoId: `demo-${chapterTitle.toLowerCase().replace(/\W+/g, "-")}-concepts`, title: `${chapterTitle} — Key Concepts`, channel: "CrashCourse", description: `Deeper look at the first key concept in ${chapterTitle}.`, thumbnail: "https://i.ytimg.com/vi/demo/hqdefault.jpg", transcript: `Now let's look more closely at the core concepts in ${chapterTitle}.` }] }),
    },
    // 5. Chapter checkpoint quiz
    {
      ...base, id: checkpointQuizId,
      title: `Chapter Quiz: ${chapterTitle}`,
      description: `Checkpoint quiz covering the chapter's core concepts.`,
      contentType: "quiz",
      contentRef: JSON.stringify({
        title: `${chapterTitle} — Chapter Quiz`,
        questions: getChapterQuizQuestions(chapterTitle, subject).map(([q, a, b, c, d, ai, exp]) => ({
          question: q, options: [a, b, c, d], answerIndex: ai, explanation: exp,
        })),
      }),
    },
    // 6. Chapter reflection essay
    {
      ...base, id: makeId(),
      title: `Reflect: ${chapterTitle}`,
      description: `Open-ended reflection connecting the chapter to your own experience.`,
      contentType: "essay_questions",
      contentRef: JSON.stringify({
        questions: [
          `What is the most interesting thing you learned in the ${chapterTitle} chapter, and why does it matter to you personally?`,
          `What question do you still have after finishing this chapter? What would you do to find the answer?`,
        ],
      }),
    },
  ];
}

function lessonAssignments(
  ctx: { orgId: string; classId: string; userId: string; now: string },
  lessonTitle: string,
  subject: string,
  gradeLevel: string,
  chapterTitle: string,
): AssignmentRow[] {
  const base = { organizationId: ctx.orgId, classId: ctx.classId, createdByUserId: ctx.userId, createdAt: ctx.now, updatedAt: ctx.now, linkedAssignmentId: null, dueAt: null };
  const slug = lessonTitle.toLowerCase().replace(/\W+/g, "-");
  return [
    // 1. Reading (400-600 words represented as structured HTML)
    {
      ...base, id: makeId(),
      title: `Reading: ${lessonTitle}`,
      description: `Instructional reading on ${lessonTitle} for grade ${gradeLevel}.`,
      contentType: "text",
      contentRef: `<h2>${lessonTitle}</h2><p><strong>${lessonTitle}</strong> is one of the key concepts in our study of <em>${chapterTitle}</em>. To understand it well, we need to look at what it is, why it matters, and how it connects to other ideas in ${subject}.</p><p>When we study ${lessonTitle}, we are really asking: <em>how does this work, and what does it mean?</em> Experts in ${subject} have spent years studying this topic, and their discoveries help us understand the world around us. As you read, pay attention to the main idea in each paragraph and how the examples support it.</p><p>One of the most important things to understand about ${lessonTitle} is that it does not exist in isolation — it connects to everything else in ${subject}. Think about how the ideas here relate to what you have already learned. Where do you see patterns? Where does something surprise you or challenge what you thought you knew?</p><h3>Before You Move On</h3><p>Write down these three things before going to the next assignment:</p><ul><li>The <strong>one most important idea</strong> from this reading</li><li>One <strong>example</strong> that helped it make sense</li><li>One <strong>question</strong> you still have</li></ul><p>This three-point summary is one of the most powerful study techniques in learning science.</p>`,
    },
    // 2. Video 1
    {
      ...base, id: makeId(),
      title: `Video: ${lessonTitle} Explained`,
      description: `Educational video explaining the core concept.`,
      contentType: "video",
      contentRef: JSON.stringify({ videos: [{ videoId: `demo-${slug}-explain`, title: `${lessonTitle} Explained`, channel: "Khan Academy", description: `Clear explanation of ${lessonTitle} for ${subject} grade ${gradeLevel}.`, thumbnail: "https://i.ytimg.com/vi/demo/hqdefault.jpg", transcript: `Let's explore ${lessonTitle}. This concept is important because it forms the foundation for everything else in ${chapterTitle}.` }] }),
    },
    // 3. Video 2
    {
      ...base, id: makeId(),
      title: `Video: ${lessonTitle} in Action`,
      description: `See the concept applied through examples and demonstrations.`,
      contentType: "video",
      contentRef: JSON.stringify({ videos: [{ videoId: `demo-${slug}-apply`, title: `${lessonTitle} — Real Examples`, channel: "CrashCourse", description: `${lessonTitle} shown through worked examples and real-world application.`, thumbnail: "https://i.ytimg.com/vi/demo/hqdefault.jpg", transcript: `Now let's see ${lessonTitle} in action with some real examples you can relate to.` }] }),
    },
    // 4. Formative check quiz (always present — mastery gate)
    {
      ...base, id: makeId(),
      title: `Check: ${lessonTitle}`,
      description: `Formative check — did you get the key idea from this lesson?`,
      contentType: "quiz",
      contentRef: JSON.stringify({
        title: `${lessonTitle} — Formative Check`,
        questions: [
          { question: `What is the central idea of ${lessonTitle}?`, options: ["A minor detail in " + subject, "A core concept that connects to " + chapterTitle, "An optional enrichment topic", "Something only experts need to know"], answerIndex: 1, explanation: `${lessonTitle} is a core concept that underpins much of ${chapterTitle}.` },
          { question: `Which best describes how ${lessonTitle} is applied?`, options: ["Only in textbooks", "Only in labs or experiments", "In real-world situations and examples", "It has no practical applications"], answerIndex: 2, explanation: `${lessonTitle} has direct real-world applications that make ${subject} relevant to daily life.` },
          { question: `What should you do if ${lessonTitle} is confusing?`, options: ["Skip it and move on", "Re-read the passage and rewatch the video", "Ask for easier content", "Assume it doesn't matter"], answerIndex: 1, explanation: "Re-reading and rewatching with fresh eyes often makes difficult concepts click." },
          { question: `How does ${lessonTitle} connect to ${chapterTitle}?`, options: ["It doesn't — it's a separate topic", "It is one piece of the larger chapter picture", "It replaces the need to learn the rest", "It only matters for tests"], answerIndex: 1, explanation: `${lessonTitle} is one piece of the ${chapterTitle} puzzle — each lesson builds on the others.` },
          { question: "What is the best way to make sure you remember this lesson?", options: ["Read it one more time", "Explain it to someone else in your own words", "Write the title 10 times", "Highlight everything"], answerIndex: 1, explanation: "Retrieval practice — recalling and explaining what you learned — is the strongest memory technique." },
        ],
      }),
    },
    // 5. Practice response (essay_questions — apply the concept)
    {
      ...base, id: makeId(),
      title: `Practice: ${lessonTitle}`,
      description: `Apply what you learned — explain it in your own words.`,
      contentType: "essay_questions",
      contentRef: JSON.stringify({
        questions: [
          `Explain ${lessonTitle} in your own words, as if you were teaching it to a younger student. Use at least one example.`,
          `How does ${lessonTitle} connect to something you already knew before this lesson? Describe the connection.`,
        ],
      }),
    },
  ];
}

function electiveAssignments(
  ctx: { orgId: string; classId: string; userId: string; now: string },
  lessonTitle: string,
  subject: string,
  gradeLevel: string,
  chapterTitle: string,
): AssignmentRow[] {
  const base = { organizationId: ctx.orgId, classId: ctx.classId, createdByUserId: ctx.userId, createdAt: ctx.now, updatedAt: ctx.now, linkedAssignmentId: null, dueAt: null };
  const slug = lessonTitle.toLowerCase().replace(/\W+/g, "-");
  return [
    // 1. Deep-dive reading (500-750 words)
    {
      ...base, id: makeId(),
      title: `Deep Dive: ${lessonTitle}`,
      description: `Advanced reading exploring ${lessonTitle} in greater depth.`,
      contentType: "text",
      contentRef: `<h2>Deep Dive: ${lessonTitle}</h2><p><strong>${lessonTitle}</strong> goes well beyond what most students encounter in a standard ${subject} course. In this deep dive, we will look at the advanced ideas, controversies, and real-world implications that make this topic genuinely fascinating to experts in the field.</p><p>One of the surprising things about ${lessonTitle} is how much is still being discovered. Researchers continue to find new evidence that challenges old assumptions and opens new questions. This is what makes ${subject} exciting — it is a living, changing body of knowledge, not just a set of facts to memorize.</p><h3>How to Read Like an Expert</h3><ul><li><strong>Predict</strong> — before reading each section, predict what comes next</li><li><strong>Question</strong> — ask why the author chose each example</li><li><strong>Connect</strong> — link new ideas to what you already know from ${chapterTitle}</li><li><strong>Challenge</strong> — notice where you agree or disagree, and why</li></ul><p>When we look more closely at ${lessonTitle}, we see layers that a quick reading misses. The underlying mechanisms, the historical development of the idea, and the ways it interacts with other concepts in ${chapterTitle} all reveal something richer than the surface summary. Take your time with this reading — let the complexity sink in.</p><p>As you finish this deep dive, your goal is not just to understand ${lessonTitle} — it is to have an informed opinion about it. What do you think? What would you want to investigate further? The ability to form evidence-based opinions is one of the highest-level skills in ${subject}.</p>`,
    },
    // 2. Video 1
    {
      ...base, id: makeId(),
      title: `Video: ${lessonTitle} — Advanced Exploration`,
      description: `Documentary-style deep dive into the topic.`,
      contentType: "video",
      contentRef: JSON.stringify({ videos: [{ videoId: `demo-${slug}-advanced`, title: `${lessonTitle} — Advanced`, channel: "TED-Ed", description: `In-depth exploration of ${lessonTitle} for advanced learners.`, thumbnail: "https://i.ytimg.com/vi/demo/hqdefault.jpg", transcript: `Welcome to this advanced exploration of ${lessonTitle}. We'll go beyond the basics and look at what experts are discovering.` }] }),
    },
    // 3. Video 2
    {
      ...base, id: makeId(),
      title: `Video: ${lessonTitle} — Case Study`,
      description: `Real-world case study or documentary example.`,
      contentType: "video",
      contentRef: JSON.stringify({ videos: [{ videoId: `demo-${slug}-case`, title: `${lessonTitle} Case Study`, channel: "National Geographic", description: `A real-world case study connecting ${lessonTitle} to contemporary issues.`, thumbnail: "https://i.ytimg.com/vi/demo/hqdefault.jpg", transcript: `This case study shows how ${lessonTitle} plays out in the real world.` }] }),
    },
    // 4. Analysis quiz (requires analysis, not just recall)
    {
      ...base, id: makeId(),
      title: `Analysis Check: ${lessonTitle}`,
      description: `Higher-order thinking quiz — analysis and application required.`,
      contentType: "quiz",
      contentRef: JSON.stringify({
        title: `${lessonTitle} — Analysis Check`,
        questions: [
          { question: `What is the most significant implication of ${lessonTitle} for ${subject}?`, options: ["It has no significant implications", "It changes how we understand " + chapterTitle, "It only matters for academic study", "It replaces all previous knowledge"], answerIndex: 1, explanation: `${lessonTitle} has real implications for how we understand ${chapterTitle} and beyond.` },
          { question: `If you were to challenge the conventional understanding of ${lessonTitle}, what evidence would you need?`, options: ["No evidence needed", "Only personal opinion", "Peer-reviewed research and data", "A single contradicting example"], answerIndex: 2, explanation: "Strong challenges to established ideas require solid evidence from reliable sources." },
          { question: `How might ${lessonTitle} look different in 50 years as the field of ${subject} evolves?`, options: ["Exactly the same", "Completely eliminated", "Refined and expanded with new evidence", "Moved to a different subject"], answerIndex: 2, explanation: "Knowledge in any field evolves — today's understanding becomes tomorrow's foundation." },
          { question: `What is the connection between ${lessonTitle} and real-world problem solving?`, options: ["There is no connection", "It provides tools for analyzing real situations", "It is purely theoretical", "Only professionals can apply it"], answerIndex: 1, explanation: `${lessonTitle} gives you analytical tools you can apply to real problems in ${subject} and beyond.` },
          { question: "What separates someone with surface understanding from someone with deep understanding of this topic?", options: ["The ability to memorize definitions", "The ability to explain, apply, and connect ideas", "The ability to finish assignments quickly", "The amount of time spent reading"], answerIndex: 1, explanation: "Deep understanding means you can explain, apply to new situations, and connect to other knowledge." },
        ],
      }),
    },
    // 5. Hands-on project (always present for electives)
    {
      ...base, id: makeId(),
      title: `Project: ${lessonTitle}`,
      description: `Create something that demonstrates your deep understanding.`,
      contentType: "report",
      contentRef: `<p><strong>Project Goal:</strong> Create an artifact that demonstrates your understanding of ${lessonTitle} and its place within ${chapterTitle}.</p><p><strong>Choose one format:</strong></p><ul><li>A detailed diagram with annotations</li><li>A written report (300–400 words)</li><li>A poster or infographic</li><li>A short presentation outline (5 key points with evidence)</li></ul><p><strong>What to include:</strong></p><ul><li>A clear explanation of ${lessonTitle} in your own words</li><li>Two or more examples or pieces of evidence</li><li>A connection to something else you've learned in ${subject}</li><li>Your own opinion or a question you still have</li></ul><p><strong>How you'll be evaluated:</strong> Accuracy of information, clarity of explanation, quality of examples, and evidence of your own thinking — not just copying from the reading.</p>`,
    },
  ];
}

function bossAssignments(
  ctx: { orgId: string; classId: string; userId: string; now: string },
  unitTitle: string,
  subject: string,
  gradeLevel: string,
  chapterTitles: string[],
): AssignmentRow[] {
  const base = { organizationId: ctx.orgId, classId: ctx.classId, createdByUserId: ctx.userId, createdAt: ctx.now, updatedAt: ctx.now, linkedAssignmentId: null, dueAt: null };
  const chaptersListed = chapterTitles.join(", ");
  return [
    // 1. Comprehensive unit review (600-900 words)
    {
      ...base, id: makeId(),
      title: `Unit Review: ${unitTitle}`,
      description: `Comprehensive review of all key concepts from this unit.`,
      contentType: "text",
      contentRef: `<h2>Unit Review: ${unitTitle}</h2><p>You have covered a lot of ground in this unit on ${subject}. This review will help you see the whole picture before your summative assessments. The chapters you completed — ${chaptersListed} — are not separate islands of information. They are deeply connected, and understanding those connections is the mark of real mastery.</p><h3>Three Big Ideas to Master</h3><ul><li><strong>Foundation</strong> — the concepts that everything else builds on. These are the ideas you need to be able to explain without looking at your notes. If any of these feel shaky, go back and review the reading or rewatch a video before attempting the summative quiz.</li><li><strong>Application</strong> — taking what you know and using it to explain something new. This is where ${subject} becomes genuinely powerful. The real test of understanding is whether you can pick up a new problem or question and use those tools to make progress on it.</li><li><strong>Synthesis</strong> — seeing how the chapters fit together into a coherent whole. What is the overarching story or argument that ties the unit together? Being able to answer this question is the highest level of understanding.</li></ul><h3>How to Prepare</h3><p>Try this strategy: without looking at any notes, write down the three most important things you learned in this unit. Then check your notes and reading to see what you missed. The gap between what you thought you knew and what you actually know is exactly where your studying should focus.</p><p>Good luck — you've done the work, and now it's time to show what you know.</p>`,
    },
    // 2-4. Three summative quizzes (one per concept cluster)
    {
      ...base, id: makeId(),
      title: `Unit Quiz 1: Foundations — ${unitTitle}`,
      description: `Summative quiz covering foundational concepts from the first chapter area.`,
      contentType: "quiz",
      contentRef: JSON.stringify({
        title: `${unitTitle} — Foundations Quiz`,
        questions: [
          { question: `Which statement best describes the foundational concepts in ${unitTitle}?`, options: ["They are optional background information", "They underpin all subsequent learning in this unit", "They are only relevant to advanced students", "They stand alone from the rest of the unit"], answerIndex: 1, explanation: "Foundational concepts are load-bearing — everything else in the unit depends on them." },
          { question: `How should you approach a topic in ${subject} that feels confusing?`, options: ["Skip it — it probably won't be tested", "Re-read, rewatch, and try to explain it aloud", "Just memorize the definition", "Ask someone else to summarize it for you"], answerIndex: 1, explanation: "Active re-engagement and self-explanation are the most effective strategies for difficult material." },
          { question: `What distinguishes a strong response in ${subject} from a weak one?`, options: ["Length alone", "Use of evidence and examples", "Number of vocabulary words used", "How quickly it was written"], answerIndex: 1, explanation: "Strong responses in any subject use specific evidence and examples to support their claims." },
          { question: `Which of the following is the best way to connect ${unitTitle} to prior knowledge?`, options: ["Look for surface similarities in vocabulary", "Identify underlying principles that appear in both topics", "Assume there are no connections", "Only look forward to future topics"], answerIndex: 1, explanation: "Deep connections happen at the level of underlying principles, not just vocabulary." },
          { question: "What role does making mistakes play in learning?", options: ["Mistakes are signs of failure", "Mistakes show what to study next and strengthen memory", "Mistakes should be hidden", "Mistakes only matter for graded work"], answerIndex: 1, explanation: "Research shows that making and correcting mistakes is one of the most powerful learning experiences." },
        ],
      }),
    },
    {
      ...base, id: makeId(),
      title: `Unit Quiz 2: Application — ${unitTitle}`,
      description: `Summative quiz requiring application of concepts to new scenarios.`,
      contentType: "quiz",
      contentRef: JSON.stringify({
        title: `${unitTitle} — Application Quiz`,
        questions: [
          { question: `If you had to teach ${unitTitle} to someone who had never heard of it, where would you start?`, options: ["With the most advanced concept", "With the most interesting fact you remember", "With the foundational concept that everything else builds on", "With a quiz to test their prior knowledge"], answerIndex: 2, explanation: "Good teaching always starts with the foundation that makes everything else make sense." },
          { question: `What would a real-world application of ${unitTitle} look like?`, options: ["A theoretical exercise with no practical value", "Solving a genuine problem or explaining a real phenomenon", "Something only done in academic settings", "An activity unrelated to everyday life"], answerIndex: 1, explanation: `The concepts in ${unitTitle} have genuine real-world applications in ${subject} and beyond.` },
          { question: `How would an expert in ${subject} approach a new problem related to ${unitTitle}?`, options: ["By memorizing more facts", "By applying known principles to analyze the new situation", "By guessing based on intuition", "By waiting for more information"], answerIndex: 1, explanation: "Experts apply principles — they don't memorize every possible scenario, they analyze new ones." },
          { question: `What evidence would you use to support a claim about ${unitTitle}?`, options: ["Personal opinion only", "Data, examples, or established research", "What sounds most convincing", "The simplest explanation available"], answerIndex: 1, explanation: "Evidence-based reasoning is the cornerstone of ${subject} and academic thinking generally." },
          { question: `How has your understanding of ${subject} changed after studying ${unitTitle}?`, options: ["It hasn't changed at all", "I now see connections I didn't see before", "I know fewer things with certainty now", "The subject seems harder with no benefit"], answerIndex: 1, explanation: "Growth in understanding often means seeing more connections and nuance — that's a sign of real learning." },
        ],
      }),
    },
    {
      ...base, id: makeId(),
      title: `Unit Quiz 3: Synthesis — ${unitTitle}`,
      description: `Summative quiz requiring synthesis across the full unit.`,
      contentType: "quiz",
      contentRef: JSON.stringify({
        title: `${unitTitle} — Synthesis Quiz`,
        questions: [
          { question: `What is the overarching theme that connects all the chapters in ${unitTitle}?`, options: ["Each chapter is completely independent", "There is a connecting story or argument running through the whole unit", "Only the boss node matters", "The theme is different for every student"], answerIndex: 1, explanation: "Well-designed units have a coherent through-line — a big idea that ties everything together." },
          { question: `Which chapter in ${unitTitle} do you think was most important, and why?`, options: ["The first one, because it was first", "The one with the most vocabulary", "The one whose concepts appear most often in other chapters", "The shortest one"], answerIndex: 2, explanation: "The most important chapter is usually the one whose concepts reappear throughout the rest of the unit." },
          { question: `How would the unit be different if one of the chapters was removed?`, options: ["It would be exactly the same", "There would be a gap in understanding that would make later concepts harder", "It would actually be easier to understand", "Only the quizzes would be affected"], answerIndex: 1, explanation: "Removing a chapter creates a conceptual gap — this is why every part of a well-designed curriculum matters." },
          { question: `What question about ${subject} does ${unitTitle} raise that you want to explore further?`, options: ["No new questions — everything is answered", "A deeper version of one of the chapter questions", "Questions about an entirely unrelated subject", "Questions about how to memorize more"], answerIndex: 1, explanation: "Good learning raises better questions than it started with — that's a sign of growing understanding." },
          { question: `How would you summarize ${unitTitle} in one sentence for someone who had never studied ${subject}?`, options: ["I would just give them the textbook", "I would explain the single most important idea in plain language", "I would list all the vocabulary words", "I would say it's too complicated to summarize"], answerIndex: 1, explanation: "Being able to summarize a complex topic simply is the ultimate test of understanding." },
        ],
      }),
    },
    // 5. Analytical essay (always at least 1 for boss nodes)
    {
      ...base, id: makeId(),
      title: `Essay: ${unitTitle}`,
      description: `Analytical essay requiring synthesis and argument across the full unit.`,
      contentType: "essay_questions",
      contentRef: JSON.stringify({
        questions: [
          `Choose the concept from ${unitTitle} that you found most surprising or that challenged your prior understanding. Explain what you originally thought, what you learned, and why this change in thinking matters. Use specific evidence from at least two different lessons.`,
          `If you could add one more chapter to ${unitTitle}, what would it cover and why? Explain how it would connect to what was already covered and what gap in understanding it would fill.`,
        ],
      }),
    },
  ];
}

export const seedDemoWorkspaceContent = createServerFn({ method: "POST" })
  .inputValidator((data) => contentResetWithPinInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    await verifyParentPinForSession(session.user.id, data.parentPin);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const existingDemoClass = await db.query.classes.findFirst({
      where: and(
        eq(classes.organizationId, organizationId),
        sql`${classes.title} like 'Demo · %'`,
      ),
    });

    if (existingDemoClass) {
      throw new Error("DEMO_CONTENT_ALREADY_EXISTS");
    }

    const schoolYear = getCurrentSchoolYearLabel();
    const nowDate = new Date();
    const monday = new Date(nowDate);
    const day = monday.getDay();
    const shift = day === 0 ? -6 : 1 - day;
    monday.setDate(monday.getDate() + shift);
    monday.setHours(0, 0, 0, 0);
    const nowStr = nowDate.toISOString();

    const ctx = { orgId: organizationId, userId: session.user.id, now: nowStr };

    // ── Phase 1: Profiles ────────────────────────────────────────────────────
    const pinHash = await hashStudentPin("1111");
    const profileRows: Record<string, unknown>[] = [];
    const profileIdMap: Record<string, string> = {}; // displayName → profileId

    for (const student of DEMO_STUDENTS) {
      const profileId = crypto.randomUUID();
      profileIdMap[student.displayName] = profileId;
      profileRows.push({
        id: profileId,
        organizationId,
        parentUserId: session.user.id,
        displayName: student.displayName,
        gradeLevel: student.gradeLevel,
        pinHash,
        status: "active",
      });
    }
    await batchInsert(db, profiles, profileRows);

    // ── Phase 2: Classes + enrollments ───────────────────────────────────────
    type ClassMeta = { classId: string; profileId: string; subject: string; gradeLevel: string };
    const classRows: Record<string, unknown>[] = [];
    const enrollmentRows: Record<string, unknown>[] = [];
    const classMetas: ClassMeta[] = [];

    for (const student of DEMO_STUDENTS) {
      const profileId = profileIdMap[student.displayName]!;
      for (const subject of student.subjects) {
        const classId = crypto.randomUUID();
        classMetas.push({ classId, profileId, subject, gradeLevel: student.gradeLevel });
        classRows.push({
          id: classId,
          organizationId,
          title: `Demo · Grade ${student.gradeLevel} ${subject}`,
          description: `Demo curriculum for ${student.displayName}`,
          schoolYear,
          createdByUserId: session.user.id,
        });
        enrollmentRows.push({ id: crypto.randomUUID(), classId, profileId });
      }
    }
    await batchInsert(db, classes, classRows);
    await batchInsert(db, classEnrollments, enrollmentRows);

    // ── Phase 3: Skill trees + nodes ─────────────────────────────────────────
    // One skill tree per class. Each tree follows DEMO_CURRICULA:
    //   chapter → milestone node
    //   chapter.lessons → lesson/elective nodes in a branch
    //   final → boss node
    //
    // Layout: chapters arranged in columns (x), nodes in each chapter stacked (y)
    //   milestone sits at top of each chapter column
    //   lessons fan out diagonally below
    //   boss is centered at the far right

    type NodeMeta = {
      nodeId: string;
      treeId: string;
      classId: string;
      profileId: string;
      subject: string;
      gradeLevel: string;
      nodeType: "milestone" | "lesson" | "elective" | "boss";
      nodeTitle: string;
      chapterTitle: string;
      unitTitle: string;
      chapterTitles: string[];
      nodeIndex: number;   // absolute index within tree (for progress/due-date spreading)
    };

    const treeRows: Record<string, unknown>[] = [];
    const nodeRows: Record<string, unknown>[] = [];
    const nodeMetas: NodeMeta[] = [];

    for (const cls of classMetas) {
      const treeId = crypto.randomUUID();
      const spec = DEMO_CURRICULA[cls.subject];
      if (!spec) continue;
      const unitTitle = `${cls.subject} — Grade ${cls.gradeLevel}`;
      const chapterTitles = spec.chapters.map((c) => c.title);

      treeRows.push({
        id: treeId,
        organizationId,
        classId: cls.classId,
        profileId: cls.profileId,
        title: `Demo Skill Map · Grade ${cls.gradeLevel} ${cls.subject}`,
        description: `Full ${cls.subject} curriculum for Grade ${cls.gradeLevel}`,
        gradeLevel: cls.gradeLevel,
        subject: cls.subject,
        schoolYear,
        createdByUserId: session.user.id,
      });

      let nodeIndex = 0;
      const CHAPTER_COL_GAP = 280;
      const ROW_GAP = 120;

      for (const [chIdx, chapter] of spec.chapters.entries()) {
        const colX = 120 + chIdx * CHAPTER_COL_GAP;

        // Milestone node (chapter entry)
        const milestoneId = crypto.randomUUID();
        nodeRows.push({
          id: milestoneId,
          treeId,
          organizationId,
          title: chapter.title,
          description: `Chapter overview: ${chapter.title}`,
          subject: cls.subject,
          icon: chapter.icon,
          colorRamp: chapter.colorRamp,
          nodeType: "milestone",
          xpReward: 150,
          positionX: colX,
          positionY: 80,
          radius: 30,
          isRequired: true,
        });
        nodeMetas.push({
          nodeId: milestoneId, treeId, classId: cls.classId, profileId: cls.profileId,
          subject: cls.subject, gradeLevel: cls.gradeLevel,
          nodeType: "milestone", nodeTitle: chapter.title, chapterTitle: chapter.title,
          unitTitle, chapterTitles, nodeIndex,
        });
        nodeIndex += 1;

        // Lesson / elective nodes
        for (const [lesIdx, les] of chapter.lessons.entries()) {
          const lessonId = crypto.randomUUID();
          const isElective = les.type === "elective";
          // Fan out: odd lessons go slightly left, even slightly right
          const xOffset = lesIdx % 2 === 0 ? -60 : 60;
          nodeRows.push({
            id: lessonId,
            treeId,
            organizationId,
            title: les.title,
            description: `${isElective ? "Elective deep-dive" : "Core lesson"}: ${les.title}`,
            subject: cls.subject,
            icon: les.icon,
            colorRamp: chapter.colorRamp,
            nodeType: les.type,
            xpReward: isElective ? 80 : 100,
            positionX: colX + xOffset,
            positionY: 80 + ROW_GAP + lesIdx * ROW_GAP,
            radius: isElective ? 14 : 20,
            isRequired: !isElective,
          });
          nodeMetas.push({
            nodeId: lessonId, treeId, classId: cls.classId, profileId: cls.profileId,
            subject: cls.subject, gradeLevel: cls.gradeLevel,
            nodeType: les.type as "lesson" | "elective", nodeTitle: les.title,
            chapterTitle: chapter.title, unitTitle, chapterTitles, nodeIndex,
          });
          nodeIndex += 1;
        }
      }

      // Boss node — centered at far right
      const bossId = crypto.randomUUID();
      const bossX = 120 + spec.chapters.length * CHAPTER_COL_GAP;
      nodeRows.push({
        id: bossId,
        treeId,
        organizationId,
        title: `${cls.subject} Mastery Assessment`,
        description: `Unit boss: summative review of all ${cls.subject} chapters`,
        subject: cls.subject,
        icon: "🏆",
        colorRamp: "blue",
        nodeType: "boss",
        xpReward: 300,
        positionX: bossX,
        positionY: 80 + Math.floor(spec.chapters[0]!.lessons.length / 2) * ROW_GAP,
        radius: 40,
        isRequired: true,
      });
      nodeMetas.push({
        nodeId: bossId, treeId, classId: cls.classId, profileId: cls.profileId,
        subject: cls.subject, gradeLevel: cls.gradeLevel,
        nodeType: "boss", nodeTitle: `${cls.subject} Mastery Assessment`,
        chapterTitle: "", unitTitle, chapterTitles, nodeIndex,
      });
    }

    await batchInsert(db, skillTrees, treeRows);
    await batchInsert(db, skillTreeNodes, nodeRows);

    // ── Phase 4: Assignments ──────────────────────────────────────────────────
    // Build all assignment rows first, then batch-insert them.
    // Also collect nodeAssignment link rows and weekPlan rows.

    type NodeAssignmentRow = { id: string; nodeId: string; assignmentId: string; orderIndex: number };
    type WeekPlanRow = { id: string; organizationId: string; profileId: string; assignmentId: string; scheduledDate: string; orderIndex: number };

    const assignmentRows: AssignmentRow[] = [];
    const nodeAssignmentRows: NodeAssignmentRow[] = [];
    const weekPlanRows: WeekPlanRow[] = [];

    // Track first quiz / first essay per class for sample submissions
    type SubmissionSeed = { assignmentId: string; profileId: string; type: "quiz" | "written" };
    const submissionSeeds: SubmissionSeed[] = [];

    // Track a sample assignment per class for templates
    type TemplateSeed = { subject: string; gradeLevel: string; assignment: AssignmentRow };
    const templateSeeds: TemplateSeed[] = [];
    const templateClassesSeen = new Set<string>(); // classId

    // Group nodeMetas by treeId so we can spread due dates per-tree
    const byTree = new Map<string, NodeMeta[]>();
    for (const nm of nodeMetas) {
      const arr = byTree.get(nm.treeId) ?? [];
      arr.push(nm);
      byTree.set(nm.treeId, arr);
    }

    let weekPlanGlobalOrder = 0;

    for (const [treeId, treeNodes] of byTree.entries()) {
      const firstNode = treeNodes[0];
      if (!firstNode) continue;
      const { classId, profileId, subject, gradeLevel } = firstNode;
      let firstQuizId: string | null = null;
      let firstEssayId: string | null = null;
      let weekPlanPerTree = 0;

      for (const nm of treeNodes) {
        const nodeCtx = { ...ctx, classId: nm.classId };
        let built: AssignmentRow[];
        if (nm.nodeType === "milestone") {
          built = milestoneAssignments(nodeCtx, nm.nodeTitle, subject, gradeLevel);
        } else if (nm.nodeType === "elective") {
          built = electiveAssignments(nodeCtx, nm.nodeTitle, nm.chapterTitle, subject, gradeLevel);
        } else if (nm.nodeType === "boss") {
          built = bossAssignments(nodeCtx, nm.unitTitle, subject, gradeLevel, nm.chapterTitles);
        } else {
          built = lessonAssignments(nodeCtx, nm.nodeTitle, nm.chapterTitle, subject, gradeLevel);
        }

        // Assign due dates spread across 28 days per tree
        for (const [orderIdx, asgn] of built.entries()) {
          const dueAt = new Date(monday);
          dueAt.setDate(monday.getDate() + ((nm.nodeIndex + orderIdx) % 28));
          dueAt.setHours(15 + (orderIdx % 3), 0, 0, 0);
          asgn.dueAt = dueAt.toISOString();
          asgn.organizationId = organizationId;

          assignmentRows.push(asgn);
          nodeAssignmentRows.push({ id: crypto.randomUUID(), nodeId: nm.nodeId, assignmentId: asgn.id, orderIndex: orderIdx });

          // Week plan: first assignment of each node, up to 15 per tree
          if (orderIdx === 0 && weekPlanPerTree < 15) {
            weekPlanRows.push({
              id: crypto.randomUUID(),
              organizationId,
              profileId: nm.profileId,
              assignmentId: asgn.id,
              scheduledDate: dueAt.toISOString().slice(0, 10),
              orderIndex: weekPlanGlobalOrder,
            });
            weekPlanGlobalOrder += 1;
            weekPlanPerTree += 1;
          }

          if (!firstQuizId && asgn.contentType === "quiz") firstQuizId = asgn.id;
          if (!firstEssayId && (asgn.contentType === "essay_questions" || asgn.contentType === "report")) firstEssayId = asgn.id;
        }

        // Template seed: one per class, use the first milestone's first assignment
        if (!templateClassesSeen.has(classId) && nm.nodeType === "milestone" && built[0]) {
          templateClassesSeen.add(classId);
          templateSeeds.push({ subject, gradeLevel, assignment: built[0] });
        }
      }

      if (firstQuizId) submissionSeeds.push({ assignmentId: firstQuizId, profileId, type: "quiz" });
      if (firstEssayId) submissionSeeds.push({ assignmentId: firstEssayId, profileId, type: "written" });
    }

    await batchInsert(db, assignments, assignmentRows);
    await batchInsert(db, skillTreeNodeAssignments, nodeAssignmentRows);

    // ── Phase 5: Node progress + edges ───────────────────────────────────────
    //
    // Edge topology for each skill tree:
    //   milestone  ──required──▶  lesson1
    //   lesson1    ──required──▶  lesson2  ──...──▶  lastLesson
    //   lastLesson ──required──▶  nextMilestone  (spine continues)
    //   milestone  ──optional──▶  elective1  (bonus XP branch off spine)
    //   lastElective ──bonus──▶  nextMilestone  (merge back)
    //   lastMilestone ──required──▶  boss  (final boss)
    //
    const progressRows: Record<string, unknown>[] = [];
    const edgeRows: Record<string, unknown>[] = [];

    for (const [treeId, treeNodes] of byTree.entries()) {
      const totalNodes = treeNodes.length;
      const completedCutoff = Math.max(1, Math.floor(totalNodes * 0.25));
      const inProgressCutoff = Math.max(2, Math.floor(totalNodes * 0.40));
      const availableCutoff = Math.max(3, Math.floor(totalNodes * 0.55));

      for (const [idx, nm] of treeNodes.entries()) {
        const status: "complete" | "in_progress" | "available" | "locked" =
          idx < completedCutoff ? "complete"
          : idx < inProgressCutoff ? "in_progress"
          : idx < availableCutoff ? "available"
          : "locked";

        progressRows.push({
          id: crypto.randomUUID(),
          nodeId: nm.nodeId,
          profileId: nm.profileId,
          treeId,
          status,
          xpEarned: status === "complete" ? nm.nodeType === "boss" ? 300 : nm.nodeType === "milestone" ? 150 : 100
                   : status === "in_progress" ? 50 : 0,
          completedAt: status === "complete" ? nowStr : null,
          updatedAt: nowStr,
        });
      }

      // Build edges by chapter groups (structured tree topology)
      // Group treeNodes by chapter: each milestone starts a new chapter group
      type ChapterGroup = {
        milestoneId: string;
        lessonIds: string[];
        electiveIds: string[];
      };
      const chapters: ChapterGroup[] = [];
      let bossNodeId: string | null = null;

      for (const nm of treeNodes) {
        if (nm.nodeType === "boss") {
          bossNodeId = nm.nodeId;
        } else if (nm.nodeType === "milestone") {
          chapters.push({ milestoneId: nm.nodeId, lessonIds: [], electiveIds: [] });
        } else if (nm.nodeType === "elective") {
          chapters.at(-1)?.electiveIds.push(nm.nodeId);
        } else {
          // lesson or branch
          chapters.at(-1)?.lessonIds.push(nm.nodeId);
        }
      }

      // Emit edges for each chapter
      for (let ci = 0; ci < chapters.length; ci++) {
        const ch = chapters[ci]!;
        const nextCh = chapters[ci + 1];

        // milestone → first lesson (required spine)
        if (ch.lessonIds.length > 0) {
          edgeRows.push({ id: crypto.randomUUID(), treeId, sourceNodeId: ch.milestoneId, targetNodeId: ch.lessonIds[0]!, edgeType: "required" });

          // chain lessons (required spine)
          for (let li = 0; li < ch.lessonIds.length - 1; li++) {
            edgeRows.push({ id: crypto.randomUUID(), treeId, sourceNodeId: ch.lessonIds[li]!, targetNodeId: ch.lessonIds[li + 1]!, edgeType: "required" });
          }

          // last lesson → next milestone (required spine continues)
          const lastLesson = ch.lessonIds.at(-1)!;
          if (nextCh) {
            edgeRows.push({ id: crypto.randomUUID(), treeId, sourceNodeId: lastLesson, targetNodeId: nextCh.milestoneId, edgeType: "required" });
          } else if (bossNodeId) {
            edgeRows.push({ id: crypto.randomUUID(), treeId, sourceNodeId: lastLesson, targetNodeId: bossNodeId, edgeType: "required" });
          }
        } else if (nextCh) {
          // milestone directly to next milestone if no lessons
          edgeRows.push({ id: crypto.randomUUID(), treeId, sourceNodeId: ch.milestoneId, targetNodeId: nextCh.milestoneId, edgeType: "required" });
        }

        // electives branch off the milestone (optional XP side paths)
        for (const electiveId of ch.electiveIds) {
          edgeRows.push({ id: crypto.randomUUID(), treeId, sourceNodeId: ch.milestoneId, targetNodeId: electiveId, edgeType: "optional" });
          // elective merges back into next milestone (or boss) as a bonus path
          const mergeTarget = nextCh?.milestoneId ?? bossNodeId;
          if (mergeTarget) {
            edgeRows.push({ id: crypto.randomUUID(), treeId, sourceNodeId: electiveId, targetNodeId: mergeTarget, edgeType: "bonus" });
          }
        }
      }

      // If first chapter has no lessons, connect first milestone → boss
      if (chapters.length === 0 && bossNodeId && treeNodes.length > 0) {
        edgeRows.push({ id: crypto.randomUUID(), treeId, sourceNodeId: treeNodes[0]!.nodeId, targetNodeId: bossNodeId, edgeType: "required" });
      }
    }

    await batchInsert(db, skillTreeNodeProgress, progressRows);
    await batchInsert(db, skillTreeEdges, edgeRows);

    // ── Phase 6: Week plan ────────────────────────────────────────────────────
    await batchInsert(db, weekPlan, weekPlanRows);

    // ── Phase 7: Submissions ──────────────────────────────────────────────────
    const submissionRows: Record<string, unknown>[] = [];

    for (const seed of submissionSeeds) {
      if (seed.type === "quiz") {
        submissionRows.push({
          id: crypto.randomUUID(),
          organizationId,
          assignmentId: seed.assignmentId,
          profileId: seed.profileId,
          submittedByUserId: session.user.id,
          textResponse: JSON.stringify([1, 1, 2, 1, 1]),
          status: "graded",
          score: 88,
          reviewedAt: nowStr,
        });
      } else {
        submissionRows.push({
          id: crypto.randomUUID(),
          organizationId,
          assignmentId: seed.assignmentId,
          profileId: seed.profileId,
          submittedByUserId: session.user.id,
          textResponse: "This is a demo written submission available for parent review.",
          status: "submitted",
          score: null,
          reviewedAt: null,
        });
      }
    }

    await batchInsert(db, submissions, submissionRows);

    // ── Phase 8: Assignment templates ────────────────────────────────────────
    const templateRows: Record<string, unknown>[] = [];

    for (const seed of templateSeeds) {
      templateRows.push({
        id: crypto.randomUUID(),
        organizationId,
        title: `${seed.assignment.title} (Template)`,
        description: `Reusable demo template for Grade ${seed.gradeLevel} ${seed.subject}.`,
        contentType: seed.assignment.contentType,
        contentRef: seed.assignment.contentRef,
        tags: JSON.stringify([
          `subject:${seed.subject.toLowerCase().replace(/\s+/g, "-")}`,
          `grade:${seed.gradeLevel}`,
          "scope:demo",
        ]),
        isPublic: false,
        createdByUserId: session.user.id,
      });
    }

    await batchInsert(db, assignmentTemplates, templateRows);

    return {
      success: true,
      note: "Demo content seeded. Student demo PIN is 1111.",
      summary: {
        studentsCreated: profileRows.length,
        classesCreated: classRows.length,
        treesCreated: treeRows.length,
        nodesCreated: nodeRows.length,
        assignmentsCreated: assignmentRows.length,
        templatesCreated: templateRows.length,
      },
    };
  });

export const resetWorkspaceContent = createServerFn({ method: "POST" })
  .inputValidator((data) => contentResetWithPinInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    await verifyParentPinForSession(session.user.id, data.parentPin);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const orgClasses = await db.query.classes.findMany({
      where: eq(classes.organizationId, organizationId),
      columns: { id: true },
    });
    const orgProfiles = await db.query.profiles.findMany({
      where: eq(profiles.organizationId, organizationId),
      columns: { id: true },
    });
    const orgAssignments = await db.query.assignments.findMany({
      where: eq(assignments.organizationId, organizationId),
      columns: { id: true },
    });
    const orgTrees = await db.query.skillTrees.findMany({
      where: eq(skillTrees.organizationId, organizationId),
      columns: { id: true },
    });
    const orgRewardTracks = await db.query.rewardTracks.findMany({
      where: eq(rewardTracks.organizationId, organizationId),
      columns: { id: true },
    });

    const classIds = orgClasses.map((row) => row.id);
    const profileIds = orgProfiles.map((row) => row.id);
    const assignmentIds = orgAssignments.map((row) => row.id);
    const treeIds = orgTrees.map((row) => row.id);
    const rewardTrackIds = orgRewardTracks.map((row) => row.id);

    // Execute deletes sequentially without transaction (D1 remote has limitations with BEGIN)
    try {
      await db.delete(weekPlan).where(eq(weekPlan.organizationId, organizationId));
      await db.delete(submissions).where(eq(submissions.organizationId, organizationId));

      for (const treeIdChunk of chunkIds(treeIds)) {
        await db.delete(skillTreeNodeProgress).where(inArray(skillTreeNodeProgress.treeId, treeIdChunk));
        await db.delete(skillTreeEdges).where(inArray(skillTreeEdges.treeId, treeIdChunk));
      }

      for (const assignmentIdChunk of chunkIds(assignmentIds)) {
        await db
          .delete(skillTreeNodeAssignments)
          .where(inArray(skillTreeNodeAssignments.assignmentId, assignmentIdChunk));
      }

      if (classIds.length > 0 || profileIds.length > 0) {
        if (classIds.length > 0 && profileIds.length > 0) {
          for (const classIdChunk of chunkIds(classIds)) {
            await db.delete(classEnrollments).where(inArray(classEnrollments.classId, classIdChunk));
          }
          for (const profileIdChunk of chunkIds(profileIds)) {
            await db.delete(classEnrollments).where(inArray(classEnrollments.profileId, profileIdChunk));
          }
        } else if (classIds.length > 0) {
          for (const classIdChunk of chunkIds(classIds)) {
            await db.delete(classEnrollments).where(inArray(classEnrollments.classId, classIdChunk));
          }
        } else {
          for (const profileIdChunk of chunkIds(profileIds)) {
            await db.delete(classEnrollments).where(inArray(classEnrollments.profileId, profileIdChunk));
          }
        }
      }

      await db.delete(rewardClaims).where(eq(rewardClaims.organizationId, organizationId));
      await db.delete(rewardTiers).where(eq(rewardTiers.organizationId, organizationId));
      for (const rewardTrackIdChunk of chunkIds(rewardTrackIds)) {
        await db
          .delete(rewardTrackXpSnapshots)
          .where(inArray(rewardTrackXpSnapshots.trackId, rewardTrackIdChunk));
      }
      await db.delete(rewardTracks).where(eq(rewardTracks.organizationId, organizationId));

      await db.delete(skillTreeNodes).where(eq(skillTreeNodes.organizationId, organizationId));
      await db.delete(skillTrees).where(eq(skillTrees.organizationId, organizationId));
      await db.delete(assignments).where(eq(assignments.organizationId, organizationId));
      await db.delete(classes).where(eq(classes.organizationId, organizationId));
      await db.delete(profiles).where(eq(profiles.organizationId, organizationId));
      await db.delete(assignmentTemplates).where(
        or(
          eq(assignmentTemplates.organizationId, organizationId),
          eq(assignmentTemplates.createdByUserId, session.user.id),
        ),
      );
    } catch (error) {
      console.error("Error resetting workspace content:", error);
      throw new Error(
        `Failed to reset workspace content: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }

    return {
      success: true,
      summary: {
        classesDeleted: classIds.length,
        profilesDeleted: profileIds.length,
        assignmentsDeleted: assignmentIds.length,
        skillTreesDeleted: treeIds.length,
      },
    };
  });

const studentDisplayNameSchema = z.string().trim().min(1).max(100);
const studentGradeLevelSchema = z.string().trim().min(1).max(20);

export const getLoginOptions = createServerFn({ method: "GET" }).handler(async () => {
  // No options needed - users enter their username directly
  return {
    parentAccounts: [],
  };
});

const parentLoginInput = z.object({
  username: z.string().min(1).max(20),
  password: z.string().min(1),
});

export const loginAsParent = createServerFn({ method: "POST" })
  .inputValidator((data) => parentLoginInput.parse(data))
  .handler(async ({ data }) => {
    const db = getDb();

    const userRecord = await db.query.users.findFirst({
      where: eq(users.username, data.username.toLowerCase()),
    });

    if (!userRecord || !userRecord.passwordHash) {
      throw new Error("FORBIDDEN");
    }

    const isPasswordValid = await verifyPassword(data.password, userRecord.passwordHash);
    if (!isPasswordValid) {
      throw new Error("FORBIDDEN");
    }

    const targetMembership = await db.query.memberships.findFirst({
      where: and(
        eq(memberships.userId, userRecord.id),
        eq(memberships.role, "parent"),
      ),
    });

    if (!targetMembership) {
      throw new Error("FORBIDDEN");
    }

    const hasAdminMembership = Boolean(
      await db.query.memberships.findFirst({
        where: and(
          eq(memberships.userId, userRecord.id),
          eq(memberships.organizationId, targetMembership.organizationId),
          eq(memberships.role, "admin"),
        ),
      }),
    );

    setRoleSessionCookies({
      role: "parent",
      userId: userRecord.id,
      organizationId: targetMembership.organizationId,
      isAdminParent: userRecord.role === "admin" || hasAdminMembership,
    });

    return {
      success: true,
      role: "parent" as const,
      nextStep: "role-selection" as const,
    };
  });

const completePostLoginRoleSelectionInput = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("parent"),
    parentPin: z.string().regex(/^\d{4,6}$/),
  }),
  z.object({
    mode: z.literal("student"),
    profileId: z.string().min(1),
    studentPin: z.string().regex(/^\d{4,8}$/),
  }),
]);

export const completePostLoginRoleSelection = createServerFn({ method: "POST" })
  .inputValidator((data) => completePostLoginRoleSelectionInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["parent", "admin"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const [userRecord, adminMembership] = await Promise.all([
      db.query.users.findFirst({
        where: eq(users.id, session.user.id),
      }),
      db.query.memberships.findFirst({
        where: and(
          eq(memberships.userId, session.user.id),
          eq(memberships.organizationId, organizationId),
          eq(memberships.role, "admin"),
        ),
      }),
    ]);

    const isAdminParent =
      session.activeRole === "admin" ||
      userRecord?.role === "admin" ||
      Boolean(adminMembership);

    if (data.mode === "parent") {
      await verifyParentPinForSession(session.user.id, data.parentPin);
      setRoleSessionCookies({
        role: "parent",
        userId: session.user.id,
        organizationId,
        isAdminParent,
      });

      return {
        success: true,
        activeRole: "parent" as const,
      };
    }

    const profile = await db.query.profiles.findFirst({
      where: and(
        eq(profiles.id, data.profileId),
        eq(profiles.parentUserId, session.user.id),
        eq(profiles.organizationId, organizationId),
        eq(profiles.status, "active"),
      ),
    });

    if (!profile) {
      throw new Error("FORBIDDEN");
    }

    const incomingPinHash = await hashStudentPin(data.studentPin);
    if (incomingPinHash !== profile.pinHash) {
      throw new Error("INVALID_PIN");
    }

    setRoleSessionCookies({
      role: "student",
      userId: session.user.id,
      organizationId,
      profileId: profile.id,
      isAdminParent,
    });

    return {
      success: true,
      activeRole: "student" as const,
      profileId: profile.id,
    };
  });

const createParentAccountInput = z.object({
  firstName: z.string().min(1).max(50),
  lastName: z.string().min(1).max(50),
  email: z.string().email(),
  username: z.string().min(3).max(20),
  password: z.string().min(8).max(128),
  parentPin: z.string().regex(/^\d{4,6}$/),
  homePodName: z.string().min(1),
});

export const createParentAccount = createServerFn({ method: "POST" })
  .inputValidator((data) => createParentAccountInput.parse(data))
  .handler(async ({ data }) => {
    const db = getDb();

    // Check for existing email
    const existingUserByEmail = await db.query.users.findFirst({
      where: eq(users.email, data.email.toLowerCase()),
    });

    if (existingUserByEmail) {
      throw new Error("EMAIL_ALREADY_EXISTS");
    }

    // Check for existing username
    const existingUserByUsername = await db.query.users.findFirst({
      where: eq(users.username, data.username.toLowerCase()),
    });

    if (existingUserByUsername) {
      throw new Error("USERNAME_ALREADY_EXISTS");
    }

    const userId = crypto.randomUUID();
    const organizationId = crypto.randomUUID();
    const now = new Date().toISOString();

    const fullName = `${data.firstName} ${data.lastName}`;
    const passwordHash = await hashPassword(data.password);
    const parentPinHash = await hashParentPin(data.parentPin);

    const slugBase = data.homePodName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const slug = `${slugBase || "home-pod"}-${organizationId.slice(0, 8)}`;

    await db.insert(users).values({
      id: userId,
      email: data.email.toLowerCase(),
      username: data.username.toLowerCase(),
      passwordHash,
      parentPin: parentPinHash,
      parentPinLength: data.parentPin.length,
      name: fullName,
      role: "user",
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(organizations).values({
      id: organizationId,
      name: data.homePodName,
      slug,
      ownerUserId: userId,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(memberships).values({
      id: crypto.randomUUID(),
      organizationId,
      userId,
      role: "parent",
      createdAt: now,
      updatedAt: now,
    });

    return {
      success: true,
      userId,
    };
  });

export const getStudentSelectionOptions = createServerFn({ method: "GET" }).handler(
  async () => {
    const session = await requireActiveRole(["parent", "admin"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const profileRows = await db.query.profiles.findMany({
      where: and(
        eq(profiles.parentUserId, session.user.id),
        eq(profiles.organizationId, organizationId),
        eq(profiles.status, "active"),
      ),
      orderBy: [desc(profiles.createdAt)],
    });

    return {
      profiles: profileRows.map((profile) => ({
        id: profile.id,
        displayName: profile.displayName,
        gradeLevel: profile.gradeLevel,
      })),
    };
  },
);

export const continueAsParent = createServerFn({ method: "POST" }).handler(async () => {
  const session = await requireActiveRole(["parent", "admin"]);
  const db = getDb();

  const organizationId = await resolveActiveOrganizationId(
    session.user.id,
    session.session.activeOrganizationId,
  );

  const userRecord = await db.query.users.findFirst({
    where: eq(users.id, session.user.id),
  });

  const adminMembership = await db.query.memberships.findFirst({
    where: and(
      eq(memberships.userId, session.user.id),
      eq(memberships.organizationId, organizationId),
      eq(memberships.role, "admin"),
    ),
  });

  setRoleSessionCookies({
    role: "parent",
    userId: session.user.id,
    organizationId,
    isAdminParent:
      session.activeRole === "admin" ||
      userRecord?.role === "admin" ||
      Boolean(adminMembership),
  });

  return {
    success: true,
  };
});

const switchWorkspaceViewInput = z.object({
  mode: z.enum(["parent", "student"]),
  profileId: z.string().optional(),
  // Required when switching FROM student → parent (PIN-guard so child can't self-escalate)
  parentPin: z.string().regex(/^\d{4,6}$/).optional(),
});

export const switchWorkspaceView = createServerFn({ method: "POST" })
  .inputValidator((data) => switchWorkspaceViewInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["parent", "admin", "student"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const userRecord = await db.query.users.findFirst({
      where: eq(users.id, session.user.id),
    });

    const adminMembership = await db.query.memberships.findFirst({
      where: and(
        eq(memberships.userId, session.user.id),
        eq(memberships.organizationId, organizationId),
        eq(memberships.role, "admin"),
      ),
    });

    const isAdminParent =
      session.activeRole === "admin" ||
      userRecord?.role === "admin" ||
      Boolean(adminMembership);

    // ── Switch to parent view ──────────────────────────────────────────────────
    // Requires parent PIN when the current session is a student session,
    // so a child cannot self-escalate to the parent workspace.
    if (data.mode === "parent") {
      const isCurrentlyStudent = session.activeRole === "student";

      if (isCurrentlyStudent) {
        if (!data.parentPin) throw new Error("PIN_REQUIRED");
        await verifyParentPinForSession(session.user.id, data.parentPin);
      }

      // Preserve the current profileId in the parent cookie so the shell can
      // pre-select the same student next time without re-picking.
      const preservedProfileId = session.session.profileId ?? undefined;

      setRoleSessionCookies({
        role: "parent",
        userId: session.user.id,
        organizationId,
        profileId: preservedProfileId,
        isAdminParent,
      });

      return {
        success: true,
        activeRole: "parent" as const,
      };
    }

    // ── Switch to student view ────────────────────────────────────────────────
    // No PIN required — the parent is already authenticated.
    // profileId is required to know which student to activate.
    if (!data.profileId) throw new Error("PROFILE_REQUIRED");

    const profile = await db.query.profiles.findFirst({
      where: and(
        eq(profiles.id, data.profileId),
        eq(profiles.parentUserId, session.user.id),
        eq(profiles.organizationId, organizationId),
        eq(profiles.status, "active"),
      ),
    });

    if (!profile) throw new Error("FORBIDDEN");

    setRoleSessionCookies({
      role: "student",
      userId: session.user.id,
      organizationId,
      profileId: profile.id,
      isAdminParent,
    });

    return {
      success: true,
      activeRole: "student" as const,
      profileId: profile.id,
    };
  });

const selectStudentViewInput = z.object({
  profileId: z.string().min(1),
  pin: z.string().regex(/^\d{4,8}$/),
});

export const selectStudentView = createServerFn({ method: "POST" })
  .inputValidator((data) => selectStudentViewInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["parent", "admin"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const profile = await db.query.profiles.findFirst({
      where: and(
        eq(profiles.id, data.profileId),
        eq(profiles.parentUserId, session.user.id),
        eq(profiles.organizationId, organizationId),
        eq(profiles.status, "active"),
      ),
    });

    if (!profile) {
      throw new Error("FORBIDDEN");
    }

    const incomingPinHash = await hashStudentPin(data.pin);
    if (incomingPinHash !== profile.pinHash) {
      throw new Error("FORBIDDEN");
    }

    setRoleSessionCookies({
      role: "student",
      userId: session.user.id,
      organizationId: profile.organizationId,
      profileId: profile.id,
      isAdminParent: session.user.role === "admin",
    });

    return {
      success: true,
      role: "student" as const,
    };
  });

const createStudentProfileInlineInput = z.object({
  displayName: studentDisplayNameSchema,
  pin: z.string().regex(/^\d{4,6}$/),
  gradeLevel: studentGradeLevelSchema,
  location: z.string().trim().max(120).optional(),
  birthDate: z.string().optional(),
});

export const createStudentProfileInline = createServerFn({ method: "POST" })
  .inputValidator((data) => createStudentProfileInlineInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["parent", "admin"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const pinHash = await hashStudentPin(data.pin);
    const id = crypto.randomUUID();

    await db.insert(profiles).values({
      id,
      organizationId,
      parentUserId: session.user.id,
      displayName: data.displayName.trim(),
      gradeLevel: data.gradeLevel.trim(),
      location: data.location?.trim() || null,
      birthDate: data.birthDate?.trim() || null,
      pinHash,
      status: "active",
    });

    return {
      success: true,
      profileId: id,
      displayName: data.displayName.trim(),
    };
  });

export const getManagedStudents = createServerFn({ method: "GET" }).handler(async () => {
  const session = await requireActiveRole(["parent", "admin"]);
  const db = getDb();

  const organizationId = await resolveActiveOrganizationId(
    session.user.id,
    session.session.activeOrganizationId,
  );

  const studentRows = await db.query.profiles.findMany({
    where: and(
      eq(profiles.parentUserId, session.user.id),
      eq(profiles.organizationId, organizationId),
    ),
    orderBy: [desc(profiles.createdAt)],
  });

  const userRecord = await db.query.users.findFirst({
    where: eq(users.id, session.user.id),
  });

  return {
    parentPinLength: resolveParentPinLength(userRecord?.parentPinLength),
    students: studentRows.map((profile) => ({
      id: profile.id,
      displayName: profile.displayName,
      gradeLevel: profile.gradeLevel ?? "",
      location: profile.location ?? "",
      birthDate: profile.birthDate ?? "",
      status: profile.status,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    })),
  };
});

export const getParentDashboardData = createServerFn({ method: "GET" }).handler(async () => {
  const session = await requireActiveRole(["parent", "admin"]);
  const db = getDb();

  const organizationId = await resolveActiveOrganizationId(
    session.user.id,
    session.session.activeOrganizationId,
  );

  const [studentRows, classRows, assignmentRows, submissionRows] = await Promise.all([
    db.query.profiles.findMany({
      where: and(
        eq(profiles.parentUserId, session.user.id),
        eq(profiles.organizationId, organizationId),
        eq(profiles.status, "active"),
      ),
      orderBy: [desc(profiles.createdAt)],
    }),
    db.query.classes.findMany({
      where: eq(classes.organizationId, organizationId),
      orderBy: [desc(classes.createdAt)],
    }),
    db.query.assignments.findMany({
      where: eq(assignments.organizationId, organizationId),
      orderBy: [desc(assignments.createdAt)],
    }),
    db.query.submissions.findMany({
      where: eq(submissions.organizationId, organizationId),
      orderBy: [desc(submissions.createdAt)],
    }),
  ]);

  const enrollmentRows = classRows.length && studentRows.length
    ? await db.query.classEnrollments.findMany({
        where: and(
          inArray(
            classEnrollments.classId,
            classRows.map((classRow) => classRow.id),
          ),
          inArray(
            classEnrollments.profileId,
            studentRows.map((student) => student.id),
          ),
        ),
      })
    : [];

  const studentIds = new Set(studentRows.map((student) => student.id));

  const assignmentsByClass = new Map<string, number>();
  const assignmentClassById = new Map<string, string>();
  for (const assignment of assignmentRows) {
    assignmentClassById.set(assignment.id, assignment.classId);
    assignmentsByClass.set(
      assignment.classId,
      (assignmentsByClass.get(assignment.classId) ?? 0) + 1,
    );
  }

  const submissionsByStudentClass = new Map<string, {
    submittedCount: number;
    gradedCount: number;
    scoreTotal: number;
  }>();

  for (const submission of submissionRows) {
    if (!studentIds.has(submission.profileId)) {
      continue;
    }
    if (submission.status === "returned") {
      continue;
    }

    const classId = assignmentClassById.get(submission.assignmentId);
    if (!classId) {
      continue;
    }

    const key = `${submission.profileId}:${classId}`;
    const existing = submissionsByStudentClass.get(key) ?? {
      submittedCount: 0,
      gradedCount: 0,
      scoreTotal: 0,
    };

    existing.submittedCount += 1;
    if (typeof submission.score === "number") {
      existing.gradedCount += 1;
      existing.scoreTotal += submission.score;
    }

    submissionsByStudentClass.set(key, existing);
  }

  const enrolledClassIdsByStudent = new Map<string, Set<string>>();
  for (const enrollment of enrollmentRows) {
    if (!studentIds.has(enrollment.profileId)) {
      continue;
    }

    const existing = enrolledClassIdsByStudent.get(enrollment.profileId) ?? new Set<string>();
    existing.add(enrollment.classId);
    enrolledClassIdsByStudent.set(enrollment.profileId, existing);
  }

  const metricsByStudent = studentRows.reduce<Record<string, Array<{
    classId: string;
    classTitle: string;
    schoolYear: string | null;
    assignedCount: number;
    submittedCount: number;
    completionPercent: number;
    averageScore: number | null;
  }>>>((acc, student) => {
    const assignedClassIds = enrolledClassIdsByStudent.get(student.id) ?? new Set<string>();
    const assignedClasses = classRows.filter((classRow) => assignedClassIds.has(classRow.id));

    acc[student.id] = assignedClasses.map((classRow) => {
      const assignedCount = assignmentsByClass.get(classRow.id) ?? 0;
      const key = `${student.id}:${classRow.id}`;
      const submissionStats = submissionsByStudentClass.get(key);
      const submittedCount = Math.min(submissionStats?.submittedCount ?? 0, assignedCount);
      const completionPercent =
        assignedCount === 0 ? 0 : Math.round((submittedCount / assignedCount) * 100);
      const averageScore =
        submissionStats && submissionStats.gradedCount > 0
          ? Math.round(submissionStats.scoreTotal / submissionStats.gradedCount)
          : null;

      return {
        classId: classRow.id,
        classTitle: classRow.title,
        schoolYear: classRow.schoolYear ?? null,
        assignedCount,
        submittedCount,
        completionPercent,
        averageScore,
      };
    });

    return acc;
  }, {});

  const schoolYears = Array.from(
    new Set(
      classRows
        .map((classRow) => classRow.schoolYear)
        .filter((year): year is string => typeof year === "string" && /^\d{4}-\d{4}$/.test(year)),
    ),
  ).sort().reverse();

  const hasClassesWithoutSchoolYear = classRows.some((classRow) => !classRow.schoolYear);

  return {
    students: studentRows.map((student) => ({
      id: student.id,
      displayName: student.displayName,
      gradeLevel: student.gradeLevel ?? "",
    })),
    metricsByStudent,
    schoolYears,
    hasClassesWithoutSchoolYear,
  };
});

const updateStudentProfileInput = z.object({
  profileId: z.string().min(1),
  displayName: studentDisplayNameSchema,
  gradeLevel: studentGradeLevelSchema,
  location: z.string().trim().max(120).optional(),
  birthDate: z.string().optional(),
  pin: z.string().regex(/^\d{4,6}$/).optional(),
});

export const updateStudentProfile = createServerFn({ method: "POST" })
  .inputValidator((data) => updateStudentProfileInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["parent", "admin"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const profile = await db.query.profiles.findFirst({
      where: and(
        eq(profiles.id, data.profileId),
        eq(profiles.parentUserId, session.user.id),
        eq(profiles.organizationId, organizationId),
        eq(profiles.status, "active"),
      ),
    });

    if (!profile) {
      throw new Error("FORBIDDEN");
    }

    await db
      .update(profiles)
      .set({
        displayName: data.displayName.trim(),
        gradeLevel: data.gradeLevel.trim(),
        location: data.location?.trim() || null,
        birthDate: data.birthDate?.trim() || null,
        ...(data.pin ? { pinHash: await hashStudentPin(data.pin) } : {}),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(profiles.id, data.profileId));

    return {
      success: true,
      profileId: profile.id,
    };
  });

const switchStudentImpersonationInput = z.object({
  profileId: z.string().min(1),
  parentPin: z.string().regex(/^\d{4,6}$/),
});

export const switchStudentImpersonation = createServerFn({ method: "POST" })
  .inputValidator((data) => switchStudentImpersonationInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["parent", "admin"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    await verifyParentPinForSession(session.user.id, data.parentPin);
    const userRecord = await db.query.users.findFirst({
      where: eq(users.id, session.user.id),
    });
    if (!userRecord) throw new Error("FORBIDDEN");

    const profile = await db.query.profiles.findFirst({
      where: and(
        eq(profiles.id, data.profileId),
        eq(profiles.parentUserId, session.user.id),
        eq(profiles.organizationId, organizationId),
        eq(profiles.status, "active"),
      ),
    });

    if (!profile) {
      throw new Error("FORBIDDEN");
    }

    setRoleSessionCookies({
      role: "parent",
      userId: session.user.id,
      organizationId,
      isAdminParent:
        session.activeRole === "admin" ||
        userRecord.role === "admin" ||
        Boolean(
          await db.query.memberships.findFirst({
            where: and(
              eq(memberships.userId, session.user.id),
              eq(memberships.organizationId, organizationId),
              eq(memberships.role, "admin"),
            ),
          }),
        ),
      impersonatingStudentId: profile.id,
    });

    return {
      success: true,
      profileId: profile.id,
      displayName: profile.displayName,
    };
  });

const switchViewModeInput = z.object({
  mode: z.enum(["admin", "student"]),
  parentPin: z.string().regex(/^\d{4,6}$/),
});

export const switchViewMode = createServerFn({ method: "POST" })
  .inputValidator((data) => switchViewModeInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["parent", "admin"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const userRecord = await db.query.users.findFirst({
      where: eq(users.id, session.user.id),
    });

    await verifyParentPinForSession(session.user.id, data.parentPin);
    if (!userRecord) throw new Error("FORBIDDEN");

    const adminMembership = await db.query.memberships.findFirst({
      where: and(
        eq(memberships.userId, session.user.id),
        eq(memberships.organizationId, organizationId),
        eq(memberships.role, "admin"),
      ),
    });

    const canAccessAdmin =
      session.activeRole === "admin" ||
      userRecord.role === "admin" ||
      Boolean(adminMembership);

    if (data.mode === "admin" && !canAccessAdmin) {
      throw new Error("FORBIDDEN");
    }

    const impersonatingStudentId =
      data.mode === "student" && session.activeRole === "parent"
        ? (session.session as any)?.impersonatingStudentId
        : undefined;

    setRoleSessionCookies({
      role: data.mode === "admin" ? "admin" : "parent",
      userId: session.user.id,
      organizationId,
      isAdminParent: canAccessAdmin,
      impersonatingStudentId,
    });

    return {
      success: true,
      mode: data.mode,
    };
  });
const setAccountAdminStatusInput = z.object({
  userId: z.string().min(1),
  isAdmin: z.boolean(),
});

export const setAccountAdminStatus = createServerFn({ method: "POST" })
  .inputValidator((data) => setAccountAdminStatusInput.parse(data))
  .handler(async ({ data }) => {
    const actor = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const actorOrganizationId = await resolveActiveOrganizationId(
      actor.user.id,
      actor.session.activeOrganizationId,
    );

    const actorAdminMembership = await db.query.memberships.findFirst({
      where: and(
        eq(memberships.userId, actor.user.id),
        eq(memberships.organizationId, actorOrganizationId),
        eq(memberships.role, "admin"),
      ),
    });

    const actorUser = await db.query.users.findFirst({
      where: eq(users.id, actor.user.id),
    });

    const canManageAdmins =
      actor.activeRole === "admin" ||
      actorUser?.role === "admin" ||
      Boolean(actorAdminMembership);

    if (!canManageAdmins) {
      throw new Error("FORBIDDEN");
    }

    await db
      .update(users)
      .set({
        role: data.isAdmin ? "admin" : "user",
        updatedAt: new Date().toISOString(),
      })
      .where(eq(users.id, data.userId));

    return {
      success: true,
    };
  });

export const logoutSession = createServerFn({ method: "POST" }).handler(async () => {
  clearRoleSessionCookies();
  return { success: true };
});

export const checkDbConnection = createServerFn({ method: "GET" }).handler(
  async () => {
    const db = getDb();
    await db.insert(healthCheck).values({ status: "connected" });
    const rows = await db.select().from(healthCheck);
    return { success: true, rows };
  },
);

const createStudentProfileInput = z.object({
  organizationId: z.string().min(1),
  displayName: studentDisplayNameSchema,
  pin: z.string().regex(/^\d{4,8}$/),
  gradeLevel: studentGradeLevelSchema,
  location: z.string().trim().max(120).optional(),
  birthDate: z.string().optional(),
});

function toHex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hashStudentPin(pin: string) {
  const encoded = new TextEncoder().encode(pin);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return toHex(digest);
}

export const createStudentProfile = createServerFn({ method: "POST" })
  .inputValidator((data) => createStudentProfileInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const member = await db.query.memberships.findFirst({
      where: and(
        eq(memberships.organizationId, data.organizationId),
        eq(memberships.userId, session.user.id),
      ),
    });

    if (!member) {
      throw new Error("FORBIDDEN");
    }

    const pinHash = await hashStudentPin(data.pin);
    const id = crypto.randomUUID();

    await db.insert(profiles).values({
      id,
      organizationId: data.organizationId,
      parentUserId: session.user.id,
      displayName: data.displayName.trim(),
      gradeLevel: data.gradeLevel.trim(),
      location: data.location?.trim() || null,
      birthDate: data.birthDate?.trim() || null,
      pinHash,
      status: "active",
    });

    return {
      success: true,
      profileId: id,
    };
  });

const impersonateInput = z.object({ userId: z.string().min(1) });

export const impersonateAsUser = createServerFn({ method: "POST" })
  .inputValidator((data) => impersonateInput.parse(data))
  .handler(async ({ data }) => {
    await requireActiveRole(["admin", "parent"]);
    const request = getRequest();
    const api = auth.api as any;

    if (typeof api.impersonateUser !== "function") {
      throw new Error("IMPERSONATION_NOT_AVAILABLE");
    }

    const result = await api.impersonateUser({
      body: { userId: data.userId },
      headers: request.headers,
    });

    return {
      success: true,
      result,
    };
  });

export const stopImpersonation = createServerFn({ method: "POST" }).handler(
  async () => {
    const request = getRequest();
    const api = auth.api as any;

    if (typeof api.stopImpersonating !== "function") {
      throw new Error("IMPERSONATION_NOT_AVAILABLE");
    }

    const result = await api.stopImpersonating({
      headers: request.headers,
    });

    return {
      success: true,
      result,
    };
  },
);

export const getRoleSwitcherData = createServerFn({ method: "POST" }).handler(
  async () => {
    const db = getDb();
    const roleContext = await getRoleContext();

    if (!roleContext.isAuthenticated || !roleContext.userId) {
      return {
        isAuthenticated: false,
        activeRole: roleContext.activeRole,
        isAdminParent: false,
        activeProfileId: null as string | null,
        profiles: [] as Array<{
          id: string;
          displayName: string;
          gradeLevel: string | null;
        }>,
      };
    }

    const orgId = roleContext.organizationId;

    const [rows, pendingClaimsRows] = await Promise.all([
      db.query.profiles.findMany({
        where: and(
          eq(profiles.parentUserId, roleContext.userId),
          eq(profiles.status, "active"),
        ),
      }),
      orgId
        ? db.query.rewardClaims.findMany({
            where: and(
              eq(rewardClaims.organizationId, orgId),
              eq(rewardClaims.status, "claimed"),
            ),
            columns: { id: true },
          })
        : Promise.resolve([]),
    ]);

    return {
      isAuthenticated: true,
      activeRole: roleContext.activeRole,
      isAdminParent: roleContext.isAdminParent,
      activeProfileId: roleContext.profileId ?? null,
      pendingRewardsCount: pendingClaimsRows.length,
      profiles: rows.map((row) => ({
        id: row.id,
        displayName: row.displayName,
        gradeLevel: row.gradeLevel ?? null,
      })),
    };
  },
);

const verifyPinInput = z.object({
  profileId: z.string().min(1),
  pin: z.string().regex(/^\d{4,8}$/),
});

export const verifyStudentPin = createServerFn({ method: "POST" })
  .inputValidator((data) => verifyPinInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent", "student"]);
    const db = getDb();

    const profile = await db.query.profiles.findFirst({
      where: and(
        eq(profiles.id, data.profileId),
        eq(profiles.parentUserId, session.user.id),
        eq(profiles.status, "active"),
      ),
    });

    if (!profile) {
      throw new Error("FORBIDDEN");
    }

    const incomingPinHash = await hashStudentPin(data.pin);
    return {
      valid: incomingPinHash === profile.pinHash,
    };
  });

async function resolveActiveOrganizationId(userId: string, preferredOrgId?: string) {
  const db = getDb();

  if (preferredOrgId) {
    return preferredOrgId;
  }

  const membership = await db.query.memberships.findFirst({
    where: eq(memberships.userId, userId),
  });

  if (!membership) {
    throw new Error("FORBIDDEN");
  }

  return membership.organizationId;
}

export const getAdminConsoleData = createServerFn({ method: "GET" }).handler(
  async () => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const [actor, actorAdminMembership] = await Promise.all([
      db.query.users.findFirst({
        where: eq(users.id, session.user.id),
      }),
      db.query.memberships.findFirst({
        where: and(
          eq(memberships.userId, session.user.id),
          eq(memberships.organizationId, organizationId),
          eq(memberships.role, "admin"),
        ),
      }),
    ]);

    if (
      session.activeRole !== "admin" &&
      actor?.role !== "admin" &&
      !actorAdminMembership
    ) {
      throw new Error("FORBIDDEN");
    }

    const [organizationRecord, memberRows] = await Promise.all([
      db.query.organizations.findFirst({
        where: eq(organizations.id, organizationId),
      }),
      db
        .select({
          membershipId: memberships.id,
          userId: users.id,
          name: users.name,
          email: users.email,
          role: memberships.role,
          accountRole: users.role,
          createdAt: memberships.createdAt,
        })
        .from(memberships)
        .innerJoin(users, eq(memberships.userId, users.id))
        .where(eq(memberships.organizationId, organizationId))
        .orderBy(desc(memberships.createdAt)),
    ]);

    return {
      organization: organizationRecord,
      members: memberRows.map((row) => ({
        ...row,
        isAdmin: row.accountRole === "admin" || row.role === "admin",
      })),
    };
  },
);

const schoolYearSchema = z
  .string()
  .regex(/^\d{4}-\d{4}$/, "School year must be in YYYY-YYYY format (e.g. 2024-2025)")
  .optional();

const createClassInput = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  schoolYear: schoolYearSchema,
  studentProfileIds: z.array(z.string().min(1)).min(1),
});

export const createClassRecord = createServerFn({ method: "POST" })
  .inputValidator((data) => createClassInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const classId = crypto.randomUUID();
    const uniqueProfileIds = Array.from(new Set(data.studentProfileIds));

    const canManageAllStudents = session.activeRole === "admin";
    const targetStudents = await db.query.profiles.findMany({
      where: and(
        eq(profiles.organizationId, organizationId),
        eq(profiles.status, "active"),
        ...(canManageAllStudents ? [] : [eq(profiles.parentUserId, session.user.id)]),
        inArray(profiles.id, uniqueProfileIds),
      ),
    });

    if (targetStudents.length !== uniqueProfileIds.length) {
      throw new Error("FORBIDDEN");
    }

    await db.insert(classes).values({
      id: classId,
      organizationId,
      title: data.title,
      description: data.description,
      schoolYear: data.schoolYear ?? null,
      createdByUserId: session.user.id,
    });

    await db.insert(classEnrollments).values(
      uniqueProfileIds.map((profileId) => ({
        id: crypto.randomUUID(),
        classId,
        profileId,
      })),
    );

    return {
      success: true,
      classId,
    };
  });

const updateClassInput = z.object({
  classId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  schoolYear: schoolYearSchema,
  studentProfileIds: z.array(z.string().min(1)).min(1),
});

export const updateClassRecord = createServerFn({ method: "POST" })
  .inputValidator((data) => updateClassInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const existing = await db.query.classes.findFirst({
      where: and(
        eq(classes.id, data.classId),
        eq(classes.organizationId, organizationId),
      ),
    });

    if (!existing) {
      throw new Error("NOT_FOUND");
    }

    const uniqueProfileIds = Array.from(new Set(data.studentProfileIds));

    const canManageAllStudents = session.activeRole === "admin";
    const targetStudents = await db.query.profiles.findMany({
      where: and(
        eq(profiles.organizationId, organizationId),
        eq(profiles.status, "active"),
        ...(canManageAllStudents ? [] : [eq(profiles.parentUserId, session.user.id)]),
        inArray(profiles.id, uniqueProfileIds),
      ),
    });

    if (targetStudents.length !== uniqueProfileIds.length) {
      throw new Error("FORBIDDEN");
    }

    try {
      await db
        .update(classes)
        .set({
          title: data.title.trim(),
          description: data.description?.trim() || null,
          schoolYear: data.schoolYear ?? null,
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(classes.id, data.classId), eq(classes.organizationId, organizationId)));

      await db
        .delete(classEnrollments)
        .where(eq(classEnrollments.classId, data.classId));

      await db.insert(classEnrollments).values(
        uniqueProfileIds.map((profileId) => ({
          id: crypto.randomUUID(),
          classId: data.classId,
          profileId,
        })),
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown class update DB error";
      throw new Error(`CLASS_UPDATE_DB_ERROR: ${errorMessage}`);
    }

    return { success: true };
  });

export const getClassEngineData = createServerFn({ method: "GET" }).handler(
  async () => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const canManageAllStudents = session.activeRole === "admin";
    const [classRows, studentRows] = await Promise.all([
      db.query.classes.findMany({
        where: eq(classes.organizationId, organizationId),
        orderBy: [desc(classes.createdAt)],
      }),
      db.query.profiles.findMany({
        where: and(
          eq(profiles.organizationId, organizationId),
          eq(profiles.status, "active"),
          ...(canManageAllStudents ? [] : [eq(profiles.parentUserId, session.user.id)]),
        ),
        orderBy: [desc(profiles.createdAt)],
      }),
    ]);

    const [enrollmentRows, markingPeriodRows] = await Promise.all([
      classRows.length
        ? db.query.classEnrollments.findMany({
            where: inArray(
              classEnrollments.classId,
              classRows.map((classRow) => classRow.id),
            ),
          })
        : Promise.resolve([]),
      db.query.markingPeriods.findMany({
        where: eq(markingPeriods.organizationId, organizationId),
        orderBy: [markingPeriods.periodNumber],
      }),
    ]);

    const studentMap = new Map(studentRows.map((student) => [student.id, student]));
    const enrollmentsByClassId = new Map<string, string[]>();

    for (const enrollment of enrollmentRows) {
      const existing = enrollmentsByClassId.get(enrollment.classId) ?? [];
      existing.push(enrollment.profileId);
      enrollmentsByClassId.set(enrollment.classId, existing);
    }

    return {
      classes: classRows.map((classRow) => ({
        ...classRow,
        enrolledStudents: (enrollmentsByClassId.get(classRow.id) ?? [])
          .map((profileId) => studentMap.get(profileId))
          .filter((student): student is NonNullable<typeof student> => Boolean(student))
          .map((student) => ({
            id: student.id,
            displayName: student.displayName,
            gradeLevel: student.gradeLevel ?? null,
          })),
      })),
      students: studentRows.map((student) => ({
        id: student.id,
        displayName: student.displayName,
        gradeLevel: student.gradeLevel ?? null,
      })),
      markingPeriods: markingPeriodRows,
    };
  },
);

const uploadAssignmentFileInput = z.object({
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  base64: z.string().min(1),
});

export const uploadAssignmentFile = createServerFn({ method: "POST" })
  .inputValidator((data) => uploadAssignmentFileInput.parse(data))
  .handler(async ({ data }) => {
    await requireActiveRole(["admin", "parent"]);
    const key = `assignments/${crypto.randomUUID()}-${data.filename}`;
    const bytes = Uint8Array.from(atob(data.base64), (c) => c.charCodeAt(0));
    await env.BUCKET.put(key, bytes, {
      httpMetadata: { contentType: data.mimeType },
    });
    return { key, filename: data.filename };
  });

const searchYoutubeInput = z.object({
  query: z.string().min(1),
});

export const searchYoutubeWithAI = createServerFn({ method: "POST" })
  .inputValidator((data) => searchYoutubeInput.parse(data))
  .handler(async ({ data }) => {
    await requireActiveRole(["admin", "parent"]);
    const apiKey = env.YOUTUBE_API_KEY;
    if (!apiKey) throw new Error("YOUTUBE_API_KEY not configured");
    const videos = await searchYoutubeForVideos(data.query, apiKey);
    return { videos };
  });

const ASSIGNMENT_CONTENT_TYPES = [
  "text",
  "file",
  "url",
  "video",
  "quiz",
  "essay_questions",
  "report",
  "movie",
] as const;

const createAssignmentInput = z.object({
  classId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  contentType: z.enum(ASSIGNMENT_CONTENT_TYPES),
  contentRef: z.string().optional(),
  linkedAssignmentId: z.string().optional(),
  dueAt: z.string().optional(),
});

type VideoAssignmentPayload = {
  videos?: Array<{
    videoId?: string;
    title?: string;
    channel?: string;
    description?: string;
    thumbnail?: string;
    transcript?: string | null;
    transcriptFetchedAt?: string | null;
    transcriptMeta?: {
      keyPresent: boolean;
      attempted: boolean;
      endpoint: "youtube" | "transcript";
      status: number | null;
      ok: boolean;
      error: string | null;
    };
  }>;
};

type AssignmentContentType = (typeof ASSIGNMENT_CONTENT_TYPES)[number];

type AccessibleAssignmentTemplate = {
  id: string;
  organizationId: string | null;
  title: string;
  description: string | null;
  contentType: AssignmentContentType;
  contentRef: string | null;
  tags: string[];
  isPublic: boolean;
  createdByUserId: string | null;
  scope: "mine" | "public";
};

function slugifyTemplateTagFragment(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeTemplateTag(tag: string) {
  const trimmed = tag.trim();
  if (!trimmed) {
    return null;
  }

  const prefixedMatch = trimmed.match(/^([a-z]+):(.*)$/i);
  if (prefixedMatch) {
    const prefix = prefixedMatch[1].toLowerCase();
    const value = slugifyTemplateTagFragment(prefixedMatch[2] ?? "");
    return value ? `${prefix}:${value}` : null;
  }

  return slugifyTemplateTagFragment(trimmed);
}

function normalizeTemplateTags(
  tags: string[],
  options?: {
    fallbackSubjectTag?: string;
  },
) {
  const unique = new Set<string>();

  for (const tag of tags) {
    const normalized = normalizeTemplateTag(tag);
    if (normalized) {
      unique.add(normalized);
    }
  }

  const hasSubjectTag = Array.from(unique).some((tag) => tag.startsWith("subject:"));
  if (!hasSubjectTag && options?.fallbackSubjectTag) {
    const fallback = normalizeTemplateTag(options.fallbackSubjectTag);
    if (fallback) {
      unique.add(fallback);
    }
  }

  return Array.from(unique);
}

function parseStoredTemplateTags(value: string | null | undefined) {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return normalizeTemplateTags(parsed.filter((item): item is string => typeof item === "string"));
  } catch {
    return [];
  }
}

function normalizeTemplateGradeTag(gradeLevel: string | undefined) {
  const trimmed = gradeLevel?.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  if (trimmed === "k" || trimmed.includes("kindergarten")) {
    return "grade:k";
  }

  const numericMatch = trimmed.match(/\d{1,2}/);
  if (numericMatch) {
    return `grade:${Number(numericMatch[0])}`;
  }

  const normalized = slugifyTemplateTagFragment(trimmed.replace(/^grade\s+/i, ""));
  return normalized ? `grade:${normalized}` : null;
}

function parseVideoAssignmentPayload(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as VideoAssignmentPayload;
  } catch {
    return null;
  }
}

async function prepareAssignmentContentRef(
  contentType: AssignmentContentType,
  contentRef: string | undefined,
) {
  let finalContentRef = contentRef;
  let transcriptCached = false;
  let transcriptStatus: string | null = null;

  if (contentType === "video" && contentRef) {
    try {
      const parsed = JSON.parse(contentRef) as VideoAssignmentPayload;
      const firstVideo = parsed.videos?.[0];
      if (firstVideo?.videoId) {
        const transcriptResult = await fetchYoutubeTranscriptWithMeta(firstVideo.videoId);
        const fetchedAt = new Date().toISOString();
        firstVideo.transcript = transcriptResult.transcript;
        firstVideo.transcriptFetchedAt = fetchedAt;
        firstVideo.transcriptMeta = transcriptResult.meta;
        finalContentRef = JSON.stringify({
          ...parsed,
          videos: [firstVideo],
        });
        transcriptCached = Boolean(transcriptResult.transcript);
        transcriptStatus = transcriptResult.transcript
          ? "Transcript cached."
          : `Transcript unavailable (${transcriptResult.meta.error ?? "UNKNOWN"}).`;
      }
    } catch {
      // Keep original payload if parsing fails.
    }
  }

  return {
    finalContentRef,
    transcriptCached,
    transcriptStatus,
  };
}

async function persistAssignmentRecord(input: {
  db: ReturnType<typeof getDb>;
  organizationId: string;
  classId: string;
  title: string;
  description?: string;
  contentType: AssignmentContentType;
  contentRef?: string;
  linkedAssignmentId?: string | null;
  dueAt?: string;
  createdByUserId: string;
}) {
  const assignmentId = crypto.randomUUID();
  const { finalContentRef, transcriptCached, transcriptStatus } = await prepareAssignmentContentRef(
    input.contentType,
    input.contentRef,
  );

  await input.db.insert(assignments).values({
    id: assignmentId,
    organizationId: input.organizationId,
    classId: input.classId,
    title: input.title.trim(),
    description: input.description?.trim() || null,
    contentType: input.contentType,
    contentRef: finalContentRef,
    linkedAssignmentId: input.linkedAssignmentId ?? null,
    dueAt: input.dueAt,
    createdByUserId: input.createdByUserId,
  });

  const savedVideoPayload =
    input.contentType === "video" ? parseVideoAssignmentPayload(finalContentRef) : null;

  return {
    success: true,
    assignmentId,
    transcriptCached,
    transcriptStatus,
    savedVideoTranscript: savedVideoPayload?.videos?.[0]?.transcript ?? null,
    savedVideoTitle: savedVideoPayload?.videos?.[0]?.title ?? input.title.trim(),
  };
}

async function getAccessibleAssignmentTemplates(
  db: ReturnType<typeof getDb>,
  options: {
    organizationId: string;
    userId: string;
    contentType?: AssignmentContentType;
    gradeLevel?: string;
  },
) {
  const rows = await db.query.assignmentTemplates.findMany({
    where: or(
      and(
        eq(assignmentTemplates.organizationId, options.organizationId),
        eq(assignmentTemplates.createdByUserId, options.userId),
      ),
      and(
        eq(assignmentTemplates.isPublic, true),
        isNull(assignmentTemplates.organizationId),
        isNull(assignmentTemplates.createdByUserId),
      ),
    ),
  });

  const dbTemplates = rows.map((row): AccessibleAssignmentTemplate => ({
    id: row.id,
    organizationId: row.organizationId ?? null,
    title: row.title,
    description: row.description ?? null,
    contentType: row.contentType as AssignmentContentType,
    contentRef: row.contentRef ?? null,
    tags: parseStoredTemplateTags(row.tags),
    isPublic: Boolean(row.isPublic),
    createdByUserId: row.createdByUserId ?? null,
    scope:
      row.organizationId === options.organizationId && row.createdByUserId === options.userId
        ? "mine"
        : "public",
  }));
  const dedupedTemplates = dbTemplates.filter((template, index, list) => (
    list.findIndex((candidate) => candidate.id === template.id) === index
  ));
  const gradeTag = normalizeTemplateGradeTag(options.gradeLevel);

  return dedupedTemplates
    .filter((row) => {
      if (options.contentType && row.contentType !== options.contentType) {
        return false;
      }
      if (gradeTag && !row.tags.includes(gradeTag)) {
        return false;
      }
      return true;
    })
    .sort((left, right) => {
      if (left.scope !== right.scope) {
        return left.scope === "mine" ? -1 : 1;
      }
      return left.title.localeCompare(right.title);
    });
}

export const createAssignmentRecord = createServerFn({ method: "POST" })
  .inputValidator((data) => createAssignmentInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const targetClass = await db.query.classes.findFirst({
      where: and(
        eq(classes.id, data.classId),
        eq(classes.organizationId, organizationId),
      ),
    });

    if (!targetClass) {
      throw new Error("FORBIDDEN");
    }

    // If linking to another assignment, verify it belongs to this org
    if (data.linkedAssignmentId) {
      const linked = await db.query.assignments.findFirst({
        where: and(
          eq(assignments.id, data.linkedAssignmentId),
          eq(assignments.organizationId, organizationId),
        ),
      });
      if (!linked) throw new Error("LINKED_ASSIGNMENT_NOT_FOUND");
    }

    return await persistAssignmentRecord({
      db,
      organizationId,
      classId: data.classId,
      title: data.title,
      description: data.description,
      contentType: data.contentType,
      contentRef: data.contentRef,
      linkedAssignmentId: data.linkedAssignmentId,
      dueAt: data.dueAt,
      createdByUserId: session.user.id,
    });
  });

const saveAssignmentAsTemplateInput = z.object({
  assignmentId: z.string().min(1),
  tags: z.array(z.string().trim().min(1).max(60)).max(20),
});

export const saveAssignmentAsTemplate = createServerFn({ method: "POST" })
  .inputValidator((data) => saveAssignmentAsTemplateInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const assignmentRecord = await db.query.assignments.findFirst({
      where: and(
        eq(assignments.id, data.assignmentId),
        eq(assignments.organizationId, organizationId),
      ),
    });

    if (!assignmentRecord) {
      throw new Error("NOT_FOUND");
    }

    const templateId = crypto.randomUUID();
    const tags = normalizeTemplateTags(data.tags, {
      fallbackSubjectTag: "subject:custom",
    });

    await db.insert(assignmentTemplates).values({
      id: templateId,
      organizationId,
      title: assignmentRecord.title,
      description: assignmentRecord.description,
      contentType: assignmentRecord.contentType,
      contentRef: assignmentRecord.contentRef,
      tags: JSON.stringify(tags),
      isPublic: false,
      createdByUserId: session.user.id,
    });

    return {
      success: true,
      templateId,
      tags,
    };
  });

const listTemplatesInput = z
  .object({
    contentType: z.enum(ASSIGNMENT_CONTENT_TYPES).optional(),
    gradeLevel: z.string().optional(),
  })
  .optional()
  .transform((value) => value ?? {});

export const listTemplates = createServerFn({ method: "GET" })
  .inputValidator((data) => listTemplatesInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const templates = await getAccessibleAssignmentTemplates(db, {
      organizationId,
      userId: session.user.id,
      contentType: data.contentType,
      gradeLevel: data.gradeLevel,
    });

    return { templates };
  });

export const getTemplateManagerData = createServerFn({ method: "GET" }).handler(async () => {
  const session = await requireActiveRole(["admin", "parent"]);
  const db = getDb();

  const organizationId = await resolveActiveOrganizationId(
    session.user.id,
    session.session.activeOrganizationId,
  );

  const [templates, classRows] = await Promise.all([
    getAccessibleAssignmentTemplates(db, {
      organizationId,
      userId: session.user.id,
    }),
    db.query.classes.findMany({
      where: eq(classes.organizationId, organizationId),
      orderBy: [desc(classes.createdAt)],
    }),
  ]);

  return {
    templates,
    classes: classRows.map((row) => ({ id: row.id, title: row.title })),
  };
});

const duplicateTemplateToMineInput = z.object({
  templateId: z.string().min(1),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
});

export const duplicateTemplateToMine = createServerFn({ method: "POST" })
  .inputValidator((data) => duplicateTemplateToMineInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const accessible = await getAccessibleAssignmentTemplates(db, {
      organizationId,
      userId: session.user.id,
    });
    const template = accessible.find((row) => row.id === data.templateId);

    if (!template) {
      throw new Error("NOT_FOUND");
    }

    const templateId = crypto.randomUUID();
    const tags = normalizeTemplateTags(data.tags ?? template.tags, {
      fallbackSubjectTag: "subject:custom",
    });

    await db.insert(assignmentTemplates).values({
      id: templateId,
      organizationId,
      title: template.title,
      description: template.description,
      contentType: template.contentType,
      contentRef: template.contentRef,
      tags: JSON.stringify(tags),
      isPublic: false,
      createdByUserId: session.user.id,
    });

    return {
      success: true,
      templateId,
      tags,
    };
  });

const updateAssignmentTemplateInput = z.object({
  templateId: z.string().min(1),
  title: z.string().trim().min(1).max(180),
  description: z.string().optional(),
  contentType: z.enum(ASSIGNMENT_CONTENT_TYPES),
  contentRef: z.string().optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
});

export const updateAssignmentTemplate = createServerFn({ method: "POST" })
  .inputValidator((data) => updateAssignmentTemplateInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const existing = await db.query.assignmentTemplates.findFirst({
      where: and(
        eq(assignmentTemplates.id, data.templateId),
        eq(assignmentTemplates.organizationId, organizationId),
        eq(assignmentTemplates.createdByUserId, session.user.id),
      ),
    });

    if (!existing) {
      throw new Error("NOT_FOUND");
    }

    const tags = normalizeTemplateTags(data.tags ?? parseStoredTemplateTags(existing.tags), {
      fallbackSubjectTag: "subject:custom",
    });

    await db
      .update(assignmentTemplates)
      .set({
        title: data.title.trim(),
        description: data.description?.trim() || null,
        contentType: data.contentType,
        contentRef: data.contentRef?.trim() || null,
        tags: JSON.stringify(tags),
      })
      .where(eq(assignmentTemplates.id, existing.id));

    return {
      success: true,
      templateId: existing.id,
      tags,
    };
  });

const deleteTemplateInput = z.object({
  templateId: z.string().min(1),
});

export const deleteAssignmentTemplate = createServerFn({ method: "POST" })
  .inputValidator((data) => deleteTemplateInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const existing = await db.query.assignmentTemplates.findFirst({
      where: and(
        eq(assignmentTemplates.id, data.templateId),
        eq(assignmentTemplates.organizationId, organizationId),
        eq(assignmentTemplates.createdByUserId, session.user.id),
      ),
    });

    if (!existing) {
      throw new Error("NOT_FOUND");
    }

    await db.delete(assignmentTemplates).where(eq(assignmentTemplates.id, existing.id));
    return { success: true };
  });

const createAssignmentFromTemplateInput = z.object({
  templateId: z.string().min(1),
  classId: z.string().min(1),
  dueAt: z.string().optional(),
});

export const createAssignmentFromTemplate = createServerFn({ method: "POST" })
  .inputValidator((data) => createAssignmentFromTemplateInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const targetClass = await db.query.classes.findFirst({
      where: and(
        eq(classes.id, data.classId),
        eq(classes.organizationId, organizationId),
      ),
    });

    if (!targetClass) {
      throw new Error("FORBIDDEN");
    }

    const templates = await getAccessibleAssignmentTemplates(db, {
      organizationId,
      userId: session.user.id,
    });
    const template = templates.find((row) => row.id === data.templateId);

    if (!template) {
      throw new Error("NOT_FOUND");
    }

    return await persistAssignmentRecord({
      db,
      organizationId,
      classId: data.classId,
      title: template.title,
      description: template.description ?? undefined,
      contentType: template.contentType,
      contentRef: template.contentRef ?? undefined,
      dueAt: data.dueAt,
      createdByUserId: session.user.id,
    });
  });

const updateAssignmentInput = z.object({
  assignmentId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  contentRef: z.string().optional(),
  linkedAssignmentId: z.string().nullable().optional(),
  classId: z.string().optional(),
  nodeId: z.string().nullable().optional(),
  dueAt: z.string().optional(),
});

export const updateAssignmentRecord = createServerFn({ method: "POST" })
  .inputValidator((data) => updateAssignmentInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const existing = await db.query.assignments.findFirst({
      where: and(
        eq(assignments.id, data.assignmentId),
        eq(assignments.organizationId, organizationId),
      ),
    });

    if (!existing) {
      throw new Error("NOT_FOUND");
    }

    // If linking to another assignment, verify it belongs to this org
    if (data.linkedAssignmentId) {
      const linked = await db.query.assignments.findFirst({
        where: and(
          eq(assignments.id, data.linkedAssignmentId),
          eq(assignments.organizationId, organizationId),
        ),
      });
      if (!linked) throw new Error("LINKED_ASSIGNMENT_NOT_FOUND");
    }

    let nextClassId = existing.classId;
    if (data.classId) {
      const targetClass = await db.query.classes.findFirst({
        where: and(
          eq(classes.id, data.classId),
          eq(classes.organizationId, organizationId),
        ),
      });
      if (!targetClass) {
        throw new Error("CLASS_NOT_FOUND");
      }
      nextClassId = targetClass.id;
    }

    if (data.nodeId) {
      const nodeRow = await db
        .select({
          nodeId: skillTreeNodes.id,
          classId: skillTrees.classId,
        })
        .from(skillTreeNodes)
        .innerJoin(skillTrees, eq(skillTreeNodes.treeId, skillTrees.id))
        .where(
          and(
            eq(skillTreeNodes.id, data.nodeId),
            eq(skillTreeNodes.organizationId, organizationId),
            eq(skillTrees.organizationId, organizationId),
          ),
        )
        .limit(1);

      const node = nodeRow[0];
      if (!node) {
        throw new Error("NODE_NOT_FOUND");
      }
      if (!node.classId || node.classId !== nextClassId) {
        throw new Error("NODE_CLASS_MISMATCH");
      }
    }

    await db
      .update(assignments)
      .set({
        classId: nextClassId,
        title: data.title.trim(),
        description: data.description?.trim() || null,
        contentRef: data.contentRef !== undefined ? data.contentRef : existing.contentRef,
        linkedAssignmentId:
          data.linkedAssignmentId !== undefined
            ? data.linkedAssignmentId
            : existing.linkedAssignmentId,
        dueAt: data.dueAt || null,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(assignments.id, data.assignmentId),
          eq(assignments.organizationId, organizationId),
        ),
      );

    const classChanged = nextClassId !== existing.classId;
    const shouldRewriteNodeLinks = data.nodeId !== undefined || classChanged;

    if (shouldRewriteNodeLinks) {
      await db
        .delete(skillTreeNodeAssignments)
        .where(eq(skillTreeNodeAssignments.assignmentId, data.assignmentId));

      if (data.nodeId) {
        const highestNodeOrder = await db.query.skillTreeNodeAssignments.findFirst({
          where: eq(skillTreeNodeAssignments.nodeId, data.nodeId),
          orderBy: [desc(skillTreeNodeAssignments.orderIndex)],
        });
        const nextOrderIndex = (highestNodeOrder?.orderIndex ?? -1) + 1;

        await db.insert(skillTreeNodeAssignments).values({
          id: crypto.randomUUID(),
          nodeId: data.nodeId,
          assignmentId: data.assignmentId,
          orderIndex: nextOrderIndex,
        });
      }
    }

    return { success: true };
  });

const deleteWithPinInput = z.object({
  id: z.string().min(1),
  parentPin: z.string().regex(/^\d{4,6}$/),
});

async function verifyParentPinForSession(userId: string, pin: string) {
  const db = getDb();
  const userRecord = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!userRecord?.parentPin) throw new Error("FORBIDDEN");
  const incomingHash = await hashParentPin(pin);
  if (incomingHash !== userRecord.parentPin) throw new Error("INVALID_PIN");
  if (userRecord.parentPinLength !== pin.length) {
    try {
      await db
        .update(users)
        .set({
          parentPinLength: pin.length,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(users.id, userId));
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("no such column") && message.includes("parent_pin_length")) {
        throw new Error("PIN_LENGTH_MIGRATION_REQUIRED");
      }
      throw error;
    }
  }
}

export const deleteAssignmentRecord = createServerFn({ method: "POST" })
  .inputValidator((data) => deleteWithPinInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    await verifyParentPinForSession(session.user.id, data.parentPin);
    const db = getDb();
    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );
    const existing = await db.query.assignments.findFirst({
      where: and(eq(assignments.id, data.id), eq(assignments.organizationId, organizationId)),
    });
    if (!existing) throw new Error("NOT_FOUND");
    await db
      .delete(assignments)
      .where(
        and(
          eq(assignments.organizationId, organizationId),
          or(eq(assignments.id, data.id), eq(assignments.linkedAssignmentId, data.id)),
        ),
      );
    return { success: true };
  });

export const deleteClassRecord = createServerFn({ method: "POST" })
  .inputValidator((data) => deleteWithPinInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    await verifyParentPinForSession(session.user.id, data.parentPin);
    const db = getDb();
    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );
    const existing = await db.query.classes.findFirst({
      where: and(eq(classes.id, data.id), eq(classes.organizationId, organizationId)),
    });
    if (!existing) throw new Error("NOT_FOUND");
    await db.delete(classes).where(eq(classes.id, data.id));
    return { success: true };
  });

export const deleteStudentProfileRecord = createServerFn({ method: "POST" })
  .inputValidator((data) => deleteWithPinInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    await verifyParentPinForSession(session.user.id, data.parentPin);
    const db = getDb();
    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );
    const existing = await db.query.profiles.findFirst({
      where: and(
        eq(profiles.id, data.id),
        eq(profiles.parentUserId, session.user.id),
        eq(profiles.organizationId, organizationId),
      ),
    });
    if (!existing) throw new Error("NOT_FOUND");
    await db.delete(profiles).where(eq(profiles.id, data.id));
    return { success: true };
  });

export const archiveStudentProfile = createServerFn({ method: "POST" })
  .inputValidator((data) => deleteWithPinInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    await verifyParentPinForSession(session.user.id, data.parentPin);
    const db = getDb();
    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );
    const existing = await db.query.profiles.findFirst({
      where: and(
        eq(profiles.id, data.id),
        eq(profiles.parentUserId, session.user.id),
        eq(profiles.organizationId, organizationId),
        eq(profiles.status, "active"),
      ),
    });
    if (!existing) throw new Error("NOT_FOUND");
    await db
      .update(profiles)
      .set({ status: "archived", updatedAt: new Date().toISOString() })
      .where(eq(profiles.id, data.id));
    return { success: true };
  });

const restoreStudentInput = z.object({ id: z.string().min(1) });

export const restoreStudentProfile = createServerFn({ method: "POST" })
  .inputValidator((data) => restoreStudentInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();
    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );
    const existing = await db.query.profiles.findFirst({
      where: and(
        eq(profiles.id, data.id),
        eq(profiles.parentUserId, session.user.id),
        eq(profiles.organizationId, organizationId),
        eq(profiles.status, "archived"),
      ),
    });
    if (!existing) throw new Error("NOT_FOUND");
    await db
      .update(profiles)
      .set({ status: "active", updatedAt: new Date().toISOString() })
      .where(eq(profiles.id, data.id));
    return { success: true };
  });

export const getCurriculumBuilderData = createServerFn({ method: "GET" }).handler(
  async () => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const [classRows, assignmentRows, userRecord, submissionRows, profileRows, templatesResult, markingPeriodRows, skillTreeNodeRows, assignmentNodeLinkRows] = await Promise.all([
      db.query.classes.findMany({
        where: eq(classes.organizationId, organizationId),
        orderBy: [desc(classes.createdAt)],
      }),
      db.query.assignments.findMany({
        where: eq(assignments.organizationId, organizationId),
        orderBy: [desc(assignments.createdAt)],
      }),
      db.query.users.findFirst({
        where: eq(users.id, session.user.id),
      }),
      db.query.submissions.findMany({
        where: eq(submissions.organizationId, organizationId),
        orderBy: [desc(submissions.submittedAt)],
      }),
      db.query.profiles.findMany({
        where: and(
          eq(profiles.organizationId, organizationId),
          eq(profiles.status, "active"),
        ),
      }),
      getAccessibleAssignmentTemplates(db, {
        organizationId,
        userId: session.user.id,
      }),
      db.query.markingPeriods.findMany({
        where: eq(markingPeriods.organizationId, organizationId),
        orderBy: [markingPeriods.periodNumber],
      }),
      db
        .select({
          nodeId: skillTreeNodes.id,
          nodeTitle: skillTreeNodes.title,
          nodeType: skillTreeNodes.nodeType,
          treeTitle: skillTrees.title,
          classId: skillTrees.classId,
        })
        .from(skillTreeNodes)
        .innerJoin(skillTrees, eq(skillTreeNodes.treeId, skillTrees.id))
        .where(
          and(
            eq(skillTreeNodes.organizationId, organizationId),
            eq(skillTrees.organizationId, organizationId),
          ),
        ),
      db
        .select({
          assignmentId: skillTreeNodeAssignments.assignmentId,
          nodeId: skillTreeNodeAssignments.nodeId,
          orderIndex: skillTreeNodeAssignments.orderIndex,
        })
        .from(skillTreeNodeAssignments)
        .innerJoin(skillTreeNodes, eq(skillTreeNodeAssignments.nodeId, skillTreeNodes.id))
        .where(eq(skillTreeNodes.organizationId, organizationId)),
    ]);
    const templates: AccessibleAssignmentTemplate[] = templatesResult;

    return {
      parentPinLength: resolveParentPinLength(userRecord?.parentPinLength),
      classes: classRows,
      assignments: assignmentRows,
      markingPeriods: markingPeriodRows,
      templates,
      submissions: submissionRows,
      skillTreeLessons: skillTreeNodeRows
        .filter((row) => Boolean(row.classId))
        .map((row) => ({
          id: row.nodeId,
          classId: row.classId as string,
          title: row.nodeTitle,
          nodeType: row.nodeType,
          treeTitle: row.treeTitle,
        })),
      assignmentNodeLinks: assignmentNodeLinkRows
        .sort((a, b) => b.orderIndex - a.orderIndex)
        .map((row) => ({
          assignmentId: row.assignmentId,
          nodeId: row.nodeId,
        })),
      profiles: profileRows.map((p) => ({
        id: p.id,
        displayName: p.displayName,
        gradeLevel: p.gradeLevel ?? "",
      })),
    };
  },
);

// ── Quiz generation from a specific video (fetches transcript first) ──────────

const generateQuizFromVideoInput = z.object({
  videoId: z.string().min(1),
  videoTitle: z.string().min(1),
  videoDescription: z.string().optional(),
  gradeLevel: z.string().optional(),
  questionCount: z.number().int().min(3).max(10).default(5),
});

export const generateQuizFromVideo = createServerFn({ method: "POST" })
  .inputValidator((data) => generateQuizFromVideoInput.parse(data))
  .handler(async ({ data }) => {
    await requireActiveRole(["admin", "parent"]);

    // Try to fetch transcript — falls back gracefully if unavailable
    const transcriptResult = await fetchYoutubeTranscriptWithMeta(data.videoId);
    const transcript = transcriptResult.transcript;
    const usedTranscript = transcript !== null;

    try {
      const quiz = await generateQuizDraft({
        topic: data.videoTitle,
        gradeLevel: data.gradeLevel,
        questionCount: data.questionCount,
        transcript: transcript ?? undefined,
        videoDescription: data.videoDescription,
      });

      return {
        quiz,
        usedTranscript,
        transcriptMeta: transcriptResult.meta,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "QUIZ_GENERATION_FAILED";
      if (errorMessage.includes("AI_QUIZ_PARSE_FAILED") || errorMessage.includes("AI_RESPONSE_PARSE_FAILED")) {
        if (usedTranscript) {
          throw new Error("QUIZ_GENERATION_FAILED_WITH_TRANSCRIPT");
        }

        const meta = transcriptResult.meta;
        const detail = [
          `reason=${meta.error ?? "UNKNOWN"}`,
          `endpoint=${meta.endpoint}`,
          `status=${meta.status ?? "NA"}`,
          `keyPresent=${meta.keyPresent ? "1" : "0"}`,
          `attempted=${meta.attempted ? "1" : "0"}`,
        ].join(";");
        throw new Error(`QUIZ_GENERATION_FAILED_NO_TRANSCRIPT:${detail}`);
      }
      throw error;
    }
  });

const generateQuizFromLinkedAssignmentInput = z.object({
  assignmentId: z.string().min(1),
  questionCount: z.number().int().min(3).max(10).default(5),
});

export const generateQuizFromLinkedAssignment = createServerFn({ method: "POST" })
  .inputValidator((data) => generateQuizFromLinkedAssignmentInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const assignmentRecord = await db.query.assignments.findFirst({
      where: and(
        eq(assignments.id, data.assignmentId),
        eq(assignments.organizationId, organizationId),
      ),
    });

    if (!assignmentRecord) {
      throw new Error("NOT_FOUND");
    }

    if (assignmentRecord.contentType === "video") {
      let payload: VideoAssignmentPayload | null = null;
      try {
        payload = assignmentRecord.contentRef ? JSON.parse(assignmentRecord.contentRef) as VideoAssignmentPayload : null;
      } catch {
        payload = null;
      }

      const primaryVideo = payload?.videos?.[0];
      if (!primaryVideo?.videoId) {
        throw new Error("VIDEO_DATA_REQUIRED");
      }

      const transcript = primaryVideo.transcript?.trim() || null;
      if (!transcript) {
        throw new Error("VIDEO_TRANSCRIPT_REQUIRED");
      }

      const quiz = await generateQuizDraft({
        topic: primaryVideo.title?.trim() || assignmentRecord.title,
        questionCount: data.questionCount,
        transcript,
        videoDescription: primaryVideo.description ?? assignmentRecord.description ?? undefined,
      });

      return {
        quiz,
        sourceType: "video" as const,
        sourceTitle: primaryVideo.title?.trim() || assignmentRecord.title,
      };
    }

    if (assignmentRecord.contentType === "text") {
      const sourceText = (assignmentRecord.contentRef ?? "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      if (!sourceText) {
        throw new Error("READING_CONTENT_REQUIRED");
      }

      const quiz = await generateQuizDraft({
        topic: assignmentRecord.title,
        questionCount: data.questionCount,
        sourceText,
      });

      return {
        quiz,
        sourceType: "text" as const,
        sourceTitle: assignmentRecord.title,
      };
    }

    throw new Error("UNSUPPORTED_SOURCE_TYPE");
  });

const generateQuizInput = z.object({
  topic: z.string().min(3),
  gradeLevel: z.string().optional(),
  questionCount: z.number().int().min(3).max(10).default(5),
});

export const generateQuizDraftForCurriculum = createServerFn({ method: "POST" })
  .inputValidator((data) => generateQuizInput.parse(data))
  .handler(async ({ data }) => {
    await requireActiveRole(["admin", "parent"]);

    const quiz = await generateQuizDraft({ topic: data.topic, gradeLevel: data.gradeLevel, questionCount: data.questionCount });
    return {
      quiz,
    };
  });

// ── AI submission grading ─────────────────────────────────────────────────────

const gradeSubmissionWithAIInput = z.object({
  submissionId: z.string().min(1),
  assignmentId: z.string().min(1),
  rubricText: z.string().optional(),
  gradeLevel: z.string().min(1),
});

export const gradeSubmissionWithAI = createServerFn({ method: "POST" })
  .inputValidator((data) => gradeSubmissionWithAIInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const [submissionRecord, assignmentRecord] = await Promise.all([
      db.query.submissions.findFirst({
        where: and(
          eq(submissions.id, data.submissionId),
          eq(submissions.organizationId, organizationId),
        ),
      }),
      db.query.assignments.findFirst({
        where: and(
          eq(assignments.id, data.assignmentId),
          eq(assignments.organizationId, organizationId),
        ),
      }),
    ]);

    if (!submissionRecord || !assignmentRecord) {
      throw new Error("NOT_FOUND");
    }

    if (!submissionRecord.textResponse) {
      throw new Error("NO_TEXT_RESPONSE");
    }

    const rubricOrInstructions =
      data.rubricText?.trim() ||
      (assignmentRecord.contentRef
        ? assignmentRecord.contentRef.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
        : undefined);

    const result = await gradeSubmission({
      submissionText: submissionRecord.textResponse,
      assignmentTitle: assignmentRecord.title,
      rubricOrInstructions,
      gradeLevel: data.gradeLevel,
    });

    const feedbackJson = JSON.stringify(result);

    await db
      .update(submissions)
      .set({
        score: result.score,
        feedbackJson,
        status: "graded",
        reviewedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(submissions.id, data.submissionId));

    return result;
  });

const getStudentWorkspaceInput = z
  .object({
    profileId: z.string().optional(),
  })
  .optional();

async function resolveStudentProfile(
  userId: string,
  organizationId: string,
  providedProfileId?: string,
) {
  const db = getDb();

  if (providedProfileId) {
    const provided = await db.query.profiles.findFirst({
      where: and(
        eq(profiles.id, providedProfileId),
        eq(profiles.organizationId, organizationId),
        eq(profiles.status, "active"),
      ),
    });

    if (!provided) {
      throw new Error("FORBIDDEN");
    }

    return provided;
  }

  const fallback = await db.query.profiles.findFirst({
    where: and(
      eq(profiles.parentUserId, userId),
      eq(profiles.organizationId, organizationId),
      eq(profiles.status, "active"),
    ),
  });

  if (!fallback) {
    throw new Error("NO_STUDENT_PROFILE");
  }

  return fallback;
}

export const getStudentWorkspaceData = createServerFn({ method: "GET" })
  .inputValidator((data) => getStudentWorkspaceInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent", "student"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const profile = await resolveStudentProfile(
      session.user.id,
      organizationId,
      data?.profileId,
    );

    const enrolledClassRows = await db
      .select({ classId: classes.id })
      .from(classEnrollments)
      .innerJoin(classes, eq(classEnrollments.classId, classes.id))
      .where(
        and(
          eq(classEnrollments.profileId, profile.id),
          eq(classes.organizationId, organizationId),
        ),
      );

    const enrolledClassIds = enrolledClassRows.map((row) => row.classId);

    const [assignmentRows, submissionRows] = await Promise.all([
      enrolledClassIds.length
        ? db.query.assignments.findMany({
            where: and(
              eq(assignments.organizationId, organizationId),
              inArray(assignments.classId, enrolledClassIds),
            ),
            orderBy: [desc(assignments.createdAt)],
          })
        : Promise.resolve([]),
      db.query.submissions.findMany({
        where: and(
          eq(submissions.organizationId, organizationId),
          eq(submissions.profileId, profile.id),
        ),
        orderBy: [desc(submissions.createdAt)],
      }),
    ]);

    return {
      profile: {
        id: profile.id,
        displayName: profile.displayName,
        gradeLevel: profile.gradeLevel,
      },
      assignments: assignmentRows,
      submissions: submissionRows,
    };
  });

const submitAssignmentInput = z.object({
  assignmentId: z.string().min(1),
  profileId: z.string().min(1),
  textResponse: z.string().optional(),
  fileName: z.string().optional(),
  fileType: z.string().optional(),
  fileBase64: z.string().optional(),
});

type QuizQuestionForScoring = {
  answerIndex: number;
};

type QuizPayloadForScoring = {
  questions?: QuizQuestionForScoring[];
};

function decodeBase64ToUint8Array(base64Text: string) {
  const normalized = base64Text.includes(",")
    ? base64Text.split(",").pop() ?? ""
    : base64Text;
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

function computeQuizAutoScore(
  assignmentRecord: typeof assignments.$inferSelect,
  textResponse?: string,
) {
  if (assignmentRecord.contentType !== "quiz" || !textResponse) {
    return null;
  }

  let payload: QuizPayloadForScoring | null = null;
  try {
    payload = assignmentRecord.contentRef
      ? (JSON.parse(assignmentRecord.contentRef) as QuizPayloadForScoring)
      : null;
  } catch {
    payload = null;
  }

  const questions = payload?.questions ?? [];
  if (questions.length === 0) {
    return null;
  }

  let answers: number[] | null = null;
  try {
    answers = JSON.parse(textResponse) as number[];
  } catch {
    answers = null;
  }

  if (!answers) {
    return null;
  }

  const correct = questions.filter((question, index) => answers[index] === question.answerIndex).length;
  return Math.round((correct / questions.length) * 100);
}

export const submitAssignmentWork = createServerFn({ method: "POST" })
  .inputValidator((data) => submitAssignmentInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent", "student"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const [assignmentRecord, profileRecord] = await Promise.all([
      db.query.assignments.findFirst({
        where: and(
          eq(assignments.id, data.assignmentId),
          eq(assignments.organizationId, organizationId),
        ),
      }),
      db.query.profiles.findFirst({
        where: and(
          eq(profiles.id, data.profileId),
          eq(profiles.organizationId, organizationId),
          eq(profiles.status, "active"),
        ),
      }),
    ]);

    if (!assignmentRecord || !profileRecord) {
      throw new Error("FORBIDDEN");
    }

    const enrollment = await db.query.classEnrollments.findFirst({
      where: and(
        eq(classEnrollments.classId, assignmentRecord.classId),
        eq(classEnrollments.profileId, data.profileId),
      ),
    });

    if (!enrollment) {
      throw new Error("FORBIDDEN");
    }

    const nowIso = new Date().toISOString();
    const score = computeQuizAutoScore(assignmentRecord, data.textResponse);
    const nextStatus = typeof score === "number" ? "graded" : "submitted";

    let assetKey: string | undefined;

    if (data.fileBase64 && data.fileName) {
      const bytes = decodeBase64ToUint8Array(data.fileBase64);

      if (bytes.byteLength > 10 * 1024 * 1024) {
        throw new Error("FILE_TOO_LARGE");
      }

      assetKey = `submissions/${organizationId}/${data.profileId}/${crypto.randomUUID()}-${data.fileName}`;

      await env.BUCKET.put(assetKey, bytes, {
        httpMetadata: {
          contentType: data.fileType ?? "application/octet-stream",
        },
      });
    }

    const existing = await db.query.submissions.findFirst({
      where: and(
        eq(submissions.assignmentId, data.assignmentId),
        eq(submissions.profileId, data.profileId),
      ),
    });

    if (existing) {
      if (existing.status !== "returned") {
        throw new Error("ALREADY_SUBMITTED");
      }

      await db
        .update(submissions)
        .set({
          textResponse: data.textResponse,
          assetKey: assetKey ?? existing.assetKey,
          status: nextStatus,
          score,
          feedbackJson: null,
          reviewedAt: typeof score === "number" ? nowIso : null,
          submittedAt: nowIso,
          updatedAt: nowIso,
          submittedByUserId: session.user.id,
        })
        .where(eq(submissions.id, existing.id));
    } else {
      await db.insert(submissions).values({
        id: crypto.randomUUID(),
        organizationId,
        assignmentId: data.assignmentId,
        profileId: data.profileId,
        submittedByUserId: session.user.id,
        assetKey,
        textResponse: data.textResponse,
        status: nextStatus,
        score,
        reviewedAt: typeof score === "number" ? nowIso : null,
      });
    }

    return {
      success: true,
      assetKey: assetKey ?? null,
      score,
      status: nextStatus,
    };
  });

const releaseSubmissionInput = z.object({
  submissionId: z.string().min(1),
});

export const releaseSubmissionToStudent = createServerFn({ method: "POST" })
  .inputValidator((data) => releaseSubmissionInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const existing = await db.query.submissions.findFirst({
      where: and(
        eq(submissions.id, data.submissionId),
        eq(submissions.organizationId, organizationId),
      ),
    });

    if (!existing) {
      throw new Error("NOT_FOUND");
    }

    await db
      .update(submissions)
      .set({
        status: "returned",
        score: null,
        feedbackJson: null,
        reviewedAt: null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(submissions.id, existing.id));

    return { success: true };
  });

const progressSnapshotInput = z
  .object({
    profileId: z.string().optional(),
  })
  .optional();

export const getProgressSnapshot = createServerFn({ method: "GET" })
  .inputValidator((data) => progressSnapshotInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent", "student"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const profile = await resolveStudentProfile(
      session.user.id,
      organizationId,
      data?.profileId,
    );

    const enrolledClassRows = await db
      .select({ classId: classes.id, classTitle: classes.title })
      .from(classEnrollments)
      .innerJoin(classes, eq(classEnrollments.classId, classes.id))
      .where(
        and(
          eq(classEnrollments.profileId, profile.id),
          eq(classes.organizationId, organizationId),
        ),
      );

    const enrolledClassIds = enrolledClassRows.map((row) => row.classId);

    const [assignmentRows, submissionRows] = await Promise.all([
      enrolledClassIds.length
        ? db.query.assignments.findMany({
            where: and(
              eq(assignments.organizationId, organizationId),
              inArray(assignments.classId, enrolledClassIds),
            ),
          })
        : Promise.resolve([]),
      db.query.submissions.findMany({
        where: and(
          eq(submissions.organizationId, organizationId),
          eq(submissions.profileId, profile.id),
        ),
      }),
    ]);

    const submissionByAssignmentId = new Map(
      submissionRows.map((row) => [row.assignmentId, row]),
    );

    const mastery = enrolledClassRows.map((classRow) => {
      const classAssignments = assignmentRows.filter(
        (assignment) => assignment.classId === classRow.classId,
      );

      if (classAssignments.length === 0) {
        return {
          classId: classRow.classId,
          classTitle: classRow.classTitle,
          completionPercent: 0,
          averageScore: null as number | null,
        };
      }

      let submittedCount = 0;
      const scored: number[] = [];

      for (const assignment of classAssignments) {
        const submission = submissionByAssignmentId.get(assignment.id);
        if (!submission || submission.status === "returned") {
          continue;
        }

        submittedCount += 1;
        if (typeof submission.score === "number") {
          scored.push(submission.score);
        }
      }

      const completionPercent = Math.round(
        (submittedCount / classAssignments.length) * 100,
      );

      const averageScore =
        scored.length > 0
          ? Math.round(scored.reduce((sum, current) => sum + current, 0) / scored.length)
          : null;

      return {
        classId: classRow.classId,
        classTitle: classRow.classTitle,
        completionPercent,
        averageScore,
      };
    });

    // ── XP level from skill trees ────────────────────────────────────────────
    const XP_THRESHOLDS = [0, 200, 500, 900, 1400, 2000, 2700, 3500, 4400, 5400, 6500];
    const XP_TITLES = [
      "Curious Learner", "Explorer", "Scholar", "Apprentice", "Journeyman",
      "Adept", "Expert", "Master", "Grand Scholar", "Sage",
    ];

    const xpProgressRows = await db
      .select({ xpEarned: skillTreeNodeProgress.xpEarned })
      .from(skillTreeNodeProgress)
      .where(eq(skillTreeNodeProgress.profileId, profile.id));

    const totalXp = xpProgressRows.reduce((acc, r) => acc + (r.xpEarned ?? 0), 0);

    let level = 1;
    for (let i = 0; i < XP_THRESHOLDS.length; i++) {
      if (totalXp >= XP_THRESHOLDS[i]!) level = i + 1;
    }
    const xpTitle = XP_TITLES[level - 1] ?? "Curious Learner";
    const currentThreshold = XP_THRESHOLDS[level - 1] ?? 0;
    const nextThreshold = XP_THRESHOLDS[level] ?? null;
    const xpToNextLevel = nextThreshold !== null ? nextThreshold - totalXp : null;

    return {
      profile: {
        id: profile.id,
        displayName: profile.displayName,
      },
      mastery,
      xpLevel: level,
      xpTitle,
      totalXp,
      currentThreshold,
      nextThreshold,
      xpToNextLevel,
    };
  });

// ── Gradebook data ────────────────────────────────────────────────────────────

export const getGradeBookData = createServerFn({ method: "GET" }).handler(async () => {
  const session = await requireActiveRole(["admin", "parent"]);
  const db = getDb();

  const organizationId = await resolveActiveOrganizationId(
    session.user.id,
    session.session.activeOrganizationId,
  );

  const [profileRows, classRows, assignmentRows, submissionRows] = await Promise.all([
    db.query.profiles.findMany({
      where: and(
        eq(profiles.organizationId, organizationId),
        eq(profiles.status, "active"),
      ),
      orderBy: [desc(profiles.createdAt)],
    }),
    db.query.classes.findMany({
      where: eq(classes.organizationId, organizationId),
      orderBy: [desc(classes.createdAt)],
    }),
    db.query.assignments.findMany({
      where: eq(assignments.organizationId, organizationId),
      orderBy: [desc(assignments.createdAt)],
    }),
    db.query.submissions.findMany({
      where: eq(submissions.organizationId, organizationId),
      orderBy: [desc(submissions.submittedAt)],
    }),
  ]);

  const profileById = new Map(profileRows.map((p) => [p.id, p]));
  const classById = new Map(classRows.map((c) => [c.id, c]));

  const rows = submissionRows.flatMap((sub) => {
    const assignment = assignmentRows.find((a) => a.id === sub.assignmentId);
    if (!assignment) return [];
    const profile = profileById.get(sub.profileId);
    const cls = classById.get(assignment.classId);
    return [{
      submissionId: sub.id,
      assignmentId: assignment.id,
      profileId: sub.profileId,
      studentName: profile?.displayName ?? "Unknown",
      classId: assignment.classId,
      className: cls?.title ?? "Unknown",
      assignmentTitle: assignment.title,
      contentType: assignment.contentType,
      submittedAt: sub.submittedAt,
      score: sub.score ?? null,
      status: sub.status,
      feedbackJson: sub.feedbackJson ?? null,
    }];
  });

  return {
    rows,
    profiles: profileRows.map((p) => ({ id: p.id, displayName: p.displayName })),
    classes: classRows.map((c) => ({ id: c.id, title: c.title })),
  };
});

// ── Week planner ──────────────────────────────────────────────────────────────

const getTodaysPlanInput = z.object({
  profileId: z.string().min(1),
});

export const getTodaysPlan = createServerFn({ method: "POST" })
  .inputValidator((data) => getTodaysPlanInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent", "student"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const today = new Date().toISOString().slice(0, 10);

    const slots = await db
      .select({
        assignmentId: weekPlan.assignmentId,
        orderIndex: weekPlan.orderIndex,
        assignmentTitle: assignments.title,
        assignmentContentType: assignments.contentType,
        classTitle: classes.title,
      })
      .from(weekPlan)
      .innerJoin(assignments, eq(weekPlan.assignmentId, assignments.id))
      .innerJoin(classes, eq(assignments.classId, classes.id))
      .where(
        and(
          eq(weekPlan.organizationId, organizationId),
          eq(weekPlan.profileId, data.profileId),
          eq(weekPlan.scheduledDate, today),
        ),
      )
      .orderBy(weekPlan.orderIndex);

    return { slots, today };
  });

/**
 * Snap an ISO date to the correct week-start for the given school week length.
 * 7-day weeks start on Sunday; all others start on Monday.
 */
function snapToWeekStart(isoDate: string, numDays: number): string {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  const utcMs = Date.UTC(y, m - 1, d);
  const dow = new Date(utcMs).getUTCDay(); // 0=Sun, 1=Mon…
  let offset: number;
  if (numDays === 7) {
    offset = dow; // back to Sunday
  } else {
    offset = dow === 0 ? 6 : dow - 1; // back to Monday (Sun → 6 days back)
  }
  return new Date(utcMs - offset * 86400000).toISOString().slice(0, 10);
}

const getWeekPlanInput = z.object({
  profileId: z.string().min(1),
  weekStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const getWeekPlan = createServerFn({ method: "GET" })
  .inputValidator((data) => getWeekPlanInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent", "student"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    // Fetch org school week days setting
    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, organizationId),
    });
    const schoolWeekDays = Math.min(Math.max(org?.schoolWeekDays ?? 5, 4), 7);

    // Build week end date based on configured school week length.
    // Use UTC arithmetic to avoid timezone bugs with new Date("YYYY-MM-DD").
    function addDaysToIsoGet(isoDate: string, days: number): string {
      const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
      return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
    }
    const snappedWeekStart = snapToWeekStart(data.weekStartDate, schoolWeekDays);
    const weekEndDate = addDaysToIsoGet(snappedWeekStart, schoolWeekDays - 1);

    const slots = await db
      .select({
        id: weekPlan.id,
        assignmentId: weekPlan.assignmentId,
        scheduledDate: weekPlan.scheduledDate,
        orderIndex: weekPlan.orderIndex,
        assignmentTitle: assignments.title,
        assignmentContentType: assignments.contentType,
        classId: assignments.classId,
        classTitle: classes.title,
      })
      .from(weekPlan)
      .innerJoin(assignments, eq(weekPlan.assignmentId, assignments.id))
      .innerJoin(classes, eq(assignments.classId, classes.id))
      .where(
        and(
          eq(weekPlan.organizationId, organizationId),
          eq(weekPlan.profileId, data.profileId),
          gte(weekPlan.scheduledDate, snappedWeekStart),
          lte(weekPlan.scheduledDate, weekEndDate),
        ),
      )
      .orderBy(weekPlan.scheduledDate, weekPlan.orderIndex);

    // Also return unscheduled pending assignments for this profile
    const enrolledClassRows = await db
      .select({ classId: classEnrollments.classId })
      .from(classEnrollments)
      .where(eq(classEnrollments.profileId, data.profileId));

    const enrolledClassIds = enrolledClassRows.map((r) => r.classId);

    const scheduledAssignmentIds = new Set(slots.map((s) => s.assignmentId));

    const submittedRows = await db
      .select({ assignmentId: submissions.assignmentId })
      .from(submissions)
      .where(
        and(
          eq(submissions.profileId, data.profileId),
          eq(submissions.organizationId, organizationId),
        ),
      );

    const submittedIds = new Set(submittedRows.map((r) => r.assignmentId));

    const pendingAssignments = enrolledClassIds.length
      ? await db
          .select({
            id: assignments.id,
            title: assignments.title,
            contentType: assignments.contentType,
            classId: assignments.classId,
            classTitle: classes.title,
          })
          .from(assignments)
          .innerJoin(classes, eq(assignments.classId, classes.id))
          .where(
            and(
              eq(assignments.organizationId, organizationId),
              inArray(assignments.classId, enrolledClassIds),
            ),
          )
          .orderBy(assignments.createdAt)
      : [];

    const unscheduled = pendingAssignments.filter(
      (a) => !scheduledAssignmentIds.has(a.id) && !submittedIds.has(a.id),
    );

    return { slots, unscheduled, schoolWeekDays, timezone: org?.timezone ?? "America/New_York" };
  });

export const getAllPendingAssignments = createServerFn({ method: "GET" })
  .inputValidator((data) =>
    z
      .object({
        profileId: z.string().min(1),
        page: z.number().int().min(0).default(0),
        pageSize: z.number().int().min(1).max(100).default(50),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent", "student"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const enrolledClassRows = await db
      .select({ classId: classEnrollments.classId })
      .from(classEnrollments)
      .where(eq(classEnrollments.profileId, data.profileId));

    const enrolledClassIds = enrolledClassRows.map((r) => r.classId);
    if (enrolledClassIds.length === 0) return { assignments: [], hasMore: false, total: 0 };

    const submittedRows = await db
      .select({ assignmentId: submissions.assignmentId })
      .from(submissions)
      .where(
        and(
          eq(submissions.profileId, data.profileId),
          eq(submissions.organizationId, organizationId),
        ),
      );
    const submittedIds = new Set(submittedRows.map((r) => r.assignmentId));

    const scheduledRows = await db
      .select({ assignmentId: weekPlan.assignmentId })
      .from(weekPlan)
      .where(eq(weekPlan.profileId, data.profileId));
    const scheduledIds = new Set(scheduledRows.map((r) => r.assignmentId));

    const allRows = await db
      .select({
        id: assignments.id,
        title: assignments.title,
        contentType: assignments.contentType,
        classTitle: classes.title,
      })
      .from(assignments)
      .innerJoin(classes, eq(assignments.classId, classes.id))
      .where(
        and(
          eq(assignments.organizationId, organizationId),
          inArray(assignments.classId, enrolledClassIds),
        ),
      )
      .orderBy(classes.title, assignments.createdAt);

    const pending = allRows.filter(
      (a) => !submittedIds.has(a.id) && !scheduledIds.has(a.id),
    );

    const total = pending.length;
    const start = data.page * data.pageSize;
    const page = pending.slice(start, start + data.pageSize);

    return { assignments: page, hasMore: start + data.pageSize < total, total };
  });

export const getRecommendedAssignments = createServerFn({ method: "GET" })
  .inputValidator((data) =>
    z
      .object({
        profileId: z.string().min(1),
        weekStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent", "student"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    // All assignments already submitted by this student
    const submittedRows = await db
      .select({ assignmentId: submissions.assignmentId })
      .from(submissions)
      .where(
        and(
          eq(submissions.profileId, data.profileId),
          eq(submissions.organizationId, organizationId),
        ),
      );
    const submittedIds = new Set(submittedRows.map((r) => r.assignmentId));

    // Assignments scheduled in the viewed week (or any week if no weekStartDate given)
    const weekScheduleConditions = [eq(weekPlan.profileId, data.profileId)];
    if (data.weekStartDate) {
      const [wy, wm, wd] = data.weekStartDate.split("-").map(Number) as [number, number, number];
      const weekEndDate = new Date(Date.UTC(wy, wm - 1, wd + 6)).toISOString().slice(0, 10);
      weekScheduleConditions.push(
        gte(weekPlan.scheduledDate, data.weekStartDate),
        lte(weekPlan.scheduledDate, weekEndDate),
      );
    }
    const scheduledRows = await db
      .select({ assignmentId: weekPlan.assignmentId })
      .from(weekPlan)
      .where(and(...weekScheduleConditions));
    const scheduledIds = new Set(scheduledRows.map((r) => r.assignmentId));

    // Enrolled classes
    const enrolledClassRows = await db
      .select({ classId: classEnrollments.classId })
      .from(classEnrollments)
      .where(eq(classEnrollments.profileId, data.profileId));
    const enrolledClassIds = enrolledClassRows.map((r) => r.classId);

    if (enrolledClassIds.length === 0) {
      return { recommendations: [] };
    }

    // Find all skill trees for enrolled classes belonging to this org
    const treeRows = await db
      .select({ id: skillTrees.id, classId: skillTrees.classId, title: skillTrees.title })
      .from(skillTrees)
      .where(
        and(
          eq(skillTrees.organizationId, organizationId),
          inArray(skillTrees.classId, enrolledClassIds),
        ),
      );

    if (treeRows.length === 0) {
      return { recommendations: [] };
    }

    const treeIds = treeRows.map((t) => t.id);
    const treeById = new Map(treeRows.map((t) => [t.id, t]));

    // Get node progress for in_progress and available nodes across all trees
    const progressRows = await db
      .select({
        nodeId: skillTreeNodeProgress.nodeId,
        treeId: skillTreeNodeProgress.treeId,
        status: skillTreeNodeProgress.status,
      })
      .from(skillTreeNodeProgress)
      .where(
        and(
          eq(skillTreeNodeProgress.profileId, data.profileId),
          inArray(skillTreeNodeProgress.treeId, treeIds),
          inArray(skillTreeNodeProgress.status, ["in_progress", "available"]),
        ),
      );

    if (progressRows.length === 0) {
      return { recommendations: [] };
    }

    // Sort: in_progress before available
    const statusPriority: Record<string, number> = { in_progress: 0, available: 1 };
    const sortedProgress = progressRows.sort(
      (a, b) => (statusPriority[a.status] ?? 2) - (statusPriority[b.status] ?? 2),
    );

    const activeNodeIds = sortedProgress.map((p) => p.nodeId);
    const nodeStatusMap = new Map(sortedProgress.map((p) => [p.nodeId, p.status]));
    const nodeTreeMap = new Map(sortedProgress.map((p) => [p.nodeId, p.treeId]));

    // Fetch ALL assignments linked to active nodes — we'll sort and dedupe in JS
    const nodeAssignmentRows = await db
      .select({
        nodeId: skillTreeNodeAssignments.nodeId,
        assignmentId: skillTreeNodeAssignments.assignmentId,
        orderIndex: skillTreeNodeAssignments.orderIndex,
        assignmentTitle: assignments.title,
        assignmentContentType: assignments.contentType,
        assignmentClassId: assignments.classId,
        classTitle: classes.title,
        nodeTitle: skillTreeNodes.title,
        nodeType: skillTreeNodes.nodeType,
      })
      .from(skillTreeNodeAssignments)
      .innerJoin(assignments, eq(skillTreeNodeAssignments.assignmentId, assignments.id))
      .innerJoin(classes, eq(assignments.classId, classes.id))
      .innerJoin(skillTreeNodes, eq(skillTreeNodeAssignments.nodeId, skillTreeNodes.id))
      .where(inArray(skillTreeNodeAssignments.nodeId, activeNodeIds));

    // Sort: in_progress nodes first, then by assignment orderIndex within each node
    const statusPriorityMap: Record<string, number> = { in_progress: 0, available: 1 };
    nodeAssignmentRows.sort((a, b) => {
      const aPriority = statusPriorityMap[nodeStatusMap.get(a.nodeId) ?? "available"] ?? 1;
      const bPriority = statusPriorityMap[nodeStatusMap.get(b.nodeId) ?? "available"] ?? 1;
      if (aPriority !== bPriority) return aPriority - bPriority;
      return a.orderIndex - b.orderIndex;
    });

    // Build per-class recommendations: collect up to RECS_PER_CLASS unsubmitted
    // assignments across ALL active nodes for the class, deduping by assignmentId.
    // The "current node" shown is the highest-priority (in_progress > available) node.
    const RECS_PER_CLASS = 6;

    const byClass = new Map<string, {
      classTitle: string;
      nodeTitle: string;
      nodeType: string;
      nodeStatus: string;
      assignments: { id: string; title: string; contentType: string; alreadyScheduled: boolean }[];
    }>();

    const seenAssignmentIds = new Set<string>();

    for (const row of nodeAssignmentRows) {
      if (submittedIds.has(row.assignmentId)) continue;
      if (seenAssignmentIds.has(row.assignmentId)) continue;
      seenAssignmentIds.add(row.assignmentId);

      const classId = row.assignmentClassId;
      const nodeStatus = nodeStatusMap.get(row.nodeId) ?? "available";
      const alreadyScheduled = scheduledIds.has(row.assignmentId);

      const existing = byClass.get(classId);
      if (!existing) {
        byClass.set(classId, {
          classTitle: row.classTitle,
          // Use this first row's node as the "current node" — it's the highest priority
          nodeTitle: row.nodeTitle,
          nodeType: row.nodeType,
          nodeStatus,
          assignments: [{ id: row.assignmentId, title: row.assignmentTitle, contentType: row.assignmentContentType, alreadyScheduled }],
        });
      } else if (existing.assignments.length < RECS_PER_CLASS) {
        existing.assignments.push({ id: row.assignmentId, title: row.assignmentTitle, contentType: row.assignmentContentType, alreadyScheduled });
      }
    }

    return { recommendations: Array.from(byClass.values()) };
  });

const saveWeekPlanInput = z.object({
  profileId: z.string().min(1),
  slots: z.array(
    z.object({
      assignmentId: z.string().min(1),
      scheduledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      orderIndex: z.number().int().min(0),
    }),
  ),
  weekStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const saveWeekPlan = createServerFn({ method: "POST" })
  .inputValidator((data) => saveWeekPlanInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    // Fetch org settings first so we know the school week length before snapping dates.
    const orgForSave = await db.query.organizations.findFirst({
      where: eq(organizations.id, organizationId),
    });
    const saveSchoolWeekDays = Math.min(Math.max(orgForSave?.schoolWeekDays ?? 5, 4), 7);

    // Snap weekStartDate to the correct week-start day (Mon for <7 days, Sun for 7).
    // Guards against client timezone bugs producing the wrong date.
    const weekStartDate = snapToWeekStart(data.weekStartDate, saveSchoolWeekDays);

    function addDaysToIso(isoDate: string, days: number): string {
      const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
      const dt = new Date(Date.UTC(y, m - 1, d + days));
      return dt.toISOString().slice(0, 10);
    }

    // Valid dates for this week: weekStartDate + 0..schoolWeekDays-1
    const validDates = new Set(
      Array.from({ length: saveSchoolWeekDays }, (_, i) => addDaysToIso(weekStartDate, i)),
    );

    // Delete window: always full Sun–Sat (7 days) to clear any AI-placed slots
    // that landed outside the strict school week range.
    const windowEndDate = addDaysToIso(weekStartDate, 6);
    await db
      .delete(weekPlan)
      .where(
        and(
          eq(weekPlan.organizationId, organizationId),
          eq(weekPlan.profileId, data.profileId),
          gte(weekPlan.scheduledDate, weekStartDate),
          lte(weekPlan.scheduledDate, windowEndDate),
        ),
      );

    // Validate all incoming assignment IDs actually exist in this org
    const slotAssignmentIds = [...new Set(data.slots.map((s) => s.assignmentId))];
    const validAssignments = slotAssignmentIds.length > 0
      ? await db
          .select({ id: assignments.id })
          .from(assignments)
          .where(
            and(
              eq(assignments.organizationId, organizationId),
              inArray(assignments.id, slotAssignmentIds),
            ),
          )
      : [];
    const validAssignmentIds = new Set(validAssignments.map((a) => a.id));

    // Deduplicate by assignmentId, drop invalid dates and unknown assignments
    const dedupedSlots = Array.from(
      data.slots
        .filter((s) => validDates.has(s.scheduledDate) && validAssignmentIds.has(s.assignmentId))
        .reduce((map, slot) => {
          map.set(slot.assignmentId, slot);
          return map;
        }, new Map<string, (typeof data.slots)[number]>())
        .values(),
    );

    if (dedupedSlots.length > 0) {
      try {
        // Keep INSERT statements under SQLite/D1 bind-parameter limits.
        // 7 columns/row -> chunking at 10 rows = 70 params max/statement.
        const insertChunkSize = 10;
        for (let i = 0; i < dedupedSlots.length; i += insertChunkSize) {
          const chunk = dedupedSlots.slice(i, i + insertChunkSize);
          await db.insert(weekPlan).values(
            chunk.map((slot) => ({
              id: crypto.randomUUID(),
              organizationId,
              profileId: data.profileId,
              assignmentId: slot.assignmentId,
              scheduledDate: slot.scheduledDate,
              orderIndex: slot.orderIndex,
              createdAt: new Date().toISOString(),
            })),
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `INSERT_FAILED: ${msg} | slots=${JSON.stringify(
            dedupedSlots.map((s) => ({ a: s.assignmentId, d: s.scheduledDate })),
          )} | validDates=${JSON.stringify([...validDates])} | validAssignments=${validAssignments.length}/${slotAssignmentIds.length}`,
        );
      }
    }

    return { saved: dedupedSlots.length };
  });

const generateWeekPlanInput = z.object({
  profileId: z.string().min(1),
  weekStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const generateWeekPlan = createServerFn({ method: "POST" })
  .inputValidator((data) => generateWeekPlanInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    // weekStartDate will be snapped after we know schoolWeekDays (fetched below).

    const profile = await db.query.profiles.findFirst({
      where: and(
        eq(profiles.id, data.profileId),
        eq(profiles.organizationId, organizationId),
      ),
    });

    if (!profile) {
      throw new Error("PROFILE_NOT_FOUND");
    }

    const enrolledClassRows = await db
      .select({ classId: classEnrollments.classId })
      .from(classEnrollments)
      .where(eq(classEnrollments.profileId, data.profileId));

    const enrolledClassIds = enrolledClassRows.map((r) => r.classId);

    if (enrolledClassIds.length === 0) {
      return { slots: [] };
    }

    const submittedRows = await db
      .select({ assignmentId: submissions.assignmentId })
      .from(submissions)
      .where(
        and(
          eq(submissions.profileId, data.profileId),
          eq(submissions.organizationId, organizationId),
        ),
      );

    const submittedIds = new Set(submittedRows.map((r) => r.assignmentId));

    // Fetch org settings, skill tree progress, and already-scheduled items in parallel
    const [org, skillProgressRows, alreadyScheduledRows] = await Promise.all([
      db.query.organizations.findFirst({
        where: eq(organizations.id, organizationId),
      }),
      db
        .select({
          nodeId: skillTreeNodeProgress.nodeId,
          treeId: skillTreeNodeProgress.treeId,
          status: skillTreeNodeProgress.status,
          nodeTitle: skillTreeNodes.title,
          nodeType: skillTreeNodes.nodeType,
          subject: skillTreeNodes.subject,
          classId: skillTrees.classId,
          classTitle: classes.title,
        })
        .from(skillTreeNodeProgress)
        .innerJoin(skillTreeNodes, eq(skillTreeNodeProgress.nodeId, skillTreeNodes.id))
        .innerJoin(skillTrees, eq(skillTreeNodeProgress.treeId, skillTrees.id))
        .leftJoin(classes, eq(skillTrees.classId, classes.id))
        .where(
          and(
            eq(skillTreeNodeProgress.profileId, data.profileId),
            inArray(skillTreeNodeProgress.status, ["available", "in_progress"]),
          ),
        )
        .orderBy(skillTreeNodeProgress.status),
      // Assignments already on the calendar for this week
      db
        .select({ assignmentId: weekPlan.assignmentId })
        .from(weekPlan)
        .where(eq(weekPlan.profileId, data.profileId)),
    ]);

    const genSchoolWeekDays = Math.min(Math.max(org?.schoolWeekDays ?? 5, 4), 7);
    const weekStartDate = snapToWeekStart(data.weekStartDate, genSchoolWeekDays);

    // Build the set of IDs to exclude: submitted + already on the calendar
    const alreadyScheduledIds = new Set(alreadyScheduledRows.map((r) => r.assignmentId));
    const excludedIds = new Set([...submittedIds, ...alreadyScheduledIds]);

    // Build skill context for the AI prompt
    const skillContext: PlannerSkillContext[] = skillProgressRows
      .filter((r) => r.classTitle !== null)
      .map((r) => ({
        classTitle: r.classTitle!,
        subject: r.subject,
        nodeTitle: r.nodeTitle,
        nodeStatus: r.status,
        nodeType: r.nodeType,
      }));

    // Pull recommended assignments from active skill tree nodes (same logic as getRecommendedAssignments)
    const activeNodeIds = skillProgressRows.map((r) => r.nodeId);
    const nodeInfoMap = new Map(
      skillProgressRows.map((r) => [
        r.nodeId,
        { nodeTitle: r.nodeTitle, nodeType: r.nodeType, nodeStatus: r.status },
      ]),
    );
    let unsubmitted: PlannerAssignment[] = [];

    if (activeNodeIds.length > 0) {
      const nodeStatusMap = new Map(skillProgressRows.map((p) => [p.nodeId, p.status]));
      const nodeAssignmentRows = await db
        .select({
          nodeId: skillTreeNodeAssignments.nodeId,
          assignmentId: skillTreeNodeAssignments.assignmentId,
          orderIndex: skillTreeNodeAssignments.orderIndex,
          assignmentTitle: assignments.title,
          assignmentContentType: assignments.contentType,
          classTitle: classes.title,
        })
        .from(skillTreeNodeAssignments)
        .innerJoin(assignments, eq(skillTreeNodeAssignments.assignmentId, assignments.id))
        .innerJoin(classes, eq(assignments.classId, classes.id))
        .where(inArray(skillTreeNodeAssignments.nodeId, activeNodeIds));

      // Sort: in_progress nodes first, then by assignment orderIndex within each node
      const statusPriorityMap: Record<string, number> = { in_progress: 0, available: 1 };
      nodeAssignmentRows.sort((a, b) => {
        const aPriority = statusPriorityMap[nodeStatusMap.get(a.nodeId) ?? "available"] ?? 1;
        const bPriority = statusPriorityMap[nodeStatusMap.get(b.nodeId) ?? "available"] ?? 1;
        if (aPriority !== bPriority) return aPriority - bPriority;
        return a.orderIndex - b.orderIndex;
      });

      const seenIds = new Set<string>();
      for (const row of nodeAssignmentRows) {
        if (excludedIds.has(row.assignmentId)) continue;
        if (seenIds.has(row.assignmentId)) continue;
        seenIds.add(row.assignmentId);
        const nodeInfo = nodeInfoMap.get(row.nodeId);
        unsubmitted.push({
          id: row.assignmentId,
          title: row.assignmentTitle,
          contentType: row.assignmentContentType,
          classTitle: row.classTitle,
          nodeId: row.nodeId,
          nodeTitle: nodeInfo?.nodeTitle ?? "",
          nodeType: nodeInfo?.nodeType ?? "lesson",
          nodeStatus: nodeInfo?.nodeStatus ?? "available",
          nodeOrderIndex: row.orderIndex,
        });
      }
    }

    const slots = await aiGenerateWeekPlan({
      assignments: unsubmitted,
      gradeLevel: profile.gradeLevel,
      weekStartDate,
      schoolWeekDays: genSchoolWeekDays,
      skillContext,
    });

    return { slots };
  });

// ── Lesson Planner Chat ───────────────────────────────────────────────────────

const lessonPlannerChatInput = z.object({
  messages: z.array(
    z.object({
      role: z.enum(["user", "assistant"]),
      content: z.string(),
    }),
  ).min(1).max(40),
  studentName: z.string(),
  grade: z.string().nullable(),
  classList: z.array(z.string()),
});

function buildFallbackSuggestionBlock(topic: string, grade: string | null) {
  const gradeSuffix = grade ? ` (Grade ${grade})` : "";
  const cleanedTopic = topic.trim() || "the selected topic";

  return [
    "",
    "ASSIGNMENT_SUGGESTION: title=\"Background Reading: " + cleanedTopic + "\" type=text description=\"Read a short passage about " + cleanedTopic + gradeSuffix + " and list 5 key facts in your own words.\"",
    "ASSIGNMENT_SUGGESTION: title=\"Video Lesson: " + cleanedTopic + "\" type=video description=\"Watch one age-appropriate lesson video on " + cleanedTopic + " and write 3 things you learned.\"",
    "ASSIGNMENT_SUGGESTION: title=\"Check for Understanding: " + cleanedTopic + "\" type=quiz description=\"Complete a short 5-question quiz covering the main vocabulary and ideas from the lesson.\"",
  ].join("\n");
}

function extractTopicFromUserMessage(userMessage: string) {
  const cleaned = userMessage
    .replace(/\b(i need|i want|please|can you|could you|help me|create|make|give me)\b/gi, "")
    .replace(/\b(assignments?|lessons?|ideas?|for|about|on)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned || "this topic";
}

function ensureSuggestionTags(content: string, userMessage: string, grade: string | null) {
  if (/ASSIGNMENT_SUGGESTION:/i.test(content)) {
    return content;
  }

  const assignmentIntent = /\b(assignments?|lesson ideas?|topic ideas?|curriculum|activities?)\b/i.test(
    userMessage,
  );

  if (!assignmentIntent) {
    return content;
  }

  const topic = extractTopicFromUserMessage(userMessage);
  return `${content.trim()}\n${buildFallbackSuggestionBlock(topic, grade)}`.trim();
}

export const lessonPlannerChat = createServerFn({ method: "POST" })
  .inputValidator((data) => lessonPlannerChatInput.parse(data))
  .handler(async ({ data }) => {
    await requireActiveRole(["admin", "parent"]);

    const classListText = data.classList.length > 0
      ? data.classList.join(", ")
      : "no classes set up yet";

    const systemPrompt = [
      "You are a homeschool curriculum assistant.",
      `The parent teaches ${data.studentName}${data.grade ? `, grade ${data.grade}` : ""}.`,
      `Current classes: ${classListText}.`,
      "Help them create lesson plans, suggest topics, generate assignment sequences.",
      "If user asks for assignments or topic ideas, include 3 to 5 actionable assignment suggestions.",
      "Every suggestion MUST be on its own line using exactly this format:",
      "ASSIGNMENT_SUGGESTION: title=\"[title]\" type=[text|video|quiz|essay_questions|report] description=\"[description]\"",
      "Do not skip the ASSIGNMENT_SUGGESTION lines when assignment ideas are requested.",
      "Keep responses concise and practical.",
    ].join(" ");

    const result = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages: [
        { role: "system", content: systemPrompt },
        ...data.messages,
      ],
      max_tokens: 800,
    });

    const rawResponseText =
      typeof result === "string"
        ? result
        : typeof (result as Record<string, unknown>).response === "string"
          ? (result as Record<string, unknown>).response as string
          : JSON.stringify(result);

    const lastUserMessage = [...data.messages]
      .reverse()
      .find((message) => message.role === "user")?.content ?? "";

    const responseText = ensureSuggestionTags(rawResponseText, lastUserMessage, data.grade);

    return { content: responseText };
  });

// ─── SKILL TREE FUNCTIONS ───

export const getSkillTreesForOrg = createServerFn({ method: "GET" }).handler(async () => {
  const session = await requireActiveRole(["admin", "parent"]);
  const db = getDb();

  const organizationId = await resolveActiveOrganizationId(
    session.user.id,
    session.session.activeOrganizationId,
  );

  const treeRows = await db.query.skillTrees.findMany({
    where: eq(skillTrees.organizationId, organizationId),
    orderBy: [desc(skillTrees.createdAt)],
  });

  if (treeRows.length === 0) {
    return { trees: [] };
  }

  const treeIds = treeRows.map((t) => t.id);

  const [nodeCounts, classRows] = await Promise.all([
    db
      .select({ treeId: skillTreeNodes.treeId, nodeCount: count() })
      .from(skillTreeNodes)
      .where(inArray(skillTreeNodes.treeId, treeIds))
      .groupBy(skillTreeNodes.treeId),
    db.query.classes.findMany({
      where: inArray(
        classes.id,
        treeRows.map((t) => t.classId).filter((id): id is string => id !== null && id !== undefined),
      ),
    }),
  ]);

  const nodeCountMap = new Map(nodeCounts.map((r) => [r.treeId, r.nodeCount]));
  const classMap = new Map(classRows.map((c) => [c.id, c.title]));

  const trees = treeRows.map((tree) => ({
    ...tree,
    nodeCount: nodeCountMap.get(tree.id) ?? 0,
    classTitle: tree.classId ? (classMap.get(tree.classId) ?? null) : null,
  }));

  return { trees };
});

const getSkillTreeDataInput = z.object({
  treeId: z.string(),
  profileId: z.string().optional(),
});

export const getSkillTreeData = createServerFn({ method: "GET" })
  .inputValidator((data) => getSkillTreeDataInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent", "student"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const tree = await db.query.skillTrees.findFirst({
      where: and(eq(skillTrees.id, data.treeId), eq(skillTrees.organizationId, organizationId)),
    });

    if (!tree) {
      throw new Error("NOT_FOUND");
    }

    const [nodes, edges, progressRows] = await Promise.all([
      db.query.skillTreeNodes.findMany({
        where: eq(skillTreeNodes.treeId, data.treeId),
      }),
      db.query.skillTreeEdges.findMany({
        where: eq(skillTreeEdges.treeId, data.treeId),
      }),
      data.profileId
        ? db.query.skillTreeNodeProgress.findMany({
            where: and(
              eq(skillTreeNodeProgress.treeId, data.treeId),
              eq(skillTreeNodeProgress.profileId, data.profileId),
            ),
          })
        : Promise.resolve([]),
    ]);

    const nodeIds = nodes.map((n) => n.id);

    const junctionRows: (typeof skillTreeNodeAssignments.$inferSelect)[] = [];
    for (const chunk of chunkIds(nodeIds, 50)) {
      const rows = await db.query.skillTreeNodeAssignments.findMany({
        where: inArray(skillTreeNodeAssignments.nodeId, chunk),
        orderBy: [desc(skillTreeNodeAssignments.orderIndex)],
      });
      junctionRows.push(...rows);
    }

    const assignmentIds = [...new Set(junctionRows.map((j) => j.assignmentId))];

    const assignmentRows: (typeof assignments.$inferSelect)[] = [];
    for (const chunk of chunkIds(assignmentIds, 50)) {
      const rows = await db.query.assignments.findMany({
        where: inArray(assignments.id, chunk),
      });
      assignmentRows.push(...rows);
    }

    const assignmentMap = new Map(assignmentRows.map((a) => [a.id, a]));

    const nodeAssignmentMap = new Map<string, typeof assignmentRows>();
    for (const junction of junctionRows) {
      const existing = nodeAssignmentMap.get(junction.nodeId) ?? [];
      const assignment = assignmentMap.get(junction.assignmentId);
      if (assignment) existing.push(assignment);
      nodeAssignmentMap.set(junction.nodeId, existing);
    }

    const nodeAssignments = nodes.map((node) => ({
      nodeId: node.id,
      assignments: nodeAssignmentMap.get(node.id) ?? [],
    }));

    const earnedXp = progressRows.reduce((acc, p) => acc + p.xpEarned, 0);
    const totalXp = nodes.reduce((acc, n) => acc + n.xpReward, 0);

    return {
      tree,
      nodes,
      edges,
      nodeAssignments,
      nodeProgress: progressRows,
      earnedXp,
      totalXp,
    };
  });

const createSkillTreeInput = z.object({
  classId: z.string().optional(),
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  gradeLevel: z.string().optional(),
  subject: z.string().optional(),
  schoolYear: z.string().optional(),
});

export const createSkillTree = createServerFn({ method: "POST" })
  .inputValidator((data) => createSkillTreeInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const treeId = crypto.randomUUID();
    const rootNodeId = crypto.randomUUID();
    const now = new Date().toISOString();

    await db.insert(skillTrees).values({
      id: treeId,
      organizationId,
      classId: data.classId ?? null,
      title: data.title.trim(),
      description: data.description?.trim() ?? null,
      gradeLevel: data.gradeLevel ?? null,
      subject: data.subject ?? null,
      schoolYear: data.schoolYear ?? null,
      createdByUserId: session.user.id,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(skillTreeNodes).values({
      id: rootNodeId,
      treeId,
      organizationId,
      title: "Start Here",
      icon: "🌟",
      colorRamp: "teal",
      nodeType: "milestone",
      positionX: 500,
      positionY: 60,
      xpReward: 0,
      radius: 32,
      createdAt: now,
      updatedAt: now,
    });

    return { treeId, rootNodeId };
  });

const upsertSkillTreeNodeInput = z.object({
  treeId: z.string(),
  nodeId: z.string().optional(),
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  subject: z.string().optional(),
  icon: z.string().optional(),
  colorRamp: z.string().optional(),
  nodeType: z.enum(["lesson", "milestone", "boss", "branch", "elective"]).optional(),
  xpReward: z.number().int().optional(),
  positionX: z.number().int().optional(),
  positionY: z.number().int().optional(),
  radius: z.number().int().optional(),
  isRequired: z.boolean().optional(),
});

export const upsertSkillTreeNode = createServerFn({ method: "POST" })
  .inputValidator((data) => upsertSkillTreeNodeInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    // Verify tree belongs to org
    const tree = await db.query.skillTrees.findFirst({
      where: and(eq(skillTrees.id, data.treeId), eq(skillTrees.organizationId, organizationId)),
    });
    if (!tree) throw new Error("NOT_FOUND");

    const now = new Date().toISOString();

    if (data.nodeId) {
      // Update existing node — verify it belongs to this tree
      const existing = await db.query.skillTreeNodes.findFirst({
        where: and(
          eq(skillTreeNodes.id, data.nodeId),
          eq(skillTreeNodes.treeId, data.treeId),
        ),
      });
      if (!existing) throw new Error("NOT_FOUND");

      await db
        .update(skillTreeNodes)
        .set({
          title: data.title.trim(),
          description: data.description?.trim() ?? existing.description,
          subject: data.subject ?? existing.subject,
          icon: data.icon ?? existing.icon,
          colorRamp: data.colorRamp ?? existing.colorRamp,
          nodeType: data.nodeType ?? existing.nodeType,
          xpReward: data.xpReward ?? existing.xpReward,
          positionX: data.positionX ?? existing.positionX,
          positionY: data.positionY ?? existing.positionY,
          radius: data.radius ?? existing.radius,
          isRequired: data.isRequired ?? existing.isRequired,
          updatedAt: now,
        })
        .where(eq(skillTreeNodes.id, data.nodeId));

      const updated = await db.query.skillTreeNodes.findFirst({
        where: eq(skillTreeNodes.id, data.nodeId),
      });
      return updated!;
    }

    // Insert new node
    const nodeId = crypto.randomUUID();
    await db.insert(skillTreeNodes).values({
      id: nodeId,
      treeId: data.treeId,
      organizationId,
      title: data.title.trim(),
      description: data.description?.trim() ?? null,
      subject: data.subject ?? null,
      icon: data.icon ?? null,
      colorRamp: data.colorRamp ?? "blue",
      nodeType: data.nodeType ?? "lesson",
      xpReward: data.xpReward ?? 100,
      positionX: data.positionX ?? 0,
      positionY: data.positionY ?? 0,
      radius: data.radius ?? 28,
      isRequired: data.isRequired ?? false,
      createdAt: now,
      updatedAt: now,
    });

    const inserted = await db.query.skillTreeNodes.findFirst({
      where: eq(skillTreeNodes.id, nodeId),
    });
    return inserted!;
  });

const deleteSkillTreeNodeInput = z.object({
  nodeId: z.string(),
  parentPin: z.string(),
});

export const deleteSkillTreeNode = createServerFn({ method: "POST" })
  .inputValidator((data) => deleteSkillTreeNodeInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    await verifyParentPinForSession(session.user.id, data.parentPin);

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    // Verify node belongs to org
    const node = await db.query.skillTreeNodes.findFirst({
      where: and(
        eq(skillTreeNodes.id, data.nodeId),
        eq(skillTreeNodes.organizationId, organizationId),
      ),
    });
    if (!node) throw new Error("NOT_FOUND");

    await Promise.all([
      db
        .delete(skillTreeEdges)
        .where(
          or(
            eq(skillTreeEdges.sourceNodeId, data.nodeId),
            eq(skillTreeEdges.targetNodeId, data.nodeId),
          ),
        ),
      db
        .delete(skillTreeNodeAssignments)
        .where(eq(skillTreeNodeAssignments.nodeId, data.nodeId)),
      db
        .delete(skillTreeNodeProgress)
        .where(eq(skillTreeNodeProgress.nodeId, data.nodeId)),
    ]);

    await db.delete(skillTreeNodes).where(eq(skillTreeNodes.id, data.nodeId));

    return { success: true };
  });

const upsertSkillTreeEdgeInput = z.object({
  treeId: z.string(),
  sourceNodeId: z.string(),
  targetNodeId: z.string(),
  edgeType: z.enum(["required", "optional", "bonus", "fork"]).optional(),
});

export const upsertSkillTreeEdge = createServerFn({ method: "POST" })
  .inputValidator((data) => upsertSkillTreeEdgeInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const tree = await db.query.skillTrees.findFirst({
      where: and(eq(skillTrees.id, data.treeId), eq(skillTrees.organizationId, organizationId)),
    });
    if (!tree) throw new Error("NOT_FOUND");

    // Verify both nodes belong to this tree
    const [sourceNode, targetNode] = await Promise.all([
      db.query.skillTreeNodes.findFirst({
        where: and(
          eq(skillTreeNodes.id, data.sourceNodeId),
          eq(skillTreeNodes.treeId, data.treeId),
        ),
      }),
      db.query.skillTreeNodes.findFirst({
        where: and(
          eq(skillTreeNodes.id, data.targetNodeId),
          eq(skillTreeNodes.treeId, data.treeId),
        ),
      }),
    ]);
    if (!sourceNode || !targetNode) throw new Error("NOT_FOUND");

    // Check for existing edge
    const existing = await db.query.skillTreeEdges.findFirst({
      where: and(
        eq(skillTreeEdges.sourceNodeId, data.sourceNodeId),
        eq(skillTreeEdges.targetNodeId, data.targetNodeId),
      ),
    });

    if (existing) {
      if (data.edgeType && data.edgeType !== existing.edgeType) {
        await db
          .update(skillTreeEdges)
          .set({ edgeType: data.edgeType })
          .where(eq(skillTreeEdges.id, existing.id));
      }
      const updated = await db.query.skillTreeEdges.findFirst({
        where: eq(skillTreeEdges.id, existing.id),
      });
      return updated!;
    }

    const edgeId = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.insert(skillTreeEdges).values({
      id: edgeId,
      treeId: data.treeId,
      sourceNodeId: data.sourceNodeId,
      targetNodeId: data.targetNodeId,
      edgeType: data.edgeType ?? "required",
      createdAt: now,
    });

    const inserted = await db.query.skillTreeEdges.findFirst({
      where: eq(skillTreeEdges.id, edgeId),
    });
    return inserted!;
  });

const deleteSkillTreeEdgeInput = z.object({
  edgeId: z.string(),
});

export const deleteSkillTreeEdge = createServerFn({ method: "POST" })
  .inputValidator((data) => deleteSkillTreeEdgeInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const edge = await db.query.skillTreeEdges.findFirst({
      where: eq(skillTreeEdges.id, data.edgeId),
    });
    if (!edge) throw new Error("NOT_FOUND");

    const tree = await db.query.skillTrees.findFirst({
      where: and(eq(skillTrees.id, edge.treeId), eq(skillTrees.organizationId, organizationId)),
    });
    if (!tree) throw new Error("FORBIDDEN");

    await db.delete(skillTreeEdges).where(eq(skillTreeEdges.id, data.edgeId));

    return { success: true };
  });

const linkAssignmentToNodeInput = z.object({
  nodeId: z.string(),
  assignmentId: z.string(),
  orderIndex: z.number().int().optional(),
});

export const linkAssignmentToNode = createServerFn({ method: "POST" })
  .inputValidator((data) => linkAssignmentToNodeInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const [node, assignment] = await Promise.all([
      db.query.skillTreeNodes.findFirst({
        where: and(
          eq(skillTreeNodes.id, data.nodeId),
          eq(skillTreeNodes.organizationId, organizationId),
        ),
      }),
      db.query.assignments.findFirst({
        where: and(
          eq(assignments.id, data.assignmentId),
          eq(assignments.organizationId, organizationId),
        ),
      }),
    ]);
    if (!node || !assignment) throw new Error("NOT_FOUND");

    const junctionId = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.insert(skillTreeNodeAssignments).values({
      id: junctionId,
      nodeId: data.nodeId,
      assignmentId: data.assignmentId,
      orderIndex: data.orderIndex ?? 0,
      createdAt: now,
    });

    const inserted = await db.query.skillTreeNodeAssignments.findFirst({
      where: eq(skillTreeNodeAssignments.id, junctionId),
    });
    return inserted!;
  });

const unlinkAssignmentFromNodeInput = z.object({
  nodeId: z.string(),
  assignmentId: z.string(),
});

export const unlinkAssignmentFromNode = createServerFn({ method: "POST" })
  .inputValidator((data) => unlinkAssignmentFromNodeInput.parse(data))
  .handler(async ({ data }) => {
    await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    await db
      .delete(skillTreeNodeAssignments)
      .where(
        and(
          eq(skillTreeNodeAssignments.nodeId, data.nodeId),
          eq(skillTreeNodeAssignments.assignmentId, data.assignmentId),
        ),
      );

    return { success: true };
  });

const updateNodePositionsInput = z.object({
  updates: z.array(
    z.object({
      nodeId: z.string(),
      positionX: z.number().int(),
      positionY: z.number().int(),
    }),
  ),
});

export const updateNodePositions = createServerFn({ method: "POST" })
  .inputValidator((data) => updateNodePositionsInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    if (data.updates.length === 0) {
      return { updated: 0 };
    }

    const nodeIds = data.updates.map((u) => u.nodeId);

    // Verify all nodes belong to org
    const nodeRows = await db.query.skillTreeNodes.findMany({
      where: and(
        inArray(skillTreeNodes.id, nodeIds),
        eq(skillTreeNodes.organizationId, organizationId),
      ),
    });
    if (nodeRows.length !== nodeIds.length) throw new Error("FORBIDDEN");

    const now = new Date().toISOString();
    await Promise.all(
      data.updates.map((update) =>
        db
          .update(skillTreeNodes)
          .set({ positionX: update.positionX, positionY: update.positionY, updatedAt: now })
          .where(eq(skillTreeNodes.id, update.nodeId)),
      ),
    );

    return { updated: data.updates.length };
  });

const PROGRESS_GATING_EDGE_TYPES = new Set(["required", "fork"]);
const SPECIALIZATION_COLOR_RAMPS = ["purple", "amber", "coral", "green"] as const;
const CORE_COLOR_RAMPS = ["blue", "teal"] as const;

function isProgressGatingEdgeType(edgeType: string | null | undefined): edgeType is "required" | "fork" {
  return typeof edgeType === "string" && PROGRESS_GATING_EDGE_TYPES.has(edgeType);
}

function isSpecializationLaneNode(input: {
  cluster?: string | null;
  nodeType?: string | null;
  colorRamp?: string | null;
}) {
  return (
    input.cluster === "specialization" ||
    input.nodeType === "elective" ||
    (typeof input.colorRamp === "string" &&
      SPECIALIZATION_COLOR_RAMPS.includes(
        input.colorRamp as (typeof SPECIALIZATION_COLOR_RAMPS)[number],
      ))
  );
}

function classifySkillTreeEdge(input: {
  prereqIndex: number;
  sourceNodeId: string;
  targetNode: {
    cluster?: string | null;
    nodeType?: string | null;
    colorRamp?: string | null;
  };
  forkSourceNodeIds?: Set<string>;
  existingEdgeType?: SkillTreeEdgeRow["edgeType"] | null;
}): SkillTreeEdgeRow["edgeType"] {
  if (input.prereqIndex > 0) return "bonus";
  if (input.existingEdgeType && input.existingEdgeType !== "bonus") {
    return input.existingEdgeType;
  }
  if (isSpecializationLaneNode(input.targetNode)) return "optional";
  if (input.forkSourceNodeIds?.has(input.sourceNodeId)) return "fork";
  return "required";
}

function deriveForkSourceIds<T extends {
  id: string;
  prerequisites: string[];
  cluster?: string | null;
  nodeType?: string | null;
  colorRamp?: string | null;
}>(nodes: T[]) {
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const coreChildCountBySourceId = new Map<string, number>();

  for (const node of nodes) {
    if (isSpecializationLaneNode(node)) continue;
    for (const sourceNodeId of node.prerequisites) {
      if (!nodeById.has(sourceNodeId)) continue;
      coreChildCountBySourceId.set(
        sourceNodeId,
        (coreChildCountBySourceId.get(sourceNodeId) ?? 0) + 1,
      );
    }
  }

  return new Set(
    Array.from(coreChildCountBySourceId.entries())
      .filter(([, count]) => count >= 2)
      .map(([sourceNodeId]) => sourceNodeId),
  );
}

function parseSkillTreeLayoutMetadata(raw: string | null): {
  description?: string;
  cluster?: "core" | "specialization";
  depth?: number;
  prerequisiteGroups?: string[][];
} {
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const record = parsed as Record<string, unknown>;
    const prerequisiteGroups = Array.isArray(record.prerequisiteGroups)
      ? (record.prerequisiteGroups as unknown[])
          .map((group) =>
            Array.isArray(group)
              ? group.filter((value): value is string => typeof value === "string" && value.length > 0)
              : [],
          )
          .filter((group) => group.length > 0)
      : undefined;
    return {
      description: typeof record.description === "string" ? record.description : undefined,
      cluster: record.cluster === "specialization" ? "specialization" : record.cluster === "core" ? "core" : undefined,
      depth:
        typeof record.depth === "number" && Number.isFinite(record.depth)
          ? Math.max(0, Math.round(record.depth))
          : undefined,
      prerequisiteGroups,
    };
  } catch {
    return {};
  }
}

function orderTreeNodesForTraversal(
  nodeRows: SkillTreeNodeRow[],
  edgeRows: SkillTreeEdgeRow[],
): SkillTreeNodeRow[] {
  const nodeById = new Map(nodeRows.map((node) => [node.id, node]));
  const childMap = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  const sortNodeRows = (a: SkillTreeNodeRow, b: SkillTreeNodeRow) =>
    a.positionY - b.positionY || a.positionX - b.positionX || a.title.localeCompare(b.title);

  for (const node of nodeRows) {
    childMap.set(node.id, []);
    inDegree.set(node.id, 0);
  }

  for (const edge of edgeRows) {
    if (!isProgressGatingEdgeType(edge.edgeType)) continue;
    if (!nodeById.has(edge.sourceNodeId) || !nodeById.has(edge.targetNodeId)) continue;
    childMap.get(edge.sourceNodeId)?.push(edge.targetNodeId);
    inDegree.set(edge.targetNodeId, (inDegree.get(edge.targetNodeId) ?? 0) + 1);
  }

  const queue = nodeRows
    .filter((node) => (inDegree.get(node.id) ?? 0) === 0)
    .sort(sortNodeRows);
  const ordered: SkillTreeNodeRow[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    ordered.push(current);

    const children = (childMap.get(current.id) ?? [])
      .map((childId) => nodeById.get(childId))
      .filter((node): node is SkillTreeNodeRow => Boolean(node))
      .sort(sortNodeRows);

    for (const child of children) {
      const nextDegree = (inDegree.get(child.id) ?? 0) - 1;
      inDegree.set(child.id, nextDegree);
      if (nextDegree === 0) {
        queue.push(child);
        queue.sort(sortNodeRows);
      }
    }
  }

  const remaining = nodeRows
    .filter((node) => !ordered.some((orderedNode) => orderedNode.id === node.id))
    .sort(sortNodeRows);

  return [...ordered, ...remaining];
}

function computeTreeDepthByNodeId(
  nodeRows: SkillTreeNodeRow[],
  edgeRows: SkillTreeEdgeRow[],
): Map<string, number> {
  const ordered = orderTreeNodesForTraversal(nodeRows, edgeRows);
  const depthByNodeId = new Map<string, number>();
  const parentMap = new Map<string, string[]>();

  for (const node of nodeRows) {
    parentMap.set(node.id, []);
  }

  for (const edge of edgeRows) {
    if (!isProgressGatingEdgeType(edge.edgeType)) continue;
    const parents = parentMap.get(edge.targetNodeId);
    if (parents) parents.push(edge.sourceNodeId);
  }

  for (const node of ordered) {
    const parents = parentMap.get(node.id) ?? [];
    const depth =
      parents.length === 0
        ? 0
        : parents.reduce(
            (maxDepth, parentId) => Math.max(maxDepth, (depthByNodeId.get(parentId) ?? 0) + 1),
            0,
          );
    depthByNodeId.set(node.id, depth);
  }

  return depthByNodeId;
}

function buildNodeLayoutMetadata(input: {
  description: string | null;
  cluster: "core" | "specialization";
  depth: number;
  prerequisiteGroups?: string[][];
}) {
  return JSON.stringify({
    description: input.description ?? "",
    cluster: input.cluster,
    depth: input.depth,
    prerequisiteGroups: input.prerequisiteGroups ?? [],
  });
}

function normalizePrerequisiteGroups(
  groups: string[][],
  allowedSourceIds?: Set<string>,
): string[][] {
  const seen = new Set<string>();
  const normalized: string[][] = [];

  for (const rawGroup of groups) {
    const group = Array.from(
      new Set(
        rawGroup.filter(
          (sourceId): sourceId is string =>
            typeof sourceId === "string" &&
            sourceId.length > 0 &&
            (!allowedSourceIds || allowedSourceIds.has(sourceId)),
        ),
      ),
    ).sort();

    if (group.length === 0) continue;

    const key = group.join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(group);
  }

  return normalized;
}

function deriveStoredPrerequisiteGroups(params: {
  node: Pick<SkillTreeNodeRow, "aiGeneratedDescription">;
  incomingEdges: SkillTreeEdgeRow[];
}) {
  const metadata = parseSkillTreeLayoutMetadata(params.node.aiGeneratedDescription);
  const incomingSourceIds = new Set(params.incomingEdges.map((edge) => edge.sourceNodeId));

  if (metadata.prerequisiteGroups?.length) {
    const explicitGroups = normalizePrerequisiteGroups(
      metadata.prerequisiteGroups,
      incomingSourceIds,
    );
    if (explicitGroups.length > 0) return explicitGroups;
  }

  const forkGroups = normalizePrerequisiteGroups(
    params.incomingEdges
      .filter((edge) => edge.edgeType === "fork")
      .map((edge) => [edge.sourceNodeId]),
    incomingSourceIds,
  );

  const gatingGroup = params.incomingEdges
    .filter((edge) => isProgressGatingEdgeType(edge.edgeType))
    .map((edge) => edge.sourceNodeId);

  const unlockOnlyGroup = params.incomingEdges
    .filter((edge) => edge.edgeType !== "bonus")
    .map((edge) => edge.sourceNodeId);

  const fallbackGroups = normalizePrerequisiteGroups(
    forkGroups.length > 0
      ? forkGroups
      : gatingGroup.length > 0
      ? [gatingGroup]
      : unlockOnlyGroup.length > 0
        ? [unlockOnlyGroup]
        : [],
    incomingSourceIds,
  );

  return fallbackGroups;
}

function arePrerequisiteGroupsMet(groups: string[][], completedNodeIds: Set<string>) {
  if (groups.length === 0) return true;
  return groups.some((group) => group.every((sourceId) => completedNodeIds.has(sourceId)));
}

function assignRewovenColorRamps(
  nodes: Array<{
    tempId: string;
    cluster: "core" | "specialization";
    nodeType: string;
    depth: number;
    prerequisites: string[];
  }>,
): Map<string, string> {
  const byId = new Map(nodes.map((node) => [node.tempId, node]));
  const colorById = new Map<string, string>();
  const branchColorByRoot = new Map<string, string>();
  let nextBranchColorIndex = 0;

  const resolveSpecializationRoot = (nodeId: string): string => {
    let currentId = nodeId;
    const seen = new Set<string>();

    while (!seen.has(currentId)) {
      seen.add(currentId);
      const current = byId.get(currentId);
      if (!current || current.cluster !== "specialization") return currentId;
      const primaryParentId = current.prerequisites[0];
      if (!primaryParentId) return currentId;
      const parent = byId.get(primaryParentId);
      if (!parent || parent.cluster !== "specialization") return currentId;
      currentId = primaryParentId;
    }

    return currentId;
  };

  for (const node of nodes) {
    if (node.cluster === "specialization") {
      const branchRootId = resolveSpecializationRoot(node.tempId);
      let ramp = branchColorByRoot.get(branchRootId);
      if (!ramp) {
        ramp = SPECIALIZATION_COLOR_RAMPS[nextBranchColorIndex % SPECIALIZATION_COLOR_RAMPS.length]!;
        branchColorByRoot.set(branchRootId, ramp);
        nextBranchColorIndex += 1;
      }
      colorById.set(node.tempId, ramp);
      continue;
    }

    const coreRamp =
      node.nodeType === "boss"
        ? "blue"
        : node.nodeType === "milestone"
          ? "teal"
          : CORE_COLOR_RAMPS[node.depth % CORE_COLOR_RAMPS.length]!;
    colorById.set(node.tempId, coreRamp);
  }

  return colorById;
}

async function syncSkillTreeProgressRows(params: {
  db: ReturnType<typeof getDb>;
  treeId: string;
  treeProfileId?: string | null;
  nodeRows: SkillTreeNodeRow[];
  edgeRows: SkillTreeEdgeRow[];
}) {
  const { db, treeId, treeProfileId, nodeRows, edgeRows } = params;
  const existingProgressRows = await db.query.skillTreeNodeProgress.findMany({
    where: eq(skillTreeNodeProgress.treeId, treeId),
  });

  const profileIds = Array.from(
    new Set([
      ...existingProgressRows.map((row) => row.profileId),
      ...(treeProfileId ? [treeProfileId] : []),
    ]),
  );

  if (profileIds.length === 0) return;

  const incomingEdgesByNodeId = new Map<string, SkillTreeEdgeRow[]>(
    nodeRows.map((node) => [node.id, []]),
  );

  for (const edge of edgeRows) {
    const incomingEdges = incomingEdgesByNodeId.get(edge.targetNodeId);
    if (incomingEdges) incomingEdges.push(edge);
  }

  const rowsByProfileId = new Map<string, SkillTreeNodeProgressRow[]>();
  for (const row of existingProgressRows) {
    const bucket = rowsByProfileId.get(row.profileId) ?? [];
    bucket.push(row);
    rowsByProfileId.set(row.profileId, bucket);
  }

  const now = new Date().toISOString();

  for (const profileId of profileIds) {
    const profileRows = rowsByProfileId.get(profileId) ?? [];
    const rowByNodeId = new Map(profileRows.map((row) => [row.nodeId, row]));
    const completedNodeIds = new Set(
      profileRows
        .filter((row) => row.status === "complete" || row.status === "mastery")
        .map((row) => row.nodeId),
    );

    for (const node of nodeRows) {
      const existing = rowByNodeId.get(node.id);
      const prerequisiteGroups = deriveStoredPrerequisiteGroups({
        node,
        incomingEdges: incomingEdgesByNodeId.get(node.id) ?? [],
      });
      const prereqsMet = arePrerequisiteGroupsMet(prerequisiteGroups, completedNodeIds);

      const status =
        existing?.status === "complete" || existing?.status === "mastery"
          ? existing.status
          : prereqsMet
            ? existing?.status === "in_progress"
              ? "in_progress"
              : "available"
            : "locked";

      const values = {
        status,
        xpEarned:
          status === "complete" || status === "mastery"
            ? existing?.xpEarned ?? node.xpReward
            : status === "in_progress"
              ? Math.max(existing?.xpEarned ?? 0, Math.max(40, Math.round(node.xpReward * 0.45)))
              : 0,
        completedAt: status === "complete" || status === "mastery" ? existing?.completedAt ?? null : null,
        masteryAt: status === "mastery" ? existing?.masteryAt ?? existing?.completedAt ?? null : null,
        updatedAt: now,
      } as const;

      if (existing) {
        await db
          .update(skillTreeNodeProgress)
          .set(values)
          .where(
            and(
              eq(skillTreeNodeProgress.nodeId, node.id),
              eq(skillTreeNodeProgress.profileId, profileId),
            ),
          );
      } else {
        await db.insert(skillTreeNodeProgress).values({
          id: crypto.randomUUID(),
          nodeId: node.id,
          profileId,
          treeId,
          ...values,
        });
      }
    }
  }
}

const autoLayoutSkillTreeInput = z.object({
  treeId: z.string(),
});

export const autoLayoutSkillTree = createServerFn({ method: "POST" })
  .inputValidator((data) => autoLayoutSkillTreeInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const tree = await db.query.skillTrees.findFirst({
      where: and(eq(skillTrees.id, data.treeId), eq(skillTrees.organizationId, organizationId)),
    });
    if (!tree) throw new Error("NOT_FOUND");

    const [nodeRows, edgeRows] = await Promise.all([
      db.query.skillTreeNodes.findMany({
        where: and(
          eq(skillTreeNodes.treeId, data.treeId),
          eq(skillTreeNodes.organizationId, organizationId),
        ),
      }),
      db.query.skillTreeEdges.findMany({
        where: eq(skillTreeEdges.treeId, data.treeId),
      }),
    ]);

    if (nodeRows.length === 0) {
      return { updated: 0, nodes: [], edges: [] };
    }

    const prerequisitesByNode = new Map<string, string[]>(
      nodeRows.map((node) => [node.id, []]),
    );
    for (const edge of edgeRows) {
      const existing = prerequisitesByNode.get(edge.targetNodeId);
      if (existing) existing.push(edge.sourceNodeId);
    }

    const specializationRamps = new Set(["purple", "amber", "coral", "green"]);
    const layoutNodes = enforceAdjacentPrerequisites(
      nodeRows.map((node) => {
        const parsedLayout = parseSkillTreeLayoutMetadata(node.aiGeneratedDescription);

        const cluster =
          parsedLayout.cluster === "specialization" ||
          node.nodeType === "elective" ||
          specializationRamps.has(node.colorRamp)
            ? "specialization"
            : "core";

        return {
          tempId: node.id,
          prerequisites: prerequisitesByNode.get(node.id) ?? [],
          depth: parsedLayout.depth,
          cluster,
          nodeType: node.nodeType,
          description: node.description,
        };
      }),
    );

    const existingEdgeTypeByKey = new Map(
      edgeRows.map((edge) => [`${edge.sourceNodeId}>${edge.targetNodeId}`, edge.edgeType] as const),
    );
    const now = new Date().toISOString();
    const layoutNodeById = new Map(layoutNodes.map((node) => [node.tempId, node] as const));

    const positionMap = layoutForceDirected(
      layoutNodes.map((node) => ({
        id: node.tempId,
        prerequisites: node.prerequisites,
        depth: node.depth,
        cluster: node.cluster,
        nodeType: node.nodeType,
      })),
      { width: 1800, height: 1400 },
    );

    // Extract true fork node IDs tagged by the layout algorithm
    const forkIds: Set<string> =
      (positionMap as Map<string, { x: number; y: number }> & { forkIds?: Set<string> }).forkIds ??
      new Set();

    const normalizedEdgeRows: SkillTreeEdgeRow[] = layoutNodes.flatMap((node) =>
      node.prerequisites.map((sourceNodeId, index) => {
        const existing = existingEdgeTypeByKey.get(`${sourceNodeId}>${node.tempId}`);
        const edgeType = classifySkillTreeEdge({
          prereqIndex: index,
          sourceNodeId,
          targetNode: node,
          forkSourceNodeIds: forkIds,
          existingEdgeType: existing ?? null,
        });
        return {
          id: crypto.randomUUID(),
          treeId: data.treeId,
          sourceNodeId,
          targetNodeId: node.tempId,
          edgeType,
          createdAt: now,
        };
      }),
    );

    const incomingEdgesByNodeId = new Map<string, SkillTreeEdgeRow[]>(
      nodeRows.map((node) => [node.id, []]),
    );
    for (const edge of normalizedEdgeRows) {
      const incomingEdges = incomingEdgesByNodeId.get(edge.targetNodeId);
      if (incomingEdges) incomingEdges.push(edge);
    }

    const updatedNodeRows = nodeRows.map((node) => {
      const position = positionMap.get(node.id) ?? {
        x: node.positionX,
        y: node.positionY,
      };
      const layoutNode = layoutNodeById.get(node.id);
      const parsedLayout = parseSkillTreeLayoutMetadata(node.aiGeneratedDescription);
      const prerequisiteGroups =
        parsedLayout.prerequisiteGroups && parsedLayout.prerequisiteGroups.length > 0
          ? normalizePrerequisiteGroups(
              parsedLayout.prerequisiteGroups,
              new Set((incomingEdgesByNodeId.get(node.id) ?? []).map((edge) => edge.sourceNodeId)),
            )
          : layoutNode && layoutNode.prerequisites.length > 1
            ? layoutNode.prerequisites.map((sourceId) => [sourceId])
            : layoutNode && layoutNode.prerequisites.length === 1
              ? [layoutNode.prerequisites]
              : [];

      return {
        ...node,
        positionX: position.x,
        positionY: position.y,
        aiGeneratedDescription: buildNodeLayoutMetadata({
          description: node.description,
          cluster: layoutNode?.cluster === "specialization" ? "specialization" : "core",
          depth: layoutNode?.depth ?? 0,
          prerequisiteGroups,
        }),
        updatedAt: now,
      };
    });

    await Promise.all(
      updatedNodeRows.map((node) => {
        return db
          .update(skillTreeNodes)
          .set({
            positionX: node.positionX,
            positionY: node.positionY,
            aiGeneratedDescription: node.aiGeneratedDescription,
            updatedAt: now,
          })
          .where(eq(skillTreeNodes.id, node.id));
      }),
    );

    await db.delete(skillTreeEdges).where(eq(skillTreeEdges.treeId, data.treeId));
    if (normalizedEdgeRows.length > 0) {
      await Promise.all(normalizedEdgeRows.map((edge) => db.insert(skillTreeEdges).values(edge)));
    }

    await syncSkillTreeProgressRows({
      db,
      treeId: data.treeId,
      treeProfileId: tree.profileId,
      nodeRows: updatedNodeRows,
      edgeRows: normalizedEdgeRows,
    });

    const progressRows = tree.profileId
      ? await db.query.skillTreeNodeProgress.findMany({
          where: and(
            eq(skillTreeNodeProgress.treeId, data.treeId),
            eq(skillTreeNodeProgress.profileId, tree.profileId),
          ),
        })
      : [];

    return {
      updated: nodeRows.length,
      nodes: updatedNodeRows,
      edges: normalizedEdgeRows,
      nodeProgress: progressRows,
    };
  });

const reweaveSkillTreeInput = z.object({
  treeId: z.string(),
});

export const reweaveSkillTree = createServerFn({ method: "POST" })
  .inputValidator((data) => reweaveSkillTreeInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const tree = await db.query.skillTrees.findFirst({
      where: and(eq(skillTrees.id, data.treeId), eq(skillTrees.organizationId, organizationId)),
    });
    if (!tree) throw new Error("NOT_FOUND");

    const [nodeRows, edgeRows] = await Promise.all([
      db.query.skillTreeNodes.findMany({
        where: and(
          eq(skillTreeNodes.treeId, data.treeId),
          eq(skillTreeNodes.organizationId, organizationId),
        ),
      }),
      db.query.skillTreeEdges.findMany({
        where: eq(skillTreeEdges.treeId, data.treeId),
      }),
    ]);

    if (nodeRows.length === 0) {
      return { updated: 0, nodes: [], edges: [] };
    }

    const orderedNodes = orderTreeNodesForTraversal(nodeRows, edgeRows);
    const currentDepthByNodeId = computeTreeDepthByNodeId(nodeRows, edgeRows);
    const tempIdByRealId = new Map<string, string>();
    const realIdByTempId = new Map<string, string>();

    orderedNodes.forEach((node, index) => {
      const tempId = `node_${index + 1}`;
      tempIdByRealId.set(node.id, tempId);
      realIdByTempId.set(tempId, node.id);
    });

    const specializationRamps = new Set(["purple", "amber", "coral", "green"]);
    const rewovenPlan = await reweaveCurriculumTree({
      treeTitle: tree.title,
      subject: tree.subject ?? "general",
      gradeLevel: tree.gradeLevel ?? "mixed",
      nodes: orderedNodes.map((node) => {
        const metadata = parseSkillTreeLayoutMetadata(node.aiGeneratedDescription);
        return {
          tempId: tempIdByRealId.get(node.id)!,
          title: node.title,
          description: node.description ?? metadata.description ?? "",
          nodeType: node.nodeType,
          colorRamp: node.colorRamp,
          xpReward: node.xpReward,
        };
      }),
    });

    const planByTempId = new Map(rewovenPlan.map((node) => [node.tempId, node]));
    const rawLayoutNodes = orderedNodes.map((node, index) => {
      const tempId = tempIdByRealId.get(node.id)!;
      const plan = planByTempId.get(tempId);
      const fallbackCluster =
        node.nodeType === "elective" || specializationRamps.has(node.colorRamp)
          ? "specialization"
          : "core";

      const prerequisites = [
        ...(plan?.primaryPrerequisite ? [plan.primaryPrerequisite] : []),
        ...(plan?.bonusPrerequisites ?? []),
      ];

      return {
        tempId,
        prerequisites: index === 0 ? [] : prerequisites,
        depth: index === 0 ? 0 : Math.max(1, plan?.depth ?? (currentDepthByNodeId.get(node.id) ?? index)),
        cluster: index === 0 ? "core" : (plan?.cluster ?? fallbackCluster),
        nodeType: node.nodeType,
      };
    });

    const normalizedLayoutNodes = enforceAdjacentPrerequisites(rawLayoutNodes);
    const rewovenColorRampByTempId = assignRewovenColorRamps(normalizedLayoutNodes);
    const positionMap = layoutForceDirected(
      normalizedLayoutNodes.map((node) => ({
        id: node.tempId,
        prerequisites: node.prerequisites,
        depth: node.depth,
        cluster: node.cluster,
        nodeType: node.nodeType,
      })),
      { width: 1200, height: 900 },
    );

    const now = new Date().toISOString();
    const forkTempIds: Set<string> =
      (positionMap as Map<string, { x: number; y: number }> & { forkIds?: Set<string> }).forkIds ??
      deriveForkSourceIds(
        normalizedLayoutNodes.map((node) => ({
          id: node.tempId,
          prerequisites: node.prerequisites,
          cluster: node.cluster,
          nodeType: node.nodeType,
        })),
      );
    const forkSourceNodeIds = new Set(
      Array.from(forkTempIds)
        .map((tempId) => realIdByTempId.get(tempId))
        .filter((value): value is string => typeof value === "string"),
    );
    const normalizedNodeByTempId = new Map(
      normalizedLayoutNodes.map((node) => [node.tempId, node] as const),
    );

    const updatedNodes: SkillTreeNodeRow[] = orderedNodes.map((node) => {
      const tempId = tempIdByRealId.get(node.id)!;
      const normalizedNode = normalizedNodeByTempId.get(tempId)!;
      const position = positionMap.get(tempId) ?? {
        x: node.positionX,
        y: node.positionY,
      };
      const prerequisiteGroups =
        normalizedNode.prerequisites.length > 1
          ? normalizedNode.prerequisites
              .map((prereqTempId) => realIdByTempId.get(prereqTempId))
              .filter((prereqId): prereqId is string => typeof prereqId === "string")
              .map((prereqId) => [prereqId])
          : normalizedNode.prerequisites.length === 1
            ? [[realIdByTempId.get(normalizedNode.prerequisites[0]!)!]]
            : [];

      return {
        ...node,
        positionX: position.x,
        positionY: position.y,
        colorRamp: rewovenColorRampByTempId.get(tempId) ?? node.colorRamp,
        aiGeneratedDescription: buildNodeLayoutMetadata({
          description: node.description,
          cluster: normalizedNode.cluster,
          depth: normalizedNode.depth ?? 0,
          prerequisiteGroups,
        }),
        updatedAt: now,
      };
    });

    const edgeSet = new Set<string>();
    const rewovenEdgeRows: SkillTreeEdgeRow[] = [];
    for (const node of normalizedLayoutNodes) {
      for (const [index, prereqTempId] of node.prerequisites.entries()) {
        const sourceNodeId = realIdByTempId.get(prereqTempId);
        const targetNodeId = realIdByTempId.get(node.tempId);
        if (!sourceNodeId || !targetNodeId) continue;

        const key = `${sourceNodeId}>${targetNodeId}`;
        if (edgeSet.has(key)) continue;
        edgeSet.add(key);

        const edgeType = classifySkillTreeEdge({
          prereqIndex: index,
          sourceNodeId,
          targetNode: node,
          forkSourceNodeIds,
        });

        rewovenEdgeRows.push({
          id: crypto.randomUUID(),
          treeId: data.treeId,
          sourceNodeId,
          targetNodeId,
          edgeType,
          createdAt: now,
        });
      }
    }

    await Promise.all(
      updatedNodes.map((node) =>
        db
          .update(skillTreeNodes)
          .set({
            positionX: node.positionX,
            positionY: node.positionY,
            colorRamp: node.colorRamp,
            aiGeneratedDescription: node.aiGeneratedDescription,
            updatedAt: now,
          })
          .where(eq(skillTreeNodes.id, node.id)),
      ),
    );

    await db.delete(skillTreeEdges).where(eq(skillTreeEdges.treeId, data.treeId));
    if (rewovenEdgeRows.length > 0) {
      await Promise.all(rewovenEdgeRows.map((edge) => db.insert(skillTreeEdges).values(edge)));
    }

    await syncSkillTreeProgressRows({
      db,
      treeId: data.treeId,
      treeProfileId: tree.profileId,
      nodeRows: updatedNodes,
      edgeRows: rewovenEdgeRows,
    });

    const progressRows = tree.profileId
      ? await db.query.skillTreeNodeProgress.findMany({
          where: and(
            eq(skillTreeNodeProgress.treeId, data.treeId),
            eq(skillTreeNodeProgress.profileId, tree.profileId),
          ),
        })
      : [];

    return {
      updated: updatedNodes.length,
      nodes: updatedNodes,
      edges: rewovenEdgeRows,
      nodeProgress: progressRows,
    };
  });

const saveTreeViewportInput = z.object({
  treeId: z.string(),
  viewportX: z.number().int(),
  viewportY: z.number().int(),
  viewportScale: z.number(),
});

export const saveTreeViewport = createServerFn({ method: "POST" })
  .inputValidator((data) => saveTreeViewportInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent", "student"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const tree = await db.query.skillTrees.findFirst({
      where: and(eq(skillTrees.id, data.treeId), eq(skillTrees.organizationId, organizationId)),
    });
    if (!tree) throw new Error("NOT_FOUND");

    await db
      .update(skillTrees)
      .set({
        viewportX: data.viewportX,
        viewportY: data.viewportY,
        viewportScale: Math.round(data.viewportScale * 100),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(skillTrees.id, data.treeId));

    return { success: true };
  });

const markNodeCompleteInput = z.object({
  nodeId: z.string(),
  profileId: z.string(),
});

export const markNodeComplete = createServerFn({ method: "POST" })
  .inputValidator((data) => markNodeCompleteInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent", "student"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    // a) Verify node belongs to org
    const node = await db.query.skillTreeNodes.findFirst({
      where: and(
        eq(skillTreeNodes.id, data.nodeId),
        eq(skillTreeNodes.organizationId, organizationId),
      ),
    });
    if (!node) throw new Error("NOT_FOUND");

    // b) Fetch linked assignments
    const junctionRows = await db.query.skillTreeNodeAssignments.findMany({
      where: eq(skillTreeNodeAssignments.nodeId, data.nodeId),
    });

    // c) Verify submissions exist for each linked assignment
    if (junctionRows.length > 0) {
      const assignmentIds = junctionRows.map((j) => j.assignmentId);
      const submissionRows = await db.query.submissions.findMany({
        where: and(
          inArray(submissions.assignmentId, assignmentIds),
          eq(submissions.profileId, data.profileId),
        ),
      });
      const submittedAssignmentIds = new Set(submissionRows.map((s) => s.assignmentId));
      const allComplete = assignmentIds.every((id) => submittedAssignmentIds.has(id));
      if (!allComplete) throw new Error("ASSIGNMENTS_INCOMPLETE");
    }

    // d) Upsert progress row to complete
    const now = new Date().toISOString();
    const existingProgress = await db.query.skillTreeNodeProgress.findFirst({
      where: and(
        eq(skillTreeNodeProgress.nodeId, data.nodeId),
        eq(skillTreeNodeProgress.profileId, data.profileId),
      ),
    });

    if (existingProgress) {
      await db
        .update(skillTreeNodeProgress)
        .set({
          status: "complete",
          xpEarned: node.xpReward,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(skillTreeNodeProgress.nodeId, data.nodeId),
            eq(skillTreeNodeProgress.profileId, data.profileId),
          ),
        );
    } else {
      await db.insert(skillTreeNodeProgress).values({
        id: crypto.randomUUID(),
        nodeId: data.nodeId,
        profileId: data.profileId,
        treeId: node.treeId,
        status: "complete",
        xpEarned: node.xpReward,
        completedAt: now,
        updatedAt: now,
      });
    }

    // e) Find outgoing edges and unlock newly eligible target nodes
    const outgoingEdges = await db.query.skillTreeEdges.findMany({
      where: eq(skillTreeEdges.sourceNodeId, data.nodeId),
    });

    const unlockedNodeIds: string[] = [];

    await Promise.all(
      outgoingEdges.map(async (edge) => {
        // Get all incoming edges to the target node
        const [incomingEdges, targetNode] = await Promise.all([
          db.query.skillTreeEdges.findMany({
            where: eq(skillTreeEdges.targetNodeId, edge.targetNodeId),
          }),
          db.query.skillTreeNodes.findFirst({
            where: eq(skillTreeNodes.id, edge.targetNodeId),
            columns: { id: true, aiGeneratedDescription: true },
          }),
        ]);

        if (!targetNode) return;

        const prerequisiteGroups = deriveStoredPrerequisiteGroups({
          node: targetNode,
          incomingEdges,
        });
        const incomingSourceIds = Array.from(
          new Set(prerequisiteGroups.flatMap((group) => group)),
        );

        // Check if all incoming source nodes are completed/mastery for this profile
        const completedSourceRows = incomingSourceIds.length
          ? await db.query.skillTreeNodeProgress.findMany({
              where: and(
                inArray(skillTreeNodeProgress.nodeId, incomingSourceIds),
                eq(skillTreeNodeProgress.profileId, data.profileId),
              ),
            })
          : [];

        const completedSet = new Set(
          completedSourceRows
            .filter((p) => p.status === "complete" || p.status === "mastery")
            .map((p) => p.nodeId),
        );

        const allPrereqsMet = arePrerequisiteGroupsMet(prerequisiteGroups, completedSet);

        if (allPrereqsMet) {
          // Upsert target to available (only if currently locked)
          const targetProgress = await db.query.skillTreeNodeProgress.findFirst({
            where: and(
              eq(skillTreeNodeProgress.nodeId, edge.targetNodeId),
              eq(skillTreeNodeProgress.profileId, data.profileId),
            ),
          });

          if (!targetProgress) {
            await db.insert(skillTreeNodeProgress).values({
              id: crypto.randomUUID(),
              nodeId: edge.targetNodeId,
              profileId: data.profileId,
              treeId: node.treeId,
              status: "available",
              xpEarned: 0,
              updatedAt: now,
            });
            unlockedNodeIds.push(edge.targetNodeId);
          } else if (targetProgress.status === "locked") {
            await db
              .update(skillTreeNodeProgress)
              .set({ status: "available", updatedAt: now })
              .where(
                and(
                  eq(skillTreeNodeProgress.nodeId, edge.targetNodeId),
                  eq(skillTreeNodeProgress.profileId, data.profileId),
                ),
              );
            unlockedNodeIds.push(edge.targetNodeId);
          }
        }
      }),
    );

    // f) Sum total earned XP for this profile on this tree
    const xpResult = await db
      .select({ total: sum(skillTreeNodeProgress.xpEarned) })
      .from(skillTreeNodeProgress)
      .where(
        and(
          eq(skillTreeNodeProgress.treeId, node.treeId),
          eq(skillTreeNodeProgress.profileId, data.profileId),
        ),
      );

    const newTotalXp = Number(xpResult[0]?.total ?? 0);

    // g) Sync active reward track XP if one exists for this profile
    let newlyUnlockedRewardTierIds: string[] = [];
    let rewardTrackXpEarned = 0;

    const activeTrack = await db.query.rewardTracks.findFirst({
      where: and(
        eq(rewardTracks.profileId, data.profileId),
        eq(rewardTracks.isActive, true),
      ),
    });

    if (activeTrack) {
      const syncResult = await syncTrackXp(
        db,
        activeTrack.id,
        data.profileId,
        organizationId,
      );
      newlyUnlockedRewardTierIds = syncResult.newlyUnlockedTierIds;
      rewardTrackXpEarned = syncResult.xpEarned;
    }

    return {
      success: true,
      xpEarned: node.xpReward,
      unlockedNodeIds,
      newTotalXp,
      newlyUnlockedRewardTierIds,
      rewardTrackXpEarned,
    };
  });

// ─── AI SKILL TREE FUNCTIONS ───

const aiExpandSkillTreeInput = z.object({
  treeId: z.string(),
  fromNodeId: z.string(),
  nodeCount: z.number().int().min(1).max(6).optional(),
  focusArea: z.string().optional(),
});

export const aiExpandSkillTree = createServerFn({ method: "POST" })
  .inputValidator((data) => aiExpandSkillTreeInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    // a) Verify fromNode belongs to this org's tree
    const fromNode = await db.query.skillTreeNodes.findFirst({
      where: and(
        eq(skillTreeNodes.id, data.fromNodeId),
        eq(skillTreeNodes.organizationId, organizationId),
      ),
    });
    if (!fromNode) throw new Error("NOT_FOUND");

    const tree = await db.query.skillTrees.findFirst({
      where: and(eq(skillTrees.id, data.treeId), eq(skillTrees.organizationId, organizationId)),
    });
    if (!tree) throw new Error("NOT_FOUND");

    // b) Fetch all existing node titles in this tree
    const existingNodes = await db.query.skillTreeNodes.findMany({
      where: eq(skillTreeNodes.treeId, data.treeId),
    });
    const existingNodeTitles = existingNodes.map((n) => n.title);

    // c) Call generateNodeExpansion
    const nodeCount = Math.min(data.nodeCount ?? 4, 6);
    const suggestions = await generateNodeExpansion({
      fromNodeTitle: fromNode.title,
      fromNodeDescription: fromNode.description ?? "",
      subject: tree.subject ?? "general",
      gradeLevel: tree.gradeLevel ?? "mixed",
      nodeCount,
      focusArea: data.focusArea,
      existingNodeTitles,
    });

    // d) Insert nodes and edges with fanned-out positions
    const now = new Date().toISOString();
    const forkSourceNodeIds = new Set(
      suggestions.filter((suggestion) => !isSpecializationLaneNode(suggestion)).length >= 2
        ? [data.fromNodeId]
        : [],
    );
    const newNodes: typeof existingNodes = [];
    const newEdgeIds: string[] = [];

    await Promise.all(
      suggestions.map(async (suggestion, index) => {
        const count = suggestions.length;
        const angle =
          count === 1
            ? -Math.PI / 2
            : (index / (count - 1)) * Math.PI - Math.PI / 2;
        const rawX = fromNode.positionX + Math.round(Math.cos(angle) * 160);
        const newX = Math.min(940, Math.max(60, rawX));
        const newY = fromNode.positionY + 140;

        const nodeId = crypto.randomUUID();
        await db.insert(skillTreeNodes).values({
          id: nodeId,
          treeId: data.treeId,
          organizationId,
          title: suggestion.title,
          description: suggestion.description || null,
          icon: suggestion.icon || null,
          colorRamp: suggestion.colorRamp,
          nodeType: suggestion.nodeType,
          xpReward: suggestion.xpReward,
          positionX: newX,
          positionY: newY,
          radius: 28,
          isRequired: false,
          aiGeneratedDescription: buildNodeLayoutMetadata({
            description: suggestion.description || null,
            cluster: suggestion.cluster,
            depth: suggestion.depth,
            prerequisiteGroups: [[data.fromNodeId]],
          }),
          createdAt: now,
          updatedAt: now,
        });

        const edgeId = crypto.randomUUID();
        await db.insert(skillTreeEdges).values({
          id: edgeId,
          treeId: data.treeId,
          sourceNodeId: data.fromNodeId,
          targetNodeId: nodeId,
          edgeType: classifySkillTreeEdge({
            prereqIndex: 0,
            sourceNodeId: data.fromNodeId,
            targetNode: suggestion,
            forkSourceNodeIds,
          }),
          createdAt: now,
        });

        newEdgeIds.push(edgeId);

        const inserted = await db.query.skillTreeNodes.findFirst({
          where: eq(skillTreeNodes.id, nodeId),
        });
        if (inserted) newNodes.push(inserted);
      }),
    );

    const newEdges = newEdgeIds.length
      ? await db.query.skillTreeEdges.findMany({
          where: inArray(skillTreeEdges.id, newEdgeIds),
        })
      : [];

    return { newNodes, newEdges };
  });

const aiGenerateNodeAssignmentsInput = z.object({
  nodeId: z.string(),
  classId: z.string(),
  count: z.number().int().min(1).max(8).optional(),
});

export const aiGenerateNodeAssignments = createServerFn({ method: "POST" })
  .inputValidator((data) => aiGenerateNodeAssignmentsInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    // a) Fetch node
    const node = await db.query.skillTreeNodes.findFirst({
      where: and(
        eq(skillTreeNodes.id, data.nodeId),
        eq(skillTreeNodes.organizationId, organizationId),
      ),
    });
    if (!node) throw new Error("NOT_FOUND");

    // b) Fetch the tree's gradeLevel
    const tree = await db.query.skillTrees.findFirst({
      where: and(eq(skillTrees.id, node.treeId), eq(skillTrees.organizationId, organizationId)),
    });
    if (!tree) throw new Error("NOT_FOUND");

    // Verify classId belongs to org
    const classRow = await db.query.classes.findFirst({
      where: and(eq(classes.id, data.classId), eq(classes.organizationId, organizationId)),
    });
    if (!classRow) throw new Error("NOT_FOUND");

    const count = data.count ?? 3;
    const subject = node.subject ?? tree.subject ?? "general";
    const gradeLevel = tree.gradeLevel ?? "mixed";

    // c) Ask AI for assignment suggestions
    const prompt = [
      `For a ${gradeLevel} student learning '${node.title}' in ${subject}, suggest ${count} assignments.`,
      node.description ? `Context: ${node.description}` : "",
      `Return JSON array: [{ "type": "text"|"video"|"quiz"|"essay_questions"|"report", "title": string, "description": string }]`,
      "Return ONLY the JSON array. No markdown, no prose.",
    ]
      .filter(Boolean)
      .join("\n");

    const result = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages: [
        { role: "system", content: "You are a homeschool curriculum designer. Output only valid JSON." },
        { role: "user", content: prompt },
      ],
      max_tokens: 1200,
    });

    const responseText =
      typeof result === "string"
        ? result
        : typeof (result as Record<string, unknown>).response === "string"
          ? ((result as Record<string, unknown>).response as string)
          : JSON.stringify(result);

    const parsed = (() => {
      const extracted = (() => {
        try { return JSON.parse(responseText.trim()); } catch { /* fall through */ }
        const fenced = responseText.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
        if (fenced) { try { return JSON.parse(fenced.trim()); } catch { /* fall through */ } }
        const firstBracket = responseText.indexOf("[");
        const lastBracket = responseText.lastIndexOf("]");
        if (firstBracket >= 0 && lastBracket > firstBracket) {
          try { return JSON.parse(responseText.slice(firstBracket, lastBracket + 1)); } catch { /* fall through */ }
        }
        return null;
      })();
      return Array.isArray(extracted) ? extracted : null;
    })();

    if (!parsed) throw new Error("AI_ASSIGNMENT_PARSE_FAILED");

    const VALID_TYPES = new Set(["text", "file", "url", "video", "quiz", "essay_questions", "report", "movie"]);
    type SuggestionItem = { type: string; title: string; description: string };
    const suggestions = (parsed as unknown[])
      .filter(
        (item): item is SuggestionItem =>
          item !== null &&
          typeof item === "object" &&
          typeof (item as Record<string, unknown>).type === "string" &&
          typeof (item as Record<string, unknown>).title === "string",
      )
      .map((item) => ({
        type: VALID_TYPES.has(item.type) ? item.type : "text",
        title: item.title.trim(),
        description: typeof item.description === "string" ? item.description.trim() : "",
      }))
      .slice(0, count);

    // d) Persist each assignment and e) link to node
    const now = new Date().toISOString();
    const createdAssignmentIds: string[] = [];

    await Promise.all(
      suggestions.map(async (suggestion, index) => {
        const assignmentId = crypto.randomUUID();
        await db.insert(assignments).values({
          id: assignmentId,
          organizationId,
          classId: data.classId,
          title: suggestion.title,
          description: suggestion.description || null,
          contentType: suggestion.type as AssignmentContentType,
          contentRef: null,
          linkedAssignmentId: null,
          dueAt: null,
          createdByUserId: session.user.id,
          createdAt: now,
          updatedAt: now,
        });

        await db.insert(skillTreeNodeAssignments).values({
          id: crypto.randomUUID(),
          nodeId: data.nodeId,
          assignmentId,
          orderIndex: index,
          createdAt: now,
        });

        createdAssignmentIds.push(assignmentId);
      }),
    );

    const createdAssignments = createdAssignmentIds.length
      ? await db.query.assignments.findMany({
          where: inArray(assignments.id, createdAssignmentIds),
        })
      : [];

    return { assignments: createdAssignments, linkedCount: createdAssignments.length };
  });

const aiSuggestFullCurriculumInput = z.object({
  treeId: z.string(),
  subject: z.string().min(1),
  gradeLevel: z.string().min(1),
  depth: z.number().int().min(2).max(6).optional(),
  seedTopic: z.string().optional(),
});

type AdjacencyNodeShape = {
  tempId: string;
  prerequisites: string[];
  depth?: number;
  cluster?: string;
  nodeType?: string;
};

/**
 * Enforce local connectivity rules:
 * - no self-links
 * - only references to earlier nodes
 * - prefer prerequisites from adjacent depth (difference <= 1)
 * - keep graph connected by adding one fallback prerequisite when needed
 */
function enforceAdjacentPrerequisites<T extends AdjacencyNodeShape>(nodes: T[]): T[] {
  if (nodes.length <= 1) return nodes;

  const byId = new Map(nodes.map((n) => [n.tempId, n]));
  const order = new Map(nodes.map((n, i) => [n.tempId, i]));
  const processed: string[] = [];
  const depthOf = (n: AdjacencyNodeShape, fallbackIndex: number) =>
    typeof n.depth === "number" && Number.isFinite(n.depth) ? n.depth : fallbackIndex;
  const clusterOf = (id: string) =>
    byId.get(id)?.cluster === "specialization" ? "specialization" : "core";

  return nodes.map((node, index) => {
    const thisIndex = order.get(node.tempId) ?? index;
    const nodeDepth = depthOf(node, thisIndex);
    const allowBridgeBackToCore =
      (node.cluster ?? "core") === "core" &&
      nodeDepth >= 2 &&
      node.nodeType !== "elective";

    const adjacentPool = processed.filter((id) => {
      const src = byId.get(id);
      if (!src) return false;
      const srcDepth = depthOf(src, order.get(id) ?? 0);
      if (srcDepth >= nodeDepth) return false;
      return nodeDepth - srcDepth <= 1;
    });

    const widerPool = processed.filter((id) => {
      const src = byId.get(id);
      if (!src) return false;
      const srcDepth = depthOf(src, order.get(id) ?? 0);
      return srcDepth < nodeDepth;
    });

    const fallbackPool = adjacentPool.length > 0 ? adjacentPool : widerPool.length > 0 ? widerPool : processed;

    const scoreCandidate = (sourceId: string) => {
      const src = byId.get(sourceId)!;
      const srcDepth = depthOf(src, order.get(sourceId) ?? 0);
      const depthPenalty = Math.abs((nodeDepth - srcDepth) - 1) * 100;
      const clusterPenalty =
        node.cluster && src.cluster && node.cluster !== src.cluster
          ? 10
          : 0;
      const indexPenalty = Math.abs((order.get(sourceId) ?? 0) - thisIndex) * 0.01;
      return depthPenalty + clusterPenalty + indexPenalty;
    };

    const uniqueRaw = Array.from(
      new Set(
        node.prerequisites.filter((sourceId) => {
          if (sourceId === node.tempId) return false;
          const src = byId.get(sourceId);
          if (!src) return false;
          const srcDepth = depthOf(src, order.get(sourceId) ?? 0);
          const sourceIndex = order.get(sourceId);
          if (typeof sourceIndex !== "number" || sourceIndex >= thisIndex) return false;
          return srcDepth < nodeDepth && nodeDepth - srcDepth <= 1;
        }),
      ),
    );

    const repaired = [...uniqueRaw];
    if (thisIndex > 0 && repaired.length === 0 && fallbackPool.length > 0) {
      const fallback = [...fallbackPool].sort((a, b) => scoreCandidate(a) - scoreCandidate(b))[0];
      if (fallback) repaired.push(fallback);
    }

    const sanitized = repaired
      .sort((a, b) => scoreCandidate(a) - scoreCandidate(b))
      .slice(0, 1);

    if (allowBridgeBackToCore && sanitized[0]) {
      const primarySourceId = sanitized[0];
      const bridgeSourceId = repaired
        .filter((sourceId) => sourceId !== primarySourceId)
        .filter((sourceId) => clusterOf(sourceId) !== clusterOf(primarySourceId))
        .sort((a, b) => scoreCandidate(a) - scoreCandidate(b))[0];
      if (bridgeSourceId) {
        sanitized.push(bridgeSourceId);
      }
    }

    processed.push(node.tempId);
    return { ...node, prerequisites: sanitized };
  });
}

export const aiSuggestFullCurriculum = createServerFn({ method: "POST" })
  .inputValidator((data) => aiSuggestFullCurriculumInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const tree = await db.query.skillTrees.findFirst({
      where: and(eq(skillTrees.id, data.treeId), eq(skillTrees.organizationId, organizationId)),
    });
    if (!tree) throw new Error("NOT_FOUND");

    // a) Fetch existing node titles
    const existingNodes = await db.query.skillTreeNodes.findMany({
      where: eq(skillTreeNodes.treeId, data.treeId),
    });
    const existingNodeTitles = existingNodes.map((n) => n.title);

    // b) Call generateCurriculumTree
    const generatedSuggestions = await generateCurriculumTree({
      subject: data.subject,
      gradeLevel: data.gradeLevel,
      depth: data.depth ?? 4,
      seedTopic: data.seedTopic,
      existingNodeTitles,
    });
    const suggestions = enforceAdjacentPrerequisites(
      generatedSuggestions.map((s) => ({
        ...s,
        prerequisites: s.prerequisites,
      })),
    );

    // c) Compute positions via force-directed layout (handles multi-prerequisite web)
    const layoutItems = suggestions.map((s) => ({
      id: s.tempId,
      prerequisites: s.prerequisites,
      depth: s.depth,
      cluster: s.cluster,
      nodeType: s.nodeType,
    }));
    const positionMap = layoutForceDirected(layoutItems);
    const forkTempIds: Set<string> =
      (positionMap as Map<string, { x: number; y: number }> & { forkIds?: Set<string> }).forkIds ??
      deriveForkSourceIds(layoutItems);

    // d) Insert nodes — build tempId → real ID map first
    const tempIdToRealId = new Map<string, string>();
    for (const suggestion of suggestions) {
      tempIdToRealId.set(suggestion.tempId, crypto.randomUUID());
    }
    const forkSourceNodeIds = new Set(
      Array.from(forkTempIds)
        .map((tempId) => tempIdToRealId.get(tempId))
        .filter((value): value is string => typeof value === "string"),
    );

    const now = new Date().toISOString();

    await Promise.all(
      suggestions.map(async (suggestion) => {
        const nodeId = tempIdToRealId.get(suggestion.tempId)!;
        const pos = positionMap.get(suggestion.tempId) ?? { x: 500, y: 60 };

        await db.insert(skillTreeNodes).values({
          id: nodeId,
          treeId: data.treeId,
          organizationId,
          title: suggestion.title,
          description: suggestion.description || null,
          icon: suggestion.icon || null,
          colorRamp: suggestion.colorRamp,
          nodeType: suggestion.nodeType,
          xpReward: suggestion.xpReward,
          positionX: pos.x,
          positionY: pos.y,
          radius: 28,
          isRequired: false,
          aiGeneratedDescription: buildNodeLayoutMetadata({
            description: suggestion.description || null,
            cluster: suggestion.cluster,
            depth: suggestion.depth,
            prerequisiteGroups:
              suggestion.prerequisites.length > 1
                ? suggestion.prerequisites
                    .map((prereqTempId) => tempIdToRealId.get(prereqTempId))
                    .filter((prereqId): prereqId is string => typeof prereqId === "string")
                    .map((prereqId) => [prereqId])
                : suggestion.prerequisites.length === 1
                  ? [[tempIdToRealId.get(suggestion.prerequisites[0]!)!]]
                  : [],
          }),
          createdAt: now,
          updatedAt: now,
        });
      }),
    );

    // e) Insert edges — one edge per entry in prerequisites (enables cross-links)
    const edgeInserts: Array<{
      id: string;
      treeId: string;
      sourceNodeId: string;
      targetNodeId: string;
      edgeType: "required" | "optional" | "bonus" | "fork";
      createdAt: string;
    }> = [];
    for (const suggestion of suggestions) {
      for (const [index, prereqTempId] of suggestion.prerequisites.entries()) {
        const sourceId = tempIdToRealId.get(prereqTempId);
        const targetId = tempIdToRealId.get(suggestion.tempId);
        if (!sourceId || !targetId) continue;
        edgeInserts.push({
          id: crypto.randomUUID(),
          treeId: data.treeId,
          sourceNodeId: sourceId,
          targetNodeId: targetId,
          edgeType: classifySkillTreeEdge({
            prereqIndex: index,
            sourceNodeId: sourceId,
            targetNode: suggestion,
            forkSourceNodeIds,
          }),
          createdAt: now,
        });
      }
    }

    if (edgeInserts.length > 0) {
      await Promise.all(edgeInserts.map((edge) => db.insert(skillTreeEdges).values(edge)));
    }

    // Fetch and return inserted rows
    const realNodeIds = [...tempIdToRealId.values()];
    const realEdgeIds = edgeInserts.map((e) => e.id);

    const [insertedNodes, insertedEdges] = await Promise.all([
      realNodeIds.length
        ? db.query.skillTreeNodes.findMany({ where: inArray(skillTreeNodes.id, realNodeIds) })
        : Promise.resolve([]),
      realEdgeIds.length
        ? db.query.skillTreeEdges.findMany({ where: inArray(skillTreeEdges.id, realEdgeIds) })
        : Promise.resolve([]),
    ]);

    return {
      insertedNodes: insertedNodes.length,
      insertedEdges: insertedEdges.length,
      nodes: insertedNodes,
      edges: insertedEdges,
    };
  });

// ── Student skill trees ───────────────────────────────────────────────────────

const studentSkillTreesInput = z.object({ profileId: z.string() });

export const getStudentSkillTrees = createServerFn({ method: "GET" })
  .inputValidator((data) => studentSkillTreesInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent", "student"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    // Get classes the profile is enrolled in
    const enrolledRows = await db
      .select({ classId: classEnrollments.classId })
      .from(classEnrollments)
      .where(eq(classEnrollments.profileId, data.profileId));

    const enrolledClassIds = enrolledRows.map((r) => r.classId);

    // Find trees for this org where classId is in enrolled classes
    const treeRows = enrolledClassIds.length
      ? await db.query.skillTrees.findMany({
          where: and(
            eq(skillTrees.organizationId, organizationId),
            inArray(skillTrees.classId, enrolledClassIds),
          ),
          orderBy: [desc(skillTrees.createdAt)],
        })
      : [];

    if (treeRows.length === 0) return [];

    const treeIds = treeRows.map((t) => t.id);

    // Node counts and progress per tree
    const [nodeCounts, progressRows] = await Promise.all([
      db
        .select({ treeId: skillTreeNodes.treeId, total: count() })
        .from(skillTreeNodes)
        .where(inArray(skillTreeNodes.treeId, treeIds))
        .groupBy(skillTreeNodes.treeId),
      db
        .select({
          treeId: skillTreeNodes.treeId,
          status: skillTreeNodeProgress.status,
          xpEarned: skillTreeNodeProgress.xpEarned,
        })
        .from(skillTreeNodeProgress)
        .innerJoin(skillTreeNodes, eq(skillTreeNodeProgress.nodeId, skillTreeNodes.id))
        .where(
          and(
            eq(skillTreeNodeProgress.profileId, data.profileId),
            inArray(skillTreeNodes.treeId, treeIds),
          ),
        ),
    ]);

    const nodeCountMap = new Map(nodeCounts.map((r) => [r.treeId, r.total]));

    // Group progress by tree
    const progressByTree = new Map<string, typeof progressRows>();
    for (const row of progressRows) {
      const existing = progressByTree.get(row.treeId) ?? [];
      existing.push(row);
      progressByTree.set(row.treeId, existing);
    }

    return treeRows.map((tree) => {
      const prog = progressByTree.get(tree.id) ?? [];
      const completedNodes = prog.filter(
        (p) => p.status === "complete" || p.status === "mastery",
      ).length;
      const earnedXp = prog.reduce((acc, p) => acc + (p.xpEarned ?? 0), 0);
      return {
        tree,
        completedNodes,
        totalNodes: nodeCountMap.get(tree.id) ?? 0,
        earnedXp,
      };
    });
  });

// ─── REWARD TRACKS ───────────────────────────────────────────────────────────

// Internal helper — not exported as a server fn.
// Computes XP earned within a track's active window, upserts the snapshot,
// then checks each tier and inserts unclaimed reward claim rows for newly reached tiers.
async function syncTrackXp(
  db: ReturnType<typeof getDb>,
  trackId: string,
  profileId: string,
  organizationId: string,
): Promise<{ xpEarned: number; newlyUnlockedTierIds: string[] }> {
  // Fetch the track so we know startedAt
  const track = await db.query.rewardTracks.findFirst({
    where: eq(rewardTracks.id, trackId),
  });
  if (!track) return { xpEarned: 0, newlyUnlockedTierIds: [] };

  // Sum xpEarned from skillTreeNodeProgress for all trees in this org for this profile,
  // filtered to completedAt >= startedAt when startedAt is set.
  const orgTreeRows = await db.query.skillTrees.findMany({
    where: eq(skillTrees.organizationId, organizationId),
    columns: { id: true },
  });
  const orgTreeIds = orgTreeRows.map((t) => t.id);

  let xpEarned = 0;
  if (orgTreeIds.length > 0) {
    const conditions = [
      inArray(skillTreeNodeProgress.treeId, orgTreeIds),
      eq(skillTreeNodeProgress.profileId, profileId),
    ];
    if (track.startedAt) {
      conditions.push(gte(skillTreeNodeProgress.completedAt, track.startedAt));
    }

    const xpResult = await db
      .select({ total: sum(skillTreeNodeProgress.xpEarned) })
      .from(skillTreeNodeProgress)
      .where(and(...conditions));
    xpEarned = Number(xpResult[0]?.total ?? 0);
  }

  // Upsert snapshot
  const existingSnapshot = await db.query.rewardTrackXpSnapshots.findFirst({
    where: and(
      eq(rewardTrackXpSnapshots.trackId, trackId),
      eq(rewardTrackXpSnapshots.profileId, profileId),
    ),
  });

  const now = new Date().toISOString();
  if (existingSnapshot) {
    await db
      .update(rewardTrackXpSnapshots)
      .set({ xpEarned, lastUpdatedAt: now })
      .where(
        and(
          eq(rewardTrackXpSnapshots.trackId, trackId),
          eq(rewardTrackXpSnapshots.profileId, profileId),
        ),
      );
  } else {
    await db.insert(rewardTrackXpSnapshots).values({
      id: crypto.randomUUID(),
      trackId,
      profileId,
      xpEarned,
      lastUpdatedAt: now,
    });
  }

  // Check tiers and auto-insert unclaimed claim rows for newly reached tiers
  const tiers = await db.query.rewardTiers.findMany({
    where: eq(rewardTiers.trackId, trackId),
    orderBy: (t, { asc }) => [asc(t.tierNumber)],
  });

  const existingClaims = await db.query.rewardClaims.findMany({
    where: and(
      eq(rewardClaims.trackId, trackId),
      eq(rewardClaims.profileId, profileId),
    ),
    columns: { tierId: true },
  });
  const claimedTierIds = new Set(existingClaims.map((c) => c.tierId));

  const newlyUnlockedTierIds: string[] = [];
  for (const tier of tiers) {
    if (xpEarned >= tier.xpThreshold && !claimedTierIds.has(tier.id)) {
      await db.insert(rewardClaims).values({
        id: crypto.randomUUID(),
        tierId: tier.id,
        trackId,
        profileId,
        organizationId,
        status: "unclaimed",
        createdAt: now,
        updatedAt: now,
      });
      newlyUnlockedTierIds.push(tier.id);
    }
  }

  return { xpEarned, newlyUnlockedTierIds };
}

// ── Parent read: all tracks for org ──────────────────────────────────────────

export const getRewardTracksForOrg = createServerFn({ method: "GET" }).handler(async () => {
  const session = await requireActiveRole(["admin", "parent"]);
  const db = getDb();

  const organizationId = await resolveActiveOrganizationId(
    session.user.id,
    session.session.activeOrganizationId,
  );

  const tracks = await db.query.rewardTracks.findMany({
    where: eq(rewardTracks.organizationId, organizationId),
    orderBy: (t, { desc: d, asc: a }) => [d(t.isActive), d(t.updatedAt)],
  });

  const results = await Promise.all(
    tracks.map(async (track) => {
      const [profile, tiers, snapshot, pendingClaimRows] = await Promise.all([
        db.query.profiles.findFirst({
          where: eq(profiles.id, track.profileId),
          columns: { id: true, displayName: true },
        }),
        db.query.rewardTiers.findMany({
          where: eq(rewardTiers.trackId, track.id),
          orderBy: (t, { asc: a }) => [a(t.tierNumber)],
        }),
        db.query.rewardTrackXpSnapshots.findFirst({
          where: and(
            eq(rewardTrackXpSnapshots.trackId, track.id),
            eq(rewardTrackXpSnapshots.profileId, track.profileId),
          ),
        }),
        db.query.rewardClaims.findMany({
          where: and(
            eq(rewardClaims.trackId, track.id),
            eq(rewardClaims.status, "claimed"),
          ),
          columns: { id: true },
        }),
      ]);

      return {
        ...track,
        profile: profile ?? null,
        tiers,
        snapshot: snapshot ?? null,
        pendingClaimsCount: pendingClaimRows.length,
      };
    }),
  );

  return results;
});

// ── Parent read: single track detail ─────────────────────────────────────────

const getRewardTrackDetailInput = z.object({ trackId: z.string() });

export const getRewardTrackDetail = createServerFn({ method: "GET" })
  .inputValidator((data) => getRewardTrackDetailInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const track = await db.query.rewardTracks.findFirst({
      where: and(
        eq(rewardTracks.id, data.trackId),
        eq(rewardTracks.organizationId, organizationId),
      ),
    });
    if (!track) throw new Error("NOT_FOUND");

    const [profile, tiers, claims, snapshot] = await Promise.all([
      db.query.profiles.findFirst({
        where: eq(profiles.id, track.profileId),
        columns: { id: true, displayName: true, gradeLevel: true },
      }),
      db.query.rewardTiers.findMany({
        where: eq(rewardTiers.trackId, track.id),
        orderBy: (t, { asc: a }) => [a(t.tierNumber)],
      }),
      db.query.rewardClaims.findMany({
        where: eq(rewardClaims.trackId, track.id),
      }),
      db.query.rewardTrackXpSnapshots.findFirst({
        where: and(
          eq(rewardTrackXpSnapshots.trackId, track.id),
          eq(rewardTrackXpSnapshots.profileId, track.profileId),
        ),
      }),
    ]);

    // Join claims with profile display names
    const claimsWithProfile = claims.map((claim) => ({
      ...claim,
      profile: profile && claim.profileId === profile.id
        ? { displayName: profile.displayName }
        : null,
    }));

    return {
      track,
      tiers,
      claims: claimsWithProfile,
      snapshot: snapshot ?? null,
      profile: profile ?? null,
    };
  });

// ── Parent write: create track ────────────────────────────────────────────────

const createRewardTrackInput = z.object({
  profileId: z.string(),
  title: z.string().min(1),
  description: z.string().optional(),
  schoolYear: z.string().optional(),
  totalXpGoal: z.number().int().positive().optional(),
  tiers: z.array(
    z.object({
      tierNumber: z.number().int().min(1),
      title: z.string().min(1),
      description: z.string().optional(),
      icon: z.string().optional(),
      rewardType: z.string().optional(),
      estimatedValue: z.string().optional(),
      isBonusTier: z.boolean().optional(),
      xpThreshold: z.number().int().nonnegative().optional(),
      imageUrl: z.string().optional(),
    }),
  ),
});

function computeRewardTierThreshold(input: {
  tierNumber: number;
  totalXpGoal: number;
  isBonusTier?: boolean;
}) {
  if (input.isBonusTier || input.tierNumber > 5) {
    return Math.round(input.totalXpGoal * 1.2);
  }

  return Math.round((input.tierNumber / 5) * input.totalXpGoal);
}

export const createRewardTrack = createServerFn({ method: "POST" })
  .inputValidator((data) => createRewardTrackInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    // Verify the profile belongs to this org
    const profile = await db.query.profiles.findFirst({
      where: and(
        eq(profiles.id, data.profileId),
        eq(profiles.organizationId, organizationId),
      ),
    });
    if (!profile) throw new Error("FORBIDDEN");

    const totalXpGoal = data.totalXpGoal ?? 5000;
    const now = new Date().toISOString();
    const trackId = crypto.randomUUID();

    await db.insert(rewardTracks).values({
      id: trackId,
      organizationId,
      profileId: data.profileId,
      createdByUserId: session.user.id,
      title: data.title,
      description: data.description ?? null,
      schoolYear: data.schoolYear ?? null,
      totalXpGoal,
      isActive: false,
      createdAt: now,
      updatedAt: now,
    });

    const tierRows = data.tiers.map((tier) => ({
      id: crypto.randomUUID(),
      trackId,
      organizationId,
      tierNumber: tier.tierNumber,
      xpThreshold: tier.xpThreshold ?? computeRewardTierThreshold({
        tierNumber: tier.tierNumber,
        totalXpGoal,
        isBonusTier: tier.isBonusTier,
      }),
      title: tier.title,
      description: tier.description ?? null,
      icon: tier.icon ?? "🎁",
      rewardType: tier.rewardType ?? "treat",
      estimatedValue: tier.estimatedValue ?? null,
      isBonusTier: tier.isBonusTier ?? false,
      imageUrl: tier.imageUrl ?? null,
      createdAt: now,
      updatedAt: now,
    }));

    if (tierRows.length > 0) {
      await db.insert(rewardTiers).values(tierRows);
    }

    return { trackId, tierCount: tierRows.length };
  });

// ── Parent write: update track ────────────────────────────────────────────────

const updateRewardTrackInput = z.object({
  trackId: z.string(),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  schoolYear: z.string().optional(),
  totalXpGoal: z.number().int().positive().optional(),
});

export const updateRewardTrack = createServerFn({ method: "POST" })
  .inputValidator((data) => updateRewardTrackInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const track = await db.query.rewardTracks.findFirst({
      where: and(
        eq(rewardTracks.id, data.trackId),
        eq(rewardTracks.organizationId, organizationId),
      ),
    });
    if (!track) throw new Error("NOT_FOUND");

    const now = new Date().toISOString();
    const updates: Partial<typeof rewardTracks.$inferInsert> = { updatedAt: now };
    if (data.title !== undefined) updates.title = data.title;
    if (data.description !== undefined) updates.description = data.description;
    if (data.schoolYear !== undefined) updates.schoolYear = data.schoolYear;
    if (data.totalXpGoal !== undefined) updates.totalXpGoal = data.totalXpGoal;

    await db
      .update(rewardTracks)
      .set(updates)
      .where(eq(rewardTracks.id, data.trackId));

    return db.query.rewardTracks.findFirst({ where: eq(rewardTracks.id, data.trackId) });
  });

// ── Parent write: upsert tier ─────────────────────────────────────────────────

const upsertRewardTierInput = z.object({
  trackId: z.string(),
  tierId: z.string().optional(),
  tierNumber: z.number().int().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  icon: z.string().optional(),
  rewardType: z.string().optional(),
  estimatedValue: z.string().optional(),
  xpThreshold: z.number().int().nonnegative().optional(),
  isBonusTier: z.boolean().optional(),
  imageUrl: z.string().optional(),
});

export const upsertRewardTier = createServerFn({ method: "POST" })
  .inputValidator((data) => upsertRewardTierInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const track = await db.query.rewardTracks.findFirst({
      where: and(
        eq(rewardTracks.id, data.trackId),
        eq(rewardTracks.organizationId, organizationId),
      ),
    });
    if (!track) throw new Error("NOT_FOUND");

    const now = new Date().toISOString();
    const threshold = data.xpThreshold ?? computeRewardTierThreshold({
      tierNumber: data.tierNumber,
      totalXpGoal: track.totalXpGoal,
      isBonusTier: data.isBonusTier,
    });

    if (data.tierId) {
      await db
        .update(rewardTiers)
        .set({
          tierNumber: data.tierNumber,
          title: data.title,
          description: data.description ?? null,
          icon: data.icon ?? "🎁",
          rewardType: data.rewardType ?? "treat",
          estimatedValue: data.estimatedValue ?? null,
          xpThreshold: threshold,
          isBonusTier: data.isBonusTier ?? false,
          ...(data.imageUrl !== undefined ? { imageUrl: data.imageUrl } : {}),
          updatedAt: now,
        })
        .where(eq(rewardTiers.id, data.tierId));
      return db.query.rewardTiers.findFirst({ where: eq(rewardTiers.id, data.tierId) });
    }

    const tierId = crypto.randomUUID();
    await db.insert(rewardTiers).values({
      id: tierId,
      trackId: data.trackId,
      organizationId,
      tierNumber: data.tierNumber,
      xpThreshold: threshold,
      title: data.title,
      description: data.description ?? null,
      icon: data.icon ?? "🎁",
      rewardType: data.rewardType ?? "treat",
      estimatedValue: data.estimatedValue ?? null,
      isBonusTier: data.isBonusTier ?? false,
      imageUrl: data.imageUrl ?? null,
      createdAt: now,
      updatedAt: now,
    });
    return db.query.rewardTiers.findFirst({ where: eq(rewardTiers.id, tierId) });
  });

// ── Parent write: delete tier ─────────────────────────────────────────────────

const deleteRewardTierInput = z.object({ tierId: z.string() });

export const deleteRewardTier = createServerFn({ method: "POST" })
  .inputValidator((data) => deleteRewardTierInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const tier = await db.query.rewardTiers.findFirst({
      where: eq(rewardTiers.id, data.tierId),
    });
    if (!tier) throw new Error("NOT_FOUND");

    // Verify the tier's track belongs to this org
    const track = await db.query.rewardTracks.findFirst({
      where: and(
        eq(rewardTracks.id, tier.trackId),
        eq(rewardTracks.organizationId, organizationId),
      ),
    });
    if (!track) throw new Error("FORBIDDEN");

    await db.delete(rewardClaims).where(eq(rewardClaims.tierId, data.tierId));
    await db.delete(rewardTiers).where(eq(rewardTiers.id, data.tierId));

    return { success: true };
  });

// ── Parent write: upload reward tier image ────────────────────────────────────

const uploadRewardImageInput = z.object({
  tierId: z.string(),
  // base64-encoded image data (without data URL prefix)
  base64: z.string().min(1),
  mimeType: z.string().min(1),
});

export const uploadRewardImage = createServerFn({ method: "POST" })
  .inputValidator((data) => uploadRewardImageInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const tier = await db.query.rewardTiers.findFirst({
      where: eq(rewardTiers.id, data.tierId),
    });
    if (!tier) throw new Error("NOT_FOUND");

    const track = await db.query.rewardTracks.findFirst({
      where: and(
        eq(rewardTracks.id, tier.trackId),
        eq(rewardTracks.organizationId, organizationId),
      ),
    });
    if (!track) throw new Error("FORBIDDEN");

    // Store in R2 under rewards/ prefix
    const ext = data.mimeType.split("/")[1] ?? "jpg";
    const key = `rewards/${organizationId}/${data.tierId}.${ext}`;
    const bytes = Uint8Array.from(atob(data.base64), (c) => c.charCodeAt(0));
    await env.BUCKET.put(key, bytes, {
      httpMetadata: { contentType: data.mimeType },
    });

    // Retrieve and return as a data URL so it can be displayed without a public CDN
    const obj = await env.BUCKET.get(key);
    if (!obj) throw new Error("Upload failed");
    const buf = await obj.arrayBuffer();
    const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    const dataUrl = `data:${data.mimeType};base64,${b64}`;

    // Persist data URL on the tier row
    const now = new Date().toISOString();
    await db.update(rewardTiers).set({ imageUrl: dataUrl, updatedAt: now }).where(eq(rewardTiers.id, data.tierId));

    return { dataUrl };
  });

// ── Parent write: activate track ──────────────────────────────────────────────

const activateRewardTrackInput = z.object({ trackId: z.string() });

export const activateRewardTrack = createServerFn({ method: "POST" })
  .inputValidator((data) => activateRewardTrackInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const track = await db.query.rewardTracks.findFirst({
      where: and(
        eq(rewardTracks.id, data.trackId),
        eq(rewardTracks.organizationId, organizationId),
      ),
    });
    if (!track) throw new Error("NOT_FOUND");

    const now = new Date().toISOString();

    // a) Deactivate all other tracks for this profile
    await db
      .update(rewardTracks)
      .set({ isActive: false, updatedAt: now })
      .where(
        and(
          eq(rewardTracks.profileId, track.profileId),
          eq(rewardTracks.organizationId, organizationId),
        ),
      );

    // b) Activate this track
    await db
      .update(rewardTracks)
      .set({ isActive: true, startedAt: now, updatedAt: now })
      .where(eq(rewardTracks.id, data.trackId));

    // c) Insert/reset snapshot at 0 (syncTrackXp will fill it in)
    const existingSnapshot = await db.query.rewardTrackXpSnapshots.findFirst({
      where: and(
        eq(rewardTrackXpSnapshots.trackId, data.trackId),
        eq(rewardTrackXpSnapshots.profileId, track.profileId),
      ),
    });
    if (!existingSnapshot) {
      await db.insert(rewardTrackXpSnapshots).values({
        id: crypto.randomUUID(),
        trackId: data.trackId,
        profileId: track.profileId,
        xpEarned: 0,
        lastUpdatedAt: now,
      });
    }

    // d+e) Sync XP immediately
    const syncResult = await syncTrackXp(
      db,
      data.trackId,
      track.profileId,
      organizationId,
    );

    return {
      success: true,
      xpEarned: syncResult.xpEarned,
      newlyUnlockedTierIds: syncResult.newlyUnlockedTierIds,
    };
  });

// ── Parent write: deactivate track ────────────────────────────────────────────

const deactivateRewardTrackInput = z.object({ trackId: z.string() });

export const deactivateRewardTrack = createServerFn({ method: "POST" })
  .inputValidator((data) => deactivateRewardTrackInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const track = await db.query.rewardTracks.findFirst({
      where: and(
        eq(rewardTracks.id, data.trackId),
        eq(rewardTracks.organizationId, organizationId),
      ),
    });
    if (!track) throw new Error("NOT_FOUND");

    const now = new Date().toISOString();
    await db
      .update(rewardTracks)
      .set({ isActive: false, completedAt: now, updatedAt: now })
      .where(eq(rewardTracks.id, data.trackId));

    return { success: true };
  });

// ── Parent write: deliver reward ──────────────────────────────────────────────

const deliverRewardInput = z.object({
  claimId: z.string(),
  parentNote: z.string().optional(),
});

export const deliverReward = createServerFn({ method: "POST" })
  .inputValidator((data) => deliverRewardInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const claim = await db.query.rewardClaims.findFirst({
      where: and(
        eq(rewardClaims.id, data.claimId),
        eq(rewardClaims.organizationId, organizationId),
      ),
    });
    if (!claim) throw new Error("NOT_FOUND");

    const now = new Date().toISOString();
    await db
      .update(rewardClaims)
      .set({
        status: "delivered",
        deliveredAt: now,
        deliveredByUserId: session.user.id,
        parentNote: data.parentNote ?? null,
        updatedAt: now,
      })
      .where(eq(rewardClaims.id, data.claimId));

    return db.query.rewardClaims.findFirst({ where: eq(rewardClaims.id, data.claimId) });
  });

const setRewardClaimDeliveredInput = z.object({
  claimId: z.string(),
  delivered: z.boolean(),
  parentNote: z.string().optional(),
});

export const setRewardClaimDelivered = createServerFn({ method: "POST" })
  .inputValidator((data) => setRewardClaimDeliveredInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const claim = await db.query.rewardClaims.findFirst({
      where: and(
        eq(rewardClaims.id, data.claimId),
        eq(rewardClaims.organizationId, organizationId),
      ),
    });
    if (!claim) throw new Error("NOT_FOUND");
    if (claim.status !== "claimed" && claim.status !== "delivered") {
      throw new Error("INVALID_STATUS");
    }

    const now = new Date().toISOString();
    if (data.delivered) {
      await db
        .update(rewardClaims)
        .set({
          status: "delivered",
          deliveredAt: now,
          deliveredByUserId: session.user.id,
          parentNote: data.parentNote ?? claim.parentNote ?? null,
          updatedAt: now,
        })
        .where(eq(rewardClaims.id, data.claimId));
    } else {
      await db
        .update(rewardClaims)
        .set({
          status: "claimed",
          deliveredAt: null,
          deliveredByUserId: null,
          updatedAt: now,
        })
        .where(eq(rewardClaims.id, data.claimId));
    }

    return db.query.rewardClaims.findFirst({ where: eq(rewardClaims.id, data.claimId) });
  });

// ── Student: get active reward track ─────────────────────────────────────────

const getActiveRewardTrackForStudentInput = z.object({ profileId: z.string() });

export const getActiveRewardTrackForStudent = createServerFn({ method: "GET" })
  .inputValidator((data) => getActiveRewardTrackForStudentInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent", "student"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const track = await db.query.rewardTracks.findFirst({
      where: and(
        eq(rewardTracks.profileId, data.profileId),
        eq(rewardTracks.isActive, true),
      ),
    });
    if (!track) return null;

    const [tiers, claims, snapshot] = await Promise.all([
      db.query.rewardTiers.findMany({
        where: eq(rewardTiers.trackId, track.id),
        orderBy: (t, { asc: a }) => [a(t.tierNumber)],
      }),
      db.query.rewardClaims.findMany({
        where: and(
          eq(rewardClaims.trackId, track.id),
          eq(rewardClaims.profileId, data.profileId),
        ),
      }),
      db.query.rewardTrackXpSnapshots.findFirst({
        where: and(
          eq(rewardTrackXpSnapshots.trackId, track.id),
          eq(rewardTrackXpSnapshots.profileId, data.profileId),
        ),
      }),
    ]);

    // Sync XP to get fresh value
    const syncResult = await syncTrackXp(db, track.id, data.profileId, organizationId);

    return {
      track,
      tiers,
      claims,
      xpEarned: syncResult.xpEarned,
      newlyUnlockedTierIds: syncResult.newlyUnlockedTierIds,
    };
  });

// ── Student: claim reward ─────────────────────────────────────────────────────

const claimRewardInput = z.object({
  tierId: z.string(),
  profileId: z.string(),
});

export const claimReward = createServerFn({ method: "POST" })
  .inputValidator((data) => claimRewardInput.parse(data))
  .handler(async ({ data }) => {
    await requireActiveRole(["admin", "parent", "student"]);
    const db = getDb();

    const tier = await db.query.rewardTiers.findFirst({
      where: eq(rewardTiers.id, data.tierId),
    });
    if (!tier) throw new Error("NOT_FOUND");

    // Verify the track is active for this profile
    const track = await db.query.rewardTracks.findFirst({
      where: and(
        eq(rewardTracks.id, tier.trackId),
        eq(rewardTracks.profileId, data.profileId),
        eq(rewardTracks.isActive, true),
      ),
    });
    if (!track) throw new Error("TIER_NOT_UNLOCKED");

    // Find existing unclaimed claim row
    const claim = await db.query.rewardClaims.findFirst({
      where: and(
        eq(rewardClaims.tierId, data.tierId),
        eq(rewardClaims.profileId, data.profileId),
      ),
    });

    if (!claim || claim.status !== "unclaimed") {
      throw new Error("TIER_NOT_UNLOCKED");
    }

    const now = new Date().toISOString();
    await db
      .update(rewardClaims)
      .set({ status: "claimed", claimedAt: now, updatedAt: now })
      .where(eq(rewardClaims.id, claim.id));

    return { success: true, tier };
  });

// ── AI: suggest rewards ───────────────────────────────────────────────────────

const aiSuggestRewardsInput = z.object({ profileId: z.string() });

export const aiSuggestRewards = createServerFn({ method: "POST" })
  .inputValidator((data) => aiSuggestRewardsInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const profile = await db.query.profiles.findFirst({
      where: and(
        eq(profiles.id, data.profileId),
        eq(profiles.organizationId, organizationId),
      ),
    });
    if (!profile) throw new Error("NOT_FOUND");

    const suggestions = await generateRewardSuggestions({
      gradeLevel: profile.gradeLevel ?? "unknown",
      studentName: profile.displayName,
      location: profile.location ?? undefined,
      count: 10,
    });

    return suggestions;
  });

// ── AI: suggest rewards for a single tier + fetch image ───────────────────────

const aiSuggestTierRewardInput = z.object({
  profileId: z.string(),
  tierNumber: z.number().int().min(1),
  count: z.number().int().min(1).max(8).default(5),
  steeringPrompt: z.string().max(200).optional(),
});

export const aiSuggestTierReward = createServerFn({ method: "POST" })
  .inputValidator((data) => aiSuggestTierRewardInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const profile = await db.query.profiles.findFirst({
      where: and(
        eq(profiles.id, data.profileId),
        eq(profiles.organizationId, organizationId),
      ),
    });
    if (!profile) throw new Error("NOT_FOUND");

    const suggestions = await generateRewardSuggestionForTier({
      tierNumber: data.tierNumber,
      gradeLevel: profile.gradeLevel ?? "unknown",
      studentName: profile.displayName,
      location: profile.location ?? undefined,
      steeringPrompt: data.steeringPrompt?.trim() || undefined,
      count: data.count,
    });

    // Fetch a photo from Unsplash Source (no API key needed) for each suggestion.
    // We request a small 200×200 image and convert it to a data URL so it can be
    // stored directly without a separate CDN endpoint.
    const withImages = await Promise.all(
      suggestions.map(async (s) => {
        try {
          const query = encodeURIComponent(s.imageSearchQuery);
          // Unsplash Source returns a random matching photo — deterministic enough
          // for a preview. Using 200×200 keeps payload small.
          const url = `https://source.unsplash.com/200x200/?${query}`;
          const resp = await fetch(url, { redirect: "follow" });
          if (!resp.ok) return { ...s, imageUrl: null };
          const buf = await resp.arrayBuffer();
          const mime = resp.headers.get("content-type") ?? "image/jpeg";
          const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
          return { ...s, imageUrl: `data:${mime};base64,${b64}` };
        } catch {
          return { ...s, imageUrl: null };
        }
      }),
    );

    return withImages;
  });

// ─── Marking Periods ──────────────────────────────────────────────────────────

export const getMarkingPeriods = createServerFn({ method: "GET" }).handler(async () => {
  const session = await requireActiveRole(["parent", "admin"]);
  const db = getDb();
  const organizationId = await resolveActiveOrganizationId(
    session.user.id,
    session.session.activeOrganizationId,
  );
  const periods = await db.query.markingPeriods.findMany({
    where: eq(markingPeriods.organizationId, organizationId),
    orderBy: [markingPeriods.periodNumber],
  });
  return periods;
});

const createMarkingPeriodsInput = z.object({
  count: z.union([z.literal(2), z.literal(3), z.literal(4)]),
  schoolYear: z.string().min(1),
});

// Default date ranges for 2025-2026 school year
function getDefaultPeriodDates(count: 2 | 3 | 4, schoolYear: string) {
  const [startYearStr] = schoolYear.split("-");
  const sy = parseInt(startYearStr ?? "2025", 10);
  if (count === 2) {
    return [
      { label: "S1", title: "First Semester", start: `${sy}-09-01`, end: `${sy}-01-16` },
      { label: "S2", title: "Second Semester", start: `${sy}-01-20`, end: `${sy + 1}-06-13` },
    ];
  }
  if (count === 3) {
    return [
      { label: "T1", title: "First Trimester", start: `${sy}-09-01`, end: `${sy}-11-28` },
      { label: "T2", title: "Second Trimester", start: `${sy}-12-02`, end: `${sy + 1}-03-06` },
      { label: "T3", title: "Third Trimester", start: `${sy + 1}-03-10`, end: `${sy + 1}-06-13` },
    ];
  }
  return [
    { label: "Q1", title: "First Quarter", start: `${sy}-09-01`, end: `${sy}-11-14` },
    { label: "Q2", title: "Second Quarter", start: `${sy}-11-17`, end: `${sy + 1}-01-30` },
    { label: "Q3", title: "Third Quarter", start: `${sy + 1}-02-02`, end: `${sy + 1}-04-11` },
    { label: "Q4", title: "Fourth Quarter", start: `${sy + 1}-04-14`, end: `${sy + 1}-06-13` },
  ];
}

export const createMarkingPeriods = createServerFn({ method: "POST" })
  .inputValidator((data) => createMarkingPeriodsInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["parent", "admin"]);
    const db = getDb();
    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );
    const now = new Date().toISOString();
    const periodDates = getDefaultPeriodDates(data.count, data.schoolYear);
    const today = new Date().toISOString().slice(0, 10);
    const rows = periodDates.map((p, i) => {
      let status: "upcoming" | "active" | "completed" = "upcoming";
      if (today > p.end) status = "completed";
      else if (today >= p.start) status = "active";
      return {
        id: crypto.randomUUID(),
        organizationId,
        label: p.label,
        title: p.title,
        periodNumber: i + 1,
        startDate: p.start,
        endDate: p.end,
        schoolYear: data.schoolYear,
        status,
        createdAt: now,
        updatedAt: now,
      };
    });
    for (const row of rows) {
      await db.insert(markingPeriods).values(row);
    }
    return { success: true, periods: rows };
  });

const updateMarkingPeriodInput = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(80).optional(),
  label: z.string().min(1).max(10).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  status: z.enum(["upcoming", "active", "completed"]).optional(),
});

export const updateMarkingPeriod = createServerFn({ method: "POST" })
  .inputValidator((data) => updateMarkingPeriodInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["parent", "admin"]);
    const db = getDb();
    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );
    const period = await db.query.markingPeriods.findFirst({
      where: and(eq(markingPeriods.id, data.id), eq(markingPeriods.organizationId, organizationId)),
    });
    if (!period) throw new Error("NOT_FOUND");
    await db
      .update(markingPeriods)
      .set({
        ...(data.title !== undefined && { title: data.title }),
        ...(data.label !== undefined && { label: data.label }),
        ...(data.startDate !== undefined && { startDate: data.startDate }),
        ...(data.endDate !== undefined && { endDate: data.endDate }),
        ...(data.status !== undefined && { status: data.status }),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(markingPeriods.id, data.id));
    return { success: true };
  });

const deleteMarkingPeriodInput = z.object({ id: z.string().min(1) });

export const deleteMarkingPeriod = createServerFn({ method: "POST" })
  .inputValidator((data) => deleteMarkingPeriodInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["parent", "admin"]);
    const db = getDb();
    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );
    const period = await db.query.markingPeriods.findFirst({
      where: and(eq(markingPeriods.id, data.id), eq(markingPeriods.organizationId, organizationId)),
    });
    if (!period) throw new Error("NOT_FOUND");
    await db.delete(markingPeriods).where(eq(markingPeriods.id, data.id));
    return { success: true };
  });

const assignClassToMarkingPeriodInput = z.object({
  classId: z.string().min(1),
  markingPeriodId: z.string().min(1).nullable(),
});

export const assignClassToMarkingPeriod = createServerFn({ method: "POST" })
  .inputValidator((data) => assignClassToMarkingPeriodInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["parent", "admin"]);
    const db = getDb();
    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );
    const cls = await db.query.classes.findFirst({
      where: and(eq(classes.id, data.classId), eq(classes.organizationId, organizationId)),
    });
    if (!cls) throw new Error("NOT_FOUND");
    await db
      .update(classes)
      .set({ markingPeriodId: data.markingPeriodId, updatedAt: new Date().toISOString() })
      .where(eq(classes.id, data.classId));
    return { success: true };
  });

const assignAssignmentToMarkingPeriodInput = z.object({
  assignmentId: z.string().min(1),
  markingPeriodId: z.string().min(1).nullable(),
});

export const assignAssignmentToMarkingPeriod = createServerFn({ method: "POST" })
  .inputValidator((data) => assignAssignmentToMarkingPeriodInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["parent", "admin"]);
    const db = getDb();
    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );
    const assignment = await db.query.assignments.findFirst({
      where: and(
        eq(assignments.id, data.assignmentId),
        eq(assignments.organizationId, organizationId),
      ),
    });
    if (!assignment) throw new Error("NOT_FOUND");
    await db
      .update(assignments)
      .set({ markingPeriodId: data.markingPeriodId, updatedAt: new Date().toISOString() })
      .where(eq(assignments.id, data.assignmentId));
    return { success: true };
  });

// ─── Rich Demo Seed (Phased) ──────────────────────────────────────────────────

const richDemoSeedWithPinInput = z.object({
  parentPin: z.string().regex(/^\d{4,6}$/),
});

const RICH_DEMO_SCHOOL_YEAR = "2025-2026";

// Keep in sync with DEMO_STUDENTS above.
const RICH_DEMO_STUDENTS = [
  {
    displayName: "Ava Rivers",
    gradeLevel: "4",
    performanceTier: "high" as const,
    location: "Raleigh, NC",
    rewardTheme: "disney" as const,
    includeBonusTier: false,
    rewardSteering: "Disney current inspired by Lilo and Stitch style family-friendly rewards.",
  },
  {
    displayName: "Leo Martinez",
    gradeLevel: "5",
    performanceTier: "medium" as const,
    location: "Orlando, FL",
    rewardTheme: "food" as const,
    includeBonusTier: false,
    rewardSteering: "Food current with fun local treats and a great family dinner as the top regular tier.",
  },
  {
    displayName: "Noah Chen",
    gradeLevel: "6",
    performanceTier: "high" as const,
    location: "Austin, TX",
    rewardTheme: "pokemon" as const,
    includeBonusTier: true,
    rewardSteering: "Pokemon current with collectible rewards and activity experiences.",
  },
  {
    displayName: "Mia Patel",
    gradeLevel: "8",
    performanceTier: "medium" as const,
    location: "Seattle, WA",
    rewardTheme: "tech" as const,
    includeBonusTier: true,
    rewardSteering: "Tech current with gaming/devices progression; includes ideas like Ninja Turtles, cars, and fandom variants in low tiers.",
  },
];

const RICH_DEMO_SUBJECTS_BY_GRADE: Record<string, string[]> = {
  "4": ["Math", "Language Arts"],
  "5": ["Math", "Language Arts", "Science"],
  "6": ["Math", "Earth Science", "US History"],
  "8": ["Pre-Algebra", "Literature", "Life Science"],
};

const RICH_DEMO_MARKING_PERIODS = [
  { label: "Q1", title: "First Quarter", periodNumber: 1, startDate: "2025-09-01", endDate: "2025-11-14", status: "completed" as const },
  { label: "Q2", title: "Second Quarter", periodNumber: 2, startDate: "2025-11-17", endDate: "2026-01-30", status: "completed" as const },
  { label: "Q3", title: "Third Quarter", periodNumber: 3, startDate: "2026-02-02", endDate: "2026-04-11", status: "active" as const },
  { label: "Q4", title: "Fourth Quarter", periodNumber: 4, startDate: "2026-04-14", endDate: "2026-06-13", status: "upcoming" as const },
];

// Exported preview so the settings UI can display accurate counts before seeding.
export const RICH_DEMO_SEED_PREVIEW = (() => {
  const totalCourses = RICH_DEMO_STUDENTS.reduce(
    (sum, s) => sum + (RICH_DEMO_SUBJECTS_BY_GRADE[s.gradeLevel]?.length ?? 0),
    0,
  );
  return {
    students: RICH_DEMO_STUDENTS.map((s) => ({
      name: s.displayName,
      grade: s.gradeLevel,
      subjects: RICH_DEMO_SUBJECTS_BY_GRADE[s.gradeLevel] ?? [],
      tier: s.performanceTier,
      location: s.location,
      rewardTheme: s.rewardTheme,
    })),
    totalStudents: RICH_DEMO_STUDENTS.length,
    totalCourses,
    markingPeriods: RICH_DEMO_MARKING_PERIODS.map((mp) => mp.label),
    schoolYear: RICH_DEMO_SCHOOL_YEAR,
    studentPin: "1111",
  };
})();

// Returns a deterministic score based on performance tier and index
function getDemoScore(tier: "high" | "medium" | "low", seed: number): number {
  const bases: Record<string, number> = { high: 88, medium: 76, low: 65 };
  const variance = (seed % 5) * 3;
  return Math.min(100, (bases[tier] ?? 75) + variance - 4);
}

function getDemoDueDate(periodIndex: number, assignmentIndex: number): string {
  const periodStarts = ["2025-09-01", "2025-11-17", "2026-02-02", "2026-04-14"];
  const base = new Date(periodStarts[periodIndex] ?? "2025-09-01");
  base.setDate(base.getDate() + (assignmentIndex * 5));
  return base.toISOString().slice(0, 10);
}

function buildRichDemoAssignments(
  subject: string,
  gradeLevel: string,
  studentName: string,
  periodLabel: string,
): Array<{ title: string; description: string; contentType: "text" | "video" | "quiz" | "essay_questions" | "report"; contentRef: string | null; isVideo?: boolean }> {
  const grade = parseInt(gradeLevel, 10);
  const prefix = `${periodLabel} ·`;

  if (subject === "Math" || subject === "Pre-Algebra" || subject === "Algebra I") {
    const topics = grade <= 4
      ? ["Number Sense", "Addition & Subtraction", "Multiplication Basics", "Fractions Intro", "Shapes & Geometry"]
      : grade <= 6
      ? ["Fractions & Decimals", "Order of Operations", "Ratios & Proportions", "Integers", "Basic Algebra"]
      : ["Linear Equations", "Inequalities", "Slope & Graphing", "Systems of Equations", "Functions"];
    const topic = topics[parseInt(periodLabel.replace(/\D/g, ""), 10) % topics.length] ?? topics[0];
    return [
      { title: `${prefix} ${topic} — Video Lesson`, description: `Watch and learn ${topic} for Grade ${gradeLevel}.`, contentType: "video", contentRef: JSON.stringify({ videos: [{ videoId: "dQw4w9WgXcQ", title: `${topic} Explained`, channel: "Math Academy", description: `Learn ${topic}` }] }), isVideo: true },
      { title: `${prefix} ${topic} — Quiz`, description: `Test your knowledge of ${topic}.`, contentType: "quiz", contentRef: JSON.stringify({ questions: [{ id: "q1", question: `What is a key concept in ${topic}?`, options: ["Option A", "Option B", "Option C", "Option D"], answerIndex: 0, explanation: "Option A is correct." }, { id: "q2", question: "Solve the practice problem:", options: ["12", "14", "16", "18"], answerIndex: 1, explanation: "The answer is 14." }] }), isVideo: false },
      { title: `${prefix} ${topic} — Practice Problems`, description: `${studentName} completes written practice for ${topic}.`, contentType: "text", contentRef: `<h2>${topic} Practice</h2><p>Complete the following problems in your notebook and submit a photo or written summary.</p><ol><li>Problem 1</li><li>Problem 2</li><li>Problem 3</li></ol>`, isVideo: false },
    ];
  }

  if (subject === "Language Arts" || subject === "English 9") {
    const topics = ["Reading Comprehension", "Grammar Foundations", "Writing Workshop", "Vocabulary Building", "Literary Analysis"];
    const topic = topics[parseInt(periodLabel.replace(/\D/g, ""), 10) % topics.length] ?? topics[0];
    return [
      { title: `${prefix} ${topic} — Reading`, description: `Read and annotate the passage for ${topic}.`, contentType: "text", contentRef: `<h2>${topic}</h2><p>Read the following passage carefully and annotate as you go.</p><blockquote><p>Sample literary text for Grade ${gradeLevel}...</p></blockquote>`, isVideo: false },
      { title: `${prefix} ${topic} — Essay`, description: `Write a short essay responding to the reading.`, contentType: "essay_questions", contentRef: JSON.stringify({ questions: [`What is the main idea of the passage? Support with evidence.`, `How does the author develop the theme? Give two examples.`, `What connections can you make to your own life?`] }), isVideo: false },
      { title: `${prefix} ${topic} — Vocabulary Quiz`, description: `Demonstrate mastery of key vocabulary.`, contentType: "quiz", contentRef: JSON.stringify({ questions: [{ id: "q1", question: "What does 'annotate' mean?", options: ["To read quickly", "To add notes and comments", "To summarize", "To memorize"], answerIndex: 1, explanation: "Annotate means to add notes or comments." }] }), isVideo: false },
    ];
  }

  if (subject === "Science" || subject === "Life Science" || subject === "Earth Science" || subject === "Biology") {
    const topics = grade <= 5
      ? ["Living Things", "Plant Life Cycles", "Weather & Climate", "Simple Machines", "Matter & Energy"]
      : ["Cell Structure", "Ecosystems", "Earth's Layers", "Chemical Reactions", "Genetics Intro"];
    const topic = topics[parseInt(periodLabel.replace(/\D/g, ""), 10) % topics.length] ?? topics[0];
    return [
      { title: `${prefix} ${topic} — Video Lesson`, description: `Explore ${topic} in this video lesson.`, contentType: "video", contentRef: JSON.stringify({ videos: [{ videoId: "dQw4w9WgXcQ", title: `${topic} Overview`, channel: "Science Explorer", description: `Introduction to ${topic}` }] }), isVideo: true },
      { title: `${prefix} ${topic} — Lab Report`, description: `Document your observations for the ${topic} lab activity.`, contentType: "report", contentRef: null, isVideo: false },
      { title: `${prefix} ${topic} — Comprehension Quiz`, description: `Check understanding of ${topic}.`, contentType: "quiz", contentRef: JSON.stringify({ questions: [{ id: "q1", question: `Which of these best describes ${topic}?`, options: ["Definition A", "Definition B", "Definition C", "Definition D"], answerIndex: 0, explanation: "Definition A is correct." }] }), isVideo: false },
    ];
  }

  // Default for History, Geography, Electives, Art, Music, Coding
  const topics = ["Introduction", "Core Concepts", "Case Study", "Project Work", "Review & Reflection"];
  const topic = topics[parseInt(periodLabel.replace(/\D/g, ""), 10) % topics.length] ?? topics[0];
  return [
    { title: `${prefix} ${subject} — ${topic} Video`, description: `Video lesson on ${topic} for ${subject}.`, contentType: "video", contentRef: JSON.stringify({ videos: [{ videoId: "dQw4w9WgXcQ", title: `${subject}: ${topic}`, channel: "Learning Hub", description: `${subject} ${topic}` }] }), isVideo: true },
    { title: `${prefix} ${subject} — ${topic} Essay`, description: `Write about what you learned in ${topic}.`, contentType: "essay_questions", contentRef: JSON.stringify({ questions: [`Describe the main concepts you learned in ${topic}.`, `How does this topic connect to real life?`] }), isVideo: false },
  ];
}

// Stored intermediate state for phased seeding
type DemoSeedState = {
  profileIds: Record<string, string>; // displayName → id
  markingPeriodIds: string[];           // [q1id, q2id, q3id, q4id]
  classMap: Array<{ classId: string; profileId: string; subject: string; gradeLevel: string; mpIndex: number }>;
  assignmentMap: Array<{ assignmentId: string; classId: string; profileId: string; subject: string; gradeLevel: string; mpIndex: number; assignmentIndex: number; contentType: string; isVideo: boolean; videoAssignmentId?: string }>;
  treeNodeMap: Array<{
    nodeId: string;
    treeId: string;
    classId: string;
    profileId: string;
    assignmentIds: string[];
    depth: number;
    cluster: "core" | "specialization";
    nodeType: "lesson" | "milestone" | "boss" | "elective";
    prerequisites: string[];
    xpReward: number;
  }>;
};

export const seedDemoPhase1 = createServerFn({ method: "POST" })
  .inputValidator((data) => richDemoSeedWithPinInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    await verifyParentPinForSession(session.user.id, data.parentPin);
    const db = getDb();
    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );
    const now = new Date().toISOString();

    // Create marking periods
    const mpIds: string[] = [];
    for (const mp of RICH_DEMO_MARKING_PERIODS) {
      const existing = await db.query.markingPeriods.findFirst({
        where: and(
          eq(markingPeriods.organizationId, organizationId),
          eq(markingPeriods.periodNumber, mp.periodNumber),
          eq(markingPeriods.schoolYear, RICH_DEMO_SCHOOL_YEAR),
        ),
      });
      const id = existing?.id ?? crypto.randomUUID();
      if (!existing) {
        await db.insert(markingPeriods).values({
          id,
          organizationId,
          label: mp.label,
          title: mp.title,
          periodNumber: mp.periodNumber,
          startDate: mp.startDate,
          endDate: mp.endDate,
          schoolYear: RICH_DEMO_SCHOOL_YEAR,
          status: mp.status,
          createdAt: now,
          updatedAt: now,
        });
      }
      mpIds.push(id);
    }

    // Create student profiles
    const pinHash = await hashStudentPin("1111");
    const profileIds: Record<string, string> = {};
    for (const student of RICH_DEMO_STUDENTS) {
      const id = crypto.randomUUID();
      await db.insert(profiles).values({
        id,
        organizationId,
        parentUserId: session.user.id,
        displayName: student.displayName,
        gradeLevel: student.gradeLevel,
        location: student.location,
        pinHash,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      profileIds[student.displayName] = id;
    }

    return {
      success: true,
      markingPeriodIds: mpIds,
      profileIds,
      summary: { studentsCreated: RICH_DEMO_STUDENTS.length, markingPeriodsCreated: RICH_DEMO_MARKING_PERIODS.length },
    };
  });

const seedDemoPhase2Input = z.object({
  parentPin: z.string().regex(/^\d{4,6}$/),
  profileIds: z.record(z.string(), z.string()),
  markingPeriodIds: z.array(z.string()),
});

export const seedDemoPhase2 = createServerFn({ method: "POST" })
  .inputValidator((data) => seedDemoPhase2Input.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();
    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );
    const now = new Date().toISOString();

    // 4 quarters → rotate subject → assign classes to marking periods
    // Each student gets one class per subject (2-3 subjects). Classes tagged to Q1 for year-long.
    type ClassEntry = { classId: string; profileId: string; subject: string; gradeLevel: string; mpIndex: number };
    const classMap: ClassEntry[] = [];

    for (const student of RICH_DEMO_STUDENTS) {
      const profileId = data.profileIds[student.displayName];
      if (!profileId) continue;
      const subjects = RICH_DEMO_SUBJECTS_BY_GRADE[student.gradeLevel] ?? ["Math", "Language Arts", "Science"];
      for (let si = 0; si < subjects.length; si++) {
        const subject = subjects[si]!;
        const classId = crypto.randomUUID();
        const mpId = data.markingPeriodIds[0]; // year-long classes tagged to Q1 period
        await db.insert(classes).values({
          id: classId,
          organizationId,
          markingPeriodId: mpId ?? null,
          title: `${student.displayName.split(" ")[0]} · Grade ${student.gradeLevel} ${subject}`,
          description: `${subject} curriculum for ${student.displayName} — ${RICH_DEMO_SCHOOL_YEAR}`,
          schoolYear: RICH_DEMO_SCHOOL_YEAR,
          createdByUserId: session.user.id,
          createdAt: now,
          updatedAt: now,
        });
        await db.insert(classEnrollments).values({
          id: crypto.randomUUID(),
          classId,
          profileId,
          createdAt: now,
        });
        classMap.push({ classId, profileId, subject, gradeLevel: student.gradeLevel, mpIndex: 0 });
      }
    }

    return { success: true, classMap, summary: { classesCreated: classMap.length } };
  });

const seedDemoPhase3Input = z.object({
  parentPin: z.string().regex(/^\d{4,6}$/),
  classMap: z.array(z.object({
    classId: z.string(),
    profileId: z.string(),
    subject: z.string(),
    gradeLevel: z.string(),
    mpIndex: z.number(),
  })),
  markingPeriodIds: z.array(z.string()),
});

export const seedDemoPhase3 = createServerFn({ method: "POST" })
  .inputValidator((data) => seedDemoPhase3Input.parse(data))
  .handler(async ({ data }) => {
    // Assignments are now created per-node in phase 4 alongside the skill tree nodes.
    // Phase 3 returns an empty assignmentMap so the downstream phase inputs remain valid.
    await requireActiveRole(["admin", "parent"]);
    return {
      success: true,
      assignmentMap: [] as Array<{
        assignmentId: string; classId: string; profileId: string; subject: string;
        gradeLevel: string; mpIndex: number; assignmentIndex: number;
        contentType: string; isVideo: boolean; videoAssignmentId?: string;
      }>,
      summary: { assignmentsCreated: 0 },
    };
  });

const seedDemoPhase4Input = z.object({
  parentPin: z.string().regex(/^\d{4,6}$/),
  markingPeriodIds: z.array(z.string()),
  classMap: z.array(z.object({
    classId: z.string(),
    profileId: z.string(),
    subject: z.string(),
    gradeLevel: z.string(),
    mpIndex: z.number(),
  })),
});

export const seedDemoPhase4 = createServerFn({ method: "POST" })
  .inputValidator((data) => seedDemoPhase4Input.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();
    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );
    const now = new Date().toISOString();

    type SeededGraphNode = {
      id: string;
      title: string;
      description: string;
      colorRamp: "teal" | "blue" | "purple" | "amber";
      nodeType: "lesson" | "milestone" | "boss" | "elective";
      cluster: "core" | "specialization";
      depth: number;
      xpReward: number;
      prerequisites: string[];
      isRequired: boolean;
      radius: number;
    };
    type TreeNodeEntry = {
      nodeId: string;
      treeId: string;
      classId: string;
      profileId: string;
      assignmentIds: string[];
      depth: number;
      cluster: "core" | "specialization";
      nodeType: "lesson" | "milestone" | "boss" | "elective";
      prerequisites: string[];
      xpReward: number;
    };
    const treeNodeMap: TreeNodeEntry[] = [];

    const TOPIC_POOLS: Record<string, {
      core: string[];
      specializations: Array<{ name: string; lessons: string[] }>;
    }> = {
      "Math": {
        core: [
          "Number Sense",
          "Operations Toolkit",
          "Fraction Fluency",
          "Ratios and Rates",
          "Expressions",
          "Equations",
          "Geometry Foundations",
          "Measurement Strategy",
          "Data Analysis",
          "Applied Problem Solving",
          "Math Mastery Boss",
        ],
        specializations: [
          { name: "Puzzle Forge", lessons: ["Pattern Hunting", "Constraint Logic", "Multi-Step Strategy", "Proof Sprint"] },
          { name: "Data Lab", lessons: ["Graph Stories", "Outlier Detective", "Prediction Models", "Decision Workshop"] },
          { name: "Spatial Studio", lessons: ["Transformations", "Area Design", "Volume Builds", "Optimization Challenge"] },
          { name: "Algebra Reactor", lessons: ["Variable Machines", "Equation Systems", "Function Clues", "Model Tuning"] },
        ],
      },
      "Language Arts": {
        core: [
          "Reading Identity",
          "Close Reading",
          "Vocabulary in Context",
          "Annotation Moves",
          "Claim Building",
          "Paragraph Architecture",
          "Essay Flow",
          "Research Moves",
          "Source Synthesis",
          "Voice and Revision",
          "Language Arts Capstone Boss",
        ],
        specializations: [
          { name: "Writer's Room", lessons: ["Narrative Openings", "Scene Weaving", "Dialogue Control", "Revision Lab"] },
          { name: "Research Archive", lessons: ["Source Vetting", "Note Compression", "Citation Web", "Argument Dossier"] },
          { name: "Poetry Chamber", lessons: ["Image Mining", "Sound Craft", "Meter Experiments", "Meaning Layers"] },
          { name: "Speaking Studio", lessons: ["Speech Blueprint", "Evidence Delivery", "Audience Signals", "Presentation Finale"] },
        ],
      },
      "Science": {
        core: [
          "Observation Protocol",
          "Question Design",
          "Hypothesis Crafting",
          "Variable Control",
          "Experiment Setup",
          "Data Collection",
          "Pattern Analysis",
          "Scientific Explanation",
          "Systems Thinking",
          "Real-World Application",
          "Science Expedition Boss",
        ],
        specializations: [
          { name: "Lab Mechanics", lessons: ["Tool Calibration", "Procedure Control", "Error Analysis", "Replication Trial"] },
          { name: "Field Research", lessons: ["Ecosystem Survey", "Sample Mapping", "Trend Tracking", "Impact Story"] },
          { name: "Engineering Bay", lessons: ["Prototype Sketches", "Design Constraints", "Stress Testing", "Iteration Loop"] },
          { name: "Data Observatory", lessons: ["Signal vs Noise", "Model Comparison", "Prediction Tuning", "Evidence Defense"] },
        ],
      },
      "default": {
        core: [
          "Orientation",
          "Foundation Concepts",
          "Guided Practice",
          "Systems Awareness",
          "Skill Integration",
          "Applied Reasoning",
          "Creative Transfer",
          "Independent Practice",
          "Reflection Loop",
          "Capstone Prep",
          "Mastery Boss",
        ],
        specializations: [
          { name: "Applied Studio", lessons: ["Scenario Mapping", "Method Choice", "Complex Challenge", "Reflection Sprint"] },
          { name: "Project Lab", lessons: ["Inquiry Launch", "Research Thread", "Build Cycle", "Presentation Loop"] },
          { name: "Strategy Branch", lessons: ["Tactics Review", "Adaptive Moves", "Risk Check", "Boss Prep"] },
          { name: "Creative Branch", lessons: ["Experiment Spark", "Prototype Flow", "Feedback Merge", "Showcase"] },
        ],
      },
    };

    const calculateXpReward = (depth: number, isBoss: boolean) => 50 + (depth * 60) + (isBoss ? 200 : 0);

    for (const cls of data.classMap) {
      const topicSet = TOPIC_POOLS[cls.subject] ?? TOPIC_POOLS["default"]!;
      const treeId = crypto.randomUUID();
      await db.insert(skillTrees).values({
        id: treeId,
        organizationId,
        classId: cls.classId,
        profileId: cls.profileId,
        title: `${cls.subject} Skill Map`,
        description: `Grade ${cls.gradeLevel} ${cls.subject} progression`,
        gradeLevel: cls.gradeLevel,
        subject: cls.subject,
        schoolYear: RICH_DEMO_SCHOOL_YEAR,
        createdByUserId: session.user.id,
        createdAt: now,
        updatedAt: now,
      });

      const generatedNodes: SeededGraphNode[] = [];
      const coreNodeIds: string[] = [];

      for (let coreIndex = 0; coreIndex < topicSet.core.length; coreIndex++) {
        const nodeId = crypto.randomUUID();
        const isBoss = coreIndex === topicSet.core.length - 1;
        const nodeType: "lesson" | "milestone" | "boss" =
          isBoss ? "boss" : coreIndex > 0 && coreIndex % 3 === 0 ? "milestone" : "lesson";
        coreNodeIds.push(nodeId);
        generatedNodes.push({
          id: nodeId,
          title: topicSet.core[coreIndex]!,
          description: `Core ${cls.subject} spine node ${coreIndex + 1} for Grade ${cls.gradeLevel}.`,
          colorRamp: coreIndex % 2 === 0 ? "teal" : "blue",
          nodeType,
          cluster: "core",
          depth: coreIndex,
          xpReward: calculateXpReward(coreIndex, isBoss),
          prerequisites: coreIndex === 0 ? [] : [coreNodeIds[coreIndex - 1]!],
          isRequired: true,
          radius: isBoss ? 38 : nodeType === "milestone" ? 32 : 28,
        });
      }

      const branchAnchors = [2, 4, 6, 7];
      const branchRegistry: Array<{ branchId: string; nodeIds: string[] }> = [];
      for (let branchIndex = 0; branchIndex < topicSet.specializations.length; branchIndex++) {
        const specialization = topicSet.specializations[branchIndex]!;
        const anchorCoreIndex = branchAnchors[branchIndex] ?? Math.min(branchIndex + 2, coreNodeIds.length - 2);
        const anchorNodeId = coreNodeIds[anchorCoreIndex]!;
        const branchId = `branch-${branchIndex}`;
        const branchNodeIds: string[] = [];

        for (let lessonIndex = 0; lessonIndex < specialization.lessons.length; lessonIndex++) {
          const nodeId = crypto.randomUUID();
          branchNodeIds.push(nodeId);
          const previousBranchNodeId = lessonIndex > 0 ? branchNodeIds[lessonIndex - 1]! : null;
          const branchHubNodeId = lessonIndex >= 2 ? branchNodeIds[1] ?? null : null;
          const prerequisites =
            lessonIndex === 0
              ? [anchorNodeId]
              : branchHubNodeId
                ? [branchHubNodeId]
                : previousBranchNodeId
                  ? [previousBranchNodeId]
                  : [anchorNodeId];

          const branchDepth =
            branchHubNodeId
              ? anchorCoreIndex + 3
              : anchorCoreIndex + lessonIndex + 1;
          generatedNodes.push({
            id: nodeId,
            title: `${specialization.name}: ${specialization.lessons[lessonIndex]!}`,
            description: `Specialization branch from ${topicSet.core[anchorCoreIndex]} into ${specialization.name}.`,
            colorRamp: branchIndex % 2 === 0 ? "purple" : "amber",
            nodeType: "elective",
            cluster: "specialization",
            depth: branchDepth,
            xpReward: calculateXpReward(branchDepth, false),
            prerequisites,
            isRequired: false,
            radius: 28,
          });
        }

        branchRegistry.push({ branchId, nodeIds: branchNodeIds });
      }

      const positionMap = layoutForceDirected(
        generatedNodes.map((node) => ({
          id: node.id,
          prerequisites: node.prerequisites,
          depth: node.depth,
          cluster: node.cluster,
          nodeType: node.nodeType,
        })),
        { width: 1800, height: 1400, minNodeDistance: 120 },
      );
      const forkSourceNodeIds: Set<string> =
        (positionMap as Map<string, { x: number; y: number }> & { forkIds?: Set<string> }).forkIds ??
        deriveForkSourceIds(
          generatedNodes.map((node) => ({
            id: node.id,
            prerequisites: node.prerequisites,
            cluster: node.cluster,
            nodeType: node.nodeType,
            colorRamp: node.colorRamp,
          })),
        );

      for (const node of generatedNodes) {
        const position = positionMap.get(node.id) ?? { x: 600, y: 450 };
        await db.insert(skillTreeNodes).values({
          id: node.id,
          treeId,
          organizationId,
          title: node.title,
          description: node.description,
          subject: cls.subject,
          icon: null,
          colorRamp: node.colorRamp,
          nodeType: node.nodeType,
          xpReward: node.xpReward,
          positionX: position.x,
          positionY: position.y,
          radius: node.radius,
          isRequired: node.isRequired,
          aiGeneratedDescription: buildNodeLayoutMetadata({
            description: node.description,
            cluster: node.cluster,
            depth: node.depth,
            prerequisiteGroups: node.prerequisites.length > 0 ? [node.prerequisites] : [],
          }),
          createdAt: now,
          updatedAt: now,
        });

        for (const [index, prerequisiteId] of node.prerequisites.entries()) {
          await db.insert(skillTreeEdges).values({
            id: crypto.randomUUID(),
            treeId,
            sourceNodeId: prerequisiteId,
            targetNodeId: node.id,
            edgeType: classifySkillTreeEdge({
              prereqIndex: index,
              sourceNodeId: prerequisiteId,
              targetNode: node,
              forkSourceNodeIds,
            }),
            createdAt: now,
          });
        }

        // ── Create assignments for this node ─────────────────────────────────
        const nodeCtx = { orgId: organizationId, classId: cls.classId, userId: session.user.id, now };

        // Use a generic chapter/unit title derived from the node's position in the tree
        const chapterTitle = node.cluster === "specialization"
          ? node.title.split(":")[0]?.trim() ?? node.title
          : node.title;
        const unitTitle = `${cls.subject} — Grade ${cls.gradeLevel}`;

        let builtAssignments: AssignmentRow[];
        if (node.nodeType === "milestone") {
          builtAssignments = milestoneAssignments(nodeCtx, node.title, cls.subject, cls.gradeLevel);
        } else if (node.nodeType === "boss") {
          // Collect chapter titles from core spine as context for the boss essay
          const coreChapterTitles = topicSet.core.slice(0, -1); // exclude the boss itself
          builtAssignments = bossAssignments(nodeCtx, unitTitle, cls.subject, cls.gradeLevel, coreChapterTitles);
        } else if (node.nodeType === "elective") {
          builtAssignments = electiveAssignments(nodeCtx, node.title, chapterTitle, cls.subject, cls.gradeLevel);
        } else {
          builtAssignments = lessonAssignments(nodeCtx, node.title, chapterTitle, cls.subject, cls.gradeLevel);
        }

        // Spread due dates across Q1–Q3 based on depth
        const mpIdx = Math.min(2, Math.floor(node.depth / 4));
        const assignmentIdList: string[] = [];
        for (const [orderIndex, asgn] of builtAssignments.entries()) {
          const dueAt = getDemoDueDate(mpIdx, node.depth * 5 + orderIndex);
          await db.insert(assignments).values({
            id: asgn.id,
            organizationId,
            classId: cls.classId,
            markingPeriodId: data.markingPeriodIds[mpIdx] ?? null,
            title: asgn.title,
            description: asgn.description,
            contentType: asgn.contentType,
            contentRef: asgn.contentRef,
            linkedAssignmentId: null,
            dueAt,
            createdByUserId: session.user.id,
            createdAt: now,
            updatedAt: now,
          });
          await db.insert(skillTreeNodeAssignments).values({
            id: crypto.randomUUID(),
            nodeId: node.id,
            assignmentId: asgn.id,
            orderIndex,
            createdAt: now,
          });
          assignmentIdList.push(asgn.id);
        }

        treeNodeMap.push({
          nodeId: node.id,
          treeId,
          classId: cls.classId,
          profileId: cls.profileId,
          assignmentIds: assignmentIdList,
          depth: node.depth,
          cluster: node.cluster,
          nodeType: node.nodeType,
          prerequisites: node.prerequisites,
          xpReward: node.xpReward,
        });
      }
    }

    const totalAssignments = treeNodeMap.reduce((sum, n) => sum + n.assignmentIds.length, 0);
    return {
      success: true,
      treeNodeMap,
      summary: { treesCreated: data.classMap.length, assignmentsCreated: totalAssignments },
    };
  });

const seedDemoPhase5Input = z.object({
  parentPin: z.string().regex(/^\d{4,6}$/),
  treeNodeMap: z.array(z.object({
    nodeId: z.string(),
    treeId: z.string(),
    classId: z.string(),
    profileId: z.string(),
    assignmentIds: z.array(z.string()),
    depth: z.number(),
    cluster: z.enum(["core", "specialization"]),
    nodeType: z.enum(["lesson", "milestone", "boss", "elective"]),
    prerequisites: z.array(z.string()),
    xpReward: z.number(),
  })),
  assignmentMap: z.array(z.object({
    assignmentId: z.string(),
    classId: z.string(),
    profileId: z.string(),
    subject: z.string(),
    gradeLevel: z.string(),
    mpIndex: z.number(),
    assignmentIndex: z.number(),
    contentType: z.string(),
    isVideo: z.boolean(),
    videoAssignmentId: z.string().optional(),
  })),
  classMap: z.array(z.object({
    classId: z.string(),
    profileId: z.string(),
    subject: z.string(),
    gradeLevel: z.string(),
    mpIndex: z.number(),
  })),
});

export const seedDemoPhase5 = createServerFn({ method: "POST" })
  .inputValidator((data) => seedDemoPhase5Input.parse(data))
  .handler(async ({ data: _data }) => {
    // Node-assignment links are now created in phase 4 alongside node insertion.
    await requireActiveRole(["admin", "parent"]);
    return { success: true, summary: { nodeAssignmentLinksCreated: 0 } };
  });

const seedDemoPhase6Input = z.object({
  parentPin: z.string().regex(/^\d{4,6}$/),
  assignmentMap: z.array(z.object({
    assignmentId: z.string(),
    classId: z.string(),
    profileId: z.string(),
    subject: z.string(),
    gradeLevel: z.string(),
    mpIndex: z.number(),
    assignmentIndex: z.number(),
    contentType: z.string(),
    isVideo: z.boolean(),
    videoAssignmentId: z.string().optional(),
  })),
  treeNodeMap: z.array(z.object({
    nodeId: z.string(),
    treeId: z.string(),
    classId: z.string(),
    profileId: z.string(),
    assignmentIds: z.array(z.string()),
    depth: z.number(),
    cluster: z.enum(["core", "specialization"]),
    nodeType: z.enum(["lesson", "milestone", "boss", "elective"]),
    prerequisites: z.array(z.string()),
    xpReward: z.number(),
  })),
});

export const seedDemoPhase6 = createServerFn({ method: "POST" })
  .inputValidator((data) => seedDemoPhase6Input.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();
    const organizationId = await resolveActiveOrganizationId(session.user.id, session.session.activeOrganizationId);
    const now = new Date().toISOString();

    let submissionsCreated = 0;
    let progressCreated = 0;

    // Determine performance tier per profileId by looking up student
    const profileTiers = new Map<string, "high" | "medium" | "low">();
    const orgProfiles = await db.query.profiles.findMany({
      where: eq(profiles.organizationId, organizationId),
      columns: { id: true, displayName: true },
    });
    for (const p of orgProfiles) {
      const studentDef = RICH_DEMO_STUDENTS.find(s => s.displayName === p.displayName);
      if (studentDef) profileTiers.set(p.id, studentDef.performanceTier);
    }

    // Create submissions for Q1 (mpIndex=0) and Q2 (mpIndex=1) — fully graded
    // Q3 (mpIndex=2) — mix: submitted or graded
    const submissionAssignments = data.assignmentMap.filter(a =>
      (a.mpIndex === 0 || a.mpIndex === 1 || a.mpIndex === 2) &&
      a.contentType !== "video" // videos don't get submissions
    );

    const assignmentChunks = chunkIds(submissionAssignments.map(a => a.assignmentId), 30);
    for (const chunk of assignmentChunks) {
      const chunkAssignments = submissionAssignments.filter(a => chunk.includes(a.assignmentId));
      for (const a of chunkAssignments) {
        const tier = profileTiers.get(a.profileId) ?? "medium";
        const score = getDemoScore(tier, a.assignmentIndex);
        const isQ3 = a.mpIndex === 2;
        const isGraded = !isQ3 || (a.assignmentIndex % 3 !== 2); // some Q3 not yet graded
        const submittedOffset = a.mpIndex * 60 + a.assignmentIndex * 3;
        const submittedAt = new Date(2025, 8, 1);
        submittedAt.setDate(submittedAt.getDate() + submittedOffset);

        let feedbackJson: string | null = null;
        if (isGraded && (a.contentType === "essay_questions" || a.contentType === "report")) {
          feedbackJson = JSON.stringify({
            strengths: ["Good analysis", "Clear writing"],
            improvements: ["Add more detail", "Cite sources"],
            overallFeedback: `Well done ${tier === "high" ? "— excellent work!" : "— keep working on it."}`,
          });
        }

        await db.insert(submissions).values({
          id: crypto.randomUUID(),
          organizationId,
          assignmentId: a.assignmentId,
          profileId: a.profileId,
          submittedByUserId: session.user.id,
          textResponse: a.contentType === "text" ? "Student response text submitted." : null,
          status: isGraded ? "graded" : "submitted",
          score: isGraded ? score : null,
          submittedAt: submittedAt.toISOString(),
          feedbackJson,
          reviewedAt: isGraded ? new Date(submittedAt.getTime() + 86400000 * 2).toISOString() : null,
          createdAt: now,
          updatedAt: now,
        });
        submissionsCreated++;
      }
    }

    // Create graph-aware node progress for each skill web.
    const orgTrees = await db.query.skillTrees.findMany({
      where: eq(skillTrees.organizationId, organizationId),
      columns: { id: true, profileId: true },
    });
    for (const tree of orgTrees) {
      if (!tree.profileId) continue;
      const treeNodes = await db.query.skillTreeNodes.findMany({
        where: eq(skillTreeNodes.treeId, tree.id),
        columns: { id: true, nodeType: true, xpReward: true, createdAt: true },
      });
      const treeEdges = await db.query.skillTreeEdges.findMany({
        where: eq(skillTreeEdges.treeId, tree.id),
        columns: { sourceNodeId: true, targetNodeId: true, edgeType: true },
      });
      if (treeNodes.length === 0) continue;

      const nodeById = new Map(treeNodes.map((node) => [node.id, node]));
      const parentMap = new Map<string, string[]>();
      const childMap = new Map<string, string[]>();
      const inDegree = new Map<string, number>();

      for (const node of treeNodes) {
        parentMap.set(node.id, []);
        childMap.set(node.id, []);
        inDegree.set(node.id, 0);
      }

      for (const edge of treeEdges) {
        if (!isProgressGatingEdgeType(edge.edgeType)) continue;
        const parents = parentMap.get(edge.targetNodeId);
        if (parents) parents.push(edge.sourceNodeId);
        const children = childMap.get(edge.sourceNodeId);
        if (children) children.push(edge.targetNodeId);
        inDegree.set(edge.targetNodeId, (inDegree.get(edge.targetNodeId) ?? 0) + 1);
      }

      const roots = treeNodes
        .filter((node) => (inDegree.get(node.id) ?? 0) === 0)
        .map((node) => node.id);
      const traversalQueue = [...roots];
      const depthByNodeId = new Map<string, number>(roots.map((rootId) => [rootId, 0]));
      const workingInDegree = new Map(inDegree);
      const topoOrder: string[] = [];

      while (traversalQueue.length > 0) {
        const currentNodeId = traversalQueue.shift()!;
        topoOrder.push(currentNodeId);
        const currentDepth = depthByNodeId.get(currentNodeId) ?? 0;

        for (const childId of childMap.get(currentNodeId) ?? []) {
          depthByNodeId.set(childId, Math.max(depthByNodeId.get(childId) ?? 0, currentDepth + 1));
          const nextDegree = (workingInDegree.get(childId) ?? 0) - 1;
          workingInDegree.set(childId, nextDegree);
          if (nextDegree === 0) {
            traversalQueue.push(childId);
          }
        }
      }

      for (const node of treeNodes) {
        if (!depthByNodeId.has(node.id)) {
          depthByNodeId.set(node.id, 0);
          topoOrder.push(node.id);
        }
      }

      const specializationRoots = treeNodes
        .filter((node) => node.nodeType === "elective")
        .filter((node) => {
          const parents = parentMap.get(node.id) ?? [];
          return parents.every((parentId) => (nodeById.get(parentId)?.nodeType ?? "lesson") !== "elective");
        })
        .sort((a, b) => (depthByNodeId.get(a.id) ?? 0) - (depthByNodeId.get(b.id) ?? 0));

      const branchKeyByNodeId = new Map<string, string>();
      const resolveBranchKey = (nodeId: string): string => {
        const cached = branchKeyByNodeId.get(nodeId);
        if (cached) return cached;
        const node = nodeById.get(nodeId);
        if (!node || node.nodeType !== "elective") {
          branchKeyByNodeId.set(nodeId, "");
          return "";
        }

        const directParents = parentMap.get(nodeId) ?? [];
        const electiveParents = directParents.filter(
          (parentId) => (nodeById.get(parentId)?.nodeType ?? "lesson") === "elective",
        );
        if (electiveParents.length === 0) {
          branchKeyByNodeId.set(nodeId, nodeId);
          return nodeId;
        }

        const branchKey = resolveBranchKey(electiveParents[0]!);
        branchKeyByNodeId.set(nodeId, branchKey);
        return branchKey;
      };

      const branchNodes = new Map<string, string[]>();
      for (const node of treeNodes) {
        if (node.nodeType !== "elective") continue;
        const branchKey = resolveBranchKey(node.id);
        const existing = branchNodes.get(branchKey) ?? [];
        existing.push(node.id);
        branchNodes.set(branchKey, existing);
      }

      for (const [branchKey, branchNodeIds] of branchNodes) {
        branchNodeIds.sort((a, b) => {
          const depthDelta = (depthByNodeId.get(a) ?? 0) - (depthByNodeId.get(b) ?? 0);
          return depthDelta !== 0 ? depthDelta : a.localeCompare(b);
        });
        branchNodes.set(branchKey, branchNodeIds);
      }

      const statusByNodeId = new Map<string, "locked" | "available" | "in_progress" | "complete" | "mastery">();
      const completedAtByNodeId = new Map<string, string>();
      const unlocksNode = (nodeId: string) =>
        (parentMap.get(nodeId) ?? []).every((parentId) => {
          const status = statusByNodeId.get(parentId);
          return status === "complete" || status === "mastery";
        });
      const stampCompletion = (nodeId: string, status: "complete" | "mastery", orderSeed: number) => {
        statusByNodeId.set(nodeId, status);
        completedAtByNodeId.set(nodeId, new Date(2025, 8, 10 + (orderSeed * 3)).toISOString());
      };

      const coreNodes = topoOrder.filter((nodeId) => (nodeById.get(nodeId)?.nodeType ?? "lesson") !== "elective");
      for (let index = 0; index < coreNodes.length; index++) {
        const nodeId = coreNodes[index]!;
        const depth = depthByNodeId.get(nodeId) ?? 0;
        if (depth <= 4 && unlocksNode(nodeId)) {
          const status = depth > 0 && depth % 4 === 0 ? "mastery" : "complete";
          stampCompletion(nodeId, status, index);
        }
      }

      const branchOrder = specializationRoots
        .map((root) => root.id)
        .filter((rootId) => branchNodes.has(rootId));

      const completedBranch = branchOrder[0];
      const progressingBranch = branchOrder[1];

      if (completedBranch) {
        const completedBranchNodes = branchNodes.get(completedBranch) ?? [];
        let completions = 0;
        for (const nodeId of completedBranchNodes) {
          if (!unlocksNode(nodeId) || completions >= 2) break;
          stampCompletion(nodeId, completions === 1 ? "mastery" : "complete", coreNodes.length + completions);
          completions++;
        }
      }

      if (progressingBranch) {
        const progressingBranchNodes = branchNodes.get(progressingBranch) ?? [];
        const firstUnlocked = progressingBranchNodes.find((nodeId) => unlocksNode(nodeId));
        if (firstUnlocked) {
          statusByNodeId.set(firstUnlocked, "in_progress");
        }
      }

      for (const nodeId of topoOrder) {
        if (statusByNodeId.has(nodeId)) continue;
        if (unlocksNode(nodeId)) {
          statusByNodeId.set(nodeId, "available");
        } else {
          statusByNodeId.set(nodeId, "locked");
        }
      }

      for (const node of treeNodes) {
        const status = statusByNodeId.get(node.id) ?? "locked";
        const completedAt = completedAtByNodeId.get(node.id) ?? null;
        const xpEarned =
          status === "mastery" ? node.xpReward + Math.round(node.xpReward * 0.25)
          : status === "complete" ? node.xpReward
          : status === "in_progress" ? Math.max(40, Math.round(node.xpReward * 0.45))
          : 0;

        await db.insert(skillTreeNodeProgress).values({
          id: crypto.randomUUID(),
          nodeId: node.id,
          profileId: tree.profileId,
          treeId: tree.id,
          status,
          xpEarned,
          completedAt,
          masteryAt: status === "mastery" ? completedAt : null,
          updatedAt: now,
        });
        progressCreated++;
      }
    }

    return { success: true, summary: { submissionsCreated, progressCreated } };
  });

const seedDemoPhase7Input = z.object({
  parentPin: z.string().regex(/^\d{4,6}$/),
  profileIds: z.record(z.string(), z.string()),
  assignmentMap: z.array(z.object({
    assignmentId: z.string(),
    classId: z.string(),
    profileId: z.string(),
    subject: z.string(),
    gradeLevel: z.string(),
    mpIndex: z.number(),
    assignmentIndex: z.number(),
    contentType: z.string(),
    isVideo: z.boolean(),
    videoAssignmentId: z.string().optional(),
  })),
});

export const seedDemoPhase7 = createServerFn({ method: "POST" })
  .inputValidator((data) => seedDemoPhase7Input.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();
    const organizationId = await resolveActiveOrganizationId(session.user.id, session.session.activeOrganizationId);
    const now = new Date().toISOString();

    type DemoRewardTier = {
      tierNumber: number;
      xpThreshold: number;
      title: string;
      icon: string;
      rewardType: "treat" | "activity" | "item" | "screen_time" | "experience";
      estimatedValue: string;
      isBonusTier?: boolean;
    };

    function buildRewardTemplate(theme: "disney" | "pokemon" | "food" | "tech"): DemoRewardTier[] {
      const baseThresholds = [1200, 2500, 3900, 5400, 7000, 8400];
      if (theme === "disney") {
        return [
          { tierNumber: 1, xpThreshold: baseThresholds[0]!, title: "Disney Treat Pick", icon: "🍦", rewardType: "treat", estimatedValue: "$5-10" },
          { tierNumber: 2, xpThreshold: baseThresholds[1]!, title: "Disney Movie Night", icon: "🎬", rewardType: "experience", estimatedValue: "$10-25" },
          { tierNumber: 3, xpThreshold: baseThresholds[2]!, title: "Disney Merch Item", icon: "🧸", rewardType: "item", estimatedValue: "$20-40" },
          { tierNumber: 4, xpThreshold: baseThresholds[3]!, title: "Theme Activity Day", icon: "🎡", rewardType: "activity", estimatedValue: "$35-70" },
          { tierNumber: 5, xpThreshold: baseThresholds[4]!, title: "Disney Family Outing", icon: "🏰", rewardType: "experience", estimatedValue: "$60-120" },
          { tierNumber: 6, xpThreshold: baseThresholds[5]!, title: "Bonus Disney Big Reward", icon: "⭐", rewardType: "item", estimatedValue: "$100-200", isBonusTier: true },
        ];
      }
      if (theme === "pokemon") {
        return [
          { tierNumber: 1, xpThreshold: baseThresholds[0]!, title: "Pokemon Card Pack", icon: "🃏", rewardType: "item", estimatedValue: "$5-12" },
          { tierNumber: 2, xpThreshold: baseThresholds[1]!, title: "Pokemon Deck Upgrade", icon: "🃏", rewardType: "item", estimatedValue: "$12-25" },
          { tierNumber: 3, xpThreshold: baseThresholds[2]!, title: "Pokemon Activity Night", icon: "🎮", rewardType: "activity", estimatedValue: "$20-40" },
          { tierNumber: 4, xpThreshold: baseThresholds[3]!, title: "Pokemon Merch Reward", icon: "🎒", rewardType: "item", estimatedValue: "$35-70" },
          { tierNumber: 5, xpThreshold: baseThresholds[4]!, title: "Pokemon Big Experience", icon: "🏆", rewardType: "experience", estimatedValue: "$60-120" },
          { tierNumber: 6, xpThreshold: baseThresholds[5]!, title: "Bonus Pokemon Tech", icon: "⭐", rewardType: "item", estimatedValue: "$100-200", isBonusTier: true },
        ];
      }
      if (theme === "food") {
        return [
          { tierNumber: 1, xpThreshold: baseThresholds[0]!, title: "Favorite Snack Pick", icon: "🍿", rewardType: "treat", estimatedValue: "$5-10" },
          { tierNumber: 2, xpThreshold: baseThresholds[1]!, title: "Case Of Soda", icon: "🥤", rewardType: "treat", estimatedValue: "$8-15" },
          { tierNumber: 3, xpThreshold: baseThresholds[2]!, title: "Food Outing", icon: "🍔", rewardType: "experience", estimatedValue: "$20-40" },
          { tierNumber: 4, xpThreshold: baseThresholds[3]!, title: "Family Restaurant", icon: "🍽️", rewardType: "experience", estimatedValue: "$35-70" },
          { tierNumber: 5, xpThreshold: baseThresholds[4]!, title: "Premium Dinner Night", icon: "🍽️", rewardType: "experience", estimatedValue: "$60-120" },
          { tierNumber: 6, xpThreshold: baseThresholds[5]!, title: "Bonus Tasting Menu", icon: "⭐", rewardType: "experience", estimatedValue: "$100-200", isBonusTier: true },
        ];
      }
      return [
        { tierNumber: 1, xpThreshold: baseThresholds[0]!, title: "Screen Time Block", icon: "🖥️", rewardType: "screen_time", estimatedValue: "$0-10" },
        { tierNumber: 2, xpThreshold: baseThresholds[1]!, title: "Game Or Snack Reward", icon: "🎁", rewardType: "treat", estimatedValue: "$8-20" },
        { tierNumber: 3, xpThreshold: baseThresholds[2]!, title: "Accessory Upgrade", icon: "🎮", rewardType: "item", estimatedValue: "$20-45" },
        { tierNumber: 4, xpThreshold: baseThresholds[3]!, title: "Tech Activity Outing", icon: "🏎️", rewardType: "activity", estimatedValue: "$35-80" },
        { tierNumber: 5, xpThreshold: baseThresholds[4]!, title: "Major Tech Item", icon: "📱", rewardType: "item", estimatedValue: "$60-140" },
        { tierNumber: 6, xpThreshold: baseThresholds[5]!, title: "Bonus Tech Reward", icon: "⭐", rewardType: "item", estimatedValue: "$100-200", isBonusTier: true },
      ];
    }

    let rewardTracksCreated = 0;
    let weekPlanCreated = 0;

    for (const student of RICH_DEMO_STUDENTS) {
      const profileId = data.profileIds[student.displayName];
      if (!profileId) continue;

      // Calculate XP from node progress for this profile
      const progressRows = await db.query.skillTreeNodeProgress.findMany({
        where: and(
          eq(skillTreeNodeProgress.profileId, profileId),
        ),
        columns: { xpEarned: true },
      });
      const totalXp = progressRows.reduce((sum, r) => sum + r.xpEarned, 0);
      const rewardTemplate = buildRewardTemplate(student.rewardTheme);
      const trackNamePrefix = student.displayName.split(" ")[0] ?? student.displayName;
      const trackTitle =
        student.rewardTheme === "pokemon"
          ? `${trackNamePrefix}'s Pokemon Current`
          : student.rewardTheme === "food"
            ? `${trackNamePrefix}'s Food Current`
            : student.rewardTheme === "disney"
              ? `${trackNamePrefix}'s Disney Current`
              : `${trackNamePrefix}'s Tech Current`;
      const trackDescription =
        student.rewardTheme === "pokemon"
          ? `Pokemon-themed rewards for ${RICH_DEMO_SCHOOL_YEAR}. ${student.rewardSteering}`
          : student.rewardTheme === "food"
            ? `Food-themed rewards for ${RICH_DEMO_SCHOOL_YEAR}. ${student.rewardSteering}`
            : student.rewardTheme === "disney"
              ? `Disney-themed rewards for ${RICH_DEMO_SCHOOL_YEAR}. ${student.rewardSteering}`
              : `Tech-themed rewards for ${RICH_DEMO_SCHOOL_YEAR}. ${student.rewardSteering}`;
      const totalXpGoal = rewardTemplate.find((tier) => tier.tierNumber === 5)?.xpThreshold ?? 7000;
      const tiersToInsert = student.includeBonusTier
        ? rewardTemplate
        : rewardTemplate.filter((tier) => !tier.isBonusTier);

      // Create reward track
      const trackId = crypto.randomUUID();
      await db.insert(rewardTracks).values({
        id: trackId,
        organizationId,
        profileId,
        createdByUserId: session.user.id,
        title: trackTitle,
        description: trackDescription,
        isActive: true,
        schoolYear: RICH_DEMO_SCHOOL_YEAR,
        startedAt: "2025-09-01",
        totalXpGoal,
        createdAt: now,
        updatedAt: now,
      });
      rewardTracksCreated++;

      // Create tiers
      const tierIds: string[] = [];
      for (const tier of tiersToInsert) {
        const tierId = crypto.randomUUID();
        tierIds.push(tierId);
        await db.insert(rewardTiers).values({
          id: tierId,
          trackId,
          organizationId,
          tierNumber: tier.tierNumber,
          xpThreshold: tier.xpThreshold,
          title: tier.title,
          description: tier.estimatedValue,
          icon: tier.icon,
          rewardType: tier.rewardType,
          estimatedValue: tier.estimatedValue,
          isBonusTier: tier.isBonusTier ?? false,
          createdAt: now,
          updatedAt: now,
        });

        // Create claims for unlocked tiers
        const isUnlocked = totalXp >= tier.xpThreshold;
        if (isUnlocked) {
          const claimStatus =
            tier.tierNumber === 1 ? "delivered" :
            tier.tierNumber === 2 ? "claimed" :
            "unclaimed";
          await db.insert(rewardClaims).values({
            id: crypto.randomUUID(),
            tierId,
            trackId,
            profileId,
            organizationId,
            status: claimStatus,
            claimedAt: claimStatus !== "unclaimed" ? new Date(2025, 10 + tier.tierNumber, 1).toISOString() : null,
            deliveredAt: claimStatus === "delivered" ? new Date(2025, 10 + tier.tierNumber, 3).toISOString() : null,
            deliveredByUserId: claimStatus === "delivered" ? session.user.id : null,
            parentNote: claimStatus === "delivered" ? "Enjoy your reward!" : null,
            createdAt: now,
            updatedAt: now,
          });
        }
      }

      // XP snapshot
      await db.insert(rewardTrackXpSnapshots).values({
        id: crypto.randomUUID(),
        trackId,
        profileId,
        xpEarned: totalXp,
        lastUpdatedAt: now,
      });

      // Week plan — schedule Q3 assignments over next 2 weeks
      const profileAssignments = data.assignmentMap.filter(a => a.profileId === profileId && a.mpIndex === 2 && !a.isVideo);
      const planAssignments = profileAssignments.slice(0, 10);
      const today = new Date();
      for (let i = 0; i < planAssignments.length; i++) {
        const schedDate = new Date(today);
        schedDate.setDate(today.getDate() + Math.floor(i / 2) + 1);
        await db.insert(weekPlan).values({
          id: crypto.randomUUID(),
          organizationId,
          profileId,
          assignmentId: planAssignments[i]!.assignmentId,
          scheduledDate: schedDate.toISOString().slice(0, 10),
          orderIndex: i % 2,
          createdAt: now,
        });
        weekPlanCreated++;
      }
    }

    return { success: true, summary: { rewardTracksCreated, weekPlanCreated } };
  });

// ─── Ensure Demo Account ──────────────────────────────────────────────────────

export const ensureDemoAccount = createServerFn({ method: "GET" }).handler(async () => {
  const db = getDb();
  const now = new Date().toISOString();

  // Check if demo user already exists and is fully set up
  const existingByUsername = await db.query.users.findFirst({
    where: eq(users.username, "demo"),
  });
  if (existingByUsername?.passwordHash && existingByUsername.parentPin) {
    return { created: false, userId: existingByUsername.id };
  }

  // Partial demo account — fix it in place rather than recreating
  if (existingByUsername) {
    const updates: Partial<typeof existingByUsername> = { updatedAt: now };
    if (!existingByUsername.passwordHash) {
      updates.passwordHash = await hashPassword("demo1234");
    }
    if (!existingByUsername.parentPin) {
      updates.parentPin = await hashParentPin("1234");
      updates.parentPinLength = 4;
    }
    await db.update(users).set(updates).where(eq(users.id, existingByUsername.id));
    return { created: false, userId: existingByUsername.id };
  }

  // Check for a partial/broken demo account created by email (no username set)
  const existingByEmail = await db.query.users.findFirst({
    where: eq(users.email, "demo@proorca.demo"),
  });

  // Delete broken email-only record so we can recreate cleanly
  if (existingByEmail) {
    await db.delete(users).where(eq(users.id, existingByEmail.id));
  }

  // Insert the demo user directly (auth.api.signUpEmail requires HTTP context)
  const demoUserId = crypto.randomUUID();
  const [passwordHash, parentPinHash] = await Promise.all([
    hashPassword("demo1234"),
    hashParentPin("1234"),
  ]);
  await db.insert(users).values({
    id: demoUserId,
    email: "demo@proorca.demo",
    emailVerified: true,
    username: "demo",
    passwordHash,
    parentPin: parentPinHash,
    parentPinLength: 4,
    name: "Demo Parent",
    role: "user",
    createdAt: now,
    updatedAt: now,
  });

  // Create the organization
  const orgId = crypto.randomUUID();
  const orgSlug = `demo-org-${orgId.slice(0, 8)}`;
  await db.insert(organizations).values({
    id: orgId,
    name: "Demo Home Academy",
    slug: orgSlug,
    ownerUserId: demoUserId,
    createdAt: now,
    updatedAt: now,
  });

  // Create membership
  await db.insert(memberships).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId: demoUserId,
    role: "parent",
    createdAt: now,
    updatedAt: now,
  });

  return { created: true, userId: demoUserId, organizationId: orgId };
});

// ── Curriculum Builder Wizard ─────────────────────────────────────────────────

export const wizardGetIntakeData = createServerFn({ method: "GET" }).handler(async () => {
  const session = await requireActiveRole(["parent", "admin"]);
  const db = getDb();

  const organizationId = await resolveActiveOrganizationId(
    session.user.id,
    session.session.activeOrganizationId,
  );

  const profileRows = await db.query.profiles.findMany({
    where: and(
      eq(profiles.organizationId, organizationId),
      eq(profiles.status, "active"),
    ),
    orderBy: [desc(profiles.createdAt)],
  });

  return {
    profiles: profileRows.map((p) => ({
      id: p.id,
      displayName: p.displayName,
      gradeLevel: p.gradeLevel ?? "",
      birthDate: p.birthDate ?? null,
    })),
  };
});

const wizardSpineInput = z.object({
  subject: z.string().min(1),
  gradeLevel: z.string().min(1),
  courseLength: z.string().min(1),
  interests: z.string().default(""),
});

export const wizardGenerateSpine = createServerFn({ method: "POST" })
  .inputValidator((data) => wizardSpineInput.parse(data))
  .handler(async ({ data }) => {
    await requireActiveRole(["admin", "parent"]);
    const nodes = await generateCurriculumSpine(data);
    return { nodes };
  });

const spineNodeShape = z.object({
  tempId: z.string(),
  title: z.string(),
  description: z.string().default(""),
  icon: z.string().default("📚"),
  colorRamp: z.string().default("teal"),
  nodeType: z.string().default("milestone"),
  cluster: z.string().default("core"),
  depth: z.number().default(0),
  isRequired: z.boolean().optional(),
  xpReward: z.number().default(150),
  prerequisites: z.array(z.string()).default([]),
  suggestedAssignments: z
    .array(z.object({ type: z.string(), title: z.string() }))
    .default([]),
});

const wizardWebInput = z.object({
  subject: z.string().min(1),
  gradeLevel: z.string().min(1),
  courseLength: z.string().min(1),
  interests: z.string().default(""),
  spineNodes: z.array(spineNodeShape).min(1),
});

export const wizardGenerateWeb = createServerFn({ method: "POST" })
  .inputValidator((data) => wizardWebInput.parse(data))
  .handler(async ({ data }) => {
    await requireActiveRole(["admin", "parent"]);

    // Generate lesson/elective nodes that branch off the spine
    const generatedWebNodes = await generateCurriculumWebFromSpine({
      subject: data.subject,
      gradeLevel: data.gradeLevel,
      courseLength: data.courseLength,
      interests: data.interests,
      spineNodes: data.spineNodes.map((n) => ({
        tempId: n.tempId,
        title: n.title,
        nodeType: n.nodeType,
        depth: n.depth,
        prerequisites: n.prerequisites,
      })),
    });
    // Sanitize: remove self-references and forward references, allow up to 2
    // prerequisites (needed for boss reconvergence nodes). Do NOT enforce
    // strict depth-gap=1 — the new zone-based prompts generate clean graphs.
    const allKnownIds = new Set([
      ...data.spineNodes.map((n) => n.tempId),
      ...generatedWebNodes.map((n) => n.tempId),
    ]);
    const nodeOrder = new Map<string, number>([
      ...data.spineNodes.map((n, i) => [n.tempId, i] as [string, number]),
      ...generatedWebNodes.map((n, i) => [n.tempId, data.spineNodes.length + i] as [string, number]),
    ]);
    const webNodes = generatedWebNodes.map((node) => {
      const myOrder = nodeOrder.get(node.tempId) ?? 9999;
      const cleanPrereqs = Array.from(new Set(
        node.prerequisites.filter(
          (p) => p !== node.tempId && allKnownIds.has(p) && (nodeOrder.get(p) ?? 9999) < myOrder,
        ),
      )).slice(0, 2); // allow up to 2 for reconvergence nodes
      return { ...node, prerequisites: cleanPrereqs.length > 0 ? cleanPrereqs : node.prerequisites.slice(0, 1) };
    });

    // Merge spine + web into a single flat list
    const combined = [
      ...data.spineNodes.map((n) => ({ ...n, isRequired: n.isRequired ?? true })),
      ...webNodes.map((n) => ({
        tempId: n.tempId,
        title: n.title,
        description: n.description,
        icon: n.icon,
        colorRamp: n.colorRamp,
        nodeType: n.nodeType as string,
        cluster: n.cluster as string,
        depth: n.depth,
        isRequired: n.isRequired,
        xpReward: n.xpReward,
        prerequisites: n.prerequisites,
        suggestedAssignments: n.suggestedAssignments,
      })),
    ];

    // Force-directed layout over the full graph
    const posMap = layoutForceDirected(
      combined.map((n) => ({
        id: n.tempId,
        prerequisites: n.prerequisites,
        depth: n.depth,
        cluster: n.cluster,
        nodeType: n.nodeType,
      })),
    );

    const nodes = combined.map((n) => {
      const pos = posMap.get(n.tempId) ?? { x: 600, y: 450 };
      return { ...n, x: pos.x, y: pos.y };
    });

    // Build a deduplicated edge list for preview rendering
    const edgeSet = new Set<string>();
    const edges: Array<{ source: string; target: string }> = [];
    for (const node of nodes) {
      for (const prereqId of node.prerequisites) {
        const key = `${prereqId}>${node.tempId}`;
        if (!edgeSet.has(key) && posMap.has(prereqId)) {
          edgeSet.add(key);
          edges.push({ source: prereqId, target: node.tempId });
        }
      }
    }

    return { nodes, edges };
  });

const wizardCommitInput = z.object({
  profileId: z.string().min(1),
  classTitle: z.string().min(1),
  treeTitle: z.string().min(1),
  subject: z.string().min(1),
  gradeLevel: z.string().min(1),
  schoolYear: z.string().optional(),
  nodes: z
    .array(
      z.object({
        tempId: z.string(),
        title: z.string(),
        description: z.string().default(""),
        icon: z.string().default("📚"),
        cluster: z.enum(["core", "specialization"]).optional(),
        depth: z.number().int().nonnegative().optional(),
        colorRamp: z.string().default("blue"),
        nodeType: z.string().default("lesson"),
        xpReward: z.number().default(100),
        isRequired: z.boolean().optional(),
        prerequisites: z.array(z.string()).default([]),
        x: z.number().default(600),
        y: z.number().default(450),
        suggestedAssignments: z
          .array(z.object({ type: z.string(), title: z.string() }))
          .default([]),
      }),
    )
    .min(1),
  generatedAssignments: z
    .array(
      z.object({
        nodeId: z.string(),
        contentType: z.enum(["text", "video", "quiz", "essay_questions", "report", "movie"]),
        title: z.string(),
        description: z.string().default(""),
        contentRef: z.string().default(""),
      }),
    )
    .default([]),
});

const assignmentPrefsShape = z.object({
  // Lesson/elective
  readingPerNode: z.boolean().default(true),
  videosPerLesson: z.number().int().min(0).max(3).default(1),
  // Chapter (milestone)
  chapterIntroVideo: z.boolean().default(true),
  quizzesPerChapter: z.number().int().min(0).max(3).default(1),
  essaysPerChapter: z.number().int().min(0).max(2).default(0),
  // Boss (capstone)
  quizzesPerBoss: z.number().int().min(0).max(5).default(2),
  essaysPerBoss: z.number().int().min(0).max(3).default(1),
  papersPerBoss: z.number().int().min(0).max(2).default(0),
  includeProjects: z.boolean().default(false),
  // Movie
  includeMovies: z.boolean().default(false),
  otherInstructions: z.string().default(""),
});

const wizardAssignmentsInput = z.object({
  subject: z.string().min(1),
  gradeLevel: z.string().min(1),
  prefs: assignmentPrefsShape,
  node: z.object({
    tempId: z.string(),
    title: z.string(),
    description: z.string().default(""),
    nodeType: z.string().default("lesson"),
  }),
});

export const wizardGenerateAssignments = createServerFn({ method: "POST" })
  .inputValidator((data) => wizardAssignmentsInput.parse(data))
  .handler(async ({ data }) => {
    await requireActiveRole(["admin", "parent"]);
    const generated = await generateAssignmentsForNode({
      subject: data.subject,
      gradeLevel: data.gradeLevel,
      node: data.node,
      prefs: data.prefs as AssignmentPrefs,
    });
    return { assignments: generated };
  });

const COMMIT_VALID_NODE_TYPES = new Set(["lesson", "milestone", "boss", "branch", "elective"]);
const COMMIT_VALID_COLOR_RAMPS = new Set(["blue", "teal", "purple", "amber", "coral", "green"]);

const wizardChapterInput = z.object({
  subject: z.string().min(1),
  gradeLevel: z.string().min(1),
  milestoneId: z.string().min(1),
  milestoneTitle: z.string().min(1),
  milestoneDescription: z.string().default(""),
  milestoneDepth: z.number().default(1),
  existingTitles: z.array(z.string()).default([]),
});

export const wizardGenerateChapterCluster = createServerFn({ method: "POST" })
  .inputValidator((data) => wizardChapterInput.parse(data))
  .handler(async ({ data }) => {
    await requireActiveRole(["admin", "parent"]);
    const nodes = await generateChapterCluster(data);
    return { nodes };
  });

const wizardBranchInput = z.object({
  subject: z.string().min(1),
  gradeLevel: z.string().min(1),
  lessonId: z.string().min(1),
  lessonTitle: z.string().min(1),
  lessonDescription: z.string().default(""),
  lessonDepth: z.number().default(2),
  milestoneTitle: z.string().min(1),
  existingTitles: z.array(z.string()).default([]),
});

export const wizardGenerateBranchCluster = createServerFn({ method: "POST" })
  .inputValidator((data) => wizardBranchInput.parse(data))
  .handler(async ({ data }) => {
    await requireActiveRole(["admin", "parent"]);
    const nodes = await generateBranchCluster(data);
    return { nodes };
  });

const wizardLayoutInput = z.object({
  nodes: z.array(
    z.object({
      tempId: z.string(),
      prerequisites: z.array(z.string()).default([]),
      depth: z.number().default(0),
      cluster: z.string().default("core"),
      nodeType: z.string().default("lesson"),
    }),
  ).min(1),
});

export const wizardLayoutNodes = createServerFn({ method: "POST" })
  .inputValidator((data) => wizardLayoutInput.parse(data))
  .handler(async ({ data }) => {
    await requireActiveRole(["admin", "parent"]);
    const posMap = layoutForceDirected(
      data.nodes.map((n) => ({
        id: n.tempId,
        prerequisites: n.prerequisites,
        depth: n.depth,
        cluster: n.cluster,
        nodeType: n.nodeType,
      })),
    );
    const edges: Array<{ source: string; target: string }> = [];
    const edgeSet = new Set<string>();
    for (const node of data.nodes) {
      for (const prereqId of node.prerequisites) {
        const key = `${prereqId}>${node.tempId}`;
        if (!edgeSet.has(key) && posMap.has(prereqId)) {
          edgeSet.add(key);
          edges.push({ source: prereqId, target: node.tempId });
        }
      }
    }
    const positions: Record<string, { x: number; y: number }> = {};
    for (const [id, pos] of posMap.entries()) {
      positions[id] = pos;
    }
    return { positions, edges };
  });

export const wizardCommitCurriculum = createServerFn({ method: "POST" })
  .inputValidator((data) => wizardCommitInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );
    const now = new Date().toISOString();

    // Verify the profile belongs to this org
    const profile = await db.query.profiles.findFirst({
      where: and(
        eq(profiles.id, data.profileId),
        eq(profiles.organizationId, organizationId),
        eq(profiles.status, "active"),
      ),
    });
    if (!profile) throw new Error("PROFILE_NOT_FOUND");

    // 1. Class
    const classId = crypto.randomUUID();
    await db.insert(classes).values({
      id: classId,
      organizationId,
      title: data.classTitle,
      schoolYear: data.schoolYear ?? null,
      createdByUserId: session.user.id,
      createdAt: now,
      updatedAt: now,
    });

    // 2. Enrollment
    await db.insert(classEnrollments).values({
      id: crypto.randomUUID(),
      classId,
      profileId: data.profileId,
      createdAt: now,
    });

    // 3. Skill tree
    const treeId = crypto.randomUUID();
    await db.insert(skillTrees).values({
      id: treeId,
      organizationId,
      classId,
      profileId: data.profileId,
      title: data.treeTitle,
      gradeLevel: data.gradeLevel,
      subject: data.subject,
      schoolYear: data.schoolYear ?? null,
      createdByUserId: session.user.id,
      createdAt: now,
      updatedAt: now,
    });

    // Nodes arriving from the wizard are already sanitized by wizardGenerateWeb.
    // Just remove any remaining self-refs or forward-refs without re-flattening.
    const commitOrder = new Map(data.nodes.map((n, i) => [n.tempId, i]));
    const normalizedCommitNodes = data.nodes.map((node) => {
      const myOrder = commitOrder.get(node.tempId) ?? 9999;
      const cleanPrereqs = Array.from(new Set(
        node.prerequisites.filter(
          (p) => p !== node.tempId && commitOrder.has(p) && (commitOrder.get(p) ?? 9999) < myOrder,
        ),
      )).slice(0, 2);
      return { ...node, prerequisites: cleanPrereqs };
    });

    // 4. Nodes — allocate real IDs upfront so edges can reference them
    const tempToReal = new Map<string, string>();
    for (const node of normalizedCommitNodes) tempToReal.set(node.tempId, crypto.randomUUID());

    await Promise.all(
      normalizedCommitNodes.map((node) => {
        const safeType = COMMIT_VALID_NODE_TYPES.has(node.nodeType)
          ? (node.nodeType as "lesson" | "milestone" | "boss" | "branch" | "elective")
          : "lesson";
        const safeRamp = COMMIT_VALID_COLOR_RAMPS.has(node.colorRamp)
          ? node.colorRamp
          : "blue";
        const cluster =
          node.cluster === "specialization" || safeType === "elective"
            ? "specialization"
            : "core";
        const radius =
          node.nodeType === "boss"
            ? 32
            : node.nodeType === "milestone"
              ? 28
              : node.nodeType === "elective"
                ? 22
                : 24;

        return db.insert(skillTreeNodes).values({
          id: tempToReal.get(node.tempId)!,
          treeId,
          organizationId,
          title: node.title,
          description: node.description || null,
          icon: node.icon || null,
          colorRamp: safeRamp,
          nodeType: safeType,
          xpReward: Math.min(1000, Math.max(0, node.xpReward)),
          positionX: Math.round(node.x),
          positionY: Math.round(node.y),
          radius,
          isRequired: node.isRequired ?? (node.cluster === "core" && node.nodeType !== "elective"),
          aiGeneratedDescription: buildNodeLayoutMetadata({
            description: node.description || null,
            cluster,
            depth: node.depth ?? 0,
            prerequisiteGroups:
              node.prerequisites.length > 1
                ? node.prerequisites
                    .map((prereqTempId) => tempToReal.get(prereqTempId))
                    .filter((prereqId): prereqId is string => typeof prereqId === "string")
                    .map((prereqId) => [prereqId])
                : node.prerequisites.length === 1
                  ? [[tempToReal.get(node.prerequisites[0]!)!]]
                  : [],
          }),
          createdAt: now,
          updatedAt: now,
        });
      }),
    );

    // 5. Edges — one per prerequisite, deduped
    const edgeSet = new Set<string>();
    const forkSourceNodeIds = new Set(
      Array.from(
        deriveForkSourceIds(
          normalizedCommitNodes.map((node) => ({
            id: node.tempId,
            prerequisites: node.prerequisites,
            cluster: node.cluster,
            nodeType: node.nodeType,
            colorRamp: node.colorRamp,
          })),
        ),
      )
        .map((tempId) => tempToReal.get(tempId))
        .filter((value): value is string => typeof value === "string"),
    );

    const edgeRows: Array<{
      id: string;
      treeId: string;
      sourceNodeId: string;
      targetNodeId: string;
      edgeType: "required" | "optional" | "bonus" | "fork";
      createdAt: string;
    }> = [];

    for (const node of normalizedCommitNodes) {
      const targetId = tempToReal.get(node.tempId);
      if (!targetId) continue;
      for (const [index, prereq] of node.prerequisites.entries()) {
        const sourceId = tempToReal.get(prereq);
        if (!sourceId) continue;
        const key = `${sourceId}>${targetId}`;
        if (edgeSet.has(key)) continue;
        edgeSet.add(key);
        edgeRows.push({
          id: crypto.randomUUID(),
          treeId,
          sourceNodeId: sourceId,
          targetNodeId: targetId,
          edgeType: classifySkillTreeEdge({
            prereqIndex: index,
            sourceNodeId: sourceId,
            targetNode: node,
            forkSourceNodeIds,
          }),
          createdAt: now,
        });
      }
    }

    if (edgeRows.length > 0) {
      await Promise.all(edgeRows.map((e) => db.insert(skillTreeEdges).values(e)));
    }

    // 6. Generated assignments — create real assignment rows and link to nodes
    if (data.generatedAssignments.length > 0) {
      // Group by nodeId
      const byNode = new Map<string, typeof data.generatedAssignments>();
      for (const a of data.generatedAssignments) {
        const realNodeId = tempToReal.get(a.nodeId);
        if (!realNodeId) continue;
        const key = a.nodeId;
        if (!byNode.has(key)) byNode.set(key, []);
        byNode.get(key)!.push(a);
      }

      for (const [tempNodeId, nodeAssignments] of byNode.entries()) {
        const realNodeId = tempToReal.get(tempNodeId);
        if (!realNodeId) continue;
        for (let i = 0; i < nodeAssignments.length; i++) {
          const a = nodeAssignments[i];
          const assignmentId = crypto.randomUUID();
          await db.insert(assignments).values({
            id: assignmentId,
            organizationId,
            classId,
            title: a.title,
            description: a.description || null,
            contentType: a.contentType,
            contentRef: a.contentRef || null,
            createdByUserId: session.user.id,
            createdAt: now,
            updatedAt: now,
          });
          await db.insert(skillTreeNodeAssignments).values({
            id: crypto.randomUUID(),
            nodeId: realNodeId,
            assignmentId,
            orderIndex: i,
            createdAt: now,
          });
        }
      }
    }

    return {
      classId,
      treeId,
      nodeCount: normalizedCommitNodes.length,
      edgeCount: edgeRows.length,
      assignmentCount: data.generatedAssignments.length,
    };
  });

// ── Node content population ───────────────────────────────────────────────────

const LLM_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** Generate a short HTML reading passage using the Workers AI LLM. */
async function generateReadingPassageHtml(input: {
  topic: string;
  subject: string;
  gradeLevel: string;
  xpReward: number;
  description?: string;
}): Promise<string> {
  const wordTarget = input.xpReward >= 500 ? 220 : input.xpReward >= 200 ? 150 : 100;
  const prompt = [
    `Write a ${wordTarget}-word educational reading for a grade-${input.gradeLevel} student learning "${input.topic}" in ${input.subject}.`,
    input.description ? `Context: ${input.description}` : "",
    "Use HTML tags <h2>, <p>, <ul>, <li> only. No markdown, no code fences.",
    "Return only the HTML fragment.",
  ]
    .filter(Boolean)
    .join("\n");

  const result = await env.AI.run(LLM_MODEL, {
    messages: [
      { role: "system", content: "You are an educational content writer. Output only HTML." },
      { role: "user", content: prompt },
    ],
    max_tokens: 700,
  });

  const raw =
    typeof result === "string"
      ? result
      : typeof (result as Record<string, unknown>).response === "string"
        ? ((result as Record<string, unknown>).response as string)
        : "";

  const text = raw.trim();
  return text || `<h2>${input.topic}</h2><p>Read about ${input.topic} in ${input.subject} and take notes in your own words.</p>`;
}

/** Build a JSON essay-questions or HTML report prompt (no AI needed). */
function buildReflectionPrompt(input: {
  topic: string;
  subject: string;
  xpReward: number;
  nodeType: string;
  description?: string;
}): { contentType: "essay_questions" | "report"; contentRef: string } {
  const isReport = input.nodeType === "boss" || input.xpReward >= 400;

  if (isReport) {
    const html = [
      `<h2>Research Report: ${input.topic}</h2>`,
      `<p>Write a 2–3 paragraph report about <strong>${input.topic}</strong> in ${input.subject}.</p>`,
      "<h3>Your report should address:</h3>",
      "<ul>",
      `<li>What is ${input.topic} and why does it matter?</li>`,
      "<li>Key facts or examples from your reading and research</li>",
      `<li>How this topic connects to other things you have learned in ${input.subject}</li>`,
      "</ul>",
      input.description ? `<p><em>Hint: ${input.description}</em></p>` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return { contentType: "report", contentRef: html };
  }

  return {
    contentType: "essay_questions",
    contentRef: JSON.stringify({
      questions: [
        `What are the most important ideas you learned about ${input.topic}?`,
        `How does ${input.topic} connect to something you already know?`,
        input.xpReward >= 250
          ? `If you had to teach ${input.topic} to a friend, how would you explain it?`
          : null,
      ].filter(Boolean),
    }),
  };
}

const populateWebNodeContentInput = z.object({
  nodeId: z.string().min(1),
  classId: z.string().min(1),
});

export const populateWebNodeContent = createServerFn({ method: "POST" })
  .inputValidator((data) => populateWebNodeContentInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    // ── Fetch node, tree, class ───────────────────────────────────────────────
    const [node, classRow] = await Promise.all([
      db.query.skillTreeNodes.findFirst({
        where: and(
          eq(skillTreeNodes.id, data.nodeId),
          eq(skillTreeNodes.organizationId, organizationId),
        ),
      }),
      db.query.classes.findFirst({
        where: and(eq(classes.id, data.classId), eq(classes.organizationId, organizationId)),
      }),
    ]);
    if (!node) throw new Error("NODE_NOT_FOUND");
    if (!classRow) throw new Error("CLASS_NOT_FOUND");

    const tree = await db.query.skillTrees.findFirst({
      where: and(eq(skillTrees.id, node.treeId), eq(skillTrees.organizationId, organizationId)),
    });
    if (!tree) throw new Error("TREE_NOT_FOUND");

    const subject = node.subject ?? tree.subject ?? "General Studies";
    const gradeLevel = tree.gradeLevel ?? "mixed";
    const now = new Date().toISOString();

    // Question count scales with XP reward
    const questionCount = node.xpReward >= 400 ? 5 : node.xpReward >= 200 ? 4 : 3;

    const createdIds: string[] = [];
    let orderIndex = 0;

    // ── Helper: insert assignment + link to node ──────────────────────────────
    async function insertAndLink(params: {
      title: string;
      description: string;
      contentType: AssignmentContentType;
      contentRef: string | null;
      linkedAssignmentId?: string;
    }): Promise<string> {
      const assignmentId = crypto.randomUUID();
      await db.insert(assignments).values({
        id: assignmentId,
        organizationId,
        classId: data.classId,
        title: params.title,
        description: params.description || null,
        contentType: params.contentType,
        contentRef: params.contentRef ?? null,
        linkedAssignmentId: params.linkedAssignmentId ?? null,
        dueAt: null,
        createdByUserId: session.user.id,
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(skillTreeNodeAssignments).values({
        id: crypto.randomUUID(),
        nodeId: data.nodeId,
        assignmentId,
        orderIndex: orderIndex++,
        createdAt: now,
      });
      createdIds.push(assignmentId);
      return assignmentId;
    }

    // ── 1. Reading passage — every node gets one ─────────────────────────────
    let readingHtml: string;
    try {
      readingHtml = await generateReadingPassageHtml({
        topic: node.title,
        subject,
        gradeLevel,
        xpReward: node.xpReward,
        description: node.description ?? undefined,
      });
    } catch {
      readingHtml = `<h2>${node.title}</h2><p>Explore ${node.title} in ${subject} through your own research and reading.</p>`;
    }
    const readingId = await insertAndLink({
      title: `Read: ${node.title}`,
      description: `Background reading for ${node.title}.`,
      contentType: "text",
      contentRef: readingHtml,
    });

    // ── 2. Video — lesson, milestone, branch, elective ───────────────────────
    let videoAssignmentId: string | undefined;
    let transcript: string | null = null;

    if (node.nodeType !== "boss") {
      const ytKey = env.YOUTUBE_API_KEY;
      if (ytKey) {
        try {
          const searchQuery = `${node.title} ${subject} grade ${gradeLevel}`;
          const videos = await searchYoutubeForVideos(searchQuery, ytKey);
          const top = videos[0];
          if (top) {
            videoAssignmentId = await insertAndLink({
              title: `Watch: ${top.title}`,
              description: `Video lesson covering ${node.title}.`,
              contentType: "video",
              contentRef: JSON.stringify({
                videos: [{ videoId: top.videoId, title: top.title, channel: top.channel, description: top.description }],
              }),
            });
            const transcriptResult = await fetchYoutubeTranscriptWithMeta(top.videoId);
            transcript = transcriptResult.transcript;
          }
        } catch {
          // YouTube unavailable — continue without video
        }
      }
    }

    // ── 3. Quiz — lesson, milestone, boss ────────────────────────────────────
    if (node.nodeType === "lesson" || node.nodeType === "milestone" || node.nodeType === "boss") {
      try {
        const quiz = await generateQuizDraft({
          topic: node.title,
          gradeLevel,
          questionCount,
          transcript: transcript ?? undefined,
          sourceText: (!transcript && node.description) ? node.description : undefined,
        });
        await insertAndLink({
          title: `Quiz: ${node.title}`,
          description: `Check your understanding of ${node.title}.`,
          contentType: "quiz",
          contentRef: JSON.stringify(quiz),
          linkedAssignmentId: videoAssignmentId,
        });
      } catch {
        // Quiz generation failed — that's OK
      }
    }

    // ── 4. Essay / Report — milestone, boss, elective ────────────────────────
    if (node.nodeType === "milestone" || node.nodeType === "boss" || node.nodeType === "elective") {
      const { contentType: reflectionType, contentRef: reflectionRef } = buildReflectionPrompt({
        topic: node.title,
        subject,
        xpReward: node.xpReward,
        nodeType: node.nodeType,
        description: node.description ?? undefined,
      });
      const isReport = reflectionType === "report";
      await insertAndLink({
        title: isReport ? `Report: ${node.title}` : `Reflect: ${node.title}`,
        description: isReport
          ? `Write a research report about ${node.title}.`
          : `Write a short reflection on what you learned about ${node.title}.`,
        contentType: reflectionType,
        contentRef: reflectionRef,
        linkedAssignmentId: readingId,
      });
    }

    // ── Return freshly created assignments ────────────────────────────────────
    const created = createdIds.length
      ? await db.query.assignments.findMany({ where: inArray(assignments.id, createdIds) })
      : [];

    return { nodeId: data.nodeId, assignments: created };
  });

// ── Curriculum Builder: Full Curriculum (Multi-Course) ────────────────────────

const curriculumRecommendInput = z.object({
  gradeLevel: z.string().min(1),
  ageYears: z.number().int().min(3).max(25),
  duration: z.string().min(1),
  courseCount: z.number().int().min(1).max(12),
  focusSteering: z.string().default(""),
});

export const curriculumRecommendCourses = createServerFn({ method: "POST" })
  .inputValidator((data) => curriculumRecommendInput.parse(data))
  .handler(async ({ data }) => {
    await requireActiveRole(["admin", "parent"]);
    const courses = await recommendCurriculumCourses(data);
    return { courses };
  });

const curriculumBuildSpineInput = z.object({
  subject: z.string().min(1),
  gradeLevel: z.string().min(1),
  courseLength: z.string().min(1),
  interests: z.string().default(""),
  ageYears: z.number().int().optional(),
  focusSteering: z.string().default(""),
});

export const curriculumBuildSpine = createServerFn({ method: "POST" })
  .inputValidator((data) => curriculumBuildSpineInput.parse(data))
  .handler(async ({ data }) => {
    await requireActiveRole(["admin", "parent"]);
    const nodes = await generateCurriculumSpine(data);
    return { nodes };
  });

const curriculumBuildChapterInput = z.object({
  subject: z.string().min(1),
  gradeLevel: z.string().min(1),
  milestoneId: z.string().min(1),
  milestoneTitle: z.string().min(1),
  milestoneDescription: z.string().default(""),
  milestoneDepth: z.number().int().default(0),
  existingTitles: z.array(z.string()).default([]),
  ageYears: z.number().int().optional(),
  focusSteering: z.string().default(""),
});

export const curriculumBuildChapter = createServerFn({ method: "POST" })
  .inputValidator((data) => curriculumBuildChapterInput.parse(data))
  .handler(async ({ data }) => {
    await requireActiveRole(["admin", "parent"]);
    const nodes = await generateChapterCluster(data);
    return { nodes };
  });

const curriculumBuildBranchInput = z.object({
  subject: z.string().min(1),
  gradeLevel: z.string().min(1),
  lessonId: z.string().min(1),
  lessonTitle: z.string().min(1),
  lessonDescription: z.string().default(""),
  lessonDepth: z.number().int().default(0),
  milestoneTitle: z.string().min(1),
  existingTitles: z.array(z.string()).default([]),
  ageYears: z.number().int().optional(),
  focusSteering: z.string().default(""),
});

export const curriculumBuildBranch = createServerFn({ method: "POST" })
  .inputValidator((data) => curriculumBuildBranchInput.parse(data))
  .handler(async ({ data }) => {
    await requireActiveRole(["admin", "parent"]);
    const nodes = await generateBranchCluster(data);
    return { nodes };
  });

const curriculumGenerateAssignmentsInput = z.object({
  subject: z.string().min(1),
  gradeLevel: z.string().min(1),
  node: z.object({
    tempId: z.string().min(1),
    title: z.string().min(1),
    description: z.string().default(""),
    nodeType: z.string().default("lesson"),
  }),
  prefs: z.object({
    readingPerNode: z.boolean().default(true),
    videosPerLesson: z.number().int().default(2),
    chapterIntroVideo: z.boolean().default(true),
    quizzesPerChapter: z.number().int().default(1),
    essaysPerChapter: z.number().int().default(1),
    quizzesPerBoss: z.number().int().default(3),
    essaysPerBoss: z.number().int().default(1),
    papersPerBoss: z.number().int().default(0),
    includeProjects: z.boolean().default(false),
    includeMovies: z.boolean().default(false),
    otherInstructions: z.string().default(""),
  }),
  ageYears: z.number().int().optional(),
  focusSteering: z.string().default(""),
  resolveYoutubeIds: z.boolean().default(false),
});

export const curriculumGenerateAssignments = createServerFn({ method: "POST" })
  .inputValidator((data) => curriculumGenerateAssignmentsInput.parse(data))
  .handler(async ({ data }) => {
    await requireActiveRole(["admin", "parent"]);
    const youtubeApiKey = data.resolveYoutubeIds
      ? ((env as unknown as Record<string, string | undefined>).YOUTUBE_API_KEY ?? undefined)
      : undefined;
    const assignments = await generateAssignmentsForNode({
      subject: data.subject,
      gradeLevel: data.gradeLevel,
      node: data.node,
      prefs: data.prefs,
      youtubeApiKey,
      ageYears: data.ageYears,
      focusSteering: data.focusSteering || undefined,
    });
    return { assignments };
  });

const curriculumGenerateLessonReadingInput = z.object({
  nodeTitle: z.string().min(1),
  nodeDescription: z.string().default(""),
  subject: z.string().min(1),
  gradeLevel: z.string().min(1),
  ageYears: z.number().int().default(12),
  focusSteering: z.string().default(""),
  nodeType: z.string().default("lesson"),
});

export const curriculumGenerateLessonReading = createServerFn({ method: "POST" })
  .inputValidator((data) => curriculumGenerateLessonReadingInput.parse(data))
  .handler(async ({ data }) => {
    await requireActiveRole(["admin", "parent"]);
    const html = await generateLessonReading({
      nodeTitle: data.nodeTitle,
      nodeDescription: data.nodeDescription,
      subject: data.subject,
      gradeLevel: data.gradeLevel,
      ageYears: data.ageYears,
      focusSteering: data.focusSteering || undefined,
      nodeType: data.nodeType,
    });
    return { html };
  });

const curriculumLayoutInput = z.object({
  nodes: z.array(z.object({
    tempId: z.string(),
    prerequisites: z.array(z.string()),
    depth: z.number(),
    cluster: z.string(),
    nodeType: z.string(),
  })),
});

export const curriculumLayoutNodes = createServerFn({ method: "POST" })
  .inputValidator((data) => curriculumLayoutInput.parse(data))
  .handler(async ({ data }) => {
    await requireActiveRole(["admin", "parent"]);
    const result = layoutForceDirected(
      data.nodes.map((n) => ({
        id: n.tempId,
        prerequisites: n.prerequisites,
        depth: n.depth,
        cluster: n.cluster,
        nodeType: n.nodeType,
      })),
      { width: 1200, height: 900 },
    );
    const positions: Record<string, { x: number; y: number }> = {};
    const edges: Array<{ source: string; target: string }> = [];
    for (const node of data.nodes) {
      const pos = result.get(node.tempId);
      if (pos) positions[node.tempId] = pos;
      for (const prereqId of node.prerequisites) {
        edges.push({ source: prereqId, target: node.tempId });
      }
    }
    return { positions, edges };
  });

const curriculumCommitCourseInput = z.object({
  profileId: z.string().min(1),
  classTitle: z.string().min(1),
  treeTitle: z.string().min(1),
  subject: z.string().min(1),
  gradeLevel: z.string().min(1),
  schoolYear: z.string().optional(),
  nodes: z.array(z.object({
    tempId: z.string(),
    title: z.string(),
    description: z.string().default(""),
    icon: z.string().default("📚"),
    colorRamp: z.string().default("blue"),
    nodeType: z.string().default("lesson"),
    cluster: z.string().default("core"),
    depth: z.number().default(0),
    isRequired: z.boolean().default(true),
    xpReward: z.number().default(100),
    prerequisites: z.array(z.string()).default([]),
    x: z.number().default(600),
    y: z.number().default(450),
    suggestedAssignments: z.array(z.object({ type: z.string(), title: z.string() })).default([]),
  })),
  generatedAssignments: z.array(z.object({
    nodeId: z.string(),
    contentType: z.string(),
    title: z.string(),
    description: z.string().default(""),
    contentRef: z.string().default(""),
    linkedFollowUpType: z.string().optional(),
  })).default([]),
});

export const curriculumCommitCourse = createServerFn({ method: "POST" })
  .inputValidator((data) => curriculumCommitCourseInput.parse(data))
  .handler(async ({ data }) => {
    // Reuse the same commit logic as wizardCommitCurriculum by delegating to it.
    // This keeps a single source of truth for DB schema changes.
    const result = await wizardCommitCurriculum({
      data: {
        profileId: data.profileId,
        classTitle: data.classTitle,
        treeTitle: data.treeTitle,
        subject: data.subject,
        gradeLevel: data.gradeLevel,
        schoolYear: data.schoolYear,
        nodes: data.nodes,
        generatedAssignments: data.generatedAssignments,
      },
    });
    return result;
  });

// ── Lessons index ─────────────────────────────────────────────────────────────

export const getLessonsData = createServerFn({ method: "GET" }).handler(async () => {
  const session = await requireActiveRole(["admin", "parent"]);
  const db = getDb();

  const organizationId = await resolveActiveOrganizationId(
    session.user.id,
    session.session.activeOrganizationId,
  );

  // Get all trees for this org
  const treeRows = await db.query.skillTrees.findMany({
    where: eq(skillTrees.organizationId, organizationId),
    orderBy: [desc(skillTrees.createdAt)],
  });

  if (treeRows.length === 0) {
    return { trees: [] };
  }

  const treeIds = treeRows.map((t) => t.id);

  // Get all nodes for all trees
  const allNodes: (typeof skillTreeNodes.$inferSelect)[] = [];
  for (const chunk of chunkIds(treeIds, 30)) {
    const rows = await db.query.skillTreeNodes.findMany({
      where: inArray(skillTreeNodes.treeId, chunk),
      orderBy: [desc(skillTreeNodes.createdAt)],
    });
    allNodes.push(...rows);
  }

  // Get assignment counts per node
  const nodeIds = allNodes.map((n) => n.id);
  const assignmentCounts: Record<string, number> = {};
  if (nodeIds.length > 0) {
    for (const chunk of chunkIds(nodeIds, 50)) {
      const counts = await db
        .select({ nodeId: skillTreeNodeAssignments.nodeId, cnt: count() })
        .from(skillTreeNodeAssignments)
        .where(inArray(skillTreeNodeAssignments.nodeId, chunk))
        .groupBy(skillTreeNodeAssignments.nodeId);
      for (const row of counts) {
        assignmentCounts[row.nodeId] = row.cnt;
      }
    }
  }

  // Group nodes by tree
  const nodesByTree = new Map<string, typeof allNodes>();
  for (const node of allNodes) {
    const existing = nodesByTree.get(node.treeId) ?? [];
    existing.push(node);
    nodesByTree.set(node.treeId, existing);
  }

  const trees = treeRows.map((tree) => ({
    id: tree.id,
    title: tree.title,
    subject: tree.subject,
    gradeLevel: tree.gradeLevel,
    schoolYear: tree.schoolYear,
    nodes: (nodesByTree.get(tree.id) ?? []).map((n) => ({
      id: n.id,
      title: n.title,
      description: n.description,
      nodeType: n.nodeType,
      subject: n.subject,
      icon: n.icon,
      colorRamp: n.colorRamp,
      xpReward: n.xpReward,
      assignmentCount: assignmentCounts[n.id] ?? 0,
    })),
  }));

  return { trees };
});
