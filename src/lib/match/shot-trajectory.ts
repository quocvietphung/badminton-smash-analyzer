// Display logic for the per-shot trajectory view. Nothing here computes a metric: the sanitized points, their source
// (TrackNet detection or InpaintNet fill), the runs, the rejected points, the tracking checks and the image-space speed
// all come from the backend record (observed-2d/v1, trajectory-rules/v2). The rule scores, the AI label and the measured
// points are only read. The Side View is an illustration; the Actual 2D view draws the record's points.
import type { MatchShot, RejectedPoint, TrackingCheck, TrajectoryEstimate, TrajectoryPoint } from "./types";

export const SIX_TYPES = ["smash", "clear", "drop", "drive", "net_shot", "lift"] as const;
export type SixType = (typeof SIX_TYPES)[number];

/** Frames the trajectory rules read: 12 before the contact and 45 after it (trajectory-rules CONFIG). */
export const WINDOW_BEFORE = 12;
export const WINDOW_AFTER = 45;

export function isSixType(value: unknown): value is SixType {
  return typeof value === "string" && (SIX_TYPES as readonly string[]).includes(value);
}

/** One frame of shuttle_trajectory.json: what the tracker wrote for it. Used only to check the record against the file. */
export type ShuttleObservation = { visible: boolean; refined: boolean; x: number | null; y: number | null };

/** Where a point comes from: a TrackNet detection ("measured"), or an InpaintNet fill ("refined", not a detection). */
export type Provenance = "measured" | "refined";

export type PathPoint = {
  frame: number;
  timeS: number;
  xPx: number;
  yPx: number;
  interpolated: boolean;
  provenance: Provenance;
  /** true when the point equals the shuttle file at its frame; null when there is no file or the point is not a detection. */
  matchesFile: boolean | null;
  role: "before" | "contact" | "after";
  /** The backend run the point belongs to; a new run starts after a gap or an implausible step. */
  segment: number | null;
};

export type RejectedMark = { frame: number; xPx: number; yPx: number; reason: RejectedPoint["reason"]; source: RejectedPoint["source"] };

export type ShotPath = {
  frameSize: [number, number];
  contact: PathPoint | null;
  /** Points in frame order, all roles together. */
  points: PathPoint[];
  /** Continuous polylines, one per backend run. */
  runs: PathPoint[][];
  /** Points the sanitizer removed inside the window, drawn apart (never joined to the path). */
  rejected: RejectedMark[];
  lastObserved: PathPoint | null;
  counts: {
    before: number;
    after: number;
    expectedBefore: number;
    expectedAfter: number;
    refined: number;
    rejected: number;
    breaks: number;
    truncatedBefore: boolean;
    truncatedAfter: boolean;
    /** Why the after window is short: the video ended, or the shuttle was not tracked. Null when it is full. */
    truncatedAfterReason: TruncationReason | null;
  };
  /** Checks of the record against the shuttle file. Empty counts when no file was given. */
  integrity: { mismatches: number; missingFromFile: number; visibleButMissing: number; checked: boolean };
};

export type TruncationReason = "video_end" | "tracking";

function provenanceOf(point: TrajectoryPoint): Provenance {
  if (point.source) return point.source === "interpolated" ? "refined" : "measured";
  return point.interpolated ? "refined" : "measured";
}

function toPoint(point: TrajectoryPoint, role: PathPoint["role"]): PathPoint {
  return {
    frame: point.frame,
    timeS: point.time_s,
    xPx: point.x_px,
    yPx: point.y_px,
    interpolated: provenanceOf(point) === "refined",
    provenance: provenanceOf(point),
    matchesFile: null,
    role,
    segment: typeof point.segment === "number" ? point.segment : null,
  };
}

function checkAgainstFile(point: PathPoint, shuttle: Map<number, ShuttleObservation> | null): PathPoint {
  if (!shuttle || point.provenance !== "measured" || point.role === "contact") return point;
  const observed = shuttle.get(point.frame);
  return { ...point, matchesFile: observed === undefined ? null : observed.x === point.xPx && observed.y === point.yPx };
}

/** Why a window is short, for records written before the backend stored the reason. */
export function truncationReason(expected: number, actual: number, contactFrame: number, lastFrame: number | null): TruncationReason | null {
  if (actual >= expected) return null;
  if (lastFrame !== null && contactFrame + expected > lastFrame) return "video_end";
  return "tracking";
}

/**
 * The path of one shot from its stored record: before the contact, the contact candidate and after the contact, with the
 * backend's runs and rejected points. Points are kept as stored; nothing is smoothed, filled or removed here.
 */
export function buildShotPath(
  record: TrajectoryEstimate,
  shuttle: Map<number, ShuttleObservation> | null = null,
  lastFrame: number | null = null,
): ShotPath {
  const before = [...record.trajectory_before].sort((a, b) => a.frame - b.frame).map((point) => toPoint(point, "before"));
  const after = [...record.trajectory_after].sort((a, b) => a.frame - b.frame).map((point) => toPoint(point, "after"));
  const contact: PathPoint | null =
    record.contact_image.x_px !== null && record.contact_image.y_px !== null
      ? { frame: record.frame, timeS: record.timestamp_s, xPx: record.contact_image.x_px, yPx: record.contact_image.y_px, interpolated: false, provenance: "measured", matchesFile: null, role: "contact", segment: null }
      : null;

  // One point per frame, in frame order (a frame stored twice keeps its first copy).
  const seen = new Set<number>();
  const points: PathPoint[] = [];
  for (const point of [...before, ...(contact ? [contact] : []), ...after].sort((a, b) => a.frame - b.frame)) {
    if (seen.has(point.frame)) continue;
    seen.add(point.frame);
    points.push(checkAgainstFile(point, shuttle));
  }
  // The contact point takes the run of its neighbours.
  points.forEach((point, index) => {
    if (point.role !== "contact" || point.segment !== null) return;
    const neighbour = points[index - 1] ?? points[index + 1];
    point.segment = neighbour?.segment ?? null;
  });

  const rejected: RejectedMark[] = (record.rejected_points ?? [])
    .filter((item) => item.x_px !== null && item.y_px !== null)
    .map((item) => ({ frame: item.frame, xPx: item.x_px as number, yPx: item.y_px as number, reason: item.reason, source: item.source }));
  const rejectedFrames = new Set((record.rejected_points ?? []).map((item) => item.frame));

  // Frames inside the window that the file shows as visible but the record neither keeps nor rejects.
  let visibleButMissing = 0;
  let missingFromFile = 0;
  if (shuttle && points.length > 0) {
    const first = points[0].frame;
    const last = points[points.length - 1].frame;
    for (let frame = first; frame <= last; frame += 1) {
      if (!seen.has(frame)) {
        if (shuttle.get(frame)?.visible && !rejectedFrames.has(frame)) visibleButMissing += 1;
      } else if (shuttle.get(frame) === undefined) {
        missingFromFile += 1;
      }
    }
  }

  const hasSegments = points.some((point) => point.segment !== null);
  const runs: PathPoint[][] = [];
  points.forEach((point, index) => {
    if (index === 0) {
      runs.push([point]);
      return;
    }
    const previous = points[index - 1];
    const same = hasSegments
      ? point.segment === previous.segment
      : point.frame - previous.frame === 1 || point.interpolated || previous.interpolated;
    if (same) runs[runs.length - 1].push(point);
    else runs.push([point]);
  });

  const lastObserved = [...points].reverse().find((point) => point.provenance === "measured") ?? null;
  const afterCount = after.length;
  const beforeCount = before.length;
  const stored = record.window?.after.truncated_reason;
  return {
    frameSize: record.frame_size,
    contact,
    points,
    runs,
    rejected,
    lastObserved,
    counts: {
      before: beforeCount,
      after: afterCount,
      expectedBefore: record.window?.before.expected ?? WINDOW_BEFORE,
      expectedAfter: record.window?.after.expected ?? WINDOW_AFTER,
      refined: points.filter((point) => point.provenance === "refined").length,
      rejected: (record.rejected_points ?? []).length,
      breaks: Math.max(0, runs.length - 1),
      truncatedBefore: beforeCount < (record.window?.before.expected ?? WINDOW_BEFORE),
      truncatedAfter: afterCount < (record.window?.after.expected ?? WINDOW_AFTER),
      truncatedAfterReason: stored !== undefined ? stored : truncationReason(WINDOW_AFTER, afterCount, record.frame, lastFrame),
    },
    integrity: {
      mismatches: points.filter((point) => point.matchesFile === false).length,
      missingFromFile,
      visibleButMissing,
      checked: shuttle !== null,
    },
  };
}

/** The backend's tracking checks of a record (empty for records written before they existed). */
export function checksOf(record: TrajectoryEstimate): TrackingCheck[] {
  return record.tracking_checks ?? [];
}

export type ZoomBox = { x: number; y: number; width: number; height: number };

/**
 * The part of the frame shown in the zoomed view. It has the frame's own aspect ratio, contains every point with a margin,
 * and falls back to the whole frame when the path does not fit inside it.
 */
export function zoomBox(frameWidth: number, frameHeight: number, points: Array<{ xPx: number; yPx: number }>, margin = 0.15): ZoomBox {
  const full: ZoomBox = { x: 0, y: 0, width: frameWidth, height: frameHeight };
  if (points.length === 0 || frameWidth <= 0 || frameHeight <= 0) return full;
  const aspect = frameWidth / frameHeight;
  const xs = points.map((point) => point.xPx);
  const ys = points.map((point) => point.yPx);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const padX = Math.max((maxX - minX) * margin, 16);
  const padY = Math.max((maxY - minY) * margin, 16);
  let width = maxX - minX + 2 * padX;
  let height = maxY - minY + 2 * padY;
  if (width / height < aspect) width = height * aspect;
  else height = width / aspect;
  if (width > frameWidth || height > frameHeight) return full;
  const centreX = (minX + maxX) / 2;
  const centreY = (minY + maxY) / 2;
  const x = Math.min(Math.max(centreX - width / 2, 0), frameWidth - width);
  const y = Math.min(Math.max(centreY - height / 2, 0), frameHeight - height);
  return { x, y, width, height };
}

/**
 * The trajectory record of a shot. The key is the analysis (job id) and the frame; a record that names its timeline row
 * must name this row. A record of another analysis never matches.
 */
export function findRecordForShot(
  records: TrajectoryEstimate[],
  shot: Pick<MatchShot, "frame"> & Partial<Pick<MatchShot, "id">>,
  jobId: string,
): TrajectoryEstimate | null {
  return (
    records.find(
      (record) => record.job_id === jobId && record.frame === shot.frame && (!record.timeline_id || !shot.id || record.timeline_id === shot.id),
    ) ?? null
  );
}

/** The frame a seek should land on: the middle of the frame's own time slot, so it is never the frame before. */
export function frameSeekTime(frame: number, fps: number): number {
  return fps > 0 ? (frame + 0.5) / fps : 0;
}

/** The shuttle file as a map from frame to observation (for the file check only). */
export function shuttleMapFrom(frames: Array<{ frame: number; x: number | null; y: number | null; visible: boolean; refined: boolean }>): Map<number, ShuttleObservation> {
  return new Map(frames.map((item) => [item.frame, { visible: item.visible, refined: item.refined, x: item.x, y: item.y }]));
}

/** What the uncertainty display says about one shot. The rule scores are scores, not probabilities. */
export function uncertaintyView(labels: ShotLabels): { uncertain: boolean; ranked: Array<{ label: string; score: number }> } {
  return { uncertain: labels.uncertain, ranked: labels.top3.slice(0, 3).map(([label, score]) => ({ label, score })) };
}

export type ShotLabels = {
  /** The original AI prediction. It is never overwritten. */
  aiLabel: SixType | null;
  /** A person's six-class label for this shot, if one has been saved. */
  reviewedLabel: SixType | null;
  /** A person's note outside the six classes ("unknown" or a legacy label). Never drawn as a stroke. */
  personNote: string | null;
  /** The label the Side View draws: the reviewed one when present, else the AI prediction. */
  sideLabel: SixType | null;
  /** The classifier's top two classes are close (a small margin). */
  uncertain: boolean;
  reviewStatus: TrajectoryEstimate["review_status"];
  reasons: string[];
  scores: Record<string, number>;
  top3: [string, number][];
};

export function resolveLabels(record: TrajectoryEstimate): ShotLabels {
  const aiLabel = isSixType(record.best_guess_label) ? record.best_guess_label : null;
  const reviewedLabel = isSixType(record.manual_label) ? record.manual_label : null;
  return {
    aiLabel,
    reviewedLabel,
    personNote: record.person_label_note ?? null,
    sideLabel: reviewedLabel ?? aiLabel,
    uncertain: record.review_reasons.some((reason) => reason.startsWith("small margin")),
    reviewStatus: record.review_status,
    reasons: record.review_reasons,
    scores: record.scores,
    top3: record.top3,
  };
}

/** Side View coordinates, in a 400 x 272 box: the shuttle paths sit above the ground at y = 196, the caption below it. */
export const SIDE_VIEW = { width: 400, height: 272, ground: 196, netX: 200, netTop: 118 } as const;

export type SideTemplate = {
  label: SixType;
  contact: { x: number; y: number };
  end: { x: number; y: number };
  /** SVG path data, starts at the contact and ends at the end marker. */
  d: string;
};

const TEMPLATES: Record<SixType, SideTemplate> = {
  // Overhead, high contact. Deep toward the opponent's back court: a high arc that falls to the back line.
  clear: { label: "clear", contact: { x: 88, y: 92 }, end: { x: 348, y: 182 }, d: "M88 92 C150 40 254 52 304 118 S340 178 348 182" },
  // High contact, fast steep descent. It is not assumed to land near the net.
  smash: { label: "smash", contact: { x: 92, y: 84 }, end: { x: 332, y: 194 }, d: "M92 84 C130 70 196 96 252 150 S316 186 332 194" },
  // Rear-court contact. Passes over the net and drops near the opponent's front court.
  drop: { label: "drop", contact: { x: 74, y: 110 }, end: { x: 292, y: 186 }, d: "M74 110 C120 86 176 98 214 124 S280 172 292 186" },
  // Relatively flat across the net.
  drive: { label: "drive", contact: { x: 96, y: 130 }, end: { x: 336, y: 134 }, d: "M96 130 C140 112 180 108 220 112 S300 126 336 134" },
  // Low contact near the net, a short path that just clears the tape.
  net_shot: { label: "net_shot", contact: { x: 170, y: 150 }, end: { x: 240, y: 160 }, d: "M170 150 C180 138 190 126 204 126 S226 146 240 160" },
  // Low, front-court contact. Rises, then travels deep toward the opponent's back court.
  lift: { label: "lift", contact: { x: 110, y: 184 }, end: { x: 360, y: 160 }, d: "M110 184 C150 110 230 70 286 74 S352 120 360 160" },
};

/** The illustrative template for a six-class label. Unknown or missing labels have no template (never a forced one). */
export function sideTemplate(label: string | null | undefined): SideTemplate | null {
  return isSixType(label) ? TEMPLATES[label] : null;
}

/** The six templates in the order of the Side View selector. */
export const TEMPLATE_ORDER: SixType[] = ["clear", "smash", "drop", "drive", "net_shot", "lift"];
