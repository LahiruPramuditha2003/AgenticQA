/**
 * FlowIndex — retrieval over an app's golden flows (G2.2).
 *
 * WHY
 * ---
 * Before this, the deterministic planner reached golden flows through a ~20-branch regex ladder in
 * `ScenarioPlanner` whose branch targets were demo-web's 15 flow keys (`customer-login`, `search`,
 * `cart`, …). That is a lookup table with a fuzzy front door: it scores 100% on the app it was written
 * for and 0% everywhere else. Auto-generated packs — whose keys look like `smoke-home` / `form-login` —
 * could never trigger it at all (limitation L2), so the whole `generate_pack` pipeline produced output
 * no consumer read.
 *
 * This module replaces the ladder with retrieval: score every flow against the request and take the best,
 * or abstain. Determinism is preserved — retrieval only *selects* a human- or execution-verified flow; it
 * never authors steps. That is the property that made deterministic-first worth having.
 *
 * SCOPE: pure and synchronous, zero IO, fully offline-testable. Embeddings are optional and live in
 * `FlowEmbeddings.ts`; pass their vectors in to blend cosine ranking with BM25 via RRF.
 *
 * ⚠️ Semantics are OFF by default because they MEASURED WORSE on demo-web (lexical 17/19, semantic
 * 14/19, hybrid 15/19 with `qwen/qwen3-embedding-8b`, 2026-08-09). `npm run eval:flowindex:compare`
 * reproduces it; re-run before ever enabling them. `ScenarioPlanner` deliberately passes no vectors.
 */

import type { GoldenFlow } from "./AppKnowledgePack";
import { requestedInteractions, interactionCoverage } from "./requestedInteractions";
import { flowPrior } from "../learn/priors";

/* ─── tokenization ─── */

/**
 * Words carrying no discriminating signal in this domain. Every benchmark prompt says "verify" and every
 * flow description says "page"; with only ~15 documents, IDF alone is too coarse to suppress them.
 * Deliberately conservative — anything that could name a feature (login, cart, search…) stays in.
 */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have", "in", "into", "is", "it",
  "its", "of", "on", "or", "that", "the", "then", "there", "this", "to", "with", "shows", "show",
  // test-harness filler
  "test", "tests", "testing", "verify", "verifies", "verifying", "check", "checks", "confirm", "confirms",
  "ensure", "should", "must", "correctly", "properly", "appears", "appear", "displayed", "display",
  "displays", "visible", "see", "using", "via", "when", "after", "before", "also",
  // Generic motion verbs. Like "verify", these describe the ACTION rather than the target, and nearly
  // every prompt contains one — "Navigate to the home page" is about *home*, not about navigating.
  // Leaving them in let a flow literally named `navigate` outrank `home` on that prompt.
  "go", "goes", "navigate", "navigates", "open", "opens", "visit", "visits", "browse", "browses",
]);

/**
 * Crude but *consistent* stemmer — plural collapsing only. Correctness matters less than applying the
 * same transform to query and document: "categories" → "categorie" on both sides still matches.
 */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) {return word.slice(0, -3) + "y";}
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) {return word.slice(0, -1);}
  return word;
}

/** Lowercase, split on non-alphanumerics (so `customer-login` and `/auth/login` become words), destop, stem. */
export function tokenize(text: string): string[] {
  return String(text ?? "")
    .toLowerCase()
    // Collapse the multi-word auth verbs onto the single words apps actually use in keys and URLs
    // (`/login`, `form-login`, `logout`). This is English orthography, not app vocabulary — "log in" and
    // "login" are the same word with and without a space.
    // ⚠️ Measured twice with opposite conclusions, which is why it is spelled out here: it changes
    // NOTHING for flow retrieval (it lifts every login-ish flow equally, so no ranking moves), and it was
    // reverted the first time for that reason. It was re-added for ROUTE resolution (G3.1), where it is
    // decisive — "Go to the sign in page…" shares no term with a route called `/login`, so the login page
    // was never inspected for any of the three sign-in prompts on the held-out app.
    .replace(/\blog\s+in\b/g, "login")
    .replace(/\bsign\s+in\b/g, "login")
    .replace(/\blog\s+out\b/g, "logout")
    .replace(/\bsign\s+out\b/g, "logout")
    .replace(/\bsign\s+up\b/g, "signup")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

/* ─── document building ─── */

/** Pull the human-meaningful strings out of a plan step (target/field/value/option/text + route path). */
function stepText(step: Record<string, unknown>): string {
  const parts: string[] = [];
  const action = typeof step.action === "string" ? step.action : "";
  if (action && action !== "waitForLoad" && action !== "waitFor") {parts.push(action);}
  for (const k of ["target", "field", "option", "value", "text"]) {
    const v = step[k];
    if (typeof v === "string" && v.trim()) {parts.push(v);}
  }
  const url = step.url;
  if (typeof url === "string" && url.trim()) {
    // Path segments only — the host is identical for every flow and would just add noise.
    try {
      parts.push(new URL(url, "http://x").pathname);
    } catch {
      parts.push(url);
    }
  }
  return parts.join(" ");
}

export interface FlowDocument {
  key: string;
  /** The searchable text; see `buildFlowDocument` for what goes in and why. */
  text: string;
  tokens: string[];
  flow: GoldenFlow;
}

/**
 * Field weights (BM25F-style: a field is weighted by repeating its tokens).
 *
 * The ordering is a **prior about which field expresses intent**, not a fit to any benchmark:
 *  - `key` — what the flow *is* (`customer-login`, and for generated packs `form-login`). Most
 *    intent-bearing, and the one field every pack always has.
 *  - `tags` — the user's vocabulary for that intent, when a pack supplies it (G2.1).
 *  - `description` — carries the *discriminating* signal when flows share steps: on demo-web,
 *    `customer-login` / `admin-login` / `login-invalid` / `logout` all fill Email+Password and click
 *    Sign In, so only the description separates them.
 *  - `steps` — implementation detail. Element labels are real evidence but weakly intentional, and
 *    repeated step text (e.g. two "Add to Cart" clicks) otherwise inflates term frequency.
 */
const FIELD_WEIGHTS = { key: 3, tags: 2, description: 1, steps: 1 } as const;

function repeat(text: string, times: number): string[] {
  return text.trim() ? Array.from({ length: times }, () => text) : [];
}

/** Build the searchable text for one flow, applying `FIELD_WEIGHTS`. */
export function buildFlowDocument(key: string, flow: GoldenFlow): FlowDocument {
  const parts = [
    ...repeat(key, FIELD_WEIGHTS.key),
    ...repeat((flow.tags ?? []).join(" "), FIELD_WEIGHTS.tags),
    ...repeat(flow.description ?? "", FIELD_WEIGHTS.description),
    ...repeat(flow.routeKey ?? "", FIELD_WEIGHTS.description),
    ...repeat(
      (flow.steps ?? []).map((s) => stepText(s as Record<string, unknown>)).join(" "),
      FIELD_WEIGHTS.steps
    ),
  ];
  const text = parts.join(" ");
  return { key, text, tokens: tokenize(text), flow };
}

/* ─── BM25 ─── */

export interface FlowIndex {
  docs: FlowDocument[];
  /** document frequency per term */
  df: Map<string, number>;
  avgLen: number;
}

export function buildFlowIndex(flows: Record<string, GoldenFlow> | null | undefined): FlowIndex {
  const docs = Object.entries(flows ?? {}).map(([k, f]) => buildFlowDocument(k, f));
  const df = new Map<string, number>();
  for (const d of docs) {
    for (const t of new Set(d.tokens)) {df.set(t, (df.get(t) ?? 0) + 1);}
  }
  const avgLen = docs.length ? docs.reduce((a, d) => a + d.tokens.length, 0) / docs.length : 0;
  return { docs, df, avgLen };
}

export interface FlowHit {
  key: string;
  score: number;
  flow: GoldenFlow;
}

const K1 = 1.2;
/**
 * Length normalization, deliberately low (textbook default is 0.75).
 *
 * BM25's `b` exists to punish long documents on the assumption that length means padding. That
 * assumption is false here: a flow document's length reflects **how many steps the scenario has**, not
 * verbosity. A 3-step smoke test is not more relevant than a 10-step checkout, yet b=0.75 was handing
 * short flows a decisive edge — it is why `logout` (a terse flow) outranked `customer-login` on a prompt
 * that says "login" twice.
 */
const B = 0.3;
/** Query-term-frequency saturation (standard BM25 `k3`). */
const K3 = 8;

/**
 * Okapi BM25. Raw (unbounded) scores are returned on purpose: normalizing to 0..1 by the best hit would
 * make top-1 always 1.0 and destroy the very signal G2.3's abstain threshold needs. Callers compare the
 * top score and the top-1/top-2 margin instead.
 */
export function rankFlowsLexical(index: FlowIndex, query: string, limit = 5): FlowHit[] {
  const qTokens = tokenize(query);
  if (!index.docs.length || !qTokens.length) {return [];}
  const N = index.docs.length;

  // Query term frequency. The classic short-query simplification treats the query as a SET, but our
  // "query" is a whole natural-language prompt where repetition is real intent signal — "Add 3 products
  // to cart, go to cart page … " says cart twice and products once, and dropping that let
  // `product-detail` outrank `cart`. This is the `qtf` half of full BM25, not an invention.
  const qtf = new Map<string, number>();
  for (const t of qTokens) {qtf.set(t, (qtf.get(t) ?? 0) + 1);}

  const hits = index.docs.map((d) => {
    const len = d.tokens.length || 1;
    const tf = new Map<string, number>();
    for (const t of d.tokens) {tf.set(t, (tf.get(t) ?? 0) + 1);}

    let score = 0;
    for (const [q, qf] of qtf) {
      const f = tf.get(q);
      if (!f) {continue;}
      const df = index.df.get(q) ?? 0;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      const docPart = (f * (K1 + 1)) / (f + K1 * (1 - B + (B * len) / (index.avgLen || len)));
      const queryPart = ((K3 + 1) * qf) / (K3 + qf); // saturating, so a repeated word can't dominate
      score += idf * docPart * queryPart;
    }
    return { key: d.key, score, flow: d.flow };
  });

  return hits
    .filter((h) => h.score > 0)
    // Ties broken by key for determinism — two runs must never disagree.
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
    .slice(0, limit);
}

/* ─── semantic ranking (vectors supplied by core/knowledge/FlowEmbeddings.ts) ─── */

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Rank flows by cosine similarity between the query vector and each flow's document vector. */
export function rankFlowsSemantic(
  index: FlowIndex,
  vectors: Map<string, number[]>,
  queryVector: number[],
  limit = 5
): FlowHit[] {
  if (!queryVector?.length) {return [];}
  return index.docs
    .map((d) => {
      const v = vectors.get(d.key);
      return v ? { key: d.key, score: cosineSimilarity(queryVector, v), flow: d.flow } : null;
    })
    .filter((h): h is FlowHit => h !== null && h.score > 0)
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
    .slice(0, limit);
}

/* ─── rank fusion (used by G2.3 to blend lexical + semantic) ─── */

/**
 * Reciprocal Rank Fusion. Combines rankings without needing their scores to be commensurable — which
 * matters here because BM25 scores and cosine similarities live on completely different scales, so any
 * weighted sum of the two would be arbitrary. `k` damps the influence of low ranks.
 */
export function fuseRankings(rankings: Array<Array<{ key: string }>>, k = 60): Array<{ key: string; score: number }> {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((item, i) => {
      scores.set(item.key, (scores.get(item.key) ?? 0) + 1 / (k + i + 1));
    });
  }
  return [...scores.entries()]
    .map(([key, score]) => ({ key, score }))
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
}

/* ─── abstain + top-level retrieval ─── */

/**
 * Structurally multi-state requests: a single golden flow cannot express them, no matter how well it
 * scores. These patterns are **generic English about web sessions**, not app vocabulary — "guest",
 * "versus", "session expired" are not e-commerce nouns — so this is not the L1 hardcoding we are removing.
 *
 * ⚠️ **Why this exists instead of a confidence threshold.** Measured on demo-web (2026-08-09): the one
 * prompt that should abstain (#14, "add to cart as guest … Then cancel, login … return to checkout")
 * scored the *highest* confidence of almost any prompt — BM25 12.08, top-1/top-2 margin 55% — while a
 * prompt whose correct answer merely ranked 2nd sat at 5%. Score, margin and query-term coverage were all
 * tested and **none separates the two classes**: any cutoff that rejects #14 also rejects six
 * confidently-correct prompts. The property is structural, not statistical, so it needs a structural test.
 */
const MULTI_STATE_PATTERNS: RegExp[] = [
  /\b(vs\.?|versus)\b/i,
  /\bcompare(s|d)?\b|\bcomparison\b/i,
  /\bpersist(s|ed|ence)?\b[\s\S]{0,40}\b(across|between|after)\b/i,
  /\bsession\s+(expir|timeout|timed\s*out)/i,
  /\bdouble[-\s]?(submit|click)/i,
  /\bcross[-\s]?(device|browser|tab|session)/i,
  // Two authentication states in one request — the #14 shape. Allowed to cross sentence boundaries,
  // because the second phase is normally a new sentence ("…appears. Then cancel, login with…").
  /\bguest\b[\s\S]{0,160}\b(log\s?in|logged\s?in|sign\s?in|signed\s?in)\b/i,
  /\b(log\s?in|logged\s?in|sign\s?in|signed\s?in)\b[\s\S]{0,160}\bas\s+(a\s+)?guest\b/i,
];

/** True when a request spans multiple states/sessions that no single golden flow can encode. */
export function isMultiStateRequest(text: string): boolean {
  const t = String(text ?? "");
  return MULTI_STATE_PATTERNS.some((re) => re.test(t));
}

/* ─── key-coverage tie-break ─── */

/**
 * Fraction of a flow key's OWN tokens that the query justifies. `customer-login` against "…click Sign
 * In…login page…" → {customer, login} both present → 1.0; `logout` → {logout} absent → 0.0.
 */
export function keyCoverage(key: string, queryTokens: string[]): number {
  const kt = [...new Set(tokenize(key))];
  if (!kt.length) {return 0;}
  const q = new Set(queryTokens);
  return kt.filter((t) => q.has(t)).length / kt.length;
}

/**
 * How close the top two must be before the tie-break is consulted.
 *
 * Measured 2026-08-09: the outcome is **identical for every margin from 0.05 to 0.5** — a 10× range —
 * so the mechanism, not the constant, is doing the work. 0.15 sits mid-range. Below ~0.03 the tie-break
 * never fires and the two known failures return.
 */
const TIE_BREAK_MARGIN = 0.15;

/**
 * Prefer the flow whose NAME the request justifies, when two flows score within `TIE_BREAK_MARGIN`.
 *
 * WHY THIS EXISTS. BM25 counts the query terms a document contains and is blind to what a document
 * claims to be. That breaks on **superset flows**: demo-web's `logout` must log in first, so its steps
 * contain `customer-login`'s entire sequence, and its description ("**User** logout — **sign** out from
 * account") coincidentally matches "verify **user** is redirected" and "click **Sign** In". It therefore
 * outscored `customer-login` on a pure login request — and, being a verified flow, would have PASSED
 * while testing the wrong thing. Same shape on a cart request, where `product-detail` says "Add to Cart"
 * twice and so out-counts `cart` itself.
 *
 * A flow's key is its identity claim. Requiring that claim to be justified is app-neutral: it reads only
 * the pack's own key vocabulary, and works the same for generated keys (`form-login`, `smoke-home`).
 *
 * ⚠️ Not to be confused with the **abstain** policy below, which deliberately has NO threshold of any
 * kind. This reorders two candidates we are already confident about; it never rejects one.
 */
function applyKeyCoverageTieBreak(candidates: FlowHit[], queryTokens: string[]): FlowHit[] {
  const [a, b] = candidates;
  if (!a || !b || a.score <= 0) {return candidates;}
  if ((a.score - b.score) / a.score > TIE_BREAK_MARGIN) {return candidates;}
  if (keyCoverage(b.key, queryTokens) <= keyCoverage(a.key, queryTokens)) {return candidates;}
  return [b, a, ...candidates.slice(2)];
}

/**
 * Promote over a flow that performs **no interaction at all** (G3.11).
 *
 * WHY, and why this rule and not a scoring tweak. BM25 sees words. TaskFlow prompt 18 —
 * *"go to the sign in page, **enter** ada@taskflow.test and Taskflow123!, **click** Sign in"* — retrieved
 * `smoke-login`, whose entire body is `goto /login; waitForLoad; expectVisible "Sign in to TaskFlow"`.
 * Every word in that prompt is about signing in, so no amount of text ranking separates it from
 * `loginAdmin`, which actually fills both fields and submits. Only the steps can.
 *
 * ⚠️ **The condition is categorical, not a threshold — deliberately.** A tuned margin was measured first
 * and rejected: prompt 18 needed ≥0.179, prompt 7 would have needed ≥0.335, and 0.363 started promoting
 * *wrong* flows. Fitting a constant into a 3% window on twenty examples from one app is exactly the
 * overfitting this initiative exists to undo. So the rule states something that is true regardless of
 * score: **a flow that interacts with nothing cannot be the answer to a request that asks to fill, pick,
 * tick or click** — when a candidate that does all of it is available. Nothing else is reordered.
 *
 * ⚠️ **It cannot fix a flow that clicks the WRONG thing, and must not pretend to.** Prompt 7 ("click
 * Apollo Redesign") is outranked by a flow that clicks the "Projects" nav link — structurally a click, and
 * substantively the wrong one. Promoting it would satisfy the substance audit while testing something the
 * prompt never asked for. Measured: this rule moves exactly **one** TaskFlow prompt. The other seven are
 * pack *coverage*, not ranking — no flow in the pack can do what they ask.
 *
 * Promotion only, never rejection: with no capable candidate the original order stands, because a partial
 * test beats no test.
 */
export function applyInteractionCoverage(candidates: FlowHit[], request: string): FlowHit[] {
  const wanted = requestedInteractions(request);
  if (!wanted.length || candidates.length < 2) {return candidates;}

  const top = candidates[0];
  // Only step aside for a flow that does nothing the request asks for...
  if (!top || interactionCoverage(top.flow.steps as any[], wanted) > 0) {return candidates;}
  // ...and only when it interacts with nothing at all. A flow that *does* act is a real answer that this
  // rule is not competent to second-guess (see prompt 7 above).
  if (INTERACTION_STEPS.some((a) => (top.flow.steps ?? []).some((s: any) => s?.action === a))) {
    return candidates;
  }

  // ⚠️ And only from the SAME page. Without this the rule promotes across the app: on the generated-pack
  // eval, "filter the Projects list by name" (top: a `/projects` smoke flow) was answered by `form-new` on
  // `/tasks/new`, purely because that flow contains a `fill` — retrieval went 15/20 -> 12/20 hit@1. A flow
  // that acts on a different page is not a better answer to the same request; it is a different request.
  const page = flowTargetPage(top.flow);
  const capable = candidates
    .slice(1)
    .find(
      (c) =>
        flowTargetPage(c.flow) === page &&
        interactionCoverage(c.flow.steps as any[], wanted) >= 1
    );
  if (!capable) {return candidates;}
  return [capable, ...candidates.filter((c) => c.key !== capable.key)];
}

/** Step actions that constitute "this flow interacts with the page". */
const INTERACTION_STEPS = ["click", "fill", "select", "check", "uncheck", "hover", "press"];

/**
 * The page a flow operates on: its declared `routeKey` when the pack supplies one (G2.1), else the path of
 * its last `goto`. Deliberately simple — this only has to answer "same page or not?".
 */
function flowTargetPage(flow: GoldenFlow): string {
  if (flow.routeKey) {return String(flow.routeKey);}
  const gotos = (flow.steps ?? []).filter((s: any) => s?.action === "goto" && s?.url);
  const last = gotos[gotos.length - 1] as any;
  if (!last) {return "";}
  try {
    return new URL(String(last.url), "http://x").pathname.replace(/\/+$/, "") || "/";
  } catch {
    return String(last.url);
  }
}

export interface FlowRetrieval {
  /** The selected flow, or null when we abstained. */
  hit: FlowHit | null;
  candidates: FlowHit[];
  /** Fraction of the request's distinct terms present in the top document. **Diagnostic only** — it is
   *  reported for logging and is deliberately NOT used as a gate (see `MULTI_STATE_PATTERNS`). */
  coverage: number;
  abstained: boolean;
  reason: string;
  via: "lexical" | "hybrid";
}

/**
 * Select a golden flow for a request, or abstain.
 *
 * Abstain has exactly **two** triggers, both of which the data supports:
 *  1. **no candidate at all** — zero term overlap and no semantic hit. Verified clean: unrelated requests
 *     ("deploy the kubernetes cluster", "what is the weather") produce zero hits, while the weakest
 *     *correct* demo-web prompt still matched. No arbitrary floor constant is needed, so none is used.
 *  2. **structurally multi-state** — see `MULTI_STATE_PATTERNS`.
 *
 * There is deliberately **no score/margin/coverage threshold**; it was measured and does not work.
 *
 * Sync and pure so it is fully unit-testable. Semantic input is optional: pass `vectors` + `queryVector`
 * (from `FlowEmbeddings.ts`) to blend in cosine ranking via RRF; omit them for lexical-only, which is the
 * behavior with no embeddings configured.
 */
export function rankFlows(
  index: FlowIndex,
  query: string,
  opts?: {
    vectors?: Map<string, number[]>;
    queryVector?: number[];
    limit?: number;
    /**
     * G4.5 — how often plans built on each flow actually passed. Optional and **absent by default**: with
     * no history (or no DB) retrieval is byte-for-byte what it was before G4. The prior is deliberately
     * narrow (`flowPrior` bounds it to ±15%) because relevance is the primary signal and history is a
     * tie-breaker — a flow that is textually the obvious answer must not be displaced because it once
     * failed for an unrelated reason.
     */
    flowStats?: Map<string, { flowKey: string; attempts: number; passes: number }>;
  }
): FlowRetrieval {
  const limit = opts?.limit ?? 5;
  const lexical = rankFlowsLexical(index, query, limit);

  const canSemantic = !!(opts?.vectors?.size && opts?.queryVector?.length);
  const semantic = canSemantic
    ? rankFlowsSemantic(index, opts!.vectors!, opts!.queryVector!, limit)
    : [];
  const via: "lexical" | "hybrid" = canSemantic ? "hybrid" : "lexical";

  // RRF rather than a weighted sum: BM25 scores and cosine similarities are not commensurable, so any
  // weighting between them would be arbitrary. Rank position is comparable; magnitude is not.
  let candidates: FlowHit[];
  if (semantic.length) {
    const byKey = new Map<string, FlowHit>();
    for (const h of [...lexical, ...semantic]) {byKey.set(h.key, h);}
    candidates = fuseRankings([lexical, semantic])
      .map((f) => {
        const base = byKey.get(f.key)!;
        return { key: f.key, score: f.score, flow: base.flow };
      })
      .slice(0, limit);
  } else {
    candidates = lexical;
  }

  // History prior BEFORE the structural rules: it only nudges scores, and the rules below reason about
  // near-ties, so they must see the adjusted numbers.
  if (opts?.flowStats?.size) {
    candidates = candidates
      .map((c) => ({ ...c, score: c.score * flowPrior(opts.flowStats!.get(c.key)) }))
      .sort((a, b) => b.score - a.score);
  }

  const queryTokens = tokenize(query);
  candidates = applyKeyCoverageTieBreak(candidates, queryTokens);
  // Capability last: identity ("is this the login flow?") settles first, then "can it act at all?".
  candidates = applyInteractionCoverage(candidates, query);

  const top = candidates[0] ?? null;

  // Diagnostic coverage of the top hit.
  let coverage = 0;
  if (top) {
    const q = new Set(queryTokens);
    const doc = index.docs.find((d) => d.key === top.key);
    if (doc && q.size) {
      const docTokens = new Set(doc.tokens);
      let matched = 0;
      for (const t of q) {if (docTokens.has(t)) {matched++;}}
      coverage = matched / q.size;
    }
  }

  if (isMultiStateRequest(query)) {
    return {
      hit: null,
      candidates,
      coverage,
      abstained: true,
      reason: "request spans multiple states/sessions — no single golden flow can express it",
      via,
    };
  }

  if (!top) {
    return {
      hit: null,
      candidates,
      coverage,
      abstained: true,
      reason: "no golden flow shares any term with the request",
      via,
    };
  }

  return {
    hit: top,
    candidates,
    coverage,
    abstained: false,
    reason: `matched "${top.key}"`,
    via,
  };
}
