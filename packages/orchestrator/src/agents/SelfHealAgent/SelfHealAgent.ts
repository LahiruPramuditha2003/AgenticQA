import {
  Agent,
  RunContext,
  Logger,
  FailedStep,
} from "../../core/agent/types";
import { EmbeddingClient } from "../../core/llm/EmbeddingClient";
import { LlmClient } from "../../core/llm/LlmClient";
import {
  getLatestBaselineEmbedding,
  getLatestBaselineSignature,
  insertElementObservation,
  findTopNObservations,
  getHealFeedback,
} from "../../core/db/db";
import { rankHealCandidates } from "../../core/learn/priors";
import { parseStepKey } from "../../core/utils/stepKeys";
import { readFile, writeFile } from "../../fs";
import {
  toPagePath,
  buildSignatureText,
  getCandidatesForAction,
  chooseHealReplacement,
  isPlausibleHealName,
} from "../../core/utils/mcp-helpers";
import {
  patchLocatorInStepBlock,
  looksLikeLocatorNotFound,
  stepKeyFromFailedStepId,
  parseTestFileForHealing,
  intendedTargetForStep,
  extractTargetFromLocatorExpr,
  findLocatorExprInStepBlock,
  synthesizeLocator,
  isAssertionAction,
} from "../../core/utils/healing";
import { captureFailureState } from "../../core/heal/failureCapture";
import { loadSystemPrompt } from "../../core/utils/loadPrompt";

/** Cap on candidate elements embedded per heal step (vector mode) to bound embedding cost. */
const MAX_HEAL_CANDIDATES = 20;

/**
 * Step actions that resolve an element on the page, and are therefore the only ones a **locator** heal
 * can possibly apply to.
 *
 * Everything else — `goto`, `waitForLoad`, `waitFor`, `screenshot`, `scroll`, `evaluate` — either takes
 * no locator or takes a URL, and rewriting one into a locator produces a spec that does not parse.
 * See the guard at the call site for the run that proved it.
 */
export const HEALABLE_ACTIONS = new Set([
  "click",
  "hover",
  "press",
  "fill",
  "select",
  "slider",
  "check",
  "uncheck",
  "expectVisible",
  "expectNotVisible",
  "expectText",
  "expectValue",
]);

/* ─── helpers ─── */

/**
 * LLM-assisted reranking of top-N candidates.
 * Presents the top candidates to the LLM and asks it to pick the best match.
 * Falls back to vector-only if LLM fails or returns invalid response.
 */
async function rerankedNearestObservation(
  llm: LlmClient,
  logger: Logger,
  candidates: Array<{
    locator: string;
    role: string | null;
    name: string | null;
    distance: number;
  }>,
  context: {
    stepKey: string;
    testAction: string;
    baselineRole: string | null;
    baselineAccessibleName: string | null;
    pageUrl: string;
  }
): Promise<{
  locator: string;
  role: string | null;
  name: string | null;
  distance: number;
  selectedByLLM: boolean;
} | null> {
  if (candidates.length === 0) return null;

  // If only one candidate, return it directly
  if (candidates.length === 1) {
    return { ...candidates[0], selectedByLLM: false };
  }

  // Try LLM reranking
  try {
    const candidatesList = candidates
      .map(
        (c, idx) =>
          `${idx + 1}. role=${c.role || "unknown"}, name="${c.name || "N/A"}", distance=${c.distance.toFixed(4)}\n` +
          `   locator: ${c.locator}`
      )
      .join("\n");

    const prompt = `You are an expert at identifying HTML elements in web pages.

## Task
The test step was trying to interact with an element using this action: **${context.testAction}**

### Original Element Signature
- Step Key: ${context.stepKey}
- Role: ${context.baselineRole || "unknown"}
- Accessible Name: "${context.baselineAccessibleName || "N/A"}"
- Page: ${context.pageUrl}

### Problem
The original locator no longer finds the element. Here are the top ${candidates.length} candidate replacement elements found on the current page, ordered by semantic similarity:

${candidatesList}

### Your Task
Which candidate best replaces the original element? Consider:
1. The element's role should match the original (e.g., heading, button, textbox)
2. The accessible name should be semantically similar to the original
3. The action type (${context.testAction}) should make sense for this element

Return ONLY the number (1-${candidates.length}) of the best candidate. If none are suitable, return 0.`;

    logger.log(
      `SelfHeal[LLM]: asking LLM to rerank ${candidates.length} candidates for ${context.stepKey} (action=${context.testAction})`
    );

    const response = await llm.chat(
      [
        // System message lives in prompts/system.md (loaded at runtime — G0.4). The user message below
        // is still built per call from the live candidate list.
        {
          role: "system",
          content: loadSystemPrompt("SelfHealAgent", undefined, { log: (m) => logger.log(m) }),
        },
        { role: "user", content: prompt },
      ],
      // ⚠️ Was `maxTokens: 20`, sized for the ANSWER ("return only the number") rather than for the
      // MODEL. `selfheal` defaults to a reasoning model (`openai/gpt-oss-20b`), which spends tokens
      // thinking before it emits a single visible character — so the whole 20-token budget went to
      // reasoning and `content` came back EMPTY. Observed live 2026-08-20: four consecutive runs logged
      // `reranking failed (LLM returned empty content)`, silently disabling LLM reranking altogether.
      // This is D21/D31 a third time: a cap that fits a non-reasoning model starves a reasoning one.
      { temperature: 0.2, maxTokens: 512 }
    );

    // Parse LLM response — expect a number 1-N.
    // ⚠️ Take the LAST number, not the first. A reasoning model's visible reply often narrates before it
    // answers ("Candidate 2 is close, but 3 matches the role — 3"), and `match(/\d+/)` would take the 2.
    // The instruction asks for the bare number, so whatever trails the reply is the actual choice.
    const trimmed = response.trim();
    const numbers = trimmed.match(/\d+/g);
    const match = numbers ? [numbers[numbers.length - 1]] : null;
    if (!match) {
      logger.log(
        `SelfHeal[LLM]: invalid response from LLM (expected number): ${trimmed}`
      );
      return { ...candidates[0], selectedByLLM: false };
    }

    const selectedIdx = Number(match[0]) - 1;
    if (selectedIdx < 0 || selectedIdx >= candidates.length) {
      logger.log(
        `SelfHeal[LLM]: LLM returned out-of-range number: ${selectedIdx + 1} (valid range: 1-${candidates.length})`
      );
      return { ...candidates[0], selectedByLLM: false };
    }

    const selected = candidates[selectedIdx];
    logger.log(
      `SelfHeal[LLM]: LLM selected candidate #${selectedIdx + 1} for ${context.stepKey}`
    );
    logger.log(
      `SelfHeal[LLM]:   - role=${selected.role}, name="${selected.name}", distance=${selected.distance.toFixed(4)}`
    );

    return { ...selected, selectedByLLM: true };
  } catch (e: any) {
    logger.log(
      `SelfHeal[LLM]: reranking failed (${e?.message ?? String(e)}). Falling back to vector-only.`
    );
    // Fall back to the vector-closest candidate
    return { ...candidates[0], selectedByLLM: false };
  }
}

/* ─── agent ─── */

export class SelfHealAgent implements Agent {
  name = "SelfHealAgent";

  async run(ctx: RunContext, logger: Logger): Promise<void> {
    if (ctx.playwrightExitCode === 0) return;
    if (ctx.healAttempted) return;

    // ── Gate (F4): prefer the Executor's failure classification (locator-not-found / strict-mode),
    // falling back to a text scan when the class is absent. Assertion/logic mismatches are not healed.
    const out =
      (ctx.playwrightStdout ?? "") + "\n" + (ctx.playwrightStderr ?? "");
    const HEALABLE_CLASSES = new Set(["locator-not-found", "strict-mode"]);
    const healableByClass = ctx.failureClass
      ? HEALABLE_CLASSES.has(ctx.failureClass)
      : false;
    const healableByText = looksLikeLocatorNotFound(out);
    if (!healableByClass && !healableByText) {
      ctx.healingSkipReason = `failure class "${ctx.failureClass ?? "unclassified"}" is not locator-healable`;
      logger.log(`SelfHeal: ${ctx.healingSkipReason}. Skipping.`);
      return;
    }

    const stepsToHeal: FailedStep[] = ctx.failedSteps ?? [];
    if (stepsToHeal.length === 0 && ctx.failedStepId && ctx.testRelPath) {
      stepsToHeal.push({
        stepId: ctx.failedStepId,
        stepKey: ctx.failedStepId,
        testRelPath: ctx.testRelPath,
      });
    }
    if (stepsToHeal.length === 0) {
      logger.log("SelfHeal: no failed steps to heal. Skipping.");
      return;
    }
    if (!ctx.effectiveBaseUrl) {
      logger.log("SelfHeal: effectiveBaseUrl missing. Skipping.");
      return;
    }

    // Two strategies. Vector mode (DB + embeddings + a baseline) reranks observations; deterministic
    // mode re-grounds against the captured failed-state page. Both heal from the SAME captured
    // snapshot (no live MCP browser) — vector requires dbEnabled + projectId + testRunId + embeddings.
    const embedder = new EmbeddingClient();
    const vectorMode = !!(
      ctx.dbEnabled &&
      ctx.projectId &&
      ctx.testRunId &&
      embedder.isConfigured() &&
      ctx.embeddingDimOk !== false // a dimension-mismatched embed model disables the vector path (N1.6)
    );
    logger.log(
      vectorMode
        ? "SelfHeal: vector mode (DB + embeddings — baseline rerank, deterministic fallback)."
        : "SelfHeal: deterministic mode (re-grounding from the captured failed-state page; no DB needed)."
    );

    const llm = new LlmClient({ role: "selfheal" });
    const llmConfigured = vectorMode && llm.isConfigured();

    logger.log(
      `SelfHeal: attempting to heal ${stepsToHeal.length} failed step(s): ${stepsToHeal.map((s) => s.stepId).join(", ")}`
    );

    ctx.healAttempted = true;
    ctx.healResults = [];

    const fileCache = new Map<string, string>();
    const parsedCache = new Map<
      string,
      ReturnType<typeof parseTestFileForHealing>
    >();

    interface StepHealInfo {
      failed: FailedStep;
      stepKey: string;
      action: string;
      baselineRole: string | null;
      /** Intended element name (plan step, or parsed from the spec locator) for re-grounding. */
      intendedName: string | null;
    }

    const healInfos: StepHealInfo[] = [];

    for (const failed of stepsToHeal) {
      const stepKey = stepKeyFromFailedStepId(failed.stepId);
      if (!stepKey) {
        logger.log(
          `SelfHeal: could not derive stepKey for ${failed.stepId}. Skipping.`
        );
        continue;
      }

      let action: string | null = null;
      let intendedName: string | null = null;

      // From the plan (generate_and_run).
      if (ctx.testPlan) {
        // D7: the key carries its test case, so a multi-case plan no longer resolves to case 0's step.
        const parsed = parseStepKey(failed.stepId);
        const planStep = parsed
          ? ctx.testPlan.testCases[parsed.testCaseIndex]?.steps?.[parsed.stepIndex]
          : undefined;
        if (planStep) {
          action = planStep.action;
          intendedName = intendedTargetForStep(planStep);
        }
      }

      // From the spec file (run_only / no plan, or to recover a missing piece).
      if (!action || !intendedName) {
        if (!fileCache.has(failed.testRelPath)) {
          try {
            const content = await readFile(
              ctx.workspacePath,
              failed.testRelPath
            );
            fileCache.set(failed.testRelPath, content);
            parsedCache.set(
              failed.testRelPath,
              parseTestFileForHealing(content)
            );
          } catch (e: any) {
            logger.log(
              `SelfHeal: could not read ${failed.testRelPath}: ${e?.message}`
            );
            continue;
          }
        }
        const content = fileCache.get(failed.testRelPath)!;
        if (!action) {
          action = parsedCache.get(failed.testRelPath)?.steps.get(failed.stepId)
            ?.action ?? null;
        }
        if (!intendedName) {
          const expr = findLocatorExprInStepBlock(content, failed.stepId);
          if (expr) intendedName = extractTargetFromLocatorExpr(expr);
        }
      }

      if (!action) {
        logger.log(
          `SelfHeal: no action for ${failed.stepId} (not in plan or spec). Skipping.`
        );
        continue;
      }

      // ⚠️ Only a step that RESOLVES AN ELEMENT can be locator-healed. Without this gate the healer
      // happily rewrote a navigation into a locator — observed on demo-web prompt 14, 2026-08-11:
      //   patched plan-step-8 — old=page.goto(new URL("/checkout", …)) → new=page.getByRole("link", …)
      // The patched spec no longer parsed, so the verification re-run reported "0 step(s), 0 spec(s)"
      // and the whole thing surfaced as a navigation timeout. Corrupting a spec is strictly worse than
      // declining to heal it, and a `goto` failing means the URL or the server is wrong — never a stale
      // locator, so there is nothing here to fix by re-grounding anyway.
      if (!HEALABLE_ACTIONS.has(action)) {
        logger.log(
          `SelfHeal: ${stepKey} is a "${action}" step — it resolves no element, so there is no locator ` +
            `to heal. Skipping.`
        );
        continue;
      }

      // Baseline role (vector mode only) helps filter same-role candidates for assertions.
      let baselineRole: string | null = null;
      if (vectorMode) {
        const baselineSig = await getLatestBaselineSignature(
          ctx.projectId!,
          stepKey
        );
        baselineRole = baselineSig?.role ?? null;
      }

      healInfos.push({ failed, stepKey, action, baselineRole, intendedName });
    }

    if (healInfos.length === 0) {
      logger.log("SelfHeal: no healable steps after analysis.");
      return;
    }

    // ── Capture each failed spec's failed-state snapshot once, then heal its steps from it. ──
    const byFile = new Map<string, StepHealInfo[]>();
    for (const info of healInfos) {
      const arr = byFile.get(info.failed.testRelPath) ?? [];
      arr.push(info);
      byFile.set(info.failed.testRelPath, arr);
    }

    for (const [testRelPath, infos] of byFile) {
      logger.log(
        `SelfHeal: capturing failed-state snapshot for ${testRelPath}...`
      );
      const capture = await captureFailureState({
        workspacePath: ctx.workspacePath,
        testRelPath,
        project: "chromium",
      });

      if (!capture || capture.refs.length === 0) {
        ctx.healingSkipReason =
          "could not capture the failed-state page snapshot";
        logger.log(
          `SelfHeal: ${ctx.healingSkipReason} for ${testRelPath}. Skipping.`
        );
        continue;
      }

      const pagePath = toPagePath(
        capture.url || ctx.effectiveBaseUrl!,
        ctx.effectiveBaseUrl!
      );
      // Carry a synthetic ref id so the captured candidates satisfy the role/name helpers; the heal
      // synthesizes locators from role+name, so the ref itself is unused.
      const captureRefs = capture.refs.map((r, i) => ({
        role: r.role,
        name: r.name,
        ref: String(i),
      }));
      logger.log(
        `SelfHeal: captured ${captureRefs.length} element(s) on ${pagePath} (url=${capture.url})`
      );

      /** Locators already handed to a healed step in this pass — see the duplicate guard below. */
      const usedLocators = new Set<string>();

      for (const info of infos) {
        const { failed, stepKey, action, baselineRole, intendedName } = info;

        const candidates = getCandidatesForAction(
          captureRefs,
          action,
          baselineRole
        );
        if (candidates.length === 0) {
          logger.log(
            `SelfHeal: no candidates for ${stepKey} (action=${action}) in capture. Skipping.`
          );
          continue;
        }

        let newLocator: string | null = null;
        let distance = 0;
        let via = "deterministic";

        // ── Vector path (DB + a baseline) — ranks the captured candidates against the baseline. ──
        if (vectorMode) {
          const baselineEmb = await getLatestBaselineEmbedding(
            ctx.projectId!,
            stepKey
          );
          if (baselineEmb) {
            for (const c of candidates.slice(0, MAX_HEAL_CANDIDATES)) {
              const locator = synthesizeLocator(c.role, c.name);
              const signatureText = buildSignatureText({
                stepKey,
                pageUrl: pagePath,
                action,
                role: c.role,
                name: c.name,
                locator,
              });
              try {
                const embedding = await embedder.embedOne(signatureText);
                await insertElementObservation({
                  testRunId: ctx.testRunId!,
                  stepKey,
                  pageUrl: pagePath,
                  role: c.role,
                  name: c.name,
                  locator,
                  signatureText,
                  embedding,
                });
              } catch (e: any) {
                logger.log(
                  `SelfHeal: embed/store failed for ${stepKey}: ${e?.message ?? String(e)}`
                );
              }
            }

            const baselineSig = await getLatestBaselineSignature(
              ctx.projectId!,
              stepKey
            );
            const topCandidates = await findTopNObservations({
              testRunId: ctx.testRunId!,
              stepKey,
              baselineEmbedding: baselineEmb,
              limit: 5,
              excludeCurrentRun: false,
            });

            if (topCandidates.length > 0) {
              logger.log(
                `SelfHeal: found ${topCandidates.length} observation candidate(s) for ${stepKey}`
              );

              // ── G4.4: what did healing this same step teach us last time? ──
              // Embedding distance says "this looks like the old element". History says "this one
              // actually made the test pass" — which is the question that matters, and the one the
              // reranker had no way to ask. A replacement that healed this step before goes first; one
              // that was tried and still failed goes last; anything unproven keeps its place between
              // them. With no history the order is untouched, byte for byte.
              const feedback = await getHealFeedback(ctx.projectId!, stepKey);
              const ordered = rankHealCandidates(topCandidates, feedback);

              // ⚠️ Report that history was CONSULTED, not only the rare case where it changed its mind.
              // The reorder-only log made a working learning loop look like an absent one: when the
              // embedding already ranks the proven repair first — the normal case once a step has healed
              // successfully a few times — nothing was printed, so four consecutive healed runs produced
              // no evidence that history existed at all. Agreement is a result too, and it is the result
              // you get most often.
              if (feedback.size) {
                const proven = [...feedback.values()]
                  .filter((f) => f.successes > 0)
                  .sort((a, b) => b.successes - a.successes);
                const failed = [...feedback.values()].filter(
                  (f) => f.attempts > 0 && f.successes === 0
                );
                logger.log(
                  `SelfHeal: history for ${stepKey} — ${feedback.size} previously-tried locator(s): ` +
                    `${proven.length} proven, ${failed.length} known-bad.` +
                    (proven[0]
                      ? ` Best: "${proven[0].newLocator}" (${proven[0].successes}/${proven[0].attempts} passed).`
                      : "")
                );
                if (ordered[0] !== topCandidates[0]) {
                  logger.log(
                    `SelfHeal: history REORDERS ${stepKey} — "${ordered[0].locator}" has healed this ` +
                      `step before, so it is tried ahead of the nearest embedding ` +
                      `("${topCandidates[0].locator}").`
                  );
                } else {
                  logger.log(
                    `SelfHeal: history AGREES with the embedding for ${stepKey} — ` +
                      `"${ordered[0].locator}" is both the nearest candidate and the proven one; order unchanged.`
                  );
                }
                for (const f of failed) {
                  logger.log(
                    `SelfHeal: history DEMOTES "${f.newLocator}" for ${stepKey} — tried ${f.attempts}×, ` +
                      `never produced a passing re-run.`
                  );
                }
              } else {
                logger.log(
                  `SelfHeal: no heal history for ${stepKey} yet — ranking by embedding distance alone ` +
                    `(this run will become the first evidence).`
                );
              }

              let selected = ordered[0];
              let selectedByLLM = false;
              if (llmConfigured) {
                const reranked = await rerankedNearestObservation(
                  llm,
                  logger,
                  ordered,
                  {
                    stepKey,
                    testAction: action,
                    baselineRole: baselineSig?.role ?? null,
                    baselineAccessibleName: baselineSig?.accessibleName ?? null,
                    pageUrl: pagePath,
                  }
                );
                if (reranked) {
                  selected = reranked;
                  selectedByLLM = reranked.selectedByLLM;
                }
              }
              // ⚠️ The replacement must still LOOK like what it replaces. Without this the vector path
              // accepted whatever embedding sat nearest the stored baseline — and because `plan-step-N` is
              // a *positional* key, an LLM-authored plan that differs run to run makes that neighbour an
              // observation from a completely different step of an earlier plan. Measured on demo-web
              // prompt 14: both `Add to Cart` and `Proceed to Checkout` were rewritten to the same
              // `getByRole("link", { name: "Shopping Cart" })`, and the healed spec failed worse than the
              // original. A heal that makes a run worse destroys the evidence of the real defect.
              if (!isPlausibleHealName(intendedName, selected.name ?? "")) {
                logger.log(
                  `SelfHeal: vector candidate "${selected.name}" is not a plausible stand-in for ` +
                    `"${intendedName ?? "?"}" on ${stepKey} — declining it and re-grounding instead.`
                );
              } else if (usedLocators.has(selected.locator)) {
                // Two steps healing to the SAME locator means the neighbour search is not discriminating
                // between them; taking it twice cannot be right.
                logger.log(
                  `SelfHeal: ${stepKey} would reuse a locator already assigned to another healed step ` +
                    `(${selected.locator}) — declining it and re-grounding instead.`
                );
              } else {
                newLocator = selected.locator;
                distance = selected.distance;
                via = selectedByLLM ? "vector+llm" : "vector";
              }
            }
          }
          if (!newLocator) {
            logger.log(
              `SelfHeal: vector path found no baseline/observation for ${stepKey} — falling back to deterministic re-grounding.`
            );
          }
        }

        // ── Deterministic path (no DB, or vector declined) — re-ground from the captured page. ──
        if (!newLocator) {
          const chosen = chooseHealReplacement(
            captureRefs,
            action,
            intendedName,
            baselineRole
          );
          // ⚠️ The SAME plausibility bar the vector path clears (D24). `chooseHealReplacement`'s
          // token-overlap stage accepts a candidate sharing a SINGLE significant word, so without this
          // the deterministic path performs the exact swap D24 was written to stop: intended
          // "Add to Cart" re-grounds to link "Shopping Cart" (they share only "cart"). Verified:
          // isPlausibleHealName("Add to Cart","Shopping Cart") === false while chooseHealReplacement
          // returns it. The guard belongs on BOTH paths or it guards nothing.
          if (chosen && !isPlausibleHealName(intendedName, chosen.name ?? "")) {
            logger.log(
              `SelfHeal: deterministic candidate "${chosen.name}" is not a plausible stand-in for ` +
                `"${intendedName ?? "?"}" on ${stepKey} — declining rather than mis-pointing the step.`
            );
          } else if (chosen && usedLocators.has(synthesizeLocator(chosen.role, chosen.name))) {
            logger.log(
              `SelfHeal: ${stepKey} re-grounded to a locator already assigned to another healed step ` +
                `— declining rather than pointing two steps at one element.`
            );
          } else if (chosen) {
            newLocator = synthesizeLocator(chosen.role, chosen.name);
            via = "deterministic";
            logger.log(
              `SelfHeal: deterministic match for ${stepKey} — role=${chosen.role}, name="${chosen.name}" → ${newLocator}`
            );
          } else {
            logger.log(
              `SelfHeal: deterministic re-grounding found no match for ${stepKey} (intended="${intendedName ?? "?"}").`
            );
          }
        }

        if (!newLocator) {
          logger.log(
            `SelfHeal: no replacement locator for ${stepKey}. Skipping.`
          );
          continue;
        }
        usedLocators.add(newLocator);

        // ── Patch the spec ──
        const fileText = await readFile(ctx.workspacePath, failed.testRelPath);
        const patchResult = patchLocatorInStepBlock(
          fileText,
          failed.stepId,
          newLocator
        );
        if (!patchResult) {
          logger.log(
            `SelfHeal: could not patch ${stepKey} in ${failed.testRelPath}.`
          );
          continue;
        }
        await writeFile(
          ctx.workspacePath,
          failed.testRelPath,
          patchResult.patched
        );
        ctx.healResults!.push({
          stepId: failed.stepId,
          stepKey,
          oldLocator: patchResult.oldLocator,
          newLocator,
          testRelPath: failed.testRelPath,
          distance,
          assertionRetargeted: isAssertionAction(action),
        });
        logger.log(
          `SelfHeal: patched ${stepKey} via ${via} — old=${patchResult.oldLocator} → new=${newLocator}` +
            (isAssertionAction(action)
              ? ` (⚠ assertion target re-pointed — verify this was a rename, not a regression)`
              : "")
        );
      }
    }

    if (ctx.healResults!.length > 0) {
      ctx.healPatched = true;
      const first = ctx.healResults![0];
      ctx.healOldLocator = first.oldLocator;
      ctx.healNewLocator = first.newLocator;
      ctx.healStepKey = first.stepKey;
      logger.log(`SelfHeal: patched ${ctx.healResults!.length} step(s) total`);
    } else {
      logger.log("SelfHeal: no patches could be applied.");
    }
  }
}
