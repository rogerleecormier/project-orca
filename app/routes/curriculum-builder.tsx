import { useState } from "react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import {
  getViewerContext,
  curriculumRecommendCourses,
  wizardCommitCurriculum,
  wizardGenerateAssignments,
  wizardGenerateBranchCluster,
  wizardGenerateChapterCluster,
  wizardGenerateSpine,
  wizardGetIntakeData,
  wizardLayoutNodes,
} from "../server/functions";
import { useCurriculumProgress } from "../components/CurriculumProgressPanel";
import { ParentPageHeader } from "../components/parent-page-header";
import type {
  BuilderAssignmentPrefs,
  CurriculumDesignInput,
  CurriculumDuration,
  AssignmentWeight,
  CourseSlot,
} from "../lib/curriculumStore";
import { createAssignmentPrefsForWeight } from "../lib/curriculumStore";
import type { CourseRecommendation } from "../lib/ai";

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

type ProfileOption = {
  id: string;
  displayName: string;
  gradeLevel: string;
  birthDate: string | null;
};

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

type WizardMode = "curriculum" | "single";
type CurriculumWizardStep = "design" | "courses" | "launched";
type SingleWizardStep = 1 | 2 | 3 | 4 | 5;
type SingleCourseLaunchStep = "design" | "review" | "launched";

type AssignmentPrefs = BuilderAssignmentPrefs;

type SingleCourseDesignInput = CurriculumDesignInput & {
  subject: string;
  courseTitle: string;
  courseDescription: string;
};

type GeneratedAssignment = {
  nodeId: string;
  contentType: "text" | "video" | "quiz" | "essay_questions" | "report";
  title: string;
  description: string;
  contentRef: string;
};

// ── Utilities ─────────────────────────────────────────────────────────────────

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

function currentSchoolYear() {
  const now = new Date();
  const start = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  return `${start}-${start + 1}`;
}

function deriveAgeFromBirthDate(birthDate: string | null): number {
  if (!birthDate) return 12;
  try {
    const birth = new Date(birthDate);
    const now = new Date();
    const age = now.getFullYear() - birth.getFullYear();
    const afterBirthday =
      now.getMonth() > birth.getMonth() ||
      (now.getMonth() === birth.getMonth() && now.getDate() >= birth.getDate());
    return afterBirthday ? age : age - 1;
  } catch {
    return 12;
  }
}

// ── Shared UI atoms ───────────────────────────────────────────────────────────

function Counter({
  value, min, max, onChange,
}: { value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-2">
      <button type="button" onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min}
        className="w-8 h-8 rounded-full border border-slate-300 text-slate-700 font-bold text-sm flex items-center justify-center hover:bg-slate-100 disabled:opacity-30 transition">−</button>
      <span className="w-6 text-center text-sm font-semibold text-slate-800 tabular-nums">{value}</span>
      <button type="button" onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max}
        className="w-8 h-8 rounded-full border border-slate-300 text-slate-700 font-bold text-sm flex items-center justify-center hover:bg-slate-100 disabled:opacity-30 transition">+</button>
    </div>
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" onClick={() => onChange(!value)}
      className={["relative inline-flex h-6 w-11 items-center rounded-full transition-colors", value ? "bg-cyan-500" : "bg-slate-200"].join(" ")}>
      <span className={["inline-block h-4 w-4 rounded-full bg-white shadow transition-transform", value ? "translate-x-6" : "translate-x-1"].join(" ")} />
    </button>
  );
}

function SummaryCell({ label, value, accent }: { label: string; value: string | number; accent?: boolean }) {
  return (
    <div className="rounded-xl bg-white border border-slate-200 px-3 py-2 text-center">
      <div className={`text-lg font-bold ${accent ? "text-cyan-600" : "text-slate-800"}`}>{value}</div>
      <div className="text-xs text-slate-500">{label}</div>
    </div>
  );
}

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
        Generating your curriculum — this usually takes 15–30 seconds.
      </p>
    </div>
  );
}

// ── Mode selector ─────────────────────────────────────────────────────────────

function ModeSelector({ onSelect }: { onSelect: (mode: WizardMode) => void }) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-bold text-slate-900">What would you like to build?</h2>
        <p className="mt-1 text-slate-500">
          Build a complete multi-course curriculum, or add a single course to an existing curriculum.
        </p>
      </div>
      <div className="grid sm:grid-cols-2 gap-4">
        <button
          type="button"
          onClick={() => onSelect("curriculum")}
          className="group rounded-2xl border-2 border-cyan-200 bg-cyan-50 hover:border-cyan-400 hover:bg-cyan-100 p-6 text-left transition"
        >
          <div className="text-3xl mb-3">🗺️</div>
          <h3 className="text-base font-bold text-slate-900 group-hover:text-cyan-800">
            Full Curriculum
          </h3>
          <p className="mt-1 text-sm text-slate-600">
            AI recommends a complete set of courses for the grade level and duration. Builds all
            courses in the background while you use the app.
          </p>
          <div className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-cyan-700 bg-cyan-100 rounded-full px-2.5 py-1">
            ✦ Recommended
          </div>
        </button>
        <button
          type="button"
          onClick={() => onSelect("single")}
          className="group rounded-2xl border-2 border-slate-200 bg-slate-50 hover:border-slate-400 hover:bg-slate-100 p-6 text-left transition"
        >
          <div className="text-3xl mb-3">📚</div>
          <h3 className="text-base font-bold text-slate-900">Single Course</h3>
          <p className="mt-1 text-sm text-slate-600">
            Design one specific course with the same intake and background build experience as the full curriculum flow.
          </p>
        </button>
      </div>
    </div>
  );
}

// ── CURRICULUM WIZARD: Step 1 — Design ───────────────────────────────────────

const DURATIONS: CurriculumDuration[] = ["6 Weeks", "9 Weeks", "12 Weeks", "1 Semester", "1 Year"];

const WEIGHT_OPTIONS: { value: AssignmentWeight; label: string; description: string }[] = [
  { value: "light", label: "Light", description: "1 video · 1 quiz per chapter · minimal writing" },
  { value: "medium", label: "Medium", description: "2 videos · quizzes + essays · recommended" },
  { value: "heavy", label: "Heavy", description: "2 videos · 2 quizzes · 2 essays + projects + movies" },
];

function AssignmentPreferencesEditor({
  prefs,
  onChange,
}: {
  prefs: AssignmentPrefs;
  onChange: (prefs: AssignmentPrefs) => void;
}) {
  function set<K extends keyof AssignmentPrefs>(key: K, value: AssignmentPrefs[K]) {
    onChange({ ...prefs, [key]: value });
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5 space-y-5">
      <div>
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-700">
          Detailed Assignment Recipe
        </h3>
        <p className="mt-1 text-xs text-slate-500">
          These settings apply to both the background course builder and the full curriculum builder.
        </p>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-4">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-600">
          Lessons And Electives
        </h4>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-slate-800">Videos per lesson</p>
            <p className="text-xs text-slate-500">One to explain, one to demonstrate is the default.</p>
          </div>
          <Counter value={prefs.videosPerLesson} min={0} max={3} onChange={(v) => set("videosPerLesson", v)} />
        </div>
      </div>

      <div className="rounded-2xl border border-teal-100 bg-teal-50 p-4 space-y-4">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-teal-700">
          Chapter Milestones
        </h4>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-slate-800">Intro videos</p>
            <p className="text-xs text-slate-500">Broad overview plus first key concept.</p>
          </div>
          <Toggle value={prefs.chapterIntroVideo} onChange={(v) => set("chapterIntroVideo", v)} />
        </div>
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-slate-800">Chapter checkpoint quizzes</p>
          <Counter value={prefs.quizzesPerChapter} min={0} max={3} onChange={(v) => set("quizzesPerChapter", v)} />
        </div>
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-slate-800">Chapter reflections</p>
          <Counter value={prefs.essaysPerChapter} min={0} max={2} onChange={(v) => set("essaysPerChapter", v)} />
        </div>
      </div>

      <div className="rounded-2xl border border-amber-100 bg-amber-50 p-4 space-y-4">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-amber-700">
          Capstones
        </h4>
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-slate-800">Summative quizzes</p>
          <Counter value={prefs.quizzesPerBoss} min={0} max={5} onChange={(v) => set("quizzesPerBoss", v)} />
        </div>
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-slate-800">Analytical essays</p>
          <Counter value={prefs.essaysPerBoss} min={0} max={3} onChange={(v) => set("essaysPerBoss", v)} />
        </div>
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-slate-800">Research papers</p>
          <Counter value={prefs.papersPerBoss} min={0} max={2} onChange={(v) => set("papersPerBoss", v)} />
        </div>
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-slate-800">Capstone project</p>
          <Toggle value={prefs.includeProjects} onChange={(v) => set("includeProjects", v)} />
        </div>
      </div>

      <div className="rounded-2xl border border-purple-100 bg-purple-50 p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-purple-700">
              Movie Assignments
            </h4>
            <p className="mt-1 text-xs text-slate-500">
              Each movie is paired with a follow-up quiz or writing task.
            </p>
          </div>
          <Toggle value={prefs.includeMovies} onChange={(v) => set("includeMovies", v)} />
        </div>
      </div>

      <div>
        <label className="block text-xs font-semibold text-slate-700 mb-1">
          Additional instructions <span className="font-normal text-slate-400">(optional)</span>
        </label>
        <textarea
          value={prefs.otherInstructions}
          onChange={(e) => set("otherInstructions", e.target.value)}
          rows={2}
          placeholder="e.g. Include more primary sources, map analysis, lab writeups, Socratic discussion prompts…"
          className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none resize-none"
        />
      </div>
    </div>
  );
}

function CurriculumDesignStep({
  profiles,
  onNext,
  loading,
  error,
}: {
  profiles: ProfileOption[];
  onNext: (data: CurriculumDesignInput) => void;
  loading: boolean;
  error: string | null;
}) {
  const [profileId, setProfileId] = useState(profiles[0]?.id ?? "");
  const [gradeLevel, setGradeLevel] = useState(profiles[0]?.gradeLevel ?? "");
  const [duration, setDuration] = useState<CurriculumDuration>("1 Year");
  const [courseCount, setCourseCount] = useState(6);
  const [assignmentWeight, setAssignmentWeight] = useState<AssignmentWeight>("medium");
  const [assignmentPrefs, setAssignmentPrefs] = useState<AssignmentPrefs>(
    createAssignmentPrefsForWeight("medium"),
  );
  const [showAdvancedPrefs, setShowAdvancedPrefs] = useState(false);
  const [focusSteering, setFocusSteering] = useState("");
  const [schoolYear, setSchoolYear] = useState(currentSchoolYear());

  function handleProfileChange(id: string) {
    setProfileId(id);
    const p = profiles.find((p) => p.id === id);
    if (p?.gradeLevel) setGradeLevel(p.gradeLevel);
  }

  const selectedProfile = profiles.find((p) => p.id === profileId);
  const ageYears = deriveAgeFromBirthDate(selectedProfile?.birthDate ?? null);
  const valid = profileId && gradeLevel.trim();

  function handleSubmit() {
    if (!valid || loading) return;
    onNext({
      profileId,
      studentName: selectedProfile?.displayName ?? "",
      gradeLevel: gradeLevel.trim(),
      ageYears,
      duration,
      courseCount,
      assignmentWeight,
      assignmentPrefs,
      focusSteering: focusSteering.trim(),
      schoolYear,
    });
  }

  function updateWeight(weight: AssignmentWeight) {
    setAssignmentWeight(weight);
    if (weight !== "custom") {
      setAssignmentPrefs(createAssignmentPrefsForWeight(weight));
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-900">Design your curriculum</h2>
        <p className="mt-1 text-slate-500">
          Tell us about the student and scope. AI will recommend a complete course list.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {/* Student */}
        <div className="sm:col-span-2">
          <label className="block text-xs font-semibold text-slate-700 mb-1">
            Student <span className="text-rose-500">*</span>
          </label>
          <select value={profileId} onChange={(e) => handleProfileChange(e.target.value)}
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none">
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}{p.gradeLevel ? ` — Grade ${p.gradeLevel}` : ""}
              </option>
            ))}
          </select>
          {ageYears && (
            <p className="mt-1 text-xs text-slate-400">
              Age: ~{ageYears} years old — content will be calibrated accordingly.
            </p>
          )}
        </div>

        {/* Grade Level */}
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">
            Grade Level <span className="text-rose-500">*</span>
          </label>
          <input type="text" value={gradeLevel} onChange={(e) => setGradeLevel(e.target.value)}
            placeholder="e.g. 6, 9–10, K"
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none" />
        </div>

        {/* School Year */}
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">School Year</label>
          <input type="text" value={schoolYear} onChange={(e) => setSchoolYear(e.target.value)}
            placeholder="2025-2026"
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none" />
        </div>

        {/* Duration */}
        <div className="sm:col-span-2">
          <label className="block text-xs font-semibold text-slate-700 mb-1">Curriculum Duration</label>
          <div className="flex flex-wrap gap-2">
            {DURATIONS.map((d) => (
              <button key={d} type="button" onClick={() => setDuration(d)}
                className={["rounded-full px-3 py-1 text-sm font-medium border transition",
                  duration === d ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-600 border-slate-300 hover:border-slate-400"].join(" ")}>
                {d}
              </button>
            ))}
          </div>
        </div>

        {/* Course count */}
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">Number of Courses</label>
          <div className="flex items-center gap-3 pt-1">
            <Counter value={courseCount} min={2} max={10} onChange={setCourseCount} />
            <span className="text-sm text-slate-500">courses</span>
          </div>
          <p className="mt-1 text-xs text-slate-400">
            A typical year has 6–8 courses: 4 core subjects + 2–4 electives.
          </p>
        </div>

        {/* Assignment weight */}
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">Assignment Load</label>
          <div className="flex flex-col gap-2 pt-1">
            {WEIGHT_OPTIONS.map((opt) => (
              <button key={opt.value} type="button" onClick={() => updateWeight(opt.value)}
                className={["rounded-xl border px-3 py-2 text-left transition",
                  assignmentWeight === opt.value
                    ? "border-cyan-400 bg-cyan-50 text-cyan-900"
                    : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"].join(" ")}>
                <span className="text-sm font-semibold">{opt.label}</span>
                <span className="ml-2 text-xs text-slate-500">{opt.description}</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              setShowAdvancedPrefs((prev) => !prev);
              if (assignmentWeight !== "custom") setAssignmentWeight("custom");
            }}
            className="mt-2 text-xs font-medium text-cyan-700 hover:text-cyan-900"
          >
            {showAdvancedPrefs ? "Hide detailed assignment controls" : "Customize assignment recipe"}
          </button>
        </div>

        {/* Focus / steering */}
        <div className="sm:col-span-2">
          <label className="block text-xs font-semibold text-slate-700 mb-1">
            Curriculum Focus / Steering
            <span className="ml-1 font-normal text-slate-400">(optional but powerful)</span>
          </label>
          <textarea value={focusSteering} onChange={(e) => setFocusSteering(e.target.value)} rows={3}
            placeholder="e.g. Central Florida highlights and local history · engineering and problem-solving focus · classics-based with primary sources · Charlotte Mason nature study emphasis…"
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none resize-none" />
          <p className="mt-1 text-xs text-slate-400">
            This theme is woven into every course, chapter title, reading passage, video search, and assignment across the entire curriculum.
          </p>
        </div>

        {(showAdvancedPrefs || assignmentWeight === "custom") && (
          <div className="sm:col-span-2">
            <AssignmentPreferencesEditor
              prefs={assignmentPrefs}
              onChange={setAssignmentPrefs}
            />
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>
      )}

      <div className="flex justify-end pt-2">
        <button type="button" disabled={!valid || loading} onClick={handleSubmit}
          className="rounded-xl bg-slate-900 px-6 py-2.5 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition flex items-center gap-2">
          {loading ? (
            <><span className="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full" />Generating course list…</>
          ) : "Generate Course List →"}
        </button>
      </div>
    </div>
  );
}

// ── CURRICULUM WIZARD: Step 2 — Approve Course List ──────────────────────────

function CourseCard({
  slot,
  index,
  onEdit,
  onRemove,
}: {
  slot: CourseSlot;
  index: number;
  onEdit: (field: keyof CourseSlot, value: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-3 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="w-7 h-7 rounded-full bg-slate-100 text-slate-600 text-xs font-bold flex items-center justify-center shrink-0">
            {index + 1}
          </span>
          {editing ? (
            <input
              type="text"
              value={slot.name}
              onChange={(e) => onEdit("name", e.target.value)}
              onBlur={() => setEditing(false)}
              autoFocus
              className="flex-1 rounded-lg border border-cyan-400 bg-white px-2 py-1 text-sm font-semibold text-slate-900 focus:outline-none"
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-sm font-semibold text-slate-900 hover:text-cyan-700 text-left"
            >
              {slot.name}
            </button>
          )}
        </div>
        <button type="button" onClick={onRemove}
          className="text-slate-400 hover:text-rose-500 text-xs shrink-0 transition">
          ✕
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <span className="rounded-full bg-cyan-50 border border-cyan-200 px-2.5 py-0.5 text-xs font-medium text-cyan-800">
          {slot.subject}
        </span>
        <span className="rounded-full bg-slate-100 border border-slate-200 px-2.5 py-0.5 text-xs text-slate-600">
          {slot.courseLength}
        </span>
      </div>

      <p className="text-xs text-slate-500 leading-relaxed">{slot.description}</p>
    </div>
  );
}

function ApproveCourseListStep({
  design,
  courses,
  setCourses,
  onBack,
  onLaunch,
}: {
  design: CurriculumDesignInput;
  courses: CourseSlot[];
  setCourses: (c: CourseSlot[]) => void;
  onBack: () => void;
  onLaunch: () => void;
}) {
  function editCourse(id: string, field: keyof CourseSlot, value: string) {
    setCourses(courses.map((c) => (c.id === id ? { ...c, [field]: value } : c)));
  }

  function removeCourse(id: string) {
    setCourses(courses.filter((c) => c.id !== id));
  }

  function addCourse() {
    const newSlot: CourseSlot = {
      id: crypto.randomUUID(),
      name: "New Course",
      subject: "Elective",
      description: "Custom course — edit name and subject above.",
      courseLength: design.duration,
      approved: true,
    };
    setCourses([...courses, newSlot]);
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-bold text-slate-900">Approve your course list</h2>
        <p className="mt-1 text-slate-500">
          AI recommended these {courses.length} courses for Grade {design.gradeLevel} — {design.duration}.
          Edit any title, remove courses you don't want, or add your own.
        </p>
      </div>

      {/* Design summary strip */}
      <div className="flex flex-wrap gap-2 text-xs">
        <span className="rounded-full bg-cyan-50 border border-cyan-200 px-3 py-1 text-cyan-800 font-medium">
          {design.studentName}
        </span>
        <span className="rounded-full bg-slate-100 border border-slate-200 px-3 py-1 text-slate-700 font-medium">
          Grade {design.gradeLevel} · Age ~{design.ageYears}
        </span>
        <span className="rounded-full bg-slate-100 border border-slate-200 px-3 py-1 text-slate-700 font-medium">
          {design.duration}
        </span>
        <span className="rounded-full bg-slate-100 border border-slate-200 px-3 py-1 text-slate-700 font-medium capitalize">
          {design.assignmentWeight} load
        </span>
        {design.focusSteering && (
          <span className="rounded-full bg-amber-50 border border-amber-200 px-3 py-1 text-amber-800 font-medium">
            Focus: {design.focusSteering.slice(0, 40)}{design.focusSteering.length > 40 ? "…" : ""}
          </span>
        )}
      </div>

      {/* Course cards */}
      <div className="space-y-3 max-h-[50vh] overflow-y-auto pr-1">
        {courses.map((slot, i) => (
          <CourseCard
            key={slot.id}
            slot={slot}
            index={i}
            onEdit={(field, value) => editCourse(slot.id, field, value)}
            onRemove={() => removeCourse(slot.id)}
          />
        ))}
      </div>

      <button type="button" onClick={addCourse}
        className="w-full rounded-xl border-2 border-dashed border-slate-300 hover:border-slate-400 py-2.5 text-sm text-slate-500 hover:text-slate-700 transition">
        + Add a course
      </button>

      {/* Note */}
      <div className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-xs text-blue-800">
        <span className="font-semibold">What happens next:</span> Curriculum building runs in the background while you use the app.
        A progress pill will appear in the bottom-right corner. When all courses are ready, you'll approve and commit them to your database.
      </div>

      <div className="flex items-center justify-between pt-2">
        <button type="button" onClick={onBack}
          className="rounded-xl border border-slate-300 px-5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition">
          ← Back
        </button>
        <button type="button" onClick={onLaunch} disabled={courses.length === 0}
          className="rounded-xl bg-cyan-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-cyan-500 disabled:opacity-40 disabled:cursor-not-allowed transition">
          Start Building {courses.length} Courses →
        </button>
      </div>
    </div>
  );
}

// ── CURRICULUM WIZARD: Launched confirmation ──────────────────────────────────

function LaunchedStep({ courseCount, onGoToDashboard }: { courseCount: number; onGoToDashboard: () => void }) {
  return (
    <div className="space-y-5 text-center py-4">
      <div className="text-6xl">🚀</div>
      <div>
        <h2 className="text-2xl font-bold text-slate-900">Building your curriculum!</h2>
        <p className="mt-2 text-slate-500 max-w-sm mx-auto">
          {courseCount} course{courseCount !== 1 ? "s are" : " is"} being built in the background.
          You can navigate anywhere — the progress pill in the bottom-right corner will keep you updated.
        </p>
      </div>
      <div className="rounded-xl border border-cyan-100 bg-cyan-50 px-4 py-3 text-sm text-cyan-800 inline-block">
        Look for <span className="font-bold">Building… XX%</span> in the bottom-right corner.
        When ready, click it to approve and create your courses.
      </div>
      <button type="button" onClick={onGoToDashboard}
        className="rounded-xl bg-slate-900 px-6 py-2.5 text-sm font-semibold text-white hover:bg-slate-700 transition">
        Go to Dashboard →
      </button>
    </div>
  );
}

function SingleCourseDesignStep({
  profiles,
  onNext,
  loading,
  error,
}: {
  profiles: ProfileOption[];
  onNext: (data: SingleCourseDesignInput) => void;
  loading: boolean;
  error: string | null;
}) {
  const [profileId, setProfileId] = useState(profiles[0]?.id ?? "");
  const [gradeLevel, setGradeLevel] = useState(profiles[0]?.gradeLevel ?? "");
  const [subject, setSubject] = useState("");
  const [courseTitle, setCourseTitle] = useState("");
  const [courseDescription, setCourseDescription] = useState("");
  const [duration, setDuration] = useState<CurriculumDuration>("1 Semester");
  const [assignmentWeight, setAssignmentWeight] = useState<AssignmentWeight>("medium");
  const [assignmentPrefs, setAssignmentPrefs] = useState<AssignmentPrefs>(
    createAssignmentPrefsForWeight("medium"),
  );
  const [showAdvancedPrefs, setShowAdvancedPrefs] = useState(false);
  const [focusSteering, setFocusSteering] = useState("");
  const [schoolYear, setSchoolYear] = useState(currentSchoolYear());

  function handleProfileChange(id: string) {
    setProfileId(id);
    const p = profiles.find((profile) => profile.id === id);
    if (p?.gradeLevel) setGradeLevel(p.gradeLevel);
  }

  function updateWeight(weight: AssignmentWeight) {
    setAssignmentWeight(weight);
    if (weight !== "custom") {
      setAssignmentPrefs(createAssignmentPrefsForWeight(weight));
    }
  }

  const selectedProfile = profiles.find((profile) => profile.id === profileId);
  const ageYears = deriveAgeFromBirthDate(selectedProfile?.birthDate ?? null);
  const resolvedCourseTitle = courseTitle.trim() || subject.trim();
  const valid = profileId && gradeLevel.trim() && subject.trim() && resolvedCourseTitle;

  function handleSubmit() {
    if (!valid || loading) return;
    onNext({
      profileId,
      studentName: selectedProfile?.displayName ?? "",
      gradeLevel: gradeLevel.trim(),
      ageYears,
      duration,
      courseCount: 1,
      assignmentWeight,
      assignmentPrefs,
      focusSteering: focusSteering.trim(),
      schoolYear,
      subject: subject.trim(),
      courseTitle: resolvedCourseTitle,
      courseDescription: courseDescription.trim() || `AI-built ${subject.trim()} course for Grade ${gradeLevel.trim()}.`,
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-900">Design your course</h2>
        <p className="mt-1 text-slate-500">
          Use the same background builder pipeline, but focused on one course with tighter control.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="block text-xs font-semibold text-slate-700 mb-1">
            Student <span className="text-rose-500">*</span>
          </label>
          <select
            value={profileId}
            onChange={(e) => handleProfileChange(e.target.value)}
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none"
          >
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.displayName}{profile.gradeLevel ? ` — Grade ${profile.gradeLevel}` : ""}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-slate-400">
            Age: ~{ageYears} years old — readings and assignments will be calibrated accordingly.
          </p>
        </div>

        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">
            Subject <span className="text-rose-500">*</span>
          </label>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="e.g. Biology, World History, Algebra I"
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none"
          />
        </div>

        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">
            Course Title <span className="text-rose-500">*</span>
          </label>
          <input
            type="text"
            value={courseTitle}
            onChange={(e) => setCourseTitle(e.target.value)}
            placeholder="Defaults to the subject if left blank"
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none"
          />
        </div>

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

        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">School Year</label>
          <input
            type="text"
            value={schoolYear}
            onChange={(e) => setSchoolYear(e.target.value)}
            placeholder="2025-2026"
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none"
          />
        </div>

        <div className="sm:col-span-2">
          <label className="block text-xs font-semibold text-slate-700 mb-1">Course Duration</label>
          <div className="flex flex-wrap gap-2">
            {DURATIONS.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setDuration(value)}
                className={[
                  "rounded-full px-3 py-1 text-sm font-medium border transition",
                  duration === value ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-600 border-slate-300 hover:border-slate-400",
                ].join(" ")}
              >
                {value}
              </button>
            ))}
          </div>
        </div>

        <div className="sm:col-span-2">
          <label className="block text-xs font-semibold text-slate-700 mb-1">
            Course Description <span className="font-normal text-slate-400">(optional)</span>
          </label>
          <textarea
            value={courseDescription}
            onChange={(e) => setCourseDescription(e.target.value)}
            rows={2}
            placeholder="Optional framing note for the course card and background job."
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none resize-none"
          />
        </div>

        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">Assignment Load</label>
          <div className="flex flex-col gap-2 pt-1">
            {WEIGHT_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => updateWeight(opt.value)}
                className={[
                  "rounded-xl border px-3 py-2 text-left transition",
                  assignmentWeight === opt.value
                    ? "border-cyan-400 bg-cyan-50 text-cyan-900"
                    : "border-slate-200 bg-white text-slate-700 hover:border-slate-300",
                ].join(" ")}
              >
                <span className="text-sm font-semibold">{opt.label}</span>
                <span className="ml-2 text-xs text-slate-500">{opt.description}</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              setShowAdvancedPrefs((prev) => !prev);
              if (assignmentWeight !== "custom") setAssignmentWeight("custom");
            }}
            className="mt-2 text-xs font-medium text-cyan-700 hover:text-cyan-900"
          >
            {showAdvancedPrefs ? "Hide detailed assignment controls" : "Customize assignment recipe"}
          </button>
        </div>

        <div className="sm:col-span-2">
          <label className="block text-xs font-semibold text-slate-700 mb-1">
            Curriculum Focus / Steering
            <span className="ml-1 font-normal text-slate-400">(optional but powerful)</span>
          </label>
          <textarea
            value={focusSteering}
            onChange={(e) => setFocusSteering(e.target.value)}
            rows={3}
            placeholder="e.g. Lab-heavy science, classical rhetoric, engineering design challenges, local history tie-ins…"
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none resize-none"
          />
        </div>

        {(showAdvancedPrefs || assignmentWeight === "custom") && (
          <div className="sm:col-span-2">
            <AssignmentPreferencesEditor prefs={assignmentPrefs} onChange={setAssignmentPrefs} />
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>
      )}

      <div className="flex justify-end pt-2">
        <button
          type="button"
          disabled={!valid || loading}
          onClick={handleSubmit}
          className="rounded-xl bg-slate-900 px-6 py-2.5 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition"
        >
          Review Course Plan →
        </button>
      </div>
    </div>
  );
}

function SingleCourseReviewStep({
  design,
  onBack,
  onLaunch,
}: {
  design: SingleCourseDesignInput;
  onBack: () => void;
  onLaunch: () => void;
}) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-bold text-slate-900">Review your course build</h2>
        <p className="mt-1 text-slate-500">
          This single course will use the same background build engine as the full curriculum builder.
        </p>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">{design.courseTitle}</h3>
            <p className="mt-1 text-sm text-slate-500">{design.courseDescription}</p>
          </div>
          <span className="rounded-full bg-cyan-50 border border-cyan-200 px-3 py-1 text-xs font-medium text-cyan-800">
            {design.subject}
          </span>
        </div>

        <div className="grid gap-2 sm:grid-cols-4">
          <SummaryCell label="Student" value={design.studentName} />
          <SummaryCell label="Grade" value={design.gradeLevel} />
          <SummaryCell label="Duration" value={design.duration} />
          <SummaryCell label="Load" value={design.assignmentWeight} accent />
        </div>

        {design.focusSteering && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <span className="font-semibold">Focus:</span> {design.focusSteering}
          </div>
        )}

        <div className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-xs text-blue-800">
          The AI will generate the course spine, lesson branches, assignment set, and layout in the background.
          You can keep using the app while it builds.
        </div>
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
          onClick={onLaunch}
          className="rounded-xl bg-cyan-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-cyan-500 transition"
        >
          Start Building Course →
        </button>
      </div>
    </div>
  );
}

// ── SINGLE COURSE WIZARD ──────────────────────────────────────────────────────

const COURSE_LENGTHS = ["6 Weeks", "9 Weeks", "12 Weeks", "1 Semester", "1 Year"];
const COURSE_LENGTH_HINTS: Record<string, string> = {
  "6 Weeks":    "~2 chapters · ~4 lessons per chapter · ~30 total nodes — focused unit or short elective.",
  "9 Weeks":    "~3 chapters · ~4 lessons per chapter · ~45 total nodes — quarter course.",
  "12 Weeks":   "~4 chapters · ~5 lessons per chapter · ~65 total nodes — trimester or short semester.",
  "1 Semester": "~6 chapters · ~5 lessons per chapter · ~100 total nodes — full half-year course.",
  "1 Year":     "~10 chapters · ~6 lessons per chapter · ~170 total nodes — complete full-year curriculum.",
};

const STEP_LABELS = ["Intake", "Assignments", "Spine", "Build", "Confirm"];

function StepIndicator({ step }: { step: SingleWizardStep }) {
  return (
    <div className="flex items-center gap-0 mb-8">
      {STEP_LABELS.map((label, i) => {
        const num = (i + 1) as SingleWizardStep;
        const done = step > num;
        const active = step === num;
        return (
          <div key={label} className="flex items-center">
            <div className="flex flex-col items-center">
              <div className={["w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold transition-all",
                done ? "bg-cyan-500 text-white" : active ? "bg-slate-900 text-white ring-2 ring-cyan-400 ring-offset-2" : "bg-slate-100 text-slate-400"].join(" ")}>
                {done ? "✓" : num}
              </div>
              <span className={["mt-1 text-xs font-medium", active ? "text-slate-900" : "text-slate-400"].join(" ")}>
                {label}
              </span>
            </div>
            {i < STEP_LABELS.length - 1 && (
              <div className={["w-16 h-0.5 mx-1 mb-4 rounded transition-all", done ? "bg-cyan-500" : "bg-slate-200"].join(" ")} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function StepIntake({
  profiles, onNext, error,
}: { profiles: ProfileOption[]; onNext: (data: IntakeData) => void; error?: string | null }) {
  const [profileId, setProfileId] = useState(profiles[0]?.id ?? "");
  const [subject, setSubject] = useState("");
  const [gradeLevel, setGradeLevel] = useState(profiles[0]?.gradeLevel ?? "");
  const [courseLength, setCourseLength] = useState(COURSE_LENGTHS[0]);
  const [interests, setInterests] = useState("");

  function handleProfileChange(id: string) {
    setProfileId(id);
    const p = profiles.find((p) => p.id === id);
    if (p?.gradeLevel) setGradeLevel(p.gradeLevel);
  }

  const valid = profileId && subject.trim() && gradeLevel.trim();

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-bold text-slate-900">Design a new course</h2>
        <p className="mt-1 text-slate-500">
          Tell us the basics. We'll generate a full gameified skill web from scratch.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="block text-xs font-semibold text-slate-700 mb-1">
            Student <span className="text-rose-500">*</span>
          </label>
          {profiles.length === 0 ? (
            <p className="text-sm text-slate-500 italic">No student profiles found. Create a profile first.</p>
          ) : (
            <select value={profileId} onChange={(e) => handleProfileChange(e.target.value)}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none">
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}{p.gradeLevel ? ` — Grade ${p.gradeLevel}` : ""}
                </option>
              ))}
            </select>
          )}
        </div>

        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">
            Subject <span className="text-rose-500">*</span>
          </label>
          <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)}
            placeholder="e.g. World History, Algebra, Biology"
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none" />
        </div>

        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">
            Grade Level <span className="text-rose-500">*</span>
          </label>
          <input type="text" value={gradeLevel} onChange={(e) => setGradeLevel(e.target.value)}
            placeholder="e.g. 6, 9–10, K"
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none" />
        </div>

        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">Course Length</label>
          <div className="flex flex-wrap gap-2">
            {COURSE_LENGTHS.map((opt) => (
              <button key={opt} type="button" onClick={() => setCourseLength(opt)}
                className={["rounded-full px-3 py-1 text-sm font-medium border transition",
                  courseLength === opt ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-600 border-slate-300 hover:border-slate-400"].join(" ")}>
                {opt}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-400">{COURSE_LENGTH_HINTS[courseLength] ?? ""}</p>
        </div>

        <div className="sm:col-span-2">
          <label className="block text-xs font-semibold text-slate-700 mb-1">
            Student Interests &amp; Focus Areas
            <span className="ml-1 font-normal text-slate-400">(optional)</span>
          </label>
          <textarea value={interests} onChange={(e) => setInterests(e.target.value)} rows={3}
            placeholder="e.g. Loves space exploration, prefers hands-on projects, keen on ancient civilizations…"
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none resize-none" />
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>
      )}

      <div className="flex justify-end pt-2">
        <button type="button" disabled={!valid}
          onClick={() => onNext({ profileId, subject: subject.trim(), gradeLevel: gradeLevel.trim(), courseLength, interests })}
          className="rounded-xl bg-slate-900 px-6 py-2.5 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition">
          Next: Assignments →
        </button>
      </div>
    </div>
  );
}

const DEFAULT_PREFS: AssignmentPrefs = {
  readingPerNode: true,
  videosPerLesson: 2,
  chapterIntroVideo: true,
  quizzesPerChapter: 1,
  essaysPerChapter: 1,
  quizzesPerBoss: 3,
  essaysPerBoss: 1,
  papersPerBoss: 0,
  includeProjects: false,
  includeMovies: false,
  otherInstructions: "",
};

function StepAssignments({
  intake, onBack, onNext,
}: { intake: IntakeData; onBack: () => void; onNext: (prefs: AssignmentPrefs) => void }) {
  const [prefs, setPrefs] = useState<AssignmentPrefs>(DEFAULT_PREFS);
  function set<K extends keyof AssignmentPrefs>(key: K, value: AssignmentPrefs[K]) {
    setPrefs((p) => ({ ...p, [key]: value }));
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-900">Assignment preferences</h2>
        <p className="mt-1 text-slate-500">
          Each node type gets a different mix of assignments.
        </p>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5 space-y-4">
        <h3 className="text-sm font-semibold text-slate-700 uppercase tracking-wide flex items-center gap-2">
          <span className="inline-block w-3 h-3 rounded-full bg-blue-400" />Lesson &amp; Elective Nodes
        </h3>
        <p className="text-xs text-slate-500 -mt-2">Every lesson always includes a formative check quiz and a short practice response — non-negotiable for mastery-based learning. Each lesson also gets its own dedicated AI-generated reading passage.</p>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-slate-800">Videos per lesson</p>
            <p className="text-xs text-slate-500">2 recommended — one to explain, one to demonstrate. Links are YouTube-validated.</p>
          </div>
          <Counter value={prefs.videosPerLesson} min={0} max={3} onChange={(v) => set("videosPerLesson", v)} />
        </div>
      </div>

      <div className="rounded-2xl border border-teal-100 bg-teal-50 p-5 space-y-4">
        <h3 className="text-sm font-semibold text-teal-700 uppercase tracking-wide flex items-center gap-2">
          <span className="inline-block w-3 h-3 rounded-full bg-teal-500" />Chapter Nodes (Milestones)
        </h3>
        <div className="flex items-center justify-between">
          <div><p className="text-sm font-medium text-slate-800">Intro videos</p><p className="text-xs text-slate-500">2 videos — broad overview + first concept</p></div>
          <Toggle value={prefs.chapterIntroVideo} onChange={(v) => set("chapterIntroVideo", v)} />
        </div>
        <div className="flex items-center justify-between">
          <div><p className="text-sm font-medium text-slate-800">Chapter checkpoint quizzes</p></div>
          <Counter value={prefs.quizzesPerChapter} min={0} max={3} onChange={(v) => set("quizzesPerChapter", v)} />
        </div>
        <div className="flex items-center justify-between">
          <div><p className="text-sm font-medium text-slate-800">Chapter reflections</p></div>
          <Counter value={prefs.essaysPerChapter} min={0} max={2} onChange={(v) => set("essaysPerChapter", v)} />
        </div>
      </div>

      <div className="rounded-2xl border border-amber-100 bg-amber-50 p-5 space-y-4">
        <h3 className="text-sm font-semibold text-amber-700 uppercase tracking-wide flex items-center gap-2">
          <span className="inline-block w-3 h-3 rounded-full bg-amber-500" />Boss Nodes (Capstones)
        </h3>
        <div className="flex items-center justify-between">
          <div><p className="text-sm font-medium text-slate-800">Summative quizzes</p></div>
          <Counter value={prefs.quizzesPerBoss} min={0} max={5} onChange={(v) => set("quizzesPerBoss", v)} />
        </div>
        <div className="flex items-center justify-between">
          <div><p className="text-sm font-medium text-slate-800">Analytical essays</p></div>
          <Counter value={prefs.essaysPerBoss} min={0} max={3} onChange={(v) => set("essaysPerBoss", v)} />
        </div>
        <div className="flex items-center justify-between">
          <div><p className="text-sm font-medium text-slate-800">Research papers</p></div>
          <Counter value={prefs.papersPerBoss} min={0} max={2} onChange={(v) => set("papersPerBoss", v)} />
        </div>
        <div className="flex items-center justify-between">
          <div><p className="text-sm font-medium text-slate-800">Capstone project</p></div>
          <Toggle value={prefs.includeProjects} onChange={(v) => set("includeProjects", v)} />
        </div>
      </div>

      <div className="rounded-2xl border border-purple-100 bg-purple-50 p-5 space-y-3">
        <h3 className="text-sm font-semibold text-purple-700 uppercase tracking-wide flex items-center gap-2">
          <span className="inline-block w-3 h-3 rounded-full bg-purple-500" />Movie Assignments
        </h3>
        <div className="flex items-center justify-between">
          <div><p className="text-sm font-medium text-slate-800">Include movie assignments</p><p className="text-xs text-slate-500">Each movie is automatically paired with a follow-up quiz or essay.</p></div>
          <Toggle value={prefs.includeMovies} onChange={(v) => set("includeMovies", v)} />
        </div>
      </div>

      <div>
        <label className="block text-xs font-semibold text-slate-700 mb-1">
          Additional instructions <span className="font-normal text-slate-400">(optional)</span>
        </label>
        <textarea value={prefs.otherInstructions} onChange={(e) => set("otherInstructions", e.target.value)} rows={2}
          placeholder="e.g. Add a map labelling activity for each geography chapter, include primary source documents…"
          className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none resize-none" />
      </div>

      <div className="flex items-center justify-between pt-2">
        <button type="button" onClick={onBack}
          className="rounded-xl border border-slate-300 px-5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition">
          ← Back
        </button>
        <button type="button" onClick={() => onNext(prefs)}
          className="rounded-xl bg-slate-900 px-6 py-2.5 text-sm font-semibold text-white hover:bg-slate-700 transition">
          Generate Spine →
        </button>
      </div>
    </div>
  );
}

function SpineNodeRow({ node, onChange }: { node: SpineNode; onChange: (title: string) => void }) {
  const color = NODE_COLORS[node.colorRamp] ?? NODE_COLORS.teal;
  const isBoss = node.nodeType === "boss";
  return (
    <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <div style={{ width: node.depth * 16 }} className="shrink-0" />
      <div className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-lg font-semibold"
        style={{ backgroundColor: color.fill + "22", border: `2px solid ${color.fill}` }}>
        {node.icon}
      </div>
      <input type="text" value={node.title} onChange={(e) => onChange(e.target.value)}
        className="flex-1 rounded-lg border border-transparent bg-slate-50 px-2.5 py-1.5 text-sm text-slate-800 focus:border-cyan-400 focus:bg-white focus:outline-none" />
      <span className={["shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide",
        isBoss ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-600"].join(" ")}>
        {node.nodeType}
      </span>
      <span className="shrink-0 text-xs text-slate-400 tabular-nums">+{node.xpReward} XP</span>
    </div>
  );
}

function StepSpine({
  intake, spineNodes, onSpineChange, onBack, onNext, loading, error,
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
          These are the major chapters and assessments. Edit any title before the AI builds lessons and enrichment branches around them.
        </p>
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        <span className="rounded-full bg-cyan-50 border border-cyan-200 px-3 py-1 text-cyan-800 font-medium">{intake.subject}</span>
        <span className="rounded-full bg-slate-100 border border-slate-200 px-3 py-1 text-slate-700 font-medium">Grade {intake.gradeLevel}</span>
        <span className="rounded-full bg-slate-100 border border-slate-200 px-3 py-1 text-slate-700 font-medium">{intake.courseLength}</span>
        <span className="rounded-full bg-amber-50 border border-amber-200 px-3 py-1 text-amber-800 font-medium">{totalXp.toLocaleString()} spine XP</span>
      </div>

      <div className="space-y-2 max-h-[50vh] overflow-y-auto pr-1">
        {spineNodes.map((n) => (
          <SpineNodeRow key={n.tempId} node={n} onChange={(title) => updateTitle(n.tempId, title)} />
        ))}
      </div>

      {error && <p className="rounded-xl bg-rose-50 border border-rose-200 px-4 py-2.5 text-sm text-rose-700">{error}</p>}

      <div className="flex items-center justify-between pt-2">
        <button type="button" onClick={onBack} disabled={loading}
          className="rounded-xl border border-slate-300 px-5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 transition">
          ← Back
        </button>
        <button type="button" onClick={onNext} disabled={loading || spineNodes.length === 0}
          className="rounded-xl bg-slate-900 px-6 py-2.5 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition flex items-center gap-2">
          {loading ? <><span className="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full" />Loading…</> : "Build Curriculum →"}
        </button>
      </div>
    </div>
  );
}

type BuildStage = "idle" | "lessons" | "branches" | "assignments" | "layout" | "done";
type ClusterProgress = { milestoneId: string; milestoneTitle: string; status: "pending" | "running" | "done" | "skipped"; nodeCount: number };
type RawNode = Omit<SpineNode, "isRequired"> & { isRequired: boolean };

function WebPreview({ nodes, edges }: { nodes: WebNode[]; edges: WebEdge[] }) {
  const nodeMap = new Map(nodes.map((n) => [n.tempId, n]));
  return (
    <div className="w-full overflow-auto rounded-xl border border-slate-800 bg-slate-950">
      <svg viewBox="0 0 1200 900" className="w-full" style={{ minWidth: 760, maxHeight: "55vh", display: "block" }}>
        {edges.map(({ source, target }, i) => {
          const src = nodeMap.get(source);
          const tgt = nodeMap.get(target);
          if (!src || !tgt) return null;
          return (
            <line key={i} x1={src.x} y1={src.y} x2={tgt.x} y2={tgt.y}
              stroke={tgt.cluster === "specialization" ? "#818cf8" : "#475569"}
              strokeWidth={tgt.cluster === "specialization" ? 1.5 : 1}
              strokeOpacity={0.45}
              strokeDasharray={tgt.nodeType === "elective" ? "5 3" : undefined} />
          );
        })}
        {nodes.map((node) => {
          const r = NODE_RADIUS[node.nodeType] ?? 18;
          const color = NODE_COLORS[node.colorRamp] ?? NODE_COLORS.blue;
          const isBoss = node.nodeType === "boss";
          const isMilestone = node.nodeType === "milestone";
          const shortTitle = node.title.length > 18 ? node.title.slice(0, 17) + "…" : node.title;
          return (
            <g key={node.tempId} transform={`translate(${node.x},${node.y})`}>
              {isBoss && <circle r={r + 8} fill={color.glow} />}
              {isMilestone && <circle r={r + 4} fill="none" stroke={color.fill} strokeWidth={1} strokeOpacity={0.35} />}
              <circle r={r} fill={color.fill} fillOpacity={node.cluster === "specialization" ? 0.82 : 1}
                stroke={isBoss ? "#fbbf24" : isMilestone ? "#fff" : "none"} strokeWidth={isBoss ? 2.5 : 1} />
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
  intake, prefs, spineNodes, onBack, onDone,
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
    const initialProgress: ClusterProgress[] = milestones.map((m) => ({ milestoneId: m.tempId, milestoneTitle: m.title, status: "pending", nodeCount: 0 }));
    setChapterProgress(initialProgress);

    const accumulated: RawNode[] = spineNodes.map((n) => ({ ...n, isRequired: n.isRequired ?? true }));

    for (let i = 0; i < milestones.length; i++) {
      const milestone = milestones[i];
      setChapterProgress((prev) => prev.map((p, idx) => idx === i ? { ...p, status: "running" } : p));
      try {
        const result = await wizardGenerateChapterCluster({
          data: {
            subject: intake.subject,
            gradeLevel: intake.gradeLevel,
            milestoneId: milestone.tempId,
            milestoneTitle: milestone.title,
            milestoneDescription: milestone.description,
            milestoneDepth: milestone.depth,
            existingTitles: accumulated.map((n) => n.title),
          },
        });
        const newNodes = (result.nodes as RawNode[]).map((n) => ({
          ...n,
          isRequired: n.isRequired ?? true,
          prerequisites: n.prerequisites.length > 0 ? n.prerequisites : [milestone.tempId],
        }));
        accumulated.push(...newNodes);
        setChapterProgress((prev) => prev.map((p, idx) => idx === i ? { ...p, status: "done", nodeCount: newNodes.length } : p));
      } catch {
        setChapterProgress((prev) => prev.map((p, idx) => idx === i ? { ...p, status: "skipped" } : p));
      }
    }
    setRawNodes([...accumulated]);
    return accumulated;
  }

  async function runStage3(accumulated: RawNode[]) {
    setStage("branches");
    const chapterLessons = accumulated.filter((n) => n.tempId.startsWith("ch_") && n.nodeType === "lesson");
    const lastByPrefix = new Map<string, RawNode>();
    for (const n of chapterLessons) {
      const prefix = n.tempId.replace(/_\d+$/, "");
      lastByPrefix.set(prefix, n);
    }
    const lastLessons = Array.from(lastByPrefix.values());
    const initProgress: ClusterProgress[] = lastLessons.map((n) => ({ milestoneId: n.tempId, milestoneTitle: n.title, status: "pending", nodeCount: 0 }));
    setBranchProgress(initProgress);

    for (let i = 0; i < lastLessons.length; i++) {
      const lesson = lastLessons[i];
      setBranchProgress((prev) => prev.map((p, idx) => idx === i ? { ...p, status: "running" } : p));
      try {
        const result = await wizardGenerateBranchCluster({
          data: {
            subject: intake.subject,
            gradeLevel: intake.gradeLevel,
            lessonId: lesson.tempId,
            lessonTitle: lesson.title,
            lessonDescription: lesson.description,
            lessonDepth: lesson.depth,
            milestoneTitle: lesson.title,
            existingTitles: accumulated.map((n) => n.title),
          },
        });
        const newNodes = (result.nodes as RawNode[]).map((n) => ({ ...n, isRequired: false }));
        accumulated.push(...newNodes);
        setBranchProgress((prev) => prev.map((p, idx) => idx === i ? { ...p, status: "done", nodeCount: newNodes.length } : p));
      } catch {
        setBranchProgress((prev) => prev.map((p, idx) => idx === i ? { ...p, status: "skipped" } : p));
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
          tempId: n.tempId, prerequisites: n.prerequisites, depth: n.depth, cluster: n.cluster, nodeType: n.nodeType,
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
    const initialProgress: ClusterProgress[] = accumulated.map((n) => ({ milestoneId: n.tempId, milestoneTitle: n.title, status: "pending", nodeCount: 0 }));
    setAssignmentProgress(initialProgress);
    const allAssignments: GeneratedAssignment[] = [];

    for (let i = 0; i < accumulated.length; i++) {
      const node = accumulated[i];
      setAssignmentProgress((prev) => prev.map((p, idx) => idx === i ? { ...p, status: "running" } : p));
      try {
        const result = await wizardGenerateAssignments({
          data: {
            subject: intake.subject,
            gradeLevel: intake.gradeLevel,
            prefs,
            node: { tempId: node.tempId, title: node.title, description: node.description, nodeType: node.nodeType },
          },
        });
        const newAssignments = result.assignments as GeneratedAssignment[];
        allAssignments.push(...newAssignments);
        setAssignmentProgress((prev) => prev.map((p, idx) => idx === i ? { ...p, status: "done", nodeCount: newAssignments.length } : p));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setAssignmentProgress((prev) => prev.map((p, idx) => idx === i ? { ...p, status: "skipped", milestoneTitle: `${prev[idx]?.milestoneTitle ?? ""} ✗ ${msg.slice(0, 50)}` } : p));
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
        <p className="mt-1 text-slate-500">The AI builds your skill web in stages. Watch it grow in real time.</p>
      </div>

      <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
        <p className="text-xs font-semibold text-slate-500 mb-2 uppercase tracking-wide">Spine — {milestones.length} milestones to expand</p>
        <div className="flex flex-wrap gap-1.5">
          {spineNodes.map((n) => {
            const color = NODE_COLORS[n.colorRamp] ?? NODE_COLORS.teal;
            return (
              <span key={n.tempId} className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium"
                style={{ backgroundColor: color.fill + "22", color: color.fill, border: `1px solid ${color.fill}55` }}>
                {n.icon} {n.title}
              </span>
            );
          })}
        </div>
      </div>

      {chapterProgress.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-slate-600 uppercase tracking-wide flex items-center gap-2">
            Stage 2 — Chapter Lessons
            {stage === "lessons" && <span className="inline-block w-3 h-3 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />}
            {lessonsDone === chapterProgress.length && <span className="text-emerald-600">✓ done</span>}
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
                <span className={p.status === "pending" ? "text-slate-400" : "text-slate-700"}>{p.milestoneTitle}</span>
                {p.status === "done" && <span className="text-xs text-slate-400">+{p.nodeCount} lessons</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {branchProgress.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-slate-600 uppercase tracking-wide flex items-center gap-2">
            Stage 3 — Enrichment Branches
            {stage === "branches" && <span className="inline-block w-3 h-3 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />}
            {branchesDone === branchProgress.length && <span className="text-emerald-600">✓ done</span>}
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
                <span className={p.status === "pending" ? "text-slate-400" : "text-slate-700"}>{p.milestoneTitle}</span>
                {p.status === "done" && <span className="text-xs text-slate-400">+{p.nodeCount} branches</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {assignmentProgress.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-slate-600 uppercase tracking-wide flex items-center gap-2">
            Stage 4 — Assignments &amp; Content
            {stage === "assignments" && <span className="inline-block w-3 h-3 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />}
            {assignmentProgress.every((p) => p.status === "done" || p.status === "skipped") && <span className="text-emerald-600">✓ done</span>}
          </p>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {assignmentProgress.map((p) => (
              <div key={p.milestoneId} className="flex items-center gap-2 text-sm">
                <span className="w-4 h-4 flex items-center justify-center shrink-0">
                  {p.status === "done" && <span className="text-emerald-500 text-xs">✓</span>}
                  {p.status === "running" && <span className="inline-block w-3 h-3 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />}
                  {p.status === "skipped" && <span className="text-slate-400 text-xs">—</span>}
                  {p.status === "pending" && <span className="text-slate-300 text-xs">·</span>}
                </span>
                <span className={p.status === "pending" ? "text-slate-400" : "text-slate-700"}>{p.milestoneTitle}</span>
                {p.status === "done" && <span className="text-xs text-slate-400">+{p.nodeCount}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {stage === "layout" && (
        <p className="text-sm text-slate-500 flex items-center gap-2">
          <span className="inline-block w-3 h-3 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
          Computing layout for {totalNodes} nodes…
        </p>
      )}

      {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}

      <div className="flex items-center justify-between pt-2">
        <button type="button" onClick={onBack} disabled={isRunning}
          className="rounded-xl border border-slate-300 px-5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 transition">
          ← Edit Spine
        </button>
        {stage === "idle" && (
          <button type="button" onClick={handleBuildLessons}
            className="rounded-xl bg-slate-900 px-6 py-2.5 text-sm font-semibold text-white hover:bg-slate-700 transition">
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

function StepConfirm({
  intake, webData, assignmentCount, onBack, onCommit, loading, error,
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
        <p className="mt-1 text-slate-500">We'll create the class, enrol the student, and build the full skill tree.</p>
      </div>

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

      <WebPreview nodes={webData.nodes as WebNode[]} edges={webData.edges} />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="block text-xs font-semibold text-slate-700 mb-1">Class Name <span className="text-rose-500">*</span></label>
          <input type="text" value={classTitle} onChange={(e) => setClassTitle(e.target.value)}
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none" />
        </div>
        <div className="sm:col-span-2">
          <label className="block text-xs font-semibold text-slate-700 mb-1">Skill Tree Title <span className="text-rose-500">*</span></label>
          <input type="text" value={treeTitle} onChange={(e) => setTreeTitle(e.target.value)}
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none" />
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">School Year</label>
          <input type="text" value={schoolYear} onChange={(e) => setSchoolYear(e.target.value)} placeholder="2025-2026"
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none" />
        </div>
      </div>

      {error && <p className="rounded-xl bg-rose-50 border border-rose-200 px-4 py-2.5 text-sm text-rose-700">{error}</p>}

      <div className="flex items-center justify-between pt-2">
        <button type="button" onClick={onBack} disabled={loading}
          className="rounded-xl border border-slate-300 px-5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 transition">
          ← Back
        </button>
        <button type="button" disabled={loading || !valid} onClick={() => onCommit(classTitle.trim(), treeTitle.trim(), schoolYear.trim())}
          className="rounded-xl bg-cyan-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-cyan-500 disabled:opacity-40 disabled:cursor-not-allowed transition flex items-center gap-2">
          {loading ? (
            <><span className="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full" />Creating curriculum…</>
          ) : "Create Curriculum ✦"}
        </button>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

function CurriculumBuilderPage() {
  const { profiles } = Route.useLoaderData();
  const router = useRouter();
  const { startJob } = useCurriculumProgress();

  const [wizardMode, setWizardMode] = useState<WizardMode | null>(null);

  // Curriculum mode state
  const [curriculumStep, setCurriculumStep] = useState<CurriculumWizardStep>("design");
  const [curriculumDesign, setCurriculumDesign] = useState<CurriculumDesignInput | null>(null);
  const [recommendedCourses, setRecommendedCourses] = useState<CourseSlot[]>([]);

  // Single course state
  const [singleStep, setSingleStep] = useState<SingleCourseLaunchStep>("design");
  const [singleCourseDesign, setSingleCourseDesign] = useState<SingleCourseDesignInput | null>(null);

  const [globalLoading, setGlobalLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState("");
  const [stepError, setStepError] = useState<string | null>(null);

  // ── Curriculum mode handlers ──────────────────────────────────────────────

  async function handleCurriculumDesign(design: CurriculumDesignInput) {
    setCurriculumDesign(design);
    setStepError(null);
    setGlobalLoading(true);
    setLoadingMessage("Generating recommended course list…");
    try {
      const result = await curriculumRecommendCourses({
        data: {
          gradeLevel: design.gradeLevel,
          ageYears: design.ageYears,
          duration: design.duration,
          courseCount: design.courseCount,
          focusSteering: design.focusSteering,
        },
      });

      const slots: CourseSlot[] = (result.courses as CourseRecommendation[]).map((c) => ({
        id: crypto.randomUUID(),
        name: c.name,
        subject: c.subject,
        description: c.description,
        courseLength: c.courseLength,
        approved: true,
      }));

      setRecommendedCourses(slots);
      setCurriculumStep("courses");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStepError(`Course recommendation failed: ${msg}. Please try again.`);
    } finally {
      setGlobalLoading(false);
    }
  }

  function handleLaunchCurriculum() {
    if (!curriculumDesign || recommendedCourses.length === 0) return;
    startJob(curriculumDesign, recommendedCourses);
    setCurriculumStep("launched");
  }

  // ── Single course handlers ────────────────────────────────────────────────

  function handleSingleCourseDesign(design: SingleCourseDesignInput) {
    setSingleCourseDesign(design);
    setStepError(null);
    setSingleStep("review");
  }

  function handleLaunchSingleCourse() {
    if (!singleCourseDesign) return;
    const singleCourse: CourseSlot = {
      id: crypto.randomUUID(),
      name: singleCourseDesign.courseTitle,
      subject: singleCourseDesign.subject,
      description: singleCourseDesign.courseDescription,
      courseLength: singleCourseDesign.duration,
      approved: true,
    };
    startJob(singleCourseDesign, [singleCourse]);
    setSingleStep("launched");
  }

  return (
    <>
      {globalLoading && <LoadingOverlay message={loadingMessage} />}

      <div className="mx-auto w-full max-w-6xl space-y-6">
        <ParentPageHeader
          title="Curriculum Builder"
          description="Launch full-curriculum or single-course builds with the same guided intake and background AI generation flow."
        />

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          {/* Mode selector */}
          {wizardMode === null && (
            <ModeSelector onSelect={setWizardMode} />
          )}

          {/* Curriculum mode */}
          {wizardMode === "curriculum" && curriculumStep === "design" && (
            <CurriculumDesignStep
              profiles={profiles as ProfileOption[]}
              onNext={handleCurriculumDesign}
              loading={globalLoading}
              error={stepError}
            />
          )}

          {wizardMode === "curriculum" && curriculumStep === "courses" && curriculumDesign && (
            <ApproveCourseListStep
              design={curriculumDesign}
              courses={recommendedCourses}
              setCourses={setRecommendedCourses}
              onBack={() => setCurriculumStep("design")}
              onLaunch={handleLaunchCurriculum}
            />
          )}

          {wizardMode === "curriculum" && curriculumStep === "launched" && (
            <LaunchedStep
              courseCount={recommendedCourses.length}
              onGoToDashboard={() => router.navigate({ to: "/" })}
            />
          )}

          {/* Single course mode */}
          {wizardMode === "single" && singleStep === "design" && (
            <SingleCourseDesignStep
              profiles={profiles as ProfileOption[]}
              onNext={handleSingleCourseDesign}
              loading={globalLoading}
              error={stepError}
            />
          )}

          {wizardMode === "single" && singleStep === "review" && singleCourseDesign && (
            <SingleCourseReviewStep
              design={singleCourseDesign}
              onBack={() => setSingleStep("design")}
              onLaunch={handleLaunchSingleCourse}
            />
          )}

          {wizardMode === "single" && singleStep === "launched" && singleCourseDesign && (
            <LaunchedStep
              courseCount={1}
              onGoToDashboard={() => router.navigate({ to: "/" })}
            />
          )}
        </div>

        {/* Back to mode select */}
        {wizardMode !== null && curriculumStep !== "launched" && (
          <div className="text-center">
            <button
              type="button"
              onClick={() => {
                setWizardMode(null);
                setCurriculumStep("design");
                setSingleStep("design");
                setSingleCourseDesign(null);
                setStepError(null);
              }}
              className="text-xs text-slate-400 transition hover:text-slate-600"
            >
              ← Start over
            </button>
          </div>
        )}
        </div>
    </>
  );
}
