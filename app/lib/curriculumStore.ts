// ── Curriculum Job Store ──────────────────────────────────────────────────────
// localStorage-persisted state for background multi-course curriculum building.
// Survives navigation and tab refreshes. Schema-versioned key prevents stale data.

const JOB_KEY = "proorca.curriculumJob.v1";

// ── Types ─────────────────────────────────────────────────────────────────────

export type CurriculumDuration = "6 Weeks" | "9 Weeks" | "12 Weeks" | "1 Semester" | "1 Year";

export type AssignmentWeight = "light" | "medium" | "heavy" | "custom";

export type BuilderAssignmentPrefs = {
  readingPerNode: boolean;
  videosPerLesson: number;
  chapterIntroVideo: boolean;
  quizzesPerChapter: number;
  essaysPerChapter: number;
  quizzesPerBoss: number;
  essaysPerBoss: number;
  papersPerBoss: number;
  includeProjects: boolean;
  includeMovies: boolean;
  otherInstructions: string;
};

export type CurriculumDesignInput = {
  profileId: string;
  studentName: string;
  gradeLevel: string;
  ageYears: number;
  duration: CurriculumDuration;
  courseCount: number;
  assignmentWeight: AssignmentWeight;
  assignmentPrefs?: BuilderAssignmentPrefs;
  focusSteering: string;
  schoolYear: string;
};

export type CourseSlot = {
  id: string;
  name: string;
  subject: string;
  description: string;
  courseLength: string;
  approved: boolean;
};

export type ClusterProgress = {
  nodeId: string;
  nodeTitle: string;
  status: "pending" | "running" | "done" | "skipped";
  nodeCount: number;
};

export type StoredSpineNode = {
  tempId: string;
  title: string;
  description: string;
  icon: string;
  colorRamp: string;
  nodeType: string;
  cluster: string;
  depth: number;
  isRequired: boolean;
  xpReward: number;
  prerequisites: string[];
  suggestedAssignments: Array<{ type: string; title: string }>;
};

export type StoredRawNode = StoredSpineNode & {
  x?: number;
  y?: number;
};

export type StoredAssignment = {
  nodeId: string;
  contentType: string;
  title: string;
  description: string;
  contentRef: string;
  linkedFollowUpType?: string;
};

export type CourseJobStatus =
  | "pending"
  | "spine_running"
  | "spine_done"
  | "lessons_running"
  | "lessons_done"
  | "branches_running"
  | "branches_done"
  | "assignments_running"
  | "assignments_done"
  | "layout_done"
  | "committed"
  | "failed";

export type CourseJob = {
  slotId: string;
  name: string;
  subject: string;
  status: CourseJobStatus;
  errorMessage?: string;
  spineNodes: StoredSpineNode[];
  rawNodes: StoredRawNode[];
  assignments: StoredAssignment[];
  committedTreeId?: string;
  chapterProgress: ClusterProgress[];
  branchProgress: ClusterProgress[];
  assignmentProgress: ClusterProgress[];
};

export type CurriculumJobOverallStatus =
  | "designing"
  | "building"
  | "review"
  | "committing"
  | "done"
  | "failed";

export type CurriculumJob = {
  jobId: string;
  createdAt: string;
  designInput: CurriculumDesignInput;
  courses: CourseSlot[];
  courseJobs: CourseJob[];
  overallStatus: CurriculumJobOverallStatus;
  wave1Done: boolean;
  wave2Done: boolean;
  wave3Done: boolean;
};

// ── Persistence helpers ───────────────────────────────────────────────────────

export function saveCurriculumJob(job: CurriculumJob): void {
  try {
    // Strip large contentRef HTML to keep localStorage size manageable.
    // Full contentRef is preserved for video/quiz/essay (small), stripped for text (large HTML).
    const compact: CurriculumJob = {
      ...job,
      courseJobs: job.courseJobs.map((cj) => ({
        ...cj,
        assignments: cj.assignments.map((a) => ({
          ...a,
          // Truncate text contentRef to 500 chars to save space; commit reads from
          // the generated assignments that are passed directly, not from localStorage.
          contentRef: a.contentType === "text" ? a.contentRef.slice(0, 500) : a.contentRef,
        })),
      })),
    };
    localStorage.setItem(JOB_KEY, JSON.stringify(compact));
  } catch {
    // Quota exceeded or private mode — silently continue, UI still works in-memory.
  }
}

export function loadCurriculumJob(): CurriculumJob | null {
  try {
    const raw = localStorage.getItem(JOB_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CurriculumJob;
    // Basic shape validation
    if (!parsed.jobId || !parsed.courseJobs || !parsed.designInput) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearCurriculumJob(): void {
  try {
    localStorage.removeItem(JOB_KEY);
  } catch {
    // ignore
  }
}

export function updateCurriculumJobCourse(
  jobId: string,
  slotId: string,
  patch: Partial<CourseJob>,
): CurriculumJob | null {
  const job = loadCurriculumJob();
  if (!job || job.jobId !== jobId) return null;

  const updated: CurriculumJob = {
    ...job,
    courseJobs: job.courseJobs.map((cj) =>
      cj.slotId === slotId ? { ...cj, ...patch } : cj,
    ),
  };
  saveCurriculumJob(updated);
  return updated;
}

export function removeCurriculumJobCourse(
  jobId: string,
  slotId: string,
): CurriculumJob | null {
  const job = loadCurriculumJob();
  if (!job || job.jobId !== jobId) return null;

  const updated: CurriculumJob = {
    ...job,
    courseJobs: job.courseJobs.filter((cj) => cj.slotId !== slotId),
    courses: job.courses.filter((c) => c.id !== slotId),
  };
  
  if (updated.courseJobs.length === 0) {
    clearCurriculumJob();
    return null;
  }
  
  saveCurriculumJob(updated);
  return updated;
}

export function updateCurriculumJobRoot(
  jobId: string,
  patch: Partial<CurriculumJob>,
): CurriculumJob | null {
  const job = loadCurriculumJob();
  if (!job || job.jobId !== jobId) return null;

  const updated: CurriculumJob = { ...job, ...patch };
  saveCurriculumJob(updated);
  return updated;
}

// ── Progress computation ──────────────────────────────────────────────────────

export function computeOverallProgress(job: CurriculumJob): number {
  const total = job.courseJobs.length;
  if (total === 0) return 0;

  const WEIGHTS = {
    pending: 0,
    spine_running: 0.05,
    spine_done: 0.15,
    lessons_running: 0.25,
    lessons_done: 0.45,
    branches_running: 0.5,
    branches_done: 0.65,
    assignments_running: 0.75,
    assignments_done: 0.90,
    layout_done: 0.95,
    committed: 1.0,
    failed: 0,
  } satisfies Record<CourseJobStatus, number>;

  const sum = job.courseJobs.reduce((acc, cj) => acc + (WEIGHTS[cj.status] ?? 0), 0);
  return Math.round((sum / total) * 100);
}

export function isCurriculumJobActive(job: CurriculumJob | null): boolean {
  if (!job) return false;
  return job.overallStatus === "building" || job.overallStatus === "committing";
}

export function createAssignmentPrefsForWeight(weight: AssignmentWeight): BuilderAssignmentPrefs {
  if (weight === "light") {
    return {
      readingPerNode: true,
      videosPerLesson: 1,
      chapterIntroVideo: true,
      quizzesPerChapter: 1,
      essaysPerChapter: 0,
      quizzesPerBoss: 2,
      essaysPerBoss: 1,
      papersPerBoss: 0,
      includeProjects: false,
      includeMovies: false,
      otherInstructions: "",
    };
  }

  if (weight === "heavy") {
    return {
      readingPerNode: true,
      videosPerLesson: 2,
      chapterIntroVideo: true,
      quizzesPerChapter: 2,
      essaysPerChapter: 2,
      quizzesPerBoss: 4,
      essaysPerBoss: 2,
      papersPerBoss: 1,
      includeProjects: true,
      includeMovies: true,
      otherInstructions: "",
    };
  }

  return {
    readingPerNode: true,
    videosPerLesson: 2,
    chapterIntroVideo: true,
    quizzesPerChapter: 1,
    essaysPerChapter: 1,
    quizzesPerBoss: 3,
    essaysPerBoss: 1,
    papersPerBoss: 0,
    includeProjects: false,
    includeMovies: false,
    otherInstructions: "",
  };
}

export function createInitialCurriculumJob(
  designInput: CurriculumDesignInput,
  courses: CourseSlot[],
): CurriculumJob {
  return {
    jobId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    designInput,
    courses,
    courseJobs: courses.map((slot) => ({
      slotId: slot.id,
      name: slot.name,
      subject: slot.subject,
      status: "pending",
      spineNodes: [],
      rawNodes: [],
      assignments: [],
      chapterProgress: [],
      branchProgress: [],
      assignmentProgress: [],
    })),
    overallStatus: "building",
    wave1Done: false,
    wave2Done: false,
    wave3Done: false,
  };
}
