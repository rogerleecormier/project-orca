import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import {
  generateWeekPlan,
  getAllPendingAssignments,
  getRecommendedAssignments,
  getStudentSelectionOptions,
  getViewerContext,
  getWeekPlan,
  saveWeekPlan,
} from "../server/functions";
import { ParentPageHeader } from "../components/parent-page-header";

// ── Helpers ───────────────────────────────────────────────────────────────────

const DAY_LABELS_BY_DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function todayInTz(tz: string): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const y = Number(parts.find((p) => p.type === "year")!.value);
  const mo = Number(parts.find((p) => p.type === "month")!.value) - 1;
  const d = Number(parts.find((p) => p.type === "day")!.value);
  return new Date(Date.UTC(y, mo, d));
}

function toIsoDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDays(date: Date, n: number): Date {
  return new Date(date.getTime() + n * 86400000);
}

function isoToUtcNoon(isoDate: string): Date {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

function formatIsoMonthDay(isoDate: string, tz: string): string {
  return isoToUtcNoon(isoDate).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: tz,
  });
}

function getMondayOf(date: Date): Date {
  const dow = date.getUTCDay();
  const daysBack = dow === 0 ? 6 : dow - 1;
  return new Date(date.getTime() - daysBack * 86400000);
}

function getSundayOf(date: Date): Date {
  const dow = date.getUTCDay();
  return new Date(date.getTime() - dow * 86400000);
}

function getWeekStartOf(date: Date, numDays: number): Date {
  return numDays === 7 ? getSundayOf(date) : getMondayOf(date);
}

function formatWeekRange(weekStart: Date, numDays: number, tz: string): string {
  const weekStartIso = toIsoDate(weekStart);
  const lastDayIso = toIsoDate(addDays(weekStart, numDays - 1));
  return `${formatIsoMonthDay(weekStartIso, tz)} – ${formatIsoMonthDay(lastDayIso, tz)}`;
}

// Deterministic hue from a string — spreads classes across the color wheel
function classHue(classTitle: string): number {
  let h = 0;
  for (let i = 0; i < classTitle.length; i++) {
    h = (h * 31 + classTitle.charCodeAt(i)) % 360;
  }
  return h;
}

const TYPE_COLORS: Record<string, string> = {
  quiz: "bg-rose-50 border-rose-200 text-rose-800",
  essay_questions: "bg-violet-50 border-violet-200 text-violet-800",
  video: "bg-cyan-50 border-cyan-200 text-cyan-800",
  text: "bg-slate-50 border-slate-200 text-slate-700",
  file: "bg-amber-50 border-amber-200 text-amber-800",
  url: "bg-emerald-50 border-emerald-200 text-emerald-800",
  report: "bg-orange-50 border-orange-200 text-orange-800",
};

const TYPE_LABELS: Record<string, string> = {
  text: "Reading",
  file: "File",
  url: "Link",
  video: "Video",
  quiz: "Quiz",
  essay_questions: "Essay",
  report: "Report",
};

const NODE_TYPE_LABELS: Record<string, string> = {
  lesson: "Lesson",
  milestone: "Milestone",
  boss: "Boss Challenge",
  branch: "Branch",
  elective: "Elective",
};

// ── Types ─────────────────────────────────────────────────────────────────────

type SlotItem = {
  assignmentId: string;
  title: string;
  contentType: string;
  classTitle: string;
  scheduledDate: string;
  orderIndex: number;
};

type PoolItem = {
  id: string;
  title: string;
  contentType: string;
  classTitle: string;
};

type RecommendedClass = Awaited<
  ReturnType<typeof getRecommendedAssignments>
>["recommendations"][number];

// ── Route ─────────────────────────────────────────────────────────────────────

export const Route = createFileRoute("/planner")({
  loader: async () => {
    const [viewerResult, studentOptionsResult] = await Promise.allSettled([
      getViewerContext(),
      getStudentSelectionOptions(),
    ]);
    const viewer =
      viewerResult.status === "fulfilled"
        ? viewerResult.value
        : {
            isAuthenticated: false,
            activeRole: null,
            isAdminParent: false,
            profileId: null,
          };

    if (!viewer.isAuthenticated) throw redirect({ to: "/login" });
    if (viewer.activeRole === "student") throw redirect({ to: "/student" });
    if (studentOptionsResult.status !== "fulfilled") throw studentOptionsResult.reason;

    return { viewer, profiles: studentOptionsResult.value.profiles };
  },
  component: PlannerPage,
});

// ── Assignment card (calendar slots) ──────────────────────────────────────────

function AssignmentCard({
  item,
  dragging,
  onDragStart,
  onRemove,
}: {
  item: SlotItem | PoolItem;
  dragging: boolean;
  onDragStart: (e: React.DragEvent, item: SlotItem | PoolItem) => void;
  onRemove?: () => void;
}) {
  const colorClass =
    TYPE_COLORS[item.contentType] ?? "bg-slate-50 border-slate-200 text-slate-700";
  const typeLabel = TYPE_LABELS[item.contentType] ?? item.contentType;

  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, item)}
      className={`group flex items-start gap-2 rounded-xl border px-3 py-2 text-left cursor-grab active:cursor-grabbing transition ${colorClass} ${dragging ? "opacity-40 ring-2 ring-cyan-400" : ""}`}
    >
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-semibold uppercase tracking-wide opacity-60">{typeLabel}</p>
        <p className="mt-0.5 text-xs font-medium leading-tight line-clamp-2">{item.title}</p>
        <p className="mt-0.5 text-[10px] opacity-50 truncate">{item.classTitle}</p>
      </div>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          className="shrink-0 mt-0.5 hidden group-hover:flex h-4 w-4 items-center justify-center rounded text-current opacity-50 hover:opacity-100"
          aria-label="Remove from day"
        >
          ×
        </button>
      ) : null}
    </div>
  );
}

// ── Pool chip (compact draggable tile for the all-assignments panel) ───────────

function PoolChip({
  item,
  dragging,
  onDragStart,
}: {
  item: PoolItem;
  dragging: boolean;
  onDragStart: (e: React.DragEvent, item: PoolItem) => void;
}) {
  const typeLabel = TYPE_LABELS[item.contentType] ?? item.contentType;
  const hue = classHue(item.classTitle);
  // Inline style for the class color dot — hsl gives good saturation spread
  const dotStyle = { backgroundColor: `hsl(${hue},65%,50%)` };

  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, item)}
      title={`${item.classTitle} · ${typeLabel}`}
      className={`flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 cursor-grab active:cursor-grabbing transition hover:border-slate-300 hover:shadow-sm select-none ${dragging ? "opacity-40 ring-2 ring-cyan-400" : ""}`}
    >
      {/* Class color dot */}
      <span className="shrink-0 h-2 w-2 rounded-full" style={dotStyle} />
      {/* Type badge */}
      <span className="shrink-0 text-[9px] font-bold uppercase tracking-wide text-slate-400">
        {typeLabel}
      </span>
      {/* Title */}
      <span className="text-xs font-medium text-slate-700 truncate min-w-0">{item.title}</span>
    </div>
  );
}

// ── Day column ────────────────────────────────────────────────────────────────

function DayColumn({
  label,
  date,
  items,
  isOver,
  timezone,
  onDrop,
  onDragOver,
  onDragLeave,
  onDragStart,
  onRemove,
  draggingId,
}: {
  label: string;
  date: string;
  items: SlotItem[];
  isOver: boolean;
  timezone: string;
  onDrop: (e: React.DragEvent, date: string) => void;
  onDragOver: (e: React.DragEvent, date: string) => void;
  onDragLeave: () => void;
  onDragStart: (e: React.DragEvent, item: SlotItem | PoolItem) => void;
  onRemove: (assignmentId: string) => void;
  draggingId: string | null;
}) {
  const isToday = date === toIsoDate(todayInTz(timezone));

  return (
    <div
      className={`flex flex-col rounded-2xl border transition min-h-[260px] ${
        isOver
          ? "border-cyan-400 bg-cyan-50/60"
          : isToday
            ? "border-cyan-300 bg-cyan-50/30"
            : "border-slate-200 bg-white/80"
      }`}
      onDragOver={(e) => onDragOver(e, date)}
      onDragLeave={onDragLeave}
      onDrop={(e) => onDrop(e, date)}
    >
      <div
        className={`flex items-center justify-between px-3 py-2 border-b ${
          isToday ? "border-cyan-200" : "border-slate-100"
        }`}
      >
        <div className="flex flex-col">
          <span className={`text-xs font-semibold uppercase tracking-wide ${isToday ? "text-cyan-700" : "text-slate-500"}`}>
            {label}
          </span>
          <span className={`text-[11px] ${isToday ? "text-cyan-500" : "text-slate-400"}`}>
            {formatIsoMonthDay(date, timezone)}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-slate-400">{items.length}</span>
          {isToday ? (
            <span className="rounded-full bg-cyan-600 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white">
              Today
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex-1 space-y-2 p-2">
        {items.map((item) => (
          <AssignmentCard
            key={item.assignmentId}
            item={item}
            dragging={draggingId === item.assignmentId}
            onDragStart={onDragStart}
            onRemove={() => onRemove(item.assignmentId)}
          />
        ))}
        {items.length === 0 ? (
          <p className="text-[11px] text-slate-400 italic mt-1 px-1">Drop here</p>
        ) : null}
      </div>
    </div>
  );
}

// ── Recommended assignments card ───────────────────────────────────────────────

function RecommendedCard({
  rec,
  draggingId,
  scheduledIds,
  onDragStart,
}: {
  rec: RecommendedClass;
  draggingId: string | null;
  scheduledIds: Set<string>;
  onDragStart: (e: React.DragEvent, item: SlotItem | PoolItem) => void;
}) {
  const isInProgress = rec.nodeStatus === "in_progress";
  const nodeTypeLabel = NODE_TYPE_LABELS[rec.nodeType] ?? rec.nodeType;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white/90 shadow-sm overflow-hidden">
      <div className="px-4 py-2.5 border-b border-slate-100 flex items-center gap-3">
        <div className="flex items-center gap-1.5 shrink-0">
          {isInProgress ? (
            <span className="h-2 w-2 rounded-full bg-cyan-500 animate-pulse" />
          ) : (
            <span className="h-2 w-2 rounded-full bg-emerald-400" />
          )}
          <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            {isInProgress ? "In Progress" : "Up Next"}
          </span>
        </div>
        <span className="text-slate-300 text-xs">·</span>
        <p className="text-sm font-semibold text-slate-800 truncate flex-1">{rec.classTitle}</p>
        <span className="shrink-0 text-[10px] text-slate-400">{nodeTypeLabel}</span>
      </div>

      <div className="px-4 py-1.5 bg-slate-50/60 border-b border-slate-100">
        <p className="text-[10px] text-slate-400 uppercase tracking-wide font-medium">Node</p>
        <p className="text-xs font-semibold text-slate-600 truncate">{rec.nodeTitle}</p>
      </div>

      <div className="p-2 space-y-2">
        {(() => {
          const visible = rec.assignments.filter((a) => !scheduledIds.has(a.id));
          if (visible.length === 0) {
            return <p className="text-xs text-slate-400 italic px-1 py-1">No pending assignments.</p>;
          }
          return visible.map((a) => {
            const dragItem: PoolItem = {
              id: a.id,
              title: a.title,
              contentType: a.contentType,
              classTitle: rec.classTitle,
            };
            return (
              <AssignmentCard
                key={a.id}
                item={dragItem}
                dragging={draggingId === a.id}
                onDragStart={onDragStart}
              />
            );
          });
        })()}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

function PlannerPage() {
  const { viewer, profiles } = Route.useLoaderData();

  const [timezone, setTimezone] = useState<string>(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [weekStart, setWeekStart] = useState<Date | null>(null);
  const [profileId, setProfileId] = useState<string>(viewer.profileId ?? "");
  const [schoolWeekDays, setSchoolWeekDays] = useState<number>(5);

  const [slots, setSlots] = useState<SlotItem[]>([]);
  const [recommendations, setRecommendations] = useState<RecommendedClass[]>([]);
  const [loading, setLoading] = useState(false);
  const [recsLoading, setRecsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  // All-assignments pool — loaded lazily on first profile select, paginated
  const [pool, setPool] = useState<PoolItem[]>([]);
  const [poolLoading, setPoolLoading] = useState(false);
  const [poolPage, setPoolPage] = useState(0);
  const [poolHasMore, setPoolHasMore] = useState(false);
  const [poolTotal, setPoolTotal] = useState(0);
  const poolLoadedForProfile = useRef<string>("");
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overDate, setOverDate] = useState<string | null>(null);
  const dragItem = useRef<SlotItem | PoolItem | null>(null);

  const numDays = Math.min(Math.max(schoolWeekDays, 4), 7);
  const effectiveWeekStart = weekStart ?? getMondayOf(todayInTz(timezone));
  const weekStartDate = toIsoDate(effectiveWeekStart);
  const weekDates = useMemo(
    () => Array.from({ length: numDays }, (_, i) => toIsoDate(addDays(effectiveWeekStart, i))),
    [effectiveWeekStart, numDays],
  );

  const slotsByDate = useMemo(() => {
    const map = new Map<string, SlotItem[]>();
    for (const d of weekDates) map.set(d, []);
    for (const s of slots) {
      const day = map.get(s.scheduledDate);
      if (day) day.push(s);
    }
    for (const day of map.values()) {
      day.sort((a, b) => a.orderIndex - b.orderIndex);
    }
    return map;
  }, [slots, weekDates]);

  const scheduledIds = useMemo(
    () => new Set(slots.map((s) => s.assignmentId)),
    [slots],
  );

  // Visible pool = loaded items minus what's currently on the calendar
  const visiblePool = useMemo(
    () => pool.filter((p) => !scheduledIds.has(p.id)),
    [pool, scheduledIds],
  );

  // ── Data loading ───────────────────────────────────────────────────────────

  const loadWeekData = useCallback(async () => {
    if (!profileId) return;
    setLoading(true);
    try {
      const result = await getWeekPlan({ data: { profileId, weekStartDate } });
      const loadedDays = result.schoolWeekDays ?? 5;
      const loadedTz = result.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      setSchoolWeekDays(loadedDays);
      if (result.timezone) setTimezone(loadedTz);
      setWeekStart((prev) => {
        if (prev !== null) return prev;
        const numLoadedDays = Math.min(Math.max(loadedDays, 4), 7);
        return getWeekStartOf(todayInTz(loadedTz), numLoadedDays);
      });
      setSlots(
        result.slots.map((s) => ({
          assignmentId: s.assignmentId,
          title: s.assignmentTitle,
          contentType: s.assignmentContentType,
          classTitle: s.classTitle,
          scheduledDate: s.scheduledDate,
          orderIndex: s.orderIndex,
        })),
      );
    } catch {
      // ignore — empty state
    } finally {
      setLoading(false);
    }
  }, [profileId, weekStartDate]);

  const loadRecommendations = useCallback(async () => {
    if (!profileId) return;
    setRecsLoading(true);
    try {
      const result = await getRecommendedAssignments({ data: { profileId, weekStartDate } });
      setRecommendations(result.recommendations);
    } catch {
      setRecommendations([]);
    } finally {
      setRecsLoading(false);
    }
  }, [profileId, weekStartDate]);

  const loadPool = useCallback(
    async (page: number, reset = false) => {
      if (!profileId) return;
      setPoolLoading(true);
      try {
        const result = await getAllPendingAssignments({
          data: { profileId, page, pageSize: 50 },
        });
        const items: PoolItem[] = result.assignments.map((a) => ({
          id: a.id,
          title: a.title,
          contentType: a.contentType,
          classTitle: a.classTitle,
        }));
        setPool((prev) => (reset ? items : [...prev, ...items]));
        setPoolPage(page);
        setPoolHasMore(result.hasMore);
        setPoolTotal(result.total);
      } catch {
        // leave as-is
      } finally {
        setPoolLoading(false);
      }
    },
    [profileId],
  );

  useEffect(() => { void loadWeekData(); }, [loadWeekData]);
  useEffect(() => { void loadRecommendations(); }, [loadRecommendations]);

  // Load pool once per profile
  useEffect(() => {
    if (!profileId || poolLoadedForProfile.current === profileId) return;
    poolLoadedForProfile.current = profileId;
    void loadPool(0, true);
  }, [profileId, loadPool]);

  // Infinite scroll — load next page when sentinel enters viewport
  useEffect(() => {
    if (!sentinelRef.current || !poolHasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !poolLoading) {
          void loadPool(poolPage + 1);
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [poolHasMore, poolLoading, poolPage, loadPool]);

  // ── Drag handlers ──────────────────────────────────────────────────────────

  const handleDragStart = (e: React.DragEvent, item: SlotItem | PoolItem) => {
    const id = "assignmentId" in item ? item.assignmentId : item.id;
    setDraggingId(id);
    dragItem.current = item;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("assignmentId", id);
  };

  const handleDragOver = (e: React.DragEvent, date: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setOverDate(date);
  };

  const handleDragLeave = () => setOverDate(null);

  const handleDrop = (e: React.DragEvent, targetDate: string) => {
    e.preventDefault();
    setOverDate(null);
    setDraggingId(null);
    const item = dragItem.current;
    dragItem.current = null;
    if (!item) return;

    const assignmentId = "assignmentId" in item ? item.assignmentId : item.id;

    setSlots((prev) => {
      const without = prev.filter((s) => s.assignmentId !== assignmentId);
      const dayItems = without.filter((s) => s.scheduledDate === targetDate);
      return [
        ...without,
        {
          assignmentId,
          title: item.title,
          contentType: item.contentType,
          classTitle: item.classTitle,
          scheduledDate: targetDate,
          orderIndex: dayItems.length,
        },
      ];
    });
  };

  const handleRemoveFromDay = (assignmentId: string) => {
    const slot = slots.find((s) => s.assignmentId === assignmentId);
    if (!slot) return;
    setSlots((prev) => prev.filter((s) => s.assignmentId !== assignmentId));
    // Ensure it's in the pool (it might already be there if pool was loaded)
    setPool((prev) => {
      if (prev.some((p) => p.id === assignmentId)) return prev;
      return [
        { id: slot.assignmentId, title: slot.title, contentType: slot.contentType, classTitle: slot.classTitle },
        ...prev,
      ];
    });
  };

  // ── Save ───────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!profileId) return;
    setSaving(true);
    setSaveStatus("idle");
    setSaveError(null);
    try {
      const validWeekDates = new Set(weekDates);
      await saveWeekPlan({
        data: {
          profileId,
          weekStartDate,
          slots: Array.from(
            slots
              .filter((s) => validWeekDates.has(s.scheduledDate))
              .reduce((map, s) => { map.set(s.assignmentId, s); return map; }, new Map<string, SlotItem>())
              .values(),
          ).map((s) => ({
            assignmentId: s.assignmentId,
            scheduledDate: s.scheduledDate,
            orderIndex: s.orderIndex,
          })),
        },
      });
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2500);
    } catch (err) {
      console.error("Save failed:", err);
      setSaveStatus("error");
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  // ── AI generate ────────────────────────────────────────────────────────────

  const handleGenerate = async () => {
    if (!profileId) return;
    setGenerating(true);
    setGenerateError(null);
    try {
      const result = await generateWeekPlan({ data: { profileId, weekStartDate } });
      if (result.slots.length === 0) return;

      const aiAssignmentIds = new Set(result.slots.map((s) => s.assignmentId));

      // Build lookup from recommendations + pool so we can resolve metadata
      const metaMap = new Map<string, { title: string; contentType: string; classTitle: string }>();
      for (const rec of recommendations) {
        for (const a of rec.assignments) {
          metaMap.set(a.id, { title: a.title, contentType: a.contentType, classTitle: rec.classTitle });
        }
      }
      for (const p of pool) {
        if (!metaMap.has(p.id)) metaMap.set(p.id, { title: p.title, contentType: p.contentType, classTitle: p.classTitle });
      }

      setSlots((prev) => {
        const kept = prev.filter((s) => !aiAssignmentIds.has(s.assignmentId));
        const newSlots: SlotItem[] = result.slots.map((s) => {
          const meta = metaMap.get(s.assignmentId);
          const existing = prev.find((p) => p.assignmentId === s.assignmentId);
          return {
            assignmentId: s.assignmentId,
            title: meta?.title ?? existing?.title ?? s.assignmentId,
            contentType: meta?.contentType ?? existing?.contentType ?? "text",
            classTitle: meta?.classTitle ?? existing?.classTitle ?? "",
            scheduledDate: s.scheduledDate,
            orderIndex: s.orderIndex,
          };
        });
        return [...kept, ...newSlots];
      });
    } catch (err) {
      console.error("AI generate failed:", err);
      setGenerateError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  };

  // ── Week navigation ────────────────────────────────────────────────────────

  const goToPrevWeek = () => setWeekStart((d) => addDays(d ?? effectiveWeekStart, -7));
  const goToNextWeek = () => setWeekStart((d) => addDays(d ?? effectiveWeekStart, 7));
  const goToCurrentWeek = () => setWeekStart(getWeekStartOf(todayInTz(timezone), numDays));

  const handleProfileChange = (nextProfileId: string) => {
    setProfileId(nextProfileId);
    setSlots([]);
    setRecommendations([]);
    setSaveStatus("idle");
    setPool([]);
    setPoolPage(0);
    setPoolHasMore(false);
    setPoolTotal(0);
    poolLoadedForProfile.current = "";
  };

  const gridColsClass =
    numDays === 4 ? "grid-cols-4"
    : numDays === 5 ? "grid-cols-5"
    : numDays === 6 ? "grid-cols-6"
    : "grid-cols-7";

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      <ParentPageHeader
        title="Week Planner"
        description="Drag assignments onto each day, or use AI to intelligently schedule based on skill map progress and best practices."
      />

      {/* Controls */}
      <section className="rounded-2xl border border-slate-200 bg-white/90 px-6 py-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          {profiles.length > 1 ? (
            <label className="space-y-1">
              <span className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                Student
              </span>
              <select
                value={profileId}
                onChange={(e) => handleProfileChange(e.target.value)}
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700"
              >
                <option value="">Select student…</option>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.displayName}
                    {profile.gradeLevel ? ` · Grade ${profile.gradeLevel}` : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <div className="flex items-center gap-1">
            <button type="button" onClick={goToPrevWeek}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-600 hover:bg-slate-50">
              ←
            </button>
            <button type="button" onClick={goToCurrentWeek}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
              {formatWeekRange(effectiveWeekStart, numDays, timezone)}
            </button>
            <button type="button" onClick={goToNextWeek}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-600 hover:bg-slate-50">
              →
            </button>
          </div>

          <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-500">
            {numDays}-day week
          </span>

          <div className="flex-1" />

          <button
            type="button"
            disabled={!profileId || generating || loading}
            onClick={() => void handleGenerate()}
            className="flex items-center gap-1.5 rounded-xl bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
          >
            {generating ? (
              <>
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                Generating…
              </>
            ) : "AI Suggest Week"}
          </button>

          <button
            type="button"
            disabled={!profileId || saving}
            onClick={() => void handleSave()}
            className="rounded-xl bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save Plan"}
          </button>

          {generateError ? (
            <span className="text-xs font-medium text-rose-600 max-w-xs truncate" title={generateError}>
              AI failed: {generateError}
            </span>
          ) : null}
          {saveStatus === "saved" ? (
            <span className="text-xs font-medium text-emerald-600">Saved</span>
          ) : saveStatus === "error" ? (
            <span className="text-xs font-medium text-rose-600 break-all whitespace-normal max-w-md">
              Save failed{saveError ? `: ${saveError}` : ""}
            </span>
          ) : null}
        </div>
      </section>

      {!profileId ? (
        <section className="rounded-2xl border border-dashed border-slate-300 bg-white/80 p-10 text-center shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Select a student to view their plan</h2>
          <p className="mt-2 text-sm text-slate-600">
            Choose a student above to load assignments and build out the week.
          </p>
        </section>
      ) : (
        <div className="space-y-6">
          {/* Day grid */}
          <div className={`grid ${gridColsClass} gap-3`}>
            {weekDates.map((date) => (
              <DayColumn
                key={date}
                label={DAY_LABELS_BY_DOW[new Date(date + "T00:00:00Z").getUTCDay()]}
                date={date}
                items={slotsByDate.get(date) ?? []}
                isOver={overDate === date}
                timezone={timezone}
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDragStart={handleDragStart}
                onRemove={handleRemoveFromDay}
                draggingId={draggingId}
              />
            ))}
          </div>

          {/* Recommended assignments */}
          <section className="rounded-2xl border border-violet-200 bg-violet-50/40 shadow-sm">
            <div className="flex items-center justify-between px-5 py-3 border-b border-violet-100">
              <div>
                <h3 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
                  <span className="inline-block h-2 w-2 rounded-full bg-violet-500" />
                  Recommended Assignments
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Next assignments from each course's active skill tree node — drag directly onto a day.
                </p>
              </div>
              {recsLoading && (
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-violet-400 border-t-transparent" />
              )}
            </div>

            {recsLoading ? (
              <div className="px-5 py-4">
                <p className="text-xs text-slate-400 italic">Loading recommendations…</p>
              </div>
            ) : recommendations.length === 0 ? (
              <div className="px-5 py-6 text-center">
                <p className="text-sm font-medium text-slate-500">No skill tree progress found.</p>
                <p className="text-xs text-slate-400 mt-1">
                  Once this student has active or available nodes on a skill tree, recommended assignments will appear here.
                </p>
              </div>
            ) : (
              <div className="p-4 grid grid-cols-2 gap-3">
                {recommendations.map((rec) => (
                  <RecommendedCard
                    key={rec.classTitle}
                    rec={rec}
                    draggingId={draggingId}
                    scheduledIds={scheduledIds}
                    onDragStart={handleDragStart}
                  />
                ))}
              </div>
            )}
          </section>

          {/* All assignments pool */}
          <section className="rounded-2xl border border-slate-200 bg-white/90 shadow-sm">
            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
              <div>
                <h3 className="text-sm font-semibold text-slate-800">All Assignments</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  {poolTotal > 0
                    ? `${visiblePool.length} of ${poolTotal} pending — drag any onto a day. Hover a chip for course details.`
                    : "All pending assignments are on the calendar."}
                </p>
              </div>
              {poolLoading && pool.length === 0 ? (
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-transparent" />
              ) : poolTotal > 0 ? (
                <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-500">
                  {poolTotal}
                </span>
              ) : null}
            </div>

            {poolLoading && pool.length === 0 ? (
              <div className="px-5 py-4">
                <p className="text-xs text-slate-400 italic">Loading…</p>
              </div>
            ) : visiblePool.length === 0 && !poolLoading ? (
              <div className="px-5 py-4">
                <p className="text-xs text-emerald-600 font-medium">
                  All pending assignments are already on the calendar.
                </p>
              </div>
            ) : (
              <div className="px-5 py-4">
                {/* Class color legend */}
                {poolTotal > 0 && (
                  <div className="flex flex-wrap gap-x-4 gap-y-1 mb-3">
                    {Array.from(new Set(pool.map((p) => p.classTitle))).map((ct) => (
                      <span key={ct} className="flex items-center gap-1 text-[10px] text-slate-500">
                        <span
                          className="h-2 w-2 rounded-full shrink-0"
                          style={{ backgroundColor: `hsl(${classHue(ct)},65%,50%)` }}
                        />
                        {ct}
                      </span>
                    ))}
                  </div>
                )}

                {/* Chip grid */}
                <div className="flex flex-wrap gap-2">
                  {visiblePool.map((item) => (
                    <PoolChip
                      key={item.id}
                      item={item}
                      dragging={draggingId === item.id}
                      onDragStart={handleDragStart}
                    />
                  ))}
                </div>

                {/* Infinite scroll sentinel */}
                {poolHasMore && (
                  <div ref={sentinelRef} className="mt-4 flex justify-center">
                    {poolLoading ? (
                      <span className="text-xs text-slate-400 italic">Loading more…</span>
                    ) : (
                      <span className="text-xs text-slate-300">↓</span>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
