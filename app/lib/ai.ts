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
