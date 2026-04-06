import { useMemo, useState } from "react";
import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { PostLoginRoleModal } from "../components/post-login-role-modal";
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
    title: "AI Lesson Planner",
    description:
      "Chat with an AI assistant to plan lessons, generate assignment ideas, and build a full week of curriculum in minutes—tailored to each student's grade and subject.",
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
    title: "Skill Maps",
    description:
      "Visualize your curriculum as an RPG-style skill tree. Students unlock skills, earn XP, and progress through mastery levels—making learning feel like an adventure.",
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
    title: "AI Quiz & Assignment Generation",
    description:
      "Generate quizzes, essay prompts, and full assignment sets from any topic or YouTube video—with AI grading and per-student feedback built in.",
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
      "Drag and drop assignments onto a weekly calendar. Plan ahead and keep every student's schedule organized with a visual overview of the whole week.",
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
    title: "Gradebook & Progress Tracking",
    description:
      "Review submissions, score work with AI assistance, and track completion and average scores across every class—all in one place.",
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
      "Set up battle-pass style reward milestones for each student. As they earn XP on Skill Maps, reward tiers unlock automatically — from small treats to big experiences.",
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
    title: "Home Pod — Multi-Family Support",
    description:
      "Run a co-op or learning pod? Home Pod lets multiple parent accounts collaborate under one organization, each managing their own students.",
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
] as const;

const HOW_IT_WORKS = [
  {
    step: "1",
    title: "Set up your school",
    description:
      "Create your account, add students, and build classes for each subject. Takes minutes.",
  },
  {
    step: "2",
    title: "Plan with AI",
    description:
      "Chat with the AI lesson planner to generate assignments, quizzes, and full skill trees tailored to each student.",
  },
  {
    step: "3",
    title: "Students learn, level up, and earn rewards",
    description:
      "Students complete assignments, unlock skill nodes, and earn XP. As milestones are hit, reward tiers unlock automatically—with celebration animations and a claim flow built in.",
  },
  {
    step: "4",
    title: "Track and grade effortlessly",
    description:
      "The gradebook aggregates submissions, and AI grading gives you scored feedback without the manual work.",
  },
] as const;

// ── Login panel (used in the landing page header) ─────────────────────────────

function HeaderLoginPanel() {
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
      window.location.assign("/");
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
      window.location.assign("/student");
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
      window.location.assign("/login");
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
        Sign In
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
            <p className="mt-3 text-xs text-slate-600">
              No account?{" "}
              <Link
                to="/register"
                className="font-medium text-cyan-700 hover:underline"
                onClick={() => setOpen(false)}
              >
                Create one
              </Link>
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
          <Link
            to="/register"
            className="hidden rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition sm:block"
          >
            Get Started
          </Link>
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
            to="/register"
            className="rounded-xl bg-slate-900 px-6 py-3 text-sm font-semibold text-white hover:bg-slate-800 transition shadow-sm"
          >
            Start for Free
          </Link>
          <Link
            to="/login"
            className="rounded-xl border border-slate-300 bg-white px-6 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 transition"
          >
            Sign In
          </Link>
        </div>
      </div>
    </section>
  );
}

function AiSpotlightSection() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
      <div className="grid gap-12 lg:grid-cols-2 lg:gap-16 lg:items-center">
        {/* Text */}
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-cyan-700">
            AI-Powered Planning
          </p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-900">
            Your personal curriculum co-pilot
          </h2>
          <p className="mt-4 text-slate-600 leading-relaxed">
            ProOrca's AI lesson planner works like a conversation. Describe what you want to cover,
            your student's grade level, and the subject—and get back a ready-to-use assignment,
            quiz, or full week of lessons.
          </p>
          <ul className="mt-6 space-y-3">
            {[
              "Chat-based lesson planning tailored to each student",
              "One-click quiz generation from any topic or YouTube video",
              "AI grading with per-student strengths and feedback",
              "Full curriculum skeleton generation for Skill Maps",
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

        {/* Visual mock */}
        <div className="rounded-2xl border border-slate-200 bg-white/90 p-5 shadow-sm">
          <div className="flex items-center gap-2 border-b border-slate-100 pb-3 mb-4">
            <span className="orca-icon-chip" aria-hidden="true">
              <OrcaMark className="h-5 w-5" alt="" />
            </span>
            <p className="text-sm font-semibold text-slate-900">AI Lesson Planner</p>
            <span className="ml-auto rounded-full bg-cyan-50 px-2 py-0.5 text-xs font-medium text-cyan-700">
              Live
            </span>
          </div>
          <div className="space-y-3">
            <div className="flex gap-3">
              <div className="h-7 w-7 shrink-0 rounded-full bg-slate-100 flex items-center justify-center text-xs font-bold text-slate-500">
                P
              </div>
              <div className="rounded-2xl rounded-tl-none bg-slate-100 px-4 py-2.5 text-sm text-slate-700 max-w-[85%]">
                Create a 3rd grade science lesson on the water cycle with a short quiz at the end.
              </div>
            </div>
            <div className="flex gap-3 flex-row-reverse">
              <span className="orca-icon-chip h-7 w-7 shrink-0" aria-hidden="true">
                <OrcaMark className="h-4 w-4" alt="" />
              </span>
              <div className="rounded-2xl rounded-tr-none border border-cyan-200 bg-cyan-50/80 px-4 py-2.5 text-sm text-cyan-900 max-w-[85%]">
                <p className="font-medium">The Water Cycle — Grade 3</p>
                <p className="mt-1 text-xs text-cyan-700">
                  Covers evaporation, condensation, and precipitation. Includes a 5-question
                  multiple-choice quiz with answer keys.
                </p>
                <button
                  className="mt-2 rounded-lg bg-slate-900 px-3 py-1 text-xs font-medium text-white opacity-80"
                  tabIndex={-1}
                  aria-hidden="true"
                >
                  + Create Assignment
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
  const nodes = [
    { label: "Intro to Fractions", x: "50%", y: "10%", status: "mastery" },
    { label: "Equivalent Fractions", x: "25%", y: "38%", status: "complete" },
    { label: "Comparing Fractions", x: "72%", y: "38%", status: "in_progress" },
    { label: "Adding Fractions", x: "12%", y: "68%", status: "available" },
    { label: "Mixed Numbers", x: "44%", y: "68%", status: "locked" },
    { label: "Boss: Fraction Challenge", x: "72%", y: "82%", status: "locked" },
  ] as const;

  const statusStyles: Record<string, string> = {
    mastery: "border-amber-400 bg-amber-50 text-amber-900",
    complete: "border-emerald-400 bg-emerald-50 text-emerald-900",
    in_progress: "border-cyan-400 bg-cyan-50 text-cyan-900",
    available: "border-slate-400 bg-white text-slate-700",
    locked: "border-slate-200 bg-slate-50 text-slate-400",
  };

  const statusDot: Record<string, string> = {
    mastery: "bg-amber-400",
    complete: "bg-emerald-400",
    in_progress: "bg-cyan-400",
    available: "bg-slate-400",
    locked: "bg-slate-200",
  };

  return (
    <section className="border-y border-slate-200 bg-slate-50/70 py-20">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="grid gap-12 lg:grid-cols-2 lg:gap-16 lg:items-center">
          {/* Visual mock */}
          <div className="order-2 lg:order-1">
            <div className="relative h-72 rounded-2xl border border-slate-200 bg-white/90 shadow-sm overflow-hidden">
              {/* SVG edges */}
              <svg className="absolute inset-0 h-full w-full" aria-hidden="true">
                <line x1="50%" y1="18%" x2="25%" y2="34%" stroke="#cbd5e1" strokeWidth="1.5" strokeDasharray="4 3" />
                <line x1="50%" y1="18%" x2="72%" y2="34%" stroke="#67e8f9" strokeWidth="1.5" />
                <line x1="25%" y1="46%" x2="12%" y2="64%" stroke="#d1d5db" strokeWidth="1.5" strokeDasharray="4 3" />
                <line x1="72%" y1="46%" x2="44%" y2="64%" stroke="#d1d5db" strokeWidth="1.5" strokeDasharray="4 3" />
                <line x1="72%" y1="46%" x2="72%" y2="78%" stroke="#d1d5db" strokeWidth="1.5" strokeDasharray="4 3" />
              </svg>

              {nodes.map((node) => (
                <div
                  key={node.label}
                  className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-xl border px-2.5 py-1.5 text-xs font-medium shadow-sm whitespace-nowrap ${statusStyles[node.status]}`}
                  style={{ left: node.x, top: node.y }}
                >
                  <span
                    className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full ${statusDot[node.status]}`}
                    aria-hidden="true"
                  />
                  {node.label}
                </div>
              ))}

              {/* Legend */}
              <div className="absolute bottom-3 right-3 flex flex-col gap-1 rounded-xl border border-slate-200 bg-white/90 p-2 text-xs">
                {[
                  { label: "Mastery", dot: "bg-amber-400" },
                  { label: "Complete", dot: "bg-emerald-400" },
                  { label: "In Progress", dot: "bg-cyan-400" },
                  { label: "Available", dot: "bg-slate-400" },
                  { label: "Locked", dot: "bg-slate-200" },
                ].map((item) => (
                  <div key={item.label} className="flex items-center gap-1.5 text-slate-600">
                    <span className={`h-2 w-2 rounded-full ${item.dot}`} aria-hidden="true" />
                    {item.label}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Text */}
          <div className="order-1 lg:order-2">
            <p className="text-xs font-semibold uppercase tracking-[0.25em] text-violet-700">
              Skill Maps
            </p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-900">
              Curriculum as an adventure map
            </h2>
            <p className="mt-4 text-slate-600 leading-relaxed">
              Skill Maps turn your curriculum into a visual, node-based progression tree. Students
              unlock skills in sequence, earn XP for each completed node, and can see exactly
              where they are in their learning journey.
            </p>
            <ul className="mt-6 space-y-3">
              {[
                "Node types: lesson, milestone, boss challenge, elective, and branch",
                "AI generates a full curriculum skeleton in one click",
                "Each node links to real assignments — not just checkboxes",
                "Students see locked → available → in progress → mastery",
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

function RewardTrackSpotlightSection() {
  const tiers = [
    { icon: "🍦", label: "Ice Cream Trip", xp: 500, status: "delivered" },
    { icon: "🎮", label: "Game Night", xp: 1000, status: "claimed" },
    { icon: "🎨", label: "Art Supplies", xp: 1500, status: "unlocked" },
    { icon: "🏕️", label: "Camping Trip", xp: 2500, status: "locked" },
    { icon: "🌎", label: "Big Adventure", xp: 5000, status: "locked" },
  ] as const;

  const cardStyle: Record<string, React.CSSProperties> = {
    delivered: { background: "linear-gradient(135deg, #fbbf24, #d97706)", border: "2px solid #f59e0b" },
    claimed: { background: "#ede9fe", border: "2px solid #a78bfa" },
    unlocked: { background: "#fff", border: "2px solid #22d3ee" },
    locked: { background: "#f8fafc", border: "1.5px solid #e2e8f0" },
  };

  const labelColor: Record<string, string> = {
    delivered: "text-white",
    claimed: "text-violet-800",
    unlocked: "text-slate-800",
    locked: "text-slate-400",
  };

  return (
    <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
      <div className="grid gap-12 lg:grid-cols-2 lg:gap-16 lg:items-center">
        {/* Text */}
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-amber-600">
            Reward Tracks
          </p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-900">
            Real-world rewards for real learning
          </h2>
          <p className="mt-4 text-slate-600 leading-relaxed">
            Set up a battle-pass style reward track for each student. As they earn XP by completing
            Skill Map nodes, milestone tiers unlock automatically — from a small treat to a big
            family experience. Students see their progress in real time and claim rewards with
            a single tap.
          </p>
          <ul className="mt-6 space-y-3">
            {[
              "10 customizable tiers per track — treats, activities, screen time, experiences",
              "AI suggests tier ideas based on student name and grade level",
              "Unlock celebrations with confetti animations when a tier is reached",
              "Parent confirms delivery — full claim history for every student",
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

        {/* Visual mock */}
        <div className="rounded-2xl border border-violet-200 bg-gradient-to-br from-violet-50 to-amber-50 p-5 shadow-sm">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span aria-hidden="true">🏆</span>
              <p className="text-sm font-semibold text-slate-800">Emma's Reward Track</p>
            </div>
            <span className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-700">
              ⭐ 1,580 XP
            </span>
          </div>

          {/* Progress bar */}
          <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: "31%", background: "linear-gradient(90deg, #a78bfa, #fbbf24)" }}
            />
          </div>

          {/* Tier row */}
          <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
            {tiers.map((tier, i) => (
              <div key={tier.label} className="flex shrink-0 items-center gap-2">
                <div
                  className="flex flex-col items-center justify-center rounded-xl p-2 text-center"
                  style={{ width: 68, height: 84, ...cardStyle[tier.status] }}
                >
                  <span style={{ fontSize: 26, opacity: tier.status === "locked" ? 0.35 : 1 }}>
                    {tier.icon}
                  </span>
                  <p
                    className={`mt-1 w-full text-center leading-tight ${labelColor[tier.status]}`}
                    style={{ fontSize: 9, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}
                  >
                    {tier.label}
                  </p>
                  {tier.status === "delivered" && (
                    <p className="mt-0.5 text-white" style={{ fontSize: 8 }}>✓ Got it!</p>
                  )}
                  {tier.status === "claimed" && (
                    <p className="mt-0.5 text-violet-600" style={{ fontSize: 8 }}>Waiting…</p>
                  )}
                  {tier.status === "unlocked" && (
                    <span
                      className="mt-1 rounded-full bg-cyan-500 px-1.5 text-white"
                      style={{ fontSize: 8, fontWeight: 600 }}
                    >
                      Claim!
                    </span>
                  )}
                  {tier.status === "locked" && (
                    <p className="mt-0.5 text-slate-400" style={{ fontSize: 8 }}>
                      {tier.xp.toLocaleString()} XP
                    </p>
                  )}
                </div>
                {i < tiers.length - 1 ? (
                  <span className="shrink-0 text-slate-300" style={{ fontSize: 11 }}>→</span>
                ) : null}
              </div>
            ))}
          </div>

          {/* Summary */}
          <p className="mt-2 text-xs text-slate-500">
            1,580 / 5,000 XP · 2/5 rewards
          </p>
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
            to="/register"
            className="rounded-xl bg-slate-900 px-6 py-3 text-sm font-semibold text-white hover:bg-slate-800 transition shadow-sm"
          >
            Create Free Account
          </Link>
          <Link
            to="/login"
            className="rounded-xl border border-slate-300 bg-white px-6 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 transition"
          >
            Sign In
          </Link>
        </div>
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
        <RewardTrackSpotlightSection />
        <FeaturesGrid />
        <HowItWorksSection />
        <CtaSection />
      </main>
      <LandingFooter />
    </div>
  );
}

// ── Parent dashboard (authenticated) ─────────────────────────────────────────

function ParentDashboard({
  parentDashboard,
  isAdminParent,
}: {
  parentDashboard: NonNullable<Awaited<ReturnType<typeof getParentDashboardData>>>;
  isAdminParent: boolean;
}) {
  const currentSchoolYear = () => {
    const now = new Date();
    const year = now.getFullYear();
    const start = now.getMonth() >= 7 ? year : year - 1;
    return `${start}-${start + 1}`;
  };

  const [selectedStudentId, setSelectedStudentId] = useState(
    parentDashboard.students[0]?.id ?? "",
  );
  const [selectedYear, setSelectedYear] = useState(() => {
    const currentYear = currentSchoolYear();
    if (parentDashboard.schoolYears.includes(currentYear)) {
      return currentYear;
    }
    return parentDashboard.schoolYears[0] ?? "all";
  });

  const parentStudents = parentDashboard.students;
  const selectedStudent =
    parentStudents.find((student) => student.id === selectedStudentId) ?? null;
  const selectedMetrics = selectedStudentId
    ? parentDashboard.metricsByStudent[selectedStudentId] ?? []
    : [];
  const filteredMetrics = useMemo(() => {
    if (selectedYear === "all") return selectedMetrics;
    if (selectedYear === "") return selectedMetrics.filter((metric) => !metric.schoolYear);
    return selectedMetrics.filter((metric) => metric.schoolYear === selectedYear);
  }, [selectedMetrics, selectedYear]);

  const featureCtas = [
    {
      to: "/students",
      title: "Students",
      description: "Manage student profiles and PINs.",
      accentClass: "border-emerald-200 bg-emerald-50/80 text-emerald-900",
      iconClass: "bg-emerald-100 text-emerald-700",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
          <path
            d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M15 3.13a4 4 0 0 1 0 7.75M14 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
    },
    {
      to: "/classes",
      title: "Classes",
      description: "Build and organize your curriculum.",
      accentClass: "border-cyan-200 bg-cyan-50/80 text-cyan-900",
      iconClass: "bg-cyan-100 text-cyan-700",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
          <path
            d="M4 5h16v12H4zM2 17h20M8 21h8"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
    },
    {
      to: "/assignments",
      title: "Assignments",
      description: "Create and track student work.",
      accentClass: "border-violet-200 bg-violet-50/80 text-violet-900",
      iconClass: "bg-violet-100 text-violet-700",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
          <path
            d="M9 11h6M9 15h6M9 7h3M5 3h14a2 2 0 0 1 2 2v14l-4-2-4 2-4-2-4 2V5a2 2 0 0 1 2-2Z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
    },
    {
      to: "/templates",
      title: "Templates",
      description: "Reuse your best assignment setups.",
      accentClass: "border-sky-200 bg-sky-50/80 text-sky-900",
      iconClass: "bg-sky-100 text-sky-700",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
          <path
            d="M4 7a2 2 0 0 1 2-2h7l7 7v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7Zm9-2v5h5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
    },
    {
      to: "/gradebook",
      title: "Gradebook",
      description: "Review submissions and scores.",
      accentClass: "border-amber-200 bg-amber-50/80 text-amber-900",
      iconClass: "bg-amber-100 text-amber-700",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
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
      to: "/planner",
      title: "Week Planner",
      description: "Schedule assignments for the week.",
      accentClass: "border-cyan-200 bg-cyan-50/80 text-cyan-900",
      iconClass: "bg-cyan-100 text-cyan-700",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
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
      to: "/skill-trees",
      title: "Skill Maps",
      description: "Build RPG-style curriculum pathways.",
      accentClass: "border-violet-200 bg-violet-50/80 text-violet-900",
      iconClass: "bg-violet-100 text-violet-700",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
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
      to: "/rewards",
      title: "Reward Tracks",
      description: "Set milestone rewards for XP progress. Battle-pass style motivation.",
      accentClass: "border-amber-200 bg-amber-50/80 text-amber-900",
      iconClass: "bg-amber-100 text-amber-700",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
          <path
            d="M20 12v8H4v-8"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M22 7H2v5h20V7z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M12 22V7"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          <path
            d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
    },
    ...(isAdminParent
      ? [
          {
            to: "/admin",
            title: "Home Pod",
            description: "Configure parent admin access.",
            accentClass: "border-amber-200 bg-amber-50/80 text-amber-900",
            iconClass: "bg-amber-100 text-amber-700",
            icon: (
              <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
                <path
                  d="M12 3 4 7v6c0 5 3.4 7.7 8 8 4.6-.3 8-3 8-8V7l-8-4Zm0 6v4m0 4h.01"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ),
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-6">
      <section className="orca-hero orca-wave rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <span className="orca-icon-chip" aria-hidden="true">
              <OrcaMark className="h-6 w-6" alt="" />
            </span>
            <h2 className="text-xl font-semibold text-slate-900">Parent Quick Actions</h2>
          </div>
          <p className="text-sm text-slate-600">Jump to the tools you use most.</p>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {featureCtas.map((cta) => (
            <Link
              key={cta.to}
              to={cta.to}
              className={`group rounded-2xl border p-4 transition hover:shadow-sm ${cta.accentClass}`}
            >
              <div className={`inline-flex rounded-xl p-2 ${cta.iconClass}`}>{cta.icon}</div>
              <h3 className="mt-3 text-base font-semibold">{cta.title}</h3>
              <p className="mt-1 text-sm">{cta.description}</p>
              <p className="mt-3 text-xs font-medium uppercase tracking-[0.14em]">Open</p>
            </Link>
          ))}
        </div>
      </section>

      <section className="orca-wave rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-cyan-700">Parent View</p>
            <h2 className="mt-2 text-xl font-semibold text-slate-900">
              Student Progress Overview
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              Choose a student to view completion metrics for each assigned class.
            </p>
          </div>
          <span className="rounded-full bg-cyan-50 px-3 py-1 text-xs font-medium text-cyan-700">
            {parentStudents.length}{" "}
            {parentStudents.length === 1 ? "student" : "students"}
          </span>
        </div>

        {parentStudents.length === 0 ? (
          <div className="mt-5 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">
            No students found. Add a student from the Students page to begin tracking class
            completion.
          </div>
        ) : (
          <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,280px)_minmax(0,1fr)]">
            <aside className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
              <h3 className="text-sm font-semibold uppercase tracking-[0.14em] text-slate-700">
                Students
              </h3>
              <div className="mt-3 space-y-2">
                {parentStudents.map((student) => {
                  const isSelected = selectedStudentId === student.id;
                  return (
                    <button
                      key={student.id}
                      onClick={() => setSelectedStudentId(student.id)}
                      className={`w-full rounded-xl border px-4 py-3 text-left text-sm font-medium transition ${
                        isSelected
                          ? "border-cyan-600 bg-cyan-600 text-white"
                          : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
                      }`}
                    >
                      <p>{student.displayName}</p>
                      <p
                        className={`mt-1 text-xs ${isSelected ? "text-cyan-100" : "text-slate-500"}`}
                      >
                        {student.gradeLevel ? `Grade ${student.gradeLevel}` : "Grade not set"}
                      </p>
                    </button>
                  );
                })}
              </div>
            </aside>

            <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-lg font-semibold text-slate-900">
                  {selectedStudent
                    ? `${selectedStudent.displayName} - Class Completion`
                    : "Class Completion"}
                </h3>
                <select
                  value={selectedYear}
                  onChange={(event) => setSelectedYear(event.target.value)}
                  className="rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700"
                >
                  <option value="all">All school years</option>
                  {parentDashboard.schoolYears.map((year) => (
                    <option key={year} value={year}>
                      {year}
                    </option>
                  ))}
                  {parentDashboard.hasClassesWithoutSchoolYear ? (
                    <option value="">No year set</option>
                  ) : null}
                </select>
              </div>

              {filteredMetrics.length === 0 ? (
                <p className="mt-3 text-sm text-slate-600">
                  {selectedYear === "all"
                    ? "No classes assigned yet."
                    : `No classes found for ${selectedYear === "" ? "No year set" : selectedYear}.`}
                </p>
              ) : (
                <div className="mt-4 space-y-3">
                  {filteredMetrics.map((metric) => (
                    <article
                      key={metric.classId}
                      className="rounded-xl border border-slate-200 bg-white p-4"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h4 className="font-semibold text-slate-900">{metric.classTitle}</h4>
                        <p className="text-sm text-slate-600">
                          {metric.completionPercent}% complete
                        </p>
                      </div>
                      <div className="mt-2 h-2 w-full rounded-full bg-slate-200">
                        <div
                          className="h-2 rounded-full bg-cyan-500"
                          style={{ width: `${metric.completionPercent}%` }}
                        />
                      </div>
                      <div className="mt-3 grid gap-2 text-sm text-slate-600 sm:grid-cols-3">
                        <p>Assigned: {metric.assignedCount}</p>
                        <p>Submitted: {metric.submittedCount}</p>
                        <p>
                          Avg Score:{" "}
                          {metric.averageScore === null
                            ? "Not graded"
                            : `${metric.averageScore}%`}
                        </p>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
