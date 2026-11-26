// Drawing helpers for the backend's shared observed-2D track (match document `observed_2d`). Display only: the points,
// their sources and runs come from the backend; nothing here filters, smooths or measures.
import type { Observed2DBlock } from "./types";

export type ObservedPoint = Observed2DBlock["points"][number];
export type PathRun = { interpolated: boolean; points: Array<[number, number]> };

/** The points ordered by frame (the backend writes them in order; this keeps the helpers safe if it ever does not). */
export function orderedPoints(observed: Observed2DBlock | null): ObservedPoint[] {
  return observed ? [...observed.points].sort((a, b) => a[0] - b[0]) : [];
}

/**
 * Polylines of the track: one per stretch of the same source inside one backend run. A source change starts the next
 * polyline at the previous point so the path stays joined; a backend run break leaves a gap.
 */
export function observedPathRuns(observed: Observed2DBlock | null): PathRun[] {
  const runs: PathRun[] = [];
  let previous: ObservedPoint | null = null;
  for (const point of orderedPoints(observed)) {
    const interpolated = point[3] === "i";
    const last = runs.at(-1);
    const sameRun = previous !== null && previous[4] === point[4];
    if (sameRun && last && last.interpolated === interpolated) {
      last.points.push([point[1], point[2]]);
    } else if (sameRun && previous) {
      runs.push({ interpolated, points: [[previous[1], previous[2]], [point[1], point[2]]] });
    } else {
      runs.push({ interpolated, points: [[point[1], point[2]]] });
    }
    previous = point;
  }
  return runs;
}

/** An SVG path of a small cross, used for a point the backend removed. */
export function crossPath(x: number, y: number, size: number): string {
  return `M${x - size},${y - size}L${x + size},${y + size}M${x - size},${y + size}L${x + size},${y - size}`;
}

/**
 * The trail the annotated video draws at a frame, from the same track: the last `count` kept points (TrackNet and
 * InpaintNet) of the current backend run. The position marker is drawn only on a frame that has a kept point itself,
 * as in the annotated video. Removed points are never part of the trail; it ends after more than 3 frames without a
 * kept point, and a gap of 5 or more frames or a backend run break starts a new trail.
 */
export function annotatedTrail(
  points: ObservedPoint[],
  frame: number,
  count = 8,
): { trail: Array<[number, number]>; current: [number, number] | null } {
  let end = points.length;
  while (end > 0 && points[end - 1][0] > frame) end -= 1;
  const last = end > 0 ? points[end - 1] : null;
  if (!last || frame - last[0] > 3) return { trail: [], current: null };
  const trail: Array<[number, number]> = [];
  let later = last[0];
  for (let index = end - 1; index >= 0 && trail.length < count; index -= 1) {
    const point = points[index];
    if (point[4] !== last[4] || later - point[0] > 4) break;
    trail.unshift([point[1], point[2]]);
    later = point[0];
  }
  return { trail, current: last[0] === frame ? [last[1], last[2]] : null };
}
