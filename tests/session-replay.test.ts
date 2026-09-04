import assert from "node:assert/strict";
import test from "node:test";
import {
  clampReplayWindow,
  createReplayWindow,
  isPlayableReplayWindow,
  normalizeSessionReplayWindows,
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

test("repairs zero-length replay windows from the session wall-clock timeline", () => {
  const [movement] = normalizeSessionReplayWindows([{
    recordedAt: "2026-09-04T12:00:04.000Z",
    replay: { startMs: 0, peakMs: 0, endMs: 0 },
  }], 6_000, "2026-09-04T12:00:06.000Z");

  assert.deepEqual(movement.replay, {
    startMs: 3_100,
    peakMs: 4_000,
    endMs: 4_850,
  });
  assert.equal(isPlayableReplayWindow(movement.replay), true);
});

test("keeps a valid replay window while clamping it to the recording", () => {
  const [movement] = normalizeSessionReplayWindows([{
    recordedAt: "2026-09-04T12:00:04.000Z",
    replay: { startMs: 1_100, peakMs: 2_350, endMs: 7_000 },
  }], 6_000, "2026-09-04T12:00:06.000Z");

  assert.deepEqual(movement.replay, {
    startMs: 1_100,
    peakMs: 2_350,
    endMs: 6_000,
  });
});

test("creates a playable fallback when stored wall-clock timestamps are invalid", () => {
  const [movement] = normalizeSessionReplayWindows([{
    recordedAt: "invalid",
    replay: undefined,
  }], 2_000, "invalid");

  assert.deepEqual(movement.replay, {
    startMs: 100,
    peakMs: 1_000,
    endMs: 1_850,
  });
  assert.equal(isPlayableReplayWindow(movement.replay), true);
});
