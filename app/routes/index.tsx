import { useState } from "react";
import { Link, createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { PostLoginRoleModal } from "../components/post-login-role-modal";
import { ParentDashboard } from "../components/parent-dashboard";
import {
  completePostLoginRoleSelection,
  getParentDashboardData,
  getStudentSelectionOptions,
  getViewerContext,
  loginAsParent,
  logoutSession,
} from "../server/functions";
import { OrcaMark } from "../components/icons/orca-mark";

export const Route = createFileRoute("/")({
  component: IndexRoute,
  loader: async () => {
    const viewer = await getViewerContext();

    if (viewer.isAuthenticated) {
      if (viewer.activeRole === "student") {
        throw redirect({ to: "/student" });
      }
      const parentDashboard = await getParentDashboardData();
      return {
        isAuthenticated: true,
        parentDashboard,
        isAdminParent: viewer.isAdminParent ?? false,
      };
    }

    return { isAuthenticated: false, parentDashboard: null, isAdminParent: false };
  },
});

function IndexRoute() {
  const data = Route.useLoaderData();

  if (data.isAuthenticated && data.parentDashboard) {
    return (
      <ParentDashboard
        parentDashboard={data.parentDashboard}
        isAdminParent={data.isAdminParent}
      />
    );
  }

  return <LandingPage />;
}

// ── Landing page (public / unauthenticated) ───────────────────────────────────

const FEATURES = [
  {
    title: "AI Curriculum Builder",
    description:
      "Launch a full multi-course curriculum or a single course flow, then let AI generate the spine, branches, layout, and assignments in the background.",
    accentClass: "border-cyan-200 bg-cyan-50/80 text-cyan-900",
    iconClass: "bg-cyan-100 text-cyan-700",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6" aria-hidden="true">
        <path
          d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M8 10h.01M12 10h.01M16 10h.01"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    title: "Skill Maps + Builder Mode",
    description:
      "Build node-based learning paths with lesson, milestone, boss, branch, and elective nodes. Parents can auto-layout, AI-expand, and auto-populate content per node.",
    accentClass: "border-violet-200 bg-violet-50/80 text-violet-900",
    iconClass: "bg-violet-100 text-violet-700",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6" aria-hidden="true">
        <circle cx="12" cy="5" r="2.5" stroke="currentColor" strokeWidth="1.8" />
        <circle cx="5" cy="16" r="2.5" stroke="currentColor" strokeWidth="1.8" />
        <circle cx="19" cy="16" r="2.5" stroke="currentColor" strokeWidth="1.8" />
        <path
          d="M12 7.5L5 13.5M12 7.5L19 13.5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    title: "Assignment Studio",
    description:
      "Create text, file, URL, video, quiz, essay, report, and movie assignments. Generate linked quizzes from readings or saved video transcripts when available.",
    accentClass: "border-emerald-200 bg-emerald-50/80 text-emerald-900",
    iconClass: "bg-emerald-100 text-emerald-700",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6" aria-hidden="true">
        <path
          d="M9 11h6M9 15h3M5 3h14a2 2 0 0 1 2 2v14l-4-2-4 2-4-2-4 2V5a2 2 0 0 1 2-2Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M14 7l1.5 1.5L18 6"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    title: "Week Planner",
    description:
      "Schedule with drag-and-drop across a 4–7 day week. Pull from recommended skill-map assignments or the pending pool, then save or auto-generate a full week plan.",
    accentClass: "border-sky-200 bg-sky-50/80 text-sky-900",
    iconClass: "bg-sky-100 text-sky-700",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6" aria-hidden="true">
        <path
          d="M7 3v2m10-2v2M4 9h16M6 6h12a2 2 0 0 1 2 2v10H4V8a2 2 0 0 1 2-2Zm3 6h2m4 0h2m-8 3h2m4 0h2"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    title: "Gradebook + Release Flow",
    description:
      "Filter and sort submissions, export CSV, auto-score quizzes, use AI scoring for written work, and release graded results back to students.",
    accentClass: "border-amber-200 bg-amber-50/80 text-amber-900",
    iconClass: "bg-amber-100 text-amber-700",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6" aria-hidden="true">
        <path
          d="M6 4h12a2 2 0 0 1 2 2v12H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm0 0v14m5-9h5m-5 4h5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    title: "Reward Tracks",
    description:
      "Track XP snapshots from skill-map progress and auto-unlock claimable tiers. Students claim rewards, parents deliver them, and pending claims stay visible in-app.",
    accentClass: "border-amber-200 bg-amber-50/80 text-amber-900",
    iconClass: "bg-amber-100 text-amber-700",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6" aria-hidden="true">
        <path
          d="M20 12V7a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v5m16 0H4m16 0v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M12 6V4m0 0a2 2 0 0 0-2-2 2 2 0 0 0 0 4h4a2 2 0 0 0 0-4 2 2 0 0 0-2 2Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    title: "Home Pod + Role Switching",
    description:
      "Support multi-family organizations with parent admin controls, plus quick parent/student workspace switching with profile selection and PIN confirmation.",
    accentClass: "border-rose-200 bg-rose-50/80 text-rose-900",
    iconClass: "bg-rose-100 text-rose-700",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6" aria-hidden="true">
        <path
          d="M3 12l9-9 9 9M5 10v9a1 1 0 0 0 1 1h4v-5h4v5h4a1 1 0 0 0 1-1v-9"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    title: "Student Workspace",
    description:
      "Give students a focused dashboard with assignments, submission flow, today’s plan, skill-map progress, and reward-track claiming in one place.",
    accentClass: "border-indigo-200 bg-indigo-50/80 text-indigo-900",
    iconClass: "bg-indigo-100 text-indigo-700",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6" aria-hidden="true">
        <path
          d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    title: "Templates",
    description:
      "Save strong assignment setups as templates and quickly reuse them across classes to keep planning consistent and fast.",
    accentClass: "border-slate-200 bg-slate-50/80 text-slate-900",
    iconClass: "bg-slate-200 text-slate-700",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6" aria-hidden="true">
        <path
          d="M4 5a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M8 11h8M8 14h5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
] as const;

const HOW_IT_WORKS = [
  {
    step: "1",
    title: "Create your workspace",
    description:
      "Set up students, classes, school year settings, timezone, and weekly school-day count.",
  },
  {
    step: "2",
    title: "Generate curriculum and assignments",
    description:
      "Use AI builder and assignment tools to create course structures, skill maps, and linked learning activities.",
  },
  {
    step: "3",
    title: "Schedule and run the week",
    description:
      "Drag assignments into the planner or auto-generate a week, then track daily progress in student view.",
  },
  {
    step: "4",
    title: "Grade, release, and reward",
    description:
      "Review submissions, publish results, and let XP progress unlock reward-track tiers students can claim.",
  },
] as const;

// ── Login panel (used in the landing page header) ─────────────────────────────

function HeaderLoginPanel() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [roleModalOpen, setRoleModalOpen] = useState(false);
  const [roleModalError, setRoleModalError] = useState<string | null>(null);
  const [roleModalLoading, setRoleModalLoading] = useState(false);
  const [profiles, setProfiles] = useState<Array<{
    id: string;
    displayName: string;
    gradeLevel: string | null;
  }>>([]);

  const submit = async () => {
    setError(null);
    if (!username.trim()) { setError("Enter your username."); return; }
    if (!password.trim()) { setError("Enter your password."); return; }
    setLoading(true);
    try {
      await loginAsParent({ data: { username: username.trim().toLowerCase(), password: password.trim() } });
      const options = await getStudentSelectionOptions();
      setProfiles(options.profiles);
      setRoleModalError(null);
      setRoleModalOpen(true);
      setOpen(false);
    } catch {
      setError("Invalid username or password.");
    } finally {
      setLoading(false);
    }
  };

  const submitDemo = async () => {
    setError(null);
    setLoading(true);
    try {
      await loginAsParent({ data: { username: "demo", password: "demo1234" } });
      const options = await getStudentSelectionOptions();
      setProfiles(options.profiles);
      setRoleModalError(null);
      setRoleModalOpen(true);
      setOpen(false);
    } catch {
      setError("Demo account not available. Seed it from Settings → Content Controls.");
    } finally {
      setLoading(false);
    }
  };

  const handleParentSelection = async (pin: string) => {
    setRoleModalError(null);
    setRoleModalLoading(true);
    try {
      await completePostLoginRoleSelection({
        data: {
          mode: "parent",
          parentPin: pin,
        },
      });
      await navigate({ to: "/" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      setRoleModalError(
        message === "INVALID_PIN"
          ? "Incorrect parent PIN."
          : "Could not continue to parent dashboard.",
      );
      setRoleModalLoading(false);
    }
  };

  const handleStudentSelection = async (profileId: string, pin: string) => {
    setRoleModalError(null);
    setRoleModalLoading(true);
    try {
      await completePostLoginRoleSelection({
        data: {
          mode: "student",
          profileId,
          studentPin: pin,
        },
      });
      await navigate({ to: "/student" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (message === "INVALID_PIN") {
        setRoleModalError("Incorrect student PIN.");
      } else if (message === "FORBIDDEN") {
        setRoleModalError("Selected student is unavailable.");
      } else {
        setRoleModalError("Could not continue to student dashboard.");
      }
      setRoleModalLoading(false);
    }
  };

  const handleRoleModalCancel = async () => {
    setRoleModalError(null);
    setRoleModalLoading(true);
    try {
      await logoutSession();
    } catch {
      // Ignore logout errors; still force login page refresh.
    } finally {
      setRoleModalOpen(false);
      setRoleModalLoading(false);
      await navigate({ to: "/login" });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") void submit();
    if (e.key === "Escape") setOpen(false);
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 transition"
      >
        Sign In / Demo
      </button>

      {open ? (
        <>
          {/* backdrop */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          {/* dropdown panel */}
          <div className="absolute right-0 top-full z-50 mt-2 w-72 rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-700">
              Parent Login
            </p>
            <div className="mt-3 space-y-3">
              <label className="block space-y-1">
                <span className="text-xs font-medium text-slate-700">Username</span>
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  onKeyDown={handleKeyDown}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                  placeholder="your_username"
                  autoComplete="username"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs font-medium text-slate-700">Password</span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={handleKeyDown}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                  placeholder="••••••••"
                  autoComplete="current-password"
                />
              </label>
            </div>
            <button
              onClick={() => void submit()}
              disabled={loading}
              className="mt-4 w-full rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60 transition"
            >
              {loading ? "Signing in…" : "Sign In"}
            </button>
            <button
              type="button"
              onClick={() => void submitDemo()}
              disabled={loading}
              className="mt-2 w-full rounded-xl border border-cyan-300 bg-cyan-50 px-4 py-2 text-sm font-medium text-cyan-700 hover:bg-cyan-100 disabled:opacity-60 transition"
            >
              Try Demo Account
            </button>
            <p className="mt-1 text-center text-xs text-slate-500">
              Demo parent PIN: <strong>1234</strong>
            </p>
            {error ? (
              <p className="mt-2 text-xs font-medium text-rose-700">{error}</p>
            ) : null}
          </div>
        </>
      ) : null}

      <PostLoginRoleModal
        open={roleModalOpen}
        profiles={profiles}
        loading={roleModalLoading}
        error={roleModalError}
        onCancel={() => {
          void handleRoleModalCancel();
        }}
        onConfirmParent={(pin) => {
          void handleParentSelection(pin);
        }}
        onConfirmStudent={(profileId, pin) => {
          void handleStudentSelection(profileId, pin);
        }}
      />
    </div>
  );
}

// ── Landing page sections ─────────────────────────────────────────────────────

function LandingHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        {/* Logo */}
        <div className="flex items-center gap-2">
          <span className="orca-icon-chip" aria-hidden="true">
            <OrcaMark className="h-6 w-6" alt="" />
          </span>
          <div>
            <p className="text-xs uppercase tracking-[0.25em] text-cyan-700 leading-none">
              Project Orca
            </p>
            <p className="text-lg font-semibold text-slate-900 leading-tight">ProOrca</p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3">
          <HeaderLoginPanel />
        </div>
      </div>
    </header>
  );
}

function HeroSection() {
  return (
    <section className="orca-hero orca-wave relative overflow-hidden border-b border-slate-200 px-4 py-20 text-center sm:py-28 sm:px-6">
      <div className="relative mx-auto max-w-3xl">
        <span className="orca-icon-chip mx-auto mb-6 flex w-fit" aria-hidden="true">
          <OrcaMark className="h-10 w-10" alt="" />
        </span>
        <p className="text-sm font-semibold uppercase tracking-[0.25em] text-cyan-700">
          Project Orca — ProOrca
        </p>
        <h1 className="mt-3 text-4xl font-bold tracking-tight text-slate-900 sm:text-5xl">
          Your homeschool,{" "}
          <span
            style={{
              background: "linear-gradient(120deg, var(--orca-sea), var(--orca-sea-bright))",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
            }}
          >
            powered by AI
          </span>
        </h1>
        <p className="mx-auto mt-5 max-w-xl text-lg text-slate-600">
          ProOrca is an edge-native homeschool command center built for parents who want
          intelligent lesson planning, gamified skill progression, and everything in one place.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link
            to="/login"
            className="rounded-xl border border-cyan-300 bg-cyan-50 px-6 py-3 text-sm font-semibold text-cyan-700 hover:bg-cyan-100 transition shadow-sm"
          >
            Try Demo Account
          </Link>
          <Link
            to="/login"
            className="rounded-xl border border-slate-300 bg-white px-6 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 transition"
          >
            Sign In
          </Link>
        </div>
        <p className="mt-2 text-xs text-slate-500">Demo parent PIN: <strong>1234</strong></p>
      </div>
    </section>
  );
}

function AiSpotlightSection() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
      <div className="grid gap-12 lg:grid-cols-2 lg:gap-16 lg:items-center">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-cyan-700">
            AI Workspace
          </p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-900">
            Builder, planner chat, and assignment generation in one flow
          </h2>
          <p className="mt-4 text-slate-600 leading-relaxed">
            ProOrca supports both guided curriculum generation and chat-driven planning. Start from
            grade, subject, duration, and preferences, then generate structure and assignments that
            are ready to schedule.
          </p>
          <ul className="mt-6 space-y-3">
            {[
              "Full curriculum mode and single-course mode",
              "Assignment recipe controls (videos, quizzes, essays, reports)",
              "Chat suggestions can jump directly into Assignments",
              "Quiz generation from readings and saved video transcript context",
            ].map((item) => (
              <li key={item} className="flex items-start gap-3 text-sm text-slate-700">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-cyan-100 text-cyan-700">
                  <svg viewBox="0 0 16 16" fill="none" className="h-3 w-3" aria-hidden="true">
                    <path
                      d="M3 8l3.5 3.5L13 4"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                {item}
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white/90 p-5 shadow-sm">
          <div className="flex items-center gap-2 border-b border-slate-100 pb-3 mb-4">
            <span className="orca-icon-chip" aria-hidden="true">
              <OrcaMark className="h-5 w-5" alt="" />
            </span>
            <p className="text-sm font-semibold text-slate-900">Lesson Planner Chat</p>
            <span className="ml-auto rounded-full bg-cyan-50 px-2 py-0.5 text-xs font-medium text-cyan-700">
              Suggestion Ready
            </span>
          </div>
          <div className="space-y-3">
            <div className="flex gap-3">
              <div className="h-7 w-7 shrink-0 rounded-full bg-slate-100 flex items-center justify-center text-xs font-bold text-slate-500">
                P
              </div>
              <div className="rounded-2xl rounded-tl-none bg-slate-100 px-4 py-2.5 text-sm text-slate-700 max-w-[85%]">
                Suggest a grade 6 history assignment and include one quiz checkpoint.
              </div>
            </div>
            <div className="flex gap-3 flex-row-reverse">
              <span className="orca-icon-chip h-7 w-7 shrink-0" aria-hidden="true">
                <OrcaMark className="h-4 w-4" alt="" />
              </span>
              <div className="rounded-2xl rounded-tr-none border border-cyan-200 bg-cyan-50/80 px-4 py-2.5 text-sm text-cyan-900 max-w-[85%]">
                <p className="font-medium">ASSIGNMENT_SUGGESTION</p>
                <p className="mt-1 text-xs text-cyan-700">
                  title="Check for Understanding: Ancient Trade Networks"
                </p>
                <p className="mt-1 text-xs text-cyan-700">
                  type=quiz description="Complete a short 5-question checkpoint."
                </p>
                <button
                  className="mt-2 rounded-lg bg-slate-900 px-3 py-1 text-xs font-medium text-white opacity-80"
                  tabIndex={-1}
                  aria-hidden="true"
                >
                  + Add to Assignments
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function SkillTreeSpotlightSection() {
  const statusFill: Record<string, string> = {
    locked: "#d3d1c7",
    available: "#378add",
    in_progress: "#7f77dd",
    complete: "#1d9e75",
    mastery: "#ef9f27",
  };

  const nodes = [
    { id: "n1", label: "Climate Zones", type: "lesson", status: "mastery", x: 170, y: 70, r: 18, icon: "C", xp: 120 },
    { id: "n2", label: "Atmosphere", type: "milestone", status: "complete", x: 90, y: 138, r: 24, icon: "A", xp: 220 },
    { id: "n3", label: "Ocean Currents", type: "branch", status: "in_progress", x: 258, y: 140, r: 18, icon: "O", xp: 160 },
    { id: "n4", label: "Storm Lab", type: "elective", status: "available", x: 54, y: 226, r: 14, icon: "S", xp: 140 },
    { id: "n5", label: "Forecast Models", type: "lesson", status: "locked", x: 170, y: 228, r: 18, icon: "F", xp: 180 },
    { id: "n6", label: "Climate Systems", type: "boss", status: "locked", x: 262, y: 268, r: 24, icon: "★", xp: 420 },
  ] as const;

  const edgeStyle = {
    required: { stroke: "#378add", width: 3.5, dash: undefined },
    optional: { stroke: "#7f77dd", width: 2, dash: "9 5" },
    bonus: { stroke: "#d3d1c7", width: 1.5, dash: "4 5" },
  } as const;

  return (
    <section className="border-y border-slate-200 bg-slate-50/70 py-20">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="grid gap-12 lg:grid-cols-2 lg:gap-16 lg:items-center">
          <div className="order-2 lg:order-1">
            <div className="relative rounded-2xl border border-slate-200 bg-white/90 p-3 shadow-sm overflow-hidden">
              <div className="absolute left-3 top-3 rounded-lg border border-slate-200 bg-white/95 px-2 py-1 text-[10px] text-slate-600">
                Builder Mode · E edit · C connect · N new node
              </div>
              <svg viewBox="0 0 320 320" className="mt-6 h-[300px] w-full" aria-hidden="true">
                <line x1="170" y1="70" x2="90" y2="138" stroke={edgeStyle.required.stroke} strokeWidth={edgeStyle.required.width} />
                <line x1="170" y1="70" x2="258" y2="140" stroke={edgeStyle.optional.stroke} strokeWidth={edgeStyle.optional.width} strokeDasharray={edgeStyle.optional.dash} />
                <line x1="90" y1="138" x2="54" y2="226" stroke={edgeStyle.bonus.stroke} strokeWidth={edgeStyle.bonus.width} strokeDasharray={edgeStyle.bonus.dash} />
                <line x1="258" y1="140" x2="170" y2="228" stroke={edgeStyle.bonus.stroke} strokeWidth={edgeStyle.bonus.width} strokeDasharray={edgeStyle.bonus.dash} />
                <line x1="258" y1="140" x2="262" y2="268" stroke={edgeStyle.bonus.stroke} strokeWidth={edgeStyle.bonus.width} strokeDasharray={edgeStyle.bonus.dash} />

                {nodes.map((node) => {
                  if (node.type === "milestone") {
                    const points = "90,112 112,125 112,151 90,164 68,151 68,125";
                    return (
                      <g key={node.id}>
                        <polygon points={points} fill={statusFill[node.status]} stroke="#378add" strokeWidth="3" />
                        <path d="M81 139 L88 146 L100 131" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" />
                        <text x="90" y="179" textAnchor="middle" className="fill-slate-600 text-[10px]">{node.label} · {node.xp} XP</text>
                      </g>
                    );
                  }
                  if (node.type === "boss") {
                    const points = "262,244 286,268 262,292 238,268";
                    return (
                      <g key={node.id}>
                        <polygon points={points} fill={statusFill[node.status]} stroke="#378add" strokeWidth="3" fillOpacity="0.35" />
                        <text x="262" y="268" textAnchor="middle" dominantBaseline="central" className="fill-white text-[14px]">★</text>
                        <text x="262" y="304" textAnchor="middle" className="fill-slate-600 text-[10px]">{node.label} · {node.xp} XP</text>
                      </g>
                    );
                  }
                  return (
                    <g key={node.id}>
                      <circle cx={node.x} cy={node.y} r={node.r + (node.status === "available" ? 6 : 0)} fill="none" stroke="#378add" strokeWidth="1.5" opacity={node.status === "available" ? "0.4" : "0"} />
                      <circle cx={node.x} cy={node.y} r={node.r} fill={statusFill[node.status]} fillOpacity={node.status === "locked" ? "0.35" : "1"} stroke="#378add" strokeWidth={node.status === "mastery" ? "3" : "2"} />
                      {node.status === "mastery" || node.status === "complete" ? (
                        <path d={`M ${node.x - 6} ${node.y} L ${node.x - 2} ${node.y + 5} L ${node.x + 8} ${node.y - 6}`} fill="none" stroke="white" strokeWidth="2.4" strokeLinecap="round" />
                      ) : (
                        <text x={node.x} y={node.y} textAnchor="middle" dominantBaseline="central" className="fill-white text-[11px] font-semibold">{node.icon}</text>
                      )}
                      <text x={node.x} y={node.y + node.r + 16} textAnchor="middle" className="fill-slate-600 text-[10px]">{node.label} · {node.xp} XP</text>
                    </g>
                  );
                })}
              </svg>

              <div className="absolute bottom-3 right-3 flex flex-col gap-1 rounded-xl border border-slate-200 bg-white/90 p-2 text-xs shadow-sm">
                {[
                  { label: "Mastery", dot: "bg-amber-400" },
                  { label: "Complete", dot: "bg-emerald-400" },
                  { label: "In Progress", dot: "bg-violet-500" },
                  { label: "Available", dot: "bg-blue-500" },
                  { label: "Locked", dot: "bg-stone-400" },
                ].map((item) => (
                  <div key={item.label} className="flex items-center gap-1.5 text-slate-600">
                    <span className={`h-2 w-2 rounded-full ${item.dot}`} aria-hidden="true" />
                    {item.label}
                  </div>
                ))}
              </div>

            </div>
          </div>

          <div className="order-1 lg:order-2">
            <p className="text-xs font-semibold uppercase tracking-[0.25em] text-violet-700">
              Skill Maps
            </p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-900">
              Visual progression with builder controls and student-state tracking
            </h2>
            <p className="mt-4 text-slate-600 leading-relaxed">
              Parent view and student view share the same map with role-specific tools. Parents can
              edit structure, connect dependencies, and link assignments. Students see progress
              state changes and XP-driven momentum.
            </p>
            <ul className="mt-6 space-y-3">
              {[
                "Statuses: locked, available, in progress, complete, mastery",
                "Node types: lesson, milestone, boss, branch, elective",
                "Zoom controls, minimap, viewport save, and keyboard shortcuts",
                "Node completion unlocks downstream paths and updates XP",
              ].map((item) => (
                <li key={item} className="flex items-start gap-3 text-sm text-slate-700">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-violet-100 text-violet-700">
                    <svg viewBox="0 0 16 16" fill="none" className="h-3 w-3" aria-hidden="true">
                      <path
                        d="M3 8l3.5 3.5L13 4"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

function PlannerSpotlightSection() {
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri"] as const;

  return (
    <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
      <div className="grid gap-12 lg:grid-cols-2 lg:gap-16 lg:items-center">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-sky-700">
            Week Planner
          </p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-900">
            Drag, auto-plan, and save a realistic school week
          </h2>
          <p className="mt-4 text-slate-600 leading-relaxed">
            The planner combines recommended assignments from active skill-map nodes with the full
            pending assignment pool. Place items manually with drag-and-drop, or generate a week
            automatically and then tweak before saving.
          </p>
          <ul className="mt-6 space-y-3">
            {[
              "Supports 4, 5, 6, or 7-day school weeks from settings",
              "Profile-specific schedule with timezone-aware week range",
              "Recommended panel + all pending pool in the same workspace",
              "Save current layout or regenerate a full plan with AI",
            ].map((item) => (
              <li key={item} className="flex items-start gap-3 text-sm text-slate-700">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-sky-100 text-sky-700">
                  <svg viewBox="0 0 16 16" fill="none" className="h-3 w-3" aria-hidden="true">
                    <path
                      d="M3 8l3.5 3.5L13 4"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                {item}
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
            <div className="flex min-w-0 items-center gap-2">
              <span aria-hidden="true">🗓️</span>
              <p className="truncate text-sm font-semibold text-slate-800">Week Planner · Grade 6</p>
            </div>
            <span className="shrink-0 rounded-full border border-cyan-200 bg-cyan-50 px-2.5 py-0.5 text-xs font-semibold text-cyan-700">
              5-day week
            </span>
          </div>

          <div className="mt-3 space-y-3">
            <div className="grid grid-cols-5 gap-1.5">
              {days.map((day, i) => (
                <div
                  key={day}
                  className={`flex min-h-[116px] flex-col rounded-xl border p-2 ${i === 2 ? "border-cyan-300 bg-cyan-50/30" : "border-slate-200 bg-white/80"}`}
                >
                  <div className="flex items-center justify-between border-b border-slate-100 pb-1">
                    <p className={`text-[10px] font-semibold uppercase tracking-wide ${i === 2 ? "text-cyan-700" : "text-slate-500"}`}>{day}</p>
                    {i === 2 ? (
                      <span className="rounded-full bg-cyan-600 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white">
                        Today
                      </span>
                    ) : null}
                  </div>
                  {i === 0 ? (
                    <div className="mt-1.5 rounded-md border border-slate-200 bg-slate-50 px-1.5 py-1 text-[10px] text-slate-700">
                      Reading
                    </div>
                  ) : null}
                  {i === 2 ? (
                    <div className="mt-1.5 rounded-md border border-rose-200 bg-rose-50 px-1.5 py-1 text-[10px] text-rose-900">
                      Quiz
                    </div>
                  ) : null}
                  {i === 4 ? (
                    <div className="mt-1.5 rounded-md border border-violet-200 bg-violet-50 px-1.5 py-1 text-[10px] text-violet-900">
                      Essay
                    </div>
                  ) : null}
                  {i === 1 || i === 3 ? (
                    <p className="mt-2 text-[11px] text-slate-400 italic">Drop here</p>
                  ) : null}
                </div>
              ))}
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white/90 shadow-sm overflow-hidden">
              <div className="px-3 py-2 border-b border-slate-100 flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-cyan-500 animate-pulse" />
                <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">In Progress</span>
                <span className="text-slate-300 text-xs">·</span>
                <p className="text-xs font-semibold text-slate-800 truncate">Earth Science</p>
                <span className="text-[10px] text-slate-400 ml-auto">Lesson</span>
              </div>
              <div className="px-3 py-1.5 bg-slate-50/60 border-b border-slate-100">
                <p className="text-[10px] text-slate-400 uppercase tracking-wide font-medium">Node</p>
                <p className="text-xs font-semibold text-slate-600 truncate">Atmosphere Systems</p>
              </div>
              <div className="p-2 grid gap-2 sm:grid-cols-3">
                <div className="group rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-left text-rose-800">
                  <p className="text-[10px] font-semibold uppercase tracking-wide opacity-60">Quiz</p>
                  <p className="mt-0.5 text-xs font-medium leading-tight">Atmospheric Pressure Check</p>
                  <p className="mt-0.5 text-[10px] opacity-50 truncate">Earth Science</p>
                </div>
                <div className="group rounded-xl border border-cyan-200 bg-cyan-50 px-3 py-2 text-left text-cyan-800">
                  <p className="text-[10px] font-semibold uppercase tracking-wide opacity-60">Video</p>
                  <p className="mt-0.5 text-xs font-medium leading-tight">Jet Stream Demonstration</p>
                  <p className="mt-0.5 text-[10px] opacity-50 truncate">Earth Science</p>
                </div>
                <div className="group rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 text-left text-violet-800">
                  <p className="text-[10px] font-semibold uppercase tracking-wide opacity-60">Essay</p>
                  <p className="mt-0.5 text-xs font-medium leading-tight">Explain Global Wind Belts</p>
                  <p className="mt-0.5 text-[10px] opacity-50 truncate">Earth Science</p>
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white/90 px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">All Assignments Pool</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <span className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[10px] text-slate-700">Reading · Air Masses</span>
                <span className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[10px] text-slate-700">Quiz · Wind Patterns</span>
                <span className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[10px] text-slate-700">Report · Local Climate</span>
              </div>
            </div>
          </div>

          <p className="mt-3 text-xs text-slate-500">
            Recommended and pool items can both be dragged into calendar slots before save.
          </p>
        </div>
      </div>
    </section>
  );
}

function ProgressSpotlightSection() {
  const tiers = [
    { icon: "🍦", label: "Tier 1", status: "delivered" },
    { icon: "🎮", label: "Tier 2", status: "claimed" },
    { icon: "🎨", label: "Tier 3", status: "unlocked" },
    { icon: "🏕️", label: "Tier 4", status: "locked" },
  ] as const;

  const tierStyle: Record<string, string> = {
    delivered: "border-amber-500 text-white",
    claimed: "border-violet-400 bg-violet-100 text-violet-900",
    unlocked: "border-cyan-400 bg-white text-slate-800",
    locked: "border-slate-200 bg-slate-100/80 text-slate-400",
  };

  return (
    <section className="border-y border-slate-200 bg-slate-50/70 py-20">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="grid gap-12 lg:grid-cols-2 lg:gap-16 lg:items-center">
          <div className="order-2 lg:order-1 space-y-4">
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Gradebook</p>
              <div className="mt-2 overflow-hidden rounded-lg border border-slate-200">
                <div className="grid grid-cols-[1.2fr_.9fr_.8fr_.8fr] bg-slate-50 px-2 py-1.5 text-[10px] font-semibold text-slate-500">
                  <span>Student</span><span>Assignment</span><span>Score</span><span>Status</span>
                </div>
                <div className="grid grid-cols-[1.2fr_.9fr_.8fr_.8fr] px-2 py-1.5 text-[10px] text-slate-700">
                  <span>Maya</span><span>Atmosphere Quiz</span><span><span className="inline-block rounded px-1.5 py-0.5 bg-emerald-50 text-emerald-800 font-semibold">92/100</span></span><span>released</span>
                </div>
                <div className="grid grid-cols-[1.2fr_.9fr_.8fr_.8fr] border-t border-slate-100 px-2 py-1.5 text-[10px] text-slate-700">
                  <span>Leo</span><span>Wind Belt Essay</span><span><span className="inline-block rounded px-1.5 py-0.5 bg-amber-50 text-amber-800 font-semibold">Needs grade</span></span><span>submitted</span>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-violet-200/60 bg-gradient-to-br from-slate-900 via-violet-950 to-indigo-950 p-4 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-wide text-violet-400">Reward Track</p>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-800">
                <div className="h-full w-[38%] rounded-full bg-gradient-to-r from-cyan-500 to-violet-500" />
              </div>
              <div className="mt-1 text-[10px] text-violet-200">1,580 / 5,000 XP</div>
              <div className="mt-3 flex gap-2">
                {tiers.map((tier) => (
                  <div
                    key={tier.label}
                    className={`w-16 rounded-lg border px-1 py-1.5 text-center text-[10px] ${tierStyle[tier.status]} ${tier.status === "delivered" ? "bg-gradient-to-br from-amber-400 to-amber-600" : ""}`}
                  >
                    <div className="text-base leading-none">{tier.icon}</div>
                    <div className="mt-1">{tier.label}</div>
                    {tier.status === "claimed" ? <div className="mt-0.5 text-[9px] text-violet-700">Pending…</div> : null}
                    {tier.status === "unlocked" ? <div className="mt-0.5 text-[9px] text-cyan-600">Claim!</div> : null}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="order-1 lg:order-2">
            <p className="text-xs font-semibold uppercase tracking-[0.25em] text-amber-600">
              Outcomes
            </p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-900">
              Grade, release, and reward without leaving the platform
            </h2>
            <p className="mt-4 text-slate-600 leading-relaxed">
              Quiz submissions can be auto-scored instantly, written responses can be scored with
              AI assistance, and parents control when graded work is released to students. XP then
              drives reward-track unlocks and claim/delivery workflows.
            </p>
            <ul className="mt-6 space-y-3">
              {[
                "Gradebook filters, sorting, and CSV export",
                "AI scoring for written submissions with strengths and improvements",
                "Student claim flow + parent delivery confirmation",
                "Pending reward badges surfaced in parent navigation",
              ].map((item) => (
                <li key={item} className="flex items-start gap-3 text-sm text-slate-700">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700">
                    <svg viewBox="0 0 16 16" fill="none" className="h-3 w-3" aria-hidden="true">
                      <path
                        d="M3 8l3.5 3.5L13 4"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

function FeaturesGrid() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
      <div className="text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.25em] text-cyan-700">
          Everything You Need
        </p>
        <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-900">
          Built for how homeschools actually work
        </h2>
        <p className="mx-auto mt-3 max-w-lg text-slate-600">
          Every tool in ProOrca is designed around the real workflow of a homeschool parent—not
          a classroom teacher.
        </p>
      </div>

      <div className="mt-10 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {FEATURES.map((feature) => (
          <div
            key={feature.title}
            className={`rounded-2xl border p-5 ${feature.accentClass}`}
          >
            <div className={`inline-flex rounded-xl p-2.5 ${feature.iconClass}`}>
              {feature.icon}
            </div>
            <h3 className="mt-4 text-base font-semibold">{feature.title}</h3>
            <p className="mt-1.5 text-sm leading-relaxed opacity-90">{feature.description}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function HowItWorksSection() {
  return (
    <section className="border-t border-slate-200 bg-slate-50/70 py-20">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-cyan-700">
            Getting Started
          </p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-900">
            Up and running in minutes
          </h2>
        </div>
        <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {HOW_IT_WORKS.map((item) => (
            <div key={item.step} className="rounded-2xl border border-slate-200 bg-white/90 p-5 shadow-sm">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-slate-900 text-sm font-bold text-white">
                {item.step}
              </div>
              <h3 className="mt-4 font-semibold text-slate-900">{item.title}</h3>
              <p className="mt-1.5 text-sm text-slate-600 leading-relaxed">{item.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function CtaSection() {
  return (
    <section className="orca-hero orca-wave border-t border-slate-200 py-20 text-center px-4 sm:px-6">
      <div className="mx-auto max-w-xl">
        <span className="orca-icon-chip mx-auto mb-5 flex w-fit" aria-hidden="true">
          <OrcaMark className="h-8 w-8" alt="" />
        </span>
        <h2 className="text-3xl font-bold tracking-tight text-slate-900">
          Ready to take the helm?
        </h2>
        <p className="mt-3 text-slate-600">
          ProOrca is your homeschool command center. Create an account and start planning smarter.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link
            to="/login"
            className="rounded-xl border border-cyan-300 bg-cyan-50 px-6 py-3 text-sm font-semibold text-cyan-700 hover:bg-cyan-100 transition shadow-sm"
          >
            Try Demo Account
          </Link>
          <Link
            to="/login"
            className="rounded-xl border border-slate-300 bg-white px-6 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 transition"
          >
            Sign In
          </Link>
        </div>
        <p className="mt-2 text-xs text-slate-500">Demo parent PIN: <strong>1234</strong></p>
      </div>
    </section>
  );
}

function LandingFooter() {
  return (
    <footer className="border-t border-slate-200 bg-white px-4 py-8 text-center sm:px-6">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <span className="orca-icon-chip" aria-hidden="true">
            <OrcaMark className="h-5 w-5" alt="" />
          </span>
          <span className="text-sm font-semibold text-slate-700">ProOrca</span>
        </div>
        <p className="text-xs text-slate-500">
          Edge-native homeschool command center &mdash; built on Cloudflare.
        </p>
      </div>
    </footer>
  );
}

function LandingPage() {
  return (
    <div className="min-h-screen">
      <LandingHeader />
      <main>
        <HeroSection />
        <AiSpotlightSection />
        <SkillTreeSpotlightSection />
        <PlannerSpotlightSection />
        <ProgressSpotlightSection />
        <FeaturesGrid />
        <HowItWorksSection />
        <CtaSection />
      </main>
      <LandingFooter />
    </div>
  );
}

// ── Parent dashboard (authenticated) ─────────────────────────────────────────
