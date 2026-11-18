import assert from "node:assert/strict";
import test from "node:test";

import {
  createSessionValue,
  passwordMatches,
  readCookie,
  verifySessionValue,
} from "../src/lib/auth/site-session.ts";
import { isAllowedBackendRequest, isMediaPath } from "../src/lib/auth/proxy-rules.ts";

const SECRET = "x".repeat(40);

test("a session cookie is valid until it expires and fails when altered or signed with another secret", () => {
  const now = 1_800_000_000;
  const value = createSessionValue(SECRET, now, 3600);
  assert.equal(verifySessionValue(SECRET, value, now + 60), true);
  assert.equal(verifySessionValue(SECRET, value, now + 3600), false);
  assert.equal(verifySessionValue("y".repeat(40), value, now + 60), false);
  const [body, signature] = value.split(".");
  assert.equal(verifySessionValue(SECRET, `${body}x.${signature}`, now + 60), false);
  assert.equal(verifySessionValue(SECRET, `${body}.${signature}.extra`, now + 60), false);
  assert.equal(verifySessionValue(SECRET, undefined, now), false);
});

test("passwords are compared without revealing a match, and equal passwords match", () => {
  assert.equal(passwordMatches("correct horse battery", "correct horse battery"), true);
  assert.equal(passwordMatches("correct horse battery", "correct horse batter"), false);
  assert.equal(passwordMatches("correct horse battery", ""), false);
});

test("the session cookie is read from a Cookie header with several entries", () => {
  assert.equal(readCookie("theme=dark; smashlab_session=abc.def; other=1", "smashlab_session"), "abc.def");
  assert.equal(readCookie("theme=dark", "smashlab_session"), undefined);
});

test("the proxy forwards only the studio's own API routes and health, and never path tricks", () => {
  assert.equal(isAllowedBackendRequest(["api", "v1", "analyses"], "GET"), true);
  assert.equal(isAllowedBackendRequest(["api", "v1", "analyses"], "POST"), true);
  assert.equal(isAllowedBackendRequest(["api", "v1", "upload-tickets"], "POST"), true);
  assert.equal(isAllowedBackendRequest(["health"], "GET"), true);
  assert.equal(isAllowedBackendRequest(["health"], "POST"), false);
  assert.equal(isAllowedBackendRequest(["api", "v1", "analyses"], "DELETE"), false);
  assert.equal(isAllowedBackendRequest(["docs"], "GET"), false);
  assert.equal(isAllowedBackendRequest(["api", "v1", "..", "secrets"], "GET"), false);
  assert.equal(isAllowedBackendRequest(["api", "v1", "%2e%2e", "x"], "GET"), false);
  assert.equal(isAllowedBackendRequest([], "GET"), false);
});

test("media paths are recognised so that they stream without a fetch timeout", () => {
  assert.equal(isMediaPath(["api", "v1", "analyses", "abc", "artifacts", "annotated.mp4"]), true);
  assert.equal(isMediaPath(["api", "v1", "analyses", "abc", "source"]), true);
  assert.equal(isMediaPath(["api", "v1", "samples", "sample-a", "video"]), true);
  assert.equal(isMediaPath(["api", "v1", "analyses"]), false);
});
