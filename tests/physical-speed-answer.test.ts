import assert from "node:assert/strict";
import test from "node:test";
import { coachTextResponse } from "../src/lib/ai/coach-provider.ts";
import {
  isShuttleSpeedQuestion,
  mostFrequentReason,
  physicalSpeedAnswer,
  physicalSpeedFacts,
  physicalSpeedReply,
} from "../src/lib/ai/physical-speed-answer.ts";

// Sample A's coach dataset: 12 contacts, none confirmed, no 3D speed, and the two-camera measurement not run.
const SAMPLE_A = {
  speed_summary: {
    estimated_3d: {
      available: 0,
      rejected: 12,
      rejection_reasons: { contact_not_confirmed: 12, insufficient_3d_camera_calibration: 12, interpolation_dominates: 1 },
    },
    measured_3d: { status: "not_run" },
  },
};
const FACTS = physicalSpeedFacts(SAMPLE_A);

const sentences = (text: string) => text.split(/(?<=[.!?])\s+/);

test("a question about the shuttle's speed in km/h or m/s is recognised in three languages; a player's speed is not", () => {
  assert.equal(isShuttleSpeedQuestion("How fast was the shuttle in km/h?"), true);
  assert.equal(isShuttleSpeedQuestion("Quả cầu bay nhanh bao nhiêu km/h?"), true);
  assert.equal(isShuttleSpeedQuestion("Wie schnell war der Federball in km/h?"), true);
  assert.equal(isShuttleSpeedQuestion("What was the shuttle speed in m/s?"), true);
  assert.equal(isShuttleSpeedQuestion("How fast did P2 move in m/s?"), false);
  assert.equal(isShuttleSpeedQuestion("Where did the shuttle land at 12 seconds?"), false);
  assert.equal(isShuttleSpeedQuestion("Which player moved more, and by how many metres?"), false);
});

test("the answer is two sentences that name the limit and its reason, with no km/h or m/s value", () => {
  assert.equal(
    physicalSpeedAnswer("en", FACTS),
    "Physical trajectory unavailable: the 3D estimate was rejected because the 3D camera calibration is not sufficient. " +
      "The two-camera measurement was not run, so no km/h or m/s value is given.",
  );
  for (const language of ["en", "de", "vi"] as const) {
    const text = physicalSpeedAnswer(language, FACTS);
    assert.equal(sentences(text).length, 2, text);
    assert.doesNotMatch(text, /\d+(?:[.,]\d+)?\s*(?:km\/h|m\/s|px\/s)/, text);
  }
  assert.match(physicalSpeedAnswer("vi", FACTS), /^Quỹ đạo vật lý không khả dụng: /);
  assert.match(physicalSpeedAnswer("de", FACTS), /^Physische Flugbahn nicht verfügbar: /);
});

test("the answer names no candidate, no contact and no pixel speed from the data", () => {
  assert.doesNotMatch(physicalSpeedAnswer("en", FACTS), /candidate|contact|1267|px\/s/i);
});

test("the most frequent reason is named, and a tie goes to the calibration reason", () => {
  assert.equal(mostFrequentReason({ contact_not_confirmed: 12, insufficient_3d_camera_calibration: 12 }), "insufficient_3d_camera_calibration");
  assert.equal(mostFrequentReason({ contact_not_confirmed: 5, interpolation_dominates: 2 }), "contact_not_confirmed");
  assert.equal(mostFrequentReason({ insufficient_3d_camera_calibration: 0 }), null);
  assert.equal(mostFrequentReason(undefined), null);
});

test("without rejection reasons or a measurement status, the answer states only what it knows", () => {
  assert.equal(
    physicalSpeedAnswer("en", {}),
    "Physical trajectory unavailable: no 3D speed estimate passed the checks. No km/h or m/s value is given.",
  );
  assert.deepEqual(physicalSpeedFacts(null), { rejectionReasons: undefined, measuredStatus: undefined });
});

test("the app answers only a shuttle km/h question with no physical speed and an analysis selected", () => {
  const base = { question: "How fast was the shuttle in km/h?", analysisSelected: true, status: "unavailable", language: "en" as const, facts: FACTS };
  assert.equal(physicalSpeedReply(base), physicalSpeedAnswer("en", FACTS));
  assert.equal(physicalSpeedReply({ ...base, status: "available" }), null);
  assert.equal(physicalSpeedReply({ ...base, analysisSelected: false }), null);
  assert.equal(physicalSpeedReply({ ...base, question: "Which player moved more, and by how many metres?" }), null);
});

test("the fixed answer is streamed in the same UI message format as a model answer", async () => {
  const streamed = await coachTextResponse({ text: physicalSpeedAnswer("en", FACTS) }).text();
  assert.match(streamed, /"type":"text-start"/);
  assert.match(streamed, /"delta":"Physical trajectory unavailable: the 3D estimate/);
  assert.match(streamed, /"type":"finish"/);
});
