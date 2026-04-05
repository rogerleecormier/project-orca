import { useState } from "react";
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
  onCreateLinkedQuiz?: (questions: QuizQuestion[], quizTitle: string) => void;
  enableQuizGeneration?: boolean;
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

// ── Main VideoSearch component ─────────────────────────────────────────────────

export function VideoSearch({
  videos,
  onVideosChange,
  disabled,
  gradeLevel,
  onCreateLinkedQuiz,
  enableQuizGeneration = true,
}: VideoSearchProps) {
  const [manualEntry, setManualEntry] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);
  const [builderMessage, setBuilderMessage] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"link" | "ai">("link");
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [results, setResults] = useState<SearchResult[]>([]);

  // Per-video quiz state (keyed by videoId)
  const [quizPanels, setQuizPanels] = useState<
    Record<
      string,
      {
        open: boolean;
        questions: QuizQuestion[];
        title: string;
        questionCount: number;
        generating: boolean;
        usedTranscript: boolean;
        transcriptStatus: string | null;
        error: string | null;
      }
    >
  >({});

  const setSingleVideo = (incoming: VideoData) => {
    if (videos[0]?.videoId === incoming.videoId) {
      setBuilderMessage("That video is already selected for this assignment.");
      return;
    }
    onVideosChange([incoming]);
    setBuilderMessage(
      videos.length > 0
        ? "Video updated. This assignment now uses the newly selected video."
        : "Video added.",
    );
  };

  const addVideos = (incoming: VideoData[]) => {
    const first = incoming[0];
    if (!first) return;
    setSingleVideo(first);
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
    setSingleVideo({ videoId: id, title: `Video (${id})`, channel: "" });
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
      prev.map((r) => ({ ...r, selected: r.videoId === videoId ? !r.selected : false })),
    );
  };

  const selectedCount = results.filter((r) => r.selected).length;

  const handleAddSelectedFromSearch = () => {
    const selected = results
      .filter((r) => r.selected)
      .map(({ selected: _selected, ...video }) => video);
    addVideos(selected);
  };

  const getQuizPanel = (videoId: string) =>
    quizPanels[videoId] ?? {
      open: false,
      questions: [],
      title: "",
      questionCount: 5,
      generating: false,
      usedTranscript: false,
      transcriptStatus: null,
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
    const panel = getQuizPanel(video.videoId);
    patchQuizPanel(video.videoId, { generating: true, error: null });
    try {
      const result = await generateQuizFromVideo({
        data: {
          videoId: video.videoId,
          videoTitle: video.title,
          videoDescription: video.description,
          gradeLevel,
          questionCount: panel.questionCount,
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
        transcriptStatus:
          result.usedTranscript
            ? "Transcript fetched from Supadata."
            : result.transcriptMeta
              ? `No transcript (${result.transcriptMeta.error ?? "UNKNOWN"}; endpoint=${result.transcriptMeta.endpoint}; status=${result.transcriptMeta.status ?? "NA"}; keyPresent=${result.transcriptMeta.keyPresent ? "yes" : "no"}).`
              : "Transcript unavailable.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Quiz generation failed.";
      const noTranscriptPrefix = "QUIZ_GENERATION_FAILED_NO_TRANSCRIPT:";
      const noTranscriptDetail = message.includes(noTranscriptPrefix)
        ? message.slice(message.indexOf(noTranscriptPrefix) + noTranscriptPrefix.length).trim()
        : null;
      const friendlyMessage =
        message.includes("QUIZ_GENERATION_FAILED_NO_TRANSCRIPT")
          ? `Quiz generation failed. Transcript was unavailable for this video.${noTranscriptDetail ? ` (${noTranscriptDetail})` : ""}`
          : message.includes("QUIZ_GENERATION_FAILED_WITH_TRANSCRIPT")
            ? "Quiz generation failed despite transcript context. Try regenerating or lowering question count."
            : message.includes("AI_QUIZ_PARSE_FAILED") || message.includes("AI_RESPONSE_PARSE_FAILED")
              ? "Quiz generation failed. Try lowering the question count or regenerating."
          : message;
      patchQuizPanel(video.videoId, { generating: false, error: friendlyMessage });
    }
  };

  return (
    <div className="space-y-4">
      {/* Input tabs */}
      <div className="rounded-xl border border-slate-200 bg-white/70 p-3">
        <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1">
          <button
            type="button"
            onClick={() => setActiveTab("link")}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
              activeTab === "link"
                ? "bg-white text-slate-900 shadow-sm"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            Paste Link
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("ai")}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
              activeTab === "ai"
                ? "bg-white text-slate-900 shadow-sm"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            Search YouTube
          </button>
        </div>

        {activeTab === "link" ? (
          <div className="mt-3 space-y-1">
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
            </div>
            {manualError ? <p className="text-xs text-rose-600">{manualError}</p> : null}
          </div>
        ) : (
          <div className="mt-3 space-y-3">
            <div className="flex gap-2">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void handleSearch()}
                disabled={disabled || searching}
                className="flex-1 rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                placeholder="e.g. Photosynthesis for 7th grade, American Revolution overview..."
              />
              <button
                type="button"
                onClick={() => void handleSearch()}
                disabled={disabled || searching || !query.trim()}
                className="shrink-0 rounded-xl bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-60"
              >
                {searching ? "Searching..." : "Search"}
              </button>
            </div>
            {searchError ? <p className="text-xs text-rose-600">{searchError}</p> : null}

            {results.length > 0 ? (
              <div className="space-y-2">
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

                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-slate-600">
                    {selectedCount === 0
                      ? "Select one video to use for this assignment."
                      : `${selectedCount} selected`}
                  </p>
                  <button
                    type="button"
                    onClick={handleAddSelectedFromSearch}
                    disabled={disabled || selectedCount === 0}
                    className="rounded-xl bg-violet-600 px-3 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-60"
                  >
                    Use Selected Video
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-xs text-slate-500">
            {query
                  ? "No results yet. Run search to see video suggestions."
                  : "Search by topic to find and add educational videos."}
            </p>
          )}
        </div>
      )}
      {builderMessage ? <p className="text-xs text-cyan-700">{builderMessage}</p> : null}
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

                {enableQuizGeneration ? (
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
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-violet-800">
                        Questions
                        <select
                          value={String(panel.questionCount)}
                          onChange={(e) =>
                            patchQuizPanel(video.videoId, { questionCount: Number(e.target.value) })
                          }
                          disabled={disabled || panel.generating}
                          className="ml-2 rounded-lg border border-violet-300 bg-white px-2 py-1 text-xs text-slate-800"
                        >
                          {Array.from({ length: 8 }, (_, index) => index + 3).map((count) => (
                            <option key={count} value={count}>
                              {count}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        type="button"
                        onClick={() => void handleGenerateQuiz(video)}
                        disabled={disabled || panel.generating}
                        className="shrink-0 rounded-xl bg-violet-600 px-3 py-2 text-xs font-medium text-white hover:bg-violet-700 disabled:opacity-60"
                      >
                        {panel.generating ? "Generating..." : panel.open ? "Regenerate" : "Generate Quiz"}
                      </button>
                    </div>
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
                      {panel.transcriptStatus ? (
                        <p className="text-xs text-slate-600">{panel.transcriptStatus}</p>
                      ) : null}

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
                        disabled={disabled || panel.questions.length === 0 || !panel.title.trim() || !onCreateLinkedQuiz}
                        onClick={() => onCreateLinkedQuiz?.(panel.questions, panel.title)}
                        className="w-full rounded-xl bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-60"
                      >
                        Save as Linked Quiz Assignment
                      </button>
                    </div>
                  ) : null}
                </div>
                ) : (
                  <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4">
                    <p className="text-sm font-medium text-slate-700">
                      Step 2 happens after save
                    </p>
                    <p className="text-xs text-slate-600">
                      Save this video assignment first. Then switch to the Quiz assignment type and generate from this saved video transcript.
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

    </div>
  );
}
