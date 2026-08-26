/**
 * Pure builder: a RunSummary → a single self-contained, professional HTML report (light/corporate).
 *
 * The SAME output is used two ways:
 *  - rendered in a VS Code webview (the in-editor "branded report"), with `interactive: true` so the
 *    "Open full Playwright report" button can postMessage back to the extension; and
 *  - written to disk and printed to PDF (export) — `window.print()` + a print stylesheet.
 *
 * No VS Code / fs imports here, so it stays unit-testable and portable (opens in any browser). Screenshots
 * are rendered from `step.screenshots` exactly as given — the extension inlines them as `data:` URIs before
 * calling this builder (so the builder stays pure and the CSP `img-src data:` is satisfied).
 */

import type { RunSummary, StepSummary } from "../views/RunTreeProvider";

export interface BuildReportOptions {
  /** When true, wire the "Open full Playwright report" button to the VS Code message channel. */
  interactive?: boolean;
  /** CSP nonce for the inline script. A fixed value keeps unit-test output deterministic. */
  nonce?: string;
  /** When true, open the print dialog automatically on load (used by the PDF export). */
  autoPrint?: boolean;
  /** Optional extension version, shown in the footer. */
  version?: string;
}

/** Actionable one-liner per failure class — reused by the sidebar. */
export const FAILURE_TIPS: Record<string, string> = {
  "locator-not-found":
    "An element wasn't found — the UI likely changed. Re-run to let self-healing repair the locator, or refine the step's target.",
  "strict-mode":
    "The locator matched multiple elements. Make the target more specific (exact text, a role, or a test id).",
  "assertion-mismatch":
    "An expected value didn't match what's on the page. Check the expected text/URL against the real app.",
  "navigation-timeout":
    "A navigation or wait timed out. The page may be slow or the dev server unreachable — confirm the app is running.",
  "state-precondition":
    "A precondition wasn't met (e.g. empty cart, not logged in). Add the missing setup steps before the assertion.",
  "unsupported-scenario":
    "This scenario isn't supported by the generator yet. Try rephrasing the request into concrete UI actions.",
  unknown: "Cause unclear — open the full Playwright report below for the trace and screenshots.",
};

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

function stripAnsi(s: string): string {
  return s.replace(/\[[0-9;]*m/g, "").split(String.fromCharCode(27)).join("");
}

function fmtDuration(ms: number | undefined): string {
  if (typeof ms !== "number" || !isFinite(ms) || ms < 0) {return "";}
  if (ms < 1000) {return `${Math.round(ms)}ms`;}
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`;
}

function stepIcon(step: StepSummary): string {
  if (step.healed) {return "🔧";}
  return step.status === "passed" ? "✔" : "✘";
}

/** SVG donut showing pass rate. Green at 100%, red at 0%, amber in between. */
function renderRing(passed: number, total: number): string {
  const pct = total > 0 ? Math.max(0, Math.min(1, passed / total)) : 0;
  const r = 52;
  const c = 2 * Math.PI * r;
  const off = c * (1 - pct);
  const color = pct >= 1 ? "var(--green)" : passed === 0 ? "var(--red)" : "var(--amber)";
  return `<svg viewBox="0 0 120 120" class="ring" role="img" aria-label="${Math.round(pct * 100)}% passed">
    <circle cx="60" cy="60" r="${r}" class="ring-track"></circle>
    <circle cx="60" cy="60" r="${r}" class="ring-val"
      style="stroke:${color};stroke-dasharray:${c.toFixed(1)};stroke-dashoffset:${off.toFixed(1)}"></circle>
    <text x="60" y="56" class="ring-pct">${Math.round(pct * 100)}%</text>
    <text x="60" y="78" class="ring-sub">${passed}/${total}</text>
  </svg>`;
}

function renderStep(step: StepSummary, maxDur: number): string {
  const dur = fmtDuration(step.durationMs);
  const desc = step.description?.trim() || step.stepKey || "step";
  const num = typeof step.index === "number" ? `<span class="step-num">${step.index}</span>` : "";
  const cls = step.healed ? "healed" : step.status;
  const barPct =
    maxDur > 0 && typeof step.durationMs === "number"
      ? Math.max(2, Math.round((step.durationMs / maxDur) * 100))
      : 0;

  let extra = "";
  if (step.status === "failed" && step.errorMessage) {
    const firstLines = stripAnsi(step.errorMessage)
      .split("\n")
      .filter((l) => l.trim())
      .slice(0, 6)
      .join("\n");
    extra += `<pre class="err">${esc(firstLines)}</pre>`;
  }
  if (step.healed && (step.oldLocator || step.newLocator)) {
    extra += `<div class="heal">
      <div><span class="tag">was</span> <code>${esc(step.oldLocator ?? "")}</code></div>
      <div><span class="tag ok">now</span> <code>${esc(step.newLocator ?? "")}</code></div>
      ${step.assertionRetargeted ? `<div class="heal-warn">⚠ Assertion target re-pointed — verify this was a rename, not a regression.</div>` : ""}
    </div>`;
  }
  if (step.screenshots && step.screenshots.length) {
    extra += `<div class="shots">${step.screenshots
      .map((s) => `<a class="shot" href="${esc(s)}" target="_blank" rel="noopener"><img src="${esc(s)}" alt="step screenshot" /></a>`)
      .join("")}</div>`;
  }

  return `<li class="step ${cls}">
    <div class="step-row">
      <span class="step-icon ${cls}">${stepIcon(step)}</span>
      ${num}
      <span class="step-desc">${esc(desc)}</span>
      <span class="step-bar"><span style="width:${barPct}%"></span></span>
      <span class="step-dur">${esc(dur)}</span>
    </div>
    ${extra}
  </li>`;
}

/** Compact one-line description of a plan step (action + its main argument). */
function describePlanStep(s: Record<string, unknown>): string {
  const action = String(s.action ?? "step");
  const arg = s.target ?? s.field ?? s.url ?? s.option ?? s.value ?? "";
  return arg ? `${action} ${arg}` : action;
}

export function buildReportHtml(summary: RunSummary, opts: BuildReportOptions = {}): string {
  const nonce = opts.nonce ?? "agenticqa";
  const passed = summary.status === "passed";
  const title = summary.testTitle?.trim() || summary.requestText?.trim() || "AgenticQA Test Run";
  const dur = fmtDuration(summary.durationMs);
  const when = (() => {
    try {
      return new Date(summary.timestamp).toLocaleString();
    } catch {
      return summary.timestamp ?? "";
    }
  })();

  const steps = summary.steps ?? [];
  const maxDur = steps.reduce((m, s) => (typeof s.durationMs === "number" && s.durationMs > m ? s.durationMs : m), 0);
  const stepsHtml = steps.length
    ? `<ol class="steps">${steps.map((s) => renderStep(s, maxDur)).join("")}</ol>`
    : `<p class="muted">No step-level results were captured.</p>`;

  const statusWord = passed ? (summary.wasHealed ? "Passed (self-healed)" : "Passed") : "Failed";

  // Metric stat cards
  const metrics = [
    { label: "Passed", value: String(summary.stepsPassed), cls: "good" },
    { label: "Failed", value: String(summary.stepsFailed), cls: summary.stepsFailed > 0 ? "bad" : "" },
    { label: "Total", value: String(summary.stepsTotal), cls: "" },
    dur ? { label: "Duration", value: dur, cls: "" } : null,
    summary.healAttempts > 0
      ? { label: "Healed", value: `${summary.healSucceeded}/${summary.healAttempts}`, cls: "warn" }
      : null,
  ].filter(Boolean) as Array<{ label: string; value: string; cls: string }>;
  const metricsHtml = `<div class="stats">${metrics
    .map((m) => `<div class="stat ${m.cls}"><div class="stat-val">${esc(m.value)}</div><div class="stat-lbl">${esc(m.label)}</div></div>`)
    .join("")}</div>`;

  // Environment / metadata
  const envRows = [
    summary.executionProject ? ["Browser", String(summary.executionProject)] : null,
    summary.baseUrl ? ["Base URL", String(summary.baseUrl)] : null,
    summary.startUrl && summary.startUrl !== summary.baseUrl ? ["Start URL", String(summary.startUrl)] : null,
    ["Run ID", `${summary.runId}${summary.persisted === false ? "  (not persisted — DB off)" : ""}`],
    ["When", when],
    summary.testFile ? ["Spec file", String(summary.testFile)] : null,
  ].filter(Boolean) as Array<[string, string]>;
  const envHtml = `<section class="card"><h2>Environment</h2><table class="kv">${envRows
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td><code>${esc(v)}</code></td></tr>`)
    .join("")}</table></section>`;

  const requestHtml =
    summary.requestText && !summary.requestText.startsWith("RUN_ONLY")
      ? `<section class="card"><h2>Request</h2><blockquote>${esc(summary.requestText.trim())}</blockquote></section>`
      : "";

  const planSteps: Array<Record<string, unknown>> = summary.testPlan?.testCases?.[0]?.steps ?? [];
  const planHtml = planSteps.length
    ? `<section class="card"><h2>Test plan</h2><ol class="plan">${planSteps
        .slice(0, 40)
        .map((s) => `<li>${esc(describePlanStep(s))}</li>`)
        .join("")}</ol></section>`
    : "";

  const failureHtml =
    !passed && summary.failureClass
      ? `<section class="card fail-card">
          <h2>Why it failed</h2>
          <p class="fclass"><span class="pill bad">${esc(summary.failureClass)}</span></p>
          <p>${esc(FAILURE_TIPS[summary.failureClass] ?? FAILURE_TIPS.unknown)}</p>
        </section>`
      : "";

  const healHtml =
    summary.healAttempts > 0
      ? `<section class="card heal-card">
          <h2>Self-healing</h2>
          <p>${summary.healSucceeded}/${summary.healAttempts} attempt(s) succeeded. Repaired locators are promoted to baselines for future runs.</p>
          ${
            summary.assertionsRetargeted && summary.assertionsRetargeted > 0
              ? `<p class="heal-warn">⚠ ${summary.assertionsRetargeted} assertion target(s) were re-pointed — verify these were renames, not regressions.</p>`
              : ""
          }
        </section>`
      : "";

  const planningHtml = summary.planningDegraded
    ? `<section class="card warn-card">
          <h2>⚠ Planning degraded</h2>
          <p>The planner couldn't produce a valid plan and ran a minimal placeholder (goto + waitForLoad).
             A PASS here does <b>not</b> confirm the requested behavior was tested.</p>
          ${summary.planningDegradedReason ? `<p class="muted">${esc(summary.planningDegradedReason)}</p>` : ""}
        </section>`
    : "";

  const healSkipHtml =
    !passed && summary.healAttempts === 0 && summary.healingSkipReason
      ? `<section class="card"><h2>Self-healing</h2><p class="muted">Not applied — ${esc(summary.healingSkipReason)}</p></section>`
      : "";

  const aiHtml = summary.aiAnalysis
    ? `<section class="card ai-card"><h2>AI analysis</h2><p>${esc(summary.aiAnalysis)}</p></section>`
    : "";

  const artifactRows = [
    summary.htmlReport ? `<tr><td>Playwright HTML</td><td><code>${esc(summary.htmlReport)}</code></td></tr>` : "",
    summary.jsonReport ? `<tr><td>Playwright JSON</td><td><code>${esc(summary.jsonReport)}</code></td></tr>` : "",
  ]
    .filter(Boolean)
    .join("");
  const artifactsHtml = artifactRows
    ? `<section class="card"><h2>Artifacts</h2><table class="kv">${artifactRows}</table>
        ${summary.htmlReport ? `<button id="open-pw" class="btn ghost">Open full Playwright report ↗</button>` : ""}
       </section>`
    : "";

  const script = `
    var pb = document.getElementById('print-btn');
    if (pb) { pb.addEventListener('click', function(){ window.print(); }); }
    var vscode = (typeof acquireVsCodeApi !== 'undefined') ? acquireVsCodeApi() : null;
    var ob = document.getElementById('open-pw');
    if (ob) {
      if (vscode) { ob.addEventListener('click', function(){ vscode.postMessage({ type: 'openPlaywright' }); }); }
      else { ob.style.display = 'none'; }
    }
    if (${opts.autoPrint ? "true" : "false"}) {
      window.addEventListener('load', function(){ setTimeout(function(){ window.print(); }, 400); });
    }`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data: https:;" />
<title>AgenticQA Report — ${esc(title)}</title>
<style>
  :root { --bg:#f4f5f7; --card:#ffffff; --line:#e5e7eb; --ink:#1f2430; --muted:#6b7280;
          --brand:#4f46e5; --green:#16a34a; --red:#dc2626; --amber:#d97706; --soft:#f9fafb; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
         font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
         line-height:1.5; }
  .wrap { max-width:920px; margin:0 auto; padding:28px 24px 40px; }
  .brandbar { display:flex; align-items:center; gap:10px; color:var(--muted); font-size:13px; font-weight:600; margin-bottom:14px; letter-spacing:.3px; }
  .brandbar .dot { width:10px; height:10px; border-radius:3px; background:var(--brand); }

  .hero { display:flex; gap:24px; align-items:center; padding:24px; border-radius:16px;
          background:var(--card); border:1px solid var(--line); box-shadow:0 1px 2px rgba(16,24,40,.04); }
  .hero.passed { border-left:5px solid var(--green); }
  .hero.failed { border-left:5px solid var(--red); }
  .hero-main { flex:1; min-width:0; }
  .status { display:inline-flex; align-items:center; gap:8px; font-size:13px; font-weight:700;
            padding:5px 12px; border-radius:999px; }
  .status.passed { background:rgba(22,163,74,.1); color:var(--green); }
  .status.failed { background:rgba(220,38,38,.1); color:var(--red); }
  .hero h1 { margin:10px 0 6px; font-size:22px; line-height:1.25; }
  .hero .sub { color:var(--muted); font-size:13px; }

  .ring { width:120px; height:120px; flex:0 0 120px; }
  .ring-track { fill:none; stroke:var(--line); stroke-width:10; }
  .ring-val { fill:none; stroke-width:10; stroke-linecap:round; transform:rotate(-90deg); transform-origin:50% 50%; }
  .ring-pct { fill:var(--ink); font-size:22px; font-weight:700; text-anchor:middle; }
  .ring-sub { fill:var(--muted); font-size:12px; text-anchor:middle; }

  .stats { display:flex; gap:12px; margin-top:16px; flex-wrap:wrap; }
  .stat { flex:1; min-width:96px; background:var(--card); border:1px solid var(--line); border-radius:12px;
          padding:14px 16px; text-align:center; }
  .stat-val { font-size:24px; font-weight:700; }
  .stat-lbl { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:.5px; margin-top:2px; }
  .stat.good .stat-val { color:var(--green); }
  .stat.bad .stat-val { color:var(--red); }
  .stat.warn .stat-val { color:var(--amber); }

  .actions { display:flex; gap:10px; margin:18px 0 4px; }
  .btn { font-size:13px; font-weight:600; padding:9px 16px; border-radius:9px; border:1px solid transparent;
         cursor:pointer; background:var(--brand); color:#fff; }
  .btn.ghost { background:transparent; color:var(--brand); border-color:var(--brand); margin-top:12px; }

  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:18px 20px; margin-top:16px;
          box-shadow:0 1px 2px rgba(16,24,40,.03); }
  .card h2 { margin:0 0 12px; font-size:12px; text-transform:uppercase; letter-spacing:.6px; color:var(--muted); }
  blockquote { margin:0; padding:12px 16px; border-left:3px solid var(--brand); background:var(--soft); border-radius:8px; }
  .muted { color:var(--muted); }

  .steps, .plan { list-style:none; margin:0; padding:0; }
  .plan { counter-reset:p; }
  .plan li { padding:6px 0 6px 28px; position:relative; border-bottom:1px dashed var(--line); font-size:13px; color:#374151; }
  .plan li:last-child { border-bottom:none; }
  .plan li::before { counter-increment:p; content:counter(p); position:absolute; left:0; top:6px; color:var(--muted); font-size:11px; }

  .step { padding:10px 0; border-bottom:1px solid var(--line); }
  .step:last-child { border-bottom:none; }
  .step-row { display:flex; align-items:center; gap:12px; }
  .step-icon { width:20px; height:20px; line-height:20px; text-align:center; border-radius:6px; font-size:12px; font-weight:700; }
  .step-icon.passed, .step-icon.healed { background:rgba(22,163,74,.12); color:var(--green); }
  .step-icon.failed { background:rgba(220,38,38,.12); color:var(--red); }
  .step-icon.healed { background:rgba(217,119,6,.14); color:var(--amber); }
  .step-num { font-size:11px; color:var(--muted); min-width:18px; }
  .step-desc { flex:1; word-break:break-word; }
  .step.failed .step-desc { color:#b91c1c; font-weight:600; }
  .step-bar { flex:0 0 120px; height:6px; background:var(--line); border-radius:999px; overflow:hidden; }
  .step-bar span { display:block; height:100%; background:var(--brand); opacity:.7; }
  .step-dur { color:var(--muted); font-size:12px; font-variant-numeric:tabular-nums; min-width:48px; text-align:right; }

  pre.err { margin:8px 0 2px 32px; padding:10px 12px; background:#fef2f2; border:1px solid rgba(220,38,38,.3);
            border-radius:8px; color:#b91c1c; font-size:12px; white-space:pre-wrap; overflow-x:auto; }
  .heal { margin:8px 0 2px 32px; font-size:12px; }
  .heal code { color:var(--brand); }
  .heal-warn { margin-top:4px; color:var(--amber); }
  .tag { display:inline-block; min-width:32px; color:var(--muted); }
  .tag.ok { color:var(--green); }
  .shots { display:flex; gap:10px; flex-wrap:wrap; margin:10px 0 2px 32px; }
  .shot { display:block; border:1px solid var(--line); border-radius:8px; overflow:hidden; max-width:280px; }
  .shot img { display:block; width:100%; height:auto; }

  .pill { font-size:11px; padding:2px 8px; border-radius:999px; }
  .pill.bad { background:rgba(220,38,38,.12); color:var(--red); }
  .fail-card { border-color:rgba(220,38,38,.3); }
  .heal-card { border-color:rgba(217,119,6,.3); }
  .warn-card { border-color:rgba(217,119,6,.45); background:#fffbeb; }
  .ai-card { border-color:rgba(79,70,229,.3); }
  table.kv { width:100%; border-collapse:collapse; font-size:13px; }
  table.kv td { padding:7px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  table.kv tr:last-child td { border-bottom:none; }
  table.kv td:first-child { color:var(--muted); width:130px; }
  code { font-family:'SF Mono',Consolas,'Courier New',monospace; font-size:12px; word-break:break-all; }
  footer { color:var(--muted); font-size:12px; text-align:center; margin:28px 0 6px; }

  @media print {
    body { background:#fff; }
    .wrap { max-width:none; }
    .hero, .card, .stat { box-shadow:none; }
    .actions, #open-pw { display:none !important; }
    .card, .step, .shot { break-inside:avoid; }
    a { color:inherit; text-decoration:none; }
  }
</style>
</head>
<body>
  <div class="wrap">
    <div class="brandbar"><span class="dot"></span> AgenticQA · Test Report</div>

    <div class="hero ${passed ? "passed" : "failed"}">
      ${renderRing(summary.stepsPassed, summary.stepsTotal)}
      <div class="hero-main">
        <span class="status ${passed ? "passed" : "failed"}">${passed ? "✔" : "✘"} ${esc(statusWord)}</span>
        <h1>${esc(title)}</h1>
        <div class="sub">${esc(when)}${summary.executionProject ? ` · ${esc(String(summary.executionProject))}` : ""}${dur ? ` · ${esc(dur)}` : ""}</div>
      </div>
    </div>

    ${metricsHtml}

    <div class="actions">
      <button id="print-btn" class="btn">⬇ Save as PDF</button>
    </div>

    ${requestHtml}
    ${planningHtml}
    ${failureHtml}

    <section class="card">
      <h2>Steps</h2>
      ${stepsHtml}
    </section>

    ${planHtml}
    ${healHtml}
    ${healSkipHtml}
    ${aiHtml}
    ${envHtml}
    ${artifactsHtml}

    <footer>Generated by AgenticQA${opts.version ? ` v${esc(opts.version)}` : ""} · ${esc(when)} · Run ${esc(summary.runId)}</footer>
  </div>
  <script nonce="${nonce}">${script}</script>
</body>
</html>`;
}
