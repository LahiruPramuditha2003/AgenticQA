# SelfHealAgent

Repairs broken **locators** in a generated/existing Playwright spec after a run fails, then the
pipeline (`runPipeline.healIfNeeded`) re-runs the patched file(s). Healing only ever engages *after*
a genuine failure — the passing path is never touched, and the generated spec is never modified to
support healing.

## When it runs

`healIfNeeded` invokes it whenever `playwrightExitCode !== 0`. The agent's gate then proceeds only for
**locator-style** failures: `ctx.failureClass` ∈ {`locator-not-found`, `strict-mode`}, falling back to
a text scan (`looksLikeLocatorNotFound`) when the class is absent. Assertion/logic mismatches are not
healed; the agent records `ctx.healingSkipReason` (surfaced in the report).

## How it reaches the failed state — capture, don't replay

The crux of self-heal is re-grounding against the page **in the exact state where it failed**. Rather
than try to *re-reach* that state by replaying steps (fragile, and impossible in `run_only` without a
plan), the agent **captures it**:

- `core/heal/failureCapture.ts` `captureFailureState()` copies the failed spec to a throwaway temp
  file (`__agenticqa_heal_*`) with an appended `test.afterEach` that, on failure, writes the page's
  `ariaSnapshot()` + URL; runs **just that file on chromium** (`reporter:"list"` so the real report
  isn't clobbered); reads + `parseAriaSnapshot`s the result into `{role, name}` candidate refs; and
  cleans up the temp spec + capture in a `finally` (plus a stale-file sweep on the next run).
- The test run naturally navigated to the right page+state, so the capture has the real failed DOM —
  works identically in `run_only` and generate-and-run, with **no MCP browser in the heal path**.

## Two strategies (from the same captured snapshot)

`vectorMode = ctx.dbEnabled && ctx.projectId && ctx.testRunId && embedder.isConfigured()`.

1. **Deterministic re-grounding — primary, no DB.** `chooseHealReplacement(captureRefs, action,
   intendedName, baselineRole)` role-aware fuzzy-matches the step's **intended name** (exact →
   substring → token-overlap), then `synthesizeLocator(role, name)` builds the new locator
   (`getByRole(role,{name}).first()`, or `getByText`). The intended name comes from the plan step
   (`intendedTargetForStep`) or, run_only/no-plan, the spec's current locator
   (`findLocatorExprInStepBlock` → `extractTargetFromLocatorExpr`, which **humanizes testids** so
   `add-to-cart-x` → "add to cart x").
2. **Vector + LLM rerank — enhancement, DB on.** Embeds the captured candidates (with synthesized
   locators) as `element_observation` rows, vector-searches the baseline `element_signature`, and
   optionally LLM-reranks the top-5 (`rerankedNearestObservation`). Falls back to strategy 1 when no
   baseline/observation is found.

DB writes (observations, `healing_attempt`, baseline promotion) only happen when `ctx.testRunId` is
set; with the DB off the deterministic path still patches + re-runs, and `ReporterAgent` synthesizes
heal status from `ctx.healResults`.

## Assertion heal-and-flag policy

`click`/`fill`/`select`/… locators heal silently. For assertion actions (`isAssertionAction`:
`expectVisible`/`expectText`/`expectCount`/…) the target is re-pointed but **flagged**
(`HealResult.assertionRetargeted` → `RUN_SUMMARY.assertionsRetargeted` + a "⚠ assertion target
re-pointed — verify rename vs regression" note in the report), so a real content regression isn't
silently masked.

## Invariants & gotchas

- **Step-key parity:** the failed step's runtime `STEP_ID` and the baseline `step_key` must match —
  both producers go through `core/utils/stepKeys.ts` (an off-by-one here once made heal a no-op).
- **Pure helpers** live in `core/utils/healing.ts` (file-text patch/parse/extract, `parseAriaSnapshot`,
  `synthesizeLocator`, `isAssertionAction`) and `core/utils/mcp-helpers.ts` (`chooseHealReplacement`,
  role/candidate logic) — unit-tested in `test/selfHeal.test.js` + `test/failureCapture.test.js`. The
  agent owns only the capture orchestration + DB.
- The LLM **rerank** prompt is built inline (it embeds per-call candidate data); `prompts/system.md`
  holds the static system instruction for reference.
- **Limits:** a renamed element with no shared word with the original is unmatchable without a
  baseline; deep state a name-based match can't reach won't re-ground.

## Key files

- `SelfHealAgent.ts` — strategy selection, capture orchestration, DB.
- `core/heal/failureCapture.ts` — temp-copy capture + `ariaSnapshot` read.
- `core/utils/healing.ts` — pure file-text + aria + target-recovery helpers.
- `core/utils/mcp-helpers.ts` — `getCandidatesForAction`, `chooseHealReplacement`.
- `core/db/db.ts` — `element_signature`/`element_observation` queries, transactional baseline promotion.
- `orchestrator/runPipeline.ts` `healIfNeeded` — re-run loop + DB-guarded persistence.
