import { useState } from "react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import {
  createClassRecord,
  getClassEngineData,
  getViewerContext,
  updateClassRecord,
} from "../server/functions";

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

function ClassEnginePage() {
  const router = useRouter();
  const data = Route.useLoaderData();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [studentProfileId, setStudentProfileId] = useState(data.students[0]?.id ?? "");
  const [saving, setSaving] = useState(false);
  const [updateSaving, setUpdateSaving] = useState(false);
  const [editingClassId, setEditingClassId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editStudentProfileId, setEditStudentProfileId] = useState(data.students[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);

  const beginEdit = (row: (typeof data.classes)[number]) => {
    setEditingClassId(row.id);
    setEditTitle(row.title);
    setEditDescription(row.description ?? "");
    setEditStudentProfileId(row.studentProfileId ?? data.students[0]?.id ?? "");
    setUpdateError(null);
  };

  const cancelEdit = () => {
    setEditingClassId(null);
    setEditTitle("");
    setEditDescription("");
    setEditStudentProfileId(data.students[0]?.id ?? "");
    setUpdateError(null);
  };

  const submitClass = async () => {
    if (!title.trim()) {
      setError("Class title is required.");
      return;
    }

    if (!studentProfileId) {
      setError("Select a student for this class.");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await createClassRecord({
        data: {
          title: title.trim(),
          description: description.trim() || undefined,
          studentProfileId,
        },
      });

      setTitle("");
      setDescription("");
      setStudentProfileId(data.students[0]?.id ?? "");
      await router.invalidate();
    } catch {
      setError("Unable to create class right now.");
    } finally {
      setSaving(false);
    }
  };

  const submitUpdate = async () => {
    if (!editingClassId) {
      return;
    }

    if (!editTitle.trim()) {
      setUpdateError("Class title is required.");
      return;
    }

    if (!editStudentProfileId) {
      setUpdateError("Select a student for this class.");
      return;
    }

    setUpdateSaving(true);
    setUpdateError(null);

    try {
      await updateClassRecord({
        data: {
          classId: editingClassId,
          title: editTitle.trim(),
          description: editDescription.trim() || undefined,
          studentProfileId: editStudentProfileId,
        },
      });

      cancelEdit();
      await router.invalidate();
    } catch {
      setUpdateError("Unable to update class right now.");
    } finally {
      setUpdateSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
        <p className="text-xs uppercase tracking-[0.2em] text-cyan-700">Class Engine</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">Create and Manage Classes</h1>
        <p className="mt-2 text-sm text-slate-600">
          Admins can define class spaces before curriculum assignments are published.
        </p>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">New Class</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="space-y-2 md:col-span-2">
            <span className="text-sm font-medium text-slate-700">Title</span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
              placeholder="Foundations of Biology"
            />
          </label>

          <label className="space-y-2 md:col-span-2">
            <span className="text-sm font-medium text-slate-700">Description</span>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              className="min-h-24 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
              placeholder="Topics, pacing notes, and expectations"
            />
          </label>

          <label className="space-y-2 md:col-span-2">
            <span className="text-sm font-medium text-slate-700">Assigned Student</span>
            <select
              value={studentProfileId}
              onChange={(event) => setStudentProfileId(event.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
            >
              {data.students.map((student) => (
                <option key={student.id} value={student.id}>
                  {student.gradeLevel
                    ? `${student.displayName} (Grade ${student.gradeLevel})`
                    : student.displayName}
                </option>
              ))}
            </select>
          </label>
        </div>

        {error ? <p className="mt-3 text-sm text-rose-700">{error}</p> : null}

        <button
          onClick={() => {
            void submitClass();
          }}
          disabled={saving}
          className="mt-4 rounded-xl bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? "Saving..." : "Create Class"}
        </button>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">Current Classes</h2>
        <div className="mt-4 space-y-3">
          {data.classes.map((row) => (
            <article key={row.id} className="rounded-xl border border-slate-200 p-4">
              {editingClassId === row.id ? (
                <div className="space-y-3">
                  <label className="space-y-2 block">
                    <span className="text-sm font-medium text-slate-700">Title</span>
                    <input
                      value={editTitle}
                      onChange={(event) => setEditTitle(event.target.value)}
                      className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                    />
                  </label>

                  <label className="space-y-2 block">
                    <span className="text-sm font-medium text-slate-700">Description</span>
                    <textarea
                      value={editDescription}
                      onChange={(event) => setEditDescription(event.target.value)}
                      className="min-h-24 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                    />
                  </label>

                  <label className="space-y-2 block">
                    <span className="text-sm font-medium text-slate-700">Assigned Student</span>
                    <select
                      value={editStudentProfileId}
                      onChange={(event) => setEditStudentProfileId(event.target.value)}
                      className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                    >
                      {data.students.map((student) => (
                        <option key={student.id} value={student.id}>
                          {student.gradeLevel
                            ? `${student.displayName} (Grade ${student.gradeLevel})`
                            : student.displayName}
                        </option>
                      ))}
                    </select>
                  </label>

                  {updateError ? <p className="text-sm text-rose-700">{updateError}</p> : null}

                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => {
                        void submitUpdate();
                      }}
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
                    <h3 className="font-semibold text-slate-900">{row.title}</h3>
                    <button
                      onClick={() => beginEdit(row)}
                      className="rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
                    >
                      Edit
                    </button>
                  </div>
                  <p className="mt-1 text-sm text-slate-600">
                    {row.description ?? "No description provided yet."}
                  </p>
                  <p className="mt-1 text-sm text-slate-600">
                    Assigned to:{" "}
                    <span className="font-medium text-slate-800">
                      {row.studentProfile?.gradeLevel
                        ? `${row.studentProfile.displayName} (Grade ${row.studentProfile.gradeLevel})`
                        : row.studentProfile?.displayName ?? "Unassigned"}
                    </span>
                  </p>
                </>
              )}
            </article>
          ))}

          {data.classes.length === 0 ? (
            <p className="text-sm text-slate-500">No classes created yet.</p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
