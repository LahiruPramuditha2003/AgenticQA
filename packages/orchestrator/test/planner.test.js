"use strict";
/**
 * Planner-engine unit tests (offline).
 */

const { test } = require("node:test");
const assert = require("node:assert");


/* ─── G3.9: the deterministic fallback grounds on the START page, not the union ─── */

const { pageContextFor } = require("../dist/knowledge/RagPlannerEngine.js");

const HOME = {
  url: "http://localhost:5173/",
  inputs: [{ role: "textbox", name: "Search products..." }],
  buttons: [{ role: "button", name: "Search" }],
  headings: [{ role: "heading", name: "Welcome to TechStore" }],
  links: [], selects: [], checkboxes: [], radios: [],
};
const LOGIN = {
  url: "http://localhost:5173/auth/login",
  inputs: [{ role: "textbox", name: "Email" }, { role: "textbox", name: "Password" }],
  buttons: [{ role: "button", name: "Sign In" }],
  headings: [{ role: "heading", name: "Please Login" }],
  links: [], selects: [], checkboxes: [], radios: [],
};
const AGGREGATE = {
  url: "http://localhost:5173/, http://localhost:5173/auth/login",
  pages: [HOME, LOGIN],
  inputs: [...HOME.inputs, ...LOGIN.inputs],
  buttons: [...HOME.buttons, ...LOGIN.buttons],
  headings: [...HOME.headings, ...LOGIN.headings],
  links: [], selects: [], checkboxes: [], radios: [],
};

test("pageContextFor picks the page the plan is standing on (G3.9)", () => {
  // The aggregate is a UNION of every inspected page. Grounding a plan on it lets a generator fill a
  // field that exists somewhere in the app but not on the page it just navigated to — Playwright then
  // waits the full 30s action timeout for it. demo-web prompt 14 filled /auth/login's Email+Password
  // into a plan whose only goto was "/", and 2 x 30s x 5 browsers hit the executor's 300s cap.
  assert.deepStrictEqual(
    pageContextFor(AGGREGATE, "http://localhost:5173/").inputs.map((i) => i.name),
    ["Search products..."]
  );
  assert.deepStrictEqual(
    pageContextFor(AGGREGATE, "http://localhost:5173/auth/login").inputs.map((i) => i.name),
    ["Email", "Password"]
  );
});

test("pageContextFor tolerates path-only urls and trailing slashes (G3.9)", () => {
  assert.strictEqual(pageContextFor(AGGREGATE, "/auth/login/").url, LOGIN.url);
  assert.strictEqual(pageContextFor(AGGREGATE, "/").url, HOME.url);
});

test("pageContextFor falls back to the aggregate rather than to nothing (G3.9)", () => {
  // An unknown page must not strip the generator of every element — degrade to today's behaviour.
  assert.strictEqual(pageContextFor(AGGREGATE, "/nowhere").url, AGGREGATE.url);
  assert.strictEqual(pageContextFor(HOME, "/anything").url, HOME.url, "single-page context is returned as-is");
  assert.strictEqual(pageContextFor(undefined, "/"), undefined);
});

/* ─── G3.9: reasoning-model JSON extraction ─── */

const { extractJsonObjects, extractFirstJsonObject } = require("../dist/core/llm/json.js");

test("extractJsonObjects is string-aware (G3.9)", () => {
  // A brace inside a string literal must not affect nesting. Plans quote user-visible text constantly,
  // and demo-web's own knowledge pack contains `All Products - "TERM"`.
  const t = 'noise {"a":"a { b","c":{"d":1}} tail';
  assert.deepStrictEqual(extractJsonObjects(t), ['{"a":"a { b","c":{"d":1}}']);
  assert.deepStrictEqual(extractJsonObjects('{"a":"he said \\"{\\""}'), ['{"a":"he said \\"{\\""}']);
});

test("extractJsonObjects returns every candidate in order (G3.9)", () => {
  assert.deepStrictEqual(extractJsonObjects('a {"x":1} b {"y":2}'), ['{"x":1}', '{"y":2}']);
});

test("extractJsonObjects degrades on truncation instead of throwing (G3.9)", () => {
  assert.deepStrictEqual(extractJsonObjects('{"x":1} then {"unterminated": '), ['{"x":1}']);
  assert.deepStrictEqual(extractJsonObjects("no json here"), []);
  assert.throws(() => extractFirstJsonObject("no json here"), /No JSON object/);
});

test("a plan is recovered from a reasoning preamble (G3.9)", () => {
  // The real 2026-08-11 shape: prose, an inline example object, then the answer. The old
  // `indexOf("{")`…`lastIndexOf("}")` slice spanned from the example to the answer and never parsed —
  // demo-web prompt 14 lost a valid 5663-char response to it on every run.
  const { parseLLMOutputForTest } = require("../dist/knowledge/RagPlannerEngine.js");
  const raw = [
    'We need to output a JSON test plan for the user request: "add to cart".',
    'Each step looks like {"action": "goto", "url": "/"} so we will start there.',
    'Final answer:',
    '{"testCases":[{"title":"T","steps":[{"action":"goto","url":"/"}]}]}',
  ].join("\n");
  const p = parseLLMOutputForTest(raw);
  assert.ok(p, "the plan must be recovered");
  assert.strictEqual(p.testCases[0].steps[0].url, "/");
});

test("an empty testCases array is still a rejection (G3.9)", () => {
  const { parseLLMOutputForTest } = require("../dist/knowledge/RagPlannerEngine.js");
  assert.strictEqual(parseLLMOutputForTest('{"testCases":[]}'), null);
});
