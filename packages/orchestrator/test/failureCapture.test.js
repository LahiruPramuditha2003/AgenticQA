"use strict";
// Offline unit tests for the self-heal failure-capture builder + aria-snapshot parsing (Phase 5).
// The live capture run (Playwright) is owner-validated. Requires a build first (imports from dist/).

const { test } = require("node:test");
const assert = require("node:assert");
const { buildHealCaptureSpec, healTempBase } = require("../dist/core/heal/failureCapture.js");
const { parseAriaSnapshot } = require("../dist/core/utils/healing.js");

/* ─── buildHealCaptureSpec ─── */

const ORIGINAL = [
  `import { test, expect } from '@playwright/test';`,
  ``,
  `test("t", async ({ page }) => {`,
  `  await test.step("STEP_ID=plan-step-1 | goto", async () => {`,
  `    await page.goto('http://localhost:5173/cart');`,
  `  });`,
  `});`,
].join("\n");

test("buildHealCaptureSpec: appends an afterEach capture hook, preserves the original bodies", () => {
  const out = buildHealCaptureSpec(ORIGINAL, "C:\\tmp\\heal\\cap.json");
  // Original test body re-emitted verbatim.
  assert.ok(out.includes(`await page.goto('http://localhost:5173/cart');`), "original step preserved");
  assert.ok(out.includes(`test("t", async ({ page }) => {`), "original test preserved");
  // Capture hook present.
  assert.ok(out.includes("test.afterEach(async ({ page }, testInfo) =>"), "afterEach hook added");
  assert.ok(out.includes("ariaSnapshot()"), "captures an aria snapshot");
  assert.ok(out.includes("if (testInfo.status === 'passed') return;"), "only captures on failure");
  // fs import prepended.
  assert.ok(out.startsWith("import * as __healFs from 'node:fs';"), "fs import prepended");
});

test("buildHealCaptureSpec: embeds the capture path as an escaped JSON literal (Windows-safe)", () => {
  const out = buildHealCaptureSpec(ORIGINAL, "C:\\tmp\\heal\\cap.json");
  // Backslashes must be escaped so the temp spec is valid TS.
  assert.ok(out.includes(`"C:\\\\tmp\\\\heal\\\\cap.json"`), "path embedded as escaped JSON string");
});

test("healTempBase: unique, prefixed, filesystem-safe", () => {
  const a = healTempBase();
  const b = healTempBase();
  assert.ok(a.startsWith("__agenticqa_heal_"));
  assert.notStrictEqual(a, b);
  assert.match(a, /^[\w]+$/);
});

/* ─── parseAriaSnapshot ─── */

test("parseAriaSnapshot: extracts {role,name} from a captured snapshot, skips containers/props", () => {
  const snap = [
    `- banner:`,
    `  - link "TechStore":`,
    `    - /url: /`,
    `- main:`,
    `  - heading "Shopping Cart" [level=1]`,
    `  - heading "Order Summary Details" [level=2]`,
    `  - button "Checkout"`,
    `  - text: some loose text`,
    `- contentinfo:`,
  ].join("\n");

  const refs = parseAriaSnapshot(snap);
  assert.deepStrictEqual(refs, [
    { role: "link", name: "TechStore" },
    { role: "heading", name: "Shopping Cart" },
    { role: "heading", name: "Order Summary Details" },
    { role: "button", name: "Checkout" },
  ]);
});

test("parseAriaSnapshot: unescapes quotes; empty input → []", () => {
  assert.deepStrictEqual(parseAriaSnapshot(""), []);
  const refs = parseAriaSnapshot(`- button "Say \\"hi\\""`);
  assert.deepStrictEqual(refs, [{ role: "button", name: 'Say "hi"' }]);
});

/* ─── G3.9: self-heal must never patch a step that resolves no element ─── */

const { HEALABLE_ACTIONS } = require("../dist/agents/SelfHealAgent/SelfHealAgent.js");

test("navigation and timing steps are not locator-healable (G3.9)", () => {
  // Observed on demo-web prompt 14 (2026-08-11):
  //   patched plan-step-8 — old=page.goto(new URL("/checkout", …)) → new=page.getByRole("link", …)
  // The patched spec no longer parsed, so the verification re-run reported "0 step(s), 0 spec(s)" and the
  // run surfaced as a navigation timeout. Corrupting a spec is strictly worse than declining to heal it.
  for (const a of ["goto", "waitForLoad", "waitFor", "screenshot", "scroll", "evaluate"]) {
    assert.strictEqual(HEALABLE_ACTIONS.has(a), false, `"${a}" resolves no element`);
  }
});

test("element-resolving steps stay healable (G3.9)", () => {
  // The gate must not cost us the heals that work: the same run re-grounded a stale product-page
  // "Add to Cart" testid to page.getByRole("button", { name: "Add to Cart" }).first() — correctly.
  for (const a of ["click", "fill", "select", "check", "hover", "press", "expectVisible", "expectText"]) {
    assert.strictEqual(HEALABLE_ACTIONS.has(a), true, `"${a}" must remain healable`);
  }
});

/* ─── G3.12: a heal must not make the run worse ─── */

const { isPlausibleHealName } = require("../dist/core/utils/mcp-helpers.js");

test("a heal replacement must look like what it replaces (G3.12)", () => {
  // demo-web prompt 14, 2026-08-11: the vector path took the nearest embedding to the stored baseline
  // with no name check at all, and rewrote BOTH "Add to Cart" and "Proceed to Checkout" to
  // getByRole("link", { name: "Shopping Cart" }). The healed spec failed worse than the original — and a
  // heal that makes a run worse destroys the evidence of the real defect.
  assert.strictEqual(isPlausibleHealName("Add to Cart", "Shopping Cart"), false);
  assert.strictEqual(isPlausibleHealName("Proceed to Checkout", "Shopping Cart"), false);
});

test("legitimate re-groundings still pass the check (G3.12)", () => {
  // The guard must not cost the heals that work — this is the real one from the same family of runs.
  assert.strictEqual(isPlausibleHealName("Add to Cart", "Add to Cart"), true);
  assert.strictEqual(isPlausibleHealName("Sign In", "Sign in"), true, "case-insensitive");
  assert.strictEqual(isPlausibleHealName("Email", "Email address"), true, "widened label");
  assert.strictEqual(isPlausibleHealName("Proceed to Checkout", "Checkout"), true, "shortened label");
  assert.strictEqual(isPlausibleHealName(null, "anything"), true, "no intended name -> other guards apply");
});

test("a single shared short word is not a match (G3.12)", () => {
  // "cart" alone linking "Add to Cart" to "Shopping Cart" is exactly the false positive a bare
  // token-overlap test would produce.
  assert.strictEqual(isPlausibleHealName("Add to Cart", "Empty Cart Message"), false);
  assert.strictEqual(isPlausibleHealName("Create Task", "Delete Workspace"), false);
});

/* ─── G5.6: a throwaway run must not delete the real run's report ─── */

const { deriveRunTimeoutMs: _drt } = require("../dist/executor.js");
const fsSync = require("node:fs");
const pathMod = require("node:path");

test("the heal capture run gets its own output directory (G5.6)", () => {
  // ⚠️ Playwright CLEARS its output directory at the start of every run, and `agenticqa-results.json`
  // lives inside `test-results/`. `reporter: "list"` stops the capture run WRITING a report but not from
  // wiping the previous one — so when a heal found no replacement (no patched re-run to regenerate it),
  // the benchmark read nothing and reported the opaque `no-report` instead of the `locator-not-found`
  // that had actually happened. Observed on demo-web prompt 19, 2026-08-11.
  const src = fsSync.readFileSync(
    pathMod.join(__dirname, "..", "src", "core", "heal", "failureCapture.ts"),
    "utf8"
  );
  assert.match(
    src,
    /outputDir:\s*"test-results\/agenticqa-heal-capture"/,
    "captureFailureState must pass its own --output dir"
  );
  assert.match(src, /reporter:\s*"list"/, "and still write no report of its own");
});

test("runPlaywright forwards an output directory when asked (G5.6)", () => {
  const src = fsSync.readFileSync(pathMod.join(__dirname, "..", "src", "executor.ts"), "utf8");
  assert.match(src, /--output=\$\{opts\.outputDir\}/);
});
