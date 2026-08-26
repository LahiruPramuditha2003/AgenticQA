"use strict";
/**
 * Offline unit tests for semantic + hybrid flow retrieval and the abstain policy (G2.3).
 *
 * Everything here runs with a DETERMINISTIC FAKE embedder — no network, no key, no quota. That is the
 * point of splitting `FlowEmbeddings.ts` (async/IO) from `FlowIndex.ts` (pure): the whole retrieval
 * decision path can be tested without an LLM.
 *
 * Requires a build (imports from dist/).
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildFlowIndex,
  rankFlows,
  rankFlowsSemantic,
  cosineSimilarity,
  isMultiStateRequest,
  keyCoverage,
  tokenize,
} = require("../dist/core/knowledge/FlowIndex.js");
const {
  embedFlowIndex,
  embedQuery,
  flowIndexHash,
  fileFlowVectorCache,
} = require("../dist/core/knowledge/FlowEmbeddings.js");

const flow = (description, steps = [], extra = {}) => ({ description, steps, ...extra });

const FLOWS = {
  "customer-login": flow("Customer login and account dashboard verification", [
    { action: "fill", field: "Email" },
    { action: "click", target: "Sign In" },
  ]),
  cart: flow("Add product to shopping cart and view cart page", [
    { action: "click", target: "Add to Cart" },
  ]),
  search: flow("Search for a product", [{ action: "fill", field: "Search products..." }]),
};

/**
 * Deterministic bag-of-words embedder: each token is hashed into a fixed-width vector. Texts sharing
 * vocabulary get genuinely similar vectors, so cosine behaves realistically — but it is reproducible and
 * needs no service.
 */
const DIMS = 64;
function fakeEmbedder(opts = {}) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    isConfigured: () => opts.configured !== false,
    async embedOne(text) {
      calls++;
      if (opts.fail) {throw new Error("embedding service exploded");}
      const v = new Array(DIMS).fill(0);
      for (const t of tokenize(text)) {
        let h = 0;
        for (let i = 0; i < t.length; i++) {h = (h * 31 + t.charCodeAt(i)) >>> 0;}
        v[h % DIMS] += 1;
      }
      return v;
    },
  };
}

/* ─── cosine + semantic ranking ─── */

test("cosineSimilarity behaves", () => {
  assert.strictEqual(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.strictEqual(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.strictEqual(cosineSimilarity([0, 0], [1, 1]), 0, "zero vector ⇒ 0, not NaN");
  assert.ok(cosineSimilarity([1, 1], [2, 2]) > 0.99, "scale-invariant");
});

test("rankFlowsSemantic ranks by cosine and is deterministic", async () => {
  const index = buildFlowIndex(FLOWS);
  const emb = fakeEmbedder();
  const vectors = await embedFlowIndex(index, emb);
  const qv = await embedQuery("search for a product", emb);

  const hits = rankFlowsSemantic(index, vectors, qv, 3);
  assert.strictEqual(hits[0].key, "search");
  assert.deepStrictEqual(
    rankFlowsSemantic(index, vectors, qv, 3).map((h) => h.key),
    hits.map((h) => h.key)
  );
});

test("rankFlowsSemantic degrades safely with no vectors or no query vector", () => {
  const index = buildFlowIndex(FLOWS);
  assert.deepStrictEqual(rankFlowsSemantic(index, new Map(), [1, 2, 3]), []);
  assert.deepStrictEqual(rankFlowsSemantic(index, new Map([["cart", [1]]]), []), []);
});

/* ─── hybrid ─── */

test("rankFlows reports lexical-only when no vectors are supplied", () => {
  const r = rankFlows(buildFlowIndex(FLOWS), "add to the shopping cart");
  assert.strictEqual(r.via, "lexical");
  assert.strictEqual(r.hit.key, "cart");
  assert.strictEqual(r.abstained, false);
});

test("rankFlows fuses lexical + semantic when vectors are supplied", async () => {
  const index = buildFlowIndex(FLOWS);
  const emb = fakeEmbedder();
  const vectors = await embedFlowIndex(index, emb);
  const queryVector = await embedQuery("log in as a customer", emb);

  const r = rankFlows(index, "log in as a customer", { vectors, queryVector });
  assert.strictEqual(r.via, "hybrid");
  assert.strictEqual(r.hit.key, "customer-login");
  assert.ok(r.candidates.length > 0);
});

/* ─── abstain policy ─── */

test("ABSTAIN: nothing overlaps the request", () => {
  const r = rankFlows(buildFlowIndex(FLOWS), "deploy the kubernetes cluster to production");
  assert.strictEqual(r.abstained, true);
  assert.strictEqual(r.hit, null);
  assert.match(r.reason, /no golden flow shares any term/);
});

test("ABSTAIN: structurally multi-state requests", () => {
  const index = buildFlowIndex(FLOWS);
  for (const q of [
    "Add item to cart as guest, proceed to checkout. Then cancel, login with valid credentials and return",
    "guest vs logged in checkout",
    "compare the cart totals",
    "verify the cart persists across sessions",
    "session expired redirects to login",
    "double submit the order form",
    "cross-device cart sync",
  ]) {
    const r = rankFlows(index, q);
    assert.strictEqual(r.abstained, true, `should abstain: ${q}`);
    assert.match(r.reason, /multiple states/);
  }
});

test("isMultiStateRequest does not fire on ordinary single-flow requests", () => {
  for (const q of [
    "Log in with valid credentials and verify the dashboard",
    "Search for a laptop",
    "Add 3 products to cart and update the quantity",
    "Sign in as an admin and open the admin panel",
    "Register a new account",
  ]) {
    assert.strictEqual(isMultiStateRequest(q), false, `should NOT abstain: ${q}`);
  }
});

test("REGRESSION GUARD: there is no score/margin/coverage threshold", () => {
  // Measured 2026-08-09: the one demo-web prompt that should abstain scored the HIGHEST confidence of
  // almost any prompt (margin 55%), while a prompt whose correct answer merely ranked 2nd sat at 5%.
  // Score, margin and coverage were each tested and none separates the classes — any cutoff rejecting the
  // former also rejects six confidently-correct prompts. So a weak-but-real match must still answer.
  const r = rankFlows(buildFlowIndex(FLOWS), "the customer wants something");
  assert.strictEqual(r.abstained, false, "a weak single-term match must NOT abstain");
  assert.strictEqual(r.hit.key, "customer-login");
  assert.ok(r.coverage < 0.5, `coverage is reported (${r.coverage}) but must not gate`);
});

/* ─── key-coverage tie-break (G2.4) ─── */

test("keyCoverage measures how much of a flow's NAME the query justifies", () => {
  const q = tokenize("go to the login page and sign in as a customer");
  assert.strictEqual(keyCoverage("customer-login", q), 1, "both key tokens present");
  assert.strictEqual(keyCoverage("logout", q), 0, "key token absent");
  assert.strictEqual(keyCoverage("product-detail", tokenize("add products to cart")), 0.5);
  assert.strictEqual(keyCoverage("", tokenize("anything")), 0, "empty key ⇒ 0, not NaN");
});

test("TIE-BREAK: a superset flow does not steal a request that names the subset", () => {
  // Uses demo-web's REAL pack: IDF depends on the whole corpus, so a 2-flow toy index would not
  // reproduce the near-tie this guards. `logout` must log in first, so its steps contain
  // customer-login's entire sequence, and its description ("User logout — sign out from account")
  // coincidentally matches "verify user…" and "click Sign In". Measured 2026-08-09, it outscored
  // customer-login 11.65 to 11.10 on a pure login request — and, being a verified flow, would have
  // PASSED while testing logout instead. Same shape on prompt 10, where `product-detail` says
  // "Add to Cart" twice and so out-counts `cart` itself.
  const pack = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "..", "..", "apps", "demo-web", ".agenticqa", "knowledge.json"),
      "utf8"
    )
  );
  const index = buildFlowIndex(pack.goldenFlows);

  assert.strictEqual(
    rankFlows(index, "Go to login page, enter customer@example.com and password123, click Sign In, and verify user is redirected to account page with welcome message.").hit.key,
    "customer-login"
  );
  assert.strictEqual(
    rankFlows(index, "Add 3 different products to cart, go to cart page, verify all 3 items are listed with correct prices, then update quantity of one item to 2 and confirm total updates.").hit.key,
    "cart"
  );
  // …and it must not invert the requests those flows legitimately own.
  assert.strictEqual(
    rankFlows(index, "Login as a user, click user menu in navbar, select Logout and verify signed out").hit.key,
    "logout"
  );
  assert.strictEqual(
    rankFlows(index, "Open a product detail page and verify the price and rating are visible").hit.key,
    "product-detail"
  );
});

test("the tie-break only reorders near-ties, never a decisive winner", () => {
  const index = buildFlowIndex(FLOWS);
  // "search" wins this outright; no key-coverage argument may override a clear margin.
  const r = rankFlows(index, "search for a product in the search box");
  assert.strictEqual(r.hit.key, "search");
});

/* ─── L2: a GENERATED pack drives the deterministic path ─── */

test("retrieval works on generated flow keys the old regex ladder could never match", () => {
  // `synthesizePack` emits `<kind>-<route>` keys. The regex ladder's branches named demo-web's 15 keys
  // (customer-login, search, cart…), so a generated pack matched NOTHING — limitation L2.
  const index = buildFlowIndex({
    "smoke-home": flow("Home page loads", [{ action: "goto", url: "/" }]),
    "form-login": flow("Login form submission", [
      { action: "goto", url: "/login" },
      { action: "fill", field: "Email" },
      { action: "click", target: "Sign In" },
    ]),
    "nav-projects": flow("Navigate to projects", [
      { action: "goto", url: "/" },
      { action: "click", target: "Projects" },
    ]),
  });
  assert.strictEqual(rankFlows(index, "sign in with my email and password").hit.key, "form-login");
  assert.strictEqual(rankFlows(index, "open the projects page").hit.key, "nav-projects");
  assert.strictEqual(rankFlows(index, "check the home page loads").hit.key, "smoke-home");
});

/* ─── embedding orchestration ─── */

test("embedFlowIndex returns null (never throws) when unconfigured or failing", async () => {
  const index = buildFlowIndex(FLOWS);
  assert.strictEqual(await embedFlowIndex(index, fakeEmbedder({ configured: false })), null);
  assert.strictEqual(await embedFlowIndex(index, fakeEmbedder({ fail: true })), null);
  assert.strictEqual(await embedFlowIndex(buildFlowIndex({}), fakeEmbedder()), null, "no flows");
  assert.strictEqual(await embedQuery("q", fakeEmbedder({ fail: true })), null);
});

test("embedFlowIndex uses the cache on a second call", async () => {
  const index = buildFlowIndex(FLOWS);
  const emb = fakeEmbedder();
  const store = new Map();
  const cache = { get: (k) => store.get(k), set: (k, v) => store.set(k, v) };

  const first = await embedFlowIndex(index, emb, { model: "m", cache });
  const callsAfterFirst = emb.calls;
  assert.strictEqual(first.size, 3);

  const second = await embedFlowIndex(index, emb, { model: "m", cache });
  assert.strictEqual(emb.calls, callsAfterFirst, "cache hit ⇒ no further embedding calls");
  assert.deepStrictEqual([...second.keys()].sort(), [...first.keys()].sort());
});

test("an incomplete cache entry is ignored rather than half-used", async () => {
  const index = buildFlowIndex(FLOWS);
  const emb = fakeEmbedder();
  const hash = flowIndexHash(index, "m");
  const cache = { get: () => ({ cart: [1, 2, 3] }), set: () => {} }; // missing 2 of 3 flows
  const vectors = await embedFlowIndex(index, emb, { model: "m", cache });
  assert.strictEqual(vectors.size, 3, "re-embedded everything");
  assert.ok(emb.calls >= 3);
  assert.ok(hash.length > 0);
});

test("flowIndexHash changes when the pack or the model changes", () => {
  const a = buildFlowIndex(FLOWS);
  const b = buildFlowIndex({ ...FLOWS, extra: flow("another flow") });
  assert.notStrictEqual(flowIndexHash(a, "m"), flowIndexHash(b, "m"), "pack change invalidates");
  assert.notStrictEqual(flowIndexHash(a, "m1"), flowIndexHash(a, "m2"), "model change invalidates");
  assert.strictEqual(flowIndexHash(a, "m"), flowIndexHash(buildFlowIndex(FLOWS), "m"), "stable");
});

test("fileFlowVectorCache round-trips and survives a corrupt file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aqa-vec-"));
  const file = path.join(dir, "nested", "vectors.json");

  const cache = fileFlowVectorCache(file);
  assert.strictEqual(cache.get("missing"), undefined);
  cache.set("h1", { cart: [1, 2, 3] });
  assert.deepStrictEqual(fileFlowVectorCache(file).get("h1"), { cart: [1, 2, 3] });

  fs.writeFileSync(file, "{ not json", "utf8");
  const broken = fileFlowVectorCache(file);
  assert.strictEqual(broken.get("h1"), undefined, "corrupt cache reads as empty, not a crash");
  broken.set("h2", { a: [1] });
  assert.deepStrictEqual(fileFlowVectorCache(file).get("h2"), { a: [1] }, "and recovers");

  fs.rmSync(dir, { recursive: true, force: true });
});
