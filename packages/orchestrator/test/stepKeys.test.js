"use strict";
// Offline regression lock for the self-heal off-by-one (see CONTRIBUTING.md, invariant 4).
//
// The generated spec's `STEP_ID=plan-step-N` marker (parsed by ExecutorAgent and used as the heal
// lookup key) MUST equal the `step_key` UiInspectorAgent stores the baseline embedding under for the
// SAME 0-based step index. If they drift, SelfHealAgent finds no baseline and heals nothing.
//
// Both producers now route through core/utils/stepKeys. This test asserts (1) the mapping, and
// (2) that the real codegen output uses exactly the shared keys, in order — so a future change that
// re-introduces a divergent numbering fails here. Requires a build first (imports from dist/).

const { test } = require("node:test");
const assert = require("node:assert");
const { stepKeyForIndex, stepIdMarker } = require("../dist/core/utils/stepKeys.js");
const { planToPlaywrightTs } = require("../dist/agents/TestScriptGeneratorAgent/tools/planToPlaywright.js");

test("stepKeys: 0-based index maps to plan-step-N (1-based)", () => {
  assert.strictEqual(stepKeyForIndex(0), "plan-step-1");
  assert.strictEqual(stepKeyForIndex(4), "plan-step-5");
  assert.strictEqual(stepIdMarker(0), "STEP_ID=plan-step-1");
  assert.strictEqual(stepIdMarker(4), "STEP_ID=plan-step-5");
});

test("codegen STEP_ID markers equal stepKeyForIndex for every step, in order (F1 lock)", () => {
  const plan = {
    testCases: [
      {
        title: "parity",
        steps: [
          { action: "goto", url: "/auth/login" },
          { action: "fill", field: "Email", value: "a@b.com" },
          { action: "fill", field: "Password", value: "pw" },
          { action: "click", target: "Sign In" },
          { action: "expectVisible", target: "Total Orders" },
        ],
      },
    ],
  };

  const code = planToPlaywrightTs({ plan, baseUrl: "http://localhost:5173" });

  // Extract STEP_ID payloads in source order.
  const markers = [...code.matchAll(/STEP_ID=([\w-]+)/g)].map((m) => m[1]);
  assert.strictEqual(markers.length, plan.testCases[0].steps.length, "one marker per step");

  markers.forEach((payload, i) => {
    assert.strictEqual(
      payload,
      stepKeyForIndex(i),
      `step ${i}: codegen marker "${payload}" must equal baseline key "${stepKeyForIndex(i)}"`
    );
  });

  // First step is plan-step-1 (not plan-step-2): the off-by-one would have shifted these.
  assert.strictEqual(markers[0], "plan-step-1");
});
