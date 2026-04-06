import { useState } from "react";

// ── Types (mirror DB schema shape — keep in sync with server return) ──────────

export type RewardTrackData = {
  id: string;
  title: string;
  totalXpGoal: number;
  isActive: boolean;
  startedAt: string | null;
  completedAt: string | null;
};

export type RewardTierData = {
  id: string;
  trackId: string;
  tierNumber: number;
  xpThreshold: number;
  title: string;
  description: string | null;
  icon: string | null;
  rewardType: string;
  estimatedValue: string | null;
  isBonusTier: boolean | null;
};

export type RewardClaimData = {
  id: string;
  tierId: string;
  status: string;
  claimedAt: string | null;
  deliveredAt: string | null;
  parentNote: string | null;
};

type Props = {
  track: RewardTrackData;
  tiers: RewardTierData[];
  claims: RewardClaimData[];
  xpEarned: number;
  newlyUnlockedTierIds: string[];
  onClaimReward: (tierId: string) => Promise<void>;
};

// ── TierCard ──────────────────────────────────────────────────────────────────

function TierCard({
  tier,
  claim,
  xpEarned,
  onClaim,
}: {
  tier: RewardTierData;
  claim: RewardClaimData | undefined;
  xpEarned: number;
  onClaim: (tierId: string) => Promise<void>;
}) {
  const [claiming, setClaiming] = useState(false);

  const status: "delivered" | "claimed" | "unlocked" | "locked" =
    claim?.status === "delivered"
      ? "delivered"
      : claim?.status === "claimed"
        ? "claimed"
        : claim?.status === "unclaimed"
          ? "unlocked"
          : "locked";

  const xpNeeded = Math.max(0, tier.xpThreshold - xpEarned);

  async function handleClaim() {
    setClaiming(true);
    try {
      await onClaim(tier.id);
    } finally {
      setClaiming(false);
    }
  }

  if (status === "delivered") {
    return (
      <div
        className="relative flex h-22 w-18 shrink-0 scroll-snap-start flex-col items-center justify-center rounded-xl p-2 text-center"
        style={{
          background: "linear-gradient(135deg, #fbbf24, #d97706)",
          border: "2px solid #f59e0b",
          width: 72,
          height: 88,
        }}
      >
        <span style={{ fontSize: 28 }}>{tier.icon ?? "🎁"}</span>
        <p
          className="mt-1 w-full overflow-hidden text-center leading-tight text-white"
          style={{ fontSize: 10, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}
        >
          {tier.title}
        </p>
        <p className="mt-0.5 text-white" style={{ fontSize: 9 }}>✓ Got it!</p>
        {/* Green checkmark badge */}
        <span
          className="absolute bottom-1.5 right-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 text-white"
          style={{ fontSize: 8 }}
        >
          ✓
        </span>
      </div>
    );
  }

  if (status === "claimed") {
    return (
      <div
        className="relative flex shrink-0 scroll-snap-start flex-col items-center justify-center rounded-xl p-2 text-center"
        style={{
          width: 72,
          height: 88,
          background: "#ede9fe",
          border: "2px solid #a78bfa",
          boxShadow: "0 0 0 3px #ddd6fe",
          animation: "reward-pulse 1.8s ease-in-out infinite",
        }}
      >
        <span style={{ fontSize: 28 }}>{tier.icon ?? "🎁"}</span>
        <p
          className="mt-1 w-full text-center leading-tight text-violet-800"
          style={{ fontSize: 10, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}
        >
          {tier.title}
        </p>
        <p className="mt-0.5 text-violet-600" style={{ fontSize: 9 }}>Waiting…</p>
      </div>
    );
  }

  if (status === "unlocked") {
    return (
      <div
        className="relative flex shrink-0 scroll-snap-start flex-col items-center justify-center rounded-xl bg-white p-2 text-center"
        style={{ width: 72, height: 88, border: "2px solid #22d3ee" }}
      >
        <span
          style={{
            fontSize: 28,
            filter: "drop-shadow(0 0 4px #22d3ee)",
            animation: "reward-sparkle 1.5s ease-in-out infinite",
            display: "block",
          }}
        >
          {tier.icon ?? "🎁"}
        </span>
        <p
          className="mt-1 w-full text-center leading-tight text-slate-800"
          style={{ fontSize: 10, display: "-webkit-box", WebkitLineClamp: 1, WebkitBoxOrient: "vertical", overflow: "hidden" }}
        >
          {tier.title}
        </p>
        <button
          type="button"
          disabled={claiming}
          onClick={() => void handleClaim()}
          className="mt-1 flex h-6 items-center rounded-full bg-cyan-500 px-2 text-white transition hover:bg-cyan-600 disabled:opacity-60"
          style={{ fontSize: 10, fontWeight: 600 }}
        >
          {claiming ? "…" : "Claim!"}
        </button>
      </div>
    );
  }

  // Locked
  return (
    <div
      className="relative flex shrink-0 scroll-snap-start flex-col items-center justify-center rounded-xl bg-slate-100 p-2 text-center"
      style={{ width: 72, height: 88, border: "1.5px solid #e2e8f0" }}
    >
      <span style={{ fontSize: 28, opacity: 0.35 }}>{tier.icon ?? "🎁"}</span>
      <p
        className="mt-1 w-full text-center leading-tight text-slate-400"
        style={{ fontSize: 10, display: "-webkit-box", WebkitLineClamp: 1, WebkitBoxOrient: "vertical", overflow: "hidden" }}
      >
        {tier.title}
      </p>
      {xpNeeded > 0 ? (
        <p className="mt-0.5 text-slate-400" style={{ fontSize: 9 }}>
          {xpNeeded.toLocaleString()} XP
        </p>
      ) : null}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export function StudentRewardTrack({
  track,
  tiers,
  claims,
  xpEarned,
  onClaimReward,
}: Props) {
  const fillPct = track.totalXpGoal > 0
    ? Math.min(100, (xpEarned / track.totalXpGoal) * 100)
    : 0;

  const claimByTierId = new Map(claims.map((c) => [c.tierId, c]));
  const sorted = [...tiers].sort((a, b) => a.tierNumber - b.tierNumber);

  const completedTiers = claims.filter(
    (c) => c.status === "claimed" || c.status === "delivered",
  ).length;

  return (
    <>
      {/* Keyframe styles */}
      <style>{`
        @keyframes reward-sparkle {
          0%, 100% { transform: scale(1); }
          50%       { transform: scale(1.15); }
        }
        @keyframes reward-pulse {
          0%, 100% { box-shadow: 0 0 0 3px #ddd6fe; }
          50%       { box-shadow: 0 0 0 6px #c4b5fd; }
        }
      `}</style>

      <div className="rounded-2xl border border-violet-200 bg-gradient-to-br from-violet-50 to-amber-50 p-4">
        {/* Header */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-lg" aria-hidden="true">🏆</span>
            <h3 className="text-sm font-semibold text-slate-800">{track.title}</h3>
          </div>
          <span className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-700">
            ⭐ {xpEarned.toLocaleString()} XP
          </span>
        </div>

        {/* Progress bar */}
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
          <div
            className="h-full rounded-full transition-all duration-700"
            style={{
              width: `${fillPct}%`,
              background: "linear-gradient(90deg, #a78bfa, #fbbf24)",
            }}
          />
        </div>

        {/* Track row */}
        <div
          className="mt-3 flex gap-2 overflow-x-auto pb-2"
          style={{ scrollSnapType: "x mandatory" }}
        >
          {sorted.map((tier, i) => (
            <div key={tier.id} className="flex items-center gap-2">
              <TierCard
                tier={tier}
                claim={claimByTierId.get(tier.id)}
                xpEarned={xpEarned}
                onClaim={onClaimReward}
              />
              {i < sorted.length - 1 ? (
                <span className="shrink-0 text-slate-300" style={{ fontSize: 12 }}>→</span>
              ) : null}
            </div>
          ))}
        </div>

        {/* Summary */}
        <p className="mt-1.5 text-xs text-slate-500">
          {xpEarned.toLocaleString()} / {track.totalXpGoal.toLocaleString()} XP
          {" · "}
          {completedTiers}/{tiers.length} rewards
        </p>
      </div>
    </>
  );
}
