import { spawn, ChildProcess } from "node:child_process";
import * as path from "node:path";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function isUrlReachable(urlStr: string): Promise<boolean> {
  const url = new URL(urlStr);
  const lib = url.protocol === "https:" ? https : http;

  return new Promise((resolve) => {
    const req = lib.request(
      {
        method: "GET",
        hostname: url.hostname,
        port: url.port,
        path: url.pathname || "/",
        timeout: 2000
      },
      (res) => {
        // Any HTTP response means server is up
        res.resume();
        resolve(true);
      }
    );

    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}

export function startWebServer(command: string, cwdAbs: string): ChildProcess {
  // Use shell:true for Windows command resolution
  return spawn(command, {
    cwd: cwdAbs,
    shell: true,
    stdio: "pipe"
  });
}

export async function ensureServerUp(opts: {
  baseUrl: string;
  command?: string;
  cwdAbs: string;
  timeoutMs: number;
  reuseExistingServer: boolean;
  onLog: (msg: string) => void;
}): Promise<{ started: boolean; proc?: ChildProcess }> {
  const { baseUrl, command, cwdAbs, timeoutMs, reuseExistingServer, onLog } = opts;

  // already running?
  if (await isUrlReachable(baseUrl)) {
    onLog(`WebServer: reachable at ${baseUrl}`);
    return { started: false };
  }

  if (!command) {
    throw new Error(`WebServer not reachable at ${baseUrl}. Start it manually or set webServer.command in .agenticqa.json`);
  }

  onLog(`WebServer: not reachable, starting: ${command}`);
  const proc = startWebServer(command, cwdAbs);

  proc.stdout?.on("data", (d) => onLog(`[webServer] ${d.toString("utf8").trimEnd()}`));
  proc.stderr?.on("data", (d) => onLog(`[webServer:err] ${d.toString("utf8").trimEnd()}`));

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isUrlReachable(baseUrl)) {
      onLog(`WebServer: now reachable at ${baseUrl}`);
      return { started: true, proc };
    }
    await sleep(500);
  }

  // timeout
  try {
    proc.kill("SIGTERM");
    // On Windows, also try taskkill for child processes
    if (process.platform === "win32" && proc.pid) {
      try {
        spawn("taskkill", ["/F", "/T", "/PID", String(proc.pid)], {
          shell: true,
          stdio: "ignore",
        });
      } catch {
        // Ignore taskkill errors
      }
    }
  } catch {}
  throw new Error(`WebServer start timed out after ${timeoutMs}ms waiting for ${baseUrl}`);
}