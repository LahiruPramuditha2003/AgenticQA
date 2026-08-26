"use strict";
/**
 * Anti-drift guards for the ONE model catalog, now multi-provider (G2.7b, extended for NVIDIA NIM).
 *
 * Model IDs used to be written out in four places kept in sync by a checklist. A dead ID does not
 * announce itself — `resolveModelChain` falls through to the next model, so a run *succeeds* while
 * quietly using something other than what was configured. These tests make the single-source rule
 * mechanical instead of aspirational.
 *
 * Requires a build (imports from dist/).
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  PROVIDERS,
  AGENT_ROLES,
  CATALOG_VERIFIED_ON,
  providerForBaseUrl,
  activeProvider,
  defaultModelsFor,
  safetyModelFor,
  chatModelsFor,
  embedModelsFor,
  defaultEmbedModelFor,
  isFreeModelId,
  allCatalogModelIds,
  DEFAULT_MODELS,
} = require("../dist/core/llm/modelCatalog.js");
const { EMBEDDING_DIM } = require("../dist/core/db/db.js");

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const PROVIDER_IDS = Object.keys(PROVIDERS);

test("every provider defines a model for every role, drawn from its own chat list", () => {
  for (const p of PROVIDER_IDS) {
    const defaults = defaultModelsFor(p);
    for (const role of AGENT_ROLES) {
      const id = defaults[role];
      assert.ok(id, `${p}: role ${role} has no default`);
      assert.ok(
        chatModelsFor(p).includes(id),
        `${p}: defaults.${role} = "${id}" is not in that provider's chatModels — either it is dead ` +
          `(change the default) or the list is stale (add it). Both live in modelCatalog.ts.`
      );
    }
    assert.ok(chatModelsFor(p).includes(safetyModelFor(p)), `${p}: safety model must be a listed model`);
  }
});

test("provider detection keys off the base URL, and defaults to OpenRouter", () => {
  assert.strictEqual(providerForBaseUrl("https://integrate.api.nvidia.com/v1"), "nvidia");
  assert.strictEqual(providerForBaseUrl("https://openrouter.ai/api/v1"), "openrouter");
  assert.strictEqual(providerForBaseUrl(undefined), "openrouter", "unconfigured behaves as before");
  assert.strictEqual(providerForBaseUrl(""), "openrouter");
});

test("the active provider is read LAZILY, not frozen at import time", () => {
  // main.ts runs dotenv.config() AFTER its imports (ES imports hoist), so anything resolved at module
  // load would see an empty OPENAI_BASE_URL and silently pick the wrong provider.
  const saved = process.env.OPENAI_BASE_URL;
  try {
    process.env.OPENAI_BASE_URL = "https://integrate.api.nvidia.com/v1";
    assert.strictEqual(activeProvider(), "nvidia");
    assert.strictEqual(DEFAULT_MODELS.planner, PROVIDERS.nvidia.defaults.planner,
      "DEFAULT_MODELS must follow the active provider");

    process.env.OPENAI_BASE_URL = "https://openrouter.ai/api/v1";
    assert.strictEqual(activeProvider(), "openrouter");
    assert.strictEqual(DEFAULT_MODELS.planner, PROVIDERS.openrouter.defaults.planner);
  } finally {
    if (saved === undefined) {delete process.env.OPENAI_BASE_URL;} else {process.env.OPENAI_BASE_URL = saved;}
  }
});

test("free-ness is provider-specific", () => {
  // `:free` is an OpenRouter convention. Applying it to NVIDIA would flag every legitimate ID as paid.
  assert.ok(isFreeModelId("openai/gpt-oss-20b:free", "openrouter"));
  assert.ok(!isFreeModelId("openai/gpt-oss-120b", "openrouter"));
  assert.ok(isFreeModelId("openai/gpt-oss-120b", "nvidia"), "NVIDIA's hosted catalog is one credit pool");
  assert.ok(!isFreeModelId("", "nvidia"));
});

test("no provider still defaults to a RETIRED embedding model", () => {
  // 2026-08-22: `npm run probe:models` found NVIDIA's default returning `410 Gone — reached its end of
  // life`. Individually probing every embedding id this project had ever named showed nv-embed-v1,
  // nv-embedcode-7b-v1, nv-embedqa-e5-v5, bge-m3 and llama-3.2-nv-embedqa-1b-v2 were ALL retired;
  // `nemotron-3-embed-1b` is the only listed one that still serves.
  //
  // This test cannot check liveness — that needs a network, and `probe:models` is the live check. What
  // it CAN do is stop a known-dead id being reintroduced by a copy-paste or a revert.
  const RETIRED = [
    "nvidia/nv-embed-v1",
    "nvidia/nv-embedcode-7b-v1",
    "nvidia/nv-embedqa-e5-v5",
    "nvidia/llama-3.2-nv-embedqa-1b-v2",
    "baai/bge-m3",
  ];
  for (const p of PROVIDER_IDS) {
    assert.ok(
      !RETIRED.includes(defaultEmbedModelFor(p)),
      `${p} defaults to ${defaultEmbedModelFor(p)}, which is retired (410 Gone). Re-probe and pick a live one.`
    );
    for (const id of embedModelsFor(p)) {
      assert.ok(!RETIRED.includes(id), `${p} still offers the retired embedding model ${id}`);
    }
  }
});

test("NVIDIA's embedding default no longer matches EMBEDDING_DIM — and that is a known degrade", () => {
  // This used to assert the OPPOSITE: that NVIDIA's 4096-dim models matched EMBEDDING_DIM so no database
  // reset was needed. That invariant died with the models (see above). The replacement is 2048-dim.
  //
  // The consequence is bounded and already handled, which is why shipping it is correct:
  //   • DB OFF (the default): full function — in-memory ranking is dimension-agnostic.
  //   • DB ON: the dimension probe sets ctx.embeddingDimOk = false and disables the DB vector path with
  //     an explanatory log. Run history and DETERMINISTIC self-heal keep working.
  // A degraded vector path beats a dead embedding model, which is what the old default now is.
  assert.strictEqual(EMBEDDING_DIM, 4096, "the DB schema hardcodes vector(EMBEDDING_DIM)");
  assert.strictEqual(defaultEmbedModelFor("nvidia"), "nvidia/nemotron-3-embed-1b");
  assert.ok(embedModelsFor("nvidia").includes("nvidia/nemotron-3-embed-1b"));
});

test("OpenRouter offers only OpenRouter-hosted embedding ids", () => {
  // NVIDIA-hosted ids with a `:free` suffix had been copy-pasted into OpenRouter's list; they would 404
  // on that endpoint. A wrong id in a picker is worse than a short picker.
  for (const id of embedModelsFor("openrouter")) {
    assert.ok(
      !id.endsWith(":free") || !id.startsWith("nvidia/"),
      `${id} is an NVIDIA-hosted id offered under OpenRouter`
    );
  }
});

test("chat and embedding lists never overlap", () => {
  for (const p of PROVIDER_IDS) {
    for (const id of embedModelsFor(p)) {
      assert.ok(!chatModelsFor(p).includes(id), `${p}: ${id} is an embedding model offered for chat`);
    }
  }
});

test("no duplicate IDs within a provider's list", () => {
  for (const p of PROVIDER_IDS) {
    for (const [name, list] of [["chatModels", chatModelsFor(p)], ["embedModels", embedModelsFor(p)]]) {
      assert.strictEqual(new Set(list).size, list.length, `${p}.${name} contains duplicates`);
    }
  }
});

test("CATALOG_VERIFIED_ON is a plausible ISO date", () => {
  assert.match(CATALOG_VERIFIED_ON, /^\d{4}-\d{2}-\d{2}$/);
});

test(".env.example names no model the catalog does not know", () => {
  // `.env.example` is a text file and cannot import, so it is the one place that can still drift.
  // On 2026-08-09 it shipped `openai/gpt-oss-120b:free`, long dead.
  const txt = fs.readFileSync(path.join(repoRoot, "packages", "orchestrator", ".env.example"), "utf8");
  const known = new Set(allCatalogModelIds());
  // `[^\s#]+` and the `$` anchor keep an EMPTY override line (`#OPENAI_MODEL=`) from swallowing the
  // next line's comment marker as if it were a model id.
  for (const line of txt.match(/^[ \t]*#?[ \t]*OPENAI_(?:MODEL|EMBED_MODEL)[A-Z_]*[ \t]*=[ \t]*[^\s#]+[ \t]*$/gm) ?? []) {
    const id = line.split("=")[1].trim();
    if (!id || id.startsWith("<") || /your[_-]?key/i.test(id)) {continue;}
    assert.ok(
      known.has(id),
      `.env.example sets a model "${id}" that modelCatalog.ts does not list. A dead ID here fails only ` +
        `at runtime, as a 404 mid-run.`
    );
  }
});

test(".env.example documents both providers' base URLs", () => {
  const txt = fs.readFileSync(path.join(repoRoot, "packages", "orchestrator", ".env.example"), "utf8");
  for (const p of PROVIDER_IDS) {
    assert.ok(txt.includes(PROVIDERS[p].baseUrl), `.env.example should show ${p}'s base URL`);
  }
});

test("the extension derives model IDs and does not hardcode its own copies", () => {
  for (const rel of [
    "packages/agenticqa/src/config/freeModels.ts",
    "packages/agenticqa/src/views/SettingsViewProvider.ts",
  ]) {
    const txt = fs.readFileSync(path.join(repoRoot, rel), "utf8");
    const code = txt.replace(/\/\*[\s\S]*?\*\//g, "").split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
    const literals = (code.match(/"[\w.\-/]+\/[\w.\-]+(?::free)?"/g) ?? [])
      .filter((m) => /nvidia|openai|google|qwen|poolside|cohere|inclusionai|minimax|z-ai/i.test(m));
    assert.deepStrictEqual(
      literals, [],
      `${rel} hardcodes model ID(s) ${literals.join(", ")} — import them from modelCatalog.ts instead.`
    );
  }
});

/* ─── API keys (the bug that made an nvapi- key kill the orchestrator) ─── */

const { isPlaceholderApiKey, looksLikeProviderKey, keyHintFor, allKeyPrefixes } =
  require("../dist/core/llm/modelCatalog.js");
const { ConfigValidator } = require("../dist/core/services/ConfigValidator.js");

test("every provider declares a key prefix and a hint", () => {
  for (const p of PROVIDER_IDS) {
    assert.ok(PROVIDERS[p].keyPrefixes.length, `${p} has no key prefix`);
    assert.ok(keyHintFor(p).length, `${p} has no key hint`);
  }
  assert.ok(allKeyPrefixes().includes("sk-"));
  assert.ok(allKeyPrefixes().includes("nvapi-"));
});

test("bare provider prefixes and placeholders count as 'no key set'", () => {
  for (const v of ["", "   ", "sk-", "sk-or-v1-", "nvapi-", "nvapi-YOUR_KEY_HERE"]) {
    assert.ok(isPlaceholderApiKey(v), `"${v}" should read as unset`);
  }
  assert.ok(!isPlaceholderApiKey("nvapi-abc123realkey"));
  assert.ok(!isPlaceholderApiKey("sk-or-v1-abc123realkey"));
});

test("looksLikeProviderKey is provider-specific", () => {
  assert.ok(looksLikeProviderKey("nvapi-abc", "nvidia"));
  assert.ok(!looksLikeProviderKey("nvapi-abc", "openrouter"));
  assert.ok(looksLikeProviderKey("sk-or-v1-abc", "openrouter"));
  assert.ok(!looksLikeProviderKey("", "nvidia"));
});

test("REGRESSION: an nvapi- key must NOT be a fatal config error", () => {
  // `main.ts` calls process.exit(1) on any validation ERROR. The key check was `startsWith("sk-")` and
  // pushed an error, so configuring a valid NVIDIA key killed the orchestrator before the pipeline ran —
  // while a stale pack on disk made the wrapper script report success. Format guesses must be warnings.
  const saved = { k: process.env.OPENAI_API_KEY, b: process.env.OPENAI_BASE_URL };
  try {
    process.env.OPENAI_API_KEY = "nvapi-abc123realkeyvalue";
    process.env.OPENAI_BASE_URL = "https://integrate.api.nvidia.com/v1";
    const res = ConfigValidator.validateEnv({ log() {}, error() {} });
    assert.deepStrictEqual(
      res.errors.filter((e) => /API_KEY/i.test(e)), [],
      "a valid NVIDIA key must raise no ERROR"
    );

    // A genuinely mismatched key still warns — helpful, but never fatal.
    process.env.OPENAI_API_KEY = "sk-or-v1-abc123realkeyvalue";
    const mismatch = ConfigValidator.validateEnv({ log() {}, error() {} });
    assert.deepStrictEqual(mismatch.errors.filter((e) => /API_KEY/i.test(e)), []);
    assert.ok(
      mismatch.warnings.some((w) => /does not look like/i.test(w)),
      "a key that doesn't match the configured provider should warn"
    );
  } finally {
    if (saved.k === undefined) {delete process.env.OPENAI_API_KEY;} else {process.env.OPENAI_API_KEY = saved.k;}
    if (saved.b === undefined) {delete process.env.OPENAI_BASE_URL;} else {process.env.OPENAI_BASE_URL = saved.b;}
  }
});
