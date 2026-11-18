// Canvas drawing for the evidence overlay on the original video. Points are source-image pixels; `scale` maps them
// to the displayed size. The glowing gold shuttle trail follows the backend's annotated video, so both views read alike.
import { identityColour, type TrackBox } from "./evidence";

export type OverlayState = {
  scale: number;
  boxes: TrackBox[];
  selectedTrackId: number | null;
  trail: Array<[number, number]>;
  shuttle: [number, number] | null;
  outline: Array<[number, number]> | null;
  pendingCorners: Array<[number, number]>;
  showOutline: boolean;
  showTrail: boolean;
  labelFor: (box: TrackBox) => string;
};

function traceLine(ctx: CanvasRenderingContext2D, points: Array<[number, number]>): void {
  points.forEach(([x, y], index) => {
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
}

function drawGlowTrail(ctx: CanvasRenderingContext2D, points: Array<[number, number]>): void {
  if (points.length < 2) return;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const [width, alpha] of [
    [12, 0.22],
    [6, 0.45],
  ] as const) {
    ctx.strokeStyle = `rgba(255, 200, 0, ${alpha})`;
    ctx.lineWidth = width;
    ctx.beginPath();
    traceLine(ctx, points);
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  traceLine(ctx, points);
  ctx.stroke();
  ctx.restore();
}

export function drawOverlay(ctx: CanvasRenderingContext2D, state: OverlayState): void {
  const s = state.scale;
  const canvas = ctx.canvas;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const scaled = (points: Array<[number, number]>) => points.map(([x, y]): [number, number] => [x * s, y * s]);

  if (state.showOutline && state.outline && state.outline.length >= 6) {
    const [a, b, c, d, netA, netB] = scaled(state.outline);
    ctx.save();
    ctx.strokeStyle = "rgba(200, 255, 200, 0.85)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    traceLine(ctx, [a, b, c, d, a]);
    ctx.moveTo(netA[0], netA[1]);
    ctx.lineTo(netB[0], netB[1]);
    ctx.stroke();
    ctx.restore();
  }

  if (state.showTrail) drawGlowTrail(ctx, scaled(state.trail));
  if (state.showTrail && state.shuttle) {
    const [x, y] = [state.shuttle[0] * s, state.shuttle[1] * s];
    ctx.save();
    ctx.fillStyle = "rgb(255, 200, 0)";
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  for (const box of state.boxes) {
    const selected = box.trackId === state.selectedTrackId;
    const x = box.x1 * s;
    const y = box.y1 * s;
    const width = (box.x2 - box.x1) * s;
    const height = (box.y2 - box.y1) * s;
    ctx.save();
    ctx.strokeStyle = identityColour(box.identity);
    ctx.lineWidth = selected ? 3.5 : 2;
    if (box.status === "uncertain" || box.status === "lost") ctx.setLineDash([6, 4]);
    ctx.strokeRect(x, y, width, height);
    ctx.setLineDash([]);
    ctx.font = "600 13px system-ui, sans-serif";
    const label = state.labelFor(box);
    const labelWidth = ctx.measureText(label).width + 8;
    ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
    ctx.fillRect(x, Math.max(0, y - 18), labelWidth, 17);
    ctx.fillStyle = identityColour(box.identity);
    ctx.fillText(label, x + 4, Math.max(12, y - 5));
    ctx.restore();
  }

  state.pendingCorners.forEach(([px, py], index) => {
    ctx.save();
    ctx.fillStyle = "rgb(255, 255, 255)";
    ctx.strokeStyle = "rgb(0, 0, 0)";
    ctx.beginPath();
    ctx.arc(px * s, py * s, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgb(0, 0, 0)";
    ctx.font = "700 12px system-ui, sans-serif";
    ctx.fillText(String(index + 1), px * s + 9, py * s - 7);
    ctx.restore();
  });
}
