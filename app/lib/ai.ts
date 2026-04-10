import { env } from "cloudflare:workers";
import { z } from "zod";

const DEFAULT_LLM_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

export type YoutubeVideo = {
  videoId: string;
  title: string;
  channel: string;
  description: string;
  thumbnail: string;
};

export async function searchYoutubeForVideos(
  query: string,
  apiKey: string,
): Promise<YoutubeVideo[]> {
  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("q", query);
  url.searchParams.set("type", "video");
  url.searchParams.set("maxResults", "8");
  url.searchParams.set("relevanceLanguage", "en");
  url.searchParams.set("safeSearch", "strict");
  url.searchParams.set("key", apiKey);

  const response = await fetch(url.toString());

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`YouTube API error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as {
    items: Array<{
      id: { videoId: string };
      snippet: {
        title: string;
        channelTitle: string;
        description: string;
        thumbnails: { high?: { url: string }; medium?: { url: string } };
      };
    }>;
  };

  return (data.items ?? []).map((item) => ({
    videoId: item.id.videoId,
    title: item.snippet.title,
    channel: item.snippet.channelTitle,
    description: item.snippet.description,
    thumbnail:
      item.snippet.thumbnails.high?.url ??
      item.snippet.thumbnails.medium?.url ??
      `https://img.youtube.com/vi/${item.id.videoId}/hqdefault.jpg`,
  }));
}

// ── YouTube transcript via Supadata ──────────────────────────────────────────

type TranscriptSegment = {
  text: string;
  offset: number;
  duration: number;
};

type SupadataResponse = {
  content: TranscriptSegment[] | string;
  lang?: string;
  availableLangs?: string[];
};

export type TranscriptFetchMeta = {
  keyPresent: boolean;
  attempted: boolean;
  endpoint: "youtube" | "transcript";
  status: number | null;
  ok: boolean;
  error: string | null;
};

export type TranscriptFetchResult = {
  transcript: string | null;
  meta: TranscriptFetchMeta;
};

function extractTranscriptContent(data: unknown): string | null {
  if (!data || typeof data !== "object") {
    return null;
  }

  const payload = data as SupadataResponse;

  if (typeof payload.content === "string") {
    return payload.content.trim() || null;
  }

  if (Array.isArray(payload.content)) {
    return payload.content
      .map((s) => s.text)
      .join(" ")
      .trim() || null;
  }

  return null;
}

async function fetchSupadataEndpoint(
  endpoint: "youtube" | "transcript",
  videoId: string,
  apiKey: string,
): Promise<TranscriptFetchResult> {
  const url =
    endpoint === "youtube"
      ? `https://api.supadata.ai/v1/youtube/transcript?videoId=${encodeURIComponent(videoId)}&text=true`
      : `https://api.supadata.ai/v1/transcript?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&text=true&mode=auto`;

  try {
    const response = await fetch(url, {
      headers: { "x-api-key": apiKey },
    });

    const body = await response.json().catch(() => null);
    const transcript = response.ok ? extractTranscriptContent(body) : null;
    const error =
      response.ok
        ? null
        : typeof (body as Record<string, unknown> | null)?.message === "string"
          ? ((body as Record<string, unknown>).message as string)
          : `HTTP_${response.status}`;

    return {
      transcript,
      meta: {
        keyPresent: true,
        attempted: true,
        endpoint,
        status: response.status,
        ok: response.ok,
        error,
      },
    };
  } catch (error) {
    return {
      transcript: null,
      meta: {
        keyPresent: true,
        attempted: true,
        endpoint,
        status: null,
        ok: false,
        error: error instanceof Error ? error.message : "NETWORK_ERROR",
      },
    };
  }
}

export async function fetchYoutubeTranscriptWithMeta(videoId: string): Promise<TranscriptFetchResult> {
  const apiKey = (env as unknown as Record<string, string | undefined>).SUPADATA_API_KEY;
  if (!apiKey) {
    return {
      transcript: null,
      meta: {
        keyPresent: false,
        attempted: false,
        endpoint: "youtube",
        status: null,
        ok: false,
        error: "SUPADATA_API_KEY_MISSING",
      },
    };
  }

  // Prefer original YouTube-specific endpoint first.
  const primary = await fetchSupadataEndpoint("youtube", videoId, apiKey);
  if (primary.transcript) {
    return primary;
  }

  // Fall back to the generic transcript endpoint.
  const fallback = await fetchSupadataEndpoint("transcript", videoId, apiKey);
  if (fallback.transcript) {
    return fallback;
  }

  return fallback.meta.attempted ? fallback : primary;
}

/**
 * Fetch the transcript for a YouTube video via Supadata.
 * Returns the full transcript as a single string, or null if unavailable or
 * the API key is not configured.
 */
export async function fetchYoutubeTranscript(videoId: string): Promise<string | null> {
  const result = await fetchYoutubeTranscriptWithMeta(videoId);
  return result.transcript;
}

// ── Submission grading ────────────────────────────────────────────────────────

export type GradingResult = {
  score: number;
  strengths: string[];
  improvements: string[];
  overallFeedback: string;
};

export async function gradeSubmission(input: {
  submissionText: string;
  assignmentTitle: string;
  rubricOrInstructions?: string;
  gradeLevel: string;
}): Promise<GradingResult> {
  const rubricSection = input.rubricOrInstructions
    ? `Assignment instructions / rubric:\n"""\n${input.rubricOrInstructions.slice(0, 3000)}\n"""`
    : `Assignment: ${input.assignmentTitle}`;

  const prompt = [
    "You are a supportive homeschool grading assistant. Evaluate the student submission below and return ONLY valid JSON.",
    "Required JSON shape:",
    '{"score":85,"strengths":["string","string"],"improvements":["string","string"],"overallFeedback":"string"}',
    "Rules:",
    "- score: integer 0–100 based on quality, completeness, and rubric adherence",
    "- strengths: 2–4 specific things the student did well",
    "- improvements: 2–4 specific, constructive suggestions",
    "- overallFeedback: 2–3 sentence encouraging summary",
    `- Grade level context: ${input.gradeLevel}`,
    "",
    rubricSection,
    "",
    "Student submission:",
    `"""\n${input.submissionText.slice(0, 5000)}\n"""`,
    "",
    "Return ONLY the JSON object. No markdown, no prose.",
  ].join("\n");

  const result = await env.AI.run(DEFAULT_LLM_MODEL, {
    messages: [
      {
        role: "system",
        content: "You are a precise grading assistant that outputs strict JSON only.",
      },
      { role: "user", content: prompt },
    ],
    max_tokens: 800,
  });

  const responseText = toModelText(result);
  const parsed = extractJsonPayload(responseText);

  if (
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed)
  ) {
    const record = parsed as Record<string, unknown>;
    const score = typeof record.score === "number" ? Math.round(Math.min(100, Math.max(0, record.score))) : null;
    const strengths = Array.isArray(record.strengths) ? record.strengths.filter((s): s is string => typeof s === "string") : [];
    const improvements = Array.isArray(record.improvements) ? record.improvements.filter((s): s is string => typeof s === "string") : [];
    const overallFeedback = typeof record.overallFeedback === "string" ? record.overallFeedback : "";

    if (score !== null && strengths.length > 0 && overallFeedback) {
      return { score, strengths, improvements, overallFeedback };
    }
  }

  throw new Error("AI_GRADING_PARSE_FAILED");
}

// ── Quiz generation ───────────────────────────────────────────────────────────

const quizItemSchema = z.object({
  question: z.string().trim().min(1),
  options: z.array(z.string().trim().min(1)).length(4),
  answerIndex: z.number().int().min(0).max(3),
  explanation: z.string().trim().min(1),
});

const quizResponseSchema = z.object({
  title: z.string().trim().min(1),
  questions: z.array(quizItemSchema).min(1),
});

export type GenerateQuizInput = {
  topic: string;
  gradeLevel?: string;
  questionCount?: number;
  /** Generic source material (e.g. reading assignment body) */
  sourceText?: string;
  /** Full video transcript text — dramatically improves accuracy */
  transcript?: string;
  /** YouTube video description — used when transcript is not available */
  videoDescription?: string;
};

function sanitizeQuiz(raw: z.infer<typeof quizResponseSchema>) {
  return {
    title: raw.title,
    questions: raw.questions.map((item) => {
      const boundedAnswerIndex = Math.min(
        Math.max(item.answerIndex, 0),
        item.options.length - 1,
      );

      return {
        question: item.question,
        options: item.options,
        answerIndex: boundedAnswerIndex,
        explanation: item.explanation,
      };
    }),
  };
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractJsonPayload(responseText: string): unknown {
  const fenced = responseText.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) {
    const parsed = tryParseJson(fenced.trim());
    if (parsed !== null) return parsed;
  }

  const direct = tryParseJson(responseText.trim());
  if (direct !== null) return direct;

  const firstBrace = responseText.indexOf("{");
  const lastBrace = responseText.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const objectCandidate = responseText.slice(firstBrace, lastBrace + 1);
    const parsedObject = tryParseJson(objectCandidate);
    if (parsedObject !== null) return parsedObject;
  }

  const firstBracket = responseText.indexOf("[");
  const lastBracket = responseText.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    const arrayCandidate = responseText.slice(firstBracket, lastBracket + 1);
    const parsedArray = tryParseJson(arrayCandidate);
    if (parsedArray !== null) return parsedArray;
  }

  return null;
}

function toModelText(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }
  if (!result || typeof result !== "object") {
    return JSON.stringify(result);
  }

  const record = result as Record<string, unknown>;
  if (typeof record.response === "string") {
    return record.response;
  }
  if (typeof record.output_text === "string") {
    return record.output_text;
  }
  if (typeof record.text === "string") {
    return record.text;
  }
  if (typeof record.completion === "string") {
    return record.completion;
  }
  if (
    record.result &&
    typeof record.result === "object" &&
    typeof (record.result as Record<string, unknown>).response === "string"
  ) {
    return (record.result as Record<string, unknown>).response as string;
  }

  return JSON.stringify(result);
}

function extractJsonCandidates(value: unknown, depth = 0): unknown[] {
  if (depth > 5 || value == null) {
    return [];
  }

  if (typeof value === "string") {
    const candidates: unknown[] = [];
    const parsed = extractJsonPayload(value);
    if (parsed !== null) {
      candidates.push(parsed);
    }
    const direct = tryParseJson(value.trim());
    if (direct !== null) {
      candidates.push(direct);
    }
    return candidates;
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => extractJsonCandidates(item, depth + 1));
  }

  if (typeof value !== "object") {
    return [];
  }

  const obj = value as Record<string, unknown>;
  const candidates: unknown[] = [obj];

  const stringFieldKeys = [
    "response",
    "output_text",
    "text",
    "content",
    "completion",
    "arguments",
    "json",
    "payload",
    "message",
  ];

  for (const key of stringFieldKeys) {
    if (key in obj) {
      candidates.push(...extractJsonCandidates(obj[key], depth + 1));
    }
  }

  const objectFieldKeys = ["result", "data", "output", "quiz", "choices"];
  for (const key of objectFieldKeys) {
    if (key in obj) {
      candidates.push(...extractJsonCandidates(obj[key], depth + 1));
    }
  }

  return candidates;
}

function dedupeCandidates(candidates: unknown[]): unknown[] {
  const seen = new Set<string>();
  const unique: unknown[] = [];
  for (const candidate of candidates) {
    let key: string;
    try {
      key = JSON.stringify(candidate);
    } catch {
      key = String(candidate);
    }
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(candidate);
  }
  return unique;
}

function normalizeQuizShape(payload: unknown, fallbackTitle: string): unknown {
  if (!payload || typeof payload !== "object") {
    return payload;
  }

  const asRecord = payload as Record<string, unknown>;

  if (Array.isArray(payload)) {
    return { title: fallbackTitle, questions: payload };
  }

  if (asRecord.quiz && typeof asRecord.quiz === "object") {
    const quiz = asRecord.quiz as Record<string, unknown>;
    return {
      title: typeof quiz.title === "string" ? quiz.title : fallbackTitle,
      questions: Array.isArray(quiz.questions) ? quiz.questions : [],
    };
  }

  if (Array.isArray(asRecord.questions)) {
    return {
      title: typeof asRecord.title === "string" ? asRecord.title : fallbackTitle,
      questions: asRecord.questions,
    };
  }

  if (
    typeof asRecord.question === "string" &&
    Array.isArray(asRecord.options)
  ) {
    return {
      title: fallbackTitle,
      questions: [asRecord],
    };
  }

  return payload;
}

function normalizeQuestionItem(item: unknown): unknown | null {
  if (!item || typeof item !== "object") {
    return null;
  }

  const record = item as Record<string, unknown>;

  const questionValue =
    typeof record.question === "string"
      ? record.question
      : typeof record.prompt === "string"
        ? record.prompt
        : typeof record.text === "string"
          ? record.text
          : null;

  const rawOptions =
    Array.isArray(record.options)
      ? record.options
      : Array.isArray(record.choices)
        ? record.choices
        : Array.isArray(record.answers)
          ? record.answers
          : null;

  const options = (rawOptions ?? [])
    .map((option) => {
      if (typeof option === "string") {
        return option.trim();
      }
      if (option && typeof option === "object") {
        const opt = option as Record<string, unknown>;
        const candidate =
          typeof opt.text === "string"
            ? opt.text
            : typeof opt.label === "string"
              ? opt.label
              : typeof opt.option === "string"
                ? opt.option
                : null;
        return candidate?.trim() ?? "";
      }
      return "";
    })
    .filter((value) => value.length > 0)
    .slice(0, 4);

  if (!questionValue || options.length < 4) {
    return null;
  }

  let answerIndex = 0;
  if (typeof record.answerIndex === "number" && Number.isFinite(record.answerIndex)) {
    answerIndex = Math.trunc(record.answerIndex);
  } else {
    const answerLike = [record.correctAnswer, record.answer, record.correctOption].find(
      (value) => typeof value === "string" || typeof value === "number",
    );

    if (typeof answerLike === "number" && Number.isFinite(answerLike)) {
      answerIndex = Math.trunc(answerLike);
    } else if (typeof answerLike === "string") {
      const trimmed = answerLike.trim();
      if (/^[A-D]$/i.test(trimmed)) {
        answerIndex = trimmed.toUpperCase().charCodeAt(0) - 65;
      } else {
        const byText = options.findIndex((option) => option.toLowerCase() === trimmed.toLowerCase());
        if (byText >= 0) {
          answerIndex = byText;
        }
      }
    }
  }

  const explanation =
    typeof record.explanation === "string"
      ? record.explanation
      : typeof record.rationale === "string"
        ? record.rationale
        : typeof record.reason === "string"
          ? record.reason
          : "No explanation provided.";

  return {
    question: questionValue,
    options,
    answerIndex,
    explanation,
  };
}

function normalizeQuizForValidation(payload: unknown, fallbackTitle: string): unknown {
  const normalized = normalizeQuizShape(payload, fallbackTitle);
  if (!normalized || typeof normalized !== "object") {
    return normalized;
  }

  const record = normalized as Record<string, unknown>;
  if (!Array.isArray(record.questions)) {
    return normalized;
  }

  const normalizedQuestions = record.questions
    .map((question) => normalizeQuestionItem(question))
    .filter((question): question is NonNullable<typeof question> => Boolean(question));

  return {
    title: typeof record.title === "string" ? record.title : fallbackTitle,
    questions: normalizedQuestions,
  };
}

async function runQuizModel(prompt: string) {
  return await env.AI.run(DEFAULT_LLM_MODEL, {
    messages: [
      {
        role: "system",
        content:
          "You are a precise quiz generator that MUST output strict JSON only with exact required keys and value types.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
    max_tokens: 1500,
  });
}

async function tryRepairQuizJson(
  rawModelOutput: string,
  fallbackTitle: string,
  questionCount: number,
) {
  const repairPrompt = [
    "Convert the following content into strict valid JSON only.",
    "Required exact shape:",
    '{"title":"string","questions":[{"question":"string","options":["string","string","string","string"],"answerIndex":0,"explanation":"string"}]}',
    `Required question count: ${questionCount}`,
    "Rules:",
    "- questions must have exactly 4 options",
    "- answerIndex must be integer 0..3",
    "- no additional top-level keys besides title and questions",
    `Use title: "${fallbackTitle}" if missing.`,
    "Do not include markdown fences or any non-JSON text.",
    "",
    "Content:",
    rawModelOutput.slice(0, 6000),
  ].join("\n");

  const repaired = await runQuizModel(repairPrompt);
  const repairedText =
    typeof repaired === "string"
      ? repaired
      : typeof (repaired as any).response === "string"
        ? (repaired as any).response
        : JSON.stringify(repaired);

  return extractJsonPayload(repairedText);
}

function hasExactQuestionCount(parsed: z.infer<typeof quizResponseSchema>, expected: number) {
  return parsed.questions.length === expected;
}

function summarizeSchemaErrors(error: z.ZodError) {
  return error.issues
    .slice(0, 6)
    .map((issue) => {
      const path = issue.path.length ? issue.path.join(".") : "root";
      return `${path}:${issue.message}`;
    })
    .join(" | ");
}

export async function generateQuizDraft(input: GenerateQuizInput) {
  const questionCount = input.questionCount ?? 5;
  const validationDiagnostics: string[] = [];

  // Build the content context — transcript is best, description is fallback,
  // topic alone is last resort.
  let contentContext: string;
  if (input.sourceText && input.sourceText.length > 50) {
    const truncated = input.sourceText.slice(0, 4000);
    contentContext = `Source material (use this as the primary source for questions):\n"""\n${truncated}\n"""`;
  } else if (input.transcript && input.transcript.length > 100) {
    // Truncate transcript to ~4000 chars to stay within token budget
    const truncated = input.transcript.slice(0, 4000);
    contentContext = `Video transcript (use this as the primary source for questions):\n"""\n${truncated}\n"""`;
  } else if (input.videoDescription && input.videoDescription.length > 20) {
    contentContext = `Video description (use as context for questions):\n"""\n${input.videoDescription}\n"""`;
  } else {
    contentContext = `Topic: ${input.topic}`;
  }

  const basePromptLines = [
    "You generate homeschool quiz drafts as strict JSON.",
    "Return only valid JSON with this exact shape and keys:",
    '{"title":"string","questions":[{"question":"string","options":["string","string","string","string"],"answerIndex":0,"explanation":"string"}]}',
    `Quiz topic/title: ${input.topic}`,
    `Grade level: ${input.gradeLevel ?? "mixed"}`,
    `Question count: ${questionCount}`,
    "",
    contentContext,
    "",
    "Write questions that are directly answerable from the content above.",
    "Do not ask about information not present in the content.",
    "Strict output rules:",
    "- Return exactly the requested question count.",
    "- Each question must have exactly 4 options.",
    "- answerIndex must be an integer 0 to 3.",
    "- Return JSON only with top-level keys: title, questions.",
  ];

  const retryPromptLines = [
    ...basePromptLines,
    "",
    "IMPORTANT: Return ONLY JSON. No prose. No markdown. No code fences.",
    "If unsure, still return the exact JSON shape with best-effort answers.",
  ];

  for (const prompt of [basePromptLines.join("\n"), retryPromptLines.join("\n")]) {
    const aiResult = await runQuizModel(prompt);
    const responseText = toModelText(aiResult);
    const repaired = await tryRepairQuizJson(responseText, `${input.topic} Quiz`, questionCount);
    const rawCandidates = [
      ...extractJsonCandidates(aiResult),
      ...extractJsonCandidates(responseText),
      repaired,
    ].filter((value): value is NonNullable<typeof value> => value !== null);
    const candidates = dedupeCandidates(rawCandidates);

    if (candidates.length === 0) {
      validationDiagnostics.push("no_json_payload_found");
      continue;
    }

    for (const candidate of candidates) {
      const normalized = normalizeQuizForValidation(candidate, `${input.topic} Quiz`);
      const parsed = quizResponseSchema.safeParse(normalized);
      if (parsed.success) {
        if (hasExactQuestionCount(parsed.data, questionCount)) {
          return sanitizeQuiz(parsed.data);
        }
        validationDiagnostics.push(
          `question_count_mismatch:expected=${questionCount},actual=${parsed.data.questions.length}`,
        );
        continue;
      }

      validationDiagnostics.push(`schema_invalid:${summarizeSchemaErrors(parsed.error)}`);
    }
  }

  const diagnosticSummary = validationDiagnostics.slice(0, 8).join(" || ");
  throw new Error(
    diagnosticSummary
      ? `AI_QUIZ_FORMAT_INVALID:${diagnosticSummary}`
      : "AI_QUIZ_PARSE_FAILED",
  );
}

// ── Week planner AI ───────────────────────────────────────────────────────────

export type PlannerAssignment = {
  id: string;
  title: string;
  contentType: string;
  classTitle: string;
  nodeId: string;
  nodeTitle: string;
  nodeType: string; // "lesson" | "milestone" | "boss" | "branch" | "elective"
  nodeStatus: string; // "in_progress" | "available"
  nodeOrderIndex: number; // assignment's position within the node
};

export type PlannerSkillContext = {
  classTitle: string;
  subject: string | null;
  nodeTitle: string;
  nodeStatus: string; // "available" | "in_progress" | "complete" | "mastery"
  nodeType: string;
};

export type WeekPlanSlot = {
  assignmentId: string;
  scheduledDate: string; // "YYYY-MM-DD"
  orderIndex: number;
};

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export async function generateWeekPlanWithAI(input: {
  assignments: PlannerAssignment[];
  gradeLevel: string | null;
  weekStartDate: string; // "YYYY-MM-DD" — Monday
  schoolWeekDays?: number; // 4–7, default 5
  skillContext?: PlannerSkillContext[];
}): Promise<WeekPlanSlot[]> {
  const { assignments, gradeLevel, weekStartDate, schoolWeekDays = 5, skillContext = [] } = input;

  if (assignments.length === 0) {
    return [];
  }

  const numDays = Math.min(Math.max(schoolWeekDays, 4), 7);
  const [wy, wm, wd] = weekStartDate.split("-").map(Number) as [number, number, number];
  const weekDays = Array.from({ length: numDays }, (_, i) =>
    new Date(Date.UTC(wy, wm - 1, wd + i)).toISOString().slice(0, 10),
  );
  const dayRange = weekDays.map((d, i) => `${d} (${DAY_NAMES[i]})`).join(", ");

  // ── Group assignments by node, preserving order within each node ─────────────
  // nodeOrderIndex is the assignment's position within the node (for sequencing).
  // Nodes are ordered: in_progress first, then available; within status by their
  // natural order in the input (already sorted by the server).

  type NodeGroup = {
    nodeId: string;
    nodeTitle: string;
    nodeType: string;
    nodeStatus: string;
    classTitle: string;
    assignments: PlannerAssignment[];
  };

  const nodeMap = new Map<string, NodeGroup>();
  const nodeOrder: string[] = []; // insertion order = server-sorted priority
  for (const a of assignments) {
    if (!nodeMap.has(a.nodeId)) {
      nodeMap.set(a.nodeId, {
        nodeId: a.nodeId,
        nodeTitle: a.nodeTitle,
        nodeType: a.nodeType,
        nodeStatus: a.nodeStatus,
        classTitle: a.classTitle,
        assignments: [],
      });
      nodeOrder.push(a.nodeId);
    }
    nodeMap.get(a.nodeId)!.assignments.push(a);
  }
  // Sort assignments within each node by nodeOrderIndex
  for (const g of nodeMap.values()) {
    g.assignments.sort((a, b) => a.nodeOrderIndex - b.nodeOrderIndex);
  }

  // Separate lesson nodes from chapter-level nodes (milestone/boss) and reports
  const lessonNodes: NodeGroup[] = [];
  const chapterNodes: NodeGroup[] = []; // milestone, boss — their quizzes go after lessons
  for (const id of nodeOrder) {
    const g = nodeMap.get(id)!;
    if (g.nodeType === "milestone" || g.nodeType === "boss") {
      chapterNodes.push(g);
    } else {
      lessonNodes.push(g);
    }
  }

  // Cap total nodes sent to AI to keep output token count manageable.
  // Prefer in_progress lessons first, then available, then chapter nodes.
  const MAX_LESSON_NODES = numDays; // one lesson node per day is ideal
  const cappedLessonNodes = lessonNodes.slice(0, MAX_LESSON_NODES);
  const cappedChapterNodes = chapterNodes.slice(0, Math.max(1, Math.floor(numDays / 3)));
  const allNodes = [...cappedLessonNodes, ...cappedChapterNodes];

  // Build the flat set of assignments being scheduled (for validation)
  const assignmentsToSchedule = allNodes.flatMap((g) => g.assignments);
  if (assignmentsToSchedule.length === 0) return [];

  // ── Build prompt ──────────────────────────────────────────────────────────────

  const totalAssignments = assignmentsToSchedule.length;
  const targetPerDay = Math.round(totalAssignments / numDays);
  const minPerDay = Math.max(1, targetPerDay - 1);
  const maxPerDay = targetPerDay + 1;

  // Format nodes as structured blocks so the AI sees groupings explicitly
  const nodeBlocks = allNodes
    .map((g) => {
      const isChapter = g.nodeType === "milestone" || g.nodeType === "boss";
      const hint = isChapter
        ? `[CHAPTER-LEVEL ${g.nodeType.toUpperCase()} — schedule AFTER lesson nodes from this class are placed; quizzes and reports here belong to the chapter as a whole]`
        : `[LESSON NODE — ALL assignments in this block must go on the SAME day]`;
      const assignmentLines = g.assignments
        .map(
          (a) =>
            `    - id=${a.id} | type=${a.contentType} | title=${a.title}`,
        )
        .join("\n");
      return `NODE: "${g.nodeTitle}" | class=${g.classTitle} | type=${g.nodeType} | status=${g.nodeStatus}\n${hint}\n${assignmentLines}`;
    })
    .join("\n\n");

  const skillContextBlock =
    skillContext.length > 0
      ? [
          "",
          "Skill map context (use to prioritize sequencing):",
          ...skillContext.map(
            (s) =>
              `- ${s.classTitle}${s.subject ? ` (${s.subject})` : ""}: node "${s.nodeTitle}" [${s.nodeType}] status=${s.nodeStatus}`,
          ),
        ].join("\n")
      : "";

  const prompt = [
    `You are an expert homeschool week planner. Schedule the assignments below across a ${numDays}-day school week.`,
    "",
    "HARD RULES — follow these exactly:",
    "1. LESSON NODES: Every assignment inside a [LESSON NODE] block MUST be scheduled on the SAME day. Do not split a lesson node across multiple days.",
    "2. CHAPTER NODES: Assignments in a [CHAPTER-LEVEL] block (milestone/boss) belong to the end of the chapter. Schedule them AFTER the lesson nodes from the same class. Spread chapter-level quizzes and reports across different days if there are multiple.",
    "3. REPORTS: Schedule each report on the same day as other assignments from the same node when possible. Never put two reports on the same day.",
    `4. EVEN LOAD: Aim for exactly ${targetPerDay} assignments per day. Acceptable range: ${minPerDay}–${maxPerDay}. Every day must have at least ${minPerDay} assignment(s).`,
    "5. SUBJECT ROTATION: Alternate which class/subject appears each day. Avoid two consecutive days dominated by the same class.",
    "6. DATE VALIDITY: scheduledDate MUST be one of the exact dates listed. No other dates are valid.",
    "",
    `Grade level: ${gradeLevel ?? "unspecified"}`,
    `School week: ${numDays} days — ${dayRange}`,
    skillContextBlock,
    "",
    "Return ONLY a JSON array. No prose, no markdown, no code fences.",
    `Each element: { "assignmentId": "<id>", "scheduledDate": "YYYY-MM-DD", "orderIndex": <int starting at 0 per day> }`,
    `Valid dates: ${weekDays.join(", ")}`,
    "",
    "=== ASSIGNMENTS (grouped by node) ===",
    nodeBlocks,
    "",
    "Return ONLY the JSON array.",
  ].join("\n");

  const responseTokens = Math.min(assignmentsToSchedule.length * 80 + 500, 8000);

  const result = await env.AI.run(DEFAULT_LLM_MODEL, {
    messages: [
      {
        role: "system",
        content: "You are a precise scheduling assistant. Output strict JSON only — no prose, no markdown.",
      },
      { role: "user", content: prompt },
    ],
    max_tokens: responseTokens,
  });

  let parsed: unknown;
  const resultRecord = result as Record<string, unknown>;
  if (Array.isArray(resultRecord?.response)) {
    parsed = resultRecord.response;
  } else {
    const responseText = toModelText(result);
    parsed = extractJsonPayload(responseText);
    if (!Array.isArray(parsed)) {
      throw new Error(`AI_PLANNER_PARSE_FAILED: ${responseText.slice(0, 300)}`);
    }
  }

  const validDates = new Set(weekDays);
  const validIds = new Set(assignmentsToSchedule.map((a) => a.id));
  const slots: WeekPlanSlot[] = [];

  for (const item of parsed) {
    if (
      item &&
      typeof item === "object" &&
      typeof item.assignmentId === "string" &&
      typeof item.scheduledDate === "string" &&
      typeof item.orderIndex === "number" &&
      validIds.has(item.assignmentId) &&
      validDates.has(item.scheduledDate)
    ) {
      slots.push({
        assignmentId: item.assignmentId,
        scheduledDate: item.scheduledDate,
        orderIndex: item.orderIndex,
      });
    }
  }

  return slots;
}

// ── Skill tree layout ─────────────────────────────────────────────────────────

/**
 * Spine-first hierarchical layout — PoE road style.
 *
 * Strategy:
 *   1. Identify the PRIMARY SPINE: the longest chain of required-edge nodes
 *      from root to terminal boss. This runs straight down the center.
 *   2. All other nodes are BRANCHES: fan left/right from their spine anchor.
 *      Branches that merge back to the spine (bonus edges) are allowed.
 *   3. Layers (rows) are assigned by longest-path depth from any root.
 *   4. Within each layer: spine nodes occupy the center column (X=0 offset).
 *      Branch subtrees are placed using Reingold-Tilford on each side,
 *      alternating L/R so they never overlap.
 *   5. Minimum horizontal gap between any two nodes in the same layer is
 *      enforced globally after placement.
 *   6. Fork nodes (decision points) are core spine nodes that split into
 *      2+ core continuation choices. Optional specialization branches do not
 *      count as forks.
 *
 * Result: center spine flows straight down; branches spread cleanly
 * left and right like roads off a highway — no edge crossings.
 */
export function layoutForceDirected(
  nodes: Array<{
    id: string;
    prerequisites: string[];
    depth?: number;
    cluster?: string;
    nodeType?: string;
  }>,
  options?: {
    width?: number;
    height?: number;
    iterations?: number;
    repulsion?: number;
    springLength?: number;
    springStrength?: number;
    gravity?: number;
    minNodeDistance?: number;
  },
): Map<string, { x: number; y: number }> {
  if (nodes.length === 0) return new Map();

  const W         = options?.width  ?? 1800;
  const H         = options?.height ?? 1400;
  const NODE_SEP  = Math.max(options?.minNodeDistance ?? 130, 130); // horizontal gap between same-layer nodes
  const RANK_SEP  = 150;  // vertical gap between layers (spine)
  const BRANCH_SEP = 110; // tighter vertical gap within branch subtrees
  const FORK_EXTRA = 40;  // extra Y gap before fork decision points
  const PAD_X     = 100;
  const PAD_Y     = 100;
  const CENTER_X  = W / 2;

  const nodeMap    = new Map(nodes.map((n) => [n.id, n]));
  const inputOrder = new Map(nodes.map((n, i) => [n.id, i]));

  // ── Layer assignment (longest path from root, cycle-safe) ───────────────────
  const layerOf  = new Map<string, number>();
  const visiting = new Set<string>();
  const computeLayer = (id: string): number => {
    if (layerOf.has(id)) return layerOf.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const node = nodeMap.get(id);
    const prereqs = (node?.prerequisites ?? []).filter((p) => nodeMap.has(p));
    const l = prereqs.length === 0 ? 0 : Math.max(...prereqs.map((p) => computeLayer(p) + 1));
    visiting.delete(id);
    layerOf.set(id, l);
    return l;
  };
  for (const n of nodes) computeLayer(n.id);

  // ── Spanning tree (one primary parent per child) ─────────────────────────────
  const parent   = new Map<string, string | null>();
  const children = new Map<string, string[]>();
  for (const n of nodes) children.set(n.id, []);
  for (const n of nodes) {
    const prereqs = n.prerequisites.filter((p) => nodeMap.has(p));
    if (prereqs.length === 0) {
      parent.set(n.id, null);
    } else {
      const best = prereqs.reduce((a, b) => (layerOf.get(a)! >= layerOf.get(b)! ? a : b));
      parent.set(n.id, best);
      children.get(best)!.push(n.id);
    }
  }
  for (const [, kids] of children) {
    kids.sort((a, b) => (inputOrder.get(a) ?? 0) - (inputOrder.get(b) ?? 0));
  }

  // ── Identify the primary spine ───────────────────────────────────────────────
  // Spine = the longest path of "core" (non-elective, non-specialization) nodes
  // from root to deepest boss/milestone. We pick it greedily:
  //   start at the root(s), always follow the child on the primary chain
  //   (prefer nodeType boss > milestone > lesson > branch, then deepest).

  const roots = nodes
    .filter((n) => parent.get(n.id) === null)
    .sort((a, b) => (inputOrder.get(a.id) ?? 0) - (inputOrder.get(b.id) ?? 0))
    .map((n) => n.id);

  const NODE_TYPE_RANK: Record<string, number> = {
    boss: 4, milestone: 3, lesson: 2, branch: 1, elective: 0,
  };

  // Follow the "most important" child at each step to mark the spine
  const spineSet = new Set<string>();
  const markSpine = (id: string) => {
    spineSet.add(id);
    const kids = children.get(id) ?? [];
    if (kids.length === 0) return;
    // Pick the child with highest type rank, then deepest subtree, then input order
    const subtreeDepth = (nid: string): number => {
      const kids2 = children.get(nid) ?? [];
      return kids2.length === 0 ? layerOf.get(nid)! : Math.max(...kids2.map(subtreeDepth));
    };
    const best = [...kids].sort((a, b) => {
      const ra = NODE_TYPE_RANK[nodeMap.get(a)?.nodeType ?? "lesson"] ?? 2;
      const rb = NODE_TYPE_RANK[nodeMap.get(b)?.nodeType ?? "lesson"] ?? 2;
      if (ra !== rb) return rb - ra;
      return subtreeDepth(b) - subtreeDepth(a);
    })[0]!;
    markSpine(best);
  };
  // Start spine from the deepest root (if multiple trees)
  const primaryRoot = roots.length === 1 ? roots[0]! :
    roots.reduce((a, b) => {
      const da = Math.max(...[...layerOf.entries()].filter(([id]) => {
        // check if a is ancestor
        const check = (nid: string): boolean => nid === a || (children.get(nid) ?? []).some(check);
        return check(id); // rough - just use layer
      }).map(([, l]) => l), 0);
      return da >= 0 ? a : b;
    });
  markSpine(primaryRoot);

  // ── Identify fork nodes (spine nodes with 2+ core continuation children) ─────
  // These are true "choose a lane" decisions in the main course flow.
  // Optional specialization branches should never be marked as forks.
  // (We expose this via a separate exported map attached to the return — but since
  //  we return Map<string,{x,y}>, we smuggle it as optional property.)
  const isCorePathNode = (id: string) => {
    const node = nodeMap.get(id);
    if (!node) return false;
    return node.cluster !== "specialization" && node.nodeType !== "elective";
  };
  const forkSet = new Set<string>();
  for (const id of spineSet) {
    const kids = children.get(id) ?? [];
    const coreChoiceKids = kids.filter((kid) => isCorePathNode(kid));
    if (coreChoiceKids.length >= 2) forkSet.add(id);
  }

  // ── Y assignment ─────────────────────────────────────────────────────────────
  // Spine nodes are placed at RANK_SEP intervals.
  // Branch nodes get BRANCH_SEP intervals from their spine anchor.
  const finalY = new Map<string, number>();

  // First pass: assign Y to spine nodes
  const spineNodes = [...spineSet].sort((a, b) => layerOf.get(a)! - layerOf.get(b)!);
  let spineY = PAD_Y;
  const spineLayerY = new Map<number, number>();
  for (const id of spineNodes) {
    const l = layerOf.get(id)!;
    if (!spineLayerY.has(l)) {
      if (spineLayerY.size > 0) {
        spineY += forkSet.has(id) ? RANK_SEP + FORK_EXTRA : RANK_SEP;
      }
      spineLayerY.set(l, spineY);
    }
    finalY.set(id, spineLayerY.get(l)!);
  }

  // Second pass: assign Y to branch nodes relative to their spine anchor
  const getSpineAncestor = (id: string): string | null => {
    if (spineSet.has(id)) return id;
    const p = parent.get(id);
    if (!p) return null;
    return getSpineAncestor(p);
  };

  const assignBranchY = (id: string, baseY: number, depthFromAnchor: number) => {
    if (finalY.has(id)) return;
    const y = baseY + depthFromAnchor * BRANCH_SEP;
    finalY.set(id, y);
    for (const kid of children.get(id) ?? []) {
      if (!spineSet.has(kid)) assignBranchY(kid, baseY, depthFromAnchor + 1);
    }
  };

  for (const id of spineSet) {
    const kids = children.get(id) ?? [];
    for (const kid of kids) {
      if (!spineSet.has(kid)) {
        assignBranchY(kid, finalY.get(id)!, 1);
      }
    }
  }

  // Handle any orphan non-spine nodes without a spine ancestor
  for (const n of nodes) {
    if (!finalY.has(n.id)) {
      finalY.set(n.id, PAD_Y + layerOf.get(n.id)! * BRANCH_SEP);
    }
  }

  // ── X assignment ─────────────────────────────────────────────────────────────
  // Spine nodes sit at CENTER_X.
  // Branch subtrees fan left/right from their spine anchor, alternating sides.
  // We use a modified RT within each branch subtree, then translate to L/R.

  const finalX = new Map<string, number>();

  // Place all spine nodes at center
  for (const id of spineSet) finalX.set(id, CENTER_X);

  // For each spine node that has branch children, place those subtrees L/R
  // Gather all branch roots per spine node, sort by input order
  const placeBranchSubtree = (rootId: string, centerAnchorX: number, side: -1 | 1, levelOffset: number) => {
    // Use a simple recursive width-first placement:
    // compute the subtree width, then place root at centerAnchorX + side * offset

    // Compute leaf count (subtree width)
    const leafCount = (id: string): number => {
      const kids = children.get(id) ?? [];
      const nonSpineKids = kids.filter((k) => !spineSet.has(k));
      if (nonSpineKids.length === 0) return 1;
      return nonSpineKids.reduce((s, k) => s + leafCount(k), 0);
    };

    // Place a branch subtree rooted at `id` with the given center X
    const placeSubtree = (id: string, cx: number) => {
      if (finalX.has(id)) return; // don't overwrite spine nodes
      finalX.set(id, cx);
      const kids = (children.get(id) ?? []).filter((k) => !spineSet.has(k));
      if (kids.length === 0) return;
      const totalLeaves = kids.reduce((s, k) => s + leafCount(k), 0);
      const totalWidth = (totalLeaves - 1) * NODE_SEP;
      let cursor = cx - totalWidth / 2;
      for (const kid of kids) {
        const kidLeaves = leafCount(kid);
        const kidCX = cursor + (kidLeaves - 1) * NODE_SEP / 2;
        placeSubtree(kid, kidCX);
        cursor += kidLeaves * NODE_SEP;
      }
    };

    const lc = leafCount(rootId);
    // Offset from spine: levelOffset * NODE_SEP, plus subtree half-width to avoid overlap with spine
    const halfWidth = ((lc - 1) * NODE_SEP) / 2;
    const rootX = centerAnchorX + side * (levelOffset * NODE_SEP + halfWidth + NODE_SEP * 0.6);
    placeSubtree(rootId, rootX);
  };

  for (const spineId of spineSet) {
    const kids = children.get(spineId) ?? [];
    const branchKids = kids.filter((k) => !spineSet.has(k));
    if (branchKids.length === 0) continue;

    // Alternate L/R: 0→right, 1→left, 2→right, ...
    branchKids.forEach((kid, idx) => {
      const side: -1 | 1 = idx % 2 === 0 ? 1 : -1;
      const levelOffset = Math.floor(idx / 2) + 1;
      placeBranchSubtree(kid, CENTER_X, side, levelOffset);
    });
  }

  // Handle any unplaced nodes
  let orphanX = CENTER_X + NODE_SEP * 3;
  for (const n of nodes) {
    if (!finalX.has(n.id)) {
      finalX.set(n.id, orphanX);
      orphanX += NODE_SEP;
    }
  }

  // ── Global layer separation enforcement ──────────────────────────────────────
  // Guarantee no two nodes in the same layer are closer than NODE_SEP horizontally.
  const byY = new Map<number, string[]>();
  for (const n of nodes) {
    const y = finalY.get(n.id)!;
    const bucket = byY.get(y) ?? [];
    bucket.push(n.id);
    byY.set(y, bucket);
  }

  for (const [, ids] of byY) {
    if (ids.length <= 1) continue;
    ids.sort((a, b) => finalX.get(a)! - finalX.get(b)!);
    // Forward pass: push right
    for (let i = 1; i < ids.length; i++) {
      const prev = finalX.get(ids[i - 1]!)!;
      const cur  = finalX.get(ids[i]!)!;
      if (cur - prev < NODE_SEP) finalX.set(ids[i]!, prev + NODE_SEP);
    }
    // Re-center the whole layer around the spine nodes in this layer if any
    const spineInLayer = ids.filter((id) => spineSet.has(id));
    if (spineInLayer.length > 0) {
      // find where spine sits now vs where it should (CENTER_X)
      const spineX = finalX.get(spineInLayer[0]!)!;
      const shift  = CENTER_X - spineX;
      if (Math.abs(shift) > 1) {
        for (const id of ids) {
          finalX.set(id, finalX.get(id)! + shift);
        }
      }
    }
  }

  // ── Normalize so everything fits on canvas ───────────────────────────────────
  const allX  = [...finalX.values()];
  const allY  = [...finalY.values()];
  const minX  = Math.min(...allX);
  const maxX  = Math.max(...allX);
  const minY  = Math.min(...allY);
  const maxY  = Math.max(...allY);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;

  const usableW = W - PAD_X * 2;
  const usableH = H - PAD_Y * 2;

  // Only scale down if it doesn't fit; never scale up (would make it too sparse)
  const scaleX = spanX > usableW ? usableW / spanX : 1;
  const scaleY = spanY > usableH ? usableH / spanY : 1;

  // Re-center after scaling
  const scaledSpanX = spanX * scaleX;
  const offsetX     = PAD_X + (usableW - scaledSpanX) / 2;

  const result = new Map<string, { x: number; y: number }>();
  for (const n of nodes) {
    const rx = (finalX.get(n.id)! - minX) * scaleX + offsetX;
    const ry = (finalY.get(n.id)! - minY) * scaleY + PAD_Y;
    result.set(n.id, { x: Math.round(rx), y: Math.round(ry) });
  }

  // Tag fork nodes on the result map so the caller can mark them
  (result as Map<string, { x: number; y: number }> & { forkIds?: Set<string> }).forkIds = forkSet;

  return result;
}

// ── Curriculum AI generation ──────────────────────────────────────────────────

export type CurriculumNodeSuggestion = {
  tempId: string;
  /** Primary parent tempId — first entry of prerequisites, kept for compat */
  parentTempId: string | null;
  /** All prerequisite tempIds — drives multi-parent graph edges */
  prerequisites: string[];
  /** "core" = main story path, "specialization" = side-quest branch */
  cluster: "core" | "specialization";
  /** Depth in the web (0 = root). Used for XP scaling. */
  depth: number;
  /** Whether completing this node is mandatory for course completion */
  isRequired: boolean;
  title: string;
  description: string;
  icon: string;
  colorRamp: "blue" | "teal" | "purple" | "amber" | "coral" | "green";
  nodeType: "lesson" | "milestone" | "boss" | "elective" | "branch";
  xpReward: number;
  suggestedAssignments: Array<{ type: string; title: string }>;
};

export type CurriculumReweaveSuggestion = {
  tempId: string;
  primaryPrerequisite: string | null;
  bonusPrerequisites: string[];
  cluster: "core" | "specialization";
  depth: number;
};

const VALID_COLOR_RAMPS = new Set(["blue", "teal", "purple", "amber", "coral", "green"]);
const VALID_NODE_TYPES = new Set(["lesson", "milestone", "boss", "elective", "branch"]);

function parseCurriculumNode(item: unknown): CurriculumNodeSuggestion | null {
  if (!item || typeof item !== "object") return null;
  const r = item as Record<string, unknown>;
  if (typeof r.tempId !== "string" || !r.tempId) return null;
  if (typeof r.title !== "string" || !r.title) return null;

  // Build prerequisites array — accept either the new `prerequisites` field or
  // fall back to the legacy `parentTempId` string so old AI responses still parse.
  const prerequisites: string[] = Array.isArray(r.prerequisites)
    ? (r.prerequisites as unknown[]).filter((p): p is string => typeof p === "string" && p.length > 0)
    : typeof r.parentTempId === "string" && r.parentTempId
      ? [r.parentTempId]
      : [];

  const parentTempId = prerequisites[0] ?? null;

  const depth =
    typeof r.depth === "number" && Number.isFinite(r.depth) && r.depth >= 0
      ? Math.round(r.depth)
      : 0;

  // XP scales with depth: shallow ≈ 50–150, deep specializations can reach 1000
  const defaultXp = Math.min(1000, Math.max(50, 50 + depth * 80));
  const xpReward =
    typeof r.xpReward === "number" && r.xpReward > 0
      ? Math.min(1000, Math.max(50, Math.round(r.xpReward)))
      : defaultXp;

  const cluster = r.cluster === "specialization" ? "specialization" : "core";
  // isRequired: respect explicit field; fall back to cluster ("core" = required)
  const isRequired =
    typeof r.isRequired === "boolean"
      ? r.isRequired
      : cluster === "core" && r.nodeType !== "elective";

  return {
    tempId: r.tempId,
    parentTempId,
    prerequisites,
    cluster,
    depth,
    isRequired,
    title: r.title.trim(),
    description: typeof r.description === "string" ? r.description.trim() : "",
    icon: typeof r.icon === "string" && r.icon ? r.icon : "📚",
    colorRamp: (typeof r.colorRamp === "string" && VALID_COLOR_RAMPS.has(r.colorRamp)
      ? r.colorRamp
      : "blue") as CurriculumNodeSuggestion["colorRamp"],
    nodeType: (typeof r.nodeType === "string" && VALID_NODE_TYPES.has(r.nodeType)
      ? r.nodeType
      : "lesson") as CurriculumNodeSuggestion["nodeType"],
    xpReward,
    suggestedAssignments: Array.isArray(r.suggestedAssignments)
      ? (r.suggestedAssignments as unknown[])
          .filter(
            (a): a is { type: string; title: string } =>
              a !== null &&
              typeof a === "object" &&
              typeof (a as Record<string, unknown>).type === "string" &&
              typeof (a as Record<string, unknown>).title === "string",
          )
          .slice(0, 4)
      : [],
  };
}

function parseReweaveNode(item: unknown): CurriculumReweaveSuggestion | null {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  if (typeof record.tempId !== "string" || !record.tempId) return null;

  const primaryPrerequisite =
    typeof record.primaryPrerequisite === "string" && record.primaryPrerequisite
      ? record.primaryPrerequisite
      : null;
  const bonusPrerequisites = Array.isArray(record.bonusPrerequisites)
    ? (record.bonusPrerequisites as unknown[])
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .slice(0, 2)
    : [];
  const depth =
    typeof record.depth === "number" && Number.isFinite(record.depth) && record.depth >= 0
      ? Math.round(record.depth)
      : 0;

  return {
    tempId: record.tempId,
    primaryPrerequisite,
    bonusPrerequisites,
    cluster: record.cluster === "specialization" ? "specialization" : "core",
    depth,
  };
}

function extractCurriculumArray(raw: unknown): CurriculumNodeSuggestion[] {
  const candidates: unknown[] = [];

  // Direct array
  if (Array.isArray(raw)) {
    candidates.push(...raw);
  } else if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    // Try known wrapper keys first, then fall back to any array-valued key
    const knownKeys = ["nodes", "tree", "curriculum", "items", "data", "response", "result", "spine"];
    let found = false;
    for (const key of knownKeys) {
      if (Array.isArray(r[key])) {
        candidates.push(...(r[key] as unknown[]));
        found = true;
        break;
      }
    }
    if (!found) {
      for (const val of Object.values(r)) {
        if (Array.isArray(val) && val.length > 0) {
          candidates.push(...val);
          break;
        }
      }
    }
  }

  return candidates.map(parseCurriculumNode).filter((n): n is CurriculumNodeSuggestion => n !== null);
}

function extractReweaveArray(raw: unknown): CurriculumReweaveSuggestion[] {
  const candidates: unknown[] = [];

  if (Array.isArray(raw)) {
    candidates.push(...raw);
  } else if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    for (const key of ["nodes", "tree", "curriculum", "items", "data"]) {
      if (Array.isArray(record[key])) {
        candidates.push(...(record[key] as unknown[]));
        break;
      }
    }
  }

  return candidates.map(parseReweaveNode).filter((n): n is CurriculumReweaveSuggestion => n !== null);
}

export async function generateCurriculumTree(input: {
  subject: string;
  gradeLevel: string;
  depth: number;
  seedTopic?: string;
  existingNodeTitles?: string[];
}): Promise<CurriculumNodeSuggestion[]> {
  // More nodes for deeper webs; specialisation branches inflate count further
  const coreCount = Math.max(4, input.depth * 3);
  const specCount = Math.max(4, input.depth * 4);
  const targetNodeCount = coreCount + specCount;

  const nodeSchema = JSON.stringify({
    tempId: "node_N (sequential integer, e.g. node_1)",
    prerequisites: ["node_M", "node_K"],
    cluster: "core | specialization",
    depth: "integer — how many hops from root",
    title: "string (2-4 words)",
    description: "string (1-2 sentences)",
    icon: "single emoji",
    colorRamp: "blue | teal | purple | amber | coral | green",
    nodeType: "lesson | milestone | boss | elective",
    xpReward: "integer — scales with depth (see XP rules below)",
    suggestedAssignments: [{ type: "text|video|quiz|essay|report", title: "string" }],
  });

  const lines = [
    `You are designing a gameified interconnected skill WEB for a ${input.subject} curriculum (grade ${input.gradeLevel}).`,
    "",
    "STRUCTURE RULES:",
    "1. Core Scaffold (~" + coreCount + " nodes, cluster='core', colorRamp='blue' or 'teal'):",
    "   - A single root node (depth=0, prerequisites=[]).",
    "   - Build a traversable scaffold, not a single straight line: allow a small Y-shape or 2-3 major branches.",
    "   - Keep the scaffold readable: no more than 3 major core lanes active at any one depth.",
    "   - Core nodes should stay contextually close to nearby related core nodes.",
    "   - One 'boss' node at the deepest core level (depth=" + input.depth + ") — the unit's final assessment.",
    "   - Include 1-2 rejoin points where an alternate core path can reconnect to a nearby later core node.",
    "",
    "2. Specialization Branches and Hub Clusters (~" + specCount + " nodes, cluster='specialization', colorRamp='purple' or 'amber' or 'coral' or 'green'):",
    "   - Branches fork off from mid-core nodes (depth 1–" + Math.ceil(input.depth / 2) + ").",
    "   - Each branch digs 2–4 levels deeper than its fork point — deep side quests.",
    "   - Most branch nodes should have exactly 1 nearby prerequisite so related concepts sit next to each other.",
    "   - Include 1-2 starburst clusters: a significant central node with 3-5 nearby optional satellite concepts around it.",
    "   - Some advanced routes may reconnect into a nearby later core node so students can return to the scaffold after exploring.",
    "   - Mark deep side-quest terminals with nodeType='elective'.",
    "",
    "XP RULES (mandatory — scale by depth):",
    "   depth 0-1 → xpReward 50–120",
    "   depth 2-3 → xpReward 120–250",
    "   depth 4-5 → xpReward 250–450",
    "   depth 6-7 → xpReward 450–700",
    "   depth 8+  → xpReward 700–1000  ← deep specialization quests should be massive",
    "   boss nodes always get +150 XP bonus on top of their depth tier.",
    "",
    "PREREQUISITES RULES:",
    "   - Most non-root nodes list exactly 1 prerequisite that already exists in the array.",
    "   - A small number of core rejoin nodes may list 2 local prerequisites if one route reconnects into the core scaffold.",
    "   - Main spine/core roads should be the required path. Specialization branches are optional by default.",
    "   - Only create a true core fork when there are 2-4 comparable path choices; if you do, keep those paths balanced in node count, rigor, and XP so one is not an obvious shortcut.",
    "   - A node may branch to several children, but keep connections local and contextually related.",
    "   - NO cycles. Prerequisites must only reference nodes with lower tempId numbers.",
    "",
  ];

  if (input.seedTopic) lines.push(`THEME: Build the entire web around the topic: ${input.seedTopic}`);
  if (input.existingNodeTitles?.length) {
    lines.push(`Do NOT duplicate these existing topics: ${input.existingNodeTitles.join(", ")}`);
  }

  lines.push(
    "",
    `Target exactly ~${targetNodeCount} total nodes.`,
    "Return ONLY a JSON array. Each element matches this schema:",
    nodeSchema,
    "",
    "Return ONLY the JSON array. No markdown fences, no prose.",
  );

  const prompt = lines.join("\n");

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await env.AI.run(DEFAULT_LLM_MODEL, {
      messages: [
        { role: "system", content: "You are a homeschool curriculum designer building skill webs. Output only valid JSON." },
        { role: "user", content: attempt === 0 ? prompt : `${prompt}\n\nCRITICAL: Return ONLY the raw JSON array. No markdown fences, no explanations.` },
      ],
      max_tokens: 4000,
    });

    const responseText = toModelText(result);
    const rawCandidates = [
      ...extractJsonCandidates(result),
      ...extractJsonCandidates(responseText),
      extractJsonPayload(responseText),
    ].filter((v): v is NonNullable<typeof v> => v !== null);

    for (const candidate of dedupeCandidates(rawCandidates)) {
      const nodes = extractCurriculumArray(candidate);
      if (nodes.length >= 3) return nodes;
    }
  }

  throw new Error("AI_CURRICULUM_PARSE_FAILED");
}

export async function generateNodeExpansion(input: {
  fromNodeTitle: string;
  fromNodeDescription: string;
  subject: string;
  gradeLevel: string;
  nodeCount: number;
  focusArea?: string;
  existingNodeTitles: string[];
}): Promise<CurriculumNodeSuggestion[]> {
  const lines = [
    `You are expanding a ${input.subject} skill tree for grade ${input.gradeLevel}.`,
    `The student just completed: '${input.fromNodeTitle}' — ${input.fromNodeDescription}.`,
    `Suggest ${input.nodeCount} new nodes that naturally follow from this.`,
    "Keep the new nodes tightly related so they can sit near each other as a small local branch or mini-cluster.",
  ];
  if (input.focusArea) lines.push(`Focus on: ${input.focusArea}`);
  if (input.existingNodeTitles.length) {
    lines.push(`Do not duplicate: ${input.existingNodeTitles.join(", ")}`);
  }
  lines.push(
    "Return JSON array with same schema as before, all parentTempId: null (caller handles edge creation).",
    "Return ONLY the JSON array. No markdown, no prose.",
  );

  const prompt = lines.join("\n");

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await env.AI.run(DEFAULT_LLM_MODEL, {
      messages: [
        { role: "system", content: "You are a homeschool curriculum designer. Output only valid JSON." },
        { role: "user", content: attempt === 0 ? prompt : `${prompt}\n\nIMPORTANT: Return ONLY the raw JSON array. No markdown fences.` },
      ],
      max_tokens: 2000,
    });

    const responseText = toModelText(result);
    const rawCandidates = [
      ...extractJsonCandidates(result),
      ...extractJsonCandidates(responseText),
      extractJsonPayload(responseText),
    ].filter((v): v is NonNullable<typeof v> => v !== null);

    for (const candidate of dedupeCandidates(rawCandidates)) {
      const nodes = extractCurriculumArray(candidate);
      if (nodes.length >= 1) return nodes;
    }
  }

  throw new Error("AI_CURRICULUM_PARSE_FAILED");
}

export async function reweaveCurriculumTree(input: {
  treeTitle: string;
  subject: string;
  gradeLevel: string;
  nodes: Array<{
    tempId: string;
    title: string;
    description: string;
    nodeType: string;
    colorRamp: string;
    xpReward: number;
  }>;
}): Promise<CurriculumReweaveSuggestion[]> {
  const nodeContext = input.nodes
    .map((node) =>
      [
        `${node.tempId}: "${node.title}"`,
        `type=${node.nodeType}`,
        `xp=${node.xpReward}`,
        node.description ? `notes=${node.description.slice(0, 180)}` : "",
      ]
        .filter(Boolean)
        .join(" | "),
    )
    .join("\n");

  const prompt = [
    `You are rewiring an existing gameified skill tree called "${input.treeTitle}" for ${input.subject}, grade ${input.gradeLevel}.`,
    "",
    "Goal: keep the SAME nodes, but rebuild the dependency roads so the map feels traversable and intentional.",
    "",
    "STRICT RULES:",
    "1. Use EVERY tempId exactly once. Do not rename, delete, or invent nodes.",
    "2. Exactly 1 root node must have primaryPrerequisite=null and depth=0.",
    "3. Build a readable core scaffold, not a straight line: a Y-shape or 2-3 major core lanes is ideal.",
    "4. Keep related content close by making most nodes depend on one nearby, semantically adjacent earlier node.",
    "5. Create 1-2 starburst clusters: a strong central hub with 3-5 nearby specialization satellites.",
    "6. Only 1-3 core nodes may include 1 bonusPrerequisite that represents an alternate return road from a nearby branch.",
    "7. bonusPrerequisites should create a legitimate alternate unlock route into that node, but keep them local. Never create long jumps or tangled cross-links.",
    "8. No cycles. Any prerequisite must reference an earlier tempId.",
    "9. Preserve major fundamentals on the core scaffold. Use specialization branches for choice, enrichment, and side quests.",
    "10. Prefer milestone/boss/branch-like nodes as hubs or important scaffold anchors when appropriate.",
    "11. Treat the main spine as required. Specialization branches stay optional unless you intentionally create a balanced 2-4 lane core fork.",
    "12. If you create a true core fork, keep the competing lanes comparable in length and rigor so no route is the obvious shortcut.",
    "",
    "Return JSON array with this exact shape:",
    JSON.stringify({
      tempId: "node_N",
      primaryPrerequisite: "node_M or null",
      bonusPrerequisites: ["node_K"],
      cluster: "core | specialization",
      depth: "integer",
    }),
    "",
    "Existing nodes:",
    nodeContext,
    "",
    `Return ONLY the JSON array of ${input.nodes.length} objects. No markdown, no prose.`,
  ].join("\n");

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await env.AI.run(DEFAULT_LLM_MODEL, {
      messages: [
        {
          role: "system",
          content: "You are a curriculum designer who outputs strict JSON for skill-tree rewiring.",
        },
        {
          role: "user",
          content:
            attempt === 0
              ? prompt
              : `${prompt}\n\nCRITICAL: Return ONLY the raw JSON array with all tempIds exactly once.`,
        },
      ],
      max_tokens: 5000,
    });

    const responseText = toModelText(result);
    const rawCandidates = [
      ...extractJsonCandidates(result),
      ...extractJsonCandidates(responseText),
      extractJsonPayload(responseText),
    ].filter((value): value is NonNullable<typeof value> => value !== null);

    for (const candidate of dedupeCandidates(rawCandidates)) {
      const nodes = extractReweaveArray(candidate);
      if (nodes.length >= Math.max(3, input.nodes.length - 1)) {
        return nodes;
      }
    }
  }

  throw new Error("AI_REWEAVE_PARSE_FAILED");
}

// ── Course duration → structural scale ───────────────────────────────────────

/**
 * Parse any courseLength string into an approximate week count.
 * Used to scale chapter count, connector density, and zone sizes.
 */
function courseLengthToWeeks(courseLength: string): number {
  const s = courseLength.toLowerCase().trim();

  // Explicit "N weeks" / "N week"
  const weeksMatch = s.match(/(\d+)\s*weeks?/);
  if (weeksMatch) return parseInt(weeksMatch[1], 10);

  // Explicit "N months"
  const monthsMatch = s.match(/(\d+)\s*months?/);
  if (monthsMatch) return parseInt(monthsMatch[1], 10) * 4;

  // Named durations
  if (/semester/.test(s)) return 18;
  if (/trimester/.test(s)) return 12;
  if (/quarter/.test(s))   return 9;
  if (/year|annual/.test(s)) return 36;

  // Fallback
  return 18;
}

/**
 * Derive spine structure from week count:
 *
 *  ≤6 weeks  → 2 chapters, 1 mid boss, 1 final boss  (mini-unit)
 *  7–10 wks  → 3 chapters                             (quarter)
 *  11–14 wks → 4 chapters                             (trimester / short semester)
 *  15–22 wks → 6 chapters                             (full semester)
 *  23–30 wks → 8 chapters                             (long semester / 3-quarter year)
 *  31+ wks   → 10 chapters                            (full year)
 *
 * Returns: { chapterCount, connectorsPerGap, choiceCount, deepCount }
 */
/**
 * Derive spine structure from week count.
 *
 * connectorsPerGap: lesson nodes between each pair of chapter milestones.
 *   Best practice (UbD / Understanding by Design): a 2-3 week chapter needs
 *   8-12 instructional activities. Zone A connectors fill ~half of that; Zone B
 *   clusters fill the rest. connectorsPerGap targets ~4-6 so total lessons per
 *   chapter (connectors + cluster satellites) reaches 8-10.
 *
 * clusterSatellites: spoke nodes per branch hub in Zone B (was hardcoded 3).
 *   4 satellites per hub gives richer topic exploration.
 *
 * choiceCount / deepCount scale with course length so longer courses have
 * proportionally more optional enrichment paths.
 */
function spineScale(weeks: number): {
  chapterCount: number;
  connectorsPerGap: number;
  clusterSatellites: number;
  choiceCount: number;
  deepCount: number;
} {
  //                                      chap  conn  sat  choice  deep
  if (weeks <= 6)  return { chapterCount: 2,  connectorsPerGap: 4, clusterSatellites: 3, choiceCount: 6,  deepCount: 4  };
  if (weeks <= 10) return { chapterCount: 3,  connectorsPerGap: 4, clusterSatellites: 4, choiceCount: 9,  deepCount: 6  };
  if (weeks <= 14) return { chapterCount: 4,  connectorsPerGap: 5, clusterSatellites: 4, choiceCount: 12, deepCount: 8  };
  if (weeks <= 22) return { chapterCount: 6,  connectorsPerGap: 5, clusterSatellites: 4, choiceCount: 18, deepCount: 12 };
  if (weeks <= 30) return { chapterCount: 8,  connectorsPerGap: 6, clusterSatellites: 4, choiceCount: 24, deepCount: 16 };
  return              { chapterCount: 10, connectorsPerGap: 6, clusterSatellites: 5, choiceCount: 30, deepCount: 20 };
}

// ── Curriculum Wizard: Spine generation ──────────────────────────────────────

/**
 * Generates ONLY the structural backbone — milestones and bosses.
 * Chapter count and density are derived from courseLength so a 6-week
 * unit gets 2 chapters while a full year gets 10.
 */
export async function generateCurriculumSpine(input: {
  subject: string;
  gradeLevel: string;
  courseLength: string;
  interests: string;
  ageYears?: number;
  focusSteering?: string;
}): Promise<CurriculumNodeSuggestion[]> {
  const weeks = courseLengthToWeeks(input.courseLength);
  const { chapterCount } = spineScale(weeks);
  const calibration = gradeCalibrationContext(input.gradeLevel, input.ageYears);

  const prompt = [
    `You are building a curriculum spine for ${input.subject}, grade ${input.gradeLevel}, ${input.courseLength}.`,
    input.interests ? `Student interests: ${input.interests}.` : "",
    input.focusSteering ? `Curriculum focus/steering: ${input.focusSteering} — weave relevant examples and contexts into chapter titles and descriptions.` : "",
    `Grade-level calibration: ${calibration}`,
    "",
    `Generate a JSON array of ${chapterCount + 3} nodes. Rules:`,
    "- spine_0: the course root (depth 0, prerequisites [], nodeType 'milestone', colorRamp 'teal', xpReward 100, isRequired true)",
    `- spine_1 through spine_${Math.ceil(chapterCount / 2)}: left-lane chapter milestones (each depends on the previous, depth 1+, colorRamp 'teal', nodeType 'milestone', isRequired true)`,
    `- spine_${Math.ceil(chapterCount / 2) + 1} through spine_${chapterCount}: right-lane chapter milestones (spine_${Math.ceil(chapterCount / 2) + 1} depends on spine_0, rest chain from there, colorRamp 'teal', nodeType 'milestone', isRequired true)`,
    `- spine_${chapterCount + 1}: mid-term boss (nodeType 'boss', colorRamp 'blue', xpReward 450, isRequired true, prerequisites [spine_${Math.ceil(chapterCount / 2)}, spine_${chapterCount}])`,
    `- spine_${chapterCount + 2}: final boss (nodeType 'boss', colorRamp 'blue', xpReward 700, isRequired true, prerequisites [spine_${chapterCount + 1}])`,
    "",
    "Each node must have these exact fields:",
    '{"tempId":"spine_0","title":"Course Name","description":"One sentence.","icon":"🌟","colorRamp":"teal","nodeType":"milestone","cluster":"core","depth":0,"xpReward":100,"isRequired":true,"prerequisites":[],"suggestedAssignments":[]}',
    "",
    "Output ONLY the JSON array. No markdown fences, no explanation.",
  ].filter(Boolean).join("\n");

  const attempts: Array<{ responseText: string; candidateCount: number; parsedCount: number }> = [];

  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await env.AI.run(DEFAULT_LLM_MODEL, {
      messages: [
        {
          role: "system",
          content: "You output only valid JSON arrays. No markdown, no prose, no code fences.",
        },
        {
          role: "user",
          content: attempt === 0
            ? prompt
            : `${prompt}\n\nCRITICAL: your previous response was not valid JSON. Output ONLY the raw JSON array starting with [ and ending with ]. Nothing else.`,
        },
      ],
      max_tokens: 2500,
    });

    const responseText = toModelText(result);
    const rawCandidates = [
      ...extractJsonCandidates(result),
      ...extractJsonCandidates(responseText),
      extractJsonPayload(responseText),
    ].filter((v): v is NonNullable<typeof v> => v !== null);

    let bestParsed = 0;
    for (const candidate of dedupeCandidates(rawCandidates)) {
      const nodes = extractCurriculumArray(candidate);
      if (nodes.length > bestParsed) bestParsed = nodes.length;
      if (nodes.length >= 3) return nodes;
    }

    attempts.push({
      responseText: responseText.slice(0, 400),
      candidateCount: rawCandidates.length,
      parsedCount: bestParsed,
    });
  }

  const debug = attempts
    .map(
      (a, i) =>
        `Attempt ${i + 1}: ${a.candidateCount} JSON candidates, ${a.parsedCount} valid nodes. Response preview: "${a.responseText}"`,
    )
    .join(" | ");

  throw new Error(`AI_SPINE_PARSE_FAILED — ${debug}`);
}

/**
 * Given an approved spine, weaves lessons and electives around it to form the
 * full gameified interconnected skill web. Returns ONLY the new non-spine nodes;
 * the caller merges with the spine.
 */
export async function generateCurriculumWebFromSpine(input: {
  subject: string;
  gradeLevel: string;
  courseLength: string;
  interests: string;
  spineNodes: Array<{
    tempId: string;
    title: string;
    nodeType: string;
    depth: number;
    prerequisites: string[];
  }>;
}): Promise<CurriculumNodeSuggestion[]> {
  const weeks = courseLengthToWeeks(input.courseLength);
  const scale = spineScale(weeks);

  // Count spine milestones (non-boss nodes) to size zones proportionally
  const milestoneSpine = input.spineNodes.filter((n) => n.nodeType !== "boss");
  const milestoneCount = Math.max(1, milestoneSpine.length);

  // Zone A: required connectors per consecutive milestone gap
  const connectorCount = (milestoneCount - 1) * scale.connectorsPerGap;
  // Zone B: hub + N satellites for ~70% of milestones (was 60%)
  const clusterMilestoneCount = Math.max(1, Math.floor(milestoneCount * 0.7));
  const clusterCount = clusterMilestoneCount * (1 + scale.clusterSatellites); // 1 hub + satellites
  // Zone C: student choice branches — scales with course length
  const choiceCount = scale.choiceCount;
  // Zone D: deep specialist chains — scales with course length
  const deepCount = scale.deepCount;
  const totalNew = connectorCount + clusterCount + choiceCount + deepCount;

  const spineContext = input.spineNodes
    .map((n) =>
      `  ${n.tempId} (depth=${n.depth}, ${n.nodeType}): "${n.title}" ← prereqs: [${n.prerequisites.join(", ") || "none"}]`,
    )
    .join("\n");

  const milestoneList = milestoneSpine.map((n) => n.tempId).join(", ");

  const lines = [
    `You are weaving a Path-of-Exile-style skill web for ${input.subject}, grade ${input.gradeLevel}.`,
    `Student interests: ${input.interests || "general"}`,
    "",
    "═══ APPROVED SPINE — reference these tempIds only, do NOT re-output them ═══",
    spineContext,
    "═════════════════════════════════════════════════════════════════════════════",
    "",
    `Generate exactly ${totalNew} NEW nodes using these FOUR TOPOLOGY ZONES.`,
    "New tempIds: web_1, web_2, web_3 … (sequential integers, never reuse spine_N ids).",
    "No forward references — prerequisites only point to lower-numbered tempIds.",
    "",
    `━━━ ZONE A — CRITICAL PATH CONNECTORS (~${connectorCount} nodes) ━━━`,
    "  cluster='core', isRequired=true, colorRamp='teal' or 'blue', nodeType='lesson'",
    "  Between each pair of consecutive spine milestones, create a CHAIN of 2-3 lesson nodes.",
    `  Milestone pairs to connect: ${milestoneList}`,
    "  Chain structure: lesson1 ← milestone_A, lesson2 ← lesson1, milestone_B gets lesson2 as prerequisite (BUT milestone_B is a spine node — do not re-output it).",
    "  Actually: just create the chain of connector lessons leading UP TO each subsequent milestone.",
    "  Example: spine_0 → web_1 → web_2, and spine_1 has web_2 in its prerequisites (already handled by spine — just create web_1, web_2 pointing back to spine_0).",
    "  These lessons represent the minimum required path through the course.",
    "  XP: 80–200 (shallow depth).",
    "",
    `━━━ ZONE B — TOPIC BRANCH CLUSTERS (~${clusterCount} nodes) ━━━`,
    "  cluster='specialization', isRequired=false, colorRamp cycles through 'purple'/'amber'/'coral'/'green', nodeType='lesson' or 'elective'",
    `  For ${clusterMilestoneCount} of the spine milestone nodes, create a HUB-AND-SPOKE cluster:`,
    "    • 1 'branch' hub node (nodeType='branch') whose prerequisite is the milestone. It is a gateway topic — the title names the sub-topic cluster.",
    `    • ${scale.clusterSatellites} satellite lesson/elective nodes each with prerequisite=hub. They explore distinct aspects of the cluster topic — each should cover a different facet (e.g., cause, effect, process, application, comparison).`,
    "  Each cluster uses ONE consistent colorRamp (different cluster = different ramp).",
    "  XP: hub 200–350, satellites 150–450.",
    "",
    `━━━ ZONE C — STUDENT CHOICE FORKS (~${choiceCount} nodes) ━━━`,
    "  cluster='core', isRequired=false, nodeType='lesson', colorRamp='blue' or 'teal'",
    `  At ${Math.max(1, Math.floor(scale.choiceCount / 6))} spine milestone(s), offer TWO alternate approach paths:`,
    "    Path A: 3 lesson nodes (chain), prerequisite starts from the milestone.",
    "    Path B: 3 lesson nodes (chain), also starting from the same milestone.",
    "  The two paths cover the same content unit from different angles (e.g., visual vs. analytical, historical vs. applied).",
    "  These are TRUE FORKS in the main course flow, not optional side quests.",
    "  Keep the paths balanced: same number of nodes, similar XP totals, similar rigor, and comparable assignment weight so no path is the obvious shortcut.",
    "  Student should be able to complete ONE path to advance, while the other path remains available later for extra XP.",
    "  Label clearly in description which path this belongs to (e.g., 'Path A: Visual approach').",
    "  XP: 150–300.",
    "",
    `━━━ ZONE D — DEEP SPECIALIST CHAINS (~${deepCount} nodes) ━━━`,
    "  cluster='specialization', isRequired=false, nodeType='elective', colorRamp='purple' or 'green'",
    "  Create 2-3 deep expert chains, each 3-4 nodes long, going into an advanced subtopic.",
    "  Each chain starts from a Zone B hub or a Zone A connector (at depth 3+).",
    "  The last node of each chain may optionally list a later spine milestone as an additional prerequisite to show 'this advanced work connects back to the main path'.",
    "  XP: 350–1000 (deepest nodes should be 700–1000).",
    "",
    "GLOBAL RULES:",
    "  • Every node must have exactly 1 prerequisite (the chain structure handles this).",
    "  • Mix subjects naturally — let the curriculum topic drive what goes in each zone.",
    "  • Vary depth: Zone A depth = milestone depth ± 1, Zone B depth = milestone depth + 1-2, Zone C depth = milestone depth + 1-3, Zone D depth = starting point + 3-5.",
    "  • Do NOT create isolated nodes — every web_N must chain properly.",
    "",
    "XP by depth:  1–2 → 80–150  |  3–4 → 150–300  |  5–6 → 300–600  |  7+ → 600–1000",
    "",
    "Node schema (JSON):",
    JSON.stringify({
      tempId: "web_N",
      prerequisites: ["spine_N or web_M (exactly 1)"],
      cluster: "core | specialization",
      depth: "integer",
      isRequired: "true for Zone A | false for B/C/D",
      title: "2–4 words",
      description: "1–2 sentences",
      icon: "single emoji",
      colorRamp: "teal|blue for core  purple|amber|coral|green for specialization",
      nodeType: "lesson | elective | branch",
      xpReward: "integer",
      suggestedAssignments: [{ type: "text|video|quiz|essay|report", title: "string" }],
    }),
    "",
    `Return ONLY a JSON array of ${totalNew} web nodes. No spine nodes. No markdown. No prose.`,
  ].join("\n");

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await env.AI.run(DEFAULT_LLM_MODEL, {
      messages: [
        { role: "system", content: "You are a curriculum designer building skill webs. Output only valid JSON." },
        { role: "user", content: attempt === 0 ? lines : `${lines}\n\nReturn ONLY the raw JSON array.` },
      ],
      max_tokens: 6000,
    });

    const responseText = toModelText(result);
    const rawCandidates = [
      ...extractJsonCandidates(result),
      ...extractJsonCandidates(responseText),
      extractJsonPayload(responseText),
    ].filter((v): v is NonNullable<typeof v> => v !== null);

    for (const candidate of dedupeCandidates(rawCandidates)) {
      const nodes = extractCurriculumArray(candidate);
      if (nodes.length >= 5) return nodes;
    }
  }

  throw new Error("AI_WEB_PARSE_FAILED");
}

/**
 * Stage 2: Generate 3-4 lesson nodes for a single spine milestone.
 * Each lesson connects directly under the milestone and chains to the next.
 * Returns ONLY new nodes — caller assigns tempIds like "ch_{milestoneId}_{i}".
 */
export async function generateChapterCluster(input: {
  subject: string;
  gradeLevel: string;
  milestoneId: string;
  milestoneTitle: string;
  milestoneDescription: string;
  milestoneDepth: number;
  existingTitles: string[];
  ageYears?: number;
  focusSteering?: string;
}): Promise<CurriculumNodeSuggestion[]> {
  const prefix = `ch_${input.milestoneId}`;
  const d = input.milestoneDepth + 1;
  const calibration = gradeCalibrationContext(input.gradeLevel, input.ageYears);

  const prompt = [
    `You are building lesson nodes for a ${input.subject} curriculum, grade ${input.gradeLevel}.`,
    `Parent milestone: "${input.milestoneTitle}" — ${input.milestoneDescription}`,
    input.focusSteering ? `Curriculum focus: ${input.focusSteering} — use relevant local examples where applicable.` : "",
    `Grade-level calibration: ${calibration}`,
    ``,
    `Generate exactly 3 lesson nodes that teach the content of this milestone, as a learning chain.`,
    `TempId format: ${prefix}_0, ${prefix}_1, ${prefix}_2`,
    `Chain rule: ${prefix}_0 prerequisite=[${input.milestoneId}], ${prefix}_1 prerequisite=[${prefix}_0], ${prefix}_2 prerequisite=[${prefix}_1]`,
    `All nodes: cluster="core", isRequired=true, nodeType="lesson", depth=${d}`,
    `Avoid duplicating any of these existing topics: ${input.existingTitles.slice(0, 20).join(", ")}`,
    ``,
    `Example node:`,
    `{"tempId":"${prefix}_0","title":"Introduction","description":"Learn the basics.","icon":"📖","colorRamp":"teal","nodeType":"lesson","cluster":"core","depth":${d},"xpReward":120,"isRequired":true,"prerequisites":["${input.milestoneId}"],"suggestedAssignments":[{"type":"text","title":"Reading exercise"}]}`,
    ``,
    `Output ONLY a JSON array of 3 nodes. No markdown. No prose.`,
  ].join("\n");

  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await env.AI.run(DEFAULT_LLM_MODEL, {
      messages: [
        { role: "system", content: "You output only valid JSON arrays. No markdown, no prose, no code fences." },
        {
          role: "user",
          content: attempt === 0
            ? prompt
            : `${prompt}\n\nCRITICAL: output ONLY the raw JSON array starting with [ and ending with ]. Nothing else.`,
        },
      ],
      max_tokens: 1200,
    });

    const responseText = toModelText(result);
    const rawCandidates = [
      ...extractJsonCandidates(result),
      ...extractJsonCandidates(responseText),
      extractJsonPayload(responseText),
    ].filter((v): v is NonNullable<typeof v> => v !== null);

    for (const candidate of dedupeCandidates(rawCandidates)) {
      const nodes = extractCurriculumArray(candidate);
      if (nodes.length >= 2) return nodes;
    }
  }

  return []; // soft fail — caller skips this milestone
}

/**
 * Stage 3: Generate 2-3 elective/branch nodes for a lesson cluster.
 * These fan out as optional specialization branches from the last lesson
 * in a chapter cluster.
 */
export async function generateBranchCluster(input: {
  subject: string;
  gradeLevel: string;
  lessonId: string;
  lessonTitle: string;
  lessonDescription: string;
  lessonDepth: number;
  milestoneTitle: string;
  existingTitles: string[];
  ageYears?: number;
  focusSteering?: string;
}): Promise<CurriculumNodeSuggestion[]> {
  const prefix = `br_${input.lessonId}`;
  const d = input.lessonDepth + 1;
  const calibration = gradeCalibrationContext(input.gradeLevel, input.ageYears);

  const prompt = [
    `You are adding optional exploration branches to a ${input.subject} curriculum, grade ${input.gradeLevel}.`,
    `The student just learned: "${input.lessonTitle}" — ${input.lessonDescription}`,
    `This is part of the unit: "${input.milestoneTitle}"`,
    input.focusSteering ? `Curriculum focus: ${input.focusSteering} — connect branch topics to this theme where meaningful.` : "",
    `Grade-level calibration: ${calibration}`,
    ``,
    `Generate exactly 2 elective nodes that let a student go DEEPER into this topic (optional enrichment).`,
    `TempId format: ${prefix}_0, ${prefix}_1`,
    `Both nodes: prerequisites=["${input.lessonId}"], cluster="specialization", isRequired=false, nodeType="elective", depth=${d}`,
    `Each should explore a different angle: one practical/applied, one historical/theoretical.`,
    `Avoid duplicating any of these existing topics: ${input.existingTitles.slice(0, 20).join(", ")}`,
    ``,
    `Example node:`,
    `{"tempId":"${prefix}_0","title":"Deep Dive: Applied","description":"Hands-on project exploring ${input.lessonTitle} in real life.","icon":"🔬","colorRamp":"purple","nodeType":"elective","cluster":"specialization","depth":${d},"xpReward":280,"isRequired":false,"prerequisites":["${input.lessonId}"],"suggestedAssignments":[{"type":"report","title":"Research project"}]}`,
    ``,
    `Output ONLY a JSON array of 2 nodes. No markdown. No prose.`,
  ].join("\n");

  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await env.AI.run(DEFAULT_LLM_MODEL, {
      messages: [
        { role: "system", content: "You output only valid JSON arrays. No markdown, no prose, no code fences." },
        {
          role: "user",
          content: attempt === 0
            ? prompt
            : `${prompt}\n\nCRITICAL: output ONLY the raw JSON array starting with [ and ending with ]. Nothing else.`,
        },
      ],
      max_tokens: 800,
    });

    const responseText = toModelText(result);
    const rawCandidates = [
      ...extractJsonCandidates(result),
      ...extractJsonCandidates(responseText),
      extractJsonPayload(responseText),
    ].filter((v): v is NonNullable<typeof v> => v !== null);

    for (const candidate of dedupeCandidates(rawCandidates)) {
      const nodes = extractCurriculumArray(candidate);
      if (nodes.length >= 1) return nodes;
    }
  }

  return []; // soft fail
}

// ── Node assignment generation ────────────────────────────────────────────────

export type AssignmentPrefs = {
  // Per-node content
  readingPerNode: boolean;        // include a reading passage for lesson/elective nodes
  videosPerLesson: number;        // 0–3: videos for lesson/elective nodes
  // Chapter (milestone) node settings
  chapterIntroVideo: boolean;     // include an intro video for chapter/milestone nodes
  quizzesPerChapter: number;      // 0–3: quizzes per chapter checkpoint
  essaysPerChapter: number;       // 0–2: essay prompts per chapter
  // Boss (capstone) settings
  quizzesPerBoss: number;         // 0–5: quizzes for boss nodes
  essaysPerBoss: number;          // 0–3: essays for boss nodes
  papersPerBoss: number;          // 0–2: research papers for boss nodes
  includeProjects: boolean;       // include hands-on project for boss nodes
  // Movie assignments
  includeMovies: boolean;         // allow movie-watching assignments (with linked follow-up)
  // Extra
  otherInstructions: string;
};

export type GeneratedAssignment = {
  nodeId: string;           // tempId of the node this belongs to
  contentType: "text" | "video" | "quiz" | "essay_questions" | "report" | "movie";
  title: string;
  description: string;
  /** For video/movie: a YouTube/title search query. For text: HTML content. For quiz: JSON string. For essay/report: the prompt text. */
  contentRef: string;
  /** For movie assignments, the follow-up linked assignment type */
  linkedFollowUpType?: "quiz" | "essay_questions" | "report";
};

/**
 * Generate assignments for a single node.
 * Assignment counts and types are dynamically determined by node type:
 *
 * milestone (chapter entry point): intro overview text + optional intro video + quizzes/essays per prefs
 * lesson/branch (core topic):      reading passage + targeted videos + quiz if prefs allow
 * elective (deep dive):            reading + video + project/report
 * boss (capstone):                 review reading + multiple quizzes + essays + optional paper/project
 *
 * Movies can appear on milestone or elective nodes when enabled, always followed by a linked follow-up.
 */
export async function generateAssignmentsForNode(input: {
  subject: string;
  gradeLevel: string;
  node: { tempId: string; title: string; description: string; nodeType: string };
  prefs: AssignmentPrefs;
  youtubeApiKey?: string;
  ageYears?: number;
  focusSteering?: string;
}): Promise<GeneratedAssignment[]> {
  const { node, prefs } = input;
  const tasks: string[] = [];

  const isBoss = node.nodeType === "boss";
  const isMilestone = node.nodeType === "milestone";
  const isLesson = node.nodeType === "lesson" || node.nodeType === "branch";
  const isElective = node.nodeType === "elective";

  if (isMilestone) {
    // Chapter entry nodes — overview, activation, and chapter-level assessment.
    // Best practice: chapter openers include a "hook" to activate prior knowledge,
    // an overview of learning objectives, and 1-2 intro media before the first lesson.
    tasks.push('1 chapter overview: contentType="text", contentRef=a detailed 5-paragraph HTML chapter introduction using <p> tags (500-700 words): paragraph 1 hooks the student with a compelling question or real-world connection, paragraph 2 builds essential background knowledge, paragraph 3 previews key concepts and learning goals, paragraph 4 explains why the topic matters in authentic contexts for this grade/age band, paragraph 5 connects to prior and upcoming learning. Keep depth high and grade-calibrated; do not oversimplify to be brief. Title like "Chapter Intro: <topic>"');
    if (prefs.chapterIntroVideo) {
      tasks.push('2 intro videos: contentType="video" — (1) a broad overview video (YouTube search query), title like "Watch: <topic> Overview"; (2) a more specific video connecting to the first key concept, title like "Watch: <topic> Introduction"');
    }
    // Pre-assessment: activates prior knowledge, identifies gaps before chapter begins
    tasks.push('1 pre-assessment warm-up: contentType="quiz", contentRef=a JSON array of exactly 5 question objects [{"question":"...","options":["A","B","C","D"],"answer":"B"},...] that checks what the student already knows about this topic (diagnostic, not graded for mastery), title like "Warm-Up: What Do You Know About <topic>?"');
    if (prefs.quizzesPerChapter > 0) {
      tasks.push(`${prefs.quizzesPerChapter} chapter checkpoint quiz(zes): contentType="quiz", contentRef=a JSON array of exactly 5 question objects [{"question":"...","options":["A","B","C","D"],"answer":"B"},...] covering the chapter's core concepts, title like "Chapter Quiz: <topic>"`);
    }
    if (prefs.essaysPerChapter > 0) {
      tasks.push(`${prefs.essaysPerChapter} chapter reflection essay(s): contentType="essay_questions", contentRef=a thoughtful open-ended question (2-3 sentences) asking the student to connect the chapter theme to their own life or prior knowledge, title like "Reflect: <topic>"`);
    }
    if (prefs.includeMovies) {
      tasks.push('1 movie assignment: contentType="movie", contentRef=a JSON object {"title":"Exact Movie Title","synopsis":"1-2 sentence description of the film and why it is relevant to this topic","whereToWatch":["Netflix","Disney+","Amazon Prime Video"]} — list ONLY the streaming platforms where this specific movie is actually available; use your knowledge of streaming libraries. Title like "Watch: <Movie Title>"');
    }
  } else if (isLesson) {
    // Lesson/branch nodes — the core instructional units of a chapter.
    // Best practice (UbD, Bloom's Taxonomy): each lesson should include input (reading/video),
    // guided practice, and a formative check. 4-5 assignments per lesson is standard.
    if (prefs.readingPerNode) {
      tasks.push('1 reading lesson: contentType="text", contentRef=a thorough 6-paragraph HTML reading passage using <p> tags (700-950 words): paragraph 1 introduces the concept with a relatable hook, paragraphs 2-4 build deep conceptual understanding with multiple concrete examples and explicit vocabulary development for the grade level, paragraph 5 explains common misconceptions and clarifies them, paragraph 6 summarizes key takeaways and sets up follow-up synthesis. Prioritize depth and explanatory detail over brevity. Title like "Reading: <topic>"');
    }
    if (prefs.videosPerLesson > 0) {
      tasks.push(`${prefs.videosPerLesson} targeted video(s): contentType="video", contentRef=a specific YouTube search query for an educational video on this exact concept (not just the general topic), title like "Video: <topic>"`);
    }
    // Formative check — every lesson gets one regardless of chapter quiz setting;
    // this is the "exit ticket" equivalent that drives mastery-based progression
    tasks.push('1 formative check quiz: contentType="quiz", contentRef=a JSON array of exactly 5 question objects [{"question":"...","options":["A","B","C","D"],"answer":"B"},...] that directly assesses understanding of THIS lesson\'s specific content — questions should require students to synthesize ideas from the reading and apply them, not just recall isolated facts. Title like "Check: <topic>"');
    // Practice activity — writing response to deepen understanding
    tasks.push('1 practice activity: contentType="essay_questions", contentRef=a short-answer question (2-4 sentences) asking the student to synthesize, explain, and apply the concept in their own words with evidence from the reading. Title like "Practice: <topic>"');
  } else if (isElective) {
    // Elective/deep-dive nodes — optional enrichment and specialization.
    // Best practice: electives should go beyond recall into analysis, synthesis, creation (Bloom's upper levels).
    // These are the "stretch" nodes for motivated or advanced students.
    if (prefs.readingPerNode) {
      tasks.push('1 deep-dive reading: contentType="text", contentRef=a rich 7-paragraph HTML reading passage using <p> tags (900-1200 words) that goes beyond the textbook — includes primary source excerpts, real-world applications, and advanced analysis calibrated to grade and age. Paragraph 1: hook and context. Paragraphs 2-5: in-depth exploration with evidence and multiple perspectives. Paragraph 6: connect to broader disciplinary themes. Paragraph 7: synthesis and open questions for further thought. Prioritize thorough explanation over concision. Title like "Deep Dive: <topic>"');
    }
    if (prefs.videosPerLesson > 0) {
      tasks.push(`${Math.min(prefs.videosPerLesson + 1, 3)} video(s): contentType="video" — mix of a documentary-style video and a how-it-works or case-study video on this advanced topic, title like "Video: <topic>"`);
    }
    // Electives always include a synthesis quiz to confirm depth of understanding
    tasks.push('1 analysis quiz: contentType="quiz", contentRef=a JSON array of exactly 5 question objects [{"question":"...","options":["A","B","C","D"],"answer":"B"},...] — questions should require synthesis across ideas in the reading and application to new scenarios, not simple recall. Title like "Analysis Check: <topic>"');
    // Always include a project for electives — this is their defining characteristic
    tasks.push('1 hands-on project or creative response: contentType="report", contentRef=a detailed project prompt (5-7 sentences) that asks the student to CREATE something — a model, diagram, experiment, written piece, or presentation. Include: the goal, the process steps, what to submit, and how it connects to the topic. Title like "Project: <topic>"');
    if (prefs.includeMovies) {
      tasks.push('1 movie assignment: contentType="movie", contentRef=a JSON object {"title":"Exact Movie Title","synopsis":"1-2 sentence description of the film and why it is relevant","whereToWatch":["Netflix","Disney+"]} — list ONLY streaming platforms where this specific film is actually known to be available. Title like "Watch: <Movie Title>"');
    }
  } else if (isBoss) {
    // Boss/capstone nodes — summative assessment for the full unit.
    // Best practice (Understanding by Design Stage 2): capstones include review,
    // multiple assessment formats, and a performance task that requires transfer of learning.
    // These should feel substantial — a student might spend 2-3 days on a boss node.
    tasks.push('1 comprehensive unit review: contentType="text", contentRef=a thorough 7-paragraph HTML review using <p> tags (1000-1400 words) that synthesizes ALL key concepts from the unit: paragraph 1 frames the big ideas, paragraphs 2-5 review each major concept cluster with detailed examples and explicit connections, paragraph 6 integrates cross-cutting themes and misconceptions, paragraph 7 connects to the next unit and poses an essential question for further learning. Depth should be substantial and grade-calibrated rather than concise. Title like "Unit Review: <topic>"');
    // Boss nodes always get at least one essay — writing is essential for retention (Roediger & Karpicke)
    const essayCount = Math.max(1, prefs.essaysPerBoss);
    tasks.push(`${essayCount} analytical essay prompt(s): contentType="essay_questions", contentRef=a substantive essay question (4-6 sentences) that requires the student to synthesize evidence from the readings, make an argument, or evaluate a claim — not just summarize. Title like "Essay: <topic>"`);
    if (prefs.quizzesPerBoss > 0) {
      tasks.push(`${prefs.quizzesPerBoss} summative quiz(zes): contentType="quiz", contentRef=a JSON array of exactly 5 question objects [{"question":"...","options":["A","B","C","D"],"answer":"B"},...] — each quiz covers a different concept cluster from the unit, so together they provide comprehensive coverage. Title like "Unit Quiz: <topic>"`);
    }
    if (prefs.papersPerBoss > 0) {
      tasks.push(`${prefs.papersPerBoss} research paper prompt(s): contentType="report", contentRef=a detailed research prompt (5-6 sentences) with: the research question, required sources or evidence types, length expectations, and evaluation criteria. Title like "Research Paper: <topic>"`);
    }
    if (prefs.includeProjects) {
      tasks.push('1 performance task / capstone project: contentType="report", contentRef=a rich performance task description (6-8 sentences) — this is the "transfer task" of UbD where the student applies learning to a new, authentic situation. Include: the scenario or challenge, the deliverable, the audience (who they are presenting/writing for), required components, and success criteria. Title like "Capstone: <topic>"');
    }
  }

  // Extra instructions apply to all types
  if (prefs.otherInstructions) {
    tasks.push(`Additional instruction: ${prefs.otherInstructions}`);
  }

  if (tasks.length === 0) return [];

  const nodeId = node.tempId;
  const calibration = gradeCalibrationContext(input.gradeLevel, input.ageYears);
  const prompt = [
    `You are creating assignments for a ${input.subject} curriculum, grade ${input.gradeLevel}.`,
    `Grade-level calibration: ${calibration}`,
    input.focusSteering ? `Curriculum focus: ${input.focusSteering} — use relevant examples from this theme in readings and quiz questions where applicable.` : "",
    `Node: "${node.title}" (type: ${node.nodeType})`,
    node.description ? `Context: ${node.description.slice(0, 200)}` : "",
    `Reading quality policy: prioritize thorough, informative, grade-calibrated explanations. Do not shorten readings for concision. Use quizzes and written assignments to make students synthesize and apply what they read.`,
    "",
    `Generate the following assignments for this node (nodeId must be exactly "${nodeId}"):`,
    tasks.map((t, i) => `${i + 1}. ${t}`).join("\n"),
    "",
    'Each assignment object: {"nodeId":"EXACT_NODE_ID","contentType":"...","title":"...","description":"1 sentence","contentRef":"..."}',
    `Valid contentType values: text, video, quiz, essay_questions, report, movie`,
    `IMPORTANT: nodeId must be exactly: ${nodeId}`,
    "Output ONLY the JSON array. No markdown. No prose.",
  ].filter(Boolean).join("\n");

  const validTypes = new Set(["text", "video", "quiz", "essay_questions", "report", "movie"]);

  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await env.AI.run(DEFAULT_LLM_MODEL, {
      messages: [
        { role: "system", content: "You output only valid JSON arrays. No markdown, no prose, no code fences." },
        {
          role: "user",
          content: attempt === 0
            ? prompt
            : `${prompt}\n\nCRITICAL: output ONLY the raw JSON array. nodeId must be exactly "${nodeId}".`,
        },
      ],
      max_tokens: 2800,
    });

    const responseText = toModelText(result);
    const rawCandidates = [
      ...extractJsonCandidates(result),
      ...extractJsonCandidates(responseText),
      extractJsonPayload(responseText),
    ].filter((v): v is NonNullable<typeof v> => v !== null);

    for (const candidate of dedupeCandidates(rawCandidates)) {
      let arr: unknown[] | null = null;
      if (Array.isArray(candidate)) {
        arr = candidate;
      } else if (candidate && typeof candidate === "object") {
        const r = candidate as Record<string, unknown>;
        for (const val of Object.values(r)) {
          if (Array.isArray(val) && val.length > 0) { arr = val; break; }
        }
      }
      if (!arr) continue;

      const parsed: GeneratedAssignment[] = [];
      for (const item of arr) {
        if (!item || typeof item !== "object") continue;
        const r = item as Record<string, unknown>;
        // Accept nodeId even if model got it slightly wrong — we know what node this is for
        if (typeof r.contentType !== "string" || !validTypes.has(r.contentType)) continue;
        if (typeof r.title !== "string" || !r.title) continue;
        parsed.push({
          nodeId,  // always use the known nodeId regardless of what model output
          contentType: r.contentType as GeneratedAssignment["contentType"],
          title: String(r.title).trim(),
          description: typeof r.description === "string" ? r.description.trim() : "",
          contentRef: typeof r.contentRef === "string" ? r.contentRef : "",
        });
      }
      if (parsed.length >= 1) {
        // Resolve YouTube video IDs if API key is provided
        if (input.youtubeApiKey) {
          const resolved = await resolveVideoAssignments(parsed, input.youtubeApiKey, input.subject, input.gradeLevel);
          return resolved;
        }
        return parsed;
      }
    }
  }

  return []; // soft fail
}

/**
 * For any video assignments that have a search-query contentRef, call the YouTube API
 * to resolve a real validated videoId. Replaces the search query with a JSON object
 * containing the validated videoId, title, and channel.
 */
async function resolveVideoAssignments(
  assignments: GeneratedAssignment[],
  apiKey: string,
  subject: string,
  gradeLevel: string,
): Promise<GeneratedAssignment[]> {
  return Promise.all(
    assignments.map(async (assignment) => {
      if (assignment.contentType !== "video") return assignment;

      // If contentRef already looks like a resolved JSON blob, skip
      const trimmed = assignment.contentRef.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) return assignment;

      try {
        const query = `${assignment.contentRef} ${subject} grade ${gradeLevel} educational`;
        const videos = await searchYoutubeForVideos(query, apiKey);
        const top = videos[0];
        if (!top) return assignment;

        return {
          ...assignment,
          contentRef: JSON.stringify({
            videoId: top.videoId,
            title: top.title,
            channel: top.channel,
            thumbnail: top.thumbnail,
            query: assignment.contentRef,
          }),
        };
      } catch {
        // YouTube search failed — keep the original search query string
        return assignment;
      }
    }),
  );
}

/** @deprecated Use generateAssignmentsForNode instead (per-node calls) */
export async function generateNodeAssignments(input: {
  subject: string;
  gradeLevel: string;
  prefs: AssignmentPrefs;
  nodes: Array<{ tempId: string; title: string; description: string; nodeType: string }>;
}): Promise<GeneratedAssignment[]> {
  // Run per-node in sequence to avoid token overflow
  const all: GeneratedAssignment[] = [];
  for (const node of input.nodes) {
    const results = await generateAssignmentsForNode({
      subject: input.subject,
      gradeLevel: input.gradeLevel,
      node,
      prefs: input.prefs,
    });
    all.push(...results);
  }
  return all;
}

// ── Grade calibration ─────────────────────────────────────────────────────────

/**
 * Returns a grade-level calibration context string for AI prompts.
 * Ensures content complexity, vocabulary, and expectations are age-appropriate.
 */
export function gradeCalibrationContext(gradeLevel: string, ageYears?: number): string {
  const grade = parseInt(gradeLevel, 10);
  const effectiveGrade = Number.isFinite(grade) ? grade : (ageYears ? ageYears - 5 : 7);

  if (effectiveGrade <= 2) {
    return "Use simple, concrete vocabulary, but still teach with depth through rich examples, explicit why/how explanations, and careful scaffolding. Prefer multiple short paragraphs over brief summaries. Avoid abstract jargon; keep concepts anchored in familiar daily-life contexts.";
  }
  if (effectiveGrade <= 5) {
    return "Use foundational academic vocabulary with clear definitions when needed. Build detailed explanations step by step with multiple examples and comparisons. Expect students to classify, compare, and explain cause/effect. Keep language accessible, but do not oversimplify content.";
  }
  if (effectiveGrade <= 8) {
    return "Develop cause-effect reasoning and structured argumentation with substantial explanatory detail. Introduce primary and secondary sources where relevant. Use domain-specific vocabulary appropriate for the subject and require evidence-based claims and cross-topic connections.";
  }
  if (effectiveGrade <= 10) {
    return "Emphasize critical thinking, textual analysis, and synthesis across multiple sources with detailed, information-rich prose. Use college-prep vocabulary and nuanced argumentation. Assume students can handle complex texts, counterarguments, and multi-step problem solving.";
  }
  return "Use advanced academic language and substantial disciplinary detail. Expect original analysis, synthesis of scholarly ideas, and independent inquiry. Content should reflect AP/dual-enrollment rigor with primary sources, methodological critique, and evidence-driven reasoning.";
}

// ── Curriculum recommendation ──────────────────────────────────────────────────

export type CourseRecommendation = {
  name: string;
  subject: string;
  description: string;
  courseLength: string;
  rationale: string;
};

export async function recommendCurriculumCourses(input: {
  gradeLevel: string;
  ageYears: number;
  duration: string;
  courseCount: number;
  focusSteering: string;
}): Promise<CourseRecommendation[]> {
  const courseLength = input.duration;

  // Derive grade-appropriate course expectations in one compact line
  const grade = parseInt(input.gradeLevel, 10);
  const gradeNote =
    grade <= 5
      ? "foundational skills, concrete examples"
      : grade <= 8
        ? "core academic rigor, structured reasoning"
        : "college-prep depth, independent analysis";

  const steeringNote = input.focusSteering
    ? `Weave this focus theme into course names and descriptions: "${input.focusSteering}".`
    : "";

  const prompt = [
    `Grade ${input.gradeLevel} (age ${input.ageYears}) homeschool curriculum — ${input.duration} duration.`,
    `Style: ${gradeNote}.`,
    steeringNote,
    ``,
    `Output a JSON array of exactly ${input.courseCount} course objects.`,
    `Rules: (1) Start with the 4 core subjects for this grade (ELA, Math, Science, History/Social Studies). (2) Fill remaining slots with electives (Art, PE, Music, Technology, etc.). (3) Each subject must be distinct. (4) Names must be specific, not generic.`,
    ``,
    `Schema (one line per field):`,
    `{"name":"string","subject":"string","description":"1-2 sentences","courseLength":"${courseLength}","rationale":"1 sentence"}`,
    ``,
    `Return ONLY the JSON array. No markdown. No explanation.`,
  ].filter(Boolean).join("\n");

  const diagnostics: string[] = [];

  for (let attempt = 0; attempt < 3; attempt++) {
    let result: Awaited<ReturnType<typeof env.AI.run>>;
    try {
      result = await env.AI.run(DEFAULT_LLM_MODEL, {
        messages: [
          {
            role: "system",
            content: "You output only valid JSON arrays. No markdown fences, no prose, no explanation.",
          },
          {
            role: "user",
            content:
              attempt === 0
                ? prompt
                : `${prompt}\n\nCRITICAL: Output ONLY the raw JSON array starting with [ and ending with ]. Nothing else.`,
          },
        ],
        max_tokens: 3000,
      });
    } catch (aiErr) {
      const errMsg = aiErr instanceof Error ? aiErr.message : String(aiErr);
      diagnostics.push(`attempt ${attempt + 1}: AI.run threw — ${errMsg}`);
      continue;
    }

    const responseText = toModelText(result);
    const preview = responseText.slice(0, 300).replace(/\n/g, "\\n");

    const rawCandidates = [
      ...extractJsonCandidates(result),
      ...extractJsonCandidates(responseText),
      extractJsonPayload(responseText),
    ].filter((v): v is NonNullable<typeof v> => v !== null);

    // Unwrap common object wrappers: {response:[...]}, {courses:[...]}, {data:[...]}, etc.
    const WRAPPER_KEYS = ["response", "courses", "data", "result", "items", "curriculum", "recommendations"];
    const unwrapped = rawCandidates.flatMap((c) => {
      if (Array.isArray(c)) return [c];
      if (c && typeof c === "object") {
        for (const key of WRAPPER_KEYS) {
          const val = (c as Record<string, unknown>)[key];
          if (Array.isArray(val)) return [val];
        }
        // Try any array-valued key
        for (const val of Object.values(c as Record<string, unknown>)) {
          if (Array.isArray(val) && val.length > 0) return [val];
        }
      }
      return [];
    });
    const deduped = dedupeCandidates([...unwrapped, ...rawCandidates]);
    let foundArray = false;

    for (const candidate of deduped) {
      if (!Array.isArray(candidate)) continue;
      foundArray = true;
      const parsed: CourseRecommendation[] = [];
      for (const item of candidate) {
        if (!item || typeof item !== "object") continue;
        const r = item as Record<string, unknown>;
        if (typeof r.name !== "string" || !r.name) continue;
        parsed.push({
          name: String(r.name).trim(),
          subject: typeof r.subject === "string" ? r.subject.trim() : String(r.name).trim(),
          description: typeof r.description === "string" ? r.description.trim() : "",
          courseLength: typeof r.courseLength === "string" ? r.courseLength : courseLength,
          rationale: typeof r.rationale === "string" ? r.rationale.trim() : "",
        });
      }
      if (parsed.length >= 1) return parsed.slice(0, input.courseCount);
      diagnostics.push(`attempt ${attempt + 1}: found array but 0 items passed name check (array length=${candidate.length})`);
    }

    if (!foundArray) {
      diagnostics.push(`attempt ${attempt + 1}: no JSON array found in response. candidates=${deduped.length}. preview="${preview}"`);
    }
  }

  throw new Error(`AI_CURRICULUM_RECOMMEND_FAILED after 3 attempts — ${diagnostics.join(" | ")}`);
}

// ── Lesson reading generation ──────────────────────────────────────────────────

/**
 * Generate a grade-appropriate reading passage for a single lesson node.
 * Returns HTML string (uses <p> tags). Each lesson gets its own call to keep
 * context focused and avoid token overflow.
 */
export async function generateLessonReading(input: {
  nodeTitle: string;
  nodeDescription: string;
  subject: string;
  gradeLevel: string;
  ageYears: number;
  focusSteering?: string;
  nodeType?: string;
}): Promise<string> {
  const calibration = gradeCalibrationContext(input.gradeLevel, input.ageYears);
  const isElective = input.nodeType === "elective";
  const wordTarget = isElective ? "900–1200" : "700–950";
  const paraCount = isElective ? 7 : 6;

  const steeringLine = input.focusSteering
    ? `Weave in real-world examples, places, or contexts related to: "${input.focusSteering}".`
    : "";

  const structureGuide = isElective
    ? `Structure: (1) Hook with a compelling question or surprising fact. (2-5) In-depth exploration with examples, evidence, and at least one competing perspective. (6) Clarify misconceptions and connect to broader themes. (7) Synthesis and open question for further thought.`
    : `Structure: (1) Relatable hook or real-world connection. (2-4) Deep concept explanation with multiple grade-appropriate examples and explicit vocabulary support. (5) Clarify a common misconception or tricky point. (6) Key takeaways and a thinking question.`;

  const prompt = [
    `You are writing an educational reading passage for a ${input.subject} lesson.`,
    `Topic: "${input.nodeTitle}"`,
    input.nodeDescription ? `Context: ${input.nodeDescription}` : "",
    ``,
    `Grade-level calibration: ${calibration}`,
    steeringLine,
    ``,
    `Write a ${wordTarget} word reading passage using exactly ${paraCount} HTML <p> tags.`,
    structureGuide,
    ``,
    `RULES:`,
    `- Use ONLY <p> tags. No <h1>, <h2>, <strong>, <em>, lists, or other HTML.`,
    `- Vocabulary and sentence complexity must match grade ${input.gradeLevel}.`,
    `- Include at least one specific, concrete example per paragraph.`,
    `- Prioritize thorough teaching and clear reasoning over short summaries.`,
    `- The reading should front-load knowledge; synthesis and transfer should be assessed in quizzes and written assignments.`,
    `- Do NOT use generic filler text. Every sentence must teach something.`,
    `- End the final paragraph with a thought-provoking question.`,
    ``,
    `Return ONLY the HTML (the <p> tags). No JSON, no markdown, no explanation.`,
  ].filter(Boolean).join("\n");

  const result = await env.AI.run(DEFAULT_LLM_MODEL, {
    messages: [
      { role: "system", content: "You are an educational content writer. Output only HTML <p> tags. No other tags, no markdown, no prose outside of the content." },
      { role: "user", content: prompt },
    ],
    max_tokens: 2600,
  });

  const responseText = toModelText(result);

  // Extract <p> tags from the response
  const pMatches = responseText.match(/<p[\s>][\s\S]*?<\/p>/gi);
  if (pMatches && pMatches.length >= 2) {
    return pMatches.join("\n");
  }

  // Fallback: if model returned plain text paragraphs, wrap them
  const paragraphs = responseText
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 20);

  if (paragraphs.length >= 2) {
    return paragraphs.map((p) => `<p>${p}</p>`).join("\n");
  }

  // Last resort fallback
  return `<p>${responseText.trim()}</p>`;
}

// ── Reward suggestions ────────────────────────────────────────────────────────

export type RewardSuggestion = {
  tierNumber: number;
  icon: string;
  title: string;
  rewardType: "treat" | "activity" | "item" | "screen_time" | "experience";
};

export async function generateRewardSuggestions(input: {
  gradeLevel: string;
  studentName: string;
  count: number;
}): Promise<RewardSuggestion[]> {
  const prompt = [
    `Suggest ${input.count} age-appropriate rewards for a homeschool student named ${input.studentName} in grade ${input.gradeLevel}.`,
    "Rewards should escalate in excitement from tier 1 (small treat) to tier 10 (big reward).",
    "Mix types: food treats, activities, toys/items, screen time, experiences.",
    `Return ONLY a JSON array of exactly ${input.count} objects:`,
    '[{ "tierNumber": 1, "icon": "🍦", "title": "Ice cream cone", "rewardType": "treat" }, ...]',
    "rewardType must be one of: treat | activity | item | screen_time | experience",
    "title must be short (max 4 words). Return ONLY the JSON array. No markdown, no prose.",
  ].join("\n");

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await env.AI.run(DEFAULT_LLM_MODEL, {
      messages: [
        { role: "system", content: "You are a helpful assistant. Output only valid JSON arrays." },
        {
          role: "user",
          content:
            attempt === 0
              ? prompt
              : `${prompt}\n\nIMPORTANT: Return ONLY the raw JSON array. No markdown fences.`,
        },
      ],
      max_tokens: 800,
    });

    const responseText = toModelText(result);
    const parsed = extractJsonPayload(responseText);

    if (Array.isArray(parsed)) {
      const validTypes = ["treat", "activity", "item", "screen_time", "experience"] as const;
      const suggestions: RewardSuggestion[] = [];
      for (const item of parsed) {
        if (
          item &&
          typeof item === "object" &&
          typeof (item as Record<string, unknown>).tierNumber === "number" &&
          typeof (item as Record<string, unknown>).title === "string" &&
          typeof (item as Record<string, unknown>).icon === "string"
        ) {
          const rec = item as Record<string, unknown>;
          const rewardType = validTypes.includes(rec.rewardType as typeof validTypes[number])
            ? (rec.rewardType as RewardSuggestion["rewardType"])
            : "treat";
          suggestions.push({
            tierNumber: rec.tierNumber as number,
            icon: rec.icon as string,
            title: (rec.title as string).slice(0, 40),
            rewardType,
          });
        }
      }
      if (suggestions.length > 0) return suggestions;
    }
  }

  // Fallback: return generic suggestions
  const fallbackTypes: RewardSuggestion["rewardType"][] = [
    "treat", "treat", "activity", "item", "screen_time",
    "activity", "item", "experience", "screen_time", "experience",
  ];
  return Array.from({ length: input.count }, (_, i) => ({
    tierNumber: i + 1,
    icon: "🎁",
    title: `Tier ${i + 1} Reward`,
    rewardType: fallbackTypes[i] ?? "treat",
  }));
}
