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

// Truncate a tier title to a safe display length to avoid card overflow
function truncateTierTitle(title: string, maxLen = 14): string {
  return title.length > maxLen ? `${title.slice(0, maxLen - 1)}…` : title;
}

// ── TierCard ──────────────────────────────────────────────────────────────────
//
// Fixed-size card: 80×100px. Text is always clamped to prevent overflow.
// Status variants:
//   delivered — gold gradient, checkmark badge
//   claimed   — violet pulse, "Pending" label
//   unlocked  — cyan glow, sparkle animation, Claim button
//   locked    — muted gray, XP remaining shown

const CARD_W = 80;
const CARD_H = 104;

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
  const shortTitle = truncateTierTitle(tier.title);
  const xpLabel = tier.xpThreshold >= 1000
    ? `${(tier.xpThreshold / 1000).toFixed(1).replace(/\.0$/, "")}k XP`
    : `${tier.xpThreshold} XP`;

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
        className="relative shrink-0 snap-start flex flex-col items-center justify-center rounded-2xl p-2 text-center"
        style={{
          width: CARD_W,
          height: CARD_H,
          background: "linear-gradient(145deg, #fbbf24 0%, #d97706 100%)",
          border: "2px solid #f59e0b",
          boxShadow: "0 2px 12px rgba(251,191,36,0.35)",
        }}
      >
        <span className="text-3xl leading-none">{tier.icon ?? "🎁"}</span>
        <p className="mt-1.5 w-full truncate px-0.5 text-center text-[10px] font-semibold leading-tight text-white">
          {shortTitle}
        </p>
        <p className="mt-0.5 text-[9px] font-medium text-amber-100">✓ Delivered</p>
        <span
          className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-white shadow"
          style={{ fontSize: 10, fontWeight: 700 }}
          aria-label="Delivered"
        >
          ✓
        </span>
      </div>
    );
  }

  if (status === "claimed") {
    return (
      <div
        className="relative shrink-0 snap-start flex flex-col items-center justify-center rounded-2xl p-2 text-center"
        style={{
          width: CARD_W,
          height: CARD_H,
          background: "linear-gradient(145deg, #ede9fe 0%, #ddd6fe 100%)",
          border: "2px solid #a78bfa",
          animation: "reward-pulse 1.8s ease-in-out infinite",
        }}
      >
        <span className="text-3xl leading-none">{tier.icon ?? "🎁"}</span>
        <p className="mt-1.5 w-full truncate px-0.5 text-center text-[10px] font-semibold leading-tight text-violet-900">
          {shortTitle}
        </p>
        <p className="mt-0.5 text-[9px] font-medium text-violet-500">Pending…</p>
      </div>
    );
  }

  if (status === "unlocked") {
    return (
      <div
        className="relative shrink-0 snap-start flex flex-col items-center justify-center rounded-2xl bg-white p-2 text-center"
        style={{
          width: CARD_W,
          height: CARD_H,
          border: "2px solid #22d3ee",
          boxShadow: "0 0 10px rgba(34,211,238,0.3)",
        }}
      >
        <span
          className="text-3xl leading-none"
          style={{
            filter: "drop-shadow(0 0 5px #22d3ee)",
            animation: "reward-sparkle 1.5s ease-in-out infinite",
            display: "block",
          }}
        >
          {tier.icon ?? "🎁"}
        </span>
        <p className="mt-1.5 w-full truncate px-0.5 text-center text-[10px] font-semibold leading-tight text-slate-800">
          {shortTitle}
        </p>
        <button
          type="button"
          disabled={claiming}
          onClick={() => void handleClaim()}
          className="mt-1.5 rounded-full bg-cyan-500 px-3 py-0.5 text-[10px] font-bold text-white transition hover:bg-cyan-600 disabled:opacity-60"
        >
          {claiming ? "…" : "Claim!"}
        </button>
      </div>
    );
  }

  // Locked
  return (
    <div
      className="relative shrink-0 snap-start flex flex-col items-center justify-center rounded-2xl bg-slate-100/80 p-2 text-center"
      style={{ width: CARD_W, height: CARD_H, border: "1.5px solid #e2e8f0" }}
    >
      <span className="text-3xl leading-none opacity-25">{tier.icon ?? "🎁"}</span>
      <p className="mt-1.5 w-full truncate px-0.5 text-center text-[10px] font-medium leading-tight text-slate-400">
        {shortTitle}
      </p>
      <p className="mt-0.5 text-[9px] text-slate-400">
        {xpNeeded > 0 ? xpLabel : "Unlocked"}
      </p>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export function StudentRewardTrack({
  track,
  tiers,
  claims,
  xpEarned,
  newlyUnlockedTierIds: _newlyUnlockedTierIds,
  onClaimReward,
}: Props) {
  const fillPct = track.totalXpGoal > 0
    ? Math.min(100, (xpEarned / track.totalXpGoal) * 100)
    : 0;

  const claimByTierId = new Map(claims.map((c) => [c.tierId, c]));
  const sorted = [...tiers].sort((a, b) => a.tierNumber - b.tierNumber);

  const deliveredCount = claims.filter((c) => c.status === "delivered").length;
  const claimedCount = claims.filter((c) => c.status === "claimed").length;
  const unlockedCount = tiers.filter((t) => {
    const cl = claimByTierId.get(t.id);
    return !cl && xpEarned >= t.xpThreshold;
  }).length;

  const xpToNext = sorted.find((t) => xpEarned < t.xpThreshold);
  const nextXpNeeded = xpToNext ? xpToNext.xpThreshold - xpEarned : 0;

  return (
    <>
      {/* Keyframe styles */}
      <style>{`
        @keyframes reward-sparkle {
          0%, 100% { transform: scale(1) rotate(0deg); }
          50%       { transform: scale(1.15) rotate(6deg); }
        }
        @keyframes reward-pulse {
          0%, 100% { box-shadow: 0 0 0 2px #ddd6fe; }
          50%       { box-shadow: 0 0 0 6px #c4b5fd; }
        }
        @keyframes progress-shimmer {
          0%   { background-position: -200% center; }
          100% { background-position: 200% center; }
        }
        @keyframes xp-pop {
          0%   { transform: scale(0.85); opacity: 0; }
          65%  { transform: scale(1.08); }
          100% { transform: scale(1); opacity: 1; }
        }
        .reward-xp-pop { animation: xp-pop 0.45s cubic-bezier(0.34,1.56,0.64,1) both; }
      `}</style>

      <div className="min-w-0 overflow-hidden rounded-2xl border border-violet-200/60 bg-gradient-to-br from-slate-900 via-violet-950 to-indigo-950 p-4 shadow-lg sm:p-5">
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-xl leading-none" aria-hidden="true">🏆</span>
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-violet-400">Reward Track</p>
              <h3 className="truncate text-sm font-bold leading-tight text-white">{track.title}</h3>
            </div>
          </div>
          <div className="reward-xp-pop flex shrink-0 items-center gap-1.5 rounded-full border border-amber-400/30 bg-amber-400/10 px-3 py-1">
            <span className="text-sm leading-none">⭐</span>
            <span className="text-sm font-bold text-amber-300">{xpEarned.toLocaleString()}</span>
            <span className="text-[10px] text-amber-400/70">XP</span>
          </div>
        </div>

        {/* Progress bar */}
        <div className="mt-3.5">
          <div className="h-3 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full transition-all duration-1000 ease-out"
              style={{
                width: `${fillPct}%`,
                background: fillPct >= 100
                  ? "linear-gradient(90deg, #a78bfa, #fbbf24, #a78bfa)"
                  : "linear-gradient(90deg, #7c3aed 0%, #a78bfa 45%, #fde68a 75%, #fbbf24 100%)",
                backgroundSize: "200% auto",
                animation: fillPct > 0 ? "progress-shimmer 3s linear infinite" : "none",
                boxShadow: fillPct > 0 ? "0 0 10px rgba(167,139,250,0.5)" : "none",
              }}
            />
          </div>
          <div className="mt-1 flex items-center justify-between">
            <span className="text-[10px] text-white/40">
              {xpEarned.toLocaleString()} / {track.totalXpGoal.toLocaleString()} XP
            </span>
            {nextXpNeeded > 0 ? (
              <span className="text-[10px] text-violet-300/70">
                {nextXpNeeded.toLocaleString()} XP to next reward
              </span>
            ) : (
              <span className="text-[10px] font-semibold text-amber-300">All tiers unlocked! 🎉</span>
            )}
          </div>
        </div>

        {/* Status chips */}
        {(deliveredCount > 0 || claimedCount > 0 || unlockedCount > 0) ? (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {deliveredCount > 0 ? (
              <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
                ✓ {deliveredCount} delivered
              </span>
            ) : null}
            {claimedCount > 0 ? (
              <span className="rounded-full border border-violet-400/30 bg-violet-400/10 px-2 py-0.5 text-[10px] font-semibold text-violet-300">
                ⏳ {claimedCount} pending
              </span>
            ) : null}
            {unlockedCount > 0 ? (
              <span className="rounded-full border border-cyan-400/30 bg-cyan-400/10 px-2 py-0.5 text-[10px] font-semibold text-cyan-300">
                ✨ {unlockedCount} ready to claim
              </span>
            ) : null}
          </div>
        ) : null}

        {/* Tier scroll track */}
        <div className="mt-4 flex items-center gap-1.5 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden snap-x snap-mandatory">
          {sorted.map((tier, i) => (
            <div key={tier.id} className="flex shrink-0 items-center gap-1.5">
              <div className="flex shrink-0 flex-col items-center gap-1">
                {/* Tier number label above card */}
                <span className="text-[8px] font-bold uppercase tracking-wider text-white/30">
                  T{tier.tierNumber}
                </span>
                <TierCard
                  tier={tier}
                  claim={claimByTierId.get(tier.id)}
                  xpEarned={xpEarned}
                  onClaim={onClaimReward}
                />
              </div>
              {i < sorted.length - 1 ? (
                <span className="shrink-0 text-white/20" style={{ fontSize: 14 }}>›</span>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
