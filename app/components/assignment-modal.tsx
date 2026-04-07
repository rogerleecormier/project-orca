/**
 * Shared AssignmentModal — used in both the Assignments page and the Skill Tree node panel.
 *
 * Modes:
 *   view       — read-only render of all content, with an "Edit" button for parents
 *   quick-edit — title, description (RTE), due date, linked assignment; "Advanced Edit" button
 *   edit       — full form (all fields, all type-specific content editors)
 */
import { useState } from "react";
import { RichContent } from "./rich-content";
import { RichTextEditor } from "./rich-text-editor";
import { QuizBuilder, type QuizQuestion } from "./quiz-builder";
import { updateAssignmentRecord, uploadAssignmentFile } from "../server/functions";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ModalAssignment = {
  id: string;
  title: string;
  description: string | null;
  contentType: string;
  contentRef: string | null;
  dueAt: string | null;
  linkedAssignmentId: string | null;
  classId?: string | null;
};

type Mode = "view" | "quick-edit" | "edit";

type Props = {
  assignment: ModalAssignment;
  allAssignments?: ModalAssignment[];
  /** If false, Edit buttons are hidden and the modal is always read-only */
  canEdit?: boolean;
  onClose: () => void;
  /** Called after a successful save — receives the updated assignment */
  onSaved?: (updated: ModalAssignment) => void;
  /** Called when Delete is clicked (parent handles confirmation + deletion) */
  onRequestDelete?: (assignment: ModalAssignment) => void;
};

// ── Constants ─────────────────────────────────────────────────────────────────

export const ASSIGNMENT_TYPE_LABELS: Record<string, string> = {
  text:            "Reading",
  file:            "File",
  url:             "Link",
  video:           "Video Lesson",
  quiz:            "Quiz",
  essay_questions: "Essay Questions",
  report:          "Report / Lab",
  movie:           "Movie",
};

const TYPE_BADGE: Record<string, string> = {
  video:           "bg-cyan-50   text-cyan-800   border-cyan-200",
  quiz:            "bg-violet-50 text-violet-800 border-violet-200",
  text:            "bg-emerald-50 text-emerald-800 border-emerald-200",
  file:            "bg-amber-50  text-amber-800  border-amber-200",
  url:             "bg-sky-50    text-sky-800    border-sky-200",
  essay_questions: "bg-rose-50   text-rose-800   border-rose-200",
  report:          "bg-indigo-50 text-indigo-800 border-indigo-200",
  movie:           "bg-violet-50 text-violet-800 border-violet-200",
};

const KNOWN_PLATFORMS = [
  "Netflix", "Disney+", "Amazon Prime Video", "HBO Max", "Max",
  "Hulu", "Apple TV+", "Peacock", "Paramount+", "Tubi", "YouTube",
] as const;

const PLATFORM_COLORS: Record<string, string> = {
  "Netflix":             "bg-red-100 text-red-700",
  "Disney+":             "bg-blue-100 text-blue-700",
  "Amazon Prime Video":  "bg-cyan-100 text-cyan-700",
  "HBO Max":             "bg-purple-100 text-purple-700",
  "Max":                 "bg-purple-100 text-purple-700",
  "Hulu":                "bg-green-100 text-green-700",
  "Apple TV+":           "bg-slate-100 text-slate-700",
  "YouTube":             "bg-rose-100 text-rose-700",
  "Peacock":             "bg-violet-100 text-violet-700",
  "Paramount+":          "bg-sky-100 text-sky-700",
  "Tubi":                "bg-orange-100 text-orange-700",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseJson<T>(s: string | null | undefined): T | null {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}

function buildDueAt(date: string, time: string, includeTime: boolean): string | null {
  if (!date) return null;
  if (includeTime && time) return new Date(`${date}T${time}`).toISOString();
  return new Date(date).toISOString();
}

function parseDueAt(dueAt: string | null) {
  if (!dueAt) return { dueDate: "", dueTime: "16:00", includeTime: false };
  const d = new Date(dueAt);
  const dueDate = d.toISOString().slice(0, 10);
  const hours = d.getHours().toString().padStart(2, "0");
  const mins = d.getMinutes().toString().padStart(2, "0");
  const dueTime = `${hours}:${mins}`;
  const includeTime = dueTime !== "00:00" && dueTime !== "16:00";
  return { dueDate, dueTime, includeTime };
}

async function uploadImage(file: File) {
  const reader = new FileReader();
  const base64 = await new Promise<string>((res, rej) => {
    reader.onerror = rej;
    reader.onload = () => {
      const r = String(reader.result ?? "");
      const i = r.indexOf(",");
      res(i >= 0 ? r.slice(i + 1) : r);
    };
    reader.readAsDataURL(file);
  });
  const { key } = await uploadAssignmentFile({ data: { filename: file.name, mimeType: file.type || "application/octet-stream", base64 } });
  return { key };
}

// ── View: content renderer ────────────────────────────────────────────────────

function AssignmentContentView({ assignment, allAssignments }: { assignment: ModalAssignment; allAssignments: ModalAssignment[] }) {
  const ref = assignment.contentRef;
  const type = assignment.contentType;

  if (type === "text" || type === "report") {
    if (!ref) return <p className="text-xs text-slate-400">No content yet.</p>;
    return <RichContent html={ref} className="text-sm" />;
  }

  if (type === "video") {
    const payload = parseJson<{ videos?: Array<{ title: string; channel?: string; videoId: string }> }>(ref);
    const videos = payload?.videos ?? [];
    if (!videos.length) return <p className="text-xs text-slate-400">No video linked.</p>;
    return (
      <div className="space-y-2">
        {videos.map((v, i) => (
          <div key={i} className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-3">
            <p className="text-sm font-medium text-slate-800">{v.title}</p>
            {v.channel ? <p className="text-xs text-slate-500 mt-0.5">{v.channel}</p> : null}
          </div>
        ))}
      </div>
    );
  }

  if (type === "quiz") {
    const payload = parseJson<{ title?: string; questions?: QuizQuestion[] }>(ref);
    const questions = payload?.questions ?? [];
    if (!questions.length) return <p className="text-xs text-slate-400">No questions yet.</p>;
    return (
      <div className="space-y-3">
        {questions.map((q, i) => (
          <div key={i} className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-3">
            <p className="text-xs font-semibold text-slate-700 mb-2">{i + 1}. {q.question}</p>
            <div className="space-y-1">
              {q.options.map((opt, oi) => (
                <div key={oi} className={`flex items-center gap-2 rounded-lg px-2 py-1 text-xs ${oi === q.answerIndex ? "bg-emerald-50 text-emerald-700 font-medium" : "text-slate-600"}`}>
                  <span className="shrink-0 w-4 h-4 rounded-full border border-current flex items-center justify-center text-[9px] font-bold">
                    {oi === q.answerIndex ? "✓" : String.fromCharCode(65 + oi)}
                  </span>
                  {opt}
                </div>
              ))}
            </div>
            {q.explanation ? <p className="mt-2 text-[11px] text-slate-500 italic">{q.explanation}</p> : null}
          </div>
        ))}
      </div>
    );
  }

  if (type === "essay_questions") {
    const payload = parseJson<{ questions?: string[] }>(ref);
    const questions = payload?.questions ?? [];
    if (!questions.length) return <p className="text-xs text-slate-400">No prompts yet.</p>;
    return (
      <div className="space-y-2">
        {questions.map((q, i) => (
          <div key={i} className="rounded-xl border border-violet-100 bg-violet-50 px-4 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-violet-400 mb-1">Prompt {i + 1}</p>
            <p className="text-sm text-slate-700">{q}</p>
          </div>
        ))}
      </div>
    );
  }

  if (type === "movie") {
    const payload = parseJson<{ title?: string; synopsis?: string; whereToWatch?: string[] }>(ref);
    const followUps = allAssignments.filter(a => a.linkedAssignmentId === assignment.id);
    return (
      <div className="space-y-3">
        {payload?.title ? <p className="text-base font-semibold text-slate-800">{payload.title}</p> : null}
        {payload?.synopsis ? <p className="text-sm text-slate-600">{payload.synopsis}</p> : null}
        {(payload?.whereToWatch ?? []).length > 0 ? (
          <div>
            <p className="mb-1.5 text-xs font-medium text-slate-500">Where to watch</p>
            <div className="flex flex-wrap gap-1.5">
              {(payload!.whereToWatch!).map(p => (
                <span key={p} className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${PLATFORM_COLORS[p] ?? "bg-slate-100 text-slate-700"}`}>{p}</span>
              ))}
            </div>
          </div>
        ) : null}
        {followUps.length > 0 ? (
          <div>
            <p className="mb-1.5 text-xs font-medium text-slate-500">Follow-up assignments</p>
            {followUps.map(f => (
              <div key={f.id} className="rounded-xl border border-indigo-100 bg-indigo-50 px-3 py-2">
                <p className="text-[10px] font-semibold text-indigo-400 mb-0.5">Follow-up</p>
                <p className="text-xs text-slate-700">{f.title}</p>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  if (type === "url") {
    return ref ? <a href={ref} target="_blank" rel="noopener noreferrer" className="text-sm text-cyan-600 underline break-all">{ref}</a> : null;
  }

  return ref ? <p className="text-sm text-slate-700 break-words">{ref}</p> : <p className="text-xs text-slate-400">No content.</p>;
}

// ── Main Modal ────────────────────────────────────────────────────────────────

export function AssignmentModal({
  assignment: initialAssignment,
  allAssignments = [],
  canEdit = true,
  onClose,
  onSaved,
  onRequestDelete,
}: Props) {
  const [mode, setMode] = useState<Mode>("view");
  const [assignment, setAssignment] = useState(initialAssignment);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // ── Edit/quick-edit shared fields ────────────────────────────────────────────
  const [title, setTitle] = useState(assignment.title);
  const [description, setDescription] = useState(assignment.description ?? "");
  const [contentRef, setContentRef] = useState(assignment.contentRef ?? "");
  const [linkedAssignmentId, setLinkedAssignmentId] = useState(assignment.linkedAssignmentId ?? "");
  const parsedDue = parseDueAt(assignment.dueAt);
  const [dueDate, setDueDate] = useState(parsedDue.dueDate);
  const [dueTime, setDueTime] = useState(parsedDue.dueTime);
  const [includeTime, setIncludeTime] = useState(parsedDue.includeTime);

  // Quiz
  const [quizTitle, setQuizTitle] = useState(() => parseJson<{ title?: string }>(assignment.contentRef)?.title ?? "");
  const [quizQuestions, setQuizQuestions] = useState<QuizQuestion[]>(() => {
    const p = parseJson<{ questions?: QuizQuestion[] }>(assignment.contentRef);
    return (p?.questions ?? []).map(q => ({ ...q, id: (q as QuizQuestion & { id?: string }).id ?? crypto.randomUUID() }));
  });

  // Essay
  const [essayQuestions, setEssayQuestions] = useState<string[]>(() => {
    const p = parseJson<{ questions?: string[] }>(assignment.contentRef);
    return p?.questions ?? [""];
  });

  // Movie
  const [movieTitle, setMovieTitle] = useState(() => parseJson<{ title?: string }>(assignment.contentRef)?.title ?? "");
  const [movieSynopsis, setMovieSynopsis] = useState(() => parseJson<{ synopsis?: string }>(assignment.contentRef)?.synopsis ?? "");
  const [moviePlatforms, setMoviePlatforms] = useState<string[]>(() => parseJson<{ whereToWatch?: string[] }>(assignment.contentRef)?.whereToWatch ?? []);
  const [movieCustomPlatform, setMovieCustomPlatform] = useState("");

  const typeLbl = ASSIGNMENT_TYPE_LABELS[assignment.contentType] ?? assignment.contentType;
  const typeBadge = TYPE_BADGE[assignment.contentType] ?? "bg-slate-50 text-slate-700 border-slate-200";

  const linkableCandidates = allAssignments.filter(a => a.id !== assignment.id);

  function buildContentRef(): string | undefined {
    const type = assignment.contentType;
    if (type === "quiz") return JSON.stringify({ title: quizTitle.trim() || title.trim(), questions: quizQuestions });
    if (type === "essay_questions") return JSON.stringify({ questions: essayQuestions.filter(q => q.trim()) });
    if (type === "movie") {
      const platforms = movieCustomPlatform.trim() ? [...moviePlatforms, movieCustomPlatform.trim()] : moviePlatforms;
      return JSON.stringify({ title: movieTitle.trim() || title.trim(), synopsis: movieSynopsis.trim(), whereToWatch: platforms });
    }
    return contentRef || undefined;
  }

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const dueAt = buildDueAt(dueDate, dueTime, includeTime);
      await updateAssignmentRecord({
        data: {
          assignmentId: assignment.id,
          title: title.trim(),
          description: description.trim() || undefined,
          contentRef: buildContentRef(),
          linkedAssignmentId: linkedAssignmentId || null,
          dueAt,
        },
      });
      const updated: ModalAssignment = {
        ...assignment,
        title: title.trim(),
        description: description.trim() || null,
        contentRef: buildContentRef() ?? null,
        linkedAssignmentId: linkedAssignmentId || null,
        dueAt,
      };
      setAssignment(updated);
      onSaved?.(updated);
      setMode("view");
    } catch {
      setSaveError("Could not save. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const isEditing = mode === "quick-edit" || mode === "edit";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="relative flex flex-col w-full max-w-2xl max-h-[92vh] rounded-2xl border border-slate-200 bg-white shadow-2xl overflow-hidden">

        {/* ── Header ── */}
        <div className="flex shrink-0 items-start gap-3 border-b border-slate-100 px-6 py-4">
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${typeBadge}`}>
                {typeLbl}
              </span>
              {assignment.dueAt ? (
                <span className="text-xs text-slate-400">
                  Due {new Date(assignment.dueAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                </span>
              ) : null}
              {/* Mode toggle pills */}
              {!isEditing ? (
                <div className="ml-auto flex items-center gap-1">
                  {canEdit ? (
                    <>
                      <button
                        type="button"
                        onClick={() => setMode("quick-edit")}
                        className="rounded-lg border border-slate-200 px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
                      >
                        Quick Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => setMode("edit")}
                        className="rounded-lg border border-cyan-200 bg-cyan-50 px-3 py-1 text-xs font-medium text-cyan-700 hover:bg-cyan-100"
                      >
                        Advanced Edit
                      </button>
                    </>
                  ) : null}
                </div>
              ) : (
                <div className="ml-auto flex items-center gap-1">
                  {mode === "quick-edit" ? (
                    <button
                      type="button"
                      onClick={() => setMode("edit")}
                      className="rounded-lg border border-cyan-200 bg-cyan-50 px-3 py-1 text-xs font-medium text-cyan-700 hover:bg-cyan-100"
                    >
                      Advanced Edit
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => { setMode("view"); setSaveError(null); }}
                    className="rounded-lg border border-slate-200 px-3 py-1 text-xs text-slate-500 hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void handleSave()}
                    className="rounded-lg bg-slate-900 px-3 py-1 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50"
                  >
                    {saving ? "Saving…" : "Save"}
                  </button>
                </div>
              )}
            </div>

            {isEditing ? (
              <input
                type="text"
                value={title}
                onChange={e => setTitle(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-base font-semibold text-slate-900 focus:border-cyan-500 focus:outline-none"
              />
            ) : (
              <h2 className="text-base font-semibold text-slate-900 leading-snug">{assignment.title}</h2>
            )}
          </div>

          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            ✕
          </button>
        </div>

        {/* ── Body ── */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          {saveError ? (
            <p className="rounded-xl bg-rose-50 border border-rose-200 px-3 py-2 text-xs text-rose-700">{saveError}</p>
          ) : null}

          {/* Description / instructions (always RTE when editing) */}
          {isEditing ? (
            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700">Assignment Instructions</label>
              <RichTextEditor
                value={description}
                onChange={setDescription}
                disabled={saving}
                placeholder="Instructions, context, or goals for this assignment…"
                documentName={title || assignment.title}
                onUploadImage={uploadImage}
              />
            </div>
          ) : assignment.description ? (
            <RichContent html={assignment.description} className="text-sm text-slate-600" />
          ) : null}

          {/* Quick-edit: due date + linked assignment, no content type editing */}
          {mode === "quick-edit" ? (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-sm font-medium text-slate-700">Due Date</label>
                <input
                  type="date"
                  value={dueDate}
                  onChange={e => setDueDate(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium text-slate-700">Linked Assignment</label>
                <select
                  value={linkedAssignmentId}
                  onChange={e => setLinkedAssignmentId(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                >
                  <option value="">— None —</option>
                  {linkableCandidates.map(a => (
                    <option key={a.id} value={a.id}>
                      {ASSIGNMENT_TYPE_LABELS[a.contentType] ?? a.contentType}: {a.title}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ) : null}

          {/* Full edit: all type-specific fields */}
          {mode === "edit" ? (
            <AssignmentFullEditFields
              assignment={assignment}
              contentRef={contentRef}
              quizTitle={quizTitle}
              quizQuestions={quizQuestions}
              essayQuestions={essayQuestions}
              movieTitle={movieTitle}
              movieSynopsis={movieSynopsis}
              moviePlatforms={moviePlatforms}
              movieCustomPlatform={movieCustomPlatform}
              linkedAssignmentId={linkedAssignmentId}
              dueDate={dueDate}
              dueTime={dueTime}
              includeTime={includeTime}
              saving={saving}
              allAssignments={allAssignments}
              onContentRefChange={setContentRef}
              onQuizTitleChange={setQuizTitle}
              onQuizQuestionsChange={setQuizQuestions}
              onEssayQuestionsChange={setEssayQuestions}
              onMovieTitleChange={setMovieTitle}
              onMovieSynopsisChange={setMovieSynopsis}
              onMoviePlatformsChange={setMoviePlatforms}
              onMovieCustomPlatformChange={setMovieCustomPlatform}
              onLinkedAssignmentChange={setLinkedAssignmentId}
              onDueDateChange={setDueDate}
              onDueTimeChange={setDueTime}
              onIncludeTimeChange={setIncludeTime}
            />
          ) : null}

          {/* View mode: render content */}
          {mode === "view" ? (
            <AssignmentContentView assignment={assignment} allAssignments={allAssignments} />
          ) : null}
        </div>

        {/* ── Footer (delete, only in advanced edit) ── */}
        {mode === "edit" && onRequestDelete ? (
          <div className="shrink-0 flex items-center justify-between border-t border-slate-100 px-6 py-3">
            <button
              type="button"
              onClick={() => onRequestDelete(assignment)}
              className="rounded-xl border border-rose-300 bg-white px-4 py-2 text-sm font-medium text-rose-700 hover:bg-rose-50"
            >
              Delete Assignment
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => { setMode("view"); setSaveError(null); }}
                className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving || !title.trim()}
                onClick={() => void handleSave()}
                className="rounded-xl bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-60"
              >
                {saving ? "Saving…" : "Save Changes"}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ── Full edit fields ──────────────────────────────────────────────────────────

function AssignmentFullEditFields({
  assignment,
  contentRef,
  quizTitle,
  quizQuestions,
  essayQuestions,
  movieTitle,
  movieSynopsis,
  moviePlatforms,
  movieCustomPlatform,
  linkedAssignmentId,
  dueDate,
  dueTime,
  includeTime,
  saving,
  allAssignments,
  onContentRefChange,
  onQuizTitleChange,
  onQuizQuestionsChange,
  onEssayQuestionsChange,
  onMovieTitleChange,
  onMovieSynopsisChange,
  onMoviePlatformsChange,
  onMovieCustomPlatformChange,
  onLinkedAssignmentChange,
  onDueDateChange,
  onDueTimeChange,
  onIncludeTimeChange,
}: {
  assignment: ModalAssignment;
  contentRef: string;
  quizTitle: string;
  quizQuestions: QuizQuestion[];
  essayQuestions: string[];
  movieTitle: string;
  movieSynopsis: string;
  moviePlatforms: string[];
  movieCustomPlatform: string;
  linkedAssignmentId: string;
  dueDate: string;
  dueTime: string;
  includeTime: boolean;
  saving: boolean;
  allAssignments: ModalAssignment[];
  onContentRefChange: (v: string) => void;
  onQuizTitleChange: (v: string) => void;
  onQuizQuestionsChange: (v: QuizQuestion[]) => void;
  onEssayQuestionsChange: (v: string[]) => void;
  onMovieTitleChange: (v: string) => void;
  onMovieSynopsisChange: (v: string) => void;
  onMoviePlatformsChange: (v: string[]) => void;
  onMovieCustomPlatformChange: (v: string) => void;
  onLinkedAssignmentChange: (v: string) => void;
  onDueDateChange: (v: string) => void;
  onDueTimeChange: (v: string) => void;
  onIncludeTimeChange: (v: boolean) => void;
}) {
  const type = assignment.contentType;
  const linkableCandidates = allAssignments.filter(a => a.id !== assignment.id);
  const linkedRecord = allAssignments.find(a => a.id === linkedAssignmentId);

  return (
    <div className="space-y-5">
      {/* Type-specific content */}
      {type === "text" ? (
        <div className="space-y-1">
          <label className="text-sm font-medium text-slate-700">Reading Content</label>
          <RichTextEditor
            value={contentRef}
            onChange={onContentRefChange}
            disabled={saving}
            placeholder="Paste or write the reading passage here."
            documentName={assignment.title}
            onUploadImage={uploadImage}
          />
        </div>
      ) : null}

      {type === "report" ? (
        <div className="space-y-1">
          <label className="text-sm font-medium text-slate-700">Report Instructions &amp; Rubric</label>
          <RichTextEditor
            value={contentRef}
            onChange={onContentRefChange}
            disabled={saving}
            placeholder="Describe the assignment, expectations, length, and grading criteria."
            documentName={assignment.title}
            onUploadImage={uploadImage}
          />
        </div>
      ) : null}

      {type === "url" ? (
        <div className="space-y-1">
          <label className="text-sm font-medium text-slate-700">URL</label>
          <input
            type="url"
            value={contentRef}
            onChange={e => onContentRefChange(e.target.value)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
          />
        </div>
      ) : null}

      {type === "quiz" ? (
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-sm font-medium text-slate-700">Quiz Title</label>
            <input
              value={quizTitle}
              onChange={e => onQuizTitleChange(e.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <QuizBuilder questions={quizQuestions} onChange={onQuizQuestionsChange} disabled={saving} />
          </div>
        </div>
      ) : null}

      {type === "essay_questions" ? (
        <div className="space-y-2">
          <label className="text-sm font-medium text-slate-700">Essay Prompts</label>
          {essayQuestions.map((q, i) => (
            <div key={i} className="flex gap-2">
              <input
                value={q}
                onChange={e => { const n = [...essayQuestions]; n[i] = e.target.value; onEssayQuestionsChange(n); }}
                placeholder={`Prompt ${i + 1}`}
                className="flex-1 rounded-xl border border-slate-300 px-3 py-2 text-sm"
              />
              {essayQuestions.length > 1 ? (
                <button type="button" onClick={() => onEssayQuestionsChange(essayQuestions.filter((_, j) => j !== i))} className="text-xs text-rose-500 hover:text-rose-700">Remove</button>
              ) : null}
            </div>
          ))}
          <button type="button" onClick={() => onEssayQuestionsChange([...essayQuestions, ""])} className="text-xs font-medium text-cyan-700 hover:underline">+ Add Prompt</button>
        </div>
      ) : null}

      {type === "movie" ? (
        <div className="space-y-4">
          <div className="space-y-1">
            <label className="text-sm font-medium text-slate-700">Movie Title</label>
            <input value={movieTitle} onChange={e => onMovieTitleChange(e.target.value)} placeholder="e.g. Schindler's List" className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm" />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium text-slate-700">Why watch it</label>
            <RichTextEditor
              value={movieSynopsis}
              onChange={onMovieSynopsisChange}
              disabled={saving}
              placeholder="Brief description of the film and how it connects to the topic…"
              documentName={assignment.title}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">Where to watch</label>
            <div className="flex flex-wrap gap-2">
              {KNOWN_PLATFORMS.map(platform => {
                const checked = moviePlatforms.includes(platform);
                return (
                  <button
                    key={platform}
                    type="button"
                    onClick={() => onMoviePlatformsChange(checked ? moviePlatforms.filter(p => p !== platform) : [...moviePlatforms, platform])}
                    className={`rounded-full px-3 py-1 text-xs font-semibold border transition ${checked ? "bg-indigo-600 text-white border-indigo-600" : "bg-white text-slate-600 border-slate-300 hover:border-indigo-400"}`}
                  >
                    {checked ? "✓ " : ""}{platform}
                  </button>
                );
              })}
            </div>
            <input value={movieCustomPlatform} onChange={e => onMovieCustomPlatformChange(e.target.value)} placeholder="Other platform…" className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm" />
          </div>
        </div>
      ) : null}

      {/* Linked assignment */}
      {type === "quiz" ? (
        <div className="space-y-1">
          <label className="text-sm font-medium text-slate-700">Linked Source Assignment</label>
          <input
            value={linkedRecord ? `${ASSIGNMENT_TYPE_LABELS[linkedRecord.contentType] ?? linkedRecord.contentType}: ${linkedRecord.title}` : "No linked source"}
            readOnly
            className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600"
          />
        </div>
      ) : (
        <div className="space-y-1">
          <label className="text-sm font-medium text-slate-700">Linked Assignment <span className="font-normal text-slate-400">(optional)</span></label>
          <select value={linkedAssignmentId} onChange={e => onLinkedAssignmentChange(e.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm">
            <option value="">— None —</option>
            {linkableCandidates.map(a => (
              <option key={a.id} value={a.id}>{ASSIGNMENT_TYPE_LABELS[a.contentType] ?? a.contentType}: {a.title}</option>
            ))}
          </select>
        </div>
      )}

      {/* Due date */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <label className="text-sm font-medium text-slate-700">Due Date</label>
          <input type="date" value={dueDate} onChange={e => onDueDateChange(e.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm" />
        </div>
        <div className="space-y-1">
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-2">
            <input type="checkbox" checked={includeTime} onChange={e => onIncludeTimeChange(e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
            Specific time
          </label>
          {includeTime ? (
            <input type="time" value={dueTime} onChange={e => onDueTimeChange(e.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm" />
          ) : null}
        </div>
      </div>
    </div>
  );
}
