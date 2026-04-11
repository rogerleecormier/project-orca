import type React from "react";
import { computeSkillTreeNodeRadius } from "./skillTreeGeometry";

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

// Edge type visual config
const EDGE_STYLE = {
  required: {
    strokeWidth: 1.6,
    opacity: 0.78,
    dasharray: undefined as string | undefined,
    colorOverride: undefined as string | undefined,
  },
  optional: {
    strokeWidth: 1.1,
    opacity: 0.6,
    dasharray: "8 6",
    colorOverride: undefined as string | undefined,
  },
  bonus: {
    strokeWidth: 0.9,
    opacity: 0.48,
    dasharray: "4 5",
    colorOverride: undefined as string | undefined,
  },
  fork: {
    strokeWidth: 1.5,
    opacity: 0.72,
    dasharray: "10 5",
    colorOverride: "#ef9f27",
  },
} as const;

const DRAW_ORDER: Record<string, number> = { bonus: 0, optional: 1, required: 2, fork: 3 };
const ROUTE_ORDER: Record<string, number> = { required: 0, fork: 1, optional: 2, bonus: 3 };

const ENDPOINT_GAP = 2;
const NODE_CLEARANCE = 14;  // padding around obstacle nodes — enough to clear the visual radius without forcing unnecessary detours
const EDGE_CLEARANCE = 14;  // min spacing between parallel edges
const DEFAULT_XP = 100;

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
  nodeType?: string;
  xpReward?: number;
  isRequired?: boolean;
  [key: string]: unknown;
};

type Point = {
  x: number;
  y: number;
};

type Segment = {
  a: Point;
  b: Point;
  edgeId: string;
};

type RoutedEdge = {
  d: string;
  midPoint: Point;
  labelPoint: Point;
  segments: Segment[];
};

// ── Geometry helpers ──────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function add(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y };
}

function sub(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y };
}

function scale(point: Point, amount: number): Point {
  return { x: point.x * amount, y: point.y * amount };
}

function length(point: Point): number {
  return Math.hypot(point.x, point.y);
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function normalize(point: Point): Point {
  const len = length(point);
  if (len < 0.0001) return { x: 0, y: 1 };
  return { x: point.x / len, y: point.y / len };
}

function perpendicular(point: Point): Point {
  return { x: -point.y, y: point.x };
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function getNodeCenter(node: SkillTreeNode): Point {
  return { x: node.positionX, y: node.positionY };
}

function getNodeVisualRadius(node: SkillTreeNode): number {
  return computeSkillTreeNodeRadius(
    node.nodeType ?? "lesson",
    node.xpReward ?? DEFAULT_XP,
    node.isRequired ?? true,
  );
}

function getNodeObstacleRadius(node: SkillTreeNode): number {
  const visualRadius = getNodeVisualRadius(node);
  const shapePadding =
    node.nodeType === "boss" ? 8 :
    node.nodeType === "milestone" ? 6 :
    2;
  return visualRadius + shapePadding;
}

function offsetFromNode(node: SkillTreeNode, toward: Point, extra = ENDPOINT_GAP): Point {
  const center = getNodeCenter(node);
  const direction = normalize(sub(toward, center));
  return add(center, scale(direction, getNodeObstacleRadius(node) + extra));
}

function distancePointToSegment(point: Point, a: Point, b: Point): number {
  const ab = sub(b, a);
  const abLenSq = ab.x * ab.x + ab.y * ab.y;
  if (abLenSq <= 0.0001) return distance(point, a);

  const ap = sub(point, a);
  const t = clamp((ap.x * ab.x + ap.y * ab.y) / abLenSq, 0, 1);
  const projection = add(a, scale(ab, t));
  return distance(point, projection);
}

function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment(a: Point, b: Point, c: Point): boolean {
  return (
    Math.min(a.x, c.x) - 0.001 <= b.x &&
    b.x <= Math.max(a.x, c.x) + 0.001 &&
    Math.min(a.y, c.y) - 0.001 <= b.y &&
    b.y <= Math.max(a.y, c.y) + 0.001
  );
}

function segmentsIntersect(a1: Point, a2: Point, b1: Point, b2: Point): boolean {
  const d1 = cross(a1, a2, b1);
  const d2 = cross(a1, a2, b2);
  const d3 = cross(b1, b2, a1);
  const d4 = cross(b1, b2, a2);

  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  if (Math.abs(d1) < 0.001 && onSegment(a1, b1, a2)) return true;
  if (Math.abs(d2) < 0.001 && onSegment(a1, b2, a2)) return true;
  if (Math.abs(d3) < 0.001 && onSegment(b1, a1, b2)) return true;
  if (Math.abs(d4) < 0.001 && onSegment(b1, a2, b2)) return true;
  return false;
}

function distanceBetweenSegments(a1: Point, a2: Point, b1: Point, b2: Point): number {
  if (segmentsIntersect(a1, a2, b1, b2)) return 0;
  return Math.min(
    distancePointToSegment(a1, b1, b2),
    distancePointToSegment(a2, b1, b2),
    distancePointToSegment(b1, a1, a2),
    distancePointToSegment(b2, a1, a2),
  );
}

function simplifyPolyline(points: Point[]): Point[] {
  const deduped = points.filter((point, index) => {
    if (index === 0) return true;
    return distance(point, points[index - 1]!) > 1;
  });

  if (deduped.length <= 2) return deduped;

  const simplified: Point[] = [deduped[0]!];
  for (let i = 1; i < deduped.length - 1; i++) {
    const prev = simplified[simplified.length - 1]!;
    const curr = deduped[i]!;
    const next = deduped[i + 1]!;
    const prevDir = normalize(sub(curr, prev));
    const nextDir = normalize(sub(next, curr));
    const turn = Math.abs(prevDir.x * nextDir.y - prevDir.y * nextDir.x);
    if (turn > 0.04 || distance(prev, curr) > 24) {
      simplified.push(curr);
    }
  }
  simplified.push(deduped[deduped.length - 1]!);
  return simplified;
}

function polylineSegments(points: Point[], edgeId: string): Segment[] {
  const segments: Segment[] = [];
  for (let i = 1; i < points.length; i++) {
    segments.push({ a: points[i - 1]!, b: points[i]!, edgeId });
  }
  return segments;
}

function polylineLength(points: Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += distance(points[i - 1]!, points[i]!);
  }
  return total;
}

function pointAtPolylineFraction(points: Point[], fraction: number): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return points[0]!;

  const total = polylineLength(points);
  if (total <= 0.0001) return points[0]!;

  const target = total * clamp(fraction, 0, 1);
  let walked = 0;

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const segmentLength = distance(a, b);
    if (walked + segmentLength >= target) {
      const t = (target - walked) / Math.max(segmentLength, 0.0001);
      return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
      };
    }
    walked += segmentLength;
  }

  return points[points.length - 1]!;
}

function tangentAtPolylineFraction(points: Point[], fraction: number): Point {
  if (points.length < 2) return { x: 0, y: -1 };

  const total = polylineLength(points);
  if (total <= 0.0001) return normalize(sub(points[1]!, points[0]!));

  const target = total * clamp(fraction, 0, 1);
  let walked = 0;

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const segmentLength = distance(a, b);
    if (walked + segmentLength >= target) {
      return normalize(sub(b, a));
    }
    walked += segmentLength;
  }

  return normalize(sub(points[points.length - 1]!, points[points.length - 2]!));
}

function buildPolylinePath(points: Point[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0]!.x} ${points[0]!.y}`;
  if (points.length === 2) return `M ${points[0]!.x} ${points[0]!.y} L ${points[1]!.x} ${points[1]!.y}`;

  // Convert the point list into a smooth cubic Bézier path.
  // For each interior segment we compute control points from the
  // neighbouring points so adjacent segments share tangents → true smooth curve.
  const p = points;
  let d = `M ${p[0]!.x.toFixed(1)} ${p[0]!.y.toFixed(1)}`;

  if (p.length === 3) {
    // Single curve through 3 points: quadratic Bézier
    d += ` Q ${p[1]!.x.toFixed(1)} ${p[1]!.y.toFixed(1)} ${p[2]!.x.toFixed(1)} ${p[2]!.y.toFixed(1)}`;
    return d;
  }

  // Catmull-Rom → cubic Bézier conversion (tension 0.5)
  // For each segment i → i+1 the control points are derived from neighbours.
  const cp = (tension: number, a: Point, b: Point, c: Point, d2: Point) => ({
    cp1: { x: b.x + (c.x - a.x) * tension, y: b.y + (c.y - a.y) * tension },
    cp2: { x: c.x - (d2.x - b.x) * tension, y: c.y - (d2.y - b.y) * tension },
  });
  const tension = 0.48;  // higher tension → fuller, rounder Bézier arcs

  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[Math.max(0, i - 1)]!;
    const p1 = p[i]!;
    const p2 = p[i + 1]!;
    const p3 = p[Math.min(p.length - 1, i + 2)]!;
    const { cp1, cp2 } = cp(tension, p0, p1, p2, p3);
    d += ` C ${cp1.x.toFixed(1)} ${cp1.y.toFixed(1)} ${cp2.x.toFixed(1)} ${cp2.y.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}

function buildRouteCandidates(edge: SkillTreeEdge, src: SkillTreeNode, tgt: SkillTreeNode): Point[][] {
  const sourceCenter = getNodeCenter(src);
  const targetCenter = getNodeCenter(tgt);
  const directVector = sub(targetCenter, sourceCenter);
  const dist = Math.max(length(directVector), 1);
  const dir = normalize(directVector);
  const perp = perpendicular(dir);
  const verticalish = Math.abs(directVector.x) < 56;
  const seed = hashString(`${edge.id}:${edge.sourceNodeId}:${edge.targetNodeId}`);
  const preferredSide: -1 | 1 =
    Math.abs(directVector.x) >= 18
      ? directVector.x > 0 ? 1 : -1
      : seed % 2 === 0 ? 1 : -1;

  const start = offsetFromNode(src, targetCenter);
  const end = offsetFromNode(tgt, sourceCenter);
  const startToEnd = sub(end, start);
  const trimmedDistance = Math.max(length(startToEnd), 1);
  const verticalDirection = Math.sign(end.y - start.y) || 1;
  const lead = clamp(trimmedDistance * (verticalish ? 0.23 : 0.16), 26, edge.edgeType === "required" ? 76 : 92);
  const baseBend = clamp(
    verticalish ? trimmedDistance * 0.32 : Math.max(Math.abs(directVector.x), Math.abs(directVector.y)) * 0.18,
    edge.edgeType === "required" ? 24 : 32,
    verticalish ? 140 : 112,
  );

  const multipliers = edge.edgeType === "required" ? [0.55, 0.85, 1.2, 1.65, 2.1] : [0.6, 0.95, 1.35, 1.8, 2.3];
  const candidates: Point[][] = [];
  const seen = new Set<string>();

  const pushCandidate = (points: Point[]) => {
    const clean = simplifyPolyline(points);
    if (clean.length < 2) return;
    const key = clean.map((point) => `${Math.round(point.x)}:${Math.round(point.y)}`).join("|");
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(clean);
  };

  // Always offer the straight line first — it wins whenever nothing is in the way.
  pushCandidate([start, end]);

  const slantBias = ((seed % 5) - 2) * 0.16;
  if (!verticalish || Math.abs(directVector.y) < 220) {
    const slantOffset = baseBend * 0.35 * (preferredSide + slantBias);
    pushCandidate([
      start,
      add(start, add(scale(dir, lead * 0.55), scale(perp, slantOffset * 0.55))),
      add(end, add(scale(dir, -lead * 0.55), scale(perp, slantOffset))),
      end,
    ]);
  }

  const routeSides: Array<-1 | 1> = [preferredSide, preferredSide === 1 ? -1 : 1];
  for (const side of routeSides) {
    for (const multiplier of multipliers) {
      const offset = baseBend * multiplier * side;
      const startLead = add(start, add(scale(dir, lead), scale(perp, offset * 0.42)));
      const mid = add(midpoint(start, end), scale(perp, offset));
      const endLead = add(end, add(scale(dir, -lead), scale(perp, offset * 0.58)));
      pushCandidate([start, startLead, mid, endLead, end]);

      // Lane-based routes — effective at bypassing clusters
      if (verticalish || Math.abs(directVector.x) < 150) {
        const laneOffset = clamp(Math.abs(offset) * 1.08, 34, 220) * side;
        pushCandidate([
          start,
          { x: start.x + laneOffset * 0.7, y: start.y + verticalDirection * lead * 0.4 },
          { x: midpoint(start, end).x + laneOffset, y: midpoint(start, end).y },
          { x: end.x + laneOffset * 0.55, y: end.y - verticalDirection * lead * 0.35 },
          end,
        ]);
      }

      // Wide-arc bypass — routes well clear of dense node clusters
      const wideOffset = clamp(Math.abs(offset) * 1.5, 60, 280) * side;
      pushCandidate([
        start,
        { x: start.x + wideOffset * 0.45, y: start.y + verticalDirection * lead * 0.55 },
        { x: midpoint(start, end).x + wideOffset, y: midpoint(start, end).y },
        { x: end.x + wideOffset * 0.35, y: end.y - verticalDirection * lead * 0.45 },
        end,
      ]);
    }
  }

  return candidates;
}

function scoreRouteCandidate(
  points: Point[],
  edge: SkillTreeEdge,
  nodes: SkillTreeNode[],
  routedSegments: Segment[],
): number {
  const segments = polylineSegments(points, edge.id);
  // Straight lines (2 points) get a strong preference bonus — no complexity penalty,
  // and a length coefficient half of curved paths. They only lose when blocked.
  const isStraight = points.length <= 2;
  let score = polylineLength(points) * (isStraight ? 0.025 : 0.05) + Math.max(0, points.length - 2) * 8;

  for (const node of nodes) {
    if (node.id === edge.sourceNodeId || node.id === edge.targetNodeId) continue;

    const center = getNodeCenter(node);
    const avoidRadius = getNodeObstacleRadius(node) + NODE_CLEARANCE;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const segment of segments) {
      closestDistance = Math.min(closestDistance, distancePointToSegment(center, segment.a, segment.b));
    }

    if (closestDistance < avoidRadius) {
      // Strong penalty for passing through a node — scale by how deep we penetrate
      score += 9000 + (avoidRadius - closestDistance) * 260;
    } else if (closestDistance < avoidRadius + 36) {
      score += (avoidRadius + 36 - closestDistance) * 38;
    }
  }

  for (const segment of segments) {
    for (const registered of routedSegments) {
      const segmentDistance = distanceBetweenSegments(segment.a, segment.b, registered.a, registered.b);
      if (segmentsIntersect(segment.a, segment.b, registered.a, registered.b)) {
        score += 3800;
      }
      if (segmentDistance < EDGE_CLEARANCE) {
        score += (EDGE_CLEARANCE - segmentDistance + 1) * 200;
      } else if (segmentDistance < EDGE_CLEARANCE + 24) {
        score += (EDGE_CLEARANCE + 24 - segmentDistance) * 14;
      }
    }
  }

  return score;
}

function routeEdge(
  edge: SkillTreeEdge,
  src: SkillTreeNode,
  tgt: SkillTreeNode,
  nodes: SkillTreeNode[],
  routedSegments: Segment[],
): RoutedEdge {
  const candidates = buildRouteCandidates(edge, src, tgt);
  let bestPoints = candidates[0] ?? [getNodeCenter(src), getNodeCenter(tgt)];
  let bestScore = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const score = scoreRouteCandidate(candidate, edge, nodes, routedSegments);
    if (score < bestScore) {
      bestScore = score;
      bestPoints = candidate;
    }
  }

  const path = buildPolylinePath(bestPoints);
  const midPoint = pointAtPolylineFraction(bestPoints, 0.5);
  let labelNormal = normalize(perpendicular(tangentAtPolylineFraction(bestPoints, 0.5)));
  if (labelNormal.y > 0) labelNormal = scale(labelNormal, -1);
  const labelPoint = add(midPoint, scale(labelNormal, 12));

  return {
    d: path,
    midPoint,
    labelPoint,
    segments: polylineSegments(bestPoints, edge.id),
  };
}

function buildRubberBandPath(fromNode: SkillTreeNode, target: Point): string {
  const start = offsetFromNode(fromNode, target);
  return buildPolylinePath([start, target]);
}

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

  const sortedEdges = [...edges].sort(
    (a, b) => (DRAW_ORDER[a.edgeType] ?? 0) - (DRAW_ORDER[b.edgeType] ?? 0),
  );

  const routedSegments: Segment[] = [];
  const routedEdgeMap = new Map<string, RoutedEdge>();
  const edgesForRouting = [...edges].sort(
    (a, b) => (ROUTE_ORDER[a.edgeType] ?? 99) - (ROUTE_ORDER[b.edgeType] ?? 99),
  );

  for (const edge of edgesForRouting) {
    const src = nodeMap.get(edge.sourceNodeId);
    const tgt = nodeMap.get(edge.targetNodeId);
    if (!src || !tgt) continue;
    const route = routeEdge(edge, src, tgt, nodes, routedSegments);
    routedEdgeMap.set(edge.id, route);
    routedSegments.push(...route.segments);
  }

  return (
    <>
      <style>{`
        @keyframes dash-flow { to { stroke-dashoffset: -18; } }
        .rubber-band { animation: dash-flow 0.4s linear infinite; }
      `}</style>

      {sortedEdges.map((edge) => {
        const src = nodeMap.get(edge.sourceNodeId);
        const tgt = nodeMap.get(edge.targetNodeId);
        if (!src || !tgt) return null;

        const route = routedEdgeMap.get(edge.id);
        if (!route) return null;

        const style = EDGE_STYLE[edge.edgeType as keyof typeof EDGE_STYLE] ?? EDGE_STYLE.required;
        const baseColor = style.colorOverride ?? RAMP_COLORS[src.colorRamp] ?? RAMP_COLORS.blue;

        const isSelected    = selectedEdgeId === edge.id;
        const isHighlighted = highlightedEdgeIds?.has(edge.id) ?? false;
        const isFork        = edge.edgeType === "fork";

        const strokeWidth = isSelected
          ? style.strokeWidth + 2
          : isHighlighted
          ? style.strokeWidth + 1
          : style.strokeWidth;

        const dimOpacity =
          hasHighlight && !isHighlighted && !isSelected ? 0.08 : style.opacity;

        const handleClick = editMode
          ? (e: React.MouseEvent) => { e.stopPropagation(); onEdgeClick(edge.id); }
          : undefined;

        const btMidX = route.midPoint.x;
        const btMidY = route.midPoint.y;

        return (
          <g key={edge.id} opacity={dimOpacity} style={{ transition: "opacity 0.2s" }}>
            <path
              d={route.d}
              fill="none"
              stroke={baseColor}
              strokeWidth={strokeWidth}
              strokeDasharray={style.dasharray}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={isSelected ? 1 : isHighlighted ? 0.96 : 0.92}
              style={{ pointerEvents: "none" }}
            />
            <path
              d={route.d}
              fill="none"
              stroke="transparent"
              strokeWidth={14}
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ cursor: editMode ? "pointer" : "default" }}
              onClick={handleClick}
            />

            {isFork && !editMode ? (
              <g transform={`translate(${btMidX} ${btMidY})`} style={{ pointerEvents: "none" }}>
                <polygon
                  points="0,-6 6,0 0,6 -6,0"
                  fill="#ef9f27"
                  opacity={0.9}
                />
                <text
                  fontSize={7}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fill="white"
                  fontWeight="700"
                  style={{ userSelect: "none" }}
                >
                  ⑂
                </text>
              </g>
            ) : null}

            {null /* optional/bonus edge labels removed — they overlapped node text */}

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

      {connectingFromId && rubberBandEnd ? (() => {
        const fromNode = nodeMap.get(connectingFromId);
        if (!fromNode) return null;
        return (
          <path
            d={buildRubberBandPath(fromNode, rubberBandEnd)}
            fill="none"
            stroke="#378add"
            strokeDasharray="6 3"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.8}
            className="rubber-band"
            style={{ pointerEvents: "none" }}
          />
        );
      })() : null}
    </>
  );
}
