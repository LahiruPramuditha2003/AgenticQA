#!/usr/bin/env node
/**
 * Measure golden-flow retrieval against demo-web's real pack + real benchmark prompts (G2.2 / G2.3).
 *
 * Ground truth is **hand-labelled below**, not taken from the incumbent regex ladder. Treating the thing
 * you are replacing as the oracle can only ever reproduce it, including its mistakes — and the whole
 * reason for replacing it is that it is a demo-web-shaped lookup table.
 *
 *   node scripts/evalFlowIndex.js [--verbose] [--embed] [--compare]
 *
 * Offline by default: reads the checked-in pack + TEST_TEMPLATES.md, lexical retrieval only, no network.
 * `--embed` runs the HYBRID path against the real embedding model (needs OPENAI_API_KEY +
 * OPENAI_EMBED_MODEL and daily quota), so the value of adding semantics is measured rather than assumed.
 * Vectors are cached by pack+model hash, so re-runs are cheap.
 *
 * `--compare` (implies --embed) scores LEXICAL vs SEMANTIC vs HYBRID side by side. Re-run this whenever
 * the embedding model changes: as of 2026-08-09 with `qwen/qwen3-embedding-8b` the answer was
 * lexical 17/19, semantic 14/19, hybrid 15/19 — i.e. **adding embeddings made retrieval worse**, which is
 * why the planner uses lexical-only. Don't turn semantics on without re-running this.
 */

const fs = require("node:fs");
const path = require("node:path");

const { extractTemplatePrompts, repoRootFromHere } = require("./extractTemplatePrompts");
const {
  buildFlowIndex,
  rankFlows,
  rankFlowsLexical,
  rankFlowsSemantic,
} = require("../dist/core/knowledge/FlowIndex.js");

const verbose = process.argv.includes("--verbose");
const compareModes = process.argv.includes("--compare");
const useEmbeddings = process.argv.includes("--embed") || compareModes;
const repoRoot = repoRootFromHere();

if (useEmbeddings) {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });
}

const pack = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "apps", "demo-web", ".agenticqa", "knowledge.json"), "utf8")
);
const prompts = extractTemplatePrompts(path.join(repoRoot, "benchmarks/TEST_TEMPLATES.md")).filter(
  (p) => p.index >= 1 && p.index <= 20
);

/**
 * Expected flow per benchmark prompt — my reading of what each prompt actually asks for, given demo-web's
 * 15 flows. `null` = no single flow fits, so the right answer is to ABSTAIN and let the LLM path handle
 * it. `alt` lists a second defensible answer.
 */
const EXPECTED = {
  1: { want: "home", alt: [] },
  2: { want: "search", alt: [] },
  3: { want: "filter-category-select", alt: [] },
  4: { want: "product-detail", alt: [] },
  5: { want: "category-card-click", alt: ["filter-category-select"] },
  6: { want: "cart", alt: ["product-detail"] },
  7: { want: "cart", alt: [] },
  8: { want: "cart", alt: [] },
  9: { want: "checkout-empty", alt: ["cart"] },
  10: { want: "cart", alt: ["checkout-empty"] },
  11: { want: "cart", alt: ["checkout-empty"] },
  12: { want: "cart", alt: ["checkout-empty"] },
  13: { want: "checkout-empty", alt: ["cart"] },
  // Multi-phase: "add to cart as guest … Then cancel, login … return to checkout". No single flow can
  // express two auth states, so abstaining (→ LLM path) is the correct behaviour.
  14: { want: null, alt: [] },
  15: { want: "customer-login", alt: [] },
  16: { want: "login-invalid", alt: [] },
  17: { want: "register", alt: [] },
  18: { want: "register-mismatch", alt: ["register"] },
  19: { want: "logout", alt: [] },
  20: { want: "password-reset", alt: [] },
};

const index = buildFlowIndex(pack.goldenFlows);

/** Real embeddings, or null to stay lexical-only. Never throws. */
async function loadSemantic() {
  if (!useEmbeddings) {return null;}
  const { EmbeddingClient } = require("../dist/core/llm/EmbeddingClient.js");
  const { embedFlowIndex, fileFlowVectorCache } = require("../dist/core/knowledge/FlowEmbeddings.js");
  const embedder = new EmbeddingClient();
  if (!embedder.isConfigured()) {
    console.log("--embed requested, but OPENAI_API_KEY / OPENAI_EMBED_MODEL are unset — lexical only.\n");
    return null;
  }
  // NOT in dist/ — `npm run build` cleans that directory, which would silently re-spend embedding
  // quota on every rebuild.
  const cache = fileFlowVectorCache(
    path.join(__dirname, "..", ".cache", "flow-embeddings.json")
  );
  const vectors = await embedFlowIndex(index, embedder, {
    cache,
    logger: { log: (m) => console.log(m) },
  });
  if (!vectors) {
    console.log("Embeddings unavailable (quota / network?) — falling back to lexical only.\n");
    return null;
  }
  return { vectors, embedder };
}

async function compare(semantic) {
  console.log("\nMode comparison - lexical vs semantic vs hybrid (RRF)\n");
  console.log(" #  want                     lexical                  semantic                 hybrid");
  let L = 0, S = 0, H = 0, n = 0;
  for (const p of prompts) {
    const want = (EXPECTED[p.index] ?? {}).want;
    if (!want) {continue;}
    n++;
    const qv = await semantic.embedder.embedOne(p.prompt).catch(() => null);
    const l = rankFlowsLexical(index, p.prompt, 5)[0];
    const s = rankFlowsSemantic(index, semantic.vectors, qv ?? [], 5)[0];
    const h = rankFlows(index, p.prompt, { vectors: semantic.vectors, queryVector: qv ?? undefined })
      .candidates[0];
    const k = (x) => (x ? x.key : "-");
    if (k(l) === want) {L++;}
    if (k(s) === want) {S++;}
    if (k(h) === want) {H++;}
    const mark = (x) => (k(x) === want ? "OK " : "xx ") + k(x).padEnd(22);
    console.log(String(p.index).padStart(2), want.padEnd(24), mark(l), mark(s), mark(h));
  }
  console.log(`\n  lexical  hit@1: ${L}/${n}`);
  console.log(`  semantic hit@1: ${S}/${n}`);
  console.log(`  hybrid   hit@1: ${H}/${n}`);
  console.log(
    L >= H
      ? "\n  => lexical is at least as good as hybrid; keep semantics OFF (the current default)."
      : "\n  => hybrid beats lexical here; consider enabling semantics in ScenarioPlanner."
  );
}

async function main() {
  console.log(
    `Indexed ${index.docs.length} golden flows from apps/demo-web; ${prompts.length} prompts.\n`
  );
  const semantic = await loadSemantic();
  if (compareModes) {
    if (!semantic) {
      console.log("--compare needs working embeddings.");
      return;
    }
    await compare(semantic);
    return;
  }

  let hit1 = 0;
  let hit1OrAlt = 0;
  let hit3 = 0;
  let mrrSum = 0;
  let scored = 0;
  const rows = [];

  for (const p of prompts) {
    const exp = EXPECTED[p.index] ?? { want: null, alt: [] };

    let opts;
    if (semantic) {
      const qv = await semantic.embedder.embedOne(p.prompt).catch(() => null);
      opts = { vectors: semantic.vectors, queryVector: qv ?? undefined };
    }
    const r = rankFlows(index, p.prompt, opts);
    const hits = r.candidates;
    const top = r.hit;

    if (exp.want === null) {
      rows.push({
        i: p.index,
        want: "(abstain)",
        got: r.abstained ? "(abstained)" : top ? top.key : "(none)",
        ok: r.abstained ? "✓" : "✗",
        hits,
      });
      continue;
    }
    scored++;

    const rank = hits.findIndex((h) => h.key === exp.want) + 1; // 0 ⇒ not found
    if (rank === 1) {hit1++;}
    if (rank > 0 && rank <= 3) {hit3++;}
    if (rank > 0) {mrrSum += 1 / rank;}
    const acceptable = new Set([exp.want, ...(exp.alt ?? [])].filter(Boolean));
    const okAlt = top && acceptable.has(top.key);
    if (okAlt) {hit1OrAlt++;}

    rows.push({
      i: p.index,
      want: exp.want,
      got: r.abstained ? "(abstained)" : top ? top.key : "(none)",
      ok: rank === 1 ? "✓" : okAlt ? "~" : "✗",
      hits,
    });
  }

  console.log(" #  | expected                 | top-1 retrieved          | ");
  console.log("-".repeat(72));
  for (const r of rows) {
    console.log(
      `${String(r.i).padStart(2)}  | ${String(r.want).padEnd(24)} | ${String(r.got).padEnd(24)} | ${r.ok}`
    );
    if (verbose && r.hits && r.hits.length) {
      console.log("     candidates: " + r.hits.map((h) => `${h.key}(${h.score.toFixed(3)})`).join(", "));
    }
  }

  const pct = (n) => `${Math.round((n / scored) * 1000) / 10}%`;
  const abstainRow = rows.find((r) => r.want === "(abstain)");
  console.log("-".repeat(72));
  console.log(`Mode: ${semantic ? "HYBRID (lexical + embeddings, RRF)" : "LEXICAL only"}`);
  console.log(`Scored ${scored} prompts (#14 scored separately as an abstain case).`);
  console.log(`  hit@1 (exact label) : ${hit1}/${scored}  (${pct(hit1)})`);
  console.log(`  hit@1 (label or alt): ${hit1OrAlt}/${scored}  (${pct(hit1OrAlt)})`);
  console.log(`  hit@3               : ${hit3}/${scored}  (${pct(hit3)})`);
  console.log(`  MRR                 : ${(mrrSum / scored).toFixed(3)}`);
  if (abstainRow) {
    console.log(
      `  abstain on #${abstainRow.i}        : ${
        abstainRow.ok === "✓" ? "yes ✓" : `NO — returned ${abstainRow.got} ✗`
      }`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
