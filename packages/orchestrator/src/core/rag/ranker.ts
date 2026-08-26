/**
 * Pure, dependency-free retrieval ranking — shared by the Domain QA DB-off path (S2.3), the eval
 * harness (S2.2), and (if the eval justifies it) the hybrid path (S2.4). No fs/network/DB here, so
 * it stays unit-testable offline.
 */

export interface RankableChunk {
  chunkText: string;
  embedding: number[];
  sourceUrl?: string;
  docTitle?: string;
}

export interface RankedChunk {
  chunkText: string;
  sourceUrl?: string;
  docTitle?: string;
  /** Higher = more relevant. For the vector ranker this is cosine similarity in [-1, 1]. */
  score: number;
}

/** Cosine similarity of two equal-length vectors; 0 when either has zero norm (safe for empties). */
export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Rank chunks by cosine similarity to the query embedding (highest first); returns the top-k. */
export function rankChunksByVector(
  queryEmbedding: number[],
  chunks: RankableChunk[],
  topK = 8
): RankedChunk[] {
  return chunks
    .map((c) => ({
      chunkText: c.chunkText,
      sourceUrl: c.sourceUrl,
      docTitle: c.docTitle,
      score: cosineSimilarity(queryEmbedding, c.embedding),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, topK));
}
