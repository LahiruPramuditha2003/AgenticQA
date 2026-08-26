"use strict";
// Offline unit tests for the PlanGrounder (page-scoped, role-aware, non-destructive grounding).
// Requires a build first (imports from dist/).

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { groundPlan } = require("../dist/agents/TestPlannerAgent/PlanGrounder.js");

function productsPage() {
  return {
    url: "http://localhost:5173/products",
    inputs: [{ role: "textbox", name: "Search products..." }],
    selects: [{ role: "combobox", name: "Category" }],
    buttons: [
      { role: "button", name: "Search" },
      { role: "button", name: "Clear All" },
      { role: "button", name: "Add to Cart" },
    ],
    links: [
      { role: "link", name: "Products" },
      { role: "link", name: "Login" },
    ],
    headings: [
      { role: "heading", name: "All Products" },
      { role: "heading", name: "Filters" },
    ],
    checkboxes: [],
    radios: [],
    rawSnapshot: "",
  };
}

const plan = (...steps) => ({ testCases: [{ title: "t", steps }] });
const stepsOf = (g) => g.testCases[0].steps;

// The pack's assertion aliases, as `TestPlannerAgent` passes them. G3.2: this protection used to come
// from a hardcoded `/^all products\s*[-–—]/` inside the grounder; it now comes from the app's own pack.
const DEMO_KEEP = ['All Products - "TERM"', "Total Orders", "Order Summary"];

test("search-results heading is preserved, never remapped to a button (the classic bug)", () => {
  const g = groundPlan(
    plan(
      { action: "goto", url: "/products" },
      { action: "fill", field: "Search products...", value: "laptop" },
      { action: "click", target: "Search" },
      { action: "expectVisible", target: 'All Products - "laptop"' }
    ),
    { pages: [productsPage()], startUrl: "/products", keepTargets: DEMO_KEEP }
  );
  const last = stepsOf(g).at(-1);
  assert.strictEqual(last.action, "expectVisible");
  assert.strictEqual(last.target, 'All Products - "laptop"', "must NOT become Clear All or anything else");
  assert.strictEqual(g.__removedSteps.length, 0, "search assertion not dropped");
});

test("G3.2: an ALL-CAPS placeholder in a pack alias matches the runtime value", () => {
  // `All Products - "TERM"` must protect `All Products - "webcam"`, a heading that does not exist until
  // the search runs. Without placeholder matching the alias would only ever match itself, which is why
  // the one app needing it previously had its pattern baked into engine code.
  for (const term of ["webcam", "4k monitor", "laptop"]) {
    const g = groundPlan(
      plan(
        { action: "goto", url: "/products" },
        { action: "expectVisible", target: `All Products - "${term}"` }
      ),
      { pages: [productsPage()], startUrl: "/products", keepTargets: DEMO_KEEP }
    );
    assert.strictEqual(stepsOf(g).at(-1).target, `All Products - "${term}"`, `kept for "${term}"`);
  }
  // A different heading is NOT protected by that alias.
  const other = groundPlan(
    plan({ action: "goto", url: "/products" }, { action: "expectVisible", target: "Totally Unrelated" }),
    { pages: [productsPage()], startUrl: "/products", keepTargets: DEMO_KEEP }
  );
  assert.ok(other.__removedSteps.length > 0, "the pattern must not protect everything");
});

test("ungroundable assertion on an inspected page is dropped and recorded", () => {
  // The drop itself is still the behaviour — it is recorded on `__removedSteps` either way. A SECOND
  // assertion is present here so the plan does not end up empty; see the trade-off test below for what
  // happens when the dropped one was the only assertion.
  const g = groundPlan(
    plan(
      { action: "goto", url: "/products" },
      { action: "expectVisible", target: "Rating Stars Widget" },
      { action: "expectVisible", target: "All Products" }
    ),
    { pages: [productsPage()], startUrl: "/products" }
  );
  assert.ok(!stepsOf(g).some((s) => s.target === "Rating Stars Widget"), "hallucinated assertion removed");
  assert.strictEqual(g.__removedSteps.length, 1);
  assert.match(g.__removedSteps[0].reason, /not present/);
});

test("click target is canonicalized to the real element name", () => {
  const g = groundPlan(
    plan(
      { action: "goto", url: "/products" },
      { action: "click", target: "add to cart" }
    ),
    { pages: [productsPage()], startUrl: "/products" }
  );
  assert.strictEqual(stepsOf(g).find((s) => s.action === "click").target, "Add to Cart");
  assert.strictEqual(g.__repairedSteps.length, 1);
  assert.strictEqual(g.__repairedSteps[0].result, "Add to Cart");
});

test("no cross-role remap: a click never resolves to a heading", () => {
  // "Filters" exists only as a heading, not a clickable → the click must be left untouched.
  const g = groundPlan(
    plan(
      { action: "goto", url: "/products" },
      { action: "click", target: "Filters" }
    ),
    { pages: [productsPage()], startUrl: "/products" }
  );
  assert.strictEqual(
    stepsOf(g).find((s) => s.action === "click").target,
    "Filters",
    "click left as-is, not remapped to the heading"
  );
  assert.strictEqual(g.__removedSteps.length, 0, "interactions are kept, not dropped");
});

test("fill field is matched within the fillable bucket (prefix match)", () => {
  const g = groundPlan(
    plan({ action: "goto", url: "/products" }, { action: "fill", field: "Search", value: "x" }),
    { pages: [productsPage()], startUrl: "/products" }
  );
  assert.strictEqual(stepsOf(g).find((s) => s.action === "fill").field, "Search products...");
});

test("steps on a route that was never inspected are trusted as-is", () => {
  const g = groundPlan(
    plan(
      { action: "goto", url: "/admin" },
      { action: "expectVisible", target: "Some Admin Widget" },
      { action: "click", target: "Add Product" }
    ),
    { pages: [productsPage()], startUrl: "/products" }
  );
  assert.strictEqual(stepsOf(g).length, 3, "nothing dropped on an uninspected route");
  assert.strictEqual(g.__removedSteps.length, 0);
});

test("absolute goto URLs are normalized to path and variant params stripped", () => {
  const g = groundPlan(plan({ action: "goto", url: "http://localhost:5173/products?variant=red" }), {
    pages: [productsPage()],
    startUrl: "/",
  });
  assert.strictEqual(stepsOf(g)[0].url, "/products");
});

test("no page inventory → plan is trusted unchanged", () => {
  const g = groundPlan(
    plan({ action: "goto", url: "/x" }, { action: "expectVisible", target: "Anything" }),
    { pages: [], startUrl: "/" }
  );
  assert.strictEqual(stepsOf(g).length, 2);
  assert.strictEqual(g.__removedSteps.length, 0);
});

test("a multi-word assertion is not collapsed to a contained sub-word", () => {
  const forgot = {
    url: "http://localhost:5173/auth/forgot-password",
    inputs: [{ role: "textbox", name: "Email" }],
    buttons: [{ role: "button", name: "Send Reset Link" }],
    headings: [{ role: "heading", name: "Reset Password" }],
    links: [],
    selects: [],
    checkboxes: [],
    radios: [],
    rawSnapshot: "",
  };
  // "Resend Email" contains "Email"; it must NOT be remapped to the Email input.
  const g1 = groundPlan(
    plan({ action: "goto", url: "/auth/forgot-password" }, { action: "expectVisible", target: "Resend Email" }),
    { pages: [forgot], startUrl: "/auth/forgot-password" }
  );
  assert.ok(!stepsOf(g1).some((s) => s.target === "Email"), "must not collapse to Email");

  // when alias-protected it is kept verbatim
  const g2 = groundPlan(
    plan({ action: "goto", url: "/auth/forgot-password" }, { action: "expectVisible", target: "Resend Email" }),
    { pages: [forgot], startUrl: "/auth/forgot-password", keepTargets: ["Resend Email"] }
  );
  assert.ok(stepsOf(g2).some((s) => s.target === "Resend Email"), "kept when alias-protected");
});

test("keepTargets (pack assertion aliases) are never dropped", () => {
  const g = groundPlan(
    plan({ action: "goto", url: "/products" }, { action: "expectVisible", target: "Order Summary" }),
    { pages: [productsPage()], startUrl: "/products", keepTargets: ["Order Summary"] }
  );
  assert.ok(stepsOf(g).some((s) => s.target === "Order Summary"), "aliased assertion preserved");
  assert.strictEqual(g.__removedSteps.length, 0);
});

/* ─── G2.7b regression: page-scoped rewrite rules ─── */

const { repairSteps } = require("../dist/agents/TestPlannerAgent/PlanGrounder.js");

/**
 * A FLATTENED two-page context, exactly what `flattenPageContext` hands `repairSteps` in a real run:
 * elements from `/` and `/products` merged into one bag, each tagged with its own `pageUrl`.
 */
function flattenedHomeAndProducts() {
  const P = "http://localhost:5173/products";
  const H = "http://localhost:5173/";
  return {
    url: H,
    inputs: [{ role: "textbox", name: "Search products...", pageUrl: P }],
    selects: [{ role: "combobox", name: "Category", pageUrl: P }],
    buttons: [{ role: "button", name: "Search", pageUrl: P }],
    links: [{ role: "link", name: "Products", pageUrl: H }],
    cards: [
      { role: "link", name: "Smartphones", pageUrl: H },
      { role: "link", name: "Laptops", pageUrl: H },
    ],
    headings: [
      { role: "heading", name: "Welcome to TechStore", pageUrl: H },
      { role: "heading", name: "All Products", pageUrl: P },
    ],
    checkboxes: [],
    radios: [],
    rawSnapshot: "",
  };
}

test("REGRESSION: a category-card click on / is NOT rewritten into a select that lives on /products", () => {
  // demo-web benchmark prompt 5, 2026-08-10. The plan is the `category-card-click` golden flow:
  // goto / → click "Smartphones" → assert. `hasCategorySelect` was checked against the FLATTENED
  // context, so a <select> on /products authorised rewriting the click into
  // `getByTestId('filter-category-select').selectOption(...)` — a control absent from `/`. The spec
  // could never run; the prompt regressed from PASS to a no-report failure.
  const out = repairSteps(
    [
      { action: "goto", url: "/" },
      { action: "waitForLoad" },
      { action: "click", target: "Smartphones" },
      { action: "waitForLoad" },
      { action: "expectVisible", target: "Smartphones" },
    ],
    flattenedHomeAndProducts()
  );
  const click = out.find((s) => s.action === "click" && /smartphones/i.test(s.target ?? ""));
  assert.ok(click, "the click on the category card must survive");
  assert.ok(
    !out.some((s) => s.action === "select"),
    `no select may be synthesized on a page without one — got ${JSON.stringify(out)}`
  );
});

test("G3.2: the category click→select rewrite is GONE, on every page", () => {
  // G2.7b made the rule page-scoped; G3.2 deleted it. It was one of ~10 demo-web rewrites that ran for
  // every app, and measurement showed **none of them fired** across all 48 deterministic plans
  // demo-web's own templates produce — they were written for LLM plans, which the deterministic path
  // replaced. The knowledge they encoded already lives in the pack's `assertionAliases`.
  const out = repairSteps(
    [
      { action: "goto", url: "/products" },
      { action: "click", target: "Laptops" },
      { action: "expectVisible", target: "Laptops" },
    ],
    flattenedHomeAndProducts()
  );
  assert.ok(!out.some((s) => s.action === "select"), "no category knowledge remains in the grounder");
  assert.ok(out.some((s) => s.action === "click" && s.target === "Laptops"), "the click is preserved");
});

test("G3.2: a fill aimed at a <select> still becomes a select — decided by the PAGE", () => {
  // The app-neutral half of the old rule survives: coercion is real (Playwright rejects fill() on a
  // <select>), but the decision comes from the live page, not from a hardcoded list of field names.
  const out = repairSteps(
    [
      { action: "goto", url: "/products" },
      { action: "fill", field: "Category", value: "Laptops" },
    ],
    flattenedHomeAndProducts()
  );
  const sel = out.find((s) => s.action === "select");
  assert.ok(sel, "fill on a known <select> is coerced");
  assert.strictEqual(sel.field, "Category");
  assert.strictEqual(sel.option, "Laptops");

  // …and a fill on a field the page does not report as a select stays a fill.
  const plain = repairSteps(
    [{ action: "goto", url: "/products" }, { action: "fill", field: "Search products...", value: "x" }],
    flattenedHomeAndProducts()
  );
  assert.ok(plain.some((s) => s.action === "fill"), "a real textbox is left alone");
  assert.ok(!plain.some((s) => s.action === "select"));
});

test("G3.2: no app literals remain in the grounder's source", () => {
  // A cheap, durable guard. These are demo-web's words; the grounder must not know them.
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "agents", "TestPlannerAgent", "PlanGrounder.ts"),
    "utf8"
  );
  // Strip comments — the file legitimately DISCUSSES the deleted rules so nobody reinstates them.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const literal of [
    "Total Orders", "Order Summary", "All Products", "Invalid email or password",
    "Reset Password", "/products", "/cart", "/account", "smartphones", "laptops",
  ]) {
    assert.ok(
      !code.toLowerCase().includes(literal.toLowerCase()),
      `PlanGrounder still contains the app literal "${literal}" outside a comment`
    );
  }
});

/* ─── G3.10: a test that cannot fail is not a test ─── */

test("a value the plan itself enters is never dropped as absent (G3.10)", () => {
  // demo-web prompt 3, VACUOUS since the suite began. The golden flow selects category "Smartphones"
  // and asserts it — but /products was inspected in its INITIAL state, where "Smartphones" is an
  // unselected <option>, so grounding deleted the assertion and left a two-action test that always
  // passes. A value the plan itself enters is present at runtime by construction.
  const g = groundPlan(
    plan(
      { action: "goto", url: "/products" },
      { action: "select", field: "Category", option: "Smartphones" },
      { action: "expectVisible", target: "Smartphones" }
    ),
    { pages: [productsPage()], startUrl: "/products" }
  );
  assert.ok(
    stepsOf(g).some((s) => s.action === "expectVisible" && s.target === "Smartphones"),
    "the assertion on the plan's own selected option must survive"
  );
  assert.strictEqual(g.__removedSteps.length, 0);
});

test("the same rule covers a filled value (G3.10)", () => {
  const g = groundPlan(
    plan(
      { action: "goto", url: "/products" },
      { action: "fill", field: "Search products...", value: "Zephyr X1" },
      { action: "expectVisible", target: "Zephyr X1" }
    ),
    { pages: [productsPage()], startUrl: "/products" }
  );
  assert.ok(stepsOf(g).some((s) => s.target === "Zephyr X1"));
});

test("dropping the LAST assertion puts it back rather than inventing one (G3.10/G5.6)", () => {
  // ⚠️ A DELIBERATE TRADE-OFF, and it was got wrong first.
  //
  // Grounding cannot tell "the planner hallucinated this" from "this is right, but I tracked the wrong
  // page" — the two look identical from in here. The first implementation resolved that by anchoring on
  // the final page's heading, and it broke demo-web's logout test: the flow asserts "Login" after signing
  // out, grounding could not place it (a `click` navigates away from the last `goto`), and the anchor
  // reached for /account's heading — "Test User", the logged-in user's name — so the generated test
  // asserted that the user is still shown AFTER logging out.
  //
  // So: put back what was removed. It is the plan's own intent and invents nothing. The cost is that a
  // genuinely hallucinated target now produces a FAILING test instead of a vacuous passing one — which is
  // the direction this project has chosen every time, because a test that cannot fail is worse than a
  // test that fails loudly. The drop stays recorded on `__removedSteps` either way.
  const g = groundPlan(
    plan(
      { action: "goto", url: "/products" },
      { action: "click", target: "Add to Cart" },
      { action: "expectVisible", target: "Rating Stars Widget" }
    ),
    { pages: [productsPage()], startUrl: "/products" }
  );
  const asserts = stepsOf(g).filter((s) => /^expect/.test(s.action));
  assert.strictEqual(asserts.length, 1);
  assert.strictEqual(asserts[0].target, "Rating Stars Widget", "the plan's own intent is restored");
  assert.strictEqual(g.__removedSteps.length, 1, "the drop is still recorded honestly");
});

test("a plan that never asserted anything still gets a page anchor (G3.10)", () => {
  // The other branch: nothing was dropped, so there is no intent to restore and a page-derived anchor is
  // the only way to make the spec falsifiable at all.
  const g = groundPlan(
    plan({ action: "goto", url: "/products" }, { action: "click", target: "Add to Cart" }),
    { pages: [productsPage()], startUrl: "/products" }
  );
  const asserts = stepsOf(g).filter((s) => /^expect/.test(s.action));
  assert.strictEqual(asserts.length, 1, "an anchor was added");
  assert.ok(asserts[0].target, "and it names a real element");
  assert.strictEqual(g.__removedSteps.length, 0);
});

test("a plan that kept an assertion is untouched (G3.10)", () => {
  const g = groundPlan(
    plan(
      { action: "goto", url: "/products" },
      { action: "expectVisible", target: "All Products" }
    ),
    { pages: [productsPage()], startUrl: "/products" }
  );
  assert.strictEqual(stepsOf(g).filter((s) => /^expect/.test(s.action)).length, 1);
});
