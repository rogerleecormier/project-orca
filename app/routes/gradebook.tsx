import { useMemo, useState } from "react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { getGradeBookData, getViewerContext, releaseSubmissionToStudent } from "../server/functions";
import { ParentPageHeader } from "../components/parent-page-header";

export const Route = createFileRoute("/gradebook")({
  loader: async () => {
    const viewer = await getViewerContext();

    if (!viewer.isAuthenticated) {
      throw redirect({ to: "/login" });
    }

    if (viewer.activeRole === "student") {
      throw redirect({ to: "/student" });
    }

    return getGradeBookData();
  },
  component: GradebookPage,
});

// ── Types ─────────────────────────────────────────────────────────────────────

type GradeRow = Awaited<ReturnType<typeof getGradeBookData>>["rows"][number];

type SortKey = keyof Pick<
  GradeRow,
  "studentName" | "className" | "assignmentTitle" | "contentType" | "submittedAt" | "score" | "status"
>;

type SortDir = "asc" | "desc";

// ── Constants ─────────────────────────────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = {
  text: "Text",
  file: "File",
  url: "URL",
  video: "Video",
  quiz: "Quiz",
  essay_questions: "Essay",
  report: "Report",
};

const GRADABLE_TYPES = new Set(["essay_questions", "report"]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function scoreColor(score: number | null): string {
  if (score === null) return "";
  if (score >= 80) return "bg-emerald-50 text-emerald-800 font-semibold";
  if (score >= 60) return "bg-amber-50 text-amber-800 font-semibold";
  return "bg-rose-50 text-rose-800 font-semibold";
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function exportCsv(rows: GradeRow[]) {
  const header = ["Student", "Class", "Assignment", "Type", "Submitted", "Score", "Status"];
  const lines = [
    header.map(csvEscape).join(","),
    ...rows.map((r) =>
      [
        r.studentName,
        r.className,
        r.assignmentTitle,
        TYPE_LABELS[r.contentType] ?? r.contentType,
        formatDate(r.submittedAt),
        r.score !== null ? String(r.score) : "",
        r.status,
      ]
        .map(csvEscape)
        .join(","),
    ),
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `gradebook-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Sort icon ─────────────────────────────────────────────────────────────────

function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) {
    return (
      <svg viewBox="0 0 16 16" fill="currentColor" className="ml-1 inline h-3 w-3 opacity-30">
        <path d="M8 2L5 6h6L8 2zm0 12l3-4H5l3 4z" />
      </svg>
    );
  }
  return dir === "asc" ? (
    <svg viewBox="0 0 16 16" fill="currentColor" className="ml-1 inline h-3 w-3 text-cyan-600">
      <path d="M8 2l4 6H4L8 2z" />
    </svg>
  ) : (
    <svg viewBox="0 0 16 16" fill="currentColor" className="ml-1 inline h-3 w-3 text-cyan-600">
      <path d="M8 14l-4-6h8l-4 6z" />
    </svg>
  );
}

// ── Page component ────────────────────────────────────────────────────────────

function GradebookPage() {
  const router = useRouter();
  const data = Route.useLoaderData();

  // ── Filter state ──────────────────────────────────────────────────────────

  const [filterStudent, setFilterStudent] = useState("all");
  const [filterClass, setFilterClass] = useState("all");
  const [filterType, setFilterType] = useState("all");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");
  const [releasingSubmissionIds, setReleasingSubmissionIds] = useState<Set<string>>(new Set());

  const handleRelease = async (submissionId: string) => {
    if (releasingSubmissionIds.has(submissionId)) {
      return;
    }
    setReleasingSubmissionIds((prev) => new Set(prev).add(submissionId));
    try {
      await releaseSubmissionToStudent({
        data: {
          submissionId,
        },
      });
      await router.invalidate();
    } finally {
      setReleasingSubmissionIds((prev) => {
        const next = new Set(prev);
        next.delete(submissionId);
        return next;
      });
    }
  };

  // ── Sort state ────────────────────────────────────────────────────────────

  const [sortKey, setSortKey] = useState<SortKey>("submittedAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  // ── Derived rows ──────────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    let rows = data.rows;

    if (filterStudent !== "all") {
      rows = rows.filter((r) => r.profileId === filterStudent);
    }

    if (filterClass !== "all") {
      rows = rows.filter((r) => r.classId === filterClass);
    }

    if (filterType !== "all") {
      rows = rows.filter((r) => r.contentType === filterType);
    }

    if (filterDateFrom) {
      const from = new Date(filterDateFrom).getTime();
      rows = rows.filter((r) => new Date(r.submittedAt).getTime() >= from);
    }

    if (filterDateTo) {
      const to = new Date(filterDateTo).getTime() + 86400000; // inclusive
      rows = rows.filter((r) => new Date(r.submittedAt).getTime() <= to);
    }

    return [...rows].sort((a, b) => {
      const aVal = a[sortKey] ?? "";
      const bVal = b[sortKey] ?? "";
      const cmp =
        typeof aVal === "number" && typeof bVal === "number"
          ? aVal - bVal
          : String(aVal).localeCompare(String(bVal));
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [data.rows, filterStudent, filterClass, filterType, filterDateFrom, filterDateTo, sortKey, sortDir]);

  // ── Column header helper ──────────────────────────────────────────────────

  function Th({
    label,
    col,
    className = "",
  }: {
    label: string;
    col: SortKey;
    className?: string;
  }) {
    return (
      <th
        scope="col"
        className={`whitespace-nowrap px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 cursor-pointer select-none hover:text-slate-800 ${className}`}
        onClick={() => handleSort(col)}
      >
        {label}
        <SortIcon active={sortKey === col} dir={sortDir} />
      </th>
    );
  }

  // ── Summary stats ─────────────────────────────────────────────────────────

  const stats = useMemo(() => {
    const scored = filtered.filter((r) => r.score !== null).map((r) => r.score as number);
    const needsGrading = filtered.filter(
      (r) => GRADABLE_TYPES.has(r.contentType) && r.score === null,
    ).length;
    const avg = scored.length
      ? Math.round(scored.reduce((s, v) => s + v, 0) / scored.length)
      : null;
    return { total: filtered.length, avg, needsGrading };
  }, [filtered]);

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <ParentPageHeader
        title="Gradebook"
        description="Review submissions, scores, and release status across every student and class."
        action={(
          <button
            type="button"
            onClick={() => exportCsv(filtered)}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4 text-slate-500" aria-hidden="true">
              <path d="M10.75 2.75a.75.75 0 0 0-1.5 0v8.614L6.295 8.235a.75.75 0 1 0-1.09 1.03l4.25 4.5a.75.75 0 0 0 1.09 0l4.25-4.5a.75.75 0 0 0-1.09-1.03l-2.955 3.129V2.75Z" />
              <path d="M3.5 12.75a.75.75 0 0 0-1.5 0v2.5A2.75 2.75 0 0 0 4.75 18h10.5A2.75 2.75 0 0 0 18 15.25v-2.5a.75.75 0 0 0-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5Z" />
            </svg>
            Export CSV
          </button>
        )}
      />

        {/* Summary chips */}
        <div className="flex flex-wrap gap-3">
          <div className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm">
            <span className="text-slate-500">Submissions: </span>
            <span className="font-semibold text-slate-900">{stats.total}</span>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm">
            <span className="text-slate-500">Avg score: </span>
            <span className={`font-semibold ${stats.avg === null ? "text-slate-400" : stats.avg >= 80 ? "text-emerald-700" : stats.avg >= 60 ? "text-amber-700" : "text-rose-700"}`}>
              {stats.avg !== null ? `${stats.avg}/100` : "—"}
            </span>
          </div>
          {stats.needsGrading > 0 ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm">
              <span className="text-amber-700 font-medium">{stats.needsGrading} need{stats.needsGrading === 1 ? "s" : ""} grading</span>
            </div>
          ) : null}
        </div>

        {/* Filters */}
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap gap-3">
            {/* Student */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-slate-500">Student</label>
              <select
                value={filterStudent}
                onChange={(e) => setFilterStudent(e.target.value)}
                className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-cyan-400"
              >
                <option value="all">All students</option>
                {data.profiles.map((p) => (
                  <option key={p.id} value={p.id}>{p.displayName}</option>
                ))}
              </select>
            </div>

            {/* Class */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-slate-500">Class</label>
              <select
                value={filterClass}
                onChange={(e) => setFilterClass(e.target.value)}
                className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-cyan-400"
              >
                <option value="all">All classes</option>
                {data.classes.map((c) => (
                  <option key={c.id} value={c.id}>{c.title}</option>
                ))}
              </select>
            </div>

            {/* Type */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-slate-500">Type</label>
              <select
                value={filterType}
                onChange={(e) => setFilterType(e.target.value)}
                className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-cyan-400"
              >
                <option value="all">All types</option>
                {Object.entries(TYPE_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </select>
            </div>

            {/* Date from */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-slate-500">From</label>
              <input
                type="date"
                value={filterDateFrom}
                onChange={(e) => setFilterDateFrom(e.target.value)}
                className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-cyan-400"
              />
            </div>

            {/* Date to */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-slate-500">To</label>
              <input
                type="date"
                value={filterDateTo}
                onChange={(e) => setFilterDateTo(e.target.value)}
                className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-cyan-400"
              />
            </div>

            {/* Clear */}
            {(filterStudent !== "all" || filterClass !== "all" || filterType !== "all" || filterDateFrom || filterDateTo) ? (
              <div className="flex flex-col justify-end">
                <button
                  type="button"
                  onClick={() => {
                    setFilterStudent("all");
                    setFilterClass("all");
                    setFilterType("all");
                    setFilterDateFrom("");
                    setFilterDateTo("");
                  }}
                  className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
                >
                  Clear
                </button>
              </div>
            ) : null}
          </div>
        </div>

        {/* Table */}
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          {filtered.length === 0 ? (
            <div className="px-6 py-12 text-center text-sm text-slate-400">
              No submissions match the current filters.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-100">
                <thead className="bg-slate-50">
                  <tr>
                    <Th label="Student" col="studentName" />
                    <Th label="Class" col="className" />
                    <Th label="Assignment" col="assignmentTitle" />
                    <Th label="Type" col="contentType" />
                    <Th label="Submitted" col="submittedAt" />
                    <Th label="Score" col="score" className="text-right" />
                    <Th label="Status" col="status" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.map((row) => {
                    const needsGrading =
                      GRADABLE_TYPES.has(row.contentType) &&
                      row.score === null &&
                      (row.status === "submitted" || row.status === "draft");
                    const canRelease =
                      row.status === "submitted" || row.status === "graded" || row.status === "draft";
                    const releasing = releasingSubmissionIds.has(row.submissionId);

                    return (
                      <tr key={row.submissionId} className="hover:bg-slate-50/60 transition-colors">
                        <td className="whitespace-nowrap px-4 py-3 text-sm font-medium text-slate-800">
                          {row.studentName}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-sm text-slate-600">
                          {row.className}
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-800 max-w-xs truncate">
                          {row.assignmentTitle}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-sm text-slate-500">
                          {TYPE_LABELS[row.contentType] ?? row.contentType}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-sm text-slate-500">
                          {formatDate(row.submittedAt)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right">
                          {row.score !== null ? (
                            <span className={`inline-block rounded-lg px-2.5 py-0.5 text-sm tabular-nums ${scoreColor(row.score)}`}>
                              {row.score}/100
                            </span>
                          ) : (
                            <span className="text-sm text-slate-400">—</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-sm">
                          {needsGrading ? (
                            <>
                              <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700">
                                Needs grading
                              </span>
                              <a
                                href={`/assignments#assignment-${row.assignmentId}`}
                                className="ml-2 text-xs font-medium text-violet-700 hover:underline"
                              >
                                Grade →
                              </a>
                            </>
                          ) : (
                            <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                              row.status === "graded"
                                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                : row.status === "returned"
                                ? "border-cyan-200 bg-cyan-50 text-cyan-700"
                                : "border-slate-200 bg-slate-100 text-slate-600"
                            }`}>
                              {row.status.charAt(0).toUpperCase() + row.status.slice(1)}
                            </span>
                          )}
                          {canRelease ? (
                            <button
                              type="button"
                              disabled={releasing}
                              onClick={() => void handleRelease(row.submissionId)}
                              className="ml-2 text-xs font-medium text-violet-700 hover:underline disabled:opacity-60"
                            >
                              {releasing ? "Releasing..." : "Release"}
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {filtered.length > 0 ? (
          <p className="text-right text-xs text-slate-400">
            Showing {filtered.length} of {data.rows.length} submission{data.rows.length === 1 ? "" : "s"}
          </p>
        ) : null}
    </div>
  );
}
