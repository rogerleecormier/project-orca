import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import { and, between, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { getDb } from "../db/client";
import {
  assignments,
  assignmentTemplates,
  classEnrollments,
  classes,
  healthCheck,
  memberships,
  organizations,
  profiles,
  submissions,
  users,
  weekPlan,
} from "../db/schema";
import { auth, getRoleContext, requireActiveRole } from "../lib/auth";
import {
  fetchYoutubeTranscript,
  fetchYoutubeTranscriptWithMeta,
  generateQuizDraft,
  generateWeekPlanWithAI as aiGenerateWeekPlan,
  gradeSubmission,
  searchYoutubeForVideos,
} from "../lib/ai";

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 8;
const DEFAULT_PBKDF2_ITERATIONS = 100000;
const PASSWORD_HASH_VERSION = "pbkdf2_sha256";
const MIN_PBKDF2_ITERATIONS = 50000;
const MAX_PBKDF2_ITERATIONS = 600000;
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

  return {
    name: userRecord.name ?? "",
    email: userRecord.email ?? "",
    username: userRecord.username ?? "",
    parentPinLength: resolveParentPinLength(userRecord.parentPinLength),
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

const studentDisplayNameSchema = z.string().trim().min(1).max(100);
const studentGradeLevelSchema = z.string().trim().min(1).max(20);

export const getLoginOptions = createServerFn({ method: "GET" }).handler(async () => {
  // No options needed - users enter their username directly
  return {
    parentAccounts: [],
  };
});

const parentLoginInput = z.object({
  username: z.string().min(3).max(20),
  password: z.string().min(8),
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
      nextStep: "student-selection" as const,
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

    const rows = await db.query.profiles.findMany({
      where: and(
        eq(profiles.parentUserId, roleContext.userId),
        eq(profiles.status, "active"),
      ),
    });

    return {
      isAuthenticated: true,
      activeRole: roleContext.activeRole,
      isAdminParent: roleContext.isAdminParent,
      activeProfileId: roleContext.profileId ?? null,
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

    const enrollmentRows = classRows.length
      ? await db.query.classEnrollments.findMany({
          where: inArray(
            classEnrollments.classId,
            classRows.map((classRow) => classRow.id),
          ),
        })
      : [];

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
        sql`${assignmentTemplates.organizationId} is null`,
        sql`${assignmentTemplates.createdByUserId} is null`,
      ),
    ),
  });

  const gradeTag = normalizeTemplateGradeTag(options.gradeLevel);

  return rows
    .map((row): AccessibleAssignmentTemplate => ({
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
    }))
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

    await db
      .update(assignments)
      .set({
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

    const [classRows, assignmentRows, userRecord, submissionRows, profileRows, templates] = await Promise.all([
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
    ]);

    return {
      parentPinLength: resolveParentPinLength(userRecord?.parentPinLength),
      classes: classRows,
      assignments: assignmentRows,
      templates,
      submissions: submissionRows,
      profiles: profileRows,
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
      await db
        .update(submissions)
        .set({
          textResponse: data.textResponse,
          assetKey: assetKey ?? existing.assetKey,
          status: "submitted",
          submittedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
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
        status: "submitted",
      });
    }

    return {
      success: true,
      assetKey: assetKey ?? null,
    };
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
        if (!submission) {
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

    return {
      profile: {
        id: profile.id,
        displayName: profile.displayName,
      },
      mastery,
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

export const getTodaysPlan = createServerFn({ method: "GET" })
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

    // Build week end date (Friday = start + 4 days)
    const weekStart = new Date(data.weekStartDate);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 4);
    const weekEndDate = weekEnd.toISOString().slice(0, 10);

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
          gte(weekPlan.scheduledDate, data.weekStartDate),
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

    return { slots, unscheduled };
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

    // Build week end date
    const weekStart = new Date(data.weekStartDate);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 4);
    const weekEndDate = weekEnd.toISOString().slice(0, 10);

    // Delete existing slots for this week/profile then re-insert
    await db
      .delete(weekPlan)
      .where(
        and(
          eq(weekPlan.organizationId, organizationId),
          eq(weekPlan.profileId, data.profileId),
          gte(weekPlan.scheduledDate, data.weekStartDate),
          lte(weekPlan.scheduledDate, weekEndDate),
        ),
      );

    if (data.slots.length > 0) {
      await db.insert(weekPlan).values(
        data.slots.map((slot) => ({
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

    return { saved: data.slots.length };
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

    const pendingAssignments = await db
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
      .orderBy(assignments.createdAt);

    const unsubmitted = pendingAssignments.filter((a) => !submittedIds.has(a.id));

    const slots = await aiGenerateWeekPlan({
      assignments: unsubmitted,
      gradeLevel: profile.gradeLevel,
      weekStartDate: data.weekStartDate,
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
