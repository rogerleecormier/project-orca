import type React from "react";

// ── Shared color palette (imported by NodeLayer too) ─────────────────────────

export const RAMP_COLORS: Record<string, string> = {
  blue:   "#378add",
  teal:   "#1d9e75",
  purple: "#7f77dd",
  amber:  "#ef9f27",
  coral:  "#d85a30",
  green:  "#639922",
  gray:   "#888780",
};

// ── Types ─────────────────────────────────────────────────────────────────────

export type SkillTreeEdge = {
  id: string;
  treeId: string;
  sourceNodeId: string;
  targetNodeId: string;
  edgeType: string;
  createdAt: string;
};

export type SkillTreeNode = {
  id: string;
  positionX: number;
  positionY: number;
  radius: number;
  colorRamp: string;
  [key: string]: unknown;
};

// ── Component ─────────────────────────────────────────────────────────────────

type Props = {
  edges: SkillTreeEdge[];
  nodes: SkillTreeNode[];
  editMode: boolean;
  selectedEdgeId: string | null;
  connectingFromId: string | null;
  rubberBandEnd: { x: number; y: number } | null;
  highlightedEdgeIds?: Set<string>;
  onEdgeClick: (edgeId: string) => void;
  onDeleteEdge?: (edgeId: string) => void;
};

export function EdgeLayer({
  edges,
  nodes,
  editMode,
  selectedEdgeId,
  connectingFromId,
  rubberBandEnd,
  highlightedEdgeIds,
  onEdgeClick,
  onDeleteEdge,
}: Props) {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const hasHighlight = (highlightedEdgeIds?.size ?? 0) > 0;

  return (
    <>
      {/* Inline keyframes for rubber-band animation */}
      <style>{`
        @keyframes dash-flow { to { stroke-dashoffset: -18; } }
        .rubber-band { animation: dash-flow 0.4s linear infinite; }
      `}</style>

      {/* SVG filter for core-path glow */}
      <defs>
        <filter id="edge-glow" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {edges.map((edge) => {
        const src = nodeMap.get(edge.sourceNodeId);
        const tgt = nodeMap.get(edge.targetNodeId);
        if (!src || !tgt) return null;

        const d = `M ${src.positionX} ${src.positionY} L ${tgt.positionX} ${tgt.positionY}`;

        const isSelected = selectedEdgeId === edge.id;
        const isHighlighted = highlightedEdgeIds?.has(edge.id) ?? false;

        // All connectors use a single unified style — solid, rounded, soft glow
        // Color always comes from the source node's color ramp for visual continuity
        const baseColor = RAMP_COLORS[src.colorRamp] ?? RAMP_COLORS.blue;
        const stroke = baseColor;
        const strokeWidth = isSelected ? 4 : isHighlighted ? 3 : 2;

        // Dimming when path highlighting is active
        const dimOpacity = hasHighlight && !isHighlighted && !isSelected ? 0.12 : 1;

        const handleClick = editMode
          ? (e: React.MouseEvent) => { e.stopPropagation(); onEdgeClick(edge.id); }
          : undefined;

        const btMidX = (src.positionX + tgt.positionX) / 2;
        const btMidY = (src.positionY + tgt.positionY) / 2;

        return (
          <g key={edge.id} opacity={dimOpacity} style={{ transition: "opacity 0.2s" }}>
            {/* Soft glow halo */}
            <path
              d={d}
              fill="none"
              stroke={stroke}
              strokeWidth={strokeWidth + 6}
              opacity={isHighlighted || isSelected ? 0.35 : 0.12}
              strokeLinecap="round"
              filter="url(#edge-glow)"
              style={{ pointerEvents: "none" }}
            />
            {/* Visible path — unified style */}
            <path
              d={d}
              fill="none"
              stroke={stroke}
              strokeWidth={strokeWidth}
              opacity={isSelected ? 1 : 0.7}
              strokeLinecap="round"
              style={{ pointerEvents: "none" }}
            />
            {/* Invisible wide click target */}
            <path
              d={d}
              fill="none"
              stroke="transparent"
              strokeWidth={12}
              style={{ cursor: editMode ? "pointer" : "default" }}
              onClick={handleClick}
            />
            {/* Delete button at segment midpoint (selected edge only) */}
            {isSelected && editMode && onDeleteEdge ? (
              <g
                transform={`translate(${btMidX} ${btMidY})`}
                style={{ cursor: "pointer" }}
                onClick={(e) => { e.stopPropagation(); onDeleteEdge(edge.id); }}
              >
                <circle r={9} fill="#ef4444" />
                <text
                  fontSize={11}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fill="white"
                  fontWeight="700"
                  style={{ pointerEvents: "none", userSelect: "none" }}
                >
                  ×
                </text>
              </g>
            ) : null}
          </g>
        );
      })}

      {/* Rubber-band line when connecting nodes */}
      {connectingFromId && rubberBandEnd ? (() => {
        const fromNode = nodeMap.get(connectingFromId);
        if (!fromNode) return null;
        return (
          <line
            x1={fromNode.positionX}
            y1={fromNode.positionY}
            x2={rubberBandEnd.x}
            y2={rubberBandEnd.y}
            stroke="#378add"
            strokeDasharray="6 3"
            strokeWidth={2}
            opacity={0.8}
            className="rubber-band"
            style={{ pointerEvents: "none" }}
          />
        );
      })() : null}
    </>
  );
}
