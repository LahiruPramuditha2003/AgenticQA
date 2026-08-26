/**
 * Bounded, same-origin BFS crawler for the Exploratory testing agent (S3.1).
 *
 * Reuses the existing inspection toolchain (MCP snapshot → refs → `buildPageContext`, plus the DOM
 * inventory for hrefs) to map a site's PUBLIC routes into a `SiteMap`. The pure URL helpers are
 * unit-tested offline; the live `crawlSite` (which drives the MCP browser) is owner-validated.
 */

import type { PageContext, PageElement } from "../agent/types";
import { waitForPageStable, buildPageContext } from "../utils/mcp-helpers";
import {
  extractDomInventory,
  mergeDomInventoryIntoContext,
  pickPageTitle,
} from "../inspection/PageInventory";

export interface SiteRoute {
  url: string;
  path: string;
  /** Dedup key — numeric/hash id segments collapsed (e.g. /products/5 → /products/:id). */
  routeKey: string;
  /** First heading on the page (its de-facto title). */
  title?: string;
  inputs: PageElement[];
  buttons: PageElement[];
  links: PageElement[];
  headings: PageElement[];
  /**
   * Checkboxes and radios.
   *
   * ⚠️ These were **not captured at all** until 2026-08-11, so no generated flow could ever tick a box —
   * `synthesizeFlows` only ever saw `inputs` (the fillable roles). TaskFlow's "tick the Bug and
   * Documentation label checkboxes" prompt therefore had no flow that could satisfy it, and the gap looked
   * like a synthesis limitation when it was really a crawl one.
   */
  checkboxes: PageElement[];
}

export interface SiteMap {
  startUrl: string;
  routes: SiteRoute[];
}

/** Resolve an href against a base; return the absolute URL string, or null if invalid, non-navigational
 *  (#, mailto:, tel:, javascript:, data:), or cross-origin. The hash is stripped. */
export function resolveSameOriginUrl(href: string, baseUrl: string): string | null {
  const h = (href ?? "").trim();
  if (!h || h.startsWith("#") || /^(mailto:|tel:|javascript:|data:)/i.test(h)) return null;
  try {
    const base = new URL(baseUrl);
    const u = new URL(h, baseUrl);
    if (u.origin !== base.origin) return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

/** Dedup key for a route: pathname with numeric / long-hex segments collapsed to ":id", lower-cased,
 *  trailing slash trimmed. So /products/1 and /products/5 share one key (we map a representative, not
 *  every product detail page). */
export function routeKeyForPath(pathname: string): string {
  const segs = (pathname || "/")
    .split("/")
    .filter(Boolean)
    .map((s) => (/^\d+$/.test(s) || /^[0-9a-f]{8,}$/i.test(s) ? ":id" : s.toLowerCase()));
  return "/" + segs.join("/");
}

export function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** Distinct same-origin link URLs (absolute) from a page's DOM inventory. */
export function collectLinkUrls(
  domElements: Array<{ tagName?: string; href?: string }> | undefined,
  baseUrl: string
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const el of domElements ?? []) {
    if (el.tagName !== "a" || !el.href) continue;
    const abs = resolveSameOriginUrl(el.href, baseUrl);
    if (abs && !seen.has(abs)) {
      seen.add(abs);
      out.push(abs);
    }
  }
  return out;
}

/** Same-origin link URLs from the MCP accessibility snapshot's `- /url: <path>` lines. Snapshot-native
 *  (no `browser_evaluate`), so link discovery works even when the DOM inventory can't be parsed. */
export function collectSnapshotLinkUrls(snapshotText: string, baseUrl: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of (snapshotText ?? "").split(/\r?\n/)) {
    const m = line.match(/\/url:\s*(\S+)/);
    if (!m) continue;
    const abs = resolveSameOriginUrl(m[1], baseUrl);
    if (abs && !seen.has(abs)) {
      seen.add(abs);
      out.push(abs);
    }
  }
  return out;
}

/** Pair each snapshot link with its `/url:` child, e.g. `- link "Products" […]` → `- /url: /products`.
 *  Used to annotate link hrefs (for nav-flow synthesis) without relying on the DOM inventory. */
export function parseSnapshotLinkHrefs(snapshotText: string): Array<{ name: string; url: string }> {
  const out: Array<{ name: string; url: string }> = [];
  let lastLink: string | null = null;
  for (const line of (snapshotText ?? "").split(/\r?\n/)) {
    const lm = line.match(/-\s*link\s+"([^"]*)"/);
    if (lm) {
      lastLink = lm[1];
      continue;
    }
    const um = line.match(/\/url:\s*(\S+)/);
    if (um && lastLink != null) {
      out.push({ name: lastLink, url: um[1] });
      lastLink = null;
    }
  }
  return out;
}

/**
 * Crawl the app breadth-first from `startUrl`, bounded by `maxPages` / `maxDepth`, staying same-origin
 * and visiting one representative per `routeKey`. Returns a `SiteMap` of mapped routes + their elements.
 * Failures on individual pages are logged and skipped (best-effort).
 */
export async function crawlSite(opts: {
  mcp: any;
  startUrl: string;
  baseUrl: string;
  maxPages?: number;
  maxDepth?: number;
  /** Extra same-origin URLs to seed the frontier at depth 0 (e.g. routes parsed from source). The crawler
   *  still de-dups by routeKey, so seeding a route already reachable by link is harmless. */
  seedUrls?: string[];
  logger: { log: (m: string) => void };
}): Promise<SiteMap> {
  const { mcp, startUrl, baseUrl, logger } = opts;
  const maxPages = opts.maxPages ?? 8;
  const maxDepth = opts.maxDepth ?? 2;

  const routes: SiteRoute[] = [];
  const visited = new Set<string>();
  const frontier: Array<{ url: string; depth: number }> = [{ url: startUrl, depth: 0 }];
  for (const seed of opts.seedUrls ?? []) {
    const abs = resolveSameOriginUrl(seed, baseUrl);
    if (abs) frontier.push({ url: abs, depth: 0 });
  }

  const keyOf = (u: string) => routeKeyForPath(pathOf(u));

  while (frontier.length && routes.length < maxPages) {
    const { url, depth } = frontier.shift()!;
    const key = keyOf(url);
    if (visited.has(key)) continue;
    visited.add(key);

    try {
      await mcp.callTool("browser_navigate", { url });
      const { snapshotText, refs } = await waitForPageStable(mcp, logger, { label: "Explore" });
      const pc: PageContext = buildPageContext(url, refs, snapshotText);
      const dom = await extractDomInventory(mcp, logger);
      mergeDomInventoryIntoContext(pc, dom);

      // Annotate link hrefs from the snapshot (robust even when the DOM inventory is unavailable) so
      // nav-flow synthesis can resolve destinations.
      const linkHrefs = parseSnapshotLinkHrefs(snapshotText);
      for (const link of pc.links) {
        if (!link.href) {
          const match = linkHrefs.find((l) => l.name === link.name);
          if (match) link.href = match.url;
        }
      }

      routes.push({
        url,
        path: pathOf(url),
        routeKey: key,
        title: pickPageTitle(pc.headings),
        inputs: pc.inputs,
        buttons: pc.buttons,
        checkboxes: [...(pc.checkboxes ?? []), ...(pc.radios ?? [])],
        links: pc.links,
        headings: pc.headings,
      });
      logger.log(
        `Explore: mapped ${key} — ${pc.inputs.length} input(s), ${(pc.checkboxes ?? []).length} checkbox(es), ` +
          `${pc.buttons.length} button(s), ${pc.links.length} link(s)`
      );

      if (depth < maxDepth) {
        // Discover next routes from BOTH the DOM inventory and the snapshot's `/url:` lines — the
        // snapshot is always present even if browser_evaluate output can't be parsed.
        const nextUrls = new Set<string>([
          ...collectLinkUrls(pc.domElements, baseUrl),
          ...collectSnapshotLinkUrls(snapshotText, baseUrl),
        ]);
        for (const next of nextUrls) {
          const nk = keyOf(next);
          if (!visited.has(nk) && !frontier.some((f) => keyOf(f.url) === nk)) {
            frontier.push({ url: next, depth: depth + 1 });
          }
        }
      }
    } catch (e: any) {
      logger.log(`Explore: failed to map ${url} — ${e?.message ?? String(e)}`);
    }
  }

  logger.log(`Explore: crawl complete — ${routes.length} route(s) mapped`);
  return { startUrl, routes };
}
