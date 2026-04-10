import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import {
  generateWeekPlan,
  getStudentSelectionOptions,
  getViewerContext,
  getWeekPlan,
  saveWeekPlan,
} from "../server/functions";
import { ParentPageHeader } from "../components/parent-page-header";

// ── Helpers ───────────────────────────────────────────────────────────────────

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"] as const;
type DayIndex = 0 | 1 | 2 | 3 | 4;

function getMondayOf(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun, 1=Mon…
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function formatWeekRange(monday: Date): string {
  const friday = addDays(monday, 4);
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${fmt(monday)} – ${fmt(friday)}`;
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

// ── Types ─────────────────────────────────────────────────────────────────────

type SlotItem = {
  assignmentId: string;
  title: string;
  contentType: string;
  classTitle: string;
  scheduledDate: string;
  orderIndex: number;
};

type UnscheduledItem = {
  id: string;
  title: string;
  contentType: string;
  classTitle: string;
};

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

    if (!viewer.isAuthenticated) {
      throw redirect({ to: "/login" });
    }

    if (viewer.activeRole === "student") {
      throw redirect({ to: "/student" });
    }

    if (studentOptionsResult.status !== "fulfilled") {
      throw studentOptionsResult.reason;
    }

    return {
      viewer,
      profiles: studentOptionsResult.value.profiles,
    };
  },
  component: PlannerPage,
});

// ── Assignment card ───────────────────────────────────────────────────────────

function AssignmentCard({
  item,
  dragging,
  onDragStart,
  onRemove,
}: {
  item: SlotItem | UnscheduledItem;
  dragging: boolean;
  onDragStart: (e: React.DragEvent, item: SlotItem | UnscheduledItem) => void;
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

// ── Day column ────────────────────────────────────────────────────────────────

function DayColumn({
  label,
  date,
  items,
  isOver,
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
  onDrop: (e: React.DragEvent, date: string) => void;
  onDragOver: (e: React.DragEvent, date: string) => void;
  onDragLeave: () => void;
  onDragStart: (e: React.DragEvent, item: SlotItem | UnscheduledItem) => void;
  onRemove: (assignmentId: string) => void;
  draggingId: string | null;
}) {
  const isToday = date === toIsoDate(new Date());

  return (
    <div
      className={`flex flex-col rounded-2xl border transition min-h-[280px] ${
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
      {/* Header */}
      <div
        className={`flex items-center justify-between px-3 py-2 border-b ${
          isToday ? "border-cyan-200" : "border-slate-100"
        }`}
      >
        <span className={`text-xs font-semibold uppercase tracking-wide ${isToday ? "text-cyan-700" : "text-slate-500"}`}>
          {label}
        </span>
        {isToday ? (
          <span className="rounded-full bg-cyan-600 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white">
            Today
          </span>
        ) : null}
      </div>

      {/* Slots */}
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

// ── Main page ─────────────────────────────────────────────────────────────────

function PlannerPage() {
  const { viewer, profiles } = Route.useLoaderData();

  const [monday, setMonday] = useState<Date>(() => getMondayOf(new Date()));
  const weekStartDate = toIsoDate(monday);

  // profile selection (parent may have multiple students)
  const [profileId, setProfileId] = useState<string>(viewer.profileId ?? "");

  // week data
  const [slots, setSlots] = useState<SlotItem[]>([]);
  const [unscheduled, setUnscheduled] = useState<UnscheduledItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle");

  // drag state
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overDate, setOverDate] = useState<string | null>(null);
  const dragItem = useRef<SlotItem | UnscheduledItem | null>(null);

  const weekDates = useMemo(
    () => Array.from({ length: 5 }, (_, i) => toIsoDate(addDays(monday, i))),
    [monday],
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

  const loadWeekData = useCallback(async () => {
    if (!profileId) return;
    setLoading(true);
    try {
      const result = await getWeekPlan({ data: { profileId, weekStartDate } });
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
      setUnscheduled(
        result.unscheduled.map((a) => ({
          id: a.id,
          title: a.title,
          contentType: a.contentType,
          classTitle: a.classTitle,
        })),
      );
    } catch {
      // ignore — empty state
    } finally {
      setLoading(false);
    }
  }, [profileId, weekStartDate]);

  useEffect(() => {
    void loadWeekData();
  }, [loadWeekData]);

  // ── Drag handlers ──────────────────────────────────────────────────────────

  const handleDragStart = (e: React.DragEvent, item: SlotItem | UnscheduledItem) => {
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
      // Remove from existing slot if present
      const without = prev.filter((s) => s.assignmentId !== assignmentId);

      const dayItems = without.filter((s) => s.scheduledDate === targetDate);
      const newOrderIndex = dayItems.length;

      const newSlot: SlotItem = {
        assignmentId,
        title: item.title,
        contentType: item.contentType,
        classTitle: item.classTitle,
        scheduledDate: targetDate,
        orderIndex: newOrderIndex,
      };

      return [...without, newSlot];
    });

    // Remove from unscheduled if it was there
    setUnscheduled((prev) => prev.filter((a) => a.id !== assignmentId));
  };

  const handleRemoveFromDay = (assignmentId: string) => {
    const slot = slots.find((s) => s.assignmentId === assignmentId);
    if (!slot) return;

    setSlots((prev) => prev.filter((s) => s.assignmentId !== assignmentId));
    setUnscheduled((prev) => [
      ...prev,
      {
        id: slot.assignmentId,
        title: slot.title,
        contentType: slot.contentType,
        classTitle: slot.classTitle,
      },
    ]);
  };

  // ── Save ───────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!profileId) return;
    setSaving(true);
    setSaveStatus("idle");
    try {
      await saveWeekPlan({
        data: {
          profileId,
          weekStartDate,
          slots: slots.map((s) => ({
            assignmentId: s.assignmentId,
            scheduledDate: s.scheduledDate,
            orderIndex: s.orderIndex,
          })),
        },
      });
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2500);
    } catch {
      setSaveStatus("error");
    } finally {
      setSaving(false);
    }
  };

  // ── AI generate ────────────────────────────────────────────────────────────

  const handleGenerate = async () => {
    if (!profileId) return;
    setGenerating(true);
    try {
      const result = await generateWeekPlan({ data: { profileId, weekStartDate } });

      if (result.slots.length === 0) return;

      // Merge AI slots with existing: AI fills unscheduled items
      const aiAssignmentIds = new Set(result.slots.map((s) => s.assignmentId));

      setSlots((prev) => {
        // Keep manually placed slots that AI didn't touch
        const kept = prev.filter((s) => !aiAssignmentIds.has(s.assignmentId));
        const newSlots: SlotItem[] = result.slots.map((s) => {
          const unschItem = unscheduled.find((u) => u.id === s.assignmentId);
          const existing = prev.find((p) => p.assignmentId === s.assignmentId);
          return {
            assignmentId: s.assignmentId,
            title: unschItem?.title ?? existing?.title ?? s.assignmentId,
            contentType: unschItem?.contentType ?? existing?.contentType ?? "text",
            classTitle: unschItem?.classTitle ?? existing?.classTitle ?? "",
            scheduledDate: s.scheduledDate,
            orderIndex: s.orderIndex,
          };
        });
        return [...kept, ...newSlots];
      });

      setUnscheduled((prev) => prev.filter((u) => !aiAssignmentIds.has(u.id)));
    } catch {
      // silent — user sees no change
    } finally {
      setGenerating(false);
    }
  };

  // ── Week navigation ────────────────────────────────────────────────────────

  const goToPrevWeek = () => setMonday((d) => addDays(d, -7));
  const goToNextWeek = () => setMonday((d) => addDays(d, 7));
  const goToCurrentWeek = () => setMonday(getMondayOf(new Date()));
  const handleProfileChange = (nextProfileId: string) => {
    setProfileId(nextProfileId);
    setSlots([]);
    setUnscheduled([]);
    setSaveStatus("idle");
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      <ParentPageHeader
        title="Week Planner"
        description="Drag assignments onto each day, then use AI to balance the week for a smoother workload."
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

          {/* Week nav */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={goToPrevWeek}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
            >
              ←
            </button>
            <button
              type="button"
              onClick={goToCurrentWeek}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              {formatWeekRange(monday)}
            </button>
            <button
              type="button"
              onClick={goToNextWeek}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
            >
              →
            </button>
          </div>

          <div className="flex-1" />

          {/* AI generate */}
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
            ) : (
              "AI Suggest Week"
            )}
          </button>

          {/* Save */}
          <button
            type="button"
            disabled={!profileId || saving}
            onClick={() => void handleSave()}
            className="rounded-xl bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save Plan"}
          </button>

          {saveStatus === "saved" ? (
            <span className="text-xs font-medium text-emerald-600">Saved</span>
          ) : saveStatus === "error" ? (
            <span className="text-xs font-medium text-rose-600">Save failed</span>
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
        <div className="flex gap-4 items-start">
          {/* 5-day grid */}
          <div className="flex-1 grid grid-cols-5 gap-3 min-w-0">
            {DAYS.map((label, i) => {
              const date = weekDates[i];
              return (
                <DayColumn
                  key={date}
                  label={label}
                  date={date}
                  items={slotsByDate.get(date) ?? []}
                  isOver={overDate === date}
                  onDrop={handleDrop}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDragStart={handleDragStart}
                  onRemove={handleRemoveFromDay}
                  draggingId={draggingId}
                />
              );
            })}
          </div>

          {/* Unscheduled sidebar */}
          <div className="w-52 shrink-0">
            <div className="rounded-2xl border border-slate-200 bg-white/90 p-3 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
                Unscheduled ({unscheduled.length})
              </p>
              {loading ? (
                <p className="text-xs text-slate-400 italic">Loading…</p>
              ) : unscheduled.length === 0 ? (
                <p className="text-xs text-slate-400 italic">All scheduled.</p>
              ) : (
                <div className="space-y-2">
                  {unscheduled.map((item) => (
                    <AssignmentCard
                      key={item.id}
                      item={item}
                      dragging={draggingId === item.id}
                      onDragStart={handleDragStart}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
