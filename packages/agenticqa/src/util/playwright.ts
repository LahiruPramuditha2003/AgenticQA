/**
 * Is Playwright ready to actually run a test? (R2.7 follow-up.)
 *
 * WHY THIS EXISTS
 * ---------------
 * Doctor already checked that the `playwright` PACKAGE is present. That is not the same question, and the
 * difference is the most likely first-run failure for a new user: `npm i -D @playwright/test` installs the
 * package but downloads no browsers, so everything looks configured until a run dies with
 *
 *     browserType.launch: Executable doesn't exist at …\chromium_headless_shell-1234\…
 *
 * buried in the output panel. It is also easy to hit *after* a working setup — bumping Playwright changes
 * the required browser build, so a project that ran yesterday stops running today.
 *
 * HOW IT CHECKS
 * -------------
 * By asking Playwright, not by guessing. `npx playwright install --dry-run` prints the exact directory it
 * expects each browser in, for the version resolved *in that workspace*:
 *
 *     Chrome for Testing 151.0.7922.34 (playwright chromium v1234)
 *       Install location:    C:\Users\me\AppData\Local\ms-playwright\chromium-1234
 *
 * Hardcoding the platform cache paths (`~/.cache/ms-playwright`, `~/Library/Caches/…`, `%LOCALAPPDATA%\…`)
 * would be both platform-specific and version-blind — it could not tell "chromium is installed" from
 * "the *right* chromium is installed", which is exactly the case that bites people on an upgrade.
 */

/** One browser Playwright expects, and where. */
export interface ExpectedBrowser {
  /** e.g. `"Chrome for Testing 151.0.7922.34 (playwright chromium v1234)"` */
  name: string;
  /** Absolute directory Playwright will look in. */
  location: string;
}

/**
 * Parse `playwright install --dry-run` output into the browsers it expects.
 *
 * Pure, so it is unit-tested against real captured output rather than being exercised only by running
 * Playwright — which is slow, and unavailable in CI without a download.
 */
export function parseExpectedBrowsers(dryRunOutput: string): ExpectedBrowser[] {
  const out: ExpectedBrowser[] = [];
  const lines = (dryRunOutput ?? "").split(/\r?\n/);
  let pendingName: string | undefined;

  for (const raw of lines) {
    const line = raw.trimEnd();
    const loc = line.match(/^\s*Install location:\s*(.+?)\s*$/);
    if (loc) {
      // A location with no preceding header would be meaningless to report, so it is skipped rather
      // than attributed to whatever came before.
      if (pendingName) {
        out.push({ name: pendingName, location: loc[1] });
        pendingName = undefined;
      }
      continue;
    }
    // A header is a non-indented, non-empty line that is not one of the URL rows.
    if (line && !/^\s/.test(line) && !/^(Download|Failed|Playwright)/i.test(line)) {
      pendingName = line.trim();
    }
  }
  return out;
}

export interface BrowserCheckResult {
  /** True when every expected browser directory is present. */
  ok: boolean;
  expected: ExpectedBrowser[];
  /** Expected but absent — these are what `npx playwright install` would download. */
  missing: ExpectedBrowser[];
  /** Set when the check itself could not run (Playwright absent, npx failed, timeout). */
  error?: string;
}

export interface BrowserCheckDeps {
  /** Run `playwright install --dry-run` in the workspace; return its combined output, or undefined. */
  dryRun: () => Promise<string | undefined>;
  exists: (p: string) => Promise<boolean>;
}

/**
 * Check whether the browsers Playwright expects are actually on disk.
 *
 * An inconclusive result is reported as `error`, never as "missing". Telling somebody to download
 * browsers they already have — because a `npx` invocation timed out on a slow machine — wastes their
 * time and teaches them to ignore Doctor.
 */
export async function checkPlaywrightBrowsers(deps: BrowserCheckDeps): Promise<BrowserCheckResult> {
  let output: string | undefined;
  try {
    output = await deps.dryRun();
  } catch (e: any) {
    return { ok: false, expected: [], missing: [], error: e?.message ?? String(e) };
  }
  if (!output) {
    return { ok: false, expected: [], missing: [], error: "could not run `playwright install --dry-run`" };
  }

  const expected = parseExpectedBrowsers(output);
  if (expected.length === 0) {
    return { ok: false, expected, missing: [], error: "no browsers reported by Playwright" };
  }

  const missing: ExpectedBrowser[] = [];
  for (const b of expected) {
    if (!(await deps.exists(b.location))) {
      missing.push(b);
    }
  }
  return { ok: missing.length === 0, expected, missing };
}

/** One-line Doctor detail for a browser check. */
export function describeBrowserCheck(result: BrowserCheckResult): string {
  if (result.error) {
    return `Could not verify browsers (${result.error})`;
  }
  if (result.ok) {
    return `${result.expected.length} browser build(s) installed`;
  }
  const names = result.missing.map((m) => m.name.replace(/\s*\(.*\)\s*$/, "")).join(", ");
  return `Missing: ${names} — run \`npx playwright install\` in this workspace`;
}
