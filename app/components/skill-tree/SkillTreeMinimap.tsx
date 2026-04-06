import { useEffect, useRef } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

export type MinimapNode = {
  id: string;
  positionX: number;
  positionY: number;
};

export type MinimapProgress = {
  nodeId: string;
  status: string;
};

export type Viewport = {
  x: number;
  y: number;
  scale: number;
};

type Props = {
  nodes: MinimapNode[];
  progressMap: Map<string, MinimapProgress>;
  viewport: Viewport;
  onViewportChange: (x: number, y: number) => void;
};

// ── Status colors ─────────────────────────────────────────────────────────────

const STATUS_DOT_COLOR: Record<string, string> = {
  complete:    "#1d9e75",
  mastery:     "#ef9f27",
  available:   "#378add",
  in_progress: "#7f77dd",
  locked:      "#d3d1c7",
};

const W = 120;
const H = 80;
// Assumed visible area for viewport rect estimation
const ASSUMED_SCREEN_W = 900;
const ASSUMED_SCREEN_H = 600;

// ── Component ─────────────────────────────────────────────────────────────────

export function SkillTreeMinimap({ nodes, progressMap, viewport, onViewportChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, W, H);

    if (nodes.length === 0) return;

    // Bounding box with padding
    const pad = 40;
    const xs = nodes.map((n) => n.positionX);
    const ys = nodes.map((n) => n.positionY);
    const minX = Math.min(...xs) - pad;
    const maxX = Math.max(...xs) + pad;
    const minY = Math.min(...ys) - pad;
    const maxY = Math.max(...ys) + pad;

    const worldW = maxX - minX || 1;
    const worldH = maxY - minY || 1;
    const scaleX = W / worldW;
    const scaleY = H / worldH;
    const mapScale = Math.min(scaleX, scaleY);

    const offsetX = (W - worldW * mapScale) / 2 - minX * mapScale;
    const offsetY = (H - worldH * mapScale) / 2 - minY * mapScale;

    const toMiniX = (wx: number) => wx * mapScale + offsetX;
    const toMiniY = (wy: number) => wy * mapScale + offsetY;

    // Draw node dots
    for (const node of nodes) {
      const p = progressMap.get(node.id);
      const status = p?.status ?? "locked";
      ctx.beginPath();
      ctx.arc(toMiniX(node.positionX), toMiniY(node.positionY), 3, 0, Math.PI * 2);
      ctx.fillStyle = STATUS_DOT_COLOR[status] ?? STATUS_DOT_COLOR.locked;
      ctx.fill();
    }

    // Draw viewport rectangle
    const vpLeft   = -viewport.x / viewport.scale;
    const vpTop    = -viewport.y / viewport.scale;
    const vpRight  = vpLeft + ASSUMED_SCREEN_W / viewport.scale;
    const vpBottom = vpTop  + ASSUMED_SCREEN_H / viewport.scale;

    const rx = toMiniX(vpLeft);
    const ry = toMiniY(vpTop);
    const rw = (vpRight - vpLeft) * mapScale;
    const rh = (vpBottom - vpTop) * mapScale;

    ctx.save();
    ctx.fillStyle = "rgba(55, 138, 221, 0.1)";
    ctx.fillRect(rx, ry, rw, rh);
    ctx.strokeStyle = "rgba(0,0,0,0.4)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(rx, ry, rw, rh);
    ctx.restore();
  }, [nodes, progressMap, viewport]);

  function handleClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas || nodes.length === 0) return;

    const rect = canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    // Reconstruct mapScale/offsets (same logic as draw)
    const pad = 40;
    const xs = nodes.map((n) => n.positionX);
    const ys = nodes.map((n) => n.positionY);
    const minX = Math.min(...xs) - pad;
    const maxX = Math.max(...xs) + pad;
    const minY = Math.min(...ys) - pad;
    const maxY = Math.max(...ys) + pad;

    const worldW = maxX - minX || 1;
    const worldH = maxY - minY || 1;
    const mapScale = Math.min(W / worldW, H / worldH);

    const offsetX = (W - worldW * mapScale) / 2 - minX * mapScale;
    const offsetY = (H - worldH * mapScale) / 2 - minY * mapScale;

    // Convert click to world coords
    const worldX = (clickX - offsetX) / mapScale;
    const worldY = (clickY - offsetY) / mapScale;

    // Center viewport on that world point (assuming viewport scale stays same)
    const newX = -(worldX * viewport.scale) + ASSUMED_SCREEN_W / 2;
    const newY = -(worldY * viewport.scale) + ASSUMED_SCREEN_H / 2;

    onViewportChange(newX, newY);
  }

  return (
    <div className="absolute bottom-4 right-4 z-10 overflow-hidden rounded-lg border border-slate-300 bg-white shadow-md">
      <canvas
        ref={canvasRef}
        width={W}
        height={H}
        style={{ display: "block", cursor: "pointer" }}
        onClick={handleClick}
        title="Click to pan to location"
      />
    </div>
  );
}
