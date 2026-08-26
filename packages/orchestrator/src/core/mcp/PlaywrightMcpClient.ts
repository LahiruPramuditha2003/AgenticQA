import { createRequire } from "node:module";
import * as path from "node:path";
import * as fs from "node:fs";

type ToolResult = any;

export interface McpLaunch {
  command: string;
  args: string[];
  /** How the CLI was located — "local" (the pinned dependency) or "npx" (network fallback). */
  source: "local" | "npx";
}

/**
 * Decide how to launch the Playwright MCP server.
 *
 * ⚠️ Do NOT go back to `require.resolve("@playwright/mcp/cli.js")`. `@playwright/mcp`'s `exports` map only
 * publishes `.` and `./package.json`, so that subpath throws `ERR_PACKAGE_PATH_NOT_EXPORTED` **even though
 * `cli.js` exists on disk**. The old code caught that and silently fell through to
 * `npx -y @playwright/mcp@latest`, which meant every run ignored the pinned dependency, paid an npx
 * cold-start (observed: MCP connect timing out at ~-32001), and could pick up a different upstream
 * version at any time. Resolving `package.json` (which IS exported) and joining `cli.js` from its
 * directory is the supported way to reach a bin file.
 *
 * Pure except for the injected `resolve`/`exists` probes, so both branches are unit-testable offline.
 */
export function resolveMcpLaunch(
  flags: string[],
  deps?: {
    resolve?: (spec: string) => string;
    exists?: (p: string) => boolean;
  }
): McpLaunch {
  const resolve = deps?.resolve;
  const exists = deps?.exists ?? fs.existsSync;

  if (resolve) {
    try {
      const pkgJsonPath = resolve("@playwright/mcp/package.json");
      const cliPath = path.join(path.dirname(pkgJsonPath), "cli.js");
      if (exists(cliPath)) {
        return { command: "node", args: [cliPath, ...flags], source: "local" };
      }
    } catch {
      // fall through to npx
    }
  }

  return {
    command: "npx",
    args: ["-y", "@playwright/mcp@latest", ...flags],
    source: "npx",
  };
}

export class PlaywrightMcpClient {
  private client: any;
  private transport: any;

  static async connect(opts?: {
    headless?: boolean;
    caps?: string[];
    snapshotMode?: "full" | "incremental" | "none";
  }) {
    const instance = new PlaywrightMcpClient();
    await instance._connect(opts);
    return instance;
  }

  private async _connect(opts?: {
    headless?: boolean;
    caps?: string[];
    snapshotMode?: "full" | "incremental" | "none";
  }) {
    const headless = opts?.headless ?? true;
    const caps = opts?.caps ?? ["testing"];
    const snapshotMode = opts?.snapshotMode ?? "full";

    // IMPORTANT: do NOT name this variable "require"
    // because TS may compile dynamic import() using require() in CJS.
    const localRequire = createRequire(__filename);

    // Dynamic imports (avoid ESM/CJS conflicts)
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

    // Prefer the locally installed (pinned) @playwright/mcp; npx is a last resort.
    const flags = [
      ...(headless ? ["--headless"] : []),
      `--caps=${caps.join(",")}`,
      `--snapshot-mode=${snapshotMode}`,
    ];
    const { command, args, source } = resolveMcpLaunch(flags, {
      resolve: (spec) => localRequire.resolve(spec),
    });

    if (source === "npx") {
      // stderr only — never the stdout JSON protocol. This used to happen silently on every run.
      console.error(
        "[MCP] @playwright/mcp not resolvable locally — falling back to `npx @playwright/mcp@latest`. " +
          "This is slow, needs network, and pins no version. Run `npm install` at the repo root to fix."
      );
    }

    this.transport = new StdioClientTransport({ command, args });

    this.client = new Client(
      { name: "agenticqa-orchestrator", version: "0.0.1" },
      { capabilities: {} }
    );

    await this.client.connect(this.transport);
  }

  async callTool(name: string, args: Record<string, any> = {}): Promise<ToolResult> {
    return await this.client.callTool({ name, arguments: args });
  }

  async close(): Promise<void> {
    try {
      await this.transport?.close?.();
    } catch {}
  }
}