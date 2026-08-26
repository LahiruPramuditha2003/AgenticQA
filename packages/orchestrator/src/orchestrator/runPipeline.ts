import { Logger, RunContext } from "../core/agent/types";
import { ReceptionistAgent } from "../agents/ReceptionistAgent";
import { ConfigService, applyModelOverridesFromWorkspace } from "../core/services/ConfigService";
import { setPromptWorkspace } from "../core/utils/loadPrompt";
import { TestPlannerAgent } from "../agents/TestPlannerAgent";
import { DbService } from "../core/services/DbService";
import { WebServerService } from "../core/services/WebServerService";
import { UiInspectorAgent } from "../agents/UiInspectorAgent";
import { TestScriptGeneratorAgent } from "../agents/TestScriptGeneratorAgent";
import { ExecutorAgent } from "../agents/ExecutorAgent";
import { ReporterAgent } from "../agents/ReporterAgent";
import { SelfHealAgent } from "../agents/SelfHealAgent";
import { DomainQaAgent } from "../agents/DomainQaAgent";
import { CasualAgent } from "../agents/CasualAgent/CasualAgent";
import { ExploratoryAgent } from "../agents/ExploratoryAgent";
import { KnowledgePackAgent } from "../agents/KnowledgePackAgent";
import { EmbeddingClient } from "../core/llm/EmbeddingClient";
import { PlaywrightMcpClient } from "../core/mcp/PlaywrightMcpClient";
import { loadAgenticQaConfig } from "../config";
import {
  waitForPageStable,
  buildPageContext,
  mergePageRefs,
} from "../core/utils/mcp-helpers";
import { buildInspectUrlsFromRequest } from "../core/inspection/RouteIntentResolver";
import {
  annotateRefsWithPage,
  extractDomInventory,
  mergeDomInventoryIntoContext,
} from "../core/inspection/PageInventory";
import {
  updateTestRunInitialStatus,
  markHealAttempted,
  markHealSucceeded,
  insertHealingAttempt,
  insertTestCase,
  insertTestStep,
  linkTestRunToTestCase,
  promoteNearestObservationToBaseline,
  recordHealOutcome,
  recordFlowOutcome,
  getRecentSpecOutcomes,
} from "../core/db/db";
import { detectFlakiness } from "../core/learn/priors";

async function preInspectPage(
  ctx: RunContext,
  logger: Logger
): Promise<void> {
  if (!ctx.effectiveBaseUrl) return;

  const baseUrl = ctx.effectiveBaseUrl;
  const startUrl = ctx.effectiveStartUrl ?? baseUrl;

  const requestForPaths = ctx.requestText ?? "";
  // Routes come from the APP (its pack's route map + the goto targets of its verified golden flows),
  // not from built-in guesses — see RouteIntentResolver's header for why that mattered (G3.1).
  const pagesToInspect = buildInspectUrlsFromRequest(
    requestForPaths,
    baseUrl,
    startUrl,
    ctx.knowledgePack
  );

  logger.log(`PreInspect: requestText="${requestForPaths.slice(0, 60)}..."`);
  if (!ctx.knowledgePack) {
    logger.log(
      "PreInspect: no knowledge pack — inspecting the start page only (routes are never guessed)."
    );
  }
  logger.log(`PreInspect: selected pages to inspect: ${pagesToInspect.join(", ")}`);
  logger.log("PreInspect: starting MCP browser for page inspection...");
  let mcp: any;
  try {
    mcp = await PlaywrightMcpClient.connect({
      headless: true,
      caps: ["core", "testing"],
      snapshotMode: "full",
    });
  } catch (e: any) {
    logger.log(
      `PreInspect: MCP connect failed — ${e?.message ?? String(e)}. Planner will work without page context.`
    );
    return;
  }

  const allRefs: any[] = [];
  const pageContexts: any[] = [];
  let finalSnapshotText = "";
  let lastUrl = startUrl;

  try {
    for (const pageUrl of pagesToInspect) {
      try {
        await mcp.callTool("browser_navigate", { url: pageUrl });
        logger.log(`PreInspect: navigated to ${pageUrl}`);

        const { snapshotText, refs } = await waitForPageStable(mcp, logger, {
          label: "PreInspect",
        });

        const pageRefs = annotateRefsWithPage(refs, pageUrl);
        const pageContext = buildPageContext(pageUrl, pageRefs, snapshotText);
        const domInventory = await extractDomInventory(mcp, logger);
        mergeDomInventoryIntoContext(pageContext, domInventory);
        pageContexts.push(pageContext);

        // Namespaced by page — a raw MCP ref id is only unique within one snapshot (see `mergePageRefs`).
        mergePageRefs(allRefs, pageRefs, pageUrl);

        finalSnapshotText += `\n\n--- Page: ${pageUrl} ---\n${snapshotText}`;
        lastUrl = pageUrl;
      } catch (e: any) {
        logger.log(`PreInspect: failed to inspect ${pageUrl} — ${e?.message ?? String(e)}. Continuing...`);
      }
    }

    const pageContextUrl = pagesToInspect.length > 1 ? pagesToInspect.join(", ") : lastUrl;
    const aggregatedPageContext = buildPageContext(pageContextUrl, allRefs, finalSnapshotText);
    if (pageContexts.length > 1) {
      aggregatedPageContext.pages = pageContexts;
    }
    ctx.pageContext = aggregatedPageContext;
    ctx.pageInventory = pageContexts;

    logger.log(
      `PreInspect: found ${allRefs.length} element(s) across ${pagesToInspect.length} pages — ` +
        `${ctx.pageContext.inputs.length} input(s), ` +
        `${ctx.pageContext.buttons.length} button(s), ` +
        `${ctx.pageContext.headings.length} heading(s), ` +
        `${ctx.pageContext.links.length} link(s)`
    );
  } catch (e: any) {
    logger.log(
      `PreInspect: failed — ${e?.message ?? String(e)}. Planner will work without page context.`
    );
  } finally {
    try {
      await mcp.close();
    } catch {}
    logger.log("PreInspect: MCP browser closed");
  }
}

/* ── store test plan in DB ── */
async function storePlanInDb(ctx: RunContext, logger: Logger): Promise<void> {
  if (!ctx.testPlan || !ctx.projectId || !ctx.testRunId) return;

  const tc = ctx.testPlan.testCases[0];
  if (!tc) return;

  const testCaseId = await insertTestCase(ctx.projectId, tc.title);
  ctx.testCaseId = testCaseId;
  await linkTestRunToTestCase(ctx.testRunId, testCaseId);

  const embedder = new EmbeddingClient();
  // Skip intent embeddings when the embed model's dimension doesn't match the DB's fixed vector size
  // (DbService probe, N1.6) — otherwise insertTestStep would throw on the wrong-dimension vector.
  const canEmbed = embedder.isConfigured() && ctx.embeddingDimOk !== false;

  for (let i = 0; i < tc.steps.length; i++) {
    const s = tc.steps[i];
    const intentText =
      `${s.action} ${s.field ?? s.target ?? s.url ?? s.value ?? ""}`.trim();

    let intentEmbedding: number[] | undefined;
    if (canEmbed) {
      try {
        intentEmbedding = await embedder.embedOne(intentText);
      } catch (e: any) {
        logger.log(
          `DB: intent embedding failed for step ${i}: ${e?.message ?? String(e)}`
        );
      }
    }

    await insertTestStep({
      testCaseId,
      stepIndex: i,
      actionType: s.action,
      url: s.url,
      intentText,
      locatorHint: s.field ?? s.target,
      intentEmbedding,
    });
  }

  logger.log(
    `DB: stored test_case "${tc.title}" with ${tc.steps.length} steps`
  );
}

/**
 * G4.2 + G4.5 — record what this run taught, and read back what earlier runs said about this spec.
 *
 * Runs once per completed test run, after healing has settled the final exit code. Everything is guarded
 * on `ctx.projectId`, so a DB-off install reaches this function and does nothing at all.
 */
async function recordRunOutcome(ctx: RunContext, logger: Logger): Promise<void> {
  if (!ctx.projectId) {return;}
  const passed = ctx.playwrightExitCode === 0;

  // Which golden flow produced this plan, and did it hold up? Read back by `FlowIndex` as a prior.
  if (ctx.selectedFlowKey) {
    await recordFlowOutcome({ projectId: ctx.projectId, flowKey: ctx.selectedFlowKey, passed });
  }

  // ⚠️ Flakiness is a question about a SEQUENCE, so it is read from `spec_outcome` rows rather than a
  // counter. `ExecutorAgent` has already appended this run's row, so the window includes it.
  if (ctx.testRelPath) {
    const recent = await getRecentSpecOutcomes(ctx.projectId, ctx.testRelPath, 10);
    if (detectFlakiness(recent)) {
      ctx.flaky = true;
      const window = recent.map((r) => (r ? "P" : "F")).join("");
      logger.log(
        `History: ${ctx.testRelPath} looks FLAKY — last ${recent.length} run(s) newest-first: ${window}`
      );
    }
  }
}

/* ── shared heal-after-failure logic ── */
async function healIfNeeded(ctx: RunContext, logger: Logger): Promise<void> {
  if (ctx.playwrightExitCode === 0) return;

  // Heal runs with or without a DB. Every DB write below is guarded by ctx.testRunId; the patch +
  // re-run + exit-code recompute happen regardless, so DB-off installs still self-heal.
  if (ctx.testRunId) await markHealAttempted(ctx.testRunId);

  await new SelfHealAgent().run(ctx, logger);

  if (!ctx.healPatched || !ctx.healResults || ctx.healResults.length === 0) {
    if (!ctx.healingSkipReason) {
      ctx.healingSkipReason =
        "no replacement locator could be found for the failed step(s)";
    }
    logger.log(
      `SelfHeal: no patch was applied — ${ctx.healingSkipReason}. Skipping re-run.`
    );
    return;
  }

  // ── Record healing attempts (pre-rerun) — DB only ──
  if (ctx.testRunId) {
    for (const hr of ctx.healResults) {
      await insertHealingAttempt({
        testRunId: ctx.testRunId,
        failedStepId: hr.stepId,
        oldLocator: hr.oldLocator,
        newLocator: hr.newLocator,
        patchedFile: hr.testRelPath,
        succeeded: false,
      });
    }
  }

  // ── Re-run ALL patched files ──
  const patchedFiles = [
    ...new Set(ctx.healResults.map((hr) => hr.testRelPath)),
  ];
  logger.log(
    `SelfHeal: re-running ${patchedFiles.length} patched file(s): ${patchedFiles.join(", ")}`
  );

  // Tell ExecutorAgent to skip DB step_result writes during re-runs
  // so the initial failure records are preserved for ReporterAgent
  ctx.isHealRerun = true;

  const filePassMap = new Map<string, boolean>();

  for (const patchedFile of patchedFiles) {
    ctx.testRelPath = patchedFile;
    logger.log(`SelfHeal: re-running ${patchedFile}...`);
    await new ExecutorAgent().run(ctx, logger);

    const filePassed = ctx.playwrightExitCode === 0;
    filePassMap.set(patchedFile, filePassed);

    if (filePassed) {
      logger.log(`SelfHeal: re-run of ${patchedFile} passed ✅`);
    } else {
      logger.log(`SelfHeal: re-run of ${patchedFile} still failing`);
    }
  }

  // Reset flag
  ctx.isHealRerun = false;

  // ── Determine overall and per-step success ──
  const anyHealed = [...filePassMap.values()].some((v) => v);
  const allHealed = [...filePassMap.values()].every((v) => v);

  if (ctx.testRunId) await markHealSucceeded(ctx.testRunId, anyHealed);

  // Set final exit code based on whether ALL files passed
  ctx.playwrightExitCode = allHealed ? 0 : 1;

  // ── Record per-step outcome based on which FILE passed — DB only ──
  if (ctx.testRunId) {
    for (const hr of ctx.healResults) {
      const filePassed = filePassMap.get(hr.testRelPath) ?? false;
      await insertHealingAttempt({
        testRunId: ctx.testRunId,
        failedStepId: hr.stepId,
        oldLocator: hr.oldLocator,
        newLocator: hr.newLocator,
        patchedFile: hr.testRelPath,
        succeeded: filePassed,
      });
    }
  }

  // ── G4.2: heal feedback, keyed on whether the RE-RUN actually passed ──
  // ⚠️ `healing_attempt.succeeded` above records the same boolean, but that table's name promises
  // something weaker — it has meant "a patch was applied" in other code paths, and the 2026-08-11
  // prompt-14 run applied two patches while failing harder than before (D24). `heal_feedback` exists so
  // the reranker learns from the OUTCOME and nothing else.
  if (ctx.projectId) {
    for (const hr of ctx.healResults) {
      await recordHealOutcome({
        projectId: ctx.projectId,
        stepKey: hr.stepKey,
        oldLocator: hr.oldLocator,
        newLocator: hr.newLocator,
        runPassedAfter: filePassMap.get(hr.testRelPath) ?? false,
      });
    }
  }

  // ── Promote baselines only for steps in files that passed (DB only) ──
  if (ctx.projectId && ctx.testRunId) {
    for (const hr of ctx.healResults) {
      const filePassed = filePassMap.get(hr.testRelPath) ?? false;
      if (!filePassed) continue;

      try {
        const promoted = await promoteNearestObservationToBaseline({
          projectId: ctx.projectId,
          testRunId: ctx.testRunId,
          stepKey: hr.stepKey,
        });
        if (promoted) {
          logger.log(
            `DB: promoted healed locator to new baseline for ${hr.stepKey}`
          );
        }
      } catch (e: any) {
        logger.log(
          `DB: baseline promotion failed for ${hr.stepKey}: ${e?.message ?? String(e)}`
        );
      }
    }
  }

  const healedCount = [...filePassMap.values()].filter((v) => v).length;
  logger.log(
    `SelfHeal: ${healedCount}/${filePassMap.size} file(s) healed successfully`
  );
}

/* ── main pipeline ── */
export async function runPipeline(ctx: RunContext, logger: Logger) {
  // Register per-workspace model overrides (.agenticqa.json `models`) BEFORE any agent runs, so they
  // apply to every intent — including Casual / Domain QA and the early-running Receptionist (which all
  // run before ConfigService). Best-effort: no/invalid config just leaves env + defaults in effect.
  await applyModelOverridesFromWorkspace(ctx.workspacePath);

  // Point the prompt loader at this workspace, so `<workspace>/.agenticqa/prompts/<Agent>.md` can
  // override a shipped system prompt (R1.1). Set here, alongside the model overrides, for the same
  // reason: the Receptionist runs before ConfigService, so anything registered later would miss it.
  setPromptWorkspace(ctx.workspacePath);

  /* ── Intent routing ── */
  if (ctx.runMode === "run_only") {
    ctx.intent = "TEST_GEN";
    logger.log("Intent = TEST_GEN (run_only mode — skipped Receptionist)");
  } else if (ctx.runMode === "explore") {
    ctx.intent = "TEST_GEN";
    logger.log("Intent = TEST_GEN (explore mode — skipped Receptionist)");
  } else if (ctx.runMode === "generate_pack") {
    ctx.intent = "TEST_GEN";
    logger.log("Intent = TEST_GEN (generate_pack mode — skipped Receptionist)");
  } else {
    const receptionist = new ReceptionistAgent();
    await receptionist.run(ctx, logger);

    if (ctx.intent === "CASUAL") {
      logger.log("Casual intent — responding conversationally");
      await new CasualAgent().run(ctx, logger);
      return;
    }
  }

  /* ── DOMAIN_QA flow ── */
  if (ctx.intent === "DOMAIN_QA") {
    try {
      const cfg = await loadAgenticQaConfig(ctx.workspacePath);
      ctx.cfg = cfg;
      logger.log("Loaded .agenticqa.json for Domain QA");
    } catch (e: any) {
      logger.log(
        `DomainQA: could not load .agenticqa.json — ${e?.message ?? String(e)}`
      );
      return;
    }

    await new DbService().apply(ctx, logger);
    await new DomainQaAgent().run(ctx, logger);
    return;
  }

  /* ── TEST_GEN: Common setup ── */
  await new ConfigService().apply(ctx, logger);
  await new DbService().apply(ctx, logger);
  await new WebServerService().apply(ctx, logger);

  /* ── explore mode ── */
  if (ctx.runMode === "explore") {
    await new ExploratoryAgent().run(ctx, logger);
    return;
  }

  /* ── generate_pack mode (auto knowledge-pack for code-accessible apps) ── */
  if (ctx.runMode === "generate_pack") {
    await new KnowledgePackAgent().run(ctx, logger);
    return;
  }

  /* ── run_only mode ── */
  if (ctx.runMode === "run_only") {
    if (ctx.requestText && ctx.requestText.startsWith("RUN_ONLY ") && ctx.requestText.trim() !== "RUN_ONLY") {
      ctx.testRelPath = ctx.requestText.slice(9).trim();
    } else {
      ctx.testRelPath = ctx.cfg?.testDir ?? "tests/generated";
    }

    await new ExecutorAgent().run(ctx, logger);

    if (ctx.testRunId) {
      const initialStatus =
        ctx.playwrightExitCode === 0 ? "passed" : "failed";
      await updateTestRunInitialStatus(ctx.testRunId, initialStatus);
      logger.log(`DB: saved initial_status=${initialStatus}`);
    }

    await healIfNeeded(ctx, logger);
    await recordRunOutcome(ctx, logger);
    await new ReporterAgent().run(ctx, logger);
    return;
  }

  /* ── generate_and_run mode ── */

  await preInspectPage(ctx, logger);

  await new TestPlannerAgent().run(ctx, logger);
  await storePlanInDb(ctx, logger);

  await new UiInspectorAgent().run(ctx, logger);

  await new TestScriptGeneratorAgent().run(ctx, logger);

  await new ExecutorAgent().run(ctx, logger);

  if (ctx.testRunId) {
    const initialStatus = ctx.playwrightExitCode === 0 ? "passed" : "failed";
    await updateTestRunInitialStatus(ctx.testRunId, initialStatus);
    logger.log(`DB: saved initial_status=${initialStatus}`);
  }

  await healIfNeeded(ctx, logger);
  await recordRunOutcome(ctx, logger);
  await new ReporterAgent().run(ctx, logger);
}
