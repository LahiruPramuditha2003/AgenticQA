import * as path from "node:path";
import { Logger, RunContext } from "../agent/types";
import { ensureServerUp } from "../../webServer"; // adjust if needed

export class WebServerService {
  async apply(ctx: RunContext, logger: Logger): Promise<void> {
    if (!ctx.cfg) throw new Error("Config not loaded");
    if (!ctx.effectiveBaseUrl) throw new Error("effectiveBaseUrl missing");

    const ws = ctx.cfg.webServer;
    const cwdAbs = ws?.cwd ? path.resolve(ctx.workspacePath, ws.cwd) : ctx.workspacePath;

    const result = await ensureServerUp({
      baseUrl: ctx.effectiveBaseUrl,
      command: ws?.command,
      cwdAbs,
      timeoutMs: ws?.timeoutMs ?? 60000,
      reuseExistingServer: ws?.reuseExistingServer ?? true,
      onLog: (m) => logger.log(m)
    });

    ctx.webServerStarted = result.started;
    ctx.webServerProc = result.proc;
  }
}