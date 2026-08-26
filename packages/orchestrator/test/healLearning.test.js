/**
 * Self-heal learning + LLM reranking — regressions from 2026-08-20, when four consecutive healed runs
 * produced no visible evidence that history existed and LLM reranking failed every time.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { rankHealCandidates, wilsonLowerBound } = require("../dist/core/learn/priors");

const SRC = path.join(__dirname, "..", "src", "agents", "SelfHealAgent", "SelfHealAgent.ts");
const raw = fs.readFileSync(SRC, "utf8");
// Strip comments before pattern-checking: the fix's own explanation quotes the value it replaced
// ("was maxTokens: 20"), which would otherwise match and make this test assert against prose.
const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the LLM rerank budget fits a REASONING model", () => {
  // `selfheal` defaults to a reasoning model, which spends tokens thinking before emitting content.
  // At maxTokens: 20 the whole budget went to reasoning and the reply came back empty — observed four
  // times in a row on 2026-08-20 as "reranking failed (LLM returned empty content)".
  assert.ok(!/maxTokens:\s*20\b/.test(src), "maxTokens: 20 starves a reasoning model");
  const m = src.match(/temperature:\s*0\.2,\s*maxTokens:\s*(\d+)/);
  assert.ok(m, "the rerank call should still set an explicit budget");
  assert.ok(Number(m[1]) >= 256, `rerank budget ${m[1]} is too small for a reasoning model`);
});

test("the rerank parser takes the LAST number, so narration cannot hijack the choice", () => {
  // A reasoning model often narrates before answering: "Candidate 2 is close, but 3 matches — 3".
  const reply = "Candidate 2 is close, but 3 matches the role better. 3";
  const first = reply.match(/\d+/)[0];
  const numbers = reply.match(/\d+/g);
  const last = numbers[numbers.length - 1];
  assert.equal(first, "2", "precondition: first-number parsing really does pick the wrong candidate");
  assert.equal(last, "3");
  assert.ok(
    /numbers\[numbers\.length - 1\]/.test(src),
    "SelfHealAgent must parse the last number, not the first"
  );
});

test("history is reported whenever it exists, not only when it changes the order", () => {
  // The reorder-only log made a working learning loop indistinguishable from an absent one.
  assert.ok(/history AGREES/.test(src), "agreement must be logged — it is the common case");
  assert.ok(/history REORDERS/.test(src), "a reorder must still be logged");
  assert.ok(/history DEMOTES/.test(src), "known-bad candidates must be logged");
  assert.ok(/no heal history for/.test(src), "the empty-history case must say so explicitly");
});

test("rankHealCandidates promotes a proven repair and demotes one that never worked", () => {
  const candidates = [
    { locator: "nearest-but-unproven" },
    { locator: "tried-and-failed" },
    { locator: "proven" },
  ];
  const feedback = new Map([
    ["proven", { newLocator: "proven", attempts: 4, successes: 4 }],
    ["tried-and-failed", { newLocator: "tried-and-failed", attempts: 2, successes: 0 }],
  ]);
  const ordered = rankHealCandidates(candidates, feedback);
  assert.equal(ordered[0].locator, "proven", "a proven repair leads");
  assert.equal(ordered[2].locator, "tried-and-failed", "a repair that never worked goes last");
  assert.equal(ordered[1].locator, "nearest-but-unproven", "unproven keeps the middle — it is not bad");
});

test("empty history leaves the order byte-for-byte unchanged", () => {
  const candidates = [{ locator: "a" }, { locator: "b" }];
  assert.deepEqual(rankHealCandidates(candidates, new Map()), candidates);
});

test("4/4 successes is strong evidence, 1/1 is not (the demo's own numbers)", () => {
  assert.ok(wilsonLowerBound(4, 4) > wilsonLowerBound(1, 1));
  assert.ok(wilsonLowerBound(0, 2) === 0, "tried twice, never worked, scores zero");
});
