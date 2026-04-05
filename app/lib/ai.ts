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

/**
 * Fetch the transcript for a YouTube video via Supadata.
 * Returns the full transcript as a single string, or null if unavailable or
 * the API key is not configured.
 */
export async function fetchYoutubeTranscript(videoId: string): Promise<string | null> {
  const apiKey = (env as unknown as Record<string, string | undefined>).SUPADATA_API_KEY;
  if (!apiKey) return null;

  try {
    const url = `https://api.supadata.ai/v1/youtube/transcript?videoId=${encodeURIComponent(videoId)}&text=true`;
    const response = await fetch(url, {
      headers: { "x-api-key": apiKey },
    });

    if (!response.ok) return null;

    const data = (await response.json()) as SupadataResponse;

    if (typeof data.content === "string") {
      return data.content.trim() || null;
    }

    if (Array.isArray(data.content)) {
      return data.content
        .map((s) => s.text)
        .join(" ")
        .trim() || null;
    }

    return null;
  } catch {
    return null;
  }
}

// ── Quiz generation ───────────────────────────────────────────────────────────

const quizItemSchema = z.object({
  question: z.string(),
  options: z.array(z.string()).min(2).max(5),
  answerIndex: z.number().int().min(0).max(4),
  explanation: z.string(),
});

const quizResponseSchema = z.object({
  title: z.string(),
  questions: z.array(quizItemSchema).min(1),
});

export type GenerateQuizInput = {
  topic: string;
  gradeLevel?: string;
  questionCount?: number;
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

export async function generateQuizDraft(input: GenerateQuizInput) {
  const questionCount = input.questionCount ?? 5;

  // Build the content context — transcript is best, description is fallback,
  // topic alone is last resort.
  let contentContext: string;
  if (input.transcript && input.transcript.length > 100) {
    // Truncate transcript to ~4000 chars to stay within token budget
    const truncated = input.transcript.slice(0, 4000);
    contentContext = `Video transcript (use this as the primary source for questions):\n"""\n${truncated}\n"""`;
  } else if (input.videoDescription && input.videoDescription.length > 20) {
    contentContext = `Video description (use as context for questions):\n"""\n${input.videoDescription}\n"""`;
  } else {
    contentContext = `Topic: ${input.topic}`;
  }

  const prompt = [
    "You generate homeschool quiz drafts as strict JSON.",
    "Return only valid JSON with this shape:",
    '{"title":"string","questions":[{"question":"string","options":["A","B","C","D"],"answerIndex":0,"explanation":"string"}]}',
    `Quiz topic/title: ${input.topic}`,
    `Grade level: ${input.gradeLevel ?? "mixed"}`,
    `Question count: ${questionCount}`,
    "",
    contentContext,
    "",
    "Write questions that are directly answerable from the content above.",
    "Do not ask about information not present in the content.",
  ].join("\n");

  const aiResult = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
    messages: [
      {
        role: "system",
        content: "You are a precise quiz generator that outputs strict JSON.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
    max_tokens: 1500,
  });

  const responseText =
    typeof aiResult === "string"
      ? aiResult
      : typeof (aiResult as any).response === "string"
        ? (aiResult as any).response
        : JSON.stringify(aiResult);

  const firstBrace = responseText.indexOf("{");
  const lastBrace = responseText.lastIndexOf("}");

  if (firstBrace < 0 || lastBrace < 0 || lastBrace <= firstBrace) {
    throw new Error("AI_RESPONSE_PARSE_FAILED");
  }

  const jsonText = responseText.slice(firstBrace, lastBrace + 1);
  const parsed = quizResponseSchema.parse(JSON.parse(jsonText));

  return sanitizeQuiz(parsed);
}
