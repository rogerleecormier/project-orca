import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import { and, count, desc, eq, gte, inArray, isNull, lte, or, sql, sum } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { getDb } from "../db/client";
import { seedAssignmentTemplates } from "../db/seed-templates";
import {
  assignments,
  assignmentTemplates,
  classEnrollments,
  classes,
  healthCheck,
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
  generateCurriculumTree,
  generateNodeExpansion,
  generateQuizDraft,
  generateRewardSuggestions,
  generateWeekPlanWithAI as aiGenerateWeekPlan,
  gradeSubmission,
  layoutRadialTree,
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

    const classIds = orgClasses.map((row) => row.id);
    const profileIds = orgProfiles.map((row) => row.id);
    const assignmentIds = orgAssignments.map((row) => row.id);
    const treeIds = orgTrees.map((row) => row.id);

    await db.delete(weekPlan).where(eq(weekPlan.organizationId, organizationId));
    await db.delete(submissions).where(eq(submissions.organizationId, organizationId));

    if (treeIds.length > 0) {
      await db.delete(skillTreeNodeProgress).where(inArray(skillTreeNodeProgress.treeId, treeIds));
      await db.delete(skillTreeEdges).where(inArray(skillTreeEdges.treeId, treeIds));
      await db.delete(skillTreeNodes).where(eq(skillTreeNodes.organizationId, organizationId));
      await db.delete(skillTrees).where(eq(skillTrees.organizationId, organizationId));
    }

    if (classIds.length > 0 || profileIds.length > 0) {
      if (classIds.length > 0 && profileIds.length > 0) {
        await db.delete(classEnrollments).where(
          or(
            inArray(classEnrollments.classId, classIds),
            inArray(classEnrollments.profileId, profileIds),
          ),
        );
      } else if (classIds.length > 0) {
        await db.delete(classEnrollments).where(inArray(classEnrollments.classId, classIds));
      } else if (profileIds.length > 0) {
        await db.delete(classEnrollments).where(inArray(classEnrollments.profileId, profileIds));
      }
    }

    if (assignmentIds.length > 0) {
      await db.delete(skillTreeNodeAssignments).where(inArray(skillTreeNodeAssignments.assignmentId, assignmentIds));
    }

    await db.delete(assignments).where(eq(assignments.organizationId, organizationId));
    await db.delete(classes).where(eq(classes.organizationId, organizationId));
    await db.delete(profiles).where(eq(profiles.organizationId, organizationId));
    await db.delete(assignmentTemplates).where(
      or(
        eq(assignmentTemplates.organizationId, organizationId),
        eq(assignmentTemplates.createdByUserId, session.user.id),
      ),
    );

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
  const seededPublicTemplates = seedAssignmentTemplates
    .filter((template) => template.isPublic)
    .map((template): AccessibleAssignmentTemplate => ({
      id: template.id,
      organizationId: template.organizationId,
      title: template.title,
      description: template.description,
      contentType: template.contentType,
      contentRef: template.contentRef,
      tags: parseStoredTemplateTags(template.tags),
      isPublic: template.isPublic,
      createdByUserId: template.createdByUserId,
      scope: "public",
    }));
  const mergedTemplates = [...dbTemplates, ...seededPublicTemplates];
  const dedupedTemplates = mergedTemplates.filter((template, index, list) => (
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

    const [classRows, assignmentRows, userRecord, submissionRows, profileRows, templatesResult] = await Promise.all([
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
    const templates: AccessibleAssignmentTemplate[] = templatesResult;

    return {
      parentPinLength: resolveParentPinLength(userRecord?.parentPinLength),
      classes: classRows,
      assignments: assignmentRows,
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

    const junctionRows = nodeIds.length
      ? await db.query.skillTreeNodeAssignments.findMany({
          where: inArray(skillTreeNodeAssignments.nodeId, nodeIds),
          orderBy: [desc(skillTreeNodeAssignments.orderIndex)],
        })
      : [];

    const assignmentIds = [...new Set(junctionRows.map((j) => j.assignmentId))];

    const assignmentRows = assignmentIds.length
      ? await db.query.assignments.findMany({
          where: inArray(assignments.id, assignmentIds),
        })
      : [];

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
        const incomingEdges = await db.query.skillTreeEdges.findMany({
          where: eq(skillTreeEdges.targetNodeId, edge.targetNodeId),
        });

        const incomingSourceIds = incomingEdges.map((e) => e.sourceNodeId);

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

        const allPrereqsMet = incomingSourceIds.every((id) => completedSet.has(id));

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
          aiGeneratedDescription: suggestion.description || null,
          createdAt: now,
          updatedAt: now,
        });

        const edgeId = crypto.randomUUID();
        await db.insert(skillTreeEdges).values({
          id: edgeId,
          treeId: data.treeId,
          sourceNodeId: data.fromNodeId,
          targetNodeId: nodeId,
          edgeType: "required",
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

    const VALID_TYPES = new Set(["text", "file", "url", "video", "quiz", "essay_questions", "report"]);
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
    const suggestions = await generateCurriculumTree({
      subject: data.subject,
      gradeLevel: data.gradeLevel,
      depth: data.depth ?? 4,
      seedTopic: data.seedTopic,
      existingNodeTitles,
    });

    // c) Compute positions via layoutRadialTree
    const layoutItems = suggestions.map((s) => ({ id: s.tempId, parentId: s.parentTempId }));
    const positionMap = layoutRadialTree(layoutItems);

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
          aiGeneratedDescription: suggestion.description || null,
          createdAt: now,
          updatedAt: now,
        });
      }),
    );

    // e) Insert edges from parentTempId → tempId relationships
    const edgeInserts = suggestions
      .filter((s) => s.parentTempId !== null)
      .map((s) => {
        const sourceId = tempIdToRealId.get(s.parentTempId!);
        const targetId = tempIdToRealId.get(s.tempId);
        if (!sourceId || !targetId) return null;
        return {
          id: crypto.randomUUID(),
          treeId: data.treeId,
          sourceNodeId: sourceId,
          targetNodeId: targetId,
          edgeType: "required" as const,
          createdAt: now,
        };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);

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
