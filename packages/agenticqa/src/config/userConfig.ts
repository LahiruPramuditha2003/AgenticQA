/**
 * Bridges the extension's user-facing settings (native VS Code config + the SecretStorage API key) to the
 * orchestrator's `process.env`-based configuration.
 *
 * Transport: the extension injects `buildEnvOverlay()` into the
 * orchestrator `spawn`'s `env`. The orchestrator reads `process.env` for everything and its `dotenv` does
 * NOT override already-set vars, so a value the user set here WINS over the bundled `.env`, while anything
 * left blank falls through to whatever the environment already provides — preserving today's behavior
 * (and the verified 20/20).
 *
 * ⚠️ R2.4: there is NO bundled API key, and there never will be. A `.vsix` is a ZIP, so a shipped key is
 * a public key — and a single key shared across every install would exhaust its provider rate limit
 * within a day, which is a worse user experience than asking for one. AgenticQA is bring-your-own-key.
 * In a monorepo checkout an unset value still falls through to `packages/orchestrator/.env`, which is a
 * developer convenience, not a product feature.
 *
 * The model-resolver precedence in the orchestrator is unchanged: the overlay only populates the env layer
 * (`OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` / `OPENAI_MODEL_<ROLE>` / `OPENAI_EMBED_MODEL`).
 */

import * as vscode from "vscode";
import { isFreeModel } from "./freeModels";

/** SecretStorage key under which the user's API key is stored (never written to settings.json). */
export const SECRET_API_KEY = "agenticqa.apiKey";

/**
 * Agent roles the user can assign a model to. Mirrors the orchestrator's `AgentRole`
 * (core/llm/models.ts). `packgen` is the (N2) knowledge-pack generator — its env var is harmless until
 * that role is wired in the orchestrator.
 */
export const AGENT_ROLES = [
  "planner",
  "domainqa",
  "selfheal",
  "reporter",
  "receptionist",
  "casual",
  "explorer",
  "packgen",
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export interface UserConfig {
  /** From SecretStorage. Undefined means NO key is configured — LLM features are unavailable. */
  apiKey?: string;
  baseUrl?: string;
  /** Force-one-model knob (`OPENAI_MODEL`); blank → per-role models below / built-in defaults. */
  globalModel?: string;
  models: Partial<Record<AgentRole, string>>;
  embedModel?: string;
  enforceFreeModels: boolean;
  /**
   * True when a key is configured. Named `usingOwnKey` historically, when the alternative was a shared
   * bundled key; the alternative is now "no key at all". Kept as-is to avoid churn at call sites.
   */
  usingOwnKey: boolean;
}

function clean(v: string | undefined | null): string | undefined {
  const t = (v ?? "").trim();
  return t.length ? t : undefined;
}

/** Read the effective user config from VS Code settings + SecretStorage. */
export async function readUserConfig(context: vscode.ExtensionContext): Promise<UserConfig> {
  const cfg = vscode.workspace.getConfiguration("agenticqa");
  const apiKey = clean(await context.secrets.get(SECRET_API_KEY));

  const models: Partial<Record<AgentRole, string>> = {};
  for (const role of AGENT_ROLES) {
    const v = clean(cfg.get<string>(`models.${role}`));
    if (v) {models[role] = v;}
  }

  return {
    apiKey,
    baseUrl: clean(cfg.get<string>("api.baseUrl")),
    globalModel: clean(cfg.get<string>("api.globalModel")),
    models,
    embedModel: clean(cfg.get<string>("embedModel")),
    enforceFreeModels: cfg.get<boolean>("enforceFreeModels") ?? true,
    usingOwnKey: !!apiKey,
  };
}

/** Paths the extension owns and the engine needs to be told about (R1.1c). */
export interface EnvOverlayPaths {
  /**
   * Directory holding per-user agent prompt overrides — `<globalStorage>/prompts/<AgentName>.md`.
   * The engine falls back to its shipped prompts when this is unset or the file is absent, so passing
   * it is always safe: an install with no customized prompts behaves exactly as before.
   */
  promptDir?: string;
  /**
   * Directory for regenerable per-user caches (embeddings today). Must NOT be the extension install
   * directory: VS Code wipes that on update and may mount it read-only, so the engine would silently
   * re-embed on every run (defect D44).
   */
  cacheDir?: string;
}

/**
 * Build the env overlay merged into the orchestrator spawn. Only keys the user actually set are included,
 * so unset values fall through to the bundled `.env` (the back-compat guarantee).
 */
export function buildEnvOverlay(uc: UserConfig, paths?: EnvOverlayPaths): Record<string, string> {
  const env: Record<string, string> = {};
  if (paths?.promptDir) {env.AGENTICQA_PROMPT_DIR = paths.promptDir;}
  if (paths?.cacheDir) {env.AGENTICQA_CACHE_DIR = paths.cacheDir;}
  if (uc.apiKey) {env.OPENAI_API_KEY = uc.apiKey;}
  if (uc.baseUrl) {env.OPENAI_BASE_URL = uc.baseUrl;}
  if (uc.globalModel) {env.OPENAI_MODEL = uc.globalModel;}
  if (uc.embedModel) {env.OPENAI_EMBED_MODEL = uc.embedModel;}
  for (const role of AGENT_ROLES) {
    const m = uc.models[role];
    if (m) {env[`OPENAI_MODEL_${role.toUpperCase()}`] = m;}
  }
  return env;
}

export type ModelPolicyLevel = "ok" | "warn" | "block";
export interface ModelPolicyResult {
  /** False only when the choice is blocked. */
  ok: boolean;
  level: ModelPolicyLevel;
  message?: string;
}

/**
 * Soft + secure free-model policy (owner decision):
 *  - a free model (`:free` / `openrouter/free`) → always ok;
 *  - non-free + a configured key → warn (allowed — it is the user's own cost to accept);
 *  - non-free + NO key → block when `enforceFreeModels`, else warn. Blocking here is not about cost:
 *    with no key the request cannot succeed at all, so a paid model is simply a slower way to fail.
 * Blank model → ok (means "use the default").
 */
export function validateModelChoice(
  model: string | undefined,
  opts: { usingOwnKey: boolean; enforceFreeModels: boolean; baseUrl?: string }
): ModelPolicyResult {
  const m = clean(model);
  if (!m) {return { ok: true, level: "ok" };}
  // Free-ness is provider-specific: NVIDIA NIM has no `:free` suffix because its whole hosted catalog
  // runs off one free credit pool. Judging it by OpenRouter's convention would warn on every model.
  if (isFreeModel(m, opts.baseUrl)) {return { ok: true, level: "ok" };}

  if (opts.usingOwnKey) {
    return {
      ok: true,
      level: "warn",
      message: `"${m}" is not a free model. With your own API key this may incur charges.`,
    };
  }
  if (opts.enforceFreeModels) {
    return {
      ok: false,
      level: "block",
      message: `"${m}" is not a free model, and no API key is configured. Run **AgenticQA: Set API Key** to add one, or choose a free model.`,
    };
  }
  return {
    ok: true,
    level: "warn",
    message: `"${m}" is not a free model, and no API key is configured — this request will fail.`,
  };
}

export interface PolicyEvaluation {
  /** Configured models that are blocked (non-free with no key configured, enforcement on). */
  blocks: string[];
  /** Configured models that warn (non-free on the user's own key). */
  warns: string[];
}

/**
 * Evaluate the free policy across every configured chat model (global + per-role). Used as the run-time
 * guard (a non-free model with no key blocks the run) and by the Doctor summary. Each entry
 * is rendered as `"<what> (<model>)"`.
 */
export function evaluateModelPolicy(uc: UserConfig): PolicyEvaluation {
  const blocks: string[] = [];
  const warns: string[] = [];
  const checks: Array<{ what: string; model: string }> = [];
  if (uc.globalModel) {checks.push({ what: "global", model: uc.globalModel });}
  for (const role of AGENT_ROLES) {
    const m = uc.models[role];
    if (m) {checks.push({ what: role, model: m });}
  }
  for (const c of checks) {
    const res = validateModelChoice(c.model, {
      usingOwnKey: uc.usingOwnKey,
      enforceFreeModels: uc.enforceFreeModels,
    });
    if (res.level === "block") {blocks.push(`${c.what} (${c.model})`);}
    else if (res.level === "warn") {warns.push(`${c.what} (${c.model})`);}
  }
  return { blocks, warns };
}
