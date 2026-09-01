import assert from "node:assert/strict";
import test from "node:test";
import { assessFootworkWindow } from "../src/lib/footwork-analysis.ts";
import type { PoseLiteSample } from "../src/lib/pose-lite-classifier.ts";

function footworkCycle(kind: "lunge" | "split" | "jump" = "lunge"): PoseLiteSample[] {
  return Array.from({ length: 24 }, (_, index) => {
    const progress = index / 23;
    const pulse = Math.exp(-((progress - 0.46) ** 2) / 0.034);
    const outAndBack = progress < 0.5 ? progress / 0.5 : 1 - (progress - 0.5) / 0.5;
    const alternate = Math.sin(progress * Math.PI * 6);
    const jump = kind === "jump" ? 1 : 0.28;
    return {
      timestamp: index * 45,
      wristSpeed: 0.08,
      armAngularSpeed: 10,
      elbowAngle: 120,
      shoulderAngle: 65,
      contactHeight: 45,
      bodyExtension: 40,
      wristAboveShoulder: false,
      visibility: 95,
      trunkRotation: 8 + pulse * (kind === "jump" ? 36 : 12),
      kneeFlexion: 12 + pulse * 45,
      leftKneeFlexion: 12 + pulse * 51,
      rightKneeFlexion: 12 + pulse * 37,
      handLocked: true,
      balanceScore: 91,
      stanceWidth: 0.55 + pulse * (kind === "lunge" ? 0.72 : 0.4),
      leftAnkleSpeed: 0.2 + Math.max(0, alternate) * 2.2 + pulse,
      rightAnkleSpeed: 0.2 + Math.max(0, -alternate) * 2.1 + pulse,
      footSpeed: 0.32 + Math.abs(alternate) * 2.1 + pulse,
      centerSpeed: 0.12 + pulse * 1.35,
      verticalBounce: 0.1 + pulse * 1.35 * jump,
      landingSymmetry: 91,
      centerX: 0.5 + outAndBack * 0.13,
      centerY: 0.57 - pulse * 0.03,
      leftAnkleX: 0.44 - alternate * 0.025,
      leftAnkleY: 0.93 - pulse * 0.03,
      rightAnkleX: 0.56 + alternate * 0.025,
      rightAnkleY: 0.93 - pulse * 0.025,
      bodyScale: 0.21,
    };
  });
}

test("scores a lunge across the four BWF movement phases", () => {
  const result = assessFootworkWindow(footworkCycle("lunge"), "lunge", "right");
  assert.equal(result.module, "footwork");
  assert.equal(result.technique, "lunge");
  assert.deepEqual(result.phases.map((phase) => phase.phase), ["start", "approach", "hit_balance", "recovery"]);
  assert.ok(result.overallScore >= 55);
  assert.ok((result.metrics.stanceWidth ?? 0) > 0.8);
});

test("scores jump landing from lower-body motion without shuttle data", () => {
  const result = assessFootworkWindow(footworkCycle("jump"), "jump_landing", "right");
  assert.equal(result.technique, "jump_landing");
  assert.ok((result.metrics.verticalBounce ?? 0) > 0.8);
  assert.ok((result.metrics.landingSymmetry ?? 0) >= 80);
  assert.equal("distanceMeters" in result, false);
});

test("low landmark visibility lowers footwork capture quality", () => {
  const samples = footworkCycle().map((sample) => ({ ...sample, visibility: 35 }));
  const result = assessFootworkWindow(samples, "chasse", "right");
  assert.ok(result.captureQuality < 60);
  assert.match(result.corrections[0], /bàn chân/i);
});

test("auto mode abstains or returns a supported footwork label", () => {
  const result = assessFootworkWindow(footworkCycle("split"), "footwork_auto", "right");
  assert.equal(result.module, "footwork");
  assert.ok(result.label.length > 0);
  assert.ok(result.evidence <= 82);
});

test("localizes footwork labels and coaching feedback", () => {
  const english = assessFootworkWindow(footworkCycle("lunge"), "lunge", "right", "en");
  const german = assessFootworkWindow(footworkCycle("jump"), "jump_landing", "right", "de");

  assert.equal(english.label, "Lunge");
  assert.match(english.summary, /motion quality/i);
  assert.equal(german.label, "Sprung und Landung");
  assert.match(german.summary, /Bewegungsqualität/);
  assert.ok(german.corrections.every((item) => !/[à-ỹ]/i.test(item)));
});
