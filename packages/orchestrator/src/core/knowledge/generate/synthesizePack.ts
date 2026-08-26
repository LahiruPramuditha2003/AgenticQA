/**
 * Pack synthesis for the knowledge-pack generator (N2.2). Pure — no IO. Two routes to a pack:
 *
 *  • `synthesizePackDeterministic(input)` — SiteMap + extracted routes/credentials → a valid, non-empty
 *    `AppKnowledgePack` with NO LLM (golden flows reuse `synthesizeFlows`; credentials come only from
 *    extracted source literals; guidance is grounded in the login route + found credentials). Always the
 *    floor so we never ship an empty pack.
 *  • `buildPackPrompt(input)` + `parsePackResponse(text)` — the LLM path: present the real routes/elements/
 *    credentials, ask for a richer pack (golden flows with assertions, guidance, assertion aliases), then
 *    tolerantly parse + clamp the response. `finalizePack(input, llmPack)` merges the LLM result over the
 *    deterministic floor — but **credentials always come from extraction**, never the LLM (no invented
 *    secrets).
 *
 * Generated golden flows are CANDIDATES; the agent (N2.3) validates them by running and keeps passers.
 */

import type { AppKnowledgePack, AssertionAlias, GoldenFlow } from "../AppKnowledgePack";
import { normalizeFlowTags } from "../AppKnowledgePack";
import type { SiteMap, SiteRoute } from "../../explore/Crawler";
import { synthesizeFlows } from "../../explore/synthesizeFlows";
import type { ExtractedRoute } from "./extractRoutes";
import type { ExtractedCredential } from "./extractCredentials";
import { extractFirstJsonObject } from "../../llm/json";

export interface PackSynthesisInput {
  appName?: string;
  baseUrl: string;
  siteMap: SiteMap;
  extractedRoutes?: ExtractedRoute[];
  credentials?: ExtractedCredential[];
}

/* ───────────────────────── helpers ───────────────────────── */

function slug(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** A readable route-hint key for a path: "/" → home, "/auth/login" → login, "/products" → products. */
function routeKeyName(path: string): string {
  if (!path || path === "/") {return "home";}
  const segs = path.split("/").filter(Boolean);
  const last = [...segs].reverse().find((s) => !s.startsWith(":")) ?? segs[segs.length - 1];
  return slug(last || "home") || "home";
}

function deriveName(input: PackSynthesisInput): string {
  if (input.appName && input.appName.trim()) {return input.appName.trim();}
  try {
    return new URL(input.baseUrl).host || "app";
  } catch {
    return "app";
  }
}

/** Pack `credentials` from extracted source pairs only (never invented). admin role → admin, else customer. */
function buildCredentials(
  creds: ExtractedCredential[] | undefined
): AppKnowledgePack["credentials"] | undefined {
  if (!creds || creds.length === 0) {return undefined;}
  const out: NonNullable<AppKnowledgePack["credentials"]> = {};

  // Pass 1: honor explicitly-labelled roles.
  for (const c of creds) {
    const role = (c.role ?? "").toLowerCase();
    if (role === "admin" && !out.admin) {out.admin = { email: c.email, password: c.password };}
    else if ((role === "customer" || role === "user") && !out.customer) {
      out.customer = { email: c.email, password: c.password };
    }
  }

  // Pass 2: fill the remaining slots (customer, then admin) from any not-yet-used credentials, so a 2nd
  // demo account isn't dropped when the source didn't label roles (e.g. a `role === 'customer' ? … : …`
  // ternary, which reveals both accounts but tags neither).
  for (const c of creds) {
    const used =
      (out.customer && out.customer.email === c.email) ||
      (out.admin && out.admin.email === c.email);
    if (used) {continue;}
    if (!out.customer) {out.customer = { email: c.email, password: c.password };}
    else if (!out.admin) {out.admin = { email: c.email, password: c.password };}
  }

  return Object.keys(out).length ? out : undefined;
}

/** Grounded planner guidance from the login route + found credentials (omitted when there's nothing real). */
function buildGuidance(input: PackSynthesisInput): string[] | undefined {
  const lines: string[] = [];
  const loginRoute = input.siteMap.routes.find((r) => /login/i.test(r.path));
  if (loginRoute) {
    lines.push(
      `Login page is at ${loginRoute.path} — navigate there first, then fill the email + password fields.`
    );
  }
  for (const c of input.credentials ?? []) {
    lines.push(`Credential${c.role ? ` (${c.role})` : ""}: email=${c.email} password=${c.password}`);
  }
  return lines.length ? lines : undefined;
}

/** Pack `routes` (intent→path) from the crawled site (deduped by key; first wins). */
function buildRoutes(site: SiteMap): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const r of site.routes) {
    const key = routeKeyName(r.path);
    if (!(key in out)) {out[key] = r.path;}
  }
  return Object.keys(out).length ? out : undefined;
}

/** A `searchInput` stable hint if a search-like input is present anywhere. */
function buildStableElements(site: SiteMap): Record<string, string> | undefined {
  for (const r of site.routes) {
    for (const i of r.inputs ?? []) {
      if (i.name && /search/i.test(i.name)) {return { searchInput: i.name };}
    }
  }
  return undefined;
}

/** Candidate golden flows from the crawl (smoke/form/nav), keyed by a readable slug. */
function buildGoldenFlows(input: PackSynthesisInput): Record<string, GoldenFlow> | undefined {
  const flows = synthesizeFlows(input.siteMap, { baseUrl: input.baseUrl });
  const out: Record<string, GoldenFlow> = {};
  for (const f of flows) {
    let key = slug(`${f.kind}-${routeKeyName(routePathForKey(input.siteMap, f.routeKey))}`) || slug(f.title);
    if (!key) {continue;}
    let n = 2;
    let unique = key;
    while (unique in out) {unique = `${key}-${n++}`;}
    out[unique] = { description: f.title, steps: f.steps };
  }
  return Object.keys(out).length ? out : undefined;
}

function routePathForKey(site: SiteMap, routeKey: string): string {
  return site.routes.find((r) => r.routeKey === routeKey)?.path ?? routeKey;
}

/* ───────────────────────── deterministic pack ───────────────────────── */

export function synthesizePackDeterministic(input: PackSynthesisInput): AppKnowledgePack {
  const pack: AppKnowledgePack = { name: deriveName(input) };
  const credentials = buildCredentials(input.credentials);
  if (credentials) {pack.credentials = credentials;}
  const routes = buildRoutes(input.siteMap);
  if (routes) {pack.routes = routes;}
  const stable = buildStableElements(input.siteMap);
  if (stable) {pack.stableElements = stable;}
  const guidance = buildGuidance(input);
  if (guidance) {pack.plannerGuidance = guidance;}
  const golden = buildGoldenFlows(input);
  if (golden) {pack.goldenFlows = golden;}
  return pack;
}

/* ───────────────────────── LLM prompt ───────────────────────── */

function compactRoute(r: SiteRoute): string {
  const names = (els: SiteRoute["inputs"]) =>
    (els ?? [])
      .map((e) => e.name)
      .filter(Boolean)
      .slice(0, 8)
      .join(", ");
  const parts = [
    `- ${r.path}${r.title ? ` — heading "${r.title}"` : ""}`,
    names(r.inputs) ? `inputs: ${names(r.inputs)}` : "",
    names(r.buttons) ? `buttons: ${names(r.buttons)}` : "",
  ].filter(Boolean);
  return parts.join(" — ");
}

export function buildPackPrompt(input: PackSynthesisInput): string {
  const routesBlock = input.siteMap.routes.slice(0, 20).map(compactRoute).join("\n");
  const extracted = (input.extractedRoutes ?? [])
    .map((r) => r.path)
    // ⚠️ Router PATTERNS are not navigable URLs. `extractRoutes` keeps `:id` on purpose (it is correct
    // router metadata), but this block is rendered under "Route paths found in source" next to a RULE
    // saying "use ONLY the real route paths listed above" — so the model was being told `/products/:id`
    // is a real route. It obeyed, the pack shipped `productDetail: "/products/:id"`, and pre-inspection
    // then browsed that literal URL. The concrete instance (`/products/1`) is already offered by the
    // crawled-routes block above, so nothing is lost by withholding the pattern.
    .filter((path) => !/[:*]/.test(path))
    .slice(0, 40)
    .join(", ");
  const credsBlock = (input.credentials ?? [])
    .map((c) => `- ${c.email} / ${c.password}${c.role ? ` (${c.role})` : ""}`)
    .join("\n");

  return [
    `You are generating an App Knowledge Pack (JSON) for an automated test planner. The app is "${deriveName(
      input
    )}" at ${input.baseUrl}.`,
    "",
    "Crawled routes (real page elements — use these EXACT names):",
    routesBlock || "(none)",
    extracted ? `\nRoute paths found in source: ${extracted}` : "",
    credsBlock
      ? `\nCredentials found in source (use EXACTLY these — do NOT invent others):\n${credsBlock}`
      : "\nNo credentials were found in source — do not invent any.",
    "",
    "Return ONLY a JSON object with these optional keys:",
    '- "routes": { intent: "/path" } map of meaningful intents to real paths.',
    '- "stableElements": { logicalName: "real element name" }.',
    '- "plannerGuidance": string[] of app-specific conventions (auth flow, search, assertions).',
    '- "assertionAliases": [{ "when": "...", "assert": "real on-page text" }].',
    '- "goldenFlows": { scenarioKey: { "description": "...", "tags": ["..."], "steps": [ ... ] } }.',
    "",
    // Tags are how a flow becomes RETRIEVABLE by the planner (FlowIndex weights them above description).
    // They are worth asking for only because they carry what the app's own text cannot: the words a USER
    // would type. Measured — tags of this kind lift retrieval on a generated pack, whereas tags that merely
    // restate the page's wording measurably HURT it, so the instruction below is deliberately specific.
    'For "tags": 2-5 short phrases naming the USER\'S INTENT — how someone would ask for this test in',
    'plain English ("sign in", "log in", "invite a teammate"). Do NOT restate the page heading, the route',
    "path, or button labels; those are already known. Omit tags rather than pad them with generic words",
    'like "page", "form", "click" or "test". Never claim a flow is verified — that is decided by running it.',
    "",
    "Each step is one of: { action:\"goto\", url:\"/path\" }, { action:\"waitForLoad\" },",
    '{ action:"fill", field:"<input name>", value:"..." }, { action:"click", target:"<button/link name>" },',
    '{ action:"select", field:"<select name>", option:"..." }, { action:"check", target:"<checkbox name>" },',
    '{ action:"expectVisible", target:"<real on-page text>" }.',
    "",
    "RULES: use ONLY the real route paths + element names listed above; never invent routes, elements, or",
    "credentials; every flow must end with an expectVisible assertion on real on-page text; prefer flows that",
    "exercise login (with the provided credentials), search, and primary navigation. Output JSON only.",
  ].join("\n");
}

/* ───────────────────────── tolerant parse + validate ───────────────────────── */

function cleanStringMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof k === "string" && typeof val === "string" && val.trim()) {out[k] = val;}
    }
  }
  return out;
}

function cleanGoldenFlows(v: unknown): Record<string, GoldenFlow> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) {return null;}
  const out: Record<string, GoldenFlow> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (!val || typeof val !== "object") {continue;}
    const raw = val as { description?: unknown; steps?: unknown; tags?: unknown; routeKey?: unknown };
    const steps = Array.isArray(raw.steps)
      ? raw.steps.filter(
          (s): s is Record<string, unknown> =>
            !!s && typeof s === "object" && typeof (s as Record<string, unknown>).action === "string"
        )
      : [];
    if (steps.length === 0) {continue;}
    const flow: GoldenFlow = {
      description: typeof raw.description === "string" ? raw.description : k,
      steps: steps as object[],
    };
    // Retrieval metadata (G2.1). Optional and defensively parsed — an LLM may omit it, or supply junk.
    // `verified` is deliberately NOT accepted from the model: only actually running a flow may set it.
    const tags = normalizeFlowTags(raw.tags);
    if (tags) {flow.tags = tags;}
    if (typeof raw.routeKey === "string" && raw.routeKey.trim()) {
      flow.routeKey = raw.routeKey.trim();
    }
    out[k] = flow;
  }
  return Object.keys(out).length ? out : null;
}

/** Clamp an arbitrary parsed object into a safe `AppKnowledgePack` (drops malformed fields). */
export function validateGeneratedPack(obj: unknown): AppKnowledgePack | null {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {return null;}
  const o = obj as Record<string, unknown>;
  const pack: AppKnowledgePack = {};

  if (typeof o.name === "string") {pack.name = o.name;}
  if (o.credentials && typeof o.credentials === "object" && !Array.isArray(o.credentials)) {
    pack.credentials = o.credentials as AppKnowledgePack["credentials"];
  }
  const routes = cleanStringMap(o.routes);
  if (Object.keys(routes).length) {pack.routes = routes;}
  const stable = cleanStringMap(o.stableElements);
  if (Object.keys(stable).length) {pack.stableElements = stable;}
  if (typeof o.plannerGuidance === "string") {
    pack.plannerGuidance = o.plannerGuidance;
  } else if (Array.isArray(o.plannerGuidance)) {
    const lines = o.plannerGuidance.filter((x): x is string => typeof x === "string");
    if (lines.length) {pack.plannerGuidance = lines;}
  }
  if (Array.isArray(o.assertionAliases)) {
    const aa = o.assertionAliases
      .filter(
        (a): a is AssertionAlias =>
          !!a &&
          typeof a === "object" &&
          typeof (a as AssertionAlias).when === "string" &&
          typeof (a as AssertionAlias).assert === "string"
      )
      .map((a) => ({ when: a.when, assert: a.assert }));
    if (aa.length) {pack.assertionAliases = aa;}
  }
  const gf = cleanGoldenFlows(o.goldenFlows);
  if (gf) {pack.goldenFlows = gf;}

  const hasContent =
    pack.goldenFlows ||
    pack.routes ||
    pack.plannerGuidance ||
    pack.assertionAliases ||
    pack.stableElements ||
    pack.credentials;
  return hasContent ? pack : null;
}

/** Tolerantly parse an LLM response (prose/markdown-wrapped JSON allowed) into a clamped pack, or null. */
export function parsePackResponse(text: string): AppKnowledgePack | null {
  try {
    const json = extractFirstJsonObject(text ?? "");
    return validateGeneratedPack(JSON.parse(json));
  } catch {
    return null;
  }
}

/**
 * Merge a (validated) LLM pack over the deterministic floor. The LLM enriches guidance / aliases / golden
 * flows and refines routes + stable elements; the deterministic golden flows stay as a fallback floor; and
 * **credentials always come from extraction** (never the LLM), so no invented secrets land in the pack.
 */
export function finalizePack(
  input: PackSynthesisInput,
  llmPack: AppKnowledgePack | null
): AppKnowledgePack {
  const base = synthesizePackDeterministic(input);
  if (!llmPack) {return base;}

  const merged: AppKnowledgePack = { name: base.name };
  if (base.credentials) {merged.credentials = base.credentials;} // extraction only

  const routes = { ...(base.routes ?? {}), ...(llmPack.routes ?? {}) };
  if (Object.keys(routes).length) {merged.routes = routes;}
  const stable = { ...(base.stableElements ?? {}), ...(llmPack.stableElements ?? {}) };
  if (Object.keys(stable).length) {merged.stableElements = stable;}
  merged.plannerGuidance = llmPack.plannerGuidance ?? base.plannerGuidance;
  if (!merged.plannerGuidance) {delete merged.plannerGuidance;}
  if (llmPack.assertionAliases) {merged.assertionAliases = llmPack.assertionAliases;}

  const golden = { ...(base.goldenFlows ?? {}), ...(llmPack.goldenFlows ?? {}) };
  if (Object.keys(golden).length) {merged.goldenFlows = golden;}

  return merged;
}

/* ───────────────────── validation budget ───────────────────── */

/** The flow family a generated key belongs to: `form-login` → `form`. LLM-invented keys fall in `other`. */
function flowKind(key: string): string {
  const m = /^([a-z]+)-/.exec(key);
  const kind = m?.[1] ?? "other";
  return ["smoke", "form", "nav", "filter"].includes(kind) ? kind : "other";
}

/**
 * Choose which candidate flows get a validation slot, round-robin across families (G3.8).
 *
 * ⚠️ **Taking the first N deleted an entire family.** `buildGoldenFlows` emits smoke+form per route in
 * crawl order and appends the nav flows last, so `slice(0, 10)` cut at exactly the boundary before them.
 * Every pack TaskFlow ever generated therefore contained **zero nav flows** — and a nav flow is the only
 * family that *clicks* anything, because a form flow deliberately stops short of submitting. Eight of the
 * fourteen UNDER_TESTED verdicts on the 2026-08-11 TaskFlow run read "prompt asks to click, but the spec
 * never does": there was no flow in the pack that could have.
 *
 * Round-robin spends the same budget without letting crawl order decide which *kind* of test the app is
 * allowed to have. `form` goes first within a cycle because it carries the most interaction per slot, then
 * `nav`, then `smoke` (a smoke flow asserts a heading that was already on screen).
 */
export function selectFlowsForValidation<T>(
  flows: Record<string, T>,
  max: number
): Array<[string, T]> {
  const entries = Object.entries(flows);
  if (entries.length <= max) {return entries;}

  const buckets = new Map<string, Array<[string, T]>>();
  for (const e of entries) {
    const k = flowKind(e[0]);
    (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(e);
  }

  // `filter` sits with `form` at the front: both carry real interaction, which is what the budget is for.
  const order = ["form", "filter", "nav", "smoke", "other"].filter((k) => buckets.has(k));
  const out: Array<[string, T]> = [];
  for (let round = 0; out.length < max; round++) {
    let progressed = false;
    for (const kind of order) {
      const bucket = buckets.get(kind)!;
      if (round >= bucket.length) {continue;}
      out.push(bucket[round]);
      progressed = true;
      if (out.length >= max) {break;}
    }
    if (!progressed) {break;}
  }
  return out;
}
