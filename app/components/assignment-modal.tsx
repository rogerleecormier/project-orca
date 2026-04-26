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
import { VideoSearch, type VideoData } from "./video-search";
import { updateAssignmentRecord, uploadAssignmentFile, generateQuizFromVideo, createAssignmentRecord } from "../server/functions";
import { essayRubric } from "../lib/ai";
import type { RubricRow } from "../lib/ai";

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

type AssignmentClassOption = {
  id: string;
  title: string;
};

type AssignmentLessonOption = {
  id: string;
  classId: string;
  title: string;
  nodeType: string;
  treeTitle: string | null;
};

type Mode = "view" | "quick-edit" | "edit";

type Props = {
  assignment: ModalAssignment;
  allAssignments?: ModalAssignment[];
  classOptions?: AssignmentClassOption[];
  lessonOptions?: AssignmentLessonOption[];
  initialNodeId?: string | null;
  /** If false, Edit buttons are hidden and the modal is always read-only */
  canEdit?: boolean;
  /** Student's grade level — used to generate/embed rubric on save for essay & report types */
  gradeLevel?: string;
  onClose: () => void;
  /** Called after a successful save — receives the updated assignment */
  onSaved?: (updated: ModalAssignment) => void;
  /** Called when a new linked quiz is created from a video — parent should refresh assignment list */
  onQuizCreated?: () => void;
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

/**
 * AI generates essay contentRef as either:
 *   - { questions: string[], rubric?: RubricRow[] }  (new format)
 *   - plain text prompt string                       (legacy / fallback)
 * This normalizes both into a consistent shape.
 */
function parseEssayRef(ref: string | null | undefined): { questions: string[]; rubric: RubricRow[] } {
  if (!ref) return { questions: [], rubric: [] };
  const parsed = parseJson<{ questions?: string[]; rubric?: RubricRow[] }>(ref);
  if (parsed?.questions && Array.isArray(parsed.questions)) {
    return { questions: parsed.questions, rubric: parsed.rubric ?? [] };
  }
  // Plain-text prompt from AI — treat the whole string as a single question, no rubric
  return { questions: [ref.trim()], rubric: [] };
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

function AssignmentContentView({ assignment, allAssignments, canEdit, gradeLevel, onQuizCreated }: {
  assignment: ModalAssignment;
  allAssignments: ModalAssignment[];
  canEdit: boolean;
  gradeLevel?: string;
  onQuizCreated?: () => void;
}) {
  const ref = assignment.contentRef;
  const type = assignment.contentType;

  if (type === "text") {
    if (!ref) return <p className="text-xs text-slate-400">No content yet.</p>;
    return <RichContent html={ref} className="text-sm" />;
  }

  if (type === "report") {
    if (!ref) return <p className="text-xs text-slate-400">No content yet.</p>;
    // Support both legacy plain HTML and new { html, rubric } JSON format
    const parsed = parseJson<{ html?: string; rubric?: RubricRow[] }>(ref);
    const html = parsed?.html ?? ref;
    const rubric = parsed?.rubric ?? [];
    return <ReportView html={html} rubric={rubric} />;
  }

  if (type === "video") {
    return <VideoAssignmentView assignment={assignment} canEdit={canEdit} gradeLevel={gradeLevel} onQuizCreated={onQuizCreated} />;
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
    const { questions, rubric } = parseEssayRef(ref);
    if (!questions.length) return <p className="text-xs text-slate-400">No prompts yet.</p>;
    return (
      <EssayQuestionsView questions={questions} rubric={rubric} />
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

// ── Video assignment view ─────────────────────────────────────────────────────

type VideoPayloadVideo = {
  videoId: string;
  title: string;
  channel?: string;
  transcript?: string | null;
};

function VideoAssignmentView({
  assignment,
  canEdit,
  gradeLevel,
  onQuizCreated,
}: {
  assignment: ModalAssignment;
  canEdit: boolean;
  gradeLevel?: string;
  onQuizCreated?: () => void;
}) {
  const payload = parseJson<{ videos?: VideoPayloadVideo[] }>(assignment.contentRef);
  const videos = payload?.videos ?? [];

  const [quizGenerating, setQuizGenerating] = useState<string | null>(null); // videoId being generated
  const [quizError, setQuizError] = useState<string | null>(null);
  const [quizSuccess, setQuizSuccess] = useState<string | null>(null);

  if (!videos.length) return <p className="text-xs text-slate-400">No video linked.</p>;

  const handleGenerateQuiz = async (v: VideoPayloadVideo) => {
    if (!assignment.classId) {
      setQuizError("This assignment is not linked to a class — cannot create a quiz.");
      return;
    }
    setQuizGenerating(v.videoId);
    setQuizError(null);
    setQuizSuccess(null);
    try {
      const result = await generateQuizFromVideo({
        data: {
          videoId: v.videoId,
          videoTitle: v.title,
          videoDescription: undefined,
          gradeLevel,
          questionCount: 5,
        },
      });
      // Save the generated quiz as a new linked assignment in the same class
      await createAssignmentRecord({
        data: {
          classId: assignment.classId,
          title: `${v.title} — Quiz`,
          description: `Quiz generated from the video lesson: ${assignment.title}`,
          contentType: "quiz",
          contentRef: JSON.stringify({
            title: `${v.title} — Quiz`,
            questions: result.quiz.questions.map((q) => ({
              question: q.question,
              options: q.options,
              answerIndex: q.answerIndex,
              explanation: q.explanation,
            })),
          }),
          linkedAssignmentId: assignment.id,
        },
      });
      setQuizSuccess(
        result.usedTranscript
          ? "Quiz created from video transcript and linked to this assignment."
          : "Quiz created (no transcript available — questions based on video title). Review before assigning.",
      );
      onQuizCreated?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Quiz generation failed.";
      setQuizError(
        msg.includes("QUIZ_GENERATION_FAILED_NO_TRANSCRIPT")
          ? "Could not generate quiz — transcript unavailable for this video."
          : "Quiz generation failed. Try again.",
      );
    } finally {
      setQuizGenerating(null);
    }
  };

  return (
    <div className="space-y-4">
      {videos.map((v) => (
        <div key={v.videoId} className="rounded-xl overflow-hidden border border-slate-200 bg-slate-50">
          <div className="relative w-full" style={{ paddingBottom: "56.25%" }}>
            <iframe
              src={`https://www.youtube.com/embed/${v.videoId}`}
              title={v.title}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
              className="absolute inset-0 w-full h-full"
            />
          </div>
          <div className="px-4 py-3 space-y-2">
            <p className="text-sm font-medium text-slate-800">{v.title}</p>
            {v.channel ? <p className="text-xs text-slate-500">{v.channel}</p> : null}

            {/* Quiz generation — only shown to editors */}
            {canEdit && (
              <div className="pt-1">
                {quizSuccess ? (
                  <p className="text-xs text-emerald-700 font-medium">{quizSuccess}</p>
                ) : (
                  <button
                    type="button"
                    disabled={quizGenerating === v.videoId}
                    onClick={() => void handleGenerateQuiz(v)}
                    className="flex items-center gap-1.5 rounded-lg border border-cyan-200 bg-cyan-50 px-3 py-1.5 text-xs font-medium text-cyan-700 hover:bg-cyan-100 disabled:opacity-60 transition-colors"
                  >
                    {quizGenerating === v.videoId ? (
                      <>
                        <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                        </svg>
                        Generating quiz…
                      </>
                    ) : (
                      <>
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                          <rect x="2" y="1" width="12" height="14" rx="2" stroke="currentColor" strokeWidth="1.5"/>
                          <line x1="5" y1="5" x2="11" y2="5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                          <line x1="5" y1="8" x2="11" y2="8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                        </svg>
                        Generate Quiz from Video
                      </>
                    )}
                  </button>
                )}
                {quizError ? <p className="mt-1 text-xs text-rose-600">{quizError}</p> : null}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Report view ───────────────────────────────────────────────────────────────

function ReportView({ html, rubric }: { html: string; rubric: RubricRow[] }) {
  const [showRubric, setShowRubric] = useState(false);
  return (
    <>
      <div className="space-y-3">
        <RichContent html={html} className="text-sm" />
        {rubric.length > 0 && (
          <button
            type="button"
            onClick={() => setShowRubric(true)}
            className="flex w-full items-center gap-2.5 rounded-xl border border-dashed border-indigo-200 bg-indigo-50/50 px-4 py-3 text-left hover:bg-indigo-50 transition-colors group"
          >
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-indigo-100 text-indigo-600 group-hover:bg-indigo-200 transition-colors">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="2" y="1" width="12" height="14" rx="2" stroke="currentColor" strokeWidth="1.5"/>
                <line x1="5" y1="5" x2="11" y2="5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                <line x1="5" y1="8" x2="11" y2="8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                <line x1="5" y1="11" x2="8.5" y2="11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              </svg>
            </div>
            <div>
              <p className="text-xs font-semibold text-indigo-700">View Grading Rubric</p>
              <p className="text-[10px] text-indigo-500">{rubric.length} criteria &middot; 4-point scale</p>
            </div>
            <svg className="ml-auto text-indigo-400 group-hover:text-indigo-600 transition-colors" width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        )}
      </div>
      {showRubric && <RubricModal rubric={rubric} onClose={() => setShowRubric(false)} />}
    </>
  );
}

// ── Rubric modal ──────────────────────────────────────────────────────────────

const LEVEL_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  Excellent:  { bg: "bg-emerald-50",  text: "text-emerald-800",  border: "border-emerald-200" },
  Proficient: { bg: "bg-cyan-50",     text: "text-cyan-800",     border: "border-cyan-200"    },
  Developing: { bg: "bg-amber-50",    text: "text-amber-800",    border: "border-amber-200"   },
  Beginning:  { bg: "bg-rose-50",     text: "text-rose-800",     border: "border-rose-200"    },
};

function RubricModal({ rubric, onClose }: { rubric: RubricRow[]; onClose: () => void }) {
  const levels = rubric[0]?.levels.map(l => l.label) ?? ["Excellent", "Proficient", "Developing", "Beginning"];
  const scores = rubric[0]?.levels.map(l => l.score) ?? [4, 3, 2, 1];

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/70 backdrop-blur-sm p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="relative flex flex-col w-full max-w-5xl max-h-[90vh] rounded-2xl border border-slate-200 bg-white shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Essay Rubric</h2>
            <p className="text-xs text-slate-500 mt-0.5">Use this rubric to guide your writing and understand how it will be evaluated.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            ✕
          </button>
        </div>

        {/* Score legend */}
        <div className="shrink-0 flex items-center gap-2 px-6 pt-4 pb-2 flex-wrap">
          {levels.map((label, i) => {
            const c = LEVEL_COLORS[label] ?? { bg: "bg-slate-50", text: "text-slate-700", border: "border-slate-200" };
            return (
              <span key={label} className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold ${c.bg} ${c.text} ${c.border}`}>
                <span className="font-bold">{scores[i]}</span>
                {label}
              </span>
            );
          })}
          <span className="ml-auto text-[10px] text-slate-400 italic">★ = weighted criterion</span>
        </div>

        {/* Rubric table */}
        <div className="flex-1 overflow-auto px-4 pb-6">
          <div className="min-w-[640px]">
            {/* Column headers */}
            <div className="grid gap-2 mb-2 sticky top-0 bg-white pt-2 pb-1 z-10" style={{ gridTemplateColumns: `220px repeat(${levels.length}, 1fr)` }}>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 px-2">Criterion</div>
              {levels.map((label, i) => {
                const c = LEVEL_COLORS[label] ?? { bg: "bg-slate-50", text: "text-slate-500", border: "border-slate-200" };
                return (
                  <div key={label} className={`rounded-xl border px-3 py-2 text-center ${c.bg} ${c.border}`}>
                    <p className={`text-xs font-bold ${c.text}`}>{label}</p>
                    <p className={`text-[10px] font-semibold ${c.text} opacity-70`}>{scores[i]} pts</p>
                  </div>
                );
              })}
            </div>

            {/* Rows */}
            <div className="space-y-2">
              {rubric.map((row) => (
                <div key={row.criterion} className="grid gap-2 items-stretch" style={{ gridTemplateColumns: `220px repeat(${levels.length}, 1fr)` }}>
                  {/* Criterion label */}
                  <div className="flex flex-col justify-center rounded-xl border border-slate-100 bg-slate-50 px-3 py-3">
                    <p className="text-sm font-semibold text-slate-800 leading-snug">{row.criterion}</p>
                    {row.weight >= 3 && (
                      <span className="mt-1 text-[9px] font-bold uppercase tracking-wider text-violet-500">Key criterion</span>
                    )}
                  </div>
                  {/* Performance level cells */}
                  {row.levels.map((lvl) => {
                    const c = LEVEL_COLORS[lvl.label] ?? { bg: "bg-slate-50", text: "text-slate-700", border: "border-slate-200" };
                    return (
                      <div key={lvl.label} className={`rounded-xl border px-3 py-3 ${c.bg} ${c.border}`}>
                        <p className={`text-xs leading-relaxed ${c.text}`}>{lvl.descriptor}</p>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Essay questions view ───────────────────────────────────────────────────────

function EssayQuestionsView({ questions, rubric }: { questions: string[]; rubric: RubricRow[] }) {
  const [showRubric, setShowRubric] = useState(false);

  return (
    <>
      <div className="space-y-3">
        {questions.map((q, i) => {
          // Split writing guidelines (appended by AI) from the essay prompt itself
          const guidelineIdx = q.indexOf("Writing guidelines:");
          const prompt = guidelineIdx > 0 ? q.slice(0, guidelineIdx).trim() : q.trim();
          const guidelines = guidelineIdx > 0 ? q.slice(guidelineIdx).trim() : null;
          return (
            <div key={i} className="rounded-xl border border-violet-100 bg-violet-50 px-4 py-3 space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-violet-400">
                {questions.length > 1 ? `Prompt ${i + 1}` : "Prompt"}
              </p>
              <p className="text-sm text-slate-700 leading-relaxed">{prompt}</p>
              {guidelines && (
                <div className="border-t border-violet-100 pt-2">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-violet-400 mb-1">Writing Guidelines</p>
                  <p className="text-xs text-slate-500 leading-relaxed">{guidelines.replace(/^Writing guidelines:\s*/i, "")}</p>
                </div>
              )}
            </div>
          );
        })}

        {/* Rubric link — only shown when rubric data is present */}
        {rubric.length > 0 && (
          <button
            type="button"
            onClick={() => setShowRubric(true)}
            className="flex w-full items-center gap-2.5 rounded-xl border border-dashed border-violet-200 bg-violet-50/50 px-4 py-3 text-left hover:bg-violet-50 transition-colors group"
          >
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-violet-100 text-violet-600 group-hover:bg-violet-200 transition-colors">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="2" y="1" width="12" height="14" rx="2" stroke="currentColor" strokeWidth="1.5"/>
                <line x1="5" y1="5" x2="11" y2="5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                <line x1="5" y1="8" x2="11" y2="8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                <line x1="5" y1="11" x2="8.5" y2="11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              </svg>
            </div>
            <div>
              <p className="text-xs font-semibold text-violet-700">View Grading Rubric</p>
              <p className="text-[10px] text-violet-500">{rubric.length} criteria &middot; 4-point scale</p>
            </div>
            <svg className="ml-auto text-violet-400 group-hover:text-violet-600 transition-colors" width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        )}
      </div>

      {showRubric && rubric.length > 0 && (
        <RubricModal rubric={rubric} onClose={() => setShowRubric(false)} />
      )}
    </>
  );
}

// ── Main Modal ────────────────────────────────────────────────────────────────

export function AssignmentModal({
  assignment: initialAssignment,
  allAssignments = [],
  classOptions = [],
  lessonOptions = [],
  initialNodeId = null,
  canEdit = true,
  gradeLevel,
  onClose,
  onSaved,
  onQuizCreated,
  onRequestDelete,
}: Props) {
  const [mode, setMode] = useState<Mode>("view");
  const [assignment, setAssignment] = useState(initialAssignment);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // ── Edit/quick-edit shared fields ────────────────────────────────────────────
  const [title, setTitle] = useState(assignment.title);
  const [description, setDescription] = useState(assignment.description ?? "");
  // For report type, contentRef may be { html, rubric } JSON or legacy plain HTML
  const [contentRef, setContentRef] = useState(() => {
    if (assignment.contentType === "report") {
      const p = parseJson<{ html?: string }>(assignment.contentRef);
      return p?.html ?? (assignment.contentRef ?? "");
    }
    return assignment.contentRef ?? "";
  });
  const [linkedAssignmentId, setLinkedAssignmentId] = useState(assignment.linkedAssignmentId ?? "");
  const [classId, setClassId] = useState(assignment.classId ?? classOptions[0]?.id ?? "");
  const [linkedNodeId, setLinkedNodeId] = useState(initialNodeId ?? "");
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
    const qs = parseEssayRef(assignment.contentRef).questions;
    return qs.length ? qs : [""];
  });

  // Movie
  const [movieTitle, setMovieTitle] = useState(() => parseJson<{ title?: string }>(assignment.contentRef)?.title ?? "");
  const [movieSynopsis, setMovieSynopsis] = useState(() => parseJson<{ synopsis?: string }>(assignment.contentRef)?.synopsis ?? "");
  const [moviePlatforms, setMoviePlatforms] = useState<string[]>(() => parseJson<{ whereToWatch?: string[] }>(assignment.contentRef)?.whereToWatch ?? []);
  const [movieCustomPlatform, setMovieCustomPlatform] = useState("");

  // Video
  const [videoVideos, setVideoVideos] = useState<VideoData[]>(() => {
    const p = parseJson<{ videos?: Array<Partial<VideoData> & { videoId: string }> }>(assignment.contentRef);
    return (p?.videos ?? []).map(v => ({
      videoId: v.videoId,
      title: v.title ?? "",
      channel: v.channel ?? "",
      description: v.description,
      thumbnail: v.thumbnail,
    }));
  });

  const typeLbl = ASSIGNMENT_TYPE_LABELS[assignment.contentType] ?? assignment.contentType;
  const typeBadge = TYPE_BADGE[assignment.contentType] ?? "bg-slate-50 text-slate-700 border-slate-200";

  const linkableCandidates = allAssignments.filter(a => a.id !== assignment.id);

  function buildContentRef(): string | undefined {
    const type = assignment.contentType;
    if (type === "quiz") return JSON.stringify({ title: quizTitle.trim() || title.trim(), questions: quizQuestions });
    if (type === "essay_questions") {
      const rubric = gradeLevel ? essayRubric(gradeLevel) : (parseEssayRef(assignment.contentRef).rubric);
      return JSON.stringify({ questions: essayQuestions.filter(q => q.trim()), rubric });
    }
    if (type === "report") {
      const rubric = gradeLevel ? essayRubric(gradeLevel) : [];
      return JSON.stringify({ html: contentRef || "", rubric });
    }
    if (type === "movie") {
      const platforms = movieCustomPlatform.trim() ? [...moviePlatforms, movieCustomPlatform.trim()] : moviePlatforms;
      return JSON.stringify({ title: movieTitle.trim() || title.trim(), synopsis: movieSynopsis.trim(), whereToWatch: platforms });
    }
    if (type === "video") return JSON.stringify({ videos: videoVideos });
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
          classId: classOptions.length > 0 ? (classId || undefined) : undefined,
          nodeId: lessonOptions.length > 0 ? (linkedNodeId || null) : undefined,
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
        classId: classId || assignment.classId || null,
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
              videoVideos={videoVideos}
              linkedAssignmentId={linkedAssignmentId}
              classId={classId}
              linkedNodeId={linkedNodeId}
              dueDate={dueDate}
              dueTime={dueTime}
              includeTime={includeTime}
              saving={saving}
              allAssignments={allAssignments}
              classOptions={classOptions}
              lessonOptions={lessonOptions}
              onContentRefChange={setContentRef}
              onQuizTitleChange={setQuizTitle}
              onQuizQuestionsChange={setQuizQuestions}
              onEssayQuestionsChange={setEssayQuestions}
              onMovieTitleChange={setMovieTitle}
              onMovieSynopsisChange={setMovieSynopsis}
              onMoviePlatformsChange={setMoviePlatforms}
              onMovieCustomPlatformChange={setMovieCustomPlatform}
              onVideoVideosChange={setVideoVideos}
              onLinkedAssignmentChange={setLinkedAssignmentId}
              onClassIdChange={(nextClassId) => {
                setClassId(nextClassId);
                if (
                  linkedNodeId &&
                  !lessonOptions.some((lesson) => lesson.classId === nextClassId && lesson.id === linkedNodeId)
                ) {
                  setLinkedNodeId("");
                }
              }}
              onLinkedNodeIdChange={setLinkedNodeId}
              onDueDateChange={setDueDate}
              onDueTimeChange={setDueTime}
              onIncludeTimeChange={setIncludeTime}
            />
          ) : null}

          {/* View mode: render content */}
          {mode === "view" ? (
            <AssignmentContentView assignment={assignment} allAssignments={allAssignments} canEdit={canEdit} gradeLevel={gradeLevel} onQuizCreated={onQuizCreated} />
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
  videoVideos,
  linkedAssignmentId,
  classId,
  linkedNodeId,
  dueDate,
  dueTime,
  includeTime,
  saving,
  allAssignments,
  classOptions,
  lessonOptions,
  onContentRefChange,
  onQuizTitleChange,
  onQuizQuestionsChange,
  onEssayQuestionsChange,
  onMovieTitleChange,
  onMovieSynopsisChange,
  onMoviePlatformsChange,
  onMovieCustomPlatformChange,
  onVideoVideosChange,
  onLinkedAssignmentChange,
  onClassIdChange,
  onLinkedNodeIdChange,
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
  videoVideos: VideoData[];
  linkedAssignmentId: string;
  classId: string;
  linkedNodeId: string;
  dueDate: string;
  dueTime: string;
  includeTime: boolean;
  saving: boolean;
  allAssignments: ModalAssignment[];
  classOptions: AssignmentClassOption[];
  lessonOptions: AssignmentLessonOption[];
  onContentRefChange: (v: string) => void;
  onQuizTitleChange: (v: string) => void;
  onQuizQuestionsChange: (v: QuizQuestion[]) => void;
  onEssayQuestionsChange: (v: string[]) => void;
  onMovieTitleChange: (v: string) => void;
  onMovieSynopsisChange: (v: string) => void;
  onMoviePlatformsChange: (v: string[]) => void;
  onMovieCustomPlatformChange: (v: string) => void;
  onVideoVideosChange: (v: VideoData[]) => void;
  onLinkedAssignmentChange: (v: string) => void;
  onClassIdChange: (v: string) => void;
  onLinkedNodeIdChange: (v: string) => void;
  onDueDateChange: (v: string) => void;
  onDueTimeChange: (v: string) => void;
  onIncludeTimeChange: (v: boolean) => void;
}) {
  const type = assignment.contentType;
  const linkableCandidates = allAssignments.filter(a => a.id !== assignment.id);
  const linkedRecord = allAssignments.find(a => a.id === linkedAssignmentId);
  const lessonsForClass = lessonOptions.filter((lesson) => lesson.classId === classId);

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

      {type === "video" ? (
        <div className="space-y-1">
          <label className="text-sm font-medium text-slate-700">Video</label>
          <VideoSearch
            videos={videoVideos}
            onVideosChange={onVideoVideosChange}
            disabled={saving}
            enableQuizGeneration={false}
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

      {(classOptions.length > 0 || lessonOptions.length > 0) ? (
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <label className="text-sm font-medium text-slate-700">Class</label>
            <select
              value={classId}
              onChange={e => onClassIdChange(e.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
            >
              {classOptions.map((row) => (
                <option key={row.id} value={row.id}>{row.title}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium text-slate-700">Linked Lesson</label>
            <select
              value={linkedNodeId}
              onChange={e => onLinkedNodeIdChange(e.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="">- None -</option>
              {lessonsForClass.map((lesson) => (
                <option key={lesson.id} value={lesson.id}>
                  {(lesson.treeTitle ? `${lesson.treeTitle} - ` : "") + `${lesson.title} (${lesson.nodeType})`}
                </option>
              ))}
            </select>
            <p className="text-xs text-slate-500">Changing this reassigns the assignment in the skill tree.</p>
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
