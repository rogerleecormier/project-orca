import { useEffect, useReducer, useRef, useState } from "react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { AssignmentModal, type ModalAssignment } from "../components/assignment-modal";
import { DeleteConfirmModal } from "../components/delete-confirm-modal";
import { ParentPageHeader } from "../components/parent-page-header";
import { QuizBuilder, type QuizQuestion } from "../components/quiz-builder";
import { RichContent } from "../components/rich-content";
import { RichTextEditor } from "../components/rich-text-editor";
import { VideoSearch, type VideoData } from "../components/video-search";
import {
  assignAssignmentToMarkingPeriod,
  createAssignmentRecord,
  deleteAssignmentRecord,
  generateQuizFromLinkedAssignment,
  getCurriculumBuilderData,
  getViewerContext,
  gradeSubmissionWithAI,
  releaseSubmissionToStudent,
  saveAssignmentAsTemplate,
  updateAssignmentRecord,
  uploadAssignmentFile,
} from "../server/functions";

export const Route = createFileRoute("/assignments")({
  validateSearch: (search: Record<string, unknown>): { classId?: string } => ({
    classId: typeof search.classId === "string" ? search.classId : undefined,
  }),
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

type AssignmentType = "text" | "file" | "url" | "video" | "quiz" | "essay_questions" | "report" | "movie";

const CHAT_SUGGESTION_STORAGE_KEY = "proorca.lessonPlanner.selectedSuggestion.v1";
const CHAT_SUGGESTION_EVENT = "proorca:lesson-planner-suggestion";

type QuizPayload = {
  title?: string;
  questions?: QuizQuestion[];
};

type VideoPayload = {
  videos?: Array<
    VideoData & {
      transcript?: string | null;
      transcriptFetchedAt?: string | null;
      transcriptMeta?: {
        keyPresent: boolean;
        attempted: boolean;
        endpoint: "youtube" | "transcript";
        status: number | null;
        ok: boolean;
        error: string | null;
      };
    }
  >;
};

type EssayQuestionsPayload = {
  questions?: string[];
};

type MoviePayload = {
  title?: string;
  synopsis?: string;
  whereToWatch?: string[];
};

const KNOWN_PLATFORMS = [
  "Netflix",
  "Disney+",
  "Amazon Prime Video",
  "HBO Max",
  "Max",
  "Hulu",
  "Apple TV+",
  "Peacock",
  "Paramount+",
  "Tubi",
  "YouTube",
] as const;

const TYPE_LABELS: Record<AssignmentType, string> = {
  text: "Reading",
  file: "File",
  url: "Link",
  video: "Video Lesson",
  quiz: "Quiz",
  essay_questions: "Essay Questions",
  report: "Report",
  movie: "Movie",
};

const TYPE_DESCRIPTIONS: Record<AssignmentType, string> = {
  text: "A passage or text for the student to read.",
  file: "A PDF, worksheet, or image to download.",
  url: "An external resource link.",
  video: "A YouTube video lesson.",
  quiz: "Multiple-choice questions.",
  essay_questions: "Short structured prompts the student answers in writing — can be linked to a video.",
  report: "A long-form writing assignment with a rubric or instructions.",
  movie: "Watch a film related to the topic, followed by a linked quiz, essay, or discussion.",
};

const TYPE_BADGE_STYLES: Record<AssignmentType, string> = {
  video: "bg-cyan-50 text-cyan-800 border-cyan-200",
  quiz: "bg-violet-50 text-violet-800 border-violet-200",
  text: "bg-emerald-50 text-emerald-800 border-emerald-200",
  file: "bg-amber-50 text-amber-800 border-amber-200",
  url: "bg-sky-50 text-sky-800 border-sky-200",
  essay_questions: "bg-rose-50 text-rose-800 border-rose-200",
  report: "bg-indigo-50 text-indigo-800 border-indigo-200",
  movie: "bg-violet-50 text-violet-800 border-violet-200",
};

function getTypeBadgeClass(type: string) {
  return TYPE_BADGE_STYLES[type as AssignmentType] ?? "bg-slate-50 text-slate-700 border-slate-200";
}

function getDefaultAssignmentInstructions(type: AssignmentType) {
  switch (type) {
    case "text":
      return "Read the assigned passage carefully. Take your time, pay attention to the key ideas, and be ready to answer questions about what you read.";
    case "file":
      return "Open the attached file, review each section carefully, and complete the work before marking the assignment finished.";
    case "url":
      return "Open the linked resource, work through the material carefully, and complete any follow-up work connected to this assignment.";
    case "video":
      return "Watch the full video lesson carefully. Pause and replay parts as needed so you understand the material before moving on.";
    case "quiz":
      return "Answer each question carefully and choose the best answer. Review your work before submitting.";
    case "essay_questions":
      return "Respond to each question in complete sentences. Use details from the lesson or source material to support your answers.";
    case "report":
      return "Complete the report using clear writing, organized ideas, and supporting details. Review your work before turning it in.";
  }
}

async function fileToBase64(file: File) {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("FILE_READ_FAILED"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const commaIndex = result.indexOf(",");
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

function hasRichTextContent(value: string) {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .trim().length > 0;
}

async function uploadInlineImageUtil(file: File) {
  try {
    const base64 = await fileToBase64(file);
    const uploaded = await uploadAssignmentFile({
      data: {
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        base64,
      },
    });
    return { key: uploaded.key };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "File upload failed";
    throw new Error(`Failed to upload image: ${errorMessage}`);
  }
}

function summarizeRichText(value: string, maxLength = 180) {
  const plain = value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (plain.length <= maxLength) {
    return plain;
  }

  return `${plain.slice(0, maxLength).trimEnd()}...`;
}

function parseJson<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function hasSavedVideoTranscript(assignment: { contentRef?: string | null }) {
  const payload = parseJson<VideoPayload>(assignment.contentRef);
  const transcript = payload?.videos?.[0]?.transcript;
  return typeof transcript === "string" && transcript.trim().length > 100;
}

function isReadingSourceAssignment(assignment: { contentType: string; contentRef?: string | null }) {
  return assignment.contentType === "text" && hasRichTextContent(assignment.contentRef ?? "");
}

function getSavedVideoTranscript(value: string | null | undefined) {
  const payload = parseJson<VideoPayload>(value);
  const transcript = payload?.videos?.[0]?.transcript;
  return typeof transcript === "string" && transcript.trim().length > 0 ? transcript : null;
}

function getQuizGenerationErrorMessage(rawMessage: string) {
  if (rawMessage.includes("VIDEO_TRANSCRIPT_REQUIRED")) {
    return "This video assignment has no saved transcript yet. Re-save the video assignment, then try again.";
  }
  if (rawMessage.includes("READING_CONTENT_REQUIRED")) {
    return "The selected reading assignment has no usable reading text.";
  }
  if (rawMessage.includes("VIDEO_DATA_REQUIRED")) {
    return "The selected video assignment is missing video details. Re-save that assignment.";
  }
  if (rawMessage.includes("NOT_FOUND")) {
    return "The selected source assignment could not be found. Refresh and select it again.";
  }
  if (rawMessage.includes("UNSUPPORTED_SOURCE_TYPE")) {
    return "This source type cannot be used for quiz generation.";
  }
  if (rawMessage.includes("AI_QUIZ_PARSE_FAILED") || rawMessage.includes("AI_RESPONSE_PARSE_FAILED")) {
    return "AI returned an invalid quiz format. Try again or lower the question count.";
  }
  if (rawMessage.includes("AI_QUIZ_FORMAT_INVALID:")) {
    const details = rawMessage.split("AI_QUIZ_FORMAT_INVALID:")[1]?.trim();
    return details
      ? `AI format validation failed: ${details}`
      : "AI format validation failed.";
  }
  return "Quiz generation failed. Please try again.";
}

function parseDueAt(value: string | null | undefined) {
  if (!value) {
    return {
      dueDate: "",
      dueTime: "23:59",
      includeDueTime: false,
    };
  }

  const dateMatch = value.match(/^(\d{4}-\d{2}-\d{2})/);
  const timeMatch = value.match(/T(\d{2}:\d{2})/);

  return {
    dueDate: dateMatch?.[1] ?? "",
    dueTime: timeMatch?.[1] ?? "23:59",
    includeDueTime: Boolean(timeMatch),
  };
}

function buildDueAt({
  dueDate,
  dueTime,
  includeDueTime,
}: {
  dueDate: string;
  dueTime: string;
  includeDueTime: boolean;
}) {
  if (!dueDate) return undefined;
  if (!includeDueTime) return dueDate;
  return `${dueDate}T${dueTime || "23:59"}`;
}

// ── Edit modal ────────────────────────────────────────────────────────────────

type AssignmentRow = Awaited<ReturnType<typeof getCurriculumBuilderData>>["assignments"][number];
type AssignmentTemplateRow = Awaited<ReturnType<typeof getCurriculumBuilderData>>["templates"][number];
type SubmissionRow = Awaited<ReturnType<typeof getCurriculumBuilderData>>["submissions"][number];
type ProfileRow = Awaited<ReturnType<typeof getCurriculumBuilderData>>["profiles"][number];

function humanizeTemplateTagValue(value: string) {
  return value
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getTemplateTagValues(template: { tags: string[] }, prefix: string) {
  return template.tags
    .filter((tag) => tag.startsWith(`${prefix}:`))
    .map((tag) => tag.slice(prefix.length + 1));
}

function getTemplatePrimarySubject(template: { tags: string[] }) {
  return getTemplateTagValues(template, "subject")[0] ?? "custom";
}

function getTemplateGradeLabels(template: { tags: string[] }) {
  return getTemplateTagValues(template, "grade").map((value) =>
    value === "k" ? "Grade K" : `Grade ${value}`,
  );
}

function EditAssignmentModal({
  assignment,
  allAssignments,
  onSave,
  onRequestDelete,
  onClose,
}: {
  assignment: AssignmentRow;
  allAssignments: AssignmentRow[];
  onSave: () => void;
  onRequestDelete: (assignment: AssignmentRow) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(assignment.title);
  const [description, setDescription] = useState(assignment.description ?? "");
  const [contentRef, setContentRef] = useState(assignment.contentRef ?? "");
  const [linkedAssignmentId, setLinkedAssignmentId] = useState(assignment.linkedAssignmentId ?? "");
  const initialDue = parseDueAt(assignment.dueAt);
  const [dueDate, setDueDate] = useState(initialDue.dueDate);
  const [dueTime, setDueTime] = useState(initialDue.dueTime);
  const [includeDueTime, setIncludeDueTime] = useState(initialDue.includeDueTime);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // For quiz editing
  const quizPayload = parseJson<QuizPayload>(assignment.contentRef);
  const [quizTitle, setQuizTitle] = useState(quizPayload?.title ?? "");
  const [quizQuestions, setQuizQuestions] = useState<QuizQuestion[]>(
    (quizPayload?.questions ?? []).map((q) => ({
      ...q,
      id: (q as QuizQuestion).id ?? crypto.randomUUID(),
    })),
  );

  // For essay_questions editing
  const essayPayload = parseJson<EssayQuestionsPayload>(assignment.contentRef);
  const [essayQuestions, setEssayQuestions] = useState<string[]>(
    essayPayload?.questions ?? [""],
  );

  // For movie editing
  const moviePayload = parseJson<MoviePayload>(assignment.contentRef);
  const [movieTitle, setMovieTitle] = useState(moviePayload?.title ?? "");
  const [movieSynopsis, setMovieSynopsis] = useState(moviePayload?.synopsis ?? "");
  const [moviePlatforms, setMoviePlatforms] = useState<string[]>(moviePayload?.whereToWatch ?? []);
  const [movieCustomPlatform, setMovieCustomPlatform] = useState("");

  const linkableCandidates = allAssignments.filter(
    (a) => a.id !== assignment.id,
  );
  const linkedAssignmentRecord = allAssignments.find((a) => a.id === linkedAssignmentId);

  const handleSave = async () => {
    setSaving(true);
    setError(null);

    let updatedContentRef: string | undefined = contentRef || undefined;

    if (assignment.contentType === "quiz") {
      updatedContentRef = JSON.stringify({
        title: quizTitle.trim() || title.trim(),
        questions: quizQuestions,
      });
    }

    if (assignment.contentType === "essay_questions") {
      const filtered = essayQuestions.filter((q) => q.trim());
      updatedContentRef = JSON.stringify({ questions: filtered });
    }

    if (assignment.contentType === "movie") {
      const allPlatforms = movieCustomPlatform.trim()
        ? [...moviePlatforms, movieCustomPlatform.trim()]
        : moviePlatforms;
      updatedContentRef = JSON.stringify({
        title: movieTitle.trim() || title.trim(),
        synopsis: movieSynopsis.trim(),
        whereToWatch: allPlatforms,
      } satisfies MoviePayload);
    }

    try {
      const dueAt = buildDueAt({ dueDate, dueTime, includeDueTime });
      await updateAssignmentRecord({
        data: {
          assignmentId: assignment.id,
          title: title.trim(),
          description: description.trim() || undefined,
          contentRef: updatedContentRef,
          linkedAssignmentId: linkedAssignmentId || null,
          dueAt,
        },
      });
      onSave();
    } catch {
      setError("Could not save changes.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 backdrop-blur-sm p-4">
      <div className="relative my-8 w-full max-w-2xl rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <div className="flex items-center justify-between gap-4 border-b border-slate-200 px-6 py-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-500">
              Edit — {TYPE_LABELS[assignment.contentType as AssignmentType] ?? assignment.contentType}
            </p>
            <h2 className="text-lg font-semibold text-slate-900">{assignment.title}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
          >
            Cancel
          </button>
        </div>

        <div className="space-y-4 px-6 py-5">
          <label className="block space-y-1">
            <span className="text-sm font-medium text-slate-700">Title</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
            />
          </label>

          <label className="block space-y-1">
            <span className="text-sm font-medium text-slate-700">Assignment Instructions</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="min-h-20 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
            />
          </label>

          {/* Type-specific content editing */}
          {assignment.contentType === "text" ? (
            <div className="block space-y-1">
              <span className="text-sm font-medium text-slate-700">Reading Text</span>
              <RichTextEditor
                value={contentRef}
                onChange={setContentRef}
                disabled={saving}
                placeholder="Paste the passage or instructions students should read."
                documentName={title || assignment.title}
                onUploadImage={(file) => uploadInlineImageUtil(file)}
              />
            </div>
          ) : null}

          {assignment.contentType === "url" ? (
            <label className="block space-y-1">
              <span className="text-sm font-medium text-slate-700">URL</span>
              <input
                value={contentRef}
                onChange={(e) => setContentRef(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
              />
            </label>
          ) : null}

          {assignment.contentType === "report" ? (
            <div className="block space-y-1">
              <span className="text-sm font-medium text-slate-700">Report Instructions & Rubric</span>
              <RichTextEditor
                value={contentRef}
                onChange={setContentRef}
                disabled={saving}
                placeholder="Describe the assignment, expectations, length, and grading criteria."
                documentName={title || assignment.title}
                onUploadImage={(file) => uploadInlineImageUtil(file)}
              />
            </div>
          ) : null}

          {assignment.contentType === "quiz" ? (
            <div className="space-y-3">
              <label className="block space-y-1">
                <span className="text-sm font-medium text-slate-700">Quiz Title</span>
                <input
                  value={quizTitle}
                  onChange={(e) => setQuizTitle(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                />
              </label>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <QuizBuilder questions={quizQuestions} onChange={setQuizQuestions} disabled={saving} />
              </div>
            </div>
          ) : null}

          {assignment.contentType === "essay_questions" ? (
            <div className="space-y-2">
              <span className="text-sm font-medium text-slate-700">Essay Questions</span>
              {essayQuestions.map((q, i) => (
                <div key={i} className="flex gap-2">
                  <input
                    value={q}
                    onChange={(e) => {
                      const next = [...essayQuestions];
                      next[i] = e.target.value;
                      setEssayQuestions(next);
                    }}
                    className="flex-1 rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                    placeholder={`Question ${i + 1}`}
                  />
                  {essayQuestions.length > 1 ? (
                    <button
                      type="button"
                      onClick={() => setEssayQuestions(essayQuestions.filter((_, j) => j !== i))}
                      className="text-xs text-rose-600 hover:text-rose-800"
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
              ))}
              <button
                type="button"
                onClick={() => setEssayQuestions([...essayQuestions, ""])}
                className="text-xs font-medium text-cyan-700 hover:text-cyan-800"
              >
                + Add Question
              </button>
            </div>
          ) : null}

          {assignment.contentType === "movie" ? (
            <div className="space-y-4">
              {/* Movie title */}
              <label className="block space-y-1">
                <span className="text-sm font-medium text-slate-700">Movie Title</span>
                <input
                  value={movieTitle}
                  onChange={(e) => setMovieTitle(e.target.value)}
                  placeholder="e.g. Schindler's List"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                />
              </label>

              {/* Synopsis */}
              <label className="block space-y-1">
                <span className="text-sm font-medium text-slate-700">Why watch it</span>
                <textarea
                  value={movieSynopsis}
                  onChange={(e) => setMovieSynopsis(e.target.value)}
                  rows={2}
                  placeholder="Brief description of the film and how it connects to the topic…"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800 resize-none"
                />
              </label>

              {/* Where to watch */}
              <div className="space-y-2">
                <span className="text-sm font-medium text-slate-700">Where to watch</span>
                <p className="text-xs text-slate-500">Check every platform where this film is available.</p>
                <div className="flex flex-wrap gap-2">
                  {KNOWN_PLATFORMS.map((platform) => {
                    const checked = moviePlatforms.includes(platform);
                    return (
                      <button
                        key={platform}
                        type="button"
                        onClick={() =>
                          setMoviePlatforms(
                            checked
                              ? moviePlatforms.filter((p) => p !== platform)
                              : [...moviePlatforms, platform],
                          )
                        }
                        className={[
                          "rounded-full px-3 py-1 text-xs font-semibold border transition",
                          checked
                            ? "bg-indigo-600 text-white border-indigo-600"
                            : "bg-white text-slate-600 border-slate-300 hover:border-indigo-400",
                        ].join(" ")}
                      >
                        {checked ? "✓ " : ""}{platform}
                      </button>
                    );
                  })}
                </div>
                {/* Custom platform */}
                <div className="flex gap-2 mt-1">
                  <input
                    value={movieCustomPlatform}
                    onChange={(e) => setMovieCustomPlatform(e.target.value)}
                    placeholder="Other platform (e.g. Kanopy, library DVD…)"
                    className="flex-1 rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                  />
                </div>
              </div>
            </div>
          ) : null}

          {/* Link to another assignment */}
          {assignment.contentType === "quiz" ? (
            <label className="block space-y-1">
              <span className="text-sm font-medium text-slate-700">
                Linked Source Assignment
              </span>
              <input
                value={
                  linkedAssignmentRecord
                    ? `${TYPE_LABELS[linkedAssignmentRecord.contentType as AssignmentType] ?? linkedAssignmentRecord.contentType}: ${linkedAssignmentRecord.title}`
                    : "No linked source"
                }
                readOnly
                className="w-full rounded-xl border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-700"
              />
            </label>
          ) : (
            <label className="block space-y-1">
              <span className="text-sm font-medium text-slate-700">
                Linked Assignment (optional)
              </span>
              <p className="text-xs text-slate-500">
                Link this to a video lesson or another assignment. Students see them grouped together.
              </p>
              <select
                value={linkedAssignmentId}
                onChange={(e) => setLinkedAssignmentId(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
              >
                <option value="">— None —</option>
                {linkableCandidates.map((a) => (
                  <option key={a.id} value={a.id}>
                    {TYPE_LABELS[a.contentType as AssignmentType] ?? a.contentType}: {a.title}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="block space-y-1">
            <span className="text-sm font-medium text-slate-700">Due Date</span>
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
            />
          </label>

          <label className="block space-y-2">
            <span className="inline-flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={includeDueTime}
                onChange={(e) => setIncludeDueTime(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300"
              />
              Add specific due time
            </span>
            {includeDueTime ? (
              <input
                type="time"
                value={dueTime}
                onChange={(e) => setDueTime(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
              />
            ) : null}
          </label>
        </div>

        {error ? <p className="px-6 pb-2 text-sm text-rose-700">{error}</p> : null}

        <div className="flex justify-end gap-3 border-t border-slate-200 px-6 py-4">
          <button
            type="button"
            onClick={() => onRequestDelete(assignment)}
            className="mr-auto rounded-xl border border-rose-300 bg-white px-4 py-2 text-sm font-medium text-rose-700 hover:bg-rose-50"
          >
            Delete Assignment
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
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
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

type VideoStep = "search" | "preview" | "confirm";

type FormState = {
  classId: string;
  createMode: "template" | "blank";
  title: string;
  description: string;
  contentType: AssignmentType;
  dueDate: string;
  dueTime: string;
  includeDueTime: boolean;
  linkedAssignmentId: string;
  textContent: string;
  resourceUrl: string;
  reportPrompt: string;
  selectedFile: File | null;
  templateFileAssetKey: string;
  videos: VideoData[];
  videoStep: VideoStep;
  createQuizAfterVideoSave: boolean;
  quizTitle: string;
  quizQuestions: QuizQuestion[];
  quizCreationMode: "generate" | "manual" | null;
  quizSourceType: "video" | "text";
  quizSourceAssignmentId: string;
  quizQuestionCount: number;
  essayQuestions: string[];
  templateSubjectFilter: string;
  templateTypeFilter: AssignmentType | "all";
  templatePrefillMessage: string | null;
  error: string | null;
  successMessage: string | null;
  quizGenerateError: string | null;
};

type FormAction =
  | { type: "RESET_FORM"; nextContentType?: AssignmentType; nextMode?: "template" | "blank"; keepClassId?: boolean; defaultClassId: string }
  | { type: "APPLY_TEMPLATE"; template: AssignmentTemplateRow }
  | { type: "APPLY_SUGGESTION"; title: string; description: string; nextType: AssignmentType }
  | { type: "CHANGE_CONTENT_TYPE"; contentType: AssignmentType; preserveQuizState?: boolean }
  | { type: "POST_VIDEO_SAVE_QUIZ_TRANSITION"; assignmentId: string }
  | { type: "QUIZ_GENERATED"; title: string; questions: QuizQuestion[]; sourceType: "video" | "text"; sourceTitle: string; sourceAssignmentId: string }
  | { type: "SELECT_QUIZ_MODE"; mode: "generate" | "manual" }
  | { type: "SET_QUIZ_SOURCE_TYPE"; sourceType: "video" | "text" }
  | { type: "SET_QUIZ_SOURCE_ASSIGNMENT"; assignmentId: string }
  | { type: "SET_FIELD"; field: keyof FormState; value: unknown };

function FORM_INITIAL_STATE(defaultClassId: string): FormState {
  return {
    classId: defaultClassId,
    createMode: "template",
    title: "",
    description: getDefaultAssignmentInstructions("video"),
    contentType: "video",
    dueDate: "",
    dueTime: "23:59",
    includeDueTime: false,
    linkedAssignmentId: "",
    textContent: "",
    resourceUrl: "",
    reportPrompt: "",
    selectedFile: null,
    templateFileAssetKey: "",
    videos: [],
    videoStep: "search",
    createQuizAfterVideoSave: false,
    quizTitle: "",
    quizQuestions: [],
    quizCreationMode: null,
    quizSourceType: "video",
    quizSourceAssignmentId: "",
    quizQuestionCount: 5,
    essayQuestions: [""],
    templateSubjectFilter: "all",
    templateTypeFilter: "all",
    templatePrefillMessage: null,
    error: null,
    successMessage: null,
    quizGenerateError: null,
  };
}

function formReducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case "RESET_FORM": {
      const nextContentType = action.nextContentType ?? "video";
      const initial = FORM_INITIAL_STATE(action.keepClassId ? state.classId : action.defaultClassId);
      return {
        ...initial,
        createMode: action.nextMode ?? "template",
        contentType: nextContentType,
      };
    }

    case "APPLY_TEMPLATE": {
      const { template } = action;
      const nextType = template.contentType as AssignmentType;
      const quizPayload = parseJson<QuizPayload>(template.contentRef);
      const essayPayload = parseJson<EssayQuestionsPayload>(template.contentRef);
      const videoPayload = parseJson<VideoPayload>(template.contentRef);

      const baseState: FormState = {
        classId: state.classId,
        createMode: "blank",
        contentType: nextType,
        title: template.title,
        description: template.description ?? getDefaultAssignmentInstructions(nextType),
        dueDate: "",
        dueTime: "23:59",
        includeDueTime: false,
        linkedAssignmentId: "",
        textContent: nextType === "text" ? (template.contentRef ?? "") : "",
        resourceUrl: nextType === "url" ? (template.contentRef ?? "") : "",
        reportPrompt: nextType === "report" ? (template.contentRef ?? "") : "",
        selectedFile: null,
        templateFileAssetKey: nextType === "file" ? (template.contentRef ?? "") : "",
        videos: nextType === "video" ? (videoPayload?.videos?.map((v) => ({ ...v })) ?? []) : [],
        videoStep: nextType === "video" && videoPayload?.videos?.length ? "preview" : "search",
        createQuizAfterVideoSave: false,
        quizTitle: nextType === "quiz" ? (quizPayload?.title ?? `${template.title} Quiz`) : "",
        quizQuestions: nextType === "quiz"
          ? (quizPayload?.questions ?? []).map((q) => ({
              ...q,
              id: q.id ?? crypto.randomUUID(),
            }))
          : [],
        quizCreationMode: nextType === "quiz" ? "manual" : null,
        quizSourceType: "video",
        quizSourceAssignmentId: "",
        quizQuestionCount: 5,
        essayQuestions: nextType === "essay_questions" && essayPayload?.questions?.length ? essayPayload.questions : [""],
        templateSubjectFilter: state.templateSubjectFilter,
        templateTypeFilter: state.templateTypeFilter,
        templatePrefillMessage: `Template loaded: ${template.title}`,
        error: null,
        successMessage: null,
        quizGenerateError: null,
      };

      return baseState;
    }

    case "APPLY_SUGGESTION": {
      const initial = FORM_INITIAL_STATE(state.classId);
      return {
        ...initial,
        createMode: "blank",
        title: action.title,
        description: action.description,
        contentType: action.nextType,
      };
    }

    case "CHANGE_CONTENT_TYPE": {
      if (state.contentType === action.contentType) {
        return state;
      }

      const nextState = {
        ...state,
        contentType: action.contentType,
        error: null,
        successMessage: null,
        templatePrefillMessage: null,
      };

      if (action.contentType === "quiz" && !action.preserveQuizState) {
        nextState.quizTitle = "";
        nextState.quizQuestions = [];
        nextState.quizCreationMode = null;
        nextState.quizSourceType = "video";
        nextState.quizSourceAssignmentId = "";
        nextState.linkedAssignmentId = "";
        nextState.quizQuestionCount = 5;
      }

      nextState.description = getDefaultAssignmentInstructions(action.contentType);

      return nextState;
    }

    case "POST_VIDEO_SAVE_QUIZ_TRANSITION": {
      return {
        ...state,
        contentType: "quiz",
        description: getDefaultAssignmentInstructions("quiz"),
        quizCreationMode: "generate",
        quizSourceType: "video",
        quizSourceAssignmentId: action.assignmentId,
        linkedAssignmentId: action.assignmentId,
        templatePrefillMessage: null,
      };
    }

    case "QUIZ_GENERATED": {
      return {
        ...state,
        contentType: "quiz",
        quizCreationMode: "generate",
        quizSourceAssignmentId: action.sourceAssignmentId,
        linkedAssignmentId: action.sourceAssignmentId,
        quizTitle: action.title,
        quizQuestions: action.questions,
        quizGenerateError: null,
        successMessage: `Quiz generated from ${action.sourceType === "video" ? "video" : "reading"} content.`,
      };
    }

    case "SELECT_QUIZ_MODE": {
      return {
        ...state,
        quizCreationMode: action.mode,
        linkedAssignmentId: "",
        quizSourceAssignmentId: "",
      };
    }

    case "SET_QUIZ_SOURCE_TYPE": {
      return {
        ...state,
        quizSourceType: action.sourceType,
        quizSourceAssignmentId: "",
        linkedAssignmentId: "",
        quizGenerateError: null,
      };
    }

    case "SET_QUIZ_SOURCE_ASSIGNMENT": {
      return {
        ...state,
        quizSourceAssignmentId: action.assignmentId,
        linkedAssignmentId: action.assignmentId,
        quizGenerateError: null,
      };
    }

    case "SET_FIELD": {
      return {
        ...state,
        [action.field]: action.value,
      };
    }

    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

function CurriculumBuilderPage() {
  const router = useRouter();
  const data = Route.useLoaderData();
  const { classId: initialClassId } = Route.useSearch();

  const [form, dispatch] = useReducer(formReducer, undefined, () =>
    FORM_INITIAL_STATE(data.classes[0]?.id ?? "")
  );

  const [drafting, setDrafting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingTemplateAssignmentId, setSavingTemplateAssignmentId] = useState<string | null>(null);
  const [transcriptModal, setTranscriptModal] = useState<{
    title: string;
    transcript: string;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AssignmentRow | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [optimisticallyDeletedAssignmentIds, setOptimisticallyDeletedAssignmentIds] = useState<Set<string>>(new Set());
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [highlightedAssignmentId, setHighlightedAssignmentId] = useState<string | null>(null);

  const [editingAssignment, setEditingAssignment] = useState<AssignmentRow | null>(null);

  // Quick Create modal state
  const [showQuickCreate, setShowQuickCreate] = useState(false);
  const [quickTitle, setQuickTitle] = useState("");
  const [quickClassId, setQuickClassId] = useState(data.classes[0]?.id ?? "");
  const [quickType, setQuickType] = useState<AssignmentType>("video");
  const [quickSaving, setQuickSaving] = useState(false);
  const [quickError, setQuickError] = useState<string | null>(null);

  // AI grading state: keyed by submissionId
  type GradingResult = { score: number; strengths: string[]; improvements: string[]; overallFeedback: string };
  const [gradingInProgress, setGradingInProgress] = useState<Set<string>>(new Set());
  const [gradingResults, setGradingResults] = useState<Map<string, GradingResult>>(new Map());
  const [gradingErrors, setGradingErrors] = useState<Map<string, string>>(new Map());
  const [releasingSubmissionIds, setReleasingSubmissionIds] = useState<Set<string>>(new Set());

  // Assignment view modal (shared AssignmentModal)
  const [viewingAssignment, setViewingAssignment] = useState<AssignmentRow | null>(null);

  // Class filter — initialised from URL search param
  const [filterClassId, setFilterClassId] = useState<string>(initialClassId ?? "all");

  // Marking period filter
  const [filterMarkingPeriodId, setFilterMarkingPeriodId] = useState<string>("all");

  // School year filter
  const [filterSchoolYear, setFilterSchoolYear] = useState<string>("all");

  // Content type filter
  const [filterContentType, setFilterContentType] = useState<string>("all");

  const handleGradeSubmission = async (
    submissionId: string,
    assignmentId: string,
    gradeLevel: string,
    rubricText?: string,
  ) => {
    setGradingInProgress((prev) => new Set(prev).add(submissionId));
    setGradingErrors((prev) => { const next = new Map(prev); next.delete(submissionId); return next; });
    try {
      const result = await gradeSubmissionWithAI({
        data: { submissionId, assignmentId, gradeLevel, rubricText },
      });
      setGradingResults((prev) => new Map(prev).set(submissionId, result));
      await router.invalidate();
    } catch {
      setGradingErrors((prev) => new Map(prev).set(submissionId, "Grading failed. Please try again."));
    } finally {
      setGradingInProgress((prev) => { const next = new Set(prev); next.delete(submissionId); return next; });
    }
  };

  const handleReleaseSubmission = async (submissionId: string) => {
    if (releasingSubmissionIds.has(submissionId)) {
      return;
    }

    // Optimistic UI: immediately remove from grading state
    const previousGradingResults = new Map(gradingResults);
    const previousGradingErrors = new Map(gradingErrors);

    setReleasingSubmissionIds((prev) => new Set(prev).add(submissionId));
    setGradingResults((prev) => {
      const next = new Map(prev);
      next.delete(submissionId);
      return next;
    });
    setGradingErrors((prev) => {
      const next = new Map(prev);
      next.delete(submissionId);
      return next;
    });

    try {
      await releaseSubmissionToStudent({
        data: {
          submissionId,
        },
      });
      await router.invalidate();
    } catch (error) {
      // Revert optimistic update on failure
      setGradingResults(previousGradingResults);
      setGradingErrors(previousGradingErrors);
      const message = error instanceof Error ? error.message : "Failed to release submission";
      alert(`Could not release submission: ${message}`);
    } finally {
      setReleasingSubmissionIds((prev) => {
        const next = new Set(prev);
        next.delete(submissionId);
        return next;
      });
    }
  };

  const newAssignmentSectionRef = useRef<HTMLElement | null>(null);
  const shouldScrollQuizBuilderToTopRef = useRef(false);
  const highlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const highlightAssignment = (assignmentId: string) => {
    setHighlightedAssignmentId(assignmentId);
    if (highlightTimeoutRef.current) {
      clearTimeout(highlightTimeoutRef.current);
    }
    highlightTimeoutRef.current = setTimeout(() => {
      setHighlightedAssignmentId((current) => (current === assignmentId ? null : current));
    }, 2000);
  };

  const jumpToAssignment = (assignmentId: string) => {
    const elementId = `assignment-${assignmentId}`;
    const destination = document.getElementById(elementId);
    if (destination) {
      destination.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    window.history.replaceState(null, "", `#${elementId}`);
    highlightAssignment(assignmentId);
  };

  useEffect(() => {
    const handleHashHighlight = () => {
      const hash = window.location.hash;
      if (!hash.startsWith("#assignment-")) {
        return;
      }
      const assignmentId = hash.slice("#assignment-".length);
      if (assignmentId) {
        highlightAssignment(assignmentId);
      }
    };

    handleHashHighlight();
    window.addEventListener("hashchange", handleHashHighlight);
    return () => {
      window.removeEventListener("hashchange", handleHashHighlight);
      if (highlightTimeoutRef.current) {
        clearTimeout(highlightTimeoutRef.current);
      }
    };
  }, []);

  const resetForm = (options?: {
    nextContentType?: AssignmentType;
    nextMode?: "template" | "blank";
    keepClassId?: boolean;
  }) => {
    dispatch({
      type: "RESET_FORM",
      nextContentType: options?.nextContentType,
      nextMode: options?.nextMode,
      keepClassId: options?.keepClassId,
      defaultClassId: data.classes[0]?.id ?? "",
    });
  };

  const applySuggestionToForm = (raw: unknown) => {
    if (!raw || typeof raw !== "object") {
      return;
    }

    const candidate = raw as { title?: unknown; type?: unknown; description?: unknown };
    if (typeof candidate.title !== "string" || typeof candidate.description !== "string") {
      return;
    }

    const validTypes: AssignmentType[] = [
      "text",
      "file",
      "url",
      "video",
      "quiz",
      "essay_questions",
      "report",
    ];

    const nextType =
      typeof candidate.type === "string" && validTypes.includes(candidate.type as AssignmentType)
        ? (candidate.type as AssignmentType)
        : "video";

    dispatch({
      type: "APPLY_SUGGESTION",
      title: candidate.title,
      description: candidate.description,
      nextType,
    });
    setShowCreateModal(true);
  };

  useEffect(() => {
    const consumeSuggestion = () => {
      try {
        const raw = sessionStorage.getItem(CHAT_SUGGESTION_STORAGE_KEY);
        if (!raw) {
          return;
        }

        sessionStorage.removeItem(CHAT_SUGGESTION_STORAGE_KEY);
        applySuggestionToForm(JSON.parse(raw));
      } catch {
        sessionStorage.removeItem(CHAT_SUGGESTION_STORAGE_KEY);
      }
    };

    consumeSuggestion();
    window.addEventListener(CHAT_SUGGESTION_EVENT, consumeSuggestion);
    return () => {
      window.removeEventListener(CHAT_SUGGESTION_EVENT, consumeSuggestion);
    };
  }, []);

  const applyTemplateToForm = (template: AssignmentTemplateRow) => {
    dispatch({
      type: "APPLY_TEMPLATE",
      template,
    });
  };

  const handleSaveAsTemplate = async (assignmentId: string, assignmentTitle: string) => {
    setSavingTemplateAssignmentId(assignmentId);
    dispatch({ type: "SET_FIELD", field: "error", value: null });
    dispatch({ type: "SET_FIELD", field: "successMessage", value: null });

    try {
      await saveAssignmentAsTemplate({
        data: {
          assignmentId,
          tags: [],
        },
      });
      await router.invalidate();
      dispatch({
        type: "SET_FIELD",
        field: "successMessage",
        value: `Saved "${assignmentTitle}" as a template.`,
      });
    } catch {
      dispatch({
        type: "SET_FIELD",
        field: "error",
        value: "Could not save that assignment as a template.",
      });
    } finally {
      setSavingTemplateAssignmentId(null);
    }
  };

  useEffect(() => {
    if (form.contentType !== "quiz") return;
    if (!shouldScrollQuizBuilderToTopRef.current) return;

    const node = newAssignmentSectionRef.current;
    if (!node) return;

    const rect = node.getBoundingClientRect();
    window.scrollTo({
      top: Math.max(0, window.scrollY + rect.top - 16),
      behavior: "smooth",
    });
    shouldScrollQuizBuilderToTopRef.current = false;
  }, [form.contentType]);

  const submitAssignment = async () => {
    if (!form.classId || !form.title.trim()) {
      dispatch({ type: "SET_FIELD", field: "error", value: "Class and title are required." });
      return;
    }

    let contentRef: string | undefined;

    if (form.contentType === "text") {
      if (!hasRichTextContent(form.textContent)) { dispatch({ type: "SET_FIELD", field: "error", value: "Reading text is required." }); return; }
      contentRef = form.textContent.trim();
    }

    if (form.contentType === "url") {
      if (!form.resourceUrl.trim()) { dispatch({ type: "SET_FIELD", field: "error", value: "A URL is required." }); return; }
      try {
        contentRef = new URL(form.resourceUrl.trim()).toString();
      } catch {
        dispatch({ type: "SET_FIELD", field: "error", value: "Please enter a valid URL." });
        return;
      }
    }

    if (form.contentType === "report") {
      if (!hasRichTextContent(form.reportPrompt)) { dispatch({ type: "SET_FIELD", field: "error", value: "Report instructions are required." }); return; }
      contentRef = form.reportPrompt.trim();
    }

    if (form.contentType === "file") {
      if (form.selectedFile) {
        try {
          const base64 = await fileToBase64(form.selectedFile);
          const uploaded = await uploadAssignmentFile({
            data: {
              filename: form.selectedFile.name,
              mimeType: form.selectedFile.type || "application/octet-stream",
              base64,
            },
          });
          contentRef = uploaded.key;
        } catch {
          dispatch({ type: "SET_FIELD", field: "error", value: "Could not upload file. Please try again." });
          return;
        }
      } else if (form.templateFileAssetKey) {
        contentRef = form.templateFileAssetKey;
      } else {
        dispatch({ type: "SET_FIELD", field: "error", value: "Choose a file to upload." });
        return;
      }
    }

    if (form.contentType === "video") {
      if (form.videos.length === 0) { dispatch({ type: "SET_FIELD", field: "error", value: "Add one YouTube video." }); return; }
      contentRef = JSON.stringify({ videos: [form.videos[0]] });
    }

    if (form.contentType === "quiz") {
      if (form.quizCreationMode === "generate") {
        if (!form.linkedAssignmentId) {
          dispatch({ type: "SET_FIELD", field: "error", value: "Generate the quiz from a saved video transcript or reading assignment first." });
          return;
        }
        if (form.quizQuestions.length === 0) { dispatch({ type: "SET_FIELD", field: "error", value: "Generate quiz questions first." }); return; }
      } else if (form.quizCreationMode === "manual") {
        if (form.quizQuestions.length === 0) { dispatch({ type: "SET_FIELD", field: "error", value: "Add at least one quiz question." }); return; }
      } else {
        dispatch({ type: "SET_FIELD", field: "error", value: "Choose whether to generate quiz questions or create them manually." });
        return;
      }
      contentRef = JSON.stringify({
        title: form.quizTitle.trim() || `${form.title.trim()} Quiz`,
        questions: form.quizQuestions,
      });
    }

    if (form.contentType === "essay_questions") {
      const filtered = form.essayQuestions.filter((q) => q.trim());
      if (filtered.length === 0) { dispatch({ type: "SET_FIELD", field: "error", value: "Add at least one question." }); return; }
      contentRef = JSON.stringify({ questions: filtered });
    }

    setSaving(true);
    dispatch({ type: "SET_FIELD", field: "error", value: null });
    dispatch({ type: "SET_FIELD", field: "successMessage", value: null });

    try {
      const dueAt = buildDueAt({ dueDate: form.dueDate, dueTime: form.dueTime, includeDueTime: form.includeDueTime });
      const created = await createAssignmentRecord({
        data: {
          classId: form.classId,
          title: form.title.trim(),
          description: form.description.trim() || undefined,
          contentType: form.contentType,
          contentRef,
          linkedAssignmentId: form.linkedAssignmentId || undefined,
          dueAt,
        },
      });
      resetForm({
        nextContentType: form.contentType,
        nextMode: form.createQuizAfterVideoSave && form.contentType === "video" ? "blank" : "template",
        keepClassId: true,
      });
      await router.invalidate();
      if (form.contentType === "video") {
        dispatch({
          type: "SET_FIELD",
          field: "successMessage",
          value: created.transcriptCached
            ? "Video saved. Transcript was also saved and is ready for quiz generation."
            : `Video saved. Transcript could not be saved (${created.transcriptStatus ?? "unavailable"}).`,
        });
        if (form.createQuizAfterVideoSave) {
          shouldScrollQuizBuilderToTopRef.current = true;
          dispatch({
            type: "POST_VIDEO_SAVE_QUIZ_TRANSITION",
            assignmentId: created.assignmentId,
          });
        }
      } else {
        dispatch({ type: "SET_FIELD", field: "successMessage", value: "Assignment created." });
      }
    } catch {
      dispatch({ type: "SET_FIELD", field: "error", value: "Unable to save assignment right now." });
    } finally {
      setSaving(false);
    }
  };

  const classAssignments = data.assignments.filter((assignment) => assignment.classId === form.classId);
  const quizSourceCandidates = classAssignments.filter((assignment) =>
    form.quizSourceType === "video"
      ? assignment.contentType === "video" && hasSavedVideoTranscript(assignment)
      : isReadingSourceAssignment(assignment),
  );
  const templateSubjectOptions = Array.from(
    new Set(data.templates.map((template) => getTemplatePrimarySubject(template))),
  ).sort((left, right) => left.localeCompare(right));
  const filteredTemplates = data.templates.filter((template) => {
    if (form.templateSubjectFilter !== "all" && getTemplatePrimarySubject(template) !== form.templateSubjectFilter) {
      return false;
    }
    if (form.templateTypeFilter !== "all" && template.contentType !== form.templateTypeFilter) {
      return false;
    }
    return true;
  });

  const generateDraftFromLinkedContent = async () => {
    if (!form.quizSourceAssignmentId) {
      dispatch({ type: "SET_FIELD", field: "quizGenerateError", value: "Choose a source assignment first." });
      return;
    }

    setDrafting(true);
    dispatch({ type: "SET_FIELD", field: "quizGenerateError", value: null });
    try {
      const result = await generateQuizFromLinkedAssignment({
        data: {
          assignmentId: form.quizSourceAssignmentId,
          questionCount: form.quizQuestionCount,
        },
      });
      const questions: QuizQuestion[] = result.quiz.questions.map((q) => ({
        id: crypto.randomUUID(),
        question: q.question,
        options: (q.options.slice(0, 4).concat(["", "", "", ""]).slice(0, 4)) as [
          string,
          string,
          string,
          string,
        ],
        answerIndex: Math.min(q.answerIndex, 3),
        explanation: q.explanation,
      }));
      dispatch({
        type: "QUIZ_GENERATED",
        title: `${result.sourceTitle} Quiz`,
        questions,
        sourceType: result.sourceType === "video" ? "video" : "text",
        sourceTitle: result.sourceTitle,
        sourceAssignmentId: form.quizSourceAssignmentId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      dispatch({ type: "SET_FIELD", field: "quizGenerateError", value: getQuizGenerationErrorMessage(message) });
    } finally {
      setDrafting(false);
    }
  };

  const handleQuickCreate = async () => {
    if (!quickClassId || !quickTitle.trim()) {
      setQuickError("Class and title are required.");
      return;
    }
    setQuickSaving(true);
    setQuickError(null);
    try {
      await createAssignmentRecord({
        data: {
          classId: quickClassId,
          title: quickTitle.trim(),
          contentType: quickType,
          description: getDefaultAssignmentInstructions(quickType),
        },
      });
      setShowQuickCreate(false);
      setQuickTitle("");
      setQuickClassId(data.classes[0]?.id ?? "");
      setQuickType("video");
      await router.invalidate();
      dispatch({
        type: "SET_FIELD",
        field: "successMessage",
        value: "Assignment created. Edit it to add content.",
      });
    } catch {
      setQuickError("Could not create assignment. Please try again.");
    } finally {
      setQuickSaving(false);
    }
  };

  // Build grouped view: video assignments with their linked children
  // Filter out optimistically deleted assignments and apply marking period filter
  // Derive available school years from classes
  const schoolYears = [...new Set(data.classes.map((c) => c.schoolYear).filter(Boolean))].sort().reverse() as string[];

  // Class → school year lookup
  const classSchoolYear = new Map(data.classes.map((c) => [c.id, c.schoolYear]));

  const visibleAssignments = data.assignments.filter((a) => {
    if (optimisticallyDeletedAssignmentIds.has(a.id)) return false;
    if (filterClassId !== "all" && a.classId !== filterClassId) return false;
    if (filterMarkingPeriodId !== "all" && a.markingPeriodId !== filterMarkingPeriodId) return false;
    if (filterSchoolYear !== "all") {
      const cls = a.classId ? classSchoolYear.get(a.classId) : null;
      if (cls !== filterSchoolYear) return false;
    }
    if (filterContentType !== "all" && a.contentType !== filterContentType) return false;
    return true;
  });
  const videoAssignments = visibleAssignments.filter((a) => a.contentType === "video");
  const linkedIds = new Set(
    visibleAssignments.flatMap((a) => (a.linkedAssignmentId ? [a.linkedAssignmentId] : [])),
  );
  const standaloneAssignments = visibleAssignments.filter(
    (a) => a.contentType !== "video" && !linkedIds.has(a.id),
  );

  // submissions grouped by assignmentId, profiles indexed by id
  const submissionsByAssignment = data.submissions.reduce<Map<string, SubmissionRow[]>>((acc, s) => {
    const list = acc.get(s.assignmentId) ?? [];
    list.push(s);
    acc.set(s.assignmentId, list);
    return acc;
  }, new Map());
  const profileById = new Map<string, ProfileRow>(data.profiles.map((p) => [p.id, p]));

  const getLinkedTo = (assignmentId: string) =>
    data.assignments.filter((a) => a.linkedAssignmentId === assignmentId);

  const handleDeleteAssignment = async (pin: string) => {
    if (!deleteTarget) return;

    // Optimistic UI: immediately hide the assignment
    const deletedAssignmentId = deleteTarget.id;
    setOptimisticallyDeletedAssignmentIds((prev) => new Set(prev).add(deletedAssignmentId));

    setDeleteLoading(true);
    setDeleteError(null);

    try {
      await deleteAssignmentRecord({
        data: {
          id: deletedAssignmentId,
          parentPin: pin,
        },
      });
      if (editingAssignment?.id === deletedAssignmentId) {
        setEditingAssignment(null);
      }
      setDeleteTarget(null);
      dispatch({ type: "SET_FIELD", field: "successMessage", value: `Assignment deleted: ${deleteTarget.title}` });
      await router.invalidate();
    } catch (error) {
      // Revert optimistic deletion on failure
      setOptimisticallyDeletedAssignmentIds((prev) => {
        const next = new Set(prev);
        next.delete(deletedAssignmentId);
        return next;
      });
      const message = error instanceof Error ? error.message : "";
      dispatch({
        type: "SET_FIELD",
        field: "error",
        value: message.includes("INVALID_PIN") || message.includes("FORBIDDEN")
          ? "Incorrect PIN. Please try again."
          : `Could not delete the assignment${message ? ` (${message})` : "."}`,
      });
    } finally {
      setDeleteLoading(false);
    }
  };

  const renderTypeSpecificFields = () => {
    if (form.contentType === "text") {
      return (
        <div className="block space-y-2 md:col-span-2">
          <span className="text-sm font-medium text-slate-700">Reading Text</span>
          <RichTextEditor
            value={form.textContent}
            onChange={(value) => dispatch({ type: "SET_FIELD", field: "textContent", value })}
            disabled={saving}
            placeholder="Paste the passage or instructions students should read."
            documentName={form.title || "reading-assignment"}
            onUploadImage={(file) => uploadInlineImageUtil(file)}
          />
        </div>
      );
    }

    if (form.contentType === "url") {
      return (
        <label className="block space-y-2 md:col-span-2">
          <span className="text-sm font-medium text-slate-700">Learning URL</span>
          <input
            value={form.resourceUrl}
            onChange={(e) => dispatch({ type: "SET_FIELD", field: "resourceUrl", value: e.target.value })}
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
            placeholder="https://www.example.com/lesson"
          />
        </label>
      );
    }

    if (form.contentType === "report") {
      return (
        <div className="block space-y-2 md:col-span-2">
          <span className="text-sm font-medium text-slate-700">Report Instructions & Rubric</span>
          <RichTextEditor
            value={form.reportPrompt}
            onChange={(value) => dispatch({ type: "SET_FIELD", field: "reportPrompt", value })}
            disabled={saving}
            placeholder="Describe the assignment, expectations, length, and grading criteria."
            documentName={form.title || "report-assignment"}
            onUploadImage={(file) => uploadInlineImageUtil(file)}
          />
        </div>
      );
    }

    if (form.contentType === "essay_questions") {
      return (
        <div className="space-y-3 md:col-span-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-slate-700">Essay Questions</span>
            <p className="text-xs text-slate-500">
              Short structured prompts — student answers each in writing.
            </p>
          </div>
          {form.essayQuestions.map((q, i) => (
            <div key={i} className="flex gap-2">
              <input
                value={q}
                onChange={(e) => {
                  const next = [...form.essayQuestions];
                  next[i] = e.target.value;
                  dispatch({ type: "SET_FIELD", field: "essayQuestions", value: next });
                }}
                className="flex-1 rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                placeholder={`Question ${i + 1}…`}
              />
              {form.essayQuestions.length > 1 ? (
                <button
                  type="button"
                  onClick={() => dispatch({ type: "SET_FIELD", field: "essayQuestions", value: form.essayQuestions.filter((_, j) => j !== i) })}
                  className="text-xs text-rose-600 hover:text-rose-800"
                >
                  Remove
                </button>
              ) : null}
            </div>
          ))}
          <button
            type="button"
            onClick={() => dispatch({ type: "SET_FIELD", field: "essayQuestions", value: [...form.essayQuestions, ""] })}
            className="text-xs font-medium text-cyan-700 hover:text-cyan-800"
          >
            + Add Question
          </button>
          <p className="text-xs text-slate-500">
            Tip: link this to a video assignment so students can navigate from the video to these questions.
          </p>
        </div>
      );
    }

    if (form.contentType === "file") {
      return (
        <label className="block space-y-2 md:col-span-2">
          <span className="text-sm font-medium text-slate-700">Attach File</span>
          <input
            type="file"
            onChange={(e) => {
              dispatch({ type: "SET_FIELD", field: "selectedFile", value: e.target.files?.[0] ?? null });
              if (e.target.files?.[0]) {
                dispatch({ type: "SET_FIELD", field: "templateFileAssetKey", value: "" });
              }
            }}
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800"
          />
          {form.selectedFile ? (
            <p className="text-xs text-slate-500">Selected: {form.selectedFile.name}</p>
          ) : form.templateFileAssetKey ? (
            <p className="text-xs text-slate-500">
              Using the file already stored in this template. Upload a new file to replace it.
            </p>
          ) : (
            <p className="text-xs text-slate-500">Upload a PDF, image, worksheet, or reference file.</p>
          )}
        </label>
      );
    }

    if (form.contentType === "video") {
      const selectedVideo = form.videos[0];
      return (
        <div className="md:col-span-2 rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
          <h3 className="text-sm font-semibold uppercase tracking-[0.14em] text-slate-700">Video Builder</h3>

          {/* Step indicator */}
          <div className="mt-3 flex items-center gap-2 text-sm">
            <span className={form.videoStep === "search" ? "font-semibold text-cyan-600" : "text-slate-400"}>
              1 Search
            </span>
            <span className="text-slate-300">→</span>
            <span className={form.videoStep === "preview" ? "font-semibold text-cyan-600" : "text-slate-400"}>
              2 Preview
            </span>
            <span className="text-slate-300">→</span>
            <span className={form.videoStep === "confirm" ? "font-semibold text-cyan-600" : "text-slate-400"}>
              3 Save
            </span>
          </div>

          <div className="mt-4">
            {form.videoStep === "search" ? (
              <VideoSearch
                videos={form.videos}
                onVideosChange={(nextVideos) => {
                  dispatch({ type: "SET_FIELD", field: "videos", value: nextVideos });
                  if (nextVideos.length > 0) {
                    dispatch({ type: "SET_FIELD", field: "videoStep", value: "preview" });
                  }
                }}
                disabled={saving}
                gradeLevel={data.classes.find((c) => c.id === form.classId)?.title}
                enableQuizGeneration={false}
              />
            ) : null}

            {form.videoStep === "preview" && selectedVideo ? (
              <div className="space-y-3">
                <div
                  className="relative w-full overflow-hidden rounded-xl bg-black"
                  style={{ paddingTop: "56.25%" }}
                >
                  <iframe
                    className="absolute inset-0 h-full w-full"
                    src={`https://www.youtube.com/embed/${selectedVideo.videoId}`}
                    title={selectedVideo.title}
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                  />
                </div>
                <p className="text-sm font-medium text-slate-900">{selectedVideo.title}</p>
                {selectedVideo.channel ? (
                  <p className="text-xs text-slate-600">Channel: {selectedVideo.channel}</p>
                ) : null}
                <p className="text-xs text-slate-500">Video ID: {selectedVideo.videoId}</p>
                <div className="flex items-center gap-3 pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      dispatch({ type: "SET_FIELD", field: "videos", value: [] });
                      dispatch({ type: "SET_FIELD", field: "videoStep", value: "search" });
                    }}
                    className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    ← Change Video
                  </button>
                  <button
                    type="button"
                    onClick={() => dispatch({ type: "SET_FIELD", field: "videoStep", value: "confirm" })}
                    className="rounded-xl bg-cyan-600 px-3 py-2 text-sm font-medium text-white hover:bg-cyan-700"
                  >
                    Looks good →
                  </button>
                </div>
              </div>
            ) : null}

            {form.videoStep === "confirm" ? (
              <div className="space-y-3">
                <label className="inline-flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={form.createQuizAfterVideoSave}
                    onChange={(e) => dispatch({ type: "SET_FIELD", field: "createQuizAfterVideoSave", value: e.target.checked })}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  Create quiz after saving this video
                </label>
                <p className="text-xs text-slate-600">
                  Saving the video also attempts to save the transcript for quiz generation.
                </p>
                <p className="text-xs text-slate-500">
                  If transcript saving fails, we will note it after save so you can retry with another video.
                </p>
                {form.createQuizAfterVideoSave ? (
                  <div className="rounded-xl border border-dashed border-cyan-300 bg-cyan-50/60 px-4 py-3">
                    <p className="text-sm font-medium text-cyan-900">Next Step: Quiz Builder</p>
                    <p className="text-xs text-cyan-800">
                      After save, we will automatically open Quiz Builder and link this saved video.
                    </p>
                  </div>
                ) : null}
                <div className="pt-1">
                  <button
                    type="button"
                    onClick={() => dispatch({ type: "SET_FIELD", field: "videoStep", value: "preview" })}
                    className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    ← Back
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      );
    }

    if (form.contentType === "quiz") {
      const selectedQuizSource = classAssignments.find((assignment) => assignment.id === form.quizSourceAssignmentId);
      return (
        <>
          <div className="md:col-span-2 rounded-2xl border bg-slate-50/80 p-4">
            {/* Mode selector — always visible */}
            <div className="grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => dispatch({ type: "SELECT_QUIZ_MODE", mode: "generate" })}
                className={`rounded-2xl border p-4 text-left transition ${
                  form.quizCreationMode === "generate"
                    ? "border-cyan-500 bg-cyan-50"
                    : "border-slate-200 bg-white hover:border-cyan-300"
                }`}
              >
                <p className="text-sm font-semibold text-slate-900">Generate Questions</p>
                <p className="mt-1 text-xs text-slate-600">
                  Build a quiz from a saved video transcript or reading assignment.
                </p>
              </button>
              <button
                type="button"
                onClick={() => dispatch({ type: "SELECT_QUIZ_MODE", mode: "manual" })}
                className={`rounded-2xl border p-4 text-left transition ${
                  form.quizCreationMode === "manual"
                    ? "border-cyan-500 bg-cyan-50"
                    : "border-slate-200 bg-white hover:border-cyan-300"
                }`}
              >
                <p className="text-sm font-semibold text-slate-900">Create Manual Questions</p>
                <p className="mt-1 text-xs text-slate-600">
                  Start with a blank quiz and write each question yourself.
                </p>
              </button>
            </div>

            {form.quizCreationMode === "generate" ? (
              <div className="mt-4 space-y-4">
                {/* Source type toggle */}
                <div>
                  <p className="mb-2 text-sm font-medium text-slate-700">Source Type</p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => dispatch({ type: "SET_QUIZ_SOURCE_TYPE", sourceType: "video" })}
                      className={`rounded-xl border px-3 py-2 text-sm font-medium ${
                        form.quizSourceType === "video"
                          ? "border-cyan-500 bg-cyan-50 text-cyan-800"
                          : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
                      }`}
                    >
                      Video
                    </button>
                    <button
                      type="button"
                      onClick={() => dispatch({ type: "SET_QUIZ_SOURCE_TYPE", sourceType: "text" })}
                      className={`rounded-xl border px-3 py-2 text-sm font-medium ${
                        form.quizSourceType === "text"
                          ? "border-cyan-500 bg-cyan-50 text-cyan-800"
                          : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
                      }`}
                    >
                      Reading
                    </button>
                  </div>
                  <p className="mt-2 text-xs text-slate-500">
                    Video quizzes use the saved transcript. Reading quizzes use the saved reading text.
                  </p>
                </div>

                {/* Source assignment select — collapses to chip once selected */}
                <div>
                  {form.quizSourceAssignmentId && selectedQuizSource ? (
                    <div className="flex items-center gap-2">
                      <span className="rounded-full border border-cyan-200 bg-cyan-50 px-3 py-1 text-xs font-medium text-cyan-800">
                        Source: {selectedQuizSource.title}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          dispatch({ type: "SET_FIELD", field: "quizSourceAssignmentId", value: "" });
                          dispatch({ type: "SET_FIELD", field: "linkedAssignmentId", value: "" });
                          dispatch({ type: "SET_FIELD", field: "quizGenerateError", value: null });
                        }}
                        className="text-xs text-slate-500 hover:text-slate-700 underline"
                      >
                        Change
                      </button>
                    </div>
                  ) : (
                    <label className="block space-y-2">
                      <span className="text-sm font-medium text-slate-700">
                        {form.quizSourceType === "video" ? "Saved Video Assignment" : "Reading Assignment"}
                      </span>
                      <select
                        value={form.quizSourceAssignmentId}
                        onChange={(e) => dispatch({ type: "SET_QUIZ_SOURCE_ASSIGNMENT", assignmentId: e.target.value })}
                        className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                      >
                        <option value="">Select source...</option>
                        {quizSourceCandidates.map((assignment) => (
                          <option key={assignment.id} value={assignment.id}>
                            {assignment.title}
                          </option>
                        ))}
                      </select>
                      {quizSourceCandidates.length === 0 ? (
                        <p className="text-xs text-slate-500">
                          {form.quizSourceType === "video"
                            ? "No saved video assignments with transcript in this class yet."
                            : "No reading assignments with saved reading text in this class yet."}
                        </p>
                      ) : null}
                    </label>
                  )}
                </div>

                {/* Question count + Generate button */}
                <div className="space-y-3">
                  <label className="block space-y-2">
                    <span className="text-sm font-medium text-slate-700">Number of Questions</span>
                    <select
                      value={String(form.quizQuestionCount)}
                      onChange={(e) => {
                        dispatch({ type: "SET_FIELD", field: "quizQuestionCount", value: Number(e.target.value) });
                        dispatch({ type: "SET_FIELD", field: "quizGenerateError", value: null });
                      }}
                      className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                    >
                      {Array.from({ length: 8 }, (_, index) => index + 3).map((count) => (
                        <option key={count} value={count}>
                          {count} questions
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      disabled={drafting || !form.quizSourceAssignmentId}
                      onClick={() => void generateDraftFromLinkedContent()}
                      className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60"
                    >
                      {drafting ? "Generating..." : "Generate Questions"}
                    </button>
                    <p className="text-xs text-slate-500">
                      Questions will be built from the stored source content.
                    </p>
                  </div>
                  {form.quizGenerateError ? (
                    <p className="text-xs font-medium text-rose-700">{form.quizGenerateError}</p>
                  ) : null}
                </div>
              </div>
            ) : null}

            {form.quizCreationMode === "manual" ? (
              <div className="mt-4 rounded-xl border border-dashed border-slate-300 bg-white px-4 py-3">
                <p className="text-sm font-medium text-slate-900">Manual mode selected</p>
                <p className="mt-1 text-xs text-slate-600">
                  Add your own questions below. No linked source is required for this quiz.
                </p>
              </div>
            ) : null}
          </div>

          <label className="block space-y-2 md:col-span-2">
            <span className="text-sm font-medium text-slate-700">Quiz Title</span>
            <input
              value={form.quizTitle}
              onChange={(e) => dispatch({ type: "SET_FIELD", field: "quizTitle", value: e.target.value })}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
              placeholder="Weekly Science Check-in"
            />
          </label>

          <div className="md:col-span-2 rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
            <h3 className="text-sm font-semibold uppercase tracking-[0.14em] text-slate-700">
              Quiz Questions
            </h3>
            <div className="mt-3">
              <QuizBuilder questions={form.quizQuestions} onChange={(questions) => dispatch({ type: "SET_FIELD", field: "quizQuestions", value: questions })} disabled={saving} />
            </div>
          </div>
        </>
      );
    }

    return null;
  };

  const renderDueFields = () => (
    <>
      <label className="space-y-2">
        <span className="text-sm font-medium text-slate-700">Due Date</span>
        <input
          type="date"
          value={form.dueDate}
          onChange={(e) => dispatch({ type: "SET_FIELD", field: "dueDate", value: e.target.value })}
          className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
        />
      </label>

      <label className="space-y-2">
        <span className="inline-flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={form.includeDueTime}
            onChange={(e) => dispatch({ type: "SET_FIELD", field: "includeDueTime", value: e.target.checked })}
            className="h-4 w-4 rounded border-slate-300"
          />
          Add specific due time
        </span>
        {form.includeDueTime ? (
          <input
            type="time"
            value={form.dueTime}
            onChange={(e) => dispatch({ type: "SET_FIELD", field: "dueTime", value: e.target.value })}
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
          />
        ) : (
          <p className="text-xs text-slate-500">
            Time is optional. If disabled, only the due date is saved.
          </p>
        )}
      </label>
    </>
  );

  return (
    <div className="space-y-6">
      <ParentPageHeader
        title="Manage Assignments"
        description="Create video lessons, quizzes, essay questions, reports, and more, then link related work so students experience it as one coherent lesson flow."
        action={(
          <button
            type="button"
            onClick={() => {
              resetForm();
              setShowCreateModal(true);
            }}
            className="rounded-xl bg-cyan-700 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-cyan-800"
          >
            New Assignment
          </button>
        )}
      />

      {!showCreateModal && form.error ? (
        <p className="text-sm text-rose-700">{form.error}</p>
      ) : null}
      {!showCreateModal && form.successMessage ? (
        <p className="text-sm text-emerald-700">{form.successMessage}</p>
      ) : null}

      {showCreateModal ? (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/50 p-4 backdrop-blur-sm">
          <div className="mx-auto w-full max-w-6xl">
            <section ref={newAssignmentSectionRef} className="rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-xl font-semibold text-slate-900">New Assignment</h2>
                <button
                  type="button"
                  onClick={() => {
                    if (saving) return;
                    setShowCreateModal(false);
                    dispatch({ type: "SET_FIELD", field: "error", value: null });
                    dispatch({ type: "SET_FIELD", field: "successMessage", value: null });
                  }}
                  className="rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
                >
                  Close
                </button>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => dispatch({ type: "SET_FIELD", field: "createMode", value: "template" })}
                  className={`rounded-xl px-4 py-2 text-sm font-medium transition ${
                    form.createMode === "template"
                      ? "bg-cyan-600 text-white shadow-sm"
                      : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
                  }`}
                >
                  Start from Template
                </button>
                <button
                  type="button"
                  onClick={() => dispatch({ type: "SET_FIELD", field: "createMode", value: "blank" })}
                  className={`rounded-xl px-4 py-2 text-sm font-medium transition ${
                    form.createMode === "blank"
                      ? "bg-slate-900 text-white shadow-sm"
                      : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
                  }`}
                >
                  Start Blank
                </button>
              </div>

              {form.createMode === "template" ? (
                <div className="mt-4 space-y-4">
                  <div className="grid gap-4 rounded-2xl border border-slate-200 bg-slate-50/80 p-4 lg:grid-cols-[1.5fr_220px_220px]">
                    <div>
                      <h3 className="text-base font-semibold text-slate-900">Choose a template</h3>
                      <p className="mt-1 text-sm text-slate-600">
                        Start with your saved templates. If shared public templates exist in your
                        data, they will appear here too. Picking a card fills the blank form so you
                        can adjust the class, due date, or content before saving.
                      </p>
                      <a href="/templates" className="mt-2 inline-block text-xs font-medium text-cyan-700 hover:underline">
                        Open Template Manager →
                      </a>
                    </div>

                    <label className="space-y-2">
                      <span className="text-sm font-medium text-slate-700">Subject</span>
                      <select
                        value={form.templateSubjectFilter}
                        onChange={(e) => dispatch({ type: "SET_FIELD", field: "templateSubjectFilter", value: e.target.value })}
                        className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                      >
                        <option value="all">All subjects</option>
                        {templateSubjectOptions.map((subject) => (
                          <option key={subject} value={subject}>
                            {humanizeTemplateTagValue(subject)}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="space-y-2">
                      <span className="text-sm font-medium text-slate-700">Type</span>
                      <select
                        value={form.templateTypeFilter}
                        onChange={(e) => dispatch({ type: "SET_FIELD", field: "templateTypeFilter", value: e.target.value as AssignmentType | "all" })}
                        className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                      >
                        <option value="all">All types</option>
                        {(Object.keys(TYPE_LABELS) as AssignmentType[]).map((type) => (
                          <option key={type} value={type}>
                            {TYPE_LABELS[type]}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  {filteredTemplates.length > 0 ? (
                    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                      {filteredTemplates.map((template) => {
                        const primarySubject = getTemplatePrimarySubject(template);
                        const gradeLabels = getTemplateGradeLabels(template).slice(0, 3);
                        const topicLabels = getTemplateTagValues(template, "topic").slice(0, 2);

                        return (
                          <button
                            key={template.id}
                            type="button"
                            onClick={() => applyTemplateToForm(template)}
                            className="rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-cyan-300 hover:shadow-md"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <span
                                className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${
                                  template.scope === "mine"
                                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                    : "border-cyan-200 bg-cyan-50 text-cyan-700"
                                }`}
                              >
                                {template.scope === "mine" ? "My Template" : "Public"}
                              </span>
                              <span
                                className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${getTypeBadgeClass(template.contentType)}`}
                              >
                                {TYPE_LABELS[template.contentType as AssignmentType] ?? template.contentType}
                              </span>
                            </div>

                            <h3 className="mt-4 text-lg font-semibold text-slate-900">{template.title}</h3>
                            <p className="mt-2 text-sm text-slate-600">
                              {template.description ?? TYPE_DESCRIPTIONS[template.contentType as AssignmentType]}
                            </p>

                            <div className="mt-4 flex flex-wrap gap-2">
                              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                                {humanizeTemplateTagValue(primarySubject)}
                              </span>
                              {topicLabels.map((topic) => (
                                <span
                                  key={`${template.id}-${topic}`}
                                  className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600"
                                >
                                  {humanizeTemplateTagValue(topic)}
                                </span>
                              ))}
                              {gradeLabels.map((grade) => (
                                <span
                                  key={`${template.id}-${grade}`}
                                  className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600"
                                >
                                  {grade}
                                </span>
                              ))}
                            </div>

                            <p className="mt-5 text-sm font-medium text-cyan-700">Use template →</p>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50/70 px-4 py-10 text-center">
                      <p className="text-sm font-medium text-slate-900">No templates match those filters.</p>
                      <p className="mt-1 text-sm text-slate-500">
                        Try another subject or type, or jump straight into a blank assignment.
                      </p>
                      <div className="mt-4 flex justify-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            dispatch({ type: "SET_FIELD", field: "templateSubjectFilter", value: "all" });
                            dispatch({ type: "SET_FIELD", field: "templateTypeFilter", value: "all" });
                          }}
                          className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
                        >
                          Clear Filters
                        </button>
                        <button
                          type="button"
                          onClick={() => dispatch({ type: "SET_FIELD", field: "createMode", value: "blank" })}
                          className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
                        >
                          Start Blank
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  {form.templatePrefillMessage ? (
                    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-emerald-200 bg-emerald-50/80 p-4">
                      <div>
                        <p className="text-sm font-semibold text-emerald-900">{form.templatePrefillMessage}</p>
                        <p className="mt-1 text-xs text-emerald-800">
                          Review the fields below and adjust anything before saving.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => dispatch({ type: "SET_FIELD", field: "createMode", value: "template" })}
                        className="rounded-xl border border-emerald-300 bg-white px-3 py-2 text-sm font-medium text-emerald-800 hover:bg-emerald-100"
                      >
                        Choose Another Template
                      </button>
                    </div>
                  ) : null}

                  <div className="mt-4 grid gap-4 md:grid-cols-2">
                    <label className="space-y-2">
                      <span className="text-sm font-medium text-slate-700">Class</span>
                      <select
                        value={form.classId}
                        onChange={(e) => dispatch({ type: "SET_FIELD", field: "classId", value: e.target.value })}
                        className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                      >
                        {data.classes.map((row) => (
                          <option key={row.id} value={row.id}>{row.title}</option>
                        ))}
                      </select>
                    </label>

                    <label className="space-y-2">
                      <span className="text-sm font-medium text-slate-700">Assignment Type</span>
                      <select
                        value={form.contentType}
                        onChange={(e) => dispatch({ type: "CHANGE_CONTENT_TYPE", contentType: e.target.value as AssignmentType })}
                        className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                      >
                        {(Object.keys(TYPE_LABELS) as AssignmentType[]).map((t) => (
                          <option key={t} value={t}>{TYPE_LABELS[t]}</option>
                        ))}
                      </select>
                      <p className="text-xs text-slate-500">{TYPE_DESCRIPTIONS[form.contentType]}</p>
                    </label>

                    <label className="space-y-2 md:col-span-2">
                      <span className="text-sm font-medium text-slate-700">Title</span>
                      <input
                        value={form.title}
                        onChange={(e) => dispatch({ type: "SET_FIELD", field: "title", value: e.target.value })}
                        className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                        placeholder="e.g. The Water Cycle — Video Lesson"
                      />
                    </label>

                    {form.contentType === "video" || form.contentType === "quiz" ? renderDueFields() : null}

                    {renderTypeSpecificFields()}

                    <label className="space-y-2 md:col-span-2">
                      <span className="text-sm font-medium text-slate-700">Assignment Instructions</span>
                      <textarea
                        value={form.description}
                        onChange={(e) => dispatch({ type: "SET_FIELD", field: "description", value: e.target.value })}
                        className="min-h-20 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                      />
                    </label>

                    {data.assignments.length > 0 && form.contentType !== "video" && form.contentType !== "quiz" ? (
                      <label className="space-y-2 md:col-span-2">
                        <span className="text-sm font-medium text-slate-700">
                          Link to Assignment (optional)
                        </span>
                        <p className="text-xs text-slate-500">
                          Attach this to a video lesson or another assignment so students can navigate between them.
                        </p>
                        <select
                          value={form.linkedAssignmentId}
                          onChange={(e) => dispatch({ type: "SET_FIELD", field: "linkedAssignmentId", value: e.target.value })}
                          className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                        >
                          <option value="">— None —</option>
                          {data.assignments.map((a) => (
                            <option key={a.id} value={a.id}>
                              {TYPE_LABELS[a.contentType as AssignmentType] ?? a.contentType}: {a.title}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}

                    {form.contentType !== "video" && form.contentType !== "quiz" ? renderDueFields() : null}
                  </div>
                </>
              )}

              {form.error ? <p className="mt-3 text-sm text-rose-700">{form.error}</p> : null}
              {form.successMessage ? <p className="mt-3 text-sm text-emerald-700">{form.successMessage}</p> : null}

              <div className="mt-4 flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (saving) return;
                    setShowCreateModal(false);
                    dispatch({ type: "SET_FIELD", field: "error", value: null });
                    dispatch({ type: "SET_FIELD", field: "successMessage", value: null });
                  }}
                  className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
                >
                  Cancel
                </button>
                <button
                  disabled={saving || (form.createMode === "blank" && data.classes.length === 0)}
                  onClick={() => {
                    if (form.createMode === "template") {
                      dispatch({ type: "SET_FIELD", field: "createMode", value: "blank" });
                      return;
                    }
                    void submitAssignment();
                  }}
                  className="rounded-xl bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {form.createMode === "template"
                    ? "Start Blank"
                    : saving
                      ? "Saving…"
                      : form.contentType === "video"
                        ? "Save Video"
                        : "Create Assignment"}
                </button>
              </div>
            </section>
          </div>
        </div>
      ) : null}

      {/* Published Assignments */}
      <section className="rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 className="text-xl font-semibold text-slate-900">Published Assignments</h2>
          <div className="flex flex-wrap items-center gap-2">
            {data.classes.length > 0 && (
              <select
                value={filterClassId}
                onChange={(e) => setFilterClassId(e.target.value)}
                className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 shadow-sm"
              >
                <option value="all">All Classes</option>
                {data.classes.map((c) => (
                  <option key={c.id} value={c.id}>{c.title}</option>
                ))}
              </select>
            )}
            {data.markingPeriods.length > 0 && (
              <select
                value={filterMarkingPeriodId}
                onChange={(e) => setFilterMarkingPeriodId(e.target.value)}
                className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 shadow-sm"
              >
                <option value="all">All Periods</option>
                {data.markingPeriods.map(p => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
            )}
            {schoolYears.length > 0 && (
              <select
                value={filterSchoolYear}
                onChange={(e) => setFilterSchoolYear(e.target.value)}
                className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 shadow-sm"
              >
                <option value="all">All Years</option>
                {schoolYears.map(y => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            )}
            <select
              value={filterContentType}
              onChange={(e) => setFilterContentType(e.target.value)}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 shadow-sm"
            >
              <option value="all">All Types</option>
              {(["text","file","url","video","quiz","essay_questions","report","movie"] as AssignmentType[]).map(t => (
                <option key={t} value={t}>{TYPE_LABELS[t]}</option>
              ))}
            </select>
            {(filterClassId !== "all" || filterMarkingPeriodId !== "all" || filterSchoolYear !== "all" || filterContentType !== "all") && (
              <button
                type="button"
                onClick={() => { setFilterClassId("all"); setFilterMarkingPeriodId("all"); setFilterSchoolYear("all"); setFilterContentType("all"); }}
                className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-500 hover:bg-slate-50"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        <div className="mt-4 space-y-4">
          {/* Video lessons with their linked assignments grouped */}
          {videoAssignments.map((video) => {
            const videoPayload = parseJson<VideoPayload>(video.contentRef);
            const storedTranscript = getSavedVideoTranscript(video.contentRef);
            const linked = getLinkedTo(video.id);

            return (
              <article
                key={video.id}
                id={`assignment-${video.id}`}
                className={`rounded-2xl border border-slate-200 overflow-hidden transition-all duration-300 ${
                  highlightedAssignmentId === video.id
                    ? "bg-cyan-50 ring-2 ring-cyan-300 shadow-md"
                    : "bg-slate-50/80"
                }`}
              >
                {/* Video row */}
                <div className="flex items-start justify-between gap-4 p-5">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold uppercase tracking-wide ${getTypeBadgeClass(video.contentType)}`}
                      >
                        {TYPE_LABELS[video.contentType as AssignmentType] ?? video.contentType}
                      </span>
                      {video.markingPeriodId && (
                        <span className="inline-flex items-center rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700">
                          {data.markingPeriods.find(p => p.id === video.markingPeriodId)?.label ?? "Period"}
                        </span>
                      )}
                      {data.markingPeriods.length > 0 && (
                        <select
                          value={video.markingPeriodId ?? ""}
                          onChange={async (e) => {
                            await assignAssignmentToMarkingPeriod({ data: { assignmentId: video.id, markingPeriodId: e.target.value || null } });
                            await router.invalidate();
                          }}
                          className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-xs text-slate-600"
                        >
                          <option value="">No period</option>
                          {data.markingPeriods.map(p => (
                            <option key={p.id} value={p.id}>{p.label}</option>
                          ))}
                        </select>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => setViewingAssignment(video)}
                      className="mt-0.5 text-left text-lg font-semibold text-slate-900 hover:text-cyan-700 hover:underline truncate"
                    >
                      {video.title}
                    </button>
                    {video.description ? (
                      <p className="mt-1 text-sm text-slate-600 line-clamp-2">{video.description}</p>
                    ) : null}
                    <p className="mt-1 text-xs text-slate-500">
                      {videoPayload?.videos?.length
                        ? `${videoPayload.videos.length} video${videoPayload.videos.length === 1 ? "" : "s"}`
                        : "Video lesson"}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {hasSavedVideoTranscript(video)
                        ? "Transcript cached and ready for quiz generation."
                        : "Transcript not cached yet."}
                    </p>
                    {!storedTranscript ? (
                      <p className="mt-1 text-xs text-amber-700">
                        No transcript stored for this video.
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-start gap-2">
                    <button
                      type="button"
                      disabled={!storedTranscript}
                      onClick={() => {
                        if (!storedTranscript) return;
                        setTranscriptModal({
                          title: video.title,
                          transcript: storedTranscript,
                        });
                      }}
                      className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      View Transcript
                    </button>
                  </div>
                </div>

                {/* Linked assignments */}
                {linked.length > 0 ? (
                  <div className="border-t border-slate-200 bg-white px-5 py-3">
                    <p className="text-xs font-medium text-slate-600">Linked assignments:</p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                      {linked.map((child) => (
                        <a
                          key={child.id}
                          href={`#assignment-${child.id}`}
                          onClick={(event) => {
                            event.preventDefault();
                            jumpToAssignment(child.id);
                          }}
                          className="inline-flex items-center gap-1 text-xs font-medium text-cyan-700 hover:text-cyan-800 hover:underline"
                        >
                          <span className="text-slate-400">↳</span>
                          <span>{child.title}</span>
                        </a>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="border-t border-dashed border-slate-200 px-5 py-3">
                    <p className="text-xs text-slate-400 italic">
                      No linked assignments yet — create a Quiz or Essay Questions and link it to this video.
                    </p>
                  </div>
                )}
              </article>
            );
          })}

          {/* Non-video, non-linked assignments */}
          {standaloneAssignments.map((row) => {
            const quizPayload = parseJson<QuizPayload>(row.contentRef);
            const essayPayload = parseJson<EssayQuestionsPayload>(row.contentRef);
            const isGradable = row.contentType === "essay_questions" || row.contentType === "report";
            const rowSubmissions = isGradable ? (submissionsByAssignment.get(row.id) ?? []) : [];

            return (
              <div
                key={row.id}
                id={`assignment-${row.id}`}
                className={`rounded-2xl border border-slate-200 transition-all duration-300 ${
                  highlightedAssignmentId === row.id
                    ? "ring-2 ring-cyan-300 shadow-md"
                    : ""
                }`}
              >
                <article
                  className={`flex items-start justify-between gap-4 p-5 ${
                    highlightedAssignmentId === row.id ? "bg-cyan-50" : "bg-slate-50/80"
                  } ${isGradable && rowSubmissions.length > 0 ? "rounded-t-2xl" : "rounded-2xl"}`}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p
                        className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold uppercase tracking-wide ${getTypeBadgeClass(row.contentType)}`}
                      >
                        {TYPE_LABELS[row.contentType as AssignmentType] ?? row.contentType}
                      </p>
                      {row.markingPeriodId && (
                        <span className="inline-flex items-center rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700">
                          {data.markingPeriods.find(p => p.id === row.markingPeriodId)?.label ?? "Period"}
                        </span>
                      )}
                      {data.markingPeriods.length > 0 && (
                        <select
                          value={row.markingPeriodId ?? ""}
                          onChange={async (e) => {
                            await assignAssignmentToMarkingPeriod({ data: { assignmentId: row.id, markingPeriodId: e.target.value || null } });
                            await router.invalidate();
                          }}
                          className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-xs text-slate-600"
                        >
                          <option value="">No period</option>
                          {data.markingPeriods.map(p => (
                            <option key={p.id} value={p.id}>{p.label}</option>
                          ))}
                        </select>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => setViewingAssignment(row)}
                      className="mt-0.5 text-left text-lg font-semibold text-slate-900 hover:text-cyan-700 hover:underline truncate"
                    >
                      {row.title}
                    </button>
                    {row.description ? (
                      <p className="mt-1 text-sm text-slate-600 line-clamp-2">{row.description}</p>
                    ) : null}

                    {row.contentType === "url" && row.contentRef ? (
                      <a
                        href={row.contentRef}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-2 inline-block text-sm font-medium text-cyan-700 hover:underline"
                      >
                        Open Link
                      </a>
                    ) : null}

                    {row.contentType === "quiz" && quizPayload?.questions?.length ? (
                      <p className="mt-1 text-xs text-slate-500">
                        {quizPayload.questions.length} question{quizPayload.questions.length === 1 ? "" : "s"}
                      </p>
                    ) : null}

                    {row.contentType === "essay_questions" && essayPayload?.questions?.length ? (
                      <p className="mt-1 text-xs text-slate-500">
                        {essayPayload.questions.length} question{essayPayload.questions.length === 1 ? "" : "s"}
                      </p>
                    ) : null}

                    {row.contentType === "text" && row.contentRef ? (
                      <p className="mt-2 text-sm text-slate-600 line-clamp-2">
                        {summarizeRichText(row.contentRef)}
                      </p>
                    ) : null}

                    {row.contentType === "report" && row.contentRef ? (
                      <p className="mt-2 text-sm text-slate-600 line-clamp-2">
                        {summarizeRichText(row.contentRef)}
                      </p>
                    ) : null}
                  </div>

                  {null /* actions moved to AssignmentModal */}
                </article>

                {/* Submission rows for essay/report assignments */}
                {isGradable && rowSubmissions.length > 0 ? (
                  <div className="border-t border-slate-200 divide-y divide-slate-100 bg-white rounded-b-2xl">
                    {rowSubmissions.map((sub) => {
                      const profile = profileById.get(sub.profileId);
                      const isGrading = gradingInProgress.has(sub.id);
                      const isReleasing = releasingSubmissionIds.has(sub.id);
                      const localResult = gradingResults.get(sub.id);
                      const gradingError = gradingErrors.get(sub.id);
                      const storedFeedback = sub.feedbackJson
                        ? (() => { try { return JSON.parse(sub.feedbackJson) as GradingResult; } catch { return null; } })()
                        : null;
                      const feedback = localResult ?? storedFeedback;

                      return (
                        <div key={sub.id} className="px-5 py-3 space-y-2">
                          <div className="flex items-center justify-between gap-3">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="text-sm font-medium text-slate-800 truncate">
                                {profile?.displayName ?? "Student"}
                              </span>
                              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
                                sub.status === "graded"
                                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                  : "border-amber-200 bg-amber-50 text-amber-700"
                              }`}>
                                {sub.status === "graded" ? `Graded · ${sub.score ?? "—"}/100` : "Submitted"}
                              </span>
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                              <button
                                type="button"
                                disabled={isGrading || isReleasing}
                                onClick={() =>
                                  void handleGradeSubmission(
                                    sub.id,
                                    row.id,
                                    profile?.gradeLevel ?? "mixed",
                                  )
                                }
                                className="rounded-lg border border-violet-200 bg-violet-50 px-3 py-1.5 text-xs font-medium text-violet-700 hover:bg-violet-100 disabled:opacity-60"
                              >
                                {isGrading ? "Grading…" : sub.status === "graded" ? "Re-grade with AI" : "AI Grade"}
                              </button>
                              {(sub.status === "submitted" || sub.status === "graded" || sub.status === "draft") ? (
                                <button
                                  type="button"
                                  disabled={isReleasing || isGrading}
                                  onClick={() => void handleReleaseSubmission(sub.id)}
                                  className="rounded-lg border border-cyan-200 bg-cyan-50 px-3 py-1.5 text-xs font-medium text-cyan-700 hover:bg-cyan-100 disabled:opacity-60"
                                >
                                  {isReleasing ? "Releasing…" : "Release"}
                                </button>
                              ) : null}
                            </div>
                          </div>

                          {gradingError ? (
                            <p className="text-xs text-rose-600">{gradingError}</p>
                          ) : null}

                          {feedback ? (
                            <div className="space-y-2 pt-1">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-semibold text-slate-900">Score: {feedback.score}/100</span>
                              </div>
                              <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 space-y-1">
                                <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Strengths</p>
                                <ul className="space-y-0.5">
                                  {feedback.strengths.map((s, i) => (
                                    <li key={i} className="text-sm text-emerald-800">• {s}</li>
                                  ))}
                                </ul>
                              </div>
                              {feedback.improvements.length > 0 ? (
                                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 space-y-1">
                                  <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">Areas to Improve</p>
                                  <ul className="space-y-0.5">
                                    {feedback.improvements.map((s, i) => (
                                      <li key={i} className="text-sm text-amber-800">• {s}</li>
                                    ))}
                                  </ul>
                                </div>
                              ) : null}
                              <p className="text-sm text-slate-600 italic">{feedback.overallFeedback}</p>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}

          {data.assignments.length === 0 ? (
            <p className="text-sm text-slate-500">No assignments published yet.</p>
          ) : null}
        </div>
      </section>

      {/* View/edit modal (shared) */}
      {viewingAssignment ? (
        <AssignmentModal
          assignment={viewingAssignment as ModalAssignment}
          allAssignments={data.assignments as ModalAssignment[]}
          canEdit={true}
          onClose={() => setViewingAssignment(null)}
          onSaved={async () => {
            setViewingAssignment(null);
            await router.invalidate();
          }}
          onRequestDelete={(a) => {
            setViewingAssignment(null);
            setDeleteError(null);
            setDeleteTarget(data.assignments.find(x => x.id === a.id) ?? null);
          }}
        />
      ) : null}

      {/* Edit modal */}
      {editingAssignment ? (
        <EditAssignmentModal
          assignment={editingAssignment}
          allAssignments={data.assignments}
          onSave={async () => {
            setEditingAssignment(null);
            await router.invalidate();
          }}
          onRequestDelete={(assignment) => {
            setEditingAssignment(null);
            setDeleteError(null);
            setDeleteTarget(assignment);
          }}
          onClose={() => setEditingAssignment(null)}
        />
      ) : null}

      <DeleteConfirmModal
        open={deleteTarget !== null}
        itemLabel="Assignment"
        itemName={deleteTarget?.title ?? ""}
        onConfirm={(pin) => void handleDeleteAssignment(pin)}
        onCancel={() => {
          setDeleteTarget(null);
          setDeleteError(null);
        }}
        error={deleteError}
        loading={deleteLoading}
        pinLength={data.parentPinLength}
      />

      {transcriptModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
          <div className="w-full max-w-3xl rounded-2xl border border-slate-200 bg-white shadow-2xl">
            <div className="flex items-center justify-between gap-4 border-b border-slate-200 px-6 py-4">
              <div>
                <p className="text-xs uppercase tracking-wide text-slate-500">Saved Transcript</p>
                <h2 className="text-lg font-semibold text-slate-900">{transcriptModal.title}</h2>
              </div>
              <button
                type="button"
                onClick={() => setTranscriptModal(null)}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
              >
                Close
              </button>
            </div>
            <div className="max-h-[70vh] overflow-y-auto px-6 py-5">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="whitespace-pre-wrap text-sm leading-6 text-slate-700">
                  {transcriptModal.transcript}
                </p>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* Quick Create modal */}
      {showQuickCreate ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white shadow-2xl">
            <div className="flex items-center justify-between gap-4 border-b border-slate-200 px-6 py-4">
              <h2 className="text-lg font-semibold text-slate-900">Quick Add</h2>
              <button
                type="button"
                onClick={() => {
                  setShowQuickCreate(false);
                  setQuickError(null);
                }}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
              >
                Close
              </button>
            </div>
            <div className="space-y-4 px-6 py-5">
              <label className="block space-y-1">
                <span className="text-sm font-medium text-slate-700">Class</span>
                <select
                  value={quickClassId}
                  onChange={(e) => setQuickClassId(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                >
                  {data.classes.map((row) => (
                    <option key={row.id} value={row.id}>{row.title}</option>
                  ))}
                </select>
              </label>
              <label className="block space-y-1">
                <span className="text-sm font-medium text-slate-700">Assignment Type</span>
                <select
                  value={quickType}
                  onChange={(e) => setQuickType(e.target.value as AssignmentType)}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                >
                  {(Object.keys(TYPE_LABELS) as AssignmentType[]).map((t) => (
                    <option key={t} value={t}>{TYPE_LABELS[t]}</option>
                  ))}
                </select>
              </label>
              <label className="block space-y-1">
                <span className="text-sm font-medium text-slate-700">Title</span>
                <input
                  value={quickTitle}
                  onChange={(e) => setQuickTitle(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                  placeholder="e.g. The Water Cycle — Video Lesson"
                />
              </label>
              <p className="text-xs text-slate-500">
                For full options (content, due date, linking),{" "}
                <button
                  type="button"
                  onClick={() => {
                    setShowQuickCreate(false);
                    resetForm({
                      nextContentType: quickType,
                      nextMode: "blank",
                      keepClassId: true,
                    });
                    dispatch({ type: "SET_FIELD", field: "classId", value: quickClassId });
                    setShowCreateModal(true);
                  }}
                  className="font-medium text-cyan-700 hover:text-cyan-800 underline"
                >
                  open Advanced →
                </button>
              </p>
              {quickError ? <p className="text-sm text-rose-700">{quickError}</p> : null}
            </div>
            <div className="flex justify-end gap-3 border-t border-slate-200 px-6 py-4">
              <button
                type="button"
                onClick={() => {
                  setShowQuickCreate(false);
                  setQuickError(null);
                }}
                className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={quickSaving || !quickTitle.trim() || !quickClassId}
                onClick={() => void handleQuickCreate()}
                className="rounded-xl bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-60"
              >
                {quickSaving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Quick Add floating button — sits above the LessonPlannerChat button */}
      <button
        type="button"
        onClick={() => {
          setQuickError(null);
          setShowQuickCreate(true);
        }}
        className="fixed bottom-[4.5rem] right-6 z-[39] rounded-full border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 shadow-md hover:bg-slate-50"
      >
        + Quick Add
      </button>

    </div>
  );
}
