"use strict";
// Offline unit tests for the pure self-heal helpers (core/utils/healing.ts). No MCP/DB/network.
// Requires a build first (imports from dist/).

const { test } = require("node:test");
const assert = require("node:assert");
const {
  patchLocatorInStepBlock,
  looksLikeLocatorNotFound,
  stepKeyFromFailedStepId,
  parseTestFileForHealing,
  extractTargetFromLocatorExpr,
  intendedTargetForStep,
  lastGotoUrlBeforeIndex,
  findLocatorExprInStepBlock,
  synthesizeLocator,
  parseAriaSnapshot,
  isAssertionAction,
} = require("../dist/core/utils/healing.js");
const { chooseHealReplacement } = require("../dist/core/utils/mcp-helpers.js");

/* ─── patchLocatorInStepBlock ─── */

test("patch: replaces the click locator in the targeted step only", () => {
  const spec = [
    `import { test, expect } from '@playwright/test';`,
    ``,
    `test("t", async ({ page }) => {`,
    `  await test.step("STEP_ID=plan-step-1 | goto", async () => {`,
    `    await page.goto('http://localhost:5173/auth/login');`,
    `  });`,
    `  await test.step("STEP_ID=plan-step-2 | click", async () => {`,
    `    await page.getByRole('button', { name: 'Sign In', exact: true }).first().click();`,
    `  });`,
    `});`,
    ``,
  ].join("\n");

  const res = patchLocatorInStepBlock(spec, "plan-step-2", "page.getByTestId('signin')");
  assert.ok(res, "patch returned a result");
  assert.strictEqual(
    res.oldLocator,
    "page.getByRole('button', { name: 'Sign In', exact: true }).first()"
  );
  assert.ok(res.patched.includes("await page.getByTestId('signin').click();"), "new locator applied");
  assert.ok(!res.patched.includes("name: 'Sign In'"), "old locator removed");
  assert.ok(
    res.patched.includes("await page.goto('http://localhost:5173/auth/login');"),
    "the other step is untouched"
  );
});

test("patch: replaces an expect(...) assertion locator", () => {
  const spec = [
    `test("t", async ({ page }) => {`,
    `  await test.step("STEP_ID=plan-step-1 | expectVisible", async () => {`,
    `    await expect(page.getByRole('heading', { name: /login/i })).toBeVisible();`,
    `  });`,
    `});`,
  ].join("\n");

  const res = patchLocatorInStepBlock(spec, "plan-step-1", "page.getByText('Login')");
  assert.ok(res);
  assert.strictEqual(res.oldLocator, "page.getByRole('heading', { name: /login/i })");
  assert.ok(res.patched.includes("await expect(page.getByText('Login')).toBeVisible();"));
});

test("patch: F5 — multi-line step body with inner }); patches the right locator", () => {
  // The inner page.evaluate(...) closes with a 4-space `});`. The old naive indexOf("  });")
  // would stop there, before the .click() locator, and fail to patch. The next-step/EOF boundary
  // handles it.
  const spec = [
    `test("t", async ({ page }) => {`,
    `  await test.step("STEP_ID=plan-step-1 | click", async () => {`,
    `    await page.evaluate(() => {`,
    `      window.scrollTo(0, 0);`,
    `    });`,
    `    await page.getByRole('button', { name: 'Old' }).click();`,
    `  });`,
    `});`,
  ].join("\n");

  const res = patchLocatorInStepBlock(spec, "plan-step-1", "page.getByTestId('new')");
  assert.ok(res, "F5: patch succeeds despite inner });");
  assert.strictEqual(res.oldLocator, "page.getByRole('button', { name: 'Old' })");
  assert.ok(res.patched.includes("await page.getByTestId('new').click();"), "click locator patched");
  assert.ok(res.patched.includes("window.scrollTo(0, 0);"), "inner evaluate body preserved");
  assert.ok(!res.patched.includes("name: 'Old'"), "old locator gone");
});

test("patch: plan-step-1 does not match plan-step-10's block", () => {
  const spec = [
    `test("t", async ({ page }) => {`,
    `  await test.step("STEP_ID=plan-step-1 | click", async () => {`,
    `    await page.getByText('First').click();`,
    `  });`,
    `  await test.step("STEP_ID=plan-step-10 | click", async () => {`,
    `    await page.getByText('Tenth').click();`,
    `  });`,
    `});`,
  ].join("\n");

  const res = patchLocatorInStepBlock(spec, "plan-step-1", "page.getByTestId('x')");
  assert.ok(res);
  assert.strictEqual(res.oldLocator, "page.getByText('First')");
  assert.ok(res.patched.includes("await page.getByText('Tenth').click();"), "step 10 untouched");

  const res10 = patchLocatorInStepBlock(spec, "plan-step-10", "page.getByTestId('y')");
  assert.ok(res10);
  assert.strictEqual(res10.oldLocator, "page.getByText('Tenth')");
});

test("patch: unknown step returns null", () => {
  const spec = `test("t", async ({ page }) => {\n  await test.step("STEP_ID=plan-step-1 | click", async () => {\n    await page.getByText('x').click();\n  });\n});`;
  assert.strictEqual(patchLocatorInStepBlock(spec, "plan-step-9", "page.x"), null);
});

/* ─── parseTestFileForHealing ─── */

test("parse: direct goto url + step action map", () => {
  const spec = [
    `test("t", async ({ page }) => {`,
    `  await test.step("STEP_ID=plan-step-1 | goto", async () => {`,
    `    await page.goto('http://localhost:5173/products');`,
    `  });`,
    `  await test.step("STEP_ID=plan-step-2 | fill", async () => {`,
    `    await page.getByLabel('Search').fill('laptop');`,
    `  });`,
    `});`,
  ].join("\n");

  const { gotoUrl, steps } = parseTestFileForHealing(spec);
  assert.strictEqual(gotoUrl, "http://localhost:5173/products");
  assert.strictEqual(steps.get("plan-step-1").action, "goto");
  assert.strictEqual(steps.get("plan-step-2").action, "fill");
});

test("parse: new URL(...).toString() goto url", () => {
  const spec = `await page.goto(new URL("/products", "http://localhost:5173").toString());`;
  const { gotoUrl } = parseTestFileForHealing(spec);
  assert.strictEqual(gotoUrl, "http://localhost:5173/products");
});

/* ─── looksLikeLocatorNotFound ─── */

test("gate: recognizes locator-style failures, rejects assertion mismatches", () => {
  assert.strictEqual(looksLikeLocatorNotFound("Error: element(s) not found"), true);
  assert.strictEqual(looksLikeLocatorNotFound("strict mode violation: resolved to 2 elements"), true);
  assert.strictEqual(looksLikeLocatorNotFound("waiting for getByRole('button')"), true);
  assert.strictEqual(looksLikeLocatorNotFound("Expected: 'A'  Received: 'B'"), false);
  assert.strictEqual(looksLikeLocatorNotFound(""), false);
});

/* ─── stepKeyFromFailedStepId ─── */

test("stepKey: extracts plan-step-N, passes through custom, null on empty", () => {
  assert.strictEqual(stepKeyFromFailedStepId("plan-step-3"), "plan-step-3");
  assert.strictEqual(stepKeyFromFailedStepId("STEP_ID=plan-step-3"), "plan-step-3");
  assert.strictEqual(stepKeyFromFailedStepId("custom-id"), "custom-id");
  assert.strictEqual(stepKeyFromFailedStepId(""), null);
});

/* ─── extractTargetFromLocatorExpr ─── */

test("extractTarget: recovers the human name from locator expressions", () => {
  assert.strictEqual(
    extractTargetFromLocatorExpr("page.getByRole('button', { name: 'Sign In', exact: true })"),
    "Sign In"
  );
  assert.strictEqual(
    extractTargetFromLocatorExpr("page.getByLabel('Email', { exact: false }).first()"),
    "Email"
  );
  assert.strictEqual(
    extractTargetFromLocatorExpr("page.getByPlaceholder('Search products...').first()"),
    "Search products..."
  );
  assert.strictEqual(
    extractTargetFromLocatorExpr("page.getByText('Order Summary', { exact: true }).first()"),
    "Order Summary"
  );
  // testid ids are humanized so their words become matchable tokens.
  assert.strictEqual(
    extractTargetFromLocatorExpr("page.getByTestId('add-to-cart-sony-wh-1000xm5')"),
    "add to cart sony wh 1000xm5"
  );
  assert.strictEqual(
    extractTargetFromLocatorExpr("page.getByRole('heading', { name: /login/i })"),
    "login"
  );
  assert.strictEqual(extractTargetFromLocatorExpr("page.goto('/x')"), null);
});

test("extractTarget + chooseHealReplacement: a humanized testid token-matches a real button name", () => {
  const intended = extractTargetFromLocatorExpr("page.getByTestId('add-to-cart-sony-wh-1000xm5')");
  const refs = [
    { role: "button", name: "Add to Cart", ref: "b1" },
    { role: "link", name: "Products", ref: "b2" },
  ];
  const chosen = chooseHealReplacement(refs, "click", intended, "button");
  assert.ok(chosen, "humanized testid tokens match the 'Add to Cart' button");
  assert.strictEqual(chosen.name, "Add to Cart");
});

/* ─── intendedTargetForStep ─── */

test("intendedTarget: field for fill, target for click, null otherwise", () => {
  assert.strictEqual(intendedTargetForStep({ action: "fill", field: "Email", value: "x" }), "Email");
  assert.strictEqual(intendedTargetForStep({ action: "click", target: "Sign In" }), "Sign In");
  assert.strictEqual(intendedTargetForStep({ action: "goto", url: "/x" }), null);
  assert.strictEqual(intendedTargetForStep(null), null);
});

/* ─── lastGotoUrlBeforeIndex (F3) ─── */

test("lastGotoUrlBeforeIndex: picks the nearest preceding goto in a multi-page flow", () => {
  const steps = [
    { action: "goto", url: "/auth/login" },
    { action: "fill", field: "Email", value: "x" },
    { action: "fill", field: "Password", value: "y" },
    { action: "click", target: "Sign In" },
    { action: "waitFor", timeout: 1500 },
    { action: "waitForLoad" },
    { action: "goto", url: "/account" },
    { action: "expectVisible", target: "Total Orders" },
  ];
  const base = "http://localhost:5173";
  // The failing assertion (index 7) lives on /account, not the first goto /auth/login.
  assert.strictEqual(lastGotoUrlBeforeIndex(steps, 7, base), "http://localhost:5173/account");
  // An earlier step (the Sign In click, index 3) is still on /auth/login.
  assert.strictEqual(lastGotoUrlBeforeIndex(steps, 3, base), "http://localhost:5173/auth/login");
  // "at or before" includes the goto itself.
  assert.strictEqual(lastGotoUrlBeforeIndex(steps, 6, base), "http://localhost:5173/account");
});

test("lastGotoUrlBeforeIndex: keeps absolute urls; null when no preceding goto", () => {
  const steps = [
    { action: "fill", field: "Email", value: "x" },
    { action: "goto", url: "https://example.com/page" },
    { action: "click", target: "X" },
  ];
  assert.strictEqual(lastGotoUrlBeforeIndex(steps, 0, "http://localhost:5173"), null);
  assert.strictEqual(
    lastGotoUrlBeforeIndex(steps, 2, "http://localhost:5173"),
    "https://example.com/page"
  );
});

/* ─── findLocatorExprInStepBlock ─── */

test("findLocatorExprInStepBlock: recovers the current locator without patching", () => {
  const spec = [
    `test("t", async ({ page }) => {`,
    `  await test.step("STEP_ID=plan-step-1 | click", async () => {`,
    `    await page.getByRole('button', { name: 'Sign In' }).first().click();`,
    `  });`,
    `});`,
  ].join("\n");
  assert.strictEqual(
    findLocatorExprInStepBlock(spec, "plan-step-1"),
    "page.getByRole('button', { name: 'Sign In' }).first()"
  );
  assert.strictEqual(findLocatorExprInStepBlock(spec, "plan-step-9"), null);
});

/* ─── chooseHealReplacement (deterministic re-grounding, F2) ─── */

const REFS = [
  { role: "button", name: "Sign In", ref: "e1" },
  { role: "button", name: "Sign Up", ref: "e2" },
  { role: "link", name: "Products", ref: "e3" },
  { role: "textbox", name: "Email", ref: "e4" },
];

test("chooseHealReplacement: exact name match wins (case-insensitive)", () => {
  assert.strictEqual(chooseHealReplacement(REFS, "click", "Sign In", null)?.ref, "e1");
  assert.strictEqual(chooseHealReplacement(REFS, "click", "sign in", null)?.ref, "e1");
  assert.strictEqual(chooseHealReplacement(REFS, "fill", "Email", null)?.ref, "e4");
});

test("chooseHealReplacement: filters candidates by action role", () => {
  // click only considers clickable roles → the Email textbox is never chosen
  assert.strictEqual(chooseHealReplacement(REFS, "click", "Email", null), null);
});

test("chooseHealReplacement: declines a confident-wrong guess among multiple", () => {
  assert.strictEqual(chooseHealReplacement(REFS, "click", "Log In", null), null);
  assert.strictEqual(chooseHealReplacement(REFS, "click", null, null), null);
});

test("chooseHealReplacement: takes the lone candidate when nothing else matches", () => {
  const refs = [{ role: "button", name: "Submit Order", ref: "x1" }];
  assert.strictEqual(chooseHealReplacement(refs, "click", "Completely Different", null)?.ref, "x1");
  assert.strictEqual(chooseHealReplacement(refs, "click", null, null)?.ref, "x1");
});

test("chooseHealReplacement: substring/token fallback picks the closer name", () => {
  const refs = [
    { role: "button", name: "Add to Cart", ref: "a1" },
    { role: "button", name: "Add to Wishlist", ref: "a2" },
  ];
  assert.strictEqual(chooseHealReplacement(refs, "click", "Add to Cart", null)?.ref, "a1");
  assert.strictEqual(chooseHealReplacement(refs, "click", "Wishlist", null)?.ref, "a2");
});

/* ─── synthesizeLocator (capture-based heal, P5.2) ─── */

test("synthesizeLocator: nameable roles → getByRole(name).first()", () => {
  assert.strictEqual(
    synthesizeLocator("heading", "Order Summary Details"),
    `page.getByRole("heading", { name: "Order Summary Details" }).first()`
  );
  assert.strictEqual(
    synthesizeLocator("button", "Add to Cart"),
    `page.getByRole("button", { name: "Add to Cart" }).first()`
  );
  assert.strictEqual(
    synthesizeLocator("textbox", "Email"),
    `page.getByRole("textbox", { name: "Email" }).first()`
  );
});

test("synthesizeLocator: text/unknown roles → getByText().first(); escapes names", () => {
  assert.strictEqual(synthesizeLocator("text", "Some loose text"), `page.getByText("Some loose text").first()`);
  assert.strictEqual(synthesizeLocator("paragraph", "hi"), `page.getByText("hi").first()`);
  assert.strictEqual(synthesizeLocator("button", 'Say "hi"'), `page.getByRole("button", { name: "Say \\"hi\\"" }).first()`);
});

/* ─── capture → choose → synthesize (the P5.3 heal decision, end-to-end pure) ─── */

test("capture heal: renamed 'Order Summary' heading re-grounds (the original cart failure)", () => {
  // The temp re-run captured /cart at failure; the heading was renamed to a shared-token value.
  const aria = [
    `- main:`,
    `  - heading "Shopping Cart" [level=1]`,
    `  - heading "Order Summary Details" [level=2]`,
    `  - button "Checkout"`,
  ].join("\n");
  const refs = parseAriaSnapshot(aria).map((r, i) => ({ ...r, ref: String(i) }));

  // expectVisible step; intended name recovered from the old spec locator = "Order Summary".
  const chosen = chooseHealReplacement(refs, "expectVisible", "Order Summary", null);
  assert.ok(chosen, "found a re-grounding candidate in the captured snapshot");
  assert.strictEqual(chosen.name, "Order Summary Details");
  assert.strictEqual(
    synthesizeLocator(chosen.role, chosen.name),
    `page.getByRole("heading", { name: "Order Summary Details" }).first()`
  );
});

test("isAssertionAction: assertion actions flagged, interactions not", () => {
  for (const a of ["expectVisible", "expectNotVisible", "expectText", "expectCount", "expectAttribute", "expectValue"]) {
    assert.strictEqual(isAssertionAction(a), true, `${a} is an assertion`);
  }
  for (const a of ["click", "fill", "select", "hover", "goto", "waitFor"]) {
    assert.strictEqual(isAssertionAction(a), false, `${a} is not an assertion`);
  }
});

test("capture heal: a click re-grounds to the live button by name", () => {
  const aria = [`- main:`, `  - button "Add to Cart"`, `  - link "Products"`].join("\n");
  const refs = parseAriaSnapshot(aria).map((r, i) => ({ ...r, ref: String(i) }));
  const chosen = chooseHealReplacement(refs, "click", "Add to Cart", "button");
  assert.ok(chosen);
  assert.strictEqual(
    synthesizeLocator(chosen.role, chosen.name),
    `page.getByRole("button", { name: "Add to Cart" }).first()`
  );
});
