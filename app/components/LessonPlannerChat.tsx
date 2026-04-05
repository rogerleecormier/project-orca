import { useEffect, useRef, useState } from "react";
import { lessonPlannerChat } from "../server/functions";

type Message = {
  role: "user" | "assistant";
  content: string;
};

type AssignmentSuggestion = {
  title: string;
  type: string;
  description: string;
};

type Props = {
  studentName: string;
  grade: string | null;
  classList: string[];
  onCreateAssignment?: (suggestion: AssignmentSuggestion) => void;
};

function extractTopicFromPrompt(prompt: string) {
  return prompt
    .replace(/\b(i need|i want|please|can you|could you|help me|create|make|give me)\b/gi, "")
    .replace(/\b(assignments?|lessons?|ideas?|for|about|on)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildFallbackSuggestionsFromPrompt(prompt: string, grade: string | null) {
  const topic = extractTopicFromPrompt(prompt) || "the topic";
  const gradeSuffix = grade ? ` (Grade ${grade})` : "";

  return [
    {
      title: `Background Reading: ${topic}`,
      type: "text",
      description: `Read a short passage about ${topic}${gradeSuffix} and list 5 key facts in your own words.`,
    },
    {
      title: `Video Lesson: ${topic}`,
      type: "video",
      description: `Watch one age-appropriate video on ${topic} and write 3 things you learned.`,
    },
    {
      title: `Check for Understanding: ${topic}`,
      type: "quiz",
      description: "Complete a short 5-question quiz covering the main vocabulary and ideas from the lesson.",
    },
  ] satisfies AssignmentSuggestion[];
}

function inferFallbackSuggestions(
  assistantContent: string,
  previousUserPrompt: string | null,
  grade: string | null,
) {
  if (!previousUserPrompt) {
    return [];
  }

  const userAskedForAssignments = /\b(assignments?|lesson ideas?|topic ideas?)\b/i.test(
    previousUserPrompt,
  );

  if (!userAskedForAssignments) {
    return [];
  }

  const assistantIndicatesSuggestions = /\b(assignment suggestions|suggestions|here are|for grade)\b/i.test(
    assistantContent,
  );

  if (!assistantIndicatesSuggestions) {
    return [];
  }

  return buildFallbackSuggestionsFromPrompt(previousUserPrompt, grade);
}

function parseAssignmentSuggestions(content: string): AssignmentSuggestion[] {
  const matches = content.matchAll(
    /ASSIGNMENT_SUGGESTION:\s*title="([^"]+)"\s+type=(\S+)\s+description="([\s\S]*?)"/g,
  );

  const suggestions: AssignmentSuggestion[] = [];
  for (const match of matches) {
    const title = match[1]?.trim();
    const type = match[2]?.trim();
    const description = match[3]?.trim();

    if (!title || !type || !description) {
      continue;
    }

    suggestions.push({ title, type, description });
  }

  return suggestions;
}

function stripSuggestionTag(content: string): string {
  return content
    .replace(/ASSIGNMENT_SUGGESTION:\s*title="[^"]+"\s+type=\S+\s+description="[\s\S]*?"\n?/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function MessageBubble({
  message,
  grade,
  previousUserPrompt,
  onCreateAssignment,
}: {
  message: Message;
  grade: string | null;
  previousUserPrompt: string | null;
  onCreateAssignment?: (s: AssignmentSuggestion) => void;
}) {
  const isUser = message.role === "user";
  const parsedSuggestions = !isUser ? parseAssignmentSuggestions(message.content) : [];
  const suggestions =
    parsedSuggestions.length > 0
      ? parsedSuggestions
      : !isUser
        ? inferFallbackSuggestions(message.content, previousUserPrompt, grade)
        : [];
  const displayText = suggestions.length > 0 ? stripSuggestionTag(message.content) : message.content;

  return (
    <div className={`flex flex-col gap-1.5 ${isUser ? "items-end" : "items-start"}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
          isUser
            ? "bg-cyan-600 text-white"
            : "bg-slate-100 text-slate-800 border border-slate-200"
        }`}
      >
        {displayText}
      </div>
      {suggestions.length > 0 && onCreateAssignment ? (
        <div className="flex w-full max-w-[85%] flex-col gap-2">
          {suggestions.map((suggestion) => (
            <button
              key={`${suggestion.title}-${suggestion.type}`}
              onClick={() => onCreateAssignment(suggestion)}
              className="rounded-xl border border-cyan-200 bg-cyan-50 px-3 py-2 text-left text-xs text-cyan-900 hover:bg-cyan-100 transition"
            >
              <p className="font-semibold">Create: {suggestion.title}</p>
              <p className="mt-0.5 text-[11px] uppercase tracking-wide text-cyan-700">{suggestion.type}</p>
              <p className="mt-1 text-xs text-cyan-900/90">{suggestion.description}</p>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function LessonPlannerChat({ studentName, grade, classList, onCreateAssignment }: Props) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open && messages.length === 0) {
      setMessages([
        {
          role: "assistant",
          content: `Hi! I'm your curriculum assistant for ${studentName}${grade ? ` (Grade ${grade})` : ""}. I can help you plan lessons, suggest topics, or generate assignment sequences. What would you like to work on?`,
        },
      ]);
    }
  }, [open, messages.length, studentName, grade]);

  useEffect(() => {
    if (open) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, open]);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    }
  }, [open]);

  const send = async () => {
    const text = input.trim();
    if (!text || loading) return;

    const userMessage: Message = { role: "user", content: text };
    const nextMessages = [...messages, userMessage].slice(-40);

    setMessages(nextMessages);
    setInput("");
    setLoading(true);
    setError(null);

    // Only send messages starting from the first user turn — the greeting is
    // a local-only assistant message and must not be sent to the model.
    const firstUserIdx = nextMessages.findIndex((m) => m.role === "user");
    const apiMessages = firstUserIdx >= 0 ? nextMessages.slice(firstUserIdx) : nextMessages;

    try {
      const result = await lessonPlannerChat({
        data: {
          messages: apiMessages,
          studentName,
          grade,
          classList,
        },
      });

      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: result.content },
      ]);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      {/* Floating button */}
      <button
        onClick={() => setOpen(true)}
        aria-label="Open AI Lesson Planner"
        className="fixed bottom-6 right-6 z-40 flex items-center gap-2 rounded-full bg-cyan-600 px-4 py-3 text-sm font-semibold text-white shadow-lg hover:bg-cyan-700 transition"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          className="h-5 w-5 shrink-0"
          aria-hidden="true"
        >
          <path
            d="M9.5 2a6.5 6.5 0 0 1 6.34 5.022A5.5 5.5 0 0 1 19 12.5c0 3.038-2.462 5.5-5.5 5.5H7A5 5 0 0 1 7 8h.085A6.504 6.504 0 0 1 9.5 2Z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M8 13h8M8 17h5"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
        AI Assistant
      </button>

      {/* Modal */}
      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-end pb-24 pr-6 sm:items-center sm:justify-end sm:pb-0 sm:pr-6"
          role="dialog"
          aria-modal="true"
          aria-label="AI Lesson Planner"
        >
          {/* Backdrop */}
          <button
            className="fixed inset-0 bg-slate-900/20 backdrop-blur-sm"
            onClick={() => setOpen(false)}
            aria-label="Close AI assistant"
            tabIndex={-1}
          />

          {/* Panel */}
          <div className="relative flex w-full max-w-sm flex-col rounded-2xl border border-slate-200 bg-white shadow-2xl sm:h-[580px] h-[500px]">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <div>
                <p className="text-sm font-semibold text-slate-900">AI Lesson Planner</p>
                <p className="text-xs text-slate-500">
                  {studentName}{grade ? ` · Grade ${grade}` : ""}
                </p>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"
                aria-label="Close"
              >
                <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
                  <path
                    d="M18 6 6 18M6 6l12 12"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
              {messages.map((msg, i) => (
                // Associate each assistant message with the most recent user prompt.
                // This lets us synthesize fallback assignment cards when the AI response is prose-only.
                (() => {
                  const previousUserPrompt = [...messages]
                    .slice(0, i)
                    .reverse()
                    .find((candidate) => candidate.role === "user")?.content ?? null;

                  return (
                    <MessageBubble
                      key={i}
                      message={msg}
                      grade={grade}
                      previousUserPrompt={previousUserPrompt}
                      onCreateAssignment={onCreateAssignment}
                    />
                  );
                })()
              ))}
              {loading ? (
                <div className="flex items-start">
                  <div className="rounded-2xl border border-slate-200 bg-slate-100 px-3.5 py-2.5">
                    <span className="inline-flex gap-1">
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:0ms]" />
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:150ms]" />
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:300ms]" />
                    </span>
                  </div>
                </div>
              ) : null}
              {error ? (
                <p className="text-xs font-medium text-rose-600 text-center">{error}</p>
              ) : null}
              <div ref={bottomRef} />
            </div>

            {/* Input */}
            <div className="border-t border-slate-200 p-3">
              <div className="flex items-end gap-2">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  placeholder="Ask for lesson ideas, topic sequences…"
                  rows={2}
                  disabled={loading}
                  className="flex-1 resize-none rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-cyan-500 focus:outline-none disabled:opacity-60"
                />
                <button
                  onClick={() => void send()}
                  disabled={!input.trim() || loading}
                  className="rounded-xl bg-cyan-600 px-3 py-2 text-sm font-semibold text-white hover:bg-cyan-700 disabled:opacity-50 transition shrink-0"
                >
                  Send
                </button>
              </div>
              <p className="mt-1.5 text-[11px] text-slate-400">Enter to send · Shift+Enter for newline</p>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
