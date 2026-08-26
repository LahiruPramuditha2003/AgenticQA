/**
 * Single source of truth for the per-step identifier shared between the generated Playwright spec
 * (the `STEP_ID=...` marker the executor parses) and the self-heal baseline `step_key` persisted by
 * `UiInspectorAgent`.
 *
 * These MUST agree for a given 0-based step index. If they drift, `SelfHealAgent` looks up the
 * baseline embedding under the wrong key, finds nothing, and silently heals nothing (this is exactly
 * the off-by-one that made self-heal a no-op before Phase 4 — see CONTRIBUTING.md F1). Keep
 * BOTH producers — codegen (`planToPlaywright.ts`) and the inspector baseline (`UiInspectorAgent.ts`)
 * — on these helpers; never re-derive the `plan-step-N` format anywhere else.
 */

/**
 * Stable step key for a step, e.g. index 0 of test case 0 → `"plan-step-1"`.
 *
 * ⚠️ **Defect D7: this used to ignore the test case entirely**, so a two-test-case plan gave *both* its
 * first steps the key `plan-step-1`. Everything downstream that looks a step up by key — self-heal's
 * baseline lookup, the reporter's step descriptions, and since G4 the locator and heal statistics — then
 * silently read the wrong test case's step. It never bit in practice only because the deterministic
 * planner emits exactly one test case; the LLM path can return several.
 *
 * Test case 0 keeps the historical `plan-step-N` **unchanged**, so every existing spec, DB baseline and
 * generated-code snapshot still matches byte for byte. Only the cases that were previously *ambiguous*
 * get a new shape.
 */
export function stepKeyForIndex(zeroBasedIndex: number, testCaseIndex = 0): string {
  const n = zeroBasedIndex + 1;
  return testCaseIndex > 0 ? `plan-tc${testCaseIndex}-step-${n}` : `plan-step-${n}`;
}

/** The `STEP_ID=` marker embedded in a generated `test.step()` title. */
export function stepIdMarker(zeroBasedIndex: number, testCaseIndex = 0): string {
  return `STEP_ID=${stepKeyForIndex(zeroBasedIndex, testCaseIndex)}`;
}

/** Recover `(testCaseIndex, zeroBasedStepIndex)` from a step key. `null` when it isn't one. */
export function parseStepKey(
  stepKey: string
): { testCaseIndex: number; stepIndex: number } | null {
  const m = /^plan-(?:tc(\d+)-)?step-(\d+)$/.exec(String(stepKey ?? "").trim());
  if (!m) {return null;}
  return { testCaseIndex: m[1] ? Number(m[1]) : 0, stepIndex: Number(m[2]) - 1 };
}

/**
 * The key under which `ctx.stepLocators` stores a resolved locator: `"<testCaseIndex>-<1-based step>"`.
 *
 * Formalised here for the same reason as `stepKeyForIndex`: it was being re-derived inline in
 * `UiInspectorAgent`, and anything that needs to read a locator back has to agree on the format.
 */
export function locatorKeyForIndex(testCaseIndex: number, zeroBasedIndex: number): string {
  return `${testCaseIndex}-${zeroBasedIndex + 1}`;
}

/** Recover the locator recorded for a step key. Exact, now that the key carries its test case (D7). */
export function findLocatorForStepKey(
  stepLocators: Record<string, string> | undefined,
  stepKey: string
): string | undefined {
  const parsed = parseStepKey(stepKey);
  if (!parsed || !stepLocators) {return undefined;}
  return stepLocators[locatorKeyForIndex(parsed.testCaseIndex, parsed.stepIndex)];
}
