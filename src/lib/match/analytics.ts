// Match dashboard maths: court geometry, frame and time sync, positions, the current shot and the speed label.
// Pure functions over the backend's match document, so they are tested without a browser. No runtime imports.
import type { MatchDocument, MatchRally, MatchShot, PositionPoint } from "./types";

/** The product taxonomy: six strokes plus Unknown. Serve, push and defensive block are not product classes. */
export const SHOT_TYPES = [
  "smash",
  "clear",
  "drop",
  "drive",
  "net_shot",
  "lift",
  "unknown",
] as const;
export type ShotType = (typeof SHOT_TYPES)[number];

/** Labels from before the taxonomy was narrowed. They are shown as Unknown, never as a stroke. */
const LEGACY_SHOT_TYPES = new Set(["push", "defensive_block", "serve"]);

/** The product type for a stored value: a legacy label becomes Unknown. */
export function productShotType(value: string): ShotType {
  if (LEGACY_SHOT_TYPES.has(value)) return "unknown";
  return isShotType(value) ? value : "unknown";
}

/** Badminton court in metres (BWF): x across the court, y along it, origin at one corner of the doubles court. */
export const COURT_M = {
  length: 13.4,
  doublesWidth: 6.1,
  singlesWidth: 5.18,
  singlesInset: 0.46,
  net: 6.7,
  shortServiceFromNet: 1.98,
  longServiceDoublesFromBack: 0.76,
} as const;

export type CourtSegment = { x1: number; y1: number; x2: number; y2: number; kind: "boundary" | "singles" | "service" | "centre" | "net" };

export function courtLines(): CourtSegment[] {
  const { length, doublesWidth: w, singlesInset: inset, net, shortServiceFromNet: ss, longServiceDoublesFromBack: ls } = COURT_M;
  const centre = w / 2;
  return [
    { x1: 0, y1: 0, x2: w, y2: 0, kind: "boundary" },
    { x1: w, y1: 0, x2: w, y2: length, kind: "boundary" },
    { x1: w, y1: length, x2: 0, y2: length, kind: "boundary" },
    { x1: 0, y1: length, x2: 0, y2: 0, kind: "boundary" },
    { x1: inset, y1: 0, x2: inset, y2: length, kind: "singles" },
    { x1: w - inset, y1: 0, x2: w - inset, y2: length, kind: "singles" },
    { x1: 0, y1: net - ss, x2: w, y2: net - ss, kind: "service" },
    { x1: 0, y1: net + ss, x2: w, y2: net + ss, kind: "service" },
    { x1: 0, y1: ls, x2: w, y2: ls, kind: "service" },
    { x1: 0, y1: length - ls, x2: w, y2: length - ls, kind: "service" },
    { x1: centre, y1: 0, x2: centre, y2: net - ss, kind: "centre" },
    { x1: centre, y1: net + ss, x2: centre, y2: length, kind: "centre" },
    { x1: 0, y1: net, x2: w, y2: net, kind: "net" },
  ];
}

export type CourtView = { width: number; height: number; padding: number };

export function courtScale(view: CourtView): number {
  return Math.max(0, Math.min((view.width - 2 * view.padding) / COURT_M.doublesWidth, (view.height - 2 * view.padding) / COURT_M.length));
}

/** Court metres to view pixels, centred, with the same scale on both axes so the court keeps its proportions. */
export function courtToView(xM: number, yM: number, view: CourtView): { x: number; y: number } {
  const scale = courtScale(view);
  const offsetX = (view.width - COURT_M.doublesWidth * scale) / 2;
  const offsetY = (view.height - COURT_M.length * scale) / 2;
  return { x: offsetX + xM * scale, y: offsetY + yM * scale };
}

/** The frame shown at a video time. Floors so that a frame is shown for its whole duration; clamped to the clip. */
export function frameAt(seconds: number, fps: number, totalFrames: number | null): number {
  if (!Number.isFinite(seconds) || !Number.isFinite(fps) || fps <= 0) return 0;
  const frame = Math.floor(seconds * fps + 1e-6);
  const last = totalFrames && totalFrames > 0 ? totalFrames - 1 : Number.MAX_SAFE_INTEGER;
  return Math.min(Math.max(frame, 0), last);
}

/** The video time to seek to for a frame: its middle, so that the browser lands on that frame and not the one before. */
export function seekTimeFor(frame: number, fps: number): number {
  return fps > 0 ? (frame + 0.5) / fps : 0;
}

export function rallyAt(rallies: MatchRally[], frame: number): MatchRally | null {
  return rallies.find((rally) => rally.start_frame <= frame && frame <= rally.end_frame) ?? null;
}

export function rallyClock(rally: MatchRally, frame: number, fps: number): number {
  return fps > 0 ? Math.max(0, (Math.min(frame, rally.end_frame) - rally.start_frame) / fps) : 0;
}

/** The last position sample at or before the frame, if it is at most maxGap frames old. */
export function pointAt(series: PositionPoint[], frame: number, maxGap: number): PositionPoint | null {
  let low = 0;
  let high = series.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (series[middle][0] <= frame) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (found < 0) return null;
  const point = series[found];
  return frame - point[0] <= maxGap ? point : null;
}

/** Court positions (metres) of the last `seconds` up to the frame. Samples without metres are skipped. */
export function trail(series: PositionPoint[], frame: number, seconds: number, fps: number): Array<{ x: number; y: number }> {
  const start = frame - seconds * fps;
  const points: Array<{ x: number; y: number }> = [];
  for (const [pointFrame, x, y] of series) {
    if (pointFrame > frame) break;
    if (pointFrame >= start && x !== null && y !== null) points.push({ x, y });
  }
  return points;
}

export type TrackingState = "tracked" | "uncertain" | "lost";

export function trackingState(series: PositionPoint[], frame: number, stepFrames: number): TrackingState {
  const point = pointAt(series, frame, Math.max(1, stepFrames) * 2);
  if (!point) return "lost";
  return point[3] === "uncertain" ? "uncertain" : "tracked";
}

/** The most recent counted shot, shown for `holdSeconds` after its contact frame. */
export function shotAt(shots: MatchShot[], frame: number, fps: number, holdSeconds = 1.2): MatchShot | null {
  let current: MatchShot | null = null;
  for (const shot of shots) {
    if (shot.frame > frame) break;
    current = shot;
  }
  if (!current || fps <= 0) return null;
  return (frame - current.frame) / fps <= holdSeconds ? current : null;
}

/** Contacts per player up to the frame: inside the current rally when there is one, otherwise since the start. */
export function hitsSoFar(shots: MatchShot[], players: string[], frame: number, rally: MatchRally | null): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(players.map((player) => [player, 0]));
  for (const shot of shots) {
    if (shot.frame > frame) break;
    if (rally && shot.rally_id !== rally.id) continue;
    if (shot.player && shot.player in counts) counts[shot.player] += 1;
  }
  return counts;
}

/** Racket contacts up to the frame, all players: inside the current rally when there is one, otherwise since the start. */
export function contactsSoFar(shots: MatchShot[], frame: number, rally: MatchRally | null): number {
  let total = 0;
  for (const shot of shots) {
    if (shot.frame > frame) break;
    if (rally && shot.rally_id !== rally.id) continue;
    total += 1;
  }
  return total;
}

/** A measured image-motion rate rounded for display. Null when the backend did not measure one. */
export function motionValue(pxPerSecond: number | null | undefined): number | null {
  return typeof pxPerSecond === "number" && Number.isFinite(pxPerSecond) ? Math.round(pxPerSecond) : null;
}

/** Headline image motion from confirmed contacts only. Automatic candidates never enter it. */
export function confirmedMotionHeadline(shots: ReadonlyArray<Pick<MatchShot, "speed">>): { pxPerSecond: number | null; count: number } {
  let best: number | null = null;
  let count = 0;
  for (const shot of shots) {
    const pxPerSecond = motionValue(shot.speed?.px_per_s);
    if (pxPerSecond === null || shot.speed?.basis !== "confirmed_contact") continue;
    count += 1;
    if (best === null || pxPerSecond > best) best = pxPerSecond;
  }
  return { pxPerSecond: best, count };
}

/** Confirmed image-motion maximum for each logical player. */
export function confirmedMotionByPlayer(
  shots: ReadonlyArray<Pick<MatchShot, "player" | "speed">>,
  players: string[],
): Record<string, number | null> {
  const result: Record<string, number | null> = Object.fromEntries(players.map((player) => [player, null]));
  for (const shot of shots) {
    if (!shot.player || !(shot.player in result) || shot.speed?.basis !== "confirmed_contact") continue;
    const value = motionValue(shot.speed.px_per_s);
    const current = result[shot.player];
    if (value !== null && (current === null || value > current)) result[shot.player] = value;
  }
  return result;
}

export const GROUND_TRUTH_SCHEMA = "smashlab.ground-truth/v1";

/** The trajectory estimate, kept apart from the human label. Null when there is none. */
function trajectoryOf(shot: MatchShot) {
  return shot.trajectory ? { ...shot.trajectory, label_kind: "trajectory_estimate_unverified" } : null;
}

/**
 * Ground-truth export for one analysis. Only human decisions become labels: a shot type is written only when a person
 * set it (type_source "manual"), and contact_status shows whether a person confirmed, rejected or left the candidate.
 * Automatic candidates keep their evidence_source so that a later comparison can separate detection from classification.
 */
export function buildGroundTruth(doc: MatchDocument, jobId: string, exportedAt: string) {
  return {
    schema: GROUND_TRUTH_SCHEMA,
    job_id: jobId,
    exported_at: exportedAt,
    fps: doc.fps,
    players: doc.players,
    note: "Human decisions only. contact_status is confirmed, rejected or candidate. shot_type is null unless a person labelled it.",
    confirmed_rally_boundaries: doc.rallies.items
      .filter((rally) => rally.status === "confirmed")
      .map((rally) => ({ start_frame: rally.start_frame, end_frame: rally.end_frame, set_by: "person" })),
    unmatched_annotations: doc.annotations.unmatched,
    transferred_annotations: doc.annotations.transferred,
    shots: doc.shots.items.map((shot) => ({
      shot_id: shot.id,
      frame: shot.frame,
      time_s: shot.time_s,
      player: shot.player,
      contact_status: shot.contact_status,
      hit_frame: shot.hit_frame ?? null,
      hit_time_s: shot.hit_frame == null ? null : shot.hit_frame / doc.fps,
      trajectory_estimate: trajectoryOf(shot),
      shot_type: shot.type_source === "manual" ? shot.type : null,
      label_source: shot.type_source === "manual" ? "manual" : null,
      candidate_source: shot.evidence_source,
    })),
  };
}

export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "–";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest.toFixed(1).padStart(4, "0")}`;
}

export function isShotType(value: string): value is ShotType {
  return (SHOT_TYPES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Accept only a well-formed match document; anything else makes the dashboard show its unavailable state. */
export function parseMatchDocument(raw: unknown): MatchDocument | null {
  if (!isRecord(raw) || raw.schema !== "smashlab.match/v1") return null;
  const { players, positions, contacts, rallies, shots, summary, speed, court } = raw;
  if (!Array.isArray(players) || !players.every((player) => typeof player === "string")) return null;
  if (!isRecord(positions) || !isRecord(positions.series)) return null;
  if (!isRecord(contacts) || !Array.isArray(contacts.items)) return null;
  if (!isRecord(rallies) || !Array.isArray(rallies.items)) return null;
  if (!isRecord(shots) || !Array.isArray(shots.items)) return null;
  if (!isRecord(summary) || !isRecord(speed) || !isRecord(court)) return null;
  if (typeof raw.fps !== "number" || raw.fps <= 0) return null;
  return raw as unknown as MatchDocument;
}
