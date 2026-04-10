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
  type CurriculumDesignInput,
  type CourseSlot,
  type StoredSpineNode,
  type StoredRawNode,
  type StoredAssignment,
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
} from "../lib/curriculumStore";
import {
  curriculumBuildBranch,
  curriculumBuildChapter,
  curriculumBuildSpine,
  curriculumCommitCourse,
  curriculumGenerateAssignments,
  curriculumGenerateLessonReading,
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
// All state mutations go directly to localStorage via updateCurriculumJobCourse /
// updateCurriculumJobRoot so that subsequent loadCurriculumJob() reads are always
// consistent. React state is synced at the end of each wave via notifyReact().

async function runCurriculumBuild(
  job: CurriculumJob,
  notifyReact: () => void,
): Promise<void> {
  const jobId = job.jobId;
  const { designInput } = job;
  const prefs: BuilderAssignmentPrefs =
    designInput.assignmentPrefs ?? createAssignmentPrefsForWeight(designInput.assignmentWeight);

  // Direct localStorage helpers — bypasses React batching so reads are always fresh
  function patchCourse(slotId: string, patch: Partial<CourseJob>) {
    updateCurriculumJobCourse(jobId, slotId, patch);
  }
  function patchRoot(patch: Partial<CurriculumJob>) {
    updateCurriculumJobRoot(jobId, patch);
  }
  function fresh() {
    return loadCurriculumJob();
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
        notifyReact();
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
        notifyReact();
      }),
  );

  patchRoot({ wave1Done: true });
  notifyReact();

  // ── Wave 2a: Chapter clusters ─────────────────────────────────────────────
  const afterWave1 = fresh();
  if (!afterWave1) return;

  const spineDone = afterWave1.courseJobs.filter((cj) => cj.status === "spine_done");
  for (const cj of spineDone) {
    patchCourse(cj.slotId, { status: "lessons_running" });
  }
  notifyReact();

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
        notifyReact();
      });
    }),
  );

  // Mark lessons_done
  const afterChapters = fresh();
  if (!afterChapters) return;
  for (const cj of afterChapters.courseJobs) {
    if (cj.status === "lessons_running") patchCourse(cj.slotId, { status: "lessons_done" });
  }
  notifyReact();

  // ── Wave 2b: Branch clusters ──────────────────────────────────────────────
  const afterLessonsDone = fresh();
  if (!afterLessonsDone) return;

  const lessonsDone = afterLessonsDone.courseJobs.filter((cj) => cj.status === "lessons_done");
  for (const cj of lessonsDone) {
    patchCourse(cj.slotId, { status: "branches_running" });
  }
  notifyReact();

  await Promise.all(
    lessonsDone.flatMap((cj) => {
      const slot = afterLessonsDone.courses.find((s) => s.id === cj.slotId);
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
        notifyReact();
      });
    }),
  );

  const afterBranches = fresh();
  if (!afterBranches) return;
  for (const cj of afterBranches.courseJobs) {
    if (cj.status === "branches_running") patchCourse(cj.slotId, { status: "branches_done" });
  }
  patchRoot({ wave2Done: true });
  notifyReact();

  // ── Wave 3: Assignments + readings + layout ───────────────────────────────
  const afterWave2 = fresh();
  if (!afterWave2) return;

  const branchesDone = afterWave2.courseJobs.filter((cj) => cj.status === "branches_done");
  for (const cj of branchesDone) {
    patchCourse(cj.slotId, { status: "assignments_running" });
  }
  notifyReact();

  await Promise.all(
    branchesDone.map(async (cj) => {
      const slot = afterWave2.courses.find((s) => s.id === cj.slotId);
      if (!slot) return;

      const nodesToProcess = cj.rawNodes.length > 0 ? cj.rawNodes : cj.spineNodes;
      const allAssignments: StoredAssignment[] = [];

      for (const node of nodesToProcess) {
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
              const readingAssignment: StoredAssignment = {
                nodeId: node.tempId,
                contentType: "text",
                title: `Reading: ${node.title}`,
                description: `Grade-appropriate reading passage for ${node.title}.`,
                contentRef: readingResult.html,
              };
              const nonText = nodeAssignments.filter((a) => a.contentType !== "text");
              allAssignments.push(readingAssignment, ...nonText);
            } catch (err) {
              console.error(`[Wave3] reading failed "${node.title}" (${node.tempId}):`, err instanceof Error ? err.message : err);
              allAssignments.push(...nodeAssignments);
            }
          } else {
            allAssignments.push(...nodeAssignments);
          }
        } catch (err) {
          console.error(`[Wave3] assignments failed "${node.title}" (${node.tempId}):`, err instanceof Error ? err.message : err);
        }
      }

      patchCourse(cj.slotId, { assignments: allAssignments, status: "assignments_done" });
      notifyReact();

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
      notifyReact();
    }),
  );

  patchRoot({ wave3Done: true, overallStatus: "review" });
  notifyReact();
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function CurriculumProgressProvider({ children }: { children: ReactNode }) {
  const [job, setJob] = useState<CurriculumJob | null>(() => loadCurriculumJob());
  const buildingRef = useRef(false);

  const notifyReact = useCallback(() => {
    setJob(loadCurriculumJob());
  }, []);

  // Resume or start building when job enters "building" state
  useEffect(() => {
    if (!job || job.overallStatus !== "building" || buildingRef.current) return;
    buildingRef.current = true;

    runCurriculumBuild(job, notifyReact)
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[CurriculumBuild] fatal top-level error:", msg);
        updateCurriculumJobRoot(job.jobId, { overallStatus: "failed" } as Partial<CurriculumJob>);
        notifyReact();
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
  assignments_running: "Generating assignments…",
  assignments_done: "Assignments ready",
  layout_done: "Laying out…",
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
  assignments_done: "text-green-400",
  layout_done: "text-green-400",
  committed: "text-emerald-400",
  failed: "text-rose-500",
};

const isActiveStatus = (status: string) =>
  status.endsWith("_running") || status === "spine_running";

function CourseProgressRow({ courseJob, onRemove }: { courseJob: CourseJob; onRemove?: () => void }) {
  const color = STATUS_COLORS[courseJob.status] ?? "text-slate-400";
  const active = isActiveStatus(courseJob.status);
  const canRemove = courseJob.status !== "committed" && onRemove;

  return (
    <div className="flex items-center gap-2 py-1.5 border-b border-slate-800 last:border-0">
      <div className="shrink-0 w-4 h-4 flex items-center justify-center">
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
        <p className={`text-xs ${color}`}>
          {STATUS_LABELS[courseJob.status] ?? courseJob.status}
          {courseJob.errorMessage && (
            <span className="ml-1 text-rose-400 text-xs" title={courseJob.errorMessage}>— {courseJob.errorMessage.slice(0, 80)}</span>
          )}
        </p>
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
  const canApprove = job.overallStatus === "review";
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

    for (const cj of job.courseJobs) {
      if (cj.status === "committed") continue;
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

        updateCurriculumJobCourse(job.jobId, cj.slotId, {
          status: "committed",
          committedTreeId: result.treeId,
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

    updateCurriculumJobRoot(job.jobId, { overallStatus: "done" });
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
                      Committing…
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
