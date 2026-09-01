import assert from "node:assert/strict";
import test from "node:test";
import { formatKnowledgeContext, retrieveKnowledge } from "../src/lib/ai/retrieval.ts";

test("retrieves smash motion coaching for a Vietnamese question", () => {
  const results = retrieveKnowledge("Smash của tôi cần cải thiện xoay thân, gập gối và hồi vị thế nào?");
  assert.equal(results[0]?.id, "smash-motion");
});

test("retrieves backhand technique guidance", () => {
  const results = retrieveKnowledge("Backhand trái tay của tôi bị dài động tác và khuỷu vào chậm");
  assert.equal(results[0]?.id, "backhand-motion");
});

test("prioritizes limitations for shuttle speed and contact questions", () => {
  const results = retrieveKnowledge("Motion capture có biết tốc độ km/h, mặt vợt và điểm tiếp xúc không?");
  assert.equal(results[0]?.id, "motion-limitations");
});

test("formats exact source titles and URLs for grounded citations", () => {
  const results = retrieveKnowledge("chu trình chuẩn bị kéo vợt theo đà hồi vị", 1);
  const formatted = formatKnowledgeContext(results);
  assert.match(formatted, /Tiêu đề nguồn chính xác: BWF Coach Education — Coaches’ Manual Level 1/);
  assert.match(formatted, /https:\/\/bwf\.worldacademysport\.com/);
});

test("retrieves BWF footwork components for split step and lunge", () => {
  const results = retrieveKnowledge("Bộ pháp split step chasse và lunge của tôi cần sửa gì?");
  assert.ok(results.slice(0, 2).some((result) => result.id === "bwf-footwork-components"));
});

test("retrieves relative measurement limits for footwork", () => {
  const results = retrieveKnowledge("Tốc độ chân và khoảng cách bộ pháp có phải mét thật không?");
  assert.ok(results.some((result) => result.id === "footwork-measurement-limit"));
});

test("retrieves footwork knowledge for a German coaching question", () => {
  const results = retrieveKnowledge("Wie verbessere ich Beinarbeit, Ausfallschritt, Landung und Rückkehr?");
  assert.ok(results.slice(0, 2).some((result) => result.id === "bwf-footwork-components"));
});

test("localizes retrieval metadata for English and German prompts", () => {
  const results = retrieveKnowledge("smash trunk rotation and recovery", 1);
  assert.match(formatKnowledgeContext(results, "en"), /Exact source title:/);
  assert.match(formatKnowledgeContext(results, "de"), /Exakter Quellentitel:/);
  assert.match(formatKnowledgeContext([], "de"), /kein passender Wissensabschnitt/i);
});
