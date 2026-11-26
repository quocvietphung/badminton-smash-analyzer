import assert from "node:assert/strict";
import test from "node:test";
import {
  COURT_M,
  courtLines,
  buildGroundTruth,
  courtToView,
  formatClock,
  frameAt,
  contactsSoFar,
  hitsSoFar,
  productShotType,
  SHOT_TYPES,
  isShotType,
  parseMatchDocument,
  pointAt,
  rallyAt,
  rallyClock,
  seekTimeFor,
  shotAt,
  motionValue,
  trackingState,
  trail,
} from "../src/lib/match/analytics.ts";
import { contactDots, distanceView, playerRows, pxPerSecond, shotLabel, speedPanel } from "../src/lib/match/dashboard-view.ts";
import { annotatedTrail, observedPathRuns, orderedPoints } from "../src/lib/match/observed-path.ts";
import type { MatchDocument, MatchRally, MatchShot, Observed2DBlock, PositionPoint } from "../src/lib/match/types.ts";

const rally = (id: string, start: number, end: number): MatchRally => ({
  id, index: Number(id.slice(1)), start_frame: start, end_frame: end, start_s: start / 30, end_s: end / 30,
  duration_s: (end - start) / 30, status: "candidate", source: "contact_sequence", validated: false, contacts: 0, hits_by_player: {}, shot_ids: [],
  winner: null, winner_status: "not supported",
});

const shot = (id: string, frame: number, player: string | null, rallyId: string | null): MatchShot => ({
  id, contact_id: `c${id}`, rally_id: rallyId, frame, time_s: frame / 30, player, type: "unknown", confidence: null,
  evidence_source: "contact candidate", contact_status: "candidate", model_version: null, validation: "unclassified", type_source: "none", type_reason: null, flags: [], speed: null,
  estimated_3d: {
    mode: "estimated_monocular", status: "rejected", label: "Physical trajectory unavailable", speed_candidate_kmh: null, speed_range_kmh: null,
    rejection_reasons: ["contact_not_confirmed", "insufficient_3d_camera_calibration"],
  },
  measured_3d: { mode: "measured_stereo", status: "not_run", label: "Measured 3D: NOT RUN — stereo input unavailable", speed_kmh: null },
});

test("the court uses BWF dimensions and keeps its proportions in any view", () => {
  assert.equal(COURT_M.length, 13.4);
  assert.equal(COURT_M.doublesWidth, 6.1);
  assert.equal(COURT_M.singlesWidth, 5.18);
  assert.ok(Math.abs(COURT_M.doublesWidth - 2 * COURT_M.singlesInset - COURT_M.singlesWidth) < 1e-9);
  const view = { width: 200, height: 300, padding: 10 };
  const nearLeft = courtToView(0, 0, view);
  const farRight = courtToView(COURT_M.doublesWidth, COURT_M.length, view);
  const ratio = (farRight.y - nearLeft.y) / (farRight.x - nearLeft.x);
  assert.ok(Math.abs(ratio - COURT_M.length / COURT_M.doublesWidth) < 1e-9);
  assert.ok(nearLeft.x >= 10 && nearLeft.y >= 10 && farRight.x <= 190 && farRight.y <= 290);
  const net = courtLines().filter((line) => line.kind === "net");
  assert.equal(net.length, 1);
  assert.equal(net[0].y1, 6.7);
});

test("video time and frames stay in sync at the boundaries", () => {
  assert.equal(frameAt(0, 30, 450), 0);
  assert.equal(frameAt(1 / 30, 30, 450), 1); // exactly on a frame boundary
  assert.equal(frameAt(14.999, 30, 450), 449);
  assert.equal(frameAt(20, 30, 450), 449); // clamped to the last frame
  assert.equal(frameAt(-1, 30, 450), 0);
  assert.equal(frameAt(Number.NaN, 30, 450), 0);
  for (const frame of [0, 1, 12, 449]) assert.equal(frameAt(seekTimeFor(frame, 25), 25, 450), frame);
});

test("rally lookup and the rally clock use frame indices", () => {
  const rallies = [rally("r1", 0, 155), rally("r2", 199, 449)];
  assert.equal(rallyAt(rallies, 100)?.id, "r1");
  assert.equal(rallyAt(rallies, 170), null);
  assert.equal(rallyAt(rallies, 199)?.id, "r2");
  assert.equal(rallyClock(rallies[1], 229, 30), 1);
  assert.equal(rallyClock(rallies[0], 400, 30), 155 / 30); // capped at the rally end
});

test("positions, trails and tracking state come from samples, never from guesses", () => {
  const series: PositionPoint[] = [
    [0, 1, 2, "matched"],
    [2, 1.1, 2.1, "matched"],
    [4, null, null, "uncertain"],
    [6, 1.3, 2.3, "recovered"],
  ];
  assert.deepEqual(pointAt(series, 3, 4), [2, 1.1, 2.1, "matched"]);
  assert.equal(pointAt(series, 20, 4), null); // too old
  assert.equal(pointAt([], 3, 4), null);
  assert.deepEqual(trail(series, 6, 1, 30), [{ x: 1, y: 2 }, { x: 1.1, y: 2.1 }, { x: 1.3, y: 2.3 }]);
  assert.equal(trackingState(series, 4, 2), "uncertain");
  assert.equal(trackingState(series, 6, 2), "tracked");
  assert.equal(trackingState(series, 30, 2), "lost");
});

test("the current shot is held briefly and hit counts follow the current rally", () => {
  const rallies = [rally("r1", 0, 100), rally("r2", 150, 300)];
  const shots = [shot("1", 20, "P1", "r1"), shot("2", 50, "P2", "r1"), shot("3", 160, "P4", "r2"), shot("4", 200, null, "r2")];
  assert.equal(shotAt(shots, 55, 30)?.id, "2");
  assert.equal(shotAt(shots, 120, 30), null); // more than 1.2 s after the last contact
  assert.equal(shotAt(shots, 10, 30), null);
  const players = ["P1", "P2", "P3", "P4"];
  assert.deepEqual(hitsSoFar(shots, players, 60, rallies[0]), { P1: 1, P2: 1, P3: 0, P4: 0 });
  assert.deepEqual(hitsSoFar(shots, players, 210, rallies[1]), { P1: 0, P2: 0, P3: 0, P4: 1 });
  assert.deepEqual(hitsSoFar(shots, players, 210, null), { P1: 1, P2: 1, P3: 0, P4: 1 });
});

test("the overlay counts racket hits: this rally when one is active, otherwise all so far", () => {
  const rallies = [rally("r1", 0, 100), rally("r2", 150, 300)];
  const shots = [shot("1", 20, "P1", "r1"), shot("2", 50, "P2", "r1"), shot("3", 160, "P4", "r2"), shot("4", 200, null, "r2")];
  assert.equal(contactsSoFar(shots, 60, rallies[0]), 2);
  assert.equal(contactsSoFar(shots, 10, rallies[0]), 0);
  assert.equal(contactsSoFar(shots, 210, rallies[1]), 2, "a shot without a player still counts as a hit");
  assert.equal(contactsSoFar(shots, 60, rallies[1]), 0);
  assert.equal(contactsSoFar(shots, 210, null), 4);
  assert.equal(contactsSoFar(shots, 120, null), 2);
});

test("the product taxonomy is six strokes plus unknown; legacy labels read as unknown", () => {
  assert.deepEqual([...SHOT_TYPES], ["smash", "clear", "drop", "drive", "net_shot", "lift", "unknown"]);
  assert.equal(productShotType("serve"), "unknown");
  assert.equal(productShotType("push"), "unknown");
  assert.equal(productShotType("defensive_block"), "unknown");
  assert.equal(productShotType("clear"), "clear");
  assert.equal(productShotType("not_a_stroke"), "unknown");
});

/** A match document with a backend dashboard block, as GET /match returns it. */
function dashboardDoc(space: "court_m" | "image_normalized"): MatchDocument {
  const candidate = { ...shot("1", 20, "P1", "r1"), speed: { kmh: null, px_per_s: 1644, kind: "image_space", basis: "automatic_candidate" as const } };
  const confirmed = { ...shot("2", 50, "P2", "r1"), contact_status: "confirmed" as const, speed: { kmh: null, px_per_s: 505, kind: "image_space", basis: "confirmed_contact" as const } };
  return {
    fps: 30, players: ["P1", "P2"],
    court: { dimensions_m: { length_m: 13.4, doubles_width_m: 6.1, singles_width_m: 5.18 } },
    shots: { items: [candidate, confirmed] },
    dashboard: {
      note: "backend",
      players: {
        P1: { contacts: 1, confirmed_contacts: 0, official_max_px_per_s: null, official_mean_px_per_s: null, official_speed_count: 0,
          distance: { value: 27.55, unit: "m", basis: "floor", jumps_skipped: 17, smoothing_frames: 7, max_step_rule: "8 m/s" },
          most_frequent_estimate: { label: "lift", count: 3, of: 6, label_kind: "trajectory_estimate_unverified", badge: "Trajectory estimate · unverified" } },
        P2: { contacts: 1, confirmed_contacts: 1, official_max_px_per_s: 505, official_mean_px_per_s: 505, official_speed_count: 1, distance: null, most_frequent_estimate: null },
      },
      speed_panel: { unit: "px/s", official_count: 1, official_mean_px_per_s: 505, official_max_px_per_s: 505, candidate_count: 1,
        candidate_mean_px_per_s: 1644, rally_mean_duration_s: 3.68, shot_interval_mean_s: 0.893, shot_interval_basis: "within_rally" },
      distance_chart: { unit: "m", basis: "floor", series: { P1: [[0, 0], [1, 2.5], [2, 27.55]], P2: [[0, 0]] } },
      contact_positions: { space, label: "test", items: [{ shot_id: "j-frame-20", timeline_id: "1", frame: 20, player: "P1", x: space === "court_m" ? 3.05 : 0.5, y: space === "court_m" ? 6.7 : 0.25 }] },
    },
  } as unknown as MatchDocument;
}

test("the dashboard shows the backend's numbers verbatim: official speeds from confirmed contacts, never a local formula", () => {
  const doc = dashboardDoc("court_m");
  const rows = playerRows(doc, ["P1", "P2"]);
  assert.equal(rows[0].officialMax, null, "P1 has only a candidate; the 1644 px/s candidate never becomes an official value");
  assert.equal(rows[1].officialMax, 505);
  assert.equal(rows[0].distance, 27.55);
  assert.equal(rows[0].distanceUnit, "m");
  assert.deepEqual(rows[0].mostFrequent, { label: "lift", count: 3, of: 6 });
  assert.equal(rows[1].distance, null);
  const panel = speedPanel(doc)!;
  assert.equal(panel.official_mean_px_per_s, 505);
  assert.equal(panel.candidate_count, 1);
  assert.equal(panel.shot_interval_basis, "within_rally");
  const distance = distanceView(doc, ["P1", "P2"])!;
  assert.deepEqual(distance.series.map((item) => [item.id, item.total]), [["P1", 27.55]], "the chart ends at the backend distance");
});

test("contact positions use the backend's space: feet in floor metres, or the shuttle's image position", () => {
  const court = contactDots(dashboardDoc("court_m"))!;
  assert.equal(court.space, "court_m");
  assert.ok(Math.abs(court.dots[0].left - 0.5) < 1e-9 && Math.abs(court.dots[0].top - 0.5) < 1e-9, "the net centre is the middle of the court box");
  const image = contactDots(dashboardDoc("image_normalized"))!;
  assert.equal(image.space, "image_normalized");
  assert.deepEqual([image.dots[0].left, image.dots[0].top], [0.5, 0.25]);
});

test("the timeline label is a person's six-class label, else the estimate; never unknown", () => {
  const estimate = { ...shot("1", 20, "P1", "r1"), trajectory: { best_guess_label: "lift", evidence_tier: "full_trajectory", evidence_quality: "high", review_status: "needs_review", shot_id: "j-frame-20" } };
  assert.equal(shotLabel(estimate), "lift");
  assert.equal(shotLabel({ ...estimate, type: "smash", type_source: "manual" }), "smash");
  assert.equal(shotLabel({ ...estimate, person_label_note: "unknown" }), "lift", "a person's 'unknown' note keeps the estimate");
  assert.equal(pxPerSecond(504.6), 505);
  assert.equal(pxPerSecond(null), null);
});

test("image motion is shown only as a measured, rounded value", () => {
  assert.equal(motionValue(null), null);
  assert.equal(motionValue(undefined), null);
  assert.equal(motionValue(Number.NaN), null);
  assert.equal(motionValue(127.64), 128);
  assert.equal(motionValue(32.4), 32);
});

test("the match document parser rejects malformed input", () => {
  const valid = {
    schema: "smashlab.match/v1", fps: 30, players: ["P1", "P2", "P3", "P4"], court: {}, speed: { status: "uncalibrated" },
    positions: { series: {} }, contacts: { items: [] }, rallies: { items: [] }, shots: { items: [] }, summary: {},
  };
  assert.ok(parseMatchDocument(valid));
  assert.equal(parseMatchDocument({ ...valid, schema: "other" }), null);
  assert.equal(parseMatchDocument({ ...valid, players: [1] }), null);
  assert.equal(parseMatchDocument({ ...valid, fps: 0 }), null);
  assert.equal(parseMatchDocument({ ...valid, shots: {} }), null);
  assert.equal(parseMatchDocument(null), null);
  assert.equal(parseMatchDocument("text"), null);
});

test("shot types and the clock format", () => {
  assert.ok(isShotType("net_shot"));
  assert.ok(isShotType("unknown"));
  assert.equal(isShotType("laser"), false);
  assert.equal(formatClock(5.24), "0:05.2");
  assert.equal(formatClock(75), "1:15.0");
  assert.equal(formatClock(-1), "–");
});

test("the ground-truth export writes only human decisions as labels", () => {
  const manual = { ...shot("2", 40, "P2", null), type: "smash", type_source: "manual" as const, contact_status: "confirmed" as const };
  const rejected = { ...shot("3", 80, "P1", null), contact_status: "rejected" as const };
  const doc = { fps: 30, players: ["P1", "P2"], shots: { items: [shot("1", 10, "P1", null), manual, rejected] }, rallies: { items: [] }, annotations: { transferred: [], unmatched: [{ type: "shot_label", frame: 99, reason: "no candidate", source_job_id: "old", correction_id: "x" }] } } as unknown as Parameters<typeof buildGroundTruth>[0];
  const out = buildGroundTruth(doc, "job-x", "2026-11-17T00:00:00.000Z");
  assert.equal(out.schema, "smashlab.ground-truth/v1");
  assert.deepEqual(out.shots.map((item) => [item.shot_id, item.shot_type, item.label_source, item.contact_status]), [
    ["1", null, null, "candidate"],
    ["2", "smash", "manual", "confirmed"],
    ["3", null, null, "rejected"],
  ]);
  assert.equal(out.shots[0].candidate_source, "contact candidate");
  assert.equal(out.shots[0].trajectory_estimate, null);
  assert.equal(out.unmatched_annotations.length, 1, "unmatched annotations stay in the export for review");
  assert.deepEqual(out.confirmed_rally_boundaries, []);
});


// The shared observed-2D track as the backend sends it: [frame, x, y, "d" | "i", run]. Removed points are not in `points`.
function observedBlock(points: Observed2DBlock["points"]): Observed2DBlock {
  return {
    version: "observed-2d/v1",
    config: {},
    frame_size: [1920, 1080],
    fps: 30,
    timestamp_source: "presentation_timestamp",
    max_speed_px_s: 4956,
    frames_total: 40,
    frames_without_position: 0,
    detected: points.filter((point) => point[3] === "d").length,
    interpolated: points.filter((point) => point[3] === "i").length,
    rejected: { tracker_jump: 2 },
    rejected_total: 2,
    invalid_steps: 0,
    segments: new Set(points.map((point) => point[4])).size,
    coordinate_space: "image_px",
    points,
    rejected_points: [
      [8, 120, 900, "tracker_jump"],
      [9, 125, 910, "tracker_jump"],
    ],
  };
}

test("the results-page path follows the backend runs and sources and never joins a removed point", () => {
  const observed = observedBlock([
    [5, 100, 100, "d", 0],
    [6, 110, 102, "d", 0],
    [7, 120, 104, "d", 0],
    [10, 150, 110, "i", 0], // frames 8-9 were removed: the run continues with an InpaintNet fill
    [11, 160, 112, "d", 0],
    [20, 900, 300, "d", 1], // a new backend run
    [21, 910, 301, "d", 1],
  ]);
  const runs = observedPathRuns(observed);
  assert.deepEqual(
    runs.map((run) => [run.interpolated, run.points.length]),
    [
      [false, 3],
      [true, 2],
      [false, 2],
      [false, 2],
    ],
  );
  assert.deepEqual(runs[1].points[0], [120, 104], "a source change starts at the previous kept point");
  assert.ok(!runs.flatMap((run) => run.points).some(([x, y]) => (x === 120 && y === 900) || (x === 125 && y === 910)));
  assert.deepEqual(runs[3].points[0], [900, 300], "a run break leaves a gap");
});

test("the evidence trail mirrors the annotated video: kept points of the current run, cleared after 3 empty frames", () => {
  const points = orderedPoints(
    observedBlock([
      [1, 10, 10, "d", 0],
      [2, 20, 10, "d", 0],
      [3, 30, 10, "i", 0],
      [6, 60, 10, "d", 0], // removed points 4-5 do not break the run
      [12, 500, 500, "d", 1],
    ]),
  );
  assert.deepEqual(annotatedTrail(points, 6, 8), { trail: [[10, 10], [20, 10], [30, 10], [60, 10]], current: [60, 10] });
  assert.deepEqual(annotatedTrail(points, 6, 2).trail, [[30, 10], [60, 10]]);
  assert.equal(annotatedTrail(points, 9, 8).current, null, "no marker on a frame without a kept point");
  assert.deepEqual(annotatedTrail(points, 9, 8).trail, [[10, 10], [20, 10], [30, 10], [60, 10]]);
  assert.deepEqual(annotatedTrail(points, 10, 8), { trail: [], current: null });
  assert.deepEqual(annotatedTrail(points, 12, 8).trail, [[500, 500]], "a new backend run starts a new trail");
  assert.deepEqual(annotatedTrail(points, 0, 8), { trail: [], current: null });
});
