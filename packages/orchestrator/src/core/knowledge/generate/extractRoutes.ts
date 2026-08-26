/**
 * Static route extraction for the knowledge-pack generator (N2.1). Pure (operates on file contents /
 * paths). Best-effort across the common frameworks; the live crawl (Crawler) is the ground truth for
 * element names — these routes seed the crawl + the pack's route hints.
 */

export interface ExtractedRoute {
  path: string;
  component?: string;
}

/** Normalize a router path: drop catch-alls, strip trailing `/*` and slashes, keep params (`:id`). */
function normalizePath(p: string): string | null {
  let s = (p ?? "").trim();
  if (!s || s === "*") {return null;}
  if (!s.startsWith("/")) {s = "/" + s;}
  s = s.replace(/\/\*+$/, ""); // strip a catch-all suffix like /account/*
  if (s.length > 1) {s = s.replace(/\/+$/, "");}
  return s.length ? s : "/";
}

/**
 * React Router (and Vue Router records): JSX `<Route path="/x" element={<Comp/>}/>` and object form
 * `{ path: "/x", element }`. Returns distinct, normalized routes (flat best-effort — nested relative
 * routes are emitted as-seen).
 */
export function extractReactRouterRoutes(source: string): ExtractedRoute[] {
  const out: ExtractedRoute[] = [];
  const seen = new Set<string>();
  const add = (p: string, component?: string) => {
    const path = normalizePath(p);
    if (path == null || seen.has(path)) {return;}
    seen.add(path);
    out.push(component ? { path, component } : { path });
  };

  // JSX: match each <Route ...> opening tag, then pull path + element component from its attribute text.
  // ([^>]*) stops at the first '>', which for `element={<Comp />}` still includes `<Comp` (the component).
  const tag = /<Route\b([^>]*)/g;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(source))) {
    const attrs = m[1];
    const pathM = attrs.match(/\bpath\s*=\s*["'`]([^"'`]+)["'`]/);
    if (!pathM) {continue;}
    const compM = attrs.match(/element\s*=\s*\{\s*<\s*([A-Za-z0-9_]+)/);
    add(pathM[1], compM ? compM[1] : undefined);
  }

  // Object form: path: "..."  (createBrowserRouter / route config arrays / vue-router records)
  const obj = /\bpath\s*:\s*["'`]([^"'`]+)["'`]/g;
  while ((m = obj.exec(source))) {add(m[1]);}

  return out;
}

/**
 * Next.js: derive routes from the app/ (`app/foo/page.tsx` → `/foo`) and pages/ (`pages/foo.tsx` → `/foo`,
 * `pages/index.tsx` → `/`) file trees. `[id]` → `:id`. Skips `_app`/`_document`/`api`.
 */
export function extractNextRoutes(filePaths: string[]): ExtractedRoute[] {
  const out: ExtractedRoute[] = [];
  const seen = new Set<string>();
  for (const f of filePaths ?? []) {
    const norm = f.replace(/\\/g, "/");
    let route: string | null = null;

    if (/(^|\/)app\//.test(norm) && /(^|\/)page\.(t|j)sx?$/.test(norm)) {
      const seg = norm.replace(/^(?:.*\/)?app\//, "").replace(/(^|\/)page\.(t|j)sx?$/, "");
      route = "/" + seg;
    } else if (
      /(^|\/)pages\//.test(norm) &&
      /\.(t|j)sx?$/.test(norm) &&
      !/(\/_app\.|\/_document\.|\/api\/)/.test(norm)
    ) {
      let seg = norm.replace(/^(?:.*\/)?pages\//, "").replace(/\.(t|j)sx?$/, "");
      seg = seg.replace(/\/index$/, "").replace(/^index$/, "");
      route = "/" + seg;
    }

    if (route == null) {continue;}
    route = route.replace(/\[\.\.\.([^\]]+)\]/g, ":$1*").replace(/\[([^\]]+)\]/g, ":$1"); // [id] → :id
    route = route.length > 1 ? route.replace(/\/+$/, "") : route;
    if (route === "") {route = "/";}
    if (!seen.has(route)) {
      seen.add(route);
      out.push({ path: route });
    }
  }
  return out;
}

/** Framework-dispatched route extraction. */
export function extractRoutes(opts: {
  framework: string;
  sources?: Array<{ path: string; content: string }>;
  filePaths?: string[];
}): ExtractedRoute[] {
  if (opts.framework === "next") {return extractNextRoutes(opts.filePaths ?? []);}

  const all: ExtractedRoute[] = [];
  for (const s of opts.sources ?? []) {all.push(...extractReactRouterRoutes(s.content));}

  const seen = new Set<string>();
  return all.filter((r) => (seen.has(r.path) ? false : (seen.add(r.path), true)));
}
