/**
 * State-aware locator resolution (G3.10).
 *
 * ⚠️ **Everything else in the pipeline inspects a page in its INITIAL state.** `preInspectPage` browses a
 * set of URLs before the run and pools what it finds; locators are then resolved out of that pool. That
 * works right up until a plan *changes* the page, and then it fails in two ways that are invisible until
 * you read a run log:
 *
 *  - **A page reached by clicking is never inspected at all.** demo-web's prompt 14 walks
 *    `/` → Products → a product tile → "Add to Cart". The product page is reached by a *click*, so it was
 *    never browsed, and `Add to Cart` matched the only inspected page that happened to have one — the home
 *    page's featured section. The generated locator was
 *    `getByTestId('featured-section').getByTestId('add-to-cart-macbook-pro-16"-m3-max')`, and the step died
 *    on a page where no such element exists. Note what that means: with **no** locator at all, codegen's
 *    generic `getByRole('button', { name: 'Add to Cart' }).first()` fallback would have worked. A wrong
 *    locator is worse than none.
 *  - **A page inspected in the wrong state has the wrong content.** The same run inspected `/checkout`
 *    with an empty cart, saw "Your cart is empty", and `PlanGrounder` then dropped all six of the plan's
 *    assertions as "not found on /checkout" — leaving a 23-step test with nothing to assert.
 *
 * The only honest fix is to *be on the page the step will be on*. This module walks the plan in the live
 * MCP browser — navigating, clicking, filling as it goes — and resolves each locator against the page as
 * the plan actually reaches it.
 *
 * **It is deliberately not the default path.** `stepsNeedingWalk` first asks the cheap question: can the
 * existing pre-inspection inventory already serve every step on the route that step runs on? When it can
 * — which is the case for nearly every single-page plan — nothing here runs, and behaviour is exactly
 * what it was. The walk costs a second pass of real browser actions, so it is spent only where the
 * alternative is a guess.
 */

import type { PageContext, PageElement } from "../agent/types";
import {
  waitForPageStable,
  toolResultToText,
  normalizeLocator,
  findBestRefMultiRole,
  FILLABLE_ROLES,
  CLICKABLE_ROLES,
  SELECTABLE_ROLES,
  type RefItem,
} from "../utils/mcp-helpers";

/** Actions that resolve an element, and therefore need a locator. */
const LOCATOR_ACTIONS = new Set([
  "click",
  "hover",
  "fill",
  "select",
  "check",
  "uncheck",
  "expectVisible",
  "expectNotVisible",
  "expectText",
  "expectValue",
]);

/** Actions the walk performs to advance the page. Assertions are read-only and never performed. */
const MUTATING_ACTIONS = new Set(["click", "fill", "select", "check", "uncheck", "hover"]);

const ASSERTION_ACTIONS = new Set([
  "expectVisible",
  "expectNotVisible",
  "expectText",
  "expectValue",
]);

/**
 * Values the plan itself puts on the page — the option a `select` chooses, the text a `fill` types.
 *
 * ⚠️ **When an assertion names one of these, the TEXT is the assertion**, and a locator that doesn't
 * carry it asserts nothing. Measured on demo-web prompt 3: the walk correctly landed on `/products` with
 * "Smartphones" selected, asked MCP for a locator, and got `getByTestId('products-title')` — a perfectly
 * stable handle on a heading whose text changes with the category. It passes for every category, so the
 * test went straight back to being unfailable, just in a way the substance audit cannot see.
 * `browser_generate_locator` optimises for uniqueness and stability, which is exactly right for a click
 * and exactly wrong here. For these targets the walk stays out of the way and lets codegen emit the
 * name-bearing form.
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

export interface WalkedStep {
  locator: string;
  role?: string;
  name?: string;
  pageUrl?: string;
}

interface McpLike {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

interface LoggerLike {
  log(m: string): void;
}

function pathOf(u: string | undefined): string {
  if (!u) {return "/";}
  try {
    return new URL(u, "http://x").pathname.replace(/\/+$/, "") || "/";
  } catch {
    return u;
  }
}

function norm(s: string | undefined): string {
  return String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** The property a step's element name lives in. */
function targetOf(step: any): string {
  return String(step?.target ?? step?.field ?? "");
}

/** Roles worth searching for a given action, most specific first. */
function rolesForAction(action: string): string[] {
  if (action === "fill") {return FILLABLE_ROLES;}
  if (action === "select") {return SELECTABLE_ROLES;}
  if (action === "check" || action === "uncheck") {return ["checkbox", "radio"];}
  if (action === "click" || action === "hover") {return CLICKABLE_ROLES;}
  return ["heading", "link", "button", "textbox", "generic"];
}

function elementsOf(p: PageContext | undefined): PageElement[] {
  if (!p) {return [];}
  const a = (x: PageElement[] | undefined) => (Array.isArray(x) ? x : []);
  return [
    ...a(p.headings),
    ...a(p.buttons),
    ...a(p.links),
    ...a(p.inputs),
    ...a(p.selects),
    ...a(p.checkboxes),
    ...a(p.radios),
  ];
}

function pageFor(route: string, pages: PageContext[]): PageContext | undefined {
  const rp = pathOf(route);
  return (
    pages.find((p) => pathOf(p.url) === rp) ??
    pages
      .filter((p) => pathOf(p.url) !== "/" && rp.startsWith(pathOf(p.url)))
      .sort((a, b) => pathOf(b.url).length - pathOf(a.url).length)[0]
  );
}

/**
 * Does the page really have this element?
 *
 * Exact, or the element's name contains the whole target ("Email" ⊂ "Email address"). **Reverse**
 * containment is deliberately excluded: it would let the target "All Products" match a nav link named
 * "Products", which is a different element on a different page. Used for the ambiguity count, where a
 * spurious second candidate sends a perfectly resolvable plan onto the expensive walk.
 */
function matches(name: string, e: PageElement): boolean {
  const n = norm(name);
  const en = norm(e.name);
  if (!n || !en) {return false;}
  return en === n || en.includes(n);
}

/** Is this click on something that navigates? Answered from the page's own inventory, not from the label. */
function clickLeavesPage(name: string, page: PageContext | undefined): boolean {
  if (!page) {return true;} // unknown page, so assume the worst
  const a = (x: PageElement[] | undefined) => (Array.isArray(x) ? x : []);
  const navish = [...a(page.links), ...a((page as any).cards), ...a((page as any).gridItems)];
  if (navish.some((e) => matches(name, e))) {return true;}
  // A button that we can see on this page is assumed to act in place; that is what buttons usually do,
  // and the ambiguity check below still catches it if the assumption turns out to matter.
  return !a(page.buttons).some((e) => matches(name, e));
}

/**
 * Which steps the pre-inspection inventory **cannot** honestly resolve — the ones worth walking for.
 *
 * The test is *ambiguity*, not mere uncertainty, and the distinction is what keeps this affordable.
 * Once a plan clicks a link we no longer know which page it is on — but that only matters if the pooled
 * search would have to *guess*. Three cases:
 *
 *  - **Route known** (we are still where the last `goto` put us): the element must be on that route's
 *    inventory. If it isn't, the pooled search is about to borrow another page's element → walk.
 *  - **Route unknown, element on exactly one inspected page**: no guess is involved — that page is the
 *    only candidate and `ensurePageForRef` will navigate to it. Cheap path, unchanged behaviour. This is
 *    what keeps ordinary "click a nav link, assert the destination heading" plans off the walk.
 *  - **Route unknown, element on zero or several inspected pages**: the pooled search picks by array
 *    order, i.e. arbitrarily. demo-web prompt 14 lives here — `Add to Cart` exists on the home page *and*
 *    `/products`, while the page the plan is actually on (a product detail page reached by clicking) was
 *    never inspected at all, so it picked the home page's featured MacBook. → walk.
 *
 * Pure, so the trigger condition is testable without a browser.
 */
export function stepsNeedingWalk(
  steps: any[],
  pages: PageContext[],
  startUrl: string
): number[] {
  if (!Array.isArray(steps) || !steps.length) {return [];}
  const out: number[] = [];
  let route = pathOf(startUrl);
  let routeKnown = true;

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const action = String(s?.action ?? "");

    if (action === "goto") {
      route = pathOf(String(s.url ?? ""));
      routeKnown = true;
      continue;
    }

    const name = targetOf(s);

    if (LOCATOR_ACTIONS.has(action) && name) {
      if (routeKnown) {
        const page = pageFor(route, pages);
        if (!page || !elementsOf(page).some((e) => matches(name, e))) {out.push(i);}
      } else {
        const hits = pages.filter((p) => elementsOf(p).some((e) => matches(name, e))).length;
        if (hits !== 1) {out.push(i);}
      }
    }

    if (action === "click" && name && clickLeavesPage(name, routeKnown ? pageFor(route, pages) : undefined)) {
      routeKnown = false;
    }
  }

  return out;
}

/**
 * Walk `steps` in the live browser, resolving each element-bearing step against the page the plan is
 * actually standing on, and performing the mutating ones so the page advances.
 *
 * Best-effort throughout: any step that can't be resolved or performed is logged and skipped, leaving the
 * caller's existing pooled result in place. A partial walk is strictly better than none — every step it
 * *does* resolve is resolved against the right page.
 */
export async function walkPlanForLocators(opts: {
  mcp: McpLike;
  steps: any[];
  baseUrl: string;
  logger: LoggerLike;
  /** Cap the walk so a pathological plan can't stall a run. */
  maxSteps?: number;
}): Promise<Map<number, WalkedStep>> {
  const { mcp, steps, baseUrl, logger } = opts;
  const maxSteps = opts.maxSteps ?? 40;
  const found = new Map<number, WalkedStep>();
  const authored = planAuthoredValues(steps);

  let refs: RefItem[] = [];
  let currentUrl = baseUrl;

  /**
   * ⚠️ Snapshot only once the page has SETTLED.
   *
   * A single `browser_snapshot` immediately after an action reads a page mid-update. Measured on demo-web
   * prompt 2: the walk typed "laptop", clicked Search, snapshotted at once — and the heading still said
   * "All Products", so the assertion target `All Products - "laptop"` was reported absent and handed back
   * to the fallback. The element the walk exists to find had simply not rendered yet. `waitForPageStable`
   * is the same settle loop pre-inspection uses, so the two stages see pages in comparable states.
   */
  const snapshot = async (): Promise<void> => {
    try {
      // Fewer retries than pre-inspection: the walk settles once PER STEP, so the default 8×1s ceiling
      // would dominate a long plan. A page that hasn't settled in ~4s here is one the fallback can have.
      const { snapshotText, refs: parsed } = await waitForPageStable(mcp as any, logger, {
        label: "PlanWalk",
        maxRetries: 4,
      });
      refs = parsed;
      const m = snapshotText.match(/Page URL:\s*(\S+)/);
      if (m) {currentUrl = m[1];}
    } catch (e: any) {
      logger.log(`PlanWalk: snapshot failed — ${e?.message ?? String(e)}`);
    }
  };

  try {
    await mcp.callTool("browser_navigate", { url: baseUrl });
    await snapshot();
  } catch (e: any) {
    logger.log(`PlanWalk: could not open ${baseUrl} — ${e?.message ?? String(e)}. Skipping walk.`);
    return found;
  }

  for (let i = 0; i < steps.length && i < maxSteps; i++) {
    const s = steps[i];
    const action = String(s?.action ?? "");

    try {
      if (action === "goto") {
        const url = String(s.url ?? "");
        await mcp.callTool("browser_navigate", {
          url: url.startsWith("http") ? url : new URL(url, baseUrl).toString(),
        });
        await snapshot();
        continue;
      }

      if (action === "waitForLoad" || action === "waitFor") {
        await snapshot();
        continue;
      }

      if (!LOCATOR_ACTIONS.has(action)) {continue;}

      const name = targetOf(s);
      if (!name) {continue;}

      const ref = findBestRefMultiRole(refs, rolesForAction(action), name);
      if (!ref) {
        logger.log(`PlanWalk [${i + 1}]: "${name}" not on ${pathOf(currentUrl)} — leaving to fallback.`);
        // Still try to advance: without the element we cannot perform the action, so the rest of the
        // walk is on a page the plan wouldn't be on. Stop rather than resolve against a wrong page.
        if (MUTATING_ACTIONS.has(action)) {
          logger.log(`PlanWalk: cannot advance past step ${i + 1}; ending walk here.`);
          break;
        }
        continue;
      }

      const item = refs.find((r) => r.ref === ref);

      // The element is confirmed present on the real page — but for an assertion on a value the plan
      // itself entered, that is ALL we wanted to learn. Recording MCP's locator here would swap the text
      // being asserted for a name-agnostic handle. See `planAuthoredValues`.
      if (ASSERTION_ACTIONS.has(action) && authored.has(norm(name))) {
        logger.log(
          `PlanWalk [${i + 1}]: "${name}" confirmed on ${pathOf(currentUrl)} — keeping the ` +
            `name-bearing assertion rather than a generated handle.`
        );
        continue;
      }

      const locRes = await mcp.callTool("browser_generate_locator", { ref });
      const locator = normalizeLocator(toolResultToText(locRes).trim());
      if (locator) {
        found.set(i, { locator, role: item?.role, name: item?.name, pageUrl: currentUrl });
        logger.log(
          `PlanWalk [${i + 1}]: ${action} "${name}" = ${locator} [on ${pathOf(currentUrl)}]`
        );
      }

      if (!MUTATING_ACTIONS.has(action)) {continue;}

      // Advance the page so the next step is resolved against the state it will really meet.
      const element = item?.name ?? name;
      if (action === "fill") {
        await mcp.callTool("browser_type", { element, ref, text: String(s.value ?? "") });
      } else if (action === "select") {
        await mcp.callTool("browser_select_option", { element, ref, values: [String(s.option ?? "")] });
      } else if (action === "hover") {
        await mcp.callTool("browser_hover", { element, ref });
      } else {
        await mcp.callTool("browser_click", { element, ref });
      }
      await snapshot();
    } catch (e: any) {
      logger.log(`PlanWalk [${i + 1}]: ${action} failed — ${e?.message ?? String(e)}. Ending walk.`);
      break;
    }
  }

  return found;
}
