// Mastery Gallery — shown in the student workspace when all assignments are complete,
// and as the persistent progress section at all times via SkillTree.

// ── Radial progress ring ──────────────────────────────────────────────────────

export function RadialRing({
  percent,
  size = 80,
  stroke = 7,
  color = "#0891b2", // cyan-600
}: {
  percent: number;
  size?: number;
  stroke?: number;
  color?: string;
}) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const filled = ((Math.min(Math.max(percent, 0), 100)) / 100) * circumference;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      {/* Track */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="#e2e8f0"
        strokeWidth={stroke}
      />
      {/* Fill */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${filled} ${circumference}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: "stroke-dasharray 0.6s ease" }}
      />
      {/* Label */}
      <text
        x="50%"
        y="50%"
        dominantBaseline="central"
        textAnchor="middle"
        fontSize={size * 0.2}
        fontWeight="600"
        fill="#0f172a"
      >
        {percent}%
      </text>
    </svg>
  );
}

// ── Type icons ────────────────────────────────────────────────────────────────

const TYPE_ICONS: Record<string, string> = {
  video: "▶",
  quiz: "✦",
  essay_questions: "✎",
  report: "✉",
  text: "☰",
  file: "⊡",
  url: "⊕",
};

const TYPE_COLORS: Record<string, { done: string; pending: string }> = {
  video:           { done: "bg-cyan-500 text-white",    pending: "bg-slate-100 text-slate-400" },
  quiz:            { done: "bg-violet-500 text-white",  pending: "bg-slate-100 text-slate-400" },
  essay_questions: { done: "bg-amber-500 text-white",   pending: "bg-slate-100 text-slate-400" },
  report:          { done: "bg-emerald-500 text-white", pending: "bg-slate-100 text-slate-400" },
  text:            { done: "bg-sky-500 text-white",     pending: "bg-slate-100 text-slate-400" },
  file:            { done: "bg-rose-400 text-white",    pending: "bg-slate-100 text-slate-400" },
  url:             { done: "bg-indigo-400 text-white",  pending: "bg-slate-100 text-slate-400" },
};

// ── Achievement badge (recently completed assignment) ─────────────────────────

type RecentItem = {
  id: string;
  title: string;
  contentType: string;
  classTitle: string;
  submittedAt: string;
};

function AchievementBadge({ item }: { item: RecentItem }) {
  const icon = TYPE_ICONS[item.contentType] ?? "★";
  const colors = TYPE_COLORS[item.contentType] ?? { done: "bg-slate-500 text-white", pending: "" };
  const date = new Date(item.submittedAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });

  return (
    <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <span
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-base ${colors.done}`}
        aria-hidden="true"
      >
        {icon}
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-slate-900">{item.title}</p>
        <p className="truncate text-xs text-slate-500">{item.classTitle} · {date}</p>
      </div>
      <span
        className="ml-auto shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700"
        aria-label="Completed"
      >
        Done
      </span>
    </div>
  );
}

// ── Mastery Gallery (caught-up state) ─────────────────────────────────────────

type MasteryClass = {
  classId: string;
  classTitle: string;
  completionPercent: number;
  averageScore: number | null;
};

type AssignmentLike = {
  id: string;
  title: string;
  contentType: string;
  classId: string;
};

type SubmissionLike = {
  assignmentId: string;
  submittedAt: string;
};

type MasteryGalleryProps = {
  displayName: string;
  mastery: MasteryClass[];
  assignments: AssignmentLike[];
  submissions: SubmissionLike[];
  /** classId → classTitle lookup (for badge subtitles) */
  classMap: Map<string, string>;
};

export function MasteryGallery({
  displayName,
  mastery,
  assignments,
  submissions,
  classMap,
}: MasteryGalleryProps) {
  // Build recent completions — last 5 by submittedAt
  const submissionByAssignmentId = new Map(submissions.map((s) => [s.assignmentId, s]));
  const assignmentById = new Map(assignments.map((a) => [a.id, a]));

  const recentItems: RecentItem[] = [...submissions]
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
    .slice(0, 5)
    .map((s) => {
      const a = assignmentById.get(s.assignmentId);
      if (!a) return null;
      return {
        id: s.assignmentId,
        title: a.title,
        contentType: a.contentType,
        classTitle: classMap.get(a.classId) ?? "Class",
        submittedAt: s.submittedAt,
      };
    })
    .filter((x): x is RecentItem => x !== null);

  const totalDone = submissions.length;
  const totalAssignments = assignments.length;
  const overallPercent =
    totalAssignments > 0 ? Math.round((totalDone / totalAssignments) * 100) : 0;

  // All-done state vs partial mastery
  const allDone = totalDone >= totalAssignments && totalAssignments > 0;

  return (
    <div className="space-y-6">
      {/* Hero */}
      <div className="rounded-2xl border border-emerald-200 bg-gradient-to-br from-emerald-50 to-cyan-50 p-6">
        <div className="flex flex-col items-center gap-4 text-center sm:flex-row sm:text-left">
          <RadialRing percent={overallPercent} size={88} color={allDone ? "#10b981" : "#0891b2"} />
          <div>
            <p className="text-xs font-medium uppercase tracking-widest text-emerald-700">
              {allDone ? "All caught up!" : "Great progress"}
            </p>
            <h2 className="mt-1 text-2xl font-bold text-slate-900">
              {allDone
                ? `${displayName}'s Mastery Gallery`
                : `${overallPercent}% complete`}
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              {allDone
                ? `${totalDone} assignment${totalDone === 1 ? "" : "s"} completed across ${mastery.length} class${mastery.length === 1 ? "" : "es"}.`
                : `${totalDone} of ${totalAssignments} assignments completed.`}
            </p>
          </div>
        </div>
      </div>

      {/* Per-class skill cards */}
      {mastery.length > 0 ? (
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-[0.12em] text-slate-500">
            By Subject
          </h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {mastery.map((item) => {
              const ringColor =
                item.completionPercent === 100
                  ? "#10b981"
                  : item.completionPercent >= 50
                    ? "#0891b2"
                    : "#94a3b8";

              // Assignment type breakdown for this class
              const classAssignments = assignments.filter((a) => a.classId === item.classId);
              const completedIds = new Set(submissions.map((s) => s.assignmentId));

              return (
                <div
                  key={item.classId}
                  className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
                >
                  <div className="flex items-start gap-4">
                    <RadialRing
                      percent={item.completionPercent}
                      size={64}
                      stroke={6}
                      color={ringColor}
                    />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-900">
                        {item.classTitle}
                      </p>
                      {item.averageScore !== null ? (
                        <p className="mt-0.5 text-xs text-slate-500">
                          Avg score: <span className="font-medium text-slate-700">{item.averageScore}%</span>
                        </p>
                      ) : (
                        <p className="mt-0.5 text-xs text-slate-400">No scores yet</p>
                      )}
                      {item.completionPercent === 100 ? (
                        <span className="mt-1 inline-block rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
                          Complete
                        </span>
                      ) : null}
                    </div>
                  </div>

                  {/* Assignment type icons */}
                  {classAssignments.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {classAssignments.map((a) => {
                        const done = completedIds.has(a.id);
                        const icon = TYPE_ICONS[a.contentType] ?? "★";
                        const colors = TYPE_COLORS[a.contentType] ?? {
                          done: "bg-slate-500 text-white",
                          pending: "bg-slate-100 text-slate-400",
                        };
                        return (
                          <span
                            key={a.id}
                            title={`${a.title}${done ? " (done)" : ""}`}
                            className={`flex h-7 w-7 items-center justify-center rounded-lg text-xs transition ${done ? colors.done : colors.pending}`}
                          >
                            {icon}
                          </span>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* Recent completions */}
      {recentItems.length > 0 ? (
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-[0.12em] text-slate-500">
            Recently Completed
          </h3>
          <div className="mt-3 space-y-2">
            {recentItems.map((item) => (
              <AchievementBadge key={item.id} item={item} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── SkillTree (always-visible progress section) ────────────────────────────────
// Shown in the Progress section regardless of completion state.
// Compact view: radial ring + class name + type-icon nodes per assignment.

type SkillTreeProps = {
  mastery: MasteryClass[];
  assignments: AssignmentLike[];
  submissions: SubmissionLike[];
  loading?: boolean;
};

export function SkillTree({ mastery, assignments, submissions, loading }: SkillTreeProps) {
  const completedIds = new Set(submissions.map((s) => s.assignmentId));

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2].map((i) => (
          <div key={i} className="h-20 animate-pulse rounded-2xl bg-slate-100" />
        ))}
      </div>
    );
  }

  if (mastery.length === 0) {
    return <p className="text-sm text-slate-500">No classes enrolled yet.</p>;
  }

  return (
    <div className="space-y-3">
      {mastery.map((item) => {
        const classAssignments = assignments.filter((a) => a.classId === item.classId);
        const ringColor =
          item.completionPercent === 100
            ? "#10b981"
            : item.completionPercent >= 50
              ? "#0891b2"
              : "#94a3b8";

        return (
          <article
            key={item.classId}
            className="flex items-center gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
          >
            <RadialRing percent={item.completionPercent} size={56} stroke={5} color={ringColor} />

            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <p className="truncate text-sm font-semibold text-slate-900">{item.classTitle}</p>
                {item.averageScore !== null ? (
                  <p className="shrink-0 text-xs text-slate-500">
                    avg <span className="font-medium text-slate-700">{item.averageScore}%</span>
                  </p>
                ) : null}
              </div>

              {classAssignments.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {classAssignments.map((a) => {
                    const done = completedIds.has(a.id);
                    const icon = TYPE_ICONS[a.contentType] ?? "★";
                    const colors = TYPE_COLORS[a.contentType] ?? {
                      done: "bg-slate-500 text-white",
                      pending: "bg-slate-100 text-slate-400",
                    };
                    return (
                      <span
                        key={a.id}
                        title={`${a.title}${done ? " ✓" : ""}`}
                        className={`flex h-6 w-6 items-center justify-center rounded-md text-[11px] transition ${done ? colors.done : colors.pending}`}
                      >
                        {icon}
                      </span>
                    );
                  })}
                </div>
              ) : (
                <p className="mt-1 text-xs text-slate-400 italic">No assignments yet</p>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}
