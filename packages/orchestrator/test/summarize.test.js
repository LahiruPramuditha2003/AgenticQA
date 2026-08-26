"use strict";
// Offline unit tests for the benchmark instrument: prompt extraction, failure
// classification, result summarization, and the Playwright report parser.
// These are plain Node scripts (no build required).

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const {
  classifyFailure,
  summarizeTemplateResults,
  parsePlaywrightReport,
} = require("../scripts/summarizeTemplateResults.js");
const { extractTemplatePrompts } = require("../scripts/extractTemplatePrompts.js");

test("classifyFailure maps known signatures", () => {
  assert.strictEqual(classifyFailure("Error: strict mode violation: ..."), "strict-mode");
  assert.strictEqual(classifyFailure("Timeout 30000ms exceeded waiting for ..."), "navigation-timeout");
  assert.strictEqual(classifyFailure(""), "unknown");
});

test("summarizeTemplateResults computes pass rate", () => {
  const s = summarizeTemplateResults([{ passed: true }, { passed: false }, { passed: true }]);
  assert.strictEqual(s.total, 3);
  assert.strictEqual(s.passed, 2);
  assert.strictEqual(s.failed, 1);
  assert.strictEqual(s.passRate, 66.67);
});

const FIXTURE_REPORT = {
  suites: [
    {
      title: "a.spec.ts",
      file: "a.spec.ts",
      specs: [
        {
          title: "search test",
          file: "a.spec.ts",
          tests: [
            { projectName: "chromium", results: [{ status: "passed", steps: [] }] },
            {
              projectName: "firefox",
              results: [
                {
                  status: "failed",
                  errors: [{ message: "strict mode violation: resolved to 2 elements" }],
                  steps: [
                    {
                      title: "STEP_ID=plan-step-2 | click",
                      error: { message: "strict mode violation" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

test("parsePlaywrightReport reports per-project status", () => {
  const { specs, projectNames } = parsePlaywrightReport(FIXTURE_REPORT);
  assert.strictEqual(specs.length, 1);
  const spec = specs[0];
  assert.strictEqual(spec.projects.chromium, "passed");
  assert.strictEqual(spec.projects.firefox, "failed");
  assert.strictEqual(spec.passed, false, "any failing project fails the spec");
  assert.strictEqual(spec.firstFailedStep, "plan-step-2");
  assert.strictEqual(spec.failureClass, "strict-mode");
  assert.ok(projectNames.includes("chromium") && projectNames.includes("firefox"));
});

test("parsePlaywrightReport merges per-project specs for the same file (real PW structure)", () => {
  // Playwright emits one spec per (file × project) — 5 browsers → 5 specs, same file.
  const projects = ["chromium", "firefox", "webkit", "Mobile Chrome", "Mobile Safari"];
  const report = {
    suites: projects.map((p) => ({
      title: p,
      file: "x.spec.ts",
      specs: [
        {
          title: "t",
          file: "x.spec.ts",
          tests: [{ projectName: p, results: [{ status: "passed", steps: [] }] }],
        },
      ],
    })),
  };
  const { specs, projectNames } = parsePlaywrightReport(report);
  assert.strictEqual(specs.length, 1, "5 per-project specs merge into one row");
  assert.deepStrictEqual(Object.keys(specs[0].projects).sort(), [...projects].sort());
  assert.strictEqual(specs[0].passed, true, "all 5 browsers passed");
  assert.strictEqual(projectNames.length, 5);
});

test("parsePlaywrightReport honours a project filter", () => {
  const { specs } = parsePlaywrightReport(FIXTURE_REPORT, { projects: ["chromium"] });
  assert.strictEqual(specs[0].passed, true, "only chromium required → passes");
  assert.deepStrictEqual(Object.keys(specs[0].projects), ["chromium"]);
});

test("extractTemplatePrompts reads the real TEST_TEMPLATES.md", () => {
  const tpl = path.resolve(__dirname, "../../../benchmarks/TEST_TEMPLATES.md");
  const prompts = extractTemplatePrompts(tpl);
  assert.ok(prompts.length >= 40, `expected many prompts, got ${prompts.length}`);
  const first = prompts.find((p) => p.index === 1);
  assert.ok(first && /home page navigation/i.test(first.title), "prompt 1 is Home Page Navigation");
  const login = prompts.find((p) => p.index === 15);
  assert.ok(login && /login/i.test(login.title), "prompt 15 is a login scenario");
});
