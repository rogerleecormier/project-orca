import { useState } from "react";
import { RAMP_COLORS } from "./EdgeLayer";
import { AssignmentModal, type ModalAssignment } from "../assignment-modal";

// ── Types ─────────────────────────────────────────────────────────────────────

export type PanelNode = {
  id: string;
  treeId: string;
  organizationId: string;
  title: string;
  description: string | null;
  subject: string | null;
  icon: string | null;
  colorRamp: string;
  nodeType: string;
  xpReward: number;
  positionX: number;
  positionY: number;
  radius: number;
  isRequired: boolean;
  aiGeneratedDescription: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PanelEdge = {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  edgeType: string;
};

export type PanelProgress = {
  nodeId: string;
  status: string;
  xpEarned: number;
  completedAt: string | null;
  masteryAt: string | null;
};

export type PanelAssignment = {
  id: string;
  title: string;
  contentType: string;
  description: string | null;
  contentRef: string | null;
  dueAt: string | null;
  linkedAssignmentId: string | null;
};

type Props = {
  node: PanelNode | null;
  progress: PanelProgress | null;
  nodeAssignments: PanelAssignment[];
  allClassAssignments: PanelAssignment[];
  nodes: PanelNode[];
  edges: PanelEdge[];
  editMode: boolean;
  isStudent: boolean;
  parentPinLength: number | null;
  onClose: () => void;
  onAssignmentLinked: (assignmentId: string) => void;
  onAssignmentUnlinked: (assignmentId: string) => void;
  onNodeUpdated: (updated: PanelNode) => void;
  onDeleteNode: (nodeId: string, pin: string) => void;
  onAiGenerateAssignments: (nodeId: string) => void;
  onMarkComplete: (nodeId: string) => void;
};

// ── Constants ─────────────────────────────────────────────────────────────────

const RAMP_LIST = ["blue", "teal", "purple", "amber", "coral", "green", "gray"] as const;

const NODE_TYPES = ["lesson", "milestone", "boss", "branch", "elective"] as const;

const TYPE_COLORS: Record<string, string> = {
  quiz:            "bg-rose-100 text-rose-700",
  essay_questions: "bg-violet-100 text-violet-700",
  video:           "bg-cyan-100 text-cyan-700",
  text:            "bg-slate-100 text-slate-600",
  file:            "bg-amber-100 text-amber-700",
  url:             "bg-emerald-100 text-emerald-700",
  report:          "bg-orange-100 text-orange-700",
  movie:           "bg-indigo-100 text-indigo-700",
};

const TYPE_LABELS: Record<string, string> = {
  text:            "Reading",
  file:            "File",
  url:             "Link",
  video:           "Video",
  quiz:            "Quiz",
  essay_questions: "Essay",
  report:          "Report",
  movie:           "Movie",
};

const QUICK_TYPES = [
  { type: "text",            label: "Reading" },
  { type: "video",           label: "Video" },
  { type: "quiz",            label: "Quiz" },
  { type: "essay_questions", label: "Essay" },
  { type: "report",          label: "Lab Report" },
  { type: "movie",           label: "Movie" },
] as const;

const STATUS_LABELS: Record<string, string> = {
  locked:      "Locked",
  available:   "Available",
  in_progress: "In Progress",
  complete:    "Complete",
  mastery:     "Mastery",
};

const STATUS_BAR_COLORS: Record<string, string> = {
  locked:      "bg-slate-300",
  available:   "bg-cyan-400",
  in_progress: "bg-violet-400",
  complete:    "bg-emerald-400",
  mastery:     "bg-amber-400",
};

// ── Sub-components ────────────────────────────────────────────────────────────

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 text-xs font-medium transition rounded-lg ${
        active
          ? "bg-slate-900 text-white"
          : "text-slate-500 hover:text-slate-800 hover:bg-slate-100"
      }`}
    >
      {children}
    </button>
  );
}

function AssignmentRow({
  assignment,
  editMode,
  onUnlink,
  onClick,
}: {
  assignment: PanelAssignment;
  editMode: boolean;
  onUnlink: () => void;
  onClick?: () => void;
}) {
  const colorCls = TYPE_COLORS[assignment.contentType] ?? "bg-slate-100 text-slate-600";
  const typeLbl = TYPE_LABELS[assignment.contentType] ?? assignment.contentType;
  return (
    <div className="flex items-center gap-2 rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 group">
      <span className={`shrink-0 rounded-lg px-1.5 py-0.5 text-[10px] font-semibold ${colorCls}`}>
        {typeLbl}
      </span>
      <button
        type="button"
        onClick={onClick}
        disabled={!onClick}
        className="flex-1 truncate text-left text-xs text-slate-700 hover:text-cyan-700 hover:underline disabled:no-underline disabled:cursor-default transition-colors"
        title={onClick ? `Open: ${assignment.title}` : undefined}
      >
        {assignment.title}
      </button>
      {editMode ? (
        <button
          type="button"
          onClick={onUnlink}
          className="shrink-0 rounded p-0.5 text-slate-400 hover:text-rose-500"
          title="Unlink"
        >
          ✕
        </button>
      ) : null}
    </div>
  );
}

// ── Prerequisite chain helper ─────────────────────────────────────────────────

/** Walk backwards from nodeId, following one predecessor per step, to build a root→node chain. */
function buildPrereqChain(nodeId: string, nodes: PanelNode[], edges: PanelEdge[]): PanelNode[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const chain: PanelNode[] = [];
  const visited = new Set<string>([nodeId]);
  let current = nodeId;

  for (let i = 0; i < 12; i++) {
    const inEdge = edges.find((e) => e.targetNodeId === current && !visited.has(e.sourceNodeId));
    if (!inEdge) break;
    const parent = nodeMap.get(inEdge.sourceNodeId);
    if (!parent) break;
    chain.unshift(parent);
    visited.add(parent.id);
    current = parent.id;
  }

  return chain;
}

// ── Main Component ────────────────────────────────────────────────────────────

export function NodeSidePanel({
  node,
  progress,
  nodeAssignments,
  allClassAssignments,
  nodes,
  edges,
  editMode,
  isStudent,
  parentPinLength,
  onClose,
  onAssignmentLinked,
  onAssignmentUnlinked,
  onNodeUpdated,
  onDeleteNode,
  onAiGenerateAssignments,
  onMarkComplete,
}: Props) {
  const [activeTab, setActiveTab] = useState<"assignments" | "info" | "edit" | "add">(
    "assignments",
  );
  const [aiGenerating, setAiGenerating] = useState(false);
  const [viewingAssignment, setViewingAssignment] = useState<PanelAssignment | null>(null);

  // Edit tab state
  const [draftTitle, setDraftTitle] = useState(node?.title ?? "");
  const [draftDesc, setDraftDesc] = useState(node?.description ?? "");
  const [draftIcon, setDraftIcon] = useState(node?.icon ?? "");
  const [draftRamp, setDraftRamp] = useState(node?.colorRamp ?? "blue");
  const [draftNodeType, setDraftNodeType] = useState(node?.nodeType ?? "lesson");
  const [draftXp, setDraftXp] = useState(node?.xpReward ?? 100);
  const [draftRequired, setDraftRequired] = useState(node?.isRequired ?? false);

  // Delete zone
  const [showDelete, setShowDelete] = useState(false);
  const [deletePin, setDeletePin] = useState("");

  // Add tab: link existing
  const [linkAssignmentId, setLinkAssignmentId] = useState("");
  // Add tab: create new
  const [quickType, setQuickType] = useState<string | null>(null);
  const [quickTitle, setQuickTitle] = useState("");

  // Reset local draft state when node changes
  const prevNodeId = node?.id;
  if (prevNodeId !== node?.id) {
    // Will reset on next render cycle — handled via key prop on the panel
  }

  if (!node) {
    return (
      <div
        className="absolute bottom-0 right-0 top-0 z-20 flex w-0 items-center justify-center overflow-hidden border-l border-slate-200 bg-white transition-all duration-200"
      />
    );
  }

  const status = progress?.status ?? "locked";
  const nodeColor = RAMP_COLORS[node.colorRamp] ?? RAMP_COLORS.blue;

  // Prereqs: nodes that are SOURCE of incoming edges to this node
  const prereqIds = edges
    .filter((e) => e.targetNodeId === node.id)
    .map((e) => e.sourceNodeId);
  const prereqNodes = nodes.filter((n) => prereqIds.includes(n.id));

  // Unlocks: nodes that are TARGET of outgoing edges from this node
  const unlockIds = edges
    .filter((e) => e.sourceNodeId === node.id)
    .map((e) => e.targetNodeId);
  const unlockNodes = nodes.filter((n) => unlockIds.includes(n.id));

  // Assignments not yet linked
  const linkedIds = new Set(nodeAssignments.map((a) => a.id));
  const unlinkableAssignments = allClassAssignments.filter((a) => !linkedIds.has(a.id));

  const allAssignmentsComplete = nodeAssignments.length > 0 && nodeAssignments.every(() => true); // Actual submission check happens server-side

  const tabs: Array<"assignments" | "info" | "edit" | "add"> = ["assignments", "info"];
  if (editMode) { tabs.push("edit"); tabs.push("add"); }

  function handleSaveNode() {
    if (!node) return;
    onNodeUpdated({
      ...node,
      title: draftTitle.trim() || node.title,
      description: draftDesc.trim() || null,
      icon: draftIcon.trim() || null,
      colorRamp: draftRamp,
      nodeType: draftNodeType,
      xpReward: draftXp,
      isRequired: draftRequired,
      updatedAt: new Date().toISOString(),
    });
  }

  async function handleAiGenerate() {
    if (!node) return;
    setAiGenerating(true);
    try {
      onAiGenerateAssignments(node.id);
    } finally {
      setAiGenerating(false);
    }
  }

  return (
    <>
    <div
      key={node.id}
      className="absolute bottom-0 right-0 top-0 z-20 flex w-[380px] max-w-full flex-col border-l border-slate-200 bg-white shadow-xl transition-transform duration-200"
      style={{ transform: "translateX(0)" }}
    >
      {/* Header */}
      <div className="flex shrink-0 items-start gap-3 border-b border-slate-100 p-4">
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xl"
          style={{ background: nodeColor + "33" }}
        >
          {node.icon ?? node.title.charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="truncate text-sm font-semibold text-slate-900">{node.title}</h3>
            <span
              className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
              style={{ background: nodeColor + "22", color: nodeColor }}
            >
              {node.nodeType}
            </span>
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 border border-amber-200">
              {node.xpReward} XP
            </span>
          </div>

          {/* Progress bar */}
          <div className="mt-2 flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
              <div
                className={`h-full rounded-full transition-all ${STATUS_BAR_COLORS[status] ?? "bg-slate-300"}`}
                style={{
                  width:
                    status === "complete" || status === "mastery"
                      ? "100%"
                      : status === "in_progress"
                      ? "50%"
                      : status === "available"
                      ? "10%"
                      : "0%",
                }}
              />
            </div>
            <span className="shrink-0 text-[10px] text-slate-500">
              {STATUS_LABELS[status] ?? status}
            </span>
            {(progress?.xpEarned ?? 0) > 0 ? (
              <span className="shrink-0 text-[10px] font-medium text-amber-600">
                ⭐ {progress!.xpEarned}
              </span>
            ) : null}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        >
          ✕
        </button>
      </div>

      {/* Tabs */}
      <div className="flex shrink-0 gap-1 border-b border-slate-100 px-3 py-2">
        {tabs.map((tab) => (
          <TabButton
            key={tab}
            active={activeTab === tab}
            onClick={() => setActiveTab(tab)}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </TabButton>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-4">

        {/* ── ASSIGNMENTS TAB ── */}
        {activeTab === "assignments" ? (
          <div className="space-y-3">
            {/* Student locked state: show XP reward but hide assignments */}
            {isStudent && status === "locked" ? (
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-center">
                <div className="flex items-center justify-center gap-2 text-slate-400 mb-3">
                  <svg viewBox="0 0 24 24" fill="none" className="h-8 w-8" aria-hidden="true">
                    <rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" strokeWidth="1.8" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  </svg>
                </div>
                <p className="text-sm font-semibold text-slate-600">Locked</p>
                <p className="mt-1 text-xs text-slate-400">
                  Complete the prerequisites to unlock this area.
                </p>
                <div className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700">
                  ⭐ {node.xpReward} XP waiting
                </div>
                {prereqNodes.length > 0 ? (
                  <div className="mt-3">
                    <p className="mb-1.5 text-xs font-medium text-slate-500">Requires:</p>
                    <div className="flex flex-wrap justify-center gap-1.5">
                      {prereqNodes.map((pn) => (
                        <span
                          key={pn.id}
                          className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-xs text-slate-600"
                        >
                          {pn.title}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <>
                {/* Parent or unlocked student: show prereq hint */}
                {!isStudent && status === "locked" && prereqNodes.length > 0 ? (
                  <div>
                    <p className="mb-2 text-xs font-medium text-slate-500">Requires:</p>
                    <div className="flex flex-wrap gap-1.5">
                      {prereqNodes.map((pn) => (
                        <span
                          key={pn.id}
                          className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-600"
                        >
                          {pn.title}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}

                {nodeAssignments.length === 0 ? (
                  <p className="rounded-xl bg-slate-50 p-4 text-center text-xs text-slate-400">
                    No assignments linked yet.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {nodeAssignments.map((a) => (
                      <AssignmentRow
                        key={a.id}
                        assignment={a}
                        editMode={editMode}
                        onUnlink={() => onAssignmentUnlinked(a.id)}
                        onClick={() => setViewingAssignment(a)}
                      />
                    ))}
                  </div>
                )}

                {/* Student: claim XP */}
                {isStudent && (status === "available" || status === "in_progress") ? (
                  <div className="pt-2">
                    {allAssignmentsComplete ? (
                      <button
                        type="button"
                        onClick={() => onMarkComplete(node.id)}
                        className="w-full rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700"
                      >
                        Claim {node.xpReward} XP ✓
                      </button>
                    ) : null}
                  </div>
                ) : null}

                {/* Complete banner */}
                {status === "complete" || status === "mastery" ? (
                  <div className="flex items-center gap-2 rounded-xl bg-emerald-50 border border-emerald-200 px-3 py-2 text-xs text-emerald-700">
                    <span>✓ Completed · {progress?.xpEarned ?? node.xpReward} XP earned</span>
                  </div>
                ) : null}
              </>
            )}
          </div>
        ) : null}

        {/* ── INFO TAB ── */}
        {activeTab === "info" ? (() => {
          const prereqChain = buildPrereqChain(node.id, nodes, edges);
          return (
            <div className="space-y-4">
              {node.description ? (
                <div>
                  <p className="mb-1 text-xs font-medium text-slate-500">Description</p>
                  <p className="text-sm text-slate-700">{node.description}</p>
                </div>
              ) : null}

              {node.subject ? (
                <div>
                  <p className="mb-1 text-xs font-medium text-slate-500">Subject</p>
                  <p className="text-sm text-slate-700">{node.subject}</p>
                </div>
              ) : null}

              {/* Prerequisite path chain */}
              {prereqChain.length > 0 ? (
                <div>
                  <p className="mb-2 text-xs font-medium text-slate-500">Path to unlock</p>
                  <div className="rounded-xl border border-slate-100 bg-slate-50 p-3">
                    <div className="flex flex-col gap-1">
                      {prereqChain.map((pn, i) => {
                        const color = RAMP_COLORS[pn.colorRamp] ?? RAMP_COLORS.blue;
                        return (
                          <div key={pn.id}>
                            <div className="flex items-center gap-2">
                              <div
                                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white"
                                style={{ background: color }}
                              >
                                {i + 1}
                              </div>
                              <span className="text-xs text-slate-700">{pn.title}</span>
                              <span
                                className="ml-auto rounded-full px-1.5 py-0.5 text-[9px] font-semibold"
                                style={{ background: color + "22", color }}
                              >
                                {pn.nodeType}
                              </span>
                            </div>
                            {/* Connector line */}
                            <div className="ml-2.5 h-3 w-px bg-slate-200" />
                          </div>
                        );
                      })}
                      {/* Current node (destination) */}
                      <div className="flex items-center gap-2">
                        <div
                          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white"
                          style={{ background: RAMP_COLORS[node.colorRamp] ?? RAMP_COLORS.blue }}
                        >
                          ★
                        </div>
                        <span className="text-xs font-semibold text-slate-900">{node.title}</span>
                        <span className="ml-auto text-[10px] font-medium text-amber-600">
                          {node.xpReward} XP
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}

              {prereqNodes.length > 0 ? (
                <div>
                  <p className="mb-1.5 text-xs font-medium text-slate-500">Direct prerequisites</p>
                  <div className="flex flex-wrap gap-1.5">
                    {prereqNodes.map((pn) => (
                      <span
                        key={pn.id}
                        className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-600"
                      >
                        {pn.title}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}

              {unlockNodes.length > 0 ? (
                <div>
                  <p className="mb-1.5 text-xs font-medium text-slate-500">Unlocks</p>
                  <div className="flex flex-wrap gap-1.5">
                    {unlockNodes.map((un) => (
                      <span
                        key={un.id}
                        className="rounded-full border border-cyan-200 bg-cyan-50 px-2.5 py-1 text-xs text-cyan-700"
                      >
                        {un.title}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}

              <div>
                <p className="mb-1 text-xs font-medium text-slate-500">XP Reward</p>
                <p className="text-sm font-medium text-amber-600">⭐ {node.xpReward} XP</p>
              </div>
            </div>
          );
        })() : null}

        {/* ── EDIT TAB ── */}
        {activeTab === "edit" && editMode ? (
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Title</label>
              <input
                type="text"
                value={draftTitle || node.title}
                onChange={(e) => setDraftTitle(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Icon (emoji)</label>
              <input
                type="text"
                value={draftIcon || node.icon || ""}
                onChange={(e) => setDraftIcon(e.target.value)}
                placeholder="🔬"
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-600">Color</label>
              <div className="flex gap-2">
                {RAMP_LIST.map((ramp) => (
                  <button
                    key={ramp}
                    type="button"
                    title={ramp}
                    onClick={() => setDraftRamp(ramp)}
                    className={`h-7 w-7 rounded-full border-2 transition ${
                      (draftRamp || node.colorRamp) === ramp
                        ? "border-slate-900 scale-110"
                        : "border-transparent hover:scale-105"
                    }`}
                    style={{ background: RAMP_COLORS[ramp] }}
                  />
                ))}
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-600">Type</label>
              <div className="flex flex-wrap gap-1.5">
                {NODE_TYPES.map((nt) => (
                  <button
                    key={nt}
                    type="button"
                    onClick={() => setDraftNodeType(nt)}
                    className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                      (draftNodeType || node.nodeType) === nt
                        ? "bg-slate-900 text-white"
                        : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    {nt}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">XP Reward</label>
              <input
                type="number"
                min={0}
                max={1000}
                value={draftXp ?? node.xpReward}
                onChange={(e) => setDraftXp(Number(e.target.value))}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none"
              />
            </div>

            <div className="flex items-center gap-2">
              <input
                id="is-required"
                type="checkbox"
                checked={draftRequired ?? node.isRequired}
                onChange={(e) => setDraftRequired(e.target.checked)}
                className="h-4 w-4 rounded"
              />
              <label htmlFor="is-required" className="text-xs text-slate-600">
                Required node
              </label>
            </div>

            <button
              type="button"
              onClick={handleSaveNode}
              className="w-full rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
            >
              Save node changes
            </button>

            {/* Danger zone */}
            <div className="border-t border-slate-100 pt-4">
              <p className="mb-2 text-xs font-semibold text-rose-500">Danger Zone</p>
              {showDelete ? (
                <div className="space-y-2">
                  <input
                    type="password"
                    inputMode="numeric"
                    value={deletePin}
                    onChange={(e) =>
                      setDeletePin(e.target.value.replace(/\D/g, "").slice(0, 6))
                    }
                    placeholder={`Parent PIN (${parentPinLength ?? 4}–6 digits)`}
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-rose-400 focus:outline-none"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => { setShowDelete(false); setDeletePin(""); }}
                      className="flex-1 rounded-xl border border-slate-200 px-3 py-2 text-xs text-slate-600 hover:bg-slate-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={deletePin.length < 4}
                      onClick={() => {
                        onDeleteNode(node.id, deletePin);
                        setShowDelete(false);
                        setDeletePin("");
                      }}
                      className="flex-1 rounded-xl bg-rose-600 px-3 py-2 text-xs font-medium text-white hover:bg-rose-700 disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowDelete(true)}
                  className="w-full rounded-xl border border-rose-200 px-4 py-2 text-sm text-rose-600 hover:bg-rose-50"
                >
                  Delete this node
                </button>
              )}
            </div>
          </div>
        ) : null}

        {/* ── ADD TAB ── */}
        {activeTab === "add" && editMode ? (
          <div className="space-y-5">
            {/* Link existing */}
            <div>
              <p className="mb-2 text-xs font-semibold text-slate-700">Link existing assignment</p>
              {unlinkableAssignments.length === 0 ? (
                <p className="text-xs text-slate-400">All assignments are already linked.</p>
              ) : (
                <div className="flex gap-2">
                  <select
                    value={linkAssignmentId}
                    onChange={(e) => setLinkAssignmentId(e.target.value)}
                    className="flex-1 rounded-xl border border-slate-300 bg-white px-2 py-1.5 text-xs focus:outline-none"
                  >
                    <option value="">— select —</option>
                    {unlinkableAssignments.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.title}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={!linkAssignmentId}
                    onClick={() => {
                      if (linkAssignmentId) {
                        onAssignmentLinked(linkAssignmentId);
                        setLinkAssignmentId("");
                      }
                    }}
                    className="rounded-xl bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                  >
                    Link
                  </button>
                </div>
              )}
            </div>

            {/* Create new */}
            <div>
              <p className="mb-2 text-xs font-semibold text-slate-700">Create new assignment</p>
              <div className="flex flex-wrap gap-1.5 mb-3">
                {QUICK_TYPES.map(({ type, label }) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => { setQuickType(type); setQuickTitle(""); }}
                    className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                      quickType === type
                        ? "bg-cyan-600 text-white"
                        : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {quickType ? (
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={quickTitle}
                    onChange={(e) => setQuickTitle(e.target.value)}
                    placeholder={`${TYPE_LABELS[quickType] ?? quickType} title…`}
                    className="flex-1 rounded-xl border border-slate-300 px-3 py-1.5 text-xs focus:border-cyan-500 focus:outline-none"
                  />
                  <button
                    type="button"
                    disabled={!quickTitle.trim()}
                    onClick={() => {
                      // Parent handles actual creation via onAssignmentLinked with a synthetic id
                      // For now emit a placeholder — the route creates and links via server fn
                      setQuickTitle("");
                      setQuickType(null);
                    }}
                    className="rounded-xl bg-cyan-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-cyan-700 disabled:opacity-50"
                  >
                    Create &amp; Link
                  </button>
                </div>
              ) : null}
            </div>

            {/* AI generate */}
            <div className="border-t border-slate-100 pt-4">
              <button
                type="button"
                disabled={aiGenerating}
                onClick={() => void handleAiGenerate()}
                className="w-full rounded-xl bg-cyan-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-60"
              >
                {aiGenerating ? "Generating…" : "✦ AI generate assignments for this node"}
              </button>
              {aiGenerating ? (
                <p className="mt-2 text-center text-xs text-cyan-600 animate-pulse">
                  Generating suggestions…
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>

    {/* Assignment view/edit modal */}
    {viewingAssignment ? (
      <AssignmentModal
        assignment={viewingAssignment as ModalAssignment}
        allAssignments={allClassAssignments as ModalAssignment[]}
        canEdit={!isStudent}
        onClose={() => setViewingAssignment(null)}
        onSaved={(updated) => {
          setViewingAssignment(updated as PanelAssignment);
        }}
      />
    ) : null}
    </>
  );
}

