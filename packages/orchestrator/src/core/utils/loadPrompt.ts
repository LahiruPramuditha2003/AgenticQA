/**
 * Agent system-prompt loader (G0.4, reworked in R1.1).
 *
 * Each agent that talks to an LLM keeps its system message in a markdown file and loads it through
 * `loadSystemPrompt("<AgentName>")`. Before G0.4 those files existed but **nothing read them** — every
 * prompt was inlined in TypeScript while the docs told contributors to "edit prompts here, not in code",
 * which silently did nothing (defect D5).
 *
 * WHY R1.1 CHANGED THE SIGNATURE (`__dirname` -> agent name)
 * ----------------------------------------------------------
 * Two reasons, and the first is a correctness bug waiting to happen:
 *
 *  1. **Bundling.** The release build (R2) esbuilds the whole orchestrator into ONE file, so `__dirname`
 *     collapses to the same directory for every agent. `loadSystemPrompt(__dirname)` would then resolve
 *     all three agents to a single `prompts/system.md` — the Receptionist would be handed the Domain-QA
 *     prompt and nothing would look broken until answers went strange (blocker B2).
 *  2. **User control.** Resolving by name lets an override live somewhere the user can actually edit,
 *     rather than inside an extension install directory that VS Code wipes on update.
 *
 * RESOLUTION CHAIN — first match wins:
 *
 *  | # | Source    | Path                                              | Who writes it |
 *  |---|-----------|---------------------------------------------------|---------------|
 *  | 1 | workspace | `<workspace>/.agenticqa/prompts/<Agent>.md`        | the team, committed alongside the app under test |
 *  | 2 | user      | `$AGENTICQA_PROMPT_DIR/<Agent>.md`                 | the Settings panel (extension globalStorage) |
 *  | 3 | packaged  | the shipped default (see `packagedCandidates`)     | this repo |
 *
 * CONTRACT
 *  • `<!-- … -->` HTML comments are stripped, so a prompt file can carry maintainer notes that are never
 *    sent to the model. Each shipped file uses this to record its parsing contract — read it before editing.
 *  • `{{placeholder}}` tokens are substituted from `vars`. An unknown/omitted token is left intact rather
 *    than replaced with "undefined" — a visible `{{typo}}` is easier to spot than a silent blank.
 *  • **An override that is missing or empty falls through to the next source** and never throws. Losing a
 *    whole run because someone saved an empty file is worse than ignoring the file.
 *  • **A missing packaged default still throws.** It means the build's prompt-copy step did not run —
 *    failing loudly beats silently sending the model no system message, and beats keeping a duplicate
 *    copy in code (the two-sources-of-truth drift G0.4 removed).
 *  • An override that drops a **required** `{{placeholder}}` is warned about by name (see `REQUIRED_VARS`).
 *    The Receptionist's local-classifier hint is the live example: without it the model still answers, but
 *    it answers without the signal the caller believes it has.
 *  • Results are cached by **resolved path**, not by agent name — otherwise editing an override would be
 *    served stale for the rest of the session.
 *
 * Build note: `tsc` does not emit `.md`, so `scripts/copyPrompts.js` mirrors the prompt tree into `dist/`
 * as part of `npm run build`, in both the tsc and the bundled layout.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Where a prompt was ultimately read from. Surfaced in logs so "which prompt ran?" is answerable. */
export type PromptSourceKind = "workspace" | "user" | "packaged";

export interface PromptSource {
  kind: PromptSourceKind;
  path: string;
}

/**
 * Placeholders an override MUST keep, per agent. Only overrides are checked — the shipped defaults are
 * behavior-locked by `test/loadPrompt.test.js`, so they cannot drift without a test failing first.
 */
const REQUIRED_VARS: Record<string, readonly string[]> = {
  ReceptionistAgent: ["localIntent", "localConfidence"],
};

const cache = new Map<string, string>();

/**
 * The workspace under test, used for source 1. Set once per request by the pipeline rather than read from
 * an env var: the orchestrator already knows it, and threading it explicitly keeps the loader testable.
 */
let workspaceRoot: string | undefined;

/** Point source 1 at a workspace (or clear it with `undefined`). */
export function setPromptWorkspace(dir: string | undefined): void {
  workspaceRoot = dir && dir.trim() ? dir : undefined;
}

/** Remove `<!-- … -->` blocks (maintainer notes) and normalize trailing whitespace. */
export function stripPromptComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "").trim();
}

/** Replace `{{key}}` with `vars[key]`; unknown tokens are left visible on purpose. */
export function applyPromptVars(text: string, vars?: Record<string, string | number>): string {
  if (!vars) {return text;}
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole
  );
}

/**
 * Read + clean a prompt file (uncached). Exported for tests.
 *
 * ⚠️ Line endings are normalised to LF. Without this the exact bytes sent to a model depend on the
 * reader's platform and git settings — a Windows checkout yields CRLF, a Linux one LF, and the
 * behaviour-lock tests then pass on one machine and fail on the other. It also matters for the user
 * override feature: someone editing a prompt in Notepad saves CRLF, and their prompt would otherwise
 * differ byte-for-byte from the shipped one it replaced.
 *
 * Caught by cloning the published repository and running its own test suite — the source checkout
 * passed, the fresh clone did not.
 */
export function readPromptFile(filePath: string): string {
  const raw = fs.readFileSync(filePath, "utf8").replace(/\r\n?/g, "\n");
  return stripPromptComments(raw);
}

/**
 * Every place a **shipped** default may live, most explicit first. Three entries because the same code
 * runs in three layouts and guessing wrong is a silent wrong-prompt bug:
 *   a. `AGENTICQA_PROMPT_ROOT` — set by the extension; wins so packaging never has to match a heuristic.
 *   b. bundled — `__dirname` is `<ext>/dist`, prompts sit beside the bundle.
 *   c. tsc — `__dirname` is `<dist>/core/utils`; both the mirrored tree and the per-agent tree are tried.
 */
export function packagedCandidates(agentName: string): string[] {
  const out: string[] = [];
  const root = (process.env.AGENTICQA_PROMPT_ROOT ?? "").trim();
  if (root) {out.push(path.join(root, agentName, "system.md"));}
  out.push(path.join(__dirname, "prompts", agentName, "system.md"));
  out.push(path.resolve(__dirname, "..", "..", "prompts", agentName, "system.md"));
  out.push(path.resolve(__dirname, "..", "..", "agents", agentName, "prompts", "system.md"));
  return out;
}

/** Override locations, highest precedence first. */
function overrideCandidates(agentName: string): PromptSource[] {
  const out: PromptSource[] = [];
  if (workspaceRoot) {
    out.push({
      kind: "workspace",
      path: path.join(workspaceRoot, ".agenticqa", "prompts", `${agentName}.md`),
    });
  }
  const userDir = (process.env.AGENTICQA_PROMPT_DIR ?? "").trim();
  if (userDir) {
    out.push({ kind: "user", path: path.join(userDir, `${agentName}.md`) });
  }
  return out;
}

/** Read a candidate, returning its cleaned text, or undefined if absent/unreadable/empty. */
function tryRead(filePath: string): string | undefined {
  const hit = cache.get(filePath);
  if (hit !== undefined) {return hit;}
  let text: string;
  try {
    text = readPromptFile(filePath);
  } catch {
    return undefined;
  }
  if (!text) {return undefined;}
  cache.set(filePath, text);
  return text;
}

export interface LoadPromptOptions {
  /** Where to report which source was used, and any override warning. Silent when omitted. */
  log?: (message: string) => void;
}

/**
 * Load an agent's system prompt.
 *
 * @param agentName directory-style agent name, e.g. `"DomainQaAgent"`
 * @param vars      values for any `{{placeholder}}` tokens
 */
export function loadSystemPrompt(
  agentName: string,
  vars?: Record<string, string | number>,
  opts?: LoadPromptOptions
): string {
  const log = opts?.log;

  // 1–2: overrides. A file that exists but is empty is reported and skipped, never fatal.
  for (const cand of overrideCandidates(agentName)) {
    const text = tryRead(cand.path);
    if (text) {
      warnOnMissingVars(agentName, text, cand, log);
      log?.(`Prompt: ${agentName} loaded from ${cand.kind} override (${cand.path})`);
      return applyPromptVars(text, vars);
    }
    if (fs.existsSync(cand.path)) {
      log?.(
        `Prompt: ${agentName}'s ${cand.kind} override at ${cand.path} is empty — ignoring it and ` +
          `falling back to the built-in prompt.`
      );
    }
  }

  // 3: the shipped default. Its absence is a build failure, so it throws.
  const candidates = packagedCandidates(agentName);
  for (const filePath of candidates) {
    const text = tryRead(filePath);
    if (text) {
      return applyPromptVars(text, vars);
    }
    // A default that exists but contains only comments is a broken build artifact, not a fallback.
    if (fs.existsSync(filePath)) {
      throw new Error(`System prompt at ${filePath} is empty.`);
    }
  }

  throw new Error(
    `Could not load system prompt for "${agentName}". Looked in:\n` +
      candidates.map((c) => `  - ${c}`).join("\n") +
      `\nPrompts are copied into dist/ by scripts/copyPrompts.js during \`npm run build\`; ` +
      `re-run the build if this is a fresh checkout.`
  );
}

function warnOnMissingVars(
  agentName: string,
  template: string,
  source: PromptSource,
  log?: (m: string) => void
): void {
  const required = REQUIRED_VARS[agentName];
  if (!required || !log) {return;}
  const missing = required.filter((v) => !new RegExp(`\\{\\{\\s*${v}\\s*\\}\\}`).test(template));
  if (missing.length) {
    log(
      `Prompt: ${agentName}'s ${source.kind} override drops ${missing
        .map((m) => `{{${m}}}`)
        .join(", ")} — the run continues, but the model will not receive that context. ` +
        `Reset the prompt in AgenticQA Settings to restore it.`
    );
  }
}

/** Drop the in-memory cache (tests, and after a user edits an override). */
export function clearPromptCache(): void {
  cache.clear();
}
