#!/usr/bin/env node
/**
 * Dump `planToPlaywrightTs()`'s emitted TypeScript for every deterministic plan a templates file
 * produces (R0.2).
 *
 * WHY THIS EXISTS
 * ---------------
 * `test/scenarioPlanGolden.test.js` locks the *plans*. Nothing locked the **generated code**, so a
 * codegen change could silently rewrite every spec in the suite and no offline test would notice —
 * only a live benchmark would, and a live diff is unattributable (it also exercises the page, the
 * grounding pass and, for unmatched prompts, an LLM).
 *
 * R1.2 deliberately changes codegen for three defects (D39 `expectCount` comparisons, D40 `check`
 * target selection, D41 regex string escaping). This fixture is what proves those changes touch
 * *only* the specs that use those actions and leave the other 48 byte-identical.
 *
 * Inputs are pinned so the output is a pure function of the codegen module:
 *   • plans come from `buildScenarioPlan` (already golden-locked),
 *   • `baseUrl` is a fixed literal,
 *   • `stepLocators` and `roleByName` are empty — grounding is a *different* layer with its own tests,
 *     and feeding it in here would make this fixture drift whenever a page changes.
 *
 *   node scripts/snapshotCodegen.js [--app=apps/demo-web] [--templates=TEST_TEMPLATES.md] [--out=f.json]
 *
 * With no --out it prints to stdout. Offline; needs only a build.
 */

const fs = require("node:fs");
const path = require("node:path");

const { extractTemplatePrompts, repoRootFromHere } = require("./extractTemplatePrompts");
const { buildScenarioPlan } = require("../dist/agents/TestPlannerAgent/ScenarioPlanner.js");
const {
  planToPlaywrightTs,
} = require("../dist/agents/TestScriptGeneratorAgent/tools/planToPlaywright.js");

/** Fixed so the fixture never moves because an app's dev-server port changed. */
const FIXED_BASE_URL = "http://localhost:5173";

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

/** Load the app's pack the same way ConfigService does: via its own .agenticqa.json. */
function loadPack(dir) {
  const cfgPath = path.join(dir, ".agenticqa.json");
  if (!fs.existsSync(cfgPath)) {
    return null;
  }
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  if (!cfg.knowledgePack) {
    return null;
  }
  const packPath = path.resolve(dir, cfg.knowledgePack);
  if (!fs.existsSync(packPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(packPath, "utf8"));
}

/**
 * Build the snapshot. Exported so the test regenerates it exactly the same way the script does —
 * two implementations of "how the fixture is produced" would be a fixture that tests itself.
 */
function buildCodegenSnapshot(appDir, templatesFile, repoRoot) {
  const pack = loadPack(appDir);
  const prompts = extractTemplatePrompts(templatesFile);

  const snapshot = {
    app: path.relative(repoRoot, appDir).replace(/\\/g, "/"),
    templates: path.relative(repoRoot, templatesFile).replace(/\\/g, "/"),
    baseUrl: FIXED_BASE_URL,
    packLoaded: !!pack,
    specs: {},
  };

  for (const p of prompts) {
    const plan = buildScenarioPlan(p.prompt, pack);
    // A prompt that abstains to the LLM path has no deterministic plan, and therefore no
    // deterministic codegen to lock. Record the abstention itself — if a prompt silently starts or
    // stops producing a plan, that is exactly as important as the code changing.
    snapshot.specs[p.index] = plan
      ? planToPlaywrightTs({
          plan,
          baseUrl: FIXED_BASE_URL,
          stepLocators: {},
          roleByName: {},
        })
      : null;
  }

  return snapshot;
}

module.exports = { buildCodegenSnapshot, loadPack, FIXED_BASE_URL };

if (require.main === module) {
  const repoRoot = repoRootFromHere();
  const appDir = path.resolve(repoRoot, arg("app", "apps/demo-web"));
  const templates = path.resolve(repoRoot, arg("templates", "benchmarks/TEST_TEMPLATES.md"));
  const out = arg("out", null);

  const snapshot = buildCodegenSnapshot(appDir, templates, repoRoot);
  const json = JSON.stringify(snapshot, null, 2);

  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(path.resolve(out), json + "\n", "utf8");
    const emitted = Object.values(snapshot.specs).filter(Boolean).length;
    console.log(
      `${snapshot.app}: ${emitted}/${Object.keys(snapshot.specs).length} prompts produced a spec -> ${out}`
    );
  } else {
    console.log(json);
  }
}
