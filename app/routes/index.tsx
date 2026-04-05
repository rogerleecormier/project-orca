import { useState } from "react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import {
  checkDbConnection,
  createStudentProfileInline,
  getManagedStudents,
  getParentDashboardData,
  getViewerContext,
  updateStudentProfile,
} from "../server/functions";

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

    const [health, studentManager, parentDashboard] = await Promise.all([
      checkDbConnection(),
      getManagedStudents(),
      getParentDashboardData(),
    ]);

    return {
      health,
      studentManager,
      parentDashboard,
    };
  },
});

function Home() {
  const data = Route.useLoaderData();
  const router = useRouter();
  const [createError, setCreateError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [createLoading, setCreateLoading] = useState(false);
  const [editLoading, setEditLoading] = useState(false);
  const [editingStudentId, setEditingStudentId] = useState<string | null>(null);

  const [newStudentName, setNewStudentName] = useState("");
  const [newStudentGrade, setNewStudentGrade] = useState("");
  const [newStudentBirthDate, setNewStudentBirthDate] = useState("");
  const [newStudentPin, setNewStudentPin] = useState("");

  const [editStudentName, setEditStudentName] = useState("");
  const [editStudentGrade, setEditStudentGrade] = useState("");
  const [editStudentBirthDate, setEditStudentBirthDate] = useState("");
  const [editStudentPin, setEditStudentPin] = useState("");
  const [selectedStudentId, setSelectedStudentId] = useState(
    data.parentDashboard.students[0]?.id ?? "",
  );

  const students = data.studentManager.students;
  const parentStudents = data.parentDashboard.students;
  const selectedStudent = parentStudents.find((student) => student.id === selectedStudentId) ?? null;
  const selectedMetrics = selectedStudentId
    ? data.parentDashboard.metricsByStudent[selectedStudentId] ?? []
    : [];

  const startEditingStudent = (student: {
    id: string;
    displayName: string;
    gradeLevel: string;
    birthDate: string;
  }) => {
    setEditError(null);
    setEditingStudentId(student.id);
    setEditStudentName(student.displayName);
    setEditStudentGrade(student.gradeLevel);
    setEditStudentBirthDate(student.birthDate);
    setEditStudentPin("");
  };

  const resetEditState = () => {
    setEditingStudentId(null);
    setEditStudentName("");
    setEditStudentGrade("");
    setEditStudentBirthDate("");
    setEditStudentPin("");
  };

  const handleCreateStudent = async () => {
    setCreateError(null);

    if (!newStudentName.trim() || !newStudentGrade.trim() || !newStudentPin.trim()) {
      setCreateError("Student name, grade, and PIN are required.");
      return;
    }

    if (!/^\d{4,6}$/.test(newStudentPin)) {
      setCreateError("Student PIN must be 4-6 digits.");
      return;
    }

    setCreateLoading(true);

    try {
      await createStudentProfileInline({
        data: {
          displayName: newStudentName.trim(),
          gradeLevel: newStudentGrade.trim(),
          birthDate: newStudentBirthDate || undefined,
          pin: newStudentPin,
        },
      });

      setNewStudentName("");
      setNewStudentGrade("");
      setNewStudentBirthDate("");
      setNewStudentPin("");
      await router.invalidate();
    } catch {
      setCreateError("Could not create the student profile.");
    } finally {
      setCreateLoading(false);
    }
  };

  const handleUpdateStudent = async () => {
    if (!editingStudentId) {
      return;
    }

    setEditError(null);

    if (!editStudentName.trim() || !editStudentGrade.trim()) {
      setEditError("Student name and grade are required.");
      return;
    }

    if (editStudentPin && !/^\d{4,6}$/.test(editStudentPin)) {
      setEditError("Student PIN must be 4-6 digits when provided.");
      return;
    }

    setEditLoading(true);

    try {
      await updateStudentProfile({
        data: {
          profileId: editingStudentId,
          displayName: editStudentName.trim(),
          gradeLevel: editStudentGrade.trim(),
          birthDate: editStudentBirthDate || undefined,
          pin: editStudentPin || undefined,
        },
      });

      resetEditState();
      await router.invalidate();
    } catch {
      setEditError("Could not update the student profile.");
    } finally {
      setEditLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
        <h1 className="text-3xl font-semibold text-slate-900">ProOrca LMS</h1>
        <p className="mt-2 text-slate-600">
          Parent dashboard for student progress tracking and learning completion.
        </p>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
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
            No students found. Add a student below to begin tracking class completion.
          </div>
        ) : (
          <>
            <div className="mt-5 flex flex-wrap gap-2">
              {parentStudents.map((student) => {
                const isSelected = selectedStudentId === student.id;

                return (
                  <button
                    key={student.id}
                    onClick={() => setSelectedStudentId(student.id)}
                    className={`rounded-xl border px-4 py-2 text-sm font-medium transition ${
                      isSelected
                        ? "border-cyan-600 bg-cyan-600 text-white"
                        : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
                    }`}
                  >
                    {student.displayName}
                    {student.gradeLevel ? ` (Grade ${student.gradeLevel})` : ""}
                  </button>
                );
              })}
            </div>

            <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50/70 p-5">
              <h3 className="text-lg font-semibold text-slate-900">
                {selectedStudent
                  ? `${selectedStudent.displayName} - Class Completion`
                  : "Class Completion"}
              </h3>

              {selectedMetrics.length === 0 ? (
                <p className="mt-3 text-sm text-slate-600">No classes assigned yet.</p>
              ) : (
                <div className="mt-4 space-y-3">
                  {selectedMetrics.map((metric) => (
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
          </>
        )}
      </section>

      <section className="grid gap-6 xl:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <article className="rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-emerald-700">Student Management</p>
              <h2 className="mt-2 text-xl font-semibold text-slate-900">Add Student</h2>
              <p className="mt-2 text-sm text-slate-600">
                Parent accounts can create student records directly from the dashboard.
              </p>
            </div>
            <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">
              {students.length} {students.length === 1 ? "student" : "students"}
            </span>
          </div>

          <div className="mt-5 space-y-4">
            <label className="block space-y-2">
              <span className="text-sm font-medium text-slate-700">Student Name</span>
              <input
                value={newStudentName}
                onChange={(event) => setNewStudentName(event.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                placeholder="Sarah"
              />
            </label>

            <label className="block space-y-2">
              <span className="text-sm font-medium text-slate-700">Grade Level</span>
              <input
                value={newStudentGrade}
                onChange={(event) => setNewStudentGrade(event.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                placeholder="9"
              />
              <p className="text-xs text-slate-500">Grade is required for every student profile.</p>
            </label>

            <label className="block space-y-2">
              <span className="text-sm font-medium text-slate-700">Birth Date</span>
              <input
                type="date"
                value={newStudentBirthDate}
                onChange={(event) => setNewStudentBirthDate(event.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
              />
            </label>

            <label className="block space-y-2">
              <span className="text-sm font-medium text-slate-700">Student PIN</span>
              <input
                type="password"
                inputMode="numeric"
                value={newStudentPin}
                onChange={(event) => setNewStudentPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                placeholder="1234"
                maxLength={6}
              />
              <p className="text-xs text-slate-500">Use 4-6 digits for the student PIN.</p>
            </label>
          </div>

          {createError ? (
            <p className="mt-4 rounded-lg bg-rose-50 p-3 text-sm font-medium text-rose-700">{createError}</p>
          ) : null}

          <button
            onClick={() => {
              void handleCreateStudent();
            }}
            disabled={createLoading || editLoading}
            className="mt-5 w-full rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
          >
            {createLoading ? "Creating..." : "Create Student"}
          </button>
        </article>

        <article className="rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-cyan-700">Student Management</p>
              <h2 className="mt-2 text-xl font-semibold text-slate-900">Manage Students</h2>
              <p className="mt-2 text-sm text-slate-600">
                Review each student profile and update the details parents control.
              </p>
            </div>
          </div>

          {students.length === 0 ? (
            <div className="mt-5 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">
              No student profiles yet. Create the first student from the form on the left.
            </div>
          ) : (
            <div className="mt-5 space-y-4">
              {students.map((student) => {
                const isEditing = editingStudentId === student.id;

                return (
                  <div key={student.id} className="rounded-2xl border border-slate-200 bg-slate-50/80 p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h3 className="text-lg font-semibold text-slate-900">{student.displayName}</h3>
                        <p className="mt-1 text-sm text-slate-600">Grade {student.gradeLevel || "Required"}</p>
                        <p className="mt-1 text-xs text-slate-500">
                          {student.birthDate ? `Birth date: ${student.birthDate}` : "Birth date not set"}
                        </p>
                      </div>

                      <button
                        onClick={() => {
                          if (isEditing) {
                            resetEditState();
                            return;
                          }

                          startEditingStudent(student);
                        }}
                        className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
                      >
                        {isEditing ? "Cancel" : "Edit Details"}
                      </button>
                    </div>

                    {isEditing ? (
                      <div className="mt-5 space-y-4 border-t border-slate-200 pt-5">
                        <label className="block space-y-2">
                          <span className="text-sm font-medium text-slate-700">Student Name</span>
                          <input
                            value={editStudentName}
                            onChange={(event) => setEditStudentName(event.target.value)}
                            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                          />
                        </label>

                        <label className="block space-y-2">
                          <span className="text-sm font-medium text-slate-700">Grade Level</span>
                          <input
                            value={editStudentGrade}
                            onChange={(event) => setEditStudentGrade(event.target.value)}
                            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                          />
                          <p className="text-xs text-slate-500">Grade is required when updating a student.</p>
                        </label>

                        <label className="block space-y-2">
                          <span className="text-sm font-medium text-slate-700">Birth Date</span>
                          <input
                            type="date"
                            value={editStudentBirthDate}
                            onChange={(event) => setEditStudentBirthDate(event.target.value)}
                            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                          />
                        </label>

                        <label className="block space-y-2">
                          <span className="text-sm font-medium text-slate-700">Reset Student PIN</span>
                          <input
                            type="password"
                            inputMode="numeric"
                            value={editStudentPin}
                            onChange={(event) => setEditStudentPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
                            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                            placeholder="Leave blank to keep current PIN"
                            maxLength={6}
                          />
                        </label>

                        {editError ? (
                          <p className="rounded-lg bg-rose-50 p-3 text-sm font-medium text-rose-700">{editError}</p>
                        ) : null}

                        <button
                          onClick={() => {
                            void handleUpdateStudent();
                          }}
                          disabled={editLoading || createLoading}
                          className="w-full rounded-xl bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-60"
                        >
                          {editLoading ? "Saving..." : "Save Student Details"}
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </article>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">System Snapshot</h2>
        <pre className="mt-3 overflow-auto rounded-xl bg-slate-100 p-4 text-sm text-slate-800">
          {JSON.stringify(data.health, null, 2)}
        </pre>
      </section>
    </div>
  );
}
