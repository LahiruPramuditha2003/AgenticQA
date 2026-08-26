/**
 * ScenarioPlanner — deterministic-first planning over RETRIEVED golden flows (G2.4).
 *
 * Given a request, select one of the app's VERIFIED golden flows from its knowledge pack, bind the
 * request's parameters into it, and return it as a plan. No LLM call — so the result is stable
 * regardless of model quality. Returns null (→ the LLM/RAG path) when the app ships no pack, or when
 * retrieval abstains.
 *
 * WHAT CHANGED IN G2.4 — and why
 * ------------------------------
 * This file used to be a ~20-branch regex ladder whose branch targets were demo-web's 15 flow keys
 * (`customer-login`, `search`, `cart`, …), plus a hardcoded `KNOWN_CATEGORIES` list of that app's
 * product categories. It scored 100% on the app it was written for and could not fire at all on any
 * other: an auto-generated pack emits keys like `smoke-home` / `form-login`, which no branch mentions,
 * so the entire `generate_pack` pipeline produced output that no consumer could read (limitation L2).
 *
 * It is replaced by `FlowIndex` retrieval, which reads the pack's own vocabulary and therefore works
 * on any pack, generated or hand-written. Determinism is preserved exactly: retrieval only *selects* a
 * human- or execution-verified flow, it never authors steps. That was always the property worth having
 * — the regex was merely one (overfitted) way of selecting.
 *
 * Parameter binding is likewise de-hardcoded. `adaptSearch`/`adaptCategory` used to pattern-match
 * demo-web literals (`/^all products/`, the category list). The replacement is app-neutral and rests on
 * a structural observation: **a golden flow demonstrates its parameter by example.** `search` fills
 * "laptop" and then asserts `All Products - "laptop"`; `filter-category-select` selects "Laptops" and
 * asserts "Laptops". So the parameter is the literal that appears in BOTH an action step and an
 * assertion — findable without knowing anything about the app. See `findExemplar` for the guard that
 * keeps this from mistaking a button label for a parameter.
 */

import type { AppKnowledgePack } from "../../core/knowledge/AppKnowledgePack";
import { buildFlowIndex, rankFlows, type FlowIndex } from "../../core/knowledge/FlowIndex";

type Step = Record<string, any>;

/** The slice of a live `PageContext` used for parameter binding — kept structural so tests need no fixture. */
export interface ParameterSource {
  selects?: Array<{ name?: string; label?: string; options?: string[] }>;
}

export interface ScenarioPlanOptions {
  /** Live page inventory. Supplies a `<select>`'s REAL options, replacing the old `KNOWN_CATEGORIES`. */
  pageContext?: ParameterSource | null;
  logger?: { log: (msg: string) => void };
  /** Called with the retrieved flow's key. Lets the caller attribute the run's outcome back to the flow
   *  (G4's `flow_stat`) without altering this function's return value, which is snapshot-locked. */
  onFlowSelected?: (flowKey: string) => void;
}

function makeTitle(request: string): string {
  const t = request.length > 70 ? request.slice(0, 70) + "..." : request;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function clone(steps: Step[]): Step[] {
  return steps.map((s) => ({ ...s }));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const eq = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Whole-word, case-insensitive mention test (so "Audio" doesn't match inside "audiobook"). */
function mentions(text: string, term: string): boolean {
  if (!term.trim()) {return false;}
  return new RegExp(`\\b${escapeRegExp(term.trim())}\\b`, "i").test(text);
}

/** First single- or double-quoted literal in the request, if any. Generic English punctuation. */
function quotedLiteral(request: string): string | null {
  const m = request.match(/["'“‘]([^"'”’]{1,40})["'”’]/);
  return m && m[1].trim() ? m[1].trim() : null;
}

/**
 * Pull the search term out of a request. These are generic English phrasings ("search for X",
 * "look for X") — not app vocabulary — so this stays in engine code.
 */
export function extractSearchTerm(r: string): string | null {
  const m =
    r.match(/search(?:\s+for)?\s+["']?([a-z0-9][a-z0-9\s-]{0,30}?)["']?(?:\s+(?:in|on|and|then|,|\.)|$)/i) ||
    r.match(/(?:find|look for)\s+["']?([a-z0-9][a-z0-9\s-]{0,30}?)["']?(?:\s+(?:in|on|and|then|,|\.)|$)/i);
  return m && m[1] ? m[1].trim() : null;
}

/* ─── parameter binding ─── */

/** The literal a step contributes as an *action* value (as opposed to an assertion). */
function actionLiteral(step: Step): string | null {
  if (step.action === "fill") {return typeof step.value === "string" ? step.value : null;}
  if (step.action === "select") {return typeof step.option === "string" ? step.option : null;}
  if (step.action === "click") {return typeof step.target === "string" ? step.target : null;}
  return null;
}

function assertionLiterals(steps: Step[]): string[] {
  const out: string[] = [];
  for (const s of steps) {
    if (!/^expect/i.test(String(s.action ?? ""))) {continue;}
    for (const k of ["target", "text", "value"]) {
      if (typeof s[k] === "string" && s[k].trim()) {out.push(s[k]);}
    }
  }
  return out;
}

export type ExemplarKind = "search" | "select" | "categorical";
export interface Exemplar {
  /** The example value the flow was authored with, e.g. "laptop" or "Laptops". */
  value: string;
  kind: ExemplarKind;
  /** The field/label the value belongs to, for matching against the right `<select>`. */
  field?: string;
}

/**
 * Find the flow's parameter, by example.
 *
 * A flow demonstrates its parameter by using a literal in an action AND echoing it in an assertion:
 * select "Laptops" → assert "Laptops"; fill "laptop" → assert `All Products - "laptop"`. That echo is
 * the signal, and it needs no app knowledge.
 *
 * ⚠️ The echo alone is NOT sufficient, which is easy to miss: demo-web's `product-detail` flow clicks
 * "Add to Cart" and then asserts "Add to Cart", so it looks exactly like a parameterized flow. A button
 * label is not a parameter, and swapping it would wreck the test. `resolveReplacement` therefore
 * requires a `categorical` exemplar to be a real member of some `<select>`'s option set before it will
 * substitute anything — "Smartphones" is; "Add to Cart" is not.
 */
export function findExemplar(steps: Step[], pack?: AppKnowledgePack | null): Exemplar | null {
  const asserts = assertionLiterals(steps).map((a) => a.toLowerCase());
  const echoed = (v: string) => asserts.some((a) => a.includes(v.toLowerCase()));
  const searchLabel = String(pack?.stableElements?.searchInput ?? "").toLowerCase();

  for (const s of steps) {
    const lit = actionLiteral(s);
    if (!lit || !lit.trim()) {continue;}

    if (s.action === "fill") {
      const field = String(s.field ?? "");
      // A search box is identified from the pack's own `stableElements`, or by the field naming itself.
      // (Filling a *search* box is inherently parameterized, so no echo is required here.)
      if ((searchLabel && eq(field, searchLabel)) || /search/i.test(field)) {
        return { value: lit, kind: "search", field };
      }
      continue;
    }
    if (s.action === "select" && echoed(lit)) {
      return { value: lit, kind: "select", field: String(s.field ?? "") };
    }
    if (s.action === "click" && echoed(lit)) {
      return { value: lit, kind: "categorical", field: undefined };
    }
  }
  return null;
}

/**
 * ⚠️ REJECTED APPROACH — harvesting a value pool from the pack's other flows.
 *
 * It looked like a page-independent replacement for `KNOWN_CATEGORIES`: `filter-category-select` uses
 * "Laptops" and `category-card-click` uses "Smartphones", so the pack appears to demonstrate its own
 * category vocabulary. Measured, it was actively wrong. The `navigate` flow clicks "Products" and
 * asserts "All Products", so "Products" is echoed and joins the pool; the request "Go to Products,
 * filter by category Smartphones" then binds the category to **"Products"**. `product-detail`
 * contributes "Add to Cart" the same way. Exemplar detection is reliable enough to *parameterize a
 * chosen flow* but far too noisy to *define an app's value set*.
 *
 * The live page's real `<select>` options are the authoritative source, and pre-inspection runs before
 * planning, so they are normally present. When they are not, we simply leave the flow at its authored
 * value — always safe, because that value is what the flow was verified with.
 */

/** Options of the `<select>` whose label matches `field`, else the union of every select's options. */
function optionSetFor(src: ParameterSource | null | undefined, field?: string): string[] {
  const selects = src?.selects ?? [];
  if (!selects.length) {return [];}
  const named = field
    ? selects.filter((s) => eq(String(s.name ?? ""), field) || eq(String(s.label ?? ""), field))
    : [];
  const pool = named.length ? named : selects;
  const out: string[] = [];
  for (const s of pool) {
    for (const o of s.options ?? []) {
      if (typeof o === "string" && o.trim() && !out.some((x) => eq(x, o))) {out.push(o);}
    }
  }
  return out;
}

/**
 * What should the exemplar be replaced with for THIS request? Null means "leave the flow as authored",
 * which is always safe — the flow is verified as-is.
 */
export function resolveReplacement(
  request: string,
  ex: Exemplar,
  src?: ParameterSource | null
): string | null {
  if (ex.kind === "search") {
    const term = extractSearchTerm(request) ?? quotedLiteral(request);
    return term && !eq(term, ex.value) ? term : null;
  }

  // The live page is the authoritative option set (see the rejected-approach note above).
  const options = optionSetFor(src, ex.field);

  // A click target is only a parameter if it is a real member of some value set (see `findExemplar`),
  // which is what stops a button label like "Add to Cart" from being substituted.
  if (ex.kind === "categorical" && !options.some((o) => eq(o, ex.value))) {return null;}

  // Page order is the app's own ordering, which makes the choice deterministic when a request names
  // several values ("click each category card (Laptops, Smartphones, Audio)").
  const mentioned = options.find((o) => !eq(o, ex.value) && mentions(request, o));
  if (mentioned) {return mentioned;}

  // No live page inventory (not yet inspected, or offline): a quoted literal is the only evidence we
  // trust for a named option — `filter by category "Smartphones"`.
  if (!options.length && ex.kind === "select") {
    const q = quotedLiteral(request);
    if (q && !eq(q, ex.value)) {return q;}
  }
  return null;
}

/**
 * Substitute the exemplar for the request's value across every *content* field of the flow.
 *
 * Deliberately does NOT touch `field` or `url`: those identify elements and routes, not data. This one
 * substitution subsumes both of the old hardcoded adapters — rewriting `All Products - "laptop"` to
 * `All Products - "smartphone"` falls out of it instead of needing a demo-web-shaped regex.
 */
export function bindParameter(steps: Step[], oldValue: string, newValue: string): void {
  if (!oldValue || !newValue || eq(oldValue, newValue)) {return;}
  const re = new RegExp(escapeRegExp(oldValue), "gi");
  for (const s of steps) {
    for (const k of ["value", "option", "target", "text"]) {
      if (typeof s[k] === "string") {s[k] = s[k].replace(re, newValue);}
    }
  }
}

/* ─── entry point ─── */

// Indexing is cheap, but a plan can be built repeatedly for the same pack; key off the flows object.
const INDEX_CACHE = new WeakMap<object, FlowIndex>();

function indexFor(pack: AppKnowledgePack | null | undefined): FlowIndex | null {
  const flows = pack?.goldenFlows;
  if (!flows || typeof flows !== "object") {return null;}
  let idx = INDEX_CACHE.get(flows as object);
  if (!idx) {
    idx = buildFlowIndex(flows);
    INDEX_CACHE.set(flows as object, idx);
  }
  return idx;
}

/**
 * Map a request to a deterministic plan, or null to defer to the LLM path.
 *
 * @param requestText the user request
 * @param pack the app knowledge pack (null → no deterministic scenarios)
 * @param opts live page context (for parameter binding) and a logger
 */
export function buildScenarioPlan(
  requestText: string,
  pack: AppKnowledgePack | null | undefined,
  opts?: ScenarioPlanOptions
): { testCases: Array<{ title: string; steps: Step[] }> } | null {
  const index = indexFor(pack);
  if (!index || !index.docs.length) {return null;} // no app knowledge → page-grounded LLM path

  const retrieval = rankFlows(index, requestText ?? "");
  if (retrieval.abstained || !retrieval.hit) {
    opts?.logger?.log(`ScenarioPlanner: no deterministic flow — ${retrieval.reason}`);
    return null;
  }

  const steps = clone((retrieval.hit.flow.steps ?? []) as Step[]);
  if (!steps.length) {return null;}

  // Report which flow was chosen WITHOUT changing the return shape — `buildScenarioPlan`'s output is an
  // exact offline fingerprint locked by `test/fixtures/scenarioPlans.demo-web.json`, and G4 must not
  // disturb it. The caller uses this to attribute the run's outcome back to the flow (`flow_stat`).
  opts?.onFlowSelected?.(retrieval.hit.key);

  const runnerUp = retrieval.candidates[1];
  opts?.logger?.log(
    `ScenarioPlanner: retrieved golden flow "${retrieval.hit.key}" ` +
      `(${retrieval.via}, score ${retrieval.hit.score.toFixed(2)}` +
      (runnerUp ? `, next "${runnerUp.key}" ${runnerUp.score.toFixed(2)}` : "") +
      `)`
  );

  const exemplar = findExemplar(steps, pack);
  if (exemplar) {
    const replacement = resolveReplacement(requestText ?? "", exemplar, opts?.pageContext);
    if (replacement) {
      bindParameter(steps, exemplar.value, replacement);
      opts?.logger?.log(
        `ScenarioPlanner: bound ${exemplar.kind} parameter "${exemplar.value}" -> "${replacement}"`
      );
    }
  }

  return { testCases: [{ title: makeTitle(requestText), steps }] };
}
