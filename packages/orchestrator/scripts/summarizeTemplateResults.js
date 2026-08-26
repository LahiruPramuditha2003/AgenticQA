const fs = require("fs");
const path = require("path");

function classifyFailure(text) {
  const t = String(text || "").toLowerCase();
  if (!t.trim()) return "unknown";
  if (t.includes("strict mode violation")) return "strict-mode";
  if (t.includes("element(s) not found") || t.includes("waiting for") && t.includes("getby")) {
    return "locator-not-found";
  }
  if (t.includes("tohaveurl") || t.includes("expected") && t.includes("received")) {
    return "assertion-mismatch";
  }
  if (t.includes("timeout") || t.includes("timed out")) return "navigation-timeout";
  if (t.includes("no baseline embedding")) return "state-precondition";
  if (t.includes("unsupported")) return "unsupported-scenario";
  return "unknown";
}

function summarizeTemplateResults(results) {
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = total - passed;
  const passRate = total === 0 ? 0 : Math.round((passed / total) * 10000) / 100;

  return {
    total,
    passed,
    failed,
    passRate,
    results,
  };
}

function printSummary(summary) {
  const rows = summary.results.map((r) => ({
    idx: String(r.index).padStart(2, " "),
    status: r.passed ? "PASS" : "FAIL",
    title: r.title,
    file: r.generatedFile || "-",
    failedStep: r.firstFailedStep || "-",
    failureClass: r.failureClass || "-",
    duration: `${Math.round((r.durationMs || 0) / 1000)}s`,
  }));

  console.log("");
  console.log("AgenticQA Template Benchmark");
  console.log("=".repeat(96));
  console.log(`Total: ${summary.total} | Passed: ${summary.passed} | Failed: ${summary.failed} | Pass rate: ${summary.passRate}%`);
  console.log("-".repeat(96));
  console.log(" # | STAT | Title                                | Failed Step       | Class              | Time");
  console.log("-".repeat(96));
  for (const row of rows) {
    console.log(
      `${row.idx} | ${row.status.padEnd(4)} | ${row.title.slice(0, 36).padEnd(36)} | ${row.failedStep.slice(0, 17).padEnd(17)} | ${row.failureClass.slice(0, 18).padEnd(18)} | ${row.duration}`
    );
  }
  console.log("=".repeat(96));
}

/* ─── Playwright JSON report parsing (pure, unit-tested offline) ─── */

function flattenReportSpecs(suites) {
  const out = [];
  for (const suite of suites || []) {
    if (Array.isArray(suite.specs)) {
      for (const spec of suite.specs) {
        out.push({ ...spec, file: spec.file || suite.file || "" });
      }
    }
    if (Array.isArray(suite.suites)) out.push(...flattenReportSpecs(suite.suites));
  }
  return out;
}

function extractStepKeyFromTitle(title) {
  const m = String(title || "").match(/STEP_ID=([\w-]+)/);
  return m ? m[1] : null;
}

function firstFailedStepFromSteps(steps) {
  for (const s of steps || []) {
    if (s.error) {
      const key = extractStepKeyFromTitle(s.title);
      if (key) return { stepKey: key, error: s.error.message || "" };
    }
    if (Array.isArray(s.steps)) {
      const nested = firstFailedStepFromSteps(s.steps);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * Parse a Playwright JSON report into per-spec, per-project pass/fail.
 * opts.projects (optional): only these browser projects count toward "passed".
 * Returns { specs: [{ file, title, projects:{name:status}, passed, firstFailedStep,
 *           firstError, failureClass }], projectNames: [...] }.
 */
function parsePlaywrightReport(report, opts = {}) {
  const allSpecs = flattenReportSpecs(report && report.suites);
  const projectFilter =
    opts.projects && opts.projects.length ? new Set(opts.projects) : null;
  const projectNames = new Set();

  // Playwright emits one spec per (file × project), so a single test file run across 5 browsers
  // appears as 5 separate specs. Group specs that share a file and merge their per-project tests
  // into ONE row — otherwise only the first project (chromium) would be reported.
  const byFile = new Map();
  for (const spec of allSpecs) {
    const key = spec.file || spec.title || "spec";
    if (!byFile.has(key)) byFile.set(key, { file: spec.file, title: spec.title, tests: [] });
    const g = byFile.get(key);
    g.tests.push(...(spec.tests || []));
    if (!g.title) g.title = spec.title;
  }

  const parsedSpecs = [...byFile.values()].map((group) => {
    const projects = {};
    let firstFailedStep = null;
    let firstError = null;

    for (const test of group.tests) {
      const proj = test.projectName || "default";
      projectNames.add(proj);
      if (projectFilter && !projectFilter.has(proj)) continue;

      const results = test.results || [];
      const last = results[results.length - 1];
      const status = last ? last.status : "unknown"; // passed|failed|timedOut|skipped|interrupted
      projects[proj] = status;

      if (status !== "passed" && status !== "skipped") {
        const ff = firstFailedStepFromSteps(last && last.steps);
        if (ff && !firstFailedStep) {
          firstFailedStep = ff.stepKey;
          if (!firstError) firstError = ff.error;
        }
        if (!firstError && last && last.errors && last.errors[0]) {
          firstError = last.errors[0].message || null;
        }
      }
    }

    const statuses = Object.values(projects);
    const passed =
      statuses.length > 0 &&
      statuses.every((s) => s === "passed" || s === "skipped");

    return {
      file: group.file,
      title: group.title,
      projects,
      passed,
      firstFailedStep,
      firstError,
      failureClass: passed ? null : classifyFailure(firstError || ""),
    };
  });

  return { specs: parsedSpecs, projectNames: Array.from(projectNames) };
}

function abbreviateProject(name) {
  const map = {
    chromium: "chrom",
    firefox: "ffox",
    webkit: "webkit",
    "Mobile Chrome": "mChr",
    "Mobile Safari": "mSaf",
  };
  return map[name] || String(name).slice(0, 6);
}

function statusMark(status) {
  if (status === "passed") return "PASS";
  if (status === "skipped") return "skip";
  if (status === undefined) return "-";
  return "FAIL";
}

/** Print a per-browser matrix table for benchmark rows that carry a `perProject` map. */
function printMatrix(results, projectNames) {
  const projs = projectNames || [];
  console.log("");
  console.log("AgenticQA Template Benchmark — per-browser matrix");
  console.log("=".repeat(100));
  console.log(
    " # | " +
      projs.map((p) => abbreviateProject(p).padEnd(6)).join(" | ") +
      " | Title"
  );
  console.log("-".repeat(100));
  for (const r of results) {
    const cells = projs
      .map((p) => statusMark(r.perProject && r.perProject[p]).padEnd(6))
      .join(" | ");
    console.log(
      `${String(r.index).padStart(2)} | ${cells} | ${String(r.title).slice(0, 30)}`
    );
  }
  const allPass = results.filter((r) => r.passed).length;
  console.log("-".repeat(100));
  console.log(
    `Fully passing (all required projects): ${allPass}/${results.length}`
  );
  console.log("=".repeat(100));
}

if (require.main === module) {
  const file = process.argv[2] || path.resolve(__dirname, "../batch-template-run-results.json");
  const raw = fs.readFileSync(file, "utf8");
  const parsed = JSON.parse(raw);
  const summary = Array.isArray(parsed.results) ? parsed : summarizeTemplateResults(parsed);
  printSummary(summary);
}

/**
 * Print the substance audit next to the raw pass rate (G1.3b / D13).
 *
 * The raw rate answers "did Playwright report green?". It cannot distinguish a real test from one whose
 * assertions were dropped — on the held-out app it read 19/20 while ~1/20 tested what was asked. The
 * substantive rate is the honest number; when the two diverge, trust this one.
 */
function printSubstance(results) {
  const rows = results.filter((r) => r && r.substance);
  if (rows.length === 0) return;

  const VERDICT_NOTE = {
    VACUOUS: "no assertions — cannot fail",
    OFF_TARGET: "asserts something the prompt never mentioned",
    UNDER_TESTED: "skips an interaction the prompt asked for",
    SUBSTANTIVE: "",
  };

  console.log("");
  console.log("Spec substance audit — what the generated tests actually exercise");
  console.log("=".repeat(100));
  console.log(
    " # | RAW  | act | asrt | VERDICT       | Why".padEnd(100)
  );
  console.log("-".repeat(100));
  for (const r of results) {
    const s = r.substance;
    if (!s) {
      console.log(
        `${String(r.index).padStart(2)} | ${(r.passed ? "PASS" : "FAIL").padEnd(4)} |  -  |  -   | (no spec)     |`
      );
      continue;
    }
    console.log(
      `${String(r.index).padStart(2)} | ${(r.passed ? "PASS" : "FAIL").padEnd(4)} | ` +
        `${String(s.interactions).padStart(3)} | ${String(s.assertions).padStart(4)} | ` +
        `${s.verdict.padEnd(13)} | ${String(s.reason).slice(0, 44)}`
    );
  }
  console.log("-".repeat(100));

  const counts = rows.reduce((acc, r) => {
    acc[r.substance.verdict] = (acc[r.substance.verdict] || 0) + 1;
    return acc;
  }, {});
  const substantive = counts.SUBSTANTIVE || 0;
  const rawPassed = results.filter((r) => r.passed).length;
  const pct = (n) => `${Math.round((n / results.length) * 1000) / 10}%`;

  for (const [verdict, note] of Object.entries(VERDICT_NOTE)) {
    if (counts[verdict]) {
      console.log(`  ${verdict.padEnd(13)} ${String(counts[verdict]).padStart(2)}${note ? `   (${note})` : ""}`);
    }
  }
  console.log("-".repeat(100));
  console.log(`  Raw pass rate:          ${rawPassed}/${results.length}  (${pct(rawPassed)})`);
  console.log(`  SUBSTANTIVE pass rate:  ${substantive}/${results.length}  (${pct(substantive)})   ← the honest number`);
  if (substantive < rawPassed) {
    console.log(
      `  ⚠ ${rawPassed - substantive} test(s) passed without testing what was asked. See docs/BENCHMARKS.md.`
    );
  }
  console.log("=".repeat(100));
}

module.exports = {
  classifyFailure,
  printSummary,
  summarizeTemplateResults,
  parsePlaywrightReport,
  flattenReportSpecs,
  printMatrix,
  printSubstance,
};
