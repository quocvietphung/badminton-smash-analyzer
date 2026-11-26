import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildVideoAnalysisSnapshot,
  videoAnalysisSchema,
  type VideoAnalysisResults,
} from "../src/lib/video-analysis.ts";
import type { MatchDocument } from "../src/lib/match/types.ts";

const META = {
  jobId: "b2a9f0db32e9434d8c7cfca75bc5a4ba",
  sourceKind: "sample" as const,
  sourceName: "Sample A",
  capturedAt: "2026-11-15T14:00:00.000Z",
};

function results(overrides: Partial<VideoAnalysisResults> = {}): VideoAnalysisResults {
  return {
    video: { width: 1920, height: 1080, fps: 30, frames_analysed: 450, duration_s: 15 },
    players: {
      tracks_confirmed: 3,
      tracks_in_movement_statistics: 2,
      max_concurrent_confirmed: 2,
      mean_detection_score: 0.87,
      detector: "YOLOX-s",
    },
    movement: {
      per_player: [
        { track_id: 1, observed_frames: 300, coverage_ratio: 0.67, segments: 1, path_length_norm: 0.42, avg_speed_norm_per_s: 0.28 },
      ],
      court_plane: {
        per_player: [
          { track_id: 1, path_length_m: 21.4, avg_speed_m_per_s: 1.4, share_inside_doubles_outline: 0.91 },
        ],
      },
    },
    shuttle: {
      frames_total: 450,
      frames_detected: 386,
      frames_interpolated: 9,
      visible_ratio: 0.88,
      visible_runs: 3,
      mean_confidence_detected: 0.75,
      step_px_per_frame_p95: 52.5,
      units: "source pixels per frame (image space), not physical speed",
    },
    court: { status: "calibrated", reason: "template lines matched the detected white court lines", template: "doubles 13.40 m x 6.10 m", score: 0.89 },
    rally_segmentation: { status: "unsupported", reason: "Rally segmentation is not implemented in this build." },
    shot_classification: { status: "unsupported", reason: "Shot classification is not implemented in this build." },
    limitations: ["Image-space detections only."],
    ...overrides,
  };
}

test("a calibrated court shares metres, and rally and shot statuses are passed through, not invented", () => {
  const snapshot = buildVideoAnalysisSnapshot(results(), META);
  assert.equal(snapshot.source, "video-analysis");
  assert.equal(snapshot.movement[0].courtPathM, 21.4);
  assert.equal(snapshot.shuttle.framesDetected, 386);
  assert.equal(snapshot.rally.status, "unsupported");
  assert.equal(snapshot.shots.status, "unsupported");
});

test("an uncalibrated court shares no metres, even when court-plane rows are present", () => {
  const snapshot = buildVideoAnalysisSnapshot(
    results({ court: { status: "failed", reason: "not enough white lines were visible", score: 0 } }),
    META,
  );
  assert.equal(snapshot.court.status, "failed");
  assert.equal(snapshot.movement[0].courtPathM, null);
  assert.equal(snapshot.movement[0].courtAvgSpeedMPerS, null);
  assert.equal(snapshot.movement[0].shareInsideOutline, null);
});

test("the snapshot carries no physical number when the production gate has no accepted measurement", () => {
  const snapshot = buildVideoAnalysisSnapshot(results(), META);
  assert.equal(snapshot.physicalSpeed.status, "unavailable");
  assert.deepEqual(snapshot.physicalSpeed.measurements, []);
});

test("only an Estimated 3D result that passed every gate is shared with the coach", () => {
  const match = {
    summary: { speed: { physical_measurements: 1, physical_label: "Estimated 3D — monocular experimental",
      estimated_3d: { mode: "estimated_monocular", label: "Estimated 3D — monocular experimental", available: 1, rejected: 1, rejection_reasons: { contact_not_confirmed: 1 } } } },
    shots: { items: [
      {
        frame: 52,
        time_s: 1.733,
        player: "P1",
        contact_status: "confirmed",
        estimated_3d: {
          mode: "estimated_monocular", status: "available", label: "Estimated 3D — monocular experimental", speed_candidate_kmh: 104,
          speed_range_kmh: [100, 109], reprojection_rms_px: 1.2, method: "RK4 robust fit", rejection_reasons: [],
        },
      },
      {
        frame: 90,
        time_s: 3.0,
        player: "P2",
        contact_status: "candidate",
        estimated_3d: { mode: "estimated_monocular", status: "rejected", label: "Physical trajectory unavailable", speed_candidate_kmh: null,
          speed_range_kmh: null, rejection_reasons: ["contact_not_confirmed"] },
      },
    ] },
  } as unknown as MatchDocument;
  const snapshot = buildVideoAnalysisSnapshot(results(), META, match);
  assert.equal(snapshot.physicalSpeed.status, "available");
  assert.equal(snapshot.physicalSpeed.measurements.length, 1, "a rejected estimate never reaches the coach");
  assert.equal(snapshot.physicalSpeed.measurements[0].firstObservedKmh, 104);
  assert.deepEqual(snapshot.physicalSpeed.measurements[0].uncertaintyKmh, [100, 109]);
  assert.equal(snapshot.physicalSpeed.measurements[0].notRadarValidated, true);
  assert.equal(videoAnalysisSchema.safeParse(snapshot).success, true);
});

test("the request schema accepts a built snapshot and bounds the movement list", () => {
  const snapshot = buildVideoAnalysisSnapshot(results(), META);
  assert.equal(videoAnalysisSchema.safeParse(snapshot).success, true);
  const tooMany = { ...snapshot, movement: Array.from({ length: 41 }, () => snapshot.movement[0]) };
  assert.equal(videoAnalysisSchema.safeParse(tooMany).success, false);
});

test("the Coach gets trajectory estimates as unverified, sourced estimates, apart from the person's labels", () => {
  const estimate = { best_guess_label: "clear", evidence_tier: "full_trajectory", evidence_quality: "high", review_status: "needs_review", shot_id: "x", rule_version: "trajectory-rules/v2" };
  const shot = (id: string, over: Record<string, unknown>) => ({
    id, contact_id: `c${id}`, rally_id: null, frame: Number(id) * 10, time_s: Number(id), player: "P1", type: "unknown",
    confidence: null, evidence_source: "contact candidate", contact_status: "candidate", model_version: null,
    validation: "unclassified", type_source: "none", type_reason: null, flags: [], speed: null, classifier: null,
    trajectory: null, estimated_3d: { status: "rejected", rejection_reasons: [] }, ...over,
  });
  const match = {
    shots: { items: [
      shot("1", { type: "clear", type_source: "trajectory_estimate", validation: "trajectory_unverified", classifier: { top3: [["clear", 0.4]], review_status: "needs_review" }, trajectory: estimate }),
      shot("2", { type: "smash", type_source: "manual", validation: "manual", trajectory: estimate }),
      shot("3", {}),
    ], classifier: { available: false }, types: [] },
    summary: { speed: { physical_measurements: null, physical_label: null } },
  } as unknown as MatchDocument;
  const snapshot = buildVideoAnalysisSnapshot(results(), META, match);
  const classification = snapshot.shotClassification;
  assert.equal(classification.source, "trajectory_rules_unverified");
  assert.equal(classification.unverified, true);
  assert.equal(classification.model, "trajectory-rules/v2", "the model is the rule version the records were built with");
  assert.equal(classification.predicted, 1, "one estimate");
  assert.equal(classification.userLabels, 1, "one person's label, counted apart");
  assert.equal(classification.predictions[0].label, "clear");
});
