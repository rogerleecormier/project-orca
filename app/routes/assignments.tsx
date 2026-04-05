import { useMemo, useState } from "react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import {
  createAssignmentRecord,
  generateQuizDraftForCurriculum,
  getViewerContext,
  getCurriculumBuilderData,
} from "../server/functions";

export const Route = createFileRoute("/assignments")({
  loader: async () => {
    const viewer = await getViewerContext();

    if (!viewer.isAuthenticated) {
      throw redirect({ to: "/login" });
    }

    if (viewer.activeRole === "student") {
      throw redirect({ to: "/student" });
    }

    return getCurriculumBuilderData();
  },
  component: CurriculumBuilderPage,
});

function CurriculumBuilderPage() {
  const router = useRouter();
  const data = Route.useLoaderData();

  const [classId, setClassId] = useState(data.classes[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [contentType, setContentType] = useState<"text" | "file" | "url">("text");
  const [contentRef, setContentRef] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [quizTopic, setQuizTopic] = useState("");
  const [quizDraft, setQuizDraft] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const classTitle = useMemo(() => {
    const current = data.classes.find((row) => row.id === classId);
    return current?.title ?? "Select class";
  }, [classId, data.classes]);

  const submitAssignment = async () => {
    if (!classId || !title.trim()) {
      setError("Class and assignment title are required.");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await createAssignmentRecord({
        data: {
          classId,
          title: title.trim(),
          description: description.trim() || undefined,
          contentType,
          contentRef: contentRef.trim() || undefined,
          dueAt: dueAt || undefined,
        },
      });

      setTitle("");
      setDescription("");
      setContentRef("");
      setDueAt("");
      await router.invalidate();
    } catch {
      setError("Unable to save assignment right now.");
    } finally {
      setSaving(false);
    }
  };

  const generateDraft = async () => {
    if (!quizTopic.trim()) {
      setError("Enter a topic to generate a quiz draft.");
      return;
    }

    setDrafting(true);
    setError(null);

    try {
      const result = await generateQuizDraftForCurriculum({
        data: {
          topic: quizTopic.trim(),
          questionCount: 5,
        },
      });

      setQuizDraft(JSON.stringify(result.quiz, null, 2));
    } catch {
      setError("Quiz draft generation failed.");
    } finally {
      setDrafting(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
        <p className="text-xs uppercase tracking-[0.2em] text-cyan-700">Curriculum Builder</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">Assignments for {classTitle}</h1>
        <p className="mt-2 text-sm text-slate-600">
          Parents can author assignments with text, file references, or external learning URLs.
        </p>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">New Assignment</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="space-y-2">
            <span className="text-sm font-medium text-slate-700">Class</span>
            <select
              value={classId}
              onChange={(event) => setClassId(event.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
            >
              {data.classes.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.title}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-2">
            <span className="text-sm font-medium text-slate-700">Content Type</span>
            <select
              value={contentType}
              onChange={(event) => setContentType(event.target.value as "text" | "file" | "url")}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
            >
              <option value="text">Text</option>
              <option value="file">File</option>
              <option value="url">URL</option>
            </select>
          </label>

          <label className="space-y-2 md:col-span-2">
            <span className="text-sm font-medium text-slate-700">Title</span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
              placeholder="Chapter 4 Reflection"
            />
          </label>

          <label className="space-y-2 md:col-span-2">
            <span className="text-sm font-medium text-slate-700">Description</span>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              className="min-h-24 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
            />
          </label>

          <label className="space-y-2 md:col-span-2">
            <span className="text-sm font-medium text-slate-700">Content Reference</span>
            <input
              value={contentRef}
              onChange={(event) => setContentRef(event.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
              placeholder="Paste text summary, file key, or URL"
            />
          </label>

          <label className="space-y-2">
            <span className="text-sm font-medium text-slate-700">Due Date</span>
            <input
              type="datetime-local"
              value={dueAt}
              onChange={(event) => setDueAt(event.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
            />
          </label>
        </div>

        {error ? <p className="mt-3 text-sm text-rose-700">{error}</p> : null}

        <button
          disabled={saving || data.classes.length === 0}
          onClick={() => {
            void submitAssignment();
          }}
          className="mt-4 rounded-xl bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? "Saving..." : "Create Assignment"}
        </button>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">AI Quiz Generator</h2>
        <p className="mt-2 text-sm text-slate-600">
          Generate a quick multiple-choice quiz draft using Workers AI.
        </p>

        <div className="mt-4 flex flex-col gap-3 md:flex-row">
          <input
            value={quizTopic}
            onChange={(event) => setQuizTopic(event.target.value)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
            placeholder="Topic: Photosynthesis"
          />
          <button
            disabled={drafting}
            onClick={() => {
              void generateDraft();
            }}
            className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {drafting ? "Generating..." : "Generate Quiz Draft"}
          </button>
        </div>

        {quizDraft ? (
          <pre className="mt-4 overflow-auto rounded-xl bg-slate-100 p-4 text-xs text-slate-800">
            {quizDraft}
          </pre>
        ) : null}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">Published Assignments</h2>
        <div className="mt-4 space-y-3">
          {data.assignments.map((row) => (
            <article key={row.id} className="rounded-xl border border-slate-200 p-4">
              <p className="text-xs uppercase tracking-wide text-slate-500">{row.contentType}</p>
              <h3 className="mt-1 font-semibold text-slate-900">{row.title}</h3>
              <p className="mt-1 text-sm text-slate-600">{row.description ?? "No description"}</p>
            </article>
          ))}
          {data.assignments.length === 0 ? (
            <p className="text-sm text-slate-500">No assignments published yet.</p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
