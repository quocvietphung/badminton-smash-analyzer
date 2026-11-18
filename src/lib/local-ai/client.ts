// Client helpers for the local AI backend. Pure functions live here so they can be tested without a browser.
// No secrets are read or sent: the backend address and API token exist only on the studio server.

/** The studio talks to the backend through its own server (same origin), which adds the API token on the server. */
export const LOCAL_AI_PROXY_BASE = "/api/backend";
export const LOCAL_AI_JOB_ID_STORAGE_KEY = "smashlab-local-ai-last-job-v1";
export const LOCAL_AI_POLL_INTERVAL_MS = 1500;
export const LOCAL_AI_MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
export const LOCAL_AI_ARTIFACT_NAMES = [
  "annotated.mp4",
  "results.json",
  "analysis.json",
  "analysis_report.json",
  "player_tracks.json",
  "identity_events.json",
  "rallies.json",
  "shots.json",
  "shuttle_trajectory.json",
  "court_coordinates.json",
  "metrics.json",
  "inference_report.json",
  "model_execution.json",
] as const;

export type LocalAiArtifactName = (typeof LOCAL_AI_ARTIFACT_NAMES)[number];
export type LocalAiJobStatus = "queued" | "running" | "completed" | "failed";

export type LocalAiJob = {
  job_id: string;
  status: LocalAiJobStatus;
  stage: string | null;
  progress: number;
  attempts: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  source: { kind: string; name: string };
  error: { code: string | null; message: string | null } | null;
  status_url: string;
  results_url: string | null;
};

export type LocalAiSample = {
  id: string;
  title: string;
  scenario: string | null;
  file: string;
  available: boolean;
  status: "available" | "missing";
  thumbnail_url: string;
  width: number | null;
  height: number | null;
  fps: number | null;
  frames: number | null;
  duration_s: number | null;
  trim: { start_s: number; duration_s: number; reencoded: string } | null;
  licence: string | null;
  source_url: string | null;
  attribution: string | null;
  ground_truth: string[];
};

/** Summary of saved analyses, from GET /api/v1/evaluation. Every value is measured or marked not evaluated. */
export type LocalAiEvaluation = {
  schema: string;
  generated_at: number;
  scope: string;
  analyses: {
    total: number;
    completed: number;
    failed: number;
    in_progress: number;
    failures_by_code: Record<string, number>;
    frames_analysed: number;
    video_seconds_analysed: number;
  };
  processing: {
    measured_analyses: number;
    wall_seconds_mean: number | null;
    frames_per_second_mean: number | null;
    cpu_utilisation_mean: number | null;
    peak_rss_mb_max: number | null;
    detector_ms_per_frame_mean: number | null;
    derive_seconds_mean: number | null;
    note: string;
  };
  shuttle_coverage: {
    visible_ratio_mean: number | null;
    detected_ratio_mean: number | null;
    interpolated_frames_total: number;
    note: string;
  };
  tracking: {
    tracks_total: number;
    tracks_per_analysis_mean: number | null;
    tracks_per_identity_mean: number | null;
    note: string;
  };
  identities: {
    events_total: number;
    counts_by_kind: Record<string, number>;
    switches_suspected: number;
    note: string;
  };
  corrections: { analyses_with_corrections: number; entries_by_type: Record<string, number>; note: string };
  rallies: { status: string; candidates_total: number; analyses_with_candidates: number; validated: boolean; evaluation: string };
  shots: { status: string; evaluation: string };
  ground_truth: { status: string; labelled_samples: number; note: string };
};

export type LocalAiHealth = {
  status: "ok" | "degraded";
  version: string;
  checks: Record<string, string>;
  ffmpeg: boolean;
  models: { tracknetv3: boolean; inpaintnet: boolean; yolox: boolean };
  worker: { alive: boolean; processed: number };
  queue_depth: number;
  jobs: Record<LocalAiJobStatus, number>;
  limits: { max_upload_mb: number; max_duration_s: number; job_timeout_s: number };
};

export type LocalAiError = { code: string; message: string };

export type HeatmapCell = { row: number; col: number; intensity: number };

export type TrajectoryFrame = {
  frame: number;
  x: number | null;
  y: number | null;
  visible: boolean;
  confidence: number;
  refined: boolean;
};

export type TrajectorySegment = { refined: boolean; points: Array<{ x: number; y: number }> };

export class LocalAiApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "LocalAiApiError";
    this.status = status;
    this.code = code;
  }
}

export function apiUrl(base: string, path: string): string {
  const cleanBase = base.replace(/\/+$/, "");
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return `${cleanBase}${cleanPath}`;
}

export function artifactUrl(base: string, jobId: string, name: LocalAiArtifactName): string {
  return apiUrl(base, `/api/v1/analyses/${encodeURIComponent(jobId)}/artifacts/${name}`);
}

/** The analysed video itself (a sample from the data folder or the local upload copy), with byte ranges. */
export function sourceVideoUrl(base: string, jobId: string): string {
  return apiUrl(base, `/api/v1/analyses/${encodeURIComponent(jobId)}/source`);
}

/** The sample video for the original-video player before an analysis (byte ranges supported). */
export function sampleVideoUrl(base: string, sampleId: string): string {
  return apiUrl(base, `/api/v1/samples/${encodeURIComponent(sampleId)}/video`);
}

export function thumbnailUrl(base: string, sampleId: string): string {
  return apiUrl(base, `/api/v1/samples/${encodeURIComponent(sampleId)}/thumbnail`);
}

export function correctionsUrl(base: string, jobId: string): string {
  return apiUrl(base, `/api/v1/analyses/${encodeURIComponent(jobId)}/corrections`);
}

export function isLocalAiArtifactName(name: string): name is LocalAiArtifactName {
  return (LOCAL_AI_ARTIFACT_NAMES as readonly string[]).includes(name);
}

/** Read the backend's {"error": {code, message}} body; fall back to the HTTP status. */
export function parseLocalAiError(status: number, body: unknown): LocalAiError {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error?: { code?: unknown; message?: unknown } }).error;
    if (error && typeof error.code === "string" && typeof error.message === "string") {
      return { code: error.code, message: error.message };
    }
  }
  return { code: "http_error", message: `The backend answered with HTTP ${status}.` };
}

export function isTerminalStatus(status: LocalAiJobStatus): boolean {
  return status === "completed" || status === "failed";
}

export function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function formatPercent(progress: number): string {
  return `${Math.round(clampProgress(progress) * 100)}%`;
}

/** Map the normalised occupancy grid (rows x cols, values 0..1) to non-empty cells. */
export function heatmapCells(normalised: number[][]): HeatmapCell[] {
  const cells: HeatmapCell[] = [];
  normalised.forEach((row, rowIndex) => {
    row.forEach((value, colIndex) => {
      const intensity = clampProgress(value);
      if (intensity > 0) cells.push({ row: rowIndex, col: colIndex, intensity });
    });
  });
  return cells;
}

/**
 * Split shuttle detections into continuous polylines in source-pixel coordinates.
 * A gap in visibility or a change between detected and interpolated points starts a new segment.
 */
export function trajectorySegments(frames: TrajectoryFrame[]): TrajectorySegment[] {
  const segments: TrajectorySegment[] = [];
  let current: TrajectorySegment | null = null;
  let previousFrame: number | null = null;
  for (const item of frames) {
    const usable = item.visible && item.x !== null && item.y !== null;
    const contiguous = previousFrame !== null && item.frame - previousFrame === 1;
    if (!usable) {
      current = null;
      previousFrame = item.frame;
      continue;
    }
    if (!current || !contiguous || current.refined !== item.refined) {
      current = { refined: item.refined, points: [] };
      segments.push(current);
    }
    current.points.push({ x: item.x as number, y: item.y as number });
    previousFrame = item.frame;
  }
  return segments;
}

/** Fraction of frames with a visible shuttle, guarded against empty input. */
export function visibleRatio(frames: TrajectoryFrame[]): number {
  if (frames.length === 0) return 0;
  return frames.filter((frame) => frame.visible).length / frames.length;
}

export function formatSeconds(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "–";
  if (value < 60) return `${value.toFixed(1)} s`;
  const minutes = Math.floor(value / 60);
  const seconds = Math.round(value % 60);
  return `${minutes} min ${seconds} s`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "–";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function readStoredJobId(storage: Pick<Storage, "getItem"> | null | undefined): string | null {
  if (!storage) return null;
  try {
    const value = storage.getItem(LOCAL_AI_JOB_ID_STORAGE_KEY);
    return value && /^[0-9a-f]{32}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeStoredJobId(storage: Pick<Storage, "setItem"> | null | undefined, jobId: string): void {
  if (!storage) return;
  try {
    storage.setItem(LOCAL_AI_JOB_ID_STORAGE_KEY, jobId);
  } catch {
    // storage can be blocked (private mode); the page still works without it
  }
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const error = parseLocalAiError(response.status, body);
    throw new LocalAiApiError(response.status, error.code, error.message);
  }
  return body as T;
}
