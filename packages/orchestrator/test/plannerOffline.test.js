"use strict";
// Offline integration smoke test: planner (mock-LLM mode) → code generation, with NO network.
// Proves the deterministic planner path produces a schema-shaped plan that codegen can render.
// Requires a build first (imports from dist/). Exercises AGENTICQA_MOCK_LLM.

const { test } = require("node:test");
const assert = require("node:assert");

process.env.AGENTICQA_MOCK_LLM = "1"; // force offline deterministic path before requiring engine

const { RagPlannerEngine } = require("../dist/knowledge/RagPlannerEngine.js");
const {
  planToPlaywrightTs,
} = require("../dist/agents/TestScriptGeneratorAgent/tools/planToPlaywright.js");

const silentLogger = { log() {} };

function fixtureCtx(requestText, pageContext) {
  return {
    requestText,
    workspacePath: "/tmp/ws",
    effectiveBaseUrl: "http://localhost:5173",
    effectiveStartUrl: "/",
    pageContext,
  };
}

const PRODUCTS_PAGE = {
  url: "http://localhost:5173/products",
  inputs: [{ role: "textbox", name: "Search products..." }],
  buttons: [{ role: "button", name: "Search" }, { role: "button", name: "Add to Cart" }],
  headings: [{ role: "heading", name: "All Products" }],
  links: [{ role: "link", name: "Products" }],
  selects: [{ role: "combobox", name: "Category" }],
  checkboxes: [],
  radios: [],
  rawSnapshot: "",
};

test("mock-mode planner produces a renderable plan with no network", async () => {
  const engine = new RagPlannerEngine();
  const ctx = fixtureCtx("Search for laptop and verify results appear", PRODUCTS_PAGE);

  const plan = await engine.generate(ctx, silentLogger);

  assert.ok(plan && Array.isArray(plan.testCases) && plan.testCases.length >= 1, "has test cases");
  const tc = plan.testCases[0];
  assert.ok(Array.isArray(tc.steps) && tc.steps.length > 0, "has steps");
  assert.strictEqual(tc.steps[0].action, "goto", "first step is goto");
  assert.ok(
    tc.steps.some((s) => /^expect/.test(s.action)),
    "plan ends with at least one assertion"
  );

  const ts = planToPlaywrightTs({
    plan,
    baseUrl: ctx.effectiveBaseUrl,
    startUrl: "/",
    stepLocators: {},
  });
  assert.match(ts, /import \{ test, expect \} from '@playwright\/test';/);
  assert.ok(ts.includes("await page.goto("), "renders a navigation");
});

test("repairSteps injects a wait after Add to Cart (mock-write race fix)", () => {
  // repairSteps was relocated from the engine into PlanGrounder (Step 4b); test it directly.
  const { repairSteps } = require("../dist/agents/TestPlannerAgent/PlanGrounder.js");
  const steps = repairSteps(
    [
      { action: "goto", url: "/products" },
      { action: "waitForLoad" },
      { action: "click", target: "Add to Cart" },
      { action: "waitForLoad" },
      { action: "goto", url: "/cart" },
    ],
    { buttons: [{ role: "button", name: "Add to Cart" }], links: [], inputs: [], selects: [], headings: [] }
  );
  const clickIdx = steps.findIndex(
    (s) => s.action === "click" && /add to cart/i.test(s.target ?? "")
  );
  assert.ok(clickIdx >= 0, "plan clicks Add to Cart");
  assert.strictEqual(
    steps[clickIdx + 1]?.action,
    "waitFor",
    "a waitFor must follow Add to Cart so the async cart write flushes before navigation"
  );
});

test("mock-mode auth request routes through the login flow", async () => {
  const engine = new RagPlannerEngine();
  const ctx = fixtureCtx("Login with valid credentials", {
    url: "http://localhost:5173/auth/login",
    inputs: [
      { role: "textbox", name: "Email" },
      { role: "textbox", name: "Password" },
    ],
    buttons: [{ role: "button", name: "Sign In" }],
    headings: [],
    links: [{ role: "link", name: "Login" }],
    selects: [],
    checkboxes: [],
    radios: [],
    rawSnapshot: "",
  });

  const plan = await engine.generate(ctx, silentLogger);
  const actions = plan.testCases[0].steps.map((s) => s.action);
  assert.ok(actions.includes("fill"), "login plan fills credentials");
  assert.ok(actions.includes("click"), "login plan clicks sign in");
});
