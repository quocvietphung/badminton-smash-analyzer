import assert from "node:assert/strict";
import test from "node:test";
import {
  apiUrl,
  artifactUrl,
  clampProgress,
  formatBytes,
  formatSeconds,
  heatmapCells,
  isLocalAiArtifactName,
  isTerminalStatus,
  LOCAL_AI_JOB_ID_STORAGE_KEY,
  LOCAL_AI_PROXY_BASE,
  parseLocalAiError,
  readStoredJobId,
  sampleVideoUrl,
  trajectorySegments,
  visibleRatio,
  writeStoredJobId,
  type TrajectoryFrame,
} from "../src/lib/local-ai/client.ts";

test("the browser calls the studio proxy, so no backend address is built into the page", () => {
  assert.equal(LOCAL_AI_PROXY_BASE, "/api/backend");
  assert.equal(apiUrl(LOCAL_AI_PROXY_BASE, "/api/v1/analyses"), "/api/backend/api/v1/analyses");
  assert.equal(
    sampleVideoUrl(LOCAL_AI_PROXY_BASE, "sample-a-singles-rally"),
    "/api/backend/api/v1/samples/sample-a-singles-rally/video",
  );
});

test("joins base URLs and paths without duplicate slashes", () => {
  assert.equal(apiUrl("http://localhost:8000/", "/api/v1/samples"), "http://localhost:8000/api/v1/samples");
  assert.equal(apiUrl("http://localhost:8000", "api/v1/samples"), "http://localhost:8000/api/v1/samples");
});

test("builds artifact URLs and recognises only allow-listed artifact names", () => {
  const jobId = "0123456789abcdef0123456789abcdef";
  assert.equal(
    artifactUrl("http://localhost:8000", jobId, "annotated.mp4"),
    `http://localhost:8000/api/v1/analyses/${jobId}/artifacts/annotated.mp4`,
  );
  assert.equal(isLocalAiArtifactName("annotated.mp4"), true);
  assert.equal(isLocalAiArtifactName("../secrets.json"), false);
  assert.equal(isLocalAiArtifactName("results.json.bak"), false);
});

test("reads the backend error envelope and falls back to the HTTP status", () => {
  assert.deepEqual(
    parseLocalAiError(415, { error: { code: "unsupported_format", message: "Only MP4 or MOV files are accepted." } }),
    { code: "unsupported_format", message: "Only MP4 or MOV files are accepted." },
  );
  assert.deepEqual(parseLocalAiError(502, "<html>bad gateway</html>"), {
    code: "http_error",
    message: "The backend answered with HTTP 502.",
  });
  assert.equal(parseLocalAiError(500, { error: { code: 1 } }).code, "http_error");
});

test("classifies terminal job states", () => {
  assert.equal(isTerminalStatus("completed"), true);
  assert.equal(isTerminalStatus("failed"), true);
  assert.equal(isTerminalStatus("queued"), false);
  assert.equal(isTerminalStatus("running"), false);
});

test("clamps progress values and formats them", () => {
  assert.equal(clampProgress(-0.2), 0);
  assert.equal(clampProgress(1.7), 1);
  assert.equal(clampProgress(Number.NaN), 0);
  assert.equal(clampProgress(0.456), 0.456);
});

test("keeps only non-empty heatmap cells with clamped intensities", () => {
  const cells = heatmapCells([
    [0, 0.5],
    [1.4, 0],
  ]);
  assert.deepEqual(cells, [
    { row: 0, col: 1, intensity: 0.5 },
    { row: 1, col: 0, intensity: 1 },
  ]);
  assert.deepEqual(heatmapCells([]), []);
});

function frame(index: number, x: number | null, y: number | null, visible: boolean, refined = false): TrajectoryFrame {
  return { frame: index, x, y, visible, confidence: visible ? 0.8 : 0, refined };
}

test("splits shuttle trajectories at gaps and at detected/interpolated changes", () => {
  const segments = trajectorySegments([
    frame(0, 10, 10, true),
    frame(1, 12, 11, true),
    frame(2, null, null, false),
    frame(3, 20, 20, true),
    frame(4, 22, 21, true, true),
    frame(5, 24, 22, true, true),
  ]);
  assert.equal(segments.length, 3);
  assert.deepEqual(segments[0], { refined: false, points: [{ x: 10, y: 10 }, { x: 12, y: 11 }] });
  assert.deepEqual(segments[1], { refined: false, points: [{ x: 20, y: 20 }] });
  assert.equal(segments[2].refined, true);
  assert.equal(segments[2].points.length, 2);
});

test("visible ratio handles empty input and counts visible frames", () => {
  assert.equal(visibleRatio([]), 0);
  assert.equal(visibleRatio([frame(0, 1, 1, true), frame(1, null, null, false)]), 0.5);
});

test("reads and writes the last job id defensively", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const jobId = "fedcba9876543210fedcba9876543210";
  writeStoredJobId(storage, jobId);
  assert.equal(values.get(LOCAL_AI_JOB_ID_STORAGE_KEY), jobId);
  assert.equal(readStoredJobId(storage), jobId);
  values.set(LOCAL_AI_JOB_ID_STORAGE_KEY, "../../etc/passwd");
  assert.equal(readStoredJobId(storage), null);
  assert.equal(readStoredJobId(null), null);

  const throwing = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(readStoredJobId(throwing), null);
  assert.doesNotThrow(() => writeStoredJobId(throwing, jobId));
});

test("formats durations and byte sizes", () => {
  assert.equal(formatSeconds(null), "–");
  assert.equal(formatSeconds(12.34), "12.3 s");
  assert.equal(formatSeconds(125), "2 min 5 s");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
});
