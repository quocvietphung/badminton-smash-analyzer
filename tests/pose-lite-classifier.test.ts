import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyPoseWindow,
  type PoseLiteSample,
} from "../src/lib/pose-lite-classifier.ts";

function sequence(overrides: Partial<PoseLiteSample>): PoseLiteSample[] {
  const {
    wristSpeed = 0.55,
    armAngularSpeed = 95,
    ...rest
  } = overrides;
  return Array.from({ length: 24 }, (_, index) => {
    const distanceFromPeak = Math.abs(index - 12);
    const pulse = 0.18 + Math.max(0, 1 - distanceFromPeak / 9) * 0.82;
    return {
      timestamp: index * 33,
      wristSpeed: wristSpeed * pulse,
      armAngularSpeed: armAngularSpeed * pulse,
      elbowAngle: 138,
      shoulderAngle: 105,
      contactHeight: 70,
      bodyExtension: 64,
      wristAboveShoulder: true,
      visibility: 92,
      ...rest,
    };
  });
}

test("nhận diện ứng viên smash mạnh nhưng không vượt mức bằng chứng an toàn", () => {
  const result = classifyPoseWindow(sequence({
    wristSpeed: 1.9,
    armAngularSpeed: 520,
    elbowAngle: 160,
    shoulderAngle: 132,
    contactHeight: 84,
    bodyExtension: 88,
  }));

  assert.equal(result.strokeType, "smash");
  assert.equal(result.certainty, "likely");
  assert.ok(result.evidence >= 70 && result.evidence <= 78);
});

test("không gán nhãn khi chuỗi chuyển động quá yếu", () => {
  const result = classifyPoseWindow(sequence({
    wristSpeed: 0.18,
    armAngularSpeed: 18,
    elbowAngle: 90,
    shoulderAngle: 45,
    contactHeight: 38,
    bodyExtension: 30,
    wristAboveShoulder: false,
    visibility: 52,
  }));

  assert.equal(result.strokeType, "unknown");
  assert.equal(result.certainty, "unknown");
});

test("clear không được trình bày như kết luận chắc chắn khi chưa thấy cầu", () => {
  const result = classifyPoseWindow(sequence({
    wristSpeed: 1.05,
    armAngularSpeed: 190,
    elbowAngle: 168,
    shoulderAngle: 124,
    contactHeight: 78,
    bodyExtension: 91,
  }));

  assert.ok(result.evidence <= 66 || result.strokeType === "smash");
});

test("không nhận tư thế nhanh nhưng không có nhịp tăng rồi giảm là một cú đánh", () => {
  const samples = Array.from({ length: 24 }, (_, index) => ({
    ...sequence({ wristSpeed: 1.8, armAngularSpeed: 480 })[0],
    timestamp: index * 33,
    wristSpeed: 1.8,
    armAngularSpeed: 480,
  }));
  const result = classifyPoseWindow(samples);

  assert.equal(result.strokeType, "unknown");
  assert.match(result.reason, /tăng tốc rồi giảm tốc/);
});

test("không gán nhãn khi phần lớn frame bị che khuất", () => {
  const samples = sequence({ wristSpeed: 1.8, armAngularSpeed: 480 })
    .map((sample, index) => ({ ...sample, visibility: index < 8 ? 90 : 25 }));
  const result = classifyPoseWindow(samples);

  assert.equal(result.strokeType, "unknown");
  assert.match(result.reason, /bị che/);
});

test("chế độ tự do không ép Clear hoặc Drop khi chỉ thấy động tác overhead có kiểm soát", () => {
  const samples = sequence({
    wristSpeed: 0.95,
    armAngularSpeed: 145,
    elbowAngle: 158,
    shoulderAngle: 118,
    contactHeight: 76,
    bodyExtension: 82,
  });
  const result = classifyPoseWindow(samples, { drillMode: "open" });
  assert.equal(result.strokeType, "overhead_control");
  assert.equal(result.family, "overhead_control");
});

test("ngữ cảnh bài tập Clear chỉ tách nhãn trong cùng nhóm overhead", () => {
  const samples = sequence({
    wristSpeed: 0.95,
    armAngularSpeed: 145,
    elbowAngle: 164,
    shoulderAngle: 122,
    contactHeight: 78,
    bodyExtension: 88,
  });
  const result = classifyPoseWindow(samples, { drillMode: "clear" });
  assert.equal(result.strokeType, "clear");
  assert.ok(result.evidence <= 68);
});
