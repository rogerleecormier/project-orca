import { useMemo, useState } from "react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  getViewerContext,
  getProgressSnapshot,
  getStudentWorkspaceData,
  getTodaysPlan,
  submitAssignmentWork,
} from "../server/functions";
import { MasteryGallery, SkillTree } from "../components/mastery-gallery";
import { RichContent } from "../components/rich-content";

export const Route = createFileRoute("/student")({
  loader: async () => {
    const viewer = await getViewerContext();

    if (!viewer.isAuthenticated) {
      throw redirect({ to: "/login" });
    }

    if (viewer.activeRole !== "student") {
      throw redirect({ to: "/" });
    }

    return getStudentWorkspaceData({
      data: {
        profileId: viewer.profileId ?? undefined,
      },
    });
  },
  component: StudentWorkspacePage,
});

// ── Types ─────────────────────────────────────────────────────────────────────

type AssignmentRow = Awaited<ReturnType<typeof getStudentWorkspaceData>>["assignments"][number];
type SubmissionRow = Awaited<ReturnType<typeof getStudentWorkspaceData>>["submissions"][number];

type QuizQuestion = {
  id?: string;
  question: string;
  options: string[];
  answerIndex: number;
  explanation: string;
};

type QuizPayload = {
  title?: string;
  questions?: QuizQuestion[];
};

type VideoPayload = {
  videos?: Array<{
    videoId: string;
    title: string;
    channel?: string;
    description?: string;
  }>;
};

type EssayQuestionsPayload = {
  questions?: string[];
};

const TYPE_LABELS: Record<string, string> = {
  text: "Reading",
  file: "File",
  url: "Link",
  video: "Video Lesson",
  quiz: "Quiz",
  essay_questions: "Essay Questions",
  report: "Report",
};

function parseJson<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

type UploadPhase = "idle" | "reading" | "uploading" | "done";

async function fileToBase64(
  file: File,
  onProgress?: (percent: number) => void,
) {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("FILE_READ_FAILED"));
    reader.onload = () => resolve(String(reader.result ?? ""));
    if (onProgress) {
      reader.onprogress = (e) => {
        if (e.lengthComputable) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      };
    }
    reader.readAsDataURL(file);
  });
}

// ── Assignment list (home) ─────────────────────────────────────────────────────

function AssignmentListView({
  assignments,
  submissions,
  onOpen,
}: {
  assignments: AssignmentRow[];
  submissions: SubmissionRow[];
  onOpen: (id: string) => void;
}) {
  const submittedIds = new Set(submissions.map((s) => s.assignmentId));

  // Group: video parents with their linked children
  const linkedIds = new Set(
    assignments.flatMap((a) => (a.linkedAssignmentId ? [a.linkedAssignmentId] : [])),
  );
  const videoAssignments = assignments.filter((a) => a.contentType === "video");
  const standaloneAssignments = assignments.filter(
    (a) => a.contentType !== "video" && !linkedIds.has(a.id),
  );
  const getLinkedTo = (id: string) => assignments.filter((a) => a.linkedAssignmentId === id);

  const renderStatusBadge = (assignmentId: string) => {
    if (submittedIds.has(assignmentId)) {
      return (
        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
          Done
        </span>
      );
    }
    return (
      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
        To Do
      </span>
    );
  };

  return (
    <div className="space-y-3">
      {/* Video lessons with linked assignments */}
      {videoAssignments.map((video) => {
        const linked = getLinkedTo(video.id);
        const videoPayload = parseJson<VideoPayload>(video.contentRef);

        return (
          <article
            key={video.id}
            className="rounded-2xl border border-slate-200 bg-white overflow-hidden shadow-sm"
          >
            {/* Video row — clickable */}
            <button
              type="button"
              onClick={() => onOpen(video.id)}
              className="w-full flex items-center justify-between gap-4 px-5 py-4 text-left hover:bg-slate-50 transition"
            >
              <div className="min-w-0">
                <p className="text-xs font-medium uppercase tracking-wide text-cyan-700">
                  Video Lesson
                </p>
                <p className="mt-0.5 text-base font-semibold text-slate-900 truncate">
                  {video.title}
                </p>
                {videoPayload?.videos?.[0] ? (
                  <p className="mt-0.5 text-xs text-slate-500">
                    {videoPayload.videos.length} video{videoPayload.videos.length === 1 ? "" : "s"}
                  </p>
                ) : null}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {renderStatusBadge(video.id)}
                <span className="text-slate-400">›</span>
              </div>
            </button>

            {/* Linked assignments */}
            {linked.length > 0 ? (
              <div className="border-t border-slate-100 divide-y divide-slate-100">
                {linked.map((child) => (
                  <button
                    key={child.id}
                    type="button"
                    onClick={() => onOpen(child.id)}
                    className="w-full flex items-center justify-between gap-4 pl-10 pr-5 py-3 text-left hover:bg-slate-50 transition"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-slate-300 text-xs shrink-0">↳</span>
                      <div className="min-w-0">
                        <p className="text-xs font-medium uppercase tracking-wide text-violet-600">
                          {TYPE_LABELS[child.contentType] ?? child.contentType}
                        </p>
                        <p className="text-sm font-medium text-slate-900 truncate">{child.title}</p>
                        {child.dueAt ? (
                          <p
                            className={`mt-0.5 text-xs font-medium ${
                              new Date(child.dueAt) < new Date()
                                ? "text-rose-600"
                                : new Date(child.dueAt) < new Date(Date.now() + 3 * 86400000)
                                  ? "text-amber-600"
                                  : "text-slate-400"
                            }`}
                          >
                            Due{" "}
                            {new Date(child.dueAt).toLocaleDateString(undefined, {
                              month: "short",
                              day: "numeric",
                            })}
                          </p>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {renderStatusBadge(child.id)}
                      <span className="text-slate-400">›</span>
                    </div>
                  </button>
                ))}
              </div>
            ) : null}
          </article>
        );
      })}

      {/* Standalone non-video assignments */}
      {standaloneAssignments.map((row) => (
        <button
          key={row.id}
          type="button"
          onClick={() => onOpen(row.id)}
          className="w-full flex items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-white px-5 py-4 text-left hover:bg-slate-50 transition shadow-sm"
        >
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              {TYPE_LABELS[row.contentType] ?? row.contentType}
            </p>
            <p className="mt-0.5 text-base font-semibold text-slate-900 truncate">{row.title}</p>
            {row.description ? (
              <p className="mt-0.5 text-xs text-slate-500 line-clamp-1">{row.description}</p>
            ) : null}
            {row.dueAt ? (
              <p
                className={`mt-0.5 text-xs font-medium ${
                  new Date(row.dueAt) < new Date()
                    ? "text-rose-600"
                    : new Date(row.dueAt) < new Date(Date.now() + 3 * 86400000)
                      ? "text-amber-600"
                      : "text-slate-400"
                }`}
              >
                Due{" "}
                {new Date(row.dueAt).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                })}
              </p>
            ) : null}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {renderStatusBadge(row.id)}
            <span className="text-slate-400">›</span>
          </div>
        </button>
      ))}

      {assignments.length === 0 ? (
        <p className="text-sm text-slate-500 italic">No assignments yet.</p>
      ) : null}
    </div>
  );
}

// ── Video assignment view ──────────────────────────────────────────────────────

function VideoAssignmentView({
  assignment,
  linkedAssignments,
  submission,
  onBack,
  onNavigateTo,
  onMarkWatched,
  saving,
}: {
  assignment: AssignmentRow;
  linkedAssignments: AssignmentRow[];
  submission: SubmissionRow | undefined;
  onBack: () => void;
  onNavigateTo: (id: string) => void;
  onMarkWatched: (assignmentId: string) => void;
  saving: boolean;
}) {
  const payload = parseJson<VideoPayload>(assignment.contentRef);
  const watched = !!submission;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
        >
          ← Back
        </button>
        <p className="text-xs uppercase tracking-wide text-slate-500">Video Lesson</p>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
        <h2 className="text-xl font-semibold text-slate-900">{assignment.title}</h2>
        {assignment.description ? (
          <p className="text-sm text-slate-600">{assignment.description}</p>
        ) : null}

        {/* Videos */}
        {payload?.videos?.map((video) => (
          <div key={video.videoId} className="space-y-2">
            <p className="text-sm font-medium text-slate-700">{video.title}</p>
            {video.channel ? (
              <p className="text-xs text-slate-500">{video.channel}</p>
            ) : null}
            <div
              className="relative w-full overflow-hidden rounded-xl bg-black"
              style={{ paddingTop: "56.25%" }}
            >
              <iframe
                className="absolute inset-0 h-full w-full"
                src={`https://www.youtube.com/embed/${video.videoId}`}
                title={video.title}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
            </div>
          </div>
        ))}

        {/* Mark as watched */}
        {watched ? (
          <p className="text-sm font-medium text-emerald-700">
            Watched — assignment complete.
          </p>
        ) : (
          <button
            type="button"
            disabled={saving}
            onClick={() => onMarkWatched(assignment.id)}
            className="w-full rounded-xl bg-cyan-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-60"
          >
            {saving ? "Saving…" : "Mark as Watched"}
          </button>
        )}
      </div>

      {/* Linked assignments — visible but on separate pages */}
      {linkedAssignments.length > 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-3">
          <h3 className="text-sm font-semibold text-slate-900">Also for this lesson</h3>
          <div className="space-y-2">
            {linkedAssignments.map((linked) => (
              <button
                key={linked.id}
                type="button"
                onClick={() => onNavigateTo(linked.id)}
                className="w-full flex items-center justify-between gap-3 rounded-xl border border-slate-200 px-4 py-3 text-left hover:bg-slate-50 transition"
              >
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-violet-600">
                    {TYPE_LABELS[linked.contentType] ?? linked.contentType}
                  </p>
                  <p className="text-sm font-medium text-slate-900">{linked.title}</p>
                </div>
                <span className="shrink-0 rounded-xl bg-violet-600 px-3 py-1.5 text-xs font-medium text-white">
                  {linked.contentType === "quiz" ? "Take Quiz →" : "Answer Questions →"}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── Quiz assignment view ───────────────────────────────────────────────────────

function QuizAssignmentView({
  assignment,
  linkedVideoAssignment,
  submission,
  onBack,
  onNavigateTo,
  onSubmitQuiz,
  saving,
}: {
  assignment: AssignmentRow;
  linkedVideoAssignment: AssignmentRow | undefined;
  submission: SubmissionRow | undefined;
  onBack: () => void;
  onNavigateTo: (id: string) => void;
  onSubmitQuiz: (assignmentId: string, answers: number[]) => void;
  saving: boolean;
}) {
  const payload = parseJson<QuizPayload>(assignment.contentRef);
  const questions = payload?.questions ?? [];

  const [started, setStarted] = useState(false);
  const [answers, setAnswers] = useState<(number | null)[]>(
    questions.map(() => null),
  );
  const [submitted, setSubmitted] = useState(false);

  const alreadySubmitted = !!submission;
  const previousAnswers = useMemo(() => {
    if (!submission?.textResponse) return null;
    try {
      return JSON.parse(submission.textResponse) as number[];
    } catch {
      return null;
    }
  }, [submission?.textResponse]);

  const allAnswered = answers.every((a) => a !== null);
  const score = useMemo(() => {
    if (!submitted && !alreadySubmitted) return null;
    const ans = submitted ? answers : previousAnswers;
    if (!ans) return null;
    const correct = questions.filter((q, i) => ans[i] === q.answerIndex).length;
    return Math.round((correct / questions.length) * 100);
  }, [submitted, alreadySubmitted, answers, previousAnswers, questions]);

  const handleSubmit = () => {
    const finalized = answers.map((a) => a ?? 0);
    setSubmitted(true);
    onSubmitQuiz(assignment.id, finalized);
  };

  // If already submitted, show review mode
  const displayAnswers = submitted ? answers.map((a) => a ?? 0) : (previousAnswers ?? []);
  const showReview = submitted || alreadySubmitted;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
        >
          ← Back
        </button>
        <p className="text-xs uppercase tracking-wide text-slate-500">Quiz</p>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
        <h2 className="text-xl font-semibold text-slate-900">{assignment.title}</h2>
        {assignment.description ? (
          <p className="text-sm text-slate-600">{assignment.description}</p>
        ) : null}
        {questions.length > 0 ? (
          <p className="text-sm text-slate-500">{questions.length} question{questions.length === 1 ? "" : "s"}</p>
        ) : null}

        {/* Linked video back-nav */}
        {linkedVideoAssignment ? (
          <button
            type="button"
            onClick={() => onNavigateTo(linkedVideoAssignment.id)}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-cyan-700 hover:text-cyan-800"
          >
            ← Back to video lesson: {linkedVideoAssignment.title}
          </button>
        ) : null}

        {/* Pre-start state */}
        {!started && !showReview ? (
          <div className="rounded-xl bg-slate-50 border border-slate-200 p-5 text-center space-y-3">
            <p className="text-sm text-slate-700">
              Ready to take the quiz? You'll answer {questions.length} question{questions.length === 1 ? "" : "s"}.
            </p>
            <button
              type="button"
              onClick={() => setStarted(true)}
              className="rounded-xl bg-cyan-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-cyan-700"
            >
              Take Quiz
            </button>
          </div>
        ) : null}

        {/* Active quiz */}
        {started && !showReview ? (
          <div className="space-y-6">
            {questions.map((q, qi) => (
              <div key={qi} className="space-y-3">
                <p className="text-sm font-semibold text-slate-900">
                  {qi + 1}. {q.question}
                </p>
                <div className="space-y-2">
                  {q.options.map((opt, oi) => (
                    <button
                      key={oi}
                      type="button"
                      onClick={() => {
                        const next = [...answers];
                        next[qi] = oi;
                        setAnswers(next);
                      }}
                      className={[
                        "w-full rounded-xl border-2 px-4 py-2.5 text-left text-sm transition",
                        answers[qi] === oi
                          ? "border-cyan-500 bg-cyan-50 text-cyan-900"
                          : "border-slate-200 bg-white text-slate-800 hover:border-slate-300",
                      ].join(" ")}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              </div>
            ))}

            <button
              type="button"
              disabled={!allAnswered || saving}
              onClick={handleSubmit}
              className="w-full rounded-xl bg-cyan-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-60"
            >
              {saving ? "Submitting…" : "Submit Quiz"}
            </button>
          </div>
        ) : null}

        {/* Review / results */}
        {showReview && questions.length > 0 ? (
          <div className="space-y-5">
            {score !== null ? (
              <div className="rounded-xl bg-slate-50 border border-slate-200 p-4 text-center">
                <p className="text-2xl font-bold text-slate-900">{score}%</p>
                <p className="text-sm text-slate-600">
                  {questions.filter((q, i) => displayAnswers[i] === q.answerIndex).length} of{" "}
                  {questions.length} correct
                </p>
              </div>
            ) : null}

            {questions.map((q, qi) => {
              const chosen = displayAnswers[qi];
              const correct = chosen === q.answerIndex;
              return (
                <div key={qi} className="space-y-2">
                  <p className="text-sm font-semibold text-slate-900">
                    {qi + 1}. {q.question}
                  </p>
                  <div className="space-y-1.5">
                    {q.options.map((opt, oi) => {
                      const isChosen = chosen === oi;
                      const isCorrect = oi === q.answerIndex;
                      return (
                        <div
                          key={oi}
                          className={[
                            "rounded-xl border-2 px-4 py-2 text-sm",
                            isCorrect
                              ? "border-emerald-400 bg-emerald-50 text-emerald-900"
                              : isChosen
                                ? "border-rose-400 bg-rose-50 text-rose-900"
                                : "border-slate-200 bg-white text-slate-600",
                          ].join(" ")}
                        >
                          {opt}
                          {isCorrect ? " ✓" : ""}
                          {isChosen && !isCorrect ? " ✗" : ""}
                        </div>
                      );
                    })}
                  </div>
                  {q.explanation ? (
                    <p className="text-xs text-slate-500 italic">{q.explanation}</p>
                  ) : null}
                </div>
              );
            })}

            {linkedVideoAssignment ? (
              <button
                type="button"
                onClick={() => onNavigateTo(linkedVideoAssignment.id)}
                className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                ← Back to Video Lesson
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ── Essay Questions view ───────────────────────────────────────────────────────

function EssayQuestionsView({
  assignment,
  linkedVideoAssignment,
  submission,
  onBack,
  onNavigateTo,
  onSubmit,
  saving,
}: {
  assignment: AssignmentRow;
  linkedVideoAssignment: AssignmentRow | undefined;
  submission: SubmissionRow | undefined;
  onBack: () => void;
  onNavigateTo: (id: string) => void;
  onSubmit: (assignmentId: string, text: string) => void;
  saving: boolean;
}) {
  const payload = parseJson<EssayQuestionsPayload>(assignment.contentRef);
  const questions = payload?.questions ?? [];

  const [answers, setAnswers] = useState<string[]>(questions.map(() => ""));
  const [submitted, setSubmitted] = useState(false);

  const alreadySubmitted = !!submission;
  const previousAnswers = useMemo(() => {
    if (!submission?.textResponse) return null;
    try {
      return JSON.parse(submission.textResponse) as string[];
    } catch {
      return submission.textResponse ? [submission.textResponse] : null;
    }
  }, [submission?.textResponse]);

  const handleSubmit = () => {
    const text = JSON.stringify(answers);
    setSubmitted(true);
    onSubmit(assignment.id, text);
  };

  const displayAnswers = submitted ? answers : (previousAnswers ?? answers);
  const showReview = submitted || alreadySubmitted;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
        >
          ← Back
        </button>
        <p className="text-xs uppercase tracking-wide text-slate-500">Essay Questions</p>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
        <h2 className="text-xl font-semibold text-slate-900">{assignment.title}</h2>
        {assignment.description ? (
          <p className="text-sm text-slate-600">{assignment.description}</p>
        ) : null}

        {linkedVideoAssignment ? (
          <button
            type="button"
            onClick={() => onNavigateTo(linkedVideoAssignment.id)}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-cyan-700 hover:text-cyan-800"
          >
            ← Back to video lesson: {linkedVideoAssignment.title}
          </button>
        ) : null}

        <div className="space-y-5">
          {questions.map((q, i) => (
            <div key={i} className="space-y-2">
              <p className="text-sm font-semibold text-slate-900">
                {i + 1}. {q}
              </p>
              {showReview ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-800">
                  {displayAnswers[i] || <span className="italic text-slate-400">No answer provided.</span>}
                </div>
              ) : (
                <textarea
                  value={answers[i]}
                  onChange={(e) => {
                    const next = [...answers];
                    next[i] = e.target.value;
                    setAnswers(next);
                  }}
                  className="min-h-24 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                  placeholder="Write your answer here…"
                />
              )}
            </div>
          ))}
        </div>

        {!showReview ? (
          <button
            type="button"
            disabled={saving || answers.every((a) => !a.trim())}
            onClick={handleSubmit}
            className="w-full rounded-xl bg-cyan-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-60"
          >
            {saving ? "Submitting…" : "Submit Answers"}
          </button>
        ) : (
          (() => {
            const feedback = submission?.feedbackJson
              ? (() => { try { return JSON.parse(submission.feedbackJson) as { score: number; strengths: string[]; improvements: string[]; overallFeedback: string }; } catch { return null; } })()
              : null;
            if (!feedback) {
              return <p className="text-sm font-medium text-emerald-700">Answers submitted — waiting for review.</p>;
            }
            return (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-slate-900">Score: {feedback.score}/100</p>
                  <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">Graded</span>
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
            );
          })()
        )}

        {showReview && linkedVideoAssignment ? (
          <button
            type="button"
            onClick={() => onNavigateTo(linkedVideoAssignment.id)}
            className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            ← Back to Video Lesson
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ── Report (long-form writing) view ───────────────────────────────────────────

function ReportAssignmentView({
  assignment,
  submission,
  onBack,
  onSubmit,
  saving,
}: {
  assignment: AssignmentRow;
  submission: SubmissionRow | undefined;
  onBack: () => void;
  onSubmit: (assignmentId: string, text: string) => void;
  saving: boolean;
}) {
  const [response, setResponse] = useState(submission?.textResponse ?? "");
  const [submitted, setSubmitted] = useState(false);
  const alreadySubmitted = !!submission;

  const handleSubmit = () => {
    setSubmitted(true);
    onSubmit(assignment.id, response);
  };

  const showReview = submitted || alreadySubmitted;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <button type="button" onClick={onBack} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50">
          ← Back
        </button>
        <p className="text-xs uppercase tracking-wide text-slate-500">Report</p>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
        <h2 className="text-xl font-semibold text-slate-900">{assignment.title}</h2>
        {assignment.contentRef ? (
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
            <RichContent html={assignment.contentRef} />
          </div>
        ) : null}

        {showReview ? (
          <>
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-800 whitespace-pre-wrap min-h-32">
              {submission?.textResponse || response || <span className="italic text-slate-400">No content submitted.</span>}
            </div>
            {(() => {
              const feedback = submission?.feedbackJson
                ? (() => { try { return JSON.parse(submission.feedbackJson) as { score: number; strengths: string[]; improvements: string[]; overallFeedback: string }; } catch { return null; } })()
                : null;
              if (!feedback) {
                return <p className="text-sm font-medium text-emerald-700">Report submitted — waiting for review.</p>;
              }
              return (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-slate-900">Score: {feedback.score}/100</p>
                    <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">Graded</span>
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
              );
            })()}
          </>
        ) : (
          <>
            <textarea
              value={response}
              onChange={(e) => setResponse(e.target.value)}
              className="min-h-48 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
              placeholder="Write your report here…"
            />
            <button
              type="button"
              disabled={saving || !response.trim()}
              onClick={handleSubmit}
              className="w-full rounded-xl bg-cyan-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-60"
            >
              {saving ? "Submitting…" : "Submit Report"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ── Generic text/url/file assignment view ─────────────────────────────────────

function GenericAssignmentView({
  assignment,
  submission,
  onBack,
  onSubmit,
  saving,
  uploadPhase,
  readPercent,
}: {
  assignment: AssignmentRow;
  submission: SubmissionRow | undefined;
  onBack: () => void;
  onSubmit: (assignmentId: string, text: string, file?: File) => void;
  saving: boolean;
  uploadPhase?: UploadPhase;
  readPercent?: number;
}) {
  const [response, setResponse] = useState(submission?.textResponse ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const alreadySubmitted = !!submission;
  const showReview = submitted || alreadySubmitted;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <button type="button" onClick={onBack} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50">
          ← Back
        </button>
        <p className="text-xs uppercase tracking-wide text-slate-500">
          {TYPE_LABELS[assignment.contentType] ?? assignment.contentType}
        </p>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
        <h2 className="text-xl font-semibold text-slate-900">{assignment.title}</h2>
        {assignment.description ? (
          <p className="text-sm text-slate-600">{assignment.description}</p>
        ) : null}

        {assignment.contentType === "text" && assignment.contentRef ? (
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-800">
            <RichContent html={assignment.contentRef} />
          </div>
        ) : null}

        {assignment.contentType === "report" && assignment.contentRef ? (
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-800">
            <RichContent html={assignment.contentRef} />
          </div>
        ) : null}

        {assignment.contentType === "url" && assignment.contentRef ? (
          <a
            href={assignment.contentRef}
            target="_blank"
            rel="noreferrer"
            className="inline-block rounded-xl bg-cyan-50 border border-cyan-200 px-4 py-2 text-sm font-medium text-cyan-700 hover:bg-cyan-100"
          >
            Open Resource →
          </a>
        ) : null}

        {!showReview ? (
          <>
            <label className="block space-y-1">
              <span className="text-sm font-medium text-slate-700">Your Response (optional)</span>
              <textarea
                value={response}
                onChange={(e) => setResponse(e.target.value)}
                className="min-h-24 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                placeholder="Write notes, reflections, or a summary…"
              />
            </label>

            {assignment.contentType === "file" ? (
              <label className="block space-y-1">
                <span className="text-sm font-medium text-slate-700">Attach File (optional)</span>
                <input
                  type="file"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800"
                />
              </label>
            ) : null}

            {uploadPhase && uploadPhase !== "idle" && uploadPhase !== "done" ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-slate-600">
                  <span>
                    {uploadPhase === "reading"
                      ? `Reading file… ${readPercent !== undefined ? `${readPercent}%` : ""}`
                      : "Uploading…"}
                  </span>
                  {uploadPhase === "reading" && readPercent !== undefined ? (
                    <span className="font-medium">{readPercent}%</span>
                  ) : null}
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                  {uploadPhase === "reading" && readPercent !== undefined ? (
                    <div
                      className="h-full rounded-full bg-cyan-500 transition-all duration-200"
                      style={{ width: `${readPercent}%` }}
                    />
                  ) : (
                    <div className="h-full w-full animate-pulse rounded-full bg-cyan-400" />
                  )}
                </div>
              </div>
            ) : (
              <button
                type="button"
                disabled={saving}
                onClick={() => {
                  setSubmitted(true);
                  onSubmit(assignment.id, response, file ?? undefined);
                }}
                className="w-full rounded-xl bg-cyan-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-60"
              >
                {saving ? "Submitting…" : "Mark Complete"}
              </button>
            )}
          </>
        ) : (
          <p className="text-sm font-medium text-emerald-700">Assignment complete.</p>
        )}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

function StudentWorkspacePage() {
  const router = useRouter();
  const data = Route.useLoaderData();

  const [activeAssignmentId, setActiveAssignmentId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploadPhase, setUploadPhase] = useState<UploadPhase>("idle");
  const [readPercent, setReadPercent] = useState<number | undefined>(undefined);

  const progressQuery = useQuery({
    queryKey: ["progress-snapshot", data.profile.id],
    queryFn: async () =>
      await getProgressSnapshot({
        data: { profileId: data.profile.id },
      }),
    refetchInterval: 20_000,
  });

  const todaysPlanQuery = useQuery({
    queryKey: ["todays-plan", data.profile.id],
    queryFn: async (): Promise<Awaited<ReturnType<typeof getTodaysPlan>>> =>
      await getTodaysPlan({ data: { profileId: data.profile.id } }),
    staleTime: 60_000,
  });

  const submissionMap = useMemo(
    () => new Map(data.submissions.map((s) => [s.assignmentId, s])),
    [data.submissions],
  );

  const assignmentMap = useMemo(
    () => new Map(data.assignments.map((a) => [a.id, a])),
    [data.assignments],
  );

  const pendingCount = data.assignments.length - data.submissions.length;

  const activeAssignment = activeAssignmentId ? assignmentMap.get(activeAssignmentId) : null;

  const getLinkedVideo = (assignment: AssignmentRow) => {
    if (!assignment.linkedAssignmentId) return undefined;
    const linked = assignmentMap.get(assignment.linkedAssignmentId);
    return linked?.contentType === "video" ? linked : undefined;
  };

  const getLinkedChildren = (assignmentId: string) =>
    data.assignments.filter((a) => a.linkedAssignmentId === assignmentId);

  const submitWork = async (
    assignmentId: string,
    textResponse?: string,
    file?: File,
  ) => {
    setSaving(true);
    try {
      let fileBase64: string | undefined;
      if (file) {
        setUploadPhase("reading");
        setReadPercent(0);
        fileBase64 = await fileToBase64(file, (pct) => setReadPercent(pct));
        setUploadPhase("uploading");
        setReadPercent(undefined);
      }
      await submitAssignmentWork({
        data: {
          assignmentId,
          profileId: data.profile.id,
          textResponse: textResponse?.trim() || undefined,
          fileName: file?.name,
          fileType: file?.type,
          fileBase64,
        },
      });
      setUploadPhase("done");
      await router.invalidate();
      await progressQuery.refetch();
    } catch {
      // Silently fail — the UI already shows success state
    } finally {
      setSaving(false);
      setUploadPhase("idle");
      setReadPercent(undefined);
    }
  };

  const submitQuiz = async (assignmentId: string, answers: number[]) => {
    await submitWork(assignmentId, JSON.stringify(answers));
  };

  const renderActiveAssignment = () => {
    if (!activeAssignment) return null;

    if (activeAssignment.contentType === "video") {
      return (
        <VideoAssignmentView
          assignment={activeAssignment}
          linkedAssignments={getLinkedChildren(activeAssignment.id)}
          submission={submissionMap.get(activeAssignment.id)}
          onBack={() => setActiveAssignmentId(null)}
          onNavigateTo={setActiveAssignmentId}
          onMarkWatched={(id) => void submitWork(id, "watched")}
          saving={saving}
        />
      );
    }

    if (activeAssignment.contentType === "quiz") {
      return (
        <QuizAssignmentView
          assignment={activeAssignment}
          linkedVideoAssignment={getLinkedVideo(activeAssignment)}
          submission={submissionMap.get(activeAssignment.id)}
          onBack={() => setActiveAssignmentId(null)}
          onNavigateTo={setActiveAssignmentId}
          onSubmitQuiz={submitQuiz}
          saving={saving}
        />
      );
    }

    if (activeAssignment.contentType === "essay_questions") {
      return (
        <EssayQuestionsView
          assignment={activeAssignment}
          linkedVideoAssignment={getLinkedVideo(activeAssignment)}
          submission={submissionMap.get(activeAssignment.id)}
          onBack={() => setActiveAssignmentId(null)}
          onNavigateTo={setActiveAssignmentId}
          onSubmit={(id, text) => void submitWork(id, text)}
          saving={saving}
        />
      );
    }

    if (activeAssignment.contentType === "report") {
      return (
        <ReportAssignmentView
          assignment={activeAssignment}
          submission={submissionMap.get(activeAssignment.id)}
          onBack={() => setActiveAssignmentId(null)}
          onSubmit={(id, text) => void submitWork(id, text)}
          saving={saving}
        />
      );
    }

    return (
      <GenericAssignmentView
        assignment={activeAssignment}
        submission={submissionMap.get(activeAssignment.id)}
        onBack={() => setActiveAssignmentId(null)}
        onSubmit={(id, text, file) => void submitWork(id, text, file)}
        saving={saving}
        uploadPhase={uploadPhase}
        readPercent={readPercent}
      />
    );
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <section className="rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
        <p className="text-xs uppercase tracking-[0.2em] text-cyan-700">Student Workspace</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">
          Welcome, {data.profile.displayName}
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          {data.profile.gradeLevel ? `Grade ${data.profile.gradeLevel}` : "Self-paced learner"}.{" "}
          {pendingCount > 0
            ? `${pendingCount} assignment${pendingCount === 1 ? "" : "s"} waiting.`
            : data.assignments.length > 0
              ? "All assignments complete — check your Mastery Gallery below."
              : "No assignments yet."}
        </p>
      </section>

      {/* Today's Plan */}
      {(todaysPlanQuery.data?.slots.length ?? 0) > 0 ? (
        <section className="rounded-2xl border border-cyan-200 bg-cyan-50/60 p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <span className="rounded-full bg-cyan-600 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">
              Today
            </span>
            <h2 className="text-base font-semibold text-cyan-900">Today's Plan</h2>
          </div>
          <div className="space-y-2">
            {todaysPlanQuery.data!.slots.map((slot) => {
              const submission = submissionMap.get(slot.assignmentId);
              const done = !!submission;
              return (
                <button
                  key={slot.assignmentId}
                  type="button"
                  onClick={() => setActiveAssignmentId(slot.assignmentId)}
                  className={`w-full flex items-center justify-between gap-4 rounded-xl border px-4 py-3 text-left transition ${
                    done
                      ? "border-emerald-200 bg-white/60 opacity-60"
                      : "border-cyan-200 bg-white hover:bg-cyan-50"
                  }`}
                >
                  <div className="min-w-0">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-cyan-700">
                      {slot.classTitle}
                    </p>
                    <p className="mt-0.5 text-sm font-medium text-slate-900 truncate">
                      {slot.assignmentTitle}
                    </p>
                  </div>
                  {done ? (
                    <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
                      Done
                    </span>
                  ) : (
                    <span className="shrink-0 rounded-xl bg-cyan-600 px-3 py-1.5 text-xs font-medium text-white">
                      Start →
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* Assignment area */}
      <section className="rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
        {activeAssignment ? (
          renderActiveAssignment()
        ) : (
          <>
            <h2 className="text-lg font-semibold text-slate-900">My Assignments</h2>
            <div className="mt-4">
              <AssignmentListView
                assignments={data.assignments}
                submissions={data.submissions}
                onOpen={setActiveAssignmentId}
              />
            </div>
          </>
        )}
      </section>

      {/* Mastery Gallery / Progress */}
      <section className="rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
        {pendingCount === 0 && data.assignments.length > 0 ? (
          <MasteryGallery
            displayName={data.profile.displayName}
            mastery={progressQuery.data?.mastery ?? []}
            assignments={data.assignments}
            submissions={data.submissions}
            classMap={
              new Map(
                (progressQuery.data?.mastery ?? []).map((m) => [m.classId, m.classTitle]),
              )
            }
          />
        ) : (
          <>
            <h2 className="text-lg font-semibold text-slate-900">Progress</h2>
            <div className="mt-4">
              <SkillTree
                mastery={progressQuery.data?.mastery ?? []}
                assignments={data.assignments}
                submissions={data.submissions}
                loading={progressQuery.isLoading}
              />
            </div>
          </>
        )}
      </section>
    </div>
  );
}
