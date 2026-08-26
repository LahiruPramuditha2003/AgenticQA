import * as vscode from "vscode";
import { FAILURE_TIPS } from "../report/buildReportHtml";

/* ─── Data types ─── */

export interface RunSummary {
  runId: string;
  /** False when the run wasn't written to a DB (runId is a synthesized `local-…`). */
  persisted?: boolean;
  status: "passed" | "failed";
  wasHealed: boolean;
  statusLabel: string;
  /** Human title of the test case — preferred display name for the run. */
  testTitle?: string;
  stepsTotal: number;
  stepsPassed: number;
  stepsFailed: number;
  /** Total wall time across steps, ms. */
  durationMs?: number;
  executionProject?: string | null;
  baseUrl?: string | null;
  startUrl?: string | null;
  failureClass?: string | null;
  /** Why self-healing was not applied (gate miss / no candidate), when a failure wasn't healed. */
  healingSkipReason?: string | null;
  healAttempts: number;
  healSucceeded: number;
  /** Count of healed steps whose assertion target was re-pointed (heal-and-flag policy). */
  assertionsRetargeted?: number;
  /** True when the planner fell back to a minimal placeholder plan (its output failed validation). */
  planningDegraded?: boolean;
  planningDegradedReason?: string | null;
  steps: StepSummary[];
  htmlReport?: string;
  jsonReport?: string;
  testFile?: string;
  workspacePath?: string;
  timestamp: string;
  requestText?: string;
  testPlan?: any;
  aiAnalysis?: string | null;
}

export interface StepSummary {
  stepKey: string | null;
  /** 1-based step number (from `plan-step-N`). */
  index?: number;
  action?: string;
  /** Human description, e.g. `click "Add to Cart"`. Preferred display label. */
  description?: string;
  status: "passed" | "failed";
  durationMs?: number;
  errorMessage?: string;
  healed?: boolean;
  oldLocator?: string;
  newLocator?: string;
  /** True when this healed step re-pointed an assertion target (verify rename vs regression). */
  assertionRetargeted?: boolean;
  /** Filesystem paths of Playwright screenshots for this step (failure state). Inlined as data URIs at
   *  render time by the extension (the report builder stays pure). N3. */
  screenshots?: string[];
}

/* ─── display helpers ─── */

function clip(s: string | undefined | null, max = 64): string {
  const str = String(s ?? "").replace(/\s+/g, " ").trim();
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

function fmtDuration(ms: number | undefined): string {
  if (typeof ms !== "number" || !isFinite(ms) || ms < 0) {return "";}
  if (ms < 1000) {return `${Math.round(ms)}ms`;}
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`;
}

function relativeTime(iso: string): string {
  try {
    const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) {return "just now";}
    const m = Math.round(s / 60);
    if (m < 60) {return `${m}m ago`;}
    const h = Math.round(m / 60);
    if (h < 24) {return `${h}h ago`;}
    return `${Math.round(h / 24)}d ago`;
  } catch {
    return "";
  }
}

/** Pick a meaningful, human-readable name for a run (never a bare UUID when avoidable). */
function friendlyRunName(summary: RunSummary): string {
  if (summary.testTitle && summary.testTitle.trim()) {return clip(summary.testTitle);}
  const req = (summary.requestText ?? "").trim();
  if (req && !req.startsWith("RUN_ONLY")) {return clip(req);}
  if (summary.testFile) {
    const base = (summary.testFile.split(/[\\/]/).pop() ?? "")
      .replace(/\.spec\.ts$/, "")
      .replace(/-[0-9a-f]{6}$/, "") // drop the codegen collision hash
      .replace(/[-_]+/g, " ")
      .trim();
    if (base) {return clip(base);}
  }
  return summary.runId ? `Run ${summary.runId.slice(0, 8)}` : "Test run";
}

export interface DomainQaSummary {
  question: string;
  timestamp: string;
}

/* ─── Tree items ─── */

type TreeItem =
  | RunItem
  | StepItem
  | InfoItem
  | DomainQaItem;

class RunItem extends vscode.TreeItem {
  constructor(public readonly summary: RunSummary) {
    const icon = summary.wasHealed
      ? "🔧"
      : summary.status === "passed"
        ? "🟢"
        : "🔴";
    // Meaningful name (test title / request), never a bare UUID.
    super(`${icon} ${friendlyRunName(summary)}`, vscode.TreeItemCollapsibleState.Collapsed);

    const dur = fmtDuration(summary.durationMs);
    const failed = summary.status === "failed";
    this.description = [
      `${summary.stepsPassed}/${summary.stepsTotal}`,
      dur || null,
      failed && summary.failureClass ? `⚠ ${summary.failureClass}` : null,
      relativeTime(summary.timestamp),
    ]
      .filter(Boolean)
      .join(" · ");

    const tip = [
      `**${summary.statusLabel}**`,
      summary.testTitle ? `Test: ${summary.testTitle}` : null,
      summary.requestText && !summary.requestText.startsWith("RUN_ONLY")
        ? `Request: ${summary.requestText.trim()}`
        : null,
      `Steps: ${summary.stepsTotal} — ${summary.stepsPassed} passed, ${summary.stepsFailed} failed`,
      summary.executionProject ? `Browser: ${summary.executionProject}` : null,
      summary.failureClass ? `Failure: \`${summary.failureClass}\`` : null,
      summary.failureClass ? `💡 ${FAILURE_TIPS[summary.failureClass] ?? FAILURE_TIPS.unknown}` : null,
      summary.planningDegraded
        ? `⚠ Planning degraded — a minimal placeholder plan ran; a PASS may not be meaningful`
        : null,
      summary.aiAnalysis ? `🤖 ${summary.aiAnalysis}` : null,
      dur ? `Duration: ${dur}` : null,
      `Run: ${summary.runId}${summary.persisted === false ? " (not persisted — DB off)" : ""}`,
      `Time: ${new Date(summary.timestamp).toLocaleString()}`,
    ].filter(Boolean);
    this.tooltip = new vscode.MarkdownString(tip.join("\n\n"));
    this.contextValue = "run";
  }
}

class StepItem extends vscode.TreeItem {
  constructor(
    public readonly step: StepSummary,
    public readonly runId: string,
    public readonly testFile?: string,
    public readonly workspacePath?: string
  ) {
    const key = step.stepKey ?? "unknown";
    // Prefer the human description (`click "Add to Cart"`); fall back to the raw key.
    const display = step.description?.trim() || key;
    let icon: string;
    let suffix = "";

    if (step.healed) {
      icon = "🔧";
      suffix = ` [healed]`;
    } else if (step.status === "passed") {
      icon = "✅";
    } else {
      icon = "❌";
    }

    const label = `${icon} ${display}${suffix}`;
    super(label, vscode.TreeItemCollapsibleState.None);

    this.description = fmtDuration(step.durationMs);

    // Build tooltip
    const tooltipLines: string[] = [
      `Step ${step.index ?? key}: ${display}`,
      `Status: ${step.status}`,
    ];
    if (step.healed) {
      tooltipLines.push("");
      tooltipLines.push("🔧 Self-healed:");
      if (step.oldLocator) {tooltipLines.push(`  Old: ${step.oldLocator}`);}
      if (step.newLocator) {tooltipLines.push(`  New: ${step.newLocator}`);}
    }
    if (step.errorMessage) {
      tooltipLines.push("");
      tooltipLines.push(`Error: ${step.errorMessage.slice(0, 200)}`);
    }

    this.tooltip = new vscode.MarkdownString(
      tooltipLines.map((l) => l.replace(/</g, "&lt;")).join("\n\n"),
      false
    );

    this.contextValue = step.healed
      ? "step-healed"
      : step.status === "failed"
        ? "step-failed"
        : "step-passed";
  }
}

class InfoItem extends vscode.TreeItem {
  constructor(label: string, description?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.contextValue = "info";
  }
}

class DomainQaItem extends vscode.TreeItem {
  constructor(public readonly qa: DomainQaSummary) {
    const shortQ =
      qa.question.length > 50
        ? qa.question.slice(0, 47) + "..."
        : qa.question;
    super(`💬 ${shortQ}`, vscode.TreeItemCollapsibleState.None);

    this.tooltip = `Question: ${qa.question}\nTime: ${new Date(qa.timestamp).toLocaleString()}`;
    this.description = new Date(qa.timestamp).toLocaleTimeString();
    this.contextValue = "domainqa";
  }
}

/* ─── Tree Data Provider ─── */

export class RunTreeProvider
  implements vscode.TreeDataProvider<TreeItem>
{
  private _onDidChange = new vscode.EventEmitter<
    TreeItem | undefined | null | void
  >();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private runs: RunSummary[] = [];
  private domainQas: DomainQaSummary[] = [];
  private context: vscode.ExtensionContext | undefined;

  /** Set the extension context for persistence */
  setContext(context: vscode.ExtensionContext) {
    this.context = context;
    // Load persisted runs on initialization
    this.loadFromStorage();
  }

  /** Load runs from VSCode workspace storage */
  private loadFromStorage() {
    if (!this.context) {return;}
    const stored = this.context.workspaceState.get<Array<RunSummary>>('agenticqa.runs', []);
    this.runs = stored.slice(0, 50); // Keep last 50
    const storedQa = this.context.workspaceState.get<Array<DomainQaSummary>>('agenticqa.domainQas', []);
    this.domainQas = storedQa.slice(0, 20); // Keep last 20
    this._onDidChange.fire();
  }

  /** Save runs to VSCode workspace storage */
  private saveToStorage() {
    if (!this.context) {return;}
    this.context.workspaceState.update('agenticqa.runs', this.runs);
    this.context.workspaceState.update('agenticqa.domainQas', this.domainQas);
  }

  /** Add a new run summary (called from extension when parsing ORCH output) */
  addRun(summary: RunSummary): void {
    // Add to front (newest first)
    this.runs.unshift(summary);
    // Keep last 50 runs
    if (this.runs.length > 50) {this.runs.length = 50;}
    this.saveToStorage();
    this._onDidChange.fire();
  }

  /** Add a domain QA entry */
  addDomainQa(qa: DomainQaSummary): void {
    this.domainQas.unshift(qa);
    if (this.domainQas.length > 20) {this.domainQas.length = 20;}
    this.saveToStorage();
    this._onDidChange.fire();
  }

  /** Clear all data */
  clear(): void {
    this.runs = [];
    this.domainQas = [];
    this.saveToStorage();
    this._onDidChange.fire();
  }

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeItem): TreeItem[] {
    if (!element) {
      // Root level: show runs + domain QA entries
      const items: TreeItem[] = [];

      if (this.runs.length === 0 && this.domainQas.length === 0) {
        items.push(
          new InfoItem("No runs yet", "Use AgenticQA: New Request to start")
        );
        return items;
      }

      // Test runs (show first, most recent)
      for (const run of this.runs) {
        items.push(new RunItem(run));
      }

      // Domain QA entries
      for (const qa of this.domainQas) {
        items.push(new DomainQaItem(qa));
      }

      return items;
    }

    if (element instanceof RunItem) {
      const summary = element.summary;
      const items: TreeItem[] = [];

      // Step items
      for (const step of summary.steps) {
        items.push(new StepItem(step, summary.runId, summary.testFile, summary.workspacePath));
      }

// Report links with clickable URIs
    if (summary.htmlReport) {
      const reportItem = new vscode.TreeItem(
        "📊 HTML Report",
        vscode.TreeItemCollapsibleState.None
      );
      reportItem.description = summary.htmlReport.split('/').pop() || summary.htmlReport;
      reportItem.tooltip = `Click to preview HTML report: ${summary.htmlReport}`;
      reportItem.command = {
        command: 'agenticqa.previewHtmlReport',
        title: 'Preview HTML Report',
        arguments: [element]
      };
      items.push(reportItem);
    }

    if (summary.jsonReport) {
      const jsonItem = new vscode.TreeItem(
        "📋 JSON Report",
        vscode.TreeItemCollapsibleState.None
      );
      jsonItem.description = summary.jsonReport.split('/').pop() || summary.jsonReport;
      jsonItem.tooltip = `Click to open JSON report: ${summary.jsonReport}`;
      const jsonUri = summary.workspacePath
        ? vscode.Uri.joinPath(vscode.Uri.file(summary.workspacePath), summary.jsonReport)
        : vscode.Uri.file(summary.jsonReport);
      jsonItem.command = {
        command: 'vscode.open',
        title: 'Open JSON Report',
        arguments: [jsonUri]
      };
      items.push(jsonItem);
    }

      return items;
    }

    return [];
  }
}