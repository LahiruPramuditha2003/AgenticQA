"use strict";
// Offline tests for planner-prompt generalization (S5.1). App-specific guidance + credentials are now
// PACK-SOURCED: with no pack the prompt carries zero demo literals (purely page-grounded); with the
// demo-web pack it reproduces the historical prompt byte-for-byte. Requires a build first (dist/).

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { buildPrompt, generateDeterministic } = require("../dist/knowledge/RagPlannerEngine.js");
const {
  loadAppKnowledgePack,
  resolvePlannerGuidance,
  resolveCredentials,
  formatCredentialsBlock,
} = require("../dist/core/knowledge/AppKnowledgePack.js");

// The demo-web planner guidance, exactly as it lived inline in RagPlannerEngine before S5 moved it into
// the pack. Transcribed verbatim (same escaping as the original source template literal) — this locks the
// pack's plannerGuidance against any drift, which in turn keeps the LLM fall-through prompt byte-identical.
const EXPECTED_GUIDANCE = `Auth flow (CRITICAL):
- Login requires navigating to login page FIRST: click "Login" link, waitForLoad, THEN fill "Email" and "Password"
- NEVER fill "Email" or "Password" without first clicking "Login" — they only exist on /auth/login
- "Welcome Back" is the LOGIN PAGE HEADING — NEVER assert it after Sign In (user is redirected away)
- After customer Sign In: navigate to /account, then assert "My Account" or "📊 Dashboard" heading
- After admin Sign In: use goto with url="/admin", then assert "Dashboard" or "Products" heading
- Registration page is at /auth/register — fields: "Full Name", "Email", "Password", "Confirm Password", checkbox "I agree to the Terms of Service and Privacy Policy", button "Create Account"
- After successful registration: navigate to /account, assert "My Account"

Search/filter:
- Always navigate to /products FIRST before filling the search input
- Search input name is "Search products..." — fill it (no click needed, it filters live)
- After search for TERM: the page heading is "All Products - \\"TERM\\"" (include the search term in the assertion)
- No results state: assert text "No products found" — NOT "All Products"
- After selecting a category filter (option="Laptops"): heading becomes "Laptops" — assert the category name, not "All Products"
- Categories: Laptops, Smartphones, Audio, Tablets, Wearables, TVs, Cameras, Gaming, Accessories
- Category/Sort are <select> elements on the Products page — use the "select" action with field="Category" or field="Sort", NEVER "fill"
- If the request says "filter by X category" / "sort by Y" (no mention of "card"): use select action, field="Category", option="X"
- ONLY use a "click" action on a category name (e.g. click "Smartphones") when the request explicitly says "category card" or "click <category name>" — this targets the home page card, not the filter

Assertions:
- NEVER assert "Free Shipping on Orders Over $100" or any promotional banner text — these are marketing display elements, not page state
- NEVER assert "Clear All" — this is a filter reset button, not a state indicator
- For search results: assert "All Products - \\"TERM\\"" matching the actual heading format

For search: extract the search term from the user request or default to "laptop"`;

// Demo-web specifics that must NOT appear when no pack is supplied (the generalization guarantee).
const DEMO_LITERALS = [
  "admin@techstore.com",
  "customer@example.com",
  "Welcome Back",
  "/auth/login",
  "Categories: Laptops, Smartphones",
  "Free Shipping on Orders Over $100",
  "Credentials (demo app",
];

const PAGE = {
  url: "http://localhost:5173/products",
  inputs: [{ role: "textbox", name: "Search products..." }],
  buttons: [{ role: "button", name: "Search" }],
  headings: [{ role: "heading", name: "All Products" }],
  links: [{ role: "link", name: "Products" }],
  selects: [{ role: "combobox", name: "Category" }],
};

let PACK;
test.before(async () => {
  PACK = await loadAppKnowledgePack(path.resolve(__dirname, "../../../apps/demo-web"), undefined);
  assert.ok(PACK && PACK.plannerGuidance, "demo pack with plannerGuidance loaded");
});

test("resolvePlannerGuidance(demo pack) reproduces the historical prose byte-for-byte", () => {
  assert.strictEqual(resolvePlannerGuidance(PACK), EXPECTED_GUIDANCE);
});

test("resolvePlannerGuidance(no pack) is empty (page-grounded)", () => {
  assert.strictEqual(resolvePlannerGuidance(null), "");
  assert.strictEqual(resolvePlannerGuidance(undefined), "");
  assert.strictEqual(resolvePlannerGuidance({}), "");
});

test("buildPrompt(no pack) contains NO demo literals", () => {
  const prompt = buildPrompt("Login as a customer", [], PAGE, "/", null, null);
  for (const lit of DEMO_LITERALS) {
    assert.ok(!prompt.includes(lit), `no-pack prompt must not contain "${lit}"`);
  }
  // It is still a usable, page-grounded prompt.
  assert.ok(prompt.includes("Available Page Elements"));
  assert.ok(prompt.includes("Search products..."), "page elements are still injected");
});

test("buildPrompt(demo pack) == page-grounded prompt + credentials + guidance (byte-identical assembly)", () => {
  const base = buildPrompt("Login as a customer", [], PAGE, "/", null, null);
  const withPack = buildPrompt("Login as a customer", [], PAGE, "/", null, PACK);
  const credBlock = formatCredentialsBlock(resolveCredentials(PACK));
  assert.strictEqual(withPack, `${base}\n\n${credBlock}\n\n${EXPECTED_GUIDANCE}`);
  // …and it now DOES carry the demo specifics, sourced from the pack rather than hardcoded.
  assert.ok(withPack.includes("admin@techstore.com"));
  assert.ok(withPack.includes("Welcome Back"));
});

/* ── S5.2 generateDeterministic is purely page-grounded (no hardcoded routes/credentials/labels) ── */

const LOGIN_PAGE = {
  url: "http://localhost:5173/auth/login",
  inputs: [{ role: "textbox", name: "Email" }, { role: "textbox", name: "Password" }],
  buttons: [{ role: "button", name: "Sign In" }],
  headings: [{ role: "heading", name: "Welcome Back" }],
  links: [{ role: "link", name: "Login" }],
  selects: [],
};

// Hardcoded ROUTES + app-specific ASSERTION/LABEL literals that used to be baked into the fallback.
const HARDCODED = [
  "/auth/login", "/auth/register", "/account", "/admin", "/products", "/cart",
  "admin@techstore.com", "Total Orders", "Order Summary", "All Products",
  "Create Account", "I agree to the Terms",
];

test("generateDeterministic(auth, no pack) builds steps only from the live page — no hardcoded routes/labels", () => {
  const tcs = generateDeterministic("auth", { requestText: "Register a new account" }, LOGIN_PAGE, "/");
  const json = JSON.stringify(tcs);
  for (const lit of HARDCODED) {
    assert.ok(!json.includes(lit), `page-grounded fallback must not contain "${lit}"`);
  }
  const steps = tcs[0].steps;
  assert.strictEqual(steps[0].action, "goto", "starts with goto");
  assert.ok(steps.some((s) => s.action === "fill" && /email/i.test(s.field)), "fills a live form field");
  assert.ok(steps.some((s) => s.action === "click" && s.target === "Sign In"), "clicks a live button");
  // Asserts a REAL on-page anchor (the page's own heading), not an invented one.
  assert.ok(steps.some((s) => /^expect/.test(s.action) && s.target === "Welcome Back"));
});

test("generateDeterministic(search, no pack) fills the page's search box and asserts a real anchor", () => {
  const tcs = generateDeterministic("search", { requestText: "Search for monitors" }, PAGE, "/");
  const steps = tcs[0].steps;
  assert.ok(steps.some((s) => s.action === "fill" && s.field === "Search products..." && s.value === "monitors"));
  assert.ok(steps.some((s) => /^expect/.test(s.action) && s.target === "All Products"),
    "asserts the live page heading (here 'All Products' is the inspected page's own heading)");
  assert.ok(!JSON.stringify(tcs).includes("/products"), "no hardcoded route");
});

test("generateDeterministic always emits at least one assertion (valid spec)", () => {
  for (const intent of ["auth", "form", "search", "filter", "cart", "checkout", "navigate", "generic"]) {
    const tcs = generateDeterministic(intent, { requestText: "do a thing" }, LOGIN_PAGE, "/");
    assert.ok(tcs[0].steps.some((s) => /^expect/.test(s.action)), `${intent} ends with an assertion`);
  }
});

/* ─── G2.6: golden-example selection routed through FlowIndex ─── */

const { selectGoldenExample } = require("../dist/knowledge/RagPlannerEngine.js");

const DEMO_FLOWS = {
  "customer-login": { description: "Customer login and account dashboard verification", steps: [
    { action: "goto", url: "/auth/login" }, { action: "click", target: "Sign In" },
    { action: "expectVisible", target: "Total Orders" }] },
  cart: { description: "Add product to shopping cart and view cart page", steps: [
    { action: "goto", url: "/products" }, { action: "click", target: "Add to Cart" },
    { action: "expectVisible", target: "Order Summary" }] },
  search: { description: "Search for a product", steps: [
    { action: "goto", url: "/products" }, { action: "fill", field: "Search products...", value: "laptop" },
    { action: "expectVisible", target: 'All Products - "laptop"' }] },
};

test("selectGoldenExample: no pack ⇒ no example (never invents one)", () => {
  // The check the G2.4 golden fixture cannot make: it only covers the DETERMINISTIC path, whereas this
  // feeds the LLM prompt. A pack-less app must reach the model with a purely page-grounded prompt.
  assert.strictEqual(selectGoldenExample("log in as a customer", {}), null);
  assert.strictEqual(selectGoldenExample("log in as a customer", null), null);
});

test("selectGoldenExample picks a relevant flow by retrieval", () => {
  assert.match(selectGoldenExample("customer login, verify the account page", DEMO_FLOWS).description, /login/i);
  assert.match(selectGoldenExample("add an item to the shopping cart", DEMO_FLOWS).description, /cart/i);
  assert.match(selectGoldenExample("search for a laptop", DEMO_FLOWS).description, /search/i);
});

test("selectGoldenExample retrieves on shared vocabulary only — it invents no synonyms", () => {
  // Documented limit, verified rather than assumed: retrieval is lexical, so a request must share WORDS
  // with the flow. "log in" does not tokenize to "login", and a flow described as "Your Work" is not
  // reachable by the word "dashboard". Measured 2026-08-09: normalizing the auth bigrams
  // ("sign in"→"login", …) changed NOTHING on either eval — it boosts competing login-ish flows equally —
  // so it was tried and reverted rather than carried as dead complexity. Closing this gap needs
  // embeddings, which measured worse (see FlowIndex's header).
  assert.strictEqual(selectGoldenExample("dashboard", { "smoke-home": {
    description: "Your Work — page loads (/)", steps: [{ action: "goto", url: "/" }] } }), null);
});

test("selectGoldenExample works on GENERATED flow keys (the L1 duplicate ladder is gone)", () => {
  // The deleted regex named demo-web's keys, so a generated pack got NO example at all.
  const generated = {
    "form-login": { description: "Sign in to TaskFlow — submit the form (/login)", steps: [
      { action: "goto", url: "/login" }, { action: "fill", field: "Email" }] },
    "smoke-home": { description: "Your Work — page loads (/)", steps: [{ action: "goto", url: "/" }] },
  };
  assert.match(selectGoldenExample("sign in with my email and password", generated).description, /Sign in/);
  assert.match(selectGoldenExample("check that Your Work loads", generated).description, /Your Work/);
});

test("selectGoldenExample does NOT abstain on multi-state requests (unlike the planner)", () => {
  // Deliberate difference from `rankFlows`: the hit here is only a STYLE TEMPLATE for the LLM, and the
  // multi-state prompts are exactly the ones that reach the LLM path. Abstaining would strip the example
  // precisely when the model most needs to see the step vocabulary.
  const multiState =
    "Add item to cart as guest, proceed to checkout. Then cancel, login with valid credentials and return.";
  assert.ok(selectGoldenExample(multiState, DEMO_FLOWS), "an example is still supplied");
});
