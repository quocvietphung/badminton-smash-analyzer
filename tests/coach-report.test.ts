import assert from "node:assert/strict";
import test from "node:test";
import { buildCoachReport, evidenceLabel, isCoachDataset, type CoachDatasetDoc } from "../src/lib/ai/coach-report.ts";
import { checkAnswerNumbers, collectKnownNumbers, numbersInText } from "../src/lib/ai/number-check.ts";

// A trimmed copy of sample A's coach-dataset/v1 (job 567e4196…, read-only recompute): 15 s, calibrated court, 12
// candidate contacts, no confirmed contact.
function sampleA(): CoachDatasetDoc {
  return {
    schema: "smashlab.coach-dataset/v1",
    job_id: "567e4196044f4f59a4f8a2e5d8fb83c0",
    rule_version: "trajectory-rules/v2",
    speed_summary: {
      unit: "px/s",
      official: { basis: "confirmed contacts only", count: 0, max_px_per_s: null, mean_px_per_s: null },
      candidates: { basis: "automatic candidates", count: 12, max_px_per_s: 1267.9, mean_px_per_s: 654.0 },
      estimated_3d: { available: 0, rejected: 12, rejection_reasons: { contact_not_confirmed: 12, insufficient_3d_camera_calibration: 12, interpolation_dominates: 1 } },
      measured_3d: { status: "not_run" },
    },
    source: { name: "A · Singles rally, clear broadcast view", fps: 30, frames: null, duration_s: 15, court_status: "calibrated", court_template: "doubles 13.40 m x 6.10 m" },
    players: {
      P1: {
        contacts: 6, confirmed_contacts: 0,
        shot_estimates: { smash: 1, clear: 2, drop: 0, drive: 0, net_shot: 0, lift: 3 },
        manual_labels: {},
        image_speed_official_px_s: { count: 0, max: null, median: null },
        image_speed_candidates_px_s: { count: 6, max: 628.4, median: 340.9 },
        movement: { court_distance_m: 27.55, image_path_px: 2370.7, court_zone_share: { front_court: 0.104, mid_court: 0.514, back_court: 0.382 }, tracking_coverage: 0.9444 },
      },
      P2: {
        contacts: 6, confirmed_contacts: 0,
        shot_estimates: { smash: 0, clear: 5, drop: 0, drive: 1, net_shot: 0, lift: 0 },
        manual_labels: {},
        image_speed_official_px_s: { count: 0, max: null, median: null },
        image_speed_candidates_px_s: { count: 6, max: 1267.9, median: 788.4 },
        movement: { court_distance_m: 29.17, image_path_px: 2580.2, court_zone_share: { front_court: 0.08, mid_court: 0.5, back_court: 0.42 }, tracking_coverage: 0.9756 },
      },
    },
    movement_comparison: { metric: "court_distance_m", values: { P1: 27.55, P2: 29.17 }, more_movement: "P2", difference_percent: 5.9 },
    shots: [
      { time_s: 0.833, frame: 25, player: "P2", contact_status: "candidate", estimate_label: "clear", manual_label: null, image_speed_px_s: 752.6 },
      { time_s: 1.733, frame: 52, player: "P1", contact_status: "candidate", estimate_label: "lift", manual_label: null, image_speed_px_s: 628.4 },
      { time_s: 4.867, frame: 146, player: "P2", contact_status: "candidate", estimate_label: "drive", manual_label: null, image_speed_px_s: 1267.9 },
      { time_s: 13.3, frame: 399, player: "P1", contact_status: "candidate", estimate_label: "smash", manual_label: null, image_speed_px_s: 374.9 },
    ],
    shot_counts: { rows: 12, accepted_by_gate: 0, needs_review: 12, person_labelled: 0 },
  };
}

const CONTEXT = { framesAnalysed: 450, durationS: 15, fps: 30, sourceName: "Sample A" };

test("the report is written from the dataset alone, with every section and the same text each time", () => {
  const report = buildCoachReport(sampleA(), "en", CONTEXT);
  assert.ok(report);
  assert.deepEqual(report.sections.map((section) => section.id), ["overview", "movement", "shots", "speed", "timeline", "not_evaluated"]);
  assert.equal(report.markdown, buildCoachReport(sampleA(), "en", CONTEXT)?.markdown);
  const text = report.markdown;
  assert.match(text, /27\.55 m on the floor/);
  assert.match(text, /P2 moved 5\.9% more than P1 \(floor metres\)/);
  assert.match(text, /front 10\.4%, mid 51\.4%, back 38\.2%/);
  assert.match(text, /Official speed: unavailable/);
  assert.match(text, /max 1267\.9 px\/s, mean 654 px\/s/);
  assert.doesNotMatch(text, /km\/h \d|\d+(\.\d+)? ?km\/h/);
});

test("every value line names its frame and timestamp or the analysed range", () => {
  const report = buildCoachReport(sampleA(), "en", CONTEXT);
  assert.ok(report);
  const facts = report.sections.flatMap((section) => section.lines).filter((item) => item.tone === "fact" || item.tone === "estimate");
  assert.ok(facts.length > 10);
  for (const item of facts) assert.ok(item.evidence, `no evidence for: ${item.text}`);
  const fastest = report.sections.find((section) => section.id === "speed")?.lines.find((item) => item.text.startsWith("Highest candidate"));
  assert.deepEqual(fastest?.evidence, { kind: "frame", frame: 146, timeS: 4.867 });
  const overview = report.sections[0].lines[0];
  assert.deepEqual(overview.evidence, { kind: "range", firstFrame: 0, lastFrame: 449, startS: 0, endS: 449 / 30 });
  assert.equal(evidenceLabel({ kind: "frame", frame: 146, timeS: 4.867 }, "vi"), "khung 146 · 4.87 s");
});

test("estimates are marked unverified and missing values are written as unavailable", () => {
  const vi = buildCoachReport(sampleA(), "vi", CONTEXT);
  const de = buildCoachReport(sampleA(), "de", CONTEXT);
  assert.ok(vi && de);
  assert.match(vi.markdown, /cầu nâng \(lift\) \(3\/6\), chưa kiểm chứng/);
  assert.match(vi.markdown, /Tốc độ chính thức: không có/);
  assert.match(de.markdown, /Häufigste Schätzung von P2: Clear \(5 von 6\), unverifiziert/);
  const uncalibrated = { ...sampleA(), source: { ...sampleA().source, court_status: "failed" } };
  const report = buildCoachReport(uncalibrated, "en", CONTEXT);
  assert.ok(report);
  assert.match(report.markdown, /P1 moved 2370\.7 px in the image/);
  assert.match(report.markdown, /Court zones: unavailable/);
  assert.doesNotMatch(report.markdown, /front 10\.4%/);
});

test("no dataset gives no report", () => {
  assert.equal(buildCoachReport(null, "en"), null);
  assert.equal(isCoachDataset({ schema: "other", job_id: "x" }), false);
  assert.equal(buildCoachReport({ schema: "other", job_id: "x" } as CoachDatasetDoc, "en"), null);
});

test("numbers in text are read with their decimal style and list numbering is skipped", () => {
  const values = numbersInText("1. P1 moved 27,55 m\n2. P2 reached 1,267.9 px/s at frame 146 (5.9 %)").map((item) => item.values);
  assert.deepEqual(values, [[27.55], [1267.9], [146], [5.9]]);
  assert.deepEqual(numbersInText("1.267").map((item) => item.values), [[1267, 1.267]]);
  assert.deepEqual(numbersInText("observed-2d/v1 P3 [K2] https://bwf.example/2023/x").length, 0);
});

test("the number check accepts values from the analysis, rounded or as percentages", () => {
  const known = collectKnownNumbers({ analysis: [sampleA(), { video: { framesAnalysed: 450 } }] });
  const answer = "P2 covered 29.2 m, about 1.6 m more than P1 (5.9%). The highest candidate was 1268 px/s at frame 146 (4.87 s). " +
    "P1 spent 51% of the time mid-court.";
  const result = checkAnswerNumbers(answer, known);
  assert.equal(result.status, "ok", JSON.stringify(result.unmatched));
  assert.equal(result.unmatched.length, 0);
  assert.ok(result.matchedBy.analysis >= 7);
});

test("an invented number and a physical speed are reported with their context", () => {
  const known = collectKnownNumbers({ analysis: [sampleA()], question: ["Was the smash at 13.3 s fast?"], knowledge: ["The net is 1.55 m high at the posts."] });
  const result = checkAnswerNumbers("The smash at 13.3 s reached 312 km/h; P1 hit 47 smashes. The net is 1.55 m high.", known);
  assert.equal(result.status, "warning");
  assert.deepEqual(result.physicalSpeeds.map((item) => item.text), ["312 km/h"]);
  assert.deepEqual(result.unmatched.map((item) => item.text), ["312", "47"]);
  assert.equal(result.matchedBy.knowledge, 1);
  assert.ok(result.matchedBy.question + result.matchedBy.analysis >= 1);
  assert.match(result.unmatched[1].context, /47 smashes/);
});

test("an answer without numbers is reported as empty, not as checked", () => {
  const result = checkAnswerNumbers("Keep your racket up between shots.", collectKnownNumbers({ analysis: [sampleA()] }));
  assert.equal(result.status, "empty");
  assert.equal(result.checked, 0);
});

test("a difference between two players in the dataset is traced, though the snapshot has its own players block", () => {
  // The chat sends [coachDataset, snapshot]. The snapshot's players block holds counts, not P1 and P2, and must not hide
  // the dataset's pair: 29.17 - 27.55 = 1.62 is known from the two values it comes from.
  const snapshotLike = { players: { tracksConfirmed: 3, tracksInMovementStatistics: 2, meanDetectionScore: 0.91 } };
  const known = collectKnownNumbers({ analysis: [sampleA(), snapshotLike] });
  const answer = "Player P2 covered approximately 1.62 more metres than Player P1. This is calculated by subtracting " +
    "P1's distance of 27.55 metres from P2's distance of 29.17 metres.";
  const result = checkAnswerNumbers(answer, known);
  assert.equal(result.status, "ok", JSON.stringify(result.unmatched));
  assert.equal(result.matched, 3);
  const wrong = checkAnswerNumbers("Player P2 covered 1.63 more metres than Player P1.", known);
  assert.deepEqual(wrong.unmatched.map((item) => item.text), ["1.63"]);
});

test("every pair of players counts, not only the first two", () => {
  const known = collectKnownNumbers({ analysis: [{ players: { P1: { court_m: 20 }, P2: { court_m: 25 }, P3: { court_m: 30 } } }] });
  assert.equal(checkAnswerNumbers("P3 covered 10 m more than P1.", known).status, "ok");
});
