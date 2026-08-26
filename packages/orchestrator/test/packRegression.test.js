/**
 * Regressions from the 2026-08-19 investigation: a generate_pack run on demo-web replaced a
 * hand-curated 15-flow pack with 5 weak flows, and the resulting tests passed while exercising nothing.
 * Each case below pins one of the causes.
 */
const test = require("node:test");
const assert = require("node:assert");

const { parseSnapshotRefs, isPlausibleHealName, chooseHealReplacement } = require("../dist/core/utils/mcp-helpers");
const { pickPageTitle, stripVolatileCounts } = require("../dist/core/inspection/PageInventory");
const { buildInspectUrlsFromRequest } = require("../dist/core/inspection/RouteIntentResolver");
const { buildPackPrompt } = require("../dist/core/knowledge/generate/synthesizePack");

test("snapshot parsing keeps the heading level", () => {
  const refs = parseSnapshotRefs('- heading "Filters" [level=3] [ref=e24]');
  assert.equal(refs[0].level, 3, "[level=N] must survive parsing — pickPageTitle depends on it");
});

test("a page's title is its highest-ranked heading, not the first in DOM order", () => {
  // demo-web /products: <h3>Filters</h3> (sidebar, line 138) precedes <h1>All Products</h1> (line 265).
  const headings = [
    { name: "Filters", level: 3 },
    { name: "All Products", level: 1 },
    { name: "No products found", level: 2 },
  ];
  assert.equal(pickPageTitle(headings), "All Products");
  assert.notEqual(pickPageTitle(headings), headings[0].name, "must not regress to headings[0]");
});

test("pickPageTitle tolerates missing levels and empty input", () => {
  assert.equal(pickPageTitle([{ name: "Only" }]), "Only");
  assert.equal(pickPageTitle([{ name: "" }, { name: "Real" }]), "Real");
  assert.equal(pickPageTitle([]), undefined);
  // A declared <h1> outranks an unranked heading that came first.
  assert.equal(pickPageTitle([{ name: "Unranked" }, { name: "Main", level: 1 }]), "Main");
});

test("route PATTERNS are never browsed as literal URLs", () => {
  const pack = { routes: { productDetail: "/products/:id", products: "/products", splat: "/files/*" } };
  const urls = buildInspectUrlsFromRequest("open a product detail page", "http://x/", "http://x/", pack);
  assert.ok(!urls.some((u) => u.includes(":id")), "a :id pattern resolves to the app's 404 page");
  assert.ok(!urls.some((u) => u.includes("/files/*")), "a splat pattern is not navigable either");
});

test("buildPackPrompt never advertises a router pattern as a real route", () => {
  const prompt = buildPackPrompt({
    siteMap: { startUrl: "http://x/", routes: [] },
    extractedRoutes: [{ path: "/products" }, { path: "/products/:id" }],
    credentials: [],
  });
  assert.ok(prompt.includes("/products"), "concrete routes must still be offered");
  assert.ok(
    !prompt.includes("/products/:id"),
    "the prompt tells the model to use ONLY the routes listed — a pattern listed there gets written into pack.routes"
  );
});

test("deterministic self-heal applies the same plausibility bar as the vector path (D24)", () => {
  const refs = [
    { role: "link", name: "Shopping Cart", ref: "e1" },
    { role: "link", name: "Products", ref: "e2" },
  ];
  const chosen = chooseHealReplacement(refs, "click", "Add to Cart", null);
  // chooseHealReplacement's token-overlap stage accepts a single shared word ("cart")...
  assert.ok(chosen, "precondition: the loose matcher still offers this candidate");
  // ...so the caller MUST gate it. If this ever returns true, the guard has been unwired again.
  assert.equal(
    isPlausibleHealName("Add to Cart", chosen.name),
    false,
    "'Add to Cart' -> 'Shopping Cart' is the exact D24 swap and must be rejected"
  );
});

/* ── D29 (R1.5): a generated pack must not assert what was true during ONE crawl ── */

test("D29: stripVolatileCounts removes trailing counts, and ONLY those", () => {
  // The live case: demo-web renders `<h1>Shopping Cart ({totalItems} items)</h1>`. A crawl taken with
  // 23 items in the cart baked "Shopping Cart (23 items)" into a flow assertion, an assertionAlias and
  // plannerGuidance — so the flow failed the moment an add-to-cart test changed the count.
  const stripped = {
    "Shopping Cart (23 items)": "Shopping Cart",
    "Products (12)": "Products",
    "Inbox [3]": "Inbox",
    "Orders - 5": "Orders",
    "Inbox — 12": "Inbox",
    "Inbox (12) - 3": "Inbox",
  };
  for (const [input, want] of Object.entries(stripped)) {
    assert.equal(stripVolatileCounts(input), want, `should strip the count from ${input}`);
  }

  // Digits that are CONTENT must survive. A pack that cannot assert "2024 Report" is worse than one
  // that occasionally asserts a count, so the rule is deliberately narrow: trailing counts only.
  const kept = ["2024 Report", "Section 3 Overview", "All Products", "Checkout", "Top 10"];
  for (const input of kept) {
    assert.equal(stripVolatileCounts(input), input, `must NOT alter ${input}`);
  }

  // Stripping that would leave nothing meaningful keeps the original — asserting something real beats
  // asserting nothing at all.
  assert.equal(stripVolatileCounts("(5)"), "(5)");
});

test("D29: pickPageTitle composes rank (D26) with count-stripping (D29)", () => {
  // Both defects hit the same field. demo-web /products renders <h3>Filters</h3> before <h1>, and the
  // cart heading carries a count — a title has to survive both to be usable as an assertion.
  assert.equal(
    pickPageTitle([
      { name: "Filters", level: 3 },
      { name: "Shopping Cart (23 items)", level: 1 },
    ]),
    "Shopping Cart"
  );
});
