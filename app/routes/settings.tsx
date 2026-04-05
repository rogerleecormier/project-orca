import { useState } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import {
  changeParentPin,
  getParentSettingsData,
  getViewerContext,
  resetParentPinWithPassword,
  updateParentSettings,
} from "../server/functions";

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

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
        <p className="text-xs uppercase tracking-[0.2em] text-cyan-700">Parent Workspace</p>
        <h1 className="mt-2 text-3xl font-semibold text-slate-900">Settings</h1>
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
    </div>
  );
}
