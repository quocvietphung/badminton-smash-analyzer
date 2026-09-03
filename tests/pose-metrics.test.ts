import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzePose,
  type PoseFrameMemory,
  type PoseLandmark,
} from "../src/lib/pose-metrics.ts";

function athletePose(scale = 1, offsetX = 0, offsetY = 0): PoseLandmark[] {
  const point = (x: number, y: number, z = 0) => ({
    x: offsetX + x * scale,
    y: offsetY + y * scale,
    z: z * scale,
    visibility: 1,
  });
  const landmarks = Array.from({ length: 33 }, () => point(0.5, 0.5));
  landmarks[11] = point(0.44, 0.38);
  landmarks[12] = point(0.56, 0.38);
  landmarks[13] = point(0.4, 0.28);
  landmarks[14] = point(0.61, 0.3);
  landmarks[15] = point(0.38, 0.18);
  landmarks[16] = point(0.65, 0.2);
  landmarks[23] = point(0.46, 0.58);
  landmarks[24] = point(0.54, 0.58);
  landmarks[25] = point(0.45, 0.75);
  landmarks[26] = point(0.55, 0.75);
  landmarks[27] = point(0.44, 0.94);
  landmarks[28] = point(0.56, 0.94);
  return landmarks;
}

test("độ cao và độ duỗi không đổi đáng kể khi người đứng gần camera hơn", () => {
  const base = analyzePose(athletePose(), 0, null, -10_000, { preferredHand: "right" });
  const zoomed = analyzePose(athletePose(0.62, 0.16, 0.18), 0, null, -10_000, { preferredHand: "right" });
  assert.ok(Math.abs(base.metrics.contactHeight - zoomed.metrics.contactHeight) < 0.5);
  assert.ok(Math.abs(base.metrics.bodyExtension - zoomed.metrics.bodyExtension) < 0.5);
});

test("dùng world landmarks để đo shoulder-hip separation theo mặt phẳng 3D", () => {
  const imageLandmarks = athletePose();
  const worldLandmarks = athletePose();
  worldLandmarks[11] = { ...worldLandmarks[11], z: -0.06 };
  worldLandmarks[12] = { ...worldLandmarks[12], z: 0.06 };
  worldLandmarks[23] = { ...worldLandmarks[23], z: 0 };
  worldLandmarks[24] = { ...worldLandmarks[24], z: 0 };

  const result = analyzePose(imageLandmarks, 0, null, -10_000, {
    preferredHand: "right",
    worldLandmarks,
  });

  assert.equal(result.metrics.worldTracking, true);
  assert.ok(result.metrics.trunkRotation >= 35 && result.metrics.trunkRotation <= 55);
});

test("tay vợt tự nhận được khóa và không đổi vì một frame nhiễu", () => {
  let memory: PoseFrameMemory | null = null;
  for (let index = 0; index < 18; index += 1) {
    const landmarks = athletePose();
    landmarks[16] = { ...landmarks[16], x: landmarks[16].x + index * 0.018 };
    const result = analyzePose(landmarks, index * 40, memory, -10_000, { preferredHand: "auto" });
    memory = result.memory;
  }
  assert.equal(memory?.lockedSide, "right");

  const noisy = athletePose();
  noisy[15] = { ...noisy[15], x: noisy[15].x - 0.22 };
  const result = analyzePose(noisy, 760, memory, -10_000, { preferredHand: "auto" });
  assert.equal(result.metrics.dominantSide, "right");
  assert.equal(result.metrics.handLocked, true);
});

test("ghi nhận chuyển động cổ chân và trọng tâm cho mô-đun bộ pháp", () => {
  const first = analyzePose(athletePose(), 0, null, -10_000, { preferredHand: "right" });
  const moved = athletePose();
  moved[23] = { ...moved[23], x: moved[23].x + 0.035 };
  moved[24] = { ...moved[24], x: moved[24].x + 0.035 };
  moved[27] = { ...moved[27], x: moved[27].x + 0.07, y: moved[27].y - 0.025 };
  moved[28] = { ...moved[28], x: moved[28].x + 0.02 };
  const result = analyzePose(moved, 40, first.memory, -10_000, { preferredHand: "right" });
  assert.ok(result.metrics.footSpeed > 0);
  assert.ok(result.metrics.centerSpeed > 0);
  assert.ok(result.metrics.bodyScale > 0);
  assert.ok(result.metrics.landingSymmetry >= 0 && result.metrics.landingSymmetry <= 100);
});
