"use strict";
/**
 * G4.6 — the parity proof.
 *
 * G4 is strictly additive: with no run history (a fresh database, or no database at all) every decision
 * must land exactly where G3 left it. This file is the lock on that promise, because the failure mode is
 * silent — a prior that quietly shifts a ranking would show up as an unexplained benchmark drift weeks
 * later, and the golden fixture alone would not say why.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { buildFlowIndex, rankFlows } = require("../dist/core/knowledge/FlowIndex.js");
const { buildScenarioPlan } = require("../dist/agents/TestPlannerAgent/ScenarioPlanner.js");
const { rankHealCandidates, preferReliableLocator, detectFlakiness } =
  require("../dist/core/learn/priors.js");
const { extractTemplatePrompts, repoRootFromHere } = require("../scripts/extractTemplatePrompts.js");

const root = repoRootFromHere();
const pack = JSON.parse(
  fs.readFileSync(path.join(root, "apps/demo-web/.agenticqa/knowledge.json"), "utf8")
);

test("empty history changes no retrieval result (G4.6)", () => {
  const index = buildFlowIndex(pack.goldenFlows);
  const prompts = extractTemplatePrompts(path.join(root, "benchmarks/TEST_TEMPLATES.md"));
  for (const p of prompts) {
    const before = rankFlows(index, p.prompt);
    for (const empty of [undefined, new Map()]) {
      const after = rankFlows(index, p.prompt, { flowStats: empty });
      assert.strictEqual(after.hit?.key ?? null, before.hit?.key ?? null, `prompt ${p.index}: hit moved`);
      assert.strictEqual(after.abstained, before.abstained, `prompt ${p.index}: abstain changed`);
      assert.deepStrictEqual(
        after.candidates.map((c) => c.key),
        before.candidates.map((c) => c.key),
        `prompt ${p.index}: candidate order moved`
      );
    }
  }
});

test("empty history changes no deterministic plan (G4.6)", () => {
  // The same guarantee at the level the golden fixture measures.
  const fixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, "fixtures/scenarioPlans.demo-web.json"), "utf8")
  );
  const prompts = extractTemplatePrompts(path.join(root, "benchmarks/TEST_TEMPLATES.md"));
  for (const p of prompts) {
    const plan = buildScenarioPlan(p.prompt, pack);
    const expected = fixture.plans[String(p.index)] ?? null;
    assert.deepStrictEqual(plan, expected, `prompt ${p.index} drifted with G4 wired in`);
  }
});

test("a history prior only ever nudges — it cannot invent or veto a hit (G4.6)", () => {
  const index = buildFlowIndex(pack.goldenFlows);
  const prompts = extractTemplatePrompts(path.join(root, "benchmarks/TEST_TEMPLATES.md")).slice(0, 8);
  for (const p of prompts) {
    const before = rankFlows(index, p.prompt);
    // Punish every flow as hard as the prior allows.
    const harsh = new Map(
      before.candidates.map((c) => [c.key, { flowKey: c.key, attempts: 50, passes: 0 }])
    );
    const after = rankFlows(index, p.prompt, { flowStats: harsh });
    assert.strictEqual(
      after.abstained,
      before.abstained,
      `prompt ${p.index}: history must never turn a hit into an abstain`
    );
    if (before.hit) {assert.ok(after.hit, `prompt ${p.index}: history must never remove a hit`);}
  }
});

test("every G4 read is a no-op on empty evidence (G4.6)", () => {
  assert.strictEqual(preferReliableLocator(["a", "b"], new Map()), null);
  const cands = [{ locator: "x" }, { locator: "y" }];
  assert.deepStrictEqual(rankHealCandidates(cands, new Map()), cands);
  assert.strictEqual(detectFlakiness([]), false);
});
