/**
 * Filesystem questions the extension asks about a workspace — where the config is, whether the app has a
 * knowledge pack, whether its source is here at all.
 *
 * Extracted from `extension.ts` in G5.2 so it can be tested without launching VS Code (nothing here
 * imports `vscode`). It is `fs`-bound rather than pure, but `fs` is trivially exercisable against a temp
 * directory, whereas the `vscode` module is not exercisable at all outside an extension host.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Directories never worth descending into when hunting for a config file. */
const SKIP_DIRS = new Set(["node_modules", ".git"]);

/** How far below the workspace root to look. A monorepo keeps its apps one or two levels down. */
export const MAX_CONFIG_SEARCH_DEPTH = 3;

/**
 * Find the nearest `.agenticqa.json`: the workspace root first, then a bounded breadth-first search.
 *
 * Breadth-first matters — it is what makes the *shallowest* config win when a monorepo has several. Opening
 * the repo root should pick the root's config, not whichever app the directory listing happened to yield
 * first.
 */
export async function findAgenticQaConfigFile(
  workspacePath: string
): Promise<string | undefined> {
  const candidate = path.join(workspacePath, ".agenticqa.json");
  try {
    await fs.access(candidate);
    return candidate;
  } catch {
    // keep looking
  }

  const queue: Array<{ dir: string; depth: number }> = [{ dir: workspacePath, depth: 0 }];
  const visited = new Set<string>([workspacePath]);

  while (queue.length) {
    const { dir, depth } = queue.shift()!;
    if (depth >= MAX_CONFIG_SEARCH_DEPTH) {continue;}

    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) {continue;}
      const fullPath = path.join(dir, entry);
      try {
        const stat = await fs.stat(fullPath);
        if (stat.isFile() && entry === ".agenticqa.json") {return fullPath;}
        if (stat.isDirectory() && !visited.has(fullPath)) {
          visited.add(fullPath);
          queue.push({ dir: fullPath, depth: depth + 1 });
        }
      } catch {
        continue;
      }
    }
  }

  return undefined;
}

/** The config file and the directory that counts as the run root (its parent). */
export async function getAgenticQaConfigInfo(
  workspacePath: string
): Promise<{ configRoot: string; configPath: string }> {
  const configPath =
    (await findAgenticQaConfigFile(workspacePath)) ??
    path.join(workspacePath, ".agenticqa.json");
  return { configRoot: path.dirname(configPath), configPath };
}

export async function readWorkspaceAgenticQaConfig(workspacePath: string): Promise<any> {
  const { configPath } = await getAgenticQaConfigInfo(workspacePath);
  try {
    return JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch {
    return {};
  }
}

export async function writeWorkspaceAgenticQaConfig(
  workspacePath: string,
  cfg: any
): Promise<void> {
  const { configPath } = await getAgenticQaConfigInfo(workspacePath);
  await fs.writeFile(configPath, JSON.stringify(cfg, null, 2), "utf8");
}

/** Does this app already have a knowledge pack — the configured path, or the conventional location? */
/** What a workspace's existing knowledge pack is, for the "replace it?" decision (R1.6). */
export interface KnowledgePackSummary {
  path: string;
  flowCount: number;
  /** `curated: true` — written by hand, and destroyed rather than merged by `generate_pack`. */
  curated: boolean;
}

/**
 * Read the workspace's knowledge pack, if there is one (R1.6, defects D30/D38).
 *
 * `generate_pack` REPLACES a pack; it never merges. A hand-curated pack can therefore be traded for a
 * poorer generated one by clicking a button, which is what happened to demo-web (15 flows → 5). The
 * engine refuses outright unless the run opts in, but the *decision* belongs in the UI, where the person
 * clicking can be told what they are about to lose.
 *
 * Returns undefined when there is no pack or it cannot be parsed — both mean "nothing to protect".
 */
export async function readKnowledgePackSummary(
  configRoot: string
): Promise<KnowledgePackSummary | undefined> {
  const candidates = [path.join(configRoot, ".agenticqa", "knowledge.json")];
  try {
    const cfg = JSON.parse(await fs.readFile(path.join(configRoot, ".agenticqa.json"), "utf8"));
    if (cfg.knowledgePack) {candidates.unshift(path.join(configRoot, cfg.knowledgePack));}
  } catch {
    // no config — only the default candidate
  }
  for (const c of candidates) {
    try {
      const pack = JSON.parse(await fs.readFile(c, "utf8"));
      return {
        path: c,
        flowCount: Object.keys(pack?.goldenFlows ?? {}).length,
        curated: pack?.curated === true,
      };
    } catch {
      // missing or unparseable — try the next candidate
    }
  }
  return undefined;
}

export async function hasKnowledgePack(configRoot: string): Promise<boolean> {
  const candidates = [path.join(configRoot, ".agenticqa", "knowledge.json")];
  try {
    const cfg = JSON.parse(
      await fs.readFile(path.join(configRoot, ".agenticqa.json"), "utf8")
    );
    if (cfg.knowledgePack) {candidates.unshift(path.join(configRoot, cfg.knowledgePack));}
  } catch {
    // no config — only the default candidate
  }
  for (const c of candidates) {
    try {
      await fs.access(c);
      return true;
    } catch {
      // not this one
    }
  }
  return false;
}

/**
 * Lightweight "is the app's source here?" check: a package.json declaring a known web framework.
 *
 * ⚠️ Deliberately shallow. It only decides whether to *offer* to generate a knowledge pack; the
 * orchestrator's `detectApp` does the authoritative detection during generation. Guessing wrong here costs
 * an unwanted prompt, which is why the offer is code-only — nagging every non-JS workspace would be worse
 * than missing one.
 */
export async function detectCodeAccessibleApp(configRoot: string): Promise<string | null> {
  let pkg: string | null = null;
  try {
    pkg = await fs.readFile(path.join(configRoot, "package.json"), "utf8");
  } catch {
    return null;
  }
  if (/"next"\s*:/.test(pkg)) {return "Next.js";}
  if (/react-router(-dom)?\s*"?\s*:/.test(pkg) || /"react-router/.test(pkg)) {return "React";}
  if (/vue-router\s*"?\s*:/.test(pkg) || /"vue-router/.test(pkg)) {return "Vue";}
  return null;
}
