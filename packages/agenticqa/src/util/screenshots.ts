/**
 * Turning screenshot file paths into `data:` URIs for the branded report.
 *
 * The report builder (`report/buildReportHtml.ts`) is deliberately **pure and fs-free** — that is what
 * lets it be render-tested by esbuilding it in isolation — and the published page runs under a CSP that
 * only allows `img-src data:`. So the filesystem work happens here, on the extension side, before the
 * builder is called. Extracted in G5.2 so it is testable without a VS Code host.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { RunSummary } from "../views/RunTreeProvider";

/** Skip anything larger than this: a webview choking on a 20 MB data URI helps nobody. */
export const MAX_SCREENSHOT_BYTES = 3_000_000;
/** Per step, so one pathological step can't inflate the whole report. */
export const MAX_SCREENSHOTS_PER_STEP = 3;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/**
 * Inline each step's screenshots as `data:` URIs. Returns a shallow copy; missing, unreadable or
 * oversized files are skipped rather than failing the report — a report without a picture is still a
 * report, and this runs after a test has already failed.
 */
export async function inlineScreenshots(summary: RunSummary): Promise<RunSummary> {
  const steps = summary.steps ?? [];
  if (!steps.some((s) => s.screenshots && s.screenshots.length)) {return summary;}

  const newSteps = await Promise.all(
    steps.map(async (s) => {
      if (!s.screenshots || !s.screenshots.length) {return s;}
      const inlined: string[] = [];
      for (const p of s.screenshots.slice(0, MAX_SCREENSHOTS_PER_STEP)) {
        if (p.startsWith("data:")) {
          inlined.push(p); // already inlined — don't re-read it off disk
          continue;
        }
        try {
          const buf = await fs.readFile(p);
          if (buf.length > MAX_SCREENSHOT_BYTES) {continue;}
          const mime = MIME_BY_EXT[path.extname(p).toLowerCase()] ?? "image/png";
          inlined.push(`data:${mime};base64,${buf.toString("base64")}`);
        } catch {
          // missing/unreadable — skip
        }
      }
      return { ...s, screenshots: inlined.length ? inlined : undefined };
    })
  );

  return { ...summary, steps: newSteps };
}
