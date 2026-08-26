"use strict";
// Offline unit tests: ReporterAgent must produce an accurate RUN_SUMMARY when the DB is
// disabled (testRunId undefined) by falling back to in-memory ctx.stepResults.
// Requires a build first (imports from dist/). No DB / network used (no testRunId → no DB calls).

const { test } = require("node:test");
const assert = require("node:assert");
const { ReporterAgent } = require("../dist/agents/ReporterAgent/ReporterAgent.js");

function captureRun(ctx) {
  const logs = [];
  const logger = { log: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) };
  return new ReporterAgent().run(ctx, logger).then(() => {
    const line = logs.find((l) => l.includes('"__type":"RUN_SUMMARY"'));
    assert.ok(line, "a RUN_SUMMARY must be emitted");
    return { summary: JSON.parse(line), logs };
  });
}

const baseCtx = () => ({
  requestText: "verify something",
  workspacePath: process.cwd(),
  testRelPath: "tests/generated/x.spec.ts",
  dbEnabled: false,
  testPlan: { testCases: [{ title: "t", steps: [{ action: "goto", url: "/" }] }] },
});

test("DB-off passing run: summary counts come from ctx.stepResults", async () => {
  const ctx = {
    ...baseCtx(),
    playwrightExitCode: 0,
    stepResults: [
      { stepKey: "plan-step-1", title: "a", status: "passed" },
      { stepKey: "plan-step-2", title: "b", status: "passed" },
    ],
  };
  const { summary } = await captureRun(ctx);
  assert.strictEqual(summary.status, "passed");
  assert.strictEqual(summary.stepsTotal, 2);
  assert.strictEqual(summary.stepsPassed, 2);
  assert.strictEqual(summary.stepsFailed, 0);
  assert.strictEqual(summary.healAttempts, 0, "no healing without a DB");
  // New contract (P2.1): every summary has a stable, non-empty id even when the DB is off, so the
  // sidebar never crashes on `runId.slice(...)`. The id is local + flagged not-persisted.
  assert.ok(summary.runId && summary.runId.startsWith("local-"), "synthesizes a local runId");
  assert.strictEqual(summary.persisted, false, "DB-off run is flagged not persisted");
});

test("P2.1: steps carry meaningful descriptions correlated from the plan", async () => {
  const ctx = {
    ...baseCtx(),
    playwrightExitCode: 0,
    testPlan: {
      testCases: [
        {
          title: "Add to cart",
          steps: [
            { action: "goto", url: "/products" },
            { action: "click", target: "Add to Cart" },
          ],
        },
      ],
    },
    stepResults: [
      { stepKey: "plan-step-1", title: "STEP_ID=plan-step-1 | goto", status: "passed", durationMs: 300 },
      { stepKey: "plan-step-2", title: "STEP_ID=plan-step-2 | click", status: "passed", durationMs: 410 },
    ],
  };
  const { summary } = await captureRun(ctx);
  assert.strictEqual(summary.testTitle, "Add to cart");
  assert.strictEqual(summary.steps[0].description, "goto /products");
  assert.strictEqual(summary.steps[1].description, 'click "Add to Cart"');
  assert.strictEqual(summary.steps[0].durationMs, 300);
  assert.strictEqual(summary.steps[1].index, 2);
  assert.strictEqual(summary.durationMs, 710);
});

test("DB-off failing run: failed steps are counted from memory", async () => {
  const ctx = {
    ...baseCtx(),
    playwrightExitCode: 1,
    stepResults: [
      { stepKey: "plan-step-1", title: "a", status: "passed" },
      { stepKey: "plan-step-2", title: "b", status: "failed", errorMessage: "locator not found" },
    ],
  };
  const { summary } = await captureRun(ctx);
  assert.strictEqual(summary.status, "failed");
  assert.strictEqual(summary.stepsTotal, 2);
  assert.strictEqual(summary.stepsPassed, 1);
  assert.strictEqual(summary.stepsFailed, 1);
});

test("DB-off run with no step results still emits a summary", async () => {
  const ctx = { ...baseCtx(), playwrightExitCode: 0, stepResults: undefined };
  const { summary } = await captureRun(ctx);
  assert.strictEqual(summary.stepsTotal, 0);
  assert.strictEqual(summary.status, "passed");
});

test("planningDegraded is surfaced in the summary + report text (E3)", async () => {
  const ctx = {
    ...baseCtx(),
    playwrightExitCode: 0,
    planningDegraded: true,
    planningDegradedReason: "schema fail",
    stepResults: [{ stepKey: "plan-step-1", title: "a", status: "passed" }],
  };
  const { summary, logs } = await captureRun(ctx);
  assert.strictEqual(summary.planningDegraded, true);
  assert.strictEqual(summary.planningDegradedReason, "schema fail");
  assert.ok(
    logs.some((l) => l.includes("Planning degraded")),
    "the human report warns that a placeholder plan ran"
  );
});

/* ─── G3.9: the Playwright wall-clock budget scales with the work ─── */

const {
  deriveRunTimeoutMs,
  MIN_RUN_TIMEOUT_MS,
  MAX_RUN_TIMEOUT_MS,
} = require("../dist/executor.js");

test("the run budget never drops below the historical floor (G3.9)", () => {
  // Everything that fit in the old flat 300s must still fit — this change may only ever add headroom.
  assert.strictEqual(deriveRunTimeoutMs(1, 1), MIN_RUN_TIMEOUT_MS, "a tiny run keeps the floor");
  assert.strictEqual(deriveRunTimeoutMs(0, 0), MIN_RUN_TIMEOUT_MS, "unknown size keeps the floor");
  for (const [steps, projects] of [[1, 1], [6, 1], [12, 5], [28, 5], [100, 5]]) {
    assert.ok(
      deriveRunTimeoutMs(steps, projects) >= MIN_RUN_TIMEOUT_MS,
      `${steps}x${projects} must never get less than the old flat cap`
    );
  }
});

test("a large plan across the full matrix gets real headroom (G3.9)", () => {
  // demo-web prompt 14: the LLM authors 28 steps; 5 browsers of that ran past the flat 300s cap and
  // was killed, producing NO Playwright report — reported as `no-report`, indistinguishable from a crash.
  assert.strictEqual(deriveRunTimeoutMs(28, 5), 120000 + 28 * 5 * 4000);
  assert.ok(deriveRunTimeoutMs(28, 5) > MIN_RUN_TIMEOUT_MS);
});

test("a genuine hang is still bounded (G3.9)", () => {
  assert.strictEqual(deriveRunTimeoutMs(500, 5), MAX_RUN_TIMEOUT_MS);
});
