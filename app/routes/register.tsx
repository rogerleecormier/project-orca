import { useState } from "react";
import { Link, createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { createParentAccount, getViewerContext } from "../server/functions";

export const Route = createFileRoute("/register")({
  loader: async () => {
    const viewer = await getViewerContext();
    if (viewer.isAuthenticated) {
      throw redirect({ to: viewer.activeRole === "student" ? "/student" : "/" });
    }
    return null;
  },
  component: RegisterPage,
});

function RegisterPage() {
  const router = useRouter();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [parentPin, setParentPin] = useState("");
  const [homePodName, setHomePodName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const validateForm = (): string | null => {
    if (!firstName.trim()) return "First name is required.";
    if (!lastName.trim()) return "Last name is required.";
    if (!email.trim()) return "Email is required.";
    if (!username.trim()) return "Username is required.";
    if (username.length < 3) return "Username must be at least 3 characters.";
    if (username.length > 20) return "Username must be 20 characters or less.";
    if (!password.trim()) return "Password is required.";
    if (password.length < 8) return "Password must be at least 8 characters.";
    if (password !== confirmPassword) return "Passwords do not match.";
    if (!parentPin.trim()) return "Parent PIN is required.";
    if (!/^\d{4,6}$/.test(parentPin)) return "Parent PIN must be 4-6 digits.";
    if (!homePodName.trim()) return "Home Pod name is required.";
    return null;
  };

  const createAccount = async () => {
    setError(null);
    setSuccess(null);

    const validationError = validateForm();
    if (validationError) {
      setError(validationError);
      return;
    }

    setLoading(true);

    try {
      await createParentAccount({
        data: {
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: email.trim().toLowerCase(),
          username: username.trim().toLowerCase(),
          password: password.trim(),
          parentPin: parentPin.trim(),
          homePodName: homePodName.trim(),
        },
      });

      setSuccess("Account created successfully! Redirecting to login...");
      setTimeout(() => {
        void router.navigate({ to: "/login" });
      }, 1000);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      if (errorMsg.includes("EMAIL_ALREADY_EXISTS")) {
        setError("This email is already in use.");
      } else if (errorMsg.includes("USERNAME_ALREADY_EXISTS")) {
        setError("This username is already taken.");
      } else {
        setError("Could not create account. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      void createAccount();
    }
  };

  return (
    <div className="mx-auto min-h-screen w-full max-w-2xl py-8 px-4">
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-xs uppercase tracking-[0.2em] text-cyan-700">Account Creation</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">Create Parent Account</h1>
        <p className="mt-1 text-sm text-slate-600">Set up your account to manage your home pod.</p>

        <div className="mt-6 space-y-4">
          {/* Name Fields */}
          <div className="grid grid-cols-2 gap-4">
            <label className="block space-y-2">
              <span className="text-sm font-medium text-slate-700">First Name</span>
              <input
                value={firstName}
                onChange={(event) => setFirstName(event.target.value)}
                onKeyDown={handleKeyDown}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                placeholder="Alex"
              />
            </label>

            <label className="block space-y-2">
              <span className="text-sm font-medium text-slate-700">Last Name</span>
              <input
                value={lastName}
                onChange={(event) => setLastName(event.target.value)}
                onKeyDown={handleKeyDown}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                placeholder="Rivera"
              />
            </label>
          </div>

          {/* Email */}
          <label className="block space-y-2">
            <span className="text-sm font-medium text-slate-700">Email</span>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              onKeyDown={handleKeyDown}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
              placeholder="alex@example.com"
              autoComplete="email"
            />
          </label>

          {/* Home Pod Name */}
          <label className="block space-y-2">
            <span className="text-sm font-medium text-slate-700">Home Pod Name</span>
            <input
              value={homePodName}
              onChange={(event) => setHomePodName(event.target.value)}
              onKeyDown={handleKeyDown}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
              placeholder="Rivera Home Pod"
            />
            <p className="mt-1 text-xs text-slate-500">This is your Learning organization name.</p>
          </label>

          {/* Username */}
          <label className="block space-y-2">
            <span className="text-sm font-medium text-slate-700">Username</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              onKeyDown={handleKeyDown}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
              placeholder="alex_rivera"
              autoComplete="username"
            />
            <p className="mt-1 text-xs text-slate-500">3-20 characters, lowercase letters, numbers, and underscores only.</p>
          </label>

          {/* Password Fields */}
          <div className="grid grid-cols-2 gap-4">
            <label className="block space-y-2">
              <span className="text-sm font-medium text-slate-700">Password</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                onKeyDown={handleKeyDown}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                placeholder="••••••••"
                autoComplete="new-password"
              />
            </label>

            <label className="block space-y-2">
              <span className="text-sm font-medium text-slate-700">Confirm Password</span>
              <input
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                onKeyDown={handleKeyDown}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                placeholder="••••••••"
                autoComplete="new-password"
              />
            </label>
          </div>

          <p className="text-xs text-slate-500">Password must be at least 8 characters.</p>

          {/* Parent PIN */}
          <label className="block space-y-2">
            <span className="text-sm font-medium text-slate-700">Parent PIN for Student Switching</span>
            <input
              type="password"
              inputMode="numeric"
              value={parentPin}
              onChange={(event) => {
                const val = event.target.value.replace(/\D/g, "").slice(0, 6);
                setParentPin(val);
              }}
              onKeyDown={handleKeyDown}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
              placeholder="1234"
              maxLength="6"
            />
            <p className="mt-1 text-xs text-slate-500">4-6 digits. Required for students to switch to their workspace.</p>
          </label>
        </div>

        <button
          onClick={() => {
            void createAccount();
          }}
          disabled={loading}
          className="mt-6 w-full rounded-xl bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-60"
        >
          {loading ? "Creating Account..." : "Create Account"}
        </button>

        <p className="mt-4 text-center text-sm text-slate-600">
          Already have an account? <Link className="font-medium text-cyan-700 hover:underline" to="/login">Sign In</Link>
        </p>

        {error ? <p className="mt-3 rounded-lg bg-rose-50 p-3 text-sm text-rose-700 font-medium">{error}</p> : null}
        {success ? <p className="mt-3 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-700 font-medium">{success}</p> : null}
      </section>
    </div>
  );
}
