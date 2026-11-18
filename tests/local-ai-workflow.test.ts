import assert from "node:assert/strict";
import test from "node:test";

import { measuredRemainingSeconds, MIN_ESTIMATE_ELAPSED_S } from "../src/lib/local-ai/estimate.ts";
import { runState, shortDigest } from "../src/lib/local-ai/model-execution.ts";
import { LOCAL_AI_PROXY_BASE, sampleVideoUrl, artifactUrl } from "../src/lib/local-ai/client.ts";

test("the remaining-time estimate is hidden until enough progress and time have been measured", () => {
  assert.equal(measuredRemainingSeconds(0.05, 60), null);
  assert.equal(measuredRemainingSeconds(0.5, MIN_ESTIMATE_ELAPSED_S - 1), null);
  assert.equal(measuredRemainingSeconds(1, 400), null);
  assert.equal(measuredRemainingSeconds(Number.NaN, 400), null);
});

test("the remaining-time estimate follows the rate measured so far", () => {
  assert.equal(measuredRemainingSeconds(0.5, 100), 100);
  assert.equal(measuredRemainingSeconds(0.25, 60), 180);
});

test("a model counts as run only when its record says executed: true", () => {
  assert.equal(runState({ executed: true }), "ran");
  assert.equal(runState({ executed: false }), "not-run");
  assert.equal(runState({}), "unknown");
  assert.equal(runState(undefined), "unknown");
});

test("digests are shortened for display and empty values show a dash", () => {
  assert.equal(shortDigest("a".repeat(64)), "aaaaaaaaaaaa…");
  assert.equal(shortDigest(undefined), "–");
});

test("the studio reaches the backend through its own origin and the sample video is addressed by ID", () => {
  assert.equal(LOCAL_AI_PROXY_BASE, "/api/backend");
  assert.equal(sampleVideoUrl(LOCAL_AI_PROXY_BASE, "sample-a-singles-rally"), "/api/backend/api/v1/samples/sample-a-singles-rally/video");
  assert.equal(
    artifactUrl(LOCAL_AI_PROXY_BASE, "a".repeat(32), "model_execution.json"),
    `/api/backend/api/v1/analyses/${"a".repeat(32)}/artifacts/model_execution.json`,
  );
});
