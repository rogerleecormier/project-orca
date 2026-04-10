import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ParentPageHeader } from "./parent-page-header";
import type { getParentDashboardData } from "../server/functions";
import { SkillMapPreview } from "./skill-map-preview";

type ParentDashboardData = NonNullable<Awaited<ReturnType<typeof getParentDashboardData>>>;

export function ParentDashboard({
  parentDashboard,
  isAdminParent,
}: {
  parentDashboard: ParentDashboardData;
  isAdminParent: boolean;
}) {
  const currentSchoolYear = () => {
    const now = new Date();
    const year = now.getFullYear();
    const start = now.getMonth() >= 7 ? year : year - 1;
    return `${start}-${start + 1}`;
  };

  const [selectedStudentId, setSelectedStudentId] = useState(
    parentDashboard.students[0]?.id ?? "",
  );
  const [selectedYear, setSelectedYear] = useState(() => {
    const currentYear = currentSchoolYear();
    if (parentDashboard.schoolYears.includes(currentYear)) {
      return currentYear;
    }
    return parentDashboard.schoolYears[0] ?? "all";
  });

  const parentStudents = parentDashboard.students;
  const selectedStudent =
    parentStudents.find((student) => student.id === selectedStudentId) ?? null;
  const selectedMetrics = selectedStudentId
    ? parentDashboard.metricsByStudent[selectedStudentId] ?? []
    : [];
  const filteredMetrics = useMemo(() => {
    if (selectedYear === "all") return selectedMetrics;
    if (selectedYear === "") return selectedMetrics.filter((metric) => !metric.schoolYear);
    return selectedMetrics.filter((metric) => metric.schoolYear === selectedYear);
  }, [selectedMetrics, selectedYear]);

  const quickActions = [
    {
      to: "/students",
      label: "Students",
      description: "Manage student profiles and PINs.",
      icon: "👥",
    },
    {
      to: "/classes",
      label: "Classes",
      description: "Build and organize your curriculum.",
      icon: "🧱",
    },
    {
      to: "/assignments",
      label: "Assignments",
      description: "Create and track student work.",
      icon: "📝",
    },
    {
      to: "/templates",
      label: "Templates",
      description: "Reuse your best assignment setups.",
      icon: "🗂️",
    },
    {
      to: "/gradebook",
      label: "Gradebook",
      description: "Review submissions and scores.",
      icon: "📘",
    },
    {
      to: "/planner",
      label: "Week Planner",
      description: "Schedule assignments for the week.",
      icon: "🗓️",
    },
    {
      to: "/skill-trees",
      label: "Skill Maps",
      description: "Build RPG-style curriculum pathways.",
      icon: "🧭",
    },
    {
      to: "/rewards",
      label: "Reward Tracks",
      description: "Set milestone rewards for XP progress. Battle-pass style motivation.",
      icon: "🏆",
    },
    ...(isAdminParent
      ? [
          {
            to: "/admin",
            label: "Home Pod",
            description: "Configure parent admin access.",
            icon: "🛠️",
          },
        ]
      : []),
  ];

  return (
    <div className="skill-map-dashboard space-y-6">
      <ParentPageHeader
        title="Parent Dashboard"
        description="Jump into the tools you use most and keep an eye on student progress across every class."
        action={(
          <Link
            to="/curriculum-builder"
            className="rounded-xl bg-cyan-700 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-cyan-800"
          >
            Open Builder
          </Link>
        )}
      />

      <section className="skill-map-panel rounded-[2rem] p-6">
        <div className="grid gap-6 xl:grid-cols-[minmax(320px,380px)_minmax(0,1fr)]">
          <div>
            <div className="orca-section-accent">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-cyan-700">
                Home Map
              </p>
              <span className="orca-sand-chip">Quick launch</span>
            </div>
            <h2 className="skill-map-display mt-3 text-3xl font-semibold text-slate-900">
              Parent quick actions, laid out like a route board
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-slate-600">
              Keep the most-used tools on a single launch surface while the same skill-map
              language carries across planning, progress, and assignment work.
            </p>

            <SkillMapPreview
              className="mt-5 min-h-[360px]"
              toolbarLabel="Quick launch route"
              showLegend={false}
            />
          </div>

          <div className="flex flex-col">
            <div className="grid gap-3 sm:grid-cols-2">
              {quickActions.map((cta) => (
                <Link
                  key={cta.to}
                  to={cta.to}
                  className="skill-map-action-card group flex items-center justify-between rounded-2xl px-4 py-4 text-slate-700 transition hover:text-slate-900"
                >
                  <span className="min-w-0">
                    <span className="flex items-center gap-2 text-sm font-medium">
                      <span className="text-base" aria-hidden="true">
                        {cta.icon}
                      </span>
                      {cta.label}
                    </span>
                    <span className="mt-1 block text-xs text-slate-500">{cta.description}</span>
                  </span>
                  <span className="text-xs text-slate-400 transition group-hover:text-slate-600">▶</span>
                </Link>
              ))}
            </div>

            <Link
              to="/curriculum-builder"
              className="group mt-4 block rounded-[1.6rem] border border-cyan-200 bg-gradient-to-r from-cyan-50/90 via-white to-sky-50/90 p-5 transition hover:shadow-sm"
            >
              <div className="flex items-center gap-2">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-700">AI Curriculum Builder</p>
                <span className="orca-sand-dot" aria-hidden="true" />
              </div>
              <h3 className="mt-2 flex items-center gap-2 text-lg font-semibold text-slate-900">
                <span aria-hidden="true">✦</span>
                Build a full curriculum in minutes
              </h3>
              <p className="mt-2 text-sm text-slate-600">
                Generate course structures, skill maps, and learning paths with one guided flow.
              </p>
              <div className="mt-3 flex items-center gap-2">
                <p className="text-sm font-medium text-cyan-900">Launch Builder →</p>
              </div>
            </Link>
          </div>
        </div>
      </section>

      <section className="skill-map-panel orca-wave rounded-[2rem] p-6">
        <div className="orca-sand-bar mb-5" aria-hidden="true" />
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="orca-section-accent">
              <p className="text-xs uppercase tracking-[0.2em] text-cyan-700">Parent View</p>
            </div>
            <h2 className="text-xl font-semibold text-slate-900">
              Student Progress Overview
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              Choose a student to view completion metrics for each assigned class.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="orca-sand-chip">
              {parentStudents.length}{" "}
              {parentStudents.length === 1 ? "student" : "students"}
            </span>
          </div>
        </div>

        {parentStudents.length === 0 ? (
          <div className="mt-5 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">
            No students found. Add a student from the Students page to begin tracking class
            completion.
          </div>
        ) : (
          <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,280px)_minmax(0,1fr)]">
            <aside className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
              <h3 className="text-sm font-semibold uppercase tracking-[0.14em] text-slate-700">
                Students
              </h3>
              <div className="mt-3 space-y-2">
                {parentStudents.map((student) => {
                  const isSelected = selectedStudentId === student.id;
                  return (
                    <button
                      key={student.id}
                      onClick={() => setSelectedStudentId(student.id)}
                      className={`w-full rounded-xl border px-4 py-3 text-left text-sm font-medium transition ${
                        isSelected
                          ? "border-cyan-600 bg-cyan-600 text-white"
                          : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
                      }`}
                    >
                      <p>{student.displayName}</p>
                      <p
                        className={`mt-1 text-xs ${isSelected ? "text-cyan-100" : "text-slate-500"}`}
                      >
                        {student.gradeLevel ? `Grade ${student.gradeLevel}` : "Grade not set"}
                      </p>
                    </button>
                  );
                })}
              </div>
            </aside>

            <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-lg font-semibold text-slate-900">
                  {selectedStudent
                    ? `${selectedStudent.displayName} - Class Completion`
                    : "Class Completion"}
                </h3>
                <select
                  value={selectedYear}
                  onChange={(event) => setSelectedYear(event.target.value)}
                  className="rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700"
                >
                  <option value="all">All school years</option>
                  {parentDashboard.schoolYears.map((year) => (
                    <option key={year} value={year}>
                      {year}
                    </option>
                  ))}
                  {parentDashboard.hasClassesWithoutSchoolYear ? (
                    <option value="">No year set</option>
                  ) : null}
                </select>
              </div>

              {filteredMetrics.length === 0 ? (
                <p className="mt-3 text-sm text-slate-600">
                  {selectedYear === "all"
                    ? "No classes assigned yet."
                    : `No classes found for ${selectedYear === "" ? "No year set" : selectedYear}.`}
                </p>
              ) : (
                <div className="mt-4 space-y-3">
                  {filteredMetrics.map((metric) => (
                    <article
                      key={metric.classId}
                      className="rounded-xl border border-slate-200 bg-white p-4"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h4 className="font-semibold text-slate-900">
                          <Link
                            to="/classes"
                            hash={`class-${metric.classId}`}
                            className="underline decoration-cyan-300 underline-offset-2 hover:text-cyan-700"
                          >
                            {metric.classTitle}
                          </Link>
                        </h4>
                        <p className="text-sm text-slate-600">
                          {metric.completionPercent}% complete
                        </p>
                      </div>
                      <div className="mt-2 h-2 w-full rounded-full bg-slate-200">
                        <div
                          className="h-2 rounded-full"
                          style={{
                            width: `${metric.completionPercent}%`,
                            background: "linear-gradient(90deg, var(--orca-sea), var(--orca-sand))",
                          }}
                        />
                      </div>
                      <div className="mt-3 grid gap-2 text-sm text-slate-600 sm:grid-cols-3">
                        <p>Assigned: {metric.assignedCount}</p>
                        <p>Submitted: {metric.submittedCount}</p>
                        <p>
                          Avg Score:{" "}
                          {metric.averageScore === null
                            ? "Not graded"
                            : `${metric.averageScore}%`}
                        </p>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
