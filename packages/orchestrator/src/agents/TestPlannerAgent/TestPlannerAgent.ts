import { Agent, RunContext, Logger } from "../../core/agent/types";
import { TestPlanSchema } from "./schema";
import { ZodError } from "zod";
import { RagPlannerEngine } from "../../knowledge/RagPlannerEngine";
import { groundPlan, repairSteps, flattenPageContext } from "./PlanGrounder";

function formatZodError(e: ZodError) {
  return e.issues.map((i) => ({
    path: i.path.join("."),
    message: i.message,
  }));
}

function ensureTestPlanTitlesAndSteps(plan: any): any {
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.testCases)) {
    return plan;
  }
  plan.testCases = plan.testCases
    .filter((tc: any) => tc && Array.isArray(tc.steps) && tc.steps.length > 0)
    .map((tc: any, idx: number) => ({
      ...tc,
      title:
        typeof tc.title === "string" && tc.title.trim()
          ? tc.title.trim()
          : `Generated test case ${idx + 1}`,
      steps: Array.isArray(tc.steps) ? tc.steps : [],
    }));
  return plan;
}

export class TestPlannerAgent implements Agent {
  name = "TestPlannerAgent";

  async run(ctx: RunContext, logger: Logger): Promise<void> {
    if (ctx.pageContext) {
      logger.log("RagPlanner: using page context from pre-inspection");
    } else {
      logger.log("RagPlanner: no page context - planning from intent only");
    }

    // RAG: retrieve knowledge + generate a RAW draft plan (LLM or deterministic fallback).
    const engine = new RagPlannerEngine();
    const rawPlan = await engine.generate(ctx, logger);

    // Single grounding layer (Step 4b): repairSteps (timing waits + canonicalization, relocated
    // from the engine) THEN page-scoped grounding below — no more competing post-processing passes.
    const flatCtx = ctx.pageContext ? flattenPageContext(ctx.pageContext) : undefined;
    if (rawPlan && Array.isArray(rawPlan.testCases)) {
      rawPlan.testCases = rawPlan.testCases.map((tc: any) => ({
        ...tc,
        steps: repairSteps(tc.steps ?? [], flatCtx),
      }));
    }

    const cleaned = ensureTestPlanTitlesAndSteps(rawPlan);
    const parsed = TestPlanSchema.safeParse(cleaned);

    if (!parsed.success) {
      logger.log(
        `RagPlanner: schema validation failed: ${JSON.stringify(formatZodError(parsed.error))}`
      );
      // The placeholder plan below trivially passes (goto + waitForLoad), which would otherwise look
      // like a clean PASS. Flag it so the Reporter warns that the requested behavior wasn't tested.
      ctx.planningDegraded = true;
      ctx.planningDegradedReason =
        "planner output failed schema validation — ran a minimal placeholder plan";
      ctx.testPlan = {
        testCases: [
          {
            title: (ctx.requestText ?? "Generated test").slice(0, 60),
            steps: [
              { action: "goto", url: ctx.effectiveStartUrl ?? ctx.effectiveBaseUrl ?? "/" },
              { action: "waitForLoad" },
            ],
          },
        ],
      };
      return;
    }

    // Single grounding pass: page-scoped, role-aware, non-destructive.
    const pages =
      ctx.pageInventory && ctx.pageInventory.length
        ? ctx.pageInventory
        : ctx.pageContext
          ? [ctx.pageContext]
          : [];

    // Pack assertion-alias values are dynamic/intended targets — never drop them in grounding.
    const keepTargets = (ctx.knowledgePack?.assertionAliases ?? [])
      .map((a) => a.assert)
      .filter((s): s is string => typeof s === "string" && s.length > 0);

    const grounded = groundPlan(parsed.data, {
      pages,
      startUrl: ctx.effectiveStartUrl ?? ctx.effectiveBaseUrl ?? "/",
      keepTargets,
      logger,
    });

    ctx.testPlan = grounded;

    logger.log(`RagPlanner: plan ready (testCases=${grounded.testCases.length})`);
    logger.log(
      `RagPlanner: first test="${grounded.testCases[0].title}" steps=${grounded.testCases[0].steps.length}`
    );
  }
}
