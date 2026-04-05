import { useState } from "react";
import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { getViewerContext, loginAsParent } from "../server/functions";

export const Route = createFileRoute("/login")({
  loader: async () => {
    const viewer = await getViewerContext();
    if (viewer.isAuthenticated) {
      throw redirect({ to: viewer.activeRole === "student" ? "/student" : "/select-student" });
    }

    return null;
  },
  component: LoginPage,
});

function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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

      window.location.assign("/select-student");
    } catch (err) {
      setError("Invalid username or password.");
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      void submitParentLogin();
    }
  };

  return (
    <div className="mx-auto grid min-h-[70vh] w-full max-w-3xl gap-6 py-8">
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

        <p className="mt-4 text-sm text-slate-600">
          Don't have an account? <Link className="font-medium text-cyan-700 hover:underline" to="/register">Create One</Link>
        </p>

        {error ? <p className="mt-3 text-sm text-rose-700 font-medium">{error}</p> : null}
      </section>
    </div>
  );
}
