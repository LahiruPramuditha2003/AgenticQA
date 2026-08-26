/**
 * Per-agent model registry — the single source of truth for "which LLM does role X use".
 *
 * Resolution precedence for a role's PRIMARY model (first that is set):
 *   1. explicit `opts.model` argument (escape hatch / tests)
 *   2. `.agenticqa.json` `models[role]` override (registered via `registerModelOverrides`)
 *   3. `OPENAI_MODEL_<ROLE>` env var (e.g. OPENAI_MODEL_PLANNER)
 *   4. `OPENAI_MODEL` global env var — the force-one-model knob; when set it overrides the
 *      built-in role defaults, preserving today's single-model behavior (and the verified 20/20)
 *      until the owner opts in.
 *   5. built-in `DEFAULT_MODELS[role]`
 *   6. universal `SAFETY_MODEL`
 *
 * `resolveModelChain` returns the ordered, de-duped fallback list (primary first, ending in the
 * safety model) that `LlmClient` walks on per-model failure. See docs/CONFIGURATION.md. Phase 3.
 */

// Model IDs live in ONE place — `modelCatalog.ts`. Re-exported here so every existing import of
// `core/llm/models` keeps working; do not re-declare the lists in this file.
export type { AgentRole } from "./modelCatalog";
export {
  AGENT_ROLES,
  DEFAULT_MODELS,
  activeProvider,
  providerForBaseUrl,
  defaultModelsFor,
  safetyModelFor,
  isFreeModelId,
} from "./modelCatalog";

import type { AgentRole } from "./modelCatalog";
import { AGENT_ROLES, DEFAULT_MODELS, safetyModelFor } from "./modelCatalog";

/**
 * The safety model for the ACTIVE provider. A function, not a constant: the provider comes from
 * `OPENAI_BASE_URL`, which `main.ts` only loads after its imports have run (ES imports hoist above
 * `dotenv.config()`), so a module-load constant would bake in the wrong provider.
 */
export function safetyModel(): string {
  return safetyModelFor();
}

// ── Per-workspace overrides (set once by ConfigService from .agenticqa.json `models`) ─────────

let configOverrides: Partial<Record<AgentRole, string>> = {};

function isAgentRole(key: string): key is AgentRole {
  return (AGENT_ROLES as string[]).includes(key);
}

/** Trim and treat empty as unset. */
function clean(v: string | undefined | null): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * Register per-workspace model overrides (from `.agenticqa.json` `models`). Replaces any prior
 * overrides; pass `undefined`/`null` to clear. Keys are case-insensitive role names; unknown keys
 * and empty values are ignored.
 */
export function registerModelOverrides(map?: Record<string, string> | null): void {
  const next: Partial<Record<AgentRole, string>> = {};
  if (map) {
    for (const [key, value] of Object.entries(map)) {
      const role = String(key).toLowerCase();
      const model = clean(value);
      if (isAgentRole(role) && model) next[role] = model;
    }
  }
  configOverrides = next;
}

/** The env var name for a role's model override, e.g. `planner` → `OPENAI_MODEL_PLANNER`. */
export function roleEnvVar(role: AgentRole): string {
  return `OPENAI_MODEL_${role.toUpperCase()}`;
}

/**
 * Ordered candidate models for a role, highest precedence first (before filtering/de-duping):
 *   explicit arg → config override → OPENAI_MODEL_<ROLE> → OPENAI_MODEL → role default → safety.
 * `process.env` is read live so changes (and tests) take effect without re-import.
 */
function candidatesFor(role: AgentRole, opts?: { model?: string }): (string | undefined)[] {
  return [
    clean(opts?.model),
    configOverrides[role],
    clean(process.env[roleEnvVar(role)]),
    clean(process.env.OPENAI_MODEL),
    DEFAULT_MODELS[role],
    safetyModel(),
  ];
}

/** Resolve the single primary model for a role (first candidate that is set). */
export function resolveModel(role: AgentRole, opts?: { model?: string }): string {
  for (const c of candidatesFor(role, opts)) {
    if (c) return c;
  }
  return safetyModel(); // unreachable (the safety model is always a candidate); keeps the return a string
}

/** Ordered, de-duped fallback chain: primary first, ending in the safety model. */
export function resolveModelChain(role: AgentRole, opts?: { model?: string }): string[] {
  const seen = new Set<string>();
  const chain: string[] = [];
  for (const c of candidatesFor(role, opts)) {
    if (c && !seen.has(c)) {
      seen.add(c);
      chain.push(c);
    }
  }
  return chain;
}
