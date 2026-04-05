import { useState } from "react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import {
  archiveStudentProfile,
  createStudentProfileInline,
  getManagedStudents,
  getViewerContext,
  restoreStudentProfile,
  updateStudentProfile,
} from "../server/functions";
import { DeleteConfirmModal } from "../components/delete-confirm-modal";

export const Route = createFileRoute("/students")({
  component: StudentsPage,
  loader: async () => {
    const viewer = await getViewerContext();

    if (!viewer.isAuthenticated) {
      throw redirect({ to: "/login" });
    }

    if (viewer.activeRole === "student") {
      throw redirect({ to: "/student" });
    }

    const result = await getManagedStudents();
    return result ?? { students: [] };
  },
});

function StudentsPage() {
  const data = Route.useLoaderData();
  const router = useRouter();

  const [createError, setCreateError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [createLoading, setCreateLoading] = useState(false);
  const [editLoading, setEditLoading] = useState(false);
  const [editingStudentId, setEditingStudentId] = useState<string | null>(null);

  // Archive modal (reuses DeleteConfirmModal for PIN entry)
  const [archiveTarget, setArchiveTarget] = useState<{ id: string; displayName: string } | null>(null);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  // Restore (no PIN required)
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const [showArchived, setShowArchived] = useState(false);

  const [newStudentName, setNewStudentName] = useState("");
  const [newStudentGrade, setNewStudentGrade] = useState("");
  const [newStudentBirthDate, setNewStudentBirthDate] = useState("");
  const [newStudentPin, setNewStudentPin] = useState("");

  const [editStudentName, setEditStudentName] = useState("");
  const [editStudentGrade, setEditStudentGrade] = useState("");
  const [editStudentBirthDate, setEditStudentBirthDate] = useState("");
  const [editStudentPin, setEditStudentPin] = useState("");

  const activeStudents = data.students.filter((s) => s.status === "active");
  const archivedStudents = data.students.filter((s) => s.status === "archived");

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

  const handleArchiveStudent = async (pin: string) => {
    if (!archiveTarget) return;
    setArchiveLoading(true);
    setArchiveError(null);
    try {
      await archiveStudentProfile({ data: { id: archiveTarget.id, parentPin: pin } });
      setArchiveTarget(null);
      await router.invalidate();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "";
      setArchiveError(
        msg === "INVALID_PIN" ? "Incorrect PIN. Please try again." : "Could not archive the student profile.",
      );
    } finally {
      setArchiveLoading(false);
    }
  };

  const handleRestoreStudent = async (id: string) => {
    setRestoringId(id);
    try {
      await restoreStudentProfile({ data: { id } });
      await router.invalidate();
    } catch {
      // no-op — reload will show current state
    } finally {
      setRestoringId(null);
    }
  };

  const handleUpdateStudent = async () => {
    if (!editingStudentId) return;

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
      <section className="orca-hero orca-wave rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
        <p className="text-xs uppercase tracking-[0.2em] text-cyan-700">Parent Workspace</p>
        <div className="mt-2 flex items-center gap-3">
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
          <h1 className="text-3xl font-semibold text-slate-900">Manage Students</h1>
        </div>
        <p className="mt-2 text-slate-600">
          Add new student profiles and update existing student records.
        </p>
      </section>

      <section className="grid gap-6 xl:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        {/* Create form */}
        <article className="rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold text-slate-900">Add Student</h2>
              <p className="mt-2 text-sm text-slate-600">
                Create a new student profile for your home pod.
              </p>
            </div>
            <span className="rounded-full bg-cyan-50 px-3 py-1 text-xs font-medium text-cyan-700">
              {activeStudents.length} {activeStudents.length === 1 ? "student" : "students"}
            </span>
          </div>

          <div className="mt-5 space-y-4">
            <label className="block space-y-2">
              <span className="text-sm font-medium text-slate-700">Student Name</span>
              <input
                value={newStudentName}
                onChange={(e) => setNewStudentName(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                placeholder="Sarah"
              />
            </label>

            <label className="block space-y-2">
              <span className="text-sm font-medium text-slate-700">Grade Level</span>
              <input
                value={newStudentGrade}
                onChange={(e) => setNewStudentGrade(e.target.value)}
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
                onChange={(e) => setNewStudentBirthDate(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
              />
            </label>

            <label className="block space-y-2">
              <span className="text-sm font-medium text-slate-700">Student PIN</span>
              <input
                type="password"
                inputMode="numeric"
                value={newStudentPin}
                onChange={(e) => setNewStudentPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                placeholder="1234"
                maxLength={6}
              />
              <p className="text-xs text-slate-500">Use 4-6 digits for the student PIN.</p>
            </label>
          </div>

          {createError ? (
            <p className="mt-4 rounded-lg bg-rose-50 p-3 text-sm font-medium text-rose-700">
              {createError}
            </p>
          ) : null}

          <button
            onClick={() => void handleCreateStudent()}
            disabled={createLoading || editLoading}
            className="mt-5 w-full rounded-xl bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-60"
          >
            {createLoading ? "Creating..." : "Create Student"}
          </button>
        </article>

        {/* Active profiles */}
        <article className="rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-900">Student Profiles</h2>
          <p className="mt-1 text-sm text-slate-600">
            Review and update active student records.
          </p>

          {activeStudents.length === 0 ? (
            <div className="mt-5 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">
              No active students. Create the first one from the form on the left.
            </div>
          ) : (
            <div className="mt-5 space-y-4">
              {activeStudents.map((student) => {
                const isEditing = editingStudentId === student.id;

                return (
                  <div
                    key={student.id}
                    className="rounded-2xl border border-slate-200 bg-slate-50/80 p-5"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h3 className="text-lg font-semibold text-slate-900">
                          {student.displayName}
                        </h3>
                        <p className="mt-1 text-sm text-slate-600">
                          Grade {student.gradeLevel || "Required"}
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          {student.birthDate
                            ? `Birth date: ${student.birthDate}`
                            : "Birth date not set"}
                        </p>
                      </div>

                      <div className="flex shrink-0 gap-2">
                        <button
                          onClick={() => {
                            if (isEditing) { resetEditState(); return; }
                            startEditingStudent(student);
                          }}
                          className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
                        >
                          {isEditing ? "Cancel" : "Edit"}
                        </button>
                        {!isEditing ? (
                          <button
                            onClick={() => {
                              setArchiveTarget({ id: student.id, displayName: student.displayName });
                              setArchiveError(null);
                            }}
                            className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-700 hover:bg-amber-100"
                          >
                            Archive
                          </button>
                        ) : null}
                      </div>
                    </div>

                    {isEditing ? (
                      <div className="mt-5 space-y-4 border-t border-slate-200 pt-5">
                        <label className="block space-y-2">
                          <span className="text-sm font-medium text-slate-700">Student Name</span>
                          <input
                            value={editStudentName}
                            onChange={(e) => setEditStudentName(e.target.value)}
                            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                          />
                        </label>

                        <label className="block space-y-2">
                          <span className="text-sm font-medium text-slate-700">Grade Level</span>
                          <input
                            value={editStudentGrade}
                            onChange={(e) => setEditStudentGrade(e.target.value)}
                            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                          />
                        </label>

                        <label className="block space-y-2">
                          <span className="text-sm font-medium text-slate-700">Birth Date</span>
                          <input
                            type="date"
                            value={editStudentBirthDate}
                            onChange={(e) => setEditStudentBirthDate(e.target.value)}
                            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                          />
                        </label>

                        <label className="block space-y-2">
                          <span className="text-sm font-medium text-slate-700">Reset Student PIN</span>
                          <input
                            type="password"
                            inputMode="numeric"
                            value={editStudentPin}
                            onChange={(e) =>
                              setEditStudentPin(e.target.value.replace(/\D/g, "").slice(0, 6))
                            }
                            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                            placeholder="Leave blank to keep current PIN"
                            maxLength={6}
                          />
                        </label>

                        {editError ? (
                          <p className="rounded-lg bg-rose-50 p-3 text-sm font-medium text-rose-700">
                            {editError}
                          </p>
                        ) : null}

                        <button
                          onClick={() => void handleUpdateStudent()}
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

          {/* Archived students collapsible section */}
          {archivedStudents.length > 0 ? (
            <div className="mt-6 border-t border-slate-200 pt-5">
              <button
                type="button"
                onClick={() => setShowArchived((v) => !v)}
                className="flex w-full items-center justify-between gap-2 text-left"
              >
                <span className="text-sm font-medium text-slate-600">
                  Archived Students ({archivedStudents.length})
                </span>
                <span className="text-xs text-slate-400">{showArchived ? "▲ Hide" : "▼ Show"}</span>
              </button>

              {showArchived ? (
                <div className="mt-4 space-y-3">
                  <p className="text-xs text-slate-500">
                    Archived profiles are hidden from the active dashboard. All submissions and history are preserved.
                  </p>
                  {archivedStudents.map((student) => (
                    <div
                      key={student.id}
                      className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 opacity-70"
                    >
                      <div>
                        <p className="text-sm font-medium text-slate-700">{student.displayName}</p>
                        <p className="text-xs text-slate-500">Grade {student.gradeLevel || "—"}</p>
                      </div>
                      <button
                        type="button"
                        disabled={restoringId === student.id}
                        onClick={() => void handleRestoreStudent(student.id)}
                        className="shrink-0 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-60"
                      >
                        {restoringId === student.id ? "Restoring…" : "Restore"}
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </article>
      </section>

      {/* Archive confirmation modal (reuses the PIN-entry delete modal) */}
      <DeleteConfirmModal
        open={archiveTarget !== null}
        itemLabel="Student"
        itemName={archiveTarget?.displayName ?? ""}
        confirmLabel="Archive Student"
        confirmDescription="Archiving preserves all submissions and history. The student will be hidden from the active dashboard and cannot log in until restored."
        onConfirm={(pin) => void handleArchiveStudent(pin)}
        onCancel={() => { setArchiveTarget(null); setArchiveError(null); }}
        error={archiveError}
        loading={archiveLoading}
      />
    </div>
  );
}
