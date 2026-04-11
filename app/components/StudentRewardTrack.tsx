import { useState, useRef } from "react";

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
  imageUrl: string | null;
};

export type RewardClaimData = {
  id: string;
  tierId: string;
  status: string;
  claimedAt: string | null;
  deliveredAt: string | null;
  parentNote: string | null;
};

type StudentProps = {
  track: RewardTrackData;
  tiers: RewardTierData[];
  claims: RewardClaimData[];
  xpEarned: number;
  newlyUnlockedTierIds: string[];
  onClaimReward: (tierId: string) => Promise<void>;
};

type ParentProps = StudentProps & {
  editable: true;
  onEditTier?: (tier: RewardTierData) => void;
};

type Props = StudentProps | ParentProps;

// Truncate a tier title to a safe display length to avoid card overflow
function truncateTierTitle(title: string, maxLen = 14): string {
  return title.length > maxLen ? `${title.slice(0, maxLen - 1)}…` : title;
}

// ── Ocean-themed node shape: Lighthouse SVG ───────────────────────────────────

function LighthouseIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 40"
      className={className}
      fill="none"
      aria-hidden="true"
    >
      {/* Light beam */}
      <path d="M16 4 L8 10 L24 10 Z" fill="currentColor" opacity="0.5" />
      {/* Tower body */}
      <rect x="12" y="10" width="8" height="20" rx="1" fill="currentColor" />
      {/* Horizontal stripes */}
      <rect x="12" y="14" width="8" height="2" fill="white" opacity="0.35" />
      <rect x="12" y="20" width="8" height="2" fill="white" opacity="0.35" />
      <rect x="12" y="26" width="8" height="2" fill="white" opacity="0.35" />
      {/* Light room */}
      <rect x="10" y="8" width="12" height="4" rx="1" fill="currentColor" />
      {/* Base platform */}
      <rect x="8" y="30" width="16" height="4" rx="2" fill="currentColor" opacity="0.7" />
      {/* Door */}
      <rect x="14" y="26" width="4" height="4" rx="1" fill="white" opacity="0.4" />
    </svg>
  );
}

// ── TierNode ─────────────────────────────────────────────────────────────────
//
// Ocean-themed node. When a reward image exists it fills the node face.
// Hovering shows a popover with full title, description, and larger image.
// Status variants:
//   delivered — gold gradient, checkmark badge
//   claimed   — violet pulse, "Pending" label
//   unlocked  — cyan glow, sparkle animation, Claim button
//   locked    — muted, frosted locked overlay (image still visible underneath)

const NODE_W = 80;
const NODE_H = 108;

// Hover popover that appears above the node
function RewardPopover({
  tier,
  status,
  xpLabel,
}: {
  tier: RewardTierData;
  status: "delivered" | "claimed" | "unlocked" | "locked";
  xpLabel: string;
}) {
  const statusChip = {
    delivered: { label: "✓ Delivered", cls: "bg-emerald-100 text-emerald-700" },
    claimed:   { label: "⏳ Pending delivery", cls: "bg-violet-100 text-violet-700" },
    unlocked:  { label: "✨ Ready to claim!", cls: "bg-cyan-100 text-cyan-700" },
    locked:    { label: `🔒 ${xpLabel} to unlock`, cls: "bg-slate-100 text-slate-500" },
  }[status];

  return (
    <div
      className="absolute bottom-[calc(100%+8px)] left-1/2 z-50 w-44 -translate-x-1/2 rounded-xl border border-slate-200 bg-white shadow-xl"
      style={{ pointerEvents: "none" }}
    >
      {/* Image */}
      {tier.imageUrl ? (
        <div className="h-28 w-full overflow-hidden rounded-t-xl">
          <img
            src={tier.imageUrl}
            alt={tier.title}
            className="h-full w-full object-cover"
          />
        </div>
      ) : (
        <div className="flex h-16 items-center justify-center rounded-t-xl bg-slate-50">
          <span className="text-4xl">{tier.icon ?? "🎁"}</span>
        </div>
      )}

      <div className="p-2.5">
        <p className="text-[11px] font-bold leading-tight text-slate-900">{tier.title}</p>
        {tier.description ? (
          <p className="mt-1 text-[10px] leading-snug text-slate-500">{tier.description}</p>
        ) : null}
        {tier.estimatedValue ? (
          <p className="mt-1 text-[10px] text-slate-400">Value: {tier.estimatedValue}</p>
        ) : null}
        <span className={`mt-2 inline-block rounded-full px-2 py-0.5 text-[9px] font-semibold ${statusChip.cls}`}>
          {statusChip.label}
        </span>
      </div>

      {/* Downward arrow */}
      <div
        className="absolute -bottom-1.5 left-1/2 h-3 w-3 -translate-x-1/2 rotate-45 border-b border-r border-slate-200 bg-white"
        aria-hidden="true"
      />
    </div>
  );
}

function TierNode({
  tier,
  claim,
  xpEarned,
  onClaim,
  editable,
  onEdit,
}: {
  tier: RewardTierData;
  claim: RewardClaimData | undefined;
  xpEarned: number;
  onClaim?: (tierId: string) => Promise<void>;
  editable?: boolean;
  onEdit?: (tier: RewardTierData) => void;
}) {
  const [claiming, setClaiming] = useState(false);
  const [hovered, setHovered] = useState(false);

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
  const xpLabel =
    tier.xpThreshold >= 1000
      ? `${(tier.xpThreshold / 1000).toFixed(1).replace(/\.0$/, "")}k XP`
      : `${tier.xpThreshold} XP`;

  async function handleClaim() {
    if (!onClaim) return;
    setClaiming(true);
    try {
      await onClaim(tier.id);
    } finally {
      setClaiming(false);
    }
  }

  const hasImage = !!tier.imageUrl;

  // ── Shared image face (shown in delivered / claimed / unlocked) ──────────
  function ImageFace({ dimmed = false }: { dimmed?: boolean }) {
    if (hasImage) {
      return (
        <div className={`w-full flex-1 overflow-hidden rounded-t-xl ${dimmed ? "opacity-25" : ""}`}
          style={{ maxHeight: 62 }}>
          <img src={tier.imageUrl!} alt={tier.title} className="h-full w-full object-cover" />
        </div>
      );
    }
    return (
      <div className={`flex flex-col items-center gap-0.5 mt-1 ${dimmed ? "opacity-20" : ""}`}>
        <LighthouseIcon className={`h-8 w-8 ${dimmed ? "text-slate-400" : "text-current"}`} />
        <span className="text-lg leading-none mt-0.5">{tier.icon ?? "🎁"}</span>
      </div>
    );
  }

  const baseStyle: React.CSSProperties = { width: NODE_W, height: NODE_H, position: "relative" };

  // ── Delivered ────────────────────────────────────────────────────────────
  if (status === "delivered") {
    return (
      <div
        className="shrink-0 snap-start flex flex-col items-center justify-between rounded-2xl text-center overflow-hidden cursor-default"
        style={{
          ...baseStyle,
          background: hasImage ? undefined : "linear-gradient(155deg, #fbbf24 0%, #d97706 100%)",
          backgroundColor: hasImage ? "#fef3c7" : undefined,
          border: "2px solid #f59e0b",
          boxShadow: "0 2px 14px rgba(251,191,36,0.40)",
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {hovered ? <RewardPopover tier={tier} status={status} xpLabel={xpLabel} /> : null}

        {hasImage ? (
          <div className="w-full overflow-hidden" style={{ height: 64 }}>
            <img src={tier.imageUrl!} alt={tier.title} className="h-full w-full object-cover" />
          </div>
        ) : (
          <div className="flex flex-col items-center gap-0.5 mt-1 text-amber-100">
            <LighthouseIcon className="h-8 w-8" />
            <span className="text-lg leading-none mt-0.5">{tier.icon ?? "🎁"}</span>
          </div>
        )}

        <div className="w-full px-1 pb-1">
          <p className={`w-full truncate text-center text-[10px] font-semibold leading-tight ${hasImage ? "text-amber-800" : "text-white"}`}>
            {shortTitle}
          </p>
          <p className={`text-[9px] font-medium mt-0.5 ${hasImage ? "text-amber-600" : "text-amber-100"}`}>✓ Delivered</p>
        </div>

        <span
          className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-white shadow"
          style={{ fontSize: 10, fontWeight: 700 }}
          aria-label="Delivered"
        >
          ✓
        </span>
        {editable ? (
          <button
            type="button"
            onClick={() => onEdit?.(tier)}
            className="absolute bottom-1 right-1 rounded-full bg-white/70 px-1.5 py-0.5 text-[8px] font-bold text-amber-800 hover:bg-white transition border border-amber-200"
          >
            Edit
          </button>
        ) : null}
      </div>
    );
  }

  // ── Claimed ──────────────────────────────────────────────────────────────
  if (status === "claimed") {
    return (
      <div
        className="shrink-0 snap-start flex flex-col items-center justify-between rounded-2xl text-center overflow-hidden cursor-default"
        style={{
          ...baseStyle,
          background: hasImage ? "#faf5ff" : "linear-gradient(155deg, #ede9fe 0%, #ddd6fe 100%)",
          border: "2px solid #a78bfa",
          animation: "reward-pulse 1.8s ease-in-out infinite",
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {hovered ? <RewardPopover tier={tier} status={status} xpLabel={xpLabel} /> : null}

        {hasImage ? (
          <div className="w-full overflow-hidden" style={{ height: 64 }}>
            <img src={tier.imageUrl!} alt={tier.title} className="h-full w-full object-cover" />
          </div>
        ) : (
          <div className="flex flex-col items-center gap-0.5 mt-1">
            <LighthouseIcon className="h-8 w-8 text-violet-500" />
            <span className="text-lg leading-none mt-0.5">{tier.icon ?? "🎁"}</span>
          </div>
        )}

        <div className="w-full px-1 pb-1">
          <p className={`w-full truncate text-center text-[10px] font-semibold leading-tight ${hasImage ? "text-violet-800" : "text-violet-900"}`}>
            {shortTitle}
          </p>
          <p className="text-[9px] font-medium text-violet-500 mt-0.5">Pending…</p>
        </div>

        {editable ? (
          <button
            type="button"
            onClick={() => onEdit?.(tier)}
            className="absolute bottom-1 right-1 rounded-full bg-violet-100 px-1.5 py-0.5 text-[8px] font-bold text-violet-800 hover:bg-violet-200 transition"
          >
            Edit
          </button>
        ) : null}
      </div>
    );
  }

  // ── Unlocked ─────────────────────────────────────────────────────────────
  if (status === "unlocked") {
    return (
      <div
        className="shrink-0 snap-start flex flex-col items-center justify-between rounded-2xl bg-white text-center overflow-hidden cursor-default"
        style={{
          ...baseStyle,
          border: "2px solid #22d3ee",
          boxShadow: "0 0 12px rgba(34,211,238,0.35)",
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {hovered ? <RewardPopover tier={tier} status={status} xpLabel={xpLabel} /> : null}

        {hasImage ? (
          <div className="w-full overflow-hidden" style={{ height: 56 }}>
            <img
              src={tier.imageUrl!}
              alt={tier.title}
              className="h-full w-full object-cover"
              style={{ animation: "reward-sparkle 1.5s ease-in-out infinite" }}
            />
          </div>
        ) : (
          <div className="flex flex-col items-center gap-0.5 mt-1">
            <LighthouseIcon className="h-8 w-8 text-cyan-500" />
            <span
              className="text-lg leading-none mt-0.5"
              style={{ animation: "reward-sparkle 1.5s ease-in-out infinite", display: "block" }}
            >
              {tier.icon ?? "🎁"}
            </span>
          </div>
        )}

        <div className="w-full px-1 pb-1">
          <p className="w-full truncate text-center text-[10px] font-semibold leading-tight text-slate-800">
            {shortTitle}
          </p>
          {!editable ? (
            <button
              type="button"
              disabled={claiming}
              onClick={() => void handleClaim()}
              className="mt-1 rounded-full bg-cyan-500 px-3 py-0.5 text-[10px] font-bold text-white transition hover:bg-cyan-600 disabled:opacity-60"
            >
              {claiming ? "…" : "Claim!"}
            </button>
          ) : (
            <p className="text-[9px] text-cyan-600 mt-0.5">Unlocked</p>
          )}
        </div>

        {editable ? (
          <button
            type="button"
            onClick={() => onEdit?.(tier)}
            className="absolute bottom-1 right-1 rounded-full bg-cyan-100 px-1.5 py-0.5 text-[8px] font-bold text-cyan-800 hover:bg-cyan-200 transition"
          >
            Edit
          </button>
        ) : null}
      </div>
    );
  }

  // ── Locked ───────────────────────────────────────────────────────────────
  return (
    <div
      className="shrink-0 snap-start flex flex-col items-center justify-between rounded-2xl text-center overflow-hidden cursor-default"
      style={{
        ...baseStyle,
        background: "rgba(248,250,252,0.85)",
        border: "1.5px solid #e2e8f0",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {hovered ? <RewardPopover tier={tier} status={status} xpLabel={xpLabel} /> : null}

      {/* Frosted lock overlay */}
      <div
        className="absolute inset-0 rounded-2xl flex flex-col items-center justify-center gap-1 z-10"
        style={{ background: "rgba(226,232,240,0.60)", backdropFilter: "blur(3px)" }}
      >
        <svg viewBox="0 0 24 24" className="h-6 w-6 text-slate-400" fill="none" aria-hidden="true">
          <rect x="5" y="11" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="2" fill="currentColor" opacity="0.15" />
          <path d="M8 11V7a4 4 0 1 1 8 0v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <circle cx="12" cy="16" r="1.5" fill="currentColor" />
        </svg>
        <p className="text-[9px] font-semibold text-slate-400">
          {xpNeeded > 0 ? xpLabel : "Unlocked"}
        </p>
      </div>

      {/* Content dimmed beneath overlay */}
      {hasImage ? (
        <div className="w-full overflow-hidden opacity-20" style={{ height: 64 }}>
          <img src={tier.imageUrl!} alt="" className="h-full w-full object-cover" aria-hidden="true" />
        </div>
      ) : (
        <div className="flex flex-col items-center gap-0.5 mt-1 opacity-20">
          <LighthouseIcon className="h-8 w-8 text-slate-400" />
          <span className="text-lg leading-none mt-0.5">{tier.icon ?? "🎁"}</span>
        </div>
      )}
      <div className="w-full px-1 pb-1 opacity-20">
        <p className="w-full truncate text-center text-[10px] font-medium leading-tight text-slate-400">
          {shortTitle}
        </p>
      </div>

      {editable ? (
        <button
          type="button"
          onClick={() => onEdit?.(tier)}
          className="absolute bottom-1 right-1 z-20 rounded-full bg-white/80 px-1.5 py-0.5 text-[8px] font-bold text-slate-600 hover:bg-white transition border border-slate-200"
        >
          Edit
        </button>
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
  newlyUnlockedTierIds: _newlyUnlockedTierIds,
  onClaimReward,
  ...rest
}: Props) {
  const editable = "editable" in rest && rest.editable;
  const onEditTier = "onEditTier" in rest ? rest.onEditTier : undefined;

  const fillPct =
    track.totalXpGoal > 0 ? Math.min(100, (xpEarned / track.totalXpGoal) * 100) : 0;

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

  // XP-aware spacing:
  // - gap widths are driven by per-tier XP deltas (tier-to-tier effort)
  // - an exponential curve emphasizes larger late-tier jumps
  // - later tiers receive a mild bias so T5/T6 feel meaningfully farther apart
  const tierCount = sorted.length;
  const xpLevels = sorted.map((tier) => Math.max(0, tier.xpThreshold));
  const xpDeltasByTier = xpLevels.map((xp, i) => {
    if (i === 0) return Math.max(1, xp);
    return Math.max(1, xp - xpLevels[i - 1]!);
  });
  const connectorDeltas = xpDeltasByTier.slice(1);
  const maxConnectorDelta = Math.max(1, ...connectorDeltas);
  const connectorWeights = connectorDeltas.map((delta, i) => {
    const normalized = delta / maxConnectorDelta;
    const tierPosition = (i + 2) / Math.max(2, tierCount); // connector leading into T(i+2)
    const deltaComponent = Math.pow(normalized, 1.9) * 2.2;
    const lateTierBias = Math.pow(tierPosition, 2.1) * 1.1;
    return 0.65 + deltaComponent + lateTierBias;
  });
  const connectorMinPx = tierCount >= 6 ? 26 : 22;
  const minTrackWidth = tierCount * NODE_W + Math.max(0, tierCount - 1) * connectorMinPx;
  const trackTemplateColumns = sorted.flatMap((_, i) => {
    const cols: string[] = [`${NODE_W}px`];
    if (i < sorted.length - 1) {
      cols.push(`minmax(${connectorMinPx}px, ${connectorWeights[i]!.toFixed(3)}fr)`);
    }
    return cols;
  }).join(" ");
  const trackWidthStyle: React.CSSProperties = { width: "100%" };

  // Both parent and student use the same light ocean theme.
  // Parent adds edit affordances; student adds claim buttons. That's the only difference.
  const containerClass = "min-w-0 overflow-hidden rounded-2xl border border-cyan-200 bg-gradient-to-br from-sky-50 via-cyan-50 to-blue-50 p-4 shadow-md sm:p-5";

  const titleColor = "text-slate-900";
  const subtitleColor = "text-cyan-700";
  const xpTextColor = "text-amber-700";
  const xpBadgeBorder = "border-amber-300/50 bg-amber-50";
  const progressSand = "bg-[#D2B48C]";
  const subTextColor = "text-slate-500";
  const nextXpColor = "text-cyan-700";
  const connectorColor = "text-cyan-400";

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
        @keyframes wave-scroll {
          0%   { transform: translateX(-50%); }
          100% { transform: translateX(0); }
        }
        @keyframes xp-pop {
          0%   { transform: scale(0.85); opacity: 0; }
          65%  { transform: scale(1.08); }
          100% { transform: scale(1); opacity: 1; }
        }
        .reward-xp-pop { animation: xp-pop 0.45s cubic-bezier(0.34,1.56,0.64,1) both; }
      `}</style>

      <div className={containerClass}>
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-xl leading-none" aria-hidden="true">🏆</span>
            <div className="min-w-0">
              <p className={`text-[10px] font-semibold uppercase tracking-[0.14em] ${subtitleColor}`}>
                Orca Current
              </p>
              <h3 className={`truncate text-sm font-bold leading-tight ${titleColor}`}>
                {track.title}
              </h3>
            </div>
          </div>
          <div className={`reward-xp-pop flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 ${xpBadgeBorder}`}>
            <span className="text-sm leading-none">⭐</span>
            <span className={`text-sm font-bold ${xpTextColor}`}>{xpEarned.toLocaleString()}</span>
            <span className="text-[10px] text-amber-500/70">XP</span>
          </div>
        </div>

        {/* Progress bar — sandy shoreline base with ocean current moving left→right */}
        <div className="mt-3.5">
          <div
            className="relative h-3.5 w-full overflow-hidden rounded-full"
            style={{ boxShadow: fillPct > 0 ? "inset 0 1px 3px rgba(0,0,0,0.08)" : "none" }}
          >
            <div className={`absolute inset-x-0 bottom-0 h-[2px] ${progressSand}`} />
            {fillPct > 0 ? (
              <div
                className="absolute inset-y-0 left-0 transition-all duration-1000 ease-out"
                style={{
                  width: `${fillPct}%`,
                  clipPath: "polygon(0 0, calc(100% - 48px) 0, 100% 82%, calc(100% - 8px) 100%, 0 100%)",
                }}
              >
                {/* Scrolling SVG wave — 2 tiles side by side, translates left by 50% = one tile */}
                <svg
                  viewBox="0 0 200 16"
                  preserveAspectRatio="none"
                  className="absolute inset-0"
                  style={{
                    width: "200%",
                    height: "100%",
                    animation: "wave-scroll 6s linear infinite",
                  }}
                  aria-hidden="true"
                >
                  <defs>
                    <linearGradient id="wave-grad" x1="0%" y1="0%" x2="100%" y2="0%">
                      <stop offset="0%"   stopColor="#0e7490" />
                      <stop offset="32%"  stopColor="#0891b2" />
                      <stop offset="46%"  stopColor="#67e8f9" />
                      <stop offset="50%"  stopColor="#ffffff" />
                      <stop offset="54%"  stopColor="#ecfeff" />
                      <stop offset="68%"  stopColor="#22d3ee" />
                      <stop offset="100%" stopColor="#0e7490" />
                    </linearGradient>
                  </defs>
                  {/*
                    Two identical wave tiles (each 100 units wide) placed side by side.
                    The wave top edge is a gentle sine — crests at y=2, troughs at y=6.
                    The path fills down to y=16 (the full bar height).
                    As the SVG translates left by 100 units (50% of 200), it seamlessly loops.
                  */}
                  <path
                    d="
                      M0 2
                      C8 0, 17 0, 25 2
                      S42 4, 50 2
                      S67 0, 75 2
                      S92 4, 100 2
                      C108 0, 117 0, 125 2
                      S142 4, 150 2
                      S167 0, 175 2
                      S192 4, 200 2
                      L200 16 L0 16 Z
                    "
                    fill="url(#wave-grad)"
                  />
                </svg>
                <div
                  className="pointer-events-none absolute inset-y-0 right-0"
                  style={{
                    width: "30px",
                    background:
                      "linear-gradient(90deg, rgba(34,211,238,0) 0%, rgba(165,243,252,0.75) 50%, rgba(186,230,253,0.98) 100%)",
                  }}
                />
              </div>
            ) : null}
          </div>
          <div className="mt-1 flex items-center justify-between">
            <span className={`text-[10px] ${subTextColor}`}>
              {xpEarned.toLocaleString()} / {track.totalXpGoal.toLocaleString()} XP
            </span>
            {nextXpNeeded > 0 ? (
              <span className={`text-[10px] ${nextXpColor}`}>
                {nextXpNeeded.toLocaleString()} XP to next reward
              </span>
            ) : (
              <span className="text-[10px] font-semibold text-amber-600">
                All tiers unlocked! 🎉
              </span>
            )}
          </div>
        </div>

        {/* Status chips */}
        {deliveredCount > 0 || claimedCount > 0 || unlockedCount > 0 ? (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {deliveredCount > 0 ? (
              <span className="rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                ✓ {deliveredCount} delivered
              </span>
            ) : null}
            {claimedCount > 0 ? (
              <span className="rounded-full border border-violet-300 bg-violet-50 px-2 py-0.5 text-[10px] font-semibold text-violet-700">
                ⏳ {claimedCount} pending
              </span>
            ) : null}
            {unlockedCount > 0 ? (
              <span className="rounded-full border border-cyan-300 bg-cyan-50 px-2 py-0.5 text-[10px] font-semibold text-cyan-700">
                ✨ {unlockedCount} ready to claim
              </span>
            ) : null}
          </div>
        ) : null}

        {/* Tier scroll track */}
        <div className="mt-4 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="mx-auto min-w-full" style={trackWidthStyle}>
            <div
              className="grid items-center gap-y-1.5"
              style={{
                gridTemplateColumns: trackTemplateColumns,
                minWidth: minTrackWidth,
              }}
            >
              {sorted.map((tier, i) => (
                <div key={`node-${tier.id}`} className="flex shrink-0 flex-col items-center gap-1">
                  <span className="text-[8px] font-bold uppercase tracking-wider text-slate-400">
                    T{tier.tierNumber}
                  </span>
                  <TierNode
                    tier={tier}
                    claim={claimByTierId.get(tier.id)}
                    xpEarned={xpEarned}
                    onClaim={onClaimReward}
                    editable={editable}
                    onEdit={onEditTier}
                  />
                </div>
              )).flatMap((nodeEl, i) => {
                const elements: JSX.Element[] = [nodeEl];
                if (i < sorted.length - 1) {
                  elements.push(
                    <svg
                      key={`connector-${sorted[i]!.id}-${sorted[i + 1]!.id}`}
                      viewBox="0 0 100 10"
                      className={`h-3 min-w-0 ${connectorColor}`}
                      style={{
                        width: "calc(100% + 12px)",
                        marginLeft: "-6px",
                        marginRight: "-6px",
                      }}
                      aria-hidden="true"
                    >
                      <path
                        d="M0 6 C10 1, 20 1, 30 6 S50 11, 60 6 S80 1, 90 6 S99 9, 100 6"
                        stroke="currentColor"
                        strokeWidth="1.7"
                        fill="none"
                        strokeLinecap="round"
                      />
                    </svg>,
                  );
                }
                return elements;
              })}
            </div>
          </div>
        </div>

        {editable ? (
          <p className="mt-2 text-[10px] text-slate-400">
            Click <strong>Edit</strong> on any tier node to update its reward.
          </p>
        ) : null}
      </div>
    </>
  );
}
