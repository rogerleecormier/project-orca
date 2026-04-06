import { useState } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import {
  changeParentPin,
  getParentSettingsData,
  getViewerContext,
  resetWorkspaceContent,
  resetParentPinWithPassword,
  seedDemoWorkspaceContent,
  updateParentSettings,
} from "../server/functions";
import { OrcaMark } from "../components/icons/orca-mark";

export const Route = createFileRoute("/settings")({
  loader: async () => {
    const viewer = await getViewerContext();

    if (!viewer.isAuthenticated) {
      throw redirect({ to: "/login" });
    }

    if (viewer.activeRole === "student") {
      throw redirect({ to: "/student" });
    }

    return await getParentSettingsData();
  },
  component: SettingsPage,
});

function SettingsPage() {
  const data = Route.useLoaderData();

  const [name, setName] = useState(data.name);
  const [email, setEmail] = useState(data.email);
  const [username, setUsername] = useState(data.username);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileSuccess, setProfileSuccess] = useState<string | null>(null);

  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [pinLength, setPinLength] = useState<number | null>(data.parentPinLength ?? null);
  const [pinSaving, setPinSaving] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinSuccess, setPinSuccess] = useState<string | null>(null);
  const [recoveryPassword, setRecoveryPassword] = useState("");
  const [recoveryNewPin, setRecoveryNewPin] = useState("");
  const [recoveryConfirmPin, setRecoveryConfirmPin] = useState("");
  const [recoverySaving, setRecoverySaving] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [recoverySuccess, setRecoverySuccess] = useState<string | null>(null);
  const [contentPin, setContentPin] = useState("");
  const [seedingDemo, setSeedingDemo] = useState(false);
  const [resettingContent, setResettingContent] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const [contentSuccess, setContentSuccess] = useState<string | null>(null);

  const saveProfile = async () => {
    setProfileSaving(true);
    setProfileError(null);
    setProfileSuccess(null);
    try {
      await updateParentSettings({
        data: {
          name: name.trim(),
          email: email.trim(),
          username: username.trim(),
        },
      });
      setProfileSuccess("Profile settings updated.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("EMAIL_ALREADY_EXISTS")) {
        setProfileError("That email is already in use.");
      } else if (message.includes("USERNAME_ALREADY_EXISTS")) {
        setProfileError("That username is already in use.");
      } else {
        setProfileError("Could not update profile settings.");
      }
    } finally {
      setProfileSaving(false);
    }
  };

  const savePin = async () => {
    setPinSaving(true);
    setPinError(null);
    setPinSuccess(null);

    if (!/^\d{4,6}$/.test(newPin)) {
      setPinSaving(false);
      setPinError("New PIN must be 4 to 6 digits.");
      return;
    }

    if (newPin !== confirmPin) {
      setPinSaving(false);
      setPinError("New PIN and confirmation do not match.");
      return;
    }

    try {
      const result = await changeParentPin({
        data: {
          currentPin: currentPin.trim(),
          newPin: newPin.trim(),
        },
      });
      setPinLength(result.parentPinLength);
      setCurrentPin("");
      setNewPin("");
      setConfirmPin("");
      setPinSuccess("Parent PIN updated.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("INVALID_PIN")) {
        setPinError("Current PIN is incorrect.");
      } else if (message.includes("PIN_LENGTH_MIGRATION_REQUIRED")) {
        setPinError("Database migration required. Run: pnpm db:migrate:local (or db:migrate:remote).");
      } else {
        setPinError("Could not update parent PIN.");
      }
    } finally {
      setPinSaving(false);
    }
  };

  const recoverPin = async () => {
    setRecoverySaving(true);
    setRecoveryError(null);
    setRecoverySuccess(null);

    if (!/^\d{4,6}$/.test(recoveryNewPin)) {
      setRecoverySaving(false);
      setRecoveryError("New PIN must be 4 to 6 digits.");
      return;
    }

    if (recoveryNewPin !== recoveryConfirmPin) {
      setRecoverySaving(false);
      setRecoveryError("New PIN and confirmation do not match.");
      return;
    }

    try {
      const result = await resetParentPinWithPassword({
        data: {
          accountPassword: recoveryPassword,
          newPin: recoveryNewPin,
        },
      });
      setPinLength(result.parentPinLength);
      setRecoveryPassword("");
      setRecoveryNewPin("");
      setRecoveryConfirmPin("");
      setRecoverySuccess("Parent PIN reset successfully.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("INVALID_PASSWORD")) {
        setRecoveryError("Account password is incorrect.");
      } else if (message.includes("PIN_LENGTH_MIGRATION_REQUIRED")) {
        setRecoveryError("Database migration required. Run: pnpm db:migrate:local (or db:migrate:remote).");
      } else {
        setRecoveryError("Could not reset parent PIN.");
      }
    } finally {
      setRecoverySaving(false);
    }
  };

  const runSeedDemoContent = async () => {
    setContentError(null);
    setContentSuccess(null);
    setSeedingDemo(true);
    try {
      const result = await seedDemoWorkspaceContent({
        data: {
          parentPin: contentPin.trim(),
        },
      });
      setContentSuccess(
        `Demo content created: ${result.summary.studentsCreated} students, ${result.summary.classesCreated} classes, ${result.summary.assignmentsCreated} assignments, ${result.summary.treesCreated} skill trees.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("INVALID_PIN")) {
        setContentError("Parent PIN is incorrect.");
      } else if (
        message.includes("ZodError") ||
        message.includes("Validation failed") ||
        message.includes("parentPin")
      ) {
        setContentError("Enter your 4-6 digit parent PIN before seeding demo content.");
      } else if (message.includes("DEMO_CONTENT_ALREADY_EXISTS")) {
        setContentError("Demo content already exists. Reset content first if you want a fresh demo set.");
      } else {
        setContentError(`Could not seed demo content. ${message ? `(${message})` : ""}`.trim());
      }
    } finally {
      setSeedingDemo(false);
    }
  };

  const runResetContent = async () => {
    if (!window.confirm("This will delete ALL students, classes, assignments, skill trees, templates, week plans, and submissions. Continue?")) {
      return;
    }

    setContentError(null);
    setContentSuccess(null);
    setResettingContent(true);
    try {
      const result = await resetWorkspaceContent({
        data: {
          parentPin: contentPin.trim(),
        },
      });
      setContentSuccess(
        `Workspace reset complete. Deleted ${result.summary.profilesDeleted} students, ${result.summary.classesDeleted} classes, ${result.summary.assignmentsDeleted} assignments, and ${result.summary.skillTreesDeleted} skill trees.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("INVALID_PIN")) {
        setContentError("Parent PIN is incorrect.");
      } else {
        setContentError("Could not reset workspace content.");
      }
    } finally {
      setResettingContent(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="orca-hero orca-wave rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
        <p className="text-xs uppercase tracking-[0.2em] text-cyan-700">Parent Workspace</p>
        <div className="mt-2 flex items-center gap-3">
          <span className="orca-icon-chip" aria-hidden="true">
            <OrcaMark className="h-6 w-6" alt="" />
          </span>
          <h1 className="text-3xl font-semibold text-slate-900">Settings</h1>
        </div>
        <p className="mt-2 text-slate-600">
          Update your account profile and manage your parent PIN.
        </p>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <article className="rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-900">Profile</h2>
          <p className="mt-2 text-sm text-slate-600">Name, email, and username used for your account.</p>

          <div className="mt-5 space-y-4">
            <label className="block space-y-2">
              <span className="text-sm font-medium text-slate-700">Name</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
              />
            </label>

            <label className="block space-y-2">
              <span className="text-sm font-medium text-slate-700">Email</span>
              <input
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                inputMode="email"
              />
            </label>

            <label className="block space-y-2">
              <span className="text-sm font-medium text-slate-700">Username</span>
              <input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
              />
            </label>
          </div>

          {profileError ? <p className="mt-4 text-sm font-medium text-rose-700">{profileError}</p> : null}
          {profileSuccess ? <p className="mt-4 text-sm font-medium text-emerald-700">{profileSuccess}</p> : null}

          <button
            type="button"
            onClick={() => void saveProfile()}
            disabled={profileSaving}
            className="mt-5 rounded-xl bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-60"
          >
            {profileSaving ? "Saving..." : "Save Profile"}
          </button>
        </article>

        <article className="rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-900">Parent PIN</h2>
          <p className="mt-2 text-sm text-slate-600">
            Change your parent PIN used for protected actions like delete/archive.
          </p>
          {pinLength ? (
            <p className="mt-2 text-xs text-slate-500">Current configured PIN length: {pinLength} digits.</p>
          ) : null}

          <div className="mt-5 space-y-4">
            <label className="block space-y-2">
              <span className="text-sm font-medium text-slate-700">Current PIN</span>
              <input
                type="password"
                inputMode="numeric"
                value={currentPin}
                onChange={(event) => setCurrentPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                maxLength={6}
              />
            </label>

            <label className="block space-y-2">
              <span className="text-sm font-medium text-slate-700">New PIN</span>
              <input
                type="password"
                inputMode="numeric"
                value={newPin}
                onChange={(event) => setNewPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                maxLength={6}
              />
            </label>

            <label className="block space-y-2">
              <span className="text-sm font-medium text-slate-700">Confirm New PIN</span>
              <input
                type="password"
                inputMode="numeric"
                value={confirmPin}
                onChange={(event) => setConfirmPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                maxLength={6}
              />
            </label>
          </div>

          {pinError ? <p className="mt-4 text-sm font-medium text-rose-700">{pinError}</p> : null}
          {pinSuccess ? <p className="mt-4 text-sm font-medium text-emerald-700">{pinSuccess}</p> : null}

          <button
            type="button"
            onClick={() => void savePin()}
            disabled={pinSaving}
            className="mt-5 rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {pinSaving ? "Updating..." : "Update Parent PIN"}
          </button>
        </article>
      </section>

      <section className="rounded-2xl border border-amber-200 bg-amber-50/60 p-6 shadow-sm">
        <h2 className="text-xl font-semibold text-slate-900">PIN Recovery (Legacy)</h2>
        <p className="mt-2 text-sm text-slate-700">
          If your old parent PIN no longer verifies, you can reset it here using your account password.
        </p>

        <div className="mt-5 grid gap-4 md:grid-cols-3">
          <label className="block space-y-2">
            <span className="text-sm font-medium text-slate-700">Account Password</span>
            <input
              type="password"
              value={recoveryPassword}
              onChange={(event) => setRecoveryPassword(event.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
            />
          </label>

          <label className="block space-y-2">
            <span className="text-sm font-medium text-slate-700">New PIN</span>
            <input
              type="password"
              inputMode="numeric"
              value={recoveryNewPin}
              onChange={(event) => setRecoveryNewPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
              maxLength={6}
            />
          </label>

          <label className="block space-y-2">
            <span className="text-sm font-medium text-slate-700">Confirm New PIN</span>
            <input
              type="password"
              inputMode="numeric"
              value={recoveryConfirmPin}
              onChange={(event) => setRecoveryConfirmPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
              maxLength={6}
            />
          </label>
        </div>

        {recoveryError ? <p className="mt-4 text-sm font-medium text-rose-700">{recoveryError}</p> : null}
        {recoverySuccess ? <p className="mt-4 text-sm font-medium text-emerald-700">{recoverySuccess}</p> : null}

        <button
          type="button"
          onClick={() => void recoverPin()}
          disabled={recoverySaving}
          className="mt-5 rounded-xl bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-60"
        >
          {recoverySaving ? "Resetting..." : "Reset Parent PIN with Password"}
        </button>
      </section>

      <section className="rounded-2xl border border-rose-200 bg-rose-50/50 p-6 shadow-sm">
        <h2 className="text-xl font-semibold text-slate-900">Content Controls</h2>
        <p className="mt-2 text-sm text-slate-700">
          Seed complete demo data or reset this workspace to a blank vanilla state. Both actions require your parent PIN.
        </p>

        <label className="mt-5 block max-w-xs space-y-2">
          <span className="text-sm font-medium text-slate-700">Parent PIN</span>
          <input
            type="password"
            inputMode="numeric"
            value={contentPin}
            onChange={(event) => setContentPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
            maxLength={6}
          />
        </label>

        <div className="mt-4 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => void runSeedDemoContent()}
            disabled={seedingDemo || resettingContent || contentPin.length < 4}
            className="rounded-xl bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-60"
          >
            {seedingDemo ? "Seeding Demo..." : "Seed Demo Content"}
          </button>
          <button
            type="button"
            onClick={() => void runResetContent()}
            disabled={resettingContent || seedingDemo || contentPin.length < 4}
            className="rounded-xl bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-60"
          >
            {resettingContent ? "Resetting..." : "Reset to Vanilla"}
          </button>
        </div>

        <p className="mt-3 text-xs text-slate-600">
          Demo seed creates students, classes, assignments, skill maps, submissions, week plans, and private templates.
        </p>
        <p className="text-xs text-slate-600">
          Reset removes all student/class/assignment/tree/template content for this workspace organization.
        </p>

        {contentError ? <p className="mt-4 text-sm font-medium text-rose-700">{contentError}</p> : null}
        {contentSuccess ? <p className="mt-4 text-sm font-medium text-emerald-700">{contentSuccess}</p> : null}
      </section>
    </div>
  );
}
