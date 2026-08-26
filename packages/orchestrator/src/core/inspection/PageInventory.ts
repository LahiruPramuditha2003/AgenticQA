import type { PageContext, PageElement } from "../agent/types";
import type { RefItem } from "../utils/mcp-helpers";

export interface DomInventoryElement {
  role?: string;
  tagName: string;
  text?: string;
  accessibleName?: string;
  testId?: string;
  placeholder?: string;
  label?: string;
  href?: string;
  inputType?: string;
  visible?: boolean;
  enabled?: boolean;
  options?: string[];
}

function textOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed || undefined;
}

/** Extract the first top-level JSON array from text that may be wrapped — e.g. a `### Result` markdown
 *  header (or code fences) that some `@playwright/mcp` versions prepend to `browser_evaluate` output. */
export function extractJsonArray(text: string): any[] | null {
  const s = text.indexOf("[");
  const e = text.lastIndexOf("]");
  if (s < 0 || e <= s) return null;
  try {
    const parsed = JSON.parse(text.slice(s, e + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function extractDomInventory(
  mcp: any,
  logger?: { log: (msg: string) => void }
): Promise<DomInventoryElement[]> {
  try {
    const res = await mcp.callTool("browser_evaluate", {
      function: `() => {
        const labelFor = (el) => {
          if (el.id) {
            const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
            if (label) return label.textContent || '';
          }
          const wrapping = el.closest('label');
          return wrapping ? wrapping.textContent || '' : '';
        };
        const isVisible = (el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style && style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const nodes = Array.from(document.querySelectorAll('a,button,input,select,textarea,[data-testid],h1,h2,h3,h4,h5,h6,[role]'));
        return nodes.slice(0, 350).map((el) => ({
          role: el.getAttribute('role') || undefined,
          tagName: el.tagName.toLowerCase(),
          text: (el.textContent || '').replace(/\\s+/g, ' ').trim(),
          accessibleName: el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') || undefined,
          testId: el.getAttribute('data-testid') || undefined,
          placeholder: el.getAttribute('placeholder') || undefined,
          label: labelFor(el).replace(/\\s+/g, ' ').trim() || undefined,
          href: el.getAttribute('href') || undefined,
          inputType: el.getAttribute('type') || undefined,
          visible: isVisible(el),
          enabled: !el.disabled && el.getAttribute('aria-disabled') !== 'true',
          options: el.tagName.toLowerCase() === 'select'
            ? Array.from(el.querySelectorAll('option')).map((o) => (o.textContent || '').trim()).filter(Boolean)
            : undefined
        }));
      }`,
    });

    const payload = Array.isArray(res?.content)
      ? res.content.find((c: any) => Array.isArray(c?.json))?.json ?? res.content.find((c: any) => typeof c?.text === "string")?.text
      : res?.json ?? res?.text ?? res;

    if (Array.isArray(payload)) return payload as DomInventoryElement[];
    if (typeof payload === "string") {
      // The result may be wrapped (e.g. a "### Result" header / code fences) — extract the JSON array.
      const arr = extractJsonArray(payload);
      if (arr) return arr as DomInventoryElement[];
    }
  } catch (e: any) {
    logger?.log(`PageInventory: DOM inventory unavailable (${e?.message ?? String(e)})`);
  }

  return [];
}

function roleFromDom(el: DomInventoryElement): string {
  if (el.role) return el.role;
  if (el.tagName === "a") return "link";
  if (el.tagName === "button") return "button";
  if (el.tagName === "select") return "combobox";
  if (el.tagName === "textarea") return "textbox";
  if (el.tagName === "input") {
    if (el.inputType === "checkbox") return "checkbox";
    if (el.inputType === "radio") return "radio";
    if (el.inputType === "range") return "slider";
    return "textbox";
  }
  if (/^h[1-6]$/.test(el.tagName)) return "heading";
  return "generic";
}

function nameFromDom(el: DomInventoryElement): string | undefined {
  return textOrUndefined(el.accessibleName) ??
    textOrUndefined(el.label) ??
    textOrUndefined(el.placeholder) ??
    textOrUndefined(el.text) ??
    textOrUndefined(el.testId);
}

export function mergeDomInventoryIntoContext(
  pageContext: PageContext,
  domInventory: DomInventoryElement[]
): PageContext {
  pageContext.domElements = domInventory;

  const add = (bucket: PageElement[], el: DomInventoryElement) => {
    const role = roleFromDom(el);
    const name = nameFromDom(el);
    if (!name) return;
    const existing = bucket.find((item) =>
      item.role === role &&
      item.name === name &&
      item.testId === el.testId
    );
    if (existing) {
      existing.testId = existing.testId ?? el.testId;
      existing.placeholder = existing.placeholder ?? el.placeholder;
      existing.label = existing.label ?? el.label;
      existing.href = existing.href ?? el.href;
      existing.inputType = existing.inputType ?? el.inputType;
      existing.options = existing.options ?? el.options;
      existing.visible = existing.visible ?? el.visible;
      existing.enabled = existing.enabled ?? el.enabled;
      return;
    }
    bucket.push({
      role,
      name,
      testId: el.testId,
      placeholder: el.placeholder,
      label: el.label,
      href: el.href,
      inputType: el.inputType,
      options: el.options,
      visible: el.visible,
      enabled: el.enabled,
      pageUrl: pageContext.url,
    });
  };

  for (const el of domInventory) {
    const role = roleFromDom(el);
    // `searchbox` included — see FILLABLE_ROLES (defect D12).
    if (role === "textbox" || role === "searchbox" || role === "combobox" || role === "slider") {
      add(pageContext.inputs, el);
    }
    if (role === "button") add(pageContext.buttons, el);
    if (role === "link") add(pageContext.links, el);
    if (role === "heading") add(pageContext.headings, el);
    if (role === "checkbox") add(pageContext.checkboxes, el);
    if (role === "radio") add(pageContext.radios, el);
    if (role === "combobox") add(pageContext.selects, el);
  }

  return pageContext;
}

export function annotateRefsWithPage(refs: RefItem[], pageUrl: string): RefItem[] {
  return refs.map((ref) => ({ ...ref, pageUrl }));
}

/**
 * The page's real title: its most important heading.
 *
 * ⚠️ This used to be `headings[0]` — the first heading in DOM ORDER, ignoring rank. On any page whose
 * markup puts a sidebar before the main column that is the wrong element: demo-web's `/products`
 * renders `<h3>Filters</h3>` (the filter panel) at line 138 and the real `<h1>All Products</h1>` at
 * line 265, so every generated flow for that page was titled "Filters — page loads (/products)" and
 * asserted `expectVisible "Filters"`. A smoke test that checks a filter panel is not a smoke test for
 * the products page.
 *
 * Rank wins; DOM order only breaks ties. Headings with no reported level sort last, because an
 * unranked heading is weaker evidence than a declared `<h1>`.
 */
/**
 * Strip a trailing COUNT from a page heading (D29).
 *
 * demo-web renders `<h1>Shopping Cart ({totalItems} items)</h1>`. A crawl taken while the cart held 23
 * items baked `"Shopping Cart (23 items)"` into a generated flow assertion, an `assertionAlias` AND
 * `plannerGuidance` — so the flow failed the moment the count changed, which is precisely what an
 * add-to-cart test causes. A generated pack must assert what is STABLE about a page, not what was true
 * during one crawl.
 *
 * Deliberately conservative: only two shapes are removed, both unambiguous counts.
 *   • a trailing bracketed group containing a digit — `(23 items)`, `(12)`, `[3]`
 *   • a trailing separator followed by digits — `Orders - 5`, `Inbox — 12`
 *
 * NOT removed: leading or interior digits. `2024 Report` and `Section 3 Overview` are content, and a
 * generated pack that could not assert them would be worse than one that occasionally asserts a count.
 * If stripping would leave nothing meaningful, the original is kept — asserting something real beats
 * asserting nothing.
 */
export function stripVolatileCounts(raw: string): string {
  const TRAILING_BRACKET_WITH_DIGIT = /\s*[([{][^)\]}]*\d[^)\]}]*[)\]}]\s*$/;
  const TRAILING_SEPARATOR_NUMBER = /\s*[-–—·|:]\s*\d+\s*$/;

  let out = (raw ?? "").trim();
  // Loop: a heading can carry more than one, e.g. `Inbox (12) - 3`.
  for (let i = 0; i < 4; i++) {
    const before = out;
    out = out.replace(TRAILING_BRACKET_WITH_DIGIT, "").replace(TRAILING_SEPARATOR_NUMBER, "").trim();
    if (out === before) {break;}
  }
  return out.length >= 2 ? out : raw.trim();
}

/**
 * The page's title, chosen by heading RANK (D26) and stabilised against crawl-time counts (D29).
 *
 * Its single consumer is the crawler, which stores it as `RouteInfo.title` — from where it reaches flow
 * assertions, assertion aliases and planner guidance alike. Stabilising here rather than at each of those
 * three sites is why one fix covers all of them.
 */
export function pickPageTitle(headings: Array<{ name?: string; level?: number }>): string | undefined {
  let best: { name: string; level: number; order: number } | undefined;
  headings.forEach((h, order) => {
    const name = (h?.name ?? "").trim();
    if (!name) {return;}
    const level = Number.isFinite(h?.level) ? Number(h.level) : 99;
    if (!best || level < best.level) {best = { name, level, order };}
  });
  return best ? stripVolatileCounts(best.name) : undefined;
}
