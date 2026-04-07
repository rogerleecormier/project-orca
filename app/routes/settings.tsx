import { useState } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import {
  changeParentPin,
  createMarkingPeriods,
  deleteMarkingPeriod,
  getMarkingPeriods,
  getParentSettingsData,
  getViewerContext,
  resetWorkspaceContent,
  resetParentPinWithPassword,
  seedDemoPhase1,
  seedDemoPhase2,
  seedDemoPhase3,
  seedDemoPhase4,
  seedDemoPhase5,
  seedDemoPhase6,
  seedDemoPhase7,
  updateMarkingPeriod,
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

    const [settingsData, markingPeriodsData] = await Promise.all([
      getParentSettingsData(),
      getMarkingPeriods(),
    ]);

    return { ...settingsData, markingPeriods: markingPeriodsData };
  },
  component: SettingsPage,
});

type SeedPhaseStatus = "idle" | "running" | "done" | "error";

const SEED_PHASES = [
  { label: "Students & Marking Periods", key: "phase1" },
  { label: "Classes & Enrollments", key: "phase2" },
  { label: "Assignments", key: "phase3" },
  { label: "Skill Trees & Nodes", key: "phase4" },
  { label: "Node Assignment Links", key: "phase5" },
  { label: "Progress & Submissions", key: "phase6" },
  { label: "Rewards & Week Plans", key: "phase7" },
] as const;

type PhaseKey = (typeof SEED_PHASES)[number]["key"];

function DemoSeedWizard({ onClose }: { onClose: () => void }) {
  const [pin, setPin] = useState("");
  const [started, setStarted] = useState(false);
  const [phaseStatuses, setPhaseStatuses] = useState<Record<PhaseKey, SeedPhaseStatus>>({
    phase1: "idle", phase2: "idle", phase3: "idle", phase4: "idle",
    phase5: "idle", phase6: "idle", phase7: "idle",
  });
  const [phaseMessages, setPhaseMessages] = useState<Record<PhaseKey, string>>({
    phase1: "", phase2: "", phase3: "", phase4: "",
    phase5: "", phase6: "", phase7: "",
  });
  const [done, setDone] = useState(false);
  const [finalSummary, setFinalSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setPhase = (key: PhaseKey, status: SeedPhaseStatus, message = "") => {
    setPhaseStatuses(prev => ({ ...prev, [key]: status }));
    setPhaseMessages(prev => ({ ...prev, [key]: message }));
  };

  const runSeed = async () => {
    if (pin.length < 4) return;
    setStarted(true);
    setError(null);

    try {
      // Phase 1
      setPhase("phase1", "running");
      const p1 = await seedDemoPhase1({ data: { parentPin: pin } });
      setPhase("phase1", "done", `${p1.summary.studentsCreated} students, ${p1.summary.markingPeriodsCreated} periods`);

      // Phase 2
      setPhase("phase2", "running");
      const p2 = await seedDemoPhase2({
        data: { parentPin: pin, profileIds: p1.profileIds, markingPeriodIds: p1.markingPeriodIds },
      });
      setPhase("phase2", "done", `${p2.summary.classesCreated} classes`);

      // Phase 3
      setPhase("phase3", "running");
      const p3 = await seedDemoPhase3({
        data: { parentPin: pin, classMap: p2.classMap, markingPeriodIds: p1.markingPeriodIds },
      });
      setPhase("phase3", "done", `ready`);

      // Phase 4 — one class per call to stay within D1 write limits
      setPhase("phase4", "running");
      const allTreeNodeMap: Awaited<ReturnType<typeof seedDemoPhase4>>["treeNodeMap"] = [];
      let totalAssignmentsCreated = 0;
      for (const cls of p2.classMap) {
        const p4batch = await seedDemoPhase4({
          data: { parentPin: pin, classMap: [cls], markingPeriodIds: p1.markingPeriodIds },
        });
        allTreeNodeMap.push(...p4batch.treeNodeMap);
        totalAssignmentsCreated += p4batch.summary.assignmentsCreated;
      }
      const p4 = { treeNodeMap: allTreeNodeMap, summary: { treesCreated: p2.classMap.length, assignmentsCreated: totalAssignmentsCreated } };
      setPhase("phase4", "done", `${p4.summary.treesCreated} skill trees, ${p4.summary.assignmentsCreated} assignments`);

      // Phase 5
      setPhase("phase5", "running");
      const p5 = await seedDemoPhase5({
        data: { parentPin: pin, treeNodeMap: p4.treeNodeMap, assignmentMap: p3.assignmentMap, classMap: p2.classMap },
      });
      setPhase("phase5", "done", `linked`);

      // Phase 6
      setPhase("phase6", "running");
      const p6 = await seedDemoPhase6({
        data: { parentPin: pin, assignmentMap: p3.assignmentMap, treeNodeMap: p4.treeNodeMap },
      });
      setPhase("phase6", "done", `${p6.summary.submissionsCreated} submissions, ${p6.summary.progressCreated} progress records`);

      // Phase 7
      setPhase("phase7", "running");
      const p7 = await seedDemoPhase7({
        data: { parentPin: pin, profileIds: p1.profileIds, assignmentMap: p3.assignmentMap },
      });
      setPhase("phase7", "done", `${p7.summary.rewardTracksCreated} tracks, ${p7.summary.weekPlanCreated} plan entries`);

      setFinalSummary(
        `${p1.summary.studentsCreated} students · ${p2.summary.classesCreated} classes · ${p4.summary.treesCreated} skill trees · ${p4.summary.assignmentsCreated} assignments · ${p7.summary.rewardTracksCreated} reward tracks`
      );
      setDone(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      if (msg.includes("INVALID_PIN")) {
        setError("Parent PIN is incorrect.");
      } else {
        setError(`Seeding failed: ${msg}`);
      }
    }
  };

  const phaseIcon = (status: SeedPhaseStatus) => {
    if (status === "idle") return <span className="inline-block h-4 w-4 rounded-full border-2 border-slate-300" />;
    if (status === "running") return <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-cyan-500 border-t-transparent" />;
    if (status === "done") return <span className="inline-block h-4 w-4 rounded-full bg-emerald-500 text-[9px] font-bold text-white flex items-center justify-center">✓</span>;
    return <span className="inline-block h-4 w-4 rounded-full bg-rose-500 text-[9px] font-bold text-white flex items-center justify-center">!</span>;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-slate-900">Seed Full Demo Content</h3>
          {!started && (
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none">×</button>
          )}
        </div>

        {!started && (
          <>
            <p className="text-sm text-slate-600 mb-4">
              Seeds 6 students with 5 subjects each, 3 marking periods of assignments, skill trees, progress, and reward tracks simulating a partial school year.
            </p>
            <label className="block space-y-1 mb-4">
              <span className="text-sm font-medium text-slate-700">Parent PIN</span>
              <input
                type="password"
                inputMode="numeric"
                value={pin}
                onChange={e => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                maxLength={6}
                placeholder="Enter your PIN"
              />
            </label>
            {error && <p className="text-sm text-rose-600 mb-3">{error}</p>}
            <div className="flex gap-2">
              <button
                onClick={() => void runSeed()}
                disabled={pin.length < 4}
                className="flex-1 rounded-xl bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-60"
              >
                Start Seeding
              </button>
              <button onClick={onClose} className="rounded-xl border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">
                Cancel
              </button>
            </div>
          </>
        )}

        {started && (
          <div className="space-y-3">
            {SEED_PHASES.map(phase => (
              <div key={phase.key} className="flex items-center gap-3">
                {phaseIcon(phaseStatuses[phase.key])}
                <div className="flex-1 min-w-0">
                  <span className="text-sm text-slate-800">{phase.label}</span>
                  {phaseMessages[phase.key] && (
                    <span className="ml-2 text-xs text-slate-500">{phaseMessages[phase.key]}</span>
                  )}
                </div>
              </div>
            ))}

            {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}

            {done && (
              <div className="mt-4 rounded-xl bg-emerald-50 border border-emerald-200 p-4">
                <p className="text-sm font-semibold text-emerald-800">Demo content seeded!</p>
                {finalSummary && <p className="text-xs text-emerald-700 mt-1">{finalSummary}</p>}
                <p className="text-xs text-slate-600 mt-1">Student PIN: <strong>1111</strong></p>
                <button
                  onClick={() => { onClose(); window.location.reload(); }}
                  className="mt-3 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
                >
                  Done
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function MarkingPeriodsCard({
  initialPeriods,
}: {
  initialPeriods: Awaited<ReturnType<typeof getMarkingPeriods>>;
}) {
  const [periods, setPeriods] = useState(initialPeriods);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [selectedCount, setSelectedCount] = useState<2 | 3 | 4>(4);
  const [schoolYear, setSchoolYear] = useState("2025-2026");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editLabel, setEditLabel] = useState("");
  const [editStart, setEditStart] = useState("");
  const [editEnd, setEditEnd] = useState("");
  const [editStatus, setEditStatus] = useState<"upcoming" | "active" | "completed">("upcoming");
  const [saving, setSaving] = useState(false);

  const handleCreate = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const result = await createMarkingPeriods({ data: { count: selectedCount, schoolYear } });
      setPeriods(result.periods);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Could not create marking periods.");
    } finally {
      setCreating(false);
    }
  };

  const startEdit = (p: (typeof periods)[number]) => {
    setEditingId(p.id);
    setEditTitle(p.title);
    setEditLabel(p.label);
    setEditStart(p.startDate);
    setEditEnd(p.endDate);
    setEditStatus(p.status as "upcoming" | "active" | "completed");
  };

  const saveEdit = async () => {
    if (!editingId) return;
    setSaving(true);
    try {
      await updateMarkingPeriod({
        data: { id: editingId, title: editTitle, label: editLabel, startDate: editStart, endDate: editEnd, status: editStatus },
      });
      setPeriods(prev => prev.map(p => p.id === editingId ? { ...p, title: editTitle, label: editLabel, startDate: editStart, endDate: editEnd, status: editStatus } : p));
      setEditingId(null);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm("Delete this marking period? Classes and assignments tagged to it will be untagged.")) return;
    await deleteMarkingPeriod({ data: { id } });
    setPeriods(prev => prev.filter(p => p.id !== id));
  };

  const statusColor = (s: string) =>
    s === "completed" ? "bg-slate-100 text-slate-600" :
    s === "active" ? "bg-cyan-100 text-cyan-700" :
    "bg-amber-50 text-amber-700";

  return (
    <section className="rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
      <h2 className="text-xl font-semibold text-slate-900">Marking Periods</h2>
      <p className="mt-2 text-sm text-slate-600">
        Divide the school year into 2, 3, or 4 grading periods. Classes and assignments can be tagged to a period.
      </p>

      {periods.length === 0 ? (
        <div className="mt-5 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="block space-y-1">
              <span className="text-sm font-medium text-slate-700">Number of periods</span>
              <select
                value={selectedCount}
                onChange={e => setSelectedCount(Number(e.target.value) as 2 | 3 | 4)}
                className="rounded-xl border border-slate-300 px-3 py-2 text-sm"
              >
                <option value={2}>2 — Semesters</option>
                <option value={3}>3 — Trimesters</option>
                <option value={4}>4 — Quarters</option>
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-sm font-medium text-slate-700">School Year</span>
              <input
                value={schoolYear}
                onChange={e => setSchoolYear(e.target.value)}
                className="rounded-xl border border-slate-300 px-3 py-2 text-sm w-28"
                placeholder="2025-2026"
              />
            </label>
            <button
              onClick={() => void handleCreate()}
              disabled={creating}
              className="rounded-xl bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-60"
            >
              {creating ? "Creating..." : "Generate Periods"}
            </button>
          </div>
          {createError && <p className="text-sm text-rose-600">{createError}</p>}
        </div>
      ) : (
        <div className="mt-5 space-y-3">
          {periods.map(p => (
            <div key={p.id} className="rounded-xl border border-slate-200 p-3">
              {editingId === p.id ? (
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <input value={editLabel} onChange={e => setEditLabel(e.target.value)} className="w-16 rounded-lg border border-slate-300 px-2 py-1 text-sm" placeholder="Label" />
                    <input value={editTitle} onChange={e => setEditTitle(e.target.value)} className="flex-1 rounded-lg border border-slate-300 px-2 py-1 text-sm" placeholder="Title" />
                  </div>
                  <div className="flex flex-wrap gap-2 items-center">
                    <input type="date" value={editStart} onChange={e => setEditStart(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1 text-sm" />
                    <span className="text-slate-400 text-xs">to</span>
                    <input type="date" value={editEnd} onChange={e => setEditEnd(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1 text-sm" />
                    <select value={editStatus} onChange={e => setEditStatus(e.target.value as "upcoming" | "active" | "completed")} className="rounded-lg border border-slate-300 px-2 py-1 text-sm">
                      <option value="upcoming">Upcoming</option>
                      <option value="active">Active</option>
                      <option value="completed">Completed</option>
                    </select>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => void saveEdit()} disabled={saving} className="rounded-lg bg-cyan-600 px-3 py-1 text-xs font-medium text-white hover:bg-cyan-700 disabled:opacity-60">{saving ? "Saving..." : "Save"}</button>
                    <button onClick={() => setEditingId(null)} className="rounded-lg border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50">Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs font-bold text-slate-500 w-8 shrink-0">{p.label}</span>
                    <span className="text-sm font-medium text-slate-800 truncate">{p.title}</span>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium shrink-0 ${statusColor(p.status)}`}>{p.status}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs text-slate-500">{p.startDate} – {p.endDate}</span>
                    <button onClick={() => startEdit(p)} className="text-xs text-cyan-600 hover:underline">Edit</button>
                    <button onClick={() => void handleDelete(p.id)} className="text-xs text-rose-500 hover:underline">Delete</button>
                  </div>
                </div>
              )}
            </div>
          ))}
          <p className="text-xs text-slate-500">Periods auto-compute status based on today's date. You can override per period above.</p>
        </div>
      )}
    </section>
  );
}

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
  const [resettingContent, setResettingContent] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const [contentSuccess, setContentSuccess] = useState<string | null>(null);
  const [showSeedWizard, setShowSeedWizard] = useState(false);

  const saveProfile = async () => {
    setProfileSaving(true);
    setProfileError(null);
    setProfileSuccess(null);
    try {
      await updateParentSettings({ data: { name: name.trim(), email: email.trim(), username: username.trim() } });
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
    if (!/^\d{4,6}$/.test(newPin)) { setPinSaving(false); setPinError("New PIN must be 4 to 6 digits."); return; }
    if (newPin !== confirmPin) { setPinSaving(false); setPinError("New PIN and confirmation do not match."); return; }
    try {
      const result = await changeParentPin({ data: { currentPin: currentPin.trim(), newPin: newPin.trim() } });
      setPinLength(result.parentPinLength);
      setCurrentPin(""); setNewPin(""); setConfirmPin("");
      setPinSuccess("Parent PIN updated.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("INVALID_PIN")) setPinError("Current PIN is incorrect.");
      else if (message.includes("PIN_LENGTH_MIGRATION_REQUIRED")) setPinError("Database migration required.");
      else setPinError("Could not update parent PIN.");
    } finally {
      setPinSaving(false);
    }
  };

  const recoverPin = async () => {
    setRecoverySaving(true);
    setRecoveryError(null);
    setRecoverySuccess(null);
    if (!/^\d{4,6}$/.test(recoveryNewPin)) { setRecoverySaving(false); setRecoveryError("New PIN must be 4 to 6 digits."); return; }
    if (recoveryNewPin !== recoveryConfirmPin) { setRecoverySaving(false); setRecoveryError("New PIN and confirmation do not match."); return; }
    try {
      const result = await resetParentPinWithPassword({ data: { accountPassword: recoveryPassword, newPin: recoveryNewPin } });
      setPinLength(result.parentPinLength);
      setRecoveryPassword(""); setRecoveryNewPin(""); setRecoveryConfirmPin("");
      setRecoverySuccess("Parent PIN reset successfully.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("INVALID_PASSWORD")) setRecoveryError("Account password is incorrect.");
      else if (message.includes("PIN_LENGTH_MIGRATION_REQUIRED")) setRecoveryError("Database migration required.");
      else setRecoveryError("Could not reset parent PIN.");
    } finally {
      setRecoverySaving(false);
    }
  };

  const runResetContent = async () => {
    if (!window.confirm("This will delete ALL students, classes, assignments, skill trees, templates, week plans, and submissions. Continue?")) return;
    setContentError(null);
    setContentSuccess(null);
    setResettingContent(true);
    try {
      const result = await resetWorkspaceContent({ data: { parentPin: contentPin.trim() } });
      setContentSuccess(
        `Workspace reset complete. Deleted ${result.summary.profilesDeleted} students, ${result.summary.classesDeleted} classes, ${result.summary.assignmentsDeleted} assignments, and ${result.summary.skillTreesDeleted} skill trees.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("INVALID_PIN")) setContentError("Parent PIN is incorrect.");
      else setContentError(`Could not reset workspace content. ${message ? `(${message})` : ""}`.trim());
    } finally {
      setResettingContent(false);
    }
  };

  return (
    <div className="space-y-6">
      {showSeedWizard && <DemoSeedWizard onClose={() => setShowSeedWizard(false)} />}

      <section className="orca-hero orca-wave rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
        <p className="text-xs uppercase tracking-[0.2em] text-cyan-700">Parent Workspace</p>
        <div className="mt-2 flex items-center gap-3">
          <span className="orca-icon-chip" aria-hidden="true">
            <OrcaMark className="h-6 w-6" alt="" />
          </span>
          <h1 className="text-3xl font-semibold text-slate-900">Settings</h1>
        </div>
        <p className="mt-2 text-slate-600">Update your account profile and manage your parent PIN.</p>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <article className="rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-900">Profile</h2>
          <p className="mt-2 text-sm text-slate-600">Name, email, and username used for your account.</p>
          <div className="mt-5 space-y-4">
            <label className="block space-y-2">
              <span className="text-sm font-medium text-slate-700">Name</span>
              <input value={name} onChange={e => setName(e.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800" />
            </label>
            <label className="block space-y-2">
              <span className="text-sm font-medium text-slate-700">Email</span>
              <input value={email} onChange={e => setEmail(e.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800" inputMode="email" />
            </label>
            <label className="block space-y-2">
              <span className="text-sm font-medium text-slate-700">Username</span>
              <input value={username} onChange={e => setUsername(e.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800" />
            </label>
          </div>
          {profileError ? <p className="mt-4 text-sm font-medium text-rose-700">{profileError}</p> : null}
          {profileSuccess ? <p className="mt-4 text-sm font-medium text-emerald-700">{profileSuccess}</p> : null}
          <button type="button" onClick={() => void saveProfile()} disabled={profileSaving} className="mt-5 rounded-xl bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-60">
            {profileSaving ? "Saving..." : "Save Profile"}
          </button>
        </article>

        <article className="rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-900">Parent PIN</h2>
          <p className="mt-2 text-sm text-slate-600">Change your parent PIN used for protected actions.</p>
          {pinLength ? <p className="mt-2 text-xs text-slate-500">Current configured PIN length: {pinLength} digits.</p> : null}
          <div className="mt-5 space-y-4">
            <label className="block space-y-2">
              <span className="text-sm font-medium text-slate-700">Current PIN</span>
              <input type="password" inputMode="numeric" value={currentPin} onChange={e => setCurrentPin(e.target.value.replace(/\D/g, "").slice(0, 6))} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800" maxLength={6} />
            </label>
            <label className="block space-y-2">
              <span className="text-sm font-medium text-slate-700">New PIN</span>
              <input type="password" inputMode="numeric" value={newPin} onChange={e => setNewPin(e.target.value.replace(/\D/g, "").slice(0, 6))} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800" maxLength={6} />
            </label>
            <label className="block space-y-2">
              <span className="text-sm font-medium text-slate-700">Confirm New PIN</span>
              <input type="password" inputMode="numeric" value={confirmPin} onChange={e => setConfirmPin(e.target.value.replace(/\D/g, "").slice(0, 6))} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800" maxLength={6} />
            </label>
          </div>
          {pinError ? <p className="mt-4 text-sm font-medium text-rose-700">{pinError}</p> : null}
          {pinSuccess ? <p className="mt-4 text-sm font-medium text-emerald-700">{pinSuccess}</p> : null}
          <button type="button" onClick={() => void savePin()} disabled={pinSaving} className="mt-5 rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60">
            {pinSaving ? "Updating..." : "Update Parent PIN"}
          </button>
        </article>
      </section>

      <MarkingPeriodsCard initialPeriods={data.markingPeriods} />

      <section className="rounded-2xl border border-amber-200 bg-amber-50/60 p-6 shadow-sm">
        <h2 className="text-xl font-semibold text-slate-900">PIN Recovery (Legacy)</h2>
        <p className="mt-2 text-sm text-slate-700">If your old parent PIN no longer verifies, reset it using your account password.</p>
        <div className="mt-5 grid gap-4 md:grid-cols-3">
          <label className="block space-y-2">
            <span className="text-sm font-medium text-slate-700">Account Password</span>
            <input type="password" value={recoveryPassword} onChange={e => setRecoveryPassword(e.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800" />
          </label>
          <label className="block space-y-2">
            <span className="text-sm font-medium text-slate-700">New PIN</span>
            <input type="password" inputMode="numeric" value={recoveryNewPin} onChange={e => setRecoveryNewPin(e.target.value.replace(/\D/g, "").slice(0, 6))} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800" maxLength={6} />
          </label>
          <label className="block space-y-2">
            <span className="text-sm font-medium text-slate-700">Confirm New PIN</span>
            <input type="password" inputMode="numeric" value={recoveryConfirmPin} onChange={e => setRecoveryConfirmPin(e.target.value.replace(/\D/g, "").slice(0, 6))} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800" maxLength={6} />
          </label>
        </div>
        {recoveryError ? <p className="mt-4 text-sm font-medium text-rose-700">{recoveryError}</p> : null}
        {recoverySuccess ? <p className="mt-4 text-sm font-medium text-emerald-700">{recoverySuccess}</p> : null}
        <button type="button" onClick={() => void recoverPin()} disabled={recoverySaving} className="mt-5 rounded-xl bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-60">
          {recoverySaving ? "Resetting..." : "Reset Parent PIN with Password"}
        </button>
      </section>

      <section className="rounded-2xl border border-rose-200 bg-rose-50/50 p-6 shadow-sm">
        <h2 className="text-xl font-semibold text-slate-900">Content Controls</h2>
        <p className="mt-2 text-sm text-slate-700">
          Seed complete demo data or reset this workspace to a blank vanilla state. Both actions require your parent PIN.
        </p>

        <div className="mt-5 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => setShowSeedWizard(true)}
            className="rounded-xl bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700"
          >
            Seed Full Demo Content
          </button>
        </div>

        <p className="mt-3 text-xs text-slate-600">
          Full demo seeds 6 students, 5 subjects each, 3 marking periods of assignments, skill trees, reward tracks, and submissions simulating ~60% year completion. Student PIN: <strong>1111</strong>
        </p>

        <div className="mt-5 border-t border-rose-200 pt-5">
          <label className="block max-w-xs space-y-2">
            <span className="text-sm font-medium text-slate-700">Parent PIN (for reset)</span>
            <input
              type="password"
              inputMode="numeric"
              value={contentPin}
              onChange={e => setContentPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
              maxLength={6}
            />
          </label>
          <button
            type="button"
            onClick={() => void runResetContent()}
            disabled={resettingContent || contentPin.length < 4}
            className="mt-3 rounded-xl bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-60"
          >
            {resettingContent ? "Resetting..." : "Reset to Vanilla"}
          </button>
          <p className="mt-2 text-xs text-slate-600">Reset removes all student/class/assignment/tree/template content for this workspace.</p>
        </div>

        {contentError ? <p className="mt-4 text-sm font-medium text-rose-700">{contentError}</p> : null}
        {contentSuccess ? <p className="mt-4 text-sm font-medium text-emerald-700">{contentSuccess}</p> : null}
      </section>
    </div>
  );
}
