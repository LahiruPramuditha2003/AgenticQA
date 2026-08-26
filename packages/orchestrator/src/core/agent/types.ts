import type { ChildProcess } from "node:child_process";
import type { AppKnowledgePack } from "../knowledge/AppKnowledgePack";
import type { AgenticQaConfig } from "../../config";

export type Intent = "CASUAL" | "DOMAIN_QA" | "TEST_GEN";
export type RunMode = "generate_and_run" | "run_only" | "explore" | "generate_pack";

export interface RunOverrides {
  baseUrl?: string;
  startUrl?: string;
}

export interface Logger {
  log(message: string): void;
  error(message: string): void;
  domainAnswer?(answer: any): void;
  casualAnswer?(text: string): void;
}

export interface StepResultInfo {
  stepKey: string | null;
  title: string;
  status: "passed" | "failed";
  errorMessage?: string;
  durationMs?: number;
  /** Filesystem paths of Playwright attachment screenshots for this step (failure state). N3.1. */
  screenshots?: string[];
}

export interface FailedStep {
  stepId: string;
  stepKey: string;
  testRelPath: string;
}

export interface HealResult {
  stepId: string;
  stepKey: string;
  oldLocator: string;
  newLocator: string;
  testRelPath: string;
  distance: number;
  /** True when the healed step was an assertion (expectVisible/expectText/…): its target was
   *  re-pointed, which could mask a genuine text/content regression — surfaced as a report warning. */
  assertionRetargeted?: boolean;
}

export interface PageElement {
  role: string;
  name: string;
  pageUrl?: string;
  testId?: string;
  placeholder?: string;
  label?: string;
  href?: string;
  inputType?: string;
  visible?: boolean;
  enabled?: boolean;
  options?: string[];
  locatorCandidates?: string[];
  /** Heading rank (1 = `<h1>`). Only set for `heading` elements; used to pick a page's real title. */
  level?: number;
}

/** Extended page element with additional context */
export interface PageElementExtended extends PageElement {
  ref?: string; // Playwright MCP reference
  visible?: boolean;
  enabled?: boolean;
}

/** Table structure detected on page */
export interface PageTable {
  name?: string;
  headers: string[];
  rowCount: number;
  ref?: string;
}

/** Modal/dialog detected on page */
export interface PageModal {
  title?: string;
  role: "dialog" | "alertdialog" | "menu";
  ref?: string;
}

/** Toast/notification detected on page */
export interface PageToast {
  message?: string;
  type?: "success" | "error" | "warning" | "info";
  ref?: string;
}

export interface PageContext {
  url: string;
  pages?: PageContext[];
  inputs: PageElement[];
  buttons: PageElement[];
  headings: PageElement[];
  links: PageElement[];
  selects: PageElement[];
  checkboxes: PageElement[];
  radios: PageElement[];
  
  // Extended elements (populated when available)
  tables?: PageTable[];
  modals?: PageModal[];
  toasts?: PageToast[];
  images?: PageElement[];
  lists?: PageElement[];
  gridItems?: PageElement[];
  cards?: PageElement[];
  breadcrumbs?: PageElement[];
  pagination?: PageElement[];
  tabs?: PageElement[];
  accordions?: PageElement[];
  domElements?: Array<{
    role?: string;
    tagName: string;
    text?: string;
    accessibleName?: string;
    testId?: string;
    placeholder?: string;
    label?: string;
    href?: string;
    inputType?: string;
    visible?: boolean;
    enabled?: boolean;
    options?: string[];
  }>;
  
  rawSnapshot: string;
}

export interface TestCasePlan {
  title: string;
  /** Steps stay loosely typed — `action` is an open set canonicalized by the grounder, and agents
   *  read varied per-action fields (url/field/target/value/option/timeout/…). */
  steps: any[];
}

/** The structured test plan threaded on `ctx.testPlan` (built by TestPlannerAgent; read by
 *  UiInspector / ScriptGen / SelfHeal / Reporter). */
export interface TestPlan {
  testCases: TestCasePlan[];
}

export interface RunContext {
  requestText: string;
  workspacePath: string;
  overrides?: RunOverrides;
  testPlan?: TestPlan;
  /** True when the planner fell back to a minimal placeholder plan (its output failed schema
   *  validation). The trivial plan can pass, so this is surfaced in the report to avoid a
   *  misleading clean PASS that didn't actually verify the requested behavior. */
  planningDegraded?: boolean;
  planningDegradedReason?: string;
  intent?: Intent;
  mcp?: any;
  stepLocators?: Record<string, string>;

  // Pre-inspection
  pageContext?: PageContext;
  pageInventory?: PageContext[];

  // URL patterns discovered during inspection
  urlPatterns?: Record<string, string>;

  // Single failure (backward compat)
  failedStepId?: string;
  failureText?: string;

  // Multi-failure support
  failedSteps?: FailedStep[];

  // Healing
  healAttempted?: boolean;
  healPatched?: boolean;
  healOldLocator?: string;
  healNewLocator?: string;
  healStepKey?: string;
  healPageUrl?: string;
  healResults?: HealResult[];

  /** When true, ExecutorAgent skips DB step_result writes (preserves initial failure records) */
  isHealRerun?: boolean;

  /**
   * Permission to replace a pack marked `curated: true` (D30/D38). Off by default: the destructive
   * choice must be made explicitly, in the UI, by a person who was told what is being traded.
   */
  overwriteCuratedPack?: boolean;
  runMode?: RunMode;

  // Config
  cfg?: AgenticQaConfig;
  /** Optional per-app knowledge pack (credentials, routes, golden flows). Null/undefined =
   *  pure page-grounded planning. Loaded by ConfigService from .agenticqa.json. */
  knowledgePack?: AppKnowledgePack | null;
  effectiveBaseUrl?: string;
  effectiveStartUrl?: string;

  // DB
  /** True only when a Postgres connection succeeded. When false, the pipeline still runs
   *  generate-and-run end to end; self-heal, run history, and signature baselines are skipped. */
  dbEnabled?: boolean;
  /** False when a custom embed model's dimension ≠ the DB's fixed `vector(EMBEDDING_DIM)` — the DB vector
   *  path is disabled for the run (set by DbService's probe, N1.6). Undefined = not probed / no embeddings. */
  embeddingDimOk?: boolean;
  projectId?: string;
  testRunId?: string;
  testCaseId?: string;

  // Artifacts
  testRelPath?: string;

  // Execution
  /** A single pinned project (explore / pack validation). Kept for the report's `executionProject`. */
  executionProject?: string;
  /**
   * The browser projects this run executes against, resolved by `ConfigService` (G5.1).
   * `undefined` means the app's full configured matrix; an array pins those projects.
   */
  executionProjects?: string[];
  /** Per-request override: run the FULL matrix regardless of config. Used by the benchmark and by the
   *  extension's explicit "Run Across All Browsers" command. */
  allProjects?: boolean;

  /* ── G4: learning from run history ── */
  /** Key of the golden flow the deterministic planner built this plan from, when it did. */
  selectedFlowKey?: string;
  /** Set by the Reporter when recent runs of this spec disagree — see `detectFlakiness`. */
  flaky?: boolean;
  failureClass?: string;
  healingSkipReason?: string;
  playwrightExitCode?: number;
  playwrightStdout?: string;
  playwrightStderr?: string;

  // Reports
  jsonReportPath?: string;
  htmlReportDir?: string;
  stepResults?: StepResultInfo[];

  // Web server lifecycle
  webServerStarted?: boolean;
  webServerProc?: ChildProcess;

  // Final
  finalStatus?: "passed" | "failed";
}

export interface Agent {
  name: string;
  run(ctx: RunContext, logger: Logger): Promise<void>;
}
