import { useState } from "react";
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
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [isSwitchingView, setIsSwitchingView] = useState(false);
  const router = useRouter();
  const activeRole = initialRole;
  const initialViewMode: "parent" | "student" = activeRole === "student" ? "student" : "parent";
  const [viewMode, setViewMode] = useState<"parent" | "student">(initialViewMode);
  const [selectedStudentId, setSelectedStudentId] = useState(
    activeProfileId ?? profiles[0]?.id ?? "",
  );
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  if (!isAuthenticated || isLoggingOut) {
    return <main className="min-h-screen p-4 md:p-8">{children}</main>;
  }

  const roleLabel =
    activeRole === "admin" ? "Administrator" : activeRole === "parent" ? "Parent" : "Student";

  const activeStudentProfile = activeProfileId
    ? profiles.find((profile) => profile.id === activeProfileId) ?? null
    : null;

  const studentLabel =
    activeRole === "student"
      ? activeStudentProfile?.gradeLevel
        ? `${activeStudentProfile.displayName} (Grade ${activeStudentProfile.gradeLevel})`
        : activeStudentProfile?.displayName ?? "Student"
      : null;

  const canAccessAdmin = activeRole === "admin" || (activeRole === "parent" && isAdminParent);
  const canAccessParentModules = activeRole === "parent" || activeRole === "admin";

  return (
    <div className="relative min-h-screen bg-[radial-gradient(circle_at_10%_10%,#cffafe_0%,#ffffff_35%,#f8fafc_100%)]">
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(120deg,rgba(6,182,212,0.09),rgba(255,255,255,0))]" />

      <div className="relative mx-auto flex min-h-screen max-w-[1400px]">
        <aside
          className={`fixed inset-y-0 left-0 z-40 w-72 border-r border-slate-200 bg-white/90 p-5 shadow-xl backdrop-blur transition-transform md:static md:translate-x-0 md:shadow-none ${
            sidebarOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <div className="mb-8">
            <p className="text-xs uppercase tracking-[0.25em] text-cyan-700">Project Orca</p>
            <h1 className="mt-2 text-2xl font-semibold text-slate-900">ProOrca</h1>
            <p className="mt-2 text-sm text-slate-600">Edge-native homeschool command center</p>
          </div>

          <nav className="space-y-2">
            {canAccessParentModules ? (
              <Link
                to="/"
                className={`block w-full rounded-xl px-3 py-2 text-left text-sm font-medium transition ${
                  pathname === "/"
                    ? "bg-cyan-50 text-cyan-900"
                    : "text-slate-700 hover:bg-slate-100"
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
                  pathname.startsWith("/admin")
                    ? "bg-cyan-50 text-cyan-900"
                    : "text-slate-700 hover:bg-slate-100"
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
                  pathname.startsWith("/classes")
                    ? "bg-cyan-50 text-cyan-900"
                    : "text-slate-700 hover:bg-slate-100"
                }`}
                onClick={() => setSidebarOpen(false)}
              >
                Classes
              </Link>
            ) : null}

            {canAccessParentModules ? (
              <Link
                to="/assignments"
                className={`block w-full rounded-xl px-3 py-2 text-left text-sm font-medium transition ${
                  pathname.startsWith("/assignments")
                    ? "bg-cyan-50 text-cyan-900"
                    : "text-slate-700 hover:bg-slate-100"
                }`}
                onClick={() => setSidebarOpen(false)}
              >
                Assignments
              </Link>
            ) : null}

            {activeRole === "student" ? (
              <Link
                to="/student"
                className={`block w-full rounded-xl px-3 py-2 text-left text-sm font-medium transition ${
                  pathname.startsWith("/student")
                    ? "bg-cyan-50 text-cyan-900"
                    : "text-slate-700 hover:bg-slate-100"
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
                <select
                  value={viewMode}
                  onChange={async (event) => {
                    const nextMode = event.target.value as "parent" | "student";
                    setViewMode(nextMode);
                    setSwitchError(null);

                    if (nextMode === "student") {
                      return;
                    }

                    setIsSwitchingView(true);

                    try {
                      await switchWorkspaceView({
                        data: {
                          mode: "parent",
                        },
                      });
                      window.location.assign("/");
                    } catch {
                      setSwitchError("Could not switch to parent view.");
                      setViewMode("student");
                    } finally {
                      setIsSwitchingView(false);
                    }
                  }}
                  disabled={isSwitchingView || isLoggingOut}
                  className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700"
                >
                  <option value="parent">Parent View</option>
                  <option value="student">Student View</option>
                </select>

                {viewMode === "student" ? (
                  <>
                    <select
                      value={selectedStudentId}
                      onChange={(event) => {
                        setSelectedStudentId(event.target.value);
                      }}
                      disabled={profiles.length === 0 || isSwitchingView || isLoggingOut}
                      className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700"
                    >
                      {profiles.length === 0 ? (
                        <option value="">No students available</option>
                      ) : (
                        profiles.map((profile) => (
                          <option key={profile.id} value={profile.id}>
                            {profile.gradeLevel
                              ? `${profile.displayName} (Grade ${profile.gradeLevel})`
                              : profile.displayName}
                          </option>
                        ))
                      )}
                    </select>

                    <button
                      className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-60"
                      disabled={!selectedStudentId || isSwitchingView || isLoggingOut}
                      onClick={async () => {
                        setSwitchError(null);
                        setIsSwitchingView(true);

                        try {
                          await switchWorkspaceView({
                            data: {
                              mode: "student",
                              profileId: selectedStudentId,
                            },
                          });
                          window.location.assign("/student");
                        } catch {
                          setSwitchError("Could not switch to student view.");
                        } finally {
                          setIsSwitchingView(false);
                        }
                      }}
                    >
                      Open Student
                    </button>
                  </>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-2">
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

            <p className="mt-2 text-sm text-slate-600">
              Signed in as <span className="font-semibold text-slate-900">{roleLabel}</span>
              {studentLabel ? ` - ${studentLabel}` : ""}
            </p>

            {switchError ? <p className="mt-2 text-sm font-medium text-rose-700">{switchError}</p> : null}
          </header>

          <main className="flex-1 p-4 md:p-8">{children}</main>
        </div>
      </div>
    </div>
  );
}
