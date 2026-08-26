import assert from "node:assert/strict";
import test from "node:test";
import {
  assignStablePlayerIds,
  resetPlayerTracking,
} from "../src/lib/pose-tracking.ts";
import type { PoseLandmark } from "../src/lib/pose-metrics.ts";

function poseAt(x: number, y: number): PoseLandmark[] {
  const landmarks = Array.from({ length: 33 }, () => ({ x, y, visibility: 1 }));
  landmarks[11] = { x: x - 0.04, y: y - 0.32, visibility: 1 };
  landmarks[12] = { x: x + 0.04, y: y - 0.32, visibility: 1 };
  landmarks[23] = { x: x - 0.03, y: y - 0.18, visibility: 1 };
  landmarks[24] = { x: x + 0.03, y: y - 0.18, visibility: 1 };
  landmarks[27] = { x: x - 0.02, y, visibility: 1 };
  landmarks[28] = { x: x + 0.02, y, visibility: 1 };
  return landmarks;
}

test("giữ nguyên ID khi thứ tự pose từ MediaPipe bị đảo", () => {
  const first = assignStablePlayerIds([
    { landmarks: poseAt(0.35, 0.82) },
    { landmarks: poseAt(0.65, 0.28) },
  ], resetPlayerTracking(), 0);
  assert.equal(first.assignments[0].player, "A");
  assert.equal(first.assignments[1].player, "B");

  const second = assignStablePlayerIds([
    { landmarks: poseAt(0.64, 0.3) },
    { landmarks: poseAt(0.36, 0.8) },
  ], first.state, 40);
  const nearPlayer = second.assignments.find((assignment) => assignment.landmarks[28].y > 0.7);
  const farPlayer = second.assignments.find((assignment) => assignment.landmarks[28].y < 0.4);
  assert.equal(nearPlayer?.player, "A");
  assert.equal(farPlayer?.player, "B");
});

test("giữ ID khi một VĐV mất khỏi khung hình ngắn hạn", () => {
  const first = assignStablePlayerIds([
    { landmarks: poseAt(0.3, 0.8) },
    { landmarks: poseAt(0.7, 0.25) },
  ], resetPlayerTracking(), 0);
  const hidden = assignStablePlayerIds([
    { landmarks: poseAt(0.69, 0.27) },
  ], first.state, 80);
  assert.equal(hidden.assignments[0].player, "B");

  const returned = assignStablePlayerIds([
    { landmarks: poseAt(0.32, 0.78) },
    { landmarks: poseAt(0.68, 0.29) },
  ], hidden.state, 140);
  assert.equal(returned.assignments.find((item) => item.landmarks[28].y > 0.7)?.player, "A");
});
