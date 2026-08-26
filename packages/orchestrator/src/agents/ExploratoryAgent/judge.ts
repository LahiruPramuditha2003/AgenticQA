/**
 * LLM-as-judge ranking for discovered exploratory flows (S3.3) — the AI centerpiece of the
 * Exploratory agent. An LLM scores each candidate flow on validity / value / novelty and returns a
 * ranked top-N; when no LLM is configured (or it fails), a deterministic coverage/diversity heuristic
 * ranks instead, so the feature degrades gracefully. The prompt builder, response parser, and heuristic
 * are pure and unit-tested; only `judgeFlows`'s LLM call is live.
 */

import type { LlmClient } from "../../core/llm/LlmClient";
import { extractFirstJsonObject } from "../../core/llm/json";
import type { ExploratoryFlow } from "../../core/explore/synthesizeFlows";

export interface RankedFlow extends ExploratoryFlow {
  /** 0–10. From the LLM when available, else the heuristic's diversity score. */
  score: number;
  rationale?: string;
}

/** Build the judge prompt: presents each candidate flow (index, kind, route, action sequence). */
export function buildJudgePrompt(flows: ExploratoryFlow[], topN: number): string {
  const list = flows
    .map((f, i) => {
      const actions = f.steps.map((s) => s.action).join(" → ");
      return `${i}. [${f.kind}] ${f.title}\n   route: ${f.routeKey}\n   actions: ${actions}`;
    })
    .join("\n");

  return `You are a senior QA engineer reviewing auto-discovered candidate UI test flows for a web app.
Rank them by how valuable each is as an automated test, considering:
- validity: will the steps plausibly run without breaking?
- value: does it verify meaningful user-facing behaviour (navigation, forms, key pages)?
- novelty: avoid near-duplicates; prefer diverse coverage of routes and interactions.

Aim for a DIVERSE mix of flow types ([smoke] / [form] / [nav]) and distinct routes — don't select only smoke tests.

Candidate flows:
${list}

Return ONLY JSON (no prose): {"ranking":[{"index":<flow index>,"score":<0-10>,"reason":"<short>"}]}
List the best ${topN} flows, best first. Omit low-value or likely-broken flows.`;
}

/** Parse a judge response into ranked flows. Tolerant of surrounding prose, out-of-range/duplicate
 *  indices, and missing fields. Returns null when nothing usable is found. */
export function parseJudgeResponse(
  raw: string,
  flows: ExploratoryFlow[]
): RankedFlow[] | null {
  let parsed: any;
  try {
    parsed = JSON.parse(extractFirstJsonObject(raw));
  } catch {
    return null;
  }
  const ranking = Array.isArray(parsed?.ranking) ? parsed.ranking : null;
  if (!ranking) return null;

  const out: RankedFlow[] = [];
  const seen = new Set<number>();
  for (const r of ranking) {
    const idx = Number(r?.index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= flows.length || seen.has(idx)) continue;
    seen.add(idx);
    const score = Math.max(0, Math.min(10, Number(r?.score) || 0));
    const rationale = typeof r?.reason === "string" ? r.reason.slice(0, 200) : undefined;
    out.push({ ...flows[idx], score, rationale });
  }
  return out.length ? out : null;
}

const KIND_WEIGHT: Record<string, number> = { form: 3, nav: 2, smoke: 1 };

/**
 * Deterministic coverage/diversity ranking (the no-LLM fallback). Greedily picks flows that add a new
 * route and/or kind, weighted by interaction richness — so the chosen set spreads across the app
 * instead of clustering on one page or one flow type.
 */
export function heuristicRank(flows: ExploratoryFlow[], topN: number): RankedFlow[] {
  const pool = flows.map((f, i) => ({
    f,
    i,
    base: (KIND_WEIGHT[f.kind] ?? 1) + Math.min(2, f.steps.length / 3),
  }));

  const selected: RankedFlow[] = [];
  const usedRoutes = new Set<string>();
  const usedKinds = new Set<string>();

  while (selected.length < topN && pool.length) {
    let best: { idxInPool: number; score: number; ord: number } | null = null;
    for (let p = 0; p < pool.length; p++) {
      const c = pool[p];
      const diversity =
        (usedRoutes.has(c.f.routeKey) ? 0 : 1.5) + (usedKinds.has(c.f.kind) ? 0 : 1);
      const score = c.base + diversity;
      if (!best || score > best.score || (score === best.score && c.i < best.ord)) {
        best = { idxInPool: p, score, ord: c.i };
      }
    }
    if (!best) break;
    const chosen = pool.splice(best.idxInPool, 1)[0];
    usedRoutes.add(chosen.f.routeKey);
    usedKinds.add(chosen.f.kind);
    selected.push({ ...chosen.f, score: Math.round(best.score * 10) / 10 });
  }
  return selected;
}

/** Rank candidate flows, preferring the LLM judge and falling back to the heuristic. Returns top-N. */
export async function judgeFlows(
  flows: ExploratoryFlow[],
  opts: { llm?: LlmClient; topN?: number; logger: { log: (m: string) => void } }
): Promise<RankedFlow[]> {
  const topN = opts.topN ?? 5;
  if (flows.length === 0) return [];

  if (opts.llm && opts.llm.isConfigured()) {
    try {
      const raw = await opts.llm.chat(
        [
          { role: "system", content: "You are a precise QA reviewer. Respond with JSON only." },
          { role: "user", content: buildJudgePrompt(flows, topN) },
        ],
        { temperature: 0.2, maxTokens: 800 }
      );
      const ranked = parseJudgeResponse(raw, flows);
      if (ranked && ranked.length) {
        opts.logger.log(`Explore: LLM judge ranked ${ranked.length} flow(s)`);
        return ranked.slice(0, topN);
      }
      opts.logger.log("Explore: judge response unusable — using heuristic ranking");
    } catch (e: any) {
      opts.logger.log(`Explore: judge LLM failed (${e?.message ?? String(e)}) — using heuristic ranking`);
    }
  } else {
    opts.logger.log("Explore: no LLM configured — using heuristic ranking");
  }

  return heuristicRank(flows, topN);
}
