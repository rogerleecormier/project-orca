import { env } from "cloudflare:workers";
import { z } from "zod";

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

  const result = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
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

function collectQuizPayloadCandidates(value: unknown, depth = 0): unknown[] {
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
    return value.flatMap((item) => collectQuizPayloadCandidates(item, depth + 1));
  }

  if (typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  const candidates: unknown[] = [record];

  const maybeJsonFields = [
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

  for (const key of maybeJsonFields) {
    if (key in record) {
      candidates.push(...collectQuizPayloadCandidates(record[key], depth + 1));
    }
  }

  const nestedObjectFields = ["result", "data", "output", "quiz", "choices"];
  for (const key of nestedObjectFields) {
    if (key in record) {
      candidates.push(...collectQuizPayloadCandidates(record[key], depth + 1));
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
  return await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
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
      ...collectQuizPayloadCandidates(aiResult),
      ...collectQuizPayloadCandidates(responseText),
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
};

export type WeekPlanSlot = {
  assignmentId: string;
  scheduledDate: string; // "YYYY-MM-DD"
  orderIndex: number;
};

export async function generateWeekPlanWithAI(input: {
  assignments: PlannerAssignment[];
  gradeLevel: string | null;
  weekStartDate: string; // "YYYY-MM-DD" — Monday
}): Promise<WeekPlanSlot[]> {
  const { assignments, gradeLevel, weekStartDate } = input;

  if (assignments.length === 0) {
    return [];
  }

  // Build weekday ISO dates Mon–Fri
  const monday = new Date(weekStartDate);
  const weekDays = Array.from({ length: 5 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d.toISOString().slice(0, 10);
  });

  const assignmentList = assignments
    .map((a) => `- id=${a.id} | class=${a.classTitle} | type=${a.contentType} | title=${a.title}`)
    .join("\n");

  const prompt = [
    "You are a homeschool week planner. Distribute the following pending assignments across a 5-day school week.",
    "Rules:",
    "- Spread work evenly (2–4 items per day ideally).",
    "- Never put 3+ quizzes or essay_questions on the same day.",
    "- Alternate subjects across consecutive days where possible.",
    "- Return ONLY a JSON array — no prose, no markdown.",
    `- Grade level: ${gradeLevel ?? "unspecified"}`,
    `- Week: ${weekDays[0]} (Mon) through ${weekDays[4]} (Fri)`,
    "",
    "Each element must have: { \"assignmentId\": \"<id>\", \"scheduledDate\": \"YYYY-MM-DD\", \"orderIndex\": <int> }",
    "scheduledDate must be one of: " + weekDays.join(", "),
    "",
    "Assignments to schedule:",
    assignmentList,
    "",
    "Return ONLY the JSON array.",
  ].join("\n");

  const result = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
    messages: [
      {
        role: "system",
        content: "You are a precise scheduling assistant that outputs strict JSON only.",
      },
      { role: "user", content: prompt },
    ],
    max_tokens: 2000,
  });

  const responseText = toModelText(result);
  const parsed = extractJsonPayload(responseText);

  if (!Array.isArray(parsed)) {
    throw new Error("AI_PLANNER_PARSE_FAILED");
  }

  const validDates = new Set(weekDays);
  const validIds = new Set(assignments.map((a) => a.id));
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

export function layoutRadialTree(
  items: Array<{ id: string; parentId: string | null }>,
  options?: { startX?: number; startY?: number; levelHeight?: number; minSpread?: number },
): Map<string, { x: number; y: number }> {
  const startX = options?.startX ?? 500;
  const startY = options?.startY ?? 60;
  const levelHeight = options?.levelHeight ?? 140;
  const minSpread = options?.minSpread ?? 130;

  const positions = new Map<string, { x: number; y: number }>();

  if (items.length === 0) return positions;

  // Build children map
  const childrenMap = new Map<string | null, string[]>();
  for (const item of items) {
    const existing = childrenMap.get(item.parentId) ?? [];
    existing.push(item.id);
    childrenMap.set(item.parentId, existing);
  }

  // Find root (parentId === null)
  const roots = childrenMap.get(null) ?? [];
  if (roots.length === 0) return positions;
  const rootId = roots[0];

  // BFS to assign depth levels
  const depthMap = new Map<string, number>();
  const queue: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }];
  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    depthMap.set(id, depth);
    for (const childId of childrenMap.get(id) ?? []) {
      queue.push({ id: childId, depth: depth + 1 });
    }
  }

  // Group nodes by depth
  const byDepth = new Map<number, string[]>();
  for (const [id, depth] of depthMap) {
    const existing = byDepth.get(depth) ?? [];
    existing.push(id);
    byDepth.set(depth, existing);
  }

  // Position each level
  for (const [depth, nodeIds] of byDepth) {
    if (depth === 0) {
      positions.set(nodeIds[0], { x: startX, y: startY });
      continue;
    }

    const count = nodeIds.length;
    const levelWidth = Math.max(count * minSpread, 300);
    const y = startY + depth * levelHeight;

    for (let i = 0; i < count; i++) {
      const x = startX - levelWidth / 2 + (i / Math.max(count - 1, 1)) * levelWidth;
      positions.set(nodeIds[i], { x: Math.round(x), y });
    }
  }

  return positions;
}

// ── Curriculum AI generation ──────────────────────────────────────────────────

export type CurriculumNodeSuggestion = {
  tempId: string;
  parentTempId: string | null;
  title: string;
  description: string;
  icon: string;
  colorRamp: "blue" | "teal" | "purple" | "amber" | "coral" | "green";
  nodeType: "lesson" | "milestone" | "boss" | "elective";
  xpReward: number;
  suggestedAssignments: Array<{ type: string; title: string }>;
};

const VALID_COLOR_RAMPS = new Set(["blue", "teal", "purple", "amber", "coral", "green"]);
const VALID_NODE_TYPES = new Set(["lesson", "milestone", "boss", "elective"]);

function parseCurriculumNode(item: unknown): CurriculumNodeSuggestion | null {
  if (!item || typeof item !== "object") return null;
  const r = item as Record<string, unknown>;
  if (typeof r.tempId !== "string" || !r.tempId) return null;
  if (typeof r.title !== "string" || !r.title) return null;
  if (r.parentTempId !== null && typeof r.parentTempId !== "string") return null;

  return {
    tempId: r.tempId,
    parentTempId: typeof r.parentTempId === "string" ? r.parentTempId : null,
    title: r.title.trim(),
    description: typeof r.description === "string" ? r.description.trim() : "",
    icon: typeof r.icon === "string" && r.icon ? r.icon : "📚",
    colorRamp: (typeof r.colorRamp === "string" && VALID_COLOR_RAMPS.has(r.colorRamp)
      ? r.colorRamp
      : "blue") as CurriculumNodeSuggestion["colorRamp"],
    nodeType: (typeof r.nodeType === "string" && VALID_NODE_TYPES.has(r.nodeType)
      ? r.nodeType
      : "lesson") as CurriculumNodeSuggestion["nodeType"],
    xpReward: typeof r.xpReward === "number" && r.xpReward > 0
      ? Math.min(400, Math.max(50, Math.round(r.xpReward)))
      : 100,
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

function extractCurriculumArray(raw: unknown): CurriculumNodeSuggestion[] {
  const candidates: unknown[] = [];

  // Direct array
  if (Array.isArray(raw)) {
    candidates.push(...raw);
  } else if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    // Wrapped in a key like "nodes", "tree", "curriculum"
    for (const key of ["nodes", "tree", "curriculum", "items", "data"]) {
      if (Array.isArray(r[key])) {
        candidates.push(...(r[key] as unknown[]));
        break;
      }
    }
  }

  return candidates.map(parseCurriculumNode).filter((n): n is CurriculumNodeSuggestion => n !== null);
}

export async function generateCurriculumTree(input: {
  subject: string;
  gradeLevel: string;
  depth: number;
  seedTopic?: string;
  existingNodeTitles?: string[];
}): Promise<CurriculumNodeSuggestion[]> {
  const targetNodeCount = input.depth >= 5 ? input.depth * 6 : input.depth * 4;

  const lines = [
    `Design a ${input.subject} curriculum skill tree for grade ${input.gradeLevel}.`,
    `Create ${targetNodeCount} nodes in a tree structure (depth ${input.depth} levels deep).`,
  ];
  if (input.seedTopic) lines.push(`Start with: ${input.seedTopic}`);
  if (input.existingNodeTitles?.length) {
    lines.push(`Do not duplicate these existing topics: ${input.existingNodeTitles.join(", ")}`);
  }
  lines.push(
    "",
    "Return ONLY a JSON array of nodes. Each node:",
    JSON.stringify({
      tempId: "node_N (sequential)",
      parentTempId: "node_N or null for root",
      title: "string (short, 2-4 words)",
      description: "string (1-2 sentences)",
      icon: "string (single relevant emoji)",
      colorRamp: "one of: blue|teal|purple|amber|coral|green",
      nodeType: "milestone for major chapters, boss for end-of-unit assessments, lesson for regular, elective for optional branches",
      xpReward: "integer 50-400 (higher for harder nodes)",
      suggestedAssignments: "array of 2-4 objects each with type (text|video|quiz|essay|report) and title",
    }),
    "",
    "Make the tree branch naturally — root has 2-3 children, each can have 1-3 children.",
    `Target approximately ${targetNodeCount} total nodes.`,
    "Return ONLY the JSON array. No markdown, no prose.",
  );

  const prompt = lines.join("\n");

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages: [
        { role: "system", content: "You are a homeschool curriculum designer. Output only valid JSON." },
        { role: "user", content: attempt === 0 ? prompt : `${prompt}\n\nIMPORTANT: Return ONLY the raw JSON array. No markdown fences, no explanations.` },
      ],
      max_tokens: 3000,
    });

    const responseText = toModelText(result);
    const rawCandidates = [
      ...collectQuizPayloadCandidates(result),
      ...collectQuizPayloadCandidates(responseText),
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
    const result = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages: [
        { role: "system", content: "You are a homeschool curriculum designer. Output only valid JSON." },
        { role: "user", content: attempt === 0 ? prompt : `${prompt}\n\nIMPORTANT: Return ONLY the raw JSON array. No markdown fences.` },
      ],
      max_tokens: 2000,
    });

    const responseText = toModelText(result);
    const rawCandidates = [
      ...collectQuizPayloadCandidates(result),
      ...collectQuizPayloadCandidates(responseText),
      extractJsonPayload(responseText),
    ].filter((v): v is NonNullable<typeof v> => v !== null);

    for (const candidate of dedupeCandidates(rawCandidates)) {
      const nodes = extractCurriculumArray(candidate);
      if (nodes.length >= 1) return nodes;
    }
  }

  throw new Error("AI_CURRICULUM_PARSE_FAILED");
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
    const result = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
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
