"use strict";
// Offline unit tests for the Domain QA RAG helpers (no DB/network). Imports from dist/.

const { test } = require("node:test");
const assert = require("node:assert");
const { buildDocChunkSearchSql } = require("../dist/core/db/db.js");
const { cosineSimilarity, rankChunksByVector } = require("../dist/core/rag/ranker.js");

test("buildDocChunkSearchSql scopes to source_url when filtering (S2.1)", () => {
  const sql = buildDocChunkSearchSql(true);
  assert.match(sql, /AND source_url = \$3/, "adds the source_url filter");
  assert.match(sql, /LIMIT \$4/, "limit shifts to $4 when source_url is present");
});

test("buildDocChunkSearchSql omits the source filter when not scoping", () => {
  const sql = buildDocChunkSearchSql(false);
  assert.ok(!sql.includes("source_url = $"), "no source_url filter");
  assert.match(sql, /LIMIT \$3/, "limit stays at $3");
});

test("cosineSimilarity: identical = 1, orthogonal = 0, zero-norm safe (S2.2)", () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0, 0], [1, 0, 0]) - 1) < 1e-9);
  assert.ok(Math.abs(cosineSimilarity([1, 0, 0], [0, 1, 0])) < 1e-9);
  assert.strictEqual(cosineSimilarity([0, 0], [0, 0]), 0);
});

test("rankChunksByVector ranks by similarity and applies top-k (S2.2)", () => {
  const chunks = [
    { chunkText: "a", embedding: [1, 0, 0], sourceUrl: "A" },
    { chunkText: "b", embedding: [0, 1, 0], sourceUrl: "B" },
    { chunkText: "c", embedding: [0.9, 0.1, 0], sourceUrl: "C" },
  ];
  const ranked = rankChunksByVector([1, 0, 0], chunks, 2);
  assert.strictEqual(ranked.length, 2, "top-k limit applied");
  assert.strictEqual(ranked[0].sourceUrl, "A", "closest first");
  assert.strictEqual(ranked[1].sourceUrl, "C", "next closest");
  assert.ok(ranked[0].score >= ranked[1].score, "scores are descending");
});
