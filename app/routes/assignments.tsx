import { useState } from "react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { QuizBuilder, type QuizQuestion } from "../components/quiz-builder";
import { RichContent } from "../components/rich-content";
import { RichTextEditor } from "../components/rich-text-editor";
import { VideoSearch, type VideoData } from "../components/video-search";
import {
  createAssignmentRecord,
  generateQuizDraftForCurriculum,
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
  videos?: VideoData[];
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
  onClose,
}: {
  assignment: AssignmentRow;
  allAssignments: AssignmentRow[];
  onSave: () => void;
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
            <span className="text-sm font-medium text-slate-700">Description (optional)</span>
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
  const [description, setDescription] = useState("");
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
  const [quizTitle, setQuizTitle] = useState("");
  const [quizQuestions, setQuizQuestions] = useState<QuizQuestion[]>([]);
  const [essayQuestions, setEssayQuestions] = useState<string[]>([""]);

  const [quizTopic, setQuizTopic] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const [editingAssignment, setEditingAssignment] = useState<AssignmentRow | null>(null);

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
    setDescription("");
    setDueDate("");
    setDueTime("23:59");
    setIncludeDueTime(false);
    setLinkedAssignmentId("");
    setTextContent("");
    setResourceUrl("");
    setReportPrompt("");
    setSelectedFile(null);
    setVideos([]);
    setQuizTitle("");
    setQuizQuestions([]);
    setEssayQuestions([""]);
    setQuizTopic("");
    setError(null);
    setSuccessMessage(null);
  };

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
      if (videos.length === 0) { setError("Add at least one YouTube video."); return; }
      contentRef = JSON.stringify({ videos });
    }

    if (contentType === "quiz") {
      if (quizQuestions.length === 0) { setError("Add at least one quiz question."); return; }
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
      await createAssignmentRecord({
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
      setSuccessMessage("Assignment created.");
    } catch {
      setError("Unable to save assignment right now.");
    } finally {
      setSaving(false);
    }
  };

  const createLinkedQuizFromVideo = async (questions: QuizQuestion[], linkedTitle: string) => {
    if (!classId) { setError("Select a class first."); return; }

    // Find the video assignment that was just created or is being built.
    // We link it by finding the most recent video assignment in this class.
    // A better approach: the video assignment is saved first, then quiz is linked.
    // For now we save the quiz linked to the current video assignment that will be saved next.
    setSaving(true);
    setError(null);
    try {
      const dueAt = buildDueAt({ dueDate, dueTime, includeDueTime });
      await createAssignmentRecord({
        data: {
          classId,
          title: linkedTitle.trim(),
          description: "Quiz linked to a video lesson.",
          contentType: "quiz",
          contentRef: JSON.stringify({ title: linkedTitle.trim(), questions }),
          dueAt,
        },
      });
      setSuccessMessage("Linked quiz assignment created.");
      await router.invalidate();
    } catch {
      setError("Could not create linked quiz assignment.");
    } finally {
      setSaving(false);
    }
  };

  const generateDraft = async () => {
    if (!quizTopic.trim()) { setError("Enter a topic to generate a quiz draft."); return; }
    setDrafting(true);
    setError(null);
    try {
      const result = await generateQuizDraftForCurriculum({
        data: { topic: quizTopic.trim(), questionCount: 5 },
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
      setContentType("quiz");
      setQuizTitle(`${quizTopic.trim()} Quiz`);
      setQuizQuestions(questions);
    } catch {
      setError("Quiz draft generation failed.");
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
      return (
        <div className="md:col-span-2 rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
          <h3 className="text-sm font-semibold uppercase tracking-[0.14em] text-slate-700">
            YouTube Lesson Builder
          </h3>
          <p className="mt-1 text-sm text-slate-600">
            Add videos manually or use AI Search. After saving, use the Linked Assignments panel to attach a quiz or essay questions.
          </p>
          <div className="mt-4">
            <VideoSearch
              videos={videos}
              onVideosChange={setVideos}
              disabled={saving}
              gradeLevel={data.classes.find((c) => c.id === classId)?.title}
              onCreateLinkedQuiz={(questions, linkedTitle) => {
                void createLinkedQuizFromVideo(questions, linkedTitle);
              }}
            />
          </div>
        </div>
      );
    }

    if (contentType === "quiz") {
      return (
        <>
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

  return (
    <div className="space-y-6">
      {/* Header */}
      <section className="orca-hero orca-wave rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
        <p className="text-xs uppercase tracking-[0.2em] text-cyan-700">Parent Workspace</p>
        <h1 className="mt-2 text-3xl font-semibold text-slate-900">Manage Assignments</h1>
        <p className="mt-2 text-slate-600">
          Create video lessons, quizzes, essay questions, reports, and more. Link assignments together so students see them grouped.
        </p>
      </section>

      {/* New Assignment */}
      <section className="rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
        <h2 className="text-xl font-semibold text-slate-900">New Assignment</h2>

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
            <span className="text-sm font-medium text-slate-700">Description (optional)</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="min-h-20 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
            />
          </label>

          {renderTypeSpecificFields()}

          {/* Link to existing assignment */}
          {data.assignments.length > 0 && contentType !== "video" ? (
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
        </div>

        {error ? <p className="mt-3 text-sm text-rose-700">{error}</p> : null}
        {successMessage ? <p className="mt-3 text-sm text-emerald-700">{successMessage}</p> : null}

        <button
          disabled={saving || data.classes.length === 0}
          onClick={() => void submitAssignment()}
          className="mt-4 rounded-xl bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? "Saving…" : "Create Assignment"}
        </button>
      </section>

      {/* AI Quiz Generator */}
      <section className="rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
        <h2 className="text-xl font-semibold text-slate-900">AI Quiz Generator</h2>
        <p className="mt-1 text-sm text-slate-600">
          Generate a quiz by topic and load it into Quiz mode above. For video-accurate quizzes, use the "Generate Quiz" button on each video card.
        </p>
        <div className="mt-4 flex flex-col gap-3 md:flex-row">
          <input
            value={quizTopic}
            onChange={(e) => setQuizTopic(e.target.value)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
            placeholder="Topic: Photosynthesis"
          />
          <button
            disabled={drafting}
            onClick={() => void generateDraft()}
            className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {drafting ? "Generating…" : "Generate Quiz Draft"}
          </button>
        </div>
      </section>

      {/* Published Assignments */}
      <section className="rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
        <h2 className="text-xl font-semibold text-slate-900">Published Assignments</h2>

        <div className="mt-4 space-y-4">
          {/* Video lessons with their linked assignments grouped */}
          {videoAssignments.map((video) => {
            const videoPayload = parseJson<VideoPayload>(video.contentRef);
            const linked = getLinkedTo(video.id);

            return (
              <article
                key={video.id}
                className="rounded-2xl border border-slate-200 bg-slate-50/80 overflow-hidden"
              >
                {/* Video row */}
                <div className="flex items-start justify-between gap-4 p-5">
                  <div className="min-w-0">
                    <p className="text-xs font-medium uppercase tracking-wide text-cyan-700">
                      Video Lesson
                    </p>
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
                  </div>
                  <button
                    type="button"
                    onClick={() => setEditingAssignment(video)}
                    className="shrink-0 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Edit
                  </button>
                </div>

                {/* Linked assignments */}
                {linked.length > 0 ? (
                  <div className="border-t border-slate-200 bg-white divide-y divide-slate-100">
                    {linked.map((child) => {
                      const quizPayload = parseJson<QuizPayload>(child.contentRef);
                      const essayPayload = parseJson<EssayQuestionsPayload>(child.contentRef);

                      return (
                        <div key={child.id} className="flex items-center justify-between gap-4 px-5 py-3">
                          <div className="flex items-center gap-3 min-w-0">
                            <div className="text-slate-400 text-xs">↳</div>
                            <div className="min-w-0">
                              <p className="text-xs font-medium uppercase tracking-wide text-violet-600">
                                {TYPE_LABELS[child.contentType as AssignmentType] ?? child.contentType}
                              </p>
                              <p className="text-sm font-medium text-slate-900 truncate">{child.title}</p>
                              {child.contentType === "quiz" && quizPayload?.questions?.length ? (
                                <p className="text-xs text-slate-500">
                                  {quizPayload.questions.length} question{quizPayload.questions.length === 1 ? "" : "s"}
                                </p>
                              ) : null}
                              {child.contentType === "essay_questions" && essayPayload?.questions?.length ? (
                                <p className="text-xs text-slate-500">
                                  {essayPayload.questions.length} question{essayPayload.questions.length === 1 ? "" : "s"}
                                </p>
                              ) : null}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => setEditingAssignment(child)}
                            className="shrink-0 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                          >
                            Edit
                          </button>
                        </div>
                      );
                    })}
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
                className="flex items-start justify-between gap-4 rounded-2xl border border-slate-200 bg-slate-50/80 p-5"
              >
                <div className="min-w-0">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
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

                <button
                  type="button"
                  onClick={() => setEditingAssignment(row)}
                  className="shrink-0 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  Edit
                </button>
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
          onClose={() => setEditingAssignment(null)}
        />
      ) : null}
    </div>
  );
}
