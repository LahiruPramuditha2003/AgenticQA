#!/usr/bin/env node
/**
 * Re-score already-saved benchmark artifacts with the substance auditor (G1.3b) — no live re-run needed.
 *
 * Reads `batch-artifacts/<app>/prompt-NN-*.spec.ts` plus the prompts that produced them, and prints the
 * same audit the live runner now emits. Useful for re-grading historical runs after the auditor changes.
 *
 *   node scripts/auditSavedArtifacts.js --app=taskflow-web --templates=TEST_TEMPLATES_TASKFLOW.md
 *   node scripts/auditSavedArtifacts.js --app=demo-web     --templates=TEST_TEMPLATES.md
 */

const fs = require("node:fs");
const path = require("node:path");

const { extractTemplatePrompts, repoRootFromHere } = require("./extractTemplatePrompts");
const { auditSpecSubstance } = require("./auditSpecSubstance");
const { printSubstance } = require("./summarizeTemplateResults");

function getArg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
}

const repoRoot = repoRootFromHere();
const orchestratorDir = path.resolve(__dirname, "..");
const appName = getArg("app", "demo-web");
const templatesArg = getArg("templates", "benchmarks/TEST_TEMPLATES.md");
const templatePath = path.isAbsolute(templatesArg)
  ? templatesArg
  : path.join(repoRoot, templatesArg);
const artifactsDir = path.join(orchestratorDir, "batch-artifacts", appName);

if (!fs.existsSync(artifactsDir)) {
  console.error(`No saved artifacts at ${artifactsDir}. Run the benchmark first.`);
  process.exit(1);
}

const prompts = new Map(extractTemplatePrompts(templatePath).map((p) => [p.index, p]));

const results = [];
for (const file of fs.readdirSync(artifactsDir).sort()) {
  const m = /^prompt-(\d+)-(PASS|FAIL)\.spec\.ts$/.exec(file);
  if (!m) continue;
  const index = Number(m[1]);
  const prompt = prompts.get(index);
  results.push({
    index,
    title: prompt ? prompt.title : `prompt ${index}`,
    passed: m[2] === "PASS",
    substance: auditSpecSubstance({
      specSource: fs.readFileSync(path.join(artifactsDir, file), "utf8"),
      prompt: prompt ? prompt.prompt : "",
      startPath: "/",
    }),
  });
}

if (results.length === 0) {
  console.error(`No prompt-NN-*.spec.ts files in ${artifactsDir}.`);
  process.exit(1);
}

console.log(`Re-scoring ${results.length} saved spec(s) for ${appName} against ${templatesArg}`);
printSubstance(results);
