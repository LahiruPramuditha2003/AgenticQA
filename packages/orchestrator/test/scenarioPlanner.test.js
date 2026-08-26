"use strict";
// Offline unit tests for deterministic-first scenario planning.
// Requires a build first (imports from dist/).

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { buildScenarioPlan } = require("../dist/agents/TestPlannerAgent/ScenarioPlanner.js");
const { loadAppKnowledgePack } = require("../dist/core/knowledge/AppKnowledgePack.js");

let PACK;
test.before(async () => {
  PACK = await loadAppKnowledgePack(path.resolve(__dirname, "../../../apps/demo-web"), undefined);
  assert.ok(PACK && PACK.goldenFlows, "demo pack loaded");
});

const steps = (p) => p.testCases[0].steps;
const has = (p, pred) => steps(p).some(pred);

test("no pack → null (LLM page-grounded path)", () => {
  assert.strictEqual(buildScenarioPlan("login as a customer", null), null);
  assert.strictEqual(buildScenarioPlan("login as a customer", {}), null);
});

test("valid login → customer-login golden (asserts Total Orders)", () => {
  const p = buildScenarioPlan("Login with customer@example.com and verify the account page", PACK);
  assert.ok(p, "matched");
  assert.ok(has(p, (s) => s.action === "click" && /sign in/i.test(s.target)));
  assert.ok(has(p, (s) => s.action === "expectVisible" && /total orders/i.test(s.target)));
});

test("invalid login → wrong creds + 'Invalid email or password'", () => {
  const p = buildScenarioPlan("Attempt login with wrong@email.com and wrongpass, verify error", PACK);
  assert.ok(p, "matched");
  assert.ok(has(p, (s) => s.action === "fill" && /password/i.test(s.field) && /wrong/i.test(s.value)));
  assert.ok(has(p, (s) => s.action === "expectVisible" && s.target === "Invalid email or password"));
});

test("home-page prompt with 'Login' nav link does NOT become a login test", () => {
  const p = buildScenarioPlan(
    "Navigate to the home page and verify the navigation bar contains links to Products, Cart, and Login",
    PACK
  );
  assert.ok(p, "matched");
  assert.ok(has(p, (s) => s.action === "expectVisible" && /welcome to techstore/i.test(s.target)),
    "should be the home flow, not login");
});

test("search adapts to the requested term", () => {
  const p = buildScenarioPlan('Search for "wireless" and confirm products appear', PACK);
  assert.ok(p, "matched");
  assert.ok(has(p, (s) => s.action === "fill" && /search/i.test(s.field) && s.value === "wireless"));
  assert.ok(has(p, (s) => s.action === "expectVisible" && s.target === 'All Products - "wireless"'));
});

// The live page supplies the real <select> options — this is what replaced the hardcoded
// KNOWN_CATEGORIES list in G2.4, so binding an UNQUOTED value now requires page context.
const PRODUCTS_PAGE = {
  selects: [
    { name: "Category", options: ["All Categories", "Laptops", "Smartphones", "Audio", "Tablets"] },
    { name: "Sort", options: ["Featured", "Price: Low to High"] },
  ],
};

test("filter adapts to the requested category (bound from the live page's options)", () => {
  const p = buildScenarioPlan("Go to Products, filter by category Smartphones, sort by price", PACK, {
    pageContext: PRODUCTS_PAGE,
  });
  assert.ok(p, "matched");
  assert.ok(has(p, (s) => s.action === "select" && /category/i.test(s.field) && s.option === "Smartphones"));
  assert.ok(has(p, (s) => s.action === "expectVisible" && s.target === "Smartphones"),
    "the assertion is re-pointed by the same substitution");
});

test("a QUOTED category binds even with no page context", () => {
  const p = buildScenarioPlan('Filter products by category "Audio"', PACK);
  assert.ok(has(p, (s) => s.action === "select" && s.option === "Audio"));
});

test("with no page context and no quotes, the flow keeps its verified value", () => {
  // Safe by construction: the authored value is the one the flow was verified with.
  const p = buildScenarioPlan("Go to Products, filter by category Smartphones", PACK);
  assert.ok(has(p, (s) => s.action === "select" && s.option === "Laptops"));
});

test("a button label is never mistaken for a category parameter", () => {
  // `product-detail` clicks "Add to Cart" AND asserts it, so it looks parameterized. It must not be
  // substituted just because the request names a real category.
  const p = buildScenarioPlan(
    "Open a product detail page for Laptops and verify the Add to Cart button",
    PACK,
    { pageContext: PRODUCTS_PAGE }
  );
  assert.ok(p, "matched");
  assert.ok(has(p, (s) => s.action === "click" && s.target === "Add to Cart"),
    "the click target must survive untouched");
});

test("cart prompt → cart golden (Add to Cart + Order Summary)", () => {
  const p = buildScenarioPlan("Add a product to the cart and view the cart page", PACK);
  assert.ok(p, "matched");
  assert.ok(has(p, (s) => s.action === "click" && /add to cart/i.test(s.target)));
  assert.ok(has(p, (s) => s.action === "expectVisible" && /order summary/i.test(s.target)));
});

test("empty-cart checkout → checkout-empty golden", () => {
  const p = buildScenarioPlan("Navigate to /checkout with an empty cart and verify redirect", PACK);
  assert.ok(p, "matched");
  assert.ok(has(p, (s) => s.action === "expectVisible" && /your cart is empty/i.test(s.target)));
});

test("registration → register golden keeps the required Terms checkbox", () => {
  const p = buildScenarioPlan("Go to register page and create a new account", PACK);
  assert.ok(p, "matched");
  assert.ok(has(p, (s) => s.action === "check" && /terms/i.test(s.target)), "Terms checkbox kept");
  assert.ok(has(p, (s) => s.action === "click" && /create account/i.test(s.target)));
});

test("admin login → admin-login golden", () => {
  const p = buildScenarioPlan("Login as admin and open the admin dashboard", PACK);
  assert.ok(p, "matched");
  assert.ok(has(p, (s) => s.action === "fill" && /email/i.test(s.field) && /admin@techstore/i.test(s.value)));
});

test("password reset → deterministic flow asserting the post-submit confirmation", () => {
  const p = buildScenarioPlan("Click Forgot Password, enter email, submit, verify confirmation", PACK);
  assert.ok(p, "matched");
  assert.ok(has(p, (s) => s.action === "click" && /send reset link/i.test(s.target)));
  assert.ok(has(p, (s) => s.action === "expectVisible" && /resend email/i.test(s.target)));
});

test("registration validation (mismatched passwords) → deterministic flow", () => {
  const p = buildScenarioPlan("Try registering with mismatched passwords and verify error", PACK);
  assert.ok(p, "matched");
  // password and confirm-password fields must differ
  const pw = steps(p).find((s) => s.action === "fill" && /^password$/i.test(s.field));
  const cpw = steps(p).find((s) => s.action === "fill" && /confirm password/i.test(s.field));
  assert.ok(pw && cpw && pw.value !== cpw.value, "uses mismatched passwords");
  assert.ok(has(p, (s) => s.action === "expectVisible" && /passwords do not match/i.test(s.target)));
});

test("genuinely comparative flows are still deferred to the LLM (null)", () => {
  assert.strictEqual(buildScenarioPlan("Add item as guest vs logged in and compare checkout", PACK), null);
});

test("auth-validation scenarios defer to the LLM when the pack lacks those flows (S5.3 — no in-code literals)", () => {
  // A pack that defines a generic flow but NOT login-invalid / password-reset / register-mismatch.
  const minimalPack = {
    goldenFlows: { home: { description: "home", steps: [{ action: "goto", url: "/" }, { action: "waitForLoad" }] } },
  };
  assert.strictEqual(buildScenarioPlan("Attempt login with wrong creds and verify the error", minimalPack), null);
  assert.strictEqual(buildScenarioPlan("Click Forgot Password, enter email, submit", minimalPack), null);
  assert.strictEqual(buildScenarioPlan("Register with mismatched passwords and verify error", minimalPack), null);
  // …but the SAME requests resolve deterministically once the (demo) pack supplies those flows.
  assert.ok(buildScenarioPlan("Attempt login with wrong creds and verify the error", PACK), "demo pack has login-invalid");
  assert.ok(buildScenarioPlan("Register with mismatched passwords and verify error", PACK), "demo pack has register-mismatch");
});
