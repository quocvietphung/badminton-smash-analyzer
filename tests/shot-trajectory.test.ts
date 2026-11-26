import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  SIDE_VIEW,
  SIX_TYPES,
  TEMPLATE_ORDER,
  WINDOW_AFTER,
  WINDOW_BEFORE,
  buildShotPath,
  findRecordForShot,
  frameSeekTime,
  isSixType,
  resolveLabels,
  checksOf,
  sideTemplate,
  truncationReason,
  uncertaintyView,
  zoomBox,
  type ShuttleObservation,
} from "../src/lib/match/shot-trajectory.ts";
import {
  getSelectedShotId,
  setSelectedShotId,
  subscribeSelectedShot,
} from "../src/lib/match/shot-selection.ts";
import type { TrajectoryEstimate, TrajectoryPoint } from "../src/lib/match/types.ts";

const FPS = 30;

function point(frame: number, x: number, y: number, interpolated = false): TrajectoryPoint {
  return { frame, time_s: Math.round((frame / FPS) * 1000) / 1000, x_px: x, y_px: y, confidence: 0.7, interpolated };
}

/** A synthetic record in the shape of one row of shot_trajectory_dataset.jsonl. Used only where a fixture is stated. */
function fixture(overrides: Partial<TrajectoryEstimate> = {}): TrajectoryEstimate {
  const contact = 100;
  const before = Array.from({ length: WINDOW_BEFORE }, (_, index) => point(contact - WINDOW_BEFORE + index, 500, 100 + index * 10));
  const after = Array.from({ length: WINDOW_AFTER }, (_, index) => point(contact + 1 + index, 500 + index, 260 - index));
  return {
    shot_id: "job-frame-100",
    job_id: "job",
    run_id: "run",
    frame: contact,
    timestamp_s: contact / FPS,
    player: "P1",
    contact_status: "candidate",
    best_guess_label: "smash",
    review_status: "needs_review",
    evidence_tier: "full_trajectory",
    evidence_quality: "high",
    rule_version: "trajectory-rules/v1",
    frame_size: [1920, 1080],
    label_kind: "trajectory_estimate_unverified",
    manual_label: null,
    contact_image: { x_px: 500, y_px: 220, x_normalized: 0.26, y_normalized: 0.2 },
    player_court_context: {
      court_calibrated: true,
      player_side: "far",
      player_foot_x_m: 5,
      player_foot_y_m: 0.5,
      distance_to_net_m: 6,
      relative_to_net: "back_court",
    },
    trajectory_before: before,
    trajectory_after: after,
    features: {},
    scores: { smash: 0.26, drop: 0.23, clear: 0.19, drive: 0.05, net_shot: 0.17, lift: 0.1 },
    top3: [["smash", 0.26], ["drop", 0.23], ["clear", 0.19]],
    missing_features: [],
    review_reasons: ["contact is not confirmed by a person", "small margin between the best and second class (0.0344)"],
    quality_warnings: [],
    offset_labels: {},
    ...overrides,
  } as TrajectoryEstimate;
}

// ---------------------------------------------------------------------------
// Real artifacts: job ccb6646d94bd4b109d7a821f1e3f09fd, frame 399 (13.30 s, P1, AI prediction smash).
// The test reads the saved outputs when they exist and skips otherwise. It never writes to them.
// ---------------------------------------------------------------------------
const REAL_JOB = path.join(process.cwd(), "outputs", "ccb6646d94bd4b109d7a821f1e3f09fd");
const REAL_DATASET = path.join(REAL_JOB, "derived", "shot_trajectory_dataset.jsonl");
const REAL_SHUTTLE = path.join(REAL_JOB, "shuttle_trajectory.json");

test("frame 399 of the known job matches the saved shuttle observations", { skip: !existsSync(REAL_DATASET) || !existsSync(REAL_SHUTTLE) }, () => {
  const records = readFileSync(REAL_DATASET, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as TrajectoryEstimate);
  const record = records.find((item) => item.frame === 399);
  assert.ok(record, "frame 399 is in the dataset");
  assert.equal(record.player, "P1");
  assert.equal(record.timestamp_s, 13.3);
  assert.equal(record.best_guess_label, "smash", "the AI prediction is kept as it was saved");
  assert.equal(record.manual_label, null);
  assert.equal(record.run_id, "20261118T171901Z-trajectory-rules-v1");

  const shuttle = JSON.parse(readFileSync(REAL_SHUTTLE, "utf8")) as { frames: Array<{ frame: number; x: number | null; y: number | null; visible: boolean }> };
  const byFrame = new Map(shuttle.frames.map((frame) => [frame.frame, frame]));
  const path_ = buildShotPath(record);
  assert.equal(path_.counts.before, WINDOW_BEFORE);
  assert.equal(path_.counts.after, WINDOW_AFTER);
  for (const item of path_.points) {
    if (item.role === "contact") continue;
    const raw = byFrame.get(item.frame);
    assert.ok(raw, `frame ${item.frame} exists in shuttle_trajectory.json`);
    assert.equal(item.xPx, raw.x, `x at frame ${item.frame}`);
    assert.equal(item.yPx, raw.y, `y at frame ${item.frame}`);
  }
  // The contact candidate sits on the observed shuttle position of its own frame.
  const contactRaw = byFrame.get(399);
  assert.ok(contactRaw && path_.contact);
  assert.equal(path_.contact.xPx, contactRaw.x);
  assert.equal(path_.contact.yPx, contactRaw.y);
});

// ---------------------------------------------------------------------------
// Path construction from the stored record
// ---------------------------------------------------------------------------

test("the path keeps before, contact and after in frame order, with the contact between them", () => {
  const path_ = buildShotPath(fixture());
  const frames = path_.points.map((item) => item.frame);
  assert.deepEqual(frames, [...frames].sort((a, b) => a - b));
  assert.equal(path_.contact?.frame, 100);
  assert.equal(path_.points.find((item) => item.frame === 100)?.role, "contact");
  assert.equal(path_.runs.length, 1, "consecutive frames form one run");
  assert.equal(path_.counts.breaks, 0);
});

test("a missing stretch of frames without interpolation starts a new run", () => {
  const record = fixture();
  record.trajectory_after = [...record.trajectory_after.slice(0, 10), ...record.trajectory_after.slice(15)];
  const path_ = buildShotPath(record);
  assert.equal(path_.runs.length, 2);
  assert.equal(path_.counts.breaks, 1);
});

test("a gap whose end is interpolated is bridged, not broken", () => {
  const record = fixture();
  // Frames 111 to 115 are missing; the point at frame 116 was filled in by interpolation, which justifies the bridge.
  record.trajectory_after = record.trajectory_after
    .filter((item) => item.frame < 111 || item.frame > 115)
    .map((item) => (item.frame === 116 ? { ...item, interpolated: true } : item));
  const path_ = buildShotPath(record);
  assert.equal(path_.runs.length, 1, "the interpolated end justifies the bridge");
  assert.equal(path_.counts.breaks, 0);
  assert.equal(path_.counts.refined, 1, "an InpaintNet fill is counted apart from detections");
});

test("the contact candidate joins both sides when its neighbours are observed", () => {
  const path_ = buildShotPath(fixture());
  const contactIndex = path_.points.findIndex((item) => item.role === "contact");
  assert.equal(path_.points[contactIndex - 1].frame, 99);
  assert.equal(path_.points[contactIndex + 1].frame, 101);
});

test("without a contact candidate, the missing contact frame is a break, not a guess", () => {
  const record = fixture({ contact_image: { x_px: null, y_px: null, x_normalized: null, y_normalized: null } });
  const path_ = buildShotPath(record);
  assert.equal(path_.contact, null);
  assert.equal(path_.runs.length, 2);
  assert.equal(path_.counts.breaks, 1);
});

test("a truncated window is reported, not padded", () => {
  const record = fixture();
  record.trajectory_after = record.trajectory_after.slice(0, 9);
  const path_ = buildShotPath(record);
  assert.equal(path_.counts.after, 9);
  assert.equal(path_.counts.truncatedAfter, true);
  assert.equal(path_.counts.truncatedBefore, false);
  assert.equal(path_.counts.expectedAfter, WINDOW_AFTER);
});

test("the last observed point is the last one that was not interpolated", () => {
  const record = fixture();
  const last = record.trajectory_after[record.trajectory_after.length - 1];
  record.trajectory_after[record.trajectory_after.length - 1] = { ...last, interpolated: true };
  const path_ = buildShotPath(record);
  assert.ok(path_.lastObserved);
  assert.equal(path_.lastObserved.interpolated, false);
  assert.equal(path_.lastObserved.frame, last.frame - 1);
});

test("a frame stored twice is kept once", () => {
  const record = fixture();
  record.trajectory_after = [...record.trajectory_after, record.trajectory_after[0]];
  const path_ = buildShotPath(record);
  const frames = path_.points.map((item) => item.frame);
  assert.equal(new Set(frames).size, frames.length);
});

// ---------------------------------------------------------------------------
// Actual 2D framing: the aspect ratio of the source is kept
// ---------------------------------------------------------------------------

test("the zoomed view keeps the frame's aspect ratio and contains every point", () => {
  const path_ = buildShotPath(fixture());
  const box = zoomBox(1920, 1080, path_.points);
  assert.ok(Math.abs(box.width / box.height - 1920 / 1080) < 1e-9);
  for (const item of path_.points) {
    assert.ok(item.xPx >= box.x && item.xPx <= box.x + box.width, "x inside");
    assert.ok(item.yPx >= box.y && item.yPx <= box.y + box.height, "y inside");
  }
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 1920 && box.y + box.height <= 1080);
});

test("a path that spans the frame falls back to the whole frame", () => {
  const box = zoomBox(1920, 1080, [{ xPx: 0, yPx: 0 }, { xPx: 1919, yPx: 1079 }]);
  assert.deepEqual(box, { x: 0, y: 0, width: 1920, height: 1080 });
});

test("with no points the zoomed view is the whole frame", () => {
  assert.deepEqual(zoomBox(848, 464, []), { x: 0, y: 0, width: 848, height: 464 });
});

// ---------------------------------------------------------------------------
// Matching shots to records, labels and corrections
// ---------------------------------------------------------------------------

test("a shot is matched to its record by analysis and frame, never by frame alone", () => {
  const records = [fixture({ job_id: "job", frame: 100 }), fixture({ job_id: "job", frame: 200, shot_id: "job-frame-200" })];
  assert.equal(findRecordForShot(records, { frame: 200 }, "job")?.shot_id, "job-frame-200");
  assert.equal(findRecordForShot(records, { frame: 300 }, "job"), null);
  // A record of another analysis at the same frame does not match this shot.
  assert.equal(findRecordForShot(records, { frame: 200 }, "other-job"), null);
});

test("the frame seek time lands inside the frame's own time slot", () => {
  for (const frame of [0, 1, 399, 448]) {
    const t = frameSeekTime(frame, 30);
    assert.ok(t >= frame / 30 && t < (frame + 1) / 30, `frame ${frame}`);
  }
  assert.equal(frameSeekTime(10, 0), 0);
});

test("the AI prediction is shown and the side view uses it when nobody has labelled the shot", () => {
  const labels = resolveLabels(fixture());
  assert.equal(labels.aiLabel, "smash");
  assert.equal(labels.reviewedLabel, null);
  assert.equal(labels.sideLabel, "smash");
  assert.equal(labels.uncertain, true, "the top two classes are close");
  assert.equal(labels.reviewStatus, "needs_review");
});

test("a person's correction changes the side view but never the AI prediction, scores or measured path", () => {
  const original = fixture();
  const corrected = fixture({ manual_label: "clear" });
  const before = resolveLabels(original);
  const after = resolveLabels(corrected);
  assert.equal(after.aiLabel, "smash", "the original AI prediction is preserved");
  assert.equal(after.reviewedLabel, "clear");
  assert.equal(after.sideLabel, "clear", "the side view draws the reviewed label");
  assert.deepEqual(after.scores, before.scores, "rule scores are unchanged");
  assert.deepEqual(after.top3, before.top3);
  assert.deepEqual(buildShotPath(corrected), buildShotPath(original), "the measured 2D path is identical before and after");
});

test("a correction that is not one of the six classes is ignored, not invented", () => {
  const labels = resolveLabels(fixture({ manual_label: "clear_attacking" }));
  assert.equal(labels.reviewedLabel, null);
  assert.equal(labels.sideLabel, "smash");
});

test("a shot without a six-class label has no side view template", () => {
  const labels = resolveLabels(fixture({ best_guess_label: "unknown", manual_label: null }));
  assert.equal(labels.sideLabel, null);
  assert.equal(sideTemplate(labels.sideLabel), null);
});

// ---------------------------------------------------------------------------
// Side View templates: illustrative, one per six-class label, drawn inside the 400 x 240 box
// ---------------------------------------------------------------------------

test("there are exactly six templates and they are the six classes, with no subtypes", () => {
  assert.deepEqual([...TEMPLATE_ORDER].sort(), [...SIX_TYPES].sort());
  assert.equal(SIX_TYPES.length, 6);
  for (const label of SIX_TYPES) assert.ok(isSixType(label));
  assert.equal(isSixType("unknown"), false);
  assert.equal(isSixType("clear_attacking"), false);
});

test("every template starts at its contact, ends at its end marker and stays inside the side view", () => {
  for (const label of SIX_TYPES) {
    const template = sideTemplate(label);
    assert.ok(template, `${label} has a template`);
    assert.equal(template.label, label);
    assert.ok(template.d.startsWith(`M${template.contact.x} ${template.contact.y} `), `${label} starts at its contact`);
    const numbers = template.d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
    assert.equal(numbers.length % 2, 0, `${label} has coordinate pairs`);
    const xs = numbers.filter((_, index) => index % 2 === 0);
    const ys = numbers.filter((_, index) => index % 2 === 1);
    assert.ok(xs.every((value) => value >= 0 && value <= SIDE_VIEW.width), `${label} x inside the box`);
    assert.ok(ys.every((value) => value >= 0 && value <= SIDE_VIEW.height), `${label} y inside the box`);
    assert.ok(template.d.endsWith(`${template.end.x} ${template.end.y}`), `${label} ends at its end marker`);
    assert.ok(template.contact.y < SIDE_VIEW.ground, `${label} contact is above the ground`);
  }
});

test("the templates describe the shot types as the brief does", () => {
  const contact = (label: (typeof SIX_TYPES)[number]) => sideTemplate(label)!.contact.y;
  assert.ok(contact("smash") < contact("drive"), "smash is struck higher than a drive");
  assert.ok(contact("net_shot") > contact("drop"), "a net shot is struck low, near the net");
  assert.ok(sideTemplate("lift")!.end.x > SIDE_VIEW.netX, "a lift travels to the opponent's side");
  assert.ok(sideTemplate("net_shot")!.end.x - SIDE_VIEW.netX < 60, "a net shot stays close to the net");
  assert.ok(sideTemplate("drop")!.end.x > SIDE_VIEW.netX, "a drop lands past the net");
});

// ---------------------------------------------------------------------------
// Selection shared by the dashboard views
// ---------------------------------------------------------------------------

test("the selected shot is shared per analysis and announced to listeners", () => {
  let calls = 0;
  const unsubscribe = subscribeSelectedShot(() => {
    calls += 1;
  });
  assert.equal(getSelectedShotId("job-a"), null);
  setSelectedShotId("job-a", "s3");
  assert.equal(getSelectedShotId("job-a"), "s3");
  assert.equal(getSelectedShotId("job-b"), null, "another analysis keeps its own selection");
  setSelectedShotId("job-a", "s3");
  assert.equal(calls, 1, "setting the same value does not announce a change");
  setSelectedShotId("job-a", null);
  assert.equal(getSelectedShotId("job-a"), null);
  unsubscribe();
});

// ---------------------------------------------------------------------------
// Provenance, suspicious tracking and integrity checks against the shuttle file
// ---------------------------------------------------------------------------

// The checks themselves are computed on the backend (observed-2d tracking_checks, backend/tests/test_observed2d.py);
// the studio only shows them.
test("tracking checks are read from the record, with TrackNet and InpaintNet counted apart", () => {
  const record = fixture({
    tracking_checks: [
      { kind: "constant_x", from: 385, to: 400, length: 16, value: 1237, other_range_px: 217, detected: 16, interpolated: 0 },
      { kind: "repeated_interpolation", from: 393, to: 394, x: 1237, y: 123, detected: 0, interpolated: 2 },
    ],
  });
  assert.deepEqual(checksOf(record).map((check) => check.kind), ["constant_x", "repeated_interpolation"]);
  assert.deepEqual(checksOf(fixture()), [], "a record from an older rule version has no checks");
});

test("v2 records: runs come from the backend segments and removed points are drawn apart, never joined", () => {
  const record = fixture();
  record.trajectory_before = record.trajectory_before.map((item) => ({ ...item, source: "detected" as const, segment: 0 }));
  record.trajectory_after = record.trajectory_after.map((item, index) => ({ ...item, source: "detected" as const, segment: index < 20 ? 0 : 1 }));
  record.rejected_points = [{ frame: 130, time_s: 130 / FPS, x_px: 900, y_px: 700, confidence: 0.7, source: "detected", reason: "tracker_jump" }];
  record.window = { first_frame: 88, last_frame: 145, before: { expected: 12, kept: 12 }, after: { expected: 45, kept: 45, truncated_reason: null }, detected: 57, interpolated: 0, rejected: { tracker_jump: 1 }, invalid_steps: 0 };
  const path_ = buildShotPath(record);
  assert.equal(path_.runs.length, 2, "the backend split the run after an implausible step");
  assert.equal(path_.counts.breaks, 1);
  assert.equal(path_.counts.rejected, 1);
  assert.deepEqual(path_.rejected.map((mark) => [mark.frame, mark.reason]), [[130, "tracker_jump"]]);
  assert.ok(path_.points.every((item) => item.frame !== 130 || item.xPx !== 900), "a removed point never enters the path");
  assert.equal(path_.contact?.segment, 0, "the contact takes the run of its neighbours");
});

test("the truncation reason and expected window come from the backend when the record has them", () => {
  const record = fixture();
  record.trajectory_after = record.trajectory_after.slice(0, 14);
  record.window = { first_frame: 88, last_frame: 145, before: { expected: 12, kept: 12 }, after: { expected: 45, kept: 14, truncated_reason: "video_end" }, detected: 26, interpolated: 0, rejected: {}, invalid_steps: 0 };
  assert.equal(buildShotPath(record).counts.truncatedAfterReason, "video_end");
});

test("a record that names its timeline row only matches that row", () => {
  const records = [fixture({ timeline_id: "s7" })];
  assert.equal(findRecordForShot(records, { frame: 100, id: "s7" }, "job")?.shot_id, "job-frame-100");
  assert.equal(findRecordForShot(records, { frame: 100, id: "s8" }, "job"), null);
  assert.equal(findRecordForShot(records, { frame: 100 }, "job")?.shot_id, "job-frame-100");
});

test("a person's note outside the six classes is kept as a note and never drawn as a stroke", () => {
  const labels = resolveLabels(fixture({ person_label_note: "unknown" }));
  assert.equal(labels.personNote, "unknown");
  assert.equal(labels.reviewedLabel, null);
  assert.equal(labels.sideLabel, "smash");
});

test("the uncertainty view keeps the rule scores as scores, not probabilities", () => {
  const view = uncertaintyView(resolveLabels(fixture()));
  assert.equal(view.uncertain, true);
  assert.deepEqual(view.ranked.map((item) => item.label), ["smash", "drop", "clear"]);
  for (const item of view.ranked) assert.ok(item.score >= 0 && item.score <= 1, "a score in the rule scale, never a percentage");
  assert.equal(uncertaintyView(resolveLabels(fixture({ review_reasons: ["contact is not confirmed by a person"] }))).uncertain, false);
});

test("truncated after-windows say whether the video ended or the shuttle was not tracked", () => {
  assert.equal(truncationReason(45, 45, 100, 449), null);
  assert.equal(truncationReason(45, 14, 433, 449), "video_end", "433 + 45 is past the last frame 449");
  assert.equal(truncationReason(45, 36, 119, 449), "tracking");
  assert.equal(truncationReason(45, 9, 146, null), "tracking");
});

const REAL_SHUTTLE_JSON = path.join(process.cwd(), "outputs", "ccb6646d94bd4b109d7a821f1e3f09fd", "shuttle_trajectory.json");

test("the shot at frame 399 is checked against the shuttle file: provenance and integrity", { skip: !existsSync(REAL_DATASET) || !existsSync(REAL_SHUTTLE_JSON) }, () => {
  const records = readFileSync(REAL_DATASET, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as TrajectoryEstimate);
  const record = records.find((item) => item.frame === 399)!;
  const file = JSON.parse(readFileSync(REAL_SHUTTLE_JSON, "utf8")) as { frames: Array<{ frame: number; x: number | null; y: number | null; visible: boolean; refined: boolean }> };
  const shuttle = new Map<number, ShuttleObservation>(file.frames.map((item) => [item.frame, { visible: item.visible, refined: item.refined, x: item.x, y: item.y }]));

  const path_ = buildShotPath(record, shuttle, 449);
  assert.equal(path_.integrity.checked, true);
  assert.equal(path_.integrity.mismatches, 0, "every measured point equals the shuttle file");
  assert.equal(path_.integrity.missingFromFile, 0);
  assert.equal(path_.integrity.visibleButMissing, 0, "no visible observation was dropped from this window");
  assert.equal(path_.counts.refined, 0);
  assert.equal(path_.counts.truncatedAfter, false);
});

test("the refined points of the known job are not counted as measured detections", { skip: !existsSync(REAL_DATASET) || !existsSync(REAL_SHUTTLE_JSON) }, () => {
  const records = readFileSync(REAL_DATASET, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as TrajectoryEstimate);
  const file = JSON.parse(readFileSync(REAL_SHUTTLE_JSON, "utf8")) as { frames: Array<{ frame: number; x: number | null; y: number | null; visible: boolean; refined: boolean }> };
  const shuttle = new Map<number, ShuttleObservation>(file.frames.map((item) => [item.frame, { visible: item.visible, refined: item.refined, x: item.x, y: item.y }]));
  const record = records.find((item) => item.frame === 25)!;
  const path_ = buildShotPath(record, shuttle, 449);
  assert.equal(path_.counts.refined, 5, "frames 32 to 37 were refined by InpaintNet, and the dataset flags them as interpolated");
  assert.ok(path_.points.filter((point) => point.provenance === "refined").every((point) => point.matchesFile === null));
});
