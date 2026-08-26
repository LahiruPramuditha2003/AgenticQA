"use strict";
/**
 * G4 — the reading half of "learning from run history".
 *
 * These are the judgements the engine makes from stored outcomes, locked offline. The invariant that
 * matters most is at the bottom: **no history means no opinion**, so a database with nothing in it must
 * leave every decision exactly where G3 left it.
 */

const { test } = require("node:test");
const assert = require("node:assert");

const {
  wilsonLowerBound,
  preferReliableLocator,
  rankHealCandidates,
  detectFlakiness,
  flowPrior,
  MIN_EVIDENCE,
} = require("../dist/core/learn/priors.js");

/* ─── the score ─── */

test("Wilson does not let one lucky run beat a long track record (G4)", () => {
  // The whole reason not to use passes/attempts: a raw rate calls 1/1 a perfect locator.
  const lucky = wilsonLowerBound(1, 1);
  const proven = wilsonLowerBound(47, 50);
  assert.ok(lucky < 0.3, `1/1 should be weak evidence, got ${lucky.toFixed(3)}`);
  assert.ok(proven > 0.8, `47/50 should be strong, got ${proven.toFixed(3)}`);
  assert.ok(proven > lucky);
});

test("Wilson grows with evidence at a fixed rate (G4)", () => {
  assert.ok(wilsonLowerBound(10, 10) > wilsonLowerBound(3, 3));
  assert.ok(wilsonLowerBound(100, 100) > wilsonLowerBound(10, 10));
  assert.strictEqual(wilsonLowerBound(0, 0), 0, "no attempts is not a score");
  assert.strictEqual(wilsonLowerBound(0, 5), 0, "never passed is the floor");
});

/* ─── locator reliability ─── */

const track = (locator, passes, attempts) => [locator, { locator, passes, attempts }];

test("with no history the resolver's choice stands (G4)", () => {
  // The parity invariant: an empty database must not change a single decision.
  assert.strictEqual(preferReliableLocator(["a", "b"], new Map()), null);
});

test("an unproven candidate is never demoted for being new (G4)", () => {
  // "b" looks great but has one attempt; "a" is unknown. Unproven is not bad.
  const stats = new Map([track("b", 1, 1)]);
  assert.strictEqual(preferReliableLocator(["a", "b"], stats), null);
});

test("a proven locator overtakes an unproven first choice (G4)", () => {
  const stats = new Map([track("b", 20, 20)]);
  assert.strictEqual(preferReliableLocator(["a", "b"], stats), "b");
});

test("a proven incumbent is only displaced by a clearly better record (G4)", () => {
  const close = new Map([track("a", 9, 10), track("b", 10, 11)]);
  assert.strictEqual(preferReliableLocator(["a", "b"], close), null, "a near-tie is not evidence");

  const decisive = new Map([track("a", 3, 10), track("b", 20, 20)]);
  assert.strictEqual(preferReliableLocator(["a", "b"], decisive), "b");
});

test("the resolver's own pick is never 'promoted' over itself (G4)", () => {
  const stats = new Map([track("a", 20, 20), track("b", 1, 10)]);
  assert.strictEqual(preferReliableLocator(["a", "b"], stats), null);
});

test("evidence below the floor is ignored (G4)", () => {
  const thin = new Map([track("b", 2, 2)]);
  assert.strictEqual(preferReliableLocator(["a", "b"], thin), null);
  assert.ok(MIN_EVIDENCE >= 3);
});

/* ─── heal feedback ─── */

test("a replacement that previously healed this step goes first (G4)", () => {
  const cands = [{ locator: "x" }, { locator: "y" }, { locator: "z" }];
  const fb = new Map([
    ["y", { newLocator: "y", attempts: 2, successes: 2 }],
    ["x", { newLocator: "x", attempts: 3, successes: 0 }],
  ]);
  // y worked before -> first; z is unproven -> middle; x was tried and never worked -> last.
  assert.deepStrictEqual(rankHealCandidates(cands, fb).map((c) => c.locator), ["y", "z", "x"]);
});

test("heal ranking is stable and no-ops without feedback (G4)", () => {
  const cands = [{ locator: "x" }, { locator: "y" }];
  assert.deepStrictEqual(rankHealCandidates(cands, new Map()), cands);
  // Equal ranks must keep the caller's order — it encodes similarity this function cannot see.
  const fb = new Map([["x", { newLocator: "x", attempts: 0, successes: 0 }]]);
  assert.deepStrictEqual(rankHealCandidates(cands, fb).map((c) => c.locator), ["x", "y"]);
});

/* ─── flakiness ─── */

test("a fixed test is not flaky (G4)", () => {
  // newest-first: fail,fail,fail then pass,pass. One transition = it got fixed. Calling that flaky
  // trains the reader to ignore the badge.
  assert.strictEqual(detectFlakiness([true, true, false, false, false]), false);
});

test("alternating outcomes are flaky (G4)", () => {
  assert.strictEqual(detectFlakiness([true, false, true, false]), true);
  assert.strictEqual(detectFlakiness([false, true, true, false, true]), true);
});

test("consistent outcomes and thin history are never flaky (G4)", () => {
  assert.strictEqual(detectFlakiness([true, true, true, true]), false);
  assert.strictEqual(detectFlakiness([false, false, false, false]), false);
  assert.strictEqual(detectFlakiness([true, false, true]), false, "too few runs to judge");
  assert.strictEqual(detectFlakiness([]), false);
});

/* ─── flow priors ─── */

test("a flow prior is exactly neutral without evidence (G4)", () => {
  assert.strictEqual(flowPrior(undefined), 1);
  assert.strictEqual(flowPrior({ flowKey: "f", attempts: 2, passes: 2 }), 1, "below the floor");
});

test("a flow prior stays inside a narrow band (G4)", () => {
  // Retrieval relevance is the primary signal; history is a tie-breaker. A flow that is textually the
  // obvious answer must not be displaced because it once failed for an unrelated reason.
  const good = flowPrior({ flowKey: "f", attempts: 20, passes: 20 });
  const bad = flowPrior({ flowKey: "f", attempts: 20, passes: 0 });
  assert.ok(good > 1 && good <= 1.15, `good=${good}`);
  assert.ok(bad >= 0.85 && bad < 1, `bad=${bad}`);
});
