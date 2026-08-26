/**
 * Domain QA RAG retrieval evaluator (S2.2).
 *
 * Measures how well the retrieval ranker surfaces the right document for a question, over a small,
 * self-contained, reproducible corpus. This is a LIVE tool: it embeds the corpus + questions with the
 * configured embedding model, so it needs OPENAI_API_KEY + OPENAI_EMBED_MODEL (no DB, no browser).
 *
 * It establishes the **pure-vector baseline** (hit@1 / hit@3 / hit@k / MRR) that gates whether the
 * S2.4 hybrid/rerank path is worth shipping — keeping "deeper RAG" evidence-based.
 *
 * Usage (after `npm run build`):
 *   node scripts/evalDomainQa.js            # pure-vector baseline
 *   node scripts/evalDomainQa.js --k=5      # report hit@k for k=5 (default 3)
 *   node scripts/evalDomainQa.js --json     # also write evalDomainQa-results.json
 */

"use strict";

const fs = require("fs");
const path = require("path");

// Load packages/orchestrator/.env so OPENAI_API_KEY + OPENAI_EMBED_MODEL are available when this
// script is run directly via `node` (unlike the orchestrator, nothing else loads dotenv here).
try {
  require("dotenv").config({ path: path.resolve(__dirname, "../.env"), quiet: true });
} catch {
  /* dotenv optional — env vars may already be set in the shell */
}

const WRITE_JSON = process.argv.includes("--json");
const K = (() => {
  const a = process.argv.find((x) => x.startsWith("--k="));
  const n = a ? parseInt(a.split("=")[1], 10) : 3;
  return Number.isFinite(n) && n > 0 ? n : 3;
})();

const distDir = path.resolve(__dirname, "../dist");
if (!fs.existsSync(distDir)) {
  console.error("❌  dist/ not found — run `npm run build` inside packages/orchestrator first.");
  process.exit(1);
}

let EmbeddingClient, rankChunksByVector;
try {
  ({ EmbeddingClient } = require(path.join(distDir, "core/llm/EmbeddingClient")));
  ({ rankChunksByVector } = require(path.join(distDir, "core/rag/ranker")));
} catch (e) {
  console.error("❌  Could not load compiled modules from dist:", e.message);
  process.exit(1);
}

// ─── Self-contained corpus (one chunk per doc; keeps the metric = "right doc ranked top-k") ───────
const CORPUS = [
  {
    id: "locators",
    title: "Playwright Locators",
    text:
      "Playwright recommends user-facing locators such as getByRole, getByText, and getByLabel. " +
      "getByRole is the most resilient because it reflects how users and assistive technology perceive " +
      "the page. Avoid CSS or XPath selectors tied to implementation details; prefer getByTestId only " +
      "when a stable data-testid is available.",
  },
  {
    id: "autowait",
    title: "Auto-waiting",
    text:
      "Playwright auto-waits for elements to be actionable before acting: visible, stable, enabled, and " +
      "able to receive events. This removes most explicit sleeps. Web-first assertions like " +
      "expect(locator).toBeVisible() retry automatically until the condition is met or the timeout expires.",
  },
  {
    id: "trace",
    title: "Trace Viewer",
    text:
      "The Playwright Trace Viewer records a trace of test execution with DOM snapshots, actions, console " +
      "logs, and network activity. Open it with `npx playwright show-trace trace.zip` to step through each " +
      "action and debug why a test failed.",
  },
  {
    id: "fixtures",
    title: "Test Fixtures",
    text:
      "Playwright test fixtures set up and tear down the environment for tests. The built-in page fixture " +
      "provides an isolated browser page per test. You can define custom fixtures with test.extend to share " +
      "setup like authentication across tests.",
  },
  {
    id: "network",
    title: "Network Interception",
    text:
      "Playwright can intercept and modify network requests with page.route. You can mock API responses, " +
      "block resources, or assert on requests. This is useful for testing error states without a real backend.",
  },
  {
    id: "selfheal",
    title: "AgenticQA Self-Healing",
    text:
      "AgenticQA self-heals broken locators: when a step fails to find an element, it captures the page's " +
      "accessibility snapshot at the moment of failure and re-grounds the step against the live page, then " +
      "re-runs. Assertion targets that are re-pointed are flagged so a real regression isn't masked.",
  },
];

// ─── Question set: each expects a specific corpus doc to rank top-k ────────────────────────────────
const QUESTIONS = [
  { q: "Which Playwright locator is the most resilient to use?", expectId: "locators" },
  { q: "Should I prefer getByRole or a CSS selector?", expectId: "locators" },
  { q: "Does Playwright wait for elements automatically before clicking?", expectId: "autowait" },
  { q: "How do web-first assertions retry?", expectId: "autowait" },
  { q: "How can I debug a failed test by stepping through DOM snapshots?", expectId: "trace" },
  { q: "How do I share login setup across tests?", expectId: "fixtures" },
  { q: "How can I mock API responses in a test?", expectId: "network" },
  { q: "How does AgenticQA repair a broken locator after the UI changes?", expectId: "selfheal" },
];

async function main() {
  const embedder = new EmbeddingClient();
  if (!embedder.isConfigured()) {
    console.error(
      "❌  Embedding model not configured. Set OPENAI_API_KEY + OPENAI_EMBED_MODEL to run the live eval."
    );
    process.exit(1);
  }

  console.log("\n📚  AgenticQA Domain QA RAG Evaluator (pure-vector baseline)");
  console.log(`    Corpus docs: ${CORPUS.length}   Questions: ${QUESTIONS.length}   k=${K}\n`);
  console.log("─".repeat(88));

  // Embed the corpus once.
  const chunks = [];
  for (const d of CORPUS) {
    const embedding = await embedder.embedOne(d.text);
    chunks.push({ chunkText: d.text, embedding, sourceUrl: d.id, docTitle: d.title });
  }

  let hit1 = 0;
  let hitK = 0;
  let mrrSum = 0;
  const rows = [];

  for (const item of QUESTIONS) {
    const qEmb = await embedder.embedOne(item.q);
    const ranked = rankChunksByVector(qEmb, chunks, CORPUS.length);
    const rankIdx = ranked.findIndex((r) => r.sourceUrl === item.expectId);
    const found = rankIdx >= 0;
    const inTopK = found && rankIdx < K;
    if (rankIdx === 0) hit1++;
    if (inTopK) hitK++;
    if (found) mrrSum += 1 / (rankIdx + 1);

    const rankLabel = found ? `#${rankIdx + 1}` : "—";
    const icon = rankIdx === 0 ? "✅" : inTopK ? "▫️" : "❌";
    console.log(
      `  ${icon}  rank ${rankLabel.padEnd(4)} expect=${item.expectId.padEnd(9)} ${item.q}`
    );
    rows.push({ q: item.q, expectId: item.expectId, rank: found ? rankIdx + 1 : null, top: ranked[0]?.sourceUrl });
  }

  const n = QUESTIONS.length;
  const pct = (x) => `${((x / n) * 100).toFixed(1)}%`;
  console.log("─".repeat(88));
  console.log("\n📊  Pure-vector baseline");
  console.log(`    hit@1 : ${hit1}/${n}  (${pct(hit1)})`);
  console.log(`    hit@${K} : ${hitK}/${n}  (${pct(hitK)})`);
  console.log(`    MRR   : ${(mrrSum / n).toFixed(3)}\n`);

  if (WRITE_JSON) {
    const out = {
      strategy: "vector",
      k: K,
      n,
      hit1,
      hitK,
      mrr: mrrSum / n,
      rows,
    };
    const outPath = path.join(__dirname, "../evalDomainQa-results.json");
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
    console.log(`📄  Results written to ${path.relative(process.cwd(), outPath)}\n`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
