import assert from "node:assert/strict";
import test from "node:test";
import {
  clampReplayWindow,
  createReplayWindow,
} from "../src/lib/session-replay.ts";

test("creates a replay window with pre-roll, peak and post-roll", () => {
  assert.deepEqual(createReplayWindow(
    { startedAt: 2_500, peakAt: 2_820 },
    3_050,
    1_000,
  ), {
    startMs: 600,
    peakMs: 1_820,
    endMs: 2_900,
  });
});

test("does not create video timestamps without an active recorder", () => {
  assert.equal(createReplayWindow(
    { startedAt: 2_500, peakAt: 2_820 },
    3_050,
    null,
  ), undefined);
});

test("clamps replay timestamps to the final recording duration", () => {
  assert.deepEqual(clampReplayWindow({
    startMs: 1_100,
    peakMs: 2_350,
    endMs: 3_800,
  }, 2_600), {
    startMs: 1_100,
    peakMs: 2_350,
    endMs: 2_600,
  });
});

test("keeps every timestamp ordered when recording stops early", () => {
  assert.deepEqual(clampReplayWindow({
    startMs: 1_100,
    peakMs: 1_900,
    endMs: 2_800,
  }, 900), {
    startMs: 900,
    peakMs: 900,
    endMs: 900,
  });
});
