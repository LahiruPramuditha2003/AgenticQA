"use strict";
/**
 * G5.1 / defect D6 — which browsers a run executes against.
 *
 * The precedence is locked here because getting it wrong is SILENT: if the accuracy benchmark ever
 * inherited the new chromium-only default, "20/20 across five browsers" would quietly start meaning
 * "20/20 on chromium" without a single line of output changing.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { resolveExecutionProjects } = require("../dist/core/services/ConfigService.js");
const { deriveRunTimeoutMs } = require("../dist/executor.js");

test("a prompted run defaults to chromium only (G5.1)", () => {
  assert.deepStrictEqual(resolveExecutionProjects({}), ["chromium"]);
});

test("the full matrix is one explicit flag away (G5.1)", () => {
  // `undefined` = pass no --project to Playwright = whatever the app's config defines.
  assert.strictEqual(resolveExecutionProjects({ allProjects: true }), undefined);
  assert.strictEqual(resolveExecutionProjects({ configured: "all" }), undefined);
});

test("an app may configure its own project list (G5.1)", () => {
  assert.deepStrictEqual(
    resolveExecutionProjects({ configured: ["chromium", "webkit"] }),
    ["chromium", "webkit"]
  );
  assert.deepStrictEqual(resolveExecutionProjects({ configured: [] }), ["chromium"], "empty = default");
});

test("an explicit pin beats everything (G5.1)", () => {
  assert.deepStrictEqual(
    resolveExecutionProjects({ pinned: "firefox", allProjects: true, configured: "all" }),
    ["firefox"]
  );
});

test("the benchmark runner still asks for the full matrix (G5.1)", () => {
  // Reading the source is the honest check: the failure mode is that this line silently disappears and
  // the headline number changes meaning with no other symptom.
  const runner = fs.readFileSync(path.join(__dirname, "..", "scripts", "batchRunTemplates.js"), "utf8");
  assert.match(
    runner,
    /execution:\s*execProject\s*\?\s*\{\s*project:\s*execProject\s*\}\s*:\s*\{\s*allProjects:\s*true\s*\}/,
    "batchRunTemplates.js must request allProjects unless --exec-project pins one"
  );
});

test("the timeout budget follows the browser count (G5.1)", () => {
  // Fewer browsers is less work, so the same plan needs less wall clock — but never below the floor.
  assert.ok(deriveRunTimeoutMs(28, 1) < deriveRunTimeoutMs(28, 5));
});
