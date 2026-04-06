import { useEffect, useRef, useState } from "react";

type StudentProfileOption = {
  id: string;
  displayName: string;
  gradeLevel: string | null;
};

type PostLoginRoleModalProps = {
  open: boolean;
  profiles: StudentProfileOption[];
  loading: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirmParent: (pin: string) => void;
  onConfirmStudent: (profileId: string, pin: string) => void;
};

type RoleMode = "parent" | "student" | null;

export function PostLoginRoleModal({
  open,
  profiles,
  loading,
  error,
  onCancel,
  onConfirmParent,
  onConfirmStudent,
}: PostLoginRoleModalProps) {
  const [mode, setMode] = useState<RoleMode>(null);
  const [parentPin, setParentPin] = useState("");
  const [studentPin, setStudentPin] = useState("");
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setMode(null);
    setParentPin("");
    setStudentPin("");
    setSelectedProfileId(profiles[0]?.id ?? "");
  }, [open, profiles]);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCancel();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  const canContinueAsParent = mode === "parent" && /^\d{4,6}$/.test(parentPin);
  const canContinueAsStudent =
    mode === "student" &&
    Boolean(selectedProfileId) &&
    /^\d{4,8}$/.test(studentPin);
  const canContinue = canContinueAsParent || canContinueAsStudent;

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === backdropRef.current) {
          onCancel();
        }
      }}
    >
      <div className="mx-4 w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl">
        <p className="text-xs uppercase tracking-[0.2em] text-cyan-700">Choose Access</p>
        <h2 className="mt-2 text-xl font-semibold text-slate-900">Parent or Student</h2>
        <p className="mt-2 text-sm text-slate-600">
          Select how to enter and provide the associated PIN.
        </p>

        <div className="mt-5 grid grid-cols-2 gap-3">
          <button
            type="button"
            disabled={loading}
            onClick={() => setMode("parent")}
            className={`rounded-xl border px-4 py-2 text-sm font-medium transition ${
              mode === "parent"
                ? "border-cyan-400 bg-cyan-50 text-cyan-900"
                : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            Parent
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={() => setMode("student")}
            className={`rounded-xl border px-4 py-2 text-sm font-medium transition ${
              mode === "student"
                ? "border-emerald-400 bg-emerald-50 text-emerald-900"
                : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            Student
          </button>
        </div>

        {mode === "parent" ? (
          <label className="mt-4 block space-y-2">
            <span className="text-sm font-medium text-slate-700">Parent PIN</span>
            <input
              type="password"
              inputMode="numeric"
              value={parentPin}
              onChange={(event) => setParentPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
              maxLength={6}
              disabled={loading}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
              placeholder="4-6 digits"
            />
          </label>
        ) : null}

        {mode === "student" ? (
          <div className="mt-4 space-y-3">
            <label className="block space-y-2">
              <span className="text-sm font-medium text-slate-700">Student</span>
              <select
                value={selectedProfileId}
                onChange={(event) => setSelectedProfileId(event.target.value)}
                disabled={loading || profiles.length === 0}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500 disabled:bg-slate-100"
              >
                {profiles.length === 0 ? <option value="">No students available</option> : null}
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.displayName}
                    {profile.gradeLevel ? ` (Grade ${profile.gradeLevel})` : ""}
                  </option>
                ))}
              </select>
            </label>

            <label className="block space-y-2">
              <span className="text-sm font-medium text-slate-700">Student PIN</span>
              <input
                type="password"
                inputMode="numeric"
                value={studentPin}
                onChange={(event) => setStudentPin(event.target.value.replace(/\D/g, "").slice(0, 8))}
                maxLength={8}
                disabled={loading}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                placeholder="4-8 digits"
              />
            </label>
          </div>
        ) : null}

        {error ? <p className="mt-3 text-sm font-medium text-rose-700">{error}</p> : null}

        <div className="mt-5 flex gap-3">
          <button
            type="button"
            disabled={loading}
            onClick={onCancel}
            className="flex-1 rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canContinue || loading}
            onClick={() => {
              if (mode === "parent") {
                onConfirmParent(parentPin);
              } else if (mode === "student") {
                onConfirmStudent(selectedProfileId, studentPin);
              }
            }}
            className="flex-1 rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {loading ? "Checking..." : "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}
