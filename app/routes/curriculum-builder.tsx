import { useState } from "react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import {
  getViewerContext,
  wizardCommitCurriculum,
  wizardGenerateAssignments,
  wizardGenerateBranchCluster,
  wizardGenerateChapterCluster,
  wizardGenerateSpine,
  wizardGetIntakeData,
  wizardLayoutNodes,
} from "../server/functions";

export const Route = createFileRoute("/curriculum-builder")({
  loader: async () => {
    const viewer = await getViewerContext();
    if (!viewer.isAuthenticated) throw redirect({ to: "/login" });
    if (viewer.activeRole === "student") throw redirect({ to: "/student" });
    const intake = await wizardGetIntakeData();
    return { profiles: intake.profiles };
  },
  component: CurriculumBuilderPage,
});

// ── Types ─────────────────────────────────────────────────────────────────────

type ProfileOption = { id: string; displayName: string; gradeLevel: string };

type IntakeData = {
  profileId: string;
  subject: string;
  gradeLevel: string;
  courseLength: string;
  interests: string;
};

type SpineNode = {
  tempId: string;
  title: string;
  description: string;
  icon: string;
  colorRamp: string;
  nodeType: string;
  cluster: string;
  depth: number;
  isRequired?: boolean;
  xpReward: number;
  prerequisites: string[];
  suggestedAssignments: Array<{ type: string; title: string }>;
};

type WebNode = SpineNode & { x: number; y: number };
type WebEdge = { source: string; target: string };

type WizardStep = 1 | 2 | 3 | 4 | 5;

type AssignmentPrefs = {
  // Lesson/elective nodes
  readingPerNode: boolean;
  videosPerLesson: number;
  // Chapter (milestone) nodes
  chapterIntroVideo: boolean;
  quizzesPerChapter: number;
  essaysPerChapter: number;
  // Boss (capstone) nodes
  quizzesPerBoss: number;
  essaysPerBoss: number;
  papersPerBoss: number;
  includeProjects: boolean;
  // Movie assignments
  includeMovies: boolean;
  otherInstructions: string;
};

type GeneratedAssignment = {
  nodeId: string;
  contentType: "text" | "video" | "quiz" | "essay_questions" | "report";
  title: string;
  description: string;
  contentRef: string;
};

// ── Color constants ───────────────────────────────────────────────────────────

const NODE_COLORS: Record<string, { fill: string; glow: string; text: string }> = {
  blue:   { fill: "#0ea5e9", glow: "#0ea5e966", text: "#e0f2fe" },
  teal:   { fill: "#14b8a6", glow: "#14b8a666", text: "#ccfbf1" },
  purple: { fill: "#a855f7", glow: "#a855f766", text: "#f3e8ff" },
  amber:  { fill: "#f59e0b", glow: "#f59e0b66", text: "#fef3c7" },
  coral:  { fill: "#f97316", glow: "#f9731666", text: "#fff7ed" },
  green:  { fill: "#22c55e", glow: "#22c55e66", text: "#dcfce7" },
};

const NODE_RADIUS: Record<string, number> = {
  boss: 40,
  milestone: 30,
  lesson: 20,
  branch: 20,
  elective: 14,
};

// ── Utility ───────────────────────────────────────────────────────────────────

function currentSchoolYear() {
  const now = new Date();
  const start = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  return `${start}-${start + 1}`;
}

// ── Step indicator ────────────────────────────────────────────────────────────

const STEP_LABELS = ["Intake", "Assignments", "Spine", "Build", "Confirm"];

function StepIndicator({ step }: { step: WizardStep }) {
  return (
    <div className="flex items-center gap-0 mb-8">
      {STEP_LABELS.map((label, i) => {
        const num = (i + 1) as WizardStep;
        const done = step > num;
        const active = step === num;
        return (
          <div key={label} className="flex items-center">
            <div className="flex flex-col items-center">
              <div
                className={[
                  "w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold transition-all",
                  done
                    ? "bg-cyan-500 text-white"
                    : active
                      ? "bg-slate-900 text-white ring-2 ring-cyan-400 ring-offset-2"
                      : "bg-slate-100 text-slate-400",
                ].join(" ")}
              >
                {done ? "✓" : num}
              </div>
              <span
                className={[
                  "mt-1 text-xs font-medium",
                  active ? "text-slate-900" : "text-slate-400",
                ].join(" ")}
              >
                {label}
              </span>
            </div>
            {i < STEP_LABELS.length - 1 && (
              <div
                className={[
                  "w-16 h-0.5 mx-1 mb-4 rounded transition-all",
                  done ? "bg-cyan-500" : "bg-slate-200",
                ].join(" ")}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Step 1: Intake ────────────────────────────────────────────────────────────

const COURSE_LENGTHS = [
  "6 Weeks",
  "9 Weeks",
  "12 Weeks",
  "1 Semester",
  "1 Year",
];

const COURSE_LENGTH_HINTS: Record<string, string> = {
  "6 Weeks":    "~2 chapters · ~4 lessons per chapter · ~30 total nodes — focused unit or short elective.",
  "9 Weeks":    "~3 chapters · ~4 lessons per chapter · ~45 total nodes — quarter course.",
  "12 Weeks":   "~4 chapters · ~5 lessons per chapter · ~65 total nodes — trimester or short semester.",
  "1 Semester": "~6 chapters · ~5 lessons per chapter · ~100 total nodes — full half-year course.",
  "1 Year":     "~10 chapters · ~6 lessons per chapter · ~170 total nodes — complete full-year curriculum.",
};

function StepIntake({
  profiles,
  onNext,
  error,
}: {
  profiles: ProfileOption[];
  onNext: (data: IntakeData) => void;
  error?: string | null;
}) {
  const [profileId, setProfileId] = useState(profiles[0]?.id ?? "");
  const [subject, setSubject] = useState("");
  const [gradeLevel, setGradeLevel] = useState(profiles[0]?.gradeLevel ?? "");
  const [courseLength, setCourseLength] = useState(COURSE_LENGTHS[0]);
  const [interests, setInterests] = useState("");

  // Auto-fill grade when profile changes
  function handleProfileChange(id: string) {
    setProfileId(id);
    const p = profiles.find((p) => p.id === id);
    if (p?.gradeLevel) setGradeLevel(p.gradeLevel);
  }

  const valid = profileId && subject.trim() && gradeLevel.trim();

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-bold text-slate-900">Design a new curriculum</h2>
        <p className="mt-1 text-slate-500">
          Tell us the basics. We'll generate a full gameified skill web from scratch.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {/* Student */}
        <div className="sm:col-span-2">
          <label className="block text-xs font-semibold text-slate-700 mb-1">
            Student <span className="text-rose-500">*</span>
          </label>
          {profiles.length === 0 ? (
            <p className="text-sm text-slate-500 italic">
              No student profiles found. Create a profile first.
            </p>
          ) : (
            <select
              value={profileId}
              onChange={(e) => handleProfileChange(e.target.value)}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none"
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                  {p.gradeLevel ? ` — Grade ${p.gradeLevel}` : ""}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Subject */}
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">
            Subject <span className="text-rose-500">*</span>
          </label>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="e.g. World History, Algebra, Biology"
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none"
          />
        </div>

        {/* Grade Level */}
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">
            Grade Level <span className="text-rose-500">*</span>
          </label>
          <input
            type="text"
            value={gradeLevel}
            onChange={(e) => setGradeLevel(e.target.value)}
            placeholder="e.g. 6, 9–10, K"
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none"
          />
        </div>

        {/* Course Length */}
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">
            Course Length
          </label>
          <div className="flex flex-wrap gap-2">
            {COURSE_LENGTHS.map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => setCourseLength(opt)}
                className={[
                  "rounded-full px-3 py-1 text-sm font-medium border transition",
                  courseLength === opt
                    ? "bg-slate-900 text-white border-slate-900"
                    : "bg-white text-slate-600 border-slate-300 hover:border-slate-400",
                ].join(" ")}
              >
                {opt}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-400">
            {COURSE_LENGTH_HINTS[courseLength] ?? ""}
          </p>
        </div>

        {/* Interests */}
        <div className="sm:col-span-2">
          <label className="block text-xs font-semibold text-slate-700 mb-1">
            Student Interests &amp; Focus Areas
            <span className="ml-1 font-normal text-slate-400">(optional)</span>
          </label>
          <textarea
            value={interests}
            onChange={(e) => setInterests(e.target.value)}
            rows={3}
            placeholder="e.g. Loves space exploration, prefers hands-on projects, keen on ancient civilizations…"
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none resize-none"
          />
          <p className="mt-1 text-xs text-slate-400">
            The AI uses this to personalise which specialisation branches to generate.
          </p>
        </div>
      </div>

      {error ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      ) : null}

      <div className="flex justify-end pt-2">
        <button
          type="button"
          disabled={!valid}
          onClick={() =>
            onNext({ profileId, subject: subject.trim(), gradeLevel: gradeLevel.trim(), courseLength, interests })
          }
          className="rounded-xl bg-slate-900 px-6 py-2.5 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition"
        >
          Next: Assignments →
        </button>
      </div>
    </div>
  );
}

// ── Step 2: Assignment Preferences ───────────────────────────────────────────

function Counter({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => onChange(Math.max(min, value - 1))}
        disabled={value <= min}
        className="w-8 h-8 rounded-full border border-slate-300 text-slate-700 font-bold text-sm flex items-center justify-center hover:bg-slate-100 disabled:opacity-30 transition"
      >−</button>
      <span className="w-6 text-center text-sm font-semibold text-slate-800 tabular-nums">{value}</span>
      <button
        type="button"
        onClick={() => onChange(Math.min(max, value + 1))}
        disabled={value >= max}
        className="w-8 h-8 rounded-full border border-slate-300 text-slate-700 font-bold text-sm flex items-center justify-center hover:bg-slate-100 disabled:opacity-30 transition"
      >+</button>
    </div>
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={[
        "relative inline-flex h-6 w-11 items-center rounded-full transition-colors",
        value ? "bg-cyan-500" : "bg-slate-200",
      ].join(" ")}
    >
      <span
        className={[
          "inline-block h-4 w-4 rounded-full bg-white shadow transition-transform",
          value ? "translate-x-6" : "translate-x-1",
        ].join(" ")}
      />
    </button>
  );
}

const DEFAULT_PREFS: AssignmentPrefs = {
  readingPerNode: true,
  videosPerLesson: 2,       // explain + demonstrate is standard instructional design
  chapterIntroVideo: true,
  quizzesPerChapter: 1,
  essaysPerChapter: 1,      // chapter reflection is best practice (Charlotte Mason, classical)
  quizzesPerBoss: 3,        // one quiz per major concept cluster in the unit
  essaysPerBoss: 1,
  papersPerBoss: 0,
  includeProjects: false,
  includeMovies: false,
  otherInstructions: "",
};

function StepAssignments({
  intake,
  onBack,
  onNext,
}: {
  intake: IntakeData;
  onBack: () => void;
  onNext: (prefs: AssignmentPrefs) => void;
}) {
  const [prefs, setPrefs] = useState<AssignmentPrefs>(DEFAULT_PREFS);

  function set<K extends keyof AssignmentPrefs>(key: K, value: AssignmentPrefs[K]) {
    setPrefs((p) => ({ ...p, [key]: value }));
  }

  const anyContent = prefs.readingPerNode || prefs.videosPerLesson > 0 || prefs.chapterIntroVideo ||
    prefs.quizzesPerChapter > 0 || prefs.essaysPerChapter > 0 ||
    prefs.quizzesPerBoss > 0 || prefs.essaysPerBoss > 0 || prefs.papersPerBoss > 0 ||
    prefs.includeProjects || prefs.includeMovies;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-900">Assignment preferences</h2>
        <p className="mt-1 text-slate-500">
          Each node type gets a different mix of assignments.{" "}
          <span className="font-medium text-slate-700">Chapter nodes</span> are overviews that branch into lessons.{" "}
          <span className="font-medium text-slate-700">Lessons</span> are focused topics with targeted content.{" "}
          <span className="font-medium text-slate-700">Boss nodes</span> are full-unit capstones.
        </p>
      </div>

      {/* Lesson & elective nodes */}
      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5 space-y-4">
        <h3 className="text-sm font-semibold text-slate-700 uppercase tracking-wide flex items-center gap-2">
          <span className="inline-block w-3 h-3 rounded-full bg-blue-400" />
          Lesson &amp; Elective Nodes
        </h3>
        <p className="text-xs text-slate-500 -mt-2">
          Every lesson always includes a formative check quiz and a short practice response — these are non-negotiable for mastery-based learning.
        </p>

        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-slate-800">Reading passage</p>
            <p className="text-xs text-slate-500">Instructional reading (400–600 words) with hook, explanation, and takeaways</p>
          </div>
          <Toggle value={prefs.readingPerNode} onChange={(v) => set("readingPerNode", v)} />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-slate-800">Videos per lesson</p>
            <p className="text-xs text-slate-500">2 recommended — one to explain, one to demonstrate or extend</p>
          </div>
          <Counter value={prefs.videosPerLesson} min={0} max={3} onChange={(v) => set("videosPerLesson", v)} />
        </div>
      </div>

      {/* Chapter (milestone) nodes */}
      <div className="rounded-2xl border border-teal-100 bg-teal-50 p-5 space-y-4">
        <h3 className="text-sm font-semibold text-teal-700 uppercase tracking-wide flex items-center gap-2">
          <span className="inline-block w-3 h-3 rounded-full bg-teal-500" />
          Chapter Nodes (Milestones)
        </h3>
        <p className="text-xs text-teal-600 -mt-2">
          Chapter openers always include an overview reading and a diagnostic pre-assessment to activate prior knowledge.
        </p>

        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-slate-800">Intro videos</p>
            <p className="text-xs text-slate-500">2 videos — broad overview + first concept introduction</p>
          </div>
          <Toggle value={prefs.chapterIntroVideo} onChange={(v) => set("chapterIntroVideo", v)} />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-slate-800">Chapter checkpoint quizzes</p>
            <p className="text-xs text-slate-500">Summative quizzes covering the chapter's core concepts (5 questions each)</p>
          </div>
          <Counter value={prefs.quizzesPerChapter} min={0} max={3} onChange={(v) => set("quizzesPerChapter", v)} />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-slate-800">Chapter reflections</p>
            <p className="text-xs text-slate-500">Open-ended prompts connecting the chapter theme to the student's life or prior learning</p>
          </div>
          <Counter value={prefs.essaysPerChapter} min={0} max={2} onChange={(v) => set("essaysPerChapter", v)} />
        </div>
      </div>

      {/* Boss / capstone nodes */}
      <div className="rounded-2xl border border-amber-100 bg-amber-50 p-5 space-y-4">
        <h3 className="text-sm font-semibold text-amber-700 uppercase tracking-wide flex items-center gap-2">
          <span className="inline-block w-3 h-3 rounded-full bg-amber-500" />
          Boss Nodes (Capstones)
        </h3>
        <p className="text-xs text-amber-700 -mt-2">
          Capstones always include a comprehensive unit review (600–900 words) and at least one essay — writing is essential for long-term retention.
        </p>

        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-slate-800">Summative quizzes</p>
            <p className="text-xs text-slate-500">One per major concept cluster — 3 recommended for full unit coverage</p>
          </div>
          <Counter value={prefs.quizzesPerBoss} min={0} max={5} onChange={(v) => set("quizzesPerBoss", v)} />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-slate-800">Analytical essays</p>
            <p className="text-xs text-slate-500">Synthesis prompts requiring argument or evidence — at least 1 is always generated</p>
          </div>
          <Counter value={prefs.essaysPerBoss} min={0} max={3} onChange={(v) => set("essaysPerBoss", v)} />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-slate-800">Research papers</p>
            <p className="text-xs text-slate-500">In-depth research report prompts</p>
          </div>
          <Counter value={prefs.papersPerBoss} min={0} max={2} onChange={(v) => set("papersPerBoss", v)} />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-slate-800">Capstone project</p>
            <p className="text-xs text-slate-500">Hands-on project with materials and steps</p>
          </div>
          <Toggle value={prefs.includeProjects} onChange={(v) => set("includeProjects", v)} />
        </div>
      </div>

      {/* Movie assignments */}
      <div className="rounded-2xl border border-purple-100 bg-purple-50 p-5 space-y-3">
        <h3 className="text-sm font-semibold text-purple-700 uppercase tracking-wide flex items-center gap-2">
          <span className="inline-block w-3 h-3 rounded-full bg-purple-500" />
          Movie Assignments
        </h3>

        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-slate-800">Include movie assignments</p>
            <p className="text-xs text-slate-500">
              Watching a film can be an assignment. Each movie is automatically paired with a
              follow-up quiz, essay, or discussion to complete afterward.
            </p>
          </div>
          <Toggle value={prefs.includeMovies} onChange={(v) => set("includeMovies", v)} />
        </div>
        {prefs.includeMovies && (
          <p className="text-xs text-purple-600 bg-purple-100 rounded-lg px-3 py-2">
            Movie assignments appear on chapter and elective nodes where a film fits the topic.
            A linked follow-up assignment (quiz or essay) is automatically attached.
          </p>
        )}
      </div>

      {/* Freeform */}
      <div>
        <label className="block text-xs font-semibold text-slate-700 mb-1">
          Additional instructions <span className="font-normal text-slate-400">(optional)</span>
        </label>
        <textarea
          value={prefs.otherInstructions}
          onChange={(e) => set("otherInstructions", e.target.value)}
          rows={2}
          placeholder="e.g. Add a map labelling activity for each geography chapter, include primary source documents…"
          className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none resize-none"
        />
      </div>

      {/* Summary preview */}
      <div className="rounded-xl border border-cyan-100 bg-cyan-50 px-4 py-3 text-xs text-cyan-800 space-y-0.5">
        <p className="font-semibold mb-1">What gets generated:</p>

        <p className="text-cyan-700 font-medium">Every lesson node (always):</p>
        <p>• Formative check quiz (5 questions, mastery check)</p>
        <p>• Short practice response (apply the concept in writing)</p>
        {prefs.readingPerNode && <p>• Reading passage (400–600 words)</p>}
        {prefs.videosPerLesson > 0 && <p>• {prefs.videosPerLesson} video{prefs.videosPerLesson > 1 ? "s" : ""} (explain + demonstrate)</p>}

        <p className="text-cyan-700 font-medium mt-1">Every elective node (always):</p>
        <p>• Analysis quiz + hands-on project</p>
        {prefs.readingPerNode && <p>• Deep-dive reading (500–750 words)</p>}
        {prefs.videosPerLesson > 0 && <p>• {Math.min(prefs.videosPerLesson + 1, 3)} video{prefs.videosPerLesson + 1 > 1 ? "s" : ""}</p>}
        {prefs.includeMovies && <p>• Movie assignment + follow-up</p>}

        <p className="text-cyan-700 font-medium mt-1">Every chapter node (always):</p>
        <p>• Chapter overview reading (250–350 words)</p>
        <p>• Diagnostic pre-assessment (activates prior knowledge)</p>
        {prefs.chapterIntroVideo && <p>• 2 intro videos (overview + concept intro)</p>}
        {prefs.quizzesPerChapter > 0 && <p>• {prefs.quizzesPerChapter} chapter checkpoint quiz{prefs.quizzesPerChapter > 1 ? "zes" : ""}</p>}
        {prefs.essaysPerChapter > 0 && <p>• {prefs.essaysPerChapter} chapter reflection{prefs.essaysPerChapter > 1 ? "s" : ""}</p>}
        {prefs.includeMovies && <p>• Movie assignment + follow-up</p>}

        <p className="text-cyan-700 font-medium mt-1">Every boss node (always):</p>
        <p>• Comprehensive unit review (600–900 words)</p>
        <p>• At least 1 analytical essay (synthesis required)</p>
        {prefs.quizzesPerBoss > 0 && <p>• {prefs.quizzesPerBoss} summative quiz{prefs.quizzesPerBoss > 1 ? "zes" : ""} (one per concept cluster)</p>}
        {prefs.papersPerBoss > 0 && <p>• {prefs.papersPerBoss} research paper{prefs.papersPerBoss > 1 ? "s" : ""}</p>}
        {prefs.includeProjects && <p>• Performance task / capstone project</p>}

        {!anyContent && (
          <p className="text-slate-500 italic">No assignments selected — nodes will be created without content.</p>
        )}
      </div>

      <div className="flex items-center justify-between pt-2">
        <button
          type="button"
          onClick={onBack}
          className="rounded-xl border border-slate-300 px-5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition"
        >
          ← Back
        </button>
        <button
          type="button"
          onClick={() => onNext(prefs)}
          className="rounded-xl bg-slate-900 px-6 py-2.5 text-sm font-semibold text-white hover:bg-slate-700 transition"
        >
          Generate Spine →
        </button>
      </div>
    </div>
  );
}

// ── Step 3: Spine Editor ──────────────────────────────────────────────────────

function SpineNodeRow({
  node,
  onChange,
}: {
  node: SpineNode;
  onChange: (title: string) => void;
}) {
  const color = NODE_COLORS[node.colorRamp] ?? NODE_COLORS.teal;
  const isBoss = node.nodeType === "boss";

  return (
    <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
      {/* Depth indent */}
      <div style={{ width: node.depth * 16 }} className="shrink-0" />

      {/* Node badge */}
      <div
        className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-lg font-semibold"
        style={{ backgroundColor: color.fill + "22", border: `2px solid ${color.fill}` }}
      >
        {node.icon}
      </div>

      {/* Title input */}
      <input
        type="text"
        value={node.title}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 rounded-lg border border-transparent bg-slate-50 px-2.5 py-1.5 text-sm text-slate-800 focus:border-cyan-400 focus:bg-white focus:outline-none"
      />

      {/* Type badge */}
      <span
        className={[
          "shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide",
          isBoss
            ? "bg-amber-100 text-amber-800"
            : "bg-slate-100 text-slate-600",
        ].join(" ")}
      >
        {node.nodeType}
      </span>

      {/* XP */}
      <span className="shrink-0 text-xs text-slate-400 tabular-nums">
        +{node.xpReward} XP
      </span>
    </div>
  );
}

function StepSpine({
  intake,
  spineNodes,
  onSpineChange,
  onBack,
  onNext,
  loading,
  error,
}: {
  intake: IntakeData;
  spineNodes: SpineNode[];
  onSpineChange: (nodes: SpineNode[]) => void;
  onBack: () => void;
  onNext: () => void;
  loading: boolean;
  error: string | null;
}) {
  function updateTitle(tempId: string, title: string) {
    onSpineChange(spineNodes.map((n) => (n.tempId === tempId ? { ...n, title } : n)));
  }

  const totalXp = spineNodes.reduce((s, n) => s + n.xpReward, 0);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-bold text-slate-900">Review the curriculum spine</h2>
        <p className="mt-1 text-slate-500">
          These are the major chapters and assessments. Edit any title before the AI builds
          lessons and enrichment branches around them.
        </p>
      </div>

      {/* Metadata strip */}
      <div className="flex flex-wrap gap-2 text-xs">
        <span className="rounded-full bg-cyan-50 border border-cyan-200 px-3 py-1 text-cyan-800 font-medium">
          {intake.subject}
        </span>
        <span className="rounded-full bg-slate-100 border border-slate-200 px-3 py-1 text-slate-700 font-medium">
          Grade {intake.gradeLevel}
        </span>
        <span className="rounded-full bg-slate-100 border border-slate-200 px-3 py-1 text-slate-700 font-medium">
          {intake.courseLength}
        </span>
        <span className="rounded-full bg-amber-50 border border-amber-200 px-3 py-1 text-amber-800 font-medium">
          {totalXp.toLocaleString()} spine XP
        </span>
      </div>

      {/* Node list */}
      <div className="space-y-2 max-h-[50vh] overflow-y-auto pr-1">
        {spineNodes.map((n) => (
          <SpineNodeRow
            key={n.tempId}
            node={n}
            onChange={(title) => updateTitle(n.tempId, title)}
          />
        ))}
      </div>

      {error && (
        <p className="rounded-xl bg-rose-50 border border-rose-200 px-4 py-2.5 text-sm text-rose-700">
          {error}
        </p>
      )}

      <div className="flex items-center justify-between pt-2">
        <button
          type="button"
          onClick={onBack}
          disabled={loading}
          className="rounded-xl border border-slate-300 px-5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 transition"
        >
          ← Back
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={loading || spineNodes.length === 0}
          className="rounded-xl bg-slate-900 px-6 py-2.5 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition flex items-center gap-2"
        >
          {loading ? (
            <>
              <span className="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full" />
              Loading…
            </>
          ) : (
            "Build Curriculum →"
          )}
        </button>
      </div>
    </div>
  );
}

// ── Step 3: Staged Build ──────────────────────────────────────────────────────

type BuildStage = "idle" | "lessons" | "branches" | "assignments" | "layout" | "done";

type ClusterProgress = {
  milestoneId: string;
  milestoneTitle: string;
  status: "pending" | "running" | "done" | "skipped";
  nodeCount: number;
};

// Flat node list accumulated across stages (no positions yet)
type RawNode = Omit<SpineNode, "isRequired"> & { isRequired: boolean };

function WebPreview({
  nodes,
  edges,
}: {
  nodes: WebNode[];
  edges: WebEdge[];
}) {
  const nodeMap = new Map(nodes.map((n) => [n.tempId, n]));

  return (
    <div className="w-full overflow-auto rounded-xl border border-slate-800 bg-slate-950">
      <svg
        viewBox="0 0 1200 900"
        className="w-full"
        style={{ minWidth: 760, maxHeight: "55vh", display: "block" }}
        aria-label="Curriculum skill web preview"
      >
        {edges.map(({ source, target }, i) => {
          const src = nodeMap.get(source);
          const tgt = nodeMap.get(target);
          if (!src || !tgt) return null;
          const isSpec = tgt.cluster === "specialization";
          const isDashed = tgt.nodeType === "elective";
          return (
            <line
              key={i}
              x1={src.x} y1={src.y} x2={tgt.x} y2={tgt.y}
              stroke={isSpec ? "#818cf8" : "#475569"}
              strokeWidth={isSpec ? 1.5 : 1}
              strokeOpacity={0.45}
              strokeDasharray={isDashed ? "5 3" : undefined}
            />
          );
        })}
        {nodes.map((node) => {
          const r = NODE_RADIUS[node.nodeType] ?? 18;
          const color = NODE_COLORS[node.colorRamp] ?? NODE_COLORS.blue;
          const isBoss = node.nodeType === "boss";
          const isMilestone = node.nodeType === "milestone";
          const isSpec = node.cluster === "specialization";
          const shortTitle = node.title.length > 18 ? node.title.slice(0, 17) + "…" : node.title;
          return (
            <g key={node.tempId} transform={`translate(${node.x},${node.y})`}>
              {isBoss && <circle r={r + 8} fill={color.glow} />}
              {isMilestone && <circle r={r + 4} fill="none" stroke={color.fill} strokeWidth={1} strokeOpacity={0.35} />}
              <circle
                r={r}
                fill={color.fill}
                fillOpacity={isSpec ? 0.82 : 1}
                stroke={isBoss ? "#fbbf24" : isMilestone ? "#fff" : "none"}
                strokeWidth={isBoss ? 2.5 : 1}
              />
              <text textAnchor="middle" dominantBaseline="central" fontSize={r * 0.9}>{node.icon}</text>
              <text y={r + 10} textAnchor="middle" fill="#cbd5e1" fontSize="8.5">{shortTitle}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function StepBuild({
  intake,
  prefs,
  spineNodes,
  onBack,
  onDone,
}: {
  intake: IntakeData;
  prefs: AssignmentPrefs;
  spineNodes: SpineNode[];
  onBack: () => void;
  onDone: (webData: { nodes: WebNode[]; edges: WebEdge[] }, generatedAssignments: GeneratedAssignment[]) => void;
}) {
  const [stage, setStage] = useState<BuildStage>("idle");
  const [chapterProgress, setChapterProgress] = useState<ClusterProgress[]>([]);
  const [branchProgress, setBranchProgress] = useState<ClusterProgress[]>([]);
  const [assignmentProgress, setAssignmentProgress] = useState<ClusterProgress[]>([]);
  const [rawNodes, setRawNodes] = useState<RawNode[]>([]);
  const [webData, setWebData] = useState<{ nodes: WebNode[]; edges: WebEdge[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const milestones = spineNodes.filter((n) => n.nodeType !== "boss");

  async function runStage2() {
    setStage("lessons");
    setError(null);

    const initialProgress: ClusterProgress[] = milestones.map((m) => ({
      milestoneId: m.tempId,
      milestoneTitle: m.title,
      status: "pending",
      nodeCount: 0,
    }));
    setChapterProgress(initialProgress);

    const accumulated: RawNode[] = spineNodes.map((n) => ({
      ...n,
      isRequired: n.isRequired ?? true,
    }));
    const existingTitles = accumulated.map((n) => n.title);

    for (let i = 0; i < milestones.length; i++) {
      const milestone = milestones[i];
      setChapterProgress((prev) =>
        prev.map((p, idx) => idx === i ? { ...p, status: "running" } : p),
      );

      try {
        const result = await wizardGenerateChapterCluster({
          data: {
            subject: intake.subject,
            gradeLevel: intake.gradeLevel,
            milestoneId: milestone.tempId,
            milestoneTitle: milestone.title,
            milestoneDescription: milestone.description,
            milestoneDepth: milestone.depth,
            existingTitles: [...existingTitles],
          },
        });

        const newNodes: RawNode[] = (result.nodes as SpineNode[]).map((n) => ({
          ...n,
          isRequired: true,
        }));
        accumulated.push(...newNodes);
        existingTitles.push(...newNodes.map((n) => n.title));

        setChapterProgress((prev) =>
          prev.map((p, idx) =>
            idx === i ? { ...p, status: "done", nodeCount: newNodes.length } : p,
          ),
        );
      } catch {
        setChapterProgress((prev) =>
          prev.map((p, idx) => idx === i ? { ...p, status: "skipped" } : p),
        );
      }
    }

    setRawNodes([...accumulated]);
    return accumulated;
  }

  async function runStage3(accumulated: RawNode[]) {
    setStage("branches");

    // Pick the last lesson in each chapter cluster as the branch point
    const lessonNodes = accumulated.filter(
      (n) => n.nodeType === "lesson" && n.cluster === "core",
    );

    // Group by milestone: pick the deepest lesson per milestone cluster
    const branchPoints: RawNode[] = [];
    for (const milestone of milestones) {
      const clusterPrefix = `ch_${milestone.tempId}`;
      const clusterLessons = lessonNodes.filter((n) => n.tempId.startsWith(clusterPrefix));
      if (clusterLessons.length > 0) {
        // Last in chain = highest suffix index
        const last = clusterLessons.sort((a, b) => a.tempId.localeCompare(b.tempId)).at(-1)!;
        branchPoints.push(last);
      }
    }

    const initialBranchProgress: ClusterProgress[] = branchPoints.map((bp) => ({
      milestoneId: bp.tempId,
      milestoneTitle: bp.title,
      status: "pending",
      nodeCount: 0,
    }));
    setBranchProgress(initialBranchProgress);

    const existingTitles = accumulated.map((n) => n.title);

    for (let i = 0; i < branchPoints.length; i++) {
      const lesson = branchPoints[i];
      const parentMilestone = milestones.find((m) =>
        lesson.tempId.startsWith(`ch_${m.tempId}`),
      );

      setBranchProgress((prev) =>
        prev.map((p, idx) => idx === i ? { ...p, status: "running" } : p),
      );

      try {
        const result = await wizardGenerateBranchCluster({
          data: {
            subject: intake.subject,
            gradeLevel: intake.gradeLevel,
            lessonId: lesson.tempId,
            lessonTitle: lesson.title,
            lessonDescription: lesson.description,
            lessonDepth: lesson.depth,
            milestoneTitle: parentMilestone?.title ?? lesson.title,
            existingTitles: [...existingTitles],
          },
        });

        const newNodes: RawNode[] = (result.nodes as SpineNode[]).map((n) => ({
          ...n,
          isRequired: false,
        }));
        accumulated.push(...newNodes);
        existingTitles.push(...newNodes.map((n) => n.title));

        setBranchProgress((prev) =>
          prev.map((p, idx) =>
            idx === i ? { ...p, status: "done", nodeCount: newNodes.length } : p,
          ),
        );
      } catch {
        setBranchProgress((prev) =>
          prev.map((p, idx) => idx === i ? { ...p, status: "skipped" } : p),
        );
      }
    }

    setRawNodes([...accumulated]);
    return accumulated;
  }

  async function runLayout(accumulated: RawNode[]) {
    setStage("layout");
    const result = await wizardLayoutNodes({
      data: {
        nodes: accumulated.map((n) => ({
          tempId: n.tempId,
          prerequisites: n.prerequisites,
          depth: n.depth,
          cluster: n.cluster,
          nodeType: n.nodeType,
        })),
      },
    });

    const positioned: WebNode[] = accumulated.map((n) => {
      const pos = result.positions[n.tempId] ?? { x: 600, y: 450 };
      return { ...n, x: pos.x, y: pos.y };
    });

    const data = { nodes: positioned, edges: result.edges };
    setWebData(data);
    setStage("done");
    return data;
  }

  async function runStage4(accumulated: RawNode[]): Promise<GeneratedAssignment[]> {
    setStage("assignments");

    // One call per node — small focused prompt, no token overflow
    const initialProgress: ClusterProgress[] = accumulated.map((n) => ({
      milestoneId: n.tempId,
      milestoneTitle: n.title,
      status: "pending",
      nodeCount: 0,
    }));
    setAssignmentProgress(initialProgress);

    const allAssignments: GeneratedAssignment[] = [];

    for (let i = 0; i < accumulated.length; i++) {
      const node = accumulated[i];
      setAssignmentProgress((prev) =>
        prev.map((p, idx) => idx === i ? { ...p, status: "running" } : p),
      );
      try {
        const result = await wizardGenerateAssignments({
          data: {
            subject: intake.subject,
            gradeLevel: intake.gradeLevel,
            prefs,
            node: {
              tempId: node.tempId,
              title: node.title,
              description: node.description,
              nodeType: node.nodeType,
            },
          },
        });
        const newAssignments = result.assignments as GeneratedAssignment[];
        allAssignments.push(...newAssignments);
        setAssignmentProgress((prev) =>
          prev.map((p, idx) =>
            idx === i ? { ...p, status: "done", nodeCount: newAssignments.length } : p,
          ),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setAssignmentProgress((prev) =>
          prev.map((p, idx) =>
            idx === i ? { ...p, status: "skipped", milestoneTitle: `${prev[idx]?.milestoneTitle ?? ""} ✗ ${msg.slice(0, 50)}` } : p,
          ),
        );
      }
    }

    return allAssignments;
  }

  async function handleBuildLessons() {
    try {
      const withLessons = await runStage2();
      const withBranches = await runStage3(withLessons);
      const assignments = await runStage4(withBranches);
      const data = await runLayout(withBranches);
      onDone(data, assignments);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Build failed: ${msg}`);
      setStage("idle");
    }
  }

  const isRunning = stage !== "idle" && stage !== "done";
  const totalNodes = rawNodes.length;
  const lessonsDone = chapterProgress.filter((p) => p.status === "done" || p.status === "skipped").length;
  const branchesDone = branchProgress.filter((p) => p.status === "done" || p.status === "skipped").length;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-bold text-slate-900">Build your curriculum</h2>
        <p className="mt-1 text-slate-500">
          The AI builds your skill web in stages — first the chapter lessons for each milestone,
          then optional enrichment branches. Watch it grow in real time.
        </p>
      </div>

      {/* Spine summary */}
      <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
        <p className="text-xs font-semibold text-slate-500 mb-2 uppercase tracking-wide">
          Spine — {milestones.length} milestones to expand
        </p>
        <div className="flex flex-wrap gap-1.5">
          {spineNodes.map((n) => {
            const color = NODE_COLORS[n.colorRamp] ?? NODE_COLORS.teal;
            return (
              <span
                key={n.tempId}
                className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium"
                style={{ backgroundColor: color.fill + "22", color: color.fill, border: `1px solid ${color.fill}55` }}
              >
                {n.icon} {n.title}
              </span>
            );
          })}
        </div>
      </div>

      {/* Stage 2 progress */}
      {chapterProgress.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-slate-600 uppercase tracking-wide flex items-center gap-2">
            Stage 2 — Chapter Lessons
            {stage === "lessons" && (
              <span className="inline-block w-3 h-3 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
            )}
            {lessonsDone === chapterProgress.length && (
              <span className="text-emerald-600">✓ done</span>
            )}
          </p>
          <div className="space-y-1">
            {chapterProgress.map((p) => (
              <div key={p.milestoneId} className="flex items-center gap-2 text-sm">
                <span className="w-4 h-4 flex items-center justify-center shrink-0">
                  {p.status === "done" && <span className="text-emerald-500 text-xs">✓</span>}
                  {p.status === "running" && <span className="inline-block w-3 h-3 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />}
                  {p.status === "skipped" && <span className="text-slate-400 text-xs">—</span>}
                  {p.status === "pending" && <span className="text-slate-300 text-xs">·</span>}
                </span>
                <span className={p.status === "pending" ? "text-slate-400" : "text-slate-700"}>
                  {p.milestoneTitle}
                </span>
                {p.status === "done" && (
                  <span className="text-xs text-slate-400">+{p.nodeCount} lessons</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Stage 3 progress */}
      {branchProgress.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-slate-600 uppercase tracking-wide flex items-center gap-2">
            Stage 3 — Enrichment Branches
            {stage === "branches" && (
              <span className="inline-block w-3 h-3 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
            )}
            {branchesDone === branchProgress.length && (
              <span className="text-emerald-600">✓ done</span>
            )}
          </p>
          <div className="space-y-1">
            {branchProgress.map((p) => (
              <div key={p.milestoneId} className="flex items-center gap-2 text-sm">
                <span className="w-4 h-4 flex items-center justify-center shrink-0">
                  {p.status === "done" && <span className="text-emerald-500 text-xs">✓</span>}
                  {p.status === "running" && <span className="inline-block w-3 h-3 border-2 border-purple-400 border-t-transparent rounded-full animate-spin" />}
                  {p.status === "skipped" && <span className="text-slate-400 text-xs">—</span>}
                  {p.status === "pending" && <span className="text-slate-300 text-xs">·</span>}
                </span>
                <span className={p.status === "pending" ? "text-slate-400" : "text-slate-700"}>
                  {p.milestoneTitle}
                </span>
                {p.status === "done" && (
                  <span className="text-xs text-slate-400">+{p.nodeCount} branches</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Stage 4 progress */}
      {assignmentProgress.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-slate-600 uppercase tracking-wide flex items-center gap-2">
            Stage 4 — Assignments &amp; Content
            {stage === "assignments" && (
              <span className="inline-block w-3 h-3 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
            )}
            {assignmentProgress.every((p) => p.status === "done" || p.status === "skipped") && (
              <span className="text-emerald-600">✓ done</span>
            )}
          </p>
          <div className="space-y-1">
            {assignmentProgress.map((p) => (
              <div key={p.milestoneId} className="flex items-center gap-2 text-sm">
                <span className="w-4 h-4 flex items-center justify-center shrink-0">
                  {p.status === "done" && <span className="text-emerald-500 text-xs">✓</span>}
                  {p.status === "running" && <span className="inline-block w-3 h-3 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />}
                  {p.status === "skipped" && <span className="text-slate-400 text-xs">—</span>}
                  {p.status === "pending" && <span className="text-slate-300 text-xs">·</span>}
                </span>
                <span className={p.status === "pending" ? "text-slate-400" : "text-slate-700"}>
                  {p.milestoneTitle}
                </span>
                {p.status === "done" && (
                  <span className="text-xs text-slate-400">+{p.nodeCount} assignments</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Layout status */}
      {stage === "layout" && (
        <p className="text-sm text-slate-500 flex items-center gap-2">
          <span className="inline-block w-3 h-3 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
          Computing layout for {totalNodes} nodes…
        </p>
      )}

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      <div className="flex items-center justify-between pt-2">
        <button
          type="button"
          onClick={onBack}
          disabled={isRunning}
          className="rounded-xl border border-slate-300 px-5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 transition"
        >
          ← Edit Spine
        </button>
        {stage === "idle" && (
          <button
            type="button"
            onClick={handleBuildLessons}
            className="rounded-xl bg-slate-900 px-6 py-2.5 text-sm font-semibold text-white hover:bg-slate-700 transition"
          >
            Build Curriculum →
          </button>
        )}
        {isRunning && (
          <span className="text-sm text-slate-500 flex items-center gap-2">
            <span className="inline-block w-4 h-4 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
            Generating…
          </span>
        )}
      </div>
    </div>
  );
}

// ── Step 4: Confirm ───────────────────────────────────────────────────────────

function StepConfirm({
  intake,
  webData,
  assignmentCount,
  onBack,
  onCommit,
  loading,
  error,
}: {
  intake: IntakeData;
  webData: { nodes: WebNode[]; edges: WebEdge[] };
  assignmentCount: number;
  onBack: () => void;
  onCommit: (classTitle: string, treeTitle: string, schoolYear: string) => void;
  loading: boolean;
  error: string | null;
}) {
  const defaultTitle = `${intake.subject} — Grade ${intake.gradeLevel}`;
  const [classTitle, setClassTitle] = useState(defaultTitle);
  const [treeTitle, setTreeTitle] = useState(defaultTitle);
  const [schoolYear, setSchoolYear] = useState(currentSchoolYear());

  const { nodes, edges } = webData;
  const totalXp = nodes.reduce((s, n) => s + n.xpReward, 0);
  const bosses = nodes.filter((n) => n.nodeType === "boss").length;
  const milestones = nodes.filter((n) => n.nodeType === "milestone").length;
  const lessons = nodes.filter((n) => n.nodeType === "lesson").length;
  const electives = nodes.filter((n) => n.nodeType === "elective").length;

  const valid = classTitle.trim() && treeTitle.trim();

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-bold text-slate-900">Create everything</h2>
        <p className="mt-1 text-slate-500">
          We'll create the class, enrol the student, and build the full skill tree in your
          database simultaneously.
        </p>
      </div>

      {/* Summary card */}
      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 space-y-3">
        <h3 className="text-sm font-semibold text-slate-700">Curriculum summary</h3>
        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          <SummaryCell label="Total nodes" value={nodes.length} />
          <SummaryCell label="Connections" value={edges.length} />
          <SummaryCell label="Total XP" value={totalXp.toLocaleString()} accent />
          <SummaryCell label="Milestones" value={milestones} />
          <SummaryCell label="Bosses" value={bosses} />
          <SummaryCell label="Lessons" value={lessons} />
          <SummaryCell label="Electives" value={electives} />
          <SummaryCell label="Assignments" value={assignmentCount} />
        </div>
      </div>

      {/* Editable fields */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="block text-xs font-semibold text-slate-700 mb-1">
            Class Name <span className="text-rose-500">*</span>
          </label>
          <input
            type="text"
            value={classTitle}
            onChange={(e) => setClassTitle(e.target.value)}
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none"
          />
        </div>
        <div className="sm:col-span-2">
          <label className="block text-xs font-semibold text-slate-700 mb-1">
            Skill Tree Title <span className="text-rose-500">*</span>
          </label>
          <input
            type="text"
            value={treeTitle}
            onChange={(e) => setTreeTitle(e.target.value)}
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">
            School Year
          </label>
          <input
            type="text"
            value={schoolYear}
            onChange={(e) => setSchoolYear(e.target.value)}
            placeholder="2025-2026"
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none"
          />
        </div>
      </div>

      {error && (
        <p className="rounded-xl bg-rose-50 border border-rose-200 px-4 py-2.5 text-sm text-rose-700">
          {error}
        </p>
      )}

      <div className="flex items-center justify-between pt-2">
        <button
          type="button"
          onClick={onBack}
          disabled={loading}
          className="rounded-xl border border-slate-300 px-5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 transition"
        >
          ← Back
        </button>
        <button
          type="button"
          disabled={loading || !valid}
          onClick={() => onCommit(classTitle.trim(), treeTitle.trim(), schoolYear.trim())}
          className="rounded-xl bg-cyan-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-cyan-500 disabled:opacity-40 disabled:cursor-not-allowed transition flex items-center gap-2"
        >
          {loading ? (
            <>
              <span className="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full" />
              Creating curriculum…
            </>
          ) : (
            "Create Curriculum ✦"
          )}
        </button>
      </div>
    </div>
  );
}

function SummaryCell({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number;
  accent?: boolean;
}) {
  return (
    <div className="rounded-xl bg-white border border-slate-200 px-3 py-2 text-center">
      <div className={`text-lg font-bold ${accent ? "text-cyan-600" : "text-slate-800"}`}>
        {value}
      </div>
      <div className="text-xs text-slate-500">{label}</div>
    </div>
  );
}

// ── Loading overlay ───────────────────────────────────────────────────────────

function LoadingOverlay({ message }: { message: string }) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-slate-950/80 backdrop-blur-sm gap-5">
      <div className="relative w-20 h-20">
        <div className="absolute inset-0 rounded-full border-4 border-cyan-500/30" />
        <div className="absolute inset-0 rounded-full border-4 border-t-cyan-400 animate-spin" />
        <div className="absolute inset-2 rounded-full border-4 border-t-purple-400 animate-spin"
          style={{ animationDirection: "reverse", animationDuration: "1.2s" }} />
      </div>
      <p className="text-white text-lg font-semibold">{message}</p>
      <p className="text-slate-400 text-sm max-w-xs text-center">
        The AI is generating your curriculum — this usually takes 10–20 seconds.
      </p>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

function CurriculumBuilderPage() {
  const { profiles } = Route.useLoaderData();
  const router = useRouter();

  const [step, setStep] = useState<WizardStep>(1);
  const [intake, setIntake] = useState<IntakeData | null>(null);
  const [assignmentPrefs, setAssignmentPrefs] = useState<AssignmentPrefs | null>(null);
  const [spineNodes, setSpineNodes] = useState<SpineNode[]>([]);
  const [webData, setWebData] = useState<{ nodes: WebNode[]; edges: WebEdge[] } | null>(null);
  const [generatedAssignments, setGeneratedAssignments] = useState<GeneratedAssignment[]>([]);

  const [globalLoading, setGlobalLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState("");
  const [stepError, setStepError] = useState<string | null>(null);

  // ── Step 1 → 2: Save intake, go to assignment prefs ────────────────────────
  function handleIntakeSubmit(data: IntakeData) {
    setIntake(data);
    setStepError(null);
    setStep(2);
  }

  // ── Step 2 → 3: Save prefs, generate spine ─────────────────────────────────
  async function handlePrefsSubmit(prefs: AssignmentPrefs) {
    if (!intake) return;
    setAssignmentPrefs(prefs);
    setStepError(null);
    setGlobalLoading(true);
    setLoadingMessage("Generating curriculum spine…");
    try {
      const result = await wizardGenerateSpine({
        data: {
          subject: intake.subject,
          gradeLevel: intake.gradeLevel,
          courseLength: intake.courseLength,
          interests: intake.interests,
        },
      });
      setSpineNodes(result.nodes as SpineNode[]);
      setStepError(null);
      setStep(3);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStepError(`Spine generation failed: ${msg}. Please try again.`);
    } finally {
      setGlobalLoading(false);
    }
  }

  // ── Step 3 → 4: Move to staged build ───────────────────────────────────────
  function handleSpineConfirm() {
    setStepError(null);
    setStep(4);
  }

  // ── Step 5: Commit ──────────────────────────────────────────────────────────
  async function handleCommit(classTitle: string, treeTitle: string, schoolYear: string) {
    if (!intake || !webData) return;
    setStepError(null);
    setGlobalLoading(true);
    setLoadingMessage("Creating your curriculum in the database…");
    try {
      const result = await wizardCommitCurriculum({
        data: {
          profileId: intake.profileId,
          classTitle,
          treeTitle,
          subject: intake.subject,
          gradeLevel: intake.gradeLevel,
          schoolYear: schoolYear || undefined,
          nodes: webData.nodes.map((n) => ({
            tempId: n.tempId,
            title: n.title,
            description: n.description,
            icon: n.icon,
            colorRamp: n.colorRamp,
            nodeType: n.nodeType,
            cluster: n.cluster,
            depth: n.depth,
            isRequired: n.isRequired,
            xpReward: n.xpReward,
            prerequisites: n.prerequisites,
            x: n.x,
            y: n.y,
            suggestedAssignments: n.suggestedAssignments,
          })),
          generatedAssignments,
        },
      });
      await router.navigate({
        to: "/skill-tree/$treeId",
        params: { treeId: result.treeId },
      });
    } catch {
      setStepError("Failed to create the curriculum. Please try again.");
      setGlobalLoading(false);
    }
  }

  return (
    <>
      {globalLoading && <LoadingOverlay message={loadingMessage} />}

      <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-cyan-50/30 px-4 py-10">
        <div className="mx-auto max-w-2xl">
          {/* Header */}
          <div className="mb-8 flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-slate-900 flex items-center justify-center text-white text-lg">
              🗺️
            </div>
            <div>
              <h1 className="text-lg font-bold text-slate-900 leading-tight">
                Curriculum Builder
              </h1>
              <p className="text-xs text-slate-500">AI-powered gameified skill web generator</p>
            </div>
          </div>

          <StepIndicator step={step} />

          {/* Step panels */}
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            {step === 1 && (
              <StepIntake
                profiles={profiles}
                onNext={handleIntakeSubmit}
                error={stepError}
              />
            )}

            {step === 2 && intake && (
              <StepAssignments
                intake={intake}
                onBack={() => setStep(1)}
                onNext={handlePrefsSubmit}
              />
            )}

            {step === 3 && intake && (
              <StepSpine
                intake={intake}
                spineNodes={spineNodes}
                onSpineChange={setSpineNodes}
                onBack={() => setStep(2)}
                onNext={handleSpineConfirm}
                loading={false}
                error={stepError}
              />
            )}

            {step === 4 && intake && assignmentPrefs && (
              <StepBuild
                intake={intake}
                prefs={assignmentPrefs}
                spineNodes={spineNodes}
                onBack={() => setStep(3)}
                onDone={(data, assignments) => {
                  setWebData(data);
                  setGeneratedAssignments(assignments);
                  setStep(5);
                }}
              />
            )}

            {step === 5 && intake && webData && (
              <StepConfirm
                intake={intake}
                webData={webData}
                assignmentCount={generatedAssignments.length}
                onBack={() => setStep(4)}
                onCommit={handleCommit}
                loading={false}
                error={stepError}
              />
            )}
          </div>
        </div>
      </div>
    </>
  );
}
