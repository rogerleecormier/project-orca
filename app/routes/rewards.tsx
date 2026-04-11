import { useState, useEffect, useRef } from "react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import {
  activateRewardTrack,
  aiSuggestTierReward,
  createRewardTrack,
  deactivateRewardTrack,
  getRewardTrackDetail,
  getRewardTracksForOrg,
  getViewerContext,
  setRewardClaimDelivered,
  updateRewardTrack,
  uploadRewardImage,
  upsertRewardTier,
} from "../server/functions";
import { ParentPageHeader } from "../components/parent-page-header";
import { StudentRewardTrack } from "../components/StudentRewardTrack";
import type { RewardTierData } from "../components/StudentRewardTrack";

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

// ── Edit Track Modal (replaces broken navigation) ─────────────────────────────

const REWARD_TYPES = ["treat", "activity", "item", "screen_time", "experience"] as const;
type RewardTypeVal = typeof REWARD_TYPES[number];

type RewardSuggestionOption = {
  tierNumber: number;
  icon: string;
  title: string;
  rewardType: string;
  imageSearchQuery?: string;
  imageUrl?: string | null;
};

function EditTrackModal({
  trackId,
  onClose,
  onSaved,
}: {
  trackId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof getRewardTrackDetail>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getRewardTrackDetail({ data: { trackId } })
      .then((d) => { if (!cancelled) setDetail(d); })
      .catch(() => { if (!cancelled) setError("Failed to load track details."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [trackId]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/50 p-4 pt-10 backdrop-blur-sm overflow-y-auto">
      <div className="flex w-full max-w-3xl flex-col rounded-2xl border border-slate-200 bg-white shadow-2xl mb-10">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <h2 className="text-base font-semibold text-slate-900">
            {detail ? `Edit: ${detail.track.title}` : "Edit Current"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 transition"
          >
            <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-slate-400 text-sm">
              Loading…
            </div>
          ) : error ? (
            <p className="text-sm font-medium text-rose-600">{error}</p>
          ) : detail ? (
            <EditTrackBody
              detail={detail}
              onSaved={() => {
                onSaved();
              }}
            />
          ) : null}
        </div>

        <div className="flex justify-end border-t border-slate-100 px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 transition"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Edit Track Body (rendered inside modal) ───────────────────────────────────

function EditTrackBody({
  detail: initialDetail,
  onSaved,
}: {
  detail: Awaited<ReturnType<typeof getRewardTrackDetail>>;
  onSaved: () => void;
}) {
  const [detail, setDetail] = useState(initialDetail);
  const [activeTab, setActiveTab] = useState<"rewards" | "settings" | "claims">("rewards");
  const [updatingClaimId, setUpdatingClaimId] = useState<string | null>(null);
  const [activating, setActivating] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);

  const track = detail.track;
  const claimByTierId = new Map(detail.claims.map((c) => [c.tierId, c]));
  const pendingClaims = detail.claims.filter((c) => c.status === "claimed");
  const hasBonusTier = detail.tiers.some((tier) => tier.isBonusTier);

  async function reload() {
    const fresh = await getRewardTrackDetail({ data: { trackId: track.id } });
    setDetail(fresh);
    onSaved();
  }

  async function handleActivate() {
    setActivating(true);
    try {
      await activateRewardTrack({ data: { trackId: track.id } });
      await reload();
    } catch {
      setActivating(false);
    }
  }

  async function handleDeactivate() {
    setDeactivating(true);
    try {
      await deactivateRewardTrack({ data: { trackId: track.id } });
      setConfirmDeactivate(false);
      await reload();
    } catch {
      setDeactivating(false);
      setConfirmDeactivate(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* Activate / Deactivate */}
      <div className="flex flex-wrap items-center gap-2">
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
                  {deactivating ? "…" : "Yes, deactivate"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDeactivate(false)}
                  className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
                >
                  Cancel
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
            className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60 transition"
          >
            {activating ? "Activating…" : "Activate Current"}
          </button>
        )}

        {pendingClaims.length > 0 ? (
          <button
            type="button"
            onClick={() => setActiveTab("claims")}
            className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-800"
          >
            ⚡ {pendingClaims.length} pending delivery
          </button>
        ) : null}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1">
        {(["rewards", "settings", "claims"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`flex-1 rounded-lg py-1.5 text-xs font-semibold capitalize transition ${
              activeTab === tab
                ? "bg-white text-slate-900 shadow-sm"
                : "text-slate-500 hover:text-slate-700"
            }`}
          >
            {tab === "claims" ? "Claim History" : tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* ── Rewards Tab ── */}
      {activeTab === "rewards" ? (
        <div className="space-y-4">
          <div className="space-y-3">
            {detail.tiers
              .sort((a, b) => a.tierNumber - b.tierNumber)
              .map((tier) => (
                <TierEditorRow
                  key={tier.id}
                  tier={tier}
                  claim={claimByTierId.get(tier.id)}
                  profileId={track.profileId}
                  onToggleDelivered={async (claim, delivered) => {
                    await setRewardClaimDelivered({ data: { claimId: claim.id, delivered } });
                    await reload();
                  }}
                  onSaved={reload}
                />
              ))}
          </div>

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
                await reload();
              }}
              className="w-full rounded-xl border border-dashed border-amber-300 bg-amber-50 px-4 py-2.5 text-sm font-medium text-amber-700 hover:bg-amber-100 transition"
            >
              + Add Bonus Tier
            </button>
          ) : null}
        </div>
      ) : null}

      {/* ── Settings Tab ── */}
      {activeTab === "settings" ? (
        <TrackSettingsPanel trackDetail={detail} onSaved={reload} />
      ) : null}

      {/* ── Claims Tab ── */}
      {activeTab === "claims" ? (
        <ClaimHistoryTable
          claims={detail.claims}
          tiers={detail.tiers}
          onDelivered={reload}
          updatingClaimId={updatingClaimId}
          setUpdatingClaimId={setUpdatingClaimId}
        />
      ) : null}
    </div>
  );
}

// ── Tier Editor Row ───────────────────────────────────────────────────────────

type DetailClaimRow = Awaited<ReturnType<typeof getRewardTrackDetail>>["claims"][number];
type DetailTierRow = Awaited<ReturnType<typeof getRewardTrackDetail>>["tiers"][number];

function TierEditorRow({
  tier,
  claim,
  profileId,
  onToggleDelivered,
  onSaved,
}: {
  tier: DetailTierRow;
  claim: DetailClaimRow | undefined;
  profileId: string;
  onToggleDelivered: (claim: DetailClaimRow, delivered: boolean) => Promise<void>;
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
  const [suggestions, setSuggestions] = useState<RewardSuggestionOption[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [deliveryUpdating, setDeliveryUpdating] = useState(false);

  // Image upload state
  const [imagePreview, setImagePreview] = useState<string | null>(tier.imageUrl ?? null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isDirty =
    icon !== (tier.icon ?? "🎁") ||
    title !== tier.title ||
    rewardType !== tier.rewardType ||
    estimatedValue !== (tier.estimatedValue ?? "") ||
    description !== (tier.description ?? "") ||
    imagePreview !== (tier.imageUrl ?? null);

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
    const selected = suggestions.find(
      (s) => `${s.icon}|${s.title}|${s.rewardType}|${s.imageUrl ?? ""}` === selectedSuggestion,
    );
    if (!selected) return;
    setIcon(selected.icon || "🎁");
    setTitle(selected.title);
    setRewardType(selected.rewardType);
    if (selected.imageUrl) {
      setImagePreview(selected.imageUrl);
    }
  }

  async function handleSuggestForTier() {
    setSuggesting(true);
    setSuggestError(null);
    try {
      const result = await aiSuggestTierReward({
        data: {
          profileId,
          tierNumber: tier.tierNumber,
          count: 5,
        },
      });
      setSuggestions(result);
    } catch {
      setSuggestError("Could not fetch AI suggestions right now.");
    } finally {
      setSuggesting(false);
    }
  }

  async function handleImageFile(file: File) {
    if (!file.type.startsWith("image/")) {
      setImageError("Please choose an image file.");
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setImageError("Image must be under 4 MB.");
      return;
    }
    setImageError(null);
    setUploadingImage(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          // Strip the data URL prefix to get pure base64
          resolve(result.split(",")[1] ?? "");
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const { dataUrl } = await uploadRewardImage({
        data: { tierId: tier.id, base64, mimeType: file.type },
      });
      setImagePreview(dataUrl);
      onSaved();
    } catch {
      setImageError("Upload failed. Please try again.");
    } finally {
      setUploadingImage(false);
    }
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
          imageUrl: imagePreview ?? undefined,
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

        {/* Image thumbnail + upload */}
        <div className="flex shrink-0 flex-col items-center gap-1">
          <div
            className="relative h-14 w-14 overflow-hidden rounded-xl border-2 border-dashed border-slate-200 bg-slate-50 cursor-pointer hover:border-cyan-400 transition group"
            onClick={() => fileInputRef.current?.click()}
            title="Click to upload reward image"
          >
            {imagePreview ? (
              <img src={imagePreview} alt="Reward" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full items-center justify-center">
                <svg viewBox="0 0 24 24" className="h-6 w-6 text-slate-300 group-hover:text-cyan-400 transition" fill="none">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  <polyline points="17 8 12 3 7 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  <line x1="12" y1="3" x2="12" y2="15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </div>
            )}
            {uploadingImage ? (
              <div className="absolute inset-0 flex items-center justify-center bg-white/70">
                <span className="text-[10px] text-cyan-700 font-semibold">…</span>
              </div>
            ) : null}
          </div>
          <span className="text-[9px] text-slate-400">
            {imagePreview ? "Change" : "Add photo"}
          </span>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleImageFile(file);
              e.target.value = "";
            }}
          />
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

      {imageError ? (
        <p className="mt-1.5 text-xs font-medium text-rose-600">{imageError}</p>
      ) : null}
      {suggestError ? (
        <p className="mt-1.5 text-xs font-medium text-rose-600">{suggestError}</p>
      ) : null}

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

      <div className="mt-2">
        <button
          type="button"
          disabled={suggesting}
          onClick={() => void handleSuggestForTier()}
          className="rounded-lg border border-cyan-300 bg-cyan-50 px-3 py-1.5 text-xs font-semibold text-cyan-800 hover:bg-cyan-100 disabled:opacity-60"
        >
          {suggesting ? "Generating options…" : "AI Suggest For This Tier"}
        </button>
      </div>

      {/* AI suggestion picker */}
      {suggestions.length > 0 ? (
        <div className="mt-2 rounded-xl border border-cyan-100 bg-cyan-50/60 px-3 py-2">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-cyan-800">
            AI options
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            {suggestions.map((s) => {
              const key = `${s.icon}|${s.title}|${s.rewardType}|${s.imageUrl ?? ""}`;
              const selected = selectedSuggestion === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSelectedSuggestion(key)}
                  className={`overflow-hidden rounded-lg border text-left transition ${
                    selected
                      ? "border-cyan-500 bg-white"
                      : "border-cyan-200 bg-white/80 hover:bg-white"
                  }`}
                >
                  {s.imageUrl ? (
                    <img src={s.imageUrl} alt={s.title} className="h-16 w-full object-cover" />
                  ) : (
                    <div className="flex h-16 w-full items-center justify-center bg-cyan-100/60 text-2xl">
                      {s.icon || "🎁"}
                    </div>
                  )}
                  <div className="p-2">
                    <div className="truncate text-xs font-semibold text-slate-900">
                      {s.icon} {s.title}
                    </div>
                    <div className="text-[10px] text-slate-500">
                      {REWARD_TYPE_LABELS[s.rewardType] ?? "Treat"}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={applySelectedSuggestion}
              disabled={!selectedSuggestion}
              className="rounded-lg border border-cyan-300 bg-white px-2.5 py-1 text-xs font-medium text-cyan-800 hover:bg-cyan-100 disabled:opacity-50"
            >
              Use Selected
            </button>
          </div>
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

const CLAIM_STATUS_STYLES: Record<string, string> = {
  unclaimed: "border-slate-200 bg-slate-50 text-slate-500",
  claimed:   "border-amber-200 bg-amber-50 text-amber-700",
  delivered: "border-emerald-200 bg-emerald-50 text-emerald-700",
};

function ClaimHistoryTable({
  claims,
  tiers,
  onDelivered,
  updatingClaimId,
  setUpdatingClaimId,
}: {
  claims: DetailClaimRow[];
  tiers: DetailTierRow[];
  onDelivered: () => void;
  updatingClaimId: string | null;
  setUpdatingClaimId: (id: string | null) => void;
}) {
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

// ── Track Settings Panel ──────────────────────────────────────────────────────

function TrackSettingsPanel({
  trackDetail,
  onSaved,
}: {
  trackDetail: Awaited<ReturnType<typeof getRewardTrackDetail>>;
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
    await Promise.all(
      trackDetail.tiers.map((tier) =>
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
          Total XP Goal{" "}
          <span className="text-xs font-normal text-slate-500">
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
            Updating XP goal will rescale all tier thresholds.
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

// ── Active Track Card (now uses shared StudentRewardTrack in editable mode) ───

function ActiveTrackCard({
  track,
  onDeactivated,
  onEdit,
}: {
  track: TrackRow;
  onDeactivated: () => void;
  onEdit: (trackId: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [deactivating, setDeactivating] = useState(false);

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

  // Build normalized data for StudentRewardTrack
  const trackData = {
    id: track.id,
    title: track.title,
    totalXpGoal: track.totalXpGoal,
    isActive: track.isActive,
    startedAt: track.startedAt ?? null,
    completedAt: track.completedAt ?? null,
  };

  return (
    <article className="rounded-2xl border border-cyan-200 bg-white shadow-sm overflow-hidden">
      {/* Header row */}
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-3 sm:px-5">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-base font-bold text-slate-600">
          {track.profile?.displayName?.charAt(0).toUpperCase() ?? "?"}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-slate-500">
            {track.profile?.displayName ?? "Unknown student"}
          </p>
          <h3 className="truncate text-sm font-semibold text-slate-900">{track.title}</h3>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">
            ACTIVE
          </span>
          <button
            type="button"
            onClick={() => onEdit(track.id)}
            className="rounded-xl border border-cyan-300 bg-cyan-50 px-3 py-1.5 text-xs font-medium text-cyan-800 hover:bg-cyan-100 transition"
          >
            Edit Current
          </button>
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

      {/* Ocean-themed track view, matching student style */}
      <div className="p-4 sm:p-5">
        <StudentRewardTrack
          track={trackData}
          tiers={track.tiers as RewardTierData[]}
          claims={[]}
          xpEarned={xpEarned}
          newlyUnlockedTierIds={[]}
          onClaimReward={async () => {}}
          editable
          onEditTier={() => onEdit(track.id)}
        />
      </div>

      {/* Pending claims banner */}
      {track.pendingClaimsCount > 0 ? (
        <div className="mx-4 mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 sm:mx-5 sm:mb-5">
          <p className="text-sm font-semibold text-amber-800">
            ⚡ {track.pendingClaimsCount} reward{track.pendingClaimsCount > 1 ? "s" : ""} waiting to be delivered
          </p>
          <button
            type="button"
            onClick={() => onEdit(track.id)}
            className="mt-1.5 inline-block text-xs font-medium text-amber-700 underline-offset-2 hover:underline"
          >
            Review &amp; toggle delivered →
          </button>
        </div>
      ) : null}
    </article>
  );
}

// ── Tracks Table Row ──────────────────────────────────────────────────────────

function TrackTableRow({
  track,
  onActivated,
  onDeactivated,
  onEdit,
}: {
  track: TrackRow;
  onActivated: () => void;
  onDeactivated: () => void;
  onEdit: (trackId: string) => void;
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
          <button
            type="button"
            onClick={() => onEdit(track.id)}
            className="text-xs font-medium text-cyan-700 hover:underline"
          >
            Edit
          </button>
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

type DraftTier = {
  tierNumber: number;
  icon: string;
  title: string;
  rewardType: RewardTypeVal;
  description: string;
  estimatedValue: string;
  imageUrl: string;
};

type CurrentBuilderMode = "manual" | "ai";

function makeDraftTiers(): DraftTier[] {
  const defaults: Array<Omit<DraftTier, "description" | "imageUrl"> & { description?: string }> = [
    { tierNumber: 1, icon: "🖥️", title: "Example: 3 Hours Screen Time", rewardType: "screen_time", estimatedValue: "$0-10" },
    { tierNumber: 2, icon: "🥤", title: "Example: Snack Or Drink", rewardType: "treat", estimatedValue: "$5-15" },
    { tierNumber: 3, icon: "🎁", title: "Example: Small Item Reward", rewardType: "item", estimatedValue: "$10-20" },
    { tierNumber: 4, icon: "🎁", title: "Example: Better Item Reward", rewardType: "item", estimatedValue: "$18-30" },
    { tierNumber: 5, icon: "🎬", title: "Example: Parent Outing", rewardType: "experience", estimatedValue: "$25-50" },
  ];

  return defaults.map((tier) => ({
    ...tier,
    description: tier.description ?? "",
    imageUrl: "",
  }));
}

function xpForTier(tierNumber: number, totalXpGoal: number) {
  if (tierNumber > 5) return Math.round(totalXpGoal * 1.2);
  return Math.round((tierNumber / 5) * totalXpGoal);
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
  const [draftTiers, setDraftTiers] = useState<DraftTier[]>(() => makeDraftTiers());
  const [builderMode, setBuilderMode] = useState<CurrentBuilderMode>("manual");
  const [steeringPrompt, setSteeringPrompt] = useState("");
  const [includeBonusTier, setIncludeBonusTier] = useState(false);
  const [creating, setCreating] = useState(false);
  const [activating, setActivating] = useState(false);
  const [createdTrackId, setCreatedTrackId] = useState<string | null>(null);
  const [aiBuildingCurrent, setAiBuildingCurrent] = useState(false);
  const [aiLoadingByTier, setAiLoadingByTier] = useState<Record<number, boolean>>({});
  const [aiOptionsByTier, setAiOptionsByTier] = useState<Record<number, RewardSuggestionOption[]>>({});
  const [error, setError] = useState<string | null>(null);

  function updateTier(index: number, patch: Partial<DraftTier>) {
    setDraftTiers((prev) => prev.map((t, i) => (i === index ? { ...t, ...patch } : t)));
  }

  function applySuggestion(tierIndex: number, suggestion: RewardSuggestionOption) {
    const validTypes = REWARD_TYPES as readonly string[];
    const rewardType = validTypes.includes(suggestion.rewardType)
      ? (suggestion.rewardType as RewardTypeVal)
      : "treat";
    updateTier(tierIndex, {
      icon: suggestion.icon,
      title: suggestion.title,
      rewardType,
      imageUrl: suggestion.imageUrl ?? "",
    });
  }

  async function handleAiSuggestForTier(tierNumber: number) {
    setAiLoadingByTier((prev) => ({ ...prev, [tierNumber]: true }));
    setError(null);
    try {
      const result = await aiSuggestTierReward({
        data: {
          profileId,
          tierNumber,
          count: 5,
          steeringPrompt: steeringPrompt.trim() || undefined,
        },
      });
      setAiOptionsByTier((prev) => ({ ...prev, [tierNumber]: result }));
    } catch {
      setError("AI suggestions failed. You can still fill in rewards manually.");
    } finally {
      setAiLoadingByTier((prev) => ({ ...prev, [tierNumber]: false }));
    }
  }

  async function handleAiBuildCurrent() {
    setAiBuildingCurrent(true);
    setError(null);
    try {
      const batches = await Promise.all(
        draftTiers.map((tier) =>
          aiSuggestTierReward({
            data: {
              profileId,
              tierNumber: tier.tierNumber,
              count: 5,
              steeringPrompt: steeringPrompt.trim() || undefined,
            },
          }),
        ),
      );

      setAiOptionsByTier(() => {
        const next: Record<number, RewardSuggestionOption[]> = {};
        for (let i = 0; i < draftTiers.length; i++) {
          next[draftTiers[i]!.tierNumber] = batches[i] ?? [];
        }
        return next;
      });

      setDraftTiers((prev) =>
        prev.map((tier, i) => {
          const first = batches[i]?.[0];
          if (!first) return tier;
          const validTypes = REWARD_TYPES as readonly string[];
          return {
            ...tier,
            icon: first.icon || tier.icon,
            title: first.title || tier.title,
            rewardType: validTypes.includes(first.rewardType)
              ? (first.rewardType as RewardTypeVal)
              : tier.rewardType,
            imageUrl: first.imageUrl ?? tier.imageUrl,
          };
        }),
      );
    } catch {
      setError("AI current builder failed. You can still customize manually.");
    } finally {
      setAiBuildingCurrent(false);
    }
  }

  async function handleCreate() {
    if (!title.trim() || !profileId) return;
    setError(null);
    setCreating(true);
    try {
      const tiersPayload = draftTiers.map((t) => ({
        tierNumber: t.tierNumber,
        title: t.title.trim() || `Tier ${t.tierNumber} Reward`,
        description: t.description.trim() || undefined,
        icon: t.icon || "🎁",
        rewardType: t.rewardType,
        estimatedValue: t.estimatedValue.trim() || undefined,
        imageUrl: t.imageUrl || undefined,
      }));
      if (includeBonusTier) {
        tiersPayload.push({
          tierNumber: 6,
          title: "Bonus Reward",
          description: "Optional bonus tier set by parent",
          icon: "⭐",
          rewardType: "item",
          estimatedValue: "$100-200",
          imageUrl: undefined,
          isBonusTier: true,
          xpThreshold: Math.round(totalXpGoal * 1.2),
        });
      }
      const result = await createRewardTrack({
        data: {
          profileId,
          title: title.trim(),
          description: description.trim() || undefined,
          schoolYear: schoolYear.trim() || undefined,
          totalXpGoal,
          tiers: tiersPayload,
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
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-4 sm:px-6">
          <h2 className="text-base font-semibold text-slate-900">
            {step === "done" ? "Current Created!" : step === 1 ? "New Orca Current" : "Set Rewards"}
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
              <div className="rounded-xl border border-cyan-200 bg-cyan-50/60 p-3">
                <label className="mb-1.5 block text-sm font-medium text-slate-700">Current Builder</label>
                <div className="mb-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setBuilderMode("manual")}
                    className={`rounded-lg px-3 py-1 text-xs font-medium ${
                      builderMode === "manual"
                        ? "bg-slate-900 text-white"
                        : "border border-slate-300 bg-white text-slate-700"
                    }`}
                  >
                    Manual
                  </button>
                  <button
                    type="button"
                    onClick={() => setBuilderMode("ai")}
                    className={`rounded-lg px-3 py-1 text-xs font-medium ${
                      builderMode === "ai"
                        ? "bg-slate-900 text-white"
                        : "border border-slate-300 bg-white text-slate-700"
                    }`}
                  >
                    AI Current Builder
                  </button>
                </div>
                {builderMode === "ai" ? (
                  <div className="space-y-2">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-700">
                        Prompt Steering (optional)
                      </label>
                      <input
                        type="text"
                        value={steeringPrompt}
                        onChange={(e) => setSteeringPrompt(e.target.value)}
                        placeholder="Focus rewards on science, reading, sports, etc."
                        className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm focus:border-cyan-500 focus:outline-none"
                      />
                    </div>
                  </div>
                ) : null}
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
                  <span className="ml-1 font-normal text-slate-500 text-xs">
                    (students earn XP by completing skill tree nodes)
                  </span>
                </label>
                <div className="mb-2 flex flex-wrap gap-2">
                  {[1000, 2500, 5000, 10000].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setTotalXpGoal(preset)}
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
                  onChange={(e) => setTotalXpGoal(Math.max(100, Number(e.target.value)))}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-slate-700">
                  Description <span className="font-normal text-slate-400">(optional)</span>
                </label>
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
              <div className="mb-4 rounded-xl border border-cyan-200 bg-cyan-50/60 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm text-cyan-900">
                    Set a reward at each XP milestone. Use AI per tier to get photo-backed options.
                  </p>
                  <button
                    type="button"
                    disabled={aiBuildingCurrent}
                    onClick={() => void handleAiBuildCurrent()}
                    className="rounded-lg border border-cyan-300 bg-white px-3 py-1.5 text-xs font-semibold text-cyan-800 hover:bg-cyan-100 disabled:opacity-60"
                  >
                    {aiBuildingCurrent ? "Building current…" : "Build Entire Current With AI"}
                  </button>
                </div>
                {builderMode === "ai" && steeringPrompt.trim() ? (
                  <p className="mt-1 text-xs text-cyan-800/80">Steering: {steeringPrompt.trim()}</p>
                ) : null}
              </div>

              <div className="space-y-2">
                {draftTiers.map((tier, i) => (
                  <div
                    key={tier.tierNumber}
                    className="rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2.5"
                  >
                    <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap sm:gap-3">
                      <div className="flex shrink-0 flex-col items-center">
                        <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
                          T{tier.tierNumber}
                        </span>
                        <span className="text-[10px] text-slate-400">
                          {xpForTier(tier.tierNumber, totalXpGoal).toLocaleString()} XP
                        </span>
                      </div>
                      {tier.imageUrl ? (
                        <img
                          src={tier.imageUrl}
                          alt={tier.title || `Tier ${tier.tierNumber} reward`}
                          className="h-10 w-10 shrink-0 rounded-lg object-cover"
                        />
                      ) : (
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-lg">
                          {tier.icon || "🎁"}
                        </div>
                      )}
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
                        onChange={(e) => updateTier(i, { rewardType: e.target.value as RewardTypeVal })}
                        className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs focus:outline-none sm:w-auto"
                      >
                        {REWARD_TYPES.map((rt) => (
                          <option key={rt} value={rt}>
                            {REWARD_TYPE_LABELS[rt]}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={!!aiLoadingByTier[tier.tierNumber]}
                        onClick={() => void handleAiSuggestForTier(tier.tierNumber)}
                        className="rounded-lg border border-cyan-300 bg-cyan-50 px-2.5 py-1 text-xs font-semibold text-cyan-800 hover:bg-cyan-100 disabled:opacity-60"
                      >
                        {aiLoadingByTier[tier.tierNumber] ? "Thinking…" : "AI Suggest"}
                      </button>
                    </div>

                    {aiOptionsByTier[tier.tierNumber]?.length ? (
                      <div className="mt-2 grid gap-2 sm:grid-cols-3">
                        {aiOptionsByTier[tier.tierNumber].map((option) => (
                          <button
                            key={`${tier.tierNumber}-${option.icon}-${option.title}-${option.rewardType}`}
                            type="button"
                            onClick={() => applySuggestion(i, option)}
                            className="overflow-hidden rounded-lg border border-cyan-200 bg-white text-left hover:border-cyan-400"
                          >
                            {option.imageUrl ? (
                              <img src={option.imageUrl} alt={option.title} className="h-14 w-full object-cover" />
                            ) : (
                              <div className="flex h-14 w-full items-center justify-center bg-cyan-100/60 text-2xl">
                                {option.icon || "🎁"}
                              </div>
                            )}
                            <div className="p-2">
                              <div className="truncate text-xs font-semibold text-slate-900">
                                {option.icon} {option.title}
                              </div>
                              <div className="text-[10px] text-slate-500">
                                {REWARD_TYPE_LABELS[option.rewardType] ?? "Treat"}
                              </div>
                            </div>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>

              <label className="mt-3 flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <input
                  type="checkbox"
                  checked={includeBonusTier}
                  onChange={(e) => setIncludeBonusTier(e.target.checked)}
                  className="h-4 w-4"
                />
                Add optional bonus tier (Tier 6)
              </label>
            </div>
          ) : null}

          {/* ── Done ── */}
          {step === "done" ? (
            <div className="py-4 text-center">
              <div className="mb-3 text-4xl">🎉</div>
              <h3 className="text-lg font-semibold text-slate-900">Orca Current created!</h3>
              <p className="mt-1 text-sm text-slate-600">
                Would you like to activate it so students can start earning rewards?
              </p>
              <div className="mt-5 flex flex-col items-center gap-2">
                <button
                  type="button"
                  disabled={activating}
                  onClick={() => void handleActivateNow()}
                  className="w-full max-w-xs rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
                >
                  {activating ? "Activating…" : "Activate Current"}
                </button>
                <button
                  type="button"
                  onClick={() => onCreated()}
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

        {/* Footer */}
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
              {creating ? "Creating…" : "Create Current"}
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
  const [editingTrackId, setEditingTrackId] = useState<string | null>(null);

  const profileMap = new Map<string, { id: string; displayName: string; gradeLevel: string | null }>();
  for (const t of initialTracks) {
    if (t.profile && !profileMap.has(t.profile.id)) {
      profileMap.set(t.profile.id, {
        id: t.profile.id,
        displayName: t.profile.displayName,
        gradeLevel: null,
      });
    }
  }
  const profiles = Array.from(profileMap.values());
  const activeTracks = initialTracks.filter((t) => t.isActive);

  return (
    <div className="min-w-0 space-y-6">
      <ParentPageHeader
        title="Orca Currents"
        description="Set up milestone rewards to celebrate each student's XP progress and keep long-term goals visible."
        action={(
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="rounded-xl bg-cyan-700 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-cyan-800"
          >
            Add Orca Current
          </button>
        )}
      />

      {/* Active tracks */}
      <section>
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
          Active Currents
        </h3>
        {activeTracks.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-slate-500">
            No active currents. Activate one to start rewarding progress.
          </div>
        ) : (
          <div className="space-y-4">
            {activeTracks.map((track) => (
              <ActiveTrackCard
                key={track.id}
                track={track}
                onDeactivated={() => router.invalidate()}
                onEdit={(id) => setEditingTrackId(id)}
              />
            ))}
          </div>
        )}
      </section>

      {/* All tracks table */}
      <section className="orca-wave rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm sm:p-6">
        <h3 className="mb-4 text-base font-semibold text-slate-900">All Currents</h3>
        {initialTracks.length === 0 ? (
          <p className="text-sm text-slate-500">No currents yet. Create one to get started.</p>
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
                    onEdit={(id) => setEditingTrackId(id)}
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

      {/* Edit modal — replaces broken page navigation */}
      {editingTrackId ? (
        <EditTrackModal
          trackId={editingTrackId}
          onClose={() => setEditingTrackId(null)}
          onSaved={() => {
            router.invalidate();
          }}
        />
      ) : null}
    </div>
  );
}
