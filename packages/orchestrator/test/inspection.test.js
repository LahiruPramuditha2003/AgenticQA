"use strict";
// Offline unit tests for the app-agnostic page-stability predicate.
// Locks the fix for the "Welcome"-heading hardcode that forced ~8s waits on every non-home page.
// Requires a build first (imports from dist/).

const { test } = require("node:test");
const assert = require("node:assert");
const {
  isSnapshotStable,
  MIN_MEANINGFUL_REFS,
} = require("../dist/core/utils/mcp-helpers.js");

const refsOf = (...names) => names.map((name, i) => ({ role: "generic", name, ref: `e${i}` }));

test("a settled page WITHOUT a 'Welcome' heading is considered stable", () => {
  // e.g. the /cart page — historically this never stabilized because of the Welcome hardcode
  const refs = refsOf("Order Summary", "Subtotal", "Checkout", "Remove");
  assert.strictEqual(isSnapshotStable(refs, refs.length), true);
});

test("not stable while the ref count is still changing", () => {
  const refs = refsOf("a", "b", "c", "d");
  assert.strictEqual(isSnapshotStable(refs, 3), false, "count differs from previous snapshot");
});

test("not stable below the meaningful-content floor", () => {
  const refs = refsOf("only-one");
  assert.strictEqual(isSnapshotStable(refs, refs.length), false, "too few refs to be real content");
  assert.ok(MIN_MEANINGFUL_REFS >= 2, "floor should exclude essentially-empty pages");
});

test("stable once the count repeats at or above the floor", () => {
  const refs = refsOf("h1", "btn", "link");
  assert.strictEqual(isSnapshotStable(refs, refs.length), true);
});

/* ─── G3.7: dropdown options come out of the accessibility snapshot ─── */

const { parseSnapshotRefs: parseRefs2, buildPageContext: buildCtx2 } =
  require("../dist/core/utils/mcp-helpers.js");

const DROPDOWN_SNAPSHOT = [
  "  - main [ref=e12]:",
  '      - textbox "Task title" [ref=e17]',
  '      - combobox "Project" [ref=e21]:',
  '        - option "Apollo Redesign" [selected]',
  '        - option "Beacon Analytics"',
  '      - combobox "Priority" [ref=e25]:',
  '        - option "Low"',
  '        - option "Medium" [selected]',
  '        - option "High"',
  '      - textbox "Due date" [ref=e27]',
  '      - button "Create Task" [ref=e40]',
].join("\n");

test("option children are attached to their dropdown (G3.7)", () => {
  // They were silently dropped. Without options a generated form flow cannot emit a `select` at all —
  // typing into a <select> is rejected (D14) — so Project/Assignee/Priority vanished from TaskFlow's
  // Create Task flow and every "set the priority" prompt scored UNDER_TESTED.
  const refs = parseRefs2(DROPDOWN_SNAPSHOT);
  const byName = Object.fromEntries(refs.map((r) => [r.name, r]));
  assert.deepStrictEqual(byName["Project"].options, ["Apollo Redesign", "Beacon Analytics"]);
  assert.deepStrictEqual(byName["Priority"].options, ["Low", "Medium", "High"]);
  assert.strictEqual(byName["Task title"].options, undefined, "a textbox has no options");
  assert.strictEqual(byName["Create Task"].options, undefined, "a button has no options");
});

test("options are not leaked to the next element (G3.7)", () => {
  // "Due date" follows Priority's options at a shallower indent — it must not inherit them.
  const refs = parseRefs2(DROPDOWN_SNAPSHOT);
  assert.strictEqual(refs.find((r) => r.name === "Due date").options, undefined);
});

test("buildPageContext puts comboboxes in selects, with their options (G3.7)", () => {
  // `selects` used to list only `listbox`, so it was EMPTY for any app using plain <select> elements —
  // which disabled PlanGrounder's fill→select coercion and ScenarioPlanner's option binding.
  const pc = buildCtx2("http://x/tasks/new", parseRefs2(DROPDOWN_SNAPSHOT), DROPDOWN_SNAPSHOT);
  const names = pc.selects.map((s) => s.name).sort();
  assert.deepStrictEqual(names, ["Priority", "Project"]);
  assert.deepStrictEqual(pc.selects.find((s) => s.name === "Priority").options, ["Low", "Medium", "High"]);
});

/* ─── G3.8: cross-page ref identity, and match quality vs role priority ─── */

const {
  mergePageRefs,
  mcpRefOf,
  scopedRef,
  findBestRefMultiRole,
  findByRef: findByRef2,
} = require("../dist/core/utils/mcp-helpers.js");

test("refs from different pages with the same id are all kept (G3.8)", () => {
  // MCP ref ids restart at e1 on every snapshot, and both accumulators used to dedupe by the raw id —
  // so the second page contributed only the ids past the first page's high-water mark. Measured on
  // demo-web: 108 of 139 elements pooled, and a login page's two textboxes reported as "1 input(s)".
  const home = [
    { role: "link", name: "Login", ref: "e11" },
    { role: "heading", name: "Welcome", ref: "e17" },
  ];
  const login = [
    { role: "heading", name: "Please Login", ref: "e11" },
    { role: "textbox", name: "Email", ref: "e17" },
    { role: "textbox", name: "Password", ref: "e19" },
  ];

  const pool = [];
  mergePageRefs(pool, home, "http://x/");
  mergePageRefs(pool, login, "http://x/auth/login");

  assert.strictEqual(pool.length, 5, "nothing may be dropped across pages");
  assert.deepStrictEqual(
    pool.filter((r) => r.role === "textbox").map((r) => r.name),
    ["Email", "Password"]
  );
  // Each entry still knows its own page, and no two share an identity.
  assert.strictEqual(new Set(pool.map((r) => r.ref)).size, 5);
  assert.strictEqual(findByRef2(pool, scopedRef("e17", "http://x/auth/login")).name, "Email");
  assert.strictEqual(findByRef2(pool, scopedRef("e17", "http://x/")).name, "Welcome");
});

test("the page-local id is recoverable for the MCP call (G3.8)", () => {
  // browser_generate_locator only understands the raw per-snapshot id.
  assert.strictEqual(mcpRefOf(scopedRef("e17", "http://x/auth/login?a=1")), "e17");
  assert.strictEqual(mcpRefOf("e17"), "e17", "an un-namespaced ref passes through");
});

test("mergePageRefs still dedupes within one page (G3.8)", () => {
  const pool = [];
  const refs = [
    { role: "link", name: "Home", ref: "e4" },
    { role: "link", name: "Home", ref: "e4" },
  ];
  mergePageRefs(pool, refs, "http://x/");
  assert.strictEqual(pool.length, 1);
});

test("an exact match beats a substring match in a preferred role (G3.8)", () => {
  // demo-web's logout test asserts "Login". `heading "Please Login"` (on the page it just left) merely
  // contains it; `link "Login"` in the post-logout navbar is exact. Searching headings first used to
  // return the heading, and the test failed on an element that no longer existed.
  const refs = [
    { role: "heading", name: "Please Login", ref: "a" },
    { role: "link", name: "Login", ref: "b" },
  ];
  assert.strictEqual(findBestRefMultiRole(refs, ["heading", "link"], "Login"), "b");
});

test("role priority still decides when match quality ties (G3.8)", () => {
  const exactBoth = [
    { role: "link", name: "Products", ref: "lnk" },
    { role: "heading", name: "Products", ref: "hdg" },
  ];
  assert.strictEqual(findBestRefMultiRole(exactBoth, ["heading", "link"], "Products"), "hdg");

  const fuzzyBoth = [
    { role: "link", name: "All Products", ref: "lnk" },
    { role: "heading", name: "All Products", ref: "hdg" },
  ];
  assert.strictEqual(findBestRefMultiRole(fuzzyBoth, ["heading", "link"], "Products"), "hdg");
});

/* ─── G3.10: when to pay for a live plan walk ─── */

const { stepsNeedingWalk } = require("../dist/core/inspection/PlanWalker.js");

const PRODUCTS = {
  url: "http://localhost:5173/products",
  headings: [{ role: "heading", name: "All Products" }],
  buttons: [{ role: "button", name: "Add to Cart" }],
  links: [], inputs: [], selects: [], checkboxes: [], radios: [],
};
const HOME_PAGE = {
  url: "http://localhost:5173/",
  headings: [{ role: "heading", name: "Welcome to TechStore" }],
  // ⚠️ The featured section really does carry its own "Add to Cart" buttons — that is precisely why the
  // pooled search could resolve a product-page click to the home page's MacBook. A fixture without them
  // would be tidier than reality and would test the code we wish we had.
  buttons: [{ role: "button", name: "Add to Cart" }],
  links: [{ role: "link", name: "Products" }, { role: "link", name: "iPhone 15 Pro Max" }],
  inputs: [], selects: [], checkboxes: [], radios: [],
};

test("no walk when the pre-inspected pages already answer (G3.10)", () => {
  // The common case must stay on the cheap path — the walk performs real browser actions.
  const steps = [
    { action: "goto", url: "/products" },
    { action: "click", target: "Add to Cart" },
    { action: "expectVisible", target: "All Products" },
  ];
  assert.deepStrictEqual(stepsNeedingWalk(steps, [PRODUCTS, HOME_PAGE], "/"), []);
});

test("clicking a nav link does not by itself force a walk (G3.10)", () => {
  // Uncertainty is not ambiguity. After clicking a link we no longer know the route — but if the target
  // exists on exactly ONE inspected page there is no guess to make, and the cheap path is still right.
  // Without this distinction almost every plan would walk, including the 19 demo-web prompts that work.
  const steps = [
    { action: "goto", url: "/" },
    { action: "click", target: "Products" },
    { action: "expectVisible", target: "All Products" },
  ];
  assert.deepStrictEqual(stepsNeedingWalk(steps, [HOME_PAGE, PRODUCTS], "/"), []);
});

test("a step after a click is walked — the route is no longer known (G3.10)", () => {
  // demo-web prompt 14: the plan reaches a product page by CLICKING a tile, so that page was never
  // inspected, and "Add to Cart" matched the home page's featured MacBook instead. A wrong locator is
  // worse than none — codegen's role fallback would have worked.
  const steps = [
    { action: "goto", url: "/" },
    { action: "click", target: "Products" },
    { action: "click", target: "iPhone 15 Pro Max" },
    { action: "click", target: "Add to Cart" },
  ];
  const need = stepsNeedingWalk(steps, [HOME_PAGE, PRODUCTS], "/");
  assert.ok(!need.includes(1), "the first click resolves on the inspected start page");
  assert.ok(
    need.includes(3),
    '"Add to Cart" is on BOTH inspected pages and on neither of them is the plan actually standing — ' +
      "the pooled search would pick by array order"
  );
});

test("a step on a route that was never inspected is walked (G3.10)", () => {
  const steps = [
    { action: "goto", url: "/checkout" },
    { action: "fill", field: "Full Name", value: "Test User" },
  ];
  assert.deepStrictEqual(stepsNeedingWalk(steps, [HOME_PAGE], "/"), [1]);
});

test("an element absent from its own route's inventory is walked (G3.10)", () => {
  // /checkout inspected with an EMPTY cart shows "Your cart is empty" and no form, so the plan's
  // assertions were dropped as "not found" — leaving a 23-step test with nothing to assert.
  const emptyCheckout = {
    url: "http://localhost:5173/checkout",
    headings: [{ role: "heading", name: "Your cart is empty" }],
    buttons: [], links: [], inputs: [], selects: [], checkboxes: [], radios: [],
  };
  const steps = [
    { action: "goto", url: "/checkout" },
    { action: "expectVisible", target: "Full Name" },
  ];
  assert.deepStrictEqual(stepsNeedingWalk(steps, [emptyCheckout], "/"), [1]);
});

test("stepsNeedingWalk ignores steps that resolve no element (G3.10)", () => {
  const steps = [
    { action: "goto", url: "/nowhere" },
    { action: "waitForLoad" },
    { action: "waitFor", timeout: 1000 },
    { action: "screenshot" },
  ];
  assert.deepStrictEqual(stepsNeedingWalk(steps, [HOME_PAGE], "/"), []);
});

/* ─── G4.3: finding the ambiguity history can speak to ─── */

const { findEquallyMatchingRefs } = require("../dist/core/utils/mcp-helpers.js");

test("equally-matching refs are all returned, not just the first (G4.3)", () => {
  // `findBestRefMultiRole` returns the first of these — arbitrary when several are equally good, and
  // that arbitrariness IS the strict-mode failure class.
  const refs = [
    { role: "button", name: "Add to Cart", ref: "a" },
    { role: "button", name: "Add to Cart", ref: "b" },
    { role: "link", name: "Add to Cart", ref: "c" },
  ];
  const hits = findEquallyMatchingRefs(refs, ["button", "link"], "Add to Cart");
  assert.deepStrictEqual(hits.map((h) => h.ref), ["a", "b"], "exact matches in the preferred role only");
});

test("no ambiguity means nothing to choose between (G4.3)", () => {
  const refs = [
    { role: "button", name: "Sign In", ref: "a" },
    { role: "button", name: "Register", ref: "b" },
  ];
  assert.strictEqual(findEquallyMatchingRefs(refs, ["button"], "Sign In").length, 1);
  assert.strictEqual(findEquallyMatchingRefs(refs, ["button"], "Nothing Here").length, 0);
  assert.strictEqual(findEquallyMatchingRefs(refs, ["button"], "").length, 0);
});

test("exact matches beat substring ones before any tie-break (G4.3)", () => {
  const refs = [
    { role: "button", name: "Add to Cart Now", ref: "loose" },
    { role: "button", name: "Add to Cart", ref: "exact" },
  ];
  assert.deepStrictEqual(
    findEquallyMatchingRefs(refs, ["button"], "Add to Cart").map((h) => h.ref),
    ["exact"]
  );
});
