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
  generateWeekPlanWithAI as aiGenerateWeekPlan,
  gradeSubmission,
  layoutForceDirected,
  reweaveCurriculumTree,
  searchYoutubeForVideos,
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

const contentResetWithPinInput = z.object({
  parentPin: z.string().regex(/^\d{4,6}$/),
});

const DEMO_STUDENTS = [
  { displayName: "Ava Rivers", gradeLevel: "3" },
  { displayName: "Noah Chen", gradeLevel: "5" },
  { displayName: "Mia Patel", gradeLevel: "7" },
  { displayName: "Lucas Gomez", gradeLevel: "9" },
] as const;

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

function buildDemoAssignments(
  gradeLevel: string,
  studentName: string,
  subject: string,
) {
  if (subject === "Math") {
    return [
      {
        title: `Demo · Number Sense Foundations (Grade ${gradeLevel})`,
        description: `Warm up with core number sense strategies for ${studentName}.`,
        contentType: "text" as const,
        contentRef:
          "<h2>Number Sense Warmup</h2><p>Read the examples and explain your strategy for each problem in your own words.</p>",
      },
      {
        title: `Demo · Algebra Checkpoint Quiz (Grade ${gradeLevel})`,
        description: "Quick check on order of operations and variables.",
        contentType: "quiz" as const,
        contentRef: JSON.stringify({
          title: "Algebra Checkpoint",
          questions: [
            {
              question: "What is 3 + 4 × 2?",
              options: ["14", "11", "16", "10"],
              answerIndex: 1,
              explanation: "Multiply first, then add.",
            },
            {
              question: "Solve for x: x + 5 = 12",
              options: ["5", "6", "7", "8"],
              answerIndex: 2,
              explanation: "Subtract 5 from both sides.",
            },
            {
              question: "What is 24 ÷ (3 × 2)?",
              options: ["4", "8", "6", "12"],
              answerIndex: 0,
              explanation: "Evaluate inside parentheses first.",
            },
          ],
        }),
      },
      {
        title: `Demo · Multi-Step Problem Solving Report`,
        description: "Show your process and explain your reasoning.",
        contentType: "report" as const,
        contentRef:
          "<h3>Report Prompt</h3><p>Choose one multi-step word problem, solve it, and explain each step clearly.</p>",
      },
      {
        title: `Demo · Fractions Video Lesson`,
        description: "Watch and summarize key fraction strategies.",
        contentType: "video" as const,
        contentRef: JSON.stringify({
          videos: [
            {
              videoId: "demo-fractions-101",
              title: "Fractions in Real Life",
              channel: "ProOrca Demo",
              description: "Conceptual intro to fractions.",
              thumbnail: "https://i.ytimg.com/vi/demo-fractions-101/hqdefault.jpg",
              transcript: "Fractions represent equal parts of a whole...",
            },
          ],
        }),
      },
    ];
  }

  if (subject === "Science") {
    return [
      {
        title: `Demo · Cell Biology Reading`,
        description: "Guided reading on cell structure and function.",
        contentType: "text" as const,
        contentRef:
          "<h2>Cells 101</h2><p>Read this overview and write five facts about organelles.</p>",
      },
      {
        title: `Demo · Scientific Method Quiz`,
        description: "Identify variables, hypothesis, and conclusions.",
        contentType: "quiz" as const,
        contentRef: JSON.stringify({
          title: "Scientific Method Quiz",
          questions: [
            {
              question: "What step comes after forming a hypothesis?",
              options: ["Draw conclusions", "Run an experiment", "Ask a question", "Share results"],
              answerIndex: 1,
              explanation: "You test the hypothesis with an experiment.",
            },
            {
              question: "Which is the independent variable?",
              options: ["The measured outcome", "The changed factor", "The control group", "The data chart"],
              answerIndex: 1,
              explanation: "The independent variable is what you change.",
            },
          ],
        }),
      },
      {
        title: `Demo · Lab Reflection Report`,
        description: "Document observations, data, and conclusions.",
        contentType: "report" as const,
        contentRef:
          "<h3>Lab Reflection</h3><p>Summarize your experiment setup, observations, and what your data suggests.</p>",
      },
      {
        title: `Demo · Photosynthesis Resource`,
        description: "Explore visual explanations and key vocabulary.",
        contentType: "url" as const,
        contentRef: "https://en.wikipedia.org/wiki/Photosynthesis",
      },
    ];
  }

  if (subject === "US History") {
    return [
      {
        title: `Demo · American Revolution Overview`,
        description: "Read about causes and major turning points.",
        contentType: "text" as const,
        contentRef:
          "<h2>American Revolution</h2><p>Explain three causes of the revolution and one long-term effect.</p>",
      },
      {
        title: `Demo · Constitution Essay Questions`,
        description: "Respond to open-ended historical prompts.",
        contentType: "essay_questions" as const,
        contentRef: JSON.stringify({
          questions: [
            "Why did the founders design checks and balances?",
            "How did the Constitution shape federal and state powers?",
          ],
        }),
      },
      {
        title: `Demo · Timeline Quiz`,
        description: "Sequence key events from colonial period to founding.",
        contentType: "quiz" as const,
        contentRef: JSON.stringify({
          title: "US History Timeline Quiz",
          questions: [
            {
              question: "Which document came first?",
              options: ["US Constitution", "Declaration of Independence", "Bill of Rights", "Articles of Confederation"],
              answerIndex: 1,
              explanation: "The Declaration came in 1776.",
            },
            {
              question: "The Bill of Rights was added to address:",
              options: ["Tax policy", "Individual liberties", "Territory borders", "Trade treaties"],
              answerIndex: 1,
              explanation: "It protects rights and freedoms.",
            },
          ],
        }),
      },
      {
        title: `Demo · Primary Source Report`,
        description: "Analyze one historical source in context.",
        contentType: "report" as const,
        contentRef:
          "<h3>Source Analysis</h3><p>Choose one primary source and explain audience, purpose, and historical impact.</p>",
      },
    ];
  }

  return [
    {
      title: `Demo · Reading and Vocabulary (${subject})`,
      description: "Read and annotate key ideas.",
      contentType: "text" as const,
      contentRef: `<h2>${subject} Reading</h2><p>Read and summarize the most important ideas from this lesson.</p>`,
    },
    {
      title: `Demo · Quick Check Quiz (${subject})`,
      description: "Short understanding check.",
      contentType: "quiz" as const,
      contentRef: JSON.stringify({
        title: `${subject} Quick Check`,
        questions: [
          {
            question: `What is the main focus of ${subject}?`,
            options: ["Option A", "Option B", "Option C", "Option D"],
            answerIndex: 0,
            explanation: "This is a demo question.",
          },
        ],
      }),
    },
    {
      title: `Demo · Written Response (${subject})`,
      description: "Respond in complete sentences.",
      contentType: "essay_questions" as const,
      contentRef: JSON.stringify({
        questions: [
          `Describe one important concept from ${subject}.`,
          "What evidence supports your explanation?",
        ],
      }),
    },
    {
      title: `Demo · Reflection Report (${subject})`,
      description: "Summarize what you learned this week.",
      contentType: "report" as const,
      contentRef: "<p>Write a short reflection on this week's learning.</p>",
    },
  ];
}

type DemoAssignmentSeed = ReturnType<typeof buildDemoAssignments>[number];
type DemoTreeScale = "small" | "medium" | "large" | "very_large";

const DEMO_NODE_TOPICS: Record<string, string[]> = {
  Math: [
    "Number Sense",
    "Operations Fluency",
    "Fractions",
    "Decimals",
    "Ratios",
    "Expressions",
    "Equations",
    "Graphing",
    "Geometry Basics",
    "Data and Probability",
  ],
  Science: [
    "Scientific Method",
    "Cells",
    "Genetics",
    "Ecosystems",
    "Matter and Energy",
    "Forces and Motion",
    "Earth Systems",
    "Chemistry Reactions",
    "Astronomy",
    "Engineering Design",
  ],
  "US History": [
    "Colonial America",
    "Revolution",
    "Constitution",
    "Early Republic",
    "Westward Expansion",
    "Civil War",
    "Reconstruction",
    "Industrialization",
    "World Wars",
    "Modern America",
  ],
};

function getNodeCountForScale(scale: DemoTreeScale) {
  if (scale === "small") return 5;
  if (scale === "medium") return 10;
  if (scale === "large") return 18;
  return 56;
}

function getClassTreeScales(
  subject: string,
  studentIndex: number,
): Array<{ label: string; scale: DemoTreeScale }> {
  const primaryScale: DemoTreeScale =
    subject === "Math" ? "medium" : subject === "Science" ? "medium" : "small";

  const specs: Array<{ label: string; scale: DemoTreeScale }> = [
    { label: "Core", scale: primaryScale },
  ];

  if (subject === "Science" && studentIndex === 2) {
    specs.push({ label: "Lab Expedition", scale: "large" });
  }

  if (subject === "US History" && studentIndex === DEMO_STUDENTS.length - 1) {
    specs.push({ label: "Mastery Marathon", scale: "very_large" });
  }

  return specs;
}

function buildNodeAssignmentSeeds(
  subject: string,
  gradeLevel: string,
  studentName: string,
  nodeTitle: string,
  nodeIndex: number,
): DemoAssignmentSeed[] {
  const lessonType = (["text", "video", "url"][nodeIndex % 3] ?? "text") as
    | "text"
    | "video"
    | "url";
  const lessonTitle = `Demo · ${nodeTitle} Lesson`;
  const lessonDescription = `Core lesson work for ${studentName} in ${subject}.`;
  const lessonContentRef =
    lessonType === "video"
      ? JSON.stringify({
          videos: [
            {
              videoId: `demo-${subject.toLowerCase().replace(/\s+/g, "-")}-${nodeIndex + 1}`,
              title: `${nodeTitle} Walkthrough`,
              channel: "ProOrca Demo",
              description: `Guided walkthrough for ${nodeTitle}.`,
              thumbnail: "https://i.ytimg.com/vi/demo/hqdefault.jpg",
              transcript: `This demo video explains ${nodeTitle} for grade ${gradeLevel}.`,
            },
          ],
        })
      : lessonType === "url"
        ? `https://en.wikipedia.org/wiki/${encodeURIComponent(nodeTitle)}`
        : `<h2>${nodeTitle}</h2><p>Read and summarize the most important ideas for grade ${gradeLevel}.</p>`;

  return [
    {
      title: lessonTitle,
      description: lessonDescription,
      contentType: lessonType,
      contentRef: lessonContentRef,
    },
    {
      title: `Demo · ${nodeTitle} Quiz`,
      description: "Auto-graded checkpoint linked to the lesson.",
      contentType: "quiz",
      contentRef: JSON.stringify({
        title: `${nodeTitle} Checkpoint`,
        questions: [
          {
            question: `Which statement best matches ${nodeTitle}?`,
            options: ["Key idea A", "Key idea B", "Key idea C", "Key idea D"],
            answerIndex: 0,
            explanation: "This is the demo correct response.",
          },
          {
            question: `How is ${nodeTitle} used in ${subject}?`,
            options: ["Approach 1", "Approach 2", "Approach 3", "Approach 4"],
            answerIndex: 1,
            explanation: "This option best matches the demo lesson objective.",
          },
        ],
      }),
    },
    ...(nodeIndex % 6 === 0
      ? [
          {
            title: `Demo · ${nodeTitle} Reflection`,
            description: "Linked written response after quiz completion.",
            contentType: (nodeIndex % 2 === 0 ? "report" : "essay_questions") as
              | "report"
              | "essay_questions",
            contentRef:
              nodeIndex % 2 === 0
                ? `<h3>${nodeTitle} Reflection</h3><p>Explain what you learned and how you would apply it.</p>`
                : JSON.stringify({
                    questions: [
                      `What is the most important idea in ${nodeTitle}?`,
                      `How confident are you with ${nodeTitle}, and what would help next?`,
                    ],
                  }),
          },
        ]
      : []),
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
    const subjectCycle = ["Math", "Science", "US History"] as const;
    const now = new Date();
    const monday = new Date(now);
    const day = monday.getDay();
    const shift = day === 0 ? -6 : 1 - day;
    monday.setDate(monday.getDate() + shift);
    monday.setHours(0, 0, 0, 0);

    let classesCreated = 0;
    let studentsCreated = 0;
    let assignmentsCreated = 0;
    let templatesCreated = 0;
    let treesCreated = 0;

    for (const [studentIndex, student] of DEMO_STUDENTS.entries()) {
      const profileId = crypto.randomUUID();
      const pinHash = await hashStudentPin("1111");

      await db.insert(profiles).values({
        id: profileId,
        organizationId,
        parentUserId: session.user.id,
        displayName: student.displayName,
        gradeLevel: student.gradeLevel,
        pinHash,
        status: "active",
      });
      studentsCreated += 1;

      for (const subject of subjectCycle) {
        const classId = crypto.randomUUID();
        await db.insert(classes).values({
          id: classId,
          organizationId,
          title: `Demo · Grade ${student.gradeLevel} ${subject}`,
          description: `Demo curriculum track for ${student.displayName}`,
          schoolYear,
          createdByUserId: session.user.id,
        });
        classesCreated += 1;

        await db.insert(classEnrollments).values({
          id: crypto.randomUUID(),
          classId,
          profileId,
        });

        const templateSource = buildDemoAssignments(student.gradeLevel, student.displayName, subject)[0];
        const topicPool = DEMO_NODE_TOPICS[subject] ?? [
          `${subject} Foundations`,
          `${subject} Practice`,
          `${subject} Checkpoint`,
          `${subject} Mastery`,
        ];
        const classTreeSpecs = getClassTreeScales(subject, studentIndex);
        const quizAssignmentIds: string[] = [];
        const writtenAssignmentIds: string[] = [];
        let weekPlanSeeded = 0;

        for (const [treeIndex, treeSpec] of classTreeSpecs.entries()) {
          const treeId = crypto.randomUUID();
          const nodeCount = getNodeCountForScale(treeSpec.scale);
          await db.insert(skillTrees).values({
            id: treeId,
            organizationId,
            classId,
            profileId,
            title: `Demo Skill Map · Grade ${student.gradeLevel} ${subject} (${treeSpec.label})`,
            description: `${treeSpec.scale.replace("_", " ")} progression path for ${student.displayName}`,
            gradeLevel: student.gradeLevel,
            subject,
            schoolYear,
            createdByUserId: session.user.id,
          });
          treesCreated += 1;

          const nodeIds: string[] = [];
          const edgeRows: Array<{
            id: string;
            treeId: string;
            sourceNodeId: string;
            targetNodeId: string;
            edgeType: "required" | "optional" | "bonus";
          }> = [];
          const progressedCutoff = Math.max(2, Math.floor(nodeCount * 0.14));
          const availableCutoff = Math.max(4, Math.floor(nodeCount * 0.28));

          for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex += 1) {
            const nodeId = crypto.randomUUID();
            nodeIds.push(nodeId);
            const column = nodeIndex % 8;
            const row = Math.floor(nodeIndex / 8);
            const topic = topicPool[nodeIndex % topicPool.length] ?? `${subject} Topic`;
            const cycle = Math.floor(nodeIndex / topicPool.length) + 1;
            const nodeTitle = `${topic} ${cycle}`;
            const nodeType: "lesson" | "milestone" | "boss" | "branch" | "elective" =
              nodeIndex === nodeCount - 1
                ? "boss"
                : nodeIndex % 7 === 0
                  ? "milestone"
                  : nodeIndex % 5 === 0
                    ? "branch"
                    : "lesson";

            await db.insert(skillTreeNodes).values({
              id: nodeId,
              treeId,
              organizationId,
              title: nodeTitle,
              description: `Demo ${subject} node ${nodeIndex + 1} of ${nodeCount}.`,
              subject,
              icon: null,
              colorRamp: nodeType === "boss" ? "blue" : nodeType === "milestone" ? "teal" : "blue",
              nodeType,
              xpReward: 80 + (nodeIndex % 6) * 20,
              positionX: 180 + column * 160,
              positionY: 100 + row * 130 + (column % 2 === 0 ? 0 : 20),
              radius: treeSpec.scale === "very_large" ? 24 : 28,
              isRequired: nodeType !== "branch",
            });

            const nodeAssignmentSeeds = buildNodeAssignmentSeeds(
              subject,
              student.gradeLevel,
              student.displayName,
              nodeTitle,
              nodeIndex,
            );

            let previousAssignmentId: string | null = null;
            for (const [orderIndex, assignmentSeed] of nodeAssignmentSeeds.entries()) {
              const assignmentId = crypto.randomUUID();
              const dueAt = new Date(monday);
              dueAt.setDate(monday.getDate() + ((nodeIndex + orderIndex + treeIndex * 2) % 28));
              dueAt.setHours(16 + (orderIndex % 2), 0, 0, 0);

              await db.insert(assignments).values({
                id: assignmentId,
                organizationId,
                classId,
                title: assignmentSeed.title,
                description: assignmentSeed.description,
                contentType: assignmentSeed.contentType,
                contentRef: assignmentSeed.contentRef,
                linkedAssignmentId: previousAssignmentId,
                dueAt: dueAt.toISOString(),
                createdByUserId: session.user.id,
              });
              assignmentsCreated += 1;

              await db.insert(skillTreeNodeAssignments).values({
                id: crypto.randomUUID(),
                nodeId,
                assignmentId,
                orderIndex,
              });

              if (assignmentSeed.contentType === "quiz" && quizAssignmentIds.length < 12) {
                quizAssignmentIds.push(assignmentId);
              }

              if (
                (assignmentSeed.contentType === "report" ||
                  assignmentSeed.contentType === "essay_questions") &&
                writtenAssignmentIds.length < 12
              ) {
                writtenAssignmentIds.push(assignmentId);
              }

              if (orderIndex === 0 && weekPlanSeeded < 20) {
                await db.insert(weekPlan).values({
                  id: crypto.randomUUID(),
                  organizationId,
                  profileId,
                  assignmentId,
                  scheduledDate: dueAt.toISOString().slice(0, 10),
                  orderIndex: weekPlanSeeded,
                });
                weekPlanSeeded += 1;
              }

              previousAssignmentId = assignmentId;
            }

            const progressStatus: "complete" | "in_progress" | "available" | "locked" =
              nodeIndex === 0
                ? "complete"
                : nodeIndex < progressedCutoff
                  ? "in_progress"
                  : nodeIndex < availableCutoff
                    ? "available"
                    : "locked";

            await db.insert(skillTreeNodeProgress).values({
              id: crypto.randomUUID(),
              nodeId,
              profileId,
              treeId,
              status: progressStatus,
              xpEarned: progressStatus === "complete" ? 100 : progressStatus === "in_progress" ? 40 : 0,
              completedAt: progressStatus === "complete" ? new Date().toISOString() : null,
              updatedAt: new Date().toISOString(),
            });

            if (nodeIndex > 0) {
              edgeRows.push({
                id: crypto.randomUUID(),
                treeId,
                sourceNodeId: nodeIds[nodeIndex - 1]!,
                targetNodeId: nodeId,
                edgeType: "required",
              });
            }
            if (nodeIndex > 2 && nodeIndex % 4 === 0) {
              edgeRows.push({
                id: crypto.randomUUID(),
                treeId,
                sourceNodeId: nodeIds[nodeIndex - 3]!,
                targetNodeId: nodeId,
                edgeType: "optional",
              });
            }
            if (nodeIndex > 5 && nodeIndex % 7 === 0) {
              edgeRows.push({
                id: crypto.randomUUID(),
                treeId,
                sourceNodeId: nodeIds[nodeIndex - 6]!,
                targetNodeId: nodeId,
                edgeType: "bonus",
              });
            }
          }

          if (edgeRows.length > 0) {
            await db.insert(skillTreeEdges).values(edgeRows);
          }
        }

        if (quizAssignmentIds[0]) {
          await db.insert(submissions).values({
            id: crypto.randomUUID(),
            organizationId,
            assignmentId: quizAssignmentIds[0],
            profileId,
            submittedByUserId: session.user.id,
            textResponse: JSON.stringify([0, 1]),
            status: "graded",
            score: 91,
            reviewedAt: new Date().toISOString(),
          });
        }

        if (writtenAssignmentIds[0]) {
          await db.insert(submissions).values({
            id: crypto.randomUUID(),
            organizationId,
            assignmentId: writtenAssignmentIds[0],
            profileId,
            submittedByUserId: session.user.id,
            textResponse: "This is a demo submission for parent review.",
            status: "submitted",
          });
        }

        await db.insert(assignmentTemplates).values({
          id: crypto.randomUUID(),
          organizationId,
          title: `${templateSource.title} Template`,
          description: `Reusable demo template for Grade ${student.gradeLevel} ${subject}.`,
          contentType: templateSource.contentType,
          contentRef: templateSource.contentRef,
          tags: JSON.stringify([
            `subject:${subject.toLowerCase().replace(/\s+/g, "-")}`,
            `grade:${student.gradeLevel}`,
            "scope:demo",
          ]),
          isPublic: false,
          createdByUserId: session.user.id,
        });
        templatesCreated += 1;
      }
    }

    return {
      success: true,
      note: "Demo content seeded. Student demo PIN is 1111.",
      summary: {
        studentsCreated,
        classesCreated,
        assignmentsCreated,
        treesCreated,
        templatesCreated,
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

    const [classRows, assignmentRows, userRecord, submissionRows, profileRows, templatesResult, markingPeriodRows] = await Promise.all([
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
    ]);
    const templates: AccessibleAssignmentTemplate[] = templatesResult;

    return {
      parentPinLength: resolveParentPinLength(userRecord?.parentPinLength),
      classes: classRows,
      assignments: assignmentRows,
      markingPeriods: markingPeriodRows,
      templates,
      submissions: submissionRows,
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
  edgeType: z.enum(["required", "optional", "bonus"]).optional(),
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

const PROGRESS_GATING_EDGE_TYPES = new Set(["required", "optional"]);
const SPECIALIZATION_COLOR_RAMPS = ["purple", "amber", "coral", "green"] as const;
const CORE_COLOR_RAMPS = ["blue", "teal"] as const;

function isProgressGatingEdgeType(edgeType: string | null | undefined): edgeType is "required" | "optional" {
  return typeof edgeType === "string" && PROGRESS_GATING_EDGE_TYPES.has(edgeType);
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

  const gatingGroup = params.incomingEdges
    .filter((edge) => isProgressGatingEdgeType(edge.edgeType))
    .map((edge) => edge.sourceNodeId);

  const fallbackGroups = normalizePrerequisiteGroups(
    gatingGroup.length > 0 ? [gatingGroup] : [],
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
      { width: 1200, height: 900 },
    );

    const normalizedEdgeRows: SkillTreeEdgeRow[] = layoutNodes.flatMap((node) =>
      node.prerequisites.map((sourceNodeId, index) => ({
        id: crypto.randomUUID(),
        treeId: data.treeId,
        sourceNodeId,
        targetNodeId: node.tempId,
        edgeType:
          index > 0
            ? "bonus"
            : (existingEdgeTypeByKey.get(`${sourceNodeId}>${node.tempId}`) ??
                (node.cluster === "specialization" || node.nodeType === "elective"
                  ? "optional"
                  : "required")),
        createdAt: now,
      })),
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

        const edgeType: SkillTreeEdgeRow["edgeType"] =
          index > 0
            ? "bonus"
            : node.cluster === "specialization" || node.nodeType === "elective"
              ? "optional"
              : "required";

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
          edgeType:
            suggestion.cluster === "specialization" || suggestion.nodeType === "elective"
              ? "optional"
              : "required",
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

    // d) Insert nodes — build tempId → real ID map first
    const tempIdToRealId = new Map<string, string>();
    for (const suggestion of suggestions) {
      tempIdToRealId.set(suggestion.tempId, crypto.randomUUID());
    }

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
      edgeType: "required" | "optional" | "bonus";
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
          edgeType:
            index > 0
              ? "bonus"
              : suggestion.cluster === "specialization" || suggestion.nodeType === "elective"
                ? "optional"
                : "required",
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
    }),
  ),
});

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
      xpThreshold: tier.xpThreshold ?? Math.round((tier.tierNumber / 10) * totalXpGoal),
      title: tier.title,
      description: tier.description ?? null,
      icon: tier.icon ?? "🎁",
      rewardType: tier.rewardType ?? "treat",
      estimatedValue: tier.estimatedValue ?? null,
      isBonusTier: tier.isBonusTier ?? false,
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
    const threshold =
      data.xpThreshold ?? Math.round((data.tierNumber / 10) * track.totalXpGoal);

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
      count: 10,
    });

    return suggestions;
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

const RICH_DEMO_STUDENTS = [
  { displayName: "Ava Rivers", gradeLevel: "3", performanceTier: "high" as const },
  { displayName: "Noah Chen", gradeLevel: "5", performanceTier: "high" as const },
  { displayName: "Mia Patel", gradeLevel: "7", performanceTier: "medium" as const },
  { displayName: "Lucas Gomez", gradeLevel: "9", performanceTier: "medium" as const },
  { displayName: "Sofia Kim", gradeLevel: "4", performanceTier: "high" as const },
  { displayName: "Ethan Brooks", gradeLevel: "6", performanceTier: "low" as const },
];

const RICH_DEMO_SUBJECTS_BY_GRADE: Record<string, string[]> = {
  "3": ["Math", "Language Arts", "Science", "Social Studies", "Art"],
  "4": ["Math", "Language Arts", "Science", "Social Studies", "Music"],
  "5": ["Math", "Language Arts", "Science", "Social Studies", "Coding Basics"],
  "6": ["Math", "Language Arts", "Life Science", "World History", "Art"],
  "7": ["Pre-Algebra", "Language Arts", "Earth Science", "Geography", "Coding"],
  "9": ["Algebra I", "English 9", "Biology", "World History", "Elective Studio"],
};

const RICH_DEMO_MARKING_PERIODS = [
  { label: "Q1", title: "First Quarter", periodNumber: 1, startDate: "2025-09-01", endDate: "2025-11-14", status: "completed" as const },
  { label: "Q2", title: "Second Quarter", periodNumber: 2, startDate: "2025-11-17", endDate: "2026-01-30", status: "completed" as const },
  { label: "Q3", title: "Third Quarter", periodNumber: 3, startDate: "2026-02-02", endDate: "2026-04-11", status: "active" as const },
  { label: "Q4", title: "Fourth Quarter", periodNumber: 4, startDate: "2026-04-14", endDate: "2026-06-13", status: "upcoming" as const },
];

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
    // Each student gets one class per subject (5 subjects). Classes tagged to Q1 for year-long.
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
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();
    const organizationId = await resolveActiveOrganizationId(
      session.user.id,
      session.session.activeOrganizationId,
    );
    const now = new Date().toISOString();

    type AssignmentEntry = {
      assignmentId: string;
      classId: string;
      profileId: string;
      subject: string;
      gradeLevel: string;
      mpIndex: number;
      assignmentIndex: number;
      contentType: string;
      isVideo: boolean;
      videoAssignmentId?: string;
    };
    const assignmentMap: AssignmentEntry[] = [];

    // Create assignments per class across 3 active marking periods (Q1, Q2, Q3)
    const activePeriods = [0, 1, 2]; // Q1=0, Q2=1, Q3=2

    for (const cls of data.classMap) {
      let assignmentIndexGlobal = 0;
      const studentInfo = RICH_DEMO_STUDENTS.find(s => data.classMap.some(c => c.classId === cls.classId && c.profileId === s.displayName));
      const studentName = RICH_DEMO_STUDENTS.find(s => {
        // find the student whose subjects include this class's subject
        const subs = RICH_DEMO_SUBJECTS_BY_GRADE[cls.gradeLevel] ?? [];
        return subs.includes(cls.subject);
      })?.displayName ?? "Student";

      for (const mpIdx of activePeriods) {
        const mpId = data.markingPeriodIds[mpIdx];
        const periodLabel = RICH_DEMO_MARKING_PERIODS[mpIdx]?.label ?? "Q1";
        const assignmentDefs = buildRichDemoAssignments(cls.subject, cls.gradeLevel, studentName, periodLabel);

        let videoAssignmentId: string | undefined;
        for (const def of assignmentDefs) {
          const assignmentId = crypto.randomUUID();
          const dueAt = getDemoDueDate(mpIdx, assignmentIndexGlobal);
          await db.insert(assignments).values({
            id: assignmentId,
            organizationId,
            classId: cls.classId,
            markingPeriodId: mpId ?? null,
            title: def.title,
            description: def.description,
            contentType: def.contentType,
            contentRef: def.contentRef,
            linkedAssignmentId: def.contentType === "quiz" && videoAssignmentId ? videoAssignmentId : null,
            dueAt,
            createdByUserId: session.user.id,
            createdAt: now,
            updatedAt: now,
          });

          if (def.isVideo) videoAssignmentId = assignmentId;

          assignmentMap.push({
            assignmentId,
            classId: cls.classId,
            profileId: cls.profileId,
            subject: cls.subject,
            gradeLevel: cls.gradeLevel,
            mpIndex: mpIdx,
            assignmentIndex: assignmentIndexGlobal,
            contentType: def.contentType,
            isVideo: !!def.isVideo,
            videoAssignmentId: def.contentType === "quiz" ? videoAssignmentId : undefined,
          });
          assignmentIndexGlobal++;
        }
      }
    }

    return { success: true, assignmentMap, summary: { assignmentsCreated: assignmentMap.length } };
  });

const seedDemoPhase4Input = z.object({
  parentPin: z.string().regex(/^\d{4,6}$/),
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
        { width: 1200, height: 900 },
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

        for (const prerequisiteId of node.prerequisites) {
          await db.insert(skillTreeEdges).values({
            id: crypto.randomUUID(),
            treeId,
            sourceNodeId: prerequisiteId,
            targetNodeId: node.id,
            edgeType: node.cluster === "specialization" ? "optional" : "required",
            createdAt: now,
          });
        }

        treeNodeMap.push({
          nodeId: node.id,
          treeId,
          classId: cls.classId,
          profileId: cls.profileId,
          assignmentIds: [],
          depth: node.depth,
          cluster: node.cluster,
          nodeType: node.nodeType,
          prerequisites: node.prerequisites,
          xpReward: node.xpReward,
        });
      }
    }

    return { success: true, treeNodeMap, summary: { treesCreated: data.classMap.length } };
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
  .handler(async ({ data }) => {
    const session = await requireActiveRole(["admin", "parent"]);
    const db = getDb();
    const now = new Date().toISOString();

    const complexityScoreByContentType: Record<string, number> = {
      text: 1,
      video: 1,
      url: 2,
      file: 2,
      quiz: 3,
      essay_questions: 5,
      report: 6,
    };
    const pairsForTargets = (targetNodeIds: string[], assignmentIds: string[]) => {
      const localPairs: Array<{ nodeId: string; assignmentId: string; orderIndex: number }> = [];
      if (targetNodeIds.length === 0 || assignmentIds.length === 0) {
        return localPairs;
      }

      const nodeOrderCounts = new Map<string, number>();
      for (let index = 0; index < assignmentIds.length; index++) {
        const nodeId = targetNodeIds[index % targetNodeIds.length]!;
        const orderIndex = nodeOrderCounts.get(nodeId) ?? 0;
        localPairs.push({
          nodeId,
          assignmentId: assignmentIds[index]!,
          orderIndex,
        });
        nodeOrderCounts.set(nodeId, orderIndex + 1);
      }

      return localPairs;
    };

    const nodesByClass = new Map<string, typeof data.treeNodeMap>();
    for (const node of data.treeNodeMap) {
      const existing = nodesByClass.get(node.classId) ?? [];
      existing.push(node);
      nodesByClass.set(node.classId, existing);
    }

    const assignmentsByClass = new Map<string, typeof data.assignmentMap>();
    for (const assignment of data.assignmentMap) {
      const existing = assignmentsByClass.get(assignment.classId) ?? [];
      existing.push(assignment);
      assignmentsByClass.set(assignment.classId, existing);
    }

    let linksCreated = 0;
    for (const [classId, classNodes] of nodesByClass) {
      const classAssignments = assignmentsByClass.get(classId) ?? [];
      if (classAssignments.length === 0 || classNodes.length === 0) continue;

      const rankedNodes = [...classNodes].sort((a, b) => {
        const aScore = (a.depth * 10) + (a.cluster === "specialization" ? 18 : 0) + (a.nodeType === "boss" ? 24 : 0);
        const bScore = (b.depth * 10) + (b.cluster === "specialization" ? 18 : 0) + (b.nodeType === "boss" ? 24 : 0);
        return bScore - aScore;
      });
      const rankedAssignments = [...classAssignments].sort((a, b) => {
        const aScore = complexityScoreByContentType[a.contentType] ?? 2;
        const bScore = complexityScoreByContentType[b.contentType] ?? 2;
        return bScore - aScore || b.assignmentIndex - a.assignmentIndex;
      });

      const hardNodes = rankedNodes
        .filter((node) => node.depth >= 5 || node.cluster === "specialization" || node.nodeType === "boss")
        .map((node) => node.nodeId);
      const mediumNodes = rankedNodes
        .filter((node) => node.depth >= 3 && node.depth <= 6 && node.cluster === "core")
        .map((node) => node.nodeId);
      const easyNodes = [...rankedNodes]
        .reverse()
        .filter((node) => node.depth <= 4 && node.cluster === "core")
        .map((node) => node.nodeId);

      const hardAssignments = rankedAssignments
        .filter((assignment) => (complexityScoreByContentType[assignment.contentType] ?? 2) >= 5)
        .map((assignment) => assignment.assignmentId);
      const mediumAssignments = rankedAssignments
        .filter((assignment) => {
          const score = complexityScoreByContentType[assignment.contentType] ?? 2;
          return score >= 3 && score < 5;
        })
        .map((assignment) => assignment.assignmentId);
      const easyAssignments = rankedAssignments
        .filter((assignment) => (complexityScoreByContentType[assignment.contentType] ?? 2) < 3)
        .map((assignment) => assignment.assignmentId);

      const pairs = [
        ...pairsForTargets(hardNodes.length ? hardNodes : rankedNodes.map((node) => node.nodeId), hardAssignments),
        ...pairsForTargets(mediumNodes.length ? mediumNodes : rankedNodes.map((node) => node.nodeId), mediumAssignments),
        ...pairsForTargets(easyNodes.length ? easyNodes : [...rankedNodes].reverse().map((node) => node.nodeId), easyAssignments),
      ];

      for (const chunk of chunkIds(pairs.map((pair) => pair.assignmentId), 50)) {
        const chunkPairs = pairs.filter((pair) => chunk.includes(pair.assignmentId));
        for (const pair of chunkPairs) {
          await db.insert(skillTreeNodeAssignments).values({
            id: crypto.randomUUID(),
            nodeId: pair.nodeId,
            assignmentId: pair.assignmentId,
            orderIndex: pair.orderIndex,
            createdAt: now,
          });
          linksCreated++;
        }
      }
    }

    return { success: true, summary: { nodeAssignmentLinksCreated: linksCreated } };
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

    const REWARD_TIERS_TEMPLATE = [
      { tierNumber: 1, xpThreshold: 500, title: "First Star", icon: "⭐", rewardType: "treat", estimatedValue: "Ice cream outing" },
      { tierNumber: 2, xpThreshold: 1500, title: "Silver Scholar", icon: "🥈", rewardType: "activity", estimatedValue: "Movie night" },
      { tierNumber: 3, xpThreshold: 3000, title: "Gold Champion", icon: "🏆", rewardType: "item", estimatedValue: "$15 book store gift card" },
      { tierNumber: 4, xpThreshold: 5000, title: "Platinum Legend", icon: "💎", rewardType: "experience", estimatedValue: "Day trip of choice" },
      { tierNumber: 5, xpThreshold: 8000, title: "Master Scholar", icon: "🎓", rewardType: "experience", estimatedValue: "Special family experience", isBonusTier: true },
    ];

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

      // Create reward track
      const trackId = crypto.randomUUID();
      await db.insert(rewardTracks).values({
        id: trackId,
        organizationId,
        profileId,
        createdByUserId: session.user.id,
        title: `${student.displayName.split(" ")[0]}'s 2025-2026 Adventure Track`,
        description: `Earn XP by completing lessons and skill trees throughout the school year!`,
        isActive: true,
        schoolYear: RICH_DEMO_SCHOOL_YEAR,
        startedAt: "2025-09-01",
        totalXpGoal: 8000,
        createdAt: now,
        updatedAt: now,
      });
      rewardTracksCreated++;

      // Create tiers
      const tierIds: string[] = [];
      for (const tier of REWARD_TIERS_TEMPLATE) {
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
    const edgeRows: Array<{
      id: string;
      treeId: string;
      sourceNodeId: string;
      targetNodeId: string;
      edgeType: "required" | "optional" | "bonus";
      createdAt: string;
    }> = [];

    for (const node of normalizedCommitNodes) {
      const targetId = tempToReal.get(node.tempId);
      if (!targetId) continue;
      const isSpecializationLane =
        node.cluster === "specialization" ||
        node.nodeType === "elective" ||
        ["purple", "amber", "coral", "green"].includes(node.colorRamp);
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
          edgeType:
            index > 0
              ? "bonus"
              : isSpecializationLane
                ? "optional"
                : "required",
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
