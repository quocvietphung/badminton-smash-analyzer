import assert from "node:assert/strict";
import test from "node:test";
import {
  createMultiPoseTrackerState,
  hitTestTrackedPose,
  updateMultiPoseTracker,
} from "../src/lib/multi-pose-tracker.ts";
import type { PoseAppearance, ShirtColor } from "../src/lib/pose-appearance.ts";

function appearance(bin: number, shirtColor: ShirtColor): PoseAppearance {
  const histogram = Array.from({ length: 21 }, () => 0);
  histogram[bin] = 1;
  return { histogram, shirtColor, confidence: 0.9, sampleCount: 120 };
}

function pose(centerX: number, centerY = 0.54, scale = 1, shirt?: PoseAppearance) {
  const point = (x: number, y: number) => ({
    x: centerX + (x - 0.5) * scale,
    y: centerY + (y - 0.54) * scale,
    z: 0,
    visibility: 1,
  });
  const landmarks = Array.from({ length: 33 }, () => point(0.5, 0.54));
  landmarks[0] = point(0.5, 0.15);
  landmarks[11] = point(0.44, 0.35);
  landmarks[12] = point(0.56, 0.35);
  landmarks[13] = point(0.4, 0.47);
  landmarks[14] = point(0.6, 0.47);
  landmarks[15] = point(0.38, 0.61);
  landmarks[16] = point(0.62, 0.61);
  landmarks[23] = point(0.46, 0.56);
  landmarks[24] = point(0.54, 0.56);
  landmarks[25] = point(0.45, 0.73);
  landmarks[26] = point(0.55, 0.73);
  landmarks[27] = point(0.44, 0.93);
  landmarks[28] = point(0.56, 0.93);
  return { landmarks, ...(shirt ? { appearance: shirt } : {}) };
}

test("keeps athlete IDs when MediaPipe changes detection order", () => {
  let state = createMultiPoseTrackerState();
  let result = updateMultiPoseTracker(state, [pose(0.27), pose(0.72)], 0);
  state = result.state;
  const leftId = result.poses.find((entry) => entry.bounds.centerX < 0.5)!.trackId;
  const rightId = result.poses.find((entry) => entry.bounds.centerX > 0.5)!.trackId;

  result = updateMultiPoseTracker(state, [pose(0.69), pose(0.3)], 40);
  assert.equal(result.poses.find((entry) => entry.bounds.centerX < 0.5)?.trackId, leftId);
  assert.equal(result.poses.find((entry) => entry.bounds.centerX > 0.5)?.trackId, rightId);
});

test("keeps four athlete IDs stable when detections are reordered", () => {
  let result = updateMultiPoseTracker(
    createMultiPoseTrackerState(),
    [pose(0.14, 0.42, 0.72), pose(0.38, 0.56, 0.78), pose(0.63, 0.44, 0.7), pose(0.84, 0.58, 0.74)],
    0,
  );
  const expected = [...result.poses]
    .sort((left, right) => left.bounds.centerX - right.bounds.centerX)
    .map((entry) => entry.trackId);
  result = updateMultiPoseTracker(
    result.state,
    [pose(0.83, 0.58, 0.74), pose(0.15, 0.42, 0.72), pose(0.62, 0.44, 0.7), pose(0.39, 0.56, 0.78)],
    40,
  );
  assert.deepEqual(
    [...result.poses].sort((left, right) => left.bounds.centerX - right.bounds.centerX).map((entry) => entry.trackId),
    expected,
  );
});

test("keeps a selected athlete ID through a short occlusion", () => {
  let state = createMultiPoseTrackerState();
  let result = updateMultiPoseTracker(state, [pose(0.35)], 0);
  const id = result.poses[0].trackId;
  state = result.state;
  state = updateMultiPoseTracker(state, [], 300).state;
  result = updateMultiPoseTracker(state, [pose(0.38)], 620);
  assert.equal(result.poses[0].trackId, id);
});

test("uses shirt appearance to avoid an ID swap when athletes cross", () => {
  const red = appearance(0, "red");
  const blue = appearance(11, "blue");
  let result = updateMultiPoseTracker(createMultiPoseTrackerState(), [pose(0.35, 0.54, 1, red), pose(0.65, 0.54, 1, blue)], 0);
  const redId = result.poses.find((entry) => entry.appearance?.shirtColor === "red")!.trackId;
  const blueId = result.poses.find((entry) => entry.appearance?.shirtColor === "blue")!.trackId;

  result = updateMultiPoseTracker(result.state, [pose(0.56, 0.54, 1, blue), pose(0.44, 0.54, 1, red)], 40);
  result = updateMultiPoseTracker(result.state, [pose(0.47, 0.54, 1, blue), pose(0.53, 0.54, 1, red)], 80);

  assert.equal(result.poses.find((entry) => entry.observedAppearance?.shirtColor === "red")?.trackId, redId);
  assert.equal(result.poses.find((entry) => entry.observedAppearance?.shirtColor === "blue")?.trackId, blueId);
});

test("keeps one athlete ID when screen color and pose fluctuate", () => {
  const colors = [
    appearance(0, "red"),
    appearance(11, "blue"),
    appearance(20, "white"),
    appearance(19, "gray"),
  ];
  let result = updateMultiPoseTracker(
    createMultiPoseTrackerState(),
    [pose(0.5, 0.54, 1, colors[0])],
    0,
  );
  const athleteId = result.poses[0].trackId;
  for (let frame = 1; frame <= 60; frame += 1) {
    const centerX = 0.5 + Math.sin(frame * 0.42) * 0.12;
    const scale = 1 + Math.sin(frame * 0.31) * 0.055;
    result = updateMultiPoseTracker(
      result.state,
      [pose(centerX, 0.54, scale, colors[frame % colors.length])],
      frame * 40,
    );
    assert.equal(result.poses[0].trackId, athleteId);
  }
  assert.equal(result.state.nextId, 2);
});

test("does not reuse a stale identity after the tracking timeout", () => {
  let result = updateMultiPoseTracker(createMultiPoseTrackerState(), [pose(0.25)], 0);
  const firstId = result.poses[0].trackId;
  result = updateMultiPoseTracker(result.state, [], 1_250);
  result = updateMultiPoseTracker(result.state, [pose(0.8)], 1_300);
  assert.notEqual(result.poses[0].trackId, firstId);
});

test("hit testing chooses the visible athlete under the pointer", () => {
  const result = updateMultiPoseTracker(createMultiPoseTrackerState(), [pose(0.25), pose(0.75)], 0);
  const selected = hitTestTrackedPose(result.poses, 0.77, 0.56);
  assert.equal(selected?.trackId, result.poses.find((entry) => entry.bounds.centerX > 0.5)?.trackId);
});
