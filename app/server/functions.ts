import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import { and, desc, eq } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { getDb } from "../db/client";
import {
  assignments,
  classes,
  healthCheck,
  memberships,
  organizations,
  profiles,
  submissions,
  users,
} from "../db/schema";
import { auth, getRoleContext, requireActiveRole } from "../lib/auth";
import { generateQuizDraft, searchYoutubeForVideos } from "../lib/ai";

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 8;
const PBKDF2_ITERATIONS = 100000;

function buildCookie(name: string, value: string, maxAgeSeconds = COOKIE_MAX_AGE_SECONDS) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${maxAgeSeconds}`;
}

// Password hashing using PBKDF2 (Web Standard API)
async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const encoder = new TextEncoder();
  const passwordBytes = encoder.encode(password);

  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt,
      hash: "SHA-256",
      iterations: PBKDF2_ITERATIONS,
    },
    await crypto.subtle.importKey("raw", passwordBytes, "PBKDF2", false, ["deriveKey"]),
    { name: "HMAC", hash: "SHA-256", length: 256 },
    true,
    ["sign"]
  );

  const derivedKeyBytes = await crypto.subtle.exportKey("raw", key);
  const saltB64 = btoa(String.fromCharCode(...Array.from(salt)));
  const hashB64 = btoa(String.fromCharCode(...Array.from(new Uint8Array(derivedKeyBytes))));

  return `${saltB64}:${hashB64}`;
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  try {
    const [saltB64, hashB64] = storedHash.split(":");
    if (!saltB64 || !hashB64) return false;

    const salt = new Uint8Array(atob(saltB64).split("").map((c) => c.charCodeAt(0)));
    const encoder = new TextEncoder();
    const passwordBytes = encoder.encode(password);

    const key = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: salt,
        hash: "SHA-256",
        iterations: PBKDF2_ITERATIONS,
      },
      await crypto.subtle.importKey("raw", passwordBytes, "PBKDF2", false, ["deriveKey"]),
      { name: "HMAC", hash: "SHA-256", length: 256 },
      true,
      ["sign"]
    );

    const derivedKeyBytes = await crypto.subtle.exportKey("raw", key);
    const computedHashB64 = btoa(String.fromCharCode(...Array.from(new Uint8Array(derivedKeyBytes))));

    return computedHashB64 === hashB64;
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

    if (data.mode === "parent") {
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

    if (!data.parentPin) {
      throw new Error("PIN_REQUIRED");
    }

    if (!userRecord?.parentPin) {
      throw new Error("FORBIDDEN");
    }

    const parentPinHash = await hashParentPin(data.parentPin);
    if (parentPinHash !== userRecord.parentPin) {
      throw new Error("INVALID_PIN");
    }

    if (!data.profileId) {
      throw new Error("PROFILE_REQUIRED");
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
      eq(profiles.status, "active"),
    ),
    orderBy: [desc(profiles.createdAt)],
  });

  return {
    students: studentRows.map((profile) => ({
      id: profile.id,
      displayName: profile.displayName,
      gradeLevel: profile.gradeLevel ?? "",
      birthDate: profile.birthDate ?? "",
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

  const metricsByStudent = studentRows.reduce<Record<string, Array<{
    classId: string;
    classTitle: string;
    assignedCount: number;
    submittedCount: number;
    completionPercent: number;
    averageScore: number | null;
  }>>>((acc, student) => {
    const assignedClasses = classRows.filter((classRow) => classRow.studentProfileId === student.id);

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
        assignedCount,
        submittedCount,
        completionPercent,
        averageScore,
      };
    });

    return acc;
  }, {});

  return {
    students: studentRows.map((student) => ({
      id: student.id,
      displayName: student.displayName,
      gradeLevel: student.gradeLevel ?? "",
    })),
    metricsByStudent,
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

    const userRecord = await db.query.users.findFirst({
      where: eq(users.id, session.user.id),
    });

    if (!userRecord?.parentPin) {
      throw new Error("FORBIDDEN");
    }

    const parentPinHash = await hashParentPin(data.parentPin);
    if (parentPinHash !== userRecord.parentPin) {
      throw new Error("FORBIDDEN");
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

    if (!userRecord?.parentPin) {
      throw new Error("FORBIDDEN");
    }

    const parentPinHash = await hashParentPin(data.parentPin);
    if (parentPinHash !== userRecord.parentPin) {
      throw new Error("FORBIDDEN");
    }

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

    const actor = await db.query.users.findFirst({
      where: eq(users.id, session.user.id),
    });

    const actorAdminMembership = await db.query.memberships.findFirst({
      where: and(
        eq(memberships.userId, session.user.id),
        eq(memberships.organizationId, organizationId),
        eq(memberships.role, "admin"),
      ),
    });

    if (
      session.activeRole !== "admin" &&
      actor?.role !== "admin" &&
      !actorAdminMembership
    ) {
      throw new Error("FORBIDDEN");
    }

    const organizationRecord = await db.query.organizations.findFirst({
      where: eq(organizations.id, organizationId),
    });

    const memberRows = await db
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
      .orderBy(desc(memberships.createdAt));

    return {
      organization: organizationRecord,
      members: memberRows.map((row) => ({
        ...row,
        isAdmin: row.accountRole === "admin" || row.role === "admin",
      })),
    };
  },
);

const createClassInput = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  studentProfileId: z.string().min(1),
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

    const targetStudent = await db.query.profiles.findFirst({
      where: and(
        eq(profiles.id, data.studentProfileId),
        eq(profiles.parentUserId, session.user.id),
        eq(profiles.organizationId, organizationId),
        eq(profiles.status, "active"),
      ),
    });

    if (!targetStudent) {
      throw new Error("FORBIDDEN");
    }

    await db.insert(classes).values({
      id: classId,
      organizationId,
      title: data.title,
      description: data.description,
      studentProfileId: data.studentProfileId,
      createdByUserId: session.user.id,
    });

    return {
      success: true,
      classId,
    };
  });

const updateClassInput = z.object({
  classId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  studentProfileId: z.string().min(1),
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

    const targetStudent = await db.query.profiles.findFirst({
      where: and(
        eq(profiles.id, data.studentProfileId),
        eq(profiles.parentUserId, session.user.id),
        eq(profiles.organizationId, organizationId),
        eq(profiles.status, "active"),
      ),
    });

    if (!targetStudent) {
      throw new Error("FORBIDDEN");
    }

    await db
      .update(classes)
      .set({
        title: data.title.trim(),
        description: data.description?.trim() || null,
        studentProfileId: data.studentProfileId,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(classes.id, data.classId), eq(classes.organizationId, organizationId)));

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

    const [classRows, studentRows] = await Promise.all([
      db.query.classes.findMany({
        where: eq(classes.organizationId, organizationId),
        orderBy: [desc(classes.createdAt)],
      }),
      db.query.profiles.findMany({
        where: and(
          eq(profiles.parentUserId, session.user.id),
          eq(profiles.organizationId, organizationId),
          eq(profiles.status, "active"),
        ),
        orderBy: [desc(profiles.createdAt)],
      }),
    ]);

    const studentMap = new Map(studentRows.map((student) => [student.id, student]));

    return {
      classes: classRows.map((classRow) => ({
        ...classRow,
        studentProfile: classRow.studentProfileId
          ? (() => {
              const student = studentMap.get(classRow.studentProfileId);
              if (!student) {
                return null;
              }

              return {
                id: student.id,
                displayName: student.displayName,
                gradeLevel: student.gradeLevel ?? null,
              };
            })()
          : null,
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

const createAssignmentInput = z.object({
  classId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  contentType: z.enum(["text", "file", "url", "video", "essay", "quiz"]),
  contentRef: z.string().optional(),
  dueAt: z.string().optional(),
});

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

    const assignmentId = crypto.randomUUID();

    await db.insert(assignments).values({
      id: assignmentId,
      organizationId,
      classId: data.classId,
      title: data.title,
      description: data.description,
      contentType: data.contentType,
      contentRef: data.contentRef,
      dueAt: data.dueAt,
      createdByUserId: session.user.id,
    });

    return {
      success: true,
      assignmentId,
    };
  });

const updateAssignmentInput = z.object({
  assignmentId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
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

    await db
      .update(assignments)
      .set({
        title: data.title.trim(),
        description: data.description?.trim() || null,
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
  const hash = await hashParentPin(pin);
  if (hash !== userRecord.parentPin) throw new Error("INVALID_PIN");
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
    await db.delete(assignments).where(eq(assignments.id, data.id));
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

export const getCurriculumBuilderData = createServerFn({ method: "GET" }).handler(
  async () => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();

    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );

    const [classRows, assignmentRows] = await Promise.all([
      db.query.classes.findMany({
        where: eq(classes.organizationId, organizationId),
        orderBy: [desc(classes.createdAt)],
      }),
      db.query.assignments.findMany({
        where: eq(assignments.organizationId, organizationId),
        orderBy: [desc(assignments.createdAt)],
      }),
    ]);

    return {
      classes: classRows,
      assignments: assignmentRows,
    };
  },
);

const generateQuizInput = z.object({
  topic: z.string().min(3),
  gradeLevel: z.string().optional(),
  questionCount: z.number().int().min(3).max(10).default(5),
});

export const generateQuizDraftForCurriculum = createServerFn({ method: "POST" })
  .inputValidator((data) => generateQuizInput.parse(data))
  .handler(async ({ data }) => {
    await requireActiveRole(["admin", "parent"]);

    const quiz = await generateQuizDraft(data);
    return {
      quiz,
    };
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

    const [assignmentRows, submissionRows] = await Promise.all([
      db.query.assignments.findMany({
        where: eq(assignments.organizationId, organizationId),
        orderBy: [desc(assignments.createdAt)],
      }),
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
      lesson: {
        videoUrl:
          "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
        checkpoints: [
          {
            id: "q1",
            atSeconds: 3,
            prompt: "What is the first visual detail you notice in the flower video?",
          },
          {
            id: "q2",
            atSeconds: 8,
            prompt: "Describe one change you observed after the opening frames.",
          },
        ],
      },
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

    const [classRows, assignmentRows, submissionRows] = await Promise.all([
      db.query.classes.findMany({
        where: eq(classes.organizationId, organizationId),
      }),
      db.query.assignments.findMany({
        where: eq(assignments.organizationId, organizationId),
      }),
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

    const mastery = classRows.map((classRow) => {
      const classAssignments = assignmentRows.filter(
        (assignment) => assignment.classId === classRow.id,
      );

      if (classAssignments.length === 0) {
        return {
          classId: classRow.id,
          classTitle: classRow.title,
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
        classId: classRow.id,
        classTitle: classRow.title,
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
