"use strict";
// Offline tests for the .agenticqa.json `models` override block + the ConfigService registration path.

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const { AgenticQaConfigSchema } = require("../dist/config.js");
const {
  registerModelOverrides,
  resolveModel,
  DEFAULT_MODELS,
  AGENT_ROLES,
  roleEnvVar,
} = require("../dist/core/llm/models.js");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { applyModelOverridesFromWorkspace } = require("../dist/core/services/ConfigService.js");

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

test("config schema accepts an optional `models` block", () => {
  const cfg = AgenticQaConfigSchema.parse({
    baseUrl: "http://localhost:5173",
    models: { planner: "vendor/p:free", domainqa: "vendor/q:free" },
  });
  assert.deepStrictEqual(cfg.models, { planner: "vendor/p:free", domainqa: "vendor/q:free" });
});

test("config schema omits `models` when absent", () => {
  const cfg = AgenticQaConfigSchema.parse({ baseUrl: "http://localhost:5173" });
  assert.strictEqual(cfg.models, undefined);
});

test("registered config `models` override per-role env (the ConfigService path)", () => {
  process.env.OPENAI_MODEL_PLANNER = "vendor/env:free";
  const cfg = AgenticQaConfigSchema.parse({
    baseUrl: "http://localhost:5173",
    models: { planner: "vendor/config:free" },
  });
  registerModelOverrides(cfg.models); // what ConfigService.apply does
  assert.strictEqual(resolveModel("planner"), "vendor/config:free");
  // a role not named in the config still falls back to its default
  assert.strictEqual(resolveModel("casual"), DEFAULT_MODELS.casual);
});

test("applyModelOverridesFromWorkspace registers `models` early (Casual/DomainQA path — I1 fix)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aqa-models-"));
  try {
    fs.writeFileSync(
      path.join(dir, ".agenticqa.json"),
      JSON.stringify({
        baseUrl: "http://localhost:5173",
        models: { casual: "vendor/casual:free", domainqa: "vendor/qa:free" },
      })
    );
    await applyModelOverridesFromWorkspace(dir);
    // Before the fix these roles ran before ConfigService registered overrides, so the config was ignored.
    assert.strictEqual(resolveModel("casual"), "vendor/casual:free");
    assert.strictEqual(resolveModel("domainqa"), "vendor/qa:free");
    assert.strictEqual(resolveModel("planner"), DEFAULT_MODELS.planner); // unspecified role unchanged
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("applyModelOverridesFromWorkspace clears overrides when config is absent/invalid", async () => {
  registerModelOverrides({ casual: "vendor/stale:free" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aqa-nomodels-"));
  try {
    await applyModelOverridesFromWorkspace(dir); // no .agenticqa.json present
    assert.strictEqual(resolveModel("casual"), DEFAULT_MODELS.casual);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
