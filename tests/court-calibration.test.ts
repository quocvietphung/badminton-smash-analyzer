import assert from "node:assert/strict";
import test from "node:test";

import {
  assessCourtCorners,
  averageCornerDistance,
  detectCourtCornersFromPixels,
  normalizeCourtCorners,
  sourcePointToStage,
  stagePointToSource,
  validateCourtCorners,
} from "../src/lib/court-calibration.ts";

function createFrame(width: number, height: number) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = 16;
    data[index * 4 + 1] = 74;
    data[index * 4 + 2] = 62;
    data[index * 4 + 3] = 255;
  }
  return data;
}

function drawLine(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  start: { x: number; y: number },
  end: { x: number; y: number },
  thickness = 3,
) {
  const steps = Math.ceil(Math.hypot(end.x - start.x, end.y - start.y));
  for (let step = 0; step <= steps; step += 1) {
    const x = Math.round(start.x + (end.x - start.x) * step / steps);
    const y = Math.round(start.y + (end.y - start.y) * step / steps);
    for (let offsetY = -thickness; offsetY <= thickness; offsetY += 1) {
      for (let offsetX = -thickness; offsetX <= thickness; offsetX += 1) {
        const pixelX = x + offsetX;
        const pixelY = y + offsetY;
        if (pixelX < 0 || pixelX >= width || pixelY < 0 || pixelY >= height) continue;
        const offset = (pixelY * width + pixelX) * 4;
        data[offset] = 225;
        data[offset + 1] = 255;
        data[offset + 2] = 245;
      }
    }
  }
}

test("detects a perspective badminton court from synthetic court lines", () => {
  const width = 320;
  const height = 180;
  const frame = createFrame(width, height);
  const farLeft = { x: 104, y: 28 };
  const farRight = { x: 216, y: 28 };
  const nearRight = { x: 292, y: 166 };
  const nearLeft = { x: 28, y: 166 };
  drawLine(frame, width, height, farLeft, farRight);
  drawLine(frame, width, height, farRight, nearRight);
  drawLine(frame, width, height, nearRight, nearLeft);
  drawLine(frame, width, height, nearLeft, farLeft);
  drawLine(frame, width, height, { x: 72, y: 105 }, { x: 248, y: 105 }, 2);
  drawLine(frame, width, height, { x: 84, y: 82 }, { x: 236, y: 82 }, 2);

  const result = detectCourtCornersFromPixels(frame, width, height);
  assert.ok(result);
  assert.ok(result.confidence >= 0.46);
  const expected = [farLeft, farRight, nearRight, nearLeft];
  result.corners.forEach((corner, index) => {
    assert.ok(Math.abs(corner.x - expected[index].x / width) < 0.12);
    assert.ok(Math.abs(corner.y - expected[index].y / height) < 0.12);
  });
});

test("validates corner order and converts object-fit cover coordinates", () => {
  const corners = [
    { x: 0.34, y: 0.16 },
    { x: 0.66, y: 0.16 },
    { x: 0.92, y: 0.94 },
    { x: 0.08, y: 0.94 },
  ];
  assert.equal(validateCourtCorners(corners), true);

  const source = { x: 0.42, y: 0.73 };
  const stage = sourcePointToStage(source, 1280, 720, 390, 430);
  const roundTrip = stagePointToSource(stage, 1280, 720, 390, 430);
  assert.ok(Math.abs(source.x - roundTrip.x) < 1e-9);
  assert.ok(Math.abs(source.y - roundTrip.y) < 1e-9);
});

test("normalizes four manually tapped corners regardless of tap order", () => {
  const normalized = normalizeCourtCorners([
    { x: 0.08, y: 0.94 },
    { x: 0.92, y: 0.94 },
    { x: 0.66, y: 0.16 },
    { x: 0.34, y: 0.16 },
  ]);
  assert.deepEqual(normalized, [
    { x: 0.34, y: 0.16 },
    { x: 0.66, y: 0.16 },
    { x: 0.92, y: 0.94 },
    { x: 0.08, y: 0.94 },
  ]);
  assert.equal(validateCourtCorners(normalized), true);
});

test("scores a well-covered court and warns about a very small court", () => {
  const good = assessCourtCorners([
    { x: 0.34, y: 0.16 },
    { x: 0.66, y: 0.16 },
    { x: 0.92, y: 0.94 },
    { x: 0.08, y: 0.94 },
  ]);
  const small = assessCourtCorners([
    { x: 0.43, y: 0.24 },
    { x: 0.57, y: 0.24 },
    { x: 0.68, y: 0.65 },
    { x: 0.32, y: 0.65 },
  ]);

  assert.equal(good.valid, true);
  assert.ok(good.score >= 70);
  assert.equal(small.valid, true);
  assert.ok(small.warnings.some((warning) => warning.includes("quá ít khung hình")));
});

test("measures inter-frame corner drift", () => {
  const first = [
    { x: 0.3, y: 0.2 }, { x: 0.7, y: 0.2 },
    { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 },
  ];
  const second = first.map((point) => ({ x: point.x + 0.02, y: point.y }));

  assert.ok(Math.abs(averageCornerDistance(first, second) - 0.02) < 1e-9);
});
