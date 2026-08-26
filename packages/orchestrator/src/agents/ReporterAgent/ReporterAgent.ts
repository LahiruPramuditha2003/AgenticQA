import { Agent, RunContext, Logger } from "../../core/agent/types";
import {
  markTestRunEnded,
  getStepResultsForRun,
  getHealingAttemptsForRun,
} from "../../core/db/db";
import { LlmClient } from "../../core/llm/LlmClient";
import { describeStep, describeFromTitle, stepNumberFromKey } from "../../core/utils/describeStep";
import { parseStepKey } from "../../core/utils/stepKeys";
import { dedupeHealAttempts } from "../../core/utils/report";
import * as path from "node:path";
import * as crypto from "node:crypto";

function fmtDuration(ms: number | undefined): string {
  if (typeof ms !== "number" || !isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`;
}

const ENABLE_AI_ANALYSIS = process.env.ENABLE_AI_ANALYSIS === "true";

export class ReporterAgent implements Agent {
  name = "ReporterAgent";

  async run(ctx: RunContext, logger: Logger): Promise<void> {
    const finalStatus = ctx.playwrightExitCode === 0 ? "passed" : "failed";
    ctx.finalStatus = finalStatus;

    // Every run needs a stable, non-empty id so the UI can key/label it. When the DB is off there is
    // no persisted UUID, so synthesize a local one (prevents a sidebar crash on `runId.slice(...)`).
    const persisted = !!ctx.testRunId;
    const runId = ctx.testRunId ?? `local-${crypto.randomBytes(4).toString("hex")}`;

    // ── Gather data (DB optional) ──
    let stepResults: Array<{ stepKey: string | null; status: string; errorMessage: string | null }> = [];
    let healingAttempts: Array<{ failedStepId: string | null; oldLocator: string | null; newLocator: string | null; succeeded: boolean }> = [];

    if (ctx.testRunId) {
      await markTestRunEnded(ctx.testRunId, finalStatus);
      stepResults = await getStepResultsForRun(ctx.testRunId);
      healingAttempts = await getHealingAttemptsForRun(ctx.testRunId);
    } else {
      // DB disabled — fall back to the in-memory step results ExecutorAgent parsed from the
      // Playwright JSON report, so the summary is still accurate.
      stepResults = (ctx.stepResults ?? []).map((s) => ({
        stepKey: s.stepKey,
        status: s.status,
        errorMessage: s.errorMessage ?? null,
      }));
      // Healing history needs the DB; with it off, synthesize from ctx.healResults so a DB-less
      // deterministic self-heal still surfaces as "self-healed" (a heal succeeded when the re-run
      // flipped the run to passed).
      healingAttempts = (ctx.healResults ?? []).map((hr) => ({
        failedStepId: hr.stepId,
        oldLocator: hr.oldLocator,
        newLocator: hr.newLocator,
        succeeded: finalStatus === "passed",
      }));
      logger.log(
        `Reporter: DB disabled — building summary from ${stepResults.length} in-memory step result(s)` +
          (ctx.healResults?.length ? `, ${ctx.healResults.length} in-memory heal result(s)` : "")
      );
    }

    const stepsPassed = stepResults.filter((s) => s.status === "passed").length;
    const stepsFailed = stepResults.filter((s) => s.status === "failed").length;
    const stepsTotal = stepResults.length;

    // Collapse the DB's multiple healing_attempt rows per step (pre- + post-rerun) into one per step,
    // so the count reflects distinct steps healed, not attempt rows (fixes the cosmetic "1/2 succeeded").
    const dedupedHeals = dedupeHealAttempts(healingAttempts);
    const healAttempts = dedupedHeals.length;
    const healSucceeded = dedupedHeals.filter((h) => h.succeeded).length;
    const wasHealed = healSucceeded > 0;

    let statusIcon: string;
    let statusLabel: string;
    if (finalStatus === "passed" && wasHealed) {
      statusIcon = "✅";
      statusLabel = "PASSED (self-healed)";
    } else if (finalStatus === "passed") {
      statusIcon = "✅";
      statusLabel = "PASSED";
    } else {
      statusIcon = "❌";
      statusLabel = "FAILED";
    }

    // ── Resolve report paths ──
    let htmlReportDisplay = "";
    if (ctx.htmlReportDir) {
      const htmlIndexPath = path.join(ctx.htmlReportDir, "index.html");
      try {
        htmlReportDisplay = path
          .relative(ctx.workspacePath, htmlIndexPath)
          .replace(/\\/g, "/");
      } catch {
        htmlReportDisplay = htmlIndexPath;
      }
    }

    let jsonReportDisplay = "";
    if (ctx.jsonReportPath) {
      try {
        jsonReportDisplay = path
          .relative(ctx.workspacePath, ctx.jsonReportPath)
          .replace(/\\/g, "/");
      } catch {
        jsonReportDisplay = ctx.jsonReportPath;
      }
    }

    // ── Gather healing data ──
    const successfulHeals = dedupedHeals.filter((h) => h.succeeded);
    const healMap = new Map<
      string,
      { oldLocator: string; newLocator: string }
    >();
    for (const h of successfulHeals) {
      if (h.failedStepId) {
        healMap.set(h.failedStepId, {
          oldLocator: h.oldLocator ?? "",
          newLocator: h.newLocator ?? "",
        });
      }
    }

    // Which healed steps re-pointed an assertion target (heal-and-flag policy). Sourced from the
    // in-memory heal results so it works with the DB on or off.
    const retargetByKey = new Map<string, boolean>();
    for (const hr of ctx.healResults ?? []) {
      if (hr.stepKey) retargetByKey.set(hr.stepKey, !!hr.assertionRetargeted);
    }

    // ── Per-step enrichment: meaningful description + duration ──
    // The DB step rows don't carry duration/title, so pull those from the in-memory parse
    // (ctx.stepResults) keyed by stepKey. Descriptions come from the test plan, correlated by the
    // `plan-step-N` index, with a title-based fallback when the plan is absent.
    // D7: resolve each step against the test case its OWN key names, not always case 0.
    const planStepFor = (stepKey: string | null): any | undefined => {
      const parsed = stepKey ? parseStepKey(stepKey) : null;
      if (!parsed) {return undefined;}
      return ctx.testPlan?.testCases?.[parsed.testCaseIndex]?.steps?.[parsed.stepIndex];
    };
    const durationByKey = new Map<string, number>();
    const titleByKey = new Map<string, string>();
    const screenshotsByKey = new Map<string, string[]>();
    for (const s of ctx.stepResults ?? []) {
      if (!s.stepKey) continue;
      if (typeof s.durationMs === "number") durationByKey.set(s.stepKey, s.durationMs);
      if (s.title) titleByKey.set(s.stepKey, s.title);
      if (s.screenshots && s.screenshots.length) screenshotsByKey.set(s.stepKey, s.screenshots);
    }

    const treeSteps = stepResults.map((sr) => {
      const num = stepNumberFromKey(sr.stepKey);
      const planStep = planStepFor(sr.stepKey);
      const description = planStep
        ? describeStep(planStep)
        : describeFromTitle(sr.stepKey ? titleByKey.get(sr.stepKey) : undefined, sr.stepKey ?? "step");
      return {
        stepKey: sr.stepKey,
        index: num ?? undefined,
        action: planStep?.action ?? describeFromTitle(sr.stepKey ? titleByKey.get(sr.stepKey) : undefined, ""),
        description,
        status: sr.status,
        durationMs: sr.stepKey ? durationByKey.get(sr.stepKey) : undefined,
        errorMessage: sr.errorMessage ?? undefined,
        healed: sr.stepKey ? healMap.has(sr.stepKey) : false,
        oldLocator: sr.stepKey ? healMap.get(sr.stepKey)?.oldLocator : undefined,
        newLocator: sr.stepKey ? healMap.get(sr.stepKey)?.newLocator : undefined,
        assertionRetargeted: sr.stepKey ? (retargetByKey.get(sr.stepKey) ?? false) : false,
        screenshots: sr.stepKey ? screenshotsByKey.get(sr.stepKey) : undefined,
      };
    });

    // Healed steps whose assertion target was re-pointed — flagged so a real regression isn't masked.
    const assertionsRetargeted = treeSteps.filter(
      (s) => s.healed && s.assertionRetargeted
    ).length;

    const totalDurationMs = [...durationByKey.values()].reduce((a, b) => a + b, 0) || undefined;
    const testTitle: string | undefined = ctx.testPlan?.testCases?.[0]?.title;

    // ── Generate AI Analysis (BEFORE emitting RUN_SUMMARY) ──
    let aiAnalysis: string | null = null;
    const failedSteps = stepResults.filter((s) => s.status === "failed");

    if (ENABLE_AI_ANALYSIS && finalStatus === "failed" && failedSteps.length > 0) {
      const llmClient = new LlmClient({ role: "reporter" });
      if (llmClient.isConfigured()) {
        const testContext = ctx.requestText ?? "Unknown test request";
        const testPlanSteps = ctx.testPlan?.testCases?.[0]?.steps
          ? ctx.testPlan.testCases[0].steps.map((s: any) => `${s.action} ${s.target ?? ""} ${s.value ?? ""}`).join(", ")
          : "Unknown test plan";

        const failedStepDetails = failedSteps.map((fs) => {
          let detail = `Step: ${fs.stepKey ?? "unknown"}`;
          if (fs.errorMessage) {
            detail += `\nError: ${fs.errorMessage.split("\n")[0].slice(0, 200)}`;
          }
          return detail;
        }).join("\n\n");

        const analysisPrompt = `You are a test failure analyst. A Playwright test failed during execution.

Test Context:
${testContext}

Test Plan Steps:
${testPlanSteps}

Failed Steps Details:
${failedStepDetails}

Based on this information, provide a brief 2-3 sentence analysis of what went wrong and potential fixes. Focus on the most likely root cause and actionable suggestions. Be concise and practical.`;

        try {
          aiAnalysis = await llmClient.chat(
            [{ role: "user", content: analysisPrompt }],
            { temperature: 0.3, maxTokens: 300 }
          );
        } catch (err) {
          aiAnalysis = "AI analysis unavailable: LLM call failed";
        }
      }
    }

    // ── Emit structured RUN_SUMMARY for TreeView ──
    logger.log(
      JSON.stringify({
        __type: "RUN_SUMMARY",
        runId,
        persisted,
        status: finalStatus,
        wasHealed,
        statusLabel,
        testTitle,
        stepsTotal,
        stepsPassed,
        stepsFailed,
        durationMs: totalDurationMs,
        executionProject: ctx.executionProject ?? null,
        baseUrl: ctx.effectiveBaseUrl ?? null,
        startUrl: ctx.effectiveStartUrl ?? null,
        healAttempts,
        healSucceeded,
        assertionsRetargeted,
        steps: treeSteps,
        htmlReport: htmlReportDisplay,
        jsonReport: jsonReportDisplay,
        testFile: ctx.testRelPath,
        workspacePath: ctx.workspacePath,
        timestamp: new Date().toISOString(),
        requestText: ctx.requestText,
        testPlan: ctx.testPlan,
        failureClass: ctx.failureClass ?? null,
        healingSkipReason: ctx.healingSkipReason ?? null,
        planningDegraded: ctx.planningDegraded ?? false,
        planningDegradedReason: ctx.planningDegradedReason ?? null,
        // G4.5 — set only when recent runs of this same spec disagree. Absent/false with the DB off,
        // and absent until there is enough history to distinguish "flaky" from "recently fixed".
        flaky: ctx.flaky ?? false,
        flowKey: ctx.selectedFlowKey ?? null,
        aiAnalysis,
      })
    );

    // ══════════════════════════════════════════════════
    //  Human-readable report (Output channel) — no hard truncation
    // ══════════════════════════════════════════════════

    const bar = "═".repeat(64);
    const thin = "─".repeat(64);
    const lines: string[] = [];

    // ── Header ──
    lines.push(bar);
    lines.push(`  ${statusIcon} ${statusLabel}  ·  AgenticQA Test Report`);
    lines.push(bar);
    if (testTitle) lines.push(`  Test:     ${testTitle}`);
    lines.push(`  Run ID:   ${runId}${persisted ? "" : "  (not persisted — DB disabled)"}`);
    const meta = [
      new Date().toISOString().replace("T", " ").slice(0, 19),
      ctx.executionProject ? `browser: ${ctx.executionProject}` : null,
      fmtDuration(totalDurationMs) ? `took ${fmtDuration(totalDurationMs)}` : null,
    ].filter(Boolean);
    lines.push(`  When:     ${meta.join("   ·   ")}`);
    if (ctx.testRelPath) lines.push(`  Spec:     ${ctx.testRelPath}`);

    // ── Request ──
    if (ctx.requestText && !ctx.requestText.startsWith("RUN_ONLY")) {
      lines.push(thin);
      lines.push("  Request:");
      lines.push(`    ${ctx.requestText.trim()}`);
    }

    // ── Planning degraded warning ──
    if (ctx.planningDegraded) {
      lines.push(thin);
      lines.push("  ⚠ Planning degraded — ran a minimal placeholder plan (goto + waitForLoad).");
      lines.push("    A PASS here does NOT confirm the requested behavior was tested.");
      if (ctx.planningDegradedReason) lines.push(`    Reason: ${ctx.planningDegradedReason}`);
    }

    // ── Flakiness (G4.5) ──
    // Worth its own line rather than a footnote: a flaky spec's PASS and its FAIL are both untrustworthy,
    // and a reader who doesn't know that will chase the wrong defect.
    if (ctx.flaky) {
      lines.push(thin);
      lines.push("  ⚠ FLAKY — recent runs of this spec disagree with each other.");
      lines.push("    Treat both a PASS and a FAIL here as unreliable until the cause is found.");
    }

    // ── Steps ──
    if (treeSteps.length > 0) {
      lines.push(thin);
      lines.push(`  Steps (${stepsPassed}/${stepsTotal} passed):`);
      for (const s of treeSteps) {
        const icon = s.healed ? "🔧" : s.status === "passed" ? "✅" : "❌";
        const num = s.index != null ? `${s.index}. ` : "";
        const dur = fmtDuration(s.durationMs);
        const tag = s.healed ? "  [healed]" : "";
        lines.push(`    ${icon} ${num}${s.description}${tag}${dur ? `   (${dur})` : ""}`);
        if (s.status === "failed" && s.errorMessage) {
          // First non-empty line of the Playwright error — not truncated mid-word.
          const firstLine = s.errorMessage.split("\n").find((l) => l.trim()) ?? "";
          lines.push(`         ↳ ${firstLine.trim()}`);
        }
        if (s.healed && (s.oldLocator || s.newLocator)) {
          lines.push(`         old: ${s.oldLocator ?? ""}`);
          lines.push(`         new: ${s.newLocator ?? ""}`);
        }
      }
    }

    // ── Failure class ──
    if (finalStatus === "failed" && ctx.failureClass) {
      lines.push(thin);
      lines.push(`  Failure class: ${ctx.failureClass}`);
    }

    // ── Self-healing ──
    if (healAttempts > 0) {
      lines.push(thin);
      lines.push(`  Self-healing: ${healSucceeded}/${healAttempts} succeeded`);
      if (assertionsRetargeted > 0) {
        lines.push(
          `  ⚠ ${assertionsRetargeted} assertion target(s) were re-pointed — verify these were renames, not regressions:`
        );
        for (const s of treeSteps) {
          if (s.healed && s.assertionRetargeted) {
            lines.push(`      • ${s.index != null ? `${s.index}. ` : ""}${s.description}`);
          }
        }
      }
    } else if (finalStatus === "failed" && !wasHealed && ctx.healingSkipReason) {
      lines.push(thin);
      lines.push(`  Self-healing: not applied — ${ctx.healingSkipReason}`);
    }

    // ── AI analysis ──
    if (aiAnalysis) {
      lines.push(thin);
      lines.push("  AI Analysis:");
      for (const aLine of aiAnalysis.split("\n")) {
        if (aLine.trim()) lines.push(`    ${aLine.trim()}`);
      }
    }

    // ── Reports ──
    if (htmlReportDisplay || jsonReportDisplay) {
      lines.push(thin);
      lines.push("  Reports:");
      if (htmlReportDisplay) lines.push(`    HTML: ${htmlReportDisplay}`);
      if (jsonReportDisplay) lines.push(`    JSON: ${jsonReportDisplay}`);
    }

    lines.push(bar);
    logger.log("\n" + lines.join("\n"));
  }
}