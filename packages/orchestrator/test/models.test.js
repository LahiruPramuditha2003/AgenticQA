"use strict";
// Offline unit tests for the per-agent model registry (no network/DB). Imports from dist/.

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const {
  resolveModel,
  resolveModelChain,
  registerModelOverrides,
  roleEnvVar,
  DEFAULT_MODELS,
  safetyModel,
  AGENT_ROLES,
} = require("../dist/core/llm/models.js");

// The safety model is provider-dependent, so it is a function now (see modelCatalog.activeProvider).
const SAFETY_MODEL = safetyModel();

// Snapshot + clear every env var the registry reads, so each test starts from a clean slate.
const ENV_KEYS = ["OPENAI_MODEL", ...AGENT_ROLES.map(roleEnvVar)];
let saved = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  registerModelOverrides(undefined);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  registerModelOverrides(undefined);
});

test("nothing set ⇒ built-in DEFAULT_MODELS per role", () => {
  for (const role of AGENT_ROLES) {
    assert.strictEqual(resolveModel(role), DEFAULT_MODELS[role]);
  }
});

test("global OPENAI_MODEL overrides role defaults for EVERY role (back-compat / force-one-model)", () => {
  process.env.OPENAI_MODEL = "vendor/one-model:free";
  for (const role of AGENT_ROLES) {
    assert.strictEqual(resolveModel(role), "vendor/one-model:free");
  }
});

test("per-role env (OPENAI_MODEL_<ROLE>) beats global OPENAI_MODEL", () => {
  process.env.OPENAI_MODEL = "vendor/global:free";
  process.env.OPENAI_MODEL_PLANNER = "vendor/planner:free";
  assert.strictEqual(resolveModel("planner"), "vendor/planner:free");
  assert.strictEqual(resolveModel("domainqa"), "vendor/global:free");
});

test("config override beats per-role env", () => {
  process.env.OPENAI_MODEL_PLANNER = "vendor/from-env:free";
  registerModelOverrides({ planner: "vendor/from-config:free" });
  assert.strictEqual(resolveModel("planner"), "vendor/from-config:free");
});

test("explicit model arg beats everything", () => {
  process.env.OPENAI_MODEL = "vendor/global:free";
  process.env.OPENAI_MODEL_PLANNER = "vendor/env:free";
  registerModelOverrides({ planner: "vendor/config:free" });
  assert.strictEqual(resolveModel("planner", { model: "vendor/explicit:free" }), "vendor/explicit:free");
});

test("resolveModelChain is ordered, primary-first, ending in SAFETY_MODEL", () => {
  process.env.OPENAI_MODEL = "vendor/global:free";
  process.env.OPENAI_MODEL_PLANNER = "vendor/role:free";
  const chain = resolveModelChain("planner");
  assert.deepStrictEqual(chain, [
    "vendor/role:free",
    "vendor/global:free",
    DEFAULT_MODELS.planner,
    SAFETY_MODEL,
  ]);
  assert.strictEqual(chain[0], "vendor/role:free");
  assert.strictEqual(chain[chain.length - 1], SAFETY_MODEL);
});

test("resolveModelChain de-dupes repeated candidates", () => {
  // config override equals the role default ⇒ chain collapses to [default, safety].
  registerModelOverrides({ planner: DEFAULT_MODELS.planner });
  const chain = resolveModelChain("planner");
  assert.deepStrictEqual(chain, [DEFAULT_MODELS.planner, SAFETY_MODEL]);
  assert.strictEqual(new Set(chain).size, chain.length);
});

test("registerModelOverrides ignores unknown keys + empty values; is case-insensitive", () => {
  registerModelOverrides({ bogus: "x", planner: "   ", DOMAINQA: "vendor/qa:free" });
  assert.strictEqual(resolveModel("planner"), DEFAULT_MODELS.planner); // empty value ignored
  assert.strictEqual(resolveModel("domainqa"), "vendor/qa:free"); // case-insensitive key
});

test("registerModelOverrides(undefined) clears prior overrides", () => {
  registerModelOverrides({ planner: "vendor/temp:free" });
  assert.strictEqual(resolveModel("planner"), "vendor/temp:free");
  registerModelOverrides(undefined);
  assert.strictEqual(resolveModel("planner"), DEFAULT_MODELS.planner);
});

test("roleEnvVar maps role → OPENAI_MODEL_<ROLE>", () => {
  assert.strictEqual(roleEnvVar("domainqa"), "OPENAI_MODEL_DOMAINQA");
  assert.strictEqual(roleEnvVar("receptionist"), "OPENAI_MODEL_RECEPTIONIST");
});
