/**
 * Embedding layer for golden-flow retrieval (G2.3).
 *
 * Kept separate from `FlowIndex.ts` so that module stays pure and synchronous: everything async or
 * IO-bound lives here. `FlowIndex.rankFlows` takes vectors as plain data, so the whole retrieval path is
 * unit-testable offline with a deterministic fake embedder — no network, no key, no quota.
 *
 * Embeddings are strictly an ENHANCEMENT. With no embed model configured, retrieval runs lexical-only and
 * behaves exactly as it did in G2.2; nothing here may ever be required for a plan to be produced.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { FlowIndex } from "./FlowIndex";

/** The slice of `EmbeddingClient` we need — so it can be passed directly, or faked in tests. */
export interface FlowEmbedder {
  isConfigured(): boolean;
  /** `inputType` is honoured by providers with asymmetric retrieval models (NVIDIA); ignored elsewhere. */
  embedOne(text: string, opts?: { inputType?: "query" | "passage" }): Promise<number[]>;
}

export interface FlowVectorCache {
  get(key: string): Record<string, number[]> | undefined;
  set(key: string, vectors: Record<string, number[]>): void;
}

/**
 * Identity of an index for caching: the flow keys + their document text, plus the embedding model.
 * Any edit to a pack (or switching models) changes the hash and invalidates the entry, so a stale vector
 * can never be served for changed content.
 */
export function flowIndexHash(index: FlowIndex, model: string): string {
  const material = index.docs
    .map((d) => `${d.key}::${d.text}`)
    .sort()
    .join("|");
  return crypto.createHash("sha256").update(`${model}::${material}`).digest("hex").slice(0, 32);
}

/**
 * Embed every flow document, returning `key → vector`.
 *
 * Returns `null` (never throws) when embeddings are unavailable or fail — the caller then continues
 * lexical-only. A partial failure is treated as total: mixing embedded and non-embedded flows would
 * silently bias ranking toward whichever ones happened to succeed.
 */
export async function embedFlowIndex(
  index: FlowIndex,
  embedder: FlowEmbedder,
  opts?: { model?: string; cache?: FlowVectorCache; logger?: { log: (m: string) => void } }
): Promise<Map<string, number[]> | null> {
  if (!index.docs.length || !embedder?.isConfigured?.()) {return null;}

  const model = opts?.model ?? process.env.OPENAI_EMBED_MODEL ?? "unknown";
  const hash = flowIndexHash(index, model);

  const cached = opts?.cache?.get(hash);
  if (cached) {
    const m = new Map<string, number[]>();
    for (const [k, v] of Object.entries(cached)) {m.set(k, v);}
    // Only trust a complete cache entry.
    if (index.docs.every((d) => m.has(d.key))) {
      opts?.logger?.log(`FlowIndex: loaded ${m.size} flow embedding(s) from cache`);
      return m;
    }
  }

  try {
    const vectors = new Map<string, number[]>();
    for (const d of index.docs) {
      vectors.set(d.key, await embedder.embedOne(d.text));
    }
    opts?.cache?.set(hash, Object.fromEntries(vectors));
    opts?.logger?.log(`FlowIndex: embedded ${vectors.size} flow(s)`);
    return vectors;
  } catch (e: any) {
    opts?.logger?.log(
      `FlowIndex: embedding failed (${e?.message ?? String(e)}) — continuing with lexical retrieval only`
    );
    return null;
  }
}

/** Embed one request. Returns null (never throws) so the caller degrades to lexical-only. */
export async function embedQuery(
  query: string,
  embedder: FlowEmbedder
): Promise<number[] | null> {
  if (!query?.trim() || !embedder?.isConfigured?.()) {return null;}
  try {
    return await embedder.embedOne(query, { inputType: "query" });
  } catch {
    return null;
  }
}

/**
 * A JSON-file vector cache. Keyed by index hash so several apps (and several embed models) coexist in one
 * file. Every operation is best-effort — a broken or unwritable cache must only cost time, never a run.
 */
export function fileFlowVectorCache(filePath: string): FlowVectorCache {
  let data: Record<string, Record<string, number[]>> | null = null;

  const load = (): Record<string, Record<string, number[]>> => {
    if (data) {return data;}
    try {
      data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      data = {};
    }
    return data!;
  };

  return {
    get(key) {
      return load()[key];
    },
    set(key, vectors) {
      const d = load();
      d[key] = vectors;
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(d));
      } catch {
        /* cache is an optimization — never fail a run over it */
      }
    },
  };
}
