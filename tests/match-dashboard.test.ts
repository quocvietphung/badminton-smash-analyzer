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
  confirmedMotionByPlayer,
  confirmedMotionHeadline,
  shotAt,
  motionValue,
  trackingState,
  trail,
} from "../src/lib/match/analytics.ts";
import type { MatchRally, MatchShot, PositionPoint } from "../src/lib/match/types.ts";

const rally = (id: string, start: number, end: number): MatchRally => ({
  id, index: Number(id.slice(1)), start_frame: start, end_frame: end, start_s: start / 30, end_s: end / 30,
  duration_s: (end - start) / 30, status: "candidate", source: "contact_sequence", validated: false, contacts: 0, hits_by_player: {}, shot_ids: [],
  winner: null, winner_status: "not supported",
});

const shot = (id: string, frame: number, player: string | null, rallyId: string | null): MatchShot => ({
  id, contact_id: `c${id}`, rally_id: rallyId, frame, time_s: frame / 30, player, type: "unknown", confidence: null,
  evidence_source: "contact candidate", contact_status: "candidate", model_version: null, validation: "unclassified", type_source: "none", type_reason: null, flags: [], speed: null,
  physical_speed: {
    status: "unavailable", label: "Physical speed unavailable", not_radar_validated: true, reason_codes: ["contact_not_confirmed"],
    speed_first_observed_kmh: null, speed_at_net_kmh: null, speed_at_contact_extrapolated_kmh: null, uncertainty_kmh: null,
    method: "test", evidence: {}, calibration: {}, assumptions: {}, quality: { passed: false }, runtime_ms: 0,
  },
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

test("the headline motion comes only from confirmed contacts, never from automatic candidates", () => {
  const shots = [
    { player: "P1", speed: { kmh: null, px_per_s: 1644, kind: "image_space", basis: "automatic_candidate" as const } },
    { player: "P1", speed: { kmh: null, px_per_s: 505, kind: "image_space", basis: "confirmed_contact" as const } },
    { player: "P2", speed: { kmh: null, px_per_s: 302, kind: "image_space", basis: "confirmed_contact" as const } },
    { player: null, speed: null },
  ];
  assert.deepEqual(confirmedMotionHeadline(shots), { pxPerSecond: 505, count: 2 });
  assert.deepEqual(confirmedMotionHeadline([shots[0]]), { pxPerSecond: null, count: 0 });
  assert.deepEqual(confirmedMotionHeadline([]), { pxPerSecond: null, count: 0 });
  assert.deepEqual(confirmedMotionByPlayer(shots, ["P1", "P2", "P3"]), { P1: 505, P2: 302, P3: null });
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
