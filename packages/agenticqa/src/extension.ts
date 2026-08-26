import * as vscode from "vscode";
import { spawn, spawnSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { RunTreeProvider, RunSummary, DomainQaSummary } from "./views/RunTreeProvider";
import { ChatViewProvider } from "./views/ChatViewProvider";
import { buildReportHtml } from "./report/buildReportHtml";
import { openSettingsPanel } from "./views/SettingsViewProvider";
import {
  SECRET_API_KEY,
  readUserConfig,
  buildEnvOverlay,
  evaluateModelPolicy,
  AGENT_ROLES,
  type UserConfig,
} from "./config/userConfig";
// Key formats/prefixes come from the ONE catalog, so adding a provider never means editing this file.
import {
  isPlaceholderApiKey,
  keyHintFor,
  allKeyPrefixes,
  providerForBaseUrl,
} from "../../orchestrator/src/core/llm/modelCatalog";
import * as crypto from "node:crypto";
// G5.2 — the vscode-free helpers live in `util/` so they can be unit-tested without launching a VS Code
// host. `extension.ts` imports `vscode`, which is why everything inside it was effectively untestable.
import { extractUrlFromText, looksLikeQuestion } from "./util/text";
import {
  findAgenticQaConfigFile,
  getAgenticQaConfigInfo,
  readWorkspaceAgenticQaConfig,
  writeWorkspaceAgenticQaConfig,
  hasKnowledgePack,
  readKnowledgePackSummary,
  detectCodeAccessibleApp,
} from "./util/workspace";
import { inlineScreenshots } from "./util/screenshots";
import { checkPlaywrightBrowsers, describeBrowserCheck } from "./util/playwright";
import {
  resolveEngine,
  monorepoOrchestratorDir,
  missingEngineMessage,
  ENGINE_KIND_LABELS,
  type EngineLocation,
} from "./util/engine";

/**
 * Where per-user agent-prompt overrides live: `<globalStorage>/prompts/<AgentName>.md` (R1.1).
 *
 * `globalStorageUri` is the location VS Code guarantees is writable and — unlike the extension install
 * directory — **survives an extension update**. The engine treats a missing directory or file as "no
 * override" and falls back to its shipped prompt, so this is safe to pass unconditionally.
 */
function promptOverrideDir(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, "prompts");
}

/** Regenerable per-user caches (embeddings). Same reasoning as above — never the install directory. */
function engineCacheDir(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, "cache");
}

/** Does this path exist? Injected into `resolveEngine` so its ordering logic stays vscode/fs-free. */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate the engine for this installation (R1.7 / blocker B1).
 *
 * Five call sites used to hardcode the monorepo sibling path, which exists only in this checkout —
 * so a `.vsix` install could not run at all. They now share one resolver, and every caller reports
 * WHICH engine it found: running a stale sibling build while believing you are running the packaged
 * one is a support ticket nobody can answer.
 */
async function locateEngine(
  context: vscode.ExtensionContext
): Promise<EngineLocation | undefined> {
  const configuredPath = vscode.workspace
    .getConfiguration("agenticqa")
    .get<string>("enginePath");
  return await resolveEngine({
    extensionPath: context.extensionPath,
    configuredPath,
    exists: pathExists,
  });
}

/**
 * One-time welcome for a fresh install with no API key (R2.4a, blocker B4).
 *
 * Before this, a first run with no key degraded **silently** into the deterministic planner: the user got
 * a thin test and no explanation, which reads as "this extension is bad" rather than "this extension is
 * not configured". Shown once per machine and never again — a notification that reappears is worse than
 * none, because people learn to dismiss it without reading.
 *
 * ⚠️ Deliberately NOT shown on activation alone. It fires on the first *run*, when the user has already
 * decided to try something and the advice is actionable. Nagging at startup is how extensions get
 * uninstalled.
 */
const WELCOME_SHOWN_KEY = "agenticqa.welcomeShown";

async function maybeShowWelcome(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(WELCOME_SHOWN_KEY)) {
    return;
  }
  if (await context.secrets.get(SECRET_API_KEY)) {
    return; // already configured — nothing to explain
  }
  await context.globalState.update(WELCOME_SHOWN_KEY, true);

  const choice = await vscode.window.showInformationMessage(
    "Welcome to AgenticQA. It turns plain-English requests into Playwright tests, runs them, and " +
      "self-heals broken locators. The AI features need an API key of your own — OpenRouter and " +
      "NVIDIA NIM both have free tiers. Without a key, AgenticQA still generates tests from a " +
      "knowledge pack, but cannot plan new scenarios or answer questions.",
    "Add API key",
    "Get a free key",
    "Later"
  );

  if (choice === "Add API key") {
    await vscode.commands.executeCommand("agenticqa.settings");
  } else if (choice === "Get a free key") {
    await vscode.env.openExternal(vscode.Uri.parse("https://openrouter.ai/keys"));
  }
}

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("AgenticQA");

  // ── TreeView provider ──
  const treeProvider = new RunTreeProvider();
  treeProvider.setContext(context); // Enable persistence
  
  const treeView = vscode.window.createTreeView("agenticqa.runsView", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });

  // ── Webview provider (Chat Input) ──
  const chatProvider = new ChatViewProvider(context.extensionUri);
  const chatView = vscode.window.registerWebviewViewProvider("agenticqa.chatView", chatProvider);

  /* ════════════════════════════════════════════════════════════════
     Orchestrator runner with progress + TreeView integration
     ════════════════════════════════════════════════════════════════ */

  // Build the orchestrator (npm run build) with progress, streaming output to the channel. Returns
  // true on success. Used when a run is requested before the orchestrator has been built.
  async function buildOrchestrator(): Promise<boolean> {
    const orchDir = monorepoOrchestratorDir(context.extensionPath);
    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "AgenticQA: building orchestrator…",
        cancellable: false,
      },
      () =>
        new Promise<boolean>((resolve) => {
          output.show(true);
          output.appendLine("────────────────────────────────────────");
          output.appendLine("Building orchestrator (npm run build)…");
          const child = spawn("npm", ["run", "build"], { cwd: orchDir, shell: true });
          child.stdout?.on("data", (b) => output.append(b.toString()));
          child.stderr?.on("data", (b) => output.append(b.toString()));
          child.on("error", (e) => {
            output.appendLine("[EXT] Build failed to start: " + String(e));
            resolve(false);
          });
          child.on("close", (code) => {
            output.appendLine(`[EXT] Build exited with code ${code}`);
            resolve(code === 0);
          });
        })
    );
  }

  async function runOrchestrator(opts: {
    runMode: "generate_and_run" | "run_only" | "explore" | "generate_pack";
    text: string;
    skipUrlExtraction?: boolean;
    /** Run the app's whole Playwright matrix instead of the chromium-only default (G5.1 / D6). */
    allProjects?: boolean;
    /** generate_pack only: the user confirmed replacing a pack marked `curated: true` (D30/D38). */
    overwriteCuratedPack?: boolean;
  }) {
    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!rootPath) {
      vscode.window.showErrorMessage(
        "Open a folder first (workspace required)."
      );
      return;
    }

    const { configRoot, configPath } = await getAgenticQaConfigInfo(rootPath);
    const workspacePath = configRoot;

    // First-run onboarding: if there's no .agenticqa.json (and the request doesn't carry its own URL),
    // offer to scaffold one so the run doesn't later fail with a cryptic "No baseUrl".
    if (opts.runMode !== "run_only") {
      let hasConfig = true;
      try {
        await fs.access(configPath);
      } catch {
        hasConfig = false;
      }
      if (!hasConfig && !extractUrlFromText(opts.text)) {
        const choice = await vscode.window.showInformationMessage(
          "No .agenticqa.json found in this workspace. Create one now?",
          "Create",
          "Cancel"
        );
        if (choice !== "Create") {
          return;
        }
        const baseUrl = await vscode.window.showInputBox({
          prompt: "Base URL of the app under test",
          value: "http://localhost:5173",
          validateInput: (v) => {
            try {
              new URL(v);
              return undefined;
            } catch {
              return "Enter a valid URL (e.g. http://localhost:5173)";
            }
          },
        });
        if (!baseUrl) {
          return;
        }
        await writeWorkspaceAgenticQaConfig(workspacePath, {
          baseUrl,
          testDir: "tests/generated",
        });
        vscode.window.showInformationMessage(
          `AgenticQA: created .agenticqa.json (baseUrl=${baseUrl}).`
        );
      }
    }

    let engine = await locateEngine(context);

    // Offer to build ONLY in a monorepo checkout, where there are sources to build. In a packaged
    // install a missing engine is a broken download; asking the user to run `npm run build` would send
    // them chasing a fix that cannot exist. `monorepoOrchestratorDir` existing is the tell.
    if (!engine) {
      const buildable = await pathExists(
        path.join(monorepoOrchestratorDir(context.extensionPath), "package.json")
      );
      if (!buildable) {
        output.appendLine(
          "[EXT] " + missingEngineMessage(context.extensionPath)
        );
        vscode.window.showErrorMessage(
          "AgenticQA: the engine is missing from this installation — see the Output panel."
        );
        return;
      }
      const choice = await vscode.window.showErrorMessage(
        "AgenticQA orchestrator isn't built yet. Build it now?",
        "Build",
        "Cancel"
      );
      if (choice !== "Build") {
        return;
      }
      const built = await buildOrchestrator();
      if (!built) {
        vscode.window.showErrorMessage(
          "AgenticQA: orchestrator build failed — see the Output panel."
        );
        return;
      }
      engine = await locateEngine(context);
      if (!engine) {
        vscode.window.showErrorMessage(
          "AgenticQA: build finished but dist/main.js wasn't produced. See the Output panel."
        );
        return;
      }
      vscode.window.showInformationMessage(
        "AgenticQA: orchestrator built ✅ — starting your request."
      );
      // fall through and continue the run
    }

    // Prompt-first auto knowledge-pack (N2.4): on a fresh generate-and-run, if this looks like a
    // code-accessible app with no pack, offer to generate one first, then continue the original run.
    if (opts.runMode === "generate_and_run") {
      const dismissed = context.workspaceState.get<boolean>(
        "agenticqa.packPromptDismissed",
        false
      );
      if (!dismissed && !(await hasKnowledgePack(workspacePath))) {
        const fw = await detectCodeAccessibleApp(workspacePath);
        if (fw) {
          const choice = await vscode.window.showInformationMessage(
            `AgenticQA detected a ${fw} app with no knowledge pack. Generate one now? It crawls your app and reads your routes + seed credentials to make generated tests more accurate (one-time).`,
            "Generate",
            "Skip",
            "Don't ask again"
          );
          if (choice === "Generate") {
            await runOrchestrator({
              runMode: "generate_pack",
              text: "GENERATE_PACK",
              skipUrlExtraction: true,
            });
            // pack now exists — fall through and continue the original request
          } else if (choice === "Don't ask again") {
            await context.workspaceState.update("agenticqa.packPromptDismissed", true);
          }
        }
      }
    }

    output.show(true);
    output.appendLine("────────────────────────────────────────");
    output.appendLine(
      `Starting orchestrator (mode=${opts.runMode}) — engine: ${ENGINE_KIND_LABELS[engine.kind]} ` +
        `(${engine.path})`
    );

    let baseUrlOverride: string | undefined;
    let startUrlOverride: string | undefined;

    if (!opts.skipUrlExtraction && !looksLikeQuestion(opts.text)) {
      const extractedUrl = extractUrlFromText(opts.text);
      if (extractedUrl) {
        let parsed: URL;
        try {
          parsed = new URL(extractedUrl);
        } catch {
          vscode.window.showErrorMessage(
            `Invalid URL in request: ${extractedUrl}`
          );
          return;
        }

        const choice = await vscode.window.showQuickPick(
          [
            { label: "Use once", value: "once" as const },
            {
              label: "Save as default for this workspace",
              value: "save" as const,
            },
          ],
          { placeHolder: `URL found: ${extractedUrl}` }
        );

        if (!choice) {return;}

        baseUrlOverride = parsed.origin;
        startUrlOverride = extractedUrl;

        if (choice.value === "save") {
          const cfg = await readWorkspaceAgenticQaConfig(workspacePath);
          cfg.baseUrl = parsed.origin;
          if (!cfg.testDir) {cfg.testDir = "tests/generated";}
          await writeWorkspaceAgenticQaConfig(workspacePath, cfg);
        }
      }
    }

    // Read the user's API/model settings (SecretStorage key + native settings) once, up front, so we can
    // enforce the free-model policy BEFORE starting the run. Only user-set values become an env overlay;
    // anything blank falls through to the orchestrator's bundled .env (preserving today's behavior + 20/20).
    const userConfig = await readUserConfig(context);

    // First run on a fresh install with no key: explain once, here, where the advice is actionable —
    // rather than degrading silently into the deterministic planner and letting the user conclude the
    // extension is broken (blocker B4).
    await maybeShowWelcome(context);

    const policy = evaluateModelPolicy(userConfig);
    if (policy.blocks.length) {
      const pick = await vscode.window.showErrorMessage(
        `AgenticQA: these models aren't free and no API key is configured — ${policy.blocks.join(
          ", "
        )}. Add your own API key, or pick ":free" models.`,
        "Open Settings",
        "Cancel"
      );
      if (pick === "Open Settings") {
        await openSettingsPanel(context);
      }
      return;
    }

    // Not fatal — deterministic planning genuinely works without an LLM, and for an app with a knowledge
    // pack it is the normal path. But it must be SAID: a thin test with no explanation is the difference
    // between "not configured" and "broken", and only one of those is the user's to fix.
    if (!userConfig.usingOwnKey) {
      output.appendLine(
        "[EXT] No API key configured. Deterministic planning still works for scenarios covered by the " +
          "app's knowledge pack; new scenarios, Domain Q&A and LLM-assisted self-heal are unavailable."
      );
    }
    if (policy.warns.length) {
      vscode.window.showWarningMessage(
        `AgenticQA: using non-free model(s) on your own key (may incur charges) — ${policy.warns.join(", ")}.`
      );
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "AgenticQA",
        cancellable: true,
      },
      async (progress, token) => {
        const envOverlay = buildEnvOverlay(userConfig, {
          promptDir: promptOverrideDir(context),
          cacheDir: engineCacheDir(context),
        });
        logConfigSource(output, userConfig);

        return new Promise<void>((resolve) => {
          progress.report({ message: "Starting orchestrator..." });

          const child = spawn(process.execPath, [engine.path], {
            cwd: workspacePath,
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env, ...envOverlay },
          });

          token.onCancellationRequested(() => {
            output.appendLine("[EXT] Cancelling orchestrator…");
            try {
              const pid = child.pid;
              if (pid && process.platform === "win32") {
                spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { shell: true });
              } else {
                child.kill();
              }
            } catch {}
            vscode.window.showInformationMessage("AgenticQA: run cancelled.");
            resolve();
          });

          child.on("error", (err) => {
            output.appendLine(
              "[EXT] Failed to spawn orchestrator: " + String(err)
            );
            vscode.window.showErrorMessage(
              `Failed to start orchestrator: ${String(err).substring(0, 100)}`
            );
            resolve();
          });

          // Track if this is a domain QA request
          let isDomainQa = false;
          let domainQaQuestion = opts.text;
          let hasConfigError = false;

          let stdoutBuf = "";
child.stdout.on("data", (buf) => {
      stdoutBuf += buf.toString("utf8");
      let idx;
      while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) {
          continue;
        }

        // ── Handle DOMAIN_QA_ANSWER message type ──
        try {
          const msg = JSON.parse(line);
          if (msg.type === "DOMAIN_QA_ANSWER") {
            chatProvider.addMessage({
              role: "assistant",
              type: "domain_qa",
              question: domainQaQuestion,
              answer: msg.answer
            });
            continue;
          }
          if (msg.type === "CASUAL_ANSWER") {
            chatProvider.addMessage({
              role: "assistant",
              type: "casual",
              text: msg.text
            });
            continue;
          }
        } catch {
          // Not JSON or not a handled type — continue to normal handling
        }

        // Don't show raw RUN_SUMMARY JSON in output (it's for TreeView only)
        // Check both escaped and unescaped forms
        if (
          !line.includes('"__type":"RUN_SUMMARY"') &&
          !line.includes('\\"__type\\":\\"RUN_SUMMARY\\"')
        ) {
          output.appendLine("[ORCH] " + line);
        }

        // ── Parse orchestrator messages ──
        try {
          const msg = JSON.parse(line);
          if (msg.type === "LOG" && typeof msg.message === "string") {
                  const m = msg.message;

                  // ── Progress notifications ──
                  if (m.includes("Intent = DOMAIN_QA")) {
                    isDomainQa = true;
                    progress.report({ message: "📖 Domain Q&A..." });
                  } else if (m.includes("Intent =")) {
                    const intent = m.split("Intent = ")[1]?.split(" ")[0];
                    progress.report({ message: `Routing: ${intent}...` });
                  } else if (
                    m.includes("Planner:") &&
                    m.includes("calling")
                  ) {
                    progress.report({ message: "🤖 Planning test steps..." });
                  } else if (m.includes("Planner: plan parsed")) {
                    progress.report({ message: "📋 Test plan ready" }); 
                  } else if (m.includes("PreInspect: starting")) {
                    progress.report({
                      message: "🔍 Pre-inspecting page...",
                    });
                  } else if (m.includes("PreInspect: found")) {
                    progress.report({
                      message: "📋 Page structure captured",
                    });
                  }else if (m.includes("UI Inspector: starting")) {
                    progress.report({
                      message: "🔍 Inspecting UI elements...",
                    });
                  } else if (m.includes("UI Inspector: closing")) {
                    progress.report({ message: "✅ UI inspection complete" });
                  } else if (m.includes("Generator:")) {
                    progress.report({ message: "📝 Generating test code..." });
                  } else if (m.includes("Running Playwright")) {
                    progress.report({
                      message: "🎭 Running Playwright tests...",
                    });
                  } else if (
                    m.includes("SelfHeal: vector-heal") ||
                    m.includes("SelfHeal: attempting")
                  ) {
                    progress.report({
                      message: "🔧 Self-healing locators...",
                    });
                  } else if (m.includes("SelfHeal: re-running")) {
                    progress.report({
                      message: "🔄 Re-running after heal...",
                    });
                  } else if (m.includes("DomainQA: fetching")) {
                    progress.report({
                      message: "🌐 Fetching documentation...",
                    });
                  } else if (m.includes("DomainQA: composing")) {
                    progress.report({ message: "💬 Composing answer..." });
                  } else if (m.includes("WebServer: not reachable")) {
                    progress.report({ message: "🚀 Starting web server..." });
                  } else if (m.includes("WebServer: now reachable")) {
                    progress.report({ message: "✅ Web server ready" });
                  } else if (m.includes("Explore: starting crawl")) {
                    progress.report({ message: "🧭 Crawling the app..." });
                  } else if (m.includes("Explore: synthesized")) {
                    progress.report({ message: "🧪 Synthesizing candidate flows..." });
                  } else if (m.includes("Explore: selected")) {
                    progress.report({ message: "🤖 Ranking flows with AI..." });
                  } else if (m.includes("Explore: [")) {
                    progress.report({ message: "📝 Running a discovered flow..." });
                  } else if (m.includes("Explore: complete")) {
                    progress.report({ message: "📊 Exploration complete!" });
                  } else if (m.includes("PackGen: extracted")) {
                    progress.report({ message: "🔎 Reading routes & credentials..." });
                  } else if (m.includes("PackGen: crawling")) {
                    progress.report({ message: "🧭 Crawling your app..." });
                  } else if (m.includes("PackGen: validating")) {
                    progress.report({ message: "✅ Validating golden flows..." });
                  } else if (m.includes("PackGen: wrote") || m.includes("PackGen: complete")) {
                    progress.report({ message: "📦 Knowledge pack ready!" });
                  } else if (m.includes("PackGen:")) {
                    progress.report({ message: "📦 Generating knowledge pack..." });
                  } else if (m.includes("Test Run Summary")) {
                    progress.report({ message: "📊 Done!" });
                  } else if (m.includes("Domain Q&A Answer")) {
                    progress.report({ message: "📊 Answer ready!" });
                  }

// ── TreeView: capture RUN_SUMMARY ──
try {
  const inner = JSON.parse(m);
  if (inner.__type === "RUN_SUMMARY") {
    const summary: RunSummary = {
      runId: inner.runId,
      persisted: inner.persisted,
      status: inner.status,
      wasHealed: inner.wasHealed,
      statusLabel: inner.statusLabel,
      testTitle: inner.testTitle,
      stepsTotal: inner.stepsTotal,
      stepsPassed: inner.stepsPassed,
      stepsFailed: inner.stepsFailed,
      durationMs: inner.durationMs,
      executionProject: inner.executionProject,
      baseUrl: inner.baseUrl,
      startUrl: inner.startUrl,
      failureClass: inner.failureClass,
      healAttempts: inner.healAttempts,
      healSucceeded: inner.healSucceeded,
      steps: inner.steps ?? [],
      htmlReport: inner.htmlReport,
      jsonReport: inner.jsonReport,
      testFile: inner.testFile,
      workspacePath: inner.workspacePath,
      timestamp: inner.timestamp,
      requestText: inner.requestText,
      testPlan: inner.testPlan,
      aiAnalysis: inner.aiAnalysis,
      assertionsRetargeted: inner.assertionsRetargeted,
      healingSkipReason: inner.healingSkipReason,
      planningDegraded: inner.planningDegraded,
      planningDegradedReason: inner.planningDegradedReason,
    };
    treeProvider.addRun(summary);
  }
} catch {
  // m was not JSON — that's fine (most messages aren't)
}

                  // ── TreeView: capture Domain QA answers ──
                  if (isDomainQa && m.includes("Domain Q&A Answer")) {
                    treeProvider.addDomainQa({
                      question: domainQaQuestion,
                      timestamp: new Date().toISOString(),
                    });
                  }
                }
              } catch {
                // Not JSON
              }
            }
          });

          child.stderr.on("data", (buf) => {
            const msg = buf.toString("utf8");
            output.appendLine("[ORCH-ERR] " + msg);

            // Detect configuration errors and show helpful messages
            if (msg.includes("CONFIGURATION ERROR")) {
              hasConfigError = true;
              output.appendLine(
                "[EXT] 🔧 Configuration issue detected. Check Output panel for details."
              );
            }
            if (
              msg.includes("DATABASE_URL") ||
              msg.includes("OPENAI_API_KEY")
            ) {
              output.appendLine(
                "[EXT] 💡 Tip: See SETUP.md for configuration instructions"
              );
            }
          });

          child.stdin.write(
            JSON.stringify({
              type: "NEW_REQUEST",
              text: opts.text,
              workspacePath,
              runMode: opts.runMode,
              overrides: {
                baseUrl: baseUrlOverride,
                startUrl: startUrlOverride,
              },
              // Omitted for a normal run, which the orchestrator then executes on chromium only — the
              // inner loop should not pay for cross-browser coverage on every iteration (G5.1 / D6).
              ...(opts.allProjects ? { execution: { allProjects: true } } : {}),
              // Sent only when a person confirmed the trade. The engine refuses to replace a curated
              // pack without it, so an accidental or scripted run cannot destroy hand-written flows.
              ...(opts.overwriteCuratedPack ? { overwriteCuratedPack: true } : {}),
            }) + "\n"
          );
          child.stdin.end();

          child.on("close", (code) => {
            if (code === 0) {
              vscode.window.showInformationMessage(
                "AgenticQA: completed successfully ✅"
              );
            } else if (hasConfigError) {
              vscode.window.showErrorMessage(
                "AgenticQA: configuration error — check packages/orchestrator/.env (see the Output panel)."
              );
            } else {
              vscode.window
                .showWarningMessage(
                  `AgenticQA: finished with issues (exit ${code}). See the Output panel for details.`,
                  "Show Output"
                )
                .then((pick) => {
                  if (pick === "Show Output") {
                    output.show(true);
                  }
                });
            }
            resolve();
          });
        });
      }
    );
  }

  /* ═══ Command 1: Generate + Run ═══ */
  const cmdGenerate = vscode.commands.registerCommand(
    "agenticqa.newRequest",
    async (textArg?: string) => {
      let text = textArg;
      if (!text) {
        text = await vscode.window.showInputBox({
          prompt:
            "Describe the test you want, or ask a question about an allowlisted domain.",
        });
      }
      if (!text) {return;}
      await runOrchestrator({ runMode: "generate_and_run", text });
    }
  );

  /* ═══ Command 1b: the same run, across every configured browser ═══ */
  // Cross-browser coverage is a release-time question, so it gets its own deliberate action rather than
  // being the silent cost of every iteration (G5.1 / D6).
  const cmdNewTestAllBrowsers = vscode.commands.registerCommand(
    "agenticqa.newTestAllBrowsers",
    async () => {
      const text = await vscode.window.showInputBox({
        prompt: "Describe the test — it will run across every browser your Playwright config defines.",
        placeHolder: "Add a product to the cart and verify the cart badge updates",
      });
      if (!text) {return;}
      await runOrchestrator({ runMode: "generate_and_run", text, allProjects: true });
    }
  );

  /* ═══ Command 2: Run-only + Heal ═══ */
  const cmdRunOnly = vscode.commands.registerCommand(
    "agenticqa.runOnly",
    async () => {
      const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!rootPath) {
        vscode.window.showErrorMessage("Open a folder first.");
        return;
      }
      const { configRoot } = await getAgenticQaConfigInfo(rootPath);
      let cfg: any = {};
      try {
        cfg = JSON.parse(await fs.readFile(path.join(configRoot, ".agenticqa.json"), "utf8"));
      } catch {}
      const testDirName = cfg.testDir ?? "tests/generated";
      const testsDir = path.join(configRoot, testDirName);
      
      let specFiles: string[] = [];
      try {
        const files = await fs.readdir(testsDir);
        specFiles = files.filter(f => f.endsWith(".spec.ts"));
      } catch {}

      let targetText = "RUN_ONLY";
      if (specFiles.length > 0) {
        const ALL = "$(play-circle) Run All Tests";
        const options = [ALL, ...specFiles.map(f => `$(file-code) ${f}`)];
        const choice = await vscode.window.showQuickPick(options, {
          placeHolder: "Select a test to run, or run all"
        });
        if (!choice) {return;}
        if (choice !== ALL) {
          const fileName = choice.replace("$(file-code) ", "");
          // Pass the specific file path
          targetText = `RUN_ONLY ${testDirName}/${fileName}`;
        }
      }

      await runOrchestrator({
        runMode: "run_only",
        text: targetText,
        skipUrlExtraction: true,
      });
    }
  );

  /* ═══ Command: Explore App (autonomous test discovery) ═══ */
  const cmdExplore = vscode.commands.registerCommand(
    "agenticqa.exploreApp",
    async () => {
      const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!rootPath) {
        vscode.window.showErrorMessage(
          "Open a folder first (workspace required)."
        );
        return;
      }
      const choice = await vscode.window.showInformationMessage(
        "AgenticQA will crawl the app's public pages, discover candidate user flows, rank them with AI, then generate + run the top ones. Continue?",
        "Explore",
        "Cancel"
      );
      if (choice !== "Explore") {
        return;
      }
      await runOrchestrator({
        runMode: "explore",
        text: "EXPLORE",
        skipUrlExtraction: true,
      });
    }
  );

  /* ═══ Command: Generate Knowledge Pack (auto pack for code-accessible apps) ═══ */
  const cmdGeneratePack = vscode.commands.registerCommand(
    "agenticqa.generatePack",
    async () => {
      const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!rootPath) {
        vscode.window.showErrorMessage("Open a folder first (workspace required).");
        return;
      }
      // Works for both kinds of target. With app source in the workspace it also reads routes + seed
      // credentials statically; for a hosted-only URL it generates from the live crawl alone (G1.4).
      const codeApp = await detectCodeAccessibleApp(
        (await getAgenticQaConfigInfo(rootPath)).configRoot
      );
      const choice = await vscode.window.showInformationMessage(
        codeApp
          ? `AgenticQA will crawl this ${codeApp} app, read its routes + seed credentials from source, synthesize a knowledge pack, validate the flows by running them, and save .agenticqa/knowledge.json. Continue?`
          : "No app source detected in this workspace, so AgenticQA will generate the pack from the LIVE APP only: crawl it, synthesize candidate flows, validate them by running, and save .agenticqa/knowledge.json. Credentials can't be discovered this way and will be omitted, so auth flows won't be included. Continue?",
        "Generate",
        "Cancel"
      );
      if (choice !== "Generate") {
        return;
      }

      // A pack marked `curated: true` was written by hand. Generation replaces a pack wholesale — no
      // flow is carried over — so this is the point to say what is being traded, in the units that
      // matter (flows), before anything is destroyed. The engine refuses without this flag regardless;
      // the modal exists so the refusal is never the way a user finds out (D30/D38).
      let overwriteCuratedPack = false;
      const existing = await readKnowledgePackSummary(
        (await getAgenticQaConfigInfo(rootPath)).configRoot
      );
      if (existing?.curated) {
        const confirm = await vscode.window.showWarningMessage(
          `This app ships a hand-written knowledge pack with ${existing.flowCount} flow(s). ` +
            `Generating will REPLACE it — every hand-written flow is discarded, not merged. A timestamped ` +
            `backup is saved beside it. Replace the curated pack?`,
          { modal: true },
          "Replace it"
        );
        if (confirm !== "Replace it") {
          return;
        }
        overwriteCuratedPack = true;
      }

      await runOrchestrator({
        runMode: "generate_pack",
        overwriteCuratedPack,
        text: "GENERATE_PACK",
        skipUrlExtraction: true,
      });
    }
  );

  /* ═══ Command 3: Clear run history ═══ */
  const cmdClear = vscode.commands.registerCommand(
    "agenticqa.clearRuns",
    () => {
      treeProvider.clear();
      vscode.window.showInformationMessage("AgenticQA: Run history cleared");
    }
  );

  /* ═══ Command 4: Clean generated tests ═══ */
  const cmdCleanTests = vscode.commands.registerCommand(
    "agenticqa.cleanTests",
    async () => {
      const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!rootPath) {
        vscode.window.showErrorMessage(
          "Open a folder first (workspace required)."
        );
        return;
      }

      const { configRoot } = await getAgenticQaConfigInfo(rootPath);
      const cfg = await readWorkspaceAgenticQaConfig(configRoot);
      const testsDir = path.join(
        configRoot,
        cfg.testDir ?? "tests/generated"
      );
      
      try {
        // Check if tests/generated directory exists
        try {
          await fs.access(testsDir);
        } catch {
          vscode.window.showInformationMessage(
            "AgenticQA: No generated tests folder found"
          );
          return;
        }

        // Read all .spec.ts files in the generated tests folder
        const files = await fs.readdir(testsDir);
        const specFiles = files.filter(
          (f) => f.endsWith(".spec.ts") && f !== ".gitkeep"
        );

        if (specFiles.length === 0) {
          vscode.window.showInformationMessage(
            "AgenticQA: No generated tests to clean"
          );
          return;
        }

        // Show confirmation with file count
        const choice = await vscode.window.showWarningMessage(
          `AgenticQA: Delete ${specFiles.length} generated test file(s)?`,
          { modal: true, detail: `Files to delete:\n${specFiles.join("\n")}` },
          { title: "Delete All", isCloseAffordance: false },
          { title: "Cancel", isCloseAffordance: true }
        );

        if (!choice || choice.title === "Cancel") {
          return;
        }

        // Delete all spec files
        let deletedCount = 0;
        for (const file of specFiles) {
          try {
            await fs.unlink(path.join(testsDir, file));
            deletedCount++;
          } catch (err: any) {
            output.appendLine(
              `[EXT] Failed to delete ${file}: ${err?.message ?? String(err)}`
            );
          }
        }

        vscode.window.showInformationMessage(
          `AgenticQA: Deleted ${deletedCount}/${specFiles.length} test file(s) ✅`
        );
        output.appendLine(
          `────────────────────────────────────────`
        );
        output.appendLine(
          `Cleaned ${deletedCount} generated test file(s) from ${testsDir}`
        );
      } catch (err: any) {
        vscode.window.showErrorMessage(
          `AgenticQA: Failed to clean tests — ${err?.message ?? String(err)}`
        );
      }
    }
  );

  /* ═══ Command 5: Doctor ═══ */
  const cmdDoctor = vscode.commands.registerCommand(
    "agenticqa.doctor",
    async () => {
      const rootPath =
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

      output.show(true);
      output.appendLine("────────────────────────────────────────");
      output.appendLine("AgenticQA Doctor — checking prerequisites...");
      output.appendLine("");

      const checks: Array<{
        label: string;
        status: "✅" | "❌" | "⚠️" | "⚪";
        detail: string;
        optional?: boolean;
      }> = [];

      // 1. Node.js
      try {
        const nodeVersion = process.version;
        const major = parseInt(nodeVersion.slice(1), 10);
        checks.push({
          label: "Node.js",
          status: major >= 18 ? "✅" : "❌",
          detail:
            major >= 18
              ? `${nodeVersion} (requires 18+)`
              : `${nodeVersion} — requires 18+`,
        });
      } catch {
        checks.push({
          label: "Node.js",
          status: "❌",
          detail: "Could not determine version",
        });
      }

      // 2. Docker
      try {
        const r = spawnSync("docker", ["info"], {
          shell: true,
          timeout: 5000,
          stdio: "pipe",
        });
        checks.push({
          label: "Docker",
          status: r.status === 0 ? "✅" : "⚪",
          optional: true,
          detail: r.status === 0 ? "Running" : "Not running (optional — enables DB-backed features)",
        });
      } catch {
        checks.push({
          label: "Docker",
          status: "⚪",
          optional: true,
          detail: "Not found (optional)",
        });
      }

      // 3. DB
      try {
        const r = spawnSync(
          "docker",
          ["exec", "agenticqa-db", "pg_isready", "-U", "agenticqa"],
          { shell: true, timeout: 5000, stdio: "pipe" }
        );
        checks.push({
          label: "PostgreSQL+pgvector",
          status: r.status === 0 ? "✅" : "⚪",
          optional: true,
          detail:
            r.status === 0
              ? "Container running"
              : "Not running (optional — vector self-heal + run history; `docker compose up -d` to enable)",
        });
      } catch {
        checks.push({
          label: "PostgreSQL+pgvector",
          status: "⚪",
          optional: true,
          detail: "Not checked (optional)",
        });
      }

      // 4. Engine
      //
      // Reports WHICH engine would run, not merely that one exists. A stale monorepo sibling shadowing
      // the engine you think you installed is invisible otherwise, and it is the single most confusing
      // state this extension can be in.
      const doctorEngine = await locateEngine(context);
      checks.push(
        doctorEngine
          ? {
              label: "Engine",
              status: "✅",
              detail: `${ENGINE_KIND_LABELS[doctorEngine.kind]} — ${doctorEngine.path}`,
            }
          : {
              label: "Engine",
              status: "❌",
              detail: "Not found — see the Output panel for the locations searched",
            }
      );

      // 5. .env
      //
      // Monorepo-only: a packaged install has no `.env` and never will, so the row is skipped there
      // rather than reporting a permanent ⚪ against a file the user cannot create usefully. The key
      // that actually matters is checked in 5b, from the effective settings overlay.
      const envPath = path.join(monorepoOrchestratorDir(context.extensionPath), ".env");
      try {
        const env = await fs.readFile(envPath, "utf8");
        const val = (k: string): string => {
          const m = env.match(new RegExp(`^${k}=(.*)$`, "m"));
          return m ? m[1].trim() : "";
        };
        // Kept in sync with the orchestrator's ConfigValidator.isPlaceholderKey: a freshly-copied
        // .env.example ships bare provider prefixes (`sk-or-v1-`, `nvapi-`), which must count as
        // "not set". The prefix list comes from the model catalog so adding a provider needs no edit here.
        const isPlaceholderKey = (v: string) =>
          isPlaceholderApiKey(v) || /change[_-]?me|xxx+|your[_-]?key|placeholder/i.test(v);
        // ⚠️ A KEY is what makes the LLM features work. `OPENAI_MODEL` must NOT be required here: it is
        // the force-one-model-on-every-role knob, and `.env.example` explicitly says "Prefer leaving it
        // unset" so the per-role catalog defaults apply. Requiring it made Doctor report
        // "LLM keys — Not set" on a correctly configured install, which is exactly backwards: the
        // recommended configuration was the one being flagged.
        const hasLlm = !isPlaceholderKey(val("OPENAI_API_KEY"));
        const embed = !!val("OPENAI_EMBED_MODEL");
        checks.push({
          label: "LLM keys (.env)",
          status: hasLlm ? "✅" : "⚪",
          optional: true,
          detail: hasLlm
            ? `Key present${val("OPENAI_MODEL") ? ` · OPENAI_MODEL=${val("OPENAI_MODEL")} (forces ONE model on every role)` : " · per-role model defaults"}${
                embed ? " · embeddings on" : " · no embed model (vector self-heal off)"
              }`
            : "No key in .env (optional — a key may still come from the Settings panel; see the line below)",
        });
      } catch {
        // No `.env`. In a monorepo checkout that is worth saying, because copying `.env.example` is a
        // real next step. In a packaged install there is nowhere to copy it TO — the advice would be
        // unfollowable — so the row is omitted entirely and 5b below carries the answer that matters.
        if (doctorEngine?.kind === "monorepo") {
          checks.push({
            label: "LLM keys (.env)",
            status: "⚪",
            optional: true,
            detail: "No .env (optional — copy .env.example to enable LLM features)",
          });
        }
      }

      // 5b. Effective AgenticQA settings overlay (Settings panel / settings.json + SecretStorage key).
      // This is what actually wins at run time — it overrides the bundled .env above.
      try {
        const uc = await readUserConfig(context);
        const roleOverrides = AGENT_ROLES.filter((r) => uc.models[r]).map(
          (r) => `${r}=${uc.models[r]}`
        );
        const bits = [
          uc.usingOwnKey ? "key: configured (SecretStorage)" : "key: NOT CONFIGURED",
          `baseURL: ${uc.baseUrl ?? "default"}`,
          uc.globalModel
            ? `model (all): ${uc.globalModel}`
            : roleOverrides.length
              ? `models: ${roleOverrides.join(", ")}`
              : "models: defaults",
          `embed: ${uc.embedModel ?? "default"}`,
        ];
        const policy = evaluateModelPolicy(uc);
        checks.push({
          label: "AgenticQA config (Settings)",
          status: policy.blocks.length ? "⚠️" : "✅",
          optional: true,
          detail:
            bits.join(" · ") +
            (policy.blocks.length
              ? ` — ⚠ non-free on bundled key (runs will be blocked): ${policy.blocks.join(", ")}`
              : ""),
        });
      } catch {
        // settings unreadable — non-fatal
      }

      // 6. Workspace
      if (rootPath) {
        const { configPath, configRoot } = await getAgenticQaConfigInfo(rootPath);
        try {
          const cfg = JSON.parse(await fs.readFile(configPath, "utf8"));
          checks.push({
            label: ".agenticqa.json",
            status: "✅",
            detail: `baseUrl=${cfg.baseUrl ?? "(not set)"} (${configPath})`,
          });
        } catch {
          checks.push({
            label: ".agenticqa.json",
            status: "⚠️",
            detail: `Not found — will be created in ${configRoot}`,
          });
        }

        // Playwright
        let pwFound = false;
        let dir = configRoot;
        for (let i = 0; i < 5; i++) {
          try {
            await fs.access(
              path.join(dir, "node_modules", "@playwright", "test")
            );
            pwFound = true;
            break;
          } catch {}
          const parent = path.dirname(dir);
          if (parent === dir) {break;}
          dir = parent;
        }
        if (!pwFound) {
          try {
            const r = spawnSync("npx", ["playwright", "--version"], {
              cwd: configRoot,
              shell: true,
              timeout: 10000,
              stdio: "pipe",
            });
            if (r.status === 0) {pwFound = true;}
          } catch {}
        }
        checks.push({
          label: "Playwright",
          status: pwFound ? "✅" : "❌",
          detail: pwFound ? "Available" : "Not installed",
        });

        // The package being present is NOT the same as being able to run. `npm i -D @playwright/test`
        // downloads no browsers, and bumping Playwright changes which browser build is required — so a
        // project that ran yesterday can stop running today. Left unchecked, that surfaces as
        // "Executable doesn't exist at …" buried in the output panel, which reads as an AgenticQA bug.
        if (pwFound) {
          const browsers = await checkPlaywrightBrowsers({
            dryRun: async () => {
              // Scoped to chromium ON PURPOSE. A prompted run executes chromium-only (G5.1/D6), so
              // reporting absent Firefox/WebKit as a failure would be a false alarm for the default
              // workflow — and a Doctor that cries wolf stops being read. Someone opting into the full
              // matrix gets Playwright's own (clear) error for the browser they actually asked for.
              const r = spawnSync("npx", ["playwright", "install", "--dry-run", "chromium"], {
                cwd: configRoot,
                shell: true,
                timeout: 30000,
                stdio: "pipe",
                encoding: "utf8",
              });
              if (r.error || r.status !== 0) {return undefined;}
              return `${r.stdout ?? ""}
${r.stderr ?? ""}`;
            },
            exists: pathExists,
          });
          checks.push({
            label: "Playwright browsers",
            // Inconclusive is reported as a warning, not a failure: telling someone to download
            // browsers they already have (because npx timed out) teaches them to ignore Doctor.
            status: browsers.ok ? "✅" : browsers.error ? "⚪" : "❌",
            optional: !!browsers.error,
            detail: `${describeBrowserCheck(browsers)} (chromium — the default run target)`,
          });
        }
      }

      // Output
      output.appendLine(
        "══════════════════════════════════════════"
      );
      output.appendLine("  AgenticQA — Doctor Report");
      output.appendLine("  (Docker/Postgres + LLM keys are OPTIONAL — the core works without them.)");
      output.appendLine(
        "══════════════════════════════════════════"
      );

      let requiredOk = true;
      for (const c of checks) {
        output.appendLine(`  ${c.status} ${c.label}${c.optional ? "  (optional)" : ""}`);
        output.appendLine(`     ${c.detail}`);
        if (!c.optional && c.status === "❌") {requiredOk = false;}
      }

      output.appendLine(
        "══════════════════════════════════════════"
      );
      output.appendLine(
        requiredOk
          ? "  Ready to go! 🚀  (optional items add DB-backed + LLM features)"
          : "  Fix the ❌ required items above."
      );

      vscode.window[requiredOk ? "showInformationMessage" : "showWarningMessage"](
        requiredOk
          ? "AgenticQA Doctor: ready ✅  (Docker & LLM keys are optional)"
          : "AgenticQA Doctor: required items missing. See Output."
      );
    }
  );

/* ═══ Command 6: Preview HTML Report in Webview ═══ */
const cmdPreviewHtmlReport = vscode.commands.registerCommand(
  "agenticqa.previewHtmlReport",
  async (item?: vscode.TreeItem) => {
    const runItem = item as any;
    const summary: RunSummary | undefined = runItem?.summary;

    if (!summary) {
      vscode.window.showErrorMessage("AgenticQA: no run data for this report.");
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "agenticqaHtmlReport",
      `AgenticQA Report — ${summary.testTitle ?? summary.runId ?? "run"}`,
      vscode.ViewColumn.Two,
      { enableScripts: true }
    );

    const nonce = crypto.randomBytes(16).toString("hex");
    const inlined = await inlineScreenshots(summary);
    panel.webview.html = buildReportHtml(inlined, {
      interactive: true,
      nonce,
      version: context.extension?.packageJSON?.version,
    });

    // The branded report's "Open full Playwright report" button asks us to open the raw report
    // in the default browser (renders the Playwright SPA properly).
    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === "openPlaywright" && summary.htmlReport && summary.workspacePath) {
        const uri = vscode.Uri.joinPath(
          vscode.Uri.file(summary.workspacePath),
          summary.htmlReport
        );
        await vscode.env.openExternal(uri);
      }
    });
  }
);

/* ═══ Command 7: Open HTML Report (external) ═══ */
const cmdOpenReport = vscode.commands.registerCommand(
  "agenticqa.openHtmlReport",
  async (item?: vscode.TreeItem) => {
    const runItem = item as any;
    const summary = runItem?.summary;
    const reportPath = summary?.htmlReport;
    if (!reportPath) {
      vscode.window.showErrorMessage(
        "AgenticQA: No HTML report available for this run."
      );
      return;
    }
    const reportUri = summary?.workspacePath
      ? vscode.Uri.joinPath(vscode.Uri.file(summary.workspacePath), reportPath)
      : vscode.Uri.file(reportPath);
    await vscode.commands.executeCommand("vscode.open", reportUri);
  }
);

/* ═══ Command 8: Export branded report → PDF ═══ */
const cmdExportReport = vscode.commands.registerCommand(
  "agenticqa.exportReport",
  async (item?: vscode.TreeItem) => {
    const summary: RunSummary | undefined = (item as any)?.summary;
    if (!summary) {
      vscode.window.showErrorMessage("AgenticQA: no run data to export.");
      return;
    }

    const root =
      summary.workspacePath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      vscode.window.showErrorMessage("AgenticQA: open a folder first.");
      return;
    }

    // Build a stable, readable file name from the test title / request + run id.
    const base =
      (summary.testTitle || summary.requestText || "report")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 50) || "report";
    const shortId = String(summary.runId ?? "run").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 12);
    const reportsDir = path.join(root, "agenticqa-reports");
    const filePath = path.join(reportsDir, `${base}-${shortId}.html`);

    try {
      await fs.mkdir(reportsDir, { recursive: true });
      const nonce = crypto.randomBytes(16).toString("hex");
      const inlined = await inlineScreenshots(summary);
      const html = buildReportHtml(inlined, {
        nonce,
        autoPrint: true,
        version: context.extension?.packageJSON?.version,
      });
      await fs.writeFile(filePath, html, "utf8");

      // Render in a webview that auto-opens the print dialog → user picks "Save as PDF".
      const panel = vscode.window.createWebviewPanel(
        "agenticqaExport",
        `Export — ${summary.testTitle ?? "report"}`,
        vscode.ViewColumn.Active,
        { enableScripts: true }
      );
      panel.webview.html = html;
      panel.webview.onDidReceiveMessage(async (msg) => {
        if (msg?.type === "openPlaywright" && summary.htmlReport && summary.workspacePath) {
          await vscode.env.openExternal(
            vscode.Uri.joinPath(vscode.Uri.file(summary.workspacePath), summary.htmlReport)
          );
        }
      });

      const rel = path.relative(root, filePath).replace(/\\/g, "/");
      const choice = await vscode.window.showInformationMessage(
        `AgenticQA: report ready — choose "Save as PDF" in the print dialog. Saved HTML: ${rel}`,
        "Reveal HTML",
        "Open in Browser"
      );
      if (choice === "Reveal HTML") {
        await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(filePath));
      } else if (choice === "Open in Browser") {
        await vscode.env.openExternal(vscode.Uri.file(filePath));
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(
        `AgenticQA: failed to export report — ${err?.message ?? String(err)}`
      );
    }
  }
);

  /* ═══ Command 9: View Test File ═══ */
  const cmdViewTestFile = vscode.commands.registerCommand(
    "agenticqa.viewTestFile",
    async (item?: vscode.TreeItem) => {
      const node = item as any;
      const testFile: string | undefined = node?.testFile ?? node?.summary?.testFile;
      const wsPath: string | undefined = node?.workspacePath ?? node?.summary?.workspacePath;
      if (!testFile) {
        vscode.window.showErrorMessage(
          "AgenticQA: No test file associated with this run."
        );
        return;
      }
      // The summary stores a workspace-relative spec path; resolve it to an absolute path.
      const abs = path.isAbsolute(testFile)
        ? testFile
        : wsPath
          ? path.join(wsPath, testFile)
          : testFile;
      try {
        await vscode.window.showTextDocument(vscode.Uri.file(abs));
      } catch {
        vscode.window.showErrorMessage(`AgenticQA: could not open ${abs}`);
      }
    }
  );

  /* ═══ Command 10: Re-run this test (run_only on its spec) ═══ */
  const cmdRerun = vscode.commands.registerCommand(
    "agenticqa.rerunTest",
    async (item?: vscode.TreeItem) => {
      const summary: RunSummary | undefined = (item as any)?.summary;
      if (!summary?.testFile) {
        vscode.window.showErrorMessage("AgenticQA: no spec file for this run.");
        return;
      }
      await runOrchestrator({
        runMode: "run_only",
        text: `RUN_ONLY ${summary.testFile}`,
        skipUrlExtraction: true,
      });
    }
  );

  /* ═══ Command: Open Settings panel ═══ */
  const cmdSettings = vscode.commands.registerCommand(
    "agenticqa.settings",
    async () => {
      await openSettingsPanel(context);
    }
  );

  /* ═══ Command 11: Set API Key (SecretStorage) ═══ */
  const cmdSetApiKey = vscode.commands.registerCommand(
    "agenticqa.setApiKey",
    async () => {
      const existing = await context.secrets.get(SECRET_API_KEY);
      const key = await vscode.window.showInputBox({
        title: "AgenticQA: Set API Key",
        prompt:
          "Your API key for the configured provider. Stored securely in VS Code SecretStorage (never written to settings.json).",
        placeHolder: existing
          ? "•••••••• (a key is already saved — type to replace)"
          : keyHintFor(providerForBaseUrl(vscode.workspace.getConfiguration("agenticqa").get<string>("baseUrl"))),
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) => {
          const t = (v ?? "").trim();
          if (!t) {return "Enter a key, or press Escape to cancel.";}
          // Advisory only — never blocking. Key formats belong to the provider and change without
          // notice; rejecting an unfamiliar one locked out NVIDIA's `nvapi-` keys entirely.
          if (!allKeyPrefixes().some((p) => t.startsWith(p))) {
            return `That doesn't look like a known provider key (expected ${allKeyPrefixes().join(" or ")}). Press Enter again to use it anyway.`;
          }
          return undefined;
        },
      });
      if (key === undefined) {return;} // cancelled
      await context.secrets.store(SECRET_API_KEY, key.trim());
      const next = await vscode.window.showInformationMessage(
        "AgenticQA: API key saved securely ✅",
        "Open Settings"
      );
      if (next === "Open Settings") {
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "agenticqa"
        );
      }
    }
  );

  /**
   * Send one control message to the orchestrator and collect its reply. Unlike `runOrchestrator` this is
   * for short, non-pipeline operations (currently just `RESET_DB`) — no progress UI, no RUN_SUMMARY
   * parsing. It reuses the same env overlay so user API/base-URL settings apply consistently.
   */
  async function sendOrchestratorCommand(
    msg: Record<string, unknown>
  ): Promise<{ ok: boolean; logs: string[]; errors: string[] }> {
    const engine = await locateEngine(context);
    if (!engine) {
      return {
        ok: false,
        logs: [],
        errors: [missingEngineMessage(context.extensionPath)],
      };
    }
    const orchestratorJsPath = engine.path;

    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const cwd = rootPath ? (await getAgenticQaConfigInfo(rootPath)).configRoot : context.extensionPath;
    const envOverlay = buildEnvOverlay(await readUserConfig(context), {
      promptDir: promptOverrideDir(context),
      cacheDir: engineCacheDir(context),
    });

    return new Promise((resolve) => {
      const child = spawn(process.execPath, [orchestratorJsPath], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...envOverlay },
      });

      const logs: string[] = [];
      const errors: string[] = [];
      let ok = false;
      let buf = "";

      child.stdout.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) {continue;}
          output.appendLine("[ORCH] " + line);
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === "LOG" && typeof parsed.message === "string") {logs.push(parsed.message);}
            if (parsed.type === "ERROR" && typeof parsed.message === "string") {errors.push(parsed.message);}
            if (parsed.type === "DONE") {ok = !!parsed.ok;}
          } catch {
            // non-JSON line — already echoed to the output channel
          }
        }
      });
      child.stderr.on("data", (chunk) => output.appendLine("[ORCH-ERR] " + chunk.toString("utf8")));
      child.on("error", (err) => {
        errors.push(String(err));
        resolve({ ok: false, logs, errors });
      });
      child.on("close", () => resolve({ ok, logs, errors }));

      child.stdin.write(JSON.stringify(msg) + "\n");
      child.stdin.end();
    });
  }

  /* ═══ Command: Reset Database (explicit, destructive — G0.2) ═══ */
  const cmdResetDatabase = vscode.commands.registerCommand(
    "agenticqa.resetDatabase",
    async () => {
      const choice = await vscode.window.showWarningMessage(
        "Reset the AgenticQA database?",
        {
          modal: true,
          detail:
            "This permanently deletes ALL stored run history, locator baselines, cached documentation " +
            "chunks, and Q&A cache entries — for every project. The schema is rebuilt automatically on " +
            "your next run.\n\n" +
            "You normally only need this if AgenticQA reported a vector-schema mismatch (a database " +
            "created by an older version). Generated test files are NOT affected.",
        },
        "Reset Database"
      );
      if (choice !== "Reset Database") {return;}

      output.show(true);
      output.appendLine("────────────────────────────────────────");
      output.appendLine("Resetting the AgenticQA database…");

      const res = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "AgenticQA: resetting database…" },
        () => sendOrchestratorCommand({ type: "RESET_DB" })
      );

      if (res.ok) {
        vscode.window.showInformationMessage(
          "AgenticQA: database reset ✅ — the schema rebuilds on your next run."
        );
      } else {
        vscode.window
          .showErrorMessage(
            `AgenticQA: database reset failed — ${res.errors[0] ?? "see the Output panel."}`,
            "Show Output"
          )
          .then((pick) => {
            if (pick === "Show Output") {output.show(true);}
          });
      }
    }
  );

  /* ═══ Command 12: Clear API Key ═══ */
  const cmdClearApiKey = vscode.commands.registerCommand(
    "agenticqa.clearApiKey",
    async () => {
      const existing = await context.secrets.get(SECRET_API_KEY);
      if (!existing) {
        vscode.window.showInformationMessage(
          "AgenticQA: no API key is saved."
        );
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        "Remove your saved AgenticQA API key? LLM features will be unavailable until you add another.",
        { modal: true },
        "Remove"
      );
      if (choice !== "Remove") {return;}
      await context.secrets.delete(SECRET_API_KEY);
      vscode.window.showInformationMessage("AgenticQA: API key removed.");
    }
  );

context.subscriptions.push(
  cmdNewTestAllBrowsers,
  cmdSettings,
  cmdSetApiKey,
  cmdClearApiKey,
  cmdResetDatabase,
  cmdGeneratePack,
  cmdRerun,
  cmdExplore,
  cmdGenerate,
  cmdRunOnly,
  cmdClear,
  cmdCleanTests,
  cmdDoctor,
  cmdPreviewHtmlReport,
  cmdOpenReport,
  cmdExportReport,
  cmdViewTestFile,
  treeView,
  chatView,
  output
);
}

/* ─── helpers ─── */

/** True when an App Knowledge Pack already exists for this workspace (cfg path or the default). */
/** Log the effective API/model config source to the Output channel — NEVER the key value itself. */
function logConfigSource(output: vscode.OutputChannel, uc: UserConfig): void {
  const parts: string[] = [
    uc.apiKey ? "API key: configured (SecretStorage)" : "API key: not configured",
  ];
  if (uc.baseUrl) {parts.push(`base URL: ${uc.baseUrl}`);}
  if (uc.globalModel) {parts.push(`global model: ${uc.globalModel}`);}
  const roleOverrides = AGENT_ROLES.filter((r) => uc.models[r]).map(
    (r) => `${r}=${uc.models[r]}`
  );
  if (roleOverrides.length) {parts.push(`models: ${roleOverrides.join(", ")}`);}
  if (uc.embedModel) {parts.push(`embed: ${uc.embedModel}`);}
  output.appendLine(`[EXT] AgenticQA config — ${parts.join(" · ")}`);
}

export function deactivate() {}
