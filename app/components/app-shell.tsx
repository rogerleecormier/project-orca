import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import { LessonPlannerChat } from "./LessonPlannerChat";
import { OrcaMark } from "./icons/orca-mark";
import { logoutSession, switchWorkspaceView } from "../server/functions";

type ActiveRole = "admin" | "parent" | "student";

type StudentProfile = {
  id: string;
  displayName: string;
  gradeLevel: string | null;
};

type AppShellProps = {
  children: ReactNode;
  isAuthenticated: boolean;
  initialRole: ActiveRole;
  isAdminParent: boolean;
  activeProfileId: string | null;
  profiles: StudentProfile[];
  pendingRewardsCount?: number;
};

const CHAT_SUGGESTION_STORAGE_KEY = "proorca.lessonPlanner.selectedSuggestion.v1";

// ── Curriculum nav group ──────────────────────────────────────────────────────

const CURRICULUM_PATHS = [
  "/curriculum-builder",
  "/skill-tree",
  "/skill-trees",
  "/lessons",
  "/classes",
  "/assignments",
  "/templates",
];

function CurriculumNavSection({
  pathname,
  onNav,
}: {
  pathname: string;
  onNav: () => void;
}) {
  const isCurriculumActive = CURRICULUM_PATHS.some((p) => pathname.startsWith(p));
  const [open, setOpen] = useState(isCurriculumActive);

  const navItem = (to: string, label: string, match?: string) => {
    const active = pathname.startsWith(match ?? to);
    return (
      <Link
        to={to}
        className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition ${
          active ? "bg-cyan-50 text-cyan-900 font-medium" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
        }`}
        onClick={onNav}
      >
        {label}
      </Link>
    );
  };

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm font-medium transition ${
          isCurriculumActive ? "text-cyan-900" : "text-slate-700 hover:bg-slate-100"
        }`}
      >
        <span className="flex items-center gap-2">
          <span className="text-base">📚</span>
          Curriculum
        </span>
        <span className={`text-xs text-slate-400 transition-transform ${open ? "rotate-90" : ""}`}>▶</span>
      </button>

      {open && (
        <div className="ml-4 mt-1 flex flex-col gap-0.5 border-l border-slate-200 pl-3">
          {navItem("/curriculum-builder", "✦ AI Builder")}
          {navItem("/skill-trees", "Skill Maps", "/skill-tree")}
          {navItem("/lessons", "Lessons")}
          {navItem("/classes", "Classes")}
          {navItem("/assignments", "Assignments")}
          {navItem("/templates", "Templates")}
        </div>
      )}
    </div>
  );
}

function NavLabel({ icon, label }: { icon: string; label: string }) {
  return (
    <span className="flex items-center gap-2">
      <span className="text-base" aria-hidden="true">
        {icon}
      </span>
      {label}
    </span>
  );
}

// ── Inline PIN prompt (student → parent quick-switch) ─────────────────────────

function ParentPinPrompt({
  onConfirm,
  onCancel,
  error,
  loading,
}: {
  onConfirm: (pin: string) => void;
  onCancel: () => void;
  error: string | null;
  loading: boolean;
}) {
  const [pin, setPin] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex items-center gap-2">
      <input
        ref={inputRef}
        autoFocus
        type="password"
        inputMode="numeric"
        value={pin}
        onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
        onKeyDown={(e) => {
          if (e.key === "Enter" && pin.length >= 4) onConfirm(pin);
          if (e.key === "Escape") onCancel();
        }}
        placeholder="Parent PIN"
        maxLength={6}
        disabled={loading}
        className="w-28 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none"
      />
      <button
        disabled={pin.length < 4 || loading}
        onClick={() => onConfirm(pin)}
        className="rounded-xl bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60"
      >
        {loading ? "…" : "Confirm"}
      </button>
      <button
        onClick={onCancel}
        disabled={loading}
        className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
      >
        Cancel
      </button>
      {error ? <p className="text-xs font-medium text-rose-600">{error}</p> : null}
    </div>
  );
}

// ── Main shell ─────────────────────────────────────────────────────────────────

export function AppShell({
  children,
  isAuthenticated,
  initialRole,
  isAdminParent,
  activeProfileId,
  profiles,
  pendingRewardsCount = 0,
}: AppShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);

  // Student selector (parent → student)
  const [selectedStudentId, setSelectedStudentId] = useState(
    activeProfileId ?? profiles[0]?.id ?? "",
  );

  useEffect(() => {
    if (profiles.length === 0) {
      setSelectedStudentId("");
      return;
    }

    const stillExists = profiles.some((profile) => profile.id === selectedStudentId);
    if (!stillExists) {
      setSelectedStudentId(activeProfileId ?? profiles[0]?.id ?? "");
    }
  }, [profiles, selectedStudentId, activeProfileId]);

  // PIN prompt state (student → parent)
  const [showPinPrompt, setShowPinPrompt] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);

  const router = useRouter();
  const activeRole = initialRole;
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const isFullBleedRoute = pathname.startsWith("/skill-tree/");

  if (!isAuthenticated || isLoggingOut) {
    return <>{children}</>;
  }

  const roleLabel =
    activeRole === "admin" ? "Administrator" : activeRole === "parent" ? "Parent" : "Student";

  const activeStudentProfile = activeProfileId
    ? profiles.find((p) => p.id === activeProfileId) ?? null
    : null;

  const studentLabel = activeStudentProfile
    ? activeStudentProfile.gradeLevel
      ? `${activeStudentProfile.displayName} (Grade ${activeStudentProfile.gradeLevel})`
      : activeStudentProfile.displayName
    : null;

  const canAccessAdmin = activeRole === "admin" || (activeRole === "parent" && isAdminParent);
  const canAccessParentModules = activeRole === "parent" || activeRole === "admin";
  const isStudentSession = activeRole === "student";
  const fallbackProfile = activeStudentProfile ?? profiles[0] ?? null;

  const handleCreateAssignmentFromChat = (suggestion: {
    title: string;
    type: string;
    description: string;
  }) => {
    try {
      sessionStorage.setItem(CHAT_SUGGESTION_STORAGE_KEY, JSON.stringify(suggestion));
    } catch {
      // Ignore storage write failures and still navigate.
    }

    if (pathname.startsWith("/assignments")) {
      window.dispatchEvent(new CustomEvent("proorca:lesson-planner-suggestion"));
      return;
    }

    window.location.assign("/assignments");
  };

  // ── Switch parent → student (no PIN needed, parent is authenticated) ─────────
  const switchToStudent = async () => {
    if (!selectedStudentId) return;
    setSwitchError(null);
    setIsSwitching(true);
    try {
      await switchWorkspaceView({ data: { mode: "student", profileId: selectedStudentId } });
      window.location.assign("/student");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("FORBIDDEN") || msg.includes("PROFILE_REQUIRED")) {
        setSwitchError("Selected student is no longer available. Pick an active student and try again.");
      } else {
        setSwitchError("Could not switch to student view.");
      }
    } finally {
      setIsSwitching(false);
    }
  };

  // ── Switch student → parent (requires parent PIN) ─────────────────────────
  const switchToParent = async (pin: string) => {
    setPinError(null);
    setIsSwitching(true);
    try {
      await switchWorkspaceView({ data: { mode: "parent", parentPin: pin } });
      window.location.assign("/");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "";
      setPinError(msg === "INVALID_PIN" ? "Incorrect PIN." : "Could not switch to parent view.");
      setIsSwitching(false);
    }
  };

  return (
    <div className="relative min-h-screen">
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(120deg,rgba(27,127,194,0.1),rgba(4,8,15,0))]" />

      <div className="relative mx-auto flex min-h-screen w-full max-w-[1400px] overflow-x-clip">
        {/* Sidebar */}
        <aside
          className={`fixed inset-y-0 left-0 z-40 w-72 border-r border-slate-200 bg-white/90 p-5 shadow-xl backdrop-blur transition-transform md:static md:translate-x-0 md:shadow-none ${
            sidebarOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <div className="mb-8">
            <p className="text-xs uppercase tracking-[0.25em] text-cyan-700">Project Orca</p>
            <div className="mt-2 flex items-center gap-2">
              <span className="orca-icon-chip" aria-hidden="true">
                <OrcaMark className="h-6 w-6" alt="" />
              </span>
              <h1 className="text-2xl font-semibold text-slate-900">ProOrca</h1>
            </div>
            <p className="mt-2 text-sm text-slate-600">Edge-native homeschool command center</p>
          </div>

          <nav className="space-y-1">
            {/* ── Dashboard ── */}
            {canAccessParentModules ? (
              <Link
                to="/"
                className={`block w-full rounded-xl px-3 py-2 text-left text-sm font-medium transition ${
                  pathname === "/" ? "bg-cyan-50 text-cyan-900" : "text-slate-700 hover:bg-slate-100"
                }`}
                onClick={() => setSidebarOpen(false)}
              >
                <NavLabel icon="🏠" label="Dashboard" />
              </Link>
            ) : null}

            {canAccessAdmin ? (
              <Link
                to="/admin"
                className={`block w-full rounded-xl px-3 py-2 text-left text-sm font-medium transition ${
                  pathname.startsWith("/admin") ? "bg-cyan-50 text-cyan-900" : "text-slate-700 hover:bg-slate-100"
                }`}
                onClick={() => setSidebarOpen(false)}
              >
                <NavLabel icon="🛠️" label="Home Pod" />
              </Link>
            ) : null}

            {canAccessParentModules ? (
              <Link
                to="/students"
                className={`block w-full rounded-xl px-3 py-2 text-left text-sm font-medium transition ${
                  pathname.startsWith("/students") ? "bg-cyan-50 text-cyan-900" : "text-slate-700 hover:bg-slate-100"
                }`}
                onClick={() => setSidebarOpen(false)}
              >
                <NavLabel icon="👥" label="Students" />
              </Link>
            ) : null}

            {/* ── Curriculum section ── */}
            {canAccessParentModules ? (
              <CurriculumNavSection pathname={pathname} onNav={() => setSidebarOpen(false)} />
            ) : null}

            {/* ── Other parent tools ── */}
            {canAccessParentModules ? (
              <Link
                to="/gradebook"
                className={`block w-full rounded-xl px-3 py-2 text-left text-sm font-medium transition ${
                  pathname.startsWith("/gradebook") ? "bg-cyan-50 text-cyan-900" : "text-slate-700 hover:bg-slate-100"
                }`}
                onClick={() => setSidebarOpen(false)}
              >
                <NavLabel icon="📘" label="Gradebook" />
              </Link>
            ) : null}

            {canAccessParentModules ? (
              <Link
                to="/planner"
                className={`block w-full rounded-xl px-3 py-2 text-left text-sm font-medium transition ${
                  pathname.startsWith("/planner") ? "bg-cyan-50 text-cyan-900" : "text-slate-700 hover:bg-slate-100"
                }`}
                onClick={() => setSidebarOpen(false)}
              >
                <NavLabel icon="🗓️" label="Week Planner" />
              </Link>
            ) : null}

            {canAccessParentModules ? (
              <Link
                to="/rewards"
                className={`relative flex items-center justify-between rounded-xl px-3 py-2 text-sm font-medium transition ${
                  pathname.startsWith("/rewards") ? "bg-cyan-50 text-cyan-900" : "text-slate-700 hover:bg-slate-100"
                }`}
                onClick={() => setSidebarOpen(false)}
              >
                <NavLabel icon="🏆" label="Rewards" />
                {pendingRewardsCount > 0 ? (
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-rose-500 text-[10px] font-bold text-white">
                    {pendingRewardsCount > 9 ? "9+" : pendingRewardsCount}
                  </span>
                ) : null}
              </Link>
            ) : null}

            {canAccessParentModules ? (
              <Link
                to="/settings"
                className={`block w-full rounded-xl px-3 py-2 text-left text-sm font-medium transition ${
                  pathname.startsWith("/settings") ? "bg-cyan-50 text-cyan-900" : "text-slate-700 hover:bg-slate-100"
                }`}
                onClick={() => setSidebarOpen(false)}
              >
                <NavLabel icon="⚙️" label="Settings" />
              </Link>
            ) : null}

            {/* ── Student session ── */}
            {isStudentSession ? (
              <Link
                to="/student"
                className={`block w-full rounded-xl px-3 py-2 text-left text-sm font-medium transition ${
                  pathname.startsWith("/student") && !pathname.startsWith("/students") ? "bg-cyan-50 text-cyan-900" : "text-slate-700 hover:bg-slate-100"
                }`}
                onClick={() => setSidebarOpen(false)}
              >
                <NavLabel icon="🎓" label="Student Workspace" />
              </Link>
            ) : null}

            {isStudentSession ? (
              <Link
                to="/skill-trees"
                className={`block w-full rounded-xl px-3 py-2 text-left text-sm font-medium transition ${
                  pathname.startsWith("/skill-tree") ? "bg-cyan-50 text-cyan-900" : "text-slate-700 hover:bg-slate-100"
                }`}
                onClick={() => setSidebarOpen(false)}
              >
                <NavLabel icon="🧭" label="My Skill Map" />
              </Link>
            ) : null}
          </nav>
        </aside>

        {sidebarOpen ? (
          <button
            aria-label="Close sidebar overlay"
            className="fixed inset-0 z-30 bg-slate-900/20 md:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        ) : null}

        <div className="flex min-w-0 w-full flex-1 flex-col md:ml-0">
          <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/85 px-4 py-3 backdrop-blur md:px-8">
            <div className="flex flex-wrap items-center gap-3">
              <button
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 md:hidden"
                onClick={() => setSidebarOpen(true)}
              >
                Menu
              </button>

              <div className="ml-auto flex flex-wrap items-center gap-2">
                {/* ── Student session: show PIN-guarded parent quick-switch ── */}
                {isStudentSession ? (
                  showPinPrompt ? (
                    <ParentPinPrompt
                      onConfirm={(pin) => void switchToParent(pin)}
                      onCancel={() => {
                        setShowPinPrompt(false);
                        setPinError(null);
                      }}
                      error={pinError}
                      loading={isSwitching}
                    />
                  ) : (
                    <button
                      onClick={() => {
                        setSwitchError(null);
                        setShowPinPrompt(true);
                      }}
                      disabled={isSwitching}
                      className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-60"
                    >
                      Switch to Parent View
                    </button>
                  )
                ) : null}

                {/* ── Parent/admin session: student selector + direct switch ── */}
                {!isStudentSession && profiles.length > 0 ? (
                  <>
                    <select
                      value={selectedStudentId}
                      onChange={(e) => setSelectedStudentId(e.target.value)}
                      disabled={isSwitching || isLoggingOut}
                      className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700"
                    >
                      {profiles.map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.gradeLevel
                            ? `${profile.displayName} (Grade ${profile.gradeLevel})`
                            : profile.displayName}
                        </option>
                      ))}
                    </select>

                    <button
                      disabled={!selectedStudentId || isSwitching || isLoggingOut}
                      onClick={() => void switchToStudent()}
                      className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-60"
                    >
                      {isSwitching ? "Opening…" : "Open Student View"}
                    </button>
                  </>
                ) : null}

                <button
                  className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"
                  onClick={async () => {
                    setSidebarOpen(false);
                    setIsLoggingOut(true);
                    try {
                      await logoutSession();
                      await router.invalidate();
                      await router.navigate({ to: "/login" });
                    } catch {
                      setIsLoggingOut(false);
                    }
                  }}
                >
                  Logout
                </button>
              </div>
            </div>

            <p className="mt-1.5 text-sm text-slate-600">
              Signed in as{" "}
              <span className="font-semibold text-slate-900">{roleLabel}</span>
              {studentLabel ? ` — ${studentLabel}` : ""}
            </p>

            {switchError ? (
              <p className="mt-1 text-sm font-medium text-rose-700">{switchError}</p>
            ) : null}
          </header>

          <main className={`min-w-0 flex-1 ${isFullBleedRoute ? "p-0" : "orca-page-main"}`}>
            {children}
          </main>

          <LessonPlannerChat
            studentName={fallbackProfile?.displayName ?? "your student"}
            grade={fallbackProfile?.gradeLevel ?? null}
            classList={[]}
            onCreateAssignment={canAccessParentModules ? handleCreateAssignmentFromChat : undefined}
          />
        </div>
      </div>
    </div>
  );
}
