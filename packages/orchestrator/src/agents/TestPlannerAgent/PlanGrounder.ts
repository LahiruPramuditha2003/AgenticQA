/**
 * PlanGrounder — the single, page-scoped, role-aware grounding pass.
 *
 * Replaces the old `normalizeTestPlan` + `validatePlanAgainstPageContext` layers, which validated
 * every step against ONE flattened, global element set using cross-role fuzzy matching. That
 * caused the classic bugs: a search assertion `All Products - "laptop"` getting remapped to the
 * `Clear All` button, a `Smartphones` heading turning into a placeholder, and needed steps being
 * silently deleted.
 *
 * This grounder instead:
 *   • tracks the current route as it walks the steps and validates each step against the inventory
 *     for THAT route (using ctx.pageInventory), not a global blob;
 *   • matches within the correct ROLE bucket (a click → buttons/links; an assertion → visible
 *     elements; a fill → inputs/selects) and never remaps across incompatible roles;
 *   • remaps to a real element name only above a confidence threshold;
 *   • is non-silent: every repair/removal is recorded on plan.__repairedSteps / __removedSteps;
 *   • is conservative: a route that was never inspected is TRUSTED (steps kept as-is), and
 *     interactions that can't be grounded are kept (honest failure) — only ungroundable
 *     assertions on an inspected page are dropped (they are almost always hallucinated).
 */

import type { PageContext, PageElement } from "../../core/agent/types";
// Shared with the flow synthesizer so "what counts as a primary action" is defined once. It matches
// generic English action verbs (submit, save, create, add, send, sign in, …), not any app's nouns.
import { isSubmitButton } from "../../core/explore/synthesizeFlows";

export interface GroundingRepair {
  tcTitle?: string;
  action: string;
  field: "field" | "target";
  original: string;
  result: string;
  confidence: number;
}

export interface GroundingRemoval {
  tcTitle?: string;
  action: string;
  target: string;
  reason: string;
}

export interface GroundOptions {
  pages: PageContext[];
  startUrl: string;
  /** assertion targets that should never be dropped (dynamic/aliased), e.g. pack alias values */
  keepTargets?: string[];
  logger?: { log: (m: string) => void };
}

const REMAP_THRESHOLD = 0.62;

/* ─── text utils ─── */

const ROLE_PREFIX = /^(heading|textbox|link|button|combobox|checkbox|radio|listbox|menuitem|tab|option|role)\s+/i;

function stripQuotes(s: string): string {
  let r = s.trim();
  while (r.length >= 2 && ((r.startsWith('"') && r.endsWith('"')) || (r.startsWith("'") && r.endsWith("'")))) {
    r = r.slice(1, -1).trim();
  }
  return r;
}

/** Normalize an element name/target for comparison: drop role prefix + quotes, lowercase, collapse. */
function norm(s: string | undefined): string {
  if (!s) return "";
  let r = String(s).trim();
  r = r.replace(ROLE_PREFIX, "");
  r = stripQuotes(r);
  return r.replace(/\s+/g, " ").trim().toLowerCase();
}

function pathOf(u: string | undefined): string {
  if (!u) return "/";
  try {
    return new URL(u, "http://x").pathname.replace(/\/+$/, "") || "/";
  } catch {
    return u;
  }
}

/* ─── role buckets ─── */

function asArray(x: PageElement[] | undefined): PageElement[] {
  return Array.isArray(x) ? x : [];
}

function fillablesOf(p: PageContext): PageElement[] {
  return [...asArray(p.inputs), ...asArray(p.selects)];
}
function selectsOf(p: PageContext): PageElement[] {
  // selects may be reported as inputs (combobox) or selects depending on the snapshot path
  return [...asArray(p.selects), ...asArray(p.inputs).filter((e) => e.role === "combobox")];
}
function clickablesOf(p: PageContext): PageElement[] {
  return [
    ...asArray(p.buttons),
    ...asArray(p.links),
    ...asArray((p as any).cards),
    ...asArray((p as any).gridItems),
  ];
}
function checkablesOf(p: PageContext): PageElement[] {
  return [...asArray(p.checkboxes), ...asArray(p.radios)];
}
function visiblesOf(p: PageContext): PageElement[] {
  return [
    ...asArray(p.headings),
    ...clickablesOf(p),
    ...fillablesOf(p),
    ...checkablesOf(p),
    ...asArray((p as any).lists),
    ...asArray((p as any).tabs),
  ];
}

/* ─── matching ─── */

interface Match {
  name: string;
  score: number;
}

function bestMatch(query: string, candidates: PageElement[]): Match | null {
  const q = norm(query);
  if (!q || candidates.length === 0) return null;

  let best: Match | null = null;
  const consider = (name: string, score: number) => {
    if (score > (best?.score ?? 0)) best = { name, score };
  };

  for (const c of candidates) {
    const cn = norm(c.name);
    if (!cn) continue;

    if (cn === q) {
      consider(c.name, 1);
      continue;
    }
    if (c.testId && norm(c.testId) === q) {
      consider(c.name, 1);
      continue;
    }
    if (cn.startsWith(q) || q.startsWith(cn)) {
      consider(c.name, 0.8);
      continue;
    }
    // forward: candidate contains the whole query (query "Email" ⊂ candidate "Email address")
    if (q.length > 3 && cn.includes(q)) {
      consider(c.name, 0.7);
      continue;
    }
    // reverse: query contains a shorter candidate ("Resend Email" ⊃ "Email"). Weak unless the
    // candidate covers most of the query — otherwise multi-word assertions wrongly collapse to a
    // generic sub-word (e.g. "Resend Email" → the "Email" input).
    if (cn.length > 3 && q.includes(cn)) {
      const coverage = cn.length / q.length;
      consider(c.name, coverage >= 0.6 ? 0.68 : 0.4);
      continue;
    }
    // token overlap (every query token present in candidate → strong; partial → weak)
    const qt = q.split(" ").filter(Boolean);
    const ct = new Set(cn.split(" ").filter(Boolean));
    if (qt.length) {
      const overlap = qt.filter((t) => ct.has(t)).length;
      if (overlap === qt.length) consider(c.name, 0.7);
      else if (overlap > 0) consider(c.name, 0.4 + 0.1 * overlap);
    }
  }

  return best;
}

/* ─── page lookup ─── */

function pageFor(route: string, pages: PageContext[]): PageContext | null {
  if (!pages.length) return null;
  const rp = pathOf(route);

  const exact = pages.find((p) => pathOf(p.url) === rp);
  if (exact) return exact;

  // /products/1 should fall back to the /products inventory
  const prefix = pages
    .filter((p) => pathOf(p.url) !== "/" && rp.startsWith(pathOf(p.url)))
    .sort((a, b) => pathOf(b.url).length - pathOf(a.url).length)[0];
  if (prefix) return prefix;

  const reverse = pages.find((p) => rp !== "/" && pathOf(p.url).startsWith(rp));
  if (reverse) return reverse;

  return null;
}

/* ─── dynamic-target guard ─── */

/**
 * An ALL-CAPS word in a pack assertion alias is a placeholder for a runtime value, e.g. demo-web's
 * `All Products - "TERM"` standing for `All Products - "laptop"`. Turn the alias into a matcher.
 *
 * G3.2: this replaces a hardcoded `/^all products\s*[-–—]/` in the grounder. The pack already declared
 * the alias; the regex existed only because a literal `TERM` never matches the real heading, so the one
 * app that needed it got its pattern baked into engine code. Now any pack can express the same thing.
 */
function keepTargetToPattern(alias: string): RegExp | null {
  const a = alias.trim();
  if (!a || !/\b[A-Z]{3,}\b/.test(a)) {return null;} // no placeholder → plain string compare is enough
  const escaped = a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const withWildcards = escaped.replace(/\b[A-Z]{3,}\b/g, ".+");
  try {
    return new RegExp(`^${withWildcards}$`, "i");
  } catch {
    return null;
  }
}

/**
 * Values the plan ITSELF puts on the page: the option a `select` chooses, the text a `fill` types.
 *
 * ⚠️ An assertion naming one of these can never be "not present on the page" — it is absent from the
 * *inspected* page precisely because the inspection happened before the plan ran. Dropping it removes the
 * only thing that made the test meaningful.
 *
 * This is demo-web's prompt 3, VACUOUS since the suite began: the golden flow selects category
 * `"Smartphones"` and asserts it, but `/products` was inspected in its initial state where "Smartphones"
 * is an unselected `<option>`, so grounding deleted the assertion and left **a two-action test that
 * cannot fail**. The same rule as the pack's hand-written `assertionAliases` keep-list, except derived
 * from the plan automatically — no app knowledge required.
 */
function planAuthoredValues(steps: any[]): Set<string> {
  const out = new Set<string>();
  for (const s of steps ?? []) {
    for (const v of [s?.option, s?.value]) {
      const t = norm(String(v ?? ""));
      if (t) {out.add(t);}
    }
  }
  return out;
}

function isDynamicAssertionTarget(
  target: string,
  keepTargets: Set<string>,
  keepPatterns: RegExp[],
  planValues?: Set<string>
): boolean {
  const t = stripQuotes(String(target ?? "").replace(ROLE_PREFIX, "")).trim();
  if (!t) return false;
  // explicit keep list (pack assertion-alias values)
  if (keepTargets.has(t.toLowerCase())) return true;
  // a value this very plan enters — present at runtime by construction
  if (planValues?.has(norm(t))) return true;
  // …and their placeholder forms, for targets only known at runtime
  return keepPatterns.some((re) => re.test(t));
}

/* ─── url normalization (ported from the old normalizeTestPlan) ─── */

function normalizePlannedUrl(u: string): string {
  let out = u;
  try {
    if (out.startsWith("http://") || out.startsWith("https://")) {
      const parsed = new URL(out);
      out = parsed.pathname + parsed.search;
    }
  } catch {
    /* ignore */
  }
  return out.replace(/\?variant=[^&]+/i, "").replace(/&variant=[^&]+/i, "");
}

/* ─── main ─── */

export function groundPlan(plan: any, opts: GroundOptions): any {
  if (!plan?.testCases?.length) return plan;

  const { pages, startUrl, logger } = opts;
  const keepTargets = new Set((opts.keepTargets ?? []).map((s) => s.toLowerCase()));
  // Aliases containing an ALL-CAPS placeholder become patterns (see `keepTargetToPattern`).
  const keepPatterns = (opts.keepTargets ?? [])
    .map(keepTargetToPattern)
    .filter((r): r is RegExp => r !== null);
  const repairs: GroundingRepair[] = [];
  const removals: GroundingRemoval[] = [];

  const log = (m: string) => logger?.log(m);

  if (!pages.length) {
    log("PlanGrounder: no page inventory — trusting plan as-is");
  }

  for (const tc of plan.testCases) {
    if (!Array.isArray(tc.steps)) continue;

    let currentRoute = pathOf(startUrl);
    const out: any[] = [];
    // Values this plan enters itself — never droppable as "absent" (see `planAuthoredValues`).
    const planValues = planAuthoredValues(tc.steps);

    for (const s of tc.steps) {
      if (!s?.action) continue;

      if (s.action === "goto") {
        if (typeof s.url === "string") s.url = normalizePlannedUrl(s.url);
        currentRoute = pathOf(s.url);
        out.push(s);
        continue;
      }

      const page = pageFor(currentRoute, pages);

      // Route never inspected (or no inventory at all) → trust the step.
      if (!page) {
        out.push(s);
        continue;
      }

      // Pick the right role bucket + the property to ground.
      let key: "field" | "target" | null = null;
      let candidates: PageElement[] = [];
      let isAssertion = false;

      switch (s.action) {
        case "fill":
          key = "field";
          candidates = fillablesOf(page);
          break;
        case "select":
          key = "field";
          candidates = selectsOf(page);
          break;
        case "slider":
          key = "field";
          candidates = fillablesOf(page);
          break;
        case "click":
        case "hover":
          key = "target";
          candidates = clickablesOf(page);
          break;
        case "check":
        case "uncheck":
          key = "target";
          candidates = checkablesOf(page);
          break;
        case "press":
          if (typeof s.target === "string") {
            key = "target";
            candidates = clickablesOf(page);
          }
          break;
        case "expectVisible":
        case "expectNotVisible":
        case "expectText":
          key = "target";
          candidates = visiblesOf(page);
          isAssertion = true;
          break;
        default:
          key = null; // waitForLoad, waitFor, screenshot, scroll, evaluate, etc.
      }

      if (!key || typeof s[key] !== "string") {
        out.push(s);
        continue;
      }

      const original: string = s[key];

      // Never touch dynamic assertion targets (search heading, aliased values).
      if (isAssertion && isDynamicAssertionTarget(original, keepTargets, keepPatterns, planValues)) {
        out.push(s);
        continue;
      }

      const m = bestMatch(original, candidates);

      if (m && m.score >= REMAP_THRESHOLD) {
        // Canonicalize to the real element name (incl. case/whitespace), since codegen matches
        // with exact: true. Record it as a repair whenever the string actually changes.
        if (m.name !== original) {
          repairs.push({
            tcTitle: tc.title,
            action: s.action,
            field: key,
            original,
            result: m.name,
            confidence: Math.round(m.score * 100) / 100,
          });
          log(`PlanGrounder: ${s.action} ${key} "${original}" → "${m.name}" on ${currentRoute} (conf ${m.score.toFixed(2)})`);
          s[key] = m.name;
        }
        out.push(s);
        continue;
      }

      // No confident match on an inspected page.
      if (isAssertion) {
        removals.push({
          tcTitle: tc.title,
          action: s.action,
          target: original,
          reason: `assertion target not present on ${currentRoute}`,
        });
        log(`PlanGrounder: dropped ${s.action} "${original}" — not found on ${currentRoute}`);
        // drop (do not push)
      } else {
        // keep interactions: inspection may have missed a real element; fail honestly if absent
        out.push(s);
      }
    }

    tc.steps = restoreAnAssertion(
      out,
      currentRoute,
      pages,
      removals.filter((r) => r.tcTitle === tc.title).map((r) => r.target),
      log
    );
  }

  plan.__repairedSteps = repairs;
  plan.__removedSteps = removals;

  if (repairs.length || removals.length) {
    log(`PlanGrounder: ${repairs.length} repair(s), ${removals.length} removal(s)`);
  }

  return plan;
}

/**
 * A test that cannot fail is not a test.
 *
 * ⚠️ Grounding may legitimately drop an assertion it cannot place — but dropping the *last* one turns
 * the spec into a sequence of actions that Playwright will report as PASS no matter what the app does.
 * The substance audit calls that VACUOUS, and demo-web's prompt 3 had been in exactly that state for the
 * whole life of the suite: two actions, zero assertions, counted as a pass in every 20/20 ever quoted.
 *
 * ⚠️ **Prefer PUTTING BACK the assertion that was dropped, over inventing one from the page.** That order
 * is not arbitrary — getting it backwards broke demo-web's logout test on 2026-08-11. The flow asserts
 * `"Login"` after signing out; grounding tracks the route from the last `goto` (`/account`) and cannot
 * know that the intervening `click "Logout"` navigates to `/`, so it dropped the assertion as absent. The
 * anchor step then reached for `/account`'s heading — **"Test User", the logged-in user's name** — and the
 * generated test asserted that the user is still shown *after logging out*. It failed, correctly, on an
 * assertion that was wrong.
 *
 * The dropped assertion came from a **verified golden flow**; a heading scraped off a page the plan may
 * already have left is a guess. When the choice is between trusting the pack and trusting a stale page
 * inventory, trust the pack. Anchoring is the last resort, for plans that never had an assertion at all.
 */
function restoreAnAssertion(
  steps: any[],
  finalRoute: string,
  pages: PageContext[],
  dropped: string[],
  log: (m: string) => void
): any[] {
  if (steps.some((s) => /^expect/i.test(String(s?.action ?? "")))) {return steps;}

  // 1. Put back what we removed. It is the plan's own intent, and grounding only rejected it because it
  //    was looking at the wrong page.
  const lastDropped = dropped[dropped.length - 1];
  if (lastDropped) {
    log(
      `PlanGrounder: plan had NO assertion left — restoring the dropped "${lastDropped}". ` +
        `Grounding could not place it, but a verified flow's intent beats a page-derived guess.`
    );
    return [...steps, { action: "expectVisible", target: lastDropped }];
  }

  // 2. Nothing was dropped: the plan genuinely never asserted anything. Anchor on the final page.
  const page = pageFor(finalRoute, pages);
  const anchor =
    asArray(page?.headings)[0] ?? asArray(page?.buttons)[0] ?? asArray(page?.links)[0];
  if (!anchor?.name) {
    log(
      `PlanGrounder: plan has no assertion and ${finalRoute} offers no anchor — ` +
        `the generated test cannot fail.`
    );
    return steps;
  }

  log(
    `PlanGrounder: plan had NO assertion at all — a test that cannot fail is not a test. ` +
      `Anchoring on "${anchor.name}" (visible on ${finalRoute}).`
  );
  return [...steps, { action: "expectVisible", target: anchor.name }];
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Step repair (relocated from RagPlannerEngine for Step 4b — one grounding module).
 * Runs BEFORE the page-scoped grounding above. Auto-fixes common LLM/plan mistakes and injects
 * the app's timing waits (Sign-In / Add-to-Cart). Demo-specific rewrites (e.g. "My Account" →
 * "Total Orders") remain here for now — a future pass can move them into pack data.
 * ────────────────────────────────────────────────────────────────────────────── */


function dedupElements(arr: PageElement[]): PageElement[] {
  const seen = new Set<string>();
  return arr.filter((e) => {
    if (seen.has(e.name)) return false;
    seen.add(e.name);
    return true;
  });
}

/** Merge a multi-page PageContext's per-page buckets into the top-level buckets (deduped). */
export function flattenPageContext(pc: PageContext): PageContext {
  if (!pc.pages || pc.pages.length === 0) return pc;
  const inputs: PageElement[] = [], buttons: PageElement[] = [], headings: PageElement[] = [];
  const links: PageElement[] = [], selects: PageElement[] = [], checkboxes: PageElement[] = [];
  const radios: PageElement[] = [], cards: PageElement[] = [], gridItems: PageElement[] = [];
  for (const page of pc.pages) {
    inputs.push(...(page.inputs ?? []));
    buttons.push(...(page.buttons ?? []));
    headings.push(...(page.headings ?? []));
    links.push(...(page.links ?? []));
    selects.push(...(page.selects ?? []));
    checkboxes.push(...(page.checkboxes ?? []));
    radios.push(...(page.radios ?? []));
    cards.push(...((page as any).cards ?? []));
    gridItems.push(...((page as any).gridItems ?? []));
  }
  return {
    ...pc,
    inputs: dedupElements(inputs), buttons: dedupElements(buttons), headings: dedupElements(headings),
    links: dedupElements(links), selects: dedupElements(selects), checkboxes: dedupElements(checkboxes),
    radios: dedupElements(radios), cards: dedupElements(cards) as any, gridItems: dedupElements(gridItems) as any,
  };
}

/**
 * Settle waits after a click. Two tiers, separated by a STRUCTURAL question — "did the user just enter
 * data?" — rather than by app vocabulary. Submitting a filled form normally navigates and needs longer;
 * a standalone primary action (adding an item, sending an invite) usually updates in place.
 */
const FORM_SUBMIT_WAIT_MS = 1500;
const PRIMARY_ACTION_WAIT_MS = 1000;

/**
 * A `fill` immediately after a click has nothing to wait on: the click may still be navigating to the
 * page that owns the field. Generalised from a rule that keyed off the literal link text "Login".
 */
function insertWaitBeforeStrandedFill(steps: any[]): any[] {
  const result: any[] = [];
  for (let i = 0; i < steps.length; i++) {
    result.push(steps[i]);
    if (steps[i].action === "click" && steps[i + 1]?.action === "fill") {
      result.push({ action: "waitForLoad" });
    }
  }
  return result;
}

// Snap a (possibly LLM-mangled) name back to the closest real element name from the page context.
function snapToKnownElement(value: string, candidates: PageElement[]): string {
  if (!value || !candidates.length) return value;
  const cleaned = value.replace(/\\+$/, "").trim();
  const v = cleaned.toLowerCase();
  if (!v) return value;

  const exact = candidates.find((e) => e.name.toLowerCase() === v);
  if (exact) return exact.name;

  if (v.length > 3) {
    const prefixMatch = candidates.find((e) => e.name.toLowerCase().startsWith(v));
    if (prefixMatch) return prefixMatch.name;

    const containMatch = candidates.find(
      (e) => v.includes(e.name.toLowerCase()) && e.name.toLowerCase().length > 3
    );
    if (containMatch) return containMatch.name;
  }

  return value;
}

/** Repair a plan's steps in place of the raw planner output (relocated from RagPlannerEngine). */
/**
 * Repair a raw plan's steps: timing, action canonicalization, and snapping names to real page elements.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *  G3.2: THIS FUNCTION IS NOW APP-NEUTRAL. Do not add an app's literals here.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * It used to carry ~10 demo-web rewrite rules that ran for **every** app: inject `goto /products`
 * before a search fill, a `KNOWN_CATEGORIES` list that converted clicks into `selectOption`, redirect
 * clicks to `/account` and `/cart`, and rewrite assertions to `"Total Orders"` / `"Order Summary"` /
 * `"All Products"` / `"Filters"` / `"Invalid email or password"` / `"Reset Password"`. On a non-ecommerce
 * app the first of those alone was a guaranteed 404.
 *
 * They were deleted on evidence, not taste. Two measurements:
 *  1. **They are dead.** Across all 48 deterministic plans demo-web's own templates produce, **not one**
 *     of those rules fired. They were written when every plan came from an LLM; the deterministic path
 *     now builds plans from verified golden flows, which already contain the right steps.
 *  2. **The knowledge already lives in the pack.** demo-web's `assertionAliases` declares "Total Orders",
 *     "Order Summary", "Invalid email or password" and the rest, and `TestPlannerAgent` consumes it as a
 *     keep-list. The hardcoded rules were an imperative duplicate of pack data.
 *
 * So no rewrite-rule engine was built to replace them: that would be a schema, a matcher and a
 * migration for behavior measured at zero. `assertionAliases` remains the declarative hook if a real
 * need appears.
 *
 * What remains is genuinely app-neutral:
 *  - **timing** — a settle wait after a form submission or other primary action;
 *  - **canonicalization** — a `fill` aimed at a `<select>` becomes a `select` (decided from the PAGE,
 *    not from a list of field names), and a login field named "username" snaps to the page's real
 *    email input when it has one;
 *  - **grounding** — `snapToKnownElement` fixes near-miss element names.
 */
export function repairSteps(steps: any[], pageContext?: PageContext): any[] {
  const clickable = pageContext
    ? [...(pageContext.buttons ?? []), ...(pageContext.links ?? []), ...((pageContext as any).cards ?? []), ...((pageContext as any).gridItems ?? [])]
    : [];
  const fillable = pageContext ? [...(pageContext.inputs ?? []), ...(pageContext.selects ?? [])] : [];
  const selects = pageContext ? asArray(pageContext.selects) : [];

  const named = (list: PageElement[], name: string) =>
    list.find((e) => (e.name ?? "").toLowerCase().trim() === name.toLowerCase().trim());

  const result: any[] = [];
  // Has the user entered data since the last navigation? Distinguishes "submit this form" (which
  // normally navigates, so wait longer) from a standalone primary action like adding an item.
  let dataEnteredSinceNav = false;

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];

    if (s.action === "goto") {
      dataEnteredSinceNav = false;
      result.push(s);
      continue;
    }

    if (s.action === "fill") {
      const field = (s.field ?? "").trim();

      // A `fill` aimed at a dropdown can never work — Playwright rejects fill() on a <select>. Decided
      // from the live page rather than from a list of field names (which is how this became app-specific
      // the first time: it used to hardcode "category" / "sort" / "sort by").
      if (named(selects, field)) {
        dataEnteredSinceNav = true;
        result.push({ action: "select", field, option: s.value ?? "" });
        continue;
      }

      // "username"-style login fields snap to the page's real email input WHEN THE PAGE HAS ONE.
      // Guarded by the page so it cannot invent a field on an app that logs in some other way.
      if (/^(username|user name|user|account)$/i.test(field)) {
        const email = fillable.find((e) => /e-?mail/i.test(e.name ?? ""));
        if (email) {
          dataEnteredSinceNav = true;
          result.push({ ...s, field: email.name });
          continue;
        }
      }

      dataEnteredSinceNav = true;
      result.push({ ...s, field: snapToKnownElement(field, fillable) });
      continue;
    }

    if (s.action === "select" || s.action === "check") {
      dataEnteredSinceNav = true;
      result.push(s);
      continue;
    }

    if (s.action === "click") {
      const target = (s.target ?? "").trim();
      result.push({ ...s, target: snapToKnownElement(target, clickable) });

      // Settle time after a primary action. `isSubmitButton` matches generic action verbs (submit, save,
      // create, add, send, sign in, ...) — English, not any app's vocabulary. A plain link or a
      // "Search" button gets no wait, exactly as before.
      if (isSubmitButton(target)) {
        const next = steps[i + 1];
        if (!next || next.action !== "waitFor") {
          result.push({
            action: "waitFor",
            timeout: dataEnteredSinceNav ? FORM_SUBMIT_WAIT_MS : PRIMARY_ACTION_WAIT_MS,
          });
        }
      }
      if (isSubmitButton(target)) {dataEnteredSinceNav = false;}
      continue;
    }

    result.push(s);
  }

  return insertWaitBeforeStrandedFill(result);
}
