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

type GenerateQuizInput = {
  topic: string;
  gradeLevel?: string;
  questionCount?: number;
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

  const prompt = [
    "You generate homeschool quiz drafts as strict JSON.",
    "Return only valid JSON with this shape:",
    '{"title":"string","questions":[{"question":"string","options":["A","B","C","D"],"answerIndex":0,"explanation":"string"}]}',
    `Topic: ${input.topic}`,
    `Grade level: ${input.gradeLevel ?? "mixed"}`,
    `Question count: ${questionCount}`,
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
    max_tokens: 1200,
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
