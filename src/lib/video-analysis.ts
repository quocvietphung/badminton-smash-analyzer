// Video analysis snapshot: the only analysis data the AI Coach receives.
// It is built from results.json of a completed local analysis (Docker backend, localhost).
// Nothing is added that the pipeline does not measure. Shuttle motion is image-space px/s near each contact
// candidate, never a physical speed. No rally statistics and no technique scores.

import { z } from "zod";
import type { MatchDocument } from "@/lib/match/types";

export type VideoAnalysisSourceKind = "sample" | "upload";

export type VideoAnalysisTrack = {
  trackId: number;
  observedFrames: number;
  coverageRatio: number;
  segments: number;
  pathLengthNorm: number;
  avgSpeedNormPerS: number;
  courtPathM: number | null;
  courtAvgSpeedMPerS: number | null;
  shareInsideOutline: number | null;
};

/** Identity evidence: logical labels P1 to P4, their events with times, and manual corrections applied. */
export type VideoAnalysisIdentity = {
  mode: string;
  logicalIdentities: number;
  eventCounts: Record<string, number>;
  events: Array<{ timeS: number | null; kind: string; identity: string; trackId: number | null }>;
  coverage: Record<string, number | null>;
  correctionsAppliedFrames: number;
};

/** Rally candidates are heuristic and never validated in this build. */
export type VideoAnalysisRally = {
  status: string;
  reason: string;
  count: number | null;
  validated: boolean;
  candidates: Array<{ startS: number; endS: number; durationS: number }>;
};

export type VideoAnalysisPhysicalSpeed = {
  status: "available" | "unavailable";
  label: string;
  measurements: Array<{
    frame: number;
    timeS: number;
    firstObservedKmh: number;
    atNetKmh: number | null;
    atContactExtrapolatedKmh: number | null;
    uncertaintyKmh: [number, number] | null;
    method: string;
    calibrationSource: string | null;
    reprojectionRmsPx: number | null;
    notRadarValidated: true;
  }>;
};

export type VideoAnalysisSnapshot = {
  source: "none" | "video-analysis";
  jobId: string | null;
  sourceKind: VideoAnalysisSourceKind | null;
  sourceName: string;
  capturedAt: string;
  video: { width: number; height: number; fps: number; framesAnalysed: number; durationS: number | null };
  court: { status: string; reason: string; template: string | null; score: number | null };
  players: {
    tracksConfirmed: number;
    tracksInMovementStatistics: number;
    maxConcurrentConfirmed: number;
    meanDetectionScore: number | null;
    detector: string | null;
  };
  movement: VideoAnalysisTrack[];
  shuttle: {
    framesTotal: number;
    framesDetected: number;
    framesInterpolated: number;
    visibleRatio: number;
    visibleRuns: number;
    meanConfidenceDetected: number | null;
    stepP95PxPerFrame: number | null;
    units: string;
  };
  identity: VideoAnalysisIdentity | null;
  rally: VideoAnalysisRally;
  shots: { status: string; reason: string };
  /** Trajectory-rule shot estimates (unvalidated), kept apart from the user's own labels. */
  shotClassification: {
    status: "predicted" | "not_loaded" | "no_predictions" | "not_loaded_yet";
    source: string;
    unverified: true;
    model: string | null;
    checkpoint: string | null;
    reason: string;
    predicted: number;
    unknown: number;
    userLabels: number;
    predictions: {
      timeS: number;
      player: string | null;
      label: string;
      modelLabel: string;
      confidence: number | null;
      top3: { label: string; probability: number }[];
    }[];
  };
  /** Each contact candidate with its image-space shuttle motion (px/s). Person labels and estimates stay apart. */
  shotTimeline: VideoAnalysisShotEntry[];
  physicalSpeed: VideoAnalysisPhysicalSpeed;
  limitations: string[];
};

export type VideoAnalysisShotEntry = {
  timeS: number;
  frame: number;
  player: string | null;
  contactStatus: string;
  /** Image-space shuttle motion near the contact, in pixels per second. Not a physical speed. */
  imageSpeedPxPerS: number | null;
  speedBasis: "confirmed_contact" | "automatic_candidate" | null;
  /** A shot type a person entered or accepted. */
  shotLabel: string | null;
  /** Trajectory estimate (trajectory-rules): unverified, never a fact. */
  trajectoryEstimate: { label: string; evidenceQuality: string; reviewStatus: string } | null;
};

export const EMPTY_VIDEO_ANALYSIS_SNAPSHOT: VideoAnalysisSnapshot = {
  source: "none",
  jobId: null,
  sourceKind: null,
  sourceName: "",
  capturedAt: "",
  video: { width: 0, height: 0, fps: 0, framesAnalysed: 0, durationS: null },
  court: { status: "none", reason: "", template: null, score: null },
  players: { tracksConfirmed: 0, tracksInMovementStatistics: 0, maxConcurrentConfirmed: 0, meanDetectionScore: null, detector: null },
  movement: [],
  shuttle: {
    framesTotal: 0,
    framesDetected: 0,
    framesInterpolated: 0,
    visibleRatio: 0,
    visibleRuns: 0,
    meanConfidenceDetected: null,
    stepP95PxPerFrame: null,
    units: "",
  },
  identity: null,
  rally: { status: "unsupported", reason: "", count: null, validated: false, candidates: [] },
  shots: { status: "unsupported", reason: "" },
  shotClassification: { status: "not_loaded_yet", source: "", unverified: true, model: null, checkpoint: null, reason: "", predicted: 0, unknown: 0, userLabels: 0, predictions: [] },
  shotTimeline: [],
  physicalSpeed: { status: "unavailable", label: "Physical speed unavailable", measurements: [] },
  limitations: [],
};

// The part of results.json (backend, snake_case) that the snapshot reads.
export type VideoAnalysisResults = {
  video: { width: number; height: number; fps: number; frames_analysed: number; duration_s: number | null };
  players: {
    tracks_confirmed: number;
    tracks_in_movement_statistics?: number | null;
    max_concurrent_confirmed: number;
    mean_detection_score: number | null;
    detector: string | null;
    logical_identities?: number;
    mode?: string;
  };
  movement: {
    per_player: Array<{
      track_id: number;
      observed_frames: number;
      coverage_ratio: number;
      segments: number;
      path_length_norm: number;
      avg_speed_norm_per_s: number;
    }>;
    court_plane?: {
      per_player: Array<{
        track_id: number;
        path_length_m: number;
        avg_speed_m_per_s: number;
        share_inside_doubles_outline: number;
      }>;
    } | null;
  };
  shuttle: {
    frames_total: number;
    frames_detected: number;
    frames_interpolated: number;
    visible_ratio: number;
    visible_runs: number;
    mean_confidence_detected: number | null;
    step_px_per_frame_p95: number | null;
    units: string;
  };
  court: { status: string; reason: string; template?: string; score?: number };
  rally_segmentation: {
    status: string;
    reason: string;
    count?: number;
    validated?: boolean;
    candidates?: Array<{ index: number; start_s: number; end_s: number; duration_s: number }>;
  };
  shot_classification: { status: string; reason: string };
  identity?: {
    mode: string;
    logical_identities: number;
    event_counts: Record<string, number>;
    events_total: number;
    events: Array<{ frame: number; time_s: number | null; kind: string; identity: string; track_id: number | null }>;
    coverage: Record<string, number | null>;
    corrections_applied_frames: number;
  } | null;
  limitations: string[];
};

export type VideoAnalysisMeta = {
  jobId: string;
  sourceKind: VideoAnalysisSourceKind;
  sourceName: string;
  capturedAt: string;
};

type CourtTrackRow = { track_id: number; path_length_m: number; avg_speed_m_per_s: number; share_inside_doubles_outline: number };

/** Build the coach snapshot. Court metres are shared only when the court was calibrated. */
/**
 * Trajectory estimates (trajectory-rules) and the user's own labels, counted apart. Estimates are always marked
 * unverified; a person's label is never reported as an estimate.
 */
function buildShotClassification(match: MatchDocument | null): VideoAnalysisSnapshot["shotClassification"] {
  if (!match) {
    return { status: "not_loaded_yet", source: "", unverified: true, model: null, checkpoint: null, reason: "", predicted: 0, unknown: 0, userLabels: 0, predictions: [] };
  }
  const shots = match.shots.items;
  const estimates = shots.filter((shot) => shot.type_source === "trajectory_estimate");
  const userLabels = shots.filter((shot) => shot.type_source === "manual").length;
  const ruleVersion = shots.find((shot) => shot.trajectory?.rule_version)?.trajectory?.rule_version ?? shots.find((shot) => shot.model_version)?.model_version ?? null;
  return {
    status: estimates.length > 0 ? "predicted" : "no_predictions",
    source: "trajectory_rules_unverified",
    unverified: true,
    model: ruleVersion,
    checkpoint: null,
    reason: "Rule-based estimate from the shuttle trajectory and image speed. Not validated.",
    predicted: estimates.length,
    unknown: 0,
    userLabels,
    predictions: estimates.slice(0, 40).map((shot) => ({
      timeS: shot.time_s,
      player: shot.player,
      label: shot.type,
      modelLabel: shot.type,
      confidence: null,
      top3: ((shot.classifier?.top3 ?? []) as [string, number][]).slice(0, 3).map(([label, probability]) => ({ label, probability })),
    })),
  };
}

/** Contact candidates in time order, each with its image-space motion. Nothing here is validated. */
function buildShotTimeline(match: MatchDocument | null): VideoAnalysisShotEntry[] {
  if (!match) return [];
  return match.shots.items.slice(0, 60).map((shot) => ({
    timeS: shot.time_s,
    frame: shot.frame,
    player: shot.player,
    contactStatus: shot.contact_status,
    imageSpeedPxPerS: shot.speed?.px_per_s ?? null,
    speedBasis: shot.speed?.basis ?? null,
    shotLabel: shot.type_source === "manual" ? shot.type : null,
    trajectoryEstimate: shot.trajectory
      ? { label: shot.trajectory.best_guess_label, evidenceQuality: shot.trajectory.evidence_quality, reviewStatus: shot.trajectory.review_status }
      : null,
  }));
}

export function buildVideoAnalysisSnapshot(
  results: VideoAnalysisResults,
  meta: VideoAnalysisMeta,
  match: MatchDocument | null = null,
): VideoAnalysisSnapshot {
  const calibrated = results.court.status === "calibrated";
  const courtRows: CourtTrackRow[] = calibrated ? results.movement.court_plane?.per_player ?? [] : [];
  const courtByTrack = new Map<number, CourtTrackRow>(courtRows.map((row) => [row.track_id, row]));

  return {
    source: "video-analysis",
    jobId: meta.jobId,
    sourceKind: meta.sourceKind,
    sourceName: meta.sourceName,
    capturedAt: meta.capturedAt,
    video: {
      width: results.video.width,
      height: results.video.height,
      fps: results.video.fps,
      framesAnalysed: results.video.frames_analysed,
      durationS: results.video.duration_s,
    },
    court: {
      status: results.court.status,
      reason: results.court.reason,
      template: results.court.template ?? null,
      score: results.court.score ?? null,
    },
    players: {
      tracksConfirmed: results.players.tracks_confirmed,
      tracksInMovementStatistics: results.players.tracks_in_movement_statistics ?? results.movement.per_player.length,
      maxConcurrentConfirmed: results.players.max_concurrent_confirmed,
      meanDetectionScore: results.players.mean_detection_score,
      detector: results.players.detector,
    },
    movement: results.movement.per_player.map((row) => {
      const court = courtByTrack.get(row.track_id);
      return {
        trackId: row.track_id,
        observedFrames: row.observed_frames,
        coverageRatio: row.coverage_ratio,
        segments: row.segments,
        pathLengthNorm: row.path_length_norm,
        avgSpeedNormPerS: row.avg_speed_norm_per_s,
        courtPathM: court ? court.path_length_m : null,
        courtAvgSpeedMPerS: court ? court.avg_speed_m_per_s : null,
        shareInsideOutline: court ? court.share_inside_doubles_outline : null,
      };
    }),
    shuttle: {
      framesTotal: results.shuttle.frames_total,
      framesDetected: results.shuttle.frames_detected,
      framesInterpolated: results.shuttle.frames_interpolated,
      visibleRatio: results.shuttle.visible_ratio,
      visibleRuns: results.shuttle.visible_runs,
      meanConfidenceDetected: results.shuttle.mean_confidence_detected,
      stepP95PxPerFrame: results.shuttle.step_px_per_frame_p95,
      units: results.shuttle.units,
    },
    identity: results.identity
      ? {
          mode: results.identity.mode,
          logicalIdentities: results.identity.logical_identities,
          eventCounts: results.identity.event_counts,
          events: results.identity.events.map((event) => ({
            timeS: event.time_s,
            kind: event.kind,
            identity: event.identity,
            trackId: event.track_id,
          })),
          coverage: results.identity.coverage,
          correctionsAppliedFrames: results.identity.corrections_applied_frames,
        }
      : null,
    rally: {
      status: results.rally_segmentation.status,
      reason: results.rally_segmentation.reason,
      count: results.rally_segmentation.count ?? null,
      validated: results.rally_segmentation.validated ?? false,
      candidates: (results.rally_segmentation.candidates ?? []).map((candidate) => ({
        startS: candidate.start_s,
        endS: candidate.end_s,
        durationS: candidate.duration_s,
      })),
    },
    shots: { status: results.shot_classification.status, reason: results.shot_classification.reason },
    shotClassification: buildShotClassification(match),
    shotTimeline: buildShotTimeline(match),
    // Estimated 3D — monocular experimental. Only shots that passed every gate carry a speed; nothing else is sent.
    physicalSpeed: {
      status: (match?.summary.speed.estimated_3d?.available ?? 0) > 0 ? "available" : "unavailable",
      label: match?.summary.speed.estimated_3d?.label ?? "Physical trajectory unavailable",
      measurements: (match?.shots.items ?? []).flatMap((shot) => {
        const estimate = shot.estimated_3d;
        if (!estimate || estimate.status !== "available" || estimate.speed_candidate_kmh === null) return [];
        return [{
          frame: shot.frame,
          timeS: shot.time_s,
          firstObservedKmh: estimate.speed_candidate_kmh,
          atNetKmh: null,
          atContactExtrapolatedKmh: null,
          uncertaintyKmh: estimate.speed_range_kmh,
          method: estimate.method ?? "Estimated 3D — monocular experimental",
          calibrationSource: null,
          reprojectionRmsPx: estimate.reprojection_rms_px ?? null,
          notRadarValidated: true as const,
        }];
      }).slice(0, 20),
    },
    limitations: results.limitations.slice(0, 20),
  };
}

const unit = z.number().min(0).max(1);
const big = z.number().min(0).max(100_000);

/** Request schema for /api/ai/chat. Bounded so that a client cannot send raw frames or video. */
export const videoAnalysisSchema = z.object({
  source: z.enum(["none", "video-analysis"]),
  jobId: z.string().max(64).nullable(),
  sourceKind: z.enum(["sample", "upload"]).nullable(),
  sourceName: z.string().max(160),
  capturedAt: z.string().max(64),
  video: z.object({
    width: z.number().int().min(0).max(20_000),
    height: z.number().int().min(0).max(20_000),
    fps: z.number().min(0).max(1_000),
    framesAnalysed: z.number().int().min(0).max(10_000_000),
    durationS: big.nullable(),
  }),
  court: z.object({
    status: z.string().max(40),
    reason: z.string().max(400),
    template: z.string().max(120).nullable(),
    score: unit.nullable(),
  }),
  players: z.object({
    tracksConfirmed: z.number().int().min(0).max(10_000),
    tracksInMovementStatistics: z.number().int().min(0).max(10_000),
    maxConcurrentConfirmed: z.number().int().min(0).max(100),
    meanDetectionScore: unit.nullable(),
    detector: z.string().max(80).nullable(),
  }),
  movement: z.array(z.object({
    trackId: z.number().int().min(0).max(10_000),
    observedFrames: z.number().int().min(0).max(10_000_000),
    coverageRatio: unit,
    segments: z.number().int().min(0).max(10_000),
    pathLengthNorm: big,
    avgSpeedNormPerS: big,
    courtPathM: big.nullable(),
    courtAvgSpeedMPerS: z.number().min(0).max(1_000).nullable(),
    shareInsideOutline: unit.nullable(),
  })).max(40),
  shuttle: z.object({
    framesTotal: z.number().int().min(0).max(10_000_000),
    framesDetected: z.number().int().min(0).max(10_000_000),
    framesInterpolated: z.number().int().min(0).max(10_000_000),
    visibleRatio: unit,
    visibleRuns: z.number().int().min(0).max(100_000),
    meanConfidenceDetected: unit.nullable(),
    stepP95PxPerFrame: big.nullable(),
    units: z.string().max(200),
  }),
  identity: z.object({
    mode: z.string().max(20),
    logicalIdentities: z.number().int().min(0).max(4),
    eventCounts: z.record(z.string().max(60), z.number().int().min(0).max(100_000)),
    events: z.array(z.object({
      timeS: big.nullable(),
      kind: z.string().max(60),
      identity: z.string().max(4),
      trackId: z.number().int().min(0).max(10_000).nullable(),
    })).max(40),
    coverage: z.record(z.string().max(4), unit.nullable()),
    correctionsAppliedFrames: z.number().int().min(0).max(10_000_000),
  }).nullable(),
  rally: z.object({
    status: z.string().max(40),
    reason: z.string().max(400),
    count: z.number().int().min(0).max(10_000).nullable(),
    validated: z.boolean(),
    candidates: z.array(z.object({ startS: big, endS: big, durationS: big })).max(20),
  }),
  shots: z.object({ status: z.string().max(40), reason: z.string().max(400) }),
  shotClassification: z.object({
    status: z.enum(["predicted", "not_loaded", "no_predictions", "not_loaded_yet"]),
    source: z.string().max(60),
    unverified: z.literal(true),
    model: z.string().max(120).nullable(),
    checkpoint: z.string().max(120).nullable(),
    reason: z.string().max(400),
    predicted: z.number().int().min(0).max(10_000),
    unknown: z.number().int().min(0).max(10_000),
    userLabels: z.number().int().min(0).max(10_000),
    predictions: z.array(z.object({
      timeS: big,
      player: z.string().max(8).nullable(),
      label: z.string().max(40),
      modelLabel: z.string().max(40),
      confidence: z.number().min(0).max(1).nullable(),
      top3: z.array(z.object({ label: z.string().max(40), probability: z.number().min(0).max(1) })).max(3),
    })).max(40),
  }),
  shotTimeline: z.array(z.object({
    timeS: big,
    frame: z.number().int().min(0).max(10_000_000),
    player: z.string().max(8).nullable(),
    contactStatus: z.enum(["candidate", "confirmed", "rejected"]),
    imageSpeedPxPerS: big.nullable(),
    speedBasis: z.enum(["confirmed_contact", "automatic_candidate"]).nullable(),
    shotLabel: z.string().max(40).nullable(),
    trajectoryEstimate: z.object({ label: z.string().max(40), evidenceQuality: z.string().max(10), reviewStatus: z.string().max(30) }).nullable(),
  })).max(60),
  physicalSpeed: z.object({
    status: z.enum(["available", "unavailable"]),
    label: z.string().max(120),
    measurements: z.array(z.object({
      frame: z.number().int().min(0).max(10_000_000),
      timeS: big,
      firstObservedKmh: z.number().min(0).max(1_000),
      atNetKmh: z.number().min(0).max(1_000).nullable(),
      atContactExtrapolatedKmh: z.number().min(0).max(1_000).nullable(),
      uncertaintyKmh: z.tuple([z.number().min(0).max(1_000), z.number().min(0).max(1_000)]).nullable(),
      method: z.string().max(240),
      calibrationSource: z.string().max(120).nullable(),
      reprojectionRmsPx: z.number().min(0).max(10_000).nullable(),
      notRadarValidated: z.literal(true),
    })).max(20),
  }),
  limitations: z.array(z.string().max(400)).max(20),
});
