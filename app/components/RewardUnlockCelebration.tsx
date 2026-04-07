import { useState } from "react";
import type { RewardTierData } from "./StudentRewardTrack";

type Props = {
  tiers: RewardTierData[];
  onDismiss: () => void;
  onClaim: (tierId: string) => Promise<void>;
};

// ── Confetti ──────────────────────────────────────────────────────────────────

const CONFETTI_COLORS = [
  "#f59e0b", "#10b981", "#6366f1", "#ec4899",
  "#3b82f6", "#f97316", "#a78bfa", "#22d3ee",
];

const CONFETTI_ELEMENTS = Array.from({ length: 28 }, (_, i) => ({
  id: i,
  color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
  size: 6 + (i % 5) * 3,
  isRect: i % 3 === 0,
  isStar: i % 7 === 0,
  delay: (i * 0.055).toFixed(2),
  duration: (0.85 + (i % 5) * 0.18).toFixed(2),
  tx: ((i % 10) - 4.5) * 40,
  ty: -(70 + (i % 8) * 32),
  rotate: (i % 3 === 0 ? 1 : -1) * (25 + (i % 6) * 30),
}));

function Confetti() {
  return (
    <>
      <style>{`
        @keyframes confetti-burst {
          0%   { transform: translate(0, 0) rotate(0deg) scale(1); opacity: 1; }
          80%  { opacity: 0.7; }
          100% { transform: translate(var(--tx), var(--ty)) rotate(var(--rot)) scale(0.3); opacity: 0; }
        }
        @keyframes tier-pop {
          0%   { transform: scale(0.3) rotate(-15deg); opacity: 0; }
          50%  { transform: scale(1.2) rotate(8deg); opacity: 1; }
          75%  { transform: scale(0.95) rotate(-3deg); }
          100% { transform: scale(1) rotate(0deg); opacity: 1; }
        }
        @keyframes tier-glow {
          0%, 100% { box-shadow: 0 0 20px 4px rgba(251,191,36,0.3); }
          50%       { box-shadow: 0 0 40px 10px rgba(251,191,36,0.55); }
        }
        .confetti-piece {
          position: absolute;
          left: 50%;
          top: 50%;
          animation: confetti-burst var(--dur) ease-out var(--delay) both;
        }
        .tier-icon-pop {
          animation: tier-pop 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) 0.15s both,
                     tier-glow 2s ease-in-out 0.65s infinite;
        }
      `}</style>

      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        {CONFETTI_ELEMENTS.map((el) => (
          el.isStar ? (
            <span
              key={el.id}
              className="confetti-piece"
              style={{
                "--tx": `${el.tx}px`,
                "--ty": `${el.ty}px`,
                "--rot": `${el.rotate}deg`,
                "--dur": `${el.duration}s`,
                "--delay": `${el.delay}s`,
                fontSize: el.size + 4,
                color: el.color,
                marginLeft: -(el.size + 4) / 2,
                marginTop: -(el.size + 4) / 2,
                lineHeight: 1,
              } as React.CSSProperties}
            >★</span>
          ) : (
            <div
              key={el.id}
              className="confetti-piece"
              style={{
                "--tx": `${el.tx}px`,
                "--ty": `${el.ty}px`,
                "--rot": `${el.rotate}deg`,
                "--dur": `${el.duration}s`,
                "--delay": `${el.delay}s`,
                width: el.size,
                height: el.isRect ? el.size * 1.6 : el.size,
                borderRadius: el.isRect ? 2 : "50%",
                background: el.color,
                marginLeft: -el.size / 2,
                marginTop: -el.size / 2,
              } as React.CSSProperties}
            />
          )
        ))}
      </div>
    </>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export function RewardUnlockCelebration({ tiers, onDismiss, onClaim }: Props) {
  const [index, setIndex] = useState(0);
  const [claiming, setClaiming] = useState(false);
  const [claimed, setClaimed] = useState<Set<string>>(new Set());

  const tier = tiers[index];
  if (!tier) return null;

  const isAlreadyClaimed = claimed.has(tier.id);
  const total = tiers.length;

  async function handleClaim() {
    setClaiming(true);
    try {
      await onClaim(tier.id);
      setClaimed((prev) => new Set([...prev, tier.id]));
    } finally {
      setClaiming(false);
    }
  }

  function handleNext() {
    if (index < total - 1) {
      setIndex(index + 1);
    } else {
      onDismiss();
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(15, 10, 40, 0.82)" }}
    >
      {/* Center card */}
      <div
        className="relative flex w-full max-w-sm flex-col items-center overflow-hidden rounded-3xl bg-white p-6 text-center shadow-2xl sm:p-8"
        style={{ maxWidth: 360 }}
      >
        <Confetti />

        {/* Heading */}
        <p className="relative z-10 text-xl font-bold text-slate-900 sm:text-2xl">
          🎉 You unlocked a reward!
        </p>

        {/* Tier number badge */}
        <span className="relative z-10 mt-2 rounded-full bg-amber-100 px-3 py-0.5 text-xs font-semibold uppercase tracking-wide text-amber-700">
          Tier {tier.tierNumber}
        </span>

        {/* Tier icon */}
        <div
          className="tier-icon-pop relative z-10 mt-5 flex h-20 w-20 items-center justify-center rounded-full"
          style={{
            background: "linear-gradient(135deg, #fbbf24, #d97706)",
            boxShadow: "0 0 32px 8px rgba(251,191,36,0.35)",
          }}
        >
          <span style={{ fontSize: 44 }}>{tier.icon ?? "🎁"}</span>
        </div>

        {/* Title + description */}
        <h2 className="relative z-10 mt-4 text-lg font-bold text-slate-800">
          {tier.title}
        </h2>
        {tier.description ? (
          <p className="relative z-10 mt-1 text-sm text-slate-500">
            {tier.description}
          </p>
        ) : null}

        {/* Claim buttons */}
        <div className="relative z-10 mt-6 flex w-full flex-col gap-2">
          {isAlreadyClaimed ? (
            <div className="rounded-xl bg-emerald-50 py-3 text-sm font-semibold text-emerald-700">
              ✓ Claimed! Your parent will deliver it soon.
            </div>
          ) : (
            <button
              type="button"
              disabled={claiming}
              onClick={() => void handleClaim()}
              className="w-full rounded-xl bg-amber-500 py-3 text-sm font-bold text-white shadow hover:bg-amber-600 disabled:opacity-60"
            >
              {claiming ? "Claiming…" : "Claim Reward!"}
            </button>
          )}

          <button
            type="button"
            onClick={handleNext}
            className="w-full rounded-xl border border-slate-200 py-2.5 text-sm font-semibold text-slate-500 hover:bg-slate-50"
          >
            {isAlreadyClaimed
              ? index < total - 1
                ? "Next →"
                : "Done"
              : "Claim Later"}
          </button>
        </div>

        {/* Pagination indicator */}
        {total > 1 ? (
          <p className="relative z-10 mt-3 text-xs text-slate-400">
            {index + 1} of {total}
          </p>
        ) : null}
      </div>
    </div>
  );
}
