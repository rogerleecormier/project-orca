import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { Link, useRouter, useRouterState } from "@tanstack/react-router";
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
};

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
}: AppShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);

  // Student selector (parent → student)
  const [selectedStudentId, setSelectedStudentId] = useState(
    activeProfileId ?? profiles[0]?.id ?? "",
  );

  // PIN prompt state (student → parent)
  const [showPinPrompt, setShowPinPrompt] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);

  const router = useRouter();
  const activeRole = initialRole;
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  if (!isAuthenticated || isLoggingOut) {
    return <main className="min-h-screen p-4 md:p-8">{children}</main>;
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

  // ── Switch parent → student (no PIN needed, parent is authenticated) ─────────
  const switchToStudent = async () => {
    if (!selectedStudentId) return;
    setSwitchError(null);
    setIsSwitching(true);
    try {
      await switchWorkspaceView({ data: { mode: "student", profileId: selectedStudentId } });
      window.location.assign("/student");
    } catch {
      setSwitchError("Could not switch to student view.");
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

      <div className="relative mx-auto flex min-h-screen max-w-[1400px]">
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
                <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                  <path
                    d="M4 14c3.5 0 5.5-2.5 8-2.5 2 0 3.8 1 6 1.8V9.5l2 1.2-2 1.1v4.7c-2.5-.5-4.2-1.5-6-1.5-2.8 0-4.5 2.5-8 2.5v-3.5Z"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <h1 className="text-2xl font-semibold text-slate-900">ProOrca</h1>
            </div>
            <p className="mt-2 text-sm text-slate-600">Edge-native homeschool command center</p>
          </div>

          <nav className="space-y-2">
            {canAccessParentModules ? (
              <Link
                to="/"
                className={`block w-full rounded-xl px-3 py-2 text-left text-sm font-medium transition ${
                  pathname === "/" ? "bg-cyan-50 text-cyan-900" : "text-slate-700 hover:bg-slate-100"
                }`}
                onClick={() => setSidebarOpen(false)}
              >
                Dashboard
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
                Home Pod
              </Link>
            ) : null}

            {canAccessParentModules ? (
              <Link
                to="/classes"
                className={`block w-full rounded-xl px-3 py-2 text-left text-sm font-medium transition ${
                  pathname.startsWith("/classes") ? "bg-cyan-50 text-cyan-900" : "text-slate-700 hover:bg-slate-100"
                }`}
                onClick={() => setSidebarOpen(false)}
              >
                Classes
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
                Students
              </Link>
            ) : null}

            {canAccessParentModules ? (
              <Link
                to="/assignments"
                className={`block w-full rounded-xl px-3 py-2 text-left text-sm font-medium transition ${
                  pathname.startsWith("/assignments") ? "bg-cyan-50 text-cyan-900" : "text-slate-700 hover:bg-slate-100"
                }`}
                onClick={() => setSidebarOpen(false)}
              >
                Assignments
              </Link>
            ) : null}

            {isStudentSession ? (
              <Link
                to="/student"
                className={`block w-full rounded-xl px-3 py-2 text-left text-sm font-medium transition ${
                  pathname.startsWith("/student") ? "bg-cyan-50 text-cyan-900" : "text-slate-700 hover:bg-slate-100"
                }`}
                onClick={() => setSidebarOpen(false)}
              >
                Student Workspace
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

        <div className="flex w-full flex-1 flex-col md:ml-0">
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

          <main className="flex-1 p-4 md:p-8">{children}</main>
        </div>
      </div>
    </div>
  );
}
