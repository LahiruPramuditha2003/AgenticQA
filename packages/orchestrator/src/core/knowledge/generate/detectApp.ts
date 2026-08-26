/**
 * Code-accessible app detection for the knowledge-pack generator (N2.1).
 *
 * "Code-accessible" = the app's source is in the workspace (a package.json with a known web framework +
 * source files), as opposed to a hosted-only URL with no code. When code is accessible we can read routes
 * + seed credentials from source; otherwise the planner stays purely page-grounded (no pack).
 *
 * Pure module (no fs): callers pass a file listing + the relevant package.json content. The agent does the
 * actual workspace reads (N2.3). Offline-testable.
 */

export type Framework = "react-router" | "next" | "vue-router" | "unknown";

export interface DetectedApp {
  /** True when source + a known framework are present → worth generating a pack. */
  isCodeAccessible: boolean;
  framework: Framework;
  /** Files likely to declare routes (read these, then run extractRoutes). */
  routeFileCandidates: string[];
  /** Files likely to hold seed/test credentials (read these, then run extractCredentials). */
  credentialFileCandidates: string[];
  reason: string;
}

const ROUTE_FILE_HINTS: RegExp[] = [
  /(^|\/)app\.(t|j)sx?$/i,
  /(^|\/)routes?\.(t|j)sx?$/i,
  /(^|\/)router(\/index)?\.(t|j)sx?$/i,
  /(^|\/)main\.(t|j)sx?$/i,
  /(^|\/)index\.(t|j)sx?$/i,
];

const CRED_FILE_HINTS: RegExp[] = [
  /mock/i,
  /seed/i,
  /fixture/i,
  /(^|\/)data\//i,
  /users?\.(t|j)s$/i,
  /\.env\.example$/i,
  /login\.(t|j)sx?$/i,
  /(^|\/)auth\//i,
];

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

function depsOf(pkgJson: string | undefined): Record<string, string> {
  if (!pkgJson) {return {};}
  try {
    const j = JSON.parse(pkgJson);
    return { ...(j.dependencies ?? {}), ...(j.devDependencies ?? {}) };
  } catch {
    return {};
  }
}

/** Identify the routing framework from a package.json's dependencies. */
export function detectFramework(pkgJson: string | undefined): Framework {
  const d = depsOf(pkgJson);
  if (d["next"]) {return "next";}
  if (d["react-router-dom"] || d["react-router"]) {return "react-router";}
  if (d["vue-router"]) {return "vue-router";}
  return "unknown";
}

/** Decide whether an app is code-accessible and surface the files worth reading. */
export function detectAppFromListing(opts: {
  packageJson?: string;
  files: string[];
}): DetectedApp {
  const framework = detectFramework(opts.packageJson);
  const files = (opts.files ?? []).filter(
    (f) => !/(^|\/)(node_modules|dist|build|\.git)(\/|$)/.test(f.replace(/\\/g, "/"))
  );
  const sourceFiles = files.filter((f) => /\.(t|j)sx?$/.test(f));
  const hasSource = sourceFiles.length > 0;
  const isCodeAccessible = framework !== "unknown" && hasSource;

  const routeFileCandidates = files.filter((f) =>
    ROUTE_FILE_HINTS.some((re) => re.test(f.replace(/\\/g, "/")))
  );
  if (framework === "next") {
    // Next.js encodes routes in the app/ + pages/ file tree itself.
    for (const f of files) {
      const n = f.replace(/\\/g, "/");
      if (/(^|\/)(app|pages)\//.test(n) && /\.(t|j)sx?$/.test(n)) {routeFileCandidates.push(f);}
    }
  }

  const credentialFileCandidates = files.filter((f) =>
    CRED_FILE_HINTS.some((re) => re.test(f.replace(/\\/g, "/")))
  );

  const reason = isCodeAccessible
    ? `Detected ${framework} app with ${sourceFiles.length} source file(s).`
    : framework === "unknown"
      ? "No known web framework in package.json — hosted-only (planner stays page-grounded)."
      : "No source files found.";

  return {
    isCodeAccessible,
    framework,
    routeFileCandidates: dedupe(routeFileCandidates),
    credentialFileCandidates: dedupe(credentialFileCandidates),
    reason,
  };
}
