/**
 * THE model catalog — the ONE place model IDs are written down, for every supported provider.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *  ⚠️  EDIT THIS FILE AND ONLY THIS FILE when model IDs change.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `core/llm/models.ts` (resolution + fallback chains), the extension's model pickers
 * (`config/freeModels.ts`) and the Settings placeholders (`views/SettingsViewProvider.ts`) all derive
 * from here. `test/modelCatalog.test.js` enforces it, including that `.env.example` — a text file, so it
 * cannot import — names no model this file does not know.
 *
 * PROVIDERS
 * ---------
 * Both supported providers speak the OpenAI wire format, so switching is configuration, not code:
 * set `OPENAI_BASE_URL` + `OPENAI_API_KEY` and the right model IDs follow from here.
 *
 *  - **OpenRouter** (`https://openrouter.ai/api/v1`) — free tier is a **daily request cap**; free IDs
 *    carry a `:free` suffix. Those IDs rot: on 2026-08-09 three defaults had silently become paid-only.
 *  - **NVIDIA NIM** (`https://integrate.api.nvidia.com/v1`) — free tier is a **credit pool** (~1000) plus
 *    40 req/min, keys look like `nvapi-…`, and IDs carry **no** suffix. Hosts the Nemotron family this
 *    project already preferred, plus `gpt-oss-*`.
 *
 * ⚠️ **A dead ID does not look like a failure.** `resolveModelChain` falls through to the next model, so
 * a run *succeeds* while quietly using something other than what you configured. Read the log for
 * "model … failed" before theorising. `npm run probe:models` checks every role against the live key.
 *
 * HOW TO RE-VERIFY an ID: one-token request. `404` → dead. `429` → alive, quota spent.
 */

/** When these IDs were last checked. Update whenever you re-verify. */
export const CATALOG_VERIFIED_ON = "2026-08-10";

export type AgentRole =
  | "planner"
  | "domainqa"
  | "selfheal"
  | "reporter"
  | "receptionist"
  | "casual"
  | "explorer"
  | "packgen";

export const AGENT_ROLES: AgentRole[] = [
  "planner",
  "domainqa",
  "selfheal",
  "reporter",
  "receptionist",
  "casual",
  "explorer",
  "packgen",
];

export type Provider = "openrouter" | "nvidia";

export interface ProviderCatalog {
  id: Provider;
  label: string;
  baseUrl: string;
  /** Chat models usable on the provider's free tier, roughly strongest first. */
  chatModels: string[];
  /** Embedding models. ⚠️ Dimension must equal `EMBEDDING_DIM` (4096) or the DB vector path shuts off. */
  embedModels: string[];
  defaultEmbedModel: string;
  /** Universal last-resort model appended to every fallback chain. */
  safetyModel: string;
  defaults: Record<AgentRole, string>;
  /** Does this ID cost nothing on this provider? */
  isFree(id: string): boolean;
  /** Prefixes this provider's API keys start with. Used for hints, never as a hard gate. */
  keyPrefixes: string[];
  /** Placeholder shown in key inputs. */
  keyHint: string;
}

/* ─── OpenRouter ─── */

const OPENROUTER: ProviderCatalog = {
  id: "openrouter",
  label: "OpenRouter",
  baseUrl: "https://openrouter.ai/api/v1",
  chatModels: [
    "openrouter/free",
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "nvidia/nemotron-3-super-120b-a12b:free",
    "nvidia/nemotron-3-nano-30b-a3b:free",
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    "nvidia/nemotron-nano-9b-v2:free",
    "nvidia/nemotron-nano-12b-v2-vl:free",
    "google/gemma-4-31b-it:free",
    "google/gemma-4-26b-a4b-it:free",
    "openai/gpt-oss-20b:free",
    "poolside/laguna-s-2.1:free",
    "poolside/laguna-xs-2.1:free",
    "cohere/north-mini-code:free",
    "inclusionai/ling-3.0-tiny:free",
  ],
  // ⚠️ These are OpenRouter ids, so they must be OpenRouter-hosted. NVIDIA-hosted ids with a `:free`
  // suffix appeared here by copy-paste and would 404 on this endpoint.
  embedModels: ["qwen/qwen3-embedding-8b", "openai/text-embedding-3-large"],
  // Not free, but it is what every published evaluation in this repo was measured with.
  defaultEmbedModel: "qwen/qwen3-embedding-8b",
  safetyModel: "openai/gpt-oss-20b:free",
  defaults: {
    planner: "nvidia/nemotron-3-super-120b-a12b:free",
    domainqa: "google/gemma-4-31b-it:free",
    selfheal: "openai/gpt-oss-20b:free",
    reporter: "openai/gpt-oss-20b:free",
    receptionist: "nvidia/nemotron-nano-9b-v2:free",
    casual: "nvidia/nemotron-nano-9b-v2:free",
    explorer: "openai/gpt-oss-20b:free",
    packgen: "nvidia/nemotron-3-super-120b-a12b:free",
  },
  isFree: (id) => {
    const s = (id ?? "").trim().toLowerCase();
    return s.endsWith(":free") || s.startsWith("openrouter/free");
  },
  keyPrefixes: ["sk-"],
  keyHint: "sk-or-v1-…",
};

/* ─── NVIDIA NIM ─── */

const NVIDIA: ProviderCatalog = {
  id: "nvidia",
  label: "NVIDIA NIM",
  baseUrl: "https://integrate.api.nvidia.com/v1",
  // Owner-selected from build.nvidia.com's free endpoints. No `:free` suffix exists here — the whole
  // hosted catalog draws on one credit pool, so "free" is a property of the ACCOUNT, not the ID.
  //
  // LATENCY MEASURED on a live key, 2026-08-10 (trivial prompt / real strict-JSON RAG prompt). Hosted NIM
  // cold-starts, so a first call can be far slower than a warm one — these are first-call numbers, which
  // is what a benchmark run actually pays.
  //   nvidia/nemotron-3-nano-30b-a3b     0.4s / 1.8s   ✅ fast
  //   openai/gpt-oss-20b                 1.0s / 1.6s   ✅ fast
  //   nvidia/nemotron-3-super-120b-a12b 17.8s / 10.2s  ✅ usable; strongest that answers reliably
  //   minimaxai/minimax-m3               0.4s / 23.8s  ⚠️ the fast number is a trivial 8-token reply
  //   nvidia/nemotron-3-ultra-550b-a55b 12.3s /   n/a  ⚠️ leaked chain-of-thought into `content`
  //   openai/gpt-oss-120b               78.7s /   n/a  ⚠️ answers, but far too slow for any live role
  //
  // ❌ DELIBERATELY OMITTED — they never answered within 90s on a live key, twice:
  //      google/gemma-4-31b-it, z-ai/glm-5.2
  //    They are not 404s; the endpoint simply does not serve them usably. Offering a model that hangs is
  //    worse than not offering it, because the failure surfaces mid-run as a timeout rather than an error.
  //    Re-add only if `npm run probe:models` shows them OK.
  chatModels: [
    "nvidia/nemotron-3-super-120b-a12b",
    "nvidia/nemotron-3-ultra-550b-a55b",
    "openai/gpt-oss-120b",
    "minimaxai/minimax-m3",
    "nvidia/nemotron-3-nano-30b-a3b",
    "openai/gpt-oss-20b",
  ],
  // ⚠️ UPDATED 2026-08-22 — the previous defaults are DEAD, and this is the failure mode this catalog
  // exists to make visible. `nv-embed-v1`, `nv-embedcode-7b-v1`, `nv-embedqa-e5-v5`, `bge-m3` and
  // `llama-3.2-nv-embedqa-1b-v2` ALL return `410 Gone — reached its end of life` on this endpoint. They
  // were probed individually; `nemotron-3-embed-1b` is the only listed embedding model that actually
  // serves. `probe:models` is what caught it, which is the whole reason that script exists.
  //
  // ⚠️ It is **2048-dimensional**, not 4096, so it no longer matches `EMBEDDING_DIM`. Consequences:
  //   • DB OFF (the default): works fully. In-memory ranking is dimension-agnostic.
  //   • DB ON: `DbService`'s dimension probe detects the mismatch and disables the DB vector path with
  //     an explanatory log (`ctx.embeddingDimOk = false`). Run history and deterministic self-heal keep
  //     working; only vector self-heal and the QA cache switch off.
  // A degraded vector path beats a dead embedding model, which is what shipping the old default would be.
  embedModels: ["nvidia/nemotron-3-embed-1b", "nvidia/llama-nemotron-embed-vl-1b-v2"],
  defaultEmbedModel: "nvidia/nemotron-3-embed-1b",
  safetyModel: "openai/gpt-oss-20b",
  defaults: {
    // Hard structured reasoning → JSON. MoE: 120B total, ~12B active per token, so it is fast.
    planner: "nvidia/nemotron-3-super-120b-a12b",
    // Long-context grounded answering + strict JSON. Was `google/gemma-4-31b-it` (mirroring the
    // OpenRouter default) until a live probe showed that model never answering within 90s here. All four
    // working candidates produced VALID JSON with correct citations on the real prompt, so the choice came
    // down to quality-per-second: this is the strongest that answers in ~10s, and Domain QA is a
    // substantive grounded task, not a trivial one.
    // ⚠️ It IS the slow one: ~20s cold, ~10s warm, and Domain QA is user-facing. If that latency annoys
    // you more than the quality helps, `OPENAI_MODEL_DOMAINQA=openai/gpt-oss-20b` answers the same
    // prompt correctly in 1.6s. Both produced valid JSON with correct citations when tested.
    domainqa: "nvidia/nemotron-3-super-120b-a12b",
    // Pick one candidate index from a short list — trivial.
    selfheal: "openai/gpt-oss-20b",
    // 2–3 sentence failure analysis.
    reporter: "openai/gpt-oss-20b",
    // 3-way intent classification, only on low local confidence.
    receptionist: "nvidia/nemotron-3-nano-30b-a3b",
    // Small talk.
    casual: "nvidia/nemotron-3-nano-30b-a3b",
    // Rank candidate flows.
    explorer: "openai/gpt-oss-20b",
    // Synthesize a whole knowledge pack — same difficulty class as the planner.
    packgen: "nvidia/nemotron-3-super-120b-a12b",
  },
  // Everything in the hosted catalog runs off the free credit pool; there is no per-ID free/paid split.
  isFree: () => true,
  keyPrefixes: ["nvapi-"],
  keyHint: "nvapi-…",
};

export const PROVIDERS: Record<Provider, ProviderCatalog> = {
  openrouter: OPENROUTER,
  nvidia: NVIDIA,
};

/* ─── provider selection ─── */

/**
 * Which provider does a base URL point at? Defaults to OpenRouter, which is what an unconfigured install
 * has always used.
 */
export function providerForBaseUrl(baseUrl?: string | null): Provider {
  const u = (baseUrl ?? "").trim().toLowerCase();
  if (u.includes("integrate.api.nvidia.com") || u.includes("api.nvidia.com")) {return "nvidia";}
  return "openrouter";
}

/**
 * The provider this process is configured for.
 *
 * ⚠️ Resolved on every call, never cached at module load. `main.ts` runs `dotenv.config()` *after* its
 * imports (ES imports hoist), so anything read at import time would see an empty `OPENAI_BASE_URL`.
 */
export function activeProvider(): Provider {
  return providerForBaseUrl(process.env.OPENAI_BASE_URL);
}

export function catalogFor(provider: Provider = activeProvider()): ProviderCatalog {
  return PROVIDERS[provider];
}

/* ─── API keys ─── */

/**
 * Bare provider prefixes are what `.env.example` ships as placeholders — treat them as "no key set"
 * rather than as a malformed key, or a fresh checkout looks misconfigured instead of unconfigured.
 */
export function isPlaceholderApiKey(key: string | undefined | null): boolean {
  const v = (key ?? "").trim();
  if (!v) {return true;}
  if (/YOUR_KEY_HERE/i.test(v)) {return true;}
  for (const p of Object.values(PROVIDERS)) {
    for (const prefix of p.keyPrefixes) {
      if (v === prefix) {return true;}
    }
  }
  return v === "sk-or-v1-";
}

/**
 * Does this key look like it belongs to the given provider?
 *
 * ⚠️ Advisory ONLY — never a hard gate. `ConfigValidator` used to *fatally exit* on a key that did not
 * start with `sk-`, which silently made the whole orchestrator unusable the moment an `nvapi-` key was
 * configured: the process died before the pipeline ran at all. Key formats are the provider's business
 * and change without notice, so a mismatch is a WARNING. The authoritative test is whether a request
 * succeeds — that is what `npm run probe:models` is for.
 */
export function looksLikeProviderKey(
  key: string | undefined | null,
  provider: Provider = activeProvider()
): boolean {
  const v = (key ?? "").trim();
  if (!v) {return false;}
  return PROVIDERS[provider].keyPrefixes.some((p) => v.startsWith(p));
}

/** Placeholder text for a key input, e.g. `nvapi-…`. */
export function keyHintFor(provider: Provider = activeProvider()): string {
  return PROVIDERS[provider].keyHint;
}

/** Every key prefix any known provider issues — for "is this a real key at all?" checks. */
export function allKeyPrefixes(): string[] {
  return [...new Set(Object.values(PROVIDERS).flatMap((p) => p.keyPrefixes))];
}

/* ─── the accessors everything else uses ─── */

export function defaultModelsFor(provider: Provider = activeProvider()): Record<AgentRole, string> {
  return PROVIDERS[provider].defaults;
}

export function safetyModelFor(provider: Provider = activeProvider()): string {
  return PROVIDERS[provider].safetyModel;
}

export function chatModelsFor(provider: Provider = activeProvider()): string[] {
  return PROVIDERS[provider].chatModels;
}

export function embedModelsFor(provider: Provider = activeProvider()): string[] {
  return PROVIDERS[provider].embedModels;
}

export function defaultEmbedModelFor(provider: Provider = activeProvider()): string {
  return PROVIDERS[provider].defaultEmbedModel;
}

/**
 * Is this model free on the given provider? Provider-specific by necessity: `:free` is an OpenRouter
 * convention, and applying it to an NVIDIA ID would flag every legitimate model as paid.
 */
export function isFreeModelId(id: string, provider: Provider = activeProvider()): boolean {
  if (!id?.trim()) {return false;}
  return PROVIDERS[provider].isFree(id);
}

/**
 * Live view of the active provider's role defaults, so `DEFAULT_MODELS[role]` keeps reading correctly
 * from every existing call site. A Proxy rather than a plain object because the provider is only known
 * once `.env` has loaded — see `activeProvider()`.
 */
export const DEFAULT_MODELS: Record<AgentRole, string> = new Proxy({} as Record<AgentRole, string>, {
  get: (_t, prop: string) => defaultModelsFor()[prop as AgentRole],
  ownKeys: () => [...AGENT_ROLES],
  has: (_t, prop: string) => (AGENT_ROLES as string[]).includes(prop),
  getOwnPropertyDescriptor: (_t, prop: string) => ({
    enumerable: (AGENT_ROLES as string[]).includes(prop),
    configurable: true,
    value: defaultModelsFor()[prop as AgentRole],
  }),
});

/** Every model ID the catalog knows, across all providers. Used by the `.env.example` drift guard. */
export function allCatalogModelIds(): string[] {
  const out: string[] = [];
  for (const p of Object.values(PROVIDERS)) {
    out.push(...p.chatModels, ...p.embedModels, p.defaultEmbedModel, p.safetyModel);
  }
  return [...new Set(out)];
}
