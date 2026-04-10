import type React from "react";
import { useState } from "react";
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

const STATUS_LABEL: Record<string, string> = {
  locked:      "Locked",
  available:   "Available",
  in_progress: "In Progress",
  complete:    "Complete",
  mastery:     "Mastery",
};

const NODE_TYPE_LABEL: Record<string, string> = {
  lesson:    "Lesson",
  milestone: "Chapter",
  boss:      "Boss",
  branch:    "Branch",
  elective:  "Elective",
};

type TooltipState = {
  nodeId: string;
  svgX: number;
  svgY: number;
  r: number;
} | null;

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
  onNodeDoubleClick?: (nodeId: string) => void;
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
  onNodeDoubleClick,
  onNodeDragStart,
}: Props) {
  const [tooltip, setTooltip] = useState<TooltipState>(null);

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
            <rect x={-24} y={-8} width={48} height={16} rx={8} fill="#eaf8ff" stroke="#67b9df" strokeWidth={0.9} />
            <text x={0} y={0} fontSize={8} textAnchor="middle" dominantBaseline="central" fill="#1f628a" fontWeight="700" style={{ userSelect: "none" }}>★ START</text>
          </g>
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

        // GOAL badge: small pill directly below node shape
        const endMarker = isEndNode ? (
          <g transform={`translate(${cx} ${cy + r + 14})`} style={{ pointerEvents: "none" }}>
            <rect x={-24} y={-8} width={48} height={16} rx={8} fill="#e2f2fe" stroke="#2a77af" strokeWidth={0.9} />
            <text x={0} y={0} fontSize={8} textAnchor="middle" dominantBaseline="central" fill="#1a4f78" fontWeight="700" style={{ userSelect: "none" }}>★ GOAL</text>
          </g>
        ) : null;

        const isDimmed = (dimmedNodeIds?.size ?? 0) > 0 && (dimmedNodeIds?.has(node.id) ?? false);

        return (
          <g
            key={node.id}
            style={{ cursor, opacity: isDimmed ? 0.15 : 1, transition: "opacity 0.2s" }}
            onClick={(e) => { e.stopPropagation(); onNodeClick(node.id); }}
            onDoubleClick={(e) => { e.stopPropagation(); onNodeDoubleClick?.(node.id); }}
            onMouseDown={(e) => {
              if (editMode && !connectMode) onNodeDragStart(node.id, e);
            }}
            onMouseEnter={() => setTooltip({ nodeId: node.id, svgX: cx, svgY: cy, r })}
            onMouseLeave={() => setTooltip((t) => t?.nodeId === node.id ? null : t)}
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
          </g>
        );
      })}

      {/* Hover tooltip — glass panel aligned to the right side of the node */}
      {tooltip ? (() => {
        const tn = nodes.find((n) => n.id === tooltip.nodeId);
        if (!tn) return null;
        const tp = progressMap.get(tn.id);
        const tstatus = tp?.status ?? "locked";
        const tnodeColor = RAMP_COLORS[tn.colorRamp] ?? RAMP_COLORS.blue;
        const isStart = startNodeIds?.has(tn.id) ?? false;
        const isEnd = endNodeIds?.has(tn.id) ?? false;

        const TW = 192;
        // Anchor to the right of the node, vertically centered
        const tipX = tooltip.svgX + tooltip.r + 14;
        const tipY = tooltip.svgY - 44;

        return (
          <foreignObject
            x={tipX}
            y={tipY}
            width={TW}
            height={160}
            style={{ pointerEvents: "none", overflow: "visible" }}
          >
            <div
              style={{
                background: "linear-gradient(145deg, rgba(255,255,255,0.96), rgba(240,249,255,0.92))",
                border: `1px solid rgba(${tnodeColor === "#378add" ? "55,138,221" : "90,139,184"},0.28)`,
                borderRadius: "14px",
                padding: "10px 13px 11px",
                boxShadow: "0 4px 20px rgba(14,42,70,0.13), 0 1px 4px rgba(14,42,70,0.07)",
                backdropFilter: "blur(12px)",
                WebkitBackdropFilter: "blur(12px)",
                fontFamily: "var(--orca-body-font, sans-serif)",
                width: `${TW}px`,
              }}
            >
              {/* Sandy top accent line */}
              <div style={{
                height: "2px",
                background: "linear-gradient(90deg, transparent, rgba(200,169,110,0.55), rgba(200,169,110,0.8), rgba(200,169,110,0.55), transparent)",
                borderRadius: "999px",
                marginBottom: "8px",
              }} />

              {/* Node type + role badges */}
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px", marginBottom: "6px" }}>
                <span style={{
                  fontSize: "9px", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase",
                  background: `${tnodeColor}18`, border: `1px solid ${tnodeColor}40`,
                  color: tnodeColor, borderRadius: "6px", padding: "1px 6px",
                }}>
                  {NODE_TYPE_LABEL[tn.nodeType] ?? tn.nodeType}
                </span>
                {!tn.isRequired && (
                  <span style={{
                    fontSize: "9px", fontWeight: 600, letterSpacing: "0.04em",
                    color: "#5f81a1", background: "rgba(90,139,184,0.1)",
                    border: "1px solid rgba(90,139,184,0.22)", borderRadius: "6px", padding: "1px 5px",
                  }}>Optional</span>
                )}
                {isStart && (
                  <span style={{ fontSize: "9px", color: "#1f628a", fontWeight: 700,
                    background: "rgba(103,185,223,0.15)", border: "1px solid rgba(103,185,223,0.3)",
                    borderRadius: "6px", padding: "1px 5px" }}>★ Start</span>
                )}
                {isEnd && (
                  <span style={{ fontSize: "9px", color: "#1a4f78", fontWeight: 700,
                    background: "rgba(42,119,175,0.12)", border: "1px solid rgba(42,119,175,0.28)",
                    borderRadius: "6px", padding: "1px 5px" }}>★ Goal</span>
                )}
              </div>

              {/* Title */}
              <div style={{
                fontSize: "12px", fontWeight: 600,
                color: "#102a43",
                lineHeight: 1.38, marginBottom: "7px",
                wordBreak: "break-word",
              }}>
                {tn.title}
              </div>

              {/* Status row */}
              <div style={{ display: "flex", alignItems: "center", gap: "5px", marginBottom: tn.xpReward > 0 ? "5px" : "0" }}>
                <span style={{
                  width: "6px", height: "6px", borderRadius: "50%",
                  background: STATUS_FILL[tstatus] ?? "#888",
                  flexShrink: 0,
                  boxShadow: `0 0 4px ${STATUS_FILL[tstatus] ?? "#888"}66`,
                }} />
                <span style={{ fontSize: "10px", color: "#467095" }}>
                  {STATUS_LABEL[tstatus] ?? tstatus}
                </span>
              </div>

              {/* XP row */}
              {tn.xpReward > 0 && (
                <div style={{
                  fontSize: "10px", fontWeight: 600,
                  color: "#a8895a",
                  letterSpacing: "0.02em",
                }}>
                  {tstatus === "mastery" || tstatus === "complete"
                    ? `${tp?.xpEarned ?? tn.xpReward} / ${tn.xpReward} XP`
                    : `${tn.xpReward} XP`}
                </div>
              )}

              {/* Hint */}
              <div style={{
                marginTop: "7px", fontSize: "9px",
                color: "#8bafc8",
                borderTop: "1px solid rgba(90,139,184,0.14)", paddingTop: "6px",
                letterSpacing: "0.01em",
              }}>
                Click to open · Double-click to edit
              </div>
            </div>
          </foreignObject>
        );
      })() : null}

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
