"use strict";
// Offline unit tests for the orchestrator report helpers (failure classification + per-browser
// step-result merge). Requires a build first (imports from dist/).

const { test } = require("node:test");
const assert = require("node:assert");
const {
  classifyFailure,
  mergeStepResults,
  mergeStepResultsByFile,
  dedupeHealAttempts,
  extractScreenshotPaths,
  attachScreenshotsToSteps,
} = require("../dist/core/utils/report.js");

test("extractScreenshotPaths keeps image attachments by type/name/extension", () => {
  const atts = [
    { name: "screenshot", contentType: "image/png", path: "/r/test-failed-1.png" },
    { name: "trace", contentType: "application/zip", path: "/r/trace.zip" },
    { name: "shot2", path: "/r/x.jpeg" },
    { name: "video", contentType: "video/webm", path: "/r/v.webm" },
    { name: "noPath", contentType: "image/png" },
  ];
  assert.deepStrictEqual(extractScreenshotPaths(atts), ["/r/test-failed-1.png", "/r/x.jpeg"]);
  assert.deepStrictEqual(extractScreenshotPaths(undefined), []);
});

test("attachScreenshotsToSteps binds shots to the failed step (else the last)", () => {
  const steps = [
    { stepKey: "plan-step-1", title: "a", status: "passed" },
    { stepKey: "plan-step-2", title: "b", status: "failed" },
    { stepKey: "plan-step-3", title: "c", status: "passed" },
  ];
  attachScreenshotsToSteps(steps, [{ name: "screenshot", contentType: "image/png", path: "/r/f.png" }]);
  assert.deepStrictEqual(steps[1].screenshots, ["/r/f.png"]);
  assert.strictEqual(steps[0].screenshots, undefined);

  const allPass = [{ stepKey: "plan-step-1", title: "a", status: "passed" }];
  attachScreenshotsToSteps(allPass, [{ name: "screenshot", path: "/r/g.png" }]);
  assert.deepStrictEqual(allPass[0].screenshots, ["/r/g.png"]);

  // no-op cases
  const s2 = [{ stepKey: "x", title: "t", status: "passed" }];
  attachScreenshotsToSteps(s2, []);
  assert.strictEqual(s2[0].screenshots, undefined);
});

test("classifyFailure buckets known signatures", () => {
  assert.strictEqual(classifyFailure("Error: strict mode violation: resolved to 2"), "strict-mode");
  assert.strictEqual(classifyFailure("element(s) not found"), "locator-not-found");
  assert.strictEqual(classifyFailure("Timeout 5000ms exceeded"), "navigation-timeout");
  assert.strictEqual(classifyFailure("expected 'A' received 'B'"), "assertion-mismatch");
  assert.strictEqual(classifyFailure(""), "unknown");
  assert.strictEqual(classifyFailure(undefined), "unknown");
});

test("classifyFailure maps the runPlaywright timeout message to navigation-timeout (F2)", () => {
  // ExecutorAgent's timeout branch classifies the exact message runPlaywright rejects with.
  assert.strictEqual(
    classifyFailure("Playwright test timed out after 300000ms"),
    "navigation-timeout"
  );
});

test("mergeStepResults dedups across browsers, FAILED wins", () => {
  const chromium = [
    { stepKey: "plan-step-1", title: "", status: "passed" },
    { stepKey: "plan-step-2", title: "", status: "passed" },
  ];
  const firefox = [
    { stepKey: "plan-step-1", title: "", status: "passed" },
    { stepKey: "plan-step-2", title: "", status: "failed", errorMessage: "boom" },
  ];
  const merged = mergeStepResults([chromium, firefox]);
  assert.strictEqual(merged.length, 2, "deduped to one row per stepKey");
  assert.strictEqual(merged[0].status, "passed");
  assert.strictEqual(merged[1].status, "failed", "a failure in any browser surfaces");
  assert.strictEqual(merged[1].errorMessage, "boom");
});

test("mergeStepResults preserves first-seen order and handles empties", () => {
  assert.deepStrictEqual(mergeStepResults([]), []);
  const m = mergeStepResults([
    [{ stepKey: "a", title: "", status: "passed" }],
    [{ stepKey: "b", title: "", status: "passed" }],
  ]);
  assert.deepStrictEqual(m.map((s) => s.stepKey), ["a", "b"]);
});

test("mergeStepResultsByFile keeps same-keyed steps in different files separate (Run All — F1)", () => {
  // Two generated specs, each with its own plan-step-1; file B's step-1 fails. A global merge would
  // collide them; the per-file merge must not.
  const fileA = {
    file: "a.spec.ts",
    perTest: [[
      { stepKey: "plan-step-1", title: "", status: "passed" },
      { stepKey: "plan-step-2", title: "", status: "passed" },
    ]],
  };
  const fileB = {
    file: "b.spec.ts",
    perTest: [[
      { stepKey: "plan-step-1", title: "", status: "failed", errorMessage: "boom" },
    ]],
  };
  const { stepResults, failedSteps } = mergeStepResultsByFile([fileA, fileB]);
  assert.strictEqual(stepResults.length, 3, "no cross-file stepKey collision");
  assert.deepStrictEqual(failedSteps, [{ stepKey: "plan-step-1", file: "b.spec.ts" }]);
});

test("mergeStepResultsByFile merges one file across browsers (single-file parity)", () => {
  const { stepResults, failedSteps } = mergeStepResultsByFile([{
    file: "only.spec.ts",
    perTest: [
      [{ stepKey: "plan-step-1", title: "", status: "passed" }],
      [{ stepKey: "plan-step-1", title: "", status: "failed", errorMessage: "x" }],
    ],
  }]);
  assert.strictEqual(stepResults.length, 1, "cross-browser dedup within the file");
  assert.strictEqual(stepResults[0].status, "failed", "FAILED in any browser surfaces");
  assert.deepStrictEqual(failedSteps, [{ stepKey: "plan-step-1", file: "only.spec.ts" }]);
});

test("dedupeHealAttempts collapses pre/post-rerun rows to one per step, success wins (H1)", () => {
  const rows = [
    { failedStepId: "plan-step-8", oldLocator: "a", newLocator: "b", succeeded: false }, // pre-rerun
    { failedStepId: "plan-step-8", oldLocator: "a", newLocator: "b", succeeded: true },  // post-rerun
  ];
  const out = dedupeHealAttempts(rows);
  assert.strictEqual(out.length, 1, "one row per step (not per attempt)");
  assert.strictEqual(out[0].succeeded, true, "success wins");
});

test("dedupeHealAttempts keeps rows without a failedStepId", () => {
  const rows = [
    { failedStepId: null, oldLocator: null, newLocator: null, succeeded: true },
    { failedStepId: null, oldLocator: null, newLocator: null, succeeded: false },
  ];
  assert.strictEqual(dedupeHealAttempts(rows).length, 2);
});
