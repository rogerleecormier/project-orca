import { useMemo, useState } from "react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import {
  createClassRecord,
  getClassEngineData,
  getViewerContext,
  updateClassRecord,
} from "../server/functions";
import { OrcaMark } from "../components/icons/orca-mark";

export const Route = createFileRoute("/classes")({
  loader: async () => {
    const viewer = await getViewerContext();

    if (!viewer.isAuthenticated) {
      throw redirect({ to: "/login" });
    }

    if (viewer.activeRole === "student") {
      throw redirect({ to: "/student" });
    }

    return getClassEngineData();
  },
  component: ClassEnginePage,
});

// Derive the current school year as a default, e.g. "2025-2026"
function currentSchoolYear(): string {
  const now = new Date();
  const year = now.getFullYear();
  // School year flips in August
  const start = now.getMonth() >= 7 ? year : year - 1;
  return `${start}-${start + 1}`;
}

function schoolYearOptions(): string[] {
  const now = new Date();
  const year = now.getFullYear();
  const currentStart = now.getMonth() >= 7 ? year : year - 1;

  const years: string[] = [];
  for (let start = currentStart - 10; start <= currentStart + 10; start += 1) {
    years.push(`${start}-${start + 1}`);
  }

  return years.reverse();
}

function isValidSchoolYear(value: string) {
  return /^\d{4}-\d{4}$/.test(value);
}

function normalizeSchoolYear(value: string | null | undefined) {
  if (!value) return "";
  return isValidSchoolYear(value) ? value : "";
}

function extractMutationErrorText(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  if (typeof error === "object" && error !== null) {
    const candidate = (error as { message?: unknown }).message;
    if (typeof candidate === "string") {
      return candidate;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return "";
    }
  }

  return "";
}

function classMutationErrorMessage(error: unknown) {
  const message = extractMutationErrorText(error);
  const normalized = message.toUpperCase();

  if (normalized.includes("FORBIDDEN")) {
    return "You do not have permission to assign one or more selected students.";
  }
  if (normalized.includes("NOT_FOUND")) {
    return "This class was not found. Refresh and try again.";
  }
  if (normalized.includes("PIN_REQUIRED")) {
    return "Parent PIN is required for this action.";
  }
  if (normalized.includes("SCHOOL YEAR")) {
    return message;
  }
  if (message.trim()) {
    return `Unable to update class right now. (${message})`;
  }

  return "Unable to update class right now.";
}

function ClassEnginePage() {
  const router = useRouter();
  const data = Route.useLoaderData();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [schoolYear, setSchoolYear] = useState(currentSchoolYear());
  const [selectedStudentIds, setSelectedStudentIds] = useState<string[]>(
    data.students[0]?.id ? [data.students[0].id] : [],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);

  const [editingClassId, setEditingClassId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editSchoolYear, setEditSchoolYear] = useState("");
  const [editSelectedStudentIds, setEditSelectedStudentIds] = useState<string[]>([]);
  const [updateSaving, setUpdateSaving] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const yearOptions = useMemo(() => schoolYearOptions(), []);

  // Filter classes by school year
  const allYears = useMemo(() => {
    const years = Array.from(
      new Set(
        data.classes
          .map((c) => c.schoolYear)
          .filter((value): value is string => Boolean(value))
          .filter((value) => isValidSchoolYear(value)),
      ),
    ).sort().reverse();
    return years;
  }, [data.classes]);

  const [filterYear, setFilterYear] = useState<string>("all");

  const visibleClasses = useMemo(() => {
    if (filterYear === "all") return data.classes;
    return data.classes.filter((c) => c.schoolYear === filterYear);
  }, [data.classes, filterYear]);

  const toggleStudentSelection = (studentId: string) =>
    setSelectedStudentIds((cur) =>
      cur.includes(studentId) ? cur.filter((id) => id !== studentId) : [...cur, studentId],
    );

  const toggleEditStudentSelection = (studentId: string) =>
    setEditSelectedStudentIds((cur) =>
      cur.includes(studentId) ? cur.filter((id) => id !== studentId) : [...cur, studentId],
    );

  const beginEdit = (row: (typeof data.classes)[number]) => {
    setEditingClassId(row.id);
    setEditTitle(row.title);
    setEditDescription(row.description ?? "");
    setEditSchoolYear(normalizeSchoolYear(row.schoolYear));
    setEditSelectedStudentIds(row.enrolledStudents.map((s) => s.id));
    setUpdateError(null);
  };

  const cancelEdit = () => {
    setEditingClassId(null);
    setEditTitle("");
    setEditDescription("");
    setEditSchoolYear("");
    setEditSelectedStudentIds([]);
    setUpdateError(null);
  };

  const validateSchoolYear = (value: string) => value === "" || isValidSchoolYear(value);

  const submitClass = async () => {
    if (!title.trim()) { setError("Class title is required."); return; }
    if (selectedStudentIds.length === 0) { setError("Select at least one student."); return; }
    if (!validateSchoolYear(schoolYear)) { setError("School year must be YYYY-YYYY (e.g. 2024-2025)."); return; }

    setSaving(true);
    setError(null);

    try {
      await createClassRecord({
        data: {
          title: title.trim(),
          description: description.trim() || undefined,
          schoolYear: schoolYear.trim() || undefined,
          studentProfileIds: selectedStudentIds,
        },
      });

      setTitle("");
      setDescription("");
      setSchoolYear(currentSchoolYear());
      setSelectedStudentIds(data.students[0]?.id ? [data.students[0].id] : []);
      setShowCreateModal(false);
      await router.invalidate();
    } catch (caughtError) {
      setError(classMutationErrorMessage(caughtError));
    } finally {
      setSaving(false);
    }
  };

  const submitUpdate = async () => {
    if (!editingClassId) return;
    if (!editTitle.trim()) { setUpdateError("Class title is required."); return; }
    if (editSelectedStudentIds.length === 0) { setUpdateError("Select at least one student."); return; }
    if (!validateSchoolYear(editSchoolYear)) { setUpdateError("School year must be YYYY-YYYY (e.g. 2024-2025)."); return; }

    setUpdateSaving(true);
    setUpdateError(null);

    try {
      await updateClassRecord({
        data: {
          classId: editingClassId,
          title: editTitle.trim(),
          description: editDescription.trim() || undefined,
          schoolYear: editSchoolYear.trim() || undefined,
          studentProfileIds: editSelectedStudentIds,
        },
      });

      cancelEdit();
      await router.invalidate();
    } catch (caughtError) {
      setUpdateError(classMutationErrorMessage(caughtError));
    } finally {
      setUpdateSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="orca-hero orca-wave rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
        <p className="text-xs uppercase tracking-[0.2em] text-cyan-700">Parent Workspace</p>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="orca-icon-chip" aria-hidden="true">
              <OrcaMark className="h-6 w-6" alt="" />
            </span>
            <h1 className="text-3xl font-semibold text-slate-900">Manage Classes</h1>
          </div>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setShowCreateModal(true);
            }}
            className="rounded-xl bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700"
          >
            New Class
          </button>
        </div>
        <p className="mt-2 text-slate-600">
          Define class spaces by school year before publishing curriculum assignments.
        </p>
      </section>

      <div className="space-y-6">
        {/* Class list */}
        <section className="rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-xl font-semibold text-slate-900">Classes</h2>

            {/* School year filter */}
            {allYears.length > 0 ? (
              <select
                value={filterYear}
                onChange={(e) => setFilterYear(e.target.value)}
                className="rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700"
              >
                <option value="all">All years</option>
                {allYears.map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
                {data.classes.some((c) => !c.schoolYear) ? (
                  <option value="">No year set</option>
                ) : null}
              </select>
            ) : null}
          </div>

          <div className="mt-4 space-y-3">
            {visibleClasses.map((row) => (
              <article key={row.id} className="rounded-2xl border border-slate-200 bg-slate-50/80 p-5">
                {editingClassId === row.id ? (
                  <div className="space-y-3">
                    <label className="block space-y-2">
                      <span className="text-sm font-medium text-slate-700">Title</span>
                      <input
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                      />
                    </label>

                    <label className="block space-y-2">
                      <span className="text-sm font-medium text-slate-700">Description</span>
                      <textarea
                        value={editDescription}
                        onChange={(e) => setEditDescription(e.target.value)}
                        className="min-h-24 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                      />
                    </label>

                    <label className="block space-y-2">
                      <span className="text-sm font-medium text-slate-700">School Year</span>
                      <select
                        value={editSchoolYear}
                        onChange={(e) => setEditSchoolYear(e.target.value)}
                        className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800"
                      >
                        <option value="">No year</option>
                        {yearOptions.map((yearOption) => (
                          <option key={yearOption} value={yearOption}>
                            {yearOption}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="block space-y-2">
                      <span className="text-sm font-medium text-slate-700">Assigned Students</span>
                      <div className="space-y-2 rounded-xl border border-slate-300 p-3">
                        {data.students.map((student) => (
                          <label key={student.id} className="flex items-center gap-2 text-sm text-slate-800">
                            <input
                              type="checkbox"
                              checked={editSelectedStudentIds.includes(student.id)}
                              onChange={() => toggleEditStudentSelection(student.id)}
                              className="h-4 w-4 rounded border-slate-300"
                            />
                            <span>
                              {student.gradeLevel
                                ? `${student.displayName} (Grade ${student.gradeLevel})`
                                : student.displayName}
                            </span>
                          </label>
                        ))}
                      </div>
                    </label>

                    {updateError ? <p className="text-sm text-rose-700">{updateError}</p> : null}

                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => void submitUpdate()}
                        disabled={updateSaving}
                        className="rounded-xl bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-60"
                      >
                        {updateSaving ? "Saving..." : "Save"}
                      </button>
                      <button
                        onClick={cancelEdit}
                        disabled={updateSaving}
                        className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-60"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <h3 className="text-lg font-semibold text-slate-900">{row.title}</h3>
                        {row.schoolYear ? (
                          <span className="mt-0.5 inline-block rounded-full bg-cyan-50 px-2 py-0.5 text-xs font-medium text-cyan-700">
                            {row.schoolYear}
                          </span>
                        ) : null}
                      </div>
                      <button
                        onClick={() => beginEdit(row)}
                        className="rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
                      >
                        Edit
                      </button>
                    </div>
                    <p className="mt-2 text-sm text-slate-600">
                      {row.description ?? "No description provided yet."}
                    </p>
                    <p className="mt-1 text-sm text-slate-600">
                      Assigned to:{" "}
                      <span className="font-medium text-slate-800">
                        {row.enrolledStudents.length > 0
                          ? row.enrolledStudents
                              .map((s) =>
                                s.gradeLevel
                                  ? `${s.displayName} (Grade ${s.gradeLevel})`
                                  : s.displayName,
                              )
                              .join(", ")
                          : "Unassigned"}
                      </span>
                    </p>
                  </>
                )}
              </article>
            ))}

            {visibleClasses.length === 0 ? (
              <p className="text-sm text-slate-500">
                {filterYear === "all"
                  ? "No classes created yet."
                  : `No classes for ${filterYear === "" ? "unset year" : filterYear}.`}
              </p>
            ) : null}
          </div>
        </section>
      </div>

      {showCreateModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
          <div className="w-full max-w-3xl rounded-2xl border border-slate-200 bg-white shadow-2xl">
            <div className="flex items-center justify-between gap-4 border-b border-slate-200 px-6 py-4">
              <h2 className="text-xl font-semibold text-slate-900">New Class</h2>
              <button
                type="button"
                onClick={() => {
                  if (saving) return;
                  setShowCreateModal(false);
                  setError(null);
                }}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                Close
              </button>
            </div>
            <div className="px-6 py-5">
              <div className="grid gap-4 md:grid-cols-2">
                <label className="space-y-2 md:col-span-2">
                  <span className="text-sm font-medium text-slate-700">Title</span>
                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                    placeholder="Foundations of Biology"
                  />
                </label>

                <label className="space-y-2 md:col-span-2">
                  <span className="text-sm font-medium text-slate-700">Description</span>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    className="min-h-24 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                    placeholder="Topics, pacing notes, and expectations"
                  />
                </label>

                <label className="space-y-2 md:col-span-2">
                  <span className="text-sm font-medium text-slate-700">School Year</span>
                  <select
                    value={schoolYear}
                    onChange={(e) => setSchoolYear(e.target.value)}
                    className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800"
                  >
                    <option value="">No year</option>
                    {yearOptions.map((yearOption) => (
                      <option key={yearOption} value={yearOption}>
                        {yearOption}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-slate-500">
                    Select the active school year (current, past 10, and next 10 years).
                  </p>
                </label>

                <label className="space-y-2 md:col-span-2">
                  <span className="text-sm font-medium text-slate-700">Assigned Students</span>
                  <div className="space-y-2 rounded-xl border border-slate-300 p-3">
                    {data.students.length === 0 ? (
                      <p className="text-sm text-slate-500 italic">No active students — add one first.</p>
                    ) : (
                      data.students.map((student) => (
                        <label key={student.id} className="flex items-center gap-2 text-sm text-slate-800">
                          <input
                            type="checkbox"
                            checked={selectedStudentIds.includes(student.id)}
                            onChange={() => toggleStudentSelection(student.id)}
                            className="h-4 w-4 rounded border-slate-300"
                          />
                          <span>
                            {student.gradeLevel
                              ? `${student.displayName} (Grade ${student.gradeLevel})`
                              : student.displayName}
                          </span>
                        </label>
                      ))
                    )}
                  </div>
                </label>
              </div>

              {error ? <p className="mt-3 text-sm text-rose-700">{error}</p> : null}

              <div className="mt-4 flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (saving) return;
                    setShowCreateModal(false);
                    setError(null);
                  }}
                  className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void submitClass()}
                  disabled={saving}
                  className="rounded-xl bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {saving ? "Saving..." : "Create Class"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
