import OpenAI from "openai";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { RunContext, PageContext, PageElement } from "../core/agent/types";
import {
  resolveCredentials,
  formatCredentialsBlock,
  resolvePlannerGuidance,
} from "../core/knowledge/AppKnowledgePack";
import type { AppKnowledgePack, GoldenFlow } from "../core/knowledge/AppKnowledgePack";
import { buildFlowIndex, rankFlowsLexical } from "../core/knowledge/FlowIndex";
import { buildScenarioPlan } from "../agents/TestPlannerAgent/ScenarioPlanner";
import { flattenPageContext } from "../agents/TestPlannerAgent/PlanGrounder";
import { resolveModelChain } from "../core/llm/models";
import { extractJsonObjects } from "../core/llm/json";
import knowledgeDocs from "./test-knowledge.json";

// ─── Golden Example selection (sourced from the app knowledge pack, not in-code) ─────

type GoldenFlowLite = { description: string; steps: object[] };

/**
 * Pick a golden flow template (from the pack's goldenFlows) most relevant to the request.
 *
 * G2.6: this was a SECOND regex ladder over the same 15 demo-web flow keys that G2.4 deleted from
 * `ScenarioPlanner` — the last row of limitation L1. It had both of that ladder's defects: it only fired
 * for packs using demo-web's exact key names (so auto-generated packs got no example at all), and it
 * duplicated selection logic that now lives in one place. It is replaced by the same retrieval.
 *
 * ⚠️ Uses `rankFlowsLexical`, NOT `rankFlows` — deliberately, and the difference matters. `rankFlows`
 * abstains on structurally multi-state requests, which is right when the hit *becomes the plan*. Here the
 * hit is only a **style template shown to the LLM**, and the multi-state prompts are precisely the ones
 * that reach this path. Abstaining would hand the model an example-free prompt exactly when it most needs
 * to see the step vocabulary — a regression against the old ladder. Any related flow is useful here;
 * a wrong one costs formatting guidance, not correctness, because the LLM still authors the steps.
 */
export function selectGoldenExample(
  requestText: string,
  flows: Record<string, GoldenFlowLite>,
  _docs?: KnowledgeDoc[]
): GoldenFlowLite | null {
  if (!flows || !Object.keys(flows).length) {return null;}
  const hit = rankFlowsLexical(buildFlowIndex(flows as Record<string, GoldenFlow>), requestText ?? "", 1)[0];
  return hit ? (hit.flow as GoldenFlowLite) : null;
}

// ─── Types ────────────────────────────────────────────────────────────────────

type IntentType =
  | "auth" | "search" | "filter" | "cart" | "checkout"
  | "navigate" | "form" | "product" | "generic";

interface KnowledgeDoc {
  id: string;
  intent: IntentType;
  title: string;
  keywords: string[];
  description: string;
  stepGuidance: string[];
  assertions: string[];
  notes: string;
}

// ─── Embedding Utilities ──────────────────────────────────────────────────────

/**
 * Where the document-embedding cache lives (D44).
 *
 * This used to be `path.join(__dirname, …)`. Packaged, `__dirname` is `<extensionPath>/dist` — the
 * extension INSTALL directory, which VS Code **wipes on every update**, may mount read-only, and shares
 * between users of one machine. The write is `try`/`catch`-guarded so it never crashed a run; the cost was
 * silent: a packaged install would re-embed every knowledge document on **every run**, burning quota and
 * seconds, and never notice it had a cache at all. VS Code's contract is `globalStorageUri`, which the
 * extension passes down as `AGENTICQA_CACHE_DIR`.
 *
 * ⚠️ Resolved LAZILY, never at module load. `main.ts` calls `dotenv.config()` *after* its imports (ES
 * imports hoist), so a module-level constant would capture an empty environment and silently pick the
 * wrong directory — the same trap that made `DEFAULT_MODELS` a Proxy over `defaultModelsFor()`.
 */
export function cachePath(): string {
  const dir = (process.env.AGENTICQA_CACHE_DIR ?? "").trim();
  return dir
    ? path.join(dir, "embeddings-cache.json")
    : path.join(__dirname, "embeddings-cache.json");
}

function hashKnowledge(): string {
  return crypto.createHash("sha256")
    .update(JSON.stringify(knowledgeDocs))
    .digest("hex")
    .slice(0, 16);
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function getEmbeddingClient(): OpenAI | null {
  if (!process.env.OPENAI_API_KEY) return null;
  return new OpenAI({
    apiKey:  process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL,
    // Cap per-call time so a slow/overloaded (often free-tier) model fails fast and we fall back
    // to deterministic generation instead of stalling the whole pipeline for minutes.
    timeout: 60000,
    maxRetries: 1,
  });
}

async function embedBatch(client: OpenAI, texts: string[]): Promise<number[][]> {
  const model = process.env.OPENAI_EMBED_MODEL ?? "text-embedding-3-small";
  const response = await client.embeddings.create({ model, input: texts });
  return response.data
    .sort((a, b) => a.index - b.index)
    .map((e) => e.embedding);
}

// ─── Vector Knowledge Store ───────────────────────────────────────────────────

class KnowledgeStore {
  private docs: KnowledgeDoc[] = knowledgeDocs as KnowledgeDoc[];
  private embeddings: number[][] = [];
  private ready = false;

  // Embed all documents once at startup; cache to disk so restarts are instant.
  async initialize(logger: { log: (msg: string) => void }): Promise<boolean> {
    if (this.ready) return true;

    const client = getEmbeddingClient();
    if (!client) {
      logger.log("RAG: OPENAI_API_KEY not set — semantic retrieval unavailable");
      return false;
    }

    const hash = hashKnowledge();

    // Load from disk cache if the knowledge base hasn't changed
    const CACHE_PATH = cachePath();
    if (fs.existsSync(CACHE_PATH)) {
      try {
        const cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
        if (
          cache.hash === hash &&
          Array.isArray(cache.embeddings) &&
          cache.embeddings.length === this.docs.length
        ) {
          this.embeddings = cache.embeddings;
          this.ready = true;
          logger.log(`RAG: loaded ${this.embeddings.length} document embeddings from cache`);
          return true;
        }
        logger.log("RAG: knowledge base changed — re-indexing");
      } catch {
        logger.log("RAG: cache invalid — re-indexing");
      }
    }

    // Embed every document (title + description + keywords + step guidance)
    logger.log(`RAG: indexing ${this.docs.length} knowledge documents...`);
    const texts = this.docs.map((doc) =>
      [doc.title, doc.description, doc.keywords.join(" "), doc.stepGuidance.join(" ")].join("\n")
    );
    this.embeddings = await embedBatch(client, texts);

    // Persist to cache
    try {
      fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
      fs.writeFileSync(CACHE_PATH, JSON.stringify({
        hash,
        embeddings: this.embeddings,
      }));
      logger.log("RAG: embeddings cached to disk");
    } catch { /* non-fatal */ }

    this.ready = true;
    logger.log(`RAG: ${this.docs.length} documents indexed`);
    return true;
  }

  // Semantic retrieval: embed query → cosine similarity → top-K; also returns embedding for golden selection
  async retrieve(client: OpenAI, query: string, topK = 3): Promise<{ docs: KnowledgeDoc[]; queryEmbedding: number[] }> {
    const [queryEmbedding] = await embedBatch(client, [query]);

    const docs = this.docs
      .map((doc, i) => ({ doc, score: cosineSimilarity(queryEmbedding, this.embeddings[i]) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({ doc, score }) => {
        return { ...doc, _score: score } as any;
      });

    return { docs, queryEmbedding };
  }

  // BM25-style fallback used when embeddings are unavailable
  retrieveFallback(query: string, intent: IntentType, topK = 3): KnowledgeDoc[] {
    const qt = tokenize(query);
    return this.docs
      .map((doc) => {
        let s = 0;
        if (doc.intent === intent) s += 10;
        for (const kw of doc.keywords) {
          if (qt.some((t) => tokenize(kw).some((k) => k === t || k.includes(t) || t.includes(k)))) s += 3;
        }
        const tt = tokenize(doc.title);
        s += qt.filter((t) => tt.some((k) => k === t || k.includes(t))).length * 2;
        return { doc, s };
      })
      .sort((a, b) => b.s - a.s)
      .slice(0, topK)
      .map(({ doc }) => doc);
  }
}

// ─── Intent Classification (used only for deterministic fallback) ─────────────

function classifyIntent(request: string): IntentType {
  const r = request.toLowerCase();
  // Home page check must come before auth: "verify navigation bar shows Login link"
  // mentions "login" as a nav element, not as an action to perform.
  if (/(home page|main page|landing page|homepage|home screen)/.test(r)) return "navigate";
  if (/\b(login|log in|sign in|signin|logout|log out|sign up|signup|register|password|auth|authentication|forgot password|reset password)\b/.test(r)) return "auth";
  if (/\b(checkout|payment|billing|place order|shipping|order confirmation|order review)\b/.test(r)) return "checkout";
  if (/\b(cart|shopping cart|add to cart|remove from cart|bag)\b/.test(r)) return "cart";
  if (/\b(search|find|look for|query|lookup)\b/.test(r)) return "search";
  if (/\b(filter|sort|category|brand|price range|refine)\b/.test(r)) return "filter";
  if (/\b(product|item|detail|buy|purchase|add to bag)\b/.test(r)) return "product";
  if (/\b(form|submit|fill|enter|complete|fill out)\b/.test(r)) return "form";
  if (/\b(navigate|go to|visit|open)\b/.test(r)) return "navigate";
  return "generic";
}

// ─── Page Context Utilities ───────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
}

// ─── Prompt Builder ───────────────────────────────────────────────────────────

/**
 * Build the LLM planner prompt. The structural rules (output format, page-element constraints,
 * search-term extraction) are app-agnostic and always emitted. App-specific guidance is **pack-sourced**:
 * the credentials block and `plannerGuidance` are injected ONLY when the pack supplies them — with no
 * pack the prompt carries zero app-specific literals, so it generalizes to any inspected page.
 */
export function buildPrompt(
  requestText: string,
  docs: KnowledgeDoc[],
  pageContext: PageContext | undefined,
  startUrl: string,
  preSelectedGolden?: { description: string; steps: object[] } | null,
  pack?: AppKnowledgePack | null
): string {
  // Credentials + guidance come from the pack only, and only for the groups it actually declares —
  // `resolveCredentials` invents nothing, so an app that ships no credentials gets no credentials block
  // (G0.3). No pack → neither block (purely page-grounded).
  const credentialsBlock = formatCredentialsBlock(resolveCredentials(pack));
  const appGuidance = resolvePlannerGuidance(pack);
  const names = (arr: PageElement[] | undefined) =>
    (arr ?? []).map((e) => e.name).join(", ") || "(none)";

  const elementSection = pageContext ? `
## Available Page Elements
Use ONLY these exact element names in fill, click, select, and expectVisible steps. Do not invent element names.

Inputs:   ${names(pageContext.inputs)}
Buttons:  ${names(pageContext.buttons)}
Headings: ${names(pageContext.headings)}
Links:    ${names(pageContext.links)}
Selects:  ${names(pageContext.selects)}
` : "";

  const patternsSection = docs.map((doc, i) => `
### Retrieved Pattern ${i + 1}: ${doc.title}
${doc.description}

Step guidance:
${doc.stepGuidance.map((s, j) => `${j + 1}. ${s}`).join("\n")}

Key assertions:
${doc.assertions.map((a) => `- ${a}`).join("\n")}

Notes: ${doc.notes}
`).join("\n");

  const goldenExample = preSelectedGolden ?? null;
  const goldenSection = goldenExample ? `

## Verified Working Example
This exact JSON is KNOWN TO PASS. Use it as your structural template — copy the action sequence, then adapt field values and assertions to match the user request:
${JSON.stringify({ testCases: [{ title: goldenExample.description, steps: goldenExample.steps }] }, null, 2)}
` : "";

  return `You are a QA test automation planner for web applications.
Generate a Playwright test plan for the following user request.

## User Request
${requestText}
${elementSection}
## Retrieved Test Patterns
These patterns were retrieved by semantic similarity to the user request:
${patternsSection}
${goldenSection}
## Output Format
Return ONLY a valid JSON object — no markdown fences, no explanation:
{
  "testCases": [
    {
      "title": "descriptive test title",
      "steps": [
        {"action": "goto", "url": "${startUrl}"},
        {"action": "waitForLoad"},
        {"action": "fill", "field": "<name from Available Page Elements>", "value": "<realistic value>"},
        {"action": "click", "target": "<name from Available Page Elements>"},
        {"action": "waitForLoad"},
        {"action": "expectVisible", "target": "<name from Available Page Elements>"}
      ]
    }
  ]
}

Rules:
- Return exactly 1 test case
- Always start with goto (url: "${startUrl}") and waitForLoad
- Always end with at least one expectVisible or expectText step
- Every fill / click / select / expectVisible MUST use a name from Available Page Elements${credentialsBlock ? `\n\n${credentialsBlock}` : ""}${appGuidance ? `\n\n${appGuidance}` : ""}`;
}

// ─── LLM Generation ──────────────────────────────────────────────────────────

/**
 * ⚠️ **Reasoning models spend the budget before they answer.** The planner call used to cap at
 * `max_tokens: 1500`; `nemotron-3-super-120b` reasons in plain prose first and, on demo-web's prompt 14,
 * was cut off **mid-sentence after 6550 characters having emitted no JSON at all** — 0 balanced
 * candidates, so no parser could have saved it. The run then silently downgraded to the page-grounded
 * fallback and looked healthy. Same failure shape as the truncated pack-generation response in G3.6.
 *
 * A plan is small; the budget is spent on the thinking, so it has to accommodate the thinking.
 */
const PLANNER_MAX_TOKENS = 6000;

/**
 * ⚠️ A chat completion is not an embedding, and it must not inherit the embedding client's budget.
 * `getEmbeddingClient()`'s 60s timeout is right for a vector call that either answers fast or is
 * overloaded; a reasoning model producing a plan legitimately spends longer than that *thinking*, and
 * sharing the client meant every such response was aborted client-side and reported as a plain
 * "Request timed out" — indistinguishable from an outage.
 */
const PLANNER_TIMEOUT_MS = 150000;

function getPlannerChatClient(): OpenAI | null {
  if (!process.env.OPENAI_API_KEY) {return null;}
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL,
    timeout: PLANNER_TIMEOUT_MS,
    maxRetries: 1,
  });
}

async function callLLM(prompt: string): Promise<{ content: string; finishReason: string; model: string }> {
  // OpenAI-compatible API (OpenRouter etc.) — add system message for JSON discipline.
  const openaiClient = getPlannerChatClient();
  if (!openaiClient) throw new Error("No LLM API key configured (set OPENAI_API_KEY)");

  // Per-agent model + fallback chain for the "planner" role (registry-driven; see core/llm/models).
  // With only OPENAI_MODEL set, the chain is [OPENAI_MODEL, …safety], so the happy path is
  // unchanged and the extra models are tried only when the primary fails.
  const chain = resolveModelChain("planner");
  let lastError: Error | null = null;

  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    try {
      const response = await openaiClient.chat.completions.create({
        model,
        max_tokens: PLANNER_MAX_TOKENS,
        temperature: 0,
        messages: [
          { role: "system", content: "You are a QA automation planner. Always respond with valid JSON only, no markdown fences, no explanation." },
          { role: "user", content: prompt },
        ],
      });
      const content = response.choices[0]?.message?.content ?? "";
      const finishReason = response.choices[0]?.finish_reason ?? "unknown";
      if (content.trim().length > 0) {return { content, finishReason, model };}
      lastError = new Error("planner LLM returned empty content");
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
    if (i < chain.length - 1) {
      // stderr only — never the stdout JSON protocol.
      console.error(`planner: model ${model} failed (${lastError?.message ?? "unknown"}); trying ${chain[i + 1]}`);
    }
  }

  throw lastError ?? new Error("planner LLM failed");
}

/** Exported under a test-only name so the extraction rules can be locked offline (G3.9). */
export function parseLLMOutputForTest(raw: string): { testCases: any[] } | null {
  return parseLLMOutput(raw);
}

function parseLLMOutput(raw: string): { testCases: any[] } | null {
  // Strip <think>...</think> reasoning blocks (Nemotron, DeepSeek R1, QwQ, etc.) before
  // any parse attempt. These blocks often contain { } chars that break the bracket-scan
  // fallback below, causing it to grab reasoning text instead of the real JSON.
  const stripped = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const text = stripped.length > 0 ? stripped : raw;

  const usable = (c: string): { testCases: any[] } | null => {
    try {
      const p = JSON.parse(c);
      return p?.testCases?.length ? p : null;
    } catch {
      return null;
    }
  };

  const whole = usable(text.trim());
  if (whole) return whole;

  // Every fenced block, last first: a model that shows its work fences the answer last.
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]+?)\s*```/g)].map((m) => m[1]);
  for (const f of fences.reverse()) {
    const p = usable(f);
    if (p) return p;
  }

  // ⚠️ Balanced, string-aware candidates — NOT `indexOf("{")` … `lastIndexOf("}")`.
  // A model without `<think>` tags reasons in plain prose ("We need to output a JSON test plan…"),
  // usually quoting an inline example on the way. The naive slice starts inside that reasoning and can
  // never parse; demo-web's prompt 14 lost a valid 5663-char response to it on every run. Last first,
  // for the same reason as the fences.
  for (const c of extractJsonObjects(text).reverse()) {
    const p = usable(c);
    if (p) return p;
  }
  return null;
}

// ─── Deterministic Fallback ───────────────────────────────────────────────────

function findBestInput(pc: PageContext, hint: string, used?: Set<number>): PageElement | undefined {
  const h = hint.toLowerCase();
  const all = [...(pc.inputs ?? []), ...(pc.selects ?? [])];
  if (!all.length) return undefined;
  const score = (e: PageElement) => {
    const n = e.name.toLowerCase();
    if (n === h) return 10; if (n.includes(h)) return 5; if (h.includes(n) && n.length > 2) return 4;
    return h.split(/\s+/).filter((t) => n.split(/\s+/).some((k) => k.includes(t) || t.includes(k))).length;
  };
  const sorted = all.map((e, i) => ({ e, i, s: score(e) })).filter(({ i }) => !used?.has(i)).sort((a, b) => b.s - a.s);
  if (!sorted.length) return all[0];
  const best = sorted[0];
  if (best.s > 0) { used?.add(best.i); return best.e; }
  const u = all.findIndex((_, i) => !used?.has(i));
  if (u >= 0) { used?.add(u); return all[u]; }
  return all[0];
}

function findBestClickable(pc: PageContext, hint: string, used?: Set<number>): PageElement | undefined {
  const h = hint.toLowerCase();
  const all = [...(pc.buttons ?? []), ...(pc.links ?? [])];
  if (!all.length) return undefined;
  const score = (e: PageElement) => {
    const n = e.name.toLowerCase();
    if (n === h) return 10; if (n.includes(h)) return 5; if (h.includes(n) && n.length > 2) return 4;
    return h.split(/\s+/).filter((t) => n.split(/\s+/).some((k) => k.includes(t) || t.includes(k))).length;
  };
  const sorted = all.map((e, i) => ({ e, i, s: score(e) })).filter(({ i }) => !used?.has(i)).sort((a, b) => b.s - a.s);
  if (!sorted.length) return all[0];
  const best = sorted[0];
  if (best.s > 0) { used?.add(best.i); return best.e; }
  const u = all.findIndex((_, i) => !used?.has(i));
  if (u >= 0) { used?.add(u); return all[u]; }
  return all[0];
}

function sampleValue(f: string): string {
  const n = f.toLowerCase();
  if (n.includes("email") || n.includes("user")) return "customer@example.com";
  if (n.includes("pass") || n.includes("confirm")) return "password123";
  if (n.includes("full") && n.includes("name")) return "Test User";
  if (n.includes("first") && n.includes("name")) return "Test";
  if (n.includes("last") && n.includes("name")) return "User";
  if (n.includes("name")) return "Test User";
  if (n.includes("phone") || n.includes("tel")) return "555-0100";
  if (n.includes("zip") || n.includes("postal")) return "10001";
  if (n.includes("city")) return "New York";
  if (n.includes("state")) return "NY";
  if (n.includes("address")) return "123 Test Street";
  if (n.includes("search") || n.includes("query")) return "laptop";
  if (n.includes("card") && n.includes("number")) return "4111111111111111";
  if (n.includes("cvv") || n.includes("cvc")) return "123";
  if (n.includes("expir")) return "12/28";
  return "test value";
}

function buildTitle(r: string): string {
  const t = r.length > 60 ? r.slice(0, 60) + "..." : r;
  return t.charAt(0).toUpperCase() + t.slice(1);
}


/**
 * Narrow a multi-page `PageContext` down to the page a plan will actually be standing on.
 *
 * ⚠️ **The aggregate is a union, not a page.** `preInspectPage` browses several URLs and flattens their
 * elements into one `PageContext` (with the per-page contexts kept on `.pages`). Grounding against that
 * union lets a generator pick an element that exists *somewhere in the app* but not on the page the plan
 * just navigated to — and Playwright then waits the full 30s action timeout for something that will never
 * appear. That is exactly how demo-web's prompt 14 failed: intent `auth` filled the Email/Password
 * textboxes from `/auth/login` into a plan whose only `goto` was `/`, and two 30s waits × 5 browsers
 * walked straight into the executor's 300s cap — reported as `no-report`, with no failing step to look at.
 */
export function pageContextFor(pc: PageContext | undefined, url: string): PageContext | undefined {
  if (!pc?.pages?.length) {return pc;}
  const want = (u: string): string => {
    try {
      return new URL(u, "http://x").pathname.replace(/\/+$/, "") || "/";
    } catch {
      return u;
    }
  };
  const target = want(url);
  return pc.pages.find((p) => want(p.url) === target) ?? pc;
}

/**
 * Purely PAGE-GROUNDED deterministic fallback. Reached only when no scenario matched (so there is no
 * golden flow for this request) AND no LLM is available. It builds steps from the LIVE inspected page
 * ONLY — no hardcoded routes, credentials, or app-specific labels. App-specific verified flows live in
 * the pack's golden flows (consumed earlier by ScenarioPlanner); duplicating them here would re-couple
 * the general engine to one app. This page-grounded fallback is what lets the no-pack path run anywhere.
 */
export function generateDeterministic(intent: IntentType, ctx: RunContext, pcIn: PageContext | undefined, startUrl: string): any[] {
  const steps: any[] = [{ action: "goto", url: startUrl }, { action: "waitForLoad" }];
  // Every step below runs on `startUrl` — so ground on THAT page, not the union of every inspected one.
  const pc = pageContextFor(pcIn, startUrl);
  if (!pc) return [{ title: buildTitle(ctx.requestText), steps }];

  const isSearchLike = (name: string): boolean => {
    const n = name.toLowerCase();
    return ["search", "query", "category", "sort", "brand", "filter"].some((t) => n.includes(t));
  };
  // The most assertable, real on-page anchor — prefer a heading, then any button/link that exists.
  const anchorName = (): string | undefined =>
    (pc.headings ?? [])[0]?.name ?? (pc.buttons ?? [])[0]?.name ?? (pc.links ?? [])[0]?.name;
  const assertSomething = (): void => {
    const target = anchorName();
    if (target) steps.push({ action: "expectVisible", target });
  };

  switch (intent) {
    case "auth":
    case "form": {
      // Fill the real form fields present on this page, click a submit/primary button, assert an anchor.
      const formInputs = (pc.inputs ?? []).filter((i) => !isSearchLike(i.name)).slice(0, 6);
      for (const inp of formInputs) {
        steps.push({ action: "fill", field: inp.name, value: sampleValue(inp.name) });
      }
      const btn =
        findBestClickable(pc, "submit") ?? findBestClickable(pc, "sign in") ??
        findBestClickable(pc, "continue") ?? (pc.buttons ?? [])[0];
      if (btn) steps.push({ action: "click", target: btn.name });
      steps.push({ action: "waitForLoad" });
      assertSomething();
      break;
    }
    case "search": {
      const inp = findBestInput(pc, "search") ?? (pc.inputs ?? [])[0];
      const term = (ctx.requestText.match(/(?:search|find|look for)\s+(?:for\s+)?["']?([^"']+?)["']?(?:\s+on|\s+in|$)/i) ?? [])[1]?.trim() ?? "test";
      if (inp) steps.push({ action: "fill", field: inp.name, value: term });
      const btn = findBestClickable(pc, "search");
      if (btn) steps.push({ action: "click", target: btn.name });
      steps.push({ action: "waitForLoad" });
      assertSomething();
      break;
    }
    case "filter": {
      // Use a real <select> on the page and its first real option — no assumed category names.
      const sel = (pc.selects ?? [])[0];
      if (sel && sel.options && sel.options.length) {
        steps.push({ action: "select", field: sel.name, option: sel.options[0] });
        steps.push({ action: "waitForLoad" });
      }
      assertSomething();
      break;
    }
    case "cart":
    case "checkout": {
      // Click a real add/primary action if the page has one, then assert an anchor.
      const add =
        findBestClickable(pc, "add to cart") ?? findBestClickable(pc, "add") ?? (pc.buttons ?? [])[0];
      if (add) steps.push({ action: "click", target: add.name });
      steps.push({ action: "waitForLoad" });
      assertSomething();
      break;
    }
    default: {
      // navigate / product / generic — verify the page rendered via a real on-page anchor.
      assertSomething();
    }
  }

  // Guarantee at least one assertion so the generated spec is always valid.
  if (!steps.some((s) => /^expect/.test(s.action))) assertSomething();
  return [{ title: buildTitle(ctx.requestText), steps }];
}

// ─── Engine ───────────────────────────────────────────────────────────────────

export class RagPlannerEngine {
  private store = new KnowledgeStore();

  async generate(
    ctx: RunContext,
    logger: { log: (msg: string) => void }
  ): Promise<{ testCases: any[] }> {
    const { requestText } = ctx;
    const pageContext = ctx.pageContext ? flattenPageContext(ctx.pageContext) : undefined;
    const startUrl = ctx.effectiveStartUrl ?? ctx.effectiveBaseUrl ?? "/";

    // ── Deterministic-first: golden-anchored scenario plan ────────────────────
    // When the app ships a knowledge pack, retrieve the best-matching verified golden flow and bind
    // the request's parameters into it. No LLM call → stable regardless of model quality. Falls
    // through to the LLM path when retrieval abstains (or there is no pack).
    // `pageContext` supplies the live `<select>` options used for parameter binding (G2.4).
    const scenario = buildScenarioPlan(requestText, ctx.knowledgePack, {
      pageContext,
      logger,
      // G4: remember which flow the plan came from, so the run's outcome can be attributed to it.
      onFlowSelected: (key) => { ctx.selectedFlowKey = key; },
    });
    if (scenario) {
      logger.log("Planner: matched deterministic scenario — using golden flow (no LLM)");
      // Raw plan; TestPlannerAgent runs repairSteps + groundPlan (the single grounding layer).
      return scenario;
    }

    // ── RAG path: embed → retrieve → generate ─────────────────────────────────
    const embeddingClient = getEmbeddingClient();
    const hasGenerationKey = Boolean(process.env.OPENAI_API_KEY);

    // Offline mock mode (AGENTICQA_MOCK_LLM): skip all network calls and route through the
    // deterministic generator. Used by unit tests and the offline dev loop so planner→codegen
    // can run with no API key / no embeddings server. Has no effect on normal runs.
    const mockLlm =
      process.env.AGENTICQA_MOCK_LLM === "1" ||
      process.env.AGENTICQA_MOCK_LLM === "true";
    if (mockLlm) {
      logger.log("RAG: AGENTICQA_MOCK_LLM set — using offline deterministic generation");
    }

    if (!mockLlm && embeddingClient && hasGenerationKey) {
      try {
        // 1. Index documents (idempotent; uses cache on subsequent calls)
        const indexed = await this.store.initialize(logger);

        if (indexed) {
          // 2. Semantic retrieval — embed query, cosine similarity over doc vectors
          const { docs } = await this.store.retrieve(embeddingClient, requestText, 3);
          logger.log(`RAG: retrieved [${docs.map((d) => d.id).join(", ")}]`);

          // 3. Select a golden-flow template from the app's knowledge pack (no in-code copies)
          const goldenExample = selectGoldenExample(requestText, ctx.knowledgePack?.goldenFlows ?? {}, docs);

          // 4. Augment prompt with retrieved patterns + live page elements + pack credentials/guidance.
          //    With no pack, buildPrompt emits neither — the prompt stays purely page-grounded.
          const prompt = buildPrompt(
            requestText,
            docs,
            pageContext,
            startUrl,
            goldenExample,
            ctx.knowledgePack
          );

          // 4. Generate via LLM (Claude or OpenAI-compatible)
          logger.log("RAG: generating via LLM...");
          const { content: raw, finishReason, model: usedModel } = await callLLM(prompt);
          const parsed = parseLLMOutput(raw);

          if (parsed && parsed.testCases.length > 0) {
            // Raw plan; TestPlannerAgent runs repairSteps + groundPlan.
            logger.log(`RAG: LLM generated ${parsed.testCases.length} test case(s)`);
            return parsed;
          }
          // Say WHAT came back, not just that it was rejected. A bare "invalid" is unactionable, and the
          // same blind spot hid a truncated pack-generation response for weeks (G3.6): the run looked
          // healthy because the fallback path always produces *something*.
          const flat = String(raw ?? "").replace(/\s+/g, " ").trim();
          const cands = extractJsonObjects(String(raw ?? ""));
          logger.log(
            `RAG: LLM output invalid — falling back. ${usedModel} returned ${flat.length} char(s), ` +
              `finish_reason=${finishReason}, ${cands.length} balanced JSON candidate(s), ` +
              `none with a non-empty testCases[].` +
              (finishReason === "length"
                ? ` ⚠️ TRUNCATED — the model hit max_tokens (${PLANNER_MAX_TOKENS}) before finishing.`
                : "") +
              (flat ? `\n  head: ${flat.slice(0, 300)}\n  tail: ${flat.slice(-300)}` : " (empty response)")
          );
        }
      } catch (e: any) {
        logger.log(`RAG: error (${e?.message ?? String(e)}) — falling back`);
      }
    } else {
      if (!embeddingClient) logger.log("RAG: OPENAI_API_KEY not set — using BM25 fallback retrieval");
      if (!hasGenerationKey) logger.log("RAG: no LLM key configured — using deterministic generation");
    }

    // ── Fallback path: BM25 retrieval + deterministic generation ─────────────
    const intent = classifyIntent(requestText);
    logger.log(`RAG: fallback intent=${intent}`);
    const fallbackDocs = this.store.retrieveFallback(requestText, intent, 3);
    logger.log(`RAG: fallback retrieved [${fallbackDocs.map((d) => d.id).join(", ")}]`);

    // Raw plan; TestPlannerAgent runs repairSteps + groundPlan (the single grounding layer).
    const rawTestCases = generateDeterministic(intent, ctx, pageContext, startUrl);
    logger.log(`RAG: deterministic fallback generated ${rawTestCases.length} test case(s)`);
    return { testCases: rawTestCases };
  }
}
