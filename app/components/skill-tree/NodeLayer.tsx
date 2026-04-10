import type React from "react";
import { RAMP_COLORS } from "./EdgeLayer";
import { computeSkillTreeNodeRadius } from "./skillTreeGeometry";

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

function starPoints(cx: number, cy: number, outerRadius: number, innerRadius: number, points = 5): string {
  return Array.from({ length: points * 2 }, (_, i) => {
    const angle = (-90 + i * (180 / points)) * (Math.PI / 180);
    const radius = i % 2 === 0 ? outerRadius : innerRadius;
    return `${cx + radius * Math.cos(angle)},${cy + radius * Math.sin(angle)}`;
  }).join(" ");
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
  forkNodeIds?: Set<string>;
  startNodeIds?: Set<string>;
  endNodeIds?: Set<string>;
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
  forkNodeIds,
  startNodeIds,
  endNodeIds,
  onNodeClick,
  onNodeDragStart,
}: Props) {
  return (
    <>
      {nodes.map((node) => {
        const p = progressMap.get(node.id);
        const status = p?.status ?? "locked";
        const r = computeSkillTreeNodeRadius(node.nodeType, node.xpReward, node.isRequired);
        const cx = node.positionX;
        const cy = node.positionY;
        const nodeColor = RAMP_COLORS[node.colorRamp] ?? RAMP_COLORS.blue;
        const isLocked = status === "locked";
        const isComplete = status === "complete" || status === "mastery";
        const isAvailable = status === "available";
        const isOptional = !node.isRequired;
        const isDragging = node.id === draggingNodeId;
        const isSelected = node.id === selectedNodeId;
        const isConnectSource = node.id === connectingFromId;
        const isNewlyAdded = newlyAddedNodeIds?.has(node.id) ?? false;
        const isForkNode = forkNodeIds?.has(node.id) ?? false;
        const isStartNode = startNodeIds?.has(node.id) ?? false;
        const isEndNode = endNodeIds?.has(node.id) ?? false;

        const shapeOpacity = isLocked ? 0.28 : isOptional ? 0.92 : 1;
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
              strokeWidth={isDragging || isSelected ? 2.5 : 1.8}
              strokeDasharray={isOptional ? "5 4" : undefined}
            />
          );
        } else if (node.nodeType === "boss") {
          shapeEl = (
            <polygon
              points={diamondPoints(cx, cy, r)}
              fill={fillColor}
              fillOpacity={shapeOpacity}
              stroke={nodeColor}
              strokeWidth={isDragging || isSelected ? 2.5 : 1.8}
              strokeDasharray={isOptional ? "5 4" : undefined}
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
              strokeWidth={isDragging || isSelected ? 2 : 1.4}
              strokeDasharray={isOptional ? "4 3" : undefined}
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
            r={r + 4}
            fill="none"
            stroke={nodeColor}
            strokeWidth={1}
            opacity={0.35}
            style={{ animation: "pulse-ring 2s ease-out infinite" }}
          />
        ) : null;

        // Connect-mode pulsing ring
        const connectRing = isConnectSource ? (
          <circle
            cx={cx}
            cy={cy}
            r={r + 5}
            fill="none"
            stroke="#0e7490"
            strokeWidth={1.5}
            opacity={0.7}
          />
        ) : null;

        const roleHaloColor = isEndNode ? "#2a77af" : "#67b9df";
        const roleHalo = isStartNode || isEndNode ? (
          <polygon
            points={starPoints(cx, cy, r + 9, r + 4)}
            fill={roleHaloColor}
            fillOpacity={isLocked ? 0.08 : 0.11}
            stroke={roleHaloColor}
            strokeWidth={1}
            opacity={0.9}
          />
        ) : null;

        const startMarker = isStartNode ? (
          <g transform={`translate(${cx} ${cy - r - 14})`} style={{ pointerEvents: "none" }}>
            <rect x={-28} y={-9} width={56} height={18} rx={9} fill="#eaf8ff" stroke="#67b9df" strokeWidth={1} />
            <text x={0} y={0} fontSize={8.5} textAnchor="middle" dominantBaseline="central" fill="#1f628a" fontWeight="700" style={{ userSelect: "none" }}>★ START</text>
          </g>
        ) : null;

        // endMarker is computed after label variables below

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
            points={hexagonPoints(cx, cy, r + 5)}
            fill="none"
            stroke={nodeColor}
            strokeWidth={0.9}
            opacity={isLocked ? 0.1 : 0.25}
            strokeDasharray="4 3"
          />
        ) : null;

        // Fork/decision-point nodes get an amber diamond ring + pulsing glow to mark them as choice nodes
        const forkRing = isForkNode ? (
          <>
            <polygon
              points={diamondPoints(cx, cy, r + 7)}
              fill="none"
              stroke="#ef9f27"
              strokeWidth={1}
              opacity={0.35}
              strokeDasharray="5 4"
            />
            <polygon
              points={diamondPoints(cx, cy, r + 4)}
              fill="none"
              stroke="#ef9f27"
              strokeWidth={0.9}
              opacity={0.6}
              strokeDasharray="5 3"
            />
          </>
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

        // Label — split into two lines at a word boundary instead of hard-truncating
        const labelFill = isLocked ? "#b0aea6" : "#1e293b";
        const MAX_CHARS = 18;
        let titleLine1 = node.title;
        let titleLine2: string | null = null;
        if (node.title.length > MAX_CHARS) {
          // Try to break at a space near the middle
          const mid = Math.floor(node.title.length / 2);
          const spaceAfter = node.title.indexOf(" ", mid);
          const spaceBefore = node.title.lastIndexOf(" ", mid);
          const breakIdx =
            spaceAfter !== -1 && (spaceBefore === -1 || spaceAfter - mid <= mid - spaceBefore)
              ? spaceAfter
              : spaceBefore !== -1
              ? spaceBefore
              : MAX_CHARS;
          titleLine1 = node.title.slice(0, breakIdx).trim();
          const remainder = node.title.slice(breakIdx).trim();
          titleLine2 = remainder.length > MAX_CHARS ? remainder.slice(0, MAX_CHARS - 1) + "…" : remainder;
        }
        const labelLineHeight = 13;
        const labelLines = titleLine2 ? [titleLine1, titleLine2] : [titleLine1];
        // Base label offset: small fixed gap after the node shape + ring clearance
        const labelGap = 9;
        const labelBaseY = cy + r + labelGap;

        // GOAL badge sits below all labels so nothing overlaps
        const goalBadgeOffsetY = labelGap + labelLines.length * labelLineHeight + (node.xpReward > 0 && !isLocked ? labelLineHeight + 4 : 4) + 8;
        const endMarker = isEndNode ? (
          <g transform={`translate(${cx} ${cy + r + goalBadgeOffsetY})`} style={{ pointerEvents: "none" }}>
            <rect x={-28} y={-9} width={56} height={18} rx={9} fill="#e2f2fe" stroke="#2a77af" strokeWidth={1} />
            <text x={0} y={0} fontSize={8.5} textAnchor="middle" dominantBaseline="central" fill="#1a4f78" fontWeight="700" style={{ userSelect: "none" }}>★ GOAL</text>
          </g>
        ) : null;

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
            {roleHalo}
            {chapterRing}
            {forkRing}
            {selectedRing}
            {shapeEl}
            {contentEl}
            {masteryBadge}
            {dragHandle}
            {startMarker}
            {endMarker}

            {/* Title label (1–2 lines) with opaque background to avoid edge bleed */}
            {labelLines.map((line, i) => {
              const ly = labelBaseY + i * labelLineHeight;
              const approxW = line.length * 6.4;
              return (
                <g key={i} style={{ pointerEvents: "none" }}>
                  <rect
                    x={cx - approxW / 2 - 3}
                    y={ly - 10}
                    width={approxW + 6}
                    height={13}
                    rx={3}
                    fill="rgba(245,252,255,0.88)"
                  />
                  <text
                    x={cx}
                    y={ly}
                    fontSize={isOptional ? 10 : 11}
                    textAnchor="middle"
                    dominantBaseline="auto"
                    fill={labelFill}
                    fontWeight={isSelected ? "700" : "500"}
                    style={{ userSelect: "none" }}
                  >
                    {line}
                  </text>
                </g>
              );
            })}

            {/* XP label with background */}
            {node.xpReward > 0 && !isLocked ? (() => {
              const xpy = labelBaseY + labelLines.length * labelLineHeight + 2;
              const xpStr = `${node.xpReward} XP`;
              const xpW = xpStr.length * 5.8;
              return (
                <g style={{ pointerEvents: "none" }}>
                  <rect
                    x={cx - xpW / 2 - 3}
                    y={xpy - 9}
                    width={xpW + 6}
                    height={12}
                    rx={3}
                    fill="rgba(245,252,255,0.75)"
                  />
                  <text
                    x={cx}
                    y={xpy}
                    fontSize={isOptional ? 9 : 10}
                    textAnchor="middle"
                    dominantBaseline="auto"
                    fill="#9ca3af"
                    style={{ userSelect: "none" }}
                  >
                    {xpStr}
                  </text>
                </g>
              );
            })() : null}
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
