"use strict";
/**
 * The L1 guard: engine code must not know any particular app's vocabulary (G3).
 *
 * Limitation L1 was ~40 demo-web literals spread across generic modules — routes like `/products` and
 * `/admin`, product categories, and assertion strings like "Total Orders". They made the engine score
 * 100% on the app it was written for and misfire on every other one: on the held-out app they sent
 * pre-inspection to 404s, leaving the planner with **0 inputs and 0 buttons for the whole application**.
 *
 * This test is what stops them coming back. It reads SOURCE, not `dist`, and strips comments first —
 * the files legitimately *discuss* the deleted literals so nobody reinstates them.
 *
 * If this fails, the fix is almost never to widen the allowlist. It is to take the knowledge from the
 * app's knowledge pack (`routes`, `goldenFlows`, `assertionAliases`, `stableElements`) or from the live
 * page inventory, both of which every one of these modules already has access to.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");

/** demo-web's vocabulary: its routes, its product categories, its on-page copy. */
const APP_LITERALS = [
  "/products", "/cart", "/checkout", "/auth/login", "/auth/register", "/auth/forgot-password",
  "/account", "/admin",
  "smartphones", "laptops", "wearables", "techstore",
  "total orders", "order summary", "all products", "add to cart",
  "invalid email or password", "your cart is empty", "passwords do not match",
  "customer@example.com", "admin@techstore.com",
];

/**
 * Modules that must stay app-agnostic. Each is generic machinery reachable by every app.
 *
 * `allow` documents a deliberate, measured exception. Only one remains, and it is bounded:
 * `planToPlaywright`'s name lists are consulted **only** when the live page inventory did not report an
 * element's role. G3.4 gave codegen the real roles (`roleByName`), which take precedence; an attempt to
 * replace the lists with a smarter *guess* instead was measured and reverted — it reclassified 40 of 48
 * demo-web specs, turning real headings into `getByRole('link')`. The way to empty this allowance is to
 * make the role map cover more elements, not to invent a better heuristic.
 */
const GUARDED = [
  { file: "core/inspection/RouteIntentResolver.ts", allow: [] },
  { file: "agents/TestPlannerAgent/PlanGrounder.ts", allow: [] },
  { file: "agents/TestPlannerAgent/ScenarioPlanner.ts", allow: [] },
  { file: "agents/UiInspectorAgent/UiInspectorAgent.ts", allow: [] },
  { file: "core/inspection/PageInventory.ts", allow: [] },
  { file: "core/explore/synthesizeFlows.ts", allow: [] },
  { file: "core/explore/Crawler.ts", allow: [] },
  { file: "core/knowledge/FlowIndex.ts", allow: [] },
  { file: "core/knowledge/AppKnowledgePack.ts", allow: [] },
  {
    file: "agents/TestScriptGeneratorAgent/tools/planToPlaywright.ts",
    allow: ["/products", "add to cart", "all products"],
  },
];

/** Source with block comments and whole-line `//` comments removed. */
function codeOf(relPath) {
  const full = path.join(SRC, relPath);
  const raw = fs.readFileSync(full, "utf8");
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n")
    .toLowerCase();
}

for (const { file, allow } of GUARDED) {
  test(`no app literals in ${file}`, () => {
    const code = codeOf(file);
    const found = APP_LITERALS.filter(
      (lit) => code.includes(lit.toLowerCase()) && !allow.includes(lit)
    );
    assert.deepStrictEqual(
      found,
      [],
      `${file} names ${found.join(", ")}. Read this file's header: take it from the knowledge pack ` +
        `(routes / goldenFlows / assertionAliases / stableElements) or from the live page inventory.`
    );
  });
}

test("the allowlist itself does not grow silently", () => {
  // One bounded exception (see GUARDED). A second one should be a conscious decision, not a drift.
  const total = GUARDED.reduce((n, g) => n + g.allow.length, 0);
  assert.ok(total <= 3, `app-literal allowances grew to ${total}; justify each one in GUARDED`);
  assert.strictEqual(
    GUARDED.filter((g) => g.allow.length > 0).length,
    1,
    "only planToPlaywright's page-role fallback may hold app literals"
  );
});
