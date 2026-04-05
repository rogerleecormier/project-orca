import { useState } from "react";
import { generateQuizDraftForCurriculum } from "../server/functions";

export type QuizQuestion = {
  id: string;
  question: string;
  options: [string, string, string, string];
  answerIndex: number;
  explanation: string;
};

type QuizBuilderProps = {
  questions: QuizQuestion[];
  onChange: (questions: QuizQuestion[]) => void;
  disabled?: boolean;
};

function emptyQuestion(): QuizQuestion {
  return {
    id: crypto.randomUUID(),
    question: "",
    options: ["", "", "", ""],
    answerIndex: 0,
    explanation: "",
  };
}

function QuestionCard({
  question,
  index,
  onUpdate,
  onRemove,
  disabled,
}: {
  question: QuizQuestion;
  index: number;
  onUpdate: (updated: QuizQuestion) => void;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  const update = (patch: Partial<QuizQuestion>) => onUpdate({ ...question, ...patch });

  const setOption = (optIndex: number, value: string) => {
    const next = [...question.options] as [string, string, string, string];
    next[optIndex] = value;
    update({ options: next });
  };

  const handleAiSuggest = async () => {
    if (!question.question.trim()) {
      setGenError("Enter a question first.");
      return;
    }
    setGenerating(true);
    setGenError(null);
    try {
      const result = await generateQuizDraftForCurriculum({
        data: { topic: question.question.trim(), questionCount: 1 },
      });
      const first = result.quiz.questions[0];
      if (!first) throw new Error("No question returned");
      const opts = [...first.options];
      while (opts.length < 4) opts.push("");
      update({
        options: opts.slice(0, 4) as [string, string, string, string],
        answerIndex: Math.min(first.answerIndex, 3),
        explanation: first.explanation,
      });
    } catch {
      setGenError("AI suggestion failed. Try again.");
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-5 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-semibold uppercase tracking-widest text-slate-500">
          Question {index + 1}
        </span>
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          className="text-xs text-rose-600 hover:text-rose-800 disabled:opacity-50"
        >
          Remove
        </button>
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium text-slate-700">Question</label>
        <div className="flex gap-2">
          <input
            value={question.question}
            onChange={(e) => update({ question: e.target.value })}
            disabled={disabled}
            className="flex-1 rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
            placeholder="What is the powerhouse of the cell?"
          />
          <button
            type="button"
            onClick={() => void handleAiSuggest()}
            disabled={disabled || generating}
            title="Let AI fill in options, answer, and explanation based on the question"
            className="shrink-0 rounded-xl border border-violet-300 bg-violet-50 px-3 py-2 text-xs font-medium text-violet-700 hover:bg-violet-100 disabled:opacity-50"
          >
            {generating ? "Generating…" : "AI Suggest"}
          </button>
        </div>
        {genError ? <p className="text-xs text-rose-600">{genError}</p> : null}
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium text-slate-700">
          Answer Options{" "}
          <span className="text-xs font-normal text-slate-500">(select the correct one)</span>
        </label>
        {question.options.map((opt, i) => (
          <div key={i} className="flex items-center gap-3">
            <input
              type="radio"
              name={`correct-${question.id}`}
              checked={question.answerIndex === i}
              onChange={() => update({ answerIndex: i })}
              disabled={disabled}
              className="accent-cyan-600"
            />
            <input
              value={opt}
              onChange={(e) => setOption(i, e.target.value)}
              disabled={disabled}
              className="flex-1 rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
              placeholder={`Option ${String.fromCharCode(65 + i)}`}
            />
          </div>
        ))}
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium text-slate-700">
          Explanation{" "}
          <span className="text-xs font-normal text-slate-500">(shown to student after answering)</span>
        </label>
        <textarea
          value={question.explanation}
          onChange={(e) => update({ explanation: e.target.value })}
          disabled={disabled}
          rows={2}
          className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
          placeholder="Explain why the correct answer is correct..."
        />
      </div>
    </div>
  );
}

export function QuizBuilder({ questions, onChange, disabled }: QuizBuilderProps) {
  const addQuestion = () => onChange([...questions, emptyQuestion()]);

  const updateQuestion = (index: number, updated: QuizQuestion) => {
    const next = [...questions];
    next[index] = updated;
    onChange(next);
  };

  const removeQuestion = (index: number) => {
    onChange(questions.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-4">
      {questions.length === 0 ? (
        <p className="text-sm text-slate-500 italic">
          No questions yet. Add one below or use AI to generate the full quiz.
        </p>
      ) : (
        questions.map((q, i) => (
          <QuestionCard
            key={q.id}
            question={q}
            index={i}
            onUpdate={(updated) => updateQuestion(i, updated)}
            onRemove={() => removeQuestion(i)}
            disabled={disabled}
          />
        ))
      )}

      <button
        type="button"
        onClick={addQuestion}
        disabled={disabled}
        className="w-full rounded-xl border-2 border-dashed border-slate-300 py-3 text-sm font-medium text-slate-500 hover:border-cyan-400 hover:text-cyan-700 disabled:opacity-50"
      >
        + Add Question
      </button>
    </div>
  );
}
