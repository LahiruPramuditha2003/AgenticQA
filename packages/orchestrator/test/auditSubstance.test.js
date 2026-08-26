"use strict";
/**
 * Offline unit tests for the spec-substance auditor (G1.3b / defect D13).
 *
 * The auditor exists because Playwright pass/fail cannot tell a real generated test from a hollow one:
 * the held-out TaskFlow benchmark read 19/20 while ~1/20 tested what was asked.
 *
 * Half of these tests are FALSE-POSITIVE GUARDS. Two earlier heuristics had to be withdrawn after they
 * scored the known-good demo-web suite at 0/20, and a third mis-read the English verb "select". A metric
 * that cries wolf is as useless as one that never does, so those cases are locked here.
 *
 * Plain Node scripts — no build required.
 */

const { test } = require("node:test");
const assert = require("node:assert");

const {
  auditSpecSubstance,
  summarizeSubstance,
  parseSteps,
  parseGotoPaths,
  parseAssertionTargets,
  expectedInteractions,
} = require("../scripts/auditSpecSubstance");

/** Build a spec body from `[action, code]` pairs, matching real codegen's STEP_ID markers. */
function spec(steps) {
  const body = steps
    .map(
      ([action, code], i) =>
        `  await test.step("STEP_ID=plan-step-${i + 1} | ${action}", async () => {\n    ${code}\n  });`
    )
    .join("\n");
  return `import { test, expect } from '@playwright/test';\ntest("t", async ({ page }) => {\n${body}\n});\n`;
}

const GOTO_ROOT = ["goto", `await page.goto(new URL("/", "http://localhost:5174").toString());`];
const WAIT = ["waitForLoad", `await page.waitForLoadState('networkidle');`];

/* ─── parsing helpers ─── */

test("parseSteps reads the ordered STEP_ID action markers", () => {
  const s = spec([GOTO_ROOT, WAIT, ["click", "await page.getByRole('link').click();"]]);
  assert.deepStrictEqual(
    parseSteps(s).map((x) => x.action),
    ["goto", "waitForLoad", "click"]
  );
});

test("parseGotoPaths handles both the new URL(...) and literal forms", () => {
  assert.deepStrictEqual(parseGotoPaths(spec([GOTO_ROOT])), ["/"]);
  const literal = spec([["goto", `await page.goto("http://x/projects");`]]);
  assert.deepStrictEqual(parseGotoPaths(literal), ["/projects"]);
});

test("parseAssertionTargets reads only inside expect(...), not action locators", () => {
  const s = spec([
    ["click", `await page.getByRole('link', { name: 'Add Task' }).click();`],
    ["expectVisible", `await expect(page.getByRole('heading', { name: 'Create Task' })).toBeVisible();`],
  ]);
  assert.deepStrictEqual(parseAssertionTargets(s), ["Create Task"]);
});

test("expectedInteractions maps prompt phrasing to required interactions", () => {
  assert.deepStrictEqual(expectedInteractions("enter your email and click Sign in"), ["fill", "click"]);
  assert.deepStrictEqual(expectedInteractions("set the Status dropdown to Paused"), ["select"]);
  assert.deepStrictEqual(expectedInteractions("tick the Bug checkbox"), ["check"]);
  assert.deepStrictEqual(expectedInteractions("verify the heading is visible"), []);
});

/* ─── verdicts ─── */

test("VACUOUS: a spec with no assertions cannot fail", () => {
  const s = spec([GOTO_ROOT, WAIT, ["select", `await page.getByLabel('Category').selectOption('X');`]]);
  const a = auditSpecSubstance({ specSource: s, prompt: "filter by category X from the dropdown" });
  assert.strictEqual(a.verdict, "VACUOUS");
  assert.strictEqual(a.assertions, 0);
});

test("UNDER_TESTED: prompt demands a fill the spec never performs", () => {
  // The dominant TaskFlow failure: "sign in with <creds>" became goto + click + assert.
  const s = spec([
    GOTO_ROOT,
    WAIT,
    ["click", `await page.getByRole('link', { name: 'TaskFlow' }).click();`],
    ["expectVisible", `await expect(page.getByRole('heading', { name: 'Your Work' })).toBeVisible();`],
  ]);
  const a = auditSpecSubstance({
    specSource: s,
    prompt: "Go to the sign in page, enter ada@taskflow.test and Taskflow123!, click Sign in, and verify Your Work loads",
  });
  assert.strictEqual(a.verdict, "UNDER_TESTED");
  assert.deepStrictEqual(a.missing, ["fill"]);
});

test("OFF_TARGET: never leaves the start page and asserts something unrelated", () => {
  const s = spec([
    GOTO_ROOT,
    WAIT,
    ["expectVisible", `await expect(page.getByRole('heading', { name: 'Your Work' })).toBeVisible();`],
  ]);
  const a = auditSpecSubstance({
    specSource: s,
    prompt: "Open the Team page and verify the members table lists Ada Lovelace and Grace Hopper",
  });
  assert.strictEqual(a.verdict, "OFF_TARGET");
});

test("SUBSTANTIVE: does the asked-for work and asserts an outcome", () => {
  const s = spec([
    ["goto", `await page.goto(new URL("/login", "http://x").toString());`],
    ["fill", `await page.getByLabel('Email').fill("ada@taskflow.test");`],
    ["fill", `await page.getByLabel('Password').fill("Taskflow123!");`],
    ["click", `await page.getByRole('button', { name: 'Sign in' }).click();`],
    ["expectVisible", `await expect(page.getByText("Signed in as Ada Lovelace")).toBeVisible();`],
  ]);
  const a = auditSpecSubstance({
    specSource: s,
    prompt: "enter ada@taskflow.test and Taskflow123!, click Sign in, verify Signed in as Ada Lovelace",
  });
  assert.strictEqual(a.verdict, "SUBSTANTIVE");
  assert.strictEqual(a.interactions, 3);
});

/* ─── false-positive guards (each of these was a real mis-scoring) ─── */

test("GUARD: a pack-aliased assertion is not penalised for paraphrasing the prompt", () => {
  // demo-web maps "verify a welcome message" onto the real anchor "Total Orders" via assertionAliases.
  // An early rule required the assertion target to appear in the prompt and scored the whole suite 0/20.
  const s = spec([
    ["goto", `await page.goto(new URL("/auth/login", "http://x").toString());`],
    ["fill", `await page.getByLabel('Email').fill("customer@example.com");`],
    ["fill", `await page.getByLabel('Password').fill("password123");`],
    ["click", `await page.getByRole('button', { name: 'Sign In' }).click();`],
    ["expectVisible", `await expect(page.getByText("Total Orders", { exact: true })).toBeVisible();`],
  ]);
  const a = auditSpecSubstance({
    specSource: s,
    prompt: "Go to login page, enter customer@example.com and password123, click Sign In, and verify the user is redirected to the account page with a welcome message.",
  });
  assert.strictEqual(a.verdict, "SUBSTANTIVE", `paraphrase must not be flagged (was ${a.reason})`);
});

test('GUARD: "select Logout" means click a menu item, not operate a <select>', () => {
  const s = spec([
    ["goto", `await page.goto(new URL("/auth/login", "http://x").toString());`],
    ["fill", `await page.getByLabel('Email').fill("a@b.c");`],
    ["click", `await page.getByRole('button', { name: 'Logout' }).click();`],
    ["expectVisible", `await expect(page.getByRole('link', { name: 'Login' })).toBeVisible();`],
  ]);
  const a = auditSpecSubstance({
    specSource: s,
    prompt: "Login as a user, click user menu in navbar, select Logout, and verify navbar shows Login link.",
  });
  assert.strictEqual(a.verdict, "SUBSTANTIVE", `bare verb "select" must not demand a dropdown (was ${a.reason})`);
});

test("GUARD: a navigation-only prompt with no interactions is legitimate", () => {
  // "Navigate directly to /checkout … verify the warning" correctly has zero interactions.
  const s = spec([
    ["goto", `await page.goto(new URL("/checkout", "http://x").toString());`],
    WAIT,
    ["expectVisible", `await expect(page.getByText("Your cart is empty")).toBeVisible();`],
  ]);
  const a = auditSpecSubstance({
    specSource: s,
    prompt: "Navigate directly to /checkout with an empty cart and verify the user is redirected back to the cart page with a warning message.",
    startPath: "/",
  });
  assert.strictEqual(a.verdict, "SUBSTANTIVE", `off-start navigation is real work (was ${a.reason})`);
});

test("GUARD: with no prompt supplied, relevance is not judged", () => {
  const s = spec([GOTO_ROOT, ["expectVisible", `await expect(page.getByText("Anything")).toBeVisible();`]]);
  assert.strictEqual(auditSpecSubstance({ specSource: s }).verdict, "SUBSTANTIVE");
});

/* ─── rollup ─── */

test("summarizeSubstance counts verdicts", () => {
  const out = summarizeSubstance([
    { verdict: "SUBSTANTIVE" },
    { verdict: "SUBSTANTIVE" },
    { verdict: "UNDER_TESTED" },
    { verdict: "VACUOUS" },
  ]);
  assert.strictEqual(out.total, 4);
  assert.strictEqual(out.SUBSTANTIVE, 2);
  assert.strictEqual(out.UNDER_TESTED, 1);
  assert.strictEqual(out.VACUOUS, 1);
});
