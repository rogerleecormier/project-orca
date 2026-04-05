import { useEffect, useRef, useState } from "react";
import { generateQuizFromVideo, searchYoutubeWithAI } from "../server/functions";
import { QuizBuilder } from "./quiz-builder";
import type { QuizQuestion } from "./quiz-builder";

export type VideoData = {
  videoId: string;
  title: string;
  channel: string;
  description?: string;
  thumbnail?: string;
};

type SearchResult = VideoData & { selected: boolean };

type VideoSearchProps = {
  videos: VideoData[];
  onVideosChange: (videos: VideoData[]) => void;
  disabled?: boolean;
  gradeLevel?: string;
  onCreateLinkedQuiz: (questions: QuizQuestion[], quizTitle: string) => void;
};

function extractYoutubeId(input: string): string | null {
  input = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;
  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /embed\/([a-zA-Z0-9_-]{11})/,
    /shorts\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = input.match(p);
    if (m) return m[1];
  }
  return null;
}

// ── AI Search Modal ────────────────────────────────────────────────────────────

function AISearchModal({
  onAdd,
  onClose,
}: {
  onAdd: (videos: VideoData[]) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [results, setResults] = useState<SearchResult[]>([]);
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setSearchError(null);
    try {
      const result = await searchYoutubeWithAI({ data: { query: query.trim() } });
      setResults(result.videos.map((v) => ({ ...v, selected: false })));
    } catch {
      setSearchError("AI search failed. Check your topic and try again.");
    } finally {
      setSearching(false);
    }
  };

  const toggleSelect = (videoId: string) => {
    setResults((prev) =>
      prev.map((r) => (r.videoId === videoId ? { ...r, selected: !r.selected } : r)),
    );
  };

  const selectedCount = results.filter((r) => r.selected).length;

  const handleAdd = () => {
    const selected = results
      .filter((r) => r.selected)
      .map(({ selected: _s, ...v }) => v);
    onAdd(selected);
  };

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 backdrop-blur-sm p-4"
      onClick={(e) => e.target === backdropRef.current && onClose()}
    >
      <div className="relative my-8 w-full max-w-3xl rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <div className="flex items-center justify-between gap-4 border-b border-slate-200 px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">AI Video Search</h2>
            <p className="text-sm text-slate-500">
              Describe the topic and AI will suggest relevant educational videos.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
          >
            Close
          </button>
        </div>

        <div className="px-6 py-4 border-b border-slate-100">
          <div className="flex gap-2">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void handleSearch()}
              disabled={searching}
              className="flex-1 rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
              placeholder="e.g. Photosynthesis for 7th grade, American Revolution overview..."
            />
            <button
              type="button"
              onClick={() => void handleSearch()}
              disabled={searching || !query.trim()}
              className="shrink-0 rounded-xl bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-60"
            >
              {searching ? "Searching…" : "Search"}
            </button>
          </div>
          {searchError ? <p className="mt-2 text-xs text-rose-600">{searchError}</p> : null}
        </div>

        <div className="px-6 py-4 min-h-32">
          {results.length === 0 && !searching ? (
            <p className="text-sm text-slate-500 italic">
              {query ? "No results yet — click Search." : "Enter a topic above to find videos."}
            </p>
          ) : null}

          {searching ? (
            <div className="flex items-center justify-center py-12">
              <p className="text-sm text-slate-500 animate-pulse">AI is finding videos…</p>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {results.map((result) => (
                <button
                  key={result.videoId}
                  type="button"
                  onClick={() => toggleSelect(result.videoId)}
                  className={[
                    "relative flex flex-col overflow-hidden rounded-xl border-2 text-left transition",
                    result.selected
                      ? "border-violet-500 bg-violet-50"
                      : "border-slate-200 bg-white hover:border-violet-300",
                  ].join(" ")}
                >
                  <div className="relative w-full bg-slate-900" style={{ paddingTop: "56.25%" }}>
                    <img
                      src={result.thumbnail ?? `https://img.youtube.com/vi/${result.videoId}/hqdefault.jpg`}
                      alt={result.title}
                      className="absolute inset-0 h-full w-full object-cover"
                    />
                    <div
                      className={[
                        "absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full border-2 text-xs font-bold transition",
                        result.selected
                          ? "border-violet-500 bg-violet-500 text-white"
                          : "border-white bg-white/80 text-slate-400",
                      ].join(" ")}
                    >
                      {result.selected ? "✓" : ""}
                    </div>
                  </div>
                  <div className="p-3 flex-1">
                    <p className="text-sm font-semibold text-slate-900 line-clamp-2 leading-snug">
                      {result.title}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">{result.channel}</p>
                    {result.description ? (
                      <p className="mt-1 text-xs text-slate-600 line-clamp-2">{result.description}</p>
                    ) : null}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {results.length > 0 ? (
          <div className="flex items-center justify-between gap-3 border-t border-slate-200 px-6 py-4">
            <p className="text-sm text-slate-600">
              {selectedCount === 0
                ? "Select one or more videos to add."
                : `${selectedCount} video${selectedCount !== 1 ? "s" : ""} selected`}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleAdd}
                disabled={selectedCount === 0}
                className="rounded-xl bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-60"
              >
                Add {selectedCount > 0 ? `${selectedCount} ` : ""}Selected
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ── Main VideoSearch component ─────────────────────────────────────────────────

export function VideoSearch({
  videos,
  onVideosChange,
  disabled,
  gradeLevel,
  onCreateLinkedQuiz,
}: VideoSearchProps) {
  const [manualEntry, setManualEntry] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  // Per-video quiz state (keyed by videoId)
  const [quizPanels, setQuizPanels] = useState<
    Record<
      string,
      {
        open: boolean;
        questions: QuizQuestion[];
        title: string;
        generating: boolean;
        usedTranscript: boolean;
        error: string | null;
      }
    >
  >({});

  const addVideos = (incoming: VideoData[]) => {
    const existingIds = new Set(videos.map((v) => v.videoId));
    const fresh = incoming.filter((v) => !existingIds.has(v.videoId));
    onVideosChange([...videos, ...fresh]);
    setModalOpen(false);
  };

  const handleManualAdd = () => {
    setManualError(null);
    const id = extractYoutubeId(manualEntry);
    if (!id) {
      setManualError("Could not read a video ID from that URL or ID.");
      return;
    }
    if (videos.some((v) => v.videoId === id)) {
      setManualError("That video is already added.");
      return;
    }
    onVideosChange([...videos, { videoId: id, title: `Video (${id})`, channel: "" }]);
    setManualEntry("");
  };

  const removeVideo = (videoId: string) => {
    onVideosChange(videos.filter((v) => v.videoId !== videoId));
    setQuizPanels((prev) => {
      const next = { ...prev };
      delete next[videoId];
      return next;
    });
  };

  const getQuizPanel = (videoId: string) =>
    quizPanels[videoId] ?? {
      open: false,
      questions: [],
      title: "",
      generating: false,
      usedTranscript: false,
      error: null,
    };

  const patchQuizPanel = (
    videoId: string,
    patch: Partial<ReturnType<typeof getQuizPanel>>,
  ) => {
    setQuizPanels((prev) => ({
      ...prev,
      [videoId]: { ...getQuizPanel(videoId), ...patch },
    }));
  };

  const handleGenerateQuiz = async (video: VideoData) => {
    patchQuizPanel(video.videoId, { generating: true, error: null });
    try {
      const result = await generateQuizFromVideo({
        data: {
          videoId: video.videoId,
          videoTitle: video.title,
          videoDescription: video.description,
          gradeLevel,
          questionCount: 5,
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
      patchQuizPanel(video.videoId, {
        questions,
        title: `${video.title} — Quiz`,
        open: true,
        generating: false,
        usedTranscript: result.usedTranscript,
      });
    } catch {
      patchQuizPanel(video.videoId, { generating: false, error: "Quiz generation failed." });
    }
  };

  return (
    <div className="space-y-4">
      {/* Manual entry row */}
      <div className="space-y-1">
        <label className="text-sm font-medium text-slate-700">Video ID or YouTube URL</label>
        <div className="flex gap-2">
          <input
            value={manualEntry}
            onChange={(e) => setManualEntry(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleManualAdd()}
            disabled={disabled}
            className="flex-1 rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
            placeholder="Paste a YouTube URL or 11-char video ID"
          />
          <button
            type="button"
            onClick={handleManualAdd}
            disabled={disabled || !manualEntry.trim()}
            className="shrink-0 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
          >
            Add
          </button>
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            disabled={disabled}
            className="shrink-0 rounded-xl bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-60"
          >
            AI Search
          </button>
        </div>
        {manualError ? <p className="text-xs text-rose-600">{manualError}</p> : null}
      </div>

      {/* Selected videos */}
      {videos.length === 0 ? (
        <p className="text-sm text-slate-500 italic">No videos added yet.</p>
      ) : (
        <div className="space-y-5">
          {videos.map((video) => {
            const panel = getQuizPanel(video.videoId);
            return (
              <div
                key={video.videoId}
                className="rounded-xl border border-slate-200 bg-slate-50/60 p-4 space-y-3"
              >
                {/* Header */}
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{video.title}</p>
                    {video.channel ? (
                      <p className="text-xs text-slate-500">{video.channel}</p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => removeVideo(video.videoId)}
                    className="text-xs text-rose-600 hover:text-rose-800 shrink-0"
                  >
                    Remove
                  </button>
                </div>

                {/* Player */}
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

                {/* Linked quiz panel */}
                <div className="rounded-xl border border-dashed border-violet-300 bg-violet-50/60 p-4 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-violet-900">
                        Generate Quiz from This Video
                      </p>
                      <p className="text-xs text-violet-600">
                        AI fetches the video transcript for accurate questions.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleGenerateQuiz(video)}
                      disabled={disabled || panel.generating}
                      className="shrink-0 rounded-xl bg-violet-600 px-3 py-2 text-xs font-medium text-white hover:bg-violet-700 disabled:opacity-60"
                    >
                      {panel.generating ? "Generating…" : panel.open ? "Regenerate" : "Generate Quiz"}
                    </button>
                  </div>

                  {panel.error ? (
                    <p className="text-xs text-rose-600">{panel.error}</p>
                  ) : null}

                  {panel.open ? (
                    <div className="space-y-3 border-t border-violet-200 pt-3">
                      {panel.usedTranscript ? (
                        <p className="text-xs text-emerald-700 font-medium">
                          Questions generated from video transcript.
                        </p>
                      ) : (
                        <p className="text-xs text-amber-700">
                          Transcript unavailable — questions based on video title/description.
                        </p>
                      )}

                      <label className="block space-y-1">
                        <span className="text-sm font-medium text-violet-900">
                          Quiz Assignment Title
                        </span>
                        <input
                          value={panel.title}
                          onChange={(e) => patchQuizPanel(video.videoId, { title: e.target.value })}
                          disabled={disabled}
                          className="w-full rounded-xl border border-violet-300 bg-white px-3 py-2 text-sm text-slate-800"
                        />
                      </label>

                      <QuizBuilder
                        questions={panel.questions}
                        onChange={(q) => patchQuizPanel(video.videoId, { questions: q })}
                        disabled={disabled}
                      />

                      <button
                        type="button"
                        disabled={disabled || panel.questions.length === 0 || !panel.title.trim()}
                        onClick={() => onCreateLinkedQuiz(panel.questions, panel.title)}
                        className="w-full rounded-xl bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-60"
                      >
                        Save as Linked Quiz Assignment
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* AI Search Modal */}
      {modalOpen ? (
        <AISearchModal onAdd={addVideos} onClose={() => setModalOpen(false)} />
      ) : null}
    </div>
  );
}
