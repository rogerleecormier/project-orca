import { useMemo, useState } from "react";
import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { getParentDashboardData, getViewerContext } from "../server/functions";

export const Route = createFileRoute("/")({
  component: Home,
  loader: async () => {
    const viewer = await getViewerContext();

    if (!viewer.isAuthenticated) {
      throw redirect({ to: "/login" });
    }

    if (viewer.activeRole === "student") {
      throw redirect({ to: "/student" });
    }

    const parentDashboard = await getParentDashboardData();

    return {
      parentDashboard,
      isAdminParent: viewer.isAdminParent ?? false,
    };
  },
});

function Home() {
  const data = Route.useLoaderData();

  const currentSchoolYear = () => {
    const now = new Date();
    const year = now.getFullYear();
    const start = now.getMonth() >= 7 ? year : year - 1;
    return `${start}-${start + 1}`;
  };

  const [selectedStudentId, setSelectedStudentId] = useState(
    data.parentDashboard.students[0]?.id ?? "",
  );
  const [selectedYear, setSelectedYear] = useState(() => {
    const currentYear = currentSchoolYear();
    if (data.parentDashboard.schoolYears.includes(currentYear)) {
      return currentYear;
    }
    return data.parentDashboard.schoolYears[0] ?? "all";
  });

  const parentStudents = data.parentDashboard.students;
  const selectedStudent = parentStudents.find((student) => student.id === selectedStudentId) ?? null;
  const selectedMetrics = selectedStudentId
    ? data.parentDashboard.metricsByStudent[selectedStudentId] ?? []
    : [];
  const filteredMetrics = useMemo(() => {
    if (selectedYear === "all") {
      return selectedMetrics;
    }
    if (selectedYear === "") {
      return selectedMetrics.filter((metric) => !metric.schoolYear);
    }
    return selectedMetrics.filter((metric) => metric.schoolYear === selectedYear);
  }, [selectedMetrics, selectedYear]);
  const featureCtas = [
    {
      to: "/students",
      title: "Students",
      description: "Manage student profiles and PINs.",
      accentClass: "border-emerald-200 bg-emerald-50/80 text-emerald-900",
      iconClass: "bg-emerald-100 text-emerald-700",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
          <path
            d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M15 3.13a4 4 0 0 1 0 7.75M14 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
    },
    {
      to: "/classes",
      title: "Classes",
      description: "Build and organize your curriculum.",
      accentClass: "border-cyan-200 bg-cyan-50/80 text-cyan-900",
      iconClass: "bg-cyan-100 text-cyan-700",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
          <path
            d="M4 5h16v12H4zM2 17h20M8 21h8"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
    },
    {
      to: "/assignments",
      title: "Assignments",
      description: "Create and track student work.",
      accentClass: "border-violet-200 bg-violet-50/80 text-violet-900",
      iconClass: "bg-violet-100 text-violet-700",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
          <path
            d="M9 11h6M9 15h6M9 7h3M5 3h14a2 2 0 0 1 2 2v14l-4-2-4 2-4-2-4 2V5a2 2 0 0 1 2-2Z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
    },
    ...(data.isAdminParent
      ? [
          {
            to: "/admin",
            title: "Home Pod",
            description: "Configure parent admin access.",
            accentClass: "border-amber-200 bg-amber-50/80 text-amber-900",
            iconClass: "bg-amber-100 text-amber-700",
            icon: (
              <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
                <path
                  d="M12 3 4 7v6c0 5 3.4 7.7 8 8 4.6-.3 8-3 8-8V7l-8-4Zm0 6v4m0 4h.01"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ),
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-6">
      <section className="orca-hero orca-wave rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <span className="orca-icon-chip" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
                <path
                  d="M4 14c3.5 0 5.5-2.5 8-2.5 2 0 3.8 1 6 1.8V9.5l2 1.2-2 1.1v4.7c-2.5-.5-4.2-1.5-6-1.5-2.8 0-4.5 2.5-8 2.5v-3.5Z"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <h2 className="text-xl font-semibold text-slate-900">Parent Quick Actions</h2>
          </div>
          <p className="text-sm text-slate-600">Jump to the tools you use most.</p>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {featureCtas.map((cta) => (
            <Link
              key={cta.to}
              to={cta.to}
              className={`group rounded-2xl border p-4 transition hover:shadow-sm ${cta.accentClass}`}
            >
              <div className={`inline-flex rounded-xl p-2 ${cta.iconClass}`}>{cta.icon}</div>
              <h3 className="mt-3 text-base font-semibold">{cta.title}</h3>
              <p className="mt-1 text-sm">{cta.description}</p>
              <p className="mt-3 text-xs font-medium uppercase tracking-[0.14em]">
                Open
              </p>
            </Link>
          ))}
        </div>
      </section>

      <section className="orca-wave rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-cyan-700">Parent View</p>
            <h2 className="mt-2 text-xl font-semibold text-slate-900">Student Progress Overview</h2>
            <p className="mt-2 text-sm text-slate-600">
              Choose a student to view completion metrics for each assigned class.
            </p>
          </div>
          <span className="rounded-full bg-cyan-50 px-3 py-1 text-xs font-medium text-cyan-700">
            {parentStudents.length} {parentStudents.length === 1 ? "student" : "students"}
          </span>
        </div>

        {parentStudents.length === 0 ? (
          <div className="mt-5 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">
            No students found. Add a student from the Students page to begin tracking class completion.
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
                      <p className={`mt-1 text-xs ${isSelected ? "text-cyan-100" : "text-slate-500"}`}>
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
                  {data.parentDashboard.schoolYears.map((year) => (
                    <option key={year} value={year}>
                      {year}
                    </option>
                  ))}
                  {data.parentDashboard.hasClassesWithoutSchoolYear ? (
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
                    <article key={metric.classId} className="rounded-xl border border-slate-200 bg-white p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h4 className="font-semibold text-slate-900">{metric.classTitle}</h4>
                        <p className="text-sm text-slate-600">{metric.completionPercent}% complete</p>
                      </div>

                      <div className="mt-2 h-2 w-full rounded-full bg-slate-200">
                        <div
                          className="h-2 rounded-full bg-cyan-500"
                          style={{ width: `${metric.completionPercent}%` }}
                        />
                      </div>

                      <div className="mt-3 grid gap-2 text-sm text-slate-600 sm:grid-cols-3">
                        <p>Assigned: {metric.assignedCount}</p>
                        <p>Submitted: {metric.submittedCount}</p>
                        <p>
                          Avg Score: {metric.averageScore === null ? "Not graded" : `${metric.averageScore}%`}
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
