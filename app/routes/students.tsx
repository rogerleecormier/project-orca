import { useState } from "react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import {
  createStudentProfileInline,
  deleteStudentProfileRecord,
  getManagedStudents,
  getViewerContext,
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
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; displayName: string } | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [newStudentName, setNewStudentName] = useState("");
  const [newStudentGrade, setNewStudentGrade] = useState("");
  const [newStudentBirthDate, setNewStudentBirthDate] = useState("");
  const [newStudentPin, setNewStudentPin] = useState("");

  const [editStudentName, setEditStudentName] = useState("");
  const [editStudentGrade, setEditStudentGrade] = useState("");
  const [editStudentBirthDate, setEditStudentBirthDate] = useState("");
  const [editStudentPin, setEditStudentPin] = useState("");

  const students = data.students;

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

  const handleDeleteStudent = async (pin: string) => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    setDeleteError(null);
    try {
      await deleteStudentProfileRecord({ data: { id: deleteTarget.id, parentPin: pin } });
      setDeleteTarget(null);
      await router.invalidate();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "";
      setDeleteError(msg === "INVALID_PIN" ? "Incorrect PIN. Please try again." : "Could not delete the student profile.");
    } finally {
      setDeleteLoading(false);
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
        <p className="text-xs uppercase tracking-[0.25em] text-emerald-700">Parent</p>
        <h1 className="mt-2 text-3xl font-semibold text-slate-900">Manage Students</h1>
        <p className="mt-2 text-slate-600">
          Add new student profiles and update existing student records.
        </p>
      </section>

      <section className="grid gap-6 xl:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <article className="rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-emerald-700">Student Management</p>
              <h2 className="mt-2 text-xl font-semibold text-slate-900">Add Student</h2>
              <p className="mt-2 text-sm text-slate-600">
                Create a new student profile for your home pod.
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
                onChange={(event) =>
                  setNewStudentPin(event.target.value.replace(/\D/g, "").slice(0, 6))
                }
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
              <h2 className="mt-2 text-xl font-semibold text-slate-900">Student Profiles</h2>
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
                        {!isEditing ? (
                          <button
                            onClick={() => { setDeleteTarget({ id: student.id, displayName: student.displayName }); setDeleteError(null); }}
                            className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700 hover:bg-rose-100"
                          >
                            Delete
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
                          <p className="text-xs text-slate-500">
                            Grade is required when updating a student.
                          </p>
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
                          <span className="text-sm font-medium text-slate-700">
                            Reset Student PIN
                          </span>
                          <input
                            type="password"
                            inputMode="numeric"
                            value={editStudentPin}
                            onChange={(event) =>
                              setEditStudentPin(
                                event.target.value.replace(/\D/g, "").slice(0, 6),
                              )
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

      <DeleteConfirmModal
        open={deleteTarget !== null}
        itemLabel="Student"
        itemName={deleteTarget?.displayName ?? ""}
        onConfirm={(pin) => void handleDeleteStudent(pin)}
        onCancel={() => { setDeleteTarget(null); setDeleteError(null); }}
        error={deleteError}
        loading={deleteLoading}
      />
    </div>
  );
}
