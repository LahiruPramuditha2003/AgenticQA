/**
 * Shared helpers used by UiInspectorAgent, SelfHealAgent, and pre-inspection.
 */

import type { PageContext, PageElement } from "../agent/types";

/* ─── Role constants ─── */

/** Roles that represent fillable input fields */
// D12: `searchbox` belongs here. An `<input type="search">` gets the ARIA role `searchbox`, not
// `textbox`, so omitting it meant such a field never reached `PageContext.inputs` and the planner
// could not fill it at all. demo-web hid the bug by using `type="text"`; TaskFlow's /projects filter
// exposed it. Left unfixed until G3 on purpose, so the cross-app baseline measured the engine as-is.
export const FILLABLE_ROLES = ["textbox", "searchbox", "combobox", "slider"];

/** Roles that represent clickable elements */
export const CLICKABLE_ROLES = ["button", "link"];

/** Roles that represent selectable dropdown options */
export const SELECTABLE_ROLES = ["combobox", "listbox", "menu"];

/* ─── Tool result parsing ─── */

export function toolResultToText(res: any): string {
  if (res == null) return "";
  if (typeof res === "string") return res;
  if (Array.isArray(res.content)) {
    return res.content
      .map((c: any) => {
        if (typeof c === "string") return c;
        if (typeof c?.text === "string") return c.text;
        if (typeof c?.content === "string") return c.content;
        return JSON.stringify(c);
      })
      .join("\n");
  }
  if (typeof res.text === "string") return res.text;
  if (typeof res.content === "string") return res.content;
  return JSON.stringify(res);
}

/* ─── Locator normalization ─── */

export function normalizeLocator(locatorRaw: string): string | null {
  if (!locatorRaw) return null;
  const lines = locatorRaw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  
  if (lines.length === 0) return null;

  const candidate = lines.find(
    (l) =>
      l.startsWith("getBy") ||
      l.startsWith("locator(") ||
      l.startsWith("page.getBy") ||
      l.startsWith("page.locator(")
  );
  
  if (candidate) {
    if (candidate.startsWith("page.")) return candidate;
    if (candidate.startsWith("getBy") || candidate.startsWith("locator(")) {
      return `page.${candidate}`;
    }
    return candidate;
  }

  // If no standard Playwright locator method is found, check if it's an error message
  const raw = lines[0];
  if (raw.toLowerCase().includes("error") || raw.toLowerCase().includes("failed") || raw.includes("not found")) {
    return null;
  }

  // Fallback: Treat as a raw string selector (e.g., internal:attr=..., #id, .class)
  return `page.locator(${JSON.stringify(raw)})`;
}

/* ─── Snapshot parsing ─── */

export type RefItem = {
  role: string;
  name: string;
  ref: string;
  pageUrl?: string;
  /** `<option>` labels, for a combobox/listbox. See `parseSnapshotRefs`. */
  options?: string[];
  /** Heading rank from `[level=N]` — 1 for `<h1>`. Absent for non-headings. See `parseSnapshotRefs`. */
  level?: number;
};

/**
 * Parse `role "name" [ref=eN]` lines out of an MCP accessibility snapshot — **including the `option`
 * children of a dropdown**, which are nested under it and carry no ref of their own:
 *
 *     - combobox "Priority" [ref=e25]:
 *         - option "Low"
 *         - option "Medium" [selected]
 *
 * ⚠️ Those options used to be dropped, and the cost was invisible but large. Without them a generated
 * form flow cannot emit a `select` step at all: `synthesizeFlows` (rightly) refuses to *type* into a
 * `<select>` (defect D14), so with no options to choose from it skipped the control entirely. On
 * TaskFlow that silently removed Project / Assignee / Priority from the Create Task flow — three of its
 * six fields — and every benchmark prompt asking to "set the priority" or "choose a project" scored
 * UNDER_TESTED. The data was in the snapshot the whole time.
 */
export function parseSnapshotRefs(snapshotText: string): RefItem[] {
  const out: RefItem[] = [];
  const lines = snapshotText.split(/\r?\n/);
  // The most recent ref and how deeply it was indented, so nested `option` lines can be attributed.
  let owner: RefItem | null = null;
  let ownerIndent = -1;

  for (const line of lines) {
    const indent = line.length - line.trimStart().length;

    const ref = line.match(/-\s*([a-zA-Z]+)\s+"([^"]*)".*\[ref=([^\]]+)\]/);
    if (ref) {
      const item: RefItem = { role: ref[1].toLowerCase(), name: ref[2], ref: ref[3] };
      // `[level=N]` was being swallowed by the `.*` above. Without it a heading's RANK is unknown, and
      // "the page's title" degrades to "whichever heading appears first in DOM order" — which on a page
      // with a filter sidebar is the sidebar's <h3>, not the <h1>. See `pickPageTitle`.
      const lvl = line.match(/\[level=(\d+)\]/);
      if (lvl) {item.level = Number(lvl[1]);}
      out.push(item);
      owner = item;
      ownerIndent = indent;
      continue;
    }

    // An `option` nested under the current dropdown. `[selected]` and similar suffixes are ignored.
    const opt = line.match(/-\s*option\s+"([^"]*)"/);
    if (opt && owner && indent > ownerIndent && (owner.role === "combobox" || owner.role === "listbox")) {
      (owner.options ??= []).push(opt[1]);
      continue;
    }

    // Any other non-blank line at or above the owner's depth ends its scope.
    if (line.trim() && indent <= ownerIndent) {
      owner = null;
      ownerIndent = -1;
    }
  }
  return out;
}

/* ─── Ref searching ─── */

export function findBestRef(
  items: RefItem[],
  role: string,
  name: string
): string | undefined {
  const target = name.trim().toLowerCase();
  const exact = items.find(
    (i) => i.role === role && i.name.trim().toLowerCase() === target
  );
  if (exact) return exact.ref;
  const contains = items.find(
    (i) => i.role === role && i.name.trim().toLowerCase().includes(target)
  );
  return contains?.ref;
}

/**
 * Search multiple roles for a name match, in role-priority order.
 *
 * ⚠️ **Match quality outranks role priority.** This used to run `findBestRef` per role and return the
 * first hit, so a *substring* match in a preferred role beat an *exact* match in a later one. That is how
 * demo-web's logout test broke: the plan asserts `"Login"`, the post-logout navbar has `link "Login"`
 * (exact), but `/auth/login`'s `heading "Please Login"` merely contains it — and headings are searched
 * before links, so the test asserted a heading that only exists on a page it had already left.
 *
 * Two passes: exact across every role first, then substring across every role. Within a pass the role
 * order still decides, so the original preference is intact wherever the match quality ties.
 */
export function findBestRefMultiRole(
  items: RefItem[],
  roles: string[],
  name: string
): string | undefined {
  const target = name.trim().toLowerCase();
  for (const role of roles) {
    const exact = items.find(
      (i) => i.role === role && i.name.trim().toLowerCase() === target
    );
    if (exact) return exact.ref;
  }
  for (const role of roles) {
    const contains = items.find(
      (i) => i.role === role && i.name.trim().toLowerCase().includes(target)
    );
    if (contains) return contains.ref;
  }
  return undefined;
}

/**
 * Every ref that matches `name` as well as the best one does — the ambiguous case, and the only one where
 * history has anything useful to say (G4.3).
 *
 * `findBestRefMultiRole` returns the first of these, which is arbitrary when several are equally good.
 * That arbitrariness is not hypothetical: it is the `strict-mode` failure class, and demo-web prompt 14
 * hit it. Returns at most `limit` refs, and an array of length ≤1 when there is nothing to choose between.
 */
export function findEquallyMatchingRefs(
  items: RefItem[],
  roles: string[],
  name: string,
  limit = 3
): RefItem[] {
  const target = name.trim().toLowerCase();
  if (!target) {return [];}
  for (const pass of ["exact", "contains"] as const) {
    for (const role of roles) {
      const hits = items.filter((i) => {
        if (i.role !== role) {return false;}
        const n = i.name.trim().toLowerCase();
        return pass === "exact" ? n === target : n.includes(target);
      });
      if (hits.length) {return hits.slice(0, limit);}
    }
  }
  return [];
}

export function findByRef(
  items: RefItem[],
  ref: string
): RefItem | undefined {
  return items.find((i) => i.ref === ref);
}

/* ─── Cross-page ref identity ─── */

/**
 * MCP ref ids (`e2`, `e17`, …) are a **per-snapshot counter**, so every page restarts at `e1`. Any code
 * that pools refs from several pages must therefore namespace them, or `e17` on page 2 is indistinguishable
 * from `e17` on page 1.
 *
 * ⚠️ It didn't just confuse lookups — it **silently deleted elements**. Both accumulators deduped by raw
 * ref id, so once the first page had used up `e2…e88`, the second page contributed only the ids beyond that
 * high-water mark. Measured on demo-web: inspecting `/` (87 refs), `/auth/login` (29) and `/account` (23)
 * pooled **108 of 139** elements, and the run log's own summary gave it away — "1 input(s)" across three
 * pages, one of which is a login form with two. The planner and the locator resolver were reasoning about a
 * page inventory with holes in it, and which elements fell in the holes depended on nothing more meaningful
 * than the order the pages happened to be visited in.
 */
const PAGE_REF_SEP = "@@";

/** Namespace a page-local ref id so it is unique across pages. */
export function scopedRef(localRef: string, pageUrl: string): string {
  return `${localRef}${PAGE_REF_SEP}${pageUrl}`;
}

/** Recover the page-local id — the only form an MCP tool call understands. */
export function mcpRefOf(ref: string): string {
  const i = ref.indexOf(PAGE_REF_SEP);
  return i === -1 ? ref : ref.slice(0, i);
}

/**
 * Append one page's refs to a cross-page pool, namespaced by page and deduped **within** the page.
 *
 * The same element can legitimately appear on several pages (a nav link, a site heading); those are kept
 * as separate entries because they are separate live elements — `ensurePageForRef` navigates to the one
 * that was chosen, so collapsing them would send locator generation to the wrong page.
 */
export function mergePageRefs(pool: RefItem[], pageRefs: RefItem[], pageUrl: string): void {
  const seen = new Set(pool.map((r) => r.ref));
  for (const r of pageRefs) {
    const ref = scopedRef(r.ref, pageUrl);
    if (seen.has(ref)) continue;
    seen.add(ref);
    pool.push({ ...r, ref, pageUrl });
  }
}

/* ─── Candidate filtering ─── */

/**
 * Get candidate refs for a given action type.
 * Handles multi-role searches (e.g., fill → textbox + combobox).
 */
export function getCandidatesForAction(
  refs: RefItem[],
  action: string,
  baselineRole?: string | null
): RefItem[] {
  if (action === "fill") {
    return refs.filter((r) => FILLABLE_ROLES.includes(r.role));
  }
  if (action === "click") {
    return refs.filter((r) => CLICKABLE_ROLES.includes(r.role));
  }
  if (action === "expectVisible") {
    if (baselineRole) return refs.filter((r) => r.role === baselineRole);
    return refs; // search all roles
  }
  return refs;
}

/**
 * Deterministic locator replacement (no DB/embeddings): from the live page's candidate refs for the
 * failed action, pick the best element by role-aware fuzzy name match against the intended name.
 * Tries exact → substring → token-overlap; returns null rather than make a confidently-wrong choice
 * when nothing matches and there's more than one candidate. This is the DB-less heal strategy.
 */
/**
 * Is `candidateName` a plausible stand-in for the element the step meant to reach?
 *
 * ⚠️ The **vector** heal path had no such check: it took the nearest embedding to the stored baseline and
 * used it, whatever it was called. Observed on demo-web prompt 14, 2026-08-11 — with the LLM planner
 * authoring a different plan each run, `plan-step-N` is a *positional* key, so a neighbour search under
 * `plan-step-5` returned an observation recorded for an entirely different step of an earlier plan. The
 * healer then rewrote **both** `Add to Cart` and `Proceed to Checkout` to the same
 * `getByRole("link", { name: "Shopping Cart" })`, and the "healed" spec failed worse than the original.
 *
 * A heal that makes a run worse is not a neutral failure: it destroys the evidence of the real defect and,
 * on an assertion, can hide a genuine regression. So the vector path must clear the same bar the
 * deterministic path already sets — the replacement has to look like the thing it replaces.
 */
export function isPlausibleHealName(intendedName: string | null | undefined, candidateName: string): boolean {
  const target = String(intendedName ?? "").trim().toLowerCase();
  const name = String(candidateName ?? "").trim().toLowerCase();
  if (!target) {return true;} // nothing to check against — the caller's other guards apply
  if (!name) {return false;}
  if (name === target || name.includes(target) || target.includes(name)) {return true;}
  const t = new Set(target.split(/\s+/).filter((w) => w.length > 2));
  if (!t.size) {return false;}
  // ⚠️ A strict MAJORITY of the intended name's significant words, not merely half. "Add to Cart" and
  // "Shopping Cart" share exactly one word of two ("to" is too short to count) — a bare overlap test, or
  // even a >=50% one, waves that straight through, and it is the precise false positive that let the
  // healer rewrite an Add-to-Cart click into a Shopping-Cart link. Short labels are common, so half of two
  // is not evidence. Genuine relabelings ("Email" -> "Email address", "Proceed to Checkout" -> "Checkout")
  // are caught by the substring test above and never reach here.
  const shared = name.split(/\s+/).filter((w) => w.length > 2 && t.has(w)).length;
  return shared * 2 > t.size;
}

export function chooseHealReplacement(
  refs: RefItem[],
  action: string,
  intendedName: string | null,
  baselineRole?: string | null
): RefItem | null {
  const candidates = getCandidatesForAction(refs, action, baselineRole);
  if (candidates.length === 0) return null;

  const target = (intendedName ?? "").trim().toLowerCase();
  if (!target) {
    // No name to disambiguate by — only safe when there's exactly one candidate.
    return candidates.length === 1 ? candidates[0] : null;
  }

  // 1) exact accessible-name match
  const exact = candidates.find((c) => c.name.trim().toLowerCase() === target);
  if (exact) return exact;

  // 2) substring either way
  const sub = candidates.find((c) => {
    const n = c.name.trim().toLowerCase();
    return n.length > 0 && (n.includes(target) || target.includes(n));
  });
  if (sub) return sub;

  // 3) token overlap — best by count of shared words (len > 2)
  const targetTokens = new Set(target.split(/\s+/).filter((w) => w.length > 2));
  if (targetTokens.size > 0) {
    let best: { ref: RefItem; score: number } | null = null;
    for (const c of candidates) {
      const tokens = c.name.trim().toLowerCase().split(/\s+/).filter((w) => w.length > 2);
      const score = tokens.filter((t) => targetTokens.has(t)).length;
      if (score > 0 && (!best || score > best.score)) best = { ref: c, score };
    }
    if (best) return best.ref;
  }

  // 4) nothing matched — take the lone candidate, else decline.
  return candidates.length === 1 ? candidates[0] : null;
}

/* ─── URL helpers ─── */

export function toPagePath(urlOrPath: string, baseUrl: string): string {
  try {
    const u = urlOrPath.startsWith("http")
      ? new URL(urlOrPath)
      : new URL(urlOrPath, baseUrl);
    return u.pathname;
  } catch {
    return urlOrPath;
  }
}

/* ─── Signature building ─── */

export function buildSignatureText(input: {
  stepKey: string;
  pageUrl: string;
  action: string;
  role?: string;
  name?: string;
  locator: string;
}): string {
  return [
    `step_key=${input.stepKey}`,
    `page_url=${input.pageUrl}`,
    `action=${input.action}`,
    `role=${input.role ?? ""}`,
    `name=${input.name ?? ""}`,
    `locator=${input.locator}`,
  ].join("\n");
}

/* ─── Page stability ─── */

/** Minimum refs for a snapshot to count as "real content" rather than an empty transient. */
export const MIN_MEANINGFUL_REFS = 3;

/**
 * App-agnostic page-stability predicate: true when the accessibility-ref count has settled
 * (equal to the previous snapshot) and is above a small floor.
 *
 * This intentionally contains NO app-specific text checks. The previous implementation required
 * a heading literally containing "Welcome" (the demo home page heading), which made every other
 * page — and every non-demo app — never satisfy the early-return and burn all retries (~8s/page).
 */
export function isSnapshotStable(
  refs: RefItem[],
  prevRefCount: number,
  minRefs: number = MIN_MEANINGFUL_REFS
): boolean {
  return refs.length >= minRefs && refs.length === prevRefCount;
}

/**
 * Wait for a page to stabilize by taking repeated snapshots until
 * the ref count stops changing.
 */
export async function waitForPageStable(
  mcp: any,
  logger: { log: (msg: string) => void },
  opts?: { maxRetries?: number; delayMs?: number; label?: string }
): Promise<{ snapshotText: string; refs: RefItem[] }> {
  const maxRetries = opts?.maxRetries ?? 8; // Increased from 4 to 8
  const delayMs = opts?.delayMs ?? 1000; // Increased from 800 to 1000
  const label = opts?.label ?? "PageWait";

  let prevRefCount = -1;
  let snapshotText = "";
  let refs: RefItem[] = [];

  for (let i = 0; i < maxRetries; i++) {
    if (i === 0) {
      await new Promise((r) => setTimeout(r, 1000)); // Increased initial wait
    } else {
      await new Promise((r) => setTimeout(r, delayMs));
    }

    const snapRes = await mcp.callTool("browser_snapshot", {});
    snapshotText = toolResultToText(snapRes);
    refs = parseSnapshotRefs(snapshotText);

    // App-agnostic stability: ref count settled across two consecutive snapshots, above a floor.
    if (isSnapshotStable(refs, prevRefCount)) {
      logger.log(
        `${label}: page stable — ${refs.length} refs (after ${i + 1} snapshot(s))`
      );
      return { snapshotText, refs };
    }

    prevRefCount = refs.length;
    logger.log(
      `${label}: page loading — ${refs.length} refs (snapshot ${i + 1}/${maxRetries})`
    );
  }

  logger.log(`${label}: using final snapshot — ${refs.length} refs`);
  return { snapshotText, refs };
}

/* ─── Pre-inspection helpers ─── */

function filterByRoles(refs: RefItem[], roles: string[]): PageElement[] {
  return refs
    .filter((r) => roles.includes(r.role))
    .map((r) => ({
      role: r.role,
      name: r.name,
      pageUrl: r.pageUrl,
      options: r.options,
      level: r.level,
    }));
}

/**
 * Build a PageContext from a snapshot's parsed refs.
 */
export function buildPageContext(
  url: string,
  refs: RefItem[],
  rawSnapshot: string
): PageContext {
  return {
    url,
    inputs: filterByRoles(refs, FILLABLE_ROLES),   // textbox + combobox
    buttons: filterByRoles(refs, ["button"]),
    headings: filterByRoles(refs, ["heading"]),
    links: filterByRoles(refs, ["link"]),
    // `combobox` too — a `<select>` reports as combobox in the accessibility tree, so listing only
    // listbox left `selects` EMPTY for most real apps. `PageInventory` already treated both as selects;
    // this was the inconsistent half, and it disabled every consumer that reads `PageContext.selects`
    // (PlanGrounder's fill→select coercion, ScenarioPlanner's option-set binding).
    selects: filterByRoles(refs, ["combobox", "listbox"]),
    checkboxes: filterByRoles(refs, ["checkbox"]),
    radios: filterByRoles(refs, ["radio"]),
    rawSnapshot,
  };
}

/**
 * Format a PageContext as a concise description for the Planner LLM.
 */
function formatPageSectionForPlanner(page: PageContext): string[] {
  const lines: string[] = [];
  lines.push(`Page URL: ${page.url}`);
  const sections: Array<{ label: string; items: PageElement[] }> = [
    { label: "Input fields (fillable)", items: page.inputs },
    { label: "Buttons", items: page.buttons },
    { label: "Headings", items: page.headings },
    { label: "Links", items: page.links },
    { label: "Dropdown lists", items: page.selects },
    { label: "Checkboxes", items: page.checkboxes },
    { label: "Radio buttons", items: page.radios },
  ];

  for (const sec of sections) {
    if (sec.items.length === 0) continue;
    const names = sec.items.map(formatElementForPlanner).join(", ");
    lines.push(`${sec.label}: ${names}`);
  }

  return lines;
}

function formatElementForPlanner(e: PageElement): string {
  const parts = [`${e.role} "${e.name}"`];
  if (e.testId) parts.push(`[data-testid=${JSON.stringify(e.testId)}]`);
  if (e.placeholder && e.placeholder !== e.name) parts.push(`[placeholder=${JSON.stringify(e.placeholder)}]`);
  if (e.label && e.label !== e.name) parts.push(`[label=${JSON.stringify(e.label)}]`);
  if (e.href) parts.push(`[href=${JSON.stringify(e.href)}]`);
  if (e.inputType) parts.push(`[type=${JSON.stringify(e.inputType)}]`);
  if (e.enabled === false) parts.push("[disabled]");
  if (e.options?.length) parts.push(`[options=${e.options.map((o) => JSON.stringify(o)).join("|")}]`);
  return parts.join(" ");
}

export function formatPageContextForPlanner(pc: PageContext): string {
  const lines: string[] = [];

  if (pc.pages && pc.pages.length > 0) {
    lines.push(`PAGE CONTEXT (from ${pc.pages.length} inspected pages):`);
    lines.push("");

    for (const page of pc.pages) {
      lines.push(...formatPageSectionForPlanner(page));
      lines.push("");
    }

    return lines.join("\n");
  } else {
    lines.push(`PAGE CONTEXT (from actual UI inspection of ${pc.url}):`);
    lines.push("");
    lines.push(...formatPageSectionForPlanner(pc));
    lines.push("");

    let foundAny = false;
    if (pc.tables && pc.tables.length > 0) {
      foundAny = true;
      const tableDesc = pc.tables
        .map((t) => `table "${t.name || "unnamed"}" (${t.rowCount} rows, headers: ${t.headers.join(", ")})`)
        .join(", ");
      lines.push(`Tables: ${tableDesc}`);
    }

    if (pc.modals && pc.modals.length > 0) {
      foundAny = true;
      const modalDesc = pc.modals
        .map((m) => `${m.role} "${m.title || "untitled"}"`)
        .join(", ");
      lines.push(`Modals/Dialogs: ${modalDesc}`);
    }

    if (pc.toasts && pc.toasts.length > 0) {
      foundAny = true;
      const toastDesc = pc.toasts
        .map((t) => `${t.type || "notification"} "${t.message || "unnamed"}"`)
        .join(", ");
      lines.push(`Toast notifications: ${toastDesc}`);
    }

    if (pc.images && pc.images.length > 0) {
      foundAny = true;
      const imgDesc = pc.images.map((e) => `img "${e.name}"`).join(", ");
      lines.push(`Images: ${imgDesc}`);
    }

    if (pc.lists && pc.lists.length > 0) {
      foundAny = true;
      const listDesc = pc.lists.map((e) => `list "${e.name}"`).join(", ");
      lines.push(`Lists: ${listDesc}`);
    }

    if (pc.gridItems && pc.gridItems.length > 0) {
      foundAny = true;
      const gridDesc = pc.gridItems
        .slice(0, 10)
        .map((e) => `grid item "${e.name}"`)
        .join(", ");
      lines.push(`Grid items (first 10): ${gridDesc}${pc.gridItems.length > 10 ? ` (+${pc.gridItems.length - 10} more)` : ""}`);
    }

    if (pc.cards && pc.cards.length > 0) {
      foundAny = true;
      const cardDesc = pc.cards
        .slice(0, 10)
        .map((e) => `card "${e.name}"`)
        .join(", ");
      lines.push(`Cards (first 10): ${cardDesc}${pc.cards.length > 10 ? ` (+${pc.cards.length - 10} more)` : ""}`);
    }

    if (pc.tabs && pc.tabs.length > 0) {
      foundAny = true;
      const tabDesc = pc.tabs.map((e) => `tab "${e.name}"`).join(", ");
      lines.push(`Tabs: ${tabDesc}`);
    }

    if (pc.pagination && pc.pagination.length > 0) {
      foundAny = true;
      const paginationDesc = pc.pagination.map((e) => `pagination "${e.name}"`).join(", ");
      lines.push(`Pagination: ${paginationDesc}`);
    }

    if (!foundAny) {
      lines.push("(No interactive elements found on the page)");
    }

    return lines.join("\n");
  }
}
