import {
  Agent,
  RunContext,
  Logger,
  StepResultInfo,
  FailedStep,
} from "../../core/agent/types";
import { runPlaywright } from "../../executor";
import {
  deleteStepResultsForRun,
  insertStepResult,
  recordLocatorOutcome,
  recordSpecOutcome,
  updateTestRunReportPaths,
} from "../../core/db/db";
import { classifyFailure, mergeStepResultsByFile, attachScreenshotsToSteps } from "../../core/utils/report";
import { findLocatorForStepKey } from "../../core/utils/stepKeys";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/* ─── JSON report parser ─── */

interface JsonStep {
  title: string;
  duration: number;
  error?: { message?: string; stack?: string };
  steps?: JsonStep[];
}

interface JsonResult {
  status: string;
  duration: number;
  errors: Array<{ message?: string; stack?: string }>;
  steps: JsonStep[];
  attachments?: Array<{ name?: string; contentType?: string; path?: string }>;
}

interface JsonSpec {
  title: string;
  file: string;
  tests: Array<{ results: JsonResult[] }>;
}

function flattenSpecs(suites: any[]): JsonSpec[] {
  const out: JsonSpec[] = [];
  for (const suite of suites) {
    if (Array.isArray(suite.specs)) {
      for (const spec of suite.specs) {
        out.push({
          title: spec.title,
          file: spec.file ?? suite.file ?? "",
          tests: spec.tests ?? [],
        });
      }
    }
    if (Array.isArray(suite.suites)) {
      out.push(...flattenSpecs(suite.suites));
    }
  }
  return out;
}

function extractStepKey(title: string): string | null {
  const m = title.match(/STEP_ID=([\w-]+)/);
  return m ? m[1] : null;
}

function parseStepResults(steps: JsonStep[]): StepResultInfo[] {
  const out: StepResultInfo[] = [];
  for (const s of steps) {
    const stepKey = extractStepKey(s.title);
    if (stepKey) {
      out.push({
        stepKey,
        title: s.title,
        status: s.error ? "failed" : "passed",
        errorMessage: s.error?.message,
        durationMs: s.duration,
      });
    }
    if (s.steps?.length) {
      out.push(...parseStepResults(s.steps));
    }
  }
  return out;
}

async function tryReadJsonReport(reportPath: string): Promise<{
  specs: JsonSpec[];
  stepResults: StepResultInfo[];
  failedSteps: FailedStep[];
} | null> {
  try {
    const raw = await fs.readFile(reportPath, "utf8");
    const json = JSON.parse(raw);
    const specs = flattenSpecs(json.suites ?? []);

    if (specs.length === 0) {
      return { specs: [], stepResults: [], failedSteps: [] };
    }

    // Playwright runs the same spec once per browser project, producing one spec per project with
    // identical STEP_IDs. Group each project's step list BY SPEC FILE first, then merge cross-browser
    // within each file (dedup by stepKey, FAILED wins) — so a failure in any browser is surfaced, and
    // identical plan-step-N keys in DIFFERENT files (a "Run All") never collide. The report's `file`
    // is a basename; run() resolves it to a workspace-relative spec path.
    const byFile = new Map<string, StepResultInfo[][]>();
    const fileOrder: string[] = [];
    for (const spec of specs) {
      const file = spec.file || "";
      if (!byFile.has(file)) {
        byFile.set(file, []);
        fileOrder.push(file);
      }
      for (const test of spec.tests ?? []) {
        const lastResult = test.results[test.results.length - 1];
        if (lastResult) {
          const steps = parseStepResults(lastResult.steps ?? []);
          // Bind result-level screenshots (e.g. test-failed-1.png) to the failed step for the report.
          attachScreenshotsToSteps(steps, lastResult.attachments);
          byFile.get(file)!.push(steps);
        }
      }
    }

    const groups = fileOrder.map((file) => ({ file, perTest: byFile.get(file)! }));
    const { stepResults: allStepResults, failedSteps: failedByFile } =
      mergeStepResultsByFile(groups);

    const failedSteps: FailedStep[] = failedByFile.map((f) => ({
      stepId: f.stepKey,
      stepKey: f.stepKey,
      testRelPath: f.file, // basename; resolved to a workspace-relative path in run()
    }));

    return { specs, stepResults: allStepResults, failedSteps };
  } catch {
    return null;
  }
}

/* ─── agent ─── */

export class ExecutorAgent implements Agent {
  name = "ExecutorAgent";

  async run(ctx: RunContext, logger: Logger): Promise<void> {
    if (!ctx.testRelPath) throw new Error("No testRelPath to execute");

    logger.log(`Running Playwright on: ${ctx.testRelPath}`);
    let res;
    try {
      // When a single execution project is requested (e.g. explore mode → chromium-only), pass it
      // through; otherwise run the full configured browser matrix (the default for prompted tests).
      // The wall-clock budget scales with the work: one project when explore/pack-validation pins it,
      // otherwise the configured matrix (5 by default). A 28-step plan across 5 browsers needs far more
      // than a 6-step one — see `deriveRunTimeoutMs`.
      const steps = ctx.testPlan?.testCases?.reduce(
        (n: number, tc: any) => n + (tc?.steps?.length ?? 0),
        0
      );
      const projectNames = ctx.executionProjects;
      res = await runPlaywright(ctx.workspacePath, ctx.testRelPath, {
        ...(ctx.executionProject ? { project: ctx.executionProject } : {}),
        ...(projectNames?.length ? { projectNames } : {}),
        steps,
        // Budget scales with steps x browsers; an unpinned run still assumes the full matrix.
        projects: projectNames?.length ?? (ctx.executionProject ? 1 : undefined),
      });
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      // A timeout used to reject all the way to main.ts, aborting the run before any RUN_SUMMARY was
      // emitted — a hung test produced no report at all. Instead, classify it and continue so the
      // Reporter still surfaces the failure. (The self-heal gate excludes timeouts, so heal is skipped.)
      if (/timed out/i.test(msg)) {
        logger.log(`Executor: Playwright run timed out — ${msg}. Emitting a timeout failure summary.`);
        ctx.playwrightExitCode = 1;
        ctx.playwrightStdout = "";
        ctx.playwrightStderr = msg;
        ctx.failureText = msg;
        ctx.failureClass = classifyFailure(msg); // → "navigation-timeout"
        ctx.stepResults = [];
        ctx.failedSteps = [];
        return;
      }
      throw e; // non-timeout executor failures keep the existing abort behavior
    }

    ctx.playwrightExitCode = res.code;
    ctx.playwrightStdout = res.stdout;
    ctx.playwrightStderr = res.stderr;
    ctx.jsonReportPath = res.jsonReportPath;
    ctx.htmlReportDir = res.htmlReportDir;

    // ── Try JSON report (preferred) ──
    const parsed = await tryReadJsonReport(res.jsonReportPath);

    if (parsed) {
      ctx.stepResults = parsed.stepResults;

      // Resolve each failed step's spec path. The JSON report only carries basenames. For a single-file
      // run the target IS the spec, so use it verbatim (keeps the validated single-file heal path
      // byte-identical). For a "Run All" run_only the target is the testDir — reconstruct
      // <testDir>/<basename> so self-heal captures the correct spec rather than the directory.
      const runTarget = ctx.testRelPath ?? "";
      const targetIsSpecFile = /\.spec\.ts$/i.test(runTarget);
      const testDirBase = runTarget.replace(/[\\/]+$/, "");
      ctx.failedSteps = parsed.failedSteps.map((failed) => {
        let testRelPath = runTarget;
        if (!targetIsSpecFile && failed.testRelPath) {
          testRelPath = testDirBase
            ? `${testDirBase}/${failed.testRelPath}`
            : failed.testRelPath;
        }
        return { ...failed, testRelPath };
      });

      logger.log(
        `Executor: parsed JSON report — ${parsed.stepResults.length} step(s), ${parsed.specs.length} spec(s)`
      );

      if (ctx.failedSteps && ctx.failedSteps.length > 0) {
        ctx.failedStepId = ctx.failedSteps[0].stepId;

        logger.log(
          `Executor: ${ctx.failedSteps.length} failed step(s): ${ctx.failedSteps.map((f) => f.stepId).join(", ")}`
        );
      }

      // ── Store step_result rows in DB (skip during healing re-runs) ──
      if (ctx.testRunId && !ctx.isHealRerun) {
        await deleteStepResultsForRun(ctx.testRunId);
        for (const sr of parsed.stepResults) {
          await insertStepResult({
            testRunId: ctx.testRunId,
            stepKey: sr.stepKey ?? undefined,
            status: sr.status,
            errorMessage: sr.errorMessage,
          });
        }
        logger.log(
          `DB: stored ${parsed.stepResults.length} step_result row(s)`
        );

        // ── G4.2: the learning write path ──
        // Same guard as above, deliberately: a healing re-run must not be counted as fresh evidence, or
        // a locator gets credit for an outcome that a *patch* produced rather than the locator itself.
        if (ctx.projectId) {
          for (const sr of parsed.stepResults) {
            const locator = sr.stepKey
              ? findLocatorForStepKey(ctx.stepLocators, sr.stepKey)
              : undefined;
            if (sr.stepKey && locator) {
              await recordLocatorOutcome({
                projectId: ctx.projectId,
                stepKey: sr.stepKey,
                locator,
                passed: sr.status === "passed",
              });
            }
          }
          // One outcome per run for the spec as a whole — that is the granularity flakiness is asked at.
          if (ctx.testRelPath) {
            await recordSpecOutcome({
              projectId: ctx.projectId,
              specPath: ctx.testRelPath,
              passed: res.code === 0,
            });
          }
        }
      } else if (ctx.isHealRerun) {
        logger.log(
          `Executor: skipping DB step_result writes (healing re-run)`
        );
      }

      // ── Store report paths (always, even during re-runs) ──
      if (ctx.testRunId) {
        await updateTestRunReportPaths(
          ctx.testRunId,
          res.jsonReportPath,
          path.join(res.htmlReportDir, "index.html")
        );
      }
    } else {
      logger.log(
        "Executor: JSON report not found or unparseable — using stdout fallback"
      );

      const out = ctx.playwrightStdout ?? "";
      const lines = out.split(/\r?\n/);
      const fallbackFailed: FailedStep[] = [];

      for (const line of lines) {
        const stepMatch = line.match(/STEP_ID=([a-zA-Z0-9_-]+)/);
        if (!stepMatch) continue;

        const fileMatch = line.match(/(tests[\\/][^\s:]+\.spec\.ts)/);
        const testRelPath = fileMatch
          ? fileMatch[1].replace(/\\/g, "/")
          : ctx.testRelPath ?? "";

        fallbackFailed.push({
          stepId: stepMatch[1],
          stepKey: stepMatch[1],
          testRelPath,
        });
      }

      if (fallbackFailed.length > 0) {
        ctx.failedSteps = fallbackFailed;
        ctx.failedStepId = fallbackFailed[0].stepId;
        ctx.testRelPath = fallbackFailed[0].testRelPath;
      } else if (res.code !== 0) {
        for (const line of lines) {
          if (/^\s*[x×✗✘]\s+\d+/.test(line)) {
            const fm = line.match(/(tests[\\/][^\s:]+\.spec\.ts)/);
            if (fm) {
              ctx.testRelPath = fm[1].replace(/\\/g, "/");
              break;
            }
          }
        }
      }
    }

    ctx.failureText = (ctx.playwrightStdout ?? "").slice(0, 1500);

    // Classify the failure into an actionable bucket for the report + self-heal gating.
    if (ctx.playwrightExitCode !== 0) {
      const firstFailed = (ctx.stepResults ?? []).find((s) => s.status === "failed");
      ctx.failureClass = classifyFailure(firstFailed?.errorMessage ?? ctx.failureText);
      logger.log(`Executor: failure class = ${ctx.failureClass}`);
    } else {
      ctx.failureClass = undefined;
    }

    logger.log(`Playwright exit code: ${res.code}`);
    logger.log(`Playwright stdout:\n${res.stdout}`);
    if (res.stderr?.trim()) logger.log(`Playwright stderr:\n${res.stderr}`);
  }
}