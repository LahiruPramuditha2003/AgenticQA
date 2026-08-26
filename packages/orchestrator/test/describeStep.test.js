"use strict";
// Offline unit tests for the step-description helper (no network/DB). Imports from dist/.

const { test } = require("node:test");
const assert = require("node:assert");
const {
  describeStep,
  describeFromTitle,
  stepNumberFromKey,
} = require("../dist/core/utils/describeStep.js");

test("describeStep renders common actions readably", () => {
  assert.strictEqual(describeStep({ action: "goto", url: "/products" }), "goto /products");
  assert.strictEqual(describeStep({ action: "click", target: "Add to Cart" }), 'click "Add to Cart"');
  assert.strictEqual(
    describeStep({ action: "fill", field: "Email", value: "a@b.com" }),
    'fill Email = "a@b.com"'
  );
  assert.strictEqual(
    describeStep({ action: "expectVisible", target: "Order Summary" }),
    'expect "Order Summary" visible'
  );
  assert.strictEqual(
    describeStep({ action: "expectText", target: "Toast", text: "Invalid", mode: "contains" }),
    'expect "Toast" contains "Invalid"'
  );
});

test("describeStep masks secret-looking fields", () => {
  const out = describeStep({ action: "fill", field: "Password", value: "hunter2" });
  assert.ok(out.includes("••••••"), `password should be masked, got: ${out}`);
  assert.ok(!out.includes("hunter2"));
});

test("describeStep never throws on unknown/garbage shapes", () => {
  assert.strictEqual(describeStep(null), "step");
  assert.strictEqual(describeStep({}), "step");
  assert.strictEqual(describeStep({ action: "weirdAction", target: "X" }), "weirdAction X");
});

test("stepNumberFromKey parses plan-step-N", () => {
  assert.strictEqual(stepNumberFromKey("plan-step-7"), 7);
  assert.strictEqual(stepNumberFromKey("plan-step-1"), 1);
  assert.strictEqual(stepNumberFromKey("nope"), null);
  assert.strictEqual(stepNumberFromKey(null), null);
});

test("describeFromTitle extracts the action from a STEP_ID title", () => {
  assert.strictEqual(describeFromTitle("STEP_ID=plan-step-3 | click"), "click");
  assert.strictEqual(describeFromTitle("STEP_ID=plan-step-3"), "plan-step-3");
  assert.strictEqual(describeFromTitle(undefined, "fallback"), "fallback");
});

/* ─── G5.3 / defect D7: step keys must name their own test case ─── */

const {
  stepKeyForIndex,
  stepIdMarker,
  parseStepKey,
  findLocatorForStepKey,
  locatorKeyForIndex,
} = require("../dist/core/utils/stepKeys.js");

test("test case 0 keeps the historical key exactly (D7)", () => {
  // Every existing spec, DB baseline and codegen snapshot has to keep matching byte for byte — only the
  // previously AMBIGUOUS cases may change shape.
  assert.strictEqual(stepKeyForIndex(0), "plan-step-1");
  assert.strictEqual(stepKeyForIndex(6, 0), "plan-step-7");
  assert.strictEqual(stepIdMarker(2), "STEP_ID=plan-step-3");
});

test("a second test case no longer collides with the first (D7)", () => {
  // This was the whole defect: both test cases emitted `plan-step-1`, so self-heal, the reporter and
  // (since G4) the locator statistics all silently read test case 0's step.
  assert.notStrictEqual(stepKeyForIndex(0, 1), stepKeyForIndex(0, 0));
  assert.strictEqual(stepKeyForIndex(0, 1), "plan-tc1-step-1");
  assert.strictEqual(stepIdMarker(4, 2), "STEP_ID=plan-tc2-step-5");
});

test("parseStepKey round-trips both shapes (D7)", () => {
  for (const [tc, idx] of [[0, 0], [0, 9], [1, 0], [3, 12]]) {
    assert.deepStrictEqual(parseStepKey(stepKeyForIndex(idx, tc)), {
      testCaseIndex: tc,
      stepIndex: idx,
    });
  }
  assert.strictEqual(parseStepKey("not-a-key"), null);
  assert.strictEqual(parseStepKey(""), null);
});

test("a locator resolves to its own test case's step (D7)", () => {
  const locators = {
    [locatorKeyForIndex(0, 2)]: "page.getByTestId('a')",
    [locatorKeyForIndex(1, 2)]: "page.getByTestId('b')",
  };
  assert.strictEqual(findLocatorForStepKey(locators, "plan-step-3"), "page.getByTestId('a')");
  assert.strictEqual(findLocatorForStepKey(locators, "plan-tc1-step-3"), "page.getByTestId('b')");
  assert.strictEqual(findLocatorForStepKey(locators, "plan-step-99"), undefined);
});

test("the displayed step number is per test case (D7)", () => {
  const { stepNumberFromKey } = require("../dist/core/utils/describeStep.js");
  assert.strictEqual(stepNumberFromKey("plan-step-7"), 7);
  assert.strictEqual(stepNumberFromKey("plan-tc2-step-7"), 7, "numbering restarts in each test case");
  assert.strictEqual(stepNumberFromKey("nonsense"), null);
});
