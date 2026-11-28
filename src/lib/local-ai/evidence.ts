// Evidence viewer maths and types. Pure functions only, so they can be tested without a browser.
// Every value comes from the backend JSON files (image pixels, frame indices, seconds). The browser only does
// geometry for display: frame and time conversion, box lookup, timeline spans and the court outline.

export const COURT_WIDTH_M = 6.1; // doubles width, the template used for calibration
export const COURT_LENGTH_M = 13.4;
export const NET_Y_M = 6.7;

export const IDENTITY_COLOURS: Record<string, string> = {
  P1: "#ff8c00",
  P2: "#00d7ff",
  P3: "#50dc50",
  P4: "#ff50ff",
};

export const STATUS_COLOURS: Record<string, string> = {
  matched: "#2ecc71",
  recovered: "#1abc9c",
  lost: "#7f8c8d",
  uncertain: "#f39c12",
  manual: "#9b59b6",
  not_initialised: "#d5d8dc",
};

/** Events that mark a change in identity evidence on the timeline. */
export const MARKER_KINDS = [
  "identity_lost",
  "identity_recovered",
  "identity_uncertain",
  "identity_switch_suspected",
  "side_change",
] as const;

export type PlayerObservation = {
  frame: number;
  time_s: number | null;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  score: number;
  confirmed: boolean;
  identity: string | null;
  identity_status: string | null;
  identity_confidence: number | null;
  court_x_m?: number;
  court_y_m?: number;
};

export type PlayerTrack = { track_id: number; confirmed: boolean; observations: PlayerObservation[] };

export type PlayerTracksFile = {
  fps: number;
  mode: string;
  logical_identities: number;
  source_width: number;
  source_height: number;
  tracks: PlayerTrack[];
};

export type IdentityEvent = {
  frame: number;
  time_s: number | null;
  kind: string;
  identity: string;
  track_id: number | null;
  confidence: number | null;
  message: string;
};

export type IdentitySegment = {
  status: string;
  start_frame: number;
  end_frame: number;
  start_s: number | null;
  end_s: number | null;
};

export type IdentityEventsFile = {
  fps: number;
  mode: string;
  logical_identities: number;
  event_counts: Record<string, number>;
  events: IdentityEvent[];
  segments: Record<string, IdentitySegment[]>;
};

export type RallyCandidate = {
  index: number;
  start_frame: number;
  end_frame: number;
  start_s: number;
  end_s: number;
  duration_s: number;
  detected_shuttle_frames: number;
  status: string;
  validated: boolean;
  method: string;
  evaluation: string;
};

export type RalliesFile = {
  fps: number;
  status: string;
  validated: boolean;
  evaluation: string;
  count: number;
  rallies: RallyCandidate[];
};

export type CorrectionType = "identity" | "court_calibration" | "mode";

export type CorrectionEntry = {
  id: string;
  type: CorrectionType | string;
  created_at: number;
  track_id?: number;
  identity?: string;
  start_frame?: number;
  end_frame?: number;
  corners_px?: number[][];
  mode?: string;
  note?: string;
};

/** One frame of shuttle_trajectory.json (image pixels). */
export type TrajectoryFrameLike = {
  frame: number;
  x: number | null;
  y: number | null;
  visible: boolean;
  confidence: number;
  refined: boolean;
};

export type TrackBox = {
  trackId: number;
  identity: string | null;
  status: string | null;
  confidence: number | null;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export type TimelineSpan = { startFraction: number; endFraction: number; status: string };

/** Map a time in seconds to the nearest frame index, clamped to the analysed frames. */
export function frameAtTime(seconds: number, fps: number, totalFrames: number): number {
  if (!Number.isFinite(seconds) || !Number.isFinite(fps) || fps <= 0 || totalFrames <= 0) return 0;
  return Math.min(totalFrames - 1, Math.max(0, Math.round(seconds * fps)));
}

export function timeAtFrame(frame: number, fps: number): number {
  return fps > 0 ? frame / fps : 0;
}

export type TransportKey = { kind: "step"; delta: number } | { kind: "toggle" } | { kind: "jump"; to: "start" | "end" };

/**
 * Maps a keyboard key to a transport action: arrows step one frame, Shift+arrow five frames,
 * Space toggles play, Home/End jump to the first/last frame. Other keys and modified chords
 * (Ctrl, Alt, Meta) return null so browser shortcuts keep working.
 */
export function transportKeyAction(key: string, modifiers: { shift?: boolean; ctrl?: boolean; alt?: boolean; meta?: boolean } = {}): TransportKey | null {
  if (modifiers.ctrl || modifiers.alt || modifiers.meta) return null;
  if (key === "ArrowLeft") return { kind: "step", delta: modifiers.shift ? -5 : -1 };
  if (key === "ArrowRight") return { kind: "step", delta: modifiers.shift ? 5 : 1 };
  if (key === " " || key === "Spacebar") return modifiers.shift ? null : { kind: "toggle" };
  if (key === "Home") return { kind: "jump", to: "start" };
  if (key === "End") return { kind: "jump", to: "end" };
  return null;
}

/** "3.47 s · frame 104" for the readout under the videos. */
export function formatFrameTime(frame: number, fps: number): string {
  return `${timeAtFrame(frame, fps).toFixed(2)} s · frame ${frame}`;
}

/** Index of boxes per frame, built once when the tracks load. */
export function indexBoxesByFrame(tracks: PlayerTrack[]): Map<number, TrackBox[]> {
  const index = new Map<number, TrackBox[]>();
  for (const track of tracks) {
    for (const observation of track.observations) {
      const box: TrackBox = {
        trackId: track.track_id,
        identity: observation.identity,
        status: observation.identity_status,
        confidence: observation.identity_confidence,
        x1: observation.x1,
        y1: observation.y1,
        x2: observation.x2,
        y2: observation.y2,
      };
      const list = index.get(observation.frame);
      if (list) list.push(box);
      else index.set(observation.frame, [box]);
    }
  }
  return index;
}

/** The smallest box that contains the point, so that a click picks the player in front. */
export function hitTestBox(boxes: TrackBox[], x: number, y: number): TrackBox | null {
  let best: TrackBox | null = null;
  let bestArea = Number.POSITIVE_INFINITY;
  for (const box of boxes) {
    if (x < box.x1 || x > box.x2 || y < box.y1 || y > box.y2) continue;
    const area = (box.x2 - box.x1) * (box.y2 - box.y1);
    if (area < bestArea) {
      best = box;
      bestArea = area;
    }
  }
  return best;
}

export function identityColour(identity: string | null | undefined): string {
  return (identity && IDENTITY_COLOURS[identity]) || "#b0b8c4";
}

export function statusColour(status: string | null | undefined): string {
  return (status && STATUS_COLOURS[status]) || "#b0b8c4";
}

/** Timeline spans for one identity, as fractions of the analysed duration. */
export function identitySpans(segments: IdentitySegment[], totalFrames: number): TimelineSpan[] {
  if (totalFrames <= 0) return [];
  return segments.map((segment) => ({
    startFraction: Math.max(0, segment.start_frame / totalFrames),
    endFraction: Math.min(1, (segment.end_frame + 1) / totalFrames),
    status: segment.status,
  }));
}

export function markerEvents(events: IdentityEvent[]): IdentityEvent[] {
  return events.filter((event) => (MARKER_KINDS as readonly string[]).includes(event.kind));
}

/** Image-pixel points of the court outline: four corners and the two net ends. Null without calibration. */
export function courtOutline(homography: number[][] | null | undefined): Array<[number, number]> | null {
  if (!homography || homography.length !== 3 || homography.some((row) => row.length !== 3)) return null;
  const template: Array<[number, number]> = [
    [0, 0],
    [COURT_WIDTH_M, 0],
    [COURT_WIDTH_M, COURT_LENGTH_M],
    [0, COURT_LENGTH_M],
    [0, NET_Y_M],
    [COURT_WIDTH_M, NET_Y_M],
  ];
  const h = homography;
  const points: Array<[number, number]> = [];
  for (const [x, y] of template) {
    const w = h[2][0] * x + h[2][1] * y + h[2][2];
    if (Math.abs(w) < 1e-9) return null;
    points.push([(h[0][0] * x + h[0][1] * y + h[0][2]) / w, (h[1][0] * x + h[1][1] * y + h[1][2]) / w]);
  }
  return points;
}

export type IdentityDraft = {
  trackId: number | null;
  identity: string;
  startFrame: number;
  endFrame: number;
};

export type DraftError = "track" | "identity" | "interval";

/** The same rules as the backend (corrections.validate), so that the form can explain a rejection before saving. */
export function validateIdentityDraft(draft: IdentityDraft, players: number, totalFrames: number): DraftError | null {
  if (draft.trackId === null || !Number.isInteger(draft.trackId) || draft.trackId < 0) return "track";
  const allowed = players === 4 ? ["P1", "P2", "P3", "P4"] : ["P1", "P2"];
  if (!allowed.includes(draft.identity)) return "identity";
  const { startFrame, endFrame } = draft;
  if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame)) return "interval";
  if (startFrame < 0 || endFrame < startFrame || endFrame >= totalFrames) return "interval";
  return null;
}

/** A frame interval of +/- radius frames around a frame, clamped to the video. */
export function intervalAround(frame: number, radius: number, totalFrames: number): { start: number; end: number } {
  const start = Math.max(0, frame - radius);
  const end = Math.max(start, Math.min(totalFrames - 1, frame + radius));
  return { start, end };
}

export function countCorrectionsByType(entries: CorrectionEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) counts[entry.type] = (counts[entry.type] ?? 0) + 1;
  return counts;
}

/** Share of analysed frames in which an identity is matched, recovered or manual. Null when nothing is measured. */
export function identityCoverage(segments: IdentitySegment[], totalFrames: number): number | null {
  if (totalFrames <= 0) return null;
  const covered = segments
    .filter((segment) => segment.status === "matched" || segment.status === "recovered" || segment.status === "manual")
    .reduce((sum, segment) => sum + (segment.end_frame - segment.start_frame + 1), 0);
  return Math.round((covered / totalFrames) * 1000) / 1000;
}
