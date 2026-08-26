"use strict";
/**
 * GOLDEN GATE for generated Playwright code (R0.2).
 *
 * `test/scenarioPlanGolden.test.js` locks the *plans*. Nothing locked the **emitted TypeScript**, so a
 * codegen change could silently rewrite every spec in the suite and no offline test would notice — only
 * a live benchmark would, and a live diff is unattributable (it also exercises the page, the grounding
 * pass and, for unmatched prompts, an LLM).
 *
 * This matters right now because R1.2 deliberately changes codegen for three confirmed defects:
 *   D39 — `expectCount` atLeast/atMost emitted exact equality,
 *   D40 — `check`/`uncheck` could bind to the wrong checkbox and still pass,
 *   D41 — startsWith/endsWith interpolated raw text into a JS string literal (a syntax error).
 * This fixture is what proves those fixes touch only the specs that use those actions.
 *
 * WHEN THIS FAILS: a generated spec changed. That is not automatically wrong — but it must be a
 * decision, not a surprise. Inspect the diff, confirm every change is intended, then regenerate:
 *
 *     node scripts/snapshotCodegen.js --out=test/fixtures/codegen.demo-web.json
 *
 * and say in the commit message which prompts changed and why.
 *
 * The snapshot is built by the *same* function the script uses (`buildCodegenSnapshot`) on purpose: two
 * implementations of "how the fixture is produced" would be a fixture that only tests itself.
 *
 * Requires a build (imports from dist/).
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { buildCodegenSnapshot } = require("../scripts/snapshotCodegen");
const { repoRootFromHere } = require("../scripts/extractTemplatePrompts");

const GOLDEN = path.join(__dirname, "fixtures", "codegen.demo-web.json");
const repoRoot = repoRootFromHere();

test("generated Playwright code for demo-web matches the golden fixture", () => {
  const golden = JSON.parse(fs.readFileSync(GOLDEN, "utf8"));
  const actual = buildCodegenSnapshot(
    path.join(repoRoot, "apps", "demo-web"),
    path.join(repoRoot, "benchmarks/TEST_TEMPLATES.md"),
    repoRoot
  );

  assert.strictEqual(actual.packLoaded, true, "the demo-web pack must load — see defect D38");
  assert.strictEqual(
    Object.keys(actual.specs).length,
    Object.keys(golden.specs).length,
    "the template file gained or lost prompts — regenerate the fixture"
  );

  // Compare per prompt rather than as one blob: a whole-object diff on 66 KB of generated code names
  // no prompt, and "something changed somewhere" is the least useful failure a golden gate can give.
  const changed = [];
  for (const key of Object.keys(golden.specs)) {
    if (actual.specs[key] !== golden.specs[key]) {
      changed.push(key);
    }
  }

  assert.deepStrictEqual(
    changed,
    [],
    `generated code changed for prompt(s) ${changed.join(", ")}. ` +
      `Inspect the diff, then regenerate with:\n` +
      `  node scripts/snapshotCodegen.js --out=test/fixtures/codegen.demo-web.json`
  );
});

test("the fixture covers every deterministic plan, and only those", () => {
  const golden = JSON.parse(fs.readFileSync(GOLDEN, "utf8"));
  const plans = JSON.parse(
    fs.readFileSync(path.join(__dirname, "fixtures", "scenarioPlans.demo-web.json"), "utf8")
  );

  // Codegen coverage must track planner coverage exactly. If a prompt starts producing a plan (or
  // stops), that is a planner change worth failing on here too — it is the moment a benchmark prompt
  // silently becomes, or stops being, model-dependent.
  const plannedKeys = Object.keys(plans.plans).filter((k) => plans.plans[k]);
  const emittedKeys = Object.keys(golden.specs).filter((k) => golden.specs[k]);

  assert.deepStrictEqual(
    emittedKeys.sort(),
    plannedKeys.sort(),
    "the set of prompts producing generated code diverged from the set producing a deterministic plan"
  );
  assert.strictEqual(emittedKeys.length, 48, "demo-web produces 48 deterministic specs");
});

test("no generated spec contains an unbalanced string literal (D41 guard)", () => {
  const golden = JSON.parse(fs.readFileSync(GOLDEN, "utf8"));

  // D41 emits `new RegExp("^He said "hi"")` — valid-looking text that is a syntax error, and it kills
  // every test in the file rather than just its own step. Parsing each spec is the only check that
  // actually catches it; a regex over the source would not.
  for (const [key, code] of Object.entries(golden.specs)) {
    if (!code) {
      continue;
    }
    // Strip the ESM import (Function() cannot host it) and parse the remainder for syntax only.
    const body = code.replace(/^import .*$/m, "");
    assert.doesNotThrow(
      () => new Function(`const test=()=>{},expect=()=>{};${body}`),
      `prompt ${key} generated a spec that is not syntactically valid JavaScript`
    );
  }
});
