/**
 * Pure helpers that turn a planned test step (or a Playwright `test.step` title) into a short,
 * human-readable description for the report + sidebar — e.g. `click "Add to Cart"`,
 * `fill Email = "a@b.com"`, `expect "Order Summary" visible`. No IO, fully unit-testable offline.
 *
 * Used by ReporterAgent to enrich each step in the RUN_SUMMARY so the VS Code tree shows meaningful
 * names instead of `plan-step-1`, `plan-step-2`, …
 */

function clip(s: unknown, max = 60): string {
  const str = String(s ?? "").replace(/\s+/g, " ").trim();
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

function quote(s: unknown, max = 60): string {
  return `"${clip(s, max)}"`;
}

/** Mask obvious secrets in field values so reports/logs don't leak passwords. */
function maskValue(field: unknown, value: unknown): string {
  const f = String(field ?? "").toLowerCase();
  if (/pass|secret|token|cvv|card/.test(f)) return "••••••";
  return clip(value, 40);
}

/**
 * `plan-step-7` → 7, `plan-tc1-step-7` → 7 (the 1-based step number **within its test case**);
 * null if it isn't a plan-step key.
 *
 * ⚠️ Display only — it is the number shown beside a step. To look a step up in the plan use
 * `parseStepKey`, which also returns the test case; conflating the two is defect D7.
 */
export function stepNumberFromKey(key: string | null | undefined): number | null {
  const m = String(key ?? "").match(/step-(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Best-effort description from a `test.step` title like `STEP_ID=plan-step-3 | click`.
 * Falls back to the raw key when no action is embedded.
 */
export function describeFromTitle(title: string | null | undefined, fallback = "step"): string {
  const t = String(title ?? "");
  const m = t.match(/\|\s*([a-zA-Z]+)\s*$/);
  if (m) return m[1];
  const key = t.match(/STEP_ID=([\w-]+)/);
  return key ? key[1] : (t.trim() || fallback);
}

/** Turn a planned step object into a concise human description. Robust to unknown shapes. */
export function describeStep(step: any): string {
  if (!step || typeof step !== "object") return "step";
  const a: string = String(step.action ?? "").trim();

  switch (a) {
    case "goto":
      return `goto ${clip(step.url, 50)}`;
    case "click":
      return `click ${quote(step.target)}`;
    case "fill":
      return `fill ${clip(step.field, 30)} = ${quote(maskValue(step.field, step.value), 42)}`;
    case "select":
      return `select ${quote(step.option, 30)} in ${clip(step.field, 30)}`;
    case "slider":
      return `set ${clip(step.field, 30)} = ${clip(step.value, 12)}`;
    case "check":
      return `check ${quote(step.target)}`;
    case "uncheck":
      return `uncheck ${quote(step.target)}`;
    case "hover":
      return `hover ${quote(step.target)}`;
    case "press":
      return step.target ? `press ${clip(step.key, 20)} on ${quote(step.target, 30)}` : `press ${clip(step.key, 20)}`;
    case "scroll":
      return `scroll ${clip(step.direction, 10)}`;
    case "screenshot":
      return "screenshot";
    case "evaluate":
      return "run script";
    case "setViewport":
      return `set viewport ${step.width}×${step.height}`;
    case "waitFor":
      return `wait ${step.timeout}ms`;
    case "waitForLoad":
      return "wait for load";
    case "expectVisible":
      return `expect ${quote(step.target)} visible`;
    case "expectNotVisible":
      return `expect ${quote(step.target)} hidden`;
    case "expectText": {
      const mode = step.mode ?? "contains";
      return `expect ${quote(step.target, 40)} ${mode} ${quote(step.text, 30)}`;
    }
    case "expectCount":
      return `expect ${step.count}× ${quote(step.target, 40)}`;
    case "expectAttribute":
      return `expect ${clip(step.attribute, 20)} of ${quote(step.target, 30)}`;
    case "expectUrl":
      return `expect URL ${step.mode ?? "contains"} ${quote(step.url, 40)}`;
    case "expectUrlContains":
      return `expect URL contains ${quote(step.value, 40)}`;
    case "measurePerformance":
      return `measure ${clip(step.metric, 10)} ≤ ${step.maxTimeMs}ms`;
    case "checkAccessibility":
      return "check accessibility";
    case "simulateApiError":
      return `simulate API error ${step.enable ? "on" : "off"}`;
    default: {
      const tgt = step.target ?? step.field ?? step.url ?? step.value ?? step.key ?? "";
      return tgt ? `${a || "step"} ${clip(tgt, 50)}` : (a || "step");
    }
  }
}
