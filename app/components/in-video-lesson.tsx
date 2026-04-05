import { useEffect, useMemo, useRef, useState } from "react";

type Checkpoint = {
  id: string;
  atSeconds: number;
  prompt: string;
};

type InVideoLessonProps = {
  videoUrl: string;
  checkpoints: Checkpoint[];
};

export function InVideoLesson({ videoUrl, checkpoints }: InVideoLessonProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [triggered, setTriggered] = useState<Record<string, boolean>>({});
  const [activePrompt, setActivePrompt] = useState<Checkpoint | null>(null);
  const [responseByCheckpoint, setResponseByCheckpoint] = useState<Record<string, string>>({});

  const sortedCheckpoints = useMemo(
    () => [...checkpoints].sort((a, b) => a.atSeconds - b.atSeconds),
    [checkpoints],
  );

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    const onTimeUpdate = () => {
      if (activePrompt) {
        return;
      }

      const currentSeconds = video.currentTime;
      const nextCheckpoint = sortedCheckpoints.find(
        (checkpoint) => currentSeconds >= checkpoint.atSeconds && !triggered[checkpoint.id],
      );

      if (!nextCheckpoint) {
        return;
      }

      setTriggered((current) => ({
        ...current,
        [nextCheckpoint.id]: true,
      }));
      setActivePrompt(nextCheckpoint);
      video.pause();
    };

    video.addEventListener("timeupdate", onTimeUpdate);
    return () => video.removeEventListener("timeupdate", onTimeUpdate);
  }, [activePrompt, sortedCheckpoints, triggered]);

  return (
    <section className="rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-slate-900">Lesson Interaction</h2>
      <p className="mt-1 text-sm text-slate-600">
        Questions appear during playback and pause the lesson for active reflection.
      </p>

      <video
        ref={videoRef}
        controls
        className="mt-4 w-full rounded-xl border border-slate-200 bg-black"
        src={videoUrl}
      />

      {activePrompt ? (
        <div className="mt-4 rounded-xl border border-cyan-200 bg-cyan-50 p-4">
          <p className="text-sm font-medium text-slate-900">In-video checkpoint</p>
          <p className="mt-2 text-sm text-slate-700">{activePrompt.prompt}</p>

          <textarea
            value={responseByCheckpoint[activePrompt.id] ?? ""}
            onChange={(event) =>
              setResponseByCheckpoint((current) => ({
                ...current,
                [activePrompt.id]: event.target.value,
              }))
            }
            className="mt-3 min-h-24 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800"
            placeholder="Type your answer before continuing..."
          />

          <button
            className="mt-3 rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
            onClick={() => {
              setActivePrompt(null);
              void videoRef.current?.play();
            }}
          >
            Continue Lesson
          </button>
        </div>
      ) : null}
    </section>
  );
}
