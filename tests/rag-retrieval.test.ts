import assert from "node:assert/strict";
import test from "node:test";
import { formatKnowledgeContext, retrieveKnowledge } from "../src/lib/ai/retrieval.ts";

test("retrieves smash coaching knowledge for a Vietnamese question", () => {
  const results = retrieveKnowledge("Smash của tôi cần cải thiện vai và hồi vị thế nào?");
  assert.equal(results[0]?.id, "smash-coaching-cues");
  assert.ok(results.some((result) => result.id === "overhead-stroke-family"));
});

test("prioritizes measurement limits for km/h and trajectory", () => {
  const results = retrieveKnowledge("Tốc độ smash bao nhiêu km/h và quỹ đạo đi chéo hay thẳng?");
  assert.equal(results[0]?.id, "pose-lite-unavailable-measurements");
});

test("retrieves rally data requirements for tactical analysis", () => {
  const results = retrieveKnowledge("Có thể kết luận chiến thuật rally và chuỗi điều cầu không?");
  assert.equal(results[0]?.id, "shuttleset-tactical-data");
});

test("formats exact source titles and URLs for grounded citations", () => {
  const [result] = retrieveKnowledge("TrackNetV3 theo dõi quả cầu thế nào?", 1);
  const context = formatKnowledgeContext(result ? [result] : []);
  assert.match(context, /Tiêu đề nguồn chính xác: TrackNetV3: Enhancing ShuttleCock Tracking/);
  assert.match(context, /URL chính xác: https:\/\/github\.com\/qaz812345\/TrackNetV3/);
});
