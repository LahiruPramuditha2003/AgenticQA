#!/usr/bin/env node
/**
 * Dump `buildScenarioPlan()`'s output for every prompt in a templates file (G2.4).
 *
 * WHY THIS EXISTS
 * ---------------
 * G2.4 replaces ScenarioPlanner's regex ladder with retrieval. The acceptance bar is that demo-web's
 * deterministic plans stay **byte-identical**, and `buildScenarioPlan` is a pure function of
 * (request, pack) — so diffing its output over all 20 benchmark prompts is a complete, exact and
 * *offline* check. A live benchmark re-run cannot prove this: it also exercises the live page, the
 * grounding pass and (for unmatched prompts) an LLM, so a byte difference there is unattributable.
 *
 *   node scripts/snapshotScenarioPlans.js [--app=apps/demo-web] [--templates=TEST_TEMPLATES.md] [--out=f.json]
 *
 * With no --out it prints to stdout. Offline; needs only a build.
 */

const fs = require("node:fs");
const path = require("node:path");

const { extractTemplatePrompts, repoRootFromHere } = require("./extractTemplatePrompts");
const { buildScenarioPlan } = require("../dist/agents/TestPlannerAgent/ScenarioPlanner.js");

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const repoRoot = repoRootFromHere();
const appDir = path.resolve(repoRoot, arg("app", "apps/demo-web"));
const templates = path.resolve(repoRoot, arg("templates", "benchmarks/TEST_TEMPLATES.md"));
const out = arg("out", null);

/** Load the app's pack the same way ConfigService does: via its own .agenticqa.json. */
function loadPack(dir) {
  const cfgPath = path.join(dir, ".agenticqa.json");
  if (!fs.existsSync(cfgPath)) {return null;}
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  if (!cfg.knowledgePack) {return null;}
  const packPath = path.resolve(dir, cfg.knowledgePack);
  if (!fs.existsSync(packPath)) {return null;}
  return JSON.parse(fs.readFileSync(packPath, "utf8"));
}

const pack = loadPack(appDir);
const prompts = extractTemplatePrompts(templates);

const snapshot = {
  app: path.relative(repoRoot, appDir).replace(/\\/g, "/"),
  templates: path.relative(repoRoot, templates).replace(/\\/g, "/"),
  packLoaded: !!pack,
  plans: {},
};

for (const p of prompts) {
  snapshot.plans[p.index] = buildScenarioPlan(p.prompt, pack);
}

const json = JSON.stringify(snapshot, null, 2);
if (out) {
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(path.resolve(out), json + "\n", "utf8");
  const matched = Object.values(snapshot.plans).filter(Boolean).length;
  console.log(
    `${snapshot.app}: ${matched}/${prompts.length} prompts produced a deterministic plan -> ${out}`
  );
} else {
  console.log(json);
}
