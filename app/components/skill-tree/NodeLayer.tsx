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

// ── Gradient stop pairs per status ────────────────────────────────────────────
const STATUS_GRADIENT: Record<string, [string, string]> = {
  locked:      ["#e2e0d8", "#bfbdb3"],
  available:   ["#5ba8f0", "#2870c8"],
  in_progress: ["#9d97ee", "#5e58c8"],
  complete:    ["#2dc98a", "#158f60"],
  mastery:     ["#f8c048", "#d07c10"],
};

// ── Icon color palette ────────────────────────────────────────────────────────
// detail  = the main icon body color — deep/dark so it reads on the gradient fill
// shadow  = darker shade for depth/shadow areas within the icon
// accent  = warm highlight (bookmark ribbon, star, branch tips)
const ICON_COLORS: Record<string, { detail: string; shadow: string; accent: string }> = {
  blue:   { detail: "#0a2e56", shadow: "#061a30", accent: "#c8841a" },
  teal:   { detail: "#043322", shadow: "#021a10", accent: "#b87a14" },
  purple: { detail: "#1e1455", shadow: "#100a30", accent: "#b87010" },
  amber:  { detail: "#5a2e00", shadow: "#2e1600", accent: "#8a4a00" },
  coral:  { detail: "#5c1400", shadow: "#2e0a00", accent: "#8a3c00" },
  green:  { detail: "#142e00", shadow: "#091800", accent: "#8a6000" },
  gray:   { detail: "#2a2a28", shadow: "#141412", accent: "#6a6050" },
};
const LOCKED_ICON = { detail: "#4a4844", shadow: "#28261e", accent: "#8a8070" };

// ── Node type SVG icons ────────────────────────────────────────────────────────

function NodeTypeIcon({
  cx, cy, r, nodeType, status, icon, colorRamp,
}: {
  cx: number; cy: number; r: number;
  nodeType: string; status: string; icon: string | null; colorRamp: string;
}): React.ReactNode {
  const isComplete = status === "complete" || status === "mastery";
  const isLocked   = status === "locked";
  const ic = isLocked ? LOCKED_ICON : (ICON_COLORS[colorRamp] ?? ICON_COLORS.blue!);

  // Checkmark for completed nodes — white on the colored fill
  if (isComplete) {
    const ck = Math.max(6, Math.round(r * 0.38));
    return (
      <path
        d={`M ${cx - ck} ${cy} L ${cx - Math.round(ck * 0.28)} ${cy + ck * 0.72} L ${cx + ck * 1.12} ${cy - ck * 0.72}`}
        fill="none"
        stroke="white"
        strokeWidth={Math.max(2.2, Math.round(r * 0.11))}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ pointerEvents: "none" }}
      />
    );
  }

  // Custom icon string (emoji or letter) set by teacher
  if (icon) {
    return (
      <text
        x={cx} y={cy}
        fontSize={Math.max(14, Math.round(r * 0.68))}
        textAnchor="middle"
        dominantBaseline="central"
        fill={ic.detail}
        fontWeight="800"
        style={{ pointerEvents: "none", userSelect: "none" }}
      >
        {icon}
      </text>
    );
  }

  const s = Math.max(7, Math.round(r * 0.48));

  if (nodeType === "milestone") {
    // Open book — dark pages on the lighter gradient
    const bw = s * 1.35;
    const bh = s * 1.0;
    return (
      <g style={{ pointerEvents: "none" }} transform={`translate(${cx},${cy})`}>
        <path
          d={`M -${bw * 0.06} -${bh * 0.42} C -${bw * 0.32} -${bh * 0.5} -${bw * 0.72} -${bh * 0.38} -${bw * 0.72} -${bh * 0.1} L -${bw * 0.72} ${bh * 0.46} C -${bw * 0.72} ${bh * 0.46} -${bw * 0.32} ${bh * 0.34} -${bw * 0.06} ${bh * 0.42} Z`}
          fill={ic.detail} fillOpacity={0.88}
        />
        <path
          d={`M ${bw * 0.06} -${bh * 0.42} C ${bw * 0.32} -${bh * 0.5} ${bw * 0.72} -${bh * 0.38} ${bw * 0.72} -${bh * 0.1} L ${bw * 0.72} ${bh * 0.46} C ${bw * 0.72} ${bh * 0.46} ${bw * 0.32} ${bh * 0.34} ${bw * 0.06} ${bh * 0.42} Z`}
          fill={ic.shadow} fillOpacity={0.72}
        />
        <line x1={0} y1={-bh * 0.42} x2={0} y2={bh * 0.42} stroke={ic.shadow} strokeWidth={s * 0.14} strokeOpacity={0.9} />
        <line x1={-bw * 0.58} y1={-bh * 0.04} x2={-bw * 0.14} y2={0}         stroke={ic.accent} strokeWidth={s * 0.1} strokeLinecap="round" strokeOpacity={0.85} />
        <line x1={-bw * 0.58} y1={bh * 0.12}  x2={-bw * 0.14} y2={bh * 0.16} stroke={ic.accent} strokeWidth={s * 0.1} strokeLinecap="round" strokeOpacity={0.85} />
        <line x1={-bw * 0.56} y1={bh * 0.27}  x2={-bw * 0.18} y2={bh * 0.31} stroke={ic.accent} strokeWidth={s * 0.08} strokeLinecap="round" strokeOpacity={0.6} />
        <polygon points={`${bw * 0.52},-${bh * 0.36} ${bw * 0.68},-${bh * 0.36} ${bw * 0.68},${bh * 0.08} ${bw * 0.6},0 ${bw * 0.52},${bh * 0.08}`} fill={ic.accent} fillOpacity={0.9} />
      </g>
    );
  }

  if (nodeType === "boss") {
    // Shield crest
    const sw = s * 1.05;
    const sh = s * 1.2;
    return (
      <g style={{ pointerEvents: "none" }} transform={`translate(${cx},${cy})`}>
        <path
          d={`M 0 -${sh} L ${sw} -${sh * 0.4} L ${sw} ${sh * 0.22} Q ${sw} ${sh * 0.72} 0 ${sh} Q -${sw} ${sh * 0.72} -${sw} ${sh * 0.22} L -${sw} -${sh * 0.4} Z`}
          fill={ic.detail} fillOpacity={0.88}
        />
        <path
          d={`M 0 -${sh * 0.7} L ${sw * 0.7} -${sh * 0.24} L ${sw * 0.7} ${sh * 0.18} Q ${sw * 0.7} ${sh * 0.54} 0 ${sh * 0.72} Q -${sw * 0.7} ${sh * 0.54} -${sw * 0.7} ${sh * 0.18} L -${sw * 0.7} -${sh * 0.24} Z`}
          fill="none" stroke={ic.shadow} strokeWidth={s * 0.12} strokeOpacity={0.6}
        />
        <polygon points={starPoints(0, sh * 0.08, sw * 0.38, sw * 0.17, 5)} fill={ic.accent} fillOpacity={0.92} />
      </g>
    );
  }

  if (nodeType === "branch" || nodeType === "elective") {
    // Fork / branching path
    const blen = s * 0.9;
    return (
      <g style={{ pointerEvents: "none" }} transform={`translate(${cx},${cy})`}>
        <line x1={0} y1={blen * 0.88} x2={0}          y2={0}          stroke={ic.detail} strokeWidth={s * 0.26} strokeLinecap="round" />
        <line x1={0} y1={0}           x2={-blen * 0.78} y2={-blen * 0.7} stroke={ic.detail} strokeWidth={s * 0.24} strokeLinecap="round" />
        <line x1={0} y1={0}           x2={blen * 0.78}  y2={-blen * 0.7} stroke={ic.detail} strokeWidth={s * 0.24} strokeLinecap="round" />
        <circle cx={-blen * 0.78} cy={-blen * 0.7} r={s * 0.22} fill={ic.accent} />
        <circle cx={blen * 0.78}  cy={-blen * 0.7} r={s * 0.22} fill={ic.accent} />
        <circle cx={0}            cy={blen * 0.88}  r={s * 0.18} fill={ic.shadow} fillOpacity={0.8} />
      </g>
    );
  }

  // Default lesson: pencil
  const pw = s * 0.3;
  const ph = s * 1.15;
  return (
    <g style={{ pointerEvents: "none" }} transform={`translate(${cx},${cy}) rotate(-22)`}>
      <rect x={-pw / 2} y={-ph * 0.52} width={pw} height={ph * 0.72} rx={pw * 0.25} fill={ic.detail} fillOpacity={0.88} />
      <rect x={-pw / 2} y={ph * 0.18}  width={pw} height={ph * 0.12} fill={ic.shadow} fillOpacity={0.7} />
      <rect x={-pw / 2} y={ph * 0.3}   width={pw} height={ph * 0.14} rx={pw * 0.2}   fill={ic.accent} fillOpacity={0.92} />
      <polygon points={`0,${ph * 0.5} ${-pw / 2},${ph * 0.2} ${pw / 2},${ph * 0.2}`} fill={ic.shadow} fillOpacity={0.8} />
      <circle cx={0} cy={ph * 0.5} r={pw * 0.22} fill={ic.shadow} fillOpacity={0.9} />
    </g>
  );
}

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

// Friendly display name shown INSIDE the node when it's a role marker
const ROLE_LABEL: Record<string, string> = {
  start: "START",
  end:   "GOAL",
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

  // Unique gradient IDs per node (stable)
  const gradientDefs = nodes.map((node) => {
    const p = progressMap.get(node.id);
    const status = p?.status ?? "locked";
    const [light, dark] = STATUS_GRADIENT[status] ?? STATUS_GRADIENT.locked!;
    const id = `ng-${node.id.replace(/[^a-z0-9]/gi, "")}`;
    const angle = node.nodeType === "boss" ? 135 : node.nodeType === "milestone" ? 110 : 130;
    const rad = (angle * Math.PI) / 180;
    const x1 = (0.5 - 0.5 * Math.cos(rad)).toFixed(3);
    const y1 = (0.5 - 0.5 * Math.sin(rad)).toFixed(3);
    const x2 = (0.5 + 0.5 * Math.cos(rad)).toFixed(3);
    const y2 = (0.5 + 0.5 * Math.sin(rad)).toFixed(3);
    return (
      <linearGradient key={id} id={id} x1={x1} y1={y1} x2={x2} y2={y2} gradientUnits="objectBoundingBox">
        <stop offset="0%" stopColor={light} />
        <stop offset="100%" stopColor={dark} />
      </linearGradient>
    );
  });

  return (
    <>
      <defs>{gradientDefs}</defs>

      {nodes.map((node) => {
        const p = progressMap.get(node.id);
        const status = p?.status ?? "locked";
        const r = computeSkillTreeNodeRadius(node.nodeType, node.xpReward, node.isRequired);
        const cx = node.positionX;
        const cy = node.positionY;
        const nodeColor = RAMP_COLORS[node.colorRamp] ?? RAMP_COLORS.blue;
        const isLocked = status === "locked";
        const isAvailable = status === "available";
        const isOptional = !node.isRequired;
        const isDragging = node.id === draggingNodeId;
        const isSelected = node.id === selectedNodeId;
        const isConnectSource = node.id === connectingFromId;
        const isNewlyAdded = newlyAddedNodeIds?.has(node.id) ?? false;
        const isForkNode = forkNodeIds?.has(node.id) ?? false;
        const isStartNode = startNodeIds?.has(node.id) ?? false;
        const isEndNode = endNodeIds?.has(node.id) ?? false;

        const shapeOpacity = isLocked ? 0.32 : isOptional ? 0.93 : 1;
        const gradId = `ng-${node.id.replace(/[^a-z0-9]/gi, "")}`;
        const fillColor = `url(#${gradId})`;
        const flatFill = isLocked ? STATUS_FILL.locked : STATUS_FILL[status] ?? nodeColor;

        const cursor = connectMode
          ? "crosshair"
          : editMode && !connectMode
          ? "move"
          : "pointer";

        // ── Shape element ─────────────────────────────────────────────────────
        // Each shape gets:
        //   1. Gradient fill
        //   2. Outer stroke (node color)
        //   3. Inner highlight bevel (thin white arc at top-left)
        let shapeEl: React.ReactNode;
        let innerHighlight: React.ReactNode = null;

        if (node.nodeType === "milestone") {
          shapeEl = (
            <polygon
              points={hexagonPoints(cx, cy, r)}
              fill={isLocked ? flatFill : fillColor}
              fillOpacity={shapeOpacity}
              stroke={nodeColor}
              strokeWidth={isDragging || isSelected ? 2.8 : 2}
              strokeDasharray={isOptional ? "5 4" : undefined}
            />
          );
          // Inner highlight — smaller hex inset
          if (!isLocked) {
            innerHighlight = (
              <polygon
                points={hexagonPoints(cx, cy - r * 0.06, r * 0.72)}
                fill="none"
                stroke="white"
                strokeWidth={0.9}
                opacity={0.22}
                style={{ pointerEvents: "none" }}
              />
            );
          }
        } else if (node.nodeType === "boss") {
          shapeEl = (
            <polygon
              points={diamondPoints(cx, cy, r)}
              fill={isLocked ? flatFill : fillColor}
              fillOpacity={shapeOpacity}
              stroke={nodeColor}
              strokeWidth={isDragging || isSelected ? 2.8 : 2}
              strokeDasharray={isOptional ? "5 4" : undefined}
            />
          );
          if (!isLocked) {
            innerHighlight = (
              <polygon
                points={diamondPoints(cx, cy - r * 0.06, r * 0.65)}
                fill="none"
                stroke="white"
                strokeWidth={0.9}
                opacity={0.2}
                style={{ pointerEvents: "none" }}
              />
            );
          }
        } else {
          shapeEl = (
            <circle
              cx={cx}
              cy={cy}
              r={r}
              fill={isLocked ? flatFill : fillColor}
              fillOpacity={shapeOpacity}
              stroke={nodeColor}
              strokeWidth={isDragging || isSelected ? 2.2 : 1.6}
              strokeDasharray={isOptional ? "4 3" : undefined}
            />
          );
          if (!isLocked) {
            // Elliptical highlight arc at top-left
            innerHighlight = (
              <ellipse
                cx={cx - r * 0.2}
                cy={cy - r * 0.28}
                rx={r * 0.42}
                ry={r * 0.22}
                fill="white"
                fillOpacity={0.18}
                style={{ pointerEvents: "none" }}
              />
            );
          }
        }

        // ── Role label inside node (replaces external pill) ───────────────────
        // Only show when not complete (checkmark takes the space) and node is big enough
        const roleLabelEl = (isStartNode || isEndNode) && status !== "complete" && status !== "mastery" ? (
          <text
            x={cx}
            y={cy + r * 0.54}
            fontSize={Math.max(6, Math.round(r * 0.24))}
            textAnchor="middle"
            dominantBaseline="central"
            fill="white"
            fontWeight="800"
            letterSpacing="0.06em"
            opacity={0.88}
            style={{ pointerEvents: "none", userSelect: "none" }}
          >
            {isStartNode ? ROLE_LABEL.start : ROLE_LABEL.end}
          </text>
        ) : null;

        // ── Node content (icon/checkmark) — shifted up slightly when role label shown ──
        const iconOffsetY = (isStartNode || isEndNode) && status !== "complete" && status !== "mastery"
          ? cy - r * 0.14  // nudge icon up to leave room for role label
          : cy;

        const contentEl = (
          <NodeTypeIcon
            cx={cx}
            cy={iconOffsetY}
            r={r}
            nodeType={node.nodeType}
            status={status}
            icon={node.icon}
            colorRamp={node.colorRamp}
          />
        );

        // ── Pulse ring for available nodes ────────────────────────────────────
        const pulseRing = isAvailable ? (
          <circle
            cx={cx} cy={cy} r={r + 5}
            fill="none" stroke={nodeColor}
            strokeWidth={1} opacity={0.38}
            style={{ animation: "pulse-ring 2s ease-out infinite" }}
          />
        ) : null;

        // ── Connect-mode ring ──────────────────────────────────────────────────
        const connectRing = isConnectSource ? (
          <circle
            cx={cx} cy={cy} r={r + 6}
            fill="none" stroke="#0e7490"
            strokeWidth={1.6} opacity={0.72}
          />
        ) : null;

        // ── Role halo (soft glow behind start/end nodes) ───────────────────────
        const roleHaloColor = isEndNode ? "#2a77af" : "#67b9df";
        const roleHalo = isStartNode || isEndNode ? (
          <polygon
            points={starPoints(cx, cy, r + 10, r + 4)}
            fill={roleHaloColor}
            fillOpacity={isLocked ? 0.06 : 0.1}
            stroke={roleHaloColor}
            strokeWidth={0.8}
            opacity={0.9}
          />
        ) : null;

        // ── Selected ring ─────────────────────────────────────────────────────
        const selectedRing = isSelected && !isConnectSource ? (
          <>
            <circle cx={cx} cy={cy} r={r + 3} fill="none" stroke={nodeColor} strokeWidth={2.8} opacity={0.9} />
            <circle cx={cx} cy={cy} fill="none" stroke={nodeColor} strokeWidth={2}
              style={{ transformOrigin: `${cx}px ${cy}px`, animation: "wave-select 1.5s ease-out infinite" }}
              r={r + 3}
            />
            <circle cx={cx} cy={cy} fill="none" stroke={nodeColor} strokeWidth={1.5}
              style={{ transformOrigin: `${cx}px ${cy}px`, animation: "wave-select 1.5s ease-out 0.4s infinite" }}
              r={r + 3}
            />
            <circle cx={cx} cy={cy} fill="none" stroke={nodeColor} strokeWidth={1}
              style={{ transformOrigin: `${cx}px ${cy}px`, animation: "wave-select 1.5s ease-out 0.8s infinite" }}
              r={r + 3}
            />
          </>
        ) : null;

        // ── Chapter ring ──────────────────────────────────────────────────────
        const chapterRing = node.nodeType === "milestone" && !isSelected && !isConnectSource ? (
          <polygon
            points={hexagonPoints(cx, cy, r + 6)}
            fill="none" stroke={nodeColor}
            strokeWidth={1} opacity={isLocked ? 0.09 : 0.24}
            strokeDasharray="4 3"
          />
        ) : null;

        // ── Fork ring ─────────────────────────────────────────────────────────
        const forkRing = isForkNode ? (
          <>
            <polygon points={diamondPoints(cx, cy, r + 8)} fill="none" stroke="#ef9f27" strokeWidth={1} opacity={0.35} strokeDasharray="5 4" />
            <polygon points={diamondPoints(cx, cy, r + 4)} fill="none" stroke="#ef9f27" strokeWidth={0.9} opacity={0.6} strokeDasharray="5 3" />
          </>
        ) : null;

        // ── Mastery badge ─────────────────────────────────────────────────────
        const masteryBadge = status === "mastery" ? (
          <>
            <circle cx={cx + r - 3} cy={cy - r + 3} r={7} fill="#ef9f27" />
            <text x={cx + r - 3} y={cy - r + 3} fontSize={8} textAnchor="middle" dominantBaseline="central" fill="white" style={{ pointerEvents: "none" }}>★</text>
          </>
        ) : null;

        // ── Ping ring for newly added nodes ───────────────────────────────────
        const pingRing = isNewlyAdded ? (
          <circle cx={cx} cy={cy} r={r + 12} fill="none" stroke={nodeColor} strokeWidth={2} opacity={0.6}
            style={{ animation: "ping 0.8s ease-out 2" }}
          />
        ) : null;

        // ── Edit mode drag handle dots ─────────────────────────────────────────
        const dragHandle = editMode && !connectMode ? (
          <>
            <circle cx={cx - 4} cy={cy - r + 5} r={1.5} fill="white" opacity={0.7} style={{ pointerEvents: "none" }} />
            <circle cx={cx}     cy={cy - r + 5} r={1.5} fill="white" opacity={0.7} style={{ pointerEvents: "none" }} />
            <circle cx={cx + 4} cy={cy - r + 5} r={1.5} fill="white" opacity={0.7} style={{ pointerEvents: "none" }} />
          </>
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
            <circle cx={cx} cy={cy} r={r + 8} fill="none" stroke={nodeColor} strokeWidth={1} opacity={0} className="node-hover-ring" />

            {pingRing}
            {pulseRing}
            {connectRing}
            {roleHalo}
            {chapterRing}
            {forkRing}
            {selectedRing}
            {shapeEl}
            {innerHighlight}
            {contentEl}
            {roleLabelEl}
            {masteryBadge}
            {dragHandle}
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
        const tipX = tooltip.svgX + tooltip.r + 14;
        const tipY = tooltip.svgY - 44;

        return (
          <foreignObject
            x={tipX} y={tipY}
            width={TW} height={160}
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
              <div style={{
                height: "2px",
                background: "linear-gradient(90deg, transparent, rgba(200,169,110,0.55), rgba(200,169,110,0.8), rgba(200,169,110,0.55), transparent)",
                borderRadius: "999px",
                marginBottom: "8px",
              }} />

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

              <div style={{
                fontSize: "12px", fontWeight: 600, color: "#102a43",
                lineHeight: 1.38, marginBottom: "7px", wordBreak: "break-word",
              }}>
                {tn.title}
              </div>

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

              {tn.xpReward > 0 && (
                <div style={{
                  fontSize: "10px", fontWeight: 600, color: "#a8895a", letterSpacing: "0.02em",
                }}>
                  {tstatus === "mastery" || tstatus === "complete"
                    ? `${tp?.xpEarned ?? tn.xpReward} / ${tn.xpReward} XP`
                    : `${tn.xpReward} XP`}
                </div>
              )}

              <div style={{
                marginTop: "7px", fontSize: "9px", color: "#8bafc8",
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
