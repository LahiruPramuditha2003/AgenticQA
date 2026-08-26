import { Agent, RunContext, Logger } from "../../core/agent/types";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PlaywrightMcpClient } from "../../core/mcp/PlaywrightMcpClient";
import { LlmClient } from "../../core/llm/LlmClient";
import { crawlSite } from "../../core/explore/Crawler";
import { detectAppFromListing } from "../../core/knowledge/generate/detectApp";
import { extractRoutes } from "../../core/knowledge/generate/extractRoutes";
import { extractCredentials } from "../../core/knowledge/generate/extractCredentials";
import {
  buildPackPrompt,
  parsePackResponse,
  finalizePack,
  selectFlowsForValidation,
  type PackSynthesisInput,
} from "../../core/knowledge/generate/synthesizePack";
import type { AppKnowledgePack } from "../../core/knowledge/AppKnowledgePack";
import { UiInspectorAgent } from "../UiInspectorAgent";
import { TestScriptGeneratorAgent } from "../TestScriptGeneratorAgent";
import { ExecutorAgent } from "../ExecutorAgent";

/**
 * Max golden flows to validate-by-running (bounds one-time generation time).
 *
 * ⚠️ Raised 10 → 12 when the `filter` family was added (2026-08-11). The budget is spent round-robin
 * across families, so a *new* family does not get its slots for free — it takes them from the others, and
 * at 10 the measurable cost was `form-settings` dropping out of the pack entirely (`eval:generatedpack`
 * 17/20 → 13/20). More families genuinely need more budget. This is a one-time cost per app, ~40s a flow.
 */
const MAX_VALIDATE = 12;

const SKIP_DIRS = /^(node_modules|\.git|dist|build|coverage|\.next|out|\.agenticqa|\.vscode)$/;

/** Reset the per-flow ctx fields so each validation flow generates + runs independently. */
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

/** Bounded recursive file listing (workspace-relative, forward-slashed), skipping heavy/irrelevant dirs. */
async function listFiles(root: string, maxFiles = 4000): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (out.length >= maxFiles || depth > 8) {return;}
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= maxFiles) {return;}
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.test(e.name)) {continue;}
        await walk(full, depth + 1);
      } else if (e.isFile()) {
        out.push(path.relative(root, full).replace(/\\/g, "/"));
      }
    }
  }
  await walk(root, 0);
  return out;
}

/** Find the app's package.json content (root first, else a shallow one declaring a web framework). */
async function findPackageJson(root: string, files: string[]): Promise<string | undefined> {
  if (files.includes("package.json")) {
    try {
      return await fs.readFile(path.join(root, "package.json"), "utf8");
    } catch {
      /* fall through */
    }
  }
  const pkgs = files.filter((f) => /(^|\/)package\.json$/.test(f)).slice(0, 12);
  for (const p of pkgs) {
    try {
      const content = await fs.readFile(path.join(root, p), "utf8");
      if (/react-router|"next"|vue-router/.test(content)) {return content;}
    } catch {
      /* ignore */
    }
  }
  if (pkgs.length) {
    try {
      return await fs.readFile(path.join(root, pkgs[0]), "utf8");
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

async function readFiles(
  root: string,
  rels: string[],
  cap = 30
): Promise<Array<{ path: string; content: string }>> {
  const out: Array<{ path: string; content: string }> = [];
  for (const rel of rels.slice(0, cap)) {
    try {
      out.push({ path: rel, content: await fs.readFile(path.join(root, rel), "utf8") });
    } catch {
      /* unreadable — skip */
    }
  }
  return out;
}

function appNameFromPackageJson(pkgJson: string | undefined): string | undefined {
  if (!pkgJson) {return undefined;}
  try {
    const name = JSON.parse(pkgJson)?.name;
    return typeof name === "string" && name.trim() ? name.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Knowledge-pack generator (N2.3). For a code-accessible app it: detects the framework, reads routes +
 * seed credentials from source, crawls the live app, synthesizes a pack (LLM-enriched over a deterministic
 * floor), VALIDATES candidate golden flows by running them (keeps only passers), and writes
 * `.agenticqa/knowledge.json`. Opt-in via the `generate_pack` run mode — never touches generate_and_run /
 * run_only / explore.
 */
export class KnowledgePackAgent implements Agent {
  name = "KnowledgePackAgent";

  async run(ctx: RunContext, logger: Logger): Promise<void> {
    const baseUrl = ctx.effectiveBaseUrl;
    if (!baseUrl) {throw new Error("effectiveBaseUrl missing");}
    const startUrl = ctx.effectiveStartUrl ?? baseUrl;
    const root = ctx.workspacePath;

    // ── 1. Detect code accessibility ──
    const files = await listFiles(root);
    const packageJson = await findPackageJson(root, files);
    const detected = detectAppFromListing({ packageJson, files });
    logger.log(`PackGen: ${detected.reason}`);

    // Hosted-only apps (a deployed URL with no source in the workspace) used to bail here, so they could
    // never earn a pack at all. But only the STATIC extraction needs source — crawl → synthesize →
    // validate → write works from the live app alone. Sourceless mode simply runs with no extracted
    // routes and, deliberately, **no credentials** (they exist only in source; inventing them is the D2
    // defect). G1.4.
    const sourceless = !detected.isCodeAccessible;

    // ── 2. Static extraction from source (skipped when sourceless) ──
    let extractedRoutes: ReturnType<typeof extractRoutes> = [];
    let credentials: ReturnType<typeof extractCredentials> = [];

    if (sourceless) {
      logger.log(
        "PackGen: no app source in the workspace — generating from the LIVE APP ONLY (crawl-based). " +
          "Routes come from the crawl; credentials are omitted entirely (never invented), so auth flows " +
          "will not be part of this pack."
      );
    } else {
      const routeSources = await readFiles(root, detected.routeFileCandidates);
      const credSources = await readFiles(root, detected.credentialFileCandidates);
      extractedRoutes = extractRoutes({
        framework: detected.framework,
        sources: routeSources,
        filePaths: detected.framework === "next" ? detected.routeFileCandidates : undefined,
      });
      credentials = extractCredentials(credSources);
      logger.log(
        `PackGen: extracted ${extractedRoutes.length} route(s) and ${credentials.length} credential(s) from source.`
      );
    }

    // ── 3. Crawl the live app (seeded with the extracted routes) ──
    logger.log("PackGen: crawling the live app…");
    const seedUrls = extractedRoutes
      .map((r) => r.path)
      .filter((p) => p && !p.includes(":"))
      .map((p) => {
        try {
          return new URL(p, baseUrl).toString();
        } catch {
          return "";
        }
      })
      .filter(Boolean);

    let mcp: any;
    try {
      mcp = await PlaywrightMcpClient.connect({ headless: true, caps: ["core", "testing"], snapshotMode: "full" });
    } catch (e: any) {
      logger.log(`PackGen: MCP connect failed — ${e?.message ?? String(e)}. Cannot crawl.`);
      return;
    }

    let site;
    try {
      // Sourceless has no extracted routes to seed the frontier, so discovery rests entirely on links —
      // go one level deeper to compensate. `maxPages` still bounds the total work either way.
      const maxDepth = sourceless ? 3 : 2;
      // ⚠️ The budget must leave room for LINK DISCOVERY, not just for the seeds. A flat 16 was fine for
      // a small app and starved a real one: demo-web's router declares 16 routes, 15 of which survive the
      // pattern filter and become seeds — leaving exactly ONE slot for everything reachable only by a
      // link. Detail pages are precisely that: `/products/:id` is filtered out of the seeds (it is not a
      // navigable URL), so `/products/1` can only arrive through discovery. Losing it means the pack has
      // no product-detail flow at all, which is how a product-detail request ended up answered by a
      // products-list smoke flow.
      const maxPages = Math.min(48, Math.max(16, seedUrls.length + 12));
      logger.log(
        `PackGen: crawl budget ${maxPages} page(s) — ${seedUrls.length} seed(s) + room for link discovery.`
      );
      site = await crawlSite({ mcp, startUrl, baseUrl, maxPages, maxDepth, seedUrls, logger });
    } finally {
      try {
        await mcp.close();
      } catch {
        /* ignore */
      }
    }

    if (!site.routes.length) {
      logger.log("PackGen: no routes mapped — cannot generate a useful pack.");
      return;
    }

    // ── 4. Synthesize the pack (LLM-enriched over the deterministic floor) ──
    const input: PackSynthesisInput = {
      appName: appNameFromPackageJson(packageJson),
      baseUrl,
      siteMap: site,
      extractedRoutes,
      credentials,
    };

    const llm = new LlmClient({ appName: "AgenticQA", role: "packgen" });
    let llmPack: AppKnowledgePack | null = null;
    if (llm.isConfigured()) {
      try {
        const resp = await llm.chat([{ role: "user", content: buildPackPrompt(input) }], {
          temperature: 0.2,
          // A whole knowledge pack — routes, stableElements, guidance, aliases and ~10 golden flows of
          // ~6 steps each — does not fit in 2000 tokens. It was silently TRUNCATED mid-JSON, so
          // `parsePackResponse` returned null and every generated pack fell back to the deterministic
          // floor: no tags, no assertion aliases. The failure logged only "LLM response unusable".
          maxTokens: 8000,
        });
        llmPack = parsePackResponse(resp);
        logger.log(
          llmPack
            ? "PackGen: LLM pack parsed — merging over the deterministic floor."
            // Say WHY. "unusable" alone hid a silent max_tokens truncation for weeks: the reply was
            // valid JSON right up to where it was cut off, so every pack quietly lost its tags.
            : `PackGen: LLM response unusable (${resp.length} chars, ` +
              `${/\{[\s\S]*\}/.test(resp) ? "no balanced JSON object — likely TRUNCATED, raise maxTokens" : "no JSON found at all"})` +
              " — using the deterministic pack."
        );
      } catch (e: any) {
        logger.log(`PackGen: LLM call failed — ${e?.message ?? String(e)}. Using the deterministic pack.`);
      }
    } else {
      logger.log("PackGen: no LLM configured — building a deterministic pack from the crawl.");
    }

    let pack = finalizePack(input, llmPack);

    // ── 5. Validate candidate golden flows by running them (keep passers) ──
    pack = await this.validateGoldenFlows(ctx, logger, pack);

    // ── 6. Write .agenticqa/knowledge.json (backing up any existing pack) ──
    await this.writePack(root, pack, logger, ctx);
    logger.log(
      `PackGen: complete (${sourceless ? "sourceless / live-app only" : `${detected.framework} source + live app`}).`
    );
  }

  /** Run each candidate golden flow (chromium) and keep only the ones that pass; clean up the temp specs. */
  private async validateGoldenFlows(
    ctx: RunContext,
    logger: Logger,
    pack: AppKnowledgePack
  ): Promise<AppKnowledgePack> {
    if (!pack.goldenFlows || Object.keys(pack.goldenFlows).length === 0) {return pack;}

    // Round-robin across flow families, NOT the first N — see `selectFlowsForValidation`. Taking the
    // first N cut at the boundary before the nav flows, so no generated pack ever contained one.
    const entries = selectFlowsForValidation(pack.goldenFlows, MAX_VALIDATE);
    const total = Object.keys(pack.goldenFlows).length;
    logger.log(
      `PackGen: validating ${entries.length} of ${total} candidate golden flow(s) by running them… ` +
        `(${entries.map(([k]) => k).join(", ")})`
    );

    // No DB writes + chromium-only for validation; validation specs are throwaway.
    ctx.testRunId = undefined;
    ctx.executionProject = "chromium";

    const kept: NonNullable<typeof pack.goldenFlows> = {};
    const generatedSpecs: string[] = [];
    // A flow that FAILED is evidence the flow is wrong. A flow that ERRORED (Playwright missing, spec
    // never ran) is evidence the harness is wrong — a very different diagnosis, and one that is easy to
    // hit on a hosted-only target whose workspace has no Playwright install.
    let errored = 0;

    for (const [key, flow] of entries) {
      resetFlowCtx(ctx);
      ctx.testPlan = { testCases: [{ title: flow.description || key, steps: flow.steps as any[] }] };
      ctx.requestText = flow.description || key;
      try {
        await new UiInspectorAgent().run(ctx, logger);
        await new TestScriptGeneratorAgent().run(ctx, logger);
        await new ExecutorAgent().run(ctx, logger);
      } catch (e: any) {
        errored++;
        logger.log(`PackGen: flow "${key}" errored — ${e?.message ?? String(e)}`);
      }
      if (ctx.testRelPath) {generatedSpecs.push(ctx.testRelPath);}
      if (ctx.playwrightExitCode === 0) {
        // `verified` is set HERE and nowhere else — it means "this flow was executed and passed", so it
        // may only be written by the code that did the executing. It is never accepted from the LLM
        // (`cleanGoldenFlows` drops it), or validate-by-running would be meaningless (G2.1/G2.5).
        kept[key] = { ...flow, verified: true };
        logger.log(`PackGen: ✓ "${key}" passed — keeping (marked verified).`);
      } else {
        logger.log(`PackGen: ✗ "${key}" did not pass — dropping.`);
      }
    }

    await this.cleanupSpecs(ctx.workspacePath, generatedSpecs, logger);

    const keptKeys = Object.keys(kept);
    logger.log(`PackGen: ${keptKeys.length}/${entries.length} golden flow(s) validated.`);
    if (keptKeys.length) {
      pack.goldenFlows = kept;
    } else {
      delete pack.goldenFlows;
      logger.log(
        errored === entries.length
          ? "PackGen: ⚠ EVERY flow errored before running — validation never happened. Is Playwright " +
              "installed in this workspace (`npm i -D @playwright/test && npx playwright install`)? " +
              "The pack is still written with routes/guidance, but with no golden flows."
          : "PackGen: no candidate flow passed, so none were kept — the pack keeps its routes/guidance " +
              "only. Nothing unverified is ever written."
      );
    }
    return pack;
  }

  /** Delete the throwaway validation spec files. */
  private async cleanupSpecs(root: string, specRelPaths: string[], logger: Logger): Promise<void> {
    for (const rel of [...new Set(specRelPaths)]) {
      if (!rel || !/\.spec\.ts$/i.test(rel)) {continue;}
      const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
      try {
        await fs.unlink(abs);
      } catch {
        /* already gone — ignore */
      }
    }
    if (specRelPaths.length) {logger.log("PackGen: cleaned up validation specs.");}
  }

  /** Write the pack to `.agenticqa/knowledge.json`, backing up any existing file. */
  private async writePack(
    root: string,
    pack: AppKnowledgePack,
    logger: Logger,
    ctx: RunContext
  ): Promise<void> {
    const dir = path.join(root, ".agenticqa");
    const file = path.join(dir, "knowledge.json");
    await fs.mkdir(dir, { recursive: true });

    // `curated` is a human's claim about a hand-written pack. A generated one must never assert it,
    // for the same reason `verified` is never accepted from a model: a marker anyone can set means
    // nothing. Stripped here rather than trusted not to appear.
    delete (pack as { curated?: boolean }).curated;

    try {
      const previousRaw = await fs.readFile(file, "utf8");
      // ── D30/D38: refuse to discard a hand-curated pack unless the run explicitly said so ──
      //
      // Generation REPLACES; it never merges. On demo-web that traded 15 curated flows for 5 generated
      // ones, and because that pack is ground truth for five offline suites the damage surfaced as
      // eight failures in files that never mention a pack. A backup is not enough on its own: the
      // person clicking the button has no reason to go looking for one.
      let previousCurated = false;
      try {
        previousCurated = JSON.parse(previousRaw)?.curated === true;
      } catch {
        /* unreadable previous pack — treat as not curated, the backup still protects it */
      }
      if (previousCurated && ctx.overwriteCuratedPack !== true) {
        const relLive = path.relative(root, file).replace(/\\/g, "/");
        logger.log(
          `PackGen: REFUSED to overwrite ${relLive} — it is marked "curated": true, meaning it was ` +
            `written by hand. Generation replaces a pack wholesale, so continuing would discard every ` +
            `flow in it.`
        );
        logger.log(
          `PackGen: nothing was written. Re-run the command and confirm the replacement prompt to ` +
            `proceed, or remove "curated": true from the pack if it is no longer hand-maintained.`
        );
        return;
      }

      const bak = path.join(dir, `knowledge.backup-${Date.now()}.json`);
      await fs.copyFile(file, bak);

      // ⚠️ Say what is being LOST, not merely that a backup happened. Generation replaces the pack
      // wholesale — no flow from the existing pack is carried over — so a hand-curated pack can be
      // traded for a poorer generated one by clicking a button. That happened on demo-web (15 curated
      // flows → 5 generated), and the only trace was a neutral "backed up existing pack" line that gave
      // no reason to look. The counts and the restore command make the trade visible at a glance.
      let previousFlows = 0;
      try {
        previousFlows = Object.keys(JSON.parse(previousRaw)?.goldenFlows ?? {}).length;
      } catch {
        /* unreadable previous pack — still backed up, just can't count it */
      }
      const nextFlows = pack.goldenFlows ? Object.keys(pack.goldenFlows).length : 0;
      const rel = path.relative(root, bak).replace(/\\/g, "/");
      logger.log(
        `PackGen: REPLACING the existing pack — ${previousFlows} flow(s) → ${nextFlows} flow(s). ` +
          `Generation does not merge; every existing flow is discarded.`
      );
      const relLive = path.relative(root, file).replace(/\\/g, "/");
      logger.log(
        `PackGen: previous pack saved to ${rel} — restore it with:  cp "${rel}" "${relLive}"`
      );
      if (previousFlows > nextFlows) {
        logger.log(
          `PackGen: ⚠ the new pack has FEWER flows than the one it replaces. If the previous pack was ` +
            `hand-curated, restore it from the backup above.`
        );
      }
    } catch {
      /* no existing pack — fine */
    }
    await fs.writeFile(file, JSON.stringify(pack, null, 2), "utf8");
    const flows = pack.goldenFlows ? Object.keys(pack.goldenFlows).length : 0;
    const creds = pack.credentials ? Object.keys(pack.credentials).length : 0;
    logger.log(
      `PackGen: wrote ${path.relative(root, file).replace(/\\/g, "/")} — ${flows} validated flow(s), ${creds} credential group(s).`
    );
  }
}
