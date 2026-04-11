import { useState } from "react";
import { Link, createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import {
  activateRewardTrack,
  aiSuggestRewards,
  deactivateRewardTrack,
  getRewardTrackDetail,
  getViewerContext,
  setRewardClaimDelivered,
  updateRewardTrack,
  upsertRewardTier,
} from "../server/functions";
import { ParentPageHeader } from "../components/parent-page-header";

// ── Route ─────────────────────────────────────────────────────────────────────

export const Route = createFileRoute("/rewards/$trackId")({
  loader: async ({ params }) => {
    const viewer = await getViewerContext();
    if (!viewer.isAuthenticated) throw redirect({ to: "/login" });
    if (viewer.activeRole === "student") throw redirect({ to: "/student" });
    const trackDetail = await getRewardTrackDetail({ data: { trackId: params.trackId } });
    return { trackDetail, viewer };
  },
  component: RewardTrackEditPage,
});

// ── Types ─────────────────────────────────────────────────────────────────────

type LoaderData = Awaited<ReturnType<typeof Route.useLoaderData>>;
type TrackDetail = LoaderData["trackDetail"];
type TierRow = TrackDetail["tiers"][number];
type ClaimRow = TrackDetail["claims"][number];

// ── Constants ─────────────────────────────────────────────────────────────────

const REWARD_TYPES = ["treat", "activity", "item", "screen_time", "experience"] as const;

const REWARD_TYPE_LABELS: Record<string, string> = {
  treat:       "Treat",
  activity:    "Activity",
  item:        "Item",
  screen_time: "Screen Time",
  experience:  "Experience",
};

const REWARD_TYPE_COLORS: Record<string, string> = {
  treat:       "bg-rose-100 text-rose-700",
  activity:    "bg-emerald-100 text-emerald-700",
  item:        "bg-violet-100 text-violet-700",
  screen_time: "bg-cyan-100 text-cyan-700",
  experience:  "bg-amber-100 text-amber-700",
};

const CLAIM_STATUS_STYLES: Record<string, string> = {
  unclaimed: "border-slate-200 bg-slate-50 text-slate-500",
  claimed:   "border-amber-200 bg-amber-50 text-amber-700",
  delivered: "border-emerald-200 bg-emerald-50 text-emerald-700",
};

type RewardSuggestionOption = {
  tierNumber: number;
  icon: string;
  title: string;
  rewardType: string;
};

// ── Tier Row Editor ───────────────────────────────────────────────────────────

function TierEditorRow({
  tier,
  claim,
  suggestions,
  onToggleDelivered,
  onSaved,
}: {
  tier: TierRow;
  claim: ClaimRow | undefined;
  suggestions: RewardSuggestionOption[];
  onToggleDelivered: (claim: ClaimRow, delivered: boolean) => Promise<void>;
  onSaved: () => void;
}) {
  const [icon, setIcon] = useState(tier.icon ?? "🎁");
  const [title, setTitle] = useState(tier.title);
  const [rewardType, setRewardType] = useState(tier.rewardType);
  const [estimatedValue, setEstimatedValue] = useState(tier.estimatedValue ?? "");
  const [description, setDescription] = useState(tier.description ?? "");
  const [showNote, setShowNote] = useState(!!tier.description);
  const [saving, setSaving] = useState(false);
  const [selectedSuggestion, setSelectedSuggestion] = useState("");
  const [deliveryUpdating, setDeliveryUpdating] = useState(false);

  const isDirty =
    icon !== (tier.icon ?? "🎁") ||
    title !== tier.title ||
    rewardType !== tier.rewardType ||
    estimatedValue !== (tier.estimatedValue ?? "") ||
    description !== (tier.description ?? "");

  const status: "delivered" | "claimed" | "unclaimed" | "locked" =
    claim?.status === "delivered"
      ? "delivered"
      : claim?.status === "claimed"
        ? "claimed"
        : claim
          ? "unclaimed"
          : "locked";

  const statusLabel = {
    delivered: "Delivered ✓",
    claimed:   "Claimed — pending",
    unclaimed: "Unlocked",
    locked:    "Locked",
  }[status];

  const statusStyle = {
    delivered: "border-emerald-200 bg-emerald-50 text-emerald-700",
    claimed:   "border-amber-200 bg-amber-50 text-amber-700",
    unclaimed: "border-cyan-200 bg-cyan-50 text-cyan-700",
    locked:    "border-slate-200 bg-slate-50 text-slate-400",
  }[status];

  function applySelectedSuggestion() {
    const selected = suggestions.find((s) => `${s.icon}|${s.title}|${s.rewardType}` === selectedSuggestion);
    if (!selected) return;
    setIcon(selected.icon || "🎁");
    setTitle(selected.title);
    setRewardType(selected.rewardType);
  }

  async function handleSave() {
    setSaving(true);
    try {
      await upsertRewardTier({
        data: {
          trackId: tier.trackId,
          tierId: tier.id,
          tierNumber: tier.tierNumber,
          title: title.trim() || tier.title,
          description: description.trim() || undefined,
          icon: icon || "🎁",
          rewardType: rewardType || "treat",
          estimatedValue: estimatedValue.trim() || undefined,
          xpThreshold: tier.xpThreshold,
        },
      });
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={`rounded-2xl border p-4 ${tier.isBonusTier ? "border-amber-200 bg-amber-50/40" : "border-slate-200 bg-white"}`}>
      <div className="flex flex-wrap items-start gap-3">
        {/* Tier number + threshold */}
        <div className="flex shrink-0 flex-col items-center rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-center">
          {tier.isBonusTier ? (
            <span className="text-[9px] font-bold uppercase tracking-wide text-amber-600">Bonus</span>
          ) : (
            <span className="text-[9px] font-bold uppercase tracking-wide text-slate-400">Tier</span>
          )}
          <span className="text-lg font-bold text-slate-800">{tier.tierNumber}</span>
          <span className="text-[10px] text-slate-400">{tier.xpThreshold.toLocaleString()} XP</span>
        </div>

        {/* Editable fields */}
        <div className="flex min-w-0 flex-1 flex-wrap gap-2">
          <input
            type="text"
            value={icon}
            onChange={(e) => setIcon(e.target.value)}
            className="w-12 rounded-xl border border-slate-200 bg-slate-50 px-2 py-1.5 text-center text-lg focus:border-cyan-500 focus:outline-none"
            maxLength={4}
            title="Emoji icon"
          />
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Reward title"
            className="flex-1 rounded-xl border border-slate-200 px-3 py-1.5 text-sm focus:border-cyan-500 focus:outline-none"
          />
          <select
            value={rewardType}
            onChange={(e) => setRewardType(e.target.value)}
            className={`rounded-xl border px-2.5 py-1.5 text-xs font-medium focus:outline-none ${REWARD_TYPE_COLORS[rewardType] ?? "bg-slate-100 text-slate-600"} border-transparent`}
          >
            {REWARD_TYPES.map((rt) => (
              <option key={rt} value={rt}>
                {REWARD_TYPE_LABELS[rt]}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={estimatedValue}
            onChange={(e) => setEstimatedValue(e.target.value)}
            placeholder="Value (optional)"
            className="w-32 rounded-xl border border-slate-200 px-3 py-1.5 text-xs focus:border-cyan-500 focus:outline-none"
          />
        </div>

        {/* Status badge */}
        <span className={`shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-semibold ${statusStyle}`}>
          {statusLabel}
        </span>
      </div>

      {/* Optional description */}
      {showNote ? (
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Note for student (e.g. 'Your choice of movie!')"
          rows={2}
          className="mt-2 w-full resize-none rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-cyan-500 focus:outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={() => setShowNote(true)}
          className="mt-1.5 text-xs text-slate-400 hover:text-slate-600"
        >
          + add note →
        </button>
      )}

      {/* Save button */}
      {isDirty ? (
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            disabled={saving}
            onClick={() => void handleSave()}
            className="rounded-xl bg-slate-900 px-4 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      ) : null}

      {/* Reward option picker */}
      {suggestions.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-cyan-100 bg-cyan-50/60 px-3 py-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-cyan-800">
            AI options
          </span>
          <select
            value={selectedSuggestion}
            onChange={(e) => setSelectedSuggestion(e.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-cyan-200 bg-white px-2 py-1 text-xs focus:outline-none"
          >
            <option value="">Select an option for this milestone</option>
            {suggestions.map((s) => {
              const key = `${s.icon}|${s.title}|${s.rewardType}`;
              return (
                <option key={key} value={key}>
                  {s.icon} {s.title} · {REWARD_TYPE_LABELS[s.rewardType] ?? "Treat"}
                </option>
              );
            })}
          </select>
          <button
            type="button"
            onClick={applySelectedSuggestion}
            disabled={!selectedSuggestion}
            className="rounded-lg border border-cyan-300 bg-white px-2.5 py-1 text-xs font-medium text-cyan-800 hover:bg-cyan-100 disabled:opacity-50"
          >
            Use
          </button>
        </div>
      ) : null}

      {/* Delivery toggle */}
      {claim && (status === "claimed" || status === "delivered") ? (
        <div className="mt-2">
          <button
            type="button"
            disabled={deliveryUpdating}
            onClick={async () => {
              setDeliveryUpdating(true);
              try {
                await onToggleDelivered(claim, status !== "delivered");
              } finally {
                setDeliveryUpdating(false);
              }
            }}
            className={`rounded-xl px-3 py-1.5 text-xs font-medium transition disabled:opacity-60 ${
              status === "delivered"
                ? "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                : "border border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100"
            }`}
          >
            {deliveryUpdating
              ? "Saving…"
              : status === "delivered"
                ? "↺ Mark Pending"
                : "✓ Mark Delivered"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ── Claim History Table ───────────────────────────────────────────────────────

function ClaimHistoryTable({
  claims,
  tiers,
  onDelivered,
}: {
  claims: ClaimRow[];
  tiers: TierRow[];
  onDelivered: () => void;
}) {
  const [updatingClaimId, setUpdatingClaimId] = useState<string | null>(null);
  const tierMap = new Map(tiers.map((t) => [t.id, t]));

  if (claims.length === 0) {
    return (
      <p className="rounded-xl bg-slate-50 p-4 text-center text-sm text-slate-400">
        No rewards claimed yet.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[500px] text-left text-sm">
        <thead>
          <tr className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">
            <th className="pb-2 pr-4">Tier</th>
            <th className="pb-2 pr-4">Status</th>
            <th className="pb-2 pr-4">Claimed</th>
            <th className="pb-2 pr-4">Delivered</th>
            <th className="pb-2">Note</th>
          </tr>
        </thead>
        <tbody>
          {claims.map((claim) => {
            const tier = tierMap.get(claim.tierId);
            const isPending = claim.status === "claimed";
            const isDelivered = claim.status === "delivered";
            return (
              <tr
                key={claim.id}
                className={`border-t border-slate-100 ${isPending ? "bg-amber-50/50" : ""}`}
              >
                <td className="py-2.5 pr-4">
                  {tier ? (
                    <span className="flex items-center gap-1.5">
                      <span>{tier.icon ?? "🎁"}</span>
                      <span className="font-medium text-slate-800">{tier.title}</span>
                    </span>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
                <td className="py-2.5 pr-4">
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${CLAIM_STATUS_STYLES[claim.status] ?? ""}`}
                  >
                    {claim.status.charAt(0).toUpperCase() + claim.status.slice(1)}
                  </span>
                </td>
                <td className="py-2.5 pr-4 text-xs text-slate-500">
                  {claim.claimedAt ? new Date(claim.claimedAt).toLocaleDateString() : "—"}
                </td>
                <td className="py-2.5 pr-4 text-xs text-slate-500">
                  {isPending || isDelivered ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={updatingClaimId === claim.id}
                        onClick={async () => {
                          setUpdatingClaimId(claim.id);
                          try {
                            await setRewardClaimDelivered({
                              data: { claimId: claim.id, delivered: !isDelivered },
                            });
                            onDelivered();
                          } finally {
                            setUpdatingClaimId(null);
                          }
                        }}
                        className={`rounded-lg border px-2.5 py-1 text-[10px] font-semibold transition disabled:opacity-60 ${
                          isDelivered
                            ? "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                            : "border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100"
                        }`}
                      >
                        {updatingClaimId === claim.id
                          ? "Saving…"
                          : isDelivered
                            ? "Mark Pending"
                            : "Mark Delivered"}
                      </button>
                      {claim.deliveredAt ? (
                        <span>{new Date(claim.deliveredAt).toLocaleDateString()}</span>
                      ) : null}
                    </div>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="py-2.5 text-xs text-slate-500">
                  {claim.parentNote ?? "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Settings Panel ────────────────────────────────────────────────────────────

function TrackSettingsPanel({
  trackDetail,
  onSaved,
}: {
  trackDetail: TrackDetail;
  onSaved: () => void;
}) {
  const track = trackDetail.track;
  const [title, setTitle] = useState(track.title);
  const [schoolYear, setSchoolYear] = useState(track.schoolYear ?? "");
  const [description, setDescription] = useState(track.description ?? "");
  const [totalXpGoal, setTotalXpGoal] = useState(track.totalXpGoal);
  const [xpGoalWarning, setXpGoalWarning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await updateRewardTrack({
        data: {
          trackId: track.id,
          title: title.trim() || track.title,
          description: description.trim() || undefined,
          schoolYear: schoolYear.trim() || undefined,
          totalXpGoal,
        },
      });
      onSaved();
    } catch {
      setError("Could not save settings.");
    } finally {
      setSaving(false);
    }
  }

  async function handleRecalculateThresholds() {
    // Update all tiers proportionally
    const tiers = trackDetail.tiers;
    await Promise.all(
      tiers.map((tier: TierRow) =>
        upsertRewardTier({
          data: {
            trackId: track.id,
            tierId: tier.id,
            tierNumber: tier.tierNumber,
            title: tier.title,
            xpThreshold:
              tier.isBonusTier || tier.tierNumber > 5
                ? Math.round(totalXpGoal * 1.2)
                : Math.round((tier.tierNumber / 5) * totalXpGoal),
          },
        }),
      ),
    );
    onSaved();
  }

  return (
    <div className="space-y-5">
      <div>
        <label className="mb-1.5 block text-sm font-medium text-slate-700">Track Title</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
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
        <label className="mb-1.5 block text-sm font-medium text-slate-700">Description</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          className="w-full resize-none rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none"
        />
      </div>

      <div>
        <label className="mb-1.5 block text-sm font-medium text-slate-700">
          Total XP Goal
          <span className="ml-1 text-xs font-normal text-slate-500">
            (students earn XP by completing skill tree nodes)
          </span>
        </label>
        <input
          type="number"
          min={100}
          value={totalXpGoal}
          onChange={(e) => {
            setTotalXpGoal(Math.max(100, Number(e.target.value)));
            setXpGoalWarning(true);
          }}
          className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none"
        />
        {xpGoalWarning ? (
          <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Updating the XP goal will rescale all tier thresholds.
            <button
              type="button"
              onClick={() => void handleRecalculateThresholds()}
              className="ml-2 font-semibold underline-offset-2 hover:underline"
            >
              Recalculate thresholds
            </button>
          </div>
        ) : null}
      </div>

      {error ? <p className="text-sm font-medium text-rose-600">{error}</p> : null}

      <button
        type="button"
        disabled={saving}
        onClick={() => void handleSave()}
        className="w-full rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
      >
        {saving ? "Saving…" : "Save Settings"}
      </button>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

function RewardTrackEditPage() {
  const { trackDetail: initialDetail } = Route.useLoaderData();
  const router = useRouter();
  const track = initialDetail.track;
  const [activating, setActivating] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiOptionsByTier, setAiOptionsByTier] = useState<Record<number, RewardSuggestionOption[]>>({});

  // Map claims by tierId for quick lookup
  const claimByTierId = new Map(
    initialDetail.claims.map((c) => [c.tierId, c]),
  );

  const pendingClaims = initialDetail.claims.filter((c) => c.status === "claimed");
  const hasBonusTier = initialDetail.tiers.some((tier) => tier.isBonusTier);

  async function handleActivate() {
    setActivating(true);
    try {
      await activateRewardTrack({ data: { trackId: track.id } });
      router.invalidate();
    } catch {
      setActivating(false);
    }
  }

  async function handleDeactivate() {
    setDeactivating(true);
    try {
      await deactivateRewardTrack({ data: { trackId: track.id } });
      setConfirmDeactivate(false);
      router.invalidate();
    } catch {
      setDeactivating(false);
      setConfirmDeactivate(false);
    }
  }

  function mergeSuggestionBatches(
    existing: Record<number, RewardSuggestionOption[]>,
    incomingBatches: RewardSuggestionOption[][],
  ) {
    const next: Record<number, RewardSuggestionOption[]> = { ...existing };
    for (const batch of incomingBatches) {
      for (const suggestion of batch) {
        const tierNumber = suggestion.tierNumber;
        const current = next[tierNumber] ?? [];
        const key = `${suggestion.icon}|${suggestion.title}|${suggestion.rewardType}`;
        const hasAlready = current.some((s) => `${s.icon}|${s.title}|${s.rewardType}` === key);
        if (!hasAlready) {
          next[tierNumber] = [...current, suggestion];
        }
      }
    }
    return next;
  }

  async function handleGenerateRewardOptions() {
    setAiLoading(true);
    setAiError(null);
    try {
      const [batchA, batchB] = await Promise.all([
        aiSuggestRewards({ data: { profileId: track.profileId } }),
        aiSuggestRewards({ data: { profileId: track.profileId } }),
      ]);
      setAiOptionsByTier((prev) =>
        mergeSuggestionBatches(prev, [batchA, batchB] as RewardSuggestionOption[][]),
      );
    } catch {
      setAiError("Could not generate AI suggestions right now.");
    } finally {
      setAiLoading(false);
    }
  }

  async function handleToggleDelivered(claim: ClaimRow, delivered: boolean) {
    await setRewardClaimDelivered({
      data: {
        claimId: claim.id,
        delivered,
      },
    });
    router.invalidate();
  }

  return (
    <div className="space-y-6">
      <ParentPageHeader
        title={track.title}
        description={(
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Link
              to="/rewards"
              className="font-medium text-cyan-800 transition hover:underline"
            >
              ← Orca Currents
            </Link>
            {initialDetail.profile ? (
              <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-700">
                {initialDetail.profile.displayName}
                {initialDetail.profile.gradeLevel ? ` · Grade ${initialDetail.profile.gradeLevel}` : ""}
              </span>
            ) : null}
          </div>
        )}
        action={(
          <div className="flex flex-wrap items-center justify-end gap-2">
            {track.isActive ? (
              <>
                <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">
                  ACTIVE
                </span>
                {confirmDeactivate ? (
                  <>
                    <span className="text-xs text-slate-600">Deactivate?</span>
                    <button
                      type="button"
                      disabled={deactivating}
                      onClick={() => void handleDeactivate()}
                      className="rounded-xl bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-700 disabled:opacity-60"
                    >
                      {deactivating ? "…" : "Yes"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDeactivate(false)}
                      className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
                    >
                      No
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmDeactivate(true)}
                    className="rounded-xl border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
                  >
                    Deactivate
                  </button>
                )}
              </>
            ) : (
              <button
                type="button"
                disabled={activating}
                onClick={() => void handleActivate()}
                className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-60"
              >
                {activating ? "Activating…" : "Activate Current"}
              </button>
            )}
          </div>
        )}
      />

      {/* Pending delivery banner */}
      {pendingClaims.length > 0 ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4">
          <p className="font-semibold text-amber-800">
            ⚡ {pendingClaims.length} reward{pendingClaims.length > 1 ? "s" : ""} claimed and waiting for delivery
          </p>
          <p className="mt-0.5 text-xs text-amber-700">
            See Claim History below to review rewards and toggle delivered status.
          </p>
        </div>
      ) : null}

      {/* Two-column layout */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
        {/* LEFT — Tier editor */}
        <section className="space-y-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Reward Manager</h2>
            <p className="mt-0.5 text-sm text-slate-500">
              Set a reward at each XP milestone. Students see these as locked until they earn enough XP.
            </p>
          </div>

          <div className="rounded-2xl border border-cyan-200 bg-cyan-50/70 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium text-cyan-900">
                Need ideas for each milestone?
              </p>
              <button
                type="button"
                disabled={aiLoading}
                onClick={() => void handleGenerateRewardOptions()}
                className="rounded-xl border border-cyan-300 bg-white px-3 py-1.5 text-xs font-semibold text-cyan-800 hover:bg-cyan-100 disabled:opacity-60"
              >
                {aiLoading ? "Generating…" : "AI Suggest Reward Options"}
              </button>
            </div>
            <p className="mt-1 text-xs text-cyan-800/80">
              Generate options, pick the rewards you like for each tier, then save the tier.
            </p>
            {aiError ? <p className="mt-2 text-xs font-medium text-rose-600">{aiError}</p> : null}
          </div>

          <div className="space-y-3">
            {initialDetail.tiers
              .sort((a, b) => a.tierNumber - b.tierNumber)
              .map((tier) => (
                <TierEditorRow
                  key={tier.id}
                  tier={tier}
                  claim={claimByTierId.get(tier.id)}
                  suggestions={aiOptionsByTier[tier.tierNumber] ?? []}
                  onToggleDelivered={handleToggleDelivered}
                  onSaved={() => router.invalidate()}
                />
              ))}
          </div>

          {/* Add bonus tier */}
          {!hasBonusTier ? (
            <button
              type="button"
              onClick={async () => {
                await upsertRewardTier({
                  data: {
                    trackId: track.id,
                    tierNumber: 6,
                    title: "Bonus Reward",
                    icon: "⭐",
                    rewardType: "item",
                    estimatedValue: "$100-200",
                    isBonusTier: true,
                    xpThreshold: Math.round(track.totalXpGoal * 1.2),
                  },
                });
                router.invalidate();
              }}
              className="w-full rounded-xl border border-dashed border-amber-300 bg-amber-50 px-4 py-2.5 text-sm font-medium text-amber-700 hover:bg-amber-100 transition"
            >
              + Add Bonus Tier
            </button>
          ) : null}
        </section>

        {/* RIGHT — Settings + claim history */}
        <aside className="space-y-6">
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="mb-4 text-base font-semibold text-slate-900">Current Settings</h2>
            <TrackSettingsPanel
              trackDetail={initialDetail}
              onSaved={() => router.invalidate()}
            />
          </section>

          <section id="claim-history" className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="mb-4 text-base font-semibold text-slate-900">Claim History</h2>
            <ClaimHistoryTable
              claims={initialDetail.claims}
              tiers={initialDetail.tiers}
              onDelivered={() => router.invalidate()}
            />
          </section>
        </aside>
      </div>
    </div>
  );
}
