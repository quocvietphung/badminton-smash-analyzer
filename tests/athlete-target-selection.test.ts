import assert from "node:assert/strict";
import test from "node:test";
import { resolveTargetConfirmation } from "../src/lib/athlete-target-selection.ts";

const athlete = (trackId: number, lockConfidence: number, lockReady = false) => ({
  trackId,
  lockConfidence,
  lockReady,
});

test("keeps confirmation on the athlete explicitly selected by the user", () => {
  const pending = athlete(7, 45);
  const state = resolveTargetConfirmation(pending, [athlete(9, 95, true), athlete(7, 65)]);

  assert.equal(state.display?.trackId, 7);
  assert.equal(state.ready, false);
});

test("enables locking only when the same selected athlete becomes ready", () => {
  const pending = athlete(7, 45);
  const state = resolveTargetConfirmation(pending, [athlete(9, 95, true), athlete(7, 80, true)]);

  assert.equal(state.display?.trackId, 7);
  assert.equal(state.visible, true);
  assert.equal(state.ready, true);
});

test("never switches confirmation to another visible athlete", () => {
  const pending = athlete(7, 45);
  const state = resolveTargetConfirmation(pending, [athlete(9, 95, true)]);

  assert.equal(state.display?.trackId, 7);
  assert.equal(state.visible, false);
  assert.equal(state.ready, false);
});
