/**
 * RouteIntentResolver — which pages should pre-inspection visit for this request? (G3.1)
 *
 * WHAT CHANGED, AND WHY IT MATTERED MORE THAN IT LOOKS
 * ----------------------------------------------------
 * This file used to be a list of demo-web routes behind e-commerce keyword regexes: the word "filter"
 * meant `/products`, "analytics" meant `/admin`, "orders" meant `/account/orders`. On the app it was
 * written for that works. On any other app it sends the browser to URLs that do not exist.
 *
 * That is not a cosmetic wart — it was the **proven root cause of the held-out app's score** (L6/G1.3).
 * On TaskFlow, "filter" and "analytics" resolved to `/products` and `/admin`, both 404s, so two of the
 * three inspected pages were error pages and the planner's context for the entire application contained
 * **0 inputs and 0 buttons**. Every generated test then asserted the one heading it could see. The engine
 * was not failing to plan; it was planning blind.
 *
 * Routes now come from the app itself — `pack.routes` (an intent→path map, present in hand-written packs
 * *and* in every generated one) plus the real `goto` paths inside its golden flows — and are matched to
 * the request with the same tokenizer the flow retriever uses. No app literals remain here.
 *
 * With no pack we inspect the start page only, plus any path the request states outright. That is the
 * honest answer: with no knowledge of the app, guessing URLs is what caused the damage above.
 */

import { buildFlowIndex, rankFlowsLexical, tokenize } from "../knowledge/FlowIndex";
import type { GoldenFlow } from "../knowledge/AppKnowledgePack";

/** The slice of a knowledge pack this module reads. Structural, so tests need no full pack. */
export interface RouteSource {
  /** intent → path, e.g. `{ home: "/", products: "/products", forgotPassword: "/auth/forgot-password" }` */
  routes?: Record<string, string>;
  /** Golden flows; their `goto` steps name real paths even when `routes` is absent. */
  goldenFlows?: Record<string, { steps?: unknown[] }>;
}

/** How many app routes pre-inspection may visit beyond the start page. Each one is a browser navigation. */
const MAX_MATCHED_ROUTES = 4;

/** `accountOrders` → `account orders`, so a camelCase route key contributes both words. */
function splitIdentifier(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ");
}

/** Path part of an absolute or relative URL, without a trailing slash. */
function pathOf(u: string): string {
  try {
    const p = new URL(u, "http://x").pathname;
    return p.length > 1 ? p.replace(/\/+$/, "") : "/";
  } catch {
    return u;
  }
}

interface RouteCandidate {
  path: string;
  /** Text describing the route's intent: its key plus its path segments. */
  label: string;
  /** Position in the pack's own declaration order — the app's implicit importance ranking. */
  order: number;
}

/**
 * Every route the app itself tells us about: the pack's `routes` map, plus each distinct `goto` target
 * in its golden flows. Flows matter because a generated pack always has them, and because a route that a
 * verified flow actually visits is known-good.
 */
export function collectKnownRoutes(source?: RouteSource | null): RouteCandidate[] {
  const byPath = new Map<string, RouteCandidate>();

  const add = (path: string, labelPart: string) => {
    const p = pathOf(path);
    if (!p.startsWith("/")) {return;}
    // A route PATTERN (`/products/:id`, `/files/*`) describes a family of URLs, not one you can open.
    // Browsing it literally yields the app's not-found page, whose elements are then pooled into the
    // shared inventory as if they were real — and it consumes one of the few inspect slots.
    if (/[:*]/.test(p)) {return;}
    const existing = byPath.get(p);
    const segments = p.split("/").filter(Boolean).join(" ");
    const label = `${splitIdentifier(labelPart)} ${splitIdentifier(segments)}`.trim();
    if (existing) {
      // Same path named by several sources — keep both names as evidence.
      existing.label = `${existing.label} ${label}`.trim();
    } else {
      byPath.set(p, { path: p, label, order: byPath.size });
    }
  };

  for (const [key, path] of Object.entries(source?.routes ?? {})) {
    if (typeof path === "string" && path.trim()) {add(path, key);}
  }

  for (const flow of Object.values(source?.goldenFlows ?? {})) {
    for (const step of (flow?.steps ?? []) as Array<Record<string, unknown>>) {
      if (step && step.action === "goto" && typeof step.url === "string" && step.url.trim()) {
        // ⚠️ Label from the PATH only — never the flow key. A flow key describes the flow, not the page
        // it happens to land on, and using it leaks one page's vocabulary onto another: demo-web's
        // `admin-login` flow ends at `/admin`, which labelled that route "admin login" and made every
        // prompt containing the word "login" drag the admin panel into pre-inspection.
        add(step.url, "");
      }
    }
  }

  return [...byPath.values()];
}

/**
 * Score a route against the request: how many of the request's distinct terms its label contains.
 *
 * Deliberately plain term overlap rather than BM25. There are only a handful of routes, their labels are
 * two or three words, and IDF over such a tiny set is noise. Predictability is worth more here — a wrong
 * route costs a browser navigation to a 404 and a poisoned page context.
 */
function matchedTerms(candidate: RouteCandidate, requestTerms: Set<string>): Set<string> {
  const labelTerms = new Set(tokenize(candidate.label));
  const hit = new Set<string>();
  for (const t of requestTerms) {
    if (labelTerms.has(t)) {hit.add(t);}
  }
  return hit;
}

/**
 * Choose the pages pre-inspection should visit.
 *
 * @param requestText the user's request
 * @param baseUrl     app base URL
 * @param startUrl    explicit start page, if any
 * @param source      the app's knowledge pack (routes + golden flows). Omit for page-grounded behavior.
 */
export function buildInspectUrlsFromRequest(
  requestText: string,
  baseUrl: string,
  startUrl?: string,
  source?: RouteSource | null
): string[] {
  const urls: string[] = [];

  const add = (pathOrUrl: string | undefined) => {
    if (!pathOrUrl) {return;}
    try {
      const full = new URL(pathOrUrl, baseUrl).toString();
      if (!urls.includes(full)) {urls.push(full);}
    } catch {
      // Ignore invalid paths.
    }
  };

  add(startUrl);
  add("/");

  // ── 1. The pages the best-matching golden flow actually visits ──────────────────────────────────
  //
  // The strongest signal available, and it costs nothing: the planner is about to build its plan from
  // that very flow, so those are exactly the pages the plan will touch. It also supplies knowledge a
  // route NAME cannot. "Search for laptop in the navbar" shares no word with any route called
  // `products` — but demo-web's `search` flow starts with `goto /products`, so the app has already told
  // us where its search box lives. That association used to be a hardcoded `"search" -> /products`
  // regex; now it comes from the app's own verified flow.
  //
  // Uses `rankFlowsLexical`, not `rankFlows`: abstaining is right when a hit becomes the plan, but here
  // a loosely-related flow still points at plausible pages, and inspecting nothing is strictly worse.
  const flows = source?.goldenFlows as Record<string, GoldenFlow> | undefined;
  if (flows && Object.keys(flows).length && (requestText ?? "").trim()) {
    const best = rankFlowsLexical(buildFlowIndex(flows), requestText, 1)[0];
    for (const step of (best?.flow?.steps ?? []) as Array<Record<string, unknown>>) {
      if (step && step.action === "goto" && typeof step.url === "string") {add(pathOf(step.url));}
    }
  }

  // ── 2. Routes the app declares, ranked by how well their names match the request ────────────────
  const requestTerms = new Set(tokenize(requestText ?? ""));
  const known = collectKnownRoutes(source);
  if (requestTerms.size && known.length) {
    const scored = known
      .map((c) => ({ c, hit: matchedTerms(c, requestTerms) }))
      .filter((x) => x.hit.size > 0)
      .sort(
        (a, b) =>
          b.hit.size - a.hit.size ||
          // Then the app's own declaration order — a pack lists its routes roughly by importance
          // (home, products, cart, …), which beats an alphabetical coin-flip.
          a.c.order - b.c.order ||
          a.c.path.split("/").length - b.c.path.split("/").length
      );

    /**
     * Take the best routes, but don't spend the budget on siblings that add nothing.
     *
     * `/account`, `/account/orders` and `/account/profile` all match the single word "account", so a
     * prompt mentioning it once would fill every slot with the same area of the app and crowd out a
     * genuinely different page — that is how prompt 17 lost `/auth/register`. A deeper route earns its
     * slot only by matching a term its already-selected ancestor did not.
     */
    const chosen: Array<{ path: string; hit: Set<string> }> = [];
    for (const x of scored) {
      if (chosen.length >= MAX_MATCHED_ROUTES) {break;}
      // `some`, not `find` — and never treat "/" as an ancestor. Every path starts with "/", so the root
      // route would always be picked as the parent and shadow the real one, silently disabling this rule.
      const covered = chosen.some(
        (s) =>
          s.path !== "/" &&
          x.c.path.startsWith(`${s.path}/`) &&
          [...x.hit].every((t) => s.hit.has(t))
      );
      if (covered) {continue;}
      chosen.push({ path: x.c.path, hit: x.hit });
    }
    for (const x of chosen) {add(x.path);}
  }

  // Paths the request states outright ("navigate directly to /checkout"). App-neutral, and the user's
  // explicit instruction outranks inference — kept last so it can still be added when nothing matched.
  //
  // The leading boundary matters: without it, "set the timezone to Europe/London" yields a request to
  // browse `/london`, and a pre-inspected 404 poisons the planner's page context with an error page.
  const explicitPathMatches =
    (requestText ?? "").toLowerCase().matchAll(/(?:^|[\s(])(\/[a-z0-9][a-z0-9/_-]*)(?:\?[^\s)]*)?/g);
  for (const m of explicitPathMatches) {add(m[1]);}

  return urls;
}
