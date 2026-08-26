"use strict";
/**
 * G3.11 — interaction-aware flow retrieval.
 *
 * Two things are locked here: that the planner and the substance auditor read a prompt IDENTICALLY, and
 * that the promotion rule stays as narrow as it was measured to be.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const {
  requestedInteractions,
  interactionCoverage,
} = require("../dist/core/knowledge/requestedInteractions.js");
const { applyInteractionCoverage } = require("../dist/core/knowledge/FlowIndex.js");
const { expectedInteractions } = require("../scripts/auditSpecSubstance.js");
const { extractTemplatePrompts, repoRootFromHere } = require("../scripts/extractTemplatePrompts.js");

/* ─── the metric and the engine must read a prompt the same way ─── */

test("planner and substance auditor agree on every benchmark prompt (G3.11)", () => {
  // ⚠️ These are two INDEPENDENT implementations of the same rule, and that is deliberate: sharing one
  // function would make a mistake in it invisible to both the engine and the measurement at once. This
  // test is what makes the duplication safe. If it fails, decide which reading is right — do not simply
  // copy one into the other.
  const root = repoRootFromHere();
  const files = ["benchmarks/TEST_TEMPLATES.md", "benchmarks/TEST_TEMPLATES_TASKFLOW.md"];
  let checked = 0;
  for (const f of files) {
    for (const p of extractTemplatePrompts(path.join(root, f))) {
      assert.deepStrictEqual(
        requestedInteractions(p.prompt),
        expectedInteractions(p.prompt),
        `${f} prompt ${p.index}: engine and auditor disagree about what is being asked`
      );
      checked++;
    }
  }
  assert.ok(checked >= 40, `expected the real benchmark prompts, got ${checked}`);
});

test("requestedInteractions reads the verb, not the domain (G3.11)", () => {
  assert.deepStrictEqual(requestedInteractions("enter your email and click Sign in"), ["fill", "click"]);
  assert.deepStrictEqual(requestedInteractions("set the Status dropdown to Paused"), ["select"]);
  assert.deepStrictEqual(requestedInteractions("tick the Bug checkbox"), ["check"]);
  assert.deepStrictEqual(requestedInteractions("verify the dashboard shows three tiles"), []);
  // "select" alone routinely means "click a menu item" — it must not demand a <select>.
  assert.deepStrictEqual(requestedInteractions("click the user menu and select Logout"), ["click"]);
});

test("interactionCoverage never penalises a look-only prompt (G3.11)", () => {
  assert.strictEqual(interactionCoverage([{ action: "goto" }], []), 1);
  assert.strictEqual(interactionCoverage([{ action: "fill" }, { action: "click" }], ["fill", "click"]), 1);
  assert.strictEqual(interactionCoverage([{ action: "fill" }], ["fill", "click"]), 0.5);
  assert.strictEqual(interactionCoverage([{ action: "uncheck" }], ["check"]), 1, "uncheck satisfies check");
});

/* ─── the promotion rule ─── */

const hit = (key, score, steps) => ({ key, score, flow: { steps } });
const SMOKE_LOGIN = hit("smoke-login", 8.0, [
  { action: "goto", url: "/login" },
  { action: "waitForLoad" },
  { action: "expectVisible", target: "Sign in to TaskFlow" },
]);
const LOGIN_ADMIN = hit("loginAdmin", 6.57, [
  { action: "goto", url: "/login" },
  { action: "fill", field: "Email", value: "a@b.c" },
  { action: "fill", field: "Password", value: "x" },
  { action: "click", target: "Sign in" },
]);

test("a do-nothing flow yields to one that can act on the same page (G3.11)", () => {
  // TaskFlow prompt 18. Every word is about signing in, so text ranking cannot separate a page-load check
  // from a real sign-in; only the steps can.
  const out = applyInteractionCoverage(
    [SMOKE_LOGIN, LOGIN_ADMIN],
    "Go to the sign in page, enter ada@taskflow.test and Taskflow123!, click Sign in"
  );
  assert.strictEqual(out[0].key, "loginAdmin");
});

test("promotion never crosses to another page (G3.11)", () => {
  // Measured on the generated-pack eval: without this, "filter the Projects list by name" was answered by
  // a /tasks/new form flow purely because it contains a `fill`. Retrieval fell 15/20 -> 12/20 hit@1.
  const smokeProjects = hit("smoke-projects", 5.0, [
    { action: "goto", url: "/projects" },
    { action: "expectVisible", target: "Projects" },
  ]);
  const formNew = hit("form-new", 4.8, [
    { action: "goto", url: "/tasks/new" },
    { action: "fill", field: "Task title", value: "x" },
  ]);
  const out = applyInteractionCoverage([smokeProjects, formNew], "type Apollo into the filter");
  assert.strictEqual(out[0].key, "smoke-projects");
});

test("a flow that DOES act is never second-guessed (G3.11)", () => {
  // TaskFlow prompt 7 asks to click "Apollo Redesign"; a nav flow clicks the "Projects" nav link.
  // Structurally a click, substantively the wrong one — promoting it would satisfy the substance audit
  // while testing something the prompt never asked for. This rule is not competent to make that call.
  const viewProjects = hit("viewProjects", 9.06, [
    { action: "goto", url: "/projects" },
    { action: "fill", field: "Filter", value: "x" },
    { action: "expectVisible", target: "Projects" },
  ]);
  const navProjects = hit("nav-projects", 6.03, [
    { action: "goto", url: "/projects" },
    { action: "click", target: "Projects" },
  ]);
  const out = applyInteractionCoverage([viewProjects, navProjects], "click Apollo Redesign");
  assert.strictEqual(out[0].key, "viewProjects", "a flow that interacts keeps its place");
});

test("with no capable candidate the order stands (G3.11)", () => {
  // Promotion only, never rejection: a partial test beats no test.
  const a = hit("smoke-a", 5, [{ action: "goto", url: "/a" }]);
  const b = hit("smoke-b", 4, [{ action: "goto", url: "/a" }]);
  assert.strictEqual(applyInteractionCoverage([a, b], "click Save")[0].key, "smoke-a");
});
