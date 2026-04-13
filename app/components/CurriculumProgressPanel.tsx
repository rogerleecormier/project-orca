import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import {
  type BuilderAssignmentPrefs,
  type CurriculumJob,
  type CourseJob,
  type CourseJobStatus,
  type CurriculumDesignInput,
  type CourseSlot,
  type StoredSpineNode,
  type StoredRawNode,
  type StoredAssignment,
  type VideoEnrichEntry,
  clearCurriculumJob,
  computeOverallProgress,
  createAssignmentPrefsForWeight,
  createInitialCurriculumJob,
  isCurriculumJobActive,
  loadCurriculumJob,
  saveCurriculumJob,
  updateCurriculumJobCourse,
  removeCurriculumJobCourse,
  updateCurriculumJobRoot,
  mergeJobCourse,
  mergeJobRoot,
} from "../lib/curriculumStore";
import {
  autoLayoutSkillTree,
  curriculumBuildBranch,
  curriculumBuildChapter,
  curriculumBuildSpine,
  curriculumCommitCourse,
  curriculumEnrichVideo,
  curriculumGenerateAssignments,
  curriculumGenerateLessonReading,
  curriculumGenerateQuizFromContent,
  curriculumLayoutNodes,
} from "../server/functions";

// ── Context ───────────────────────────────────────────────────────────────────

type CurriculumProgressContextValue = {
  job: CurriculumJob | null;
  startJob: (design: CurriculumDesignInput, courses: CourseSlot[]) => void;
  clearJob: () => void;
  refreshJob: () => void;
  isBuilding: boolean;
  overallPercent: number;
};

const CurriculumProgressContext = createContext<CurriculumProgressContextValue>({
  job: null,
  startJob: () => {},
  clearJob: () => {},
  refreshJob: () => {},
  isBuilding: false,
  overallPercent: 0,
});

export function useCurriculumProgress() {
  return useContext(CurriculumProgressContext);
}

// ── Build orchestration ───────────────────────────────────────────────────────
// Two parallel copies of the job are maintained:
//   • localStorage (via updateCurriculumJobCourse) — compact, text contentRefs
//     stripped to "" so the ~5 MB quota is not exceeded. Used only for resume.
//   • in-memory `mem` — full unstripped copy passed to React state via
//     notifyReact(mem). This is what the UI and commit step read from.

async function runCurriculumBuild(
  job: CurriculumJob,
  notifyReact: (full: CurriculumJob) => void,
): Promise<void> {
  const jobId = job.jobId;
  const { designInput } = job;
  const prefs: BuilderAssignmentPrefs =
    designInput.assignmentPrefs ?? createAssignmentPrefsForWeight(designInput.assignmentWeight);

  // `mem` is the authoritative full in-memory copy; localStorage is the stripped resume copy.
  let mem: CurriculumJob = job;

  function patchCourse(slotId: string, patch: Partial<CourseJob>) {
    // Update localStorage (stripped)
    updateCurriculumJobCourse(jobId, slotId, patch);
    // Update in-memory (full)
    mem = mergeJobCourse(mem, slotId, patch);
    notifyReact(mem);
  }
  function patchRoot(patch: Partial<CurriculumJob>) {
    updateCurriculumJobRoot(jobId, patch);
    mem = mergeJobRoot(mem, patch);
    notifyReact(mem);
  }
  // fresh() still reads localStorage for cross-closure consistency checks
  // (e.g. reading chapterProgress accumulated by parallel branches)
  function fresh() {
    return loadCurriculumJob();
  }
  // freshMem() returns the current in-memory job for reads that need full content
  function freshMem() {
    return mem;
  }

  // ── Resume sanitization ───────────────────────────────────────────────────
  // If the page was refreshed mid-build, courses stuck in a *_running status
  // won't be picked up by any wave filter. Reset them to their previous "done"
  // state so the right wave picks them up for re-processing.
  const RUNNING_TO_RESTART: Record<string, CourseJobStatus> = {
    spine_running:       "pending",
    lessons_running:     "spine_done",
    branches_running:    "lessons_done",
    assignments_running: "branches_done",
  };
  for (const cj of (fresh()?.courseJobs ?? [])) {
    const resetTo = RUNNING_TO_RESTART[cj.status];
    if (resetTo) {
      patchCourse(cj.slotId, { status: resetTo });
    }
  }

  // ── Wave 1: Build all spines concurrently ─────────────────────────────────
  const wave1Job = fresh();
  if (!wave1Job) return;

  await Promise.all(
    wave1Job.courseJobs
      .filter((cj) => cj.status === "pending" || cj.status === "spine_running")
      .map(async (cj) => {
        const slot = wave1Job.courses.find((s) => s.id === cj.slotId);
        if (!slot) return;
        patchCourse(cj.slotId, { status: "spine_running" });
        try {
          const result = await curriculumBuildSpine({
            data: {
              subject: slot.subject,
              gradeLevel: designInput.gradeLevel,
              courseLength: slot.courseLength,
              interests: designInput.focusSteering,
              ageYears: designInput.ageYears,
              focusSteering: designInput.focusSteering,
            },
          });
          patchCourse(cj.slotId, {
            status: "spine_done",
            spineNodes: result.nodes as StoredSpineNode[],
          });
        } catch (err) {
          patchCourse(cj.slotId, {
            status: "failed",
            errorMessage: err instanceof Error ? err.message : String(err),
          });
        }
      }),
  );

  patchRoot({ wave1Done: true });

  // ── Wave 2a: Chapter clusters ─────────────────────────────────────────────
  const afterWave1 = fresh();
  if (!afterWave1) return;

  const spineDone = afterWave1.courseJobs.filter((cj) => cj.status === "spine_done");
  for (const cj of spineDone) {
    patchCourse(cj.slotId, { status: "lessons_running" });
  }

  await Promise.all(
    spineDone.flatMap((cj) => {
      const slot = afterWave1.courses.find((s) => s.id === cj.slotId);
      if (!slot) return [];
      const milestones = cj.spineNodes.filter((n) => n.nodeType !== "boss");
      const existingTitles = cj.spineNodes.map((n) => n.title);

      return milestones.map(async (milestone) => {
        try {
          const result = await curriculumBuildChapter({
            data: {
              subject: slot.subject,
              gradeLevel: designInput.gradeLevel,
              milestoneId: milestone.tempId,
              milestoneTitle: milestone.title,
              milestoneDescription: milestone.description,
              milestoneDepth: milestone.depth,
              existingTitles,
              ageYears: designInput.ageYears,
              focusSteering: designInput.focusSteering,
            },
          });

          const cur = fresh()?.courseJobs.find((j) => j.slotId === cj.slotId);
          const newNodes = (result.nodes as StoredSpineNode[]).map((n) => ({
            ...n,
            prerequisites: n.prerequisites.length > 0 ? n.prerequisites : [milestone.tempId],
          }));
          const merged = [...(cur?.rawNodes ?? cj.spineNodes.map((s) => ({ ...s }))), ...newNodes];
          patchCourse(cj.slotId, {
            rawNodes: merged,
            chapterProgress: [
              ...(cur?.chapterProgress ?? []),
              { nodeId: milestone.tempId, nodeTitle: milestone.title, status: "done", nodeCount: newNodes.length },
            ],
          });
        } catch (err) {
          console.error(`[Wave2a] chapter failed "${milestone.title}" (${milestone.tempId}) course=${cj.slotId}:`, err instanceof Error ? err.message : err);
          const cur = fresh()?.courseJobs.find((j) => j.slotId === cj.slotId);
          patchCourse(cj.slotId, {
            chapterProgress: [
              ...(cur?.chapterProgress ?? []),
              { nodeId: milestone.tempId, nodeTitle: milestone.title, status: "skipped", nodeCount: 0 },
            ],
          });
        }
      });
    }),
  );

  // ── Post-Wave-2a: re-wire spine so milestones connect through chapter lessons ──
  // Without this, spine_N → spine_N+1 directly while chapter lessons hang off to the side.
  // With this, the required chain becomes: spine_N → ch_lesson_0 → … → ch_lesson_last → spine_N+1
  for (const cj of freshMem().courseJobs) {
    if (cj.status !== "lessons_running") continue;

    const rawNodes = [...(freshMem().courseJobs.find((j) => j.slotId === cj.slotId)?.rawNodes ?? [])];

    // Build a map: milestoneId → last chapter lesson tempId for that milestone
    const lastLessonForMilestone = new Map<string, string>();
    const chapterPrefixToNodes = new Map<string, StoredRawNode[]>();
    for (const n of rawNodes) {
      if (!n.tempId.startsWith("ch_")) continue;
      // ch_{milestoneId}_{index} → prefix is ch_{milestoneId}
      const match = n.tempId.match(/^(ch_.+)_\d+$/);
      if (!match) continue;
      const pfx = match[1]!;
      if (!chapterPrefixToNodes.has(pfx)) chapterPrefixToNodes.set(pfx, []);
      chapterPrefixToNodes.get(pfx)!.push(n);
    }
    for (const [pfx, nodes] of chapterPrefixToNodes) {
      // Sort by tempId suffix number to find the last
      const sorted = [...nodes].sort((a, b) => {
        const ai = parseInt(a.tempId.replace(/^.*_(\d+)$/, "$1"), 10);
        const bi = parseInt(b.tempId.replace(/^.*_(\d+)$/, "$1"), 10);
        return ai - bi;
      });
      const lastNode = sorted[sorted.length - 1];
      if (!lastNode) continue;
      // Extract milestoneId from prefix: ch_{milestoneId} → strip "ch_" prefix
      const milestoneId = pfx.replace(/^ch_/, "");
      lastLessonForMilestone.set(milestoneId, lastNode.tempId);
    }

    // Re-wire: for any node whose prerequisites include a milestone that has chapter lessons,
    // replace that milestone reference with the last lesson's tempId (so spine flows through lessons).
    // Exclusions:
    //   - The chapter cluster nodes themselves (ch_*) — they already point to the milestone correctly
    //   - Optional nodes (isRequired=false) — they branch off milestones/lessons directly
    const rewired = rawNodes.map((n) => {
      if (n.tempId.startsWith("ch_")) return n; // chapter lessons stay anchored to their milestone
      const newPrereqs = n.prerequisites.map((prereq) => {
        const lastLesson = lastLessonForMilestone.get(prereq);
        // Only re-wire required nodes (spine milestones, bosses) that point to a milestone
        return (lastLesson && n.isRequired) ? lastLesson : prereq;
      });
      const changed = newPrereqs.some((p, i) => p !== n.prerequisites[i]);
      return changed ? { ...n, prerequisites: newPrereqs } : n;
    });

    patchCourse(cj.slotId, { rawNodes: rewired });
  }

  // Mark lessons_done
  for (const cj of freshMem().courseJobs) {
    if (cj.status === "lessons_running") patchCourse(cj.slotId, { status: "lessons_done" });
  }

  // ── Wave 2b: Branch clusters ──────────────────────────────────────────────
  const lessonsDone = freshMem().courseJobs.filter((cj) => cj.status === "lessons_done");
  for (const cj of lessonsDone) {
    patchCourse(cj.slotId, { status: "branches_running" });
  }

  await Promise.all(
    lessonsDone.flatMap((cj) => {
      const slot = mem.courses.find((s) => s.id === cj.slotId);
      if (!slot) return [];

      const chapterLessons = cj.rawNodes.filter(
        (n) => n.tempId.startsWith("ch_") && n.nodeType === "lesson",
      );
      const lastLessons = new Map<string, StoredRawNode>();
      for (const n of chapterLessons) {
        const prefix = n.tempId.replace(/_\d+$/, "");
        lastLessons.set(prefix, n);
      }

      return Array.from(lastLessons.values()).map(async (lesson) => {
        try {
          const result = await curriculumBuildBranch({
            data: {
              subject: slot.subject,
              gradeLevel: designInput.gradeLevel,
              lessonId: lesson.tempId,
              lessonTitle: lesson.title,
              lessonDescription: lesson.description,
              lessonDepth: lesson.depth,
              milestoneTitle: lesson.title,
              existingTitles: cj.rawNodes.map((n) => n.title),
              ageYears: designInput.ageYears,
              focusSteering: designInput.focusSteering,
            },
          });

          const cur = fresh()?.courseJobs.find((j) => j.slotId === cj.slotId);
          const newNodes = result.nodes as StoredSpineNode[];
          const merged = [...(cur?.rawNodes ?? cj.rawNodes), ...newNodes];
          patchCourse(cj.slotId, { rawNodes: merged });
        } catch (err) {
          console.error(`[Wave2b] branch failed "${lesson.title}" (${lesson.tempId}) course=${cj.slotId}:`, err instanceof Error ? err.message : err);
        }
      });
    }),
  );

  for (const cj of freshMem().courseJobs) {
    if (cj.status === "branches_running") patchCourse(cj.slotId, { status: "branches_done" });
  }
  patchRoot({ wave2Done: true });

  // ── Wave 3: Assignments + readings + layout ───────────────────────────────
  const branchesDone = freshMem().courseJobs.filter((cj) => cj.status === "branches_done");
  for (const cj of branchesDone) {
    patchCourse(cj.slotId, { status: "assignments_running" });
  }

  await Promise.all(
    branchesDone.map(async (cj) => {
      const slot = mem.courses.find((s) => s.id === cj.slotId);
      if (!slot) return;

      const nodesToProcess = cj.rawNodes.length > 0 ? cj.rawNodes : cj.spineNodes;
      const allAssignments: StoredAssignment[] = [];

      // Seed per-node progress tracker
      patchCourse(cj.slotId, {
        assignmentProgress: nodesToProcess.map((n) => ({
          nodeId: n.tempId,
          nodeTitle: n.title,
          status: "pending" as const,
          nodeCount: 0,
        })),
      });

      for (const node of nodesToProcess) {
        // Mark running — read from mem so progress array is unstripped
        const curProgress = freshMem().courseJobs.find((j) => j.slotId === cj.slotId)?.assignmentProgress ?? [];
        patchCourse(cj.slotId, {
          assignmentProgress: curProgress.map((p) =>
            p.nodeId === node.tempId ? { ...p, status: "running" as const } : p,
          ),
        });

        let nodeAssignmentCount = 0;
        let nodeStatus: "done" | "skipped" = "done";

        try {
          const result = await curriculumGenerateAssignments({
            data: {
              subject: slot.subject,
              gradeLevel: designInput.gradeLevel,
              node: {
                tempId: node.tempId,
                title: node.title,
                description: node.description,
                nodeType: node.nodeType,
              },
              prefs,
              ageYears: designInput.ageYears,
              focusSteering: designInput.focusSteering,
              resolveYoutubeIds: true,
            },
          });

          const nodeAssignments = result.assignments as StoredAssignment[];

          if (node.nodeType === "lesson" || node.nodeType === "elective") {
            try {
              const readingResult = await curriculumGenerateLessonReading({
                data: {
                  nodeTitle: node.title,
                  nodeDescription: node.description,
                  subject: slot.subject,
                  gradeLevel: designInput.gradeLevel,
                  ageYears: designInput.ageYears,
                  focusSteering: designInput.focusSteering,
                  nodeType: node.nodeType,
                },
              });

              // Strip HTML tags to get plain text for quiz generation
              const readingPlainText = readingResult.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

              const readingAssignment: StoredAssignment = {
                nodeId: node.tempId,
                contentType: "text",
                title: `Reading: ${node.title}`,
                description: `Grade-appropriate reading passage for ${node.title}.`,
                contentRef: readingResult.html,  // full HTML — lives only in mem, stripped in localStorage
              };

              // Regenerate any quiz assignments using the reading content as source
              const nonText = nodeAssignments.filter((a) => a.contentType !== "text");
              const enrichedAssignments = await Promise.all(
                nonText.map(async (a) => {
                  if (a.contentType !== "quiz") return a;
                  try {
                    const quizResult = await curriculumGenerateQuizFromContent({
                      data: {
                        topic: node.title,
                        gradeLevel: designInput.gradeLevel,
                        sourceText: readingPlainText.slice(0, 4000),
                        questionCount: 5,
                      },
                    });
                    return { ...a, contentRef: quizResult.contentRef };
                  } catch {
                    return a; // keep original on failure
                  }
                }),
              );

              allAssignments.push(readingAssignment, ...enrichedAssignments);
              nodeAssignmentCount = 1 + enrichedAssignments.length;
            } catch (err) {
              console.error(`[Wave3] reading failed "${node.title}" (${node.tempId}):`, err instanceof Error ? err.message : err);
              allAssignments.push(...nodeAssignments);
              nodeAssignmentCount = nodeAssignments.length;
            }
          } else if (node.nodeType === "milestone" || node.nodeType === "boss") {
            // Build chapter context from all assignments already collected for this chapter's lesson nodes.
            // Chapter lesson nodes use tempIds prefixed with "ch_<milestoneId>_" (from generateChapterCluster).
            // For boss nodes, gather across ALL chapter nodes collected so far.
            const chapterPrefix = `ch_${node.tempId}_`;
            const isChapterNode = (tempId: string) =>
              node.nodeType === "boss"
                ? true  // boss covers the full course
                : tempId.startsWith(chapterPrefix);

            // Collect reading text from lesson nodes in this chapter
            const chapterReadings = allAssignments
              .filter((a) => a.contentType === "text" && isChapterNode(a.nodeId) && a.contentRef)
              .map((a) => a.contentRef!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
              .filter(Boolean);

            // Collect question strings from prior quizzes in this chapter to avoid repetition
            const priorQuizQuestions = allAssignments
              .filter((a) => a.contentType === "quiz" && isChapterNode(a.nodeId) && a.contentRef)
              .flatMap((a) => {
                try {
                  const parsed = JSON.parse(a.contentRef!) as { questions?: Array<{ question: string }> };
                  return (parsed.questions ?? []).map((q) => q.question).filter(Boolean);
                } catch { return []; }
              });

            const chapterSourceText = chapterReadings.join("\n\n").slice(0, 3500)
              || (node.description ?? "");

            const enrichedAssignments = await Promise.all(
              nodeAssignments.map(async (a) => {
                if (a.contentType !== "quiz") return a;
                try {
                  const quizResult = await curriculumGenerateQuizFromContent({
                    data: {
                      topic: node.title,
                      gradeLevel: designInput.gradeLevel,
                      sourceText: chapterSourceText,
                      questionCount: 5,
                      priorQuestions: priorQuizQuestions,
                    },
                  });
                  return { ...a, contentRef: quizResult.contentRef };
                } catch {
                  return a;
                }
              }),
            );
            allAssignments.push(...enrichedAssignments);
            nodeAssignmentCount = enrichedAssignments.length;
          } else {
            allAssignments.push(...nodeAssignments);
            nodeAssignmentCount = nodeAssignments.length;
          }
        } catch (err) {
          console.error(`[Wave3] assignments failed "${node.title}" (${node.tempId}):`, err instanceof Error ? err.message : err);
          nodeStatus = "skipped";
        }

        // Mark done — read progress from mem to preserve other nodes' state
        const doneProgress = freshMem().courseJobs.find((j) => j.slotId === cj.slotId)?.assignmentProgress ?? [];
        patchCourse(cj.slotId, {
          assignmentProgress: doneProgress.map((p) =>
            p.nodeId === node.tempId
              ? { ...p, status: nodeStatus, nodeCount: nodeAssignmentCount }
              : p,
          ),
        });
      }

      patchCourse(cj.slotId, { assignments: allAssignments, status: "assignments_done" });

      // Layout
      try {
        const layoutNodes = nodesToProcess.map((n) => ({
          tempId: n.tempId,
          prerequisites: n.prerequisites,
          depth: n.depth,
          cluster: n.cluster,
          nodeType: n.nodeType,
        }));
        const layoutResult = await curriculumLayoutNodes({ data: { nodes: layoutNodes } });
        const positionedNodes: StoredRawNode[] = nodesToProcess.map((n) => ({
          ...n,
          x: layoutResult.positions[n.tempId]?.x ?? 600,
          y: layoutResult.positions[n.tempId]?.y ?? 450,
        }));
        patchCourse(cj.slotId, { rawNodes: positionedNodes, status: "layout_done" });
      } catch (err) {
        console.error(`[Wave3] layout failed course=${cj.slotId}:`, err instanceof Error ? err.message : err);
        patchCourse(cj.slotId, { status: "layout_done" });
      }
    }),
  );

  // Only enter review if every course reached layout_done.
  // Courses stuck at earlier stages get marked failed so the user sees what went wrong.
  const LAYOUT_DONE_STATUSES = new Set(["layout_done", "assignments_done"]);
  for (const cj of freshMem().courseJobs) {
    if (!LAYOUT_DONE_STATUSES.has(cj.status) && cj.status !== "failed") {
      patchCourse(cj.slotId, { status: "failed", errorMessage: "Content generation did not complete." });
    }
  }

  const anyReady = freshMem().courseJobs.some((cj) => LAYOUT_DONE_STATUSES.has(cj.status));
  patchRoot({ wave3Done: true, overallStatus: anyReady ? "review" : "failed" });
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function CurriculumProgressProvider({ children }: { children: ReactNode }) {
  const [job, setJob] = useState<CurriculumJob | null>(() => loadCurriculumJob());
  const buildingRef = useRef(false);

  const notifyReact = useCallback((full: CurriculumJob) => {
    setJob(full);
  }, []);

  // Resume or start building when job enters "building" state
  useEffect(() => {
    if (!job || job.overallStatus !== "building" || buildingRef.current) return;
    buildingRef.current = true;

    runCurriculumBuild(job, notifyReact)
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[CurriculumBuild] fatal top-level error:", msg);
        const failedJob = updateCurriculumJobRoot(job.jobId, { overallStatus: "failed" } as Partial<CurriculumJob>);
        if (failedJob) notifyReact(failedJob);
      })
      .finally(() => {
        buildingRef.current = false;
      });
  }, [job?.jobId, job?.overallStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  const startJob = useCallback((design: CurriculumDesignInput, courses: CourseSlot[]) => {
    const newJob = createInitialCurriculumJob(design, courses);
    saveCurriculumJob(newJob);
    setJob(newJob);
  }, []);

  const clearJob = useCallback(() => {
    clearCurriculumJob();
    setJob(null);
    buildingRef.current = false;
  }, []);

  const refreshJob = useCallback(() => {
    const latest = loadCurriculumJob();
    setJob(latest);
  }, []);

  const isBuilding = isCurriculumJobActive(job);
  const overallPercent = job ? computeOverallProgress(job) : 0;

  return (
    <CurriculumProgressContext.Provider value={{ job, startJob, clearJob, refreshJob, isBuilding, overallPercent }}>
      {children}
      {job && <CurriculumProgressPanel />}
    </CurriculumProgressContext.Provider>
  );
}

// ── Progress Panel UI ─────────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  pending: "Waiting",
  spine_running: "Building chapters…",
  spine_done: "Chapters ready",
  lessons_running: "Building lessons…",
  lessons_done: "Lessons ready",
  branches_running: "Building branches…",
  branches_done: "Branches ready",
  assignments_running: "Generating content…",
  assignments_done: "Content ready",
  layout_done: "Layout done",
  enriching_running: "Fetching transcripts…",
  enriching_done: "Transcripts done",
  committed: "Complete",
  failed: "Failed",
};

const STATUS_COLORS: Record<string, string> = {
  pending: "text-slate-400",
  spine_running: "text-cyan-500",
  spine_done: "text-cyan-400",
  lessons_running: "text-blue-500",
  lessons_done: "text-blue-400",
  branches_running: "text-purple-500",
  branches_done: "text-purple-400",
  assignments_running: "text-amber-500",
  assignments_done: "text-amber-400",
  layout_done: "text-amber-400",
  enriching_running: "text-teal-400",
  enriching_done: "text-teal-300",
  committed: "text-emerald-400",
  failed: "text-rose-500",
};

const isActiveStatus = (status: string) =>
  status.endsWith("_running");

function CourseProgressRow({ courseJob, onRemove }: { courseJob: CourseJob; onRemove?: () => void }) {
  const color = STATUS_COLORS[courseJob.status] ?? "text-slate-400";
  const active = isActiveStatus(courseJob.status);
  const canRemove = courseJob.status !== "committed" && onRemove;

  // Assignment generation progress
  const runningNode = courseJob.status === "assignments_running"
    ? courseJob.assignmentProgress.find((p) => p.status === "running")
    : null;
  const doneNodeCount = courseJob.assignmentProgress.filter(
    (p) => p.status === "done" || p.status === "skipped",
  ).length;
  const totalNodeCount = courseJob.assignmentProgress.length;

  // Video enrichment progress
  const enrichProgress = courseJob.videoEnrichProgress ?? [];
  const doneVideoCount = enrichProgress.filter((v) => v.status === "done" || v.status === "skipped").length;
  const totalVideoCount = enrichProgress.length;
  const runningVideo = courseJob.status === "enriching_running"
    ? enrichProgress.find((v) => v.status === "running")
    : null;

  return (
    <div className="flex items-start gap-2 py-1.5 border-b border-slate-800 last:border-0">
      <div className="shrink-0 w-4 h-4 flex items-center justify-center mt-0.5">
        {courseJob.status === "committed" && (
          <span className="text-emerald-400 text-xs">✓</span>
        )}
        {courseJob.status === "failed" && (
          <span className="text-rose-400 text-xs">✗</span>
        )}
        {courseJob.status === "pending" && (
          <span className="text-slate-600 text-xs">·</span>
        )}
        {active && (
          <span className="inline-block w-3 h-3 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
        )}
        {!active && !["committed", "failed", "pending"].includes(courseJob.status) && (
          <span className="text-slate-500 text-xs">○</span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-slate-300 truncate">{courseJob.name}</p>
        <p className={`text-xs ${color} truncate`}>
          {courseJob.status === "assignments_running" && totalNodeCount > 0
            ? `Content ${doneNodeCount}/${totalNodeCount}${runningNode ? ` — ${runningNode.nodeTitle}` : "…"}`
            : courseJob.status === "enriching_running" && totalVideoCount > 0
            ? `Videos ${doneVideoCount}/${totalVideoCount}${runningVideo ? ` — ${runningVideo.title}` : "…"}`
            : STATUS_LABELS[courseJob.status] ?? courseJob.status}
          {courseJob.errorMessage && (
            <span className="ml-1 text-rose-400 text-xs" title={courseJob.errorMessage}>— {courseJob.errorMessage.slice(0, 60)}</span>
          )}
        </p>
        {/* Mini progress bar during assignment generation */}
        {courseJob.status === "assignments_running" && totalNodeCount > 0 && (
          <div className="mt-1 w-full h-1 bg-slate-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-amber-500 rounded-full transition-all duration-300"
              style={{ width: `${Math.round((doneNodeCount / totalNodeCount) * 100)}%` }}
            />
          </div>
        )}
        {/* Mini progress bar during video enrichment */}
        {courseJob.status === "enriching_running" && totalVideoCount > 0 && (
          <div className="mt-1 w-full h-1 bg-slate-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-teal-500 rounded-full transition-all duration-300"
              style={{ width: `${Math.round((doneVideoCount / totalVideoCount) * 100)}%` }}
            />
          </div>
        )}
      </div>
      {courseJob.status === "committed" && courseJob.committedTreeId && (
        <a
          href={`/skill-tree/${courseJob.committedTreeId}`}
          className="text-xs text-cyan-400 hover:text-cyan-300 shrink-0"
        >
          View →
        </a>
      )}
      {canRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="shrink-0 text-slate-600 hover:text-rose-400 text-xs px-1 transition"
          title="Remove course"
        >
          ✕
        </button>
      )}
    </div>
  );
}

function CurriculumProgressPanel() {
  const { job, clearJob, refreshJob, isBuilding, overallPercent } = useCurriculumProgress();
  const [expanded, setExpanded] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);

  if (!job) return null;

  const allDone = job.overallStatus === "done";
  // Require every course to have finished layout before approve is shown.
  // This prevents the button from appearing if some courses stalled mid-generation.
  const REVIEW_TERMINAL = new Set(["layout_done", "assignments_done", "enriching_running", "enriching_done", "committed"]);
  const allCoursesReadyForApproval = job.courseJobs.length > 0 && job.courseJobs.every((cj) => REVIEW_TERMINAL.has(cj.status));
  const canApprove = job.overallStatus === "review" && allCoursesReadyForApproval;
  const canCommit = canApprove && !committing;

  function handleRemoveCourse(slotId: string) {
    if (!job) return;
    const updated = removeCurriculumJobCourse(job.jobId, slotId);
    if (!updated) {
      // All courses removed — job was cleared
      refreshJob();
      return;
    }
    // If we were in review, check whether remaining courses are all done
    // If not all done, reset to building so approve button disappears
    if (updated.overallStatus === "review") {
      const allRemainingDone = updated.courseJobs.every(
        (cj) => cj.status === "layout_done" || cj.status === "committed",
      );
      if (!allRemainingDone) {
        updateCurriculumJobRoot(job.jobId, { overallStatus: "building" });
      }
    }
    refreshJob();
  }

  async function handleCommitAll() {
    if (!job) return;
    setCommitting(true);
    setCommitError(null);

    const { designInput } = job;
    const jobId = job.jobId;

    // ── Step 1: DB commit — fast, no AI ──────────────────────────────────────
    for (const cj of job.courseJobs) {
      if (cj.status === "committed" || cj.status === "enriching_running" || cj.status === "enriching_done") continue;
      const slot = job.courses.find((s) => s.id === cj.slotId);
      if (!slot) continue;

      const nodesToCommit = cj.rawNodes.length > 0 ? cj.rawNodes : cj.spineNodes;

      try {
        const result = await curriculumCommitCourse({
          data: {
            profileId: designInput.profileId,
            classTitle: cj.name,
            treeTitle: cj.name,
            subject: slot.subject,
            gradeLevel: designInput.gradeLevel,
            schoolYear: designInput.schoolYear,
            nodes: nodesToCommit.map((n) => {
              const raw = n as StoredRawNode;
              return {
                tempId: n.tempId,
                title: n.title,
                description: n.description,
                icon: n.icon,
                colorRamp: n.colorRamp,
                nodeType: n.nodeType,
                cluster: n.cluster,
                depth: n.depth,
                isRequired: n.isRequired,
                xpReward: n.xpReward,
                prerequisites: n.prerequisites,
                x: raw.x ?? 600,
                y: raw.y ?? 450,
                suggestedAssignments: n.suggestedAssignments,
              };
            }),
            generatedAssignments: cj.assignments.map((a) => ({
              nodeId: a.nodeId,
              contentType: a.contentType,
              title: a.title,
              description: a.description,
              contentRef: a.contentRef,
              linkedFollowUpType: a.linkedFollowUpType,
            })),
          },
        });

        // Trigger autolayout on the committed tree — reads from DB, runs full
        // fork detection + edge classification, and persists proper positions.
        // Errors are non-fatal: the tree is usable even with the draft layout.
        try {
          await autoLayoutSkillTree({ data: { treeId: result.treeId } });
        } catch (err) {
          console.warn(`[CurriculumBuild] autolayout failed for tree ${result.treeId}:`, err instanceof Error ? err.message : err);
        }

        // Seed Wave 4 progress from the video assignments returned by commit
        const videoEntries: VideoEnrichEntry[] = (result.videoAssignments ?? []).map((v) => ({
          assignmentId: v.assignmentId,
          nodeId: v.nodeId,
          classId: result.classId,
          title: v.title,
          status: "pending" as const,
        }));

        updateCurriculumJobCourse(jobId, cj.slotId, {
          status: "enriching_running",
          committedTreeId: result.treeId,
          committedClassId: result.classId,
          videoEnrichProgress: videoEntries,
        });
        refreshJob();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[CurriculumBuild] commit failed for "${cj.name}":`, msg);
        setCommitError(`Failed to commit "${cj.name}": ${msg}`);
        setCommitting(false);
        refreshJob();
        return;
      }
    }

    // ── Step 2: Wave 4 — transcript + quiz enrichment, concurrent ─────────────
    // Run all courses in parallel; within each course cap at 5 concurrent videos.
    const latestJob = loadCurriculumJob();
    if (latestJob) {
      const enrichingCourses = latestJob.courseJobs.filter(
        (cj) => cj.status === "enriching_running",
      );

      await Promise.all(
        enrichingCourses.map(async (cj) => {
          const videos = cj.videoEnrichProgress;
          if (videos.length === 0) {
            updateCurriculumJobCourse(jobId, cj.slotId, { status: "enriching_done" });
            refreshJob();
            return;
          }

          // Process in chunks of 5 concurrently
          const CONCURRENCY = 5;
          for (let i = 0; i < videos.length; i += CONCURRENCY) {
            const chunk = videos.slice(i, i + CONCURRENCY);
            await Promise.all(
              chunk.map(async (v) => {
                // Mark running
                const cur = loadCurriculumJob()?.courseJobs.find((j) => j.slotId === cj.slotId);
                updateCurriculumJobCourse(jobId, cj.slotId, {
                  videoEnrichProgress: (cur?.videoEnrichProgress ?? videos).map((e) =>
                    e.assignmentId === v.assignmentId ? { ...e, status: "running" as const } : e,
                  ),
                });
                refreshJob();

                let finalStatus: "done" | "skipped" = "done";
                try {
                  await curriculumEnrichVideo({
                    data: {
                      assignmentId: v.assignmentId,
                      classId: v.classId,
                      nodeId: v.nodeId,
                      gradeLevel: designInput.gradeLevel,
                    },
                  });
                } catch (err) {
                  console.error(`[Wave4] enrich failed "${v.title}":`, err instanceof Error ? err.message : err);
                  finalStatus = "skipped";
                }

                // Mark done/skipped
                const cur2 = loadCurriculumJob()?.courseJobs.find((j) => j.slotId === cj.slotId);
                updateCurriculumJobCourse(jobId, cj.slotId, {
                  videoEnrichProgress: (cur2?.videoEnrichProgress ?? videos).map((e) =>
                    e.assignmentId === v.assignmentId ? { ...e, status: finalStatus } : e,
                  ),
                });
                refreshJob();
              }),
            );
          }

          updateCurriculumJobCourse(jobId, cj.slotId, { status: "enriching_done" });
          refreshJob();
        }),
      );
    }

    // ── Step 3: Mark everything committed ────────────────────────────────────
    const finalJob = loadCurriculumJob();
    if (finalJob) {
      for (const cj of finalJob.courseJobs) {
        if (cj.status === "enriching_done" || cj.status === "enriching_running") {
          updateCurriculumJobCourse(jobId, cj.slotId, { status: "committed" });
        }
      }
    }

    updateCurriculumJobRoot(jobId, { overallStatus: "done" });
    setCommitting(false);
    refreshJob();
  }

  return (
    <div className="fixed bottom-4 left-4 z-50 flex flex-col items-start gap-2">
      {/* Expanded panel */}
      {expanded && (
        <div className="w-80 rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl shadow-black/60 overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
            <div>
              <p className="text-sm font-bold text-white">Curriculum Builder</p>
              <p className="text-xs text-slate-400">
                {job.designInput.studentName} · Grade {job.designInput.gradeLevel}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="text-slate-500 hover:text-slate-300 text-xs"
            >
              ✕
            </button>
          </div>

          {/* Progress bar */}
          <div className="px-4 py-2 border-b border-slate-800">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-slate-400">
                {isBuilding ? "Building…" : canApprove ? "Ready to approve" : "Complete"}
              </span>
              <span className="text-xs font-bold text-white">{overallPercent}%</span>
            </div>
            <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-cyan-500 to-blue-500 rounded-full transition-all duration-500"
                style={{ width: `${overallPercent}%` }}
              />
            </div>
          </div>

          {/* Course list */}
          <div className="px-4 py-2 max-h-64 overflow-y-auto">
            {job.courseJobs.map((cj) => (
              <CourseProgressRow
                key={cj.slotId}
                courseJob={cj}
                onRemove={!committing ? () => handleRemoveCourse(cj.slotId) : undefined}
              />
            ))}
          </div>

          {/* Actions */}
          {(canApprove || allDone || commitError) && (
            <div className="px-4 py-3 border-t border-slate-800 space-y-2">
              {commitError && (
                <p className="text-xs text-rose-400 rounded-lg bg-rose-950/50 px-2 py-1">
                  {commitError}
                </p>
              )}
              {canApprove && (
                <button
                  type="button"
                  onClick={handleCommitAll}
                  disabled={!canCommit}
                  className="w-full rounded-xl bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white text-sm font-semibold py-2 transition flex items-center justify-center gap-2"
                >
                  {committing ? (
                    <>
                      <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      {job.courseJobs.some((cj) => cj.status === "enriching_running")
                        ? "Fetching transcripts…"
                        : "Saving courses…"}
                    </>
                  ) : (
                    "Approve & Create Courses ✦"
                  )}
                </button>
              )}
              {allDone && (
                <button
                  type="button"
                  onClick={clearJob}
                  className="w-full rounded-xl border border-slate-700 text-slate-400 hover:text-slate-200 text-xs py-1.5 transition"
                >
                  Dismiss
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Minimized pill */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setExpanded((p) => !p)}
          className={[
            "flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold text-white shadow-lg transition-all",
            canApprove ? "bg-cyan-600 hover:bg-cyan-500 ring-2 ring-cyan-400/50" : "bg-slate-800 hover:bg-slate-700",
          ].join(" ")}
        >
          {isBuilding && (
            <span className="inline-block w-3 h-3 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin shrink-0" />
          )}
          {canApprove && !isBuilding && (
            <span className="text-cyan-300 text-xs">✦</span>
          )}
          {allDone && <span className="text-emerald-400 text-xs">✓</span>}
          <span>
            {allDone
              ? "Curriculum Complete"
              : canApprove
                ? "Approve Curriculum"
                : `Building… ${overallPercent}%`}
          </span>
          <span className="text-slate-400 text-xs ml-1">
            {expanded ? "▲" : "▼"}
          </span>
        </button>
        <button
          type="button"
          onClick={clearJob}
          className="flex items-center justify-center w-7 h-7 rounded-full bg-slate-800 hover:bg-rose-900 text-slate-400 hover:text-rose-300 shadow-lg transition-all text-xs"
          title="Cancel and dismiss"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
