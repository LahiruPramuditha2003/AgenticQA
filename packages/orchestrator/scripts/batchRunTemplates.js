#!/usr/bin/env node
/**
 * Template benchmark harness — the accuracy measurement instrument.
 *
 * For each numbered prompt in a templates markdown file, runs the full orchestrator
 * (generate_and_run) against a target app, then reads the Playwright JSON report to compute
 * REAL per-browser pass/fail. Writes an incremental JSON summary and prints a matrix table.
 *
 * Usage (run from packages/orchestrator after `npm run build`):
 *   node scripts/batchRunTemplates.js [--from=1] [--to=20] [--project=chromium[,firefox]]
 *                                     [--keep-tests] [--save-logs] [--json] [--base-url=http://localhost:5173]
 *                                     [--exec-project=chromium]
 *                                     [--app=apps/demo-web] [--templates=TEST_TEMPLATES.md]
 *
 * `--app` / `--templates` (G0.5) take a path absolute or relative to the repo root, and default to
 * `apps/demo-web` + `TEST_TEMPLATES.md` — so the bare invocation behaves exactly as it always has.
 * Everything app-specific (base URL, dev-server command + cwd, testDir) is read from the target app's
 * OWN `.agenticqa.json`, so pointing this at a second app needs no code change. Results and artifacts
 * are named per app, so runs against different apps don't clobber each other.
 *
 * Example — the held-out app:
 *   node scripts/batchRunTemplates.js --app=apps/taskflow-web \
 *        --templates=TEST_TEMPLATES_TASKFLOW.md --project=chromium
 *
 * NOTE: invoke node DIRECTLY for custom ranges. `npm run batch:templates -- --from=1 --to=3`
 * does not reliably forward the flags in this repo's workspace setup (they get dropped and it
 * runs 1..20). `npm run batch:templates` is fine only for the default full 1..20 run.
 *
 * Prerequisites for a LIVE run: the app's dev server (auto-started from its config if not already up)
 * and orchestrator/.env LLM keys. Docker/Postgres is OPTIONAL (generate-and-run works without it;
 * healing/history need it).
 *
 * Scope: this is a RUNNER, not an evaluation harness. Ablation matrices and per-component metrics are
 * deliberately out of scope — see docs/BENCHMARKS.md for what IS measured, and why.
 */

const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const http = require("http");

const { extractTemplatePrompts, repoRootFromHere } = require("./extractTemplatePrompts");
const {
  parsePlaywrightReport,
  summarizeTemplateResults,
  printSummary,
  printMatrix,
  printSubstance,
} = require("./summarizeTemplateResults");
const { auditSpecSubstance } = require("./auditSpecSubstance");

/* ─── args ─── */

function getArg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
}
function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const fromIdx = parseInt(getArg("from", "1"), 10);
const toIdx = parseInt(getArg("to", "20"), 10);
const keepTests = hasFlag("keep-tests");
const emitJson = hasFlag("json");
// Failures always persist their log. `--save-logs` keeps the PASSING ones too, which is what you need
// when a test passes for the wrong reason - the substance audit flags that, but only the orchestrator
// log says which stage (retrieval, grounding, locator resolution) made the decision.
const saveLogs = hasFlag("save-logs");
// ⚠️ Distinct from `--project`, and the difference matters. `--project` is a SCORING filter: which
// browsers must pass for a prompt to count. `--exec-project` is an EXECUTION filter: which browsers the
// orchestrator runs at all. Without it every run executes the full configured matrix serially (D6), so a
// verification loop over one prompt costs 5x what it needs to. Defaults to unset = full matrix, so the
// headline demo-web 20/20-across-5-browsers number is produced by exactly the command it always was.
const execProject = getArg("exec-project", "");
const projectsArg = getArg("project", "");
const projects = projectsArg
  ? projectsArg.split(",").map((s) => s.trim()).filter(Boolean)
  : null; // null = every project found in the report counts

/* ─── target app + templates (G0.5) ─── */

const repoRoot = repoRootFromHere();
const orchestratorDir = path.resolve(__dirname, "..");
const mainJs = path.join(orchestratorDir, "dist", "main.js");

/** Resolve a CLI path arg: absolute wins, otherwise relative to the repo root. */
function resolveFromRepo(p) {
  return path.isAbsolute(p) ? p : path.join(repoRoot, p);
}

const appDir = resolveFromRepo(getArg("app", path.join("apps", "demo-web")));
const templatePath = resolveFromRepo(getArg("templates", "benchmarks/TEST_TEMPLATES.md"));
/** Short, filesystem-safe label for artifact names, e.g. "demo-web". */
const appName = path.basename(appDir).replace(/[^\w.-]+/g, "-") || "app";

/** The target app's own .agenticqa.json — the single source of app-specific settings. */
function readAppConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(appDir, ".agenticqa.json"), "utf8"));
  } catch {
    return {};
  }
}
const appCfg = readAppConfig();

// --base-url wins; otherwise the app's configured baseUrl; otherwise the historical default.
const baseUrl = getArg("base-url", appCfg.baseUrl || "http://localhost:5173");

const reportPath = path.join(appDir, "test-results", "agenticqa-results.json");
const generatedDir = path.join(appDir, appCfg.testDir || "tests/generated");
// Per-app names so a demo-web run and a held-out-app run don't overwrite each other.
const outputPath = path.join(orchestratorDir, `batch-results-${appName}.json`);
const artifactsDir = path.join(orchestratorDir, "batch-artifacts", appName);

/* ─── helpers ─── */

function cleanGeneratedSpecs() {
  try {
    for (const f of fs.readdirSync(generatedDir)) {
      if (f.endsWith(".spec.ts")) fs.rmSync(path.join(generatedDir, f), { force: true });
    }
  } catch {
    /* dir may not exist yet */
  }
}

function safeUnlink(p) {
  try {
    fs.rmSync(p, { force: true });
  } catch {
    /* ignore */
  }
}

function preflight() {
  if (!fs.existsSync(appDir)) {
    console.error(`Cannot find the target app at ${appDir}\nPass --app=<dir> (absolute, or relative to the repo root).`);
    process.exit(1);
  }
  if (!fs.existsSync(path.join(appDir, ".agenticqa.json"))) {
    console.error(
      `${appDir} has no .agenticqa.json — the runner reads baseUrl / testDir / webServer from it.\n` +
        `Create one before benchmarking this app.`
    );
    process.exit(1);
  }
  if (!fs.existsSync(templatePath)) {
    console.error(`Cannot find the templates file at ${templatePath}\nPass --templates=<file.md>.`);
    process.exit(1);
  }
  if (!fs.existsSync(mainJs)) {
    console.error(`Orchestrator not built: ${mainJs}\nRun: npm run build`);
    process.exit(1);
  }
}

/* ─── run ─── */

function runOne(prompt) {
  if (!keepTests) cleanGeneratedSpecs();
  safeUnlink(reportPath);

  const request = {
    type: "NEW_REQUEST",
    text: prompt.prompt,
    workspacePath: appDir,
    runMode: "generate_and_run",
    overrides: { baseUrl, startUrl: "/" },
    // ⚠️ **The benchmark asks for the full matrix explicitly.** Since G5.1 a prompted run defaults to
    // chromium only, which is right for an inner loop and wrong here: the headline number is
    // "20/20 across five browsers", and if this harness inherited the new default that claim would
    // quietly start meaning "20/20 on chromium" without a single line of output changing.
    execution: execProject ? { project: execProject } : { allProjects: true },
  };

  const started = Date.now();
  const proc = cp.spawnSync("node", [mainJs], {
    cwd: orchestratorDir,
    input: JSON.stringify(request) + "\n",
    encoding: "utf8",
    env: process.env,
    maxBuffer: 1024 * 1024 * 20,
  });
  const durationMs = Date.now() - started;

  // Read the Playwright report this run produced (if any).
  let parsed = null;
  if (fs.existsSync(reportPath)) {
    try {
      parsed = parsePlaywrightReport(JSON.parse(fs.readFileSync(reportPath, "utf8")), {
        projects,
      });
    } catch (e) {
      parsed = null;
    }
  }

  const spec = parsed && parsed.specs[0];
  const generatedFile = spec
    ? path.basename(spec.file || "")
    : (proc.stdout.match(/tests[\\/]generated[\\/]([\w.-]+\.spec\.ts)/) || [])[1] || "";

  const row = {
    index: prompt.index,
    title: prompt.title,
    prompt: prompt.prompt,
    exitCode: proc.status,
    durationMs,
    generatedFile,
    passed: spec ? spec.passed : false,
    perProject: spec ? spec.projects : {},
    projectNames: parsed ? parsed.projectNames : [],
    firstFailedStep: spec ? spec.firstFailedStep : null,
    failureClass: spec
      ? spec.failureClass
      : proc.status === 0
        ? "no-report"
        : "generation-error",
    firstError: spec ? spec.firstError : (proc.stderr || "").slice(-400) || null,
  };

  // Audit what the generated spec actually TESTS (G1.3b / D13). Playwright pass/fail cannot tell a real
  // test from one whose assertions were dropped, so this second signal is recorded alongside it.
  try {
    if (generatedFile) {
      const specPath = path.join(generatedDir, generatedFile);
      if (fs.existsSync(specPath)) {
        row.substance = auditSpecSubstance({
          specSource: fs.readFileSync(specPath, "utf8"),
          prompt: prompt.prompt,
          startPath: "/",
        });
      }
    }
  } catch {
    /* non-fatal — the audit is diagnostic only */
  }

  // Preserve the generated spec for offline diagnosis (survives the next prompt's clean).
  try {
    if (generatedFile) {
      const src = path.join(generatedDir, generatedFile);
      if (fs.existsSync(src)) {
        fs.mkdirSync(artifactsDir, { recursive: true });
        const dest = path.join(
          artifactsDir,
          `prompt-${String(prompt.index).padStart(2, "0")}-${row.passed ? "PASS" : "FAIL"}.spec.ts`
        );
        fs.copyFileSync(src, dest);
        row.savedSpec = path.relative(orchestratorDir, dest).replace(/\\/g, "/");
      }
    }
  } catch {
    /* non-fatal */
  }

  // For failures (esp. crashes with no Playwright report), persist the orchestrator output so the
  // root cause is diagnosable offline.
  try {
    if (!row.passed || saveLogs) {
      fs.mkdirSync(artifactsDir, { recursive: true });
      const log = `=== PROMPT ${prompt.index}: ${prompt.title} ===\nexit=${proc.status} class=${row.failureClass}\n\n=== STDOUT ===\n${proc.stdout || ""}\n\n=== STDERR ===\n${proc.stderr || ""}`;
      fs.writeFileSync(
        path.join(
          artifactsDir,
          `prompt-${String(prompt.index).padStart(2, "0")}-${row.passed ? "PASS" : "FAIL"}.log`
        ),
        log
      );
    }
  } catch {
    /* non-fatal */
  }

  if (proc.error) row.spawnError = proc.error.message;
  return row;
}

/* ─── dev server (keep ONE running for the whole batch) ─── */

function ping(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (r) => {
      r.resume();
      resolve(r.statusCode > 0 && r.statusCode < 500);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function ensureDevServer() {
  if (await ping(baseUrl)) {
    console.log(`Dev server already running at ${baseUrl} — reusing for the whole batch.`);
    return null;
  }
  // Start it the way the app itself declares (.agenticqa.json webServer), so this works for any target.
  const command = appCfg.webServer?.command || "npm run dev";
  const cwd = path.resolve(appDir, appCfg.webServer?.cwd || ".");
  console.log(`Starting dev server for the batch (${baseUrl}): \`${command}\` in ${cwd}`);
  const proc = cp.spawn(command, {
    cwd,
    shell: true,
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await ping(baseUrl)) {
      console.log("Dev server ready.");
      return proc;
    }
  }
  console.warn("Dev server did not become reachable in 60s; continuing anyway.");
  return proc;
}

function stopDevServer(proc) {
  if (!proc || !proc.pid) return;
  try {
    if (process.platform === "win32") {
      cp.spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { shell: true, stdio: "ignore" });
    } else {
      proc.kill("SIGTERM");
    }
  } catch {
    /* ignore */
  }
}

/* ─── main ─── */

(async () => {
  preflight();

  // Fresh artifacts each run so stale PASS/FAIL specs don't linger.
  fs.rmSync(artifactsDir, { recursive: true, force: true });

  const allPrompts = extractTemplatePrompts(templatePath);
  const prompts = allPrompts.filter((p) => p.index >= fromIdx && p.index <= toIdx);

  if (prompts.length === 0) {
    console.error(`No prompts in range ${fromIdx}..${toIdx} (found ${allPrompts.length} total).`);
    process.exit(1);
  }

  // A single standing dev server avoids per-prompt start/stop churn (which caused 120s timeouts).
  const devServer = await ensureDevServer();

  console.log(
    `Running prompts ${fromIdx}..${toIdx} (${prompts.length}) against ${appDir}` +
      `\n  templates: ${path.relative(repoRoot, templatePath).replace(/\\/g, "/")}` +
      `  |  baseUrl: ${baseUrl}` +
      (projects ? `  |  required projects: ${projects.join(", ")}` : "  |  all projects")
  );

  const results = [];
  const projectNamesSeen = new Set();

  try {
    for (let i = 0; i < prompts.length; i++) {
      const p = prompts[i];
      console.log(`\n=== [${i + 1}/${prompts.length}] Prompt ${p.index}: ${p.title} ===`);
      const row = runOne(p);
      for (const n of row.projectNames) projectNamesSeen.add(n);
      results.push(row);

      // incremental write so a crash mid-run still leaves partial data
      fs.writeFileSync(
        outputPath,
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            // Provenance: a results file is meaningless without knowing which app/templates produced it.
            app: path.relative(repoRoot, appDir).replace(/\\/g, "/"),
            templates: path.relative(repoRoot, templatePath).replace(/\\/g, "/"),
            baseUrl,
            from: fromIdx,
            to: toIdx,
            projects,
            results,
          },
          null,
          2
        )
      );

      console.log(
        `  → ${row.passed ? "PASS" : "FAIL"} (exit=${row.exitCode}, ${Math.round(
          row.durationMs / 1000
        )}s)` +
          (row.passed ? "" : ` class=${row.failureClass} step=${row.firstFailedStep || "-"}`)
      );
    }
  } finally {
    if (devServer) {
      console.log("Stopping batch dev server...");
      stopDevServer(devServer);
    }
  }

  /* ─── summary ─── */

  const projectNames = projects && projects.length ? projects : Array.from(projectNamesSeen);
  printMatrix(results, projectNames);
  printSummary(summarizeTemplateResults(results));
  printSubstance(results);

  console.log(`\nResults written to ${outputPath}`);
  if (emitJson) {
    console.log("JSON_SUMMARY_START");
    console.log(
      JSON.stringify({
        app: path.relative(repoRoot, appDir).replace(/\\/g, "/"),
        templates: path.relative(repoRoot, templatePath).replace(/\\/g, "/"),
        from: fromIdx,
        to: toIdx,
        projects: projectNames,
        results,
      })
    );
    console.log("JSON_SUMMARY_END");
  }

  const fullyPassed = results.filter((r) => r.passed).length;
  const passRate = Math.round((fullyPassed / results.length) * 1000) / 10;
  console.log(`\n${appName}: ${fullyPassed}/${results.length} prompts fully passed (${passRate}%).`);
  // Always exit 0: a partial pass rate is expected benchmark data, not a script failure. (Exiting
  // non-zero made `npm run` print a misleading "npm error" block.) Use --json to consume results.
  process.exitCode = 0;
})();
