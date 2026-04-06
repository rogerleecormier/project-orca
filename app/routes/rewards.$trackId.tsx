import { useState } from "react";
import { Link, createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import {
  activateRewardTrack,
  deactivateRewardTrack,
  deliverReward,
  getRewardTrackDetail,
  getViewerContext,
  updateRewardTrack,
  upsertRewardTier,
} from "../server/functions";

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

// ── Deliver Reward Inline Form ────────────────────────────────────────────────

function DeliverForm({
  claimId,
  onDelivered,
  onCancel,
}: {
  claimId: string;
  onDelivered: () => void;
  onCancel: () => void;
}) {
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDeliver() {
    setLoading(true);
    setError(null);
    try {
      await deliverReward({ data: { claimId, parentNote: note.trim() || undefined } });
      onDelivered();
    } catch {
      setError("Could not mark as delivered.");
      setLoading(false);
    }
  }

  return (
    <div className="mt-2 flex flex-col gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Optional note for student… (e.g. 'Choose your flavor!')"
        rows={2}
        className="resize-none rounded-lg border border-slate-200 px-3 py-2 text-xs focus:border-cyan-500 focus:outline-none"
      />
      <div className="flex gap-2">
        <button
          type="button"
          disabled={loading}
          onClick={() => void handleDeliver()}
          className="rounded-xl bg-emerald-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
        >
          {loading ? "Saving…" : "Mark Delivered ✓"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={loading}
          className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100"
        >
          Cancel
        </button>
      </div>
      {error ? <p className="text-xs font-medium text-rose-600">{error}</p> : null}
    </div>
  );
}

// ── Tier Row Editor ───────────────────────────────────────────────────────────

function TierEditorRow({
  tier,
  claim,
  totalXpGoal,
  onSaved,
}: {
  tier: TierRow;
  claim: ClaimRow | undefined;
  totalXpGoal: number;
  onSaved: () => void;
}) {
  const [icon, setIcon] = useState(tier.icon ?? "🎁");
  const [title, setTitle] = useState(tier.title);
  const [rewardType, setRewardType] = useState(tier.rewardType);
  const [estimatedValue, setEstimatedValue] = useState(tier.estimatedValue ?? "");
  const [description, setDescription] = useState(tier.description ?? "");
  const [showNote, setShowNote] = useState(!!tier.description);
  const [saving, setSaving] = useState(false);
  const [showDeliver, setShowDeliver] = useState(false);

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

      {/* Deliver reward inline */}
      {status === "claimed" ? (
        showDeliver ? (
          <DeliverForm
            claimId={claim!.id}
            onDelivered={() => { setShowDeliver(false); onSaved(); }}
            onCancel={() => setShowDeliver(false)}
          />
        ) : (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setShowDeliver(true)}
              className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100 transition"
            >
              🎁 Mark Delivered
            </button>
          </div>
        )
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
  const [deliverFormClaimId, setDeliverFormClaimId] = useState<string | null>(null);
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
            return (
              <>
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
                    {claim.deliveredAt ? new Date(claim.deliveredAt).toLocaleDateString() : (
                      isPending ? (
                        <button
                          type="button"
                          onClick={() =>
                            setDeliverFormClaimId(
                              deliverFormClaimId === claim.id ? null : claim.id,
                            )
                          }
                          className="rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1 text-[10px] font-semibold text-amber-800 hover:bg-amber-100 transition"
                        >
                          Mark Delivered
                        </button>
                      ) : "—"
                    )}
                  </td>
                  <td className="py-2.5 text-xs text-slate-500">
                    {claim.parentNote ?? "—"}
                  </td>
                </tr>
                {deliverFormClaimId === claim.id ? (
                  <tr key={`deliver-${claim.id}`} className="border-t-0">
                    <td colSpan={5} className="pb-3 pt-0 pr-4">
                      <DeliverForm
                        claimId={claim.id}
                        onDelivered={() => {
                          setDeliverFormClaimId(null);
                          onDelivered();
                        }}
                        onCancel={() => setDeliverFormClaimId(null)}
                      />
                    </td>
                  </tr>
                ) : null}
              </>
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
            xpThreshold: Math.round((tier.tierNumber / 10) * totalXpGoal),
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

  // Map claims by tierId for quick lookup
  const claimByTierId = new Map(
    initialDetail.claims.map((c) => [c.tierId, c]),
  );

  const pendingClaims = initialDetail.claims.filter((c) => c.status === "claimed");

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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <Link
          to="/rewards"
          className="shrink-0 text-sm text-slate-500 transition hover:text-slate-900"
        >
          ← Reward Tracks
        </Link>
        <span className="text-slate-300">|</span>
        <h1 className="text-lg font-semibold text-slate-900">{track.title}</h1>
        {initialDetail.profile ? (
          <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-700">
            {initialDetail.profile.displayName}
            {initialDetail.profile.gradeLevel ? ` · Grade ${initialDetail.profile.gradeLevel}` : ""}
          </span>
        ) : null}

        <div className="ml-auto flex shrink-0 items-center gap-2">
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
                  className="rounded-xl border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 transition"
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
              className="rounded-xl bg-emerald-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60 transition"
            >
              {activating ? "Activating…" : "Activate Track"}
            </button>
          )}
        </div>
      </div>

      {/* Pending delivery banner */}
      {pendingClaims.length > 0 ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4">
          <p className="font-semibold text-amber-800">
            ⚡ {pendingClaims.length} reward{pendingClaims.length > 1 ? "s" : ""} claimed and waiting for delivery
          </p>
          <p className="mt-0.5 text-xs text-amber-700">
            See the Claim History section below to mark them as delivered.
          </p>
        </div>
      ) : null}

      {/* Two-column layout */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
        {/* LEFT — Tier editor */}
        <section className="space-y-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Reward Tiers</h2>
            <p className="mt-0.5 text-sm text-slate-500">
              Set a reward at each XP milestone. Students see these as locked until they earn enough XP.
            </p>
          </div>

          <div className="space-y-3">
            {initialDetail.tiers
              .sort((a, b) => a.tierNumber - b.tierNumber)
              .map((tier) => (
                <TierEditorRow
                  key={tier.id}
                  tier={tier}
                  claim={claimByTierId.get(tier.id)}
                  totalXpGoal={track.totalXpGoal}
                  onSaved={() => router.invalidate()}
                />
              ))}
          </div>

          {/* Add bonus tier */}
          <button
            type="button"
            onClick={async () => {
              const maxTier = Math.max(0, ...initialDetail.tiers.map((t) => t.tierNumber));
              const nextNum = maxTier + 1;
              await upsertRewardTier({
                data: {
                  trackId: track.id,
                  tierNumber: nextNum,
                  title: `Bonus Tier ${nextNum}`,
                  icon: "⭐",
                  rewardType: "experience",
                  isBonusTier: true,
                  xpThreshold: Math.round((nextNum / 10) * track.totalXpGoal),
                },
              });
              router.invalidate();
            }}
            className="w-full rounded-xl border border-dashed border-amber-300 bg-amber-50 px-4 py-2.5 text-sm font-medium text-amber-700 hover:bg-amber-100 transition"
          >
            + Add Bonus Tier
          </button>
        </section>

        {/* RIGHT — Settings + claim history */}
        <aside className="space-y-6">
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="mb-4 text-base font-semibold text-slate-900">Track Settings</h2>
            <TrackSettingsPanel
              trackDetail={initialDetail}
              onSaved={() => router.invalidate()}
            />
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
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
