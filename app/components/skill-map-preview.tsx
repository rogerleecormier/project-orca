const PALETTE = {
  blue: "#378add",
  teal: "#1d9e75",
  purple: "#7f77dd",
  amber: "#ef9f27",
  paper: "#fffaf1",
  ink: "#213044",
  muted: "#857d72",
  line: "#d7cfbf",
};

type PreviewProps = {
  className?: string;
  toolbarLabel?: string;
  showLegend?: boolean;
};

type PreviewNode = {
  id: string;
  label: string;
  x: number;
  y: number;
  r: number;
  tone: keyof typeof PALETTE;
  shape: "circle" | "hex" | "diamond";
  icon: string;
  optional?: boolean;
  start?: boolean;
  goal?: boolean;
};

type PreviewEdge = {
  id: string;
  stroke: string;
  dash?: string;
  label?: string;
  points: Array<{ x: number; y: number }>;
};

const NODES: PreviewNode[] = [
  { id: "start", label: "Orientation", x: 134, y: 52, r: 17, tone: "teal", shape: "circle", icon: "O", start: true },
  { id: "foundation", label: "Foundation", x: 134, y: 116, r: 17, tone: "blue", shape: "circle", icon: "F" },
  { id: "weaving", label: "Skill Weaving", x: 134, y: 188, r: 28, tone: "teal", shape: "hex", icon: "S" },
  { id: "transfer", label: "Creative Transfer", x: 134, y: 278, r: 18, tone: "blue", shape: "circle", icon: "T" },
  { id: "goal", label: "Mastery Boss", x: 134, y: 356, r: 30, tone: "teal", shape: "diamond", icon: "M", goal: true },
  { id: "studio", label: "Applied Studio", x: 312, y: 142, r: 12, tone: "purple", shape: "circle", icon: "A", optional: true },
  { id: "lab", label: "Project Lab", x: 348, y: 220, r: 12, tone: "amber", shape: "circle", icon: "P", optional: true },
  { id: "strategy", label: "Strategy Branch", x: 292, y: 292, r: 12, tone: "purple", shape: "circle", icon: "S", optional: true },
  { id: "branch", label: "Creative Branch", x: 356, y: 334, r: 12, tone: "amber", shape: "circle", icon: "C", optional: true },
];

const EDGES: PreviewEdge[] = [
  { id: "e1", stroke: PALETTE.teal, points: [{ x: 134, y: 69 }, { x: 134, y: 99 }] },
  { id: "e2", stroke: PALETTE.blue, points: [{ x: 134, y: 133 }, { x: 134, y: 160 }] },
  { id: "e3", stroke: PALETTE.teal, points: [{ x: 134, y: 216 }, { x: 134, y: 252 }] },
  { id: "e4", stroke: PALETTE.blue, points: [{ x: 134, y: 296 }, { x: 134, y: 326 }] },
  {
    id: "e5",
    stroke: PALETTE.teal,
    dash: "8 6",
    label: "+XP",
    points: [{ x: 151, y: 116 }, { x: 222, y: 128 }, { x: 300, y: 142 }],
  },
  {
    id: "e6",
    stroke: PALETTE.teal,
    dash: "8 6",
    label: "+XP",
    points: [{ x: 162, y: 188 }, { x: 230, y: 220 }, { x: 336, y: 220 }],
  },
  {
    id: "e7",
    stroke: PALETTE.blue,
    dash: "8 6",
    label: "+XP",
    points: [{ x: 152, y: 278 }, { x: 230, y: 306 }, { x: 280, y: 292 }],
  },
  {
    id: "e8",
    stroke: PALETTE.purple,
    dash: "8 6",
    points: [{ x: 304, y: 300 }, { x: 344, y: 326 }],
  },
];

function hexagonPoints(cx: number, cy: number, r: number): string {
  return Array.from({ length: 6 }, (_, i) => {
    const angle = (i * 60 - 90) * (Math.PI / 180);
    return `${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`;
  }).join(" ");
}

function diamondPoints(cx: number, cy: number, r: number): string {
  return `${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`;
}

function starPoints(cx: number, cy: number, outerRadius: number, innerRadius: number): string {
  return Array.from({ length: 10 }, (_, i) => {
    const angle = (-90 + i * 36) * (Math.PI / 180);
    const radius = i % 2 === 0 ? outerRadius : innerRadius;
    return `${cx + radius * Math.cos(angle)},${cy + radius * Math.sin(angle)}`;
  }).join(" ");
}

function linePath(points: PreviewEdge["points"]): string {
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
}

export function SkillMapPreview({ className = "", toolbarLabel = "Skill Map Builder", showLegend = true }: PreviewProps) {
  return (
    <div className={`skill-map-preview ${className}`.trim()}>
      <div className="absolute left-4 top-4 z-10 rounded-full border border-[rgba(90,139,184,0.35)] bg-white/85 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--orca-map-muted)]">
        {toolbarLabel}
      </div>

      <svg viewBox="0 0 420 400" className="relative z-[1] h-full w-full" aria-hidden="true">
        <g>
          {EDGES.map((edge) => {
            const lastPoint = edge.points[edge.points.length - 1]!;
            const labelPoint = edge.points[Math.max(0, edge.points.length - 2)]!;
            return (
              <g key={edge.id}>
                <path
                  d={linePath(edge.points)}
                  fill="none"
                  stroke={edge.stroke}
                  strokeWidth={edge.dash ? 2.2 : 2.8}
                  strokeDasharray={edge.dash}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity={0.9}
                />
                {edge.label ? (
                  <text
                    x={labelPoint.x + 10}
                    y={labelPoint.y - 8}
                    fontSize={9}
                    fill={edge.stroke}
                    opacity={0.8}
                    style={{ userSelect: "none" }}
                  >
                    {edge.label}
                  </text>
                ) : null}
                <circle cx={lastPoint.x} cy={lastPoint.y} r={1.8} fill={edge.stroke} opacity={0.55} />
              </g>
            );
          })}
        </g>

        <g>
          {NODES.map((node) => {
            const color = PALETTE[node.tone];
            const shapeProps = {
              fill: PALETTE.paper,
              stroke: color,
              strokeWidth: node.shape === "circle" ? 2.4 : 2.8,
              strokeDasharray: node.optional ? "4 4" : undefined,
            };

            return (
              <g key={node.id}>
                {node.start || node.goal ? (
                  <polygon
                    points={starPoints(node.x, node.y, node.r + 16, node.r + 9)}
                    fill={node.goal ? "rgba(239,159,39,0.15)" : "rgba(243,196,81,0.18)"}
                    stroke={node.goal ? PALETTE.amber : "#f3c451"}
                    strokeWidth={1.4}
                  />
                ) : null}

                {node.shape === "hex" ? (
                  <polygon points={hexagonPoints(node.x, node.y, node.r)} {...shapeProps} />
                ) : node.shape === "diamond" ? (
                  <polygon points={diamondPoints(node.x, node.y, node.r)} {...shapeProps} />
                ) : (
                  <circle cx={node.x} cy={node.y} r={node.r} {...shapeProps} />
                )}

                {node.shape === "hex" ? (
                  <polygon
                    points={hexagonPoints(node.x, node.y, node.r - 8)}
                    fill={color}
                    fillOpacity={0.12}
                    stroke="none"
                  />
                ) : node.shape === "diamond" ? (
                  <polygon
                    points={diamondPoints(node.x, node.y, node.r - 8)}
                    fill={color}
                    fillOpacity={0.12}
                    stroke="none"
                  />
                ) : (
                  <circle cx={node.x} cy={node.y} r={Math.max(8, node.r - 6)} fill={color} fillOpacity={0.12} />
                )}

                <text
                  x={node.x}
                  y={node.y}
                  fontSize={node.optional ? 10 : 12}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fill={color}
                  fontWeight="700"
                  style={{ userSelect: "none" }}
                >
                  {node.icon}
                </text>

                {node.start ? (
                  <g transform={`translate(${node.x} ${node.y - node.r - 26})`}>
                    <rect x={-30} y={-10} width={60} height={20} rx={10} fill="#eaf8ff" stroke="#67b9df" strokeWidth={1.2} />
                    <text x={0} y={0} fontSize={9} textAnchor="middle" dominantBaseline="central" fill="#1f628a" fontWeight="700">★ START</text>
                  </g>
                ) : null}

                {node.goal ? (
                  <g transform={`translate(${node.x} ${node.y + node.r + 26})`}>
                    <rect x={-28} y={-10} width={56} height={20} rx={10} fill="#e2f2fe" stroke="#2a77af" strokeWidth={1.2} />
                    <text x={0} y={0} fontSize={9} textAnchor="middle" dominantBaseline="central" fill="#1a4f78" fontWeight="700">★ GOAL</text>
                  </g>
                ) : null}

                <text
                  x={node.x}
                  y={node.y + node.r + (node.goal ? 30 : 18)}
                  fontSize={node.optional ? 9 : 10}
                  textAnchor="middle"
                  fill={PALETTE.muted}
                  style={{ userSelect: "none" }}
                >
                  {node.label}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      {showLegend ? (
        <div className="absolute bottom-4 right-4 z-10 flex flex-col gap-1 rounded-2xl border border-[rgba(90,139,184,0.3)] bg-white/86 px-3 py-2 text-[11px] text-[var(--orca-map-muted)] shadow-[0_16px_36px_rgba(22,32,50,0.08)] backdrop-blur-sm">
          <div className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-[var(--orca-sea)]" /> Required path</div>
          <div className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-[#7f77dd]" /> Optional branch</div>
          <div className="flex items-center gap-2"><span className="text-[10px]">★</span> Start and goal markers</div>
        </div>
      ) : null}
    </div>
  );
}
