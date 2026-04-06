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
  onNodeClick,
  onNodeDragStart,
}: Props) {
  return (
    <>
      {nodes.map((node) => {
        const p = progressMap.get(node.id);
        const status = p?.status ?? "locked";
        const r = node.radius ?? 28;
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
              strokeWidth={isDragging || isSelected ? 3 : 2}
            />
          );
        } else if (node.nodeType === "boss") {
          shapeEl = (
            <polygon
              points={diamondPoints(cx, cy, r)}
              fill={fillColor}
              fillOpacity={shapeOpacity}
              stroke={nodeColor}
              strokeWidth={isDragging || isSelected ? 3 : 2}
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
          contentEl = (
            <path
              d={`M ${cx - 7} ${cy} L ${cx - 2} ${cy + 5} L ${cx + 8} ${cy - 5}`}
              fill="none"
              stroke="white"
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ pointerEvents: "none" }}
            />
          );
        } else {
          const label = node.icon ?? node.title.charAt(0).toUpperCase();
          contentEl = (
            <text
              x={cx}
              y={cy}
              fontSize={node.icon ? 16 : 13}
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

        // Selected ring
        const selectedRing = isSelected && !isConnectSource ? (
          <circle
            cx={cx}
            cy={cy}
            r={r + 6}
            fill="none"
            stroke={nodeColor}
            strokeWidth={2}
            opacity={0.6}
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

        return (
          <g
            key={node.id}
            style={{ cursor }}
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
          0%   { opacity: 0.5; r: ${0}; }
          70%  { opacity: 0.1; }
          100% { opacity: 0; }
        }
        @keyframes ping {
          0%   { transform: scale(1); opacity: 0.6; }
          100% { transform: scale(1.4); opacity: 0; }
        }
      `}</style>
    </>
  );
}
