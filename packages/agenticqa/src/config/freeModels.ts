/**
 * Curated catalog of free OpenRouter chat models + free-model helpers.
 *
 * The catalog is a *fallback*: when an API key is configured the Settings panel fetches the LIVE list
 * from OpenRouter (`/models`, kept to the free tier) so the dropdown always reflects what the user's key
 * can actually access. Free-text entry is always allowed — the catalog only powers the suggestions.
 *
 * Pure module (no vscode/fs imports) so it stays portable and unit-testable; `fetch` is the only I/O.
 *
 * ⚠️ Model IDs are NOT written here. They come from the single catalog at
 * `packages/orchestrator/src/core/llm/modelCatalog.ts` — edit that file, never this one.
 */

import {
  chatModelsFor,
  embedModelsFor,
  providerForBaseUrl,
  isFreeModelId,
} from "../../../orchestrator/src/core/llm/modelCatalog";

/**
 * Known free chat models (OpenRouter `:free` tier), used as the **offline fallback** — the live fetch
 * supersedes it whenever a key + network are available. `openrouter/free` is OpenRouter's zero-cost
 * auto-router, a good "just works" pick.
 *
 * ⚠️ **This list rots and must be re-checked periodically.** Refreshed 2026-08-09 from the owner's live
 * key. The previous version offered `openai/gpt-oss-120b:free`, `qwen/qwen3-next-80b-a3b-instruct:free`,
 * `meta-llama/llama-3.2-3b-instruct:free` and several others that had quietly become paid-only —
 * suggesting a dead model in the picker is worse than suggesting none, because the failure only surfaces
 * mid-run as a 404. Entries that no longer resolve were removed rather than kept "just in case".
 *
 * Embedding/rerank/safety models are intentionally excluded: this list feeds the **chat** role pickers.
 */
// Derived from the ONE catalog (`packages/orchestrator/src/core/llm/modelCatalog.ts`) rather than
// repeated here — this list used to be a hand-maintained copy, which is a drift waiting to happen.
// esbuild bundles the import, so the extension gains no runtime dependency on the orchestrator.
export const CURATED_FREE_MODELS: string[] = [...chatModelsFor("openrouter")];

/**
 * Free embedding models (`OPENAI_EMBED_MODEL`). Separate from the chat list because embeddings are a
 * system-wide single choice, not per-agent — and because a chat model in this field silently breaks
 * retrieval. See `EMBEDDING_DIM` in the orchestrator: changing dimension needs a DB reset.
 */
export const CURATED_FREE_EMBED_MODELS: string[] = [...embedModelsFor("openrouter")];

/**
 * Is this model free — **for the provider the user is actually pointed at**?
 *
 * `:free` is an OpenRouter naming convention, not a universal one. NVIDIA NIM's hosted catalog draws on
 * a single free credit pool and its IDs carry no suffix at all, so applying the OpenRouter rule there
 * would flag every legitimate model as paid and the policy below would warn on all of them. The rule
 * per provider lives in `modelCatalog.ts`; this just forwards to it.
 */
export function isFreeModel(id: string | undefined | null, baseUrl?: string): boolean {
  const v = (id ?? "").trim();
  if (!v) {return false;}
  return isFreeModelId(v, providerForBaseUrl(baseUrl));
}

/**
 * Fetch the live set of free models the given key can access, falling back to the curated list on any
 * error (no network / bad key / unexpected shape). Sorted + de-duped. Never throws.
 */
export async function fetchFreeModels(opts: { baseUrl?: string; apiKey?: string }): Promise<string[]> {
  const base = (opts.baseUrl?.trim() || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.apiKey?.trim()) {headers["Authorization"] = `Bearer ${opts.apiKey.trim()}`;}
    const res = await fetch(`${base}/models`, { headers });
    if (!res.ok) {throw new Error(`models fetch ${res.status}`);}
    const json = (await res.json()) as { data?: Array<{ id?: string }> };
    const ids = Array.isArray(json?.data)
      ? json.data.map((m) => String(m?.id ?? "")).filter(Boolean)
      : [];
    const provider = providerForBaseUrl(opts.baseUrl);
    const free = [...new Set(ids.filter((id) => isFreeModelId(id, provider)))].sort();
    return free.length ? free : [...chatModelsFor(provider)];
  } catch {
    return [...chatModelsFor(providerForBaseUrl(opts.baseUrl))];
  }
}
