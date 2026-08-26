"use strict";
// Offline unit tests for LlmClient model-chain execution (no real network — global fetch stubbed).

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const { LlmClient } = require("../dist/core/llm/LlmClient.js");
const { DEFAULT_MODELS, safetyModel, AGENT_ROLES, roleEnvVar } = require("../dist/core/llm/models.js");

// NOT captured at module load. The safety model is provider-dependent and these tests clear/restore
// OPENAI_BASE_URL, so a value frozen up here would disagree with the (lazy) DEFAULT_MODELS proxy —
// exactly the staleness the proxy exists to avoid.
const SAFETY = () => safetyModel();

const ENV_KEYS = ["OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_BASE_URL", ...AGENT_ROLES.map(roleEnvVar)];
let saved = {};
let origFetch;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  origFetch = globalThis.fetch;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  globalThis.fetch = origFetch;
});

/** Stub fetch: record requested models; fail for any model in `failFor`, else return its name. */
function stubFetch(failFor) {
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const model = JSON.parse(init.body).model;
    calls.push(model);
    if (failFor.has(model)) {
      return { ok: false, status: 503, statusText: "overloaded", text: async () => "model down" };
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: `OK from ${model}` } }] }) };
  };
  return calls;
}

test("chat walks the fallback chain, advancing past a failing primary model", async () => {
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.OPENAI_MODEL = "vendor/global:free";
  process.env.OPENAI_MODEL_RECEPTIONIST = "vendor/down:free";
  // receptionist chain = [down, global, DEFAULT.receptionist, safety]; down fails, global succeeds.
  const calls = stubFetch(new Set(["vendor/down:free"]));

  const client = new LlmClient({ role: "receptionist" });
  const out = await client.chat([{ role: "user", content: "hi" }], { retries: 0 });

  assert.strictEqual(out, "OK from vendor/global:free");
  assert.strictEqual(calls[0], "vendor/down:free");
  assert.strictEqual(calls[1], "vendor/global:free");
});

test("chat falls through to the safety model when everything else is down", async () => {
  process.env.OPENAI_API_KEY = "sk-test";
  // casual chain = [DEFAULT.casual, safety]; only the safety model answers.
  const calls = stubFetch(new Set([DEFAULT_MODELS.casual]));

  const client = new LlmClient({ role: "casual" });
  const out = await client.chat([{ role: "user", content: "hi" }], { retries: 0 });

  assert.strictEqual(out, `OK from ${SAFETY()}`);
  assert.strictEqual(calls[0], DEFAULT_MODELS.casual);
  assert.strictEqual(calls[calls.length - 1], SAFETY());
});

test("no role ⇒ single model (back-compat), no fallback chain", async () => {
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.OPENAI_MODEL = "vendor/only:free";
  const calls = stubFetch(new Set(["vendor/only:free"])); // it fails

  const client = new LlmClient();
  await assert.rejects(() => client.chat([{ role: "user", content: "x" }], { retries: 0 }));
  assert.deepStrictEqual(calls, ["vendor/only:free"]); // tried exactly once, no fallback
});

test("isConfigured: role makes a client configured even without OPENAI_MODEL", () => {
  process.env.OPENAI_API_KEY = "sk-test";
  // no OPENAI_MODEL, no role ⇒ not configured
  assert.strictEqual(new LlmClient().isConfigured(), false);
  // role ⇒ resolves to DEFAULT_MODELS[role] ⇒ configured
  assert.strictEqual(new LlmClient({ role: "casual" }).isConfigured(), true);
});

test("isConfigured: no API key ⇒ never configured", () => {
  delete process.env.OPENAI_API_KEY;
  assert.strictEqual(new LlmClient({ role: "planner" }).isConfigured(), false);
});
