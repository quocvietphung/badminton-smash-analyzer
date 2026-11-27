import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { COURT_REASONS, COURT_THRESHOLDS, explainCourt } from "../src/lib/match/court-explanation.ts";

const COURT_PY = readFileSync(new URL("../backend/app/ai/court_detection/court.py", import.meta.url), "utf8");

test("the thresholds are the backend's thresholds", () => {
  const read = (name: string) => Number(COURT_PY.match(new RegExp(`^${name} = ([0-9.]+)`, "m"))?.[1]);
  assert.equal(read("MIN_SCORE"), COURT_THRESHOLDS.score);
  assert.equal(read("MIN_COVERAGE"), COURT_THRESHOLDS.coverage);
  assert.equal(read("MIN_OUTLINE"), COURT_THRESHOLDS.outline);
});

test("every failure reason the backend writes maps to one step, and the backend writes no other", () => {
  const written = new Set<string>();
  for (const match of COURT_PY.matchAll(/CourtEstimate\(\s*"failed",\s*"([^"]+)"/g)) written.add(match[1]);
  const mapped = new Set(Object.values(COURT_REASONS).flat());
  mapped.delete("no full-resolution frames were available for calibration"); // written by the pipeline runner
  assert.deepEqual([...written].sort(), [...mapped].sort());
  const runner = readFileSync(new URL("../backend/app/pipeline/runner.py", import.meta.url), "utf8");
  assert.ok(runner.includes(COURT_REASONS.no_frames[0]));
});

test("sample A: calibrated automatically, both checks pass", () => {
  const result = explainCourt({ status: "calibrated", source: "auto", reason: "template lines matched the detected white court lines", score: 0.8958, coverage: 1.0 });
  assert.equal(result.stage, "calibrated");
  assert.deepEqual(result.checks.map((check) => [check.id, check.value, check.passed]), [["score", 0.8958, true], ["coverage", 1, true]]);
});

test("samples C and D stop before a fit: their stored 0.0 is not a score", () => {
  const c = explainCourt({ status: "failed", source: "auto", reason: "not enough horizontal and vertical white court lines were visible", score: 0, coverage: 0 });
  const d = explainCourt({ status: "failed", source: "auto", reason: "no dominant floor region was found", score: 0, coverage: 0 });
  assert.equal(c.stage, "no_lines");
  assert.equal(d.stage, "no_floor");
  for (const result of [c, d]) {
    assert.equal(result.calibrated, false);
    assert.ok(result.checks.every((check) => check.value === null && check.passed === null));
  }
});

test("a weak fit names the check that failed", () => {
  const result = explainCourt({ status: "failed", source: "auto", reason: "the best court fit did not reach the score and coverage thresholds", score: 0.61, coverage: 0.42 });
  assert.equal(result.stage, "below_threshold");
  assert.deepEqual(result.checks.map((check) => check.passed), [true, false]);
});

test("a person's four corners are a manual calibration with no automatic checks", () => {
  const result = explainCourt({ status: "calibrated", source: "manual", reason: "four corners provided by the user", score: null, coverage: null });
  assert.equal(result.stage, "manual");
  assert.equal(result.checks.length, 0);
  assert.equal(explainCourt(null).stage, "unknown");
  assert.equal(explainCourt({ status: "failed", reason: "something new" }).stage, "unknown");
});
