import type React from "react";
import { RAMP_COLORS } from "./EdgeLayer";

// ── Types ─────────────────────────────────────────────────────────────────────

export type SkillTreeNode = {
  id: string;
  title: string;
  icon: string | null;
  colorRamp: string;
  nodeType: string;
  xpReward: number;
  positionX: number;
  positionY: number;
  radius: number;
  isRequired: boolean;
  [key: string]: unknown;
};

export type SkillTreeNodeProgress = {
  nodeId: string;
  status: string;
  xpEarned: number;
  completedAt: string | null;
  masteryAt: string | null;
  [key: string]: unknown;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Compute display radius from node type and XP reward.
 *
 * Size tiers (clear delineation for children):
 *   boss       — 40px base  (dominant capstone, always biggest)
 *   milestone  — 30px base  (chapter entry points, clearly large)
 *   lesson     — 20px base  (core topic nodes, medium)
 *   branch     — 20px base  (hub nodes, same as lesson)
 *   elective   — 14px base  (optional deep dives, clearly smallest)
 *
 * XP scales within each tier (±25% of base) so high-XP lessons
 * are visibly larger than low-XP ones, but never overlap the tier above.
 */
function computeRadius(nodeType: string, xpReward: number): number {
  const base: Record<string, number> = {
    boss: 40, milestone: 30, lesson: 20, branch: 20, elective: 14,
  };
  const b = base[nodeType] ?? 20;
  const t = Math.min(1, Math.max(0, (xpReward - 50) / 950));
  return Math.round(b * (1 + 0.25 * t));
}

function hexagonPoints(cx: number, cy: number, r: number): string {
  return Array.from({ length: 6 }, (_, i) => {
    const a = (i * 60 - 90) * (Math.PI / 180);
    return `${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`;
  }).join(" ");
}

function diamondPoints(cx: number, cy: number, r: number): string {
  return `${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`;
}

const STATUS_FILL: Record<string, string> = {
  locked:      "#d3d1c7",
  available:   "#378add",
  in_progress: "#7f77dd",
  complete:    "#1d9e75",
  mastery:     "#ef9f27",
};

// ── Component ─────────────────────────────────────────────────────────────────

type Props = {
  nodes: SkillTreeNode[];
  progressMap: Map<string, SkillTreeNodeProgress>;
  editMode: boolean;
  connectMode: boolean;
  connectingFromId: string | null;
  draggingNodeId: string | null;
  selectedNodeId: string | null;
  newlyAddedNodeIds?: Set<string>;
  dimmedNodeIds?: Set<string>;
  onNodeClick: (nodeId: string) => void;
  onNodeDragStart: (nodeId: string, e: React.MouseEvent) => void;
};

export function NodeLayer({
  nodes,
  progressMap,
  editMode,
  connectMode,
  connectingFromId,
  draggingNodeId,
  selectedNodeId,
  newlyAddedNodeIds,
  dimmedNodeIds,
  onNodeClick,
  onNodeDragStart,
}: Props) {
  return (
    <>
      {nodes.map((node) => {
        const p = progressMap.get(node.id);
        const status = p?.status ?? "locked";
        const r = computeRadius(node.nodeType, node.xpReward);
        const cx = node.positionX;
        const cy = node.positionY;
        const nodeColor = RAMP_COLORS[node.colorRamp] ?? RAMP_COLORS.blue;
        const isLocked = status === "locked";
        const isComplete = status === "complete" || status === "mastery";
        const isAvailable = status === "available";
        const isDragging = node.id === draggingNodeId;
        const isSelected = node.id === selectedNodeId;
        const isConnectSource = node.id === connectingFromId;
        const isNewlyAdded = newlyAddedNodeIds?.has(node.id) ?? false;

        const shapeOpacity = isLocked ? 0.35 : 1;
        const fillColor = isLocked ? STATUS_FILL.locked : STATUS_FILL[status] ?? nodeColor;

        const cursor = connectMode
          ? "crosshair"
          : editMode && !connectMode
          ? "move"
          : "pointer";

        // Shape element
        let shapeEl: React.ReactNode;
        if (node.nodeType === "milestone") {
          shapeEl = (
            <polygon
              points={hexagonPoints(cx, cy, r)}
              fill={fillColor}
              fillOpacity={shapeOpacity}
              stroke={nodeColor}
              strokeWidth={isDragging || isSelected ? 4 : 3}
            />
          );
        } else if (node.nodeType === "boss") {
          shapeEl = (
            <polygon
              points={diamondPoints(cx, cy, r)}
              fill={fillColor}
              fillOpacity={shapeOpacity}
              stroke={nodeColor}
              strokeWidth={isDragging || isSelected ? 4 : 3}
            />
          );
        } else {
          shapeEl = (
            <circle
              cx={cx}
              cy={cy}
              r={r}
              fill={fillColor}
              fillOpacity={shapeOpacity}
              stroke={nodeColor}
              strokeWidth={isDragging || isSelected ? 3 : 2}
            />
          );
        }

        // Node content
        let contentEl: React.ReactNode;
        if (isComplete) {
          const ck = Math.max(6, Math.round(r * 0.35));
          contentEl = (
            <path
              d={`M ${cx - ck} ${cy} L ${cx - Math.round(ck * 0.3)} ${cy + ck * 0.7} L ${cx + ck * 1.1} ${cy - ck * 0.7}`}
              fill="none"
              stroke="white"
              strokeWidth={Math.max(2, Math.round(r * 0.1))}
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ pointerEvents: "none" }}
            />
          );
        } else {
          const label = node.icon ?? node.title.charAt(0).toUpperCase();
          // Scale icon/letter with node size so larger nodes don't look empty
          const iconSize = node.icon
            ? Math.max(14, Math.round(r * 0.65))
            : Math.max(11, Math.round(r * 0.5));
          contentEl = (
            <text
              x={cx}
              y={cy}
              fontSize={iconSize}
              textAnchor="middle"
              dominantBaseline="central"
              fill="white"
              fontWeight="600"
              style={{ pointerEvents: "none", userSelect: "none" }}
            >
              {label}
            </text>
          );
        }

        // Pulse ring for available nodes
        const pulseRing = isAvailable ? (
          <circle
            cx={cx}
            cy={cy}
            r={r + 6}
            fill="none"
            stroke={nodeColor}
            strokeWidth={1.5}
            opacity={0.4}
            style={{ animation: "pulse-ring 2s ease-out infinite" }}
          />
        ) : null;

        // Connect-mode pulsing ring
        const connectRing = isConnectSource ? (
          <circle
            cx={cx}
            cy={cy}
            r={r + 8}
            fill="none"
            stroke="#0e7490"
            strokeWidth={2.5}
            opacity={0.7}
          />
        ) : null;

        // Selected ring — three wave circles rippling outward from node center
        const selectedRing = isSelected && !isConnectSource ? (
          <>
            {/* Tight inner selection outline */}
            <circle
              cx={cx}
              cy={cy}
              r={r + 3}
              fill="none"
              stroke={nodeColor}
              strokeWidth={2.5}
              opacity={0.9}
            />
            {/* Wave 1 */}
            <circle
              cx={cx}
              cy={cy}
              fill="none"
              stroke={nodeColor}
              strokeWidth={2}
              style={{
                transformOrigin: `${cx}px ${cy}px`,
                animation: "wave-select 1.5s ease-out infinite",
              }}
              r={r + 3}
            />
            {/* Wave 2 — delayed */}
            <circle
              cx={cx}
              cy={cy}
              fill="none"
              stroke={nodeColor}
              strokeWidth={1.5}
              style={{
                transformOrigin: `${cx}px ${cy}px`,
                animation: "wave-select 1.5s ease-out 0.4s infinite",
              }}
              r={r + 3}
            />
            {/* Wave 3 — more delayed */}
            <circle
              cx={cx}
              cy={cy}
              fill="none"
              stroke={nodeColor}
              strokeWidth={1}
              style={{
                transformOrigin: `${cx}px ${cy}px`,
                animation: "wave-select 1.5s ease-out 0.8s infinite",
              }}
              r={r + 3}
            />
          </>
        ) : null;

        // Chapter (milestone) nodes get a distinctive outer accent ring to mark them as entry points
        const chapterRing = node.nodeType === "milestone" && !isSelected && !isConnectSource ? (
          <polygon
            points={hexagonPoints(cx, cy, r + 8)}
            fill="none"
            stroke={nodeColor}
            strokeWidth={1.5}
            opacity={isLocked ? 0.15 : 0.35}
            strokeDasharray="4 3"
          />
        ) : null;

        // Mastery badge
        const masteryBadge = status === "mastery" ? (
          <>
            <circle cx={cx + r - 3} cy={cy - r + 3} r={7} fill="#ef9f27" />
            <text
              x={cx + r - 3}
              y={cy - r + 3}
              fontSize={8}
              textAnchor="middle"
              dominantBaseline="central"
              fill="white"
              style={{ pointerEvents: "none" }}
            >
              ★
            </text>
          </>
        ) : null;

        // Ping ring for newly added nodes
        const pingRing = isNewlyAdded ? (
          <circle
            cx={cx}
            cy={cy}
            r={r + 12}
            fill="none"
            stroke={nodeColor}
            strokeWidth={2}
            opacity={0.6}
            style={{ animation: "ping 0.8s ease-out 2" }}
          />
        ) : null;

        // Edit mode drag handle dots
        const dragHandle = editMode && !connectMode ? (
          <>
            <circle cx={cx - 4} cy={cy - r + 5} r={1.5} fill="white" opacity={0.7} style={{ pointerEvents: "none" }} />
            <circle cx={cx}     cy={cy - r + 5} r={1.5} fill="white" opacity={0.7} style={{ pointerEvents: "none" }} />
            <circle cx={cx + 4} cy={cy - r + 5} r={1.5} fill="white" opacity={0.7} style={{ pointerEvents: "none" }} />
          </>
        ) : null;

        // Label
        const labelFill = isLocked ? "#b0aea6" : "#1e293b";
        const titleText = node.title.length > 16 ? node.title.slice(0, 15) + "…" : node.title;

        const isDimmed = (dimmedNodeIds?.size ?? 0) > 0 && (dimmedNodeIds?.has(node.id) ?? false);

        return (
          <g
            key={node.id}
            style={{ cursor, opacity: isDimmed ? 0.15 : 1, transition: "opacity 0.2s" }}
            onClick={(e) => { e.stopPropagation(); onNodeClick(node.id); }}
            onMouseDown={(e) => {
              if (editMode && !connectMode) onNodeDragStart(node.id, e);
            }}
          >
            {/* Hover ring (CSS hover) */}
            <circle
              cx={cx}
              cy={cy}
              r={r + 7}
              fill="none"
              stroke={nodeColor}
              strokeWidth={1}
              opacity={0}
              className="node-hover-ring"
            />

            {pingRing}
            {pulseRing}
            {connectRing}
            {chapterRing}
            {selectedRing}
            {shapeEl}
            {contentEl}
            {masteryBadge}
            {dragHandle}

            {/* Title label */}
            <text
              x={cx}
              y={cy + r + 14}
              fontSize={11}
              textAnchor="middle"
              fill={labelFill}
              fontWeight={isSelected ? "700" : "500"}
              style={{ pointerEvents: "none", userSelect: "none" }}
            >
              {titleText}
            </text>

            {/* XP label */}
            {node.xpReward > 0 && !isLocked ? (
              <text
                x={cx}
                y={cy + r + 27}
                fontSize={10}
                textAnchor="middle"
                fill="#888780"
                style={{ pointerEvents: "none", userSelect: "none" }}
              >
                {node.xpReward} XP
              </text>
            ) : null}
          </g>
        );
      })}

      {/* Global keyframes */}
      <style>{`
        @keyframes pulse-ring {
          0%   { opacity: 0.5; }
          70%  { opacity: 0.1; }
          100% { opacity: 0; }
        }
        @keyframes ping {
          0%   { transform: scale(1); opacity: 0.6; }
          100% { transform: scale(1.4); opacity: 0; }
        }
        @keyframes wave-select {
          0%   { transform: scale(1);    opacity: 0.75; }
          70%  { transform: scale(1.5);  opacity: 0.15; }
          100% { transform: scale(1.7);  opacity: 0; }
        }
        .node-hover-ring { transition: opacity 0.15s; }
        g:hover .node-hover-ring { opacity: 0.5 !important; }
      `}</style>
    </>
  );
}
