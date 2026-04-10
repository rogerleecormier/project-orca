import { useMemo, useState } from "react";
import { Link, createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import {
  createAssignmentFromTemplate,
  deleteAssignmentTemplate,
  duplicateTemplateToMine,
  getTemplateManagerData,
  getViewerContext,
  updateAssignmentTemplate,
} from "../server/functions";
import { ParentPageHeader } from "../components/parent-page-header";
import { RichContent } from "../components/rich-content";

export const Route = createFileRoute("/templates")({
  loader: async () => {
    const viewer = await getViewerContext();

    if (!viewer.isAuthenticated) {
      throw redirect({ to: "/login" });
    }

    if (viewer.activeRole === "student") {
      throw redirect({ to: "/student" });
    }

    return getTemplateManagerData();
  },
  component: TemplateManagerPage,
});

type TemplateRow = Awaited<ReturnType<typeof getTemplateManagerData>>["templates"][number];
type TemplateType = TemplateRow["contentType"];

type ScopeFilter = "all" | "mine" | "public";

const TYPE_LABELS: Record<string, string> = {
  text: "Reading",
  file: "File",
  url: "Link",
  video: "Video",
  quiz: "Quiz",
  essay_questions: "Essay",
  report: "Report",
};

function getTemplateTagValues(template: { tags: string[] }, prefix: string) {
  return template.tags
    .filter((tag) => tag.startsWith(`${prefix}:`))
    .map((tag) => tag.slice(prefix.length + 1))
    .filter(Boolean);
}

function getTemplatePrimarySubject(template: { tags: string[] }) {
  return getTemplateTagValues(template, "subject")[0] ?? "custom";
}

function titleCaseLabel(value: string) {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function parseJson<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

type QuizQuestionPreview = {
  question: string;
  options: string[];
  answerIndex: number;
  explanation?: string;
};

type QuizPayloadPreview = {
  title?: string;
  questions?: QuizQuestionPreview[];
};

type EssayPayloadPreview = {
  questions?: string[];
};

function TemplateManagerPage() {
  const data = Route.useLoaderData();
  const router = useRouter();

  const [scope, setScope] = useState<ScopeFilter>("all");
  const [subjectFilter, setSubjectFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState<TemplateType | "all">("all");
  const [search, setSearch] = useState("");

  const [classId, setClassId] = useState(data.classes[0]?.id ?? "");
  const [dueAtLocal, setDueAtLocal] = useState("");

  const [workingTemplateId, setWorkingTemplateId] = useState<string | null>(null);
  const [bulkWorking, setBulkWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedTemplateIds, setSelectedTemplateIds] = useState<Set<string>>(new Set());
  const [previewTarget, setPreviewTarget] = useState<TemplateRow | null>(null);

  const [editTarget, setEditTarget] = useState<TemplateRow | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editType, setEditType] = useState<TemplateType>("text");
  const [editContentRef, setEditContentRef] = useState("");
  const [editTagsCsv, setEditTagsCsv] = useState("");

  const subjectOptions = useMemo(
    () =>
      Array.from(new Set(data.templates.map((template) => getTemplatePrimarySubject(template))))
        .sort((a, b) => a.localeCompare(b)),
    [data.templates],
  );

  const filteredTemplates = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return data.templates.filter((template) => {
      if (scope !== "all" && template.scope !== scope) {
        return false;
      }
      if (subjectFilter !== "all" && getTemplatePrimarySubject(template) !== subjectFilter) {
        return false;
      }
      if (typeFilter !== "all" && template.contentType !== typeFilter) {
        return false;
      }
      if (!normalizedSearch) {
        return true;
      }

      const haystack = [
        template.title,
        template.description ?? "",
        template.tags.join(" "),
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(normalizedSearch);
    });
  }, [data.templates, scope, subjectFilter, typeFilter, search]);

  const parseTagsCsv = (value: string) =>
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

  const selectedTemplates = filteredTemplates.filter((template) => selectedTemplateIds.has(template.id));
  const selectedPublicTemplates = selectedTemplates.filter((template) => template.scope === "public");
  const selectedMineTemplates = selectedTemplates.filter((template) => template.scope === "mine");

  const toggleTemplateSelection = (templateId: string) => {
    setSelectedTemplateIds((prev) => {
      const next = new Set(prev);
      if (next.has(templateId)) {
        next.delete(templateId);
      } else {
        next.add(templateId);
      }
      return next;
    });
  };

  const toggleSelectAllVisible = () => {
    const allVisibleSelected = filteredTemplates.length > 0
      && filteredTemplates.every((template) => selectedTemplateIds.has(template.id));

    setSelectedTemplateIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const template of filteredTemplates) {
          next.delete(template.id);
        }
      } else {
        for (const template of filteredTemplates) {
          next.add(template.id);
        }
      }
      return next;
    });
  };

  const openEditModal = (template: TemplateRow) => {
    setEditTarget(template);
    setEditTitle(template.title);
    setEditDescription(template.description ?? "");
    setEditType(template.contentType);
    setEditContentRef(template.contentRef ?? "");
    setEditTagsCsv(template.tags.join(", "));
    setError(null);
  };

  const handleUseTemplate = async (templateId: string) => {
    if (!classId) {
      setError("Choose a class before creating an assignment.");
      return;
    }

    setWorkingTemplateId(templateId);
    setError(null);
    setMessage(null);
    try {
      const created = await createAssignmentFromTemplate({
        data: {
          templateId,
          classId,
          dueAt: dueAtLocal ? new Date(dueAtLocal).toISOString() : undefined,
        },
      });
      const targetHash = `assignment-${created.assignmentId}`;
      setMessage("Assignment created from template.");
      window.location.assign(`/assignments#${targetHash}`);
    } catch {
      setError("Could not create assignment from that template.");
    } finally {
      setWorkingTemplateId(null);
    }
  };

  const handleDuplicateTemplate = async (templateId: string) => {
    setWorkingTemplateId(templateId);
    setError(null);
    setMessage(null);
    try {
      await duplicateTemplateToMine({ data: { templateId } });
      await router.invalidate();
      setMessage("Template copied to My Templates.");
    } catch {
      setError("Could not duplicate template.");
    } finally {
      setWorkingTemplateId(null);
    }
  };

  const handleDeleteTemplate = async (template: TemplateRow) => {
    if (!window.confirm(`Delete template \"${template.title}\"?`)) {
      return;
    }

    setWorkingTemplateId(template.id);
    setError(null);
    setMessage(null);
    try {
      await deleteAssignmentTemplate({ data: { templateId: template.id } });
      await router.invalidate();
      setMessage("Template deleted.");
    } catch {
      setError("Could not delete template.");
    } finally {
      setWorkingTemplateId(null);
    }
  };

  const handleSaveEdit = async () => {
    if (!editTarget) {
      return;
    }

    setWorkingTemplateId(editTarget.id);
    setError(null);
    setMessage(null);
    try {
      await updateAssignmentTemplate({
        data: {
          templateId: editTarget.id,
          title: editTitle,
          description: editDescription,
          contentType: editType,
          contentRef: editContentRef,
          tags: parseTagsCsv(editTagsCsv),
        },
      });
      setEditTarget(null);
      await router.invalidate();
      setMessage("Template updated.");
    } catch {
      setError("Could not update template.");
    } finally {
      setWorkingTemplateId(null);
    }
  };

  const handleBulkDuplicatePublic = async () => {
    if (selectedPublicTemplates.length === 0) {
      return;
    }

    setBulkWorking(true);
    setError(null);
    setMessage(null);

    let failed = 0;
    for (const template of selectedPublicTemplates) {
      try {
        await duplicateTemplateToMine({ data: { templateId: template.id } });
      } catch {
        failed += 1;
      }
    }

    await router.invalidate();
    setBulkWorking(false);
    setSelectedTemplateIds(new Set());

    if (failed > 0) {
      setError(`${failed} template${failed === 1 ? "" : "s"} could not be duplicated.`);
    } else {
      setMessage(`Copied ${selectedPublicTemplates.length} public template${selectedPublicTemplates.length === 1 ? "" : "s"} to My Templates.`);
    }
  };

  const handleBulkDeleteMine = async () => {
    if (selectedMineTemplates.length === 0) {
      return;
    }

    if (!window.confirm(`Delete ${selectedMineTemplates.length} selected template${selectedMineTemplates.length === 1 ? "" : "s"}?`)) {
      return;
    }

    setBulkWorking(true);
    setError(null);
    setMessage(null);

    let failed = 0;
    for (const template of selectedMineTemplates) {
      try {
        await deleteAssignmentTemplate({ data: { templateId: template.id } });
      } catch {
        failed += 1;
      }
    }

    await router.invalidate();
    setBulkWorking(false);
    setSelectedTemplateIds(new Set());

    if (failed > 0) {
      setError(`${failed} template${failed === 1 ? "" : "s"} could not be deleted.`);
    } else {
      setMessage(`Deleted ${selectedMineTemplates.length} template${selectedMineTemplates.length === 1 ? "" : "s"}.`);
    }
  };

  return (
    <div className="space-y-6">
      <ParentPageHeader
        eyebrow="Template Manager"
        title="Assignment Templates"
        description="Save your best assignment setups once, then spin up polished new assignments in one click."
        action={(
          <Link
            to="/assignments"
            className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            Back to Assignments
          </Link>
        )}
      />

      <section className="rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
        <div className="mt-5 grid gap-3 md:grid-cols-3">
          <label className="block space-y-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">Target class</span>
            <select
              value={classId}
              onChange={(event) => setClassId(event.target.value)}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800"
            >
              {data.classes.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.title}
                </option>
              ))}
            </select>
          </label>

          <label className="block space-y-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">Default due date</span>
            <input
              type="datetime-local"
              value={dueAtLocal}
              onChange={(event) => setDueAtLocal(event.target.value)}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800"
            />
          </label>

          <label className="block space-y-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">Search</span>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Title, topic, or tag"
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800"
            />
          </label>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <label className="block space-y-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">Scope</span>
            <select
              value={scope}
              onChange={(event) => setScope(event.target.value as ScopeFilter)}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800"
            >
              <option value="all">All templates</option>
              <option value="mine">My templates</option>
              <option value="public">Public templates</option>
            </select>
          </label>

          <label className="block space-y-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">Subject</span>
            <select
              value={subjectFilter}
              onChange={(event) => setSubjectFilter(event.target.value)}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800"
            >
              <option value="all">All subjects</option>
              {subjectOptions.map((subject) => (
                <option key={subject} value={subject}>
                  {titleCaseLabel(subject)}
                </option>
              ))}
            </select>
          </label>

          <label className="block space-y-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">Type</span>
            <select
              value={typeFilter}
              onChange={(event) => setTypeFilter(event.target.value as TemplateType | "all")}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800"
            >
              <option value="all">All types</option>
              {Object.entries(TYPE_LABELS).map(([type, label]) => (
                <option key={type} value={type}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {message ? <p className="mt-4 text-sm font-medium text-emerald-700">{message}</p> : null}
        {error ? <p className="mt-2 text-sm font-medium text-rose-700">{error}</p> : null}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-slate-900">Templates</h2>
          <p className="text-xs text-slate-500">{filteredTemplates.length} shown</p>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={bulkWorking || filteredTemplates.length === 0}
            onClick={toggleSelectAllVisible}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
          >
            {filteredTemplates.length > 0 && filteredTemplates.every((template) => selectedTemplateIds.has(template.id))
              ? "Clear Visible"
              : "Select Visible"}
          </button>
          <button
            type="button"
            disabled={bulkWorking || selectedPublicTemplates.length === 0}
            onClick={() => void handleBulkDuplicatePublic()}
            className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-60"
          >
            {bulkWorking ? "Working..." : `Duplicate Public (${selectedPublicTemplates.length})`}
          </button>
          <button
            type="button"
            disabled={bulkWorking || selectedMineTemplates.length === 0}
            onClick={() => void handleBulkDeleteMine()}
            className="rounded-lg border border-rose-200 bg-white px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-60"
          >
            {bulkWorking ? "Working..." : `Delete Mine (${selectedMineTemplates.length})`}
          </button>
          {selectedTemplates.length > 0 ? (
            <span className="text-xs text-slate-500">
              {selectedTemplates.length} selected
            </span>
          ) : null}
        </div>

        {filteredTemplates.length === 0 ? (
          <div className="mt-4 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">
            No templates match your filters.
          </div>
        ) : (
          <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {filteredTemplates.map((template) => {
              const topicTags = getTemplateTagValues(template, "topic").slice(0, 3);
              const gradeTags = getTemplateTagValues(template, "grade").slice(0, 3);
              const busy = workingTemplateId === template.id;

              return (
                <article key={template.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="flex items-center justify-between gap-2">
                    <label className="inline-flex items-center gap-2 text-xs text-slate-600">
                      <input
                        type="checkbox"
                        checked={selectedTemplateIds.has(template.id)}
                        onChange={() => toggleTemplateSelection(template.id)}
                        className="h-4 w-4 rounded border-slate-300 text-cyan-600"
                      />
                      Select
                    </label>
                    <button
                      type="button"
                      onClick={() => setPreviewTarget(template)}
                      className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
                    >
                      Preview
                    </button>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
                      template.scope === "mine"
                        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                        : "border-slate-200 bg-slate-100 text-slate-700"
                    }`}>
                      {template.scope === "mine" ? "My Template" : "Public"}
                    </span>
                    <span className="inline-flex rounded-full border border-cyan-200 bg-cyan-50 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-cyan-700">
                      {TYPE_LABELS[template.contentType] ?? template.contentType}
                    </span>
                  </div>

                  <h3 className="mt-3 text-base font-semibold text-slate-900">{template.title}</h3>
                  <p className="mt-1 text-sm text-slate-600 line-clamp-3">
                    {template.description || "No description set."}
                  </p>

                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    {titleCaseLabel(getTemplatePrimarySubject(template)) ? (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                        {titleCaseLabel(getTemplatePrimarySubject(template))}
                      </span>
                    ) : null}
                    {topicTags.map((topic) => (
                      <span key={`${template.id}-${topic}`} className="rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-medium text-violet-700">
                        {titleCaseLabel(topic)}
                      </span>
                    ))}
                    {gradeTags.map((grade) => (
                      <span key={`${template.id}-${grade}`} className="rounded-full bg-cyan-50 px-2 py-0.5 text-[11px] font-medium text-cyan-700">
                        Grade {titleCaseLabel(grade)}
                      </span>
                    ))}
                  </div>

                  <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busy || !classId}
                      onClick={() => void handleUseTemplate(template.id)}
                      className="rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-cyan-700 disabled:opacity-60"
                    >
                      {busy ? "Working..." : "Use Template"}
                    </button>

                    {template.scope === "public" ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleDuplicateTemplate(template.id)}
                        className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-60"
                      >
                        Save to Mine
                      </button>
                    ) : null}

                    {template.scope === "mine" ? (
                      <>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => openEditModal(template)}
                          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleDeleteTemplate(template)}
                          className="rounded-lg border border-rose-200 bg-white px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-60"
                        >
                          Delete
                        </button>
                      </>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {editTarget ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
          <div className="w-full max-w-2xl rounded-2xl border border-slate-200 bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
              <h3 className="text-lg font-semibold text-slate-900">Edit Template</h3>
              <button
                type="button"
                onClick={() => setEditTarget(null)}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
              >
                Close
              </button>
            </div>

            <div className="space-y-4 px-6 py-5">
              <label className="block space-y-1">
                <span className="text-sm font-medium text-slate-700">Title</span>
                <input
                  value={editTitle}
                  onChange={(event) => setEditTitle(event.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                />
              </label>

              <label className="block space-y-1">
                <span className="text-sm font-medium text-slate-700">Description</span>
                <textarea
                  value={editDescription}
                  onChange={(event) => setEditDescription(event.target.value)}
                  className="min-h-20 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                />
              </label>

              <label className="block space-y-1">
                <span className="text-sm font-medium text-slate-700">Type</span>
                <select
                  value={editType}
                  onChange={(event) => setEditType(event.target.value as TemplateType)}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                >
                  {Object.entries(TYPE_LABELS).map(([type, label]) => (
                    <option key={type} value={type}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block space-y-1">
                <span className="text-sm font-medium text-slate-700">Content Reference</span>
                <textarea
                  value={editContentRef}
                  onChange={(event) => setEditContentRef(event.target.value)}
                  className="min-h-28 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                  placeholder="URL, rich text, JSON payload, or file asset key"
                />
              </label>

              <label className="block space-y-1">
                <span className="text-sm font-medium text-slate-700">Tags (comma-separated)</span>
                <input
                  value={editTagsCsv}
                  onChange={(event) => setEditTagsCsv(event.target.value)}
                  placeholder="subject:science, grade:6, topic:cells"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                />
              </label>
            </div>

            <div className="flex justify-end gap-2 border-t border-slate-200 px-6 py-4">
              <button
                type="button"
                onClick={() => setEditTarget(null)}
                className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={workingTemplateId === editTarget.id || !editTitle.trim()}
                onClick={() => void handleSaveEdit()}
                className="rounded-xl bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-60"
              >
                {workingTemplateId === editTarget.id ? "Saving..." : "Save Changes"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {previewTarget ? (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40 backdrop-blur-sm">
          <button
            type="button"
            className="flex-1"
            aria-label="Close preview"
            onClick={() => setPreviewTarget(null)}
          />
          <aside className="h-full w-full max-w-2xl overflow-y-auto border-l border-slate-200 bg-white p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-wide text-cyan-700">Template Preview</p>
                <h3 className="mt-1 text-xl font-semibold text-slate-900">{previewTarget.title}</h3>
              </div>
              <button
                type="button"
                onClick={() => setPreviewTarget(null)}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
              >
                Close
              </button>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <span className="inline-flex rounded-full border border-cyan-200 bg-cyan-50 px-2.5 py-1 text-xs font-semibold text-cyan-700">
                {TYPE_LABELS[previewTarget.contentType] ?? previewTarget.contentType}
              </span>
              <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${
                previewTarget.scope === "mine"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                  : "border-slate-200 bg-slate-100 text-slate-700"
              }`}>
                {previewTarget.scope === "mine" ? "My Template" : "Public Template"}
              </span>
            </div>

            {previewTarget.description ? (
              <p className="mt-4 text-sm text-slate-700">{previewTarget.description}</p>
            ) : null}

            <div className="mt-4 flex flex-wrap gap-1.5">
              {previewTarget.tags.map((tag) => (
                <span key={`${previewTarget.id}-${tag}`} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                  {tag}
                </span>
              ))}
            </div>

            <div className="mt-6 space-y-3">
              <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-700">Content</h4>
              {previewTarget.contentType === "text" || previewTarget.contentType === "report" ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-800">
                  {previewTarget.contentRef ? <RichContent html={previewTarget.contentRef} /> : <p>No content.</p>}
                </div>
              ) : null}
              {previewTarget.contentType === "url" ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-800">
                  {previewTarget.contentRef ? (
                    <a href={previewTarget.contentRef} target="_blank" rel="noreferrer" className="text-cyan-700 hover:underline">
                      {previewTarget.contentRef}
                    </a>
                  ) : (
                    <p>No URL set.</p>
                  )}
                </div>
              ) : null}
              {previewTarget.contentType === "quiz" ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-800">
                  {(() => {
                    const payload = parseJson<QuizPayloadPreview>(previewTarget.contentRef);
                    const questions = payload?.questions ?? [];
                    if (questions.length === 0) return <p>No quiz questions found.</p>;
                    return (
                      <div className="space-y-4">
                        {questions.map((question, index) => (
                          <div key={`${previewTarget.id}-q-${index}`} className="space-y-1">
                            <p className="font-medium text-slate-900">{index + 1}. {question.question}</p>
                            <ul className="space-y-0.5">
                              {question.options.map((option, optionIndex) => (
                                <li key={`${previewTarget.id}-q-${index}-o-${optionIndex}`} className={optionIndex === question.answerIndex ? "text-emerald-700" : "text-slate-700"}>
                                  {optionIndex === question.answerIndex ? "Correct: " : ""}{option}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              ) : null}
              {previewTarget.contentType === "essay_questions" ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-800">
                  {(() => {
                    const payload = parseJson<EssayPayloadPreview>(previewTarget.contentRef);
                    const questions = payload?.questions ?? [];
                    if (questions.length === 0) return <p>No questions found.</p>;
                    return (
                      <ol className="space-y-1">
                        {questions.map((question, index) => (
                          <li key={`${previewTarget.id}-essay-${index}`}>
                            {index + 1}. {question}
                          </li>
                        ))}
                      </ol>
                    );
                  })()}
                </div>
              ) : null}
              {previewTarget.contentType === "file" || previewTarget.contentType === "video" ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                  <p>This template uses structured content.</p>
                  <p className="mt-1 break-all text-xs text-slate-500">{previewTarget.contentRef ?? "No content reference set."}</p>
                </div>
              ) : null}
            </div>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
