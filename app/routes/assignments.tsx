import { useEffect, useRef, useState } from "react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { DeleteConfirmModal } from "../components/delete-confirm-modal";
import { QuizBuilder, type QuizQuestion } from "../components/quiz-builder";
import { RichContent } from "../components/rich-content";
import { RichTextEditor } from "../components/rich-text-editor";
import { VideoSearch, type VideoData } from "../components/video-search";
import {
  createAssignmentRecord,
  deleteAssignmentRecord,
  generateQuizFromLinkedAssignment,
  getCurriculumBuilderData,
  getViewerContext,
  updateAssignmentRecord,
  uploadAssignmentFile,
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

type AssignmentType = "text" | "file" | "url" | "video" | "quiz" | "essay_questions" | "report";

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

const TYPE_LABELS: Record<AssignmentType, string> = {
  text: "Reading",
  file: "File",
  url: "Link",
  video: "Video Lesson",
  quiz: "Quiz",
  essay_questions: "Essay Questions",
  report: "Report",
};

const TYPE_DESCRIPTIONS: Record<AssignmentType, string> = {
  text: "A passage or text for the student to read.",
  file: "A PDF, worksheet, or image to download.",
  url: "An external resource link.",
  video: "A YouTube video lesson.",
  quiz: "Multiple-choice questions.",
  essay_questions: "Short structured prompts the student answers in writing — can be linked to a video.",
  report: "A long-form writing assignment with a rubric or instructions.",
};

const TYPE_BADGE_STYLES: Record<AssignmentType, string> = {
  video: "bg-cyan-50 text-cyan-800 border-cyan-200",
  quiz: "bg-violet-50 text-violet-800 border-violet-200",
  text: "bg-emerald-50 text-emerald-800 border-emerald-200",
  file: "bg-amber-50 text-amber-800 border-amber-200",
  url: "bg-sky-50 text-sky-800 border-sky-200",
  essay_questions: "bg-rose-50 text-rose-800 border-rose-200",
  report: "bg-indigo-50 text-indigo-800 border-indigo-200",
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

  const uploadInlineImage = async (file: File) => {
    const base64 = await fileToBase64(file);
    const uploaded = await uploadAssignmentFile({
      data: {
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        base64,
      },
    });

    return { key: uploaded.key };
  };

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
                onUploadImage={(file) => uploadInlineImage(file)}
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
                onUploadImage={(file) => uploadInlineImage(file)}
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

function CurriculumBuilderPage() {
  const router = useRouter();
  const data = Route.useLoaderData();

  const [classId, setClassId] = useState(data.classes[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState(getDefaultAssignmentInstructions("video"));
  const [contentType, setContentType] = useState<AssignmentType>("video");
  const [dueDate, setDueDate] = useState("");
  const [dueTime, setDueTime] = useState("23:59");
  const [includeDueTime, setIncludeDueTime] = useState(false);
  const [linkedAssignmentId, setLinkedAssignmentId] = useState("");

  const [textContent, setTextContent] = useState("");
  const [resourceUrl, setResourceUrl] = useState("");
  const [reportPrompt, setReportPrompt] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [videos, setVideos] = useState<VideoData[]>([]);
  const [createQuizAfterVideoSave, setCreateQuizAfterVideoSave] = useState(false);
  const [videoAccordionOpen, setVideoAccordionOpen] = useState<{
    step1: boolean;
    step2: boolean;
    step3: boolean;
  }>({
    step1: true,
    step2: true,
    step3: true,
  });
  const [quizTitle, setQuizTitle] = useState("");
  const [quizQuestions, setQuizQuestions] = useState<QuizQuestion[]>([]);
  const [quizCreationMode, setQuizCreationMode] = useState<"generate" | "manual" | null>(null);
  const [quizSourceType, setQuizSourceType] = useState<"video" | "text">("video");
  const [quizSourceAssignmentId, setQuizSourceAssignmentId] = useState("");
  const [quizQuestionCount, setQuizQuestionCount] = useState(5);
  const [quizAccordionOpen, setQuizAccordionOpen] = useState({
    step1: true,
    step2: false,
    step3: false,
    step4: false,
  });
  const [essayQuestions, setEssayQuestions] = useState<string[]>([""]);

  const [drafting, setDrafting] = useState(false);
  const [quizGenerateError, setQuizGenerateError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [transcriptModal, setTranscriptModal] = useState<{
    title: string;
    transcript: string;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AssignmentRow | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [highlightedAssignmentId, setHighlightedAssignmentId] = useState<string | null>(null);

  const [editingAssignment, setEditingAssignment] = useState<AssignmentRow | null>(null);
  const newAssignmentSectionRef = useRef<HTMLElement | null>(null);
  const videoStep1Ref = useRef<HTMLDivElement | null>(null);
  const videoStep2Ref = useRef<HTMLDivElement | null>(null);
  const videoStep3Ref = useRef<HTMLDivElement | null>(null);
  const stepToCenterRef = useRef<"step1" | "step2" | "step3" | null>(null);
  const quizStep1Ref = useRef<HTMLDivElement | null>(null);
  const quizStep2Ref = useRef<HTMLDivElement | null>(null);
  const quizStep3Ref = useRef<HTMLDivElement | null>(null);
  const quizStep4Ref = useRef<HTMLDivElement | null>(null);
  const quizStepToCenterRef = useRef<"step1" | "step2" | "step3" | "step4" | null>(null);
  const shouldScrollQuizBuilderToTopRef = useRef(false);
  const preserveNextQuizTypeStateRef = useRef(false);
  const previousTypeRef = useRef<AssignmentType>("video");
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

  const uploadInlineImage = async (file: File) => {
    const base64 = await fileToBase64(file);
    const uploaded = await uploadAssignmentFile({
      data: {
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        base64,
      },
    });

    return { key: uploaded.key };
  };

  const resetForm = () => {
    setTitle("");
    setDescription(getDefaultAssignmentInstructions(contentType));
    setDueDate("");
    setDueTime("23:59");
    setIncludeDueTime(false);
    setLinkedAssignmentId("");
    setTextContent("");
    setResourceUrl("");
    setReportPrompt("");
    setSelectedFile(null);
    setVideos([]);
    setCreateQuizAfterVideoSave(false);
    setVideoAccordionOpen({
      step1: true,
      step2: true,
      step3: true,
    });
    setQuizTitle("");
    setQuizQuestions([]);
    setQuizCreationMode(null);
    setQuizSourceType("video");
    setQuizSourceAssignmentId("");
    setQuizQuestionCount(5);
    setQuizAccordionOpen({
      step1: true,
      step2: false,
      step3: false,
      step4: false,
    });
    setEssayQuestions([""]);
    setError(null);
    setQuizGenerateError(null);
    setSuccessMessage(null);
  };

  useEffect(() => {
    if (contentType !== "video") return;
    const stepToCenter = stepToCenterRef.current;
    if (!stepToCenter) return;

    const isOpen =
      stepToCenter === "step1"
        ? videoAccordionOpen.step1
        : stepToCenter === "step2"
          ? videoAccordionOpen.step2
          : videoAccordionOpen.step3;
    if (!isOpen) return;

    const node =
      stepToCenter === "step1"
        ? videoStep1Ref.current
        : stepToCenter === "step2"
          ? videoStep2Ref.current
          : videoStep3Ref.current;
    if (!node) return;

    const rect = node.getBoundingClientRect();
    const targetTop = window.scrollY + rect.top - window.innerHeight / 2;
    window.scrollTo({
      top: Math.max(0, targetTop),
      behavior: "smooth",
    });
    stepToCenterRef.current = null;
  }, [contentType, videoAccordionOpen.step1, videoAccordionOpen.step2, videoAccordionOpen.step3, videos.length]);

  useEffect(() => {
    const stepToCenter = quizStepToCenterRef.current;
    if (contentType !== "quiz" || !stepToCenter) return;

    const isOpen =
      stepToCenter === "step1"
        ? quizAccordionOpen.step1
        : stepToCenter === "step2"
          ? quizAccordionOpen.step2
          : stepToCenter === "step3"
            ? quizAccordionOpen.step3
            : quizAccordionOpen.step4;
    if (!isOpen) return;

    const node =
      stepToCenter === "step1"
        ? quizStep1Ref.current
        : stepToCenter === "step2"
          ? quizStep2Ref.current
          : stepToCenter === "step3"
            ? quizStep3Ref.current
            : quizStep4Ref.current;
    if (!node) return;

    const rect = node.getBoundingClientRect();
    const targetTop = window.scrollY + rect.top - window.innerHeight / 2;
    window.scrollTo({
      top: Math.max(0, targetTop),
      behavior: "smooth",
    });
    quizStepToCenterRef.current = null;
  }, [contentType, quizAccordionOpen.step1, quizAccordionOpen.step2, quizAccordionOpen.step3, quizAccordionOpen.step4]);

  useEffect(() => {
    const previousType = previousTypeRef.current;
    if (previousType === contentType) return;

    setDescription(getDefaultAssignmentInstructions(contentType));

    if (contentType === "quiz") {
      if (preserveNextQuizTypeStateRef.current) {
        preserveNextQuizTypeStateRef.current = false;
      } else {
        setQuizTitle("");
        setQuizQuestions([]);
        setQuizCreationMode(null);
        setQuizSourceType("video");
        setQuizSourceAssignmentId("");
        setLinkedAssignmentId("");
        setQuizQuestionCount(5);
        setQuizAccordionOpen({
          step1: true,
          step2: false,
          step3: false,
          step4: false,
        });
      }
    }

    previousTypeRef.current = contentType;
  }, [contentType]);

  useEffect(() => {
    if (contentType !== "quiz") return;
    if (!shouldScrollQuizBuilderToTopRef.current) return;

    const node = newAssignmentSectionRef.current;
    if (!node) return;

    const rect = node.getBoundingClientRect();
    window.scrollTo({
      top: Math.max(0, window.scrollY + rect.top - 16),
      behavior: "smooth",
    });
    shouldScrollQuizBuilderToTopRef.current = false;
  }, [contentType]);

  const submitAssignment = async () => {
    if (!classId || !title.trim()) {
      setError("Class and title are required.");
      return;
    }

    let contentRef: string | undefined;

    if (contentType === "text") {
      if (!hasRichTextContent(textContent)) { setError("Reading text is required."); return; }
      contentRef = textContent.trim();
    }

    if (contentType === "url") {
      if (!resourceUrl.trim()) { setError("A URL is required."); return; }
      try {
        contentRef = new URL(resourceUrl.trim()).toString();
      } catch {
        setError("Please enter a valid URL.");
        return;
      }
    }

    if (contentType === "report") {
      if (!hasRichTextContent(reportPrompt)) { setError("Report instructions are required."); return; }
      contentRef = reportPrompt.trim();
    }

    if (contentType === "file") {
      if (!selectedFile) { setError("Choose a file to upload."); return; }
      try {
        const base64 = await fileToBase64(selectedFile);
        const uploaded = await uploadAssignmentFile({
          data: {
            filename: selectedFile.name,
            mimeType: selectedFile.type || "application/octet-stream",
            base64,
          },
        });
        contentRef = uploaded.key;
      } catch {
        setError("Could not upload file. Please try again.");
        return;
      }
    }

    if (contentType === "video") {
      if (videos.length === 0) { setError("Add one YouTube video."); return; }
      contentRef = JSON.stringify({ videos: [videos[0]] });
    }

    if (contentType === "quiz") {
      if (quizCreationMode === "generate") {
        if (!linkedAssignmentId) {
          setError("Generate the quiz from a saved video transcript or reading assignment first.");
          return;
        }
        if (quizQuestions.length === 0) { setError("Generate quiz questions first."); return; }
      } else if (quizCreationMode === "manual") {
        if (quizQuestions.length === 0) { setError("Add at least one quiz question."); return; }
      } else {
        setError("Choose whether to generate quiz questions or create them manually.");
        return;
      }
      contentRef = JSON.stringify({
        title: quizTitle.trim() || `${title.trim()} Quiz`,
        questions: quizQuestions,
      });
    }

    if (contentType === "essay_questions") {
      const filtered = essayQuestions.filter((q) => q.trim());
      if (filtered.length === 0) { setError("Add at least one question."); return; }
      contentRef = JSON.stringify({ questions: filtered });
    }

    setSaving(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const dueAt = buildDueAt({ dueDate, dueTime, includeDueTime });
      const created = await createAssignmentRecord({
        data: {
          classId,
          title: title.trim(),
          description: description.trim() || undefined,
          contentType,
          contentRef,
          linkedAssignmentId: linkedAssignmentId || undefined,
          dueAt,
        },
      });
      resetForm();
      await router.invalidate();
      if (contentType === "video") {
        setSuccessMessage(
          created.transcriptCached
            ? "Video saved. Transcript was also saved and is ready for quiz generation."
            : `Video saved. Transcript could not be saved (${created.transcriptStatus ?? "unavailable"}).`,
        );
        if (createQuizAfterVideoSave) {
          shouldScrollQuizBuilderToTopRef.current = true;
          preserveNextQuizTypeStateRef.current = true;
          setContentType("quiz");
          setDescription(getDefaultAssignmentInstructions("quiz"));
          setQuizCreationMode("generate");
          setQuizSourceType("video");
          setQuizSourceAssignmentId(created.assignmentId);
          setLinkedAssignmentId(created.assignmentId);
          setQuizAccordionOpen({
            step1: false,
            step2: false,
            step3: false,
            step4: true,
          });
        }
      } else {
        setSuccessMessage("Assignment created.");
      }
    } catch {
      setError("Unable to save assignment right now.");
    } finally {
      setSaving(false);
    }
  };

  const classAssignments = data.assignments.filter((assignment) => assignment.classId === classId);
  const quizSourceCandidates = classAssignments.filter((assignment) =>
    quizSourceType === "video"
      ? assignment.contentType === "video" && hasSavedVideoTranscript(assignment)
      : isReadingSourceAssignment(assignment),
  );

  const generateDraftFromLinkedContent = async () => {
    if (!quizSourceAssignmentId) {
      setQuizGenerateError("Choose a source assignment first.");
      return;
    }

    setDrafting(true);
    setQuizGenerateError(null);
    try {
      const result = await generateQuizFromLinkedAssignment({
        data: {
          assignmentId: quizSourceAssignmentId,
          questionCount: quizQuestionCount,
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
      preserveNextQuizTypeStateRef.current = true;
      setContentType("quiz");
      setQuizCreationMode("generate");
      setQuizSourceAssignmentId(quizSourceAssignmentId);
      setQuizAccordionOpen({
        step1: false,
        step2: false,
        step3: false,
        step4: true,
      });
      setLinkedAssignmentId(quizSourceAssignmentId);
      setQuizTitle(`${result.sourceTitle} Quiz`);
      setQuizQuestions(questions);
      setQuizGenerateError(null);
      setSuccessMessage(`Quiz generated from ${result.sourceType === "video" ? "video" : "reading"} content.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      setQuizGenerateError(getQuizGenerationErrorMessage(message));
    } finally {
      setDrafting(false);
    }
  };

  // Build grouped view: video assignments with their linked children
  const videoAssignments = data.assignments.filter((a) => a.contentType === "video");
  const linkedIds = new Set(
    data.assignments.flatMap((a) => (a.linkedAssignmentId ? [a.linkedAssignmentId] : [])),
  );
  const standaloneAssignments = data.assignments.filter(
    (a) => a.contentType !== "video" && !linkedIds.has(a.id),
  );

  const getLinkedTo = (assignmentId: string) =>
    data.assignments.filter((a) => a.linkedAssignmentId === assignmentId);

  const handleDeleteAssignment = async (pin: string) => {
    if (!deleteTarget) return;

    setDeleteLoading(true);
    setDeleteError(null);
    try {
      await deleteAssignmentRecord({
        data: {
          id: deleteTarget.id,
          parentPin: pin,
        },
      });
      if (editingAssignment?.id === deleteTarget.id) {
        setEditingAssignment(null);
      }
      setDeleteTarget(null);
      setSuccessMessage(`Assignment deleted: ${deleteTarget.title}`);
      await router.invalidate();
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      setDeleteError(
        message.includes("INVALID_PIN") || message.includes("FORBIDDEN")
          ? "Incorrect PIN. Please try again."
          : `Could not delete the assignment${message ? ` (${message})` : "."}`,
      );
    } finally {
      setDeleteLoading(false);
    }
  };

  const renderTypeSpecificFields = () => {
    if (contentType === "text") {
      return (
        <div className="block space-y-2 md:col-span-2">
          <span className="text-sm font-medium text-slate-700">Reading Text</span>
          <RichTextEditor
            value={textContent}
            onChange={setTextContent}
            disabled={saving}
            placeholder="Paste the passage or instructions students should read."
            documentName={title || "reading-assignment"}
            onUploadImage={(file) => uploadInlineImage(file)}
          />
        </div>
      );
    }

    if (contentType === "url") {
      return (
        <label className="block space-y-2 md:col-span-2">
          <span className="text-sm font-medium text-slate-700">Learning URL</span>
          <input
            value={resourceUrl}
            onChange={(e) => setResourceUrl(e.target.value)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
            placeholder="https://www.example.com/lesson"
          />
        </label>
      );
    }

    if (contentType === "report") {
      return (
        <div className="block space-y-2 md:col-span-2">
          <span className="text-sm font-medium text-slate-700">Report Instructions & Rubric</span>
          <RichTextEditor
            value={reportPrompt}
            onChange={setReportPrompt}
            disabled={saving}
            placeholder="Describe the assignment, expectations, length, and grading criteria."
            documentName={title || "report-assignment"}
            onUploadImage={(file) => uploadInlineImage(file)}
          />
        </div>
      );
    }

    if (contentType === "essay_questions") {
      return (
        <div className="space-y-3 md:col-span-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-slate-700">Essay Questions</span>
            <p className="text-xs text-slate-500">
              Short structured prompts — student answers each in writing.
            </p>
          </div>
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
                placeholder={`Question ${i + 1}…`}
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
          <p className="text-xs text-slate-500">
            Tip: link this to a video assignment so students can navigate from the video to these questions.
          </p>
        </div>
      );
    }

    if (contentType === "file") {
      return (
        <label className="block space-y-2 md:col-span-2">
          <span className="text-sm font-medium text-slate-700">Attach File</span>
          <input
            type="file"
            onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)}
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800"
          />
          {selectedFile ? (
            <p className="text-xs text-slate-500">Selected: {selectedFile.name}</p>
          ) : (
            <p className="text-xs text-slate-500">Upload a PDF, image, worksheet, or reference file.</p>
          )}
        </label>
      );
    }

    if (contentType === "video") {
      const selectedVideo = videos[0];
      return (
        <div className="md:col-span-2 rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
          <h3 className="text-sm font-semibold uppercase tracking-[0.14em] text-slate-700">Video Builder</h3>
          <p className="mt-1 text-sm text-slate-600">
            Complete the video steps below, then continue to Quiz Builder.
          </p>

          <div className="mt-4 space-y-3">
            <div ref={videoStep1Ref} className="rounded-xl border border-slate-200 bg-white">
              <button
                type="button"
                onClick={() => {
                  const willOpen = !videoAccordionOpen.step1;
                  if (willOpen) {
                    stepToCenterRef.current = "step1";
                  }
                  setVideoAccordionOpen((prev) => ({ ...prev, step1: !prev.step1 }));
                }}
                className="flex w-full items-center justify-between px-4 py-3 text-left"
              >
                <span className="text-sm font-semibold text-slate-900">Step 1: Search Video or Paste Link</span>
                <span className="text-xs text-slate-500">{videoAccordionOpen.step1 ? "Hide" : "Show"}</span>
              </button>
              {videoAccordionOpen.step1 ? (
                <div className="border-t border-slate-100 px-4 py-4">
                  <VideoSearch
                    videos={videos}
                    onVideosChange={(nextVideos) => {
                      setVideos(nextVideos);
                      if (nextVideos.length > 0) {
                        stepToCenterRef.current = "step2";
                      }
                      setVideoAccordionOpen((prev) => ({
                        ...prev,
                        step1: nextVideos.length === 0,
                        step2: true,
                      }));
                    }}
                    disabled={saving}
                    gradeLevel={data.classes.find((c) => c.id === classId)?.title}
                    enableQuizGeneration={false}
                  />
                </div>
              ) : null}
            </div>

            <div ref={videoStep2Ref} className="rounded-xl border border-slate-200 bg-white">
              <button
                type="button"
                onClick={() => {
                  const willOpen = !videoAccordionOpen.step2;
                  if (willOpen) {
                    stepToCenterRef.current = "step2";
                  }
                  setVideoAccordionOpen((prev) => ({ ...prev, step2: !prev.step2 }));
                }}
                className="flex w-full items-center justify-between px-4 py-3 text-left"
              >
                <span className="text-sm font-semibold text-slate-900">Step 2: Select Video</span>
                <span className="text-xs text-slate-500">{videoAccordionOpen.step2 ? "Hide" : "Show"}</span>
              </button>
              {videoAccordionOpen.step2 ? (
                <div className="border-t border-slate-100 px-4 py-4">
                  {selectedVideo ? (
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
                    </div>
                  ) : (
                    <p className="text-xs text-slate-500">
                      No video selected yet. Complete Step 1 first.
                    </p>
                  )}
                </div>
              ) : null}
            </div>

            <div ref={videoStep3Ref} className="rounded-xl border border-slate-200 bg-white">
              <button
                type="button"
                onClick={() => {
                  const willOpen = !videoAccordionOpen.step3;
                  if (willOpen) {
                    stepToCenterRef.current = "step3";
                  }
                  setVideoAccordionOpen((prev) => ({ ...prev, step3: !prev.step3 }));
                }}
                className="flex w-full items-center justify-between px-4 py-3 text-left"
              >
                <span className="text-sm font-semibold text-slate-900">Step 3: Save Video</span>
                <span className="text-xs text-slate-500">{videoAccordionOpen.step3 ? "Hide" : "Show"}</span>
              </button>
              {videoAccordionOpen.step3 ? (
                <div className="border-t border-slate-100 px-4 py-4 space-y-2">
                  <label className="inline-flex items-center gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={createQuizAfterVideoSave}
                      onChange={(e) => setCreateQuizAfterVideoSave(e.target.checked)}
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
                </div>
              ) : null}
            </div>

            {createQuizAfterVideoSave ? (
              <div className="rounded-xl border border-dashed border-cyan-300 bg-cyan-50/60 px-4 py-3">
                <p className="text-sm font-medium text-cyan-900">Next Step: Quiz Builder</p>
                <p className="text-xs text-cyan-800">
                  After save, we will automatically open Quiz Builder and link this saved video.
                </p>
              </div>
            ) : null}
          </div>
        </div>
      );
    }

    if (contentType === "quiz") {
      const selectedQuizSource = classAssignments.find((assignment) => assignment.id === quizSourceAssignmentId);
      return (
        <>
          <div className="md:col-span-2 rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
            <h3 className="text-sm font-semibold uppercase tracking-[0.14em] text-slate-700">
              Quiz Builder Steps
            </h3>

            <div className="mt-4 space-y-4">
              <div ref={quizStep1Ref} className="rounded-xl border border-slate-200 bg-white">
                <button
                  type="button"
                  onClick={() => {
                    const willOpen = !quizAccordionOpen.step1;
                    if (willOpen) {
                      quizStepToCenterRef.current = "step1";
                    }
                    setQuizAccordionOpen((prev) => ({ ...prev, step1: !prev.step1 }));
                  }}
                  className="flex w-full items-center justify-between px-4 py-3 text-left"
                >
                  <span className="text-sm font-semibold text-slate-900">Step 1: Choose Quiz Setup</span>
                  <span className="text-xs text-slate-500">{quizAccordionOpen.step1 ? "Hide" : "Show"}</span>
                </button>
                {quizAccordionOpen.step1 ? (
                  <div className="border-t border-slate-100 px-4 py-4 space-y-3">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <button
                        type="button"
                        onClick={() => {
                          setQuizCreationMode("generate");
                          setQuizSourceAssignmentId("");
                          setLinkedAssignmentId("");
                          setQuizQuestions([]);
                          setQuizAccordionOpen({
                            step1: true,
                            step2: true,
                            step3: false,
                            step4: false,
                          });
                          quizStepToCenterRef.current = "step2";
                        }}
                        className={`rounded-2xl border p-4 text-left transition ${
                          quizCreationMode === "generate"
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
                        onClick={() => {
                          setQuizCreationMode("manual");
                          setLinkedAssignmentId("");
                          setQuizSourceAssignmentId("");
                          setQuizAccordionOpen({
                            step1: true,
                            step2: false,
                            step3: false,
                            step4: false,
                          });
                        }}
                        className={`rounded-2xl border p-4 text-left transition ${
                          quizCreationMode === "manual"
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
                  </div>
                ) : null}
              </div>

              {quizCreationMode === "generate" ? (
                <>
                  <div ref={quizStep2Ref} className="rounded-xl border border-slate-200 bg-white">
                    <button
                      type="button"
                      onClick={() => {
                        const willOpen = !quizAccordionOpen.step2;
                        if (willOpen) {
                          quizStepToCenterRef.current = "step2";
                        }
                        setQuizAccordionOpen((prev) => ({ ...prev, step2: !prev.step2 }));
                      }}
                      className="flex w-full items-center justify-between px-4 py-3 text-left"
                    >
                      <span className="text-sm font-semibold text-slate-900">Step 2: Choose Content Type</span>
                      <span className="text-xs text-slate-500">{quizAccordionOpen.step2 ? "Hide" : "Show"}</span>
                    </button>
                    {quizAccordionOpen.step2 ? (
                      <div className="border-t border-slate-100 px-4 py-4">
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setQuizSourceType("video");
                              setQuizSourceAssignmentId("");
                              setLinkedAssignmentId("");
                              setQuizGenerateError(null);
                              setQuizAccordionOpen((prev) => ({
                                ...prev,
                                step3: true,
                                step4: false,
                              }));
                              quizStepToCenterRef.current = "step3";
                            }}
                            className={`rounded-xl border px-3 py-2 text-sm font-medium ${
                              quizSourceType === "video"
                                ? "border-cyan-500 bg-cyan-50 text-cyan-800"
                                : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
                            }`}
                          >
                            Video
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setQuizSourceType("text");
                              setQuizSourceAssignmentId("");
                              setLinkedAssignmentId("");
                              setQuizGenerateError(null);
                              setQuizAccordionOpen((prev) => ({
                                ...prev,
                                step3: true,
                                step4: false,
                              }));
                              quizStepToCenterRef.current = "step3";
                            }}
                            className={`rounded-xl border px-3 py-2 text-sm font-medium ${
                              quizSourceType === "text"
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
                    ) : null}
                  </div>

                  <div ref={quizStep3Ref} className="rounded-xl border border-slate-200 bg-white">
                    <button
                      type="button"
                      onClick={() => {
                        const willOpen = !quizAccordionOpen.step3;
                        if (willOpen) {
                          quizStepToCenterRef.current = "step3";
                        }
                        setQuizAccordionOpen((prev) => ({ ...prev, step3: !prev.step3 }));
                      }}
                      className="flex w-full items-center justify-between px-4 py-3 text-left"
                    >
                      <span className="text-sm font-semibold text-slate-900">Step 3: Select Content</span>
                      <span className="text-xs text-slate-500">{quizAccordionOpen.step3 ? "Hide" : "Show"}</span>
                    </button>
                    {quizAccordionOpen.step3 ? (
                      <div className="border-t border-slate-100 px-4 py-4 space-y-3">
                        <label className="block space-y-2">
                          <span className="text-sm font-medium text-slate-700">
                            {quizSourceType === "video" ? "Saved Video Assignment" : "Reading Assignment"}
                          </span>
                          <select
                            value={quizSourceAssignmentId}
                            onChange={(e) => {
                              setQuizSourceAssignmentId(e.target.value);
                              setLinkedAssignmentId(e.target.value);
                              setQuizGenerateError(null);
                              setQuizAccordionOpen((prev) => ({
                                ...prev,
                                step4: true,
                              }));
                              quizStepToCenterRef.current = "step4";
                            }}
                            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                          >
                            <option value="">Select source...</option>
                            {quizSourceCandidates.map((assignment) => (
                              <option key={assignment.id} value={assignment.id}>
                                {assignment.title}
                              </option>
                            ))}
                          </select>
                        </label>
                        {quizSourceCandidates.length === 0 ? (
                          <p className="text-xs text-slate-500">
                            {quizSourceType === "video"
                              ? "No saved video assignments with transcript in this class yet."
                              : "No reading assignments with saved reading text in this class yet."}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                  </div>

                  <div ref={quizStep4Ref} className="rounded-xl border border-slate-200 bg-white">
                    <button
                      type="button"
                      onClick={() => {
                        const willOpen = !quizAccordionOpen.step4;
                        if (willOpen) {
                          quizStepToCenterRef.current = "step4";
                        }
                        setQuizAccordionOpen((prev) => ({ ...prev, step4: !prev.step4 }));
                      }}
                      className="flex w-full items-center justify-between px-4 py-3 text-left"
                    >
                      <span className="text-sm font-semibold text-slate-900">Step 4: Generate Questions</span>
                      <span className="text-xs text-slate-500">{quizAccordionOpen.step4 ? "Hide" : "Show"}</span>
                    </button>
                    {quizAccordionOpen.step4 ? (
                      <div className="border-t border-slate-100 px-4 py-4 space-y-3">
                        <label className="block space-y-2">
                          <span className="text-sm font-medium text-slate-700">Number of Questions</span>
                          <select
                            value={String(quizQuestionCount)}
                            onChange={(e) => {
                              setQuizQuestionCount(Number(e.target.value));
                              setQuizGenerateError(null);
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
                            disabled={drafting || !quizSourceAssignmentId}
                            onClick={() => void generateDraftFromLinkedContent()}
                            className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60"
                          >
                            {drafting ? "Generating..." : "Generate Questions"}
                          </button>
                          <p className="text-xs text-slate-500">
                            Questions will be built from the stored source content.
                          </p>
                        </div>
                        {selectedQuizSource ? (
                          <p className="text-xs text-cyan-700">
                            Selected source: {selectedQuizSource.title}
                          </p>
                        ) : null}
                        {quizGenerateError ? (
                          <p className="text-xs font-medium text-rose-700">{quizGenerateError}</p>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </>
              ) : null}

              {quizCreationMode === "manual" ? (
                <div className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-3">
                  <p className="text-sm font-medium text-slate-900">Manual mode selected</p>
                  <p className="mt-1 text-xs text-slate-600">
                    Add your own questions below. No linked source is required for this quiz.
                  </p>
                </div>
              ) : null}
            </div>
          </div>

          <label className="block space-y-2 md:col-span-2">
            <span className="text-sm font-medium text-slate-700">Quiz Title</span>
            <input
              value={quizTitle}
              onChange={(e) => setQuizTitle(e.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
              placeholder="Weekly Science Check-in"
            />
          </label>

          <div className="md:col-span-2 rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
            <h3 className="text-sm font-semibold uppercase tracking-[0.14em] text-slate-700">
              Quiz Questions
            </h3>
            <div className="mt-3">
              <QuizBuilder questions={quizQuestions} onChange={setQuizQuestions} disabled={saving} />
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
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
          className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
        />
      </label>

      <label className="space-y-2">
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
      {/* Header */}
      <section className="orca-hero orca-wave rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
        <p className="text-xs uppercase tracking-[0.2em] text-cyan-700">Parent Workspace</p>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-3xl font-semibold text-slate-900">Manage Assignments</h1>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setSuccessMessage(null);
              setShowCreateModal(true);
            }}
            className="rounded-xl bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700"
          >
            New Assignment
          </button>
        </div>
        <p className="mt-2 text-slate-600">
          Create video lessons, quizzes, essay questions, reports, and more. Link assignments together so students see them grouped.
        </p>
      </section>

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
                    setError(null);
                    setSuccessMessage(null);
                  }}
                  className="rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
                >
                  Close
                </button>
              </div>

              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <label className="space-y-2">
                  <span className="text-sm font-medium text-slate-700">Class</span>
                  <select
                    value={classId}
                    onChange={(e) => setClassId(e.target.value)}
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
                    value={contentType}
                    onChange={(e) => {
                      setContentType(e.target.value as AssignmentType);
                      setError(null);
                      setSuccessMessage(null);
                    }}
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                  >
                    {(Object.keys(TYPE_LABELS) as AssignmentType[]).map((t) => (
                      <option key={t} value={t}>{TYPE_LABELS[t]}</option>
                    ))}
                  </select>
                  <p className="text-xs text-slate-500">{TYPE_DESCRIPTIONS[contentType]}</p>
                </label>

                <label className="space-y-2 md:col-span-2">
                  <span className="text-sm font-medium text-slate-700">Title</span>
                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                    placeholder="e.g. The Water Cycle — Video Lesson"
                  />
                </label>

                <label className="space-y-2 md:col-span-2">
                  <span className="text-sm font-medium text-slate-700">Assignment Instructions</span>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    className="min-h-20 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                  />
                </label>

                {contentType === "video" || contentType === "quiz" ? renderDueFields() : null}

                {renderTypeSpecificFields()}

                {data.assignments.length > 0 && contentType !== "video" && contentType !== "quiz" ? (
                  <label className="space-y-2 md:col-span-2">
                    <span className="text-sm font-medium text-slate-700">
                      Link to Assignment (optional)
                    </span>
                    <p className="text-xs text-slate-500">
                      Attach this to a video lesson or another assignment so students can navigate between them.
                    </p>
                    <select
                      value={linkedAssignmentId}
                      onChange={(e) => setLinkedAssignmentId(e.target.value)}
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

                {contentType !== "video" && contentType !== "quiz" ? renderDueFields() : null}
              </div>

              {error ? <p className="mt-3 text-sm text-rose-700">{error}</p> : null}
              {successMessage ? <p className="mt-3 text-sm text-emerald-700">{successMessage}</p> : null}

              <div className="mt-4 flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (saving) return;
                    setShowCreateModal(false);
                    setError(null);
                    setSuccessMessage(null);
                  }}
                  className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
                >
                  Cancel
                </button>
                <button
                  disabled={saving || data.classes.length === 0}
                  onClick={() => void submitAssignment()}
                  className="rounded-xl bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {saving
                    ? "Saving…"
                    : contentType === "video"
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
        <h2 className="text-xl font-semibold text-slate-900">Published Assignments</h2>

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
                    <span
                      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold uppercase tracking-wide ${getTypeBadgeClass(video.contentType)}`}
                    >
                      {TYPE_LABELS[video.contentType as AssignmentType] ?? video.contentType}
                    </span>
                    <h3 className="mt-0.5 text-lg font-semibold text-slate-900 truncate">
                      {video.title}
                    </h3>
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
                    <button
                      type="button"
                      onClick={() => setEditingAssignment(video)}
                      className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setDeleteError(null);
                        setDeleteTarget(video);
                      }}
                      className="rounded-lg border border-rose-200 bg-white px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50"
                    >
                      Delete
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

            return (
              <article
                key={row.id}
                id={`assignment-${row.id}`}
                className={`flex items-start justify-between gap-4 rounded-2xl border border-slate-200 p-5 transition-all duration-300 ${
                  highlightedAssignmentId === row.id
                    ? "bg-cyan-50 ring-2 ring-cyan-300 shadow-md"
                    : "bg-slate-50/80"
                }`}
              >
                <div className="min-w-0">
                  <p
                    className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold uppercase tracking-wide ${getTypeBadgeClass(row.contentType)}`}
                  >
                    {TYPE_LABELS[row.contentType as AssignmentType] ?? row.contentType}
                  </p>
                  <h3 className="mt-0.5 text-lg font-semibold text-slate-900 truncate">{row.title}</h3>
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

                <div className="flex shrink-0 items-start gap-2">
                  <button
                    type="button"
                    onClick={() => setEditingAssignment(row)}
                    className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDeleteError(null);
                      setDeleteTarget(row);
                    }}
                    className="rounded-lg border border-rose-200 bg-white px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50"
                  >
                    Delete
                  </button>
                </div>
              </article>
            );
          })}

          {data.assignments.length === 0 ? (
            <p className="text-sm text-slate-500">No assignments published yet.</p>
          ) : null}
        </div>
      </section>

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
    </div>
  );
}
