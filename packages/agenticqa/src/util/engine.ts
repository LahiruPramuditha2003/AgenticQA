/**
 * Locating the AgenticQA engine (R1.7, prerequisite for R2.3).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `extension.ts` resolved the engine with a hardcoded path in **five** places:
 *
 *     path.join(context.extensionPath, "..", "orchestrator", "dist", "main.js")
 *
 * That sibling directory exists only in this monorepo. A normally installed extension lives in
 * `~/.vscode/extensions/<publisher>.<name>-<version>/`, whose parent is the extensions folder — so a
 * `.vsix` install could not run at all (blocker B1). Five copies of the assumption also meant five
 * places to get R2's fix wrong, in a 1500-line file with no test coverage.
 *
 * Resolution is now one vscode-free, unit-tested function. `exists` is injected rather than importing
 * `fs`, so the ordering logic can be tested exhaustively without a filesystem — which matters because
 * the failure it guards against is silent: running a **stale sibling build** while believing you are
 * running the packaged engine is an unanswerable support ticket.
 */

import * as path from "node:path";

export type EngineKind =
  /** The engine bundled into the extension itself. The normal case for an installed extension. */
  | "bundled"
  /** The sibling `packages/orchestrator` build. Monorepo development / the F5 dev host. */
  | "monorepo"
  /** An explicit `agenticqa.enginePath` setting. Escape hatch for contributors and support. */
  | "configured";

export interface EngineLocation {
  path: string;
  kind: EngineKind;
}

/** Human label for logs, Doctor, and error messages. */
export const ENGINE_KIND_LABELS: Record<EngineKind, string> = {
  bundled: "bundled with the extension",
  monorepo: "monorepo sibling build",
  configured: "agenticqa.enginePath setting",
};

/**
 * Every place the engine may live, in priority order.
 *
 * ⚠️ `configured` is FIRST, which differs from the initial R2.3 sketch. An explicit setting that loses
 * to a bundled engine would be useless in the one situation people set it for: pointing a packaged
 * install at a local build to reproduce a bug. An escape hatch that only works when nothing else does
 * is not an escape hatch.
 */
export function engineCandidates(extensionPath: string, configuredPath?: string): EngineLocation[] {
  const out: EngineLocation[] = [];
  const configured = (configuredPath ?? "").trim();
  if (configured) {
    out.push({ path: path.resolve(configured), kind: "configured" });
  }
  out.push({ path: path.join(extensionPath, "dist", "orchestrator.js"), kind: "bundled" });
  out.push({
    path: path.join(extensionPath, "..", "orchestrator", "dist", "main.js"),
    kind: "monorepo",
  });
  return out;
}

/**
 * The sibling orchestrator package directory — where `npm run build` can be run.
 *
 * Only meaningful in a monorepo checkout. A packaged install has no sources to build, so offering the
 * user a "build it now?" prompt there would be asking them to fix a broken install by hand.
 */
export function monorepoOrchestratorDir(extensionPath: string): string {
  return path.join(extensionPath, "..", "orchestrator");
}

export interface ResolveEngineOptions {
  extensionPath: string;
  /** `agenticqa.enginePath`, if the user set one. */
  configuredPath?: string;
  /** Injected so resolution is testable without a filesystem. */
  exists: (candidatePath: string) => Promise<boolean>;
}

/**
 * First candidate that exists on disk, or `undefined` if none do.
 *
 * Callers must report which `kind` they got. Silence here is how someone spends an afternoon debugging
 * a fix that their VS Code never loaded.
 */
export async function resolveEngine(opts: ResolveEngineOptions): Promise<EngineLocation | undefined> {
  for (const candidate of engineCandidates(opts.extensionPath, opts.configuredPath)) {
    if (await opts.exists(candidate.path)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * What to tell the user when no engine was found. The advice differs sharply by layout, and giving the
 * wrong one wastes their time: a monorepo checkout genuinely needs a build, while a packaged install
 * that is missing its engine is a broken download and no amount of `npm run build` will help.
 */
export function missingEngineMessage(extensionPath: string, configuredPath?: string): string {
  const configured = (configuredPath ?? "").trim();
  if (configured) {
    return (
      `AgenticQA: the engine path you configured does not exist — ${path.resolve(configured)}. ` +
      `Clear the "agenticqa.enginePath" setting to fall back to the bundled engine.`
    );
  }
  return (
    "AgenticQA: the engine could not be found. Looked in:\n" +
    engineCandidates(extensionPath)
      .map((c) => `  • ${c.path}  (${ENGINE_KIND_LABELS[c.kind]})`)
      .join("\n") +
    "\nIf you installed AgenticQA from a marketplace this is a broken installation — reinstall the " +
    "extension. In a monorepo checkout, build the orchestrator first."
  );
}

/**
 * Where the SHIPPED default prompt for an agent lives, given a resolved engine path (R1.4).
 *
 * Uniform across both layouts because `copyPrompts.js` emits the flat `dist/prompts/<Agent>/system.md`
 * tree in the tsc build as well as the bundle — the engine's own directory is therefore the only thing
 * that varies. The Settings panel seeds a user's override from this file so they start from the real
 * prompt (comments and parsing contract included) rather than a blank page.
 */
export function packagedPromptFile(enginePath: string, agentName: string): string {
  return path.join(path.dirname(enginePath), "prompts", agentName, "system.md");
}
