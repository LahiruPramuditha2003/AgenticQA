"use strict";
// Offline unit tests for plan → Playwright code generation (locator selection).
// Tests the public planToPlaywrightTs API (resilient to internal refactors in later steps).
// Requires a build first: `npm run build` (imports from dist/).

const { test } = require("node:test");
const assert = require("node:assert");
const {
  planToPlaywrightTs,
} = require("../dist/agents/TestScriptGeneratorAgent/tools/planToPlaywright.js");

const BASE = "http://localhost:5173";

function gen(steps, title = "spec under test") {
  return planToPlaywrightTs({
    plan: { testCases: [{ title, steps }] },
    baseUrl: BASE,
    startUrl: "/",
    stepLocators: {},
  });
}

test("emits a valid Playwright scaffold", () => {
  const ts = gen([{ action: "goto", url: "/" }, { action: "waitForLoad" }]);
  assert.match(ts, /import \{ test, expect \} from '@playwright\/test';/);
  assert.match(ts, /test\("spec under test", async \(\{ page \}\) => \{/);
});

test("goto with a relative url resolves against baseUrl", () => {
  const ts = gen([{ action: "goto", url: "/products" }]);
  assert.ok(
    ts.includes(`new URL("/products", "http://localhost:5173").toString()`),
    "relative goto should resolve via new URL(path, baseUrl)"
  );
});

test("fill on a labelled field uses getByLabel", () => {
  const ts = gen([{ action: "fill", field: "Email", value: "a@b.com" }]);
  assert.ok(ts.includes(`getByLabel("Email"`), "Email should map to getByLabel");
  assert.ok(ts.includes(`.fill("a@b.com")`));
});

test("click on a nav label maps to a link role", () => {
  const ts = gen([{ action: "click", target: "Products" }]);
  assert.ok(
    ts.includes(`getByRole('link', { name: "Products", exact: true })`),
    "Products is a nav link"
  );
});

test("click on an action label maps to a button role", () => {
  const ts = gen([{ action: "click", target: "Add to Cart" }]);
  assert.ok(
    ts.includes(`getByRole('button', { name: "Add to Cart" }).first()`),
    "Add to Cart is a button action"
  );
});

test("search-results heading becomes a tolerant getByText regex", () => {
  const ts = gen([{ action: "expectVisible", target: 'All Products - "laptop"' }]);
  assert.ok(ts.includes("getByText(/All Products"), "search heading → getByText regex");
  assert.ok(ts.includes("laptop"), "search term preserved in assertion");
  assert.ok(ts.includes("toBeVisible()"));
});

test("STEP_IDs are unique and sequential", () => {
  const steps = [
    { action: "goto", url: "/" },
    { action: "waitForLoad" },
    { action: "fill", field: "Email", value: "x" },
    { action: "click", target: "Sign In" },
    { action: "expectVisible", target: "Dashboard" },
  ];
  const ts = gen(steps);
  const ids = [...ts.matchAll(/STEP_ID=plan-step-(\d+)/g)].map((m) => Number(m[1]));
  assert.strictEqual(ids.length, steps.length, "one STEP_ID per step");
  assert.strictEqual(new Set(ids).size, ids.length, "no duplicate STEP_IDs");
  assert.deepStrictEqual(
    ids,
    steps.map((_, i) => i + 1),
    "STEP_IDs are sequential 1..N"
  );
});

test("submit-like labels click a button, not a same-named heading", () => {
  // Register page has both an <h1>Create Account</h1> and the submit button.
  const ts = gen([{ action: "click", target: "Create Account" }]);
  assert.ok(ts.includes(`getByRole('button', { name: "Create Account" })`), "targets the button by role");
  assert.ok(!ts.includes("getByText(\"Create Account\""), "not getByText (would hit the heading)");
});

test("button clicks tolerate emoji/icon prefixes (e.g. '🚪 Logout')", () => {
  const ts = gen([{ action: "click", target: "Logout" }]);
  // exact:false so getByRole name substring-matches "🚪 Logout"
  assert.ok(ts.includes(`getByRole('button', { name: "Logout" }).first()`));
  assert.ok(!ts.includes("exact: true }).first().click"), "logout button is not exact-matched");
});

test("an element name containing a role word ('Send Reset Link') is not mis-rendered", () => {
  const ts = gen([{ action: "click", target: "Send Reset Link" }]);
  assert.ok(!ts.includes("getByRole('link'"), "must not become a link locator");
  assert.ok(ts.includes(`getByText("Send Reset Link"`), "matches the button by its full text");
});

test("error/toast text asserts as getByText, not a heading", () => {
  const ts = gen([{ action: "expectVisible", target: "Invalid email or password" }]);
  assert.ok(ts.includes(`getByText("Invalid email or password"`), "toast → getByText");
  assert.ok(!ts.includes(`getByRole('heading', { name: "Invalid email or password"`), "not a heading");
});

test("override locators from the inspector take precedence", () => {
  const ts = planToPlaywrightTs({
    plan: {
      testCases: [
        { title: "t", steps: [{ action: "click", target: "Whatever" }] },
      ],
    },
    baseUrl: BASE,
    startUrl: "/",
    stepLocators: { "0-1": `page.getByTestId("buy-now")` },
  });
  assert.ok(ts.includes(`page.getByTestId("buy-now").click({ force: true })`));
});

/* ─── G3.4: real element roles beat name guesses ─── */

test("G3.4: the live page's role decides link vs heading vs button", () => {
  const plan = {
    testCases: [{
      title: "roles",
      steps: [
        { action: "goto", url: "/cart" },
        { action: "expectVisible", target: "Order Summary" },
        { action: "click", target: "Products" },
      ],
    }],
  };
  const roleByName = { "order summary": "heading", products: "link" };
  const src = planToPlaywrightTs({ plan, baseUrl: "http://localhost:5173", roleByName });
  assert.match(src, /getByRole\('heading', \{ name: "Order Summary"/,
    "a real heading is asserted as a heading, not loose text");
  assert.match(src, /getByRole\('link', \{ name: "Products"/);
});

test("G3.4: the role map overrides the hardcoded fallback lists", () => {
  // "cart" is in the legacy nav-link list. If the page says it is a heading, the page wins.
  const plan = { testCases: [{ title: "t", steps: [{ action: "expectVisible", target: "Cart" }] }] };
  const asHeading = planToPlaywrightTs({
    plan, baseUrl: "http://x", roleByName: { cart: "heading" },
  });
  assert.match(asHeading, /getByRole\('heading', \{ name: "Cart"/);
});

test("G3.4: with no role map the previous behavior is unchanged", () => {
  // The fallback lists still apply for names the page never reported — verified byte-identical across
  // all 48 deterministic demo-web specs when the map is absent.
  const plan = { testCases: [{ title: "t", steps: [{ action: "click", target: "Products" }] }] };
  const src = planToPlaywrightTs({ plan, baseUrl: "http://x" });
  assert.match(src, /getByRole\('link', \{ name: "Products"/);
});

/* ────────────────────────────────────────────────────────────────────────────
   R1.2 — three codegen defects found by the release audit (2026-08-22).
   Each was reproduced against the built output before being fixed; these lock
   the fixes and, more importantly, lock the REASON each one mattered.
   ──────────────────────────────────────────────────────────────────────────── */

test("D39: expectCount atLeast/atMost emit inequalities, not exact equality", () => {
  // Was: `toHaveCount(3)` for BOTH, with a trailing comment claiming otherwise — so "at least 3
  // products" failed whenever there were 4. The comment documented the intent the code ignored.
  const atLeast = gen([{ action: "expectCount", target: "Product", count: 3, comparison: "atLeast" }]);
  assert.match(atLeast, /toBeGreaterThanOrEqual\(3\)/);
  assert.doesNotMatch(atLeast, /toHaveCount/, "atLeast must not assert an exact count");

  const atMost = gen([{ action: "expectCount", target: "Product", count: 3, comparison: "atMost" }]);
  assert.match(atMost, /toBeLessThanOrEqual\(3\)/);
  assert.doesNotMatch(atMost, /toHaveCount/, "atMost must not assert an exact count");

  // `equal` is the one comparison that SHOULD stay exact.
  assert.match(
    gen([{ action: "expectCount", target: "Product", count: 3, comparison: "equal" }]),
    /toHaveCount\(3\)/
  );
  // Strict inequalities keep working and use the same shape.
  assert.match(
    gen([{ action: "expectCount", target: "P", count: 2, comparison: "greaterThan" }]),
    /toBeGreaterThan\(2\)/
  );
  assert.match(
    gen([{ action: "expectCount", target: "P", count: 2, comparison: "lessThan" }]),
    /toBeLessThan\(2\)/
  );
});

test("D40: a NAMED checkbox never falls back to an unnamed one", () => {
  // Was: `.or(page.getByRole('checkbox')).first()`. `.or()` is a union and `.first()` is DOM-first
  // ACROSS it, so an unrelated checkbox earlier in the page won even when the named one existed —
  // and when the named one was absent the step ticked an arbitrary box and the test PASSED.
  for (const action of ["check", "uncheck"]) {
    const src = gen([{ action, target: "Urgent" }]);
    assert.match(src, /getByRole\('checkbox', \{ name: "Urgent" \}\)/);
    assert.match(src, /getByLabel\("Urgent"\)/, "the wrapping-label case is still covered");
    assert.doesNotMatch(
      src,
      /\.or\(page\.getByRole\('checkbox'\)\)/,
      "a named target must never union in the unnamed catch-all"
    );
    assert.match(src, new RegExp(`\.${action}\(\)`), `${action} must call .${action}()`);
  }
});

test("D40: an UNNAMED checkbox still gets the bare fallback", () => {
  // A lone checkbox with no accessible name has nothing else to match on, so the fallback is the best
  // available guess there — the defect was applying it when a name WAS supplied.
  const src = gen([{ action: "check", target: "" }]);
  assert.match(src, /page\.getByRole\('checkbox'\)\.first\(\)\.check\(\)/);
});

test("D41: startsWith/endsWith survive quotes, backslashes and regex metacharacters", () => {
  // Was: `new RegExp("^${escaped}")` — regex metacharacters escaped, but nothing escaped the quote
  // that terminates the JS string. `He said "hi"` produced a SYNTAX ERROR, which fails the whole
  // file rather than the step. Parsing is the only check that catches it.
  const nasty = 'He said "hi" \ (a|b) [x] $end';
  const parses = (src) =>
    assert.doesNotThrow(
      () => new Function(`const test=()=>{},expect=()=>{};${src.replace(/^import .*$/m, "")}`),
      `generated spec must be syntactically valid:\n${src}`
    );

  for (const mode of ["startsWith", "endsWith"]) {
    parses(gen([{ action: "expectText", target: "h1", text: nasty, mode }]));
  }
  parses(gen([{ action: "expectUrl", url: '/a"b?c=(1)', mode: "startsWith" }]));

  // …and the escaping must still produce a regex that means what it says.
  const src = gen([{ action: "expectText", target: "h1", text: "a.b", mode: "startsWith" }]);
  // String.raw so the backslash count is readable rather than a puzzle: the emitted JS source must
  // literally contain  new RegExp("^a\\.b")  — i.e. a JS literal whose VALUE is  ^a\.b ,
  // which as a regex matches a literal dot. One backslash fewer and the dot means 'any character'.
  const wanted = String.raw`new RegExp("^a\\.b")`;
  const got = src.split(`\n`).find((l) => l.includes(`RegExp`));
  assert.ok(src.includes(wanted), `wanted ${wanted} — got ${got}`);
});
