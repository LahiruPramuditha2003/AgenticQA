import readline from "node:readline";
import { runPipeline } from "./orchestrator/runPipeline";
import { RunContext } from "./core/agent/types";
import { ConfigValidator } from "./core/services/ConfigValidator";
import dotenv from "dotenv";
import * as path from "node:path";

// Load orchestrator/.env (packages/orchestrator/.env)
dotenv.config({ path: path.resolve(__dirname, "../.env"), quiet: true });
// Also load workspace .env (optional)
dotenv.config({ quiet: true });

type InMsg =
  | { type: "PING" }
  /** Explicit, user-initiated schema reset (G0.2). The only path that may drop AgenticQA tables — the
   *  implicit drop-on-every-start was removed. Triggered by the `AgenticQA: Reset Database` command. */
  | { type: "RESET_DB" }
  | {
      type: "NEW_REQUEST";
      text: string;
      workspacePath: string;
      runMode?: "generate_and_run" | "run_only" | "explore" | "generate_pack";
      overrides?: { baseUrl?: string; startUrl?: string };
      /** generate_pack only: permission to replace a pack marked `curated: true`. */
      overwriteCuratedPack?: boolean;
      /** Which browsers to run against. `allProjects` runs the app's full configured matrix; without it
       *  the run defaults to chromium only (G5.1 / D6) unless `.agenticqa.json` says otherwise. */
      execution?: { project?: string; projects?: string[]; allProjects?: boolean };
    };

/**
 * The ONE writer to stdout. Everything the extension parses arrives through here as newline-delimited
 * JSON, so a single stray character on this stream desynchronises the protocol.
 *
 * Captured before the console redirect below, so `send` keeps a private handle on the real stream.
 */
const writeProtocolLine = process.stdout.write.bind(process.stdout);

function send(obj: any) {
  writeProtocolLine(JSON.stringify(obj) + "\n");
}

/**
 * Make the transport structurally immune to stray logging (R1.9, from the R0.4 sweep).
 *
 * Today the orchestrator's own source is clean - one stdout writer, zero `console.log`. But the release
 * build inlines five third-party packages (`openai`, `pg`, `zod`, `dotenv`, the MCP SDK), and one
 * `console.log` from any of them - now or in a future version - would land mid-JSON, leaving the
 * extension with unparseable garbage instead of a run. Relying on five dependencies staying quiet
 * forever is not a guarantee; redirecting the console is.
 *
 * stderr is already the log channel here (`ConfigValidator` writes there) and the extension surfaces it
 * in the Output panel, so redirected output stays visible rather than being swallowed.
 */
for (const level of ["log", "info", "debug"] as const) {
  console[level] = (...args: unknown[]) => {
    console.error(...args);
  };
}

// Validate configuration before signaling readiness
const validationResult = ConfigValidator.validateEnv({
  log: (msg) => console.error(`[CONFIG_VALIDATOR] ${msg}`),
  error: (msg) => console.error(`[CONFIG_VALIDATOR_ERROR] ${msg}`),
});

if (!validationResult.isValid) {
  console.error(`\n${"=".repeat(60)}`);
  console.error("❌ CONFIGURATION ERROR");
  console.error("=".repeat(60));
  for (const err of validationResult.errors) {
    console.error(`  • ${err}`);
  }
  console.error(`${"=".repeat(60)}`);
  console.error("See SETUP.md for configuration instructions");
  console.error("=".repeat(60));
  process.exit(1);
}

// Log warnings (if any)
for (const warn of validationResult.warnings) {
  console.error(`[WARN] ${warn}`);
}

// Signal readiness to the extension
send({ type: "READY" });

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", async (line) => {
  if (!line.trim()) return;

  let msg: InMsg;
  try {
    msg = JSON.parse(line);
  } catch {
    send({ type: "ERROR", message: "Invalid JSON received by orchestrator" });
    send({ type: "DONE", ok: false });
    process.exit(1);
  }

  if (msg.type === "PING") {
    send({ type: "PONG" });
    return;
  }

  if (msg.type === "RESET_DB") {
    if (!process.env.DATABASE_URL) {
      send({
        type: "ERROR",
        message:
          "DB reset: DATABASE_URL is not set — there is no database to reset.",
      });
      send({ type: "DONE", ok: false });
      process.exit(1);
    }
    try {
      const { dbReset } = await import("./core/db/db");
      const dropped = await dbReset();
      send({
        type: "LOG",
        message: `DB: reset complete — dropped ${dropped.length} table(s): ${dropped.join(", ")}. The next run rebuilds the schema.`,
      });
      send({ type: "DONE", ok: true });
      process.exit(0);
    } catch (e: any) {
      send({ type: "ERROR", message: `DB reset failed: ${e?.message ?? String(e)}` });
      send({ type: "DONE", ok: false });
      process.exit(1);
    }
  }

  if (msg.type !== "NEW_REQUEST") return;

  // Build the pipeline context
  const ctx: RunContext = {
    requestText: msg.text,
    workspacePath: msg.workspacePath,
    overrides: msg.overrides,
    runMode: msg.runMode ?? "generate_and_run",
    overwriteCuratedPack: msg.overwriteCuratedPack === true,
    executionProject: msg.execution?.project,
    executionProjects: msg.execution?.projects,
    allProjects: msg.execution?.allProjects === true
  };

  // Logger used by all agents
  const logger = {
    log: (message: string) => send({ type: "LOG", message }),
    error: (message: string) => send({ type: "ERROR", message }),
    domainAnswer: (answer: any) => send({ type: "DOMAIN_QA_ANSWER", answer }),
    casualAnswer: (text: string) => send({ type: "CASUAL_ANSWER", text })
  };

  // Optional: keep these two logs here (or remove if Receptionist logs them)
  logger.log(`Got request: ${msg.text}`);
  logger.log(`Workspace: ${msg.workspacePath}`);

  let ok = false;

  try {
    await runPipeline(ctx, logger);
    ok = true;
  } catch (e: any) {
    logger.error(e?.stack ?? e?.message ?? String(e));
    ok = false;
  } finally {
        // Safety net: close MCP if any agent left it open
    if (ctx.mcp) {
      try {
        logger.log("MCP: closing leftover client");
        await ctx.mcp.close();
      } catch {}
      ctx.mcp = undefined;
    }
    // Stop only if we started it
    if (ctx.webServerStarted && ctx.webServerProc) {
      logger.log("WebServer: stopping server process started by orchestrator");
      try {
        const pid = ctx.webServerProc.pid;
        if (pid && process.platform === "win32") {
          // Windows: the dev server is a shell → node tree, so killing the pid alone orphans children.
          logger.log(`WebServer: killing process tree pid=${pid}`);
          const { spawnSync } = await import("node:child_process");
          spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { shell: true });
        } else if (pid) {
          // POSIX: negative pid signals the whole process group (the child is spawned detached-ish via
          // a shell). Fall back to a direct kill if the group signal isn't permitted.
          logger.log(`WebServer: killing process group pid=${pid}`);
          try {
            process.kill(-pid, "SIGTERM");
          } catch {
            ctx.webServerProc.kill("SIGTERM");
          }
        } else {
          ctx.webServerProc.kill();
        }
      } catch (e: any) {
        logger.error("WebServer: failed to stop process: " + (e?.message ?? String(e)));
      }
    }
  }
  send({ type: "DONE", ok });
  process.exit(ok ? 0 : 1);
  
});
