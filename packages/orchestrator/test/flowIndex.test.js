"use strict";
/**
 * Offline unit tests for lexical flow retrieval (G2.2).
 *
 * These lock the *mechanics*. The quality measurement lives in `scripts/evalFlowIndex.js`, which scores
 * retrieval against hand-labelled expectations over demo-web's real pack and real benchmark prompts
 * (currently hit@1 17/19, hit@3 19/19, MRR 0.947).
 *
 * Several cases below are regression guards for BM25 details that were wrong in the first draft and that
 * silently cost accuracy — they are cheap to break again by "simplifying" the scorer.
 *
 * Requires a build (imports from dist/).
 */

const { test } = require("node:test");
const assert = require("node:assert");

const {
  tokenize,
  buildFlowDocument,
  buildFlowIndex,
  rankFlowsLexical,
  fuseRankings,
} = require("../dist/core/knowledge/FlowIndex.js");

const flow = (description, steps, extra = {}) => ({ description, steps, ...extra });

/* ─── tokenization ─── */

test("tokenize splits on punctuation so keys and paths become words", () => {
  assert.deepStrictEqual(tokenize("customer-login"), ["customer", "login"]);
  assert.deepStrictEqual(tokenize("/auth/login"), ["auth", "login"]);
  assert.deepStrictEqual(tokenize("Add to Cart"), ["add", "cart"]); // "to" is a stopword
});

test("tokenize drops filler that appears in every prompt", () => {
  // With ~15 documents, IDF is too coarse to suppress these on its own.
  for (const filler of ["verify", "check", "test", "displays", "should"]) {
    assert.deepStrictEqual(tokenize(filler), [], `"${filler}" should be a stopword`);
  }
});

test("REGRESSION GUARD: generic motion verbs are stopwords", () => {
  // "Navigate to the home page" is about *home*, not navigating. Leaving these in let a flow literally
  // named `navigate` outrank `home` on demo-web prompt 1.
  for (const verb of ["navigate", "go", "open", "visit", "browse"]) {
    assert.deepStrictEqual(tokenize(verb), [], `"${verb}" should be a stopword`);
  }
  assert.deepStrictEqual(tokenize("Navigate to the home page"), ["home", "page"]);
});

test("stemming collapses plurals consistently on both sides", () => {
  assert.deepStrictEqual(tokenize("products"), tokenize("product"));
  assert.deepStrictEqual(tokenize("categories"), tokenize("category"));
  assert.deepStrictEqual(tokenize("address"), ["address"], "does not strip -ss");
});

/* ─── document building ─── */

test("buildFlowDocument pulls names, values and route paths out of steps", () => {
  const doc = buildFlowDocument(
    "cart",
    flow("Add product to cart", [
      { action: "goto", url: "http://localhost:5173/products" },
      { action: "waitForLoad" },
      { action: "click", target: "Add to Cart" },
      { action: "expectVisible", target: "Order Summary" },
    ])
  );
  for (const t of ["cart", "product", "order", "summary"]) {
    assert.ok(doc.tokens.includes(t), `expected token "${t}" in ${doc.tokens.join(" ")}`);
  }
  assert.ok(!doc.text.includes("localhost"), "host is noise — only the path is indexed");
  assert.ok(!doc.tokens.includes("waitforload"), "timing steps carry no intent");
});

test("REGRESSION GUARD: fields are weighted, key highest", () => {
  const doc = buildFlowDocument("login", flow("something else entirely", []));
  const count = (t) => doc.tokens.filter((x) => x === t).length;
  assert.strictEqual(count("login"), 3, "key is weighted ×3");

  const tagged = buildFlowDocument("x", flow("d", [], { tags: ["signin"] }));
  assert.strictEqual(tagged.tokens.filter((t) => t === "signin").length, 2, "tags weighted ×2");
});

test("a flow with no tags/routeKey still indexes (backward compat)", () => {
  const doc = buildFlowDocument("password-reset", flow("Request a password reset", []));
  assert.ok(doc.tokens.includes("password") && doc.tokens.includes("reset"));
});

/* ─── ranking ─── */

const FLOWS = {
  "customer-login": flow("Customer login and account dashboard verification", [
    { action: "fill", field: "Email" },
    { action: "fill", field: "Password" },
    { action: "click", target: "Sign In" },
    { action: "expectVisible", target: "Total Orders" },
  ]),
  cart: flow("Add product to shopping cart and view cart page", [
    { action: "click", target: "Add to Cart" },
    { action: "expectVisible", target: "Order Summary" },
  ]),
  search: flow("Search for a product", [
    { action: "fill", field: "Search products..." },
    { action: "click", target: "Search" },
  ]),
};

test("ranks the obviously-matching flow first", () => {
  const idx = buildFlowIndex(FLOWS);
  assert.strictEqual(rankFlowsLexical(idx, "search for a laptop")[0].key, "search");
  assert.strictEqual(rankFlowsLexical(idx, "log in as a customer")[0].key, "customer-login");
  assert.strictEqual(rankFlowsLexical(idx, "add an item to the shopping cart")[0].key, "cart");
});

test("REGRESSION GUARD: query term frequency counts", () => {
  // Treating the query as a SET (the classic short-query simplification) is wrong for whole-prompt
  // queries, where repetition is intent: this is what let `product-detail` outrank `cart` on a prompt
  // saying "cart" twice.
  const idx = buildFlowIndex(FLOWS);
  const once = rankFlowsLexical(idx, "product cart")[0];
  const twice = rankFlowsLexical(idx, "product cart cart cart");
  assert.strictEqual(twice[0].key, "cart", "repeating a term must raise its flow");
  assert.ok(
    twice.find((h) => h.key === "cart").score > once.score || once.key === "cart",
    "repetition must change the score"
  );
});

test("returns hits sorted, capped, and only for non-zero overlap", () => {
  const idx = buildFlowIndex(FLOWS);
  const hits = rankFlowsLexical(idx, "cart", 2);
  assert.ok(hits.length <= 2);
  for (let i = 1; i < hits.length; i++) {assert.ok(hits[i - 1].score >= hits[i].score);}
  assert.deepStrictEqual(rankFlowsLexical(idx, "zzzz nonexistent"), [], "no overlap ⇒ no hits");
});

test("degenerate inputs are safe", () => {
  assert.deepStrictEqual(rankFlowsLexical(buildFlowIndex(null), "anything"), []);
  assert.deepStrictEqual(rankFlowsLexical(buildFlowIndex({}), "anything"), []);
  assert.deepStrictEqual(rankFlowsLexical(buildFlowIndex(FLOWS), ""), []);
  assert.deepStrictEqual(rankFlowsLexical(buildFlowIndex(FLOWS), "the and of"), [], "all-stopword query");
});

test("ranking is deterministic — ties broken by key", () => {
  const twins = { "b-flow": flow("same words", []), "a-flow": flow("same words", []) };
  const idx = buildFlowIndex(twins);
  const first = rankFlowsLexical(idx, "same words").map((h) => h.key);
  const second = rankFlowsLexical(idx, "same words").map((h) => h.key);
  assert.deepStrictEqual(first, second);
  if (first.length === 2) {assert.deepStrictEqual(first, ["a-flow", "b-flow"]);}
});

test("hits carry the flow itself, so the caller needs no second lookup", () => {
  const hit = rankFlowsLexical(buildFlowIndex(FLOWS), "search for a product")[0];
  assert.strictEqual(hit.flow.description, "Search for a product");
});

/* ─── rank fusion (used by G2.3) ─── */

test("fuseRankings combines rankings by reciprocal rank", () => {
  const lexical = [{ key: "a" }, { key: "b" }, { key: "c" }];
  const semantic = [{ key: "b" }, { key: "a" }, { key: "d" }];
  const fused = fuseRankings([lexical, semantic]);
  // a and b are each top-2 in both lists, so they must outrank the singletons.
  assert.deepStrictEqual(fused.slice(0, 2).map((f) => f.key).sort(), ["a", "b"]);
  assert.ok(fused.find((f) => f.key === "d").score < fused[0].score);
});

test("fuseRankings tolerates an empty ranking (e.g. embeddings unavailable)", () => {
  const fused = fuseRankings([[{ key: "a" }, { key: "b" }], []]);
  assert.deepStrictEqual(fused.map((f) => f.key), ["a", "b"]);
  assert.deepStrictEqual(fuseRankings([[], []]), []);
});
