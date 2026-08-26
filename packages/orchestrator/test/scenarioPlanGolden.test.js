"use strict";
/**
 * GOLDEN GATE for deterministic planning (G2.4).
 *
 * `buildScenarioPlan` is a pure function of (request, pack), so its output over demo-web's whole
 * template file is an exact, offline fingerprint of the deterministic planner. This test locks that
 * fingerprint. It exists because G2.4 replaced the planner's internals wholesale — a regex ladder over
 * hardcoded flow keys became retrieval — and the acceptance bar was that demo-web's verified plans must
 * not drift as a side effect. A live benchmark cannot prove that: it also exercises the live page, the
 * grounding pass and (for unmatched prompts) an LLM, so a difference there is unattributable.
 *
 * WHEN THIS FAILS: it is telling you a deterministic plan changed. That is not automatically wrong —
 * but it must be a decision, not a surprise. Inspect the diff, confirm every change is intended, then
 * regenerate:
 *
 *     node scripts/snapshotScenarioPlans.js --out=test/fixtures/scenarioPlans.demo-web.json
 *
 * and say in the commit message which prompts changed and why.
 *
 * Requires a build (imports from dist/).
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { buildScenarioPlan } = require("../dist/agents/TestPlannerAgent/ScenarioPlanner.js");
const { extractTemplatePrompts, repoRootFromHere } = require("../scripts/extractTemplatePrompts");

const GOLDEN = path.join(__dirname, "fixtures", "scenarioPlans.demo-web.json");
const repoRoot = repoRootFromHere();

test("deterministic plans for demo-web match the golden fixture", () => {
  const golden = JSON.parse(fs.readFileSync(GOLDEN, "utf8"));
  const pack = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "apps", "demo-web", ".agenticqa", "knowledge.json"), "utf8")
  );
  const prompts = extractTemplatePrompts(path.join(repoRoot, "benchmarks/TEST_TEMPLATES.md"));

  assert.strictEqual(golden.packLoaded, true, "fixture was captured with the pack loaded");
  assert.strictEqual(
    prompts.length,
    Object.keys(golden.plans).length,
    "the template file gained or lost prompts — regenerate the fixture"
  );

  const drifted = [];
  for (const p of prompts) {
    const actual = buildScenarioPlan(p.prompt, pack);
    const expected = golden.plans[String(p.index)] ?? null;
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      drifted.push(p.index);
    }
  }
  assert.deepStrictEqual(drifted, [], `deterministic plans drifted for prompt(s) ${drifted.join(", ")}`);
});

test("the benchmark prompts all still resolve deterministically (no silent LLM fallback)", () => {
  // Prompts 1-20 are the accuracy benchmark. If one stops matching, the run quietly becomes
  // model-dependent — the exact fragility deterministic-first exists to avoid. #14 is the one
  // deliberate abstain: it spans two auth states, which no single golden flow can express.
  const golden = JSON.parse(fs.readFileSync(GOLDEN, "utf8"));
  const abstained = [];
  for (let i = 1; i <= 20; i++) {
    if (!golden.plans[String(i)]) {abstained.push(i);}
  }
  assert.deepStrictEqual(abstained, [14], "only prompt 14 may fall through to the LLM path");
});
