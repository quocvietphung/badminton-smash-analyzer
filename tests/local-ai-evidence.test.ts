import assert from "node:assert/strict";
import test from "node:test";

import {
  courtOutline,
  countCorrectionsByType,
  formatFrameTime,
  frameAtTime,
  hitTestBox,
  identityCoverage,
  identitySpans,
  indexBoxesByFrame,
  intervalAround,
  markerEvents,
  validateIdentityDraft,
  type IdentityEvent,
  type PlayerTrack,
} from "../src/lib/local-ai/evidence.ts";

const observation = (frame: number, identity: string, x1: number, y1: number, x2: number, y2: number) => ({
  frame,
  time_s: frame / 30,
  x1,
  y1,
  x2,
  y2,
  score: 0.9,
  confirmed: true,
  identity,
  identity_status: "matched",
  identity_confidence: 0.8,
});

test("frame and time conversions clamp to the analysed frames", () => {
  assert.equal(frameAtTime(1.0, 30, 450), 30);
  assert.equal(frameAtTime(-1, 30, 450), 0);
  assert.equal(frameAtTime(100, 30, 450), 449);
  assert.equal(frameAtTime(2, 0, 450), 0);
  assert.equal(formatFrameTime(104, 30), "3.47 s · frame 104");
});

test("boxes are indexed by frame and a click picks the smallest box under the pointer", () => {
  const tracks: PlayerTrack[] = [
    { track_id: 1, confirmed: true, observations: [observation(5, "P1", 0, 0, 100, 200)] },
    { track_id: 2, confirmed: true, observations: [observation(5, "P2", 40, 40, 60, 80)] },
  ];
  const index = indexBoxesByFrame(tracks);
  assert.equal(index.get(5)?.length, 2);
  assert.equal(index.get(6), undefined);
  assert.equal(hitTestBox(index.get(5) ?? [], 50, 60)?.trackId, 2);
  assert.equal(hitTestBox(index.get(5) ?? [], 90, 150)?.trackId, 1);
  assert.equal(hitTestBox(index.get(5) ?? [], 500, 500), null);
});

test("timeline spans are fractions of the analysed duration", () => {
  const spans = identitySpans(
    [
      { status: "matched", start_frame: 0, end_frame: 9, start_s: 0, end_s: 0.3 },
      { status: "lost", start_frame: 10, end_frame: 19, start_s: 0.3, end_s: 0.6 },
    ],
    20,
  );
  assert.deepEqual(spans, [
    { startFraction: 0, endFraction: 0.5, status: "matched" },
    { startFraction: 0.5, endFraction: 1, status: "lost" },
  ]);
});

test("the court outline projects the template through the homography", () => {
  // court metres -> image pixels: x = 600 + 100 x, y = 1700 - 100 y
  const homography = [
    [100, 0, 600],
    [0, -100, 1700],
    [0, 0, 1],
  ];
  const outline = courtOutline(homography);
  assert.ok(outline);
  assert.equal(outline.length, 6);
  assert.deepEqual(outline[0], [600, 1700]);
  assert.deepEqual(outline[2], [1210, 360]);
  assert.deepEqual(outline[4], [600, 1030]);
  assert.equal(courtOutline(null), null);
  assert.equal(courtOutline([[1, 0], [0, 1]]), null);
});

test("identity drafts follow the backend rules for singles and doubles", () => {
  const base = { trackId: 1, identity: "P1", startFrame: 0, endFrame: 10 };
  assert.equal(validateIdentityDraft(base, 2, 100), null);
  assert.equal(validateIdentityDraft({ ...base, trackId: null }, 2, 100), "track");
  assert.equal(validateIdentityDraft({ ...base, identity: "P3" }, 2, 100), "identity");
  assert.equal(validateIdentityDraft({ ...base, identity: "P3" }, 4, 100), null);
  assert.equal(validateIdentityDraft({ ...base, startFrame: 20, endFrame: 10 }, 2, 100), "interval");
  assert.equal(validateIdentityDraft({ ...base, endFrame: 100 }, 2, 100), "interval");
});

test("an interval around a frame is clamped to the video", () => {
  assert.deepEqual(intervalAround(3, 15, 100), { start: 0, end: 18 });
  assert.deepEqual(intervalAround(95, 15, 100), { start: 80, end: 99 });
});

test("identity coverage counts only matched, recovered and manual frames", () => {
  const coverage = identityCoverage(
    [
      { status: "matched", start_frame: 0, end_frame: 9, start_s: 0, end_s: 0.3 },
      { status: "lost", start_frame: 10, end_frame: 19, start_s: 0.3, end_s: 0.6 },
    ],
    20,
  );
  assert.equal(coverage, 0.5);
  assert.equal(identityCoverage([], 0), null);
});

test("only identity changes appear as timeline markers", () => {
  const events: IdentityEvent[] = [
    { frame: 1, time_s: 0.03, kind: "identity_initialised", identity: "P1", track_id: 1, confidence: null, message: "" },
    { frame: 9, time_s: 0.3, kind: "identity_lost", identity: "P2", track_id: null, confidence: 0, message: "" },
  ];
  assert.deepEqual(markerEvents(events).map((event) => event.kind), ["identity_lost"]);
  assert.deepEqual(countCorrectionsByType([
    { id: "a", type: "identity", created_at: 1 },
    { id: "b", type: "identity", created_at: 2 },
    { id: "c", type: "mode", created_at: 3 },
  ]), { identity: 2, mode: 1 });
});
