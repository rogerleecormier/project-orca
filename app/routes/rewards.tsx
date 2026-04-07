import { useState } from "react";
import { Link, createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import {
  activateRewardTrack,
  aiSuggestRewards,
  createRewardTrack,
  deactivateRewardTrack,
  deliverReward,
  getRewardTracksForOrg,
  getViewerContext,
} from "../server/functions";

// ── Route ─────────────────────────────────────────────────────────────────────

export const Route = createFileRoute("/rewards")({
  loader: async () => {
    const viewer = await getViewerContext();
    if (!viewer.isAuthenticated) throw redirect({ to: "/login" });
    if (viewer.activeRole === "student") throw redirect({ to: "/student" });
    const tracks = await getRewardTracksForOrg();
    return { tracks, viewer };
  },
  component: RewardsIndexPage,
});

// ── Types ─────────────────────────────────────────────────────────────────────

type LoaderData = Awaited<ReturnType<typeof Route.useLoaderData>>;
type TrackRow = LoaderData["tracks"][number];
type TierRow = TrackRow["tiers"][number];
type Claim = ReturnType<typeof useClaims>[number];

function useClaims(track: TrackRow) {
  return track.tiers.flatMap((_tier: TierRow) => {
    // We don't have per-claim rows here — they're on the detail page.
    // The index only knows pendingClaimsCount. We'll use that for the banner.
    return [] as Array<{ id: string; tierId: string; status: string; profileId: string }>;
  });
}

const REWARD_TYPE_LABELS: Record<string, string> = {
  treat: "Treat",
  activity: "Activity",
  item: "Item",
  screen_time: "Screen Time",
  experience: "Experience",
};

const REWARD_TYPE_COLORS: Record<string, string> = {
  treat:       "bg-rose-100 text-rose-700",
  activity:    "bg-emerald-100 text-emerald-700",
  item:        "bg-violet-100 text-violet-700",
  screen_time: "bg-cyan-100 text-cyan-700",
  experience:  "bg-amber-100 text-amber-700",
};

// ── XP Progress Bar ───────────────────────────────────────────────────────────

function RewardProgressBar({
  tiers,
  xpEarned,
  totalXpGoal,
}: {
  tiers: TierRow[];
  xpEarned: number;
  totalXpGoal: number;
}) {
  const [tooltip, setTooltip] = useState<string | null>(null);
  const fillPct = totalXpGoal > 0 ? Math.min(100, (xpEarned / totalXpGoal) * 100) : 0;

  // Sort tiers by threshold for positioning
  const sorted = [...tiers].sort((a, b) => a.xpThreshold - b.xpThreshold);

  return (
    <div className="mt-4">
      <div className="relative h-14">
        {/* Track rail */}
        <div className="absolute left-0 right-0 top-1/2 h-4 -translate-y-1/2 overflow-hidden rounded-full bg-slate-100">
          <div
            className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-violet-500 transition-all duration-700"
            style={{ width: `${fillPct}%` }}
          />
        </div>

        {/* Tier circles */}
        {sorted.map((tier) => {
          const pct = totalXpGoal > 0 ? Math.min(100, (tier.xpThreshold / totalXpGoal) * 100) : 0;
          const isReached = xpEarned >= tier.xpThreshold;

          return (
            <div
              key={tier.id}
              className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
              style={{ left: `${pct}%` }}
              onMouseEnter={() =>
                setTooltip(`${tier.title} — ${tier.xpThreshold.toLocaleString()} XP`)
              }
              onMouseLeave={() => setTooltip(null)}
            >
              <div
                className={`flex h-10 w-10 items-center justify-center rounded-full border-2 text-lg transition-all ${
                  isReached
                    ? "border-violet-400 bg-violet-100 shadow-md"
                    : "border-slate-300 bg-white"
                }`}
              >
                {isReached ? (
                  <span>{tier.icon ?? "🎁"}</span>
                ) : (
                  <span className="text-slate-300">🔒</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Tooltip */}
      <div className="mt-1 h-5 text-center text-xs text-slate-500">
        {tooltip ?? ""}
      </div>

      {/* XP label */}
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>{xpEarned.toLocaleString()} XP earned</span>
        <span>{totalXpGoal.toLocaleString()} XP goal</span>
      </div>
    </div>
  );
}

// ── Active Track Card ─────────────────────────────────────────────────────────

function ActiveTrackCard({ track, onDeactivated }: { track: TrackRow; onDeactivated: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const router = useRouter();

  const xpEarned = track.snapshot?.xpEarned ?? 0;

  async function handleDeactivate() {
    setDeactivating(true);
    try {
      await deactivateRewardTrack({ data: { trackId: track.id } });
      onDeactivated();
    } catch {
      setDeactivating(false);
      setConfirming(false);
    }
  }

  return (
    <article className="rounded-2xl border border-emerald-200 bg-white shadow-sm">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-4 sm:p-5">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-lg font-bold text-slate-600">
          {track.profile?.displayName?.charAt(0).toUpperCase() ?? "?"}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">
            {track.profile?.displayName ?? "Unknown student"}
          </p>
          <h3 className="truncate text-base font-semibold text-slate-900">{track.title}</h3>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">
            ACTIVE
          </span>
          <Link
            to="/rewards/$trackId"
            params={{ trackId: track.id }}
            className="rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 transition"
          >
            Edit
          </Link>
          {confirming ? (
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-slate-600">Deactivate?</span>
              <button
                type="button"
                onClick={() => void handleDeactivate()}
                disabled={deactivating}
                className="rounded-xl bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-700 disabled:opacity-60"
              >
                {deactivating ? "…" : "Yes"}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
              >
                No
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 transition"
            >
              Deactivate
            </button>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div className="px-4 pb-2 pt-4 sm:px-5">
        <RewardProgressBar
          tiers={track.tiers}
          xpEarned={xpEarned}
          totalXpGoal={track.totalXpGoal}
        />
      </div>

      {/* Pending claims banner */}
      {track.pendingClaimsCount > 0 ? (
        <div className="mx-4 mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 sm:mx-5 sm:mb-5">
          <p className="text-sm font-semibold text-amber-800">
            ⚡ {track.pendingClaimsCount} reward{track.pendingClaimsCount > 1 ? "s" : ""} waiting to be delivered
          </p>
          <Link
            to="/rewards/$trackId"
            params={{ trackId: track.id }}
            className="mt-1.5 inline-block text-xs font-medium text-amber-700 underline-offset-2 hover:underline"
          >
            Review &amp; deliver →
          </Link>
        </div>
      ) : null}
    </article>
  );
}

// ── Tracks Table ──────────────────────────────────────────────────────────────

function TrackTableRow({
  track,
  onActivated,
  onDeactivated,
}: {
  track: TrackRow;
  onActivated: () => void;
  onDeactivated: () => void;
}) {
  const [activating, setActivating] = useState(false);
  const [deactivating, setDeactivating] = useState(false);

  const status = track.completedAt
    ? "completed"
    : track.isActive
      ? "active"
      : "inactive";

  const statusBadge =
    status === "active"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : status === "completed"
        ? "border-slate-200 bg-slate-100 text-slate-500"
        : "border-slate-200 bg-slate-50 text-slate-500";

  async function handleActivate() {
    setActivating(true);
    try {
      await activateRewardTrack({ data: { trackId: track.id } });
      onActivated();
    } catch {
      setActivating(false);
    }
  }

  async function handleDeactivate() {
    setDeactivating(true);
    try {
      await deactivateRewardTrack({ data: { trackId: track.id } });
      onDeactivated();
    } catch {
      setDeactivating(false);
    }
  }

  return (
    <tr className="border-t border-slate-100 text-sm">
      <td className="py-3 pr-4 font-medium text-slate-900">
        {track.profile?.displayName ?? "—"}
      </td>
      <td className="py-3 pr-4 text-slate-700">{track.title}</td>
      <td className="py-3 pr-4 text-slate-500">{track.schoolYear ?? "—"}</td>
      <td className="py-3 pr-4 text-slate-500">{track.tiers.length}</td>
      <td className="py-3 pr-4">
        <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${statusBadge}`}>
          {status.charAt(0).toUpperCase() + status.slice(1)}
        </span>
      </td>
      <td className="py-3">
        <div className="flex items-center gap-2">
          <Link
            to="/rewards/$trackId"
            params={{ trackId: track.id }}
            className="text-xs font-medium text-cyan-700 hover:underline"
          >
            Edit
          </Link>
          {status === "inactive" ? (
            <button
              type="button"
              disabled={activating}
              onClick={() => void handleActivate()}
              className="text-xs font-medium text-emerald-700 hover:underline disabled:opacity-50"
            >
              {activating ? "…" : "Activate"}
            </button>
          ) : status === "active" ? (
            <button
              type="button"
              disabled={deactivating}
              onClick={() => void handleDeactivate()}
              className="text-xs font-medium text-rose-600 hover:underline disabled:opacity-50"
            >
              {deactivating ? "…" : "Deactivate"}
            </button>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

// ── Create Track Modal ────────────────────────────────────────────────────────

const REWARD_TYPES = ["treat", "activity", "item", "screen_time", "experience"] as const;
type RewardType = typeof REWARD_TYPES[number];

type DraftTier = {
  tierNumber: number;
  icon: string;
  title: string;
  rewardType: RewardType;
  description: string;
  estimatedValue: string;
};

function makeDraftTiers(totalXpGoal: number): DraftTier[] {
  return Array.from({ length: 10 }, (_, i) => ({
    tierNumber: i + 1,
    icon: "🎁",
    title: "",
    rewardType: "treat" as RewardType,
    description: "",
    estimatedValue: "",
  }));
}

function xpForTier(tierNumber: number, totalXpGoal: number) {
  return Math.round((tierNumber / 10) * totalXpGoal);
}

function CreateTrackModal({
  profiles,
  onClose,
  onCreated,
}: {
  profiles: Array<{ id: string; displayName: string; gradeLevel: string | null }>;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [step, setStep] = useState<1 | 2 | "done">(1);
  const [profileId, setProfileId] = useState(profiles[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [schoolYear, setSchoolYear] = useState("");
  const [totalXpGoal, setTotalXpGoal] = useState(5000);
  const [description, setDescription] = useState("");
  const [draftTiers, setDraftTiers] = useState<DraftTier[]>(() => makeDraftTiers(5000));
  const [creating, setCreating] = useState(false);
  const [activating, setActivating] = useState(false);
  const [createdTrackId, setCreatedTrackId] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<
    Array<{ tierNumber: number; icon: string; title: string; rewardType: string }> | null
  >(null);

  function updateTier(index: number, patch: Partial<DraftTier>) {
    setDraftTiers((prev) => prev.map((t, i) => (i === index ? { ...t, ...patch } : t)));
  }

  async function handleAiSuggest() {
    setAiLoading(true);
    setError(null);
    try {
      const result = await aiSuggestRewards({ data: { profileId } });
      setSuggestions(result);
    } catch {
      setError("AI suggestions failed. You can fill in rewards manually.");
    } finally {
      setAiLoading(false);
    }
  }

  function applySuggestion(
    tierIndex: number,
    suggestion: { icon: string; title: string; rewardType: string },
  ) {
    const validTypes = REWARD_TYPES as readonly string[];
    const rewardType = validTypes.includes(suggestion.rewardType)
      ? (suggestion.rewardType as RewardType)
      : "treat";
    updateTier(tierIndex, { icon: suggestion.icon, title: suggestion.title, rewardType });
  }

  async function handleCreate() {
    if (!title.trim() || !profileId) return;
    setError(null);
    setCreating(true);
    try {
      const result = await createRewardTrack({
        data: {
          profileId,
          title: title.trim(),
          description: description.trim() || undefined,
          schoolYear: schoolYear.trim() || undefined,
          totalXpGoal,
          tiers: draftTiers.map((t) => ({
            tierNumber: t.tierNumber,
            title: t.title.trim() || `Tier ${t.tierNumber} Reward`,
            description: t.description.trim() || undefined,
            icon: t.icon || "🎁",
            rewardType: t.rewardType,
            estimatedValue: t.estimatedValue.trim() || undefined,
          })),
        },
      });
      setCreatedTrackId(result.trackId);
      setStep("done");
    } catch {
      setError("Failed to create track. Please try again.");
    } finally {
      setCreating(false);
    }
  }

  async function handleActivateNow() {
    if (!createdTrackId) return;
    setActivating(true);
    try {
      await activateRewardTrack({ data: { trackId: createdTrackId } });
      onCreated();
    } catch {
      setActivating(false);
      setError("Could not activate track.");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-2xl border border-slate-200 bg-white shadow-2xl">
        {/* Modal header */}
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-4 sm:px-6">
          <h2 className="text-base font-semibold text-slate-900">
            {step === "done" ? "Track Created!" : step === 1 ? "New Reward Track" : "Set Rewards"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"
          >
            <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
          {/* ── Step 1 ── */}
          {step === 1 ? (
            <div className="space-y-4">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-slate-700">Student</label>
                <select
                  value={profileId}
                  onChange={(e) => setProfileId(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none"
                >
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName}{p.gradeLevel ? ` (Grade ${p.gradeLevel})` : ""}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium text-slate-700">Track Title</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Spring 2025 Rewards"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium text-slate-700">School Year</label>
                <input
                  type="text"
                  value={schoolYear}
                  onChange={(e) => setSchoolYear(e.target.value)}
                  placeholder="2024-2025"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium text-slate-700">
                  Total XP Goal
                  <span className="ml-1 font-normal text-slate-500 text-xs">(students earn XP by completing skill tree nodes)</span>
                </label>
                <div className="mb-2 flex flex-wrap gap-2">
                  {[1000, 2500, 5000, 10000].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => {
                        setTotalXpGoal(preset);
                        setDraftTiers(makeDraftTiers(preset));
                      }}
                      className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                        totalXpGoal === preset
                          ? "bg-slate-900 text-white"
                          : "border border-slate-200 text-slate-600 hover:bg-slate-50"
                      }`}
                    >
                      {preset.toLocaleString()} XP
                    </button>
                  ))}
                </div>
                <input
                  type="number"
                  min={100}
                  value={totalXpGoal}
                  onChange={(e) => {
                    const v = Math.max(100, Number(e.target.value));
                    setTotalXpGoal(v);
                  }}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium text-slate-700">Description <span className="font-normal text-slate-400">(optional)</span></label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                  className="w-full resize-none rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none"
                />
              </div>
            </div>
          ) : null}

          {/* ── Step 2 ── */}
          {step === 2 ? (
            <div>
              <div className="mb-4 flex items-center justify-between">
                <p className="text-sm text-slate-600">Set a reward at each XP milestone.</p>
                <button
                  type="button"
                  disabled={aiLoading}
                  onClick={() => void handleAiSuggest()}
                  className="rounded-xl border border-cyan-200 bg-cyan-50 px-3 py-1.5 text-xs font-medium text-cyan-700 hover:bg-cyan-100 disabled:opacity-60 transition"
                >
                  {aiLoading ? "Thinking…" : "✦ Need ideas?"}
                </button>
              </div>

              {/* AI suggestion chips */}
              {suggestions ? (
                <div className="mb-4 rounded-xl border border-cyan-200 bg-cyan-50/60 p-3">
                  <p className="mb-2 text-xs font-semibold text-cyan-800">AI Suggestions — click to apply:</p>
                  <div className="flex flex-wrap gap-1.5">
                    {suggestions.map((s, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => applySuggestion(s.tierNumber - 1, s)}
                        className="rounded-full border border-cyan-200 bg-white px-2.5 py-1 text-xs text-cyan-900 hover:bg-cyan-100 transition"
                      >
                        {s.icon} T{s.tierNumber}: {s.title}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="space-y-2">
                {draftTiers.map((tier, i) => (
                  <div
                    key={tier.tierNumber}
                    className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2.5 sm:flex-nowrap sm:gap-3"
                  >
                    <div className="flex shrink-0 flex-col items-center">
                      <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
                        T{tier.tierNumber}
                      </span>
                      <span className="text-[10px] text-slate-400">
                        {xpForTier(tier.tierNumber, totalXpGoal).toLocaleString()} XP
                      </span>
                    </div>
                    <input
                      type="text"
                      value={tier.icon}
                      onChange={(e) => updateTier(i, { icon: e.target.value })}
                      className="w-10 shrink-0 rounded-lg border border-slate-200 bg-white px-1.5 py-1 text-center text-sm focus:border-cyan-500 focus:outline-none"
                      maxLength={4}
                      placeholder="🎁"
                    />
                    <input
                      type="text"
                      value={tier.title}
                      onChange={(e) => updateTier(i, { title: e.target.value })}
                      placeholder="e.g. Ice cream trip"
                      className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-sm focus:border-cyan-500 focus:outline-none"
                    />
                    <select
                      value={tier.rewardType}
                      onChange={(e) => updateTier(i, { rewardType: e.target.value as RewardType })}
                      className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs focus:outline-none sm:w-auto"
                    >
                      {REWARD_TYPES.map((rt) => (
                        <option key={rt} value={rt}>
                          {REWARD_TYPE_LABELS[rt]}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {/* ── Done ── */}
          {step === "done" ? (
            <div className="py-4 text-center">
              <div className="mb-3 text-4xl">🎉</div>
              <h3 className="text-lg font-semibold text-slate-900">Track created!</h3>
              <p className="mt-1 text-sm text-slate-600">
                Would you like to activate it now so students can start earning rewards?
              </p>
              <div className="mt-5 flex flex-col items-center gap-2">
                <button
                  type="button"
                  disabled={activating}
                  onClick={() => void handleActivateNow()}
                  className="w-full max-w-xs rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
                >
                  {activating ? "Activating…" : "Activate Now"}
                </button>
                <button
                  type="button"
                  onClick={() => { onCreated(); }}
                  className="text-sm text-slate-500 hover:text-slate-700"
                >
                  Set up later
                </button>
              </div>
            </div>
          ) : null}

          {error ? (
            <p className="mt-3 text-sm font-medium text-rose-600">{error}</p>
          ) : null}
        </div>

        {/* Footer buttons */}
        {step === 1 ? (
          <div className="flex justify-end border-t border-slate-100 px-4 py-4 sm:px-6">
            <button
              type="button"
              disabled={!title.trim() || !profileId}
              onClick={() => setStep(2)}
              className="rounded-xl bg-slate-900 px-5 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
            >
              Next: Set Rewards →
            </button>
          </div>
        ) : step === 2 ? (
          <div className="flex items-center justify-between border-t border-slate-100 px-4 py-4 sm:px-6">
            <button
              type="button"
              onClick={() => setStep(1)}
              className="text-sm text-slate-500 hover:text-slate-700"
            >
              ← Back
            </button>
            <button
              type="button"
              disabled={creating}
              onClick={() => void handleCreate()}
              className="rounded-xl bg-slate-900 px-5 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {creating ? "Creating…" : "Create Track"}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

function RewardsIndexPage() {
  const { tracks: initialTracks } = Route.useLoaderData();
  const router = useRouter();
  const [showCreate, setShowCreate] = useState(false);

  // Derive profiles from tracks (unique)
  const profileMap = new Map<string, { id: string; displayName: string; gradeLevel: string | null }>();
  for (const t of initialTracks) {
    if (t.profile && !profileMap.has(t.profile.id)) {
      profileMap.set(t.profile.id, { id: t.profile.id, displayName: t.profile.displayName, gradeLevel: null });
    }
  }
  const profiles = Array.from(profileMap.values());

  const activeTracks = initialTracks.filter((t) => t.isActive);

  return (
    <div className="min-w-0 space-y-6">
      {/* Hero */}
      <section className="orca-hero orca-wave rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="orca-icon-chip" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6" aria-hidden="true">
                <path d="M20 12v8H4v-8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M22 7H2v5h20V7z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M12 22V7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                <path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <div>
              <h2 className="text-xl font-semibold text-slate-900">Reward Tracks</h2>
              <p className="text-sm text-slate-600">Set up milestone rewards to celebrate your student's XP progress.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 transition"
          >
            + New Reward Track
          </button>
        </div>
      </section>

      {/* Active tracks */}
      <section>
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
          Active Tracks
        </h3>
        {activeTracks.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-slate-500">
            No active reward tracks. Activate a track to start rewarding progress.
          </div>
        ) : (
          <div className="space-y-4">
            {activeTracks.map((track) => (
              <ActiveTrackCard
                key={track.id}
                track={track}
                onDeactivated={() => router.invalidate()}
              />
            ))}
          </div>
        )}
      </section>

      {/* All tracks table */}
      <section className="orca-wave rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm sm:p-6">
        <h3 className="mb-4 text-base font-semibold text-slate-900">All Tracks</h3>
        {initialTracks.length === 0 ? (
          <p className="text-sm text-slate-500">No reward tracks yet. Create one to get started.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-left">
              <thead>
                <tr className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">
                  <th className="pb-2 pr-4">Student</th>
                  <th className="pb-2 pr-4">Title</th>
                  <th className="pb-2 pr-4">School Year</th>
                  <th className="pb-2 pr-4">Tiers</th>
                  <th className="pb-2 pr-4">Status</th>
                  <th className="pb-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {initialTracks.map((track) => (
                  <TrackTableRow
                    key={track.id}
                    track={track}
                    onActivated={() => router.invalidate()}
                    onDeactivated={() => router.invalidate()}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Create modal */}
      {showCreate ? (
        <CreateTrackModal
          profiles={profiles}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            router.invalidate();
          }}
        />
      ) : null}
    </div>
  );
}
