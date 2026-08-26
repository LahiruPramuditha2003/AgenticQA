import { Agent, RunContext, Logger } from "../../core/agent/types";
import { writeFile } from "../../fs";
import { generateDemoLoginTest } from "../../generateDemoTest";
import { planToPlaywrightTs } from "./tools/planToPlaywright";
import * as crypto from "node:crypto";

/**
 * Real element roles by lowercased accessible name, from every inspected page (G3.4).
 *
 * Codegen used to decide "is 'Products' a link or a heading?" from hardcoded demo-web name lists. The
 * page already knows. First writer wins so a heading isn't shadowed by a same-named link elsewhere —
 * headings are listed first below for that reason.
 */
function buildRoleMap(ctx: RunContext): Record<string, string> {
  const out: Record<string, string> = {};
  const pages = ctx.pageContext?.pages?.length ? ctx.pageContext.pages : ctx.pageContext ? [ctx.pageContext] : [];
  for (const p of pages) {
    const groups: Array<[string, any[]]> = [
      ["heading", (p as any).headings ?? []],
      ["button", (p as any).buttons ?? []],
      ["link", (p as any).links ?? []],
      ["textbox", (p as any).inputs ?? []],
      ["combobox", (p as any).selects ?? []],
      ["checkbox", (p as any).checkboxes ?? []],
    ];
    for (const [role, els] of groups) {
      for (const e of els) {
        const key = String(e?.name ?? "").trim().toLowerCase();
        if (key && !(key in out)) {out[key] = e?.role || role;}
      }
    }
  }
  return out;
}

function safeFileName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Add short hash suffix to prevent file name collisions across runs */
function uniqueFileName(title: string): string {
  const base = safeFileName(title) || "planned-test";
  const hash = crypto
    .createHash("md5")
    .update(title + Date.now())
    .digest("hex")
    .slice(0, 6);
  return `${base}-${hash}`;
}

export class TestScriptGeneratorAgent implements Agent {
  name = "TestScriptGeneratorAgent";

  async run(ctx: RunContext, logger: Logger): Promise<void> {
    const cfg = ctx.cfg;
    if (!cfg) throw new Error("Config not loaded");
    if (!ctx.effectiveBaseUrl) throw new Error("effectiveBaseUrl missing");

    let testRelPath = `${cfg.testDir}/demo-login.spec.ts`;
    let content: string;

    if (ctx.testPlan) {
      const firstTitle =
        ctx.testPlan?.testCases?.[0]?.title &&
        typeof ctx.testPlan.testCases[0].title === "string"
          ? ctx.testPlan.testCases[0].title
          : "planned-test";

      const fileName = uniqueFileName(firstTitle);
      testRelPath = `${cfg.testDir}/${fileName}.spec.ts`;

content = planToPlaywrightTs({
          plan: ctx.testPlan,
          baseUrl: ctx.effectiveBaseUrl,
          startUrl: ctx.effectiveStartUrl,
          stepLocators: ctx.stepLocators,
          roleByName: buildRoleMap(ctx),
        });

      logger.log(
        `Generator: created test from plan (title="${firstTitle}", file="${testRelPath}")`
      );
    } else {
      content = generateDemoLoginTest(
        ctx.effectiveBaseUrl,
        ctx.effectiveStartUrl
      );
      logger.log(
        "Generator: no testPlan found; using demo generator fallback"
      );
    }

    await writeFile(ctx.workspacePath, testRelPath, content);
    ctx.testRelPath = testRelPath;

    logger.log(`Wrote test: ${testRelPath}`);
  }
}