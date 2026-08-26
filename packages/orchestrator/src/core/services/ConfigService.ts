import { Logger, RunContext } from "../agent/types";
import { loadAgenticQaConfig } from "../../config"; // adjust if needed
import { loadAppKnowledgePack } from "../knowledge/AppKnowledgePack";
import { registerModelOverrides, resolveModel, AGENT_ROLES } from "../llm/models";

/**
 * Which browser projects should this run execute against? (G5.1 / defect D6)
 *
 * `undefined` means "the app's full configured matrix" — Playwright's own default when no `--project`
 * flag is passed.
 *
 * Precedence: an explicit per-run pin > "run everything" > the app's `.agenticqa.json` > **chromium**.
 *
 * ⚠️ That last default is the behaviour change, and it is worth being explicit about. Every prompted run
 * used to execute the whole matrix serially — five browsers on demo-web — so cross-browser coverage was
 * the price of *every* iteration rather than a release-time decision, and it was the single largest
 * latency in the system. Pure and exported so the precedence can be argued about in a test rather than
 * discovered from a benchmark that quietly changed meaning.
 */
export function resolveExecutionProjects(input: {
  pinned?: string;
  allProjects?: boolean;
  configured?: "all" | string[];
}): string[] | undefined {
  if (input.pinned) {return [input.pinned];}
  if (input.allProjects) {return undefined;}
  if (input.configured === "all") {return undefined;}
  if (Array.isArray(input.configured) && input.configured.length) {return input.configured;}
  return ["chromium"];
}

export class ConfigService {
  async apply(ctx: RunContext, logger: Logger): Promise<void> {
    const cfg = await loadAgenticQaConfig(ctx.workspacePath);

    const effectiveBaseUrl = ctx.overrides?.baseUrl ?? cfg.baseUrl;
    const effectiveStartUrl = ctx.overrides?.startUrl;

    logger.log(`effectiveBaseUrl = ${effectiveBaseUrl ?? "undefined"}`);
    if (effectiveStartUrl) logger.log(`effectiveStartUrl = ${effectiveStartUrl}`);

    if (!effectiveBaseUrl) {
      throw new Error("No baseUrl available. Provide URL in request or set baseUrl in .agenticqa.json");
    }

    ctx.cfg = cfg;
    ctx.effectiveBaseUrl = effectiveBaseUrl;
    ctx.effectiveStartUrl = effectiveStartUrl;

    logger.log("Loaded .agenticqa.json");
    logger.log(`testDir = ${cfg.testDir}`);

    // ── G5.1 / defect D6: which browsers does this run execute against? ──
    // Precedence: an explicit per-request pin > "run everything" > the app's config > chromium.
    //
    // ⚠️ The final default is the behaviour change. Every prompted run used to execute the app's whole
    // Playwright matrix serially — five browsers on demo-web — which made cross-browser coverage the
    // price of *every* iteration rather than a release-time decision, and it was the single largest
    // latency in the system. The full matrix is still one flag away, and the accuracy benchmark asks for
    // it explicitly so the "20/20 across five browsers" number keeps meaning what it says.
    if (!ctx.executionProjects?.length) {
      ctx.executionProjects = resolveExecutionProjects({
        pinned: ctx.executionProject,
        allProjects: ctx.allProjects,
        configured: cfg.execution?.projects,
      });
    }
    logger.log(
      `Execution: ${ctx.executionProjects?.length ? ctx.executionProjects.join(", ") : "all configured browser projects"}`
    );

    // Load the optional per-app knowledge pack (credentials, routes, golden flows).
    ctx.knowledgePack = await loadAppKnowledgePack(ctx.workspacePath, cfg, logger);

    // Register any per-workspace model overrides (.agenticqa.json `models`) into the registry,
    // then log the effective model each agent role will use this run.
    registerModelOverrides(cfg.models);
    logger.log(
      `Model assignment: ${AGENT_ROLES.map((r) => `${r}=${resolveModel(r)}`).join(", ")}`
    );
  }
}

/**
 * Best-effort: load `.agenticqa.json` `models` and register them so per-agent model overrides apply to
 * EVERY intent — Casual, Domain QA, and the early-running Receptionist — not just the roles that run
 * after `ConfigService.apply`. Call this before intent routing. On a missing/invalid config it clears
 * overrides (the `OPENAI_MODEL_<ROLE>` / `OPENAI_MODEL` env vars and built-in defaults still apply).
 */
export async function applyModelOverridesFromWorkspace(workspacePath: string): Promise<void> {
  try {
    const cfg = await loadAgenticQaConfig(workspacePath);
    registerModelOverrides(cfg.models);
  } catch {
    registerModelOverrides(undefined);
  }
}