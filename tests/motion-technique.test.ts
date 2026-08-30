import assert from "node:assert/strict";
import test from "node:test";
import { assessMotionWindow } from "../src/lib/motion-technique.ts";
import type { PoseLiteSample } from "../src/lib/pose-lite-classifier.ts";

function createSwing(overrides: Partial<PoseLiteSample> = {}): PoseLiteSample[] {
  return Array.from({ length: 18 }, (_, index) => {
    const progress = index / 17;
    const peak = Math.exp(-((progress - 0.56) ** 2) / 0.017);
    const loading = Math.exp(-((progress - 0.32) ** 2) / 0.045);
    return {
      timestamp: index * 40,
      wristSpeed: 0.12 + peak * 1.8,
      armAngularSpeed: 24 + peak * 540,
      elbowAngle: 108 + peak * 56,
      shoulderAngle: 58 + peak * 84,
      contactHeight: 58 + peak * 32,
      bodyExtension: 38 + peak * 54,
      wristAboveShoulder: progress > 0.3 && progress < 0.78,
      visibility: 94,
      trunkRotation: 9 + loading * 31 + peak * 13,
      kneeFlexion: 11 + loading * 36,
      handLocked: true,
      balanceScore: 91,
      stanceWidth: 0.76,
      wristAcrossBody: 10 + peak * 6,
      lateralReach: 20 + peak * 31,
      ...overrides,
    };
  });
}

test("scores a complete smash motion across six phases", () => {
  const result = assessMotionWindow(createSwing(), "smash", "right");
  assert.equal(result.technique, "smash");
  assert.equal(result.phases.length, 6);
  assert.ok(result.overallScore >= 60);
  assert.ok(result.captureQuality >= 80);
  assert.equal(result.dominantSide, "right");
});

test("uses selected backhand drill context and cross-body motion", () => {
  const result = assessMotionWindow(createSwing({
    wristAboveShoulder: false,
    contactHeight: 58,
    wristAcrossBody: 88,
    lateralReach: 82,
  }), "backhand", "left");
  assert.equal(result.technique, "backhand");
  assert.equal(result.label, "Backhand");
  assert.ok(result.phases.find((phase) => phase.phase === "contact_zone")!.score >= 55);
});

test("low visibility reduces capture quality and adds camera guidance", () => {
  const result = assessMotionWindow(createSwing({ visibility: 38, handLocked: false }), "smash", "right");
  assert.ok(result.captureQuality < 60);
  assert.match(result.corrections[0], /góc quay/i);
});

test("motion score is independent from shuttle speed or trajectory", () => {
  const result = assessMotionWindow(createSwing(), "clear", "right");
  assert.equal("speedKmh" in result, false);
  assert.equal("trajectory" in result, false);
  assert.equal(result.technique, "clear");
});
