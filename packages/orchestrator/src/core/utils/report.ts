/**
 * Pure helpers for turning a Playwright JSON report into orchestrator step results + a failure
 * class. Kept free of fs/IO so they're unit-testable offline. Mirrors the heuristics in the
 * benchmark harness (`scripts/summarizeTemplateResults.js`).
 */

import type { StepResultInfo } from "../agent/types";

export type FailureClass =
  | "locator-not-found"
  | "strict-mode"
  | "assertion-mismatch"
  | "navigation-timeout"
  | "state-precondition"
  | "unsupported-scenario"
  | "unknown";

/** Best-effort classification of a Playwright failure message into an actionable bucket. */
export function classifyFailure(text: string | undefined | null): FailureClass {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return "unknown";
  if (t.includes("strict mode violation")) return "strict-mode";
  if (t.includes("element(s) not found") || (t.includes("waiting for") && t.includes("getby"))) {
    return "locator-not-found";
  }
  if (t.includes("tohaveurl") || (t.includes("expected") && t.includes("received"))) {
    return "assertion-mismatch";
  }
  if (t.includes("timeout") || t.includes("timed out")) return "navigation-timeout";
  if (t.includes("no baseline")) return "state-precondition";
  if (t.includes("unsupported")) return "unsupported-scenario";
  return "unknown";
}

/**
 * Merge step results across browser projects. Playwright runs the same spec once per project, so a
 * 5-browser run yields 5 step lists with identical STEP_IDs. Dedup by stepKey, preserving first
 * occurrence order, and let a FAILED status win — so a failure in any browser (not just the first)
 * is surfaced instead of being hidden behind chromium's pass.
 */
export function mergeStepResults(perTest: StepResultInfo[][]): StepResultInfo[] {
  const byKey = new Map<string, StepResultInfo>();
  const order: string[] = [];
  let anon = 0;
  for (const steps of perTest) {
    for (const sr of steps) {
      const key = sr.stepKey ?? `__anon-${anon++}`;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, sr);
        order.push(key);
      } else if (existing.status === "passed" && sr.status === "failed") {
        byKey.set(key, sr);
      }
    }
  }
  return order.map((k) => byKey.get(k)!);
}

/** One spec file's parsed step-result lists, one per browser project. */
export interface FileStepGroup {
  /** The spec file as named in the Playwright JSON report (a basename). */
  file: string;
  perTest: StepResultInfo[][];
}

/**
 * Group-by-file wrapper around `mergeStepResults`: merges cross-browser results **within each spec
 * file** and tags each failed step with its owning file. Needed for a "Run All" run_only, where every
 * generated spec independently uses `plan-step-1..N` — a single global merge would collide identical
 * keys across files (and a healed step would target the wrong / no spec). A single-file run collapses
 * to exactly the previous `mergeStepResults` behavior.
 */
export function mergeStepResultsByFile(groups: FileStepGroup[]): {
  stepResults: StepResultInfo[];
  failedSteps: Array<{ stepKey: string; file: string }>;
} {
  const stepResults: StepResultInfo[] = [];
  const failedSteps: Array<{ stepKey: string; file: string }> = [];
  for (const g of groups) {
    for (const sr of mergeStepResults(g.perTest)) {
      stepResults.push(sr);
      if (sr.status === "failed" && sr.stepKey) {
        failedSteps.push({ stepKey: sr.stepKey, file: g.file });
      }
    }
  }
  return { stepResults, failedSteps };
}

/** A Playwright result attachment (subset of fields we use). */
export interface AttachmentLike {
  name?: string;
  contentType?: string;
  path?: string;
}

/** Image attachment paths from a Playwright result's `attachments` (screenshots, by content-type/name/ext). */
export function extractScreenshotPaths(attachments: AttachmentLike[] | undefined): string[] {
  return (attachments ?? [])
    .filter(
      (a) =>
        !!a?.path &&
        (/^image\//.test(a.contentType ?? "") ||
          /screenshot/i.test(a.name ?? "") ||
          /\.(png|jpe?g|webp)$/i.test(a.path ?? ""))
    )
    .map((a) => a.path as string);
}

/**
 * Attach result-level screenshots to the relevant step. Playwright records screenshots at the test-result
 * level (e.g. `test-failed-1.png` on failure), not per `test.step`, so we bind them to the failed step (the
 * failure state) — or the last step when nothing failed. Mutates `steps` in place.
 */
export function attachScreenshotsToSteps(
  steps: StepResultInfo[],
  attachments: AttachmentLike[] | undefined
): void {
  const shots = extractScreenshotPaths(attachments);
  if (shots.length === 0 || steps.length === 0) {return;}
  const target = steps.find((s) => s.status === "failed") ?? steps[steps.length - 1];
  target.screenshots = [...(target.screenshots ?? []), ...shots];
}

/** One persisted/synthesized healing attempt row. */
export interface HealAttemptRow {
  failedStepId: string | null;
  oldLocator: string | null;
  newLocator: string | null;
  succeeded: boolean;
}

/**
 * Collapse healing attempts to **one row per failed step**. The DB records two `healing_attempt` rows
 * per step (a pre-rerun `succeeded:false` and a post-rerun outcome), which otherwise inflates the heal
 * count (the cosmetic "1/2 succeeded"). Success wins, so a step that ultimately healed counts once as a
 * success. Rows without a `failedStepId` pass through untouched.
 */
export function dedupeHealAttempts<T extends HealAttemptRow>(rows: T[]): T[] {
  const byStep = new Map<string, T>();
  const noId: T[] = [];
  for (const r of rows) {
    if (!r.failedStepId) {
      noId.push(r);
      continue;
    }
    const prev = byStep.get(r.failedStepId);
    if (!prev || (!prev.succeeded && r.succeeded)) byStep.set(r.failedStepId, r);
  }
  return [...byStep.values(), ...noId];
}
