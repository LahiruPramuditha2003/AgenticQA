import { spawn } from "node:child_process";
import * as path from "node:path";

export interface PlaywrightResult {
  code: number;
  stdout: string;
  stderr: string;
  jsonReportPath: string;
  htmlReportDir: string;
}

/** Historical floor — every run that fit in 300s before must still fit. */
export const MIN_RUN_TIMEOUT_MS = 300000;
/** Ceiling, so a genuine hang is still bounded. */
export const MAX_RUN_TIMEOUT_MS = 900000;

/**
 * Wall-clock budget for one `npx playwright test` invocation, derived from the work it has to do:
 * a fixed startup allowance plus a per-(step × project) slice. Clamped to [300s, 900s].
 */
export function deriveRunTimeoutMs(steps?: number, projects?: number): number {
  // Unknown step count -> the historical flat cap, exactly. Callers that can't say how much work the
  // spec is (the self-heal capture re-run, for one) get precisely the behaviour they had before.
  if (!Number.isFinite(steps) || (steps as number) <= 0) {return MIN_RUN_TIMEOUT_MS;}
  const p = Number.isFinite(projects) && (projects as number) > 0 ? (projects as number) : 5;
  const budget = 120000 + (steps as number) * p * 4000;
  return Math.min(MAX_RUN_TIMEOUT_MS, Math.max(MIN_RUN_TIMEOUT_MS, budget));
}

export async function runPlaywright(
  workspacePath: string,
  testFileRelPath: string,
  opts?: {
    timeoutMs?: number;
    /** A single project. Prefer `projectNames` — kept because several call sites pin exactly one. */
    project?: string;
    /** Browser projects to run. Empty/omitted = whatever the app's playwright.config defines. */
    projectNames?: string[];
    reporter?: string;
    /** Step count of the spec being run — scales the wall-clock budget. */
    steps?: number;
    /** Number of browser projects the spec will run against. */
    projects?: number;
    /**
     * Playwright `--output` directory for this invocation.
     *
     * ⚠️ **Playwright CLEARS its output directory at the start of every run**, and the JSON report lives
     * inside `test-results/`. So a second invocation — even one with `reporter: "list"` that writes no
     * report of its own — **deletes the report the first run produced**. That is not theoretical: the
     * self-heal capture run wiped the original failure's report, and when the heal then found no
     * replacement (so there was no patched re-run to regenerate it), the benchmark read nothing and
     * classified a perfectly ordinary `locator-not-found` as the opaque `no-report`. Give a throwaway run
     * its own directory.
     */
    outputDir?: string;
  }
): Promise<PlaywrightResult> {
  const jsonReportRel = "test-results/agenticqa-results.json";
  const htmlReportDir = "playwright-report";
  // Per-test timeout is 60s (below). The whole `npx playwright test` run executes the spec once
  // PER configured browser project, serially (--workers=1) — so the wall time scales with
  // steps × projects, and a single fixed cap cannot be right for both.
  //
  // ⚠️ It used to be a flat 300s, which was sized for the 5–12-step plans the deterministic planner
  // produces. The moment the LLM path came back to life it authored a legitimate 28-step plan for
  // demo-web's prompt 14; five browsers of that ran past 300s and were killed, and a killed run has no
  // Playwright report at all — so it surfaced as `no-report` with no failing step to look at, which
  // reads like a crash rather than "we didn't wait long enough". The budget is now derived from the
  // work, and never shrinks below the historical 300s.
  const timeout = opts?.timeoutMs ?? deriveRunTimeoutMs(opts?.steps, opts?.projects);
  // Default reporters write the shared json/html report. The self-heal capture run overrides this
  // (e.g. `reporter: "list"`) so it doesn't clobber the real failure report, and passes
  // `project: "chromium"` to run a single browser.
  const reporter = opts?.reporter ?? "list,json,html";

  const args = [
    "playwright",
    "test",
    testFileRelPath,
    "--workers=1",
    "--timeout=60000",
    `--reporter=${reporter}`,
  ];
  // Playwright accepts repeated --project flags; omitting them runs the whole configured matrix.
  const wanted = opts?.projectNames?.length ? opts.projectNames : opts?.project ? [opts.project] : [];
  for (const name of wanted) {args.push(`--project=${name}`);}
  if (opts?.outputDir) {args.push(`--output=${opts.outputDir}`);}

  return new Promise((resolve, reject) => {
    const child = spawn(
      "npx",
      args,
      {
        cwd: workspacePath,
        shell: true,
        env: {
          ...process.env,
          PLAYWRIGHT_JSON_OUTPUT_NAME: jsonReportRel,
          PLAYWRIGHT_HTML_OPEN: "never",
        },
      }
    );

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // On Windows, also try taskkill for child processes
      if (process.platform === "win32") {
        try {
          spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
            shell: true,
            stdio: "ignore",
          });
        } catch {
          // Ignore taskkill errors
        }
      }
      reject(new Error(`Playwright test timed out after ${timeout}ms`));
    }, timeout);

    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));

    child.on("close", (code) => {
      if (!timedOut) {
        clearTimeout(timeoutId);
        resolve({
          code: code ?? 1,
          stdout,
          stderr,
          jsonReportPath: path.join(workspacePath, jsonReportRel),
          htmlReportDir: path.join(workspacePath, htmlReportDir),
        });
      }
    });

    child.on("error", (err) => {
      if (!timedOut) {
        clearTimeout(timeoutId);
        reject(err);
      }
    });
  });
}