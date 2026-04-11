import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import {
  autoLayoutSkillTree,
  aiExpandSkillTree,
  aiGenerateNodeAssignments,
  deleteSkillTreeEdge,
  deleteSkillTreeNode,
  getSkillTreeData,
  getViewerContext,
  linkAssignmentToNode,
  markNodeComplete,
  populateWebNodeContent,
  saveTreeViewport,
  unlinkAssignmentFromNode,
  updateNodePositions,
  upsertSkillTreeEdge,
  upsertSkillTreeNode,
} from "../server/functions";
import { EdgeLayer } from "../components/skill-tree/EdgeLayer";
import { NodeLayer } from "../components/skill-tree/NodeLayer";
import { NodeSidePanel } from "../components/skill-tree/NodeSidePanel";
import { SkillTreeMinimap } from "../components/skill-tree/SkillTreeMinimap";

// ── Route ─────────────────────────────────────────────────────────────────────

export const Route = createFileRoute("/skill-tree/$treeId")({
  loader: async ({ params }) => {
    const viewer = await getViewerContext();

    if (!viewer.isAuthenticated) {
      throw redirect({ to: "/login" });
    }

    const treeData = await getSkillTreeData({
      data: { treeId: params.treeId, profileId: viewer.profileId ?? undefined },
    });

    return {
      treeData,
      isStudent: viewer.activeRole === "student",
      isParent: viewer.activeRole !== "student",
      profileId: viewer.profileId ?? null,
    };
  },
  component: SkillTreePage,
});

// ── Types ─────────────────────────────────────────────────────────────────────

type LoaderData = Awaited<ReturnType<typeof Route.useLoaderData>>;
type TreeNode = LoaderData["treeData"]["nodes"][number];
type TreeEdge = LoaderData["treeData"]["edges"][number];
type NodeProgress = LoaderData["treeData"]["nodeProgress"][number];
type NodeAssignment = LoaderData["treeData"]["nodeAssignments"][number];
type Assignment = NodeAssignment["assignments"][number];

type Viewport = { x: number; y: number; scale: number };

// ── Status / legend constants ─────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  locked:      "#d3d1c7",
  available:   "#378add",
  in_progress: "#7f77dd",
  complete:    "#1d9e75",
  mastery:     "#ef9f27",
};

const STATUS_LABELS: Record<string, string> = {
  locked:      "Locked",
  available:   "Available",
  in_progress: "In Progress",
  complete:    "Complete",
  mastery:     "Mastery",
};

const TOOLBAR_TOOLTIPS = {
  deleteEdge: "Delete the selected dependency road between two nodes.",
  savePositions: "Save the node positions after dragging them into place.",
  autoLayout: "Reflow the map using a hierarchical tree layout — no edge crossings, clean branching structure.",
  addNode: "Add a new node at the center of the current view.",
  connect: "Turn on connection mode, then click one node and another to create a dependency road.",
  connectActive: "Exit connection mode.",
  expand: "Use AI to grow a small related branch from an existing node.",
  autoPopulate: "Fill empty nodes with AI-generated assignments and learning content.",
  autoPopulateDone: "All nodes already have linked content.",
  editMode: "Turn on builder controls so you can move nodes, connect them, and add new ones.",
  editModeActive: "Leave builder mode and return to normal viewing.",
  addFirstNode: "Create the first node in this empty skill map.",
} as const;

// ── Zoom controls ─────────────────────────────────────────────────────────────

function ZoomControls({
  viewport,
  onSetViewport,
}: {
  viewport: Viewport;
  onSetViewport: (v: Viewport) => void;
}) {
  return (
    <div className="absolute right-3 top-3 z-10 flex flex-col gap-1">
      <button
        type="button"
        title="Zoom in"
        onClick={() => onSetViewport({ ...viewport, scale: Math.min(3, viewport.scale * 1.2) })}
        className="skill-map-overlay-panel flex h-8 w-8 items-center justify-center rounded-xl text-sm font-bold text-slate-700 transition hover:-translate-y-0.5"
      >
        +
      </button>
      <button
        type="button"
        title="Zoom out"
        onClick={() => onSetViewport({ ...viewport, scale: Math.max(0.2, viewport.scale / 1.2) })}
        className="skill-map-overlay-panel flex h-8 w-8 items-center justify-center rounded-xl text-sm font-bold text-slate-700 transition hover:-translate-y-0.5"
      >
        −
      </button>
      <button
        type="button"
        title="Reset zoom"
        onClick={() => onSetViewport({ x: 0, y: 0, scale: 1 })}
        className="skill-map-overlay-panel flex h-8 w-8 items-center justify-center rounded-xl text-xs text-slate-700 transition hover:-translate-y-0.5"
      >
        ⊡
      </button>
    </div>
  );
}

// ── Legend ────────────────────────────────────────────────────────────────────

function Legend() {
  return (
    <div className="skill-map-overlay-panel absolute bottom-4 left-3 z-10 rounded-xl px-3 py-2">
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {Object.entries(STATUS_LABELS).map(([key, label]) => (
          <div key={key} className="flex items-center gap-1.5">
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ background: STATUS_COLORS[key] }}
            />
            <span className="text-xs text-slate-500">{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── AI Expand Panel ───────────────────────────────────────────────────────────

function AiExpandPanel({
  nodes,
  treeId,
  onExpanded,
  onClose,
}: {
  nodes: TreeNode[];
  treeId: string;
  onExpanded: (newNodes: TreeNode[], newEdges: TreeEdge[]) => void;
  onClose: () => void;
}) {
  const [fromNodeId, setFromNodeId] = useState(nodes[0]?.id ?? "");
  const [nodeCount, setNodeCount] = useState(4);
  const [focusArea, setFocusArea] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="skill-map-overlay-panel absolute left-3 right-3 top-3 z-10 rounded-2xl p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-semibold text-slate-800">✦ AI Expand from Node</p>
        <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700">
          ✕
        </button>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="mb-1 block text-xs text-slate-500">From node</label>
          <select
            value={fromNodeId}
            onChange={(e) => setFromNodeId(e.target.value)}
            disabled={loading}
            className="rounded-xl border border-[rgba(90,139,184,0.35)] bg-white/85 px-2 py-1.5 text-xs text-slate-800 focus:outline-none"
          >
            {nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.title}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-slate-500">Count</label>
          <input
            type="number"
            min={1}
            max={6}
            value={nodeCount}
            onChange={(e) => setNodeCount(Math.min(6, Math.max(1, Number(e.target.value))))}
            disabled={loading}
            className="w-16 rounded-xl border border-[rgba(90,139,184,0.35)] bg-white/85 px-2 py-1.5 text-center text-xs focus:outline-none"
          />
        </div>
        <div className="min-w-[140px] flex-1">
          <label className="mb-1 block text-xs text-slate-500">Focus area (optional)</label>
          <input
            type="text"
            value={focusArea}
            onChange={(e) => setFocusArea(e.target.value)}
            disabled={loading}
            placeholder="e.g. Experiments"
            className="w-full rounded-xl border border-[rgba(90,139,184,0.35)] bg-white/85 px-2 py-1.5 text-xs focus:outline-none"
          />
        </div>
        <button
          type="button"
          disabled={loading || !fromNodeId}
          onClick={async () => {
            setLoading(true);
            setError(null);
            try {
              const result = await aiExpandSkillTree({
                data: { treeId, fromNodeId, nodeCount, focusArea: focusArea.trim() || undefined },
              });
              onExpanded(result.newNodes as TreeNode[], result.newEdges as TreeEdge[]);
              onClose();
            } catch {
              setError("AI expansion failed. Try again.");
            } finally {
              setLoading(false);
            }
          }}
          className="rounded-xl bg-cyan-700 px-4 py-2 text-xs font-medium text-white hover:bg-cyan-800 disabled:opacity-50"
        >
          {loading ? "Generating…" : "✦ Generate"}
        </button>
      </div>
      {error ? <p className="mt-2 text-xs text-rose-600">{error}</p> : null}
    </div>
  );
}

// ── Auto-Populate Progress Panel ──────────────────────────────────────────────

type PopulatePhase = "running" | "done" | "cancelled";

type PopulateState = {
  phase: PopulatePhase;
  total: number;
  completed: number;
  failed: number;
  currentTitle: string;
};

function PopulateProgressPanel({
  state,
  onCancel,
  onDismiss,
}: {
  state: PopulateState;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  const pct = state.total > 0 ? Math.round((state.completed / state.total) * 100) : 0;
  const succeeded = state.completed - state.failed;

  return (
    <div className="skill-map-overlay-panel absolute left-3 right-3 top-3 z-20 rounded-2xl p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {state.phase === "running" && (
            <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-cyan-500 border-t-transparent" />
          )}
          <p className="text-sm font-semibold text-slate-800">
            {state.phase === "running"
              ? "Auto-populating nodes…"
              : state.phase === "done"
                ? `Done — ${succeeded} node${succeeded !== 1 ? "s" : ""} populated`
                : `Cancelled — ${succeeded} node${succeeded !== 1 ? "s" : ""} populated`}
          </p>
        </div>
        {state.phase !== "running" ? (
          <button
            type="button"
            onClick={onDismiss}
            className="text-xs text-slate-400 hover:text-slate-700"
          >
            ✕ Dismiss
          </button>
        ) : null}
      </div>

      {/* Progress bar */}
      <div className="mb-2 h-2 w-full overflow-hidden rounded-full bg-slate-100">
        <div
          className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-cyan-600 transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
        <span>
          {state.completed} / {state.total} nodes
          {state.failed > 0 ? (
            <span className="ml-1.5 text-amber-600">({state.failed} skipped)</span>
          ) : null}
        </span>
        {state.phase === "running" ? (
          <span className="max-w-[55%] truncate italic">
            {state.currentTitle ? `Processing: ${state.currentTitle}` : "Starting…"}
          </span>
        ) : null}
        {state.phase === "running" ? (
          <button
            type="button"
            onClick={onCancel}
            className="shrink-0 rounded-lg border border-rose-200 px-2.5 py-1 text-xs font-medium text-rose-600 hover:bg-rose-50"
          >
            Cancel
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

function SkillTreePage() {
  const { treeData, isStudent, isParent, profileId } = Route.useLoaderData();

  // ── Core state ──────────────────────────────────────────────────────────────
  const [nodes, setNodes] = useState<TreeNode[]>(treeData.nodes);
  const [edges, setEdges] = useState<TreeEdge[]>(treeData.edges);
  const [nodeAssignmentsMap, setNodeAssignmentsMap] = useState<Map<string, Assignment[]>>(
    () =>
      new Map(
        treeData.nodeAssignments.map((na: NodeAssignment) => [na.nodeId, na.assignments]),
      ),
  );
  const [progressMap, setProgressMap] = useState<Map<string, NodeProgress>>(
    () => new Map(treeData.nodeProgress.map((p) => [p.nodeId, p])),
  );
  const [viewport, setViewport] = useState<Viewport>({
    x: treeData.tree.viewportX,
    y: treeData.tree.viewportY,
    scale: treeData.tree.viewportScale / 100,
  });

  // ── Interaction state ────────────────────────────────────────────────────────
  const [editMode, setEditMode] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [sidePanelInitialTab, setSidePanelInitialTab] = useState<"assignments" | "info" | "edit" | "add" | undefined>(undefined);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [connectMode, setConnectMode] = useState(false);
  const [connectingFromId, setConnectingFromId] = useState<string | null>(null);
  const [rubberBandEnd, setRubberBandEnd] = useState<{ x: number; y: number } | null>(null);
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [hasUnsavedPositions, setHasUnsavedPositions] = useState(false);
  const [aiExpandOpen, setAiExpandOpen] = useState(false);
  const [newlyAddedNodeIds, setNewlyAddedNodeIds] = useState<Set<string>>(new Set());
  const [xpToast, setXpToast] = useState<{ x: number; y: number; xp: number } | null>(null);
  const [unlockToast, setUnlockToast] = useState<string | null>(null);
  const [rewardUnlockBanner, setRewardUnlockBanner] = useState<{ tierTitle: string } | null>(null);
  const [autoLayouting, setAutoLayouting] = useState(false);

  const [populateState, setPopulateState] = useState<PopulateState | null>(null);

  // ── Refs ─────────────────────────────────────────────────────────────────────
  const [canvasSize, setCanvasSize] = useState({ w: 900, h: 600 });
  const canvasRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const isPanning = useRef(false);
  const lastPanPos = useRef({ x: 0, y: 0 });
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const cancelPopulateRef = useRef(false);

  // ── Measure canvas ───────────────────────────────────────────────────────────
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      const e = entries[0];
      if (e) setCanvasSize({ w: e.contentRect.width, h: e.contentRect.height });
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // ── Auto-layout on first load if nodes are not meaningfully spread ───────────
  // Detects when stored positions are at origin / collapsed (newly generated tree
  // or tree whose positions were never saved) and runs a silent auto-layout so
  // the tree is immediately visible in both parent and student views.
  useEffect(() => {
    if (treeData.nodes.length < 2) return;
    const xs = treeData.nodes.map((n) => n.positionX);
    const ys = treeData.nodes.map((n) => n.positionY);
    const spreadX = Math.max(...xs) - Math.min(...xs);
    const spreadY = Math.max(...ys) - Math.min(...ys);
    // If all nodes are within a 60px square (effectively stacked/un-laid-out)
    if (spreadX < 60 && spreadY < 60) {
      void handleAutoLayout();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Debounced viewport save ──────────────────────────────────────────────────
  const saveViewportTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (saveViewportTimer.current) clearTimeout(saveViewportTimer.current);
    saveViewportTimer.current = setTimeout(() => {
      void saveTreeViewport({
        data: {
          treeId: treeData.tree.id,
          viewportX: Math.round(viewport.x),
          viewportY: Math.round(viewport.y),
          viewportScale: viewport.scale,
        },
      });
    }, 1500);
    return () => {
      if (saveViewportTimer.current) clearTimeout(saveViewportTimer.current);
    };
  }, [viewport, treeData.tree.id]);

  // ── Rubber-band tracking in connect mode ────────────────────────────────────
  useEffect(() => {
    if (!connectMode || !connectingFromId) {
      setRubberBandEnd(null);
      return;
    }
    function onMove(e: MouseEvent) {
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const v = viewportRef.current;
      const worldX = (e.clientX - rect.left - v.x) / v.scale;
      const worldY = (e.clientY - rect.top - v.y) / v.scale;
      setRubberBandEnd({ x: worldX, y: worldY });
    }
    document.addEventListener("mousemove", onMove);
    return () => document.removeEventListener("mousemove", onMove);
  }, [connectMode, connectingFromId]);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────────
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Ignore when typing in an input/textarea/select
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (e.key === "Escape") {
        if (connectMode) {
          setConnectMode(false);
          setConnectingFromId(null);
          setRubberBandEnd(null);
        }
        if (selectedNodeId) setSelectedNodeId(null);
        if (selectedEdgeId) setSelectedEdgeId(null);
        return;
      }

      if (!isParent) return; // Shortcuts below are parent-only

      if (e.key === "e" || e.key === "E") {
        setEditMode((v) => !v);
        setConnectMode(false);
        setConnectingFromId(null);
        setRubberBandEnd(null);
        setAiExpandOpen(false);
        setSelectedEdgeId(null);
        return;
      }

      if ((e.key === "c" || e.key === "C") && editMode) {
        setConnectMode((v) => !v);
        setConnectingFromId(null);
        setRubberBandEnd(null);
        return;
      }

      if ((e.key === "n" || e.key === "N") && editMode) {
        void handleAddNode();
        return;
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [connectMode, selectedNodeId, selectedEdgeId, editMode, isParent]);

  // ── Pan & node drag ──────────────────────────────────────────────────────────
  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (draggingNodeId) {
        const v = viewportRef.current;
        const svg = svgRef.current;
        if (!svg) return;
        const rect = svg.getBoundingClientRect();
        const worldX = (e.clientX - rect.left - v.x) / v.scale;
        const worldY = (e.clientY - rect.top - v.y) / v.scale;
        // dragOffset stores the offset from node centre in world coords
        setNodes((prev) =>
          prev.map((n) =>
            n.id === draggingNodeId
              ? {
                  ...n,
                  positionX: Math.round(worldX - dragOffset.x),
                  positionY: Math.round(worldY - dragOffset.y),
                }
              : n,
          ),
        );
        setHasUnsavedPositions(true);
        return;
      }
      if (isPanning.current) {
        const dx = e.clientX - lastPanPos.current.x;
        const dy = e.clientY - lastPanPos.current.y;
        lastPanPos.current = { x: e.clientX, y: e.clientY };
        setViewport((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
      }
    }
    function onMouseUp() {
      if (draggingNodeId) setDraggingNodeId(null);
      isPanning.current = false;
    }
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, [draggingNodeId, dragOffset]);

  // ── Wheel zoom ───────────────────────────────────────────────────────────────
  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY > 0 ? 0.92 : 1.08;
    setViewport((v) => {
      const newScale = Math.min(3, Math.max(0.2, v.scale * factor));
      return {
        scale: newScale,
        x: mx - (mx - v.x) * (newScale / v.scale),
        y: my - (my - v.y) * (newScale / v.scale),
      };
    });
  }, []);

  // ── Canvas mouse down (pan start) ────────────────────────────────────────────
  function handleCanvasMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    const target = e.target as Element;
    const isBackground =
      target === svgRef.current ||
      target.id === "world" ||
      target.tagName === "svg";
    if (isBackground && !draggingNodeId) {
      isPanning.current = true;
      lastPanPos.current = { x: e.clientX, y: e.clientY };
      // Deselect on background click
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
    }
  }

  // ── Node click ───────────────────────────────────────────────────────────────
  function handleNodeClick(nodeId: string) {
    if (connectMode) {
      if (!connectingFromId) {
        setConnectingFromId(nodeId);
        return;
      }
      if (connectingFromId === nodeId) {
        setConnectingFromId(null);
        return;
      }
      void upsertSkillTreeEdge({
        data: {
          treeId: treeData.tree.id,
          sourceNodeId: connectingFromId,
          targetNodeId: nodeId,
          edgeType: "required",
        },
      }).then((edge) => {
        setEdges((prev) => {
          if (prev.some((ex) => ex.id === edge.id)) return prev;
          return [...prev, edge as TreeEdge];
        });
      });
      setConnectingFromId(null);
      setRubberBandEnd(null);
      return;
    }
    setSelectedEdgeId(null);
    setSelectedNodeId((prev) => (prev === nodeId ? null : nodeId));
  }

  function handleNodeDoubleClick(nodeId: string) {
    setSelectedEdgeId(null);
    setSelectedNodeId(nodeId);
    setSidePanelInitialTab(editMode ? "edit" : "info");
  }

  // ── Edge click ────────────────────────────────────────────────────────────────
  function handleEdgeClick(edgeId: string) {
    if (!editMode) return;
    setSelectedEdgeId((prev) => (prev === edgeId ? null : edgeId));
    setSelectedNodeId(null);
  }

  // ── Node drag start ──────────────────────────────────────────────────────────
  function handleNodeDragStart(nodeId: string, e: React.MouseEvent) {
    if (!editMode || connectMode) return;
    e.stopPropagation();
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const v = viewportRef.current;
    // compute offset in world coords between pointer and node centre
    const worldMouseX = (e.clientX - rect.left - v.x) / v.scale;
    const worldMouseY = (e.clientY - rect.top - v.y) / v.scale;
    setDragOffset({ x: worldMouseX - node.positionX, y: worldMouseY - node.positionY });
    setDraggingNodeId(nodeId);
  }

  // ── Save positions ───────────────────────────────────────────────────────────
  async function handleSavePositions() {
    await updateNodePositions({
      data: {
        updates: nodes.map((n) => ({
          nodeId: n.id,
          positionX: n.positionX,
          positionY: n.positionY,
        })),
      },
    });
    setHasUnsavedPositions(false);
  }

  async function handleAutoLayout() {
    setAutoLayouting(true);
    try {
      const result = await autoLayoutSkillTree({
        data: { treeId: treeData.tree.id },
      });
      setNodes(result.nodes as TreeNode[]);
      setEdges(result.edges as TreeEdge[]);
      if (Array.isArray(result.nodeProgress)) {
        setProgressMap(new Map((result.nodeProgress as NodeProgress[]).map((p) => [p.nodeId, p])));
      }
      setHasUnsavedPositions(false);
      setSelectedEdgeId(null);
    } finally {
      setAutoLayouting(false);
    }
  }

  // ── Add node ─────────────────────────────────────────────────────────────────
  async function handleAddNode() {
    const newNode = await upsertSkillTreeNode({
      data: {
        treeId: treeData.tree.id,
        title: "New Node",
        positionX: Math.round((-viewport.x + canvasSize.w / 2) / viewport.scale),
        positionY: Math.round((-viewport.y + canvasSize.h / 2) / viewport.scale),
      },
    });
    setNodes((prev) => [...prev, newNode as TreeNode]);
    setSelectedNodeId(newNode.id);
  }

  // ── Delete edge ──────────────────────────────────────────────────────────────
  async function handleDeleteEdge(edgeId: string) {
    await deleteSkillTreeEdge({ data: { edgeId } });
    setEdges((prev) => prev.filter((e) => e.id !== edgeId));
    setSelectedEdgeId(null);
  }

  // ── Node panel callbacks ─────────────────────────────────────────────────────
  async function handleNodeUpdated(updated: TreeNode) {
    const result = await upsertSkillTreeNode({
      data: {
        treeId: treeData.tree.id,
        nodeId: updated.id,
        title: updated.title,
        description: updated.description ?? undefined,
        icon: updated.icon ?? undefined,
        colorRamp: updated.colorRamp,
        nodeType: updated.nodeType as "lesson" | "milestone" | "boss" | "branch" | "elective",
        xpReward: updated.xpReward,
        isRequired: updated.isRequired,
      },
    });
    setNodes((prev) => prev.map((n) => (n.id === updated.id ? (result as TreeNode) : n)));
  }

  async function handleDeleteNode(nodeId: string, pin: string) {
    await deleteSkillTreeNode({ data: { nodeId, parentPin: pin } });
    setNodes((prev) => prev.filter((n) => n.id !== nodeId));
    setEdges((prev) =>
      prev.filter((e) => e.sourceNodeId !== nodeId && e.targetNodeId !== nodeId),
    );
    setSelectedNodeId(null);
  }

  async function handleAssignmentLinked(assignmentId: string) {
    if (!selectedNodeId) return;
    await linkAssignmentToNode({ data: { nodeId: selectedNodeId, assignmentId } });
    // Add to local state
    const allAssignments = treeData.nodeAssignments.flatMap((na: NodeAssignment) => na.assignments);
    const assignment = allAssignments.find((a: Assignment) => a.id === assignmentId);
    if (!assignment) return;
    setNodeAssignmentsMap((prev) => {
      const next = new Map(prev);
      const existing = next.get(selectedNodeId) ?? [];
      next.set(selectedNodeId, [...existing, assignment]);
      return next;
    });
  }

  async function handleAssignmentUnlinked(assignmentId: string) {
    if (!selectedNodeId) return;
    await unlinkAssignmentFromNode({ data: { nodeId: selectedNodeId, assignmentId } });
    setNodeAssignmentsMap((prev) => {
      const next = new Map(prev);
      const existing = next.get(selectedNodeId) ?? [];
      next.set(selectedNodeId, existing.filter((a) => a.id !== assignmentId));
      return next;
    });
  }

  async function handleAiGenerateAssignments(nodeId: string) {
    if (!treeData.tree.classId) return;
    const result = await aiGenerateNodeAssignments({
      data: { nodeId, classId: treeData.tree.classId },
    });
    setNodeAssignmentsMap((prev) => {
      const next = new Map(prev);
      const existing = next.get(nodeId) ?? [];
      next.set(nodeId, [...existing, ...(result.assignments as Assignment[])]);
      return next;
    });
  }

  function handleMarkComplete(nodeId: string) {
    void markNodeComplete({ data: { nodeId, profileId: profileId ?? "" } }).then((result) => {
      const completedNode = nodes.find((n) => n.id === nodeId);
      const xpEarned = result.xpEarned ?? completedNode?.xpReward ?? 0;

      // Show XP toast at node's screen position
      if (completedNode) {
        const screenX = completedNode.positionX * viewport.scale + viewport.x;
        const screenY = completedNode.positionY * viewport.scale + viewport.y;
        setXpToast({ x: screenX, y: screenY - 20, xp: xpEarned });
        setTimeout(() => setXpToast(null), 1600);
      }

      // Show unlock toast
      if (result.unlockedNodeIds.length > 0) {
        const count = result.unlockedNodeIds.length;
        setUnlockToast(`🔓 ${count} new area${count > 1 ? "s" : ""} unlocked!`);
        setTimeout(() => setUnlockToast(null), 2500);
      }

      // Show reward unlock banner
      if ((result.newlyUnlockedRewardTierIds?.length ?? 0) > 0) {
        const count = result.newlyUnlockedRewardTierIds!.length;
        setRewardUnlockBanner({ tierTitle: count === 1 ? "a new reward" : `${count} new rewards` });
        setTimeout(() => setRewardUnlockBanner(null), 4000);
      }

      // Update progress map
      setProgressMap((prev) => {
        const next = new Map(prev);
        const existing = next.get(nodeId);
        next.set(nodeId, {
          ...(existing ?? {
            id: "",
            nodeId,
            profileId: profileId ?? "",
            treeId: treeData.tree.id,
            masteryAt: null,
          }),
          status: "complete" as const,
          xpEarned,
          completedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as NodeProgress);
        // Mark newly unlocked nodes as available
        for (const unlockedId of result.unlockedNodeIds) {
          const unlocked = next.get(unlockedId);
          if (!unlocked || unlocked.status === "locked") {
            next.set(unlockedId, {
              ...(unlocked ?? {
                id: "",
                nodeId: unlockedId,
                profileId: profileId ?? "",
                treeId: treeData.tree.id,
                masteryAt: null,
                completedAt: null,
              }),
              status: "available" as const,
              xpEarned: 0,
              updatedAt: new Date().toISOString(),
            } as NodeProgress);
          }
        }
        return next;
      });
    });
  }

  // ── Auto-populate batch handler ──────────────────────────────────────────────
  async function handleAutoPopulate() {
    const classId = treeData.tree.classId;
    if (!classId) return;

    // Only process nodes that currently have 0 assignments, prioritise core path
    const unpopulated = [...nodes]
      .filter((n) => (nodeAssignmentsMap.get(n.id) ?? []).length === 0)
      .sort((a, b) => {
        // milestones + lessons first so the spine gets content first
        const order: Record<string, number> = { milestone: 0, lesson: 1, boss: 2, elective: 3, branch: 4 };
        return (order[a.nodeType] ?? 5) - (order[b.nodeType] ?? 5);
      });

    if (unpopulated.length === 0) return;

    cancelPopulateRef.current = false;
    setPopulateState({
      phase: "running",
      total: unpopulated.length,
      completed: 0,
      failed: 0,
      currentTitle: "",
    });

    for (const node of unpopulated) {
      if (cancelPopulateRef.current) {
        setPopulateState((prev) =>
          prev ? { ...prev, phase: "cancelled" } : null,
        );
        return;
      }

      setPopulateState((prev) =>
        prev ? { ...prev, currentTitle: node.title } : null,
      );

      try {
        const result = await populateWebNodeContent({
          data: { nodeId: node.id, classId },
        });
        setNodeAssignmentsMap((prev) => {
          const next = new Map(prev);
          const existing = next.get(node.id) ?? [];
          next.set(node.id, [...existing, ...(result.assignments as Assignment[])]);
          return next;
        });
        setPopulateState((prev) =>
          prev ? { ...prev, completed: prev.completed + 1 } : null,
        );
      } catch {
        setPopulateState((prev) =>
          prev
            ? { ...prev, completed: prev.completed + 1, failed: prev.failed + 1 }
            : null,
        );
      }
    }

    setPopulateState((prev) => (prev ? { ...prev, phase: "done" } : null));
  }

  // ── Derived values ────────────────────────────────────────────────────────────
  const selectedNode = selectedNodeId
    ? (nodes.find((n) => n.id === selectedNodeId) ?? null)
    : null;

  // BFS backwards from selectedNodeId to find all ancestor nodes + edges (for path highlighting)
  const { highlightedNodeIds, highlightedEdgeIds } = useMemo(() => {
    if (!selectedNodeId) {
      return { highlightedNodeIds: new Set<string>(), highlightedEdgeIds: new Set<string>() };
    }
    const nodeSet = new Set<string>([selectedNodeId]);
    const edgeSet = new Set<string>();
    const queue = [selectedNodeId];
    while (queue.length > 0) {
      const curr = queue.shift()!;
      for (const edge of edges) {
        if (edge.targetNodeId === curr && !nodeSet.has(edge.sourceNodeId)) {
          nodeSet.add(edge.sourceNodeId);
          edgeSet.add(edge.id);
          queue.push(edge.sourceNodeId);
        }
      }
    }
    return { highlightedNodeIds: nodeSet, highlightedEdgeIds: edgeSet };
  }, [selectedNodeId, edges]);

  const dimmedNodeIds = useMemo(() => {
    if (highlightedNodeIds.size === 0) return new Set<string>();
    return new Set(nodes.filter((n) => !highlightedNodeIds.has(n.id)).map((n) => n.id));
  }, [highlightedNodeIds, nodes]);

  // Fork nodes = sources of "fork"-type edges (decision points)
  const forkNodeIds = useMemo(() => {
    const set = new Set<string>();
    for (const edge of edges) {
      if (edge.edgeType === "fork") set.add(edge.sourceNodeId);
    }
    return set;
  }, [edges]);

  const { startNodeIds, endNodeIds } = useMemo(() => {
    const incoming = new Map(nodes.map((node) => [node.id, 0]));
    const outgoing = new Map(nodes.map((node) => [node.id, 0]));

    for (const edge of edges) {
      outgoing.set(edge.sourceNodeId, (outgoing.get(edge.sourceNodeId) ?? 0) + 1);
      incoming.set(edge.targetNodeId, (incoming.get(edge.targetNodeId) ?? 0) + 1);
    }

    return {
      startNodeIds: new Set(
        nodes
          .filter((node) => (incoming.get(node.id) ?? 0) === 0)
          .map((node) => node.id),
      ),
      endNodeIds: new Set(
        nodes
          .filter((node) => (outgoing.get(node.id) ?? 0) === 0)
          .map((node) => node.id),
      ),
    };
  }, [nodes, edges]);

  const selectedNodeProgress = selectedNodeId ? (progressMap.get(selectedNodeId) ?? null) : null;
  const selectedNodeAssignments = selectedNodeId
    ? (nodeAssignmentsMap.get(selectedNodeId) ?? [])
    : [];

  // All assignments across all linked nodes (for "link existing" dropdown)
  const allClassAssignments: Assignment[] = treeData.nodeAssignments.flatMap(
    (na: NodeAssignment) => na.assignments,
  );
  // Deduplicate
  const allClassAssignmentsUniq = Array.from(
    new Map(allClassAssignments.map((a) => [a.id, a])).values(),
  );

  const earnedXp = Array.from(progressMap.values()).reduce((acc, p) => acc + p.xpEarned, 0);
  const totalXp = nodes.reduce((acc, n) => acc + n.xpReward, 0);
  const xpPercent = totalXp > 0 ? Math.min(100, Math.round((earnedXp / totalXp) * 100)) : 0;
  const completedCount = Array.from(progressMap.values()).filter(
    (p) => p.status === "complete" || p.status === "mastery",
  ).length;

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div style={{ height: "calc(100vh - 64px)" }} className="skill-map-shell flex flex-col">
      {/* ── Toolbar ── */}
      <div className="skill-map-toolbar flex h-[56px] shrink-0 items-center justify-between gap-3 px-4">
        {/* Left */}
        <div className="flex min-w-0 items-center gap-3">
          {isParent ? (
            <Link
              to="/skill-trees"
              className="shrink-0 text-sm text-slate-500 transition hover:text-slate-900"
            >
              ← Skill Maps
            </Link>
          ) : null}
          {isParent ? <span className="shrink-0 text-slate-300">|</span> : null}
          <span className="truncate text-sm font-semibold text-slate-900">
            {treeData.tree.title}
          </span>
          {treeData.tree.subject ? (
            <span className="skill-map-chip shrink-0 rounded-full px-2.5 py-1 text-xs">
              {treeData.tree.subject}
            </span>
          ) : null}
        </div>

        {/* Right — parent controls */}
        {isParent ? (
          <div className="flex shrink-0 items-center gap-2">
            {selectedEdgeId ? (
              <button
                type="button"
                onClick={() => void handleDeleteEdge(selectedEdgeId)}
                title={TOOLBAR_TOOLTIPS.deleteEdge}
                className="rounded-xl border border-rose-200 bg-white px-3 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-50"
              >
                Delete edge
              </button>
            ) : null}

            {hasUnsavedPositions ? (
              <button
                type="button"
                onClick={() => void handleSavePositions()}
                title={TOOLBAR_TOOLTIPS.savePositions}
                className="rounded-xl bg-amber-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-600"
              >
                Save
              </button>
            ) : null}

            <button
              type="button"
              disabled={autoLayouting || nodes.length === 0}
              onClick={() => void handleAutoLayout()}
              title={TOOLBAR_TOOLTIPS.autoLayout}
              className="rounded-xl border border-cyan-200 bg-cyan-50 px-3 py-1.5 text-xs font-medium text-cyan-700 hover:bg-cyan-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {autoLayouting ? "Reflowing…" : "Auto-Layout"}
            </button>

            {editMode ? (
              <>
                <button
                  type="button"
                  onClick={() => void handleAddNode()}
                  title={TOOLBAR_TOOLTIPS.addNode}
                  className="rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
                >
                  + Node
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setConnectMode((v) => !v);
                    setConnectingFromId(null);
                    setRubberBandEnd(null);
                  }}
                  title={connectMode ? TOOLBAR_TOOLTIPS.connectActive : TOOLBAR_TOOLTIPS.connect}
                  className={`rounded-xl px-3 py-1.5 text-xs font-medium transition ${
                    connectMode
                      ? "bg-cyan-600 text-white"
                      : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
                  }`}
                >
                  Connect
                </button>
                <button
                  type="button"
                  onClick={() => setAiExpandOpen((v) => !v)}
                  title={TOOLBAR_TOOLTIPS.expand}
                  className={`rounded-xl px-3 py-1.5 text-xs font-medium transition ${
                    aiExpandOpen
                      ? "bg-cyan-600 text-white"
                      : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
                  }`}
                >
                  ✦ Expand
                </button>
              </>
            ) : null}

            {/* Auto-populate — visible whenever there's a classId, not just edit mode */}
            {treeData.tree.classId ? (() => {
              const emptyCount = nodes.filter((n) => (nodeAssignmentsMap.get(n.id) ?? []).length === 0).length;
              const allDone = emptyCount === 0;
              return (
                <button
                  type="button"
                  disabled={populateState?.phase === "running" || allDone}
                  onClick={() => void handleAutoPopulate()}
                  title={allDone ? TOOLBAR_TOOLTIPS.autoPopulateDone : TOOLBAR_TOOLTIPS.autoPopulate}
                  className={[
                    "rounded-xl border px-3 py-1.5 text-xs font-medium transition",
                    allDone
                      ? "border-slate-200 bg-slate-50 text-slate-400 cursor-default"
                      : "border-violet-400 bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm",
                  ].join(" ")}
                >
                  {populateState?.phase === "running" ? (
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                      Generating content…
                    </span>
                  ) : allDone ? (
                    "✓ Content filled"
                  ) : (
                    <span className="flex items-center gap-1">
                      ✦ Generate Assignments
                      <span className="ml-1 rounded-full bg-violet-500 px-1.5 py-0.5 text-[10px] font-bold">{emptyCount}</span>
                    </span>
                  )}
                </button>
              );
            })() : null}

            <button
              type="button"
              onClick={() => {
                setEditMode((v) => !v);
                setConnectMode(false);
                setConnectingFromId(null);
                setRubberBandEnd(null);
                setAiExpandOpen(false);
                setSelectedEdgeId(null);
              }}
              title={editMode ? TOOLBAR_TOOLTIPS.editModeActive : TOOLBAR_TOOLTIPS.editMode}
              className={`rounded-xl px-3 py-1.5 text-xs font-medium transition ${
                editMode
                  ? "bg-cyan-600 text-white"
                  : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
              }`}
            >
              Edit Mode
            </button>
          </div>
        ) : null}

        {/* Right — student XP meter */}
        {isStudent ? (
          <div className="flex shrink-0 items-center gap-2.5">
            <span className="text-xs font-semibold text-amber-700 whitespace-nowrap">
              ⭐ {earnedXp}{totalXp > 0 ? ` / ${totalXp}` : ""} XP
            </span>
            <div className="relative h-3 w-28 overflow-hidden rounded-full bg-slate-200 sm:w-40" title={`${xpPercent}% complete`}>
              <div
                className="h-full rounded-full bg-gradient-to-r from-amber-400 to-amber-500 transition-all duration-500"
                style={{ width: `${xpPercent}%` }}
              />
            </div>
            <span className="hidden text-[10px] text-slate-500 sm:block">
              {completedCount}/{nodes.length}
            </span>
          </div>
        ) : null}
      </div>

      {/* ── Keyboard shortcut hint (parent edit mode only) ── */}
      {isParent && editMode ? (
        <div className="skill-map-subtoolbar flex h-7 shrink-0 items-center px-4">
          <p className="text-[10px] text-slate-400">
            E = edit mode · C = connect · N = new node · Esc = cancel
          </p>
        </div>
      ) : null}

      {/* ── Canvas area ── */}
      <div
        ref={canvasRef}
        className="skill-map-canvas relative flex-1 select-none overflow-hidden"
        style={{ cursor: isPanning.current ? "grabbing" : "grab" }}
        onMouseDown={handleCanvasMouseDown}
        onWheel={handleWheel}
      >
        <svg
          ref={svgRef}
          width="100%"
          height="100%"
          style={{ position: "absolute", inset: 0, overflow: "visible" }}
        >
          <g
            id="world"
            transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`}
          >
            <EdgeLayer
              edges={edges}
              nodes={nodes}
              editMode={editMode}
              selectedEdgeId={selectedEdgeId}
              connectingFromId={connectMode ? connectingFromId : null}
              rubberBandEnd={rubberBandEnd}
              highlightedEdgeIds={highlightedEdgeIds}
              onEdgeClick={handleEdgeClick}
              onDeleteEdge={handleDeleteEdge}
            />
            <NodeLayer
              nodes={nodes}
              progressMap={progressMap}
              editMode={editMode}
              connectMode={connectMode}
              connectingFromId={connectingFromId}
              draggingNodeId={draggingNodeId}
              selectedNodeId={selectedNodeId}
              newlyAddedNodeIds={newlyAddedNodeIds}
              dimmedNodeIds={dimmedNodeIds}
              forkNodeIds={forkNodeIds}
              startNodeIds={startNodeIds}
              endNodeIds={endNodeIds}
              onNodeClick={(id) => { setSidePanelInitialTab(undefined); handleNodeClick(id); }}
              onNodeDoubleClick={handleNodeDoubleClick}
              onNodeDragStart={handleNodeDragStart}
            />
          </g>
        </svg>

        {/* ── Empty tree state ── */}
        {nodes.length === 0 ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
            <p className="text-sm text-slate-500">This skill map is empty.</p>
            {isParent && editMode ? (
              <button
                type="button"
                onClick={() => void handleAddNode()}
                title={TOOLBAR_TOOLTIPS.addFirstNode}
                className="rounded-xl bg-cyan-700 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-cyan-800"
              >
                + Add your first node
              </button>
            ) : isParent ? (
              <p className="text-xs text-slate-400">Switch to Edit Mode to start building</p>
            ) : null}
          </div>
        ) : null}

        {/* ── Overlays ── */}
        <ZoomControls viewport={viewport} onSetViewport={setViewport} />
        <Legend />
        <SkillTreeMinimap
          nodes={nodes}
          progressMap={progressMap}
          viewport={viewport}
          onViewportChange={(x, y) => setViewport((v) => ({ ...v, x, y }))}
        />

        {/* Side panel */}
        <NodeSidePanel
          node={selectedNode as Parameters<typeof NodeSidePanel>[0]["node"]}
          progress={selectedNodeProgress as Parameters<typeof NodeSidePanel>[0]["progress"]}
          nodeAssignments={selectedNodeAssignments as Parameters<typeof NodeSidePanel>[0]["nodeAssignments"]}
          allClassAssignments={allClassAssignmentsUniq as Parameters<typeof NodeSidePanel>[0]["allClassAssignments"]}
          nodes={nodes as Parameters<typeof NodeSidePanel>[0]["nodes"]}
          edges={edges as Parameters<typeof NodeSidePanel>[0]["edges"]}
          editMode={editMode}
          isStudent={isStudent}
          parentPinLength={null}
          initialTab={sidePanelInitialTab}
          onClose={() => { setSelectedNodeId(null); setSidePanelInitialTab(undefined); }}
          onAssignmentLinked={(id) => void handleAssignmentLinked(id)}
          onAssignmentUnlinked={(id) => void handleAssignmentUnlinked(id)}
          onNodeUpdated={(updated) => void handleNodeUpdated(updated as TreeNode)}
          onDeleteNode={(nodeId, pin) => void handleDeleteNode(nodeId, pin)}
          onAiGenerateAssignments={(nodeId) => void handleAiGenerateAssignments(nodeId)}
          onMarkComplete={handleMarkComplete}
        />

        {/* AI expand panel */}
        {aiExpandOpen && editMode ? (
          <AiExpandPanel
            nodes={nodes}
            treeId={treeData.tree.id}
            onExpanded={(newNodes, newEdges) => {
              setNodes((prev) => [...prev, ...newNodes]);
              setEdges((prev) => [...prev, ...newEdges]);
              setHasUnsavedPositions(true);
              const ids = new Set(newNodes.map((n) => n.id));
              setNewlyAddedNodeIds(ids);
              setTimeout(() => setNewlyAddedNodeIds(new Set()), 2000);
            }}
            onClose={() => setAiExpandOpen(false)}
          />
        ) : null}

        {/* Auto-populate progress panel */}
        {populateState && !aiExpandOpen ? (
          <PopulateProgressPanel
            state={populateState}
            onCancel={() => { cancelPopulateRef.current = true; }}
            onDismiss={() => setPopulateState(null)}
          />
        ) : null}

        {/* XP toast */}
        {xpToast ? (
          <div
            key={xpToast.xp + xpToast.x}
            className="pointer-events-none absolute z-50 text-sm font-bold text-emerald-600"
            style={{
              left: xpToast.x,
              top: xpToast.y,
              transform: "translateX(-50%)",
              animation: "xp-float 1.5s ease-out forwards",
            }}
          >
            +{xpToast.xp} XP
          </div>
        ) : null}

        {/* Unlock toast */}
        {unlockToast ? (
          <div className="pointer-events-none absolute bottom-20 left-1/2 z-50 -translate-x-1/2 rounded-2xl border border-cyan-200 bg-white px-4 py-2 text-sm font-medium text-cyan-700 shadow-lg">
            {unlockToast}
          </div>
        ) : null}

        {/* Reward unlock banner */}
        {rewardUnlockBanner ? (
          <div className="absolute top-3 left-1/2 z-50 -translate-x-1/2 flex items-center gap-2 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-2.5 shadow-lg">
            <span>🎁</span>
            <span className="text-sm font-semibold text-amber-800">
              You unlocked {rewardUnlockBanner.tierTitle}! Go claim it
            </span>
            <Link
              to="/student"
              className="ml-1 text-sm font-bold text-amber-700 underline hover:text-amber-900"
            >
              →
            </Link>
          </div>
        ) : null}

        {/* XP float keyframe */}
        <style>{`
          @keyframes xp-float {
            0%   { opacity: 1; transform: translateX(-50%) translateY(0); }
            100% { opacity: 0; transform: translateX(-50%) translateY(-40px); }
          }
        `}</style>
      </div>
    </div>
  );
}
