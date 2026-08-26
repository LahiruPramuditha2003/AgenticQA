/**
 * Domain QA answer parsing — regressions from 2026-08-19, when every question failed with one of three
 * indistinguishable messages while retrieval had worked perfectly. All three causes are pinned here.
 */
const test = require("node:test");
const assert = require("node:assert");

const { DomainQaResponseSchema } = require("../dist/agents/DomainQaAgent/schema");
const { extractJsonObjects } = require("../dist/core/llm/json");

const base = {
  directAnswer: "A direct answer.",
  detailedExplanation: "A detailed explanation.",
  sources: [],
  confidence: "MEDIUM",
  confidenceReasoning: "Because the sources agree.",
};

test("prose fields accept an array and are joined (the observed live failure)", () => {
  // Live log: {"path":["detailedExplanation"],"message":"expected string, received array"}
  const r = DomainQaResponseSchema.safeParse({
    ...base,
    detailedExplanation: ["First paragraph.", "Second paragraph."],
  });
  assert.ok(r.success, "an array of paragraphs must not discard the whole answer");
  assert.equal(r.data.detailedExplanation, "First paragraph.\n\nSecond paragraph.");
});

test("directAnswer and confidenceReasoning tolerate the same drift", () => {
  const r = DomainQaResponseSchema.safeParse({
    ...base,
    directAnswer: ["One.", "Two."],
    confidenceReasoning: ["Sources agree.", "Coverage is good."],
  });
  assert.ok(r.success);
  assert.match(r.data.directAnswer, /One\./);
});

test("a genuinely empty prose field is still rejected", () => {
  assert.equal(DomainQaResponseSchema.safeParse({ ...base, detailedExplanation: [] }).success, false);
  assert.equal(DomainQaResponseSchema.safeParse({ ...base, detailedExplanation: "" }).success, false);
});

test("a long directAnswer is not rejected for style", () => {
  const r = DomainQaResponseSchema.safeParse({ ...base, directAnswer: "A".repeat(700) });
  assert.ok(r.success, "concision is a display concern, not a validation one");
});

test("a relative relatedTopics URL does not invalidate the answer", () => {
  const r = DomainQaResponseSchema.safeParse({
    ...base,
    relatedTopics: [{ title: "Docs", url: "/docs/intro" }],
  });
  assert.ok(r.success, "model-authored links must not be able to destroy a good answer");
});

test("JSON is recovered from a reply that reasons in prose around it", () => {
  const reply =
    'Thinking. An example looks like { "a": 1 }.\n\nAnswer:\n' + JSON.stringify(base);
  // The old greedy first-brace-to-last-brace slice produced invalid JSON here (defect D22).
  let greedyOk = true;
  try {
    JSON.parse(reply.match(/\{[\s\S]*\}/)[0]);
  } catch {
    greedyOk = false;
  }
  assert.equal(greedyOk, false, "precondition: the old regex really does fail on this shape");

  const candidates = extractJsonObjects(reply);
  assert.ok(candidates.length >= 2);
  const parsed = JSON.parse(candidates[candidates.length - 1]);
  assert.ok(DomainQaResponseSchema.safeParse(parsed).success, "last-first must find the real answer");
});
