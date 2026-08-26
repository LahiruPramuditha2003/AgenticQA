#!/usr/bin/env node
/**
 * Run the `generate_pack` pipeline against an app from the CLI (G2.7).
 *
 * The VS Code command "AgenticQA: Generate Knowledge Pack" does the same thing, but it needs the app
 * opened as the workspace root. This drives the orchestrator over the same stdio protocol the extension
 * uses, so a pack can be generated (and re-generated) reproducibly from a terminal.
 *
 *   node scripts/generatePack.js --app=apps/taskflow-web [--url=http://localhost:5174]
 *
 * Writes <app>/.agenticqa/knowledge.json, backing up any existing pack. Needs LLM creds for the richer
 * pack (it falls back to the deterministic floor without them) and a Playwright install in the target app
 * — every candidate flow is validated by actually running it, and only passers are kept.
 */

const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const readline = require("node:readline");

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const appRel = arg("app", "apps/taskflow-web");
const appDir = path.resolve(repoRoot, appRel);
const mainJs = path.join(__dirname, "..", "dist", "main.js");

if (!fs.existsSync(appDir)) {
  console.error(`No such app directory: ${appDir}`);
  process.exit(1);
}
if (!fs.existsSync(mainJs)) {
  console.error("dist/main.js missing — run `npm run build` in packages/orchestrator first.");
  process.exit(1);
}

const packPath = path.join(appDir, ".agenticqa", "knowledge.json");
const existed = fs.existsSync(packPath);
// Remember the pre-run state. Reporting whatever file happens to be on disk is how this script once
// announced "Pack written: 9 validated flow(s)" for a run that had died before the pipeline even
// started — the orchestrator exited on a config error and the script proudly described the OLD pack.
const mtimeBefore = existed ? fs.statSync(packPath).mtimeMs : 0;

console.log(`generate_pack -> ${appRel}`);
console.log(`  pack file : ${path.relative(repoRoot, packPath).replace(/\\/g, "/")}${existed ? " (exists — will be backed up)" : ""}`);
console.log("");

const child = spawn(process.execPath, [mainJs], {
  cwd: path.join(__dirname, ".."),
  stdio: ["pipe", "pipe", "inherit"],
});

let sent = false;
readline.createInterface({ input: child.stdout }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    console.log(line);
    return;
  }
  if (msg.type === "READY" && !sent) {
    sent = true;
    child.stdin.write(
      JSON.stringify({
        type: "NEW_REQUEST",
        text: "Generate the app knowledge pack",
        workspacePath: appDir,
        runMode: "generate_pack",
        overrides: { baseUrl: arg("url", undefined) },
      }) + "\n"
    );
    return;
  }
  if (msg.type === "LOG") {console.log(msg.message);}
  else if (msg.type === "ERROR") {console.error(`ERROR: ${msg.message}`);}
  else if (msg.type === "DONE") {child.stdin.end();}
});

child.on("exit", (code) => {
  console.log("");

  // Did the orchestrator ever accept the request? If it exits before READY (config error, crash), the
  // handshake never happens and nothing ran.
  if (!sent) {
    console.log("❌ The orchestrator exited before it was ready — the pack was NOT regenerated.");
    console.log("   Look above for a CONFIGURATION ERROR; nothing below this line has run.");
    process.exit(code || 1);
  }
  if (code) {
    console.log(`❌ The orchestrator exited with code ${code} — treat any pack on disk as STALE.`);
    process.exit(code);
  }
  if (!fs.existsSync(packPath)) {
    console.log("No pack was written. Check the log above — most often every candidate flow failed");
    console.log("validation (the flows were wrong) or errored (Playwright missing in the target app).");
    process.exit(1);
  }
  if (fs.statSync(packPath).mtimeMs === mtimeBefore) {
    console.log("⚠️  The pack file was NOT modified by this run — what follows is the PREVIOUS pack.");
    console.log("   The run finished without writing one; check the log for why.");
    process.exit(1);
  }
  const pack = JSON.parse(fs.readFileSync(packPath, "utf8"));
  const flows = Object.entries(pack.goldenFlows ?? {});
  console.log(`Pack written: ${flows.length} validated flow(s), ${Object.keys(pack.routes ?? {}).length} route(s), ` +
    `${Object.keys(pack.credentials ?? {}).length} credential group(s).`);
  for (const [k, f] of flows) {
    console.log(`  ${k.padEnd(24)} ${f.verified ? "[verified]" : "[UNVERIFIED]"} ${f.description ?? ""}`);
    if (f.tags?.length) {console.log(`  ${" ".repeat(24)} tags: ${f.tags.join(", ")}`);}
  }
  process.exit(code ?? 0);
});
