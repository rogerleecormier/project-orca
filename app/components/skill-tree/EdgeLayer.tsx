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
  onEdgeClick,
  onDeleteEdge,
}: Props) {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  return (
    <>
      {/* Inline keyframes for rubber-band animation */}
      <style>{`
        @keyframes dash-flow { to { stroke-dashoffset: -18; } }
        .rubber-band { animation: dash-flow 0.4s linear infinite; }
      `}</style>

      {edges.map((edge) => {
        const src = nodeMap.get(edge.sourceNodeId);
        const tgt = nodeMap.get(edge.targetNodeId);
        if (!src || !tgt) return null;

        const midY = (src.positionY + tgt.positionY) / 2;
        const d = `M ${src.positionX} ${src.positionY} C ${src.positionX} ${midY}, ${tgt.positionX} ${midY}, ${tgt.positionX} ${tgt.positionY}`;

        const isSelected = selectedEdgeId === edge.id;
        const strokeWidth = isSelected ? 3 : 2;
        const baseColor = RAMP_COLORS[src.colorRamp] ?? RAMP_COLORS.blue;
        const opacity = 0.7;

        let stroke = baseColor;
        let strokeDasharray: string | undefined;

        if (edge.edgeType === "optional") {
          stroke = "#b4b2a9";
          strokeDasharray = "6 3";
        } else if (edge.edgeType === "bonus") {
          stroke = "#ef9f27";
          strokeDasharray = "4 4";
        }

        const handleClick = editMode
          ? (e: React.MouseEvent) => { e.stopPropagation(); onEdgeClick(edge.id); }
          : undefined;

        // Bezier midpoint (t=0.5): B(0.5) = 0.125*P0 + 0.375*P1 + 0.375*P2 + 0.125*P3
        // where P0=(src.x,src.y), P1=(src.x,ctrlY), P2=(tgt.x,ctrlY), P3=(tgt.x,tgt.y)
        const btMidX = 0.125 * src.positionX + 0.375 * src.positionX + 0.375 * tgt.positionX + 0.125 * tgt.positionX;
        const btMidY = 0.125 * src.positionY + 0.375 * midY + 0.375 * midY + 0.125 * tgt.positionY;

        return (
          <g key={edge.id}>
            {/* Visible path */}
            <path
              d={d}
              fill="none"
              stroke={isSelected ? baseColor : stroke}
              strokeWidth={isSelected ? 3.5 : strokeWidth}
              strokeDasharray={strokeDasharray}
              opacity={isSelected ? 1 : opacity}
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
            {/* Delete button at bezier midpoint (selected edge only) */}
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
