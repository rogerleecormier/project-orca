import { useMemo, useState } from "react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { InVideoLesson } from "../components/in-video-lesson";
import {
  getViewerContext,
  getProgressSnapshot,
  getStudentWorkspaceData,
  submitAssignmentWork,
} from "../server/functions";

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

async function fileToBase64(file: File) {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("FILE_READ_FAILED"));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(file);
  });
}

function StudentWorkspacePage() {
  const router = useRouter();
  const data = Route.useLoaderData();
  const [activeAssignmentId, setActiveAssignmentId] = useState(data.assignments[0]?.id ?? "");
  const [textResponse, setTextResponse] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const progressQuery = useQuery({
    queryKey: ["progress-snapshot", data.profile.id],
    queryFn: async () =>
      await getProgressSnapshot({
        data: {
          profileId: data.profile.id,
        },
      }),
    refetchInterval: 20_000,
  });

  const pendingCount = useMemo(
    () => data.assignments.length - data.submissions.length,
    [data.assignments.length, data.submissions.length],
  );

  const submitWork = async () => {
    if (!activeAssignmentId) {
      setError("Select an assignment first.");
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const encodedFile = selectedFile ? await fileToBase64(selectedFile) : undefined;

      await submitAssignmentWork({
        data: {
          assignmentId: activeAssignmentId,
          profileId: data.profile.id,
          textResponse: textResponse.trim() || undefined,
          fileName: selectedFile?.name,
          fileType: selectedFile?.type,
          fileBase64: encodedFile,
        },
      });

      setTextResponse("");
      setSelectedFile(null);
      await router.invalidate();
      await progressQuery.refetch();
    } catch {
      setError("Unable to submit right now. Try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
        <p className="text-xs uppercase tracking-[0.2em] text-cyan-700">Student Workspace</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">Welcome, {data.profile.displayName}</h1>
        <p className="mt-2 text-sm text-slate-600">
          {data.profile.gradeLevel ? `Grade ${data.profile.gradeLevel}` : "Self-paced learner"}.
          {" "}
          {pendingCount > 0
            ? `${pendingCount} assignment${pendingCount === 1 ? "" : "s"} waiting.`
            : "All caught up for now."}
        </p>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">Submission Center</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="space-y-2 md:col-span-2">
            <span className="text-sm font-medium text-slate-700">Assignment</span>
            <select
              value={activeAssignmentId}
              onChange={(event) => setActiveAssignmentId(event.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
            >
              {data.assignments.map((assignment) => (
                <option key={assignment.id} value={assignment.id}>
                  {assignment.title}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-2 md:col-span-2">
            <span className="text-sm font-medium text-slate-700">Written Response</span>
            <textarea
              value={textResponse}
              onChange={(event) => setTextResponse(event.target.value)}
              className="min-h-28 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
              placeholder="Write your response, summary, or notes"
            />
          </label>

          <label className="space-y-2 md:col-span-2">
            <span className="text-sm font-medium text-slate-700">Attach File (optional)</span>
            <input
              type="file"
              onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800"
            />
          </label>
        </div>

        {error ? <p className="mt-3 text-sm text-rose-700">{error}</p> : null}

        <button
          disabled={submitting || data.assignments.length === 0}
          onClick={() => {
            void submitWork();
          }}
          className="mt-4 rounded-xl bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? "Submitting..." : "Submit Assignment"}
        </button>
      </section>

      <InVideoLesson
        videoUrl={data.lesson.videoUrl}
        checkpoints={data.lesson.checkpoints}
      />

      <section className="rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">Progress Visualization</h2>
        <p className="mt-1 text-sm text-slate-600">
          Mastery and completion sync with TanStack Query in near real-time.
        </p>

        <div className="mt-4 space-y-3">
          {(progressQuery.data?.mastery ?? []).map((item) => (
            <article key={item.classId} className="rounded-xl border border-slate-200 p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-semibold text-slate-900">{item.classTitle}</h3>
                <p className="text-sm text-slate-600">{item.completionPercent}% complete</p>
              </div>
              <div className="mt-2 h-2 w-full rounded-full bg-slate-200">
                <div
                  className="h-2 rounded-full bg-cyan-500"
                  style={{ width: `${item.completionPercent}%` }}
                />
              </div>
              <p className="mt-2 text-sm text-slate-600">
                Avg score: {item.averageScore === null ? "Not graded yet" : `${item.averageScore}%`}
              </p>
            </article>
          ))}

          {!progressQuery.isLoading && (progressQuery.data?.mastery.length ?? 0) === 0 ? (
            <p className="text-sm text-slate-500">No class mastery data available yet.</p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
