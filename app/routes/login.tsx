import { useState } from "react";
import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { PostLoginRoleModal } from "../components/post-login-role-modal";
import {
  completePostLoginRoleSelection,
  ensureDemoAccount,
  getStudentSelectionOptions,
  getViewerContext,
  loginAsParent,
  logoutSession,
} from "../server/functions";

export const Route = createFileRoute("/login")({
  loader: async () => {
    const viewer = await getViewerContext();
    if (viewer.isAuthenticated) {
      throw redirect({ to: viewer.activeRole === "student" ? "/student" : "/" });
    }

    // Ensure the demo account exists (best-effort — never crash the login page)
    try { await ensureDemoAccount(); } catch { /* ignore */ }

    return null;
  },
  component: LoginPage,
});

function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [roleModalOpen, setRoleModalOpen] = useState(false);
  const [roleModalError, setRoleModalError] = useState<string | null>(null);
  const [roleModalLoading, setRoleModalLoading] = useState(false);
  const [profiles, setProfiles] = useState<Array<{
    id: string;
    displayName: string;
    gradeLevel: string | null;
  }>>([]);

  const submitParentLogin = async () => {
    setError(null);

    if (!username.trim()) {
      setError("Enter your username.");
      return;
    }

    if (!password.trim()) {
      setError("Enter your password.");
      return;
    }

    setLoading(true);

    try {
      await loginAsParent({
        data: {
          username: username.trim().toLowerCase(),
          password: password.trim(),
        },
      });
      const options = await getStudentSelectionOptions();
      setProfiles(options.profiles);
      setRoleModalError(null);
      setRoleModalOpen(true);
    } catch (err) {
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
    if (e.key === "Enter") {
      void submitParentLogin();
    }
  };

  return (
    <div className="orca-auth-page grid gap-6">
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-xs uppercase tracking-[0.2em] text-cyan-700">Parent Login</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">Step 1: Parent Access</h1>
        <p className="mt-2 text-sm text-slate-600">
          Sign in as a parent. You will choose parent or student view in the next step.
        </p>

        <div className="mt-5 space-y-4">
          <label className="block space-y-2">
            <span className="text-sm font-medium text-slate-700">Username</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              onKeyDown={handleKeyDown}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
              placeholder="your_username"
              autoComplete="username"
            />
          </label>

          <label className="block space-y-2">
            <span className="text-sm font-medium text-slate-700">Password</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={handleKeyDown}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
              placeholder="••••••••"
              autoComplete="current-password"
            />
          </label>
        </div>

        <button
          onClick={() => {
            void submitParentLogin();
          }}
          disabled={loading}
          className="mt-5 w-full rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60"
        >
          {loading ? "Signing in..." : "Sign In"}
        </button>

        <div className="mt-3 flex items-center gap-3">
          <div className="flex-1 h-px bg-slate-200" />
          <span className="text-xs text-slate-400">or</span>
          <div className="flex-1 h-px bg-slate-200" />
        </div>

        <button
          type="button"
          onClick={async () => {
            setError(null);
            setLoading(true);
            try {
              await loginAsParent({ data: { username: "demo", password: "demo1234" } });
              const options = await getStudentSelectionOptions();
              setProfiles(options.profiles);
              setRoleModalError(null);
              setRoleModalOpen(true);
            } catch {
              setError("Demo account not available. Seed it from Settings → Content Controls.");
            } finally {
              setLoading(false);
            }
          }}
          disabled={loading}
          className="mt-3 w-full rounded-xl border border-cyan-300 bg-cyan-50 px-4 py-2 text-sm font-medium text-cyan-700 hover:bg-cyan-100 disabled:opacity-60"
        >
          Try Demo Account
        </button>
        <p className="mt-1.5 text-center text-xs text-slate-500">Explore with pre-loaded sample data — no account needed</p>

        <p className="mt-4 text-sm text-slate-600">
          Don't have an account? <Link className="font-medium text-cyan-700 hover:underline" to="/register">Create One</Link>
        </p>

        {error ? <p className="mt-3 text-sm text-rose-700 font-medium">{error}</p> : null}
      </section>

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
