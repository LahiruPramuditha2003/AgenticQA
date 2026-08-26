import { Agent, RunContext, Logger } from "../../core/agent/types";
import { PlaywrightMcpClient } from "../../core/mcp/PlaywrightMcpClient";
import { LlmClient } from "../../core/llm/LlmClient";
import { crawlSite } from "../../core/explore/Crawler";
import { synthesizeFlows } from "../../core/explore/synthesizeFlows";
import { judgeFlows } from "./judge";
import { UiInspectorAgent } from "../UiInspectorAgent";
import { TestScriptGeneratorAgent } from "../TestScriptGeneratorAgent";
import { ExecutorAgent } from "../ExecutorAgent";
import { ReporterAgent } from "../ReporterAgent";

/** Reset the per-flow ctx fields so each discovered flow generates + reports independently. */
function resetFlowCtx(ctx: RunContext): void {
  ctx.testPlan = undefined;
  ctx.stepLocators = undefined;
  ctx.testRelPath = undefined;
  ctx.playwrightExitCode = undefined;
  ctx.playwrightStdout = undefined;
  ctx.playwrightStderr = undefined;
  ctx.jsonReportPath = undefined;
  ctx.htmlReportDir = undefined;
  ctx.stepResults = undefined;
  ctx.failedSteps = undefined;
  ctx.failedStepId = undefined;
  ctx.failureText = undefined;
  ctx.failureClass = undefined;
  ctx.healResults = undefined;
  ctx.healingSkipReason = undefined;
  ctx.planningDegraded = undefined;
  ctx.planningDegradedReason = undefined;
  ctx.finalStatus = undefined;
}

/**
 * Exploratory testing agent (S3.4). Crawls the app's public routes, synthesizes candidate flows, has an
 * LLM judge rank them, then generates + runs the top-N through the EXISTING grounding (UiInspector) →
 * codegen (TestScriptGenerator) → execution (Executor) → reporting (Reporter) path. Opt-in via the
 * `explore` run mode; it never alters `generate_and_run` / `run_only`.
 */
export class ExploratoryAgent implements Agent {
  name = "ExploratoryAgent";

  async run(ctx: RunContext, logger: Logger): Promise<void> {
    const baseUrl = ctx.effectiveBaseUrl;
    if (!baseUrl) throw new Error("effectiveBaseUrl missing");
    const startUrl = ctx.effectiveStartUrl ?? baseUrl;

    // ── 1. Crawl public routes → SiteMap ──
    logger.log("Explore: starting crawl of public routes…");
    let mcp: any;
    try {
      mcp = await PlaywrightMcpClient.connect({
        headless: true,
        caps: ["core", "testing"],
        snapshotMode: "full",
      });
    } catch (e: any) {
      logger.log(`Explore: MCP connect failed — ${e?.message ?? String(e)}. Cannot explore.`);
      return;
    }

    let site;
    try {
      site = await crawlSite({ mcp, startUrl, baseUrl, maxPages: 8, maxDepth: 2, logger });
    } finally {
      try {
        await mcp.close();
      } catch {}
    }

    if (!site.routes.length) {
      logger.log("Explore: no routes mapped — nothing to explore.");
      return;
    }

    // ── 2. Synthesize candidate flows ──
    const flows = synthesizeFlows(site, { baseUrl });
    logger.log(
      `Explore: synthesized ${flows.length} candidate flow(s) across ${site.routes.length} route(s)`
    );
    if (!flows.length) {
      logger.log("Explore: no candidate flows synthesized.");
      return;
    }

    // ── 3. Judge → top 5 ──
    const llm = new LlmClient({ appName: "AgenticQA", role: "explorer" });
    const ranked = await judgeFlows(flows, { llm, topN: 5, logger });
    logger.log(`Explore: selected ${ranked.length} flow(s) to generate + run:`);
    ranked.forEach((f, i) =>
      logger.log(`  ${i + 1}. [${f.kind}] ${f.title}${f.rationale ? ` — ${f.rationale}` : ""}`)
    );

    // Each flow reports as an independent (local) run — clear the shared DB run id so per-flow reports
    // don't overwrite one another. Explore is a discovery tool; persistence/heal aren't needed here.
    ctx.testRunId = undefined;

    // Run discovered flows on chromium only — exploration is about *finding* flows quickly and stably,
    // not cross-browser validation (kept specs can later be run on the full matrix via Run Existing Tests).
    ctx.executionProject = "chromium";

    // ── 4. Generate + run each ranked flow through the existing pipeline ──
    let passed = 0;
    for (let i = 0; i < ranked.length; i++) {
      const flow = ranked[i];
      logger.log(`Explore: [${i + 1}/${ranked.length}] generating + running "${flow.title}"…`);
      resetFlowCtx(ctx);
      ctx.testPlan = { testCases: [{ title: flow.title, steps: flow.steps }] };
      ctx.requestText = flow.title; // drives UiInspector page inference + the report's display name

      try {
        await new UiInspectorAgent().run(ctx, logger);
        await new TestScriptGeneratorAgent().run(ctx, logger);
        await new ExecutorAgent().run(ctx, logger);
      } catch (e: any) {
        logger.log(`Explore: flow "${flow.title}" errored — ${e?.message ?? String(e)}`);
      }

      if (ctx.playwrightExitCode === 0) passed++;
      await new ReporterAgent().run(ctx, logger); // emits a per-flow RUN_SUMMARY for the sidebar
    }

    logger.log(`Explore: complete — ${passed}/${ranked.length} discovered flow(s) passed.`);
  }
}
