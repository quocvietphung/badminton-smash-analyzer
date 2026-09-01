import assert from "node:assert/strict";
import test from "node:test";
import {
  appearanceIdentityConflict,
  appearanceDistance,
  extractTorsoAppearance,
  horizontalPosition,
} from "../src/lib/pose-appearance.ts";
import type { PoseAppearance, ShirtColor } from "../src/lib/pose-appearance.ts";
import type { PoseLandmark } from "../src/lib/pose-metrics.ts";

function appearance(bin: number, shirtColor: ShirtColor): PoseAppearance {
  const histogram = Array.from({ length: 21 }, () => 0);
  histogram[bin] = 1;
  return { histogram, shirtColor, confidence: 0.9, sampleCount: 120 };
}

function landmarks(): PoseLandmark[] {
  const points = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 1 }));
  points[11] = { x: 0.35, y: 0.28, visibility: 1 };
  points[12] = { x: 0.65, y: 0.28, visibility: 1 };
  points[23] = { x: 0.4, y: 0.72, visibility: 1 };
  points[24] = { x: 0.6, y: 0.72, visibility: 1 };
  return points;
}

function solidFrame(red: number, green: number, blue: number) {
  const data = new Uint8ClampedArray(80 * 80 * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = red;
    data[index + 1] = green;
    data[index + 2] = blue;
    data[index + 3] = 255;
  }
  return data;
}

test("classifies saturated shirt colors from the torso crop", () => {
  const red = extractTorsoAppearance(solidFrame(230, 35, 42), 80, 80, landmarks());
  const orange = extractTorsoAppearance(solidFrame(235, 115, 25), 80, 80, landmarks());
  const yellow = extractTorsoAppearance(solidFrame(235, 220, 35), 80, 80, landmarks());
  const blue = extractTorsoAppearance(solidFrame(30, 100, 225), 80, 80, landmarks());
  const white = extractTorsoAppearance(solidFrame(235, 238, 236), 80, 80, landmarks());
  assert.equal(red?.shirtColor, "red");
  assert.equal(orange?.shirtColor, "orange");
  assert.equal(yellow?.shirtColor, "yellow");
  assert.equal(blue?.shirtColor, "blue");
  assert.equal(white?.shirtColor, "white");
});

test("appearance histogram separates different shirts", () => {
  const red = extractTorsoAppearance(solidFrame(230, 35, 42), 80, 80, landmarks())!;
  const secondRed = extractTorsoAppearance(solidFrame(205, 32, 38), 80, 80, landmarks())!;
  const blue = extractTorsoAppearance(solidFrame(30, 100, 225), 80, 80, landmarks())!;
  assert.ok(appearanceDistance(red, secondRed) < 0.2);
  assert.ok(appearanceDistance(red, blue) > 0.8);
});

test("describes horizontal target position", () => {
  assert.equal(horizontalPosition(0.2), "left");
  assert.equal(horizontalPosition(0.5), "center");
  assert.equal(horizontalPosition(0.8), "right");
});

test("does not reject a sole athlete only because lighting changes shirt color", () => {
  const red = appearance(0, "red");
  const blue = appearance(11, "blue");
  assert.equal(appearanceIdentityConflict(red, blue, []), false);
  assert.equal(appearanceIdentityConflict(red, blue, [red]), true);
});
