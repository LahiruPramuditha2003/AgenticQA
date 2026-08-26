/**
 * Pure flow synthesis for the Exploratory testing agent (S3.2).
 *
 * Turns a crawled `SiteMap` into candidate flows — action-list plans with the same shape as a
 * `testPlan` test case's `steps`. Three families:
 *   • smoke — `goto` a route + assert its primary heading is visible.
 *   • form  — on a route with fillable inputs + a submit-like button: fill sample values, assert the
 *             submit control is available, then SUBMIT. (It deliberately did not submit until 2026-08-11;
 *             see the note on the click in `formFlow` for why that changed and what makes it safe.)
 *   • nav   — from the start page, click a nav link and assert the destination route's heading.
 *
 * No IO here — fully unit-testable from a `SiteMap` fixture.
 */

import type { SiteMap, SiteRoute } from "./Crawler";
import { resolveSameOriginUrl, routeKeyForPath, pathOf } from "./Crawler";

export type FlowKind = "smoke" | "form" | "nav" | "filter";

export interface ExploratoryFlow {
  title: string;
  kind: FlowKind;
  /** The route this flow primarily exercises (for the smoke/form it's the page; for nav it's the dest). */
  routeKey: string;
  /** Action-list, same shape as a testPlan test case's steps. */
  steps: Array<Record<string, any>>;
}

/**
 * Generic English action VERBS that begin a form's primary button label.
 *
 * ⚠️ This list used to read `create account|place order|checkout|pay|…` — e-commerce *nouns*, i.e. the
 * same app-specific hardcoding as L1, hiding in the generator. It meant a "Create Task" button was not
 * recognised, so TaskFlow's main form got no form flow at all: `generate_pack` silently produced a pack
 * with no way to test the app's central workflow, and `explore` never generated one either.
 *
 * The line held here is verb, not noun: `create` is generic English, `create account` is a domain phrase.
 * Match the verb and any app's "Create Task" / "Create Project" / "Add Item" works with no new entries.
 *
 * `delete`/`remove` are deliberately EXCLUDED — a destructive action is not a form submit, and picking one
 * as a flow's primary button would point generated tests at the most dangerous control on the page.
 */
const SUBMIT_RE =
  /^(submit|save|create|add|send|invite|register|apply|update|confirm|continue|next|finish|post|publish|sign\s?in|log\s?in|login|sign\s?up|place order|checkout|pay)\b/i;

/** True when a button label reads like a form-submit / primary action. */
export function isSubmitButton(name: string): boolean {
  return SUBMIT_RE.test((name ?? "").trim());
}

/**
 * A realistic sample value for a field.
 *
 * ⚠️ **The input's TYPE wins over its name.** `<input type="date">` only accepts `YYYY-MM-DD`; anything
 * else makes Playwright throw `fill: Error: Malformed value`. That is what killed TaskFlow's Create Task
 * flow on 2026-08-10 — "Due date" got the generic `"Test value"`, the flow failed validation, and the
 * generated pack shipped with **no way to test the app's central workflow**. Same defect family as D14
 * (a `<select>` typed into instead of chosen from): the DOM says what a control accepts, so ask it.
 */
export function sampleValueFor(field: string, inputType?: string): string {
  switch ((inputType ?? "").toLowerCase()) {
    case "date": return "2026-12-31";
    case "datetime-local": return "2026-12-31T10:00";
    case "month": return "2026-12";
    case "week": return "2026-W01";
    case "time": return "10:00";
    case "number":
    case "range": return "1";
    case "email": return "test.user@example.com";
    case "tel": return "555-0100";
    case "url": return "https://example.com";
    case "color": return "#3366ff";
    case "password": return "Password123!";
    default: break;
  }
  const n = (field ?? "").toLowerCase();
  // Name-based date detection, for a date-ish field the crawler reported without a type.
  if (/\b(date|deadline|due|birthday|dob)\b|expir/.test(n)) {return "2026-12-31";}
  if (n.includes("email") || n.includes("e-mail")) return "test.user@example.com";
  if (n.includes("pass")) return "Password123!";
  if (n.includes("full") && n.includes("name")) return "Test User";
  if (n.includes("first")) return "Test";
  if (n.includes("last")) return "User";
  if (n.includes("name")) return "Test User";
  if (n.includes("phone") || n.includes("tel")) return "555-0100";
  if (n.includes("zip") || n.includes("postal")) return "10001";
  if (n.includes("city")) return "New York";
  if (n.includes("state")) return "NY";
  if (n.includes("address")) return "123 Test Street";
  if (n.includes("card") && n.includes("number")) return "4111111111111111";
  if (n.includes("cvv") || n.includes("cvc")) return "123";
  if (n.includes("expir")) return "12/28";
  if (n.includes("search") || n.includes("query")) return "laptop";
  return "Test value";
}

function smokeFlow(route: SiteRoute): ExploratoryFlow | null {
  if (!route.title) return null; // nothing reliable to assert
  return {
    kind: "smoke",
    routeKey: route.routeKey,
    // Leads with the page's REAL heading. A flow title is not just a label: when the flow lands in a
    // knowledge pack it becomes the `description`, which is retrieval text (G2.5). "Smoke" is developer
    // jargon that appears in every such flow, so it discriminates nothing and only dilutes the rest.
    // The path stays for uniqueness — `synthesizeFlows` dedupes by title.
    title: `${route.title} — page loads (${route.path})`,
    steps: [
      { action: "goto", url: route.url },
      { action: "waitForLoad" },
      { action: "expectVisible", target: route.title },
    ],
  };
}

/** Roles that must be chosen from, never typed into. */
function isSelectRole(role?: string): boolean {
  const r = (role ?? "").toLowerCase();
  return r === "combobox" || r === "listbox";
}

function formFlow(route: SiteRoute): ExploratoryFlow | null {
  // Dedupe by name. A route is inventoried twice — once from the MCP accessibility snapshot, once from
  // the DOM — and the merge only unifies the two when `testId` matches. It usually doesn't (the snapshot
  // copy has none), so the same control can appear twice: once WITHOUT its <option> list and once with.
  // Un-deduped that yields duplicate steps and, worse, can hand us the option-less copy.
  const seen = new Set<string>();
  const fillable = route.inputs
    .filter((i) => i.name && !i.name.toLowerCase().includes("search")) // skip search filters
    .filter((i) => {
      const k = i.name.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 6);
  const submit = route.buttons.find((b) => isSubmitButton(b.name));
  if (fillable.length === 0 || !submit) return null;

  /** Options for a control, taken from ANY inventoried copy of it (see the dedupe note above). */
  const optionsFor = (name: string): string[] | undefined =>
    route.inputs.find((i) => i.name === name && i.options && i.options.length > 0)?.options;

  /** Same for `inputType`: the accessibility-snapshot copy carries none, the DOM copy does. */
  const inputTypeFor = (name: string): string | undefined =>
    route.inputs.find((i) => i.name === name && i.inputType)?.inputType;

  const steps: Array<Record<string, any>> = [
    { action: "goto", url: route.url },
    { action: "waitForLoad" },
  ];
  for (const f of fillable) {
    // ⚠️ Defect D14, and it was not cosmetic. This used to branch on `options` being present, so a
    // combobox whose options weren't captured fell through to `fill` — and Playwright rejects a fill on
    // a <select> ("Element is not an <input>"). On the 2026-08-10 TaskFlow run that killed BOTH
    // interaction-heavy flows (`form-new`, `form-settings`) during validate-by-running, leaving a pack of
    // smoke/nav flows only: every generated test passed while exercising nothing (25% substantive).
    // Branch on the ROLE, which is always known; missing options mean skip, never type.
    if (isSelectRole(f.role)) {
      const opts = f.options?.length ? f.options : optionsFor(f.name);
      if (opts?.length) {
        steps.push({ action: "select", field: f.name, option: opts[opts.length - 1] });
      }
      // No options anywhere: skip it. We cannot invent an option value, and typing is guaranteed to fail.
      continue;
    }
    steps.push({
      action: "fill",
      field: f.name,
      value: sampleValueFor(f.name, f.inputType ?? inputTypeFor(f.name)),
    });
  }

  // If every control turned out to be an unusable select, there is no form flow worth generating.
  if (!steps.some((s) => s.action === "fill" || s.action === "select")) return null;

  // Assert the primary action is available once the form is filled — some apps keep it hidden or disabled
  // until the form validates, so this is a real check and not a restatement of the click below.
  // Checkboxes are part of the form. They were invisible to this function until the crawler started
  // capturing them at all (2026-08-11) — see `SiteRoute.checkboxes`.
  for (const c of (route.checkboxes ?? []).slice(0, 3)) {
    if (c.name) {steps.push({ action: "check", target: c.name });}
  }

  steps.push({ action: "expectVisible", target: submit.name });

  // ⚠️ **Submit.** This used to stop here, on purpose: blind-submitting an unknown form can navigate or
  // error unpredictably, which would make a *discovered* test flaky. The cost of that caution was that
  // every generated pack tested a form it never sent — TaskFlow's "Create Task", "Save Settings" and the
  // required-title validation all scored UNDER_TESTED for exactly this reason, and the app's central
  // workflow had no test at all.
  //
  // Owner decision, 2026-08-11: submit, and let **validate-by-running** be the judge. That safety net
  // already exists and is not theoretical — it is what caught D14. A flow whose submit misbehaves fails
  // validation and never reaches the pack, exactly as before; the difference is that a flow whose submit
  // *works* is now allowed to prove it.
  //
  // `isSubmitButton` deliberately excludes `delete`/`remove`, so the control clicked here is never the
  // destructive one on the page.
  steps.push({ action: "click", target: submit.name });
  steps.push({ action: "waitForLoad" });

  return {
    kind: "form",
    routeKey: route.routeKey,
    // ⚠️ This used to be `Fill the form on ${route.path}`, throwing away the page heading the crawler had
    // already captured. Measured on the TaskFlow generated pack: it cost SEVEN of twenty prompts, because
    // `smoke-new` ("Create Task") and `nav-login` ("Sign in to TaskFlow") kept the app's own vocabulary
    // while the form flows that actually satisfy those prompts described themselves only by URL path.
    title: route.title
      ? `${route.title} — submit the form (${route.path})`
      : `Submit the form on ${route.path}`,
    steps,
  };
}

/**
 * A page whose controls have **no submit button** — a filter bar, a sort dropdown, a settings toggle.
 *
 * ⚠️ `formFlow` requires a submit control and bails without one, so these pages produced nothing but a
 * smoke flow: a `goto` and a heading assertion. That is why TaskFlow's "type a name into the Projects
 * filter" and "set the Status dropdown to Paused" had no flow that could satisfy them — the *page* was
 * crawled, its controls were captured, and then discarded for lack of a button to press.
 *
 * The assertion is deliberately modest — the page's own heading, i.e. "interacting with this control did
 * not break the page". Generically we cannot know what a filter *should* produce, and inventing an
 * expectation would be the kind of guess this project keeps refusing. It is the same standard `formFlow`
 * already holds itself to (it asserts the submit control is available, not that submission succeeded).
 */
function filterFlow(route: SiteRoute): ExploratoryFlow | null {
  if (!route.title) return null;
  if (route.buttons.some((b) => isSubmitButton(b.name))) return null; // formFlow's job

  const seen = new Set<string>();
  const controls = route.inputs
    .filter((i) => i.name && !seen.has(i.name.toLowerCase()) && (seen.add(i.name.toLowerCase()), true))
    .slice(0, 3);
  const boxes = (route.checkboxes ?? []).filter((c) => c.name).slice(0, 2);
  if (!controls.length && !boxes.length) return null;

  const optionsFor = (name: string): string[] | undefined =>
    route.inputs.find((i) => i.name === name && i.options && i.options.length > 0)?.options;
  const inputTypeFor = (name: string): string | undefined =>
    route.inputs.find((i) => i.name === name && i.inputType)?.inputType;

  const steps: Array<Record<string, any>> = [
    { action: "goto", url: route.url },
    { action: "waitForLoad" },
  ];
  let acted = false;
  for (const c of controls) {
    if (isSelectRole(c.role)) {
      const opts = c.options?.length ? c.options : optionsFor(c.name);
      // Prefer the LAST option: selecting whatever is already selected exercises nothing.
      if (opts?.length) {
        steps.push({ action: "select", field: c.name, option: opts[opts.length - 1] });
        acted = true;
      }
      continue;
    }
    steps.push({
      action: "fill",
      field: c.name,
      value: sampleValueFor(c.name, c.inputType ?? inputTypeFor(c.name)),
    });
    acted = true;
  }
  for (const b of boxes) {
    steps.push({ action: "check", target: b.name });
    acted = true;
  }
  if (!acted) return null;

  steps.push({ action: "waitForLoad" });
  steps.push({ action: "expectVisible", target: route.title });

  return {
    kind: "filter",
    routeKey: route.routeKey,
    title: `${route.title} — use the page controls (${route.path})`,
    steps,
  };
}

function navFlows(
  start: SiteRoute,
  byKey: Map<string, SiteRoute>,
  baseUrl: string,
  max = 6
): ExploratoryFlow[] {
  const out: ExploratoryFlow[] = [];
  const seen = new Set<string>();
  for (const link of start.links) {
    if (out.length >= max) break;
    if (!link.name || !link.href) continue;
    const abs = resolveSameOriginUrl(link.href, baseUrl);
    if (!abs) continue;
    const destKey = routeKeyForPath(pathOf(abs));
    if (destKey === start.routeKey || seen.has(destKey)) continue;
    const dest = byKey.get(destKey);
    if (!dest || !dest.title) continue;
    seen.add(destKey);
    // When the link label and the destination heading say the same thing ("Projects" → "Projects",
    // "Sign in" → "Sign in to TaskFlow"), naming both double-counts one piece of evidence and let
    // navigation-only flows outrank the form flows that actually satisfy a "sign in with…" request.
    const sameWords =
      link.name.toLowerCase() === dest.title.toLowerCase() ||
      dest.title.toLowerCase().includes(link.name.toLowerCase());
    out.push({
      kind: "nav",
      routeKey: destKey,
      title: sameWords
        ? `Open "${dest.title}" from the navigation`
        : `Open "${dest.title}" via the "${link.name}" link`,
      steps: [
        { action: "goto", url: start.url },
        { action: "waitForLoad" },
        { action: "click", target: link.name },
        { action: "waitForLoad" },
        { action: "expectVisible", target: dest.title },
      ],
    });
  }
  return out;
}

/** Synthesize candidate flows from a crawled SiteMap (deduped by title, capped at `maxFlows`). */
export function synthesizeFlows(
  site: SiteMap,
  opts?: { baseUrl?: string; maxFlows?: number }
): ExploratoryFlow[] {
  const baseUrl = opts?.baseUrl ?? site.startUrl;
  const maxFlows = opts?.maxFlows ?? 40;
  const byKey = new Map(site.routes.map((r) => [r.routeKey, r]));
  const flows: ExploratoryFlow[] = [];

  for (const route of site.routes) {
    const s = smokeFlow(route);
    if (s) flows.push(s);
    const f = formFlow(route);
    if (f) flows.push(f);
    const fl = filterFlow(route);
    if (fl) flows.push(fl);
  }

  const start = byKey.get(routeKeyForPath(pathOf(site.startUrl))) ?? site.routes[0];
  if (start) flows.push(...navFlows(start, byKey, baseUrl));

  const seen = new Set<string>();
  return flows.filter((fl) => (seen.has(fl.title) ? false : (seen.add(fl.title), true))).slice(0, maxFlows);
}
