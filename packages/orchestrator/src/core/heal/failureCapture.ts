/**
 * Self-heal failure capture (Phase 5). Instead of re-reaching the failed state by replaying steps
 * (fragile, and impossible in run_only without a plan), we capture the page's accessibility snapshot
 * at the exact moment of failure: copy the failed spec to a throwaway temp file with an appended
 * `test.afterEach` that writes an `ariaSnapshot()` on failure, run just that file on one browser, and
 * read the snapshot back. The committed spec is never modified.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { runPlaywright } from "../../executor";
import { parseAriaSnapshot } from "../utils/healing";

export interface FailureCapture {
  url: string;
  title: string;
  refs: Array<{ role: string; name: string }>;
}

/**
 * Pure: the original spec text + a prepended `fs` import + an appended `test.afterEach` that, on a
 * non-passing test, writes `{ url, title, aria }` to `captureAbsPath`. The original test bodies are
 * re-emitted unchanged. `captureAbsPath` is embedded as a JSON string literal (so Windows backslashes
 * are escaped correctly).
 */
export function buildHealCaptureSpec(
  originalSpecText: string,
  captureAbsPath: string
): string {
  const jsonPath = JSON.stringify(captureAbsPath);
  return (
    `import * as __healFs from 'node:fs';\n` +
    originalSpecText.trimEnd() +
    `\n\n/* ── AgenticQA self-heal capture (temporary, auto-generated) ── */\n` +
    `test.afterEach(async ({ page }, testInfo) => {\n` +
    `  if (testInfo.status === 'passed') return;\n` +
    `  try {\n` +
    `    const aria = await page.locator('body').ariaSnapshot();\n` +
    `    __healFs.writeFileSync(${jsonPath}, JSON.stringify({ url: page.url(), title: testInfo.title, aria }));\n` +
    `  } catch {}\n` +
    `});\n`
  );
}

/** Shared prefix for all heal capture temp artifacts (temp spec + capture json). */
export const HEAL_TEMP_PREFIX = "__agenticqa_heal_";

/** Deterministic temp-file base name for a heal capture run (unique per call). */
export function healTempBase(rand: string = crypto.randomBytes(4).toString("hex")): string {
  return `${HEAL_TEMP_PREFIX}${rand}`;
}

/** Best-effort sweep of any heal temp artifacts left in a dir by a crashed prior run. */
async function sweepStaleHealFiles(dirAbs: string): Promise<void> {
  try {
    const entries = await fs.readdir(dirAbs);
    await Promise.all(
      entries
        .filter((f) => f.startsWith(HEAL_TEMP_PREFIX))
        .map((f) => fs.rm(path.join(dirAbs, f), { force: true }).catch(() => {}))
    );
  } catch {
    /* dir unreadable — nothing to sweep */
  }
}

/**
 * Run the failed spec once (single browser, no json/html reporter so the real report is untouched)
 * with the capture hook, and return the failed-state snapshot. Returns null if no capture was
 * produced (e.g. the temp run unexpectedly passed, or the hook failed). Always cleans up the temp
 * spec + capture file.
 */
export async function captureFailureState(opts: {
  workspacePath: string;
  testRelPath: string;
  project?: string;
}): Promise<FailureCapture | null> {
  const project = opts.project ?? "chromium";
  const specAbs = path.join(opts.workspacePath, opts.testRelPath);
  const testDirAbs = path.dirname(specAbs);
  const base = healTempBase();
  const tempAbs = path.join(testDirAbs, `${base}.spec.ts`);
  const captureAbs = path.join(testDirAbs, `${base}.capture.json`);
  const tempRel = path.relative(opts.workspacePath, tempAbs).replace(/\\/g, "/");

  try {
    // Clear any leftovers from a crashed prior heal so a normal run never picks one up.
    await sweepStaleHealFiles(testDirAbs);

    const original = await fs.readFile(specAbs, "utf8");
    await fs.writeFile(tempAbs, buildHealCaptureSpec(original, captureAbs), "utf8");

    // We don't care about the exit code — the spec is expected to fail; we only want the capture.
    //
    // ⚠️ `reporter: "list"` is NOT enough on its own, and the comment here used to claim it was.
    // Playwright clears its **output directory** at the start of every run, and `agenticqa-results.json`
    // lives inside `test-results/` — so this throwaway run deleted the real failure's report. When the
    // heal then found no replacement (no patched re-run to regenerate it), the benchmark read nothing and
    // reported the opaque `no-report` instead of the `locator-not-found` that had actually happened.
    // Its own `--output` directory keeps the two runs from touching each other's artifacts.
    await runPlaywright(opts.workspacePath, tempRel, {
      project,
      reporter: "list",
      outputDir: "test-results/agenticqa-heal-capture",
    }).catch(() => undefined);

    let raw: string;
    try {
      raw = await fs.readFile(captureAbs, "utf8");
    } catch {
      return null;
    }

    const json = JSON.parse(raw);
    return {
      url: String(json.url ?? ""),
      title: String(json.title ?? ""),
      refs: parseAriaSnapshot(String(json.aria ?? "")),
    };
  } catch {
    return null;
  } finally {
    await fs.rm(tempAbs, { force: true }).catch(() => {});
    await fs.rm(captureAbs, { force: true }).catch(() => {});
  }
}
