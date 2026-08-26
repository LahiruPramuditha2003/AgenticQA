/**
 * App Knowledge Pack — the optional, per-application knowledge seam.
 *
 * The planner engine is general and page-grounded: with NO pack it works against any web app
 * using only the live inspected page. A pack lets a specific app (e.g. apps/demo-web) supply
 * declarative knowledge — credentials, route hints, golden flows, assertion aliases — as DATA
 * instead of hardcoding it in engine code.
 *
 * Resolution: `.agenticqa.json`'s `knowledgePack` path (relative to the workspace) if set,
 * else the default `.agenticqa/knowledge.json`. Absent or malformed → null (pure page-grounded).
 *
 * This module is intentionally self-contained (no imports from agent types) to avoid cycles.
 */

import * as fs from "node:fs/promises";
import * as fssync from "node:fs";
import * as path from "node:path";

export interface CredentialPair {
  email: string;
  password: string;
}

export interface RegistrationCredentials {
  name: string;
  email: string;
  password: string;
  confirmPassword: string;
}

export interface ShippingDetails {
  name: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  card: string;
  expiry: string;
  cvv: string;
}

/**
 * Credentials actually available for this app. **Every group is optional — absent means absent.**
 * There are deliberately no built-in defaults: a credential the pack didn't supply is one we don't know,
 * and inventing one would put a foreign app's fake login into the planner prompt as fact (defect D2).
 */
export interface ResolvedCredentials {
  customer?: CredentialPair;
  admin?: CredentialPair;
  /** Form-fill hints; partial is useful, so individual fields may be missing. */
  registration?: Partial<RegistrationCredentials>;
  shipping?: Partial<ShippingDetails>;
}

/**
 * A named, verified-passing step sequence for one scenario.
 *
 * `description` and `steps` are the originals. The three optional fields were added in G2.1 to make flows
 * **retrievable** rather than merely addressable by key: the deterministic planner used to reach them
 * through a hardcoded regex ladder keyed to demo-web's 15 flow names, which is why auto-generated packs
 * (whose keys look like `smoke-home` / `form-login`) could never trigger it — limitation L2. All three are
 * optional and every existing pack keeps working untouched; `FlowIndex` falls back to the key +
 * `description` + step content when they're absent.
 */
export interface GoldenFlow {
  description: string;
  steps: object[];
  /**
   * Free-form intent labels used for retrieval, e.g. `["login", "sign in", "auth"]`. The point is to let a
   * request phrased in the *user's* words find a flow named in the *app's* words.
   */
  tags?: string[];
  /** True once the flow has actually been executed and passed (set by the pack generator's validation). */
  verified?: boolean;
  /** The route this flow primarily exercises, e.g. `/projects/:id` — a retrieval hint, not a constraint. */
  routeKey?: string;
}

/** Normalize a `tags` value from arbitrary parsed JSON: strings only, trimmed, lower-cased, deduped, capped. */
export function normalizeFlowTags(v: unknown, max = 12): string[] | undefined {
  if (!Array.isArray(v)) {return undefined;}
  const seen = new Set<string>();
  for (const raw of v) {
    if (typeof raw !== "string") {continue;}
    const t = raw.trim().toLowerCase().replace(/\s+/g, " ");
    if (t) {seen.add(t);}
    if (seen.size >= max) {break;}
  }
  return seen.size ? [...seen] : undefined;
}

export interface AssertionAlias {
  /** human note describing the condition this alias applies to */
  when: string;
  /** the element name / text to assert instead */
  assert: string;
}

export interface AppKnowledgePack {
  name?: string;
  /**
   * Marks a HAND-WRITTEN pack that `generate_pack` must not silently replace (D30/D38).
   *
   * Generation does not merge — it discards every existing flow — so one click could trade a curated
   * 15-flow pack for a 5-flow generated one, and on demo-web it did. Worse, that pack is ground truth
   * for five offline test suites, so the damage surfaced as eight failures in files that never mention
   * a pack. The engine now refuses unless the run explicitly opts in.
   *
   * ⚠️ Never set by the generator, and never accepted from a model — same rule as `verified`. Only a
   * human writing a pack by hand may set it, or the marker would mean nothing.
   */
  curated?: boolean;
  credentials?: Partial<{
    customer: CredentialPair;
    admin: CredentialPair;
    registration: RegistrationCredentials;
    shipping: ShippingDetails;
  }>;
  /** intent → path hints (e.g. { login: "/auth/login" }) */
  routes?: Record<string, string>;
  /** named, verified-passing step sequences keyed by scenario */
  goldenFlows?: Record<string, GoldenFlow>;
  /** app-specific "assert X instead" hints for ambiguous post-action states */
  assertionAliases?: AssertionAlias[];
  /** stable locator hints by logical name */
  stableElements?: Record<string, string>;
  /**
   * Free-form app-specific guidance appended to the LLM planner prompt (string, or line array joined
   * with "\n"). This is how an app teaches the planner its auth/search/assertion conventions WITHOUT
   * hardcoding them in the general engine. Injected ONLY when a pack supplies it — with no pack the
   * planner prompt carries no app-specific instructions (purely page-grounded).
   */
  plannerGuidance?: string | string[];
}

/** A usable login pair needs BOTH halves — an email with no password can't sign anything in. */
function loginPair(v: Partial<CredentialPair> | undefined): CredentialPair | undefined {
  const email = typeof v?.email === "string" ? v.email.trim() : "";
  const password = typeof v?.password === "string" ? v.password.trim() : "";
  return email && password ? { email, password } : undefined;
}

/** Keep only the string fields the pack actually supplied; drop the group when it supplied none. */
function suppliedFields<T extends object>(v: Partial<T> | undefined): Partial<T> | undefined {
  if (!v || typeof v !== "object") {return undefined;}
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "string" && val.trim()) {out[k] = val;}
  }
  return Object.keys(out).length ? (out as Partial<T>) : undefined;
}

/**
 * The credentials this app actually declares. **No defaults, no merging, no invention** — a group the
 * pack omits comes back `undefined`.
 *
 * This used to merge a built-in `DEFAULT_CREDENTIALS` constant (the demo app's real logins) into every
 * gap, so a pack that omitted, say, the `admin` group silently received the demo app's admin login —
 * which the planner prompt then presented to the LLM as fact for a completely unrelated application
 * (defect D2, fixed in G0.3). Those values now live where they belong: in the demo app's own pack at
 * `apps/demo-web/.agenticqa/knowledge.json`.
 */
export function resolveCredentials(pack?: AppKnowledgePack | null): ResolvedCredentials {
  const c = pack?.credentials;
  const out: ResolvedCredentials = {};
  const customer = loginPair(c?.customer);
  if (customer) {out.customer = customer;}
  const admin = loginPair(c?.admin);
  if (admin) {out.admin = admin;}
  const registration = suppliedFields<RegistrationCredentials>(c?.registration);
  if (registration) {out.registration = registration;}
  const shipping = suppliedFields<ShippingDetails>(c?.shipping);
  if (shipping) {out.shipping = shipping;}
  return out;
}

/** `{name: "x", zip: "1"}` → `"name=x, zip=1"`, preserving the interface's field order. */
function joinFields<T extends object>(v: Partial<T>, order: Array<keyof T & string>): string {
  return order
    .filter((k) => typeof (v as Record<string, unknown>)[k] === "string")
    .map((k) => `${k}=${(v as Record<string, string>)[k]}`)
    .join(", ");
}

/**
 * Render the "Credentials" block for the planner prompt — **only the groups the pack supplied**.
 * Returns "" when the app declares none, so the prompt simply carries no credentials section rather
 * than a fabricated one.
 */
export function formatCredentialsBlock(creds: ResolvedCredentials): string {
  const lines: string[] = [];
  if (creds.customer) {
    lines.push(`- Customer: email=${creds.customer.email} password=${creds.customer.password}`);
  }
  if (creds.admin) {
    lines.push(`- Admin: email=${creds.admin.email} password=${creds.admin.password}`);
  }
  if (creds.registration) {
    const fields = joinFields(creds.registration, [
      "name",
      "email",
      "password",
      "confirmPassword",
    ]);
    if (fields) {lines.push(`- New registration: ${fields}`);}
  }
  if (creds.shipping) {
    const fields = joinFields(creds.shipping, [
      "name",
      "address",
      "city",
      "state",
      "zip",
      "card",
      "expiry",
      "cvv",
    ]);
    if (fields) {lines.push(`- Shipping: ${fields}`);}
  }
  if (lines.length === 0) {return "";}
  return ["Credentials (use EXACTLY these):", ...lines].join("\n");
}

/**
 * App-specific planner guidance, normalized to a single string. A line array is joined with "\n".
 * Returns "" when the pack supplies none — so the planner prompt stays page-grounded with no pack.
 */
export function resolvePlannerGuidance(pack?: AppKnowledgePack | null): string {
  const g = pack?.plannerGuidance;
  if (!g) return "";
  return Array.isArray(g) ? g.join("\n") : String(g);
}

/** Pack-supplied golden flows, or null when none. */
export function resolveGoldenFlows(
  pack?: AppKnowledgePack | null
): Record<string, GoldenFlow> | null {
  const flows = pack?.goldenFlows;
  if (flows && typeof flows === "object" && Object.keys(flows).length > 0) return flows;
  return null;
}

/** Parse raw pack JSON (pure — no filesystem). Returns null on malformed/non-object input. */
export function parseKnowledgePack(
  raw: string,
  source: string,
  logger?: { log: (m: string) => void }
): AppKnowledgePack | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e: any) {
    logger?.log(`KnowledgePack: failed to parse ${source} — ${e?.message ?? String(e)}. Ignoring.`);
    return null;
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    logger?.log(`KnowledgePack: ${source} is not a JSON object — ignoring.`);
    return null;
  }
  return json as AppKnowledgePack;
}

/**
 * Locate and load the app knowledge pack for a workspace. Returns null when none is found,
 * which keeps the planner in pure page-grounded mode.
 */
export async function loadAppKnowledgePack(
  workspacePath: string,
  cfg: { knowledgePack?: string } | undefined,
  logger?: { log: (m: string) => void }
): Promise<AppKnowledgePack | null> {
  const candidates: string[] = [];
  if (cfg?.knowledgePack) candidates.push(path.resolve(workspacePath, cfg.knowledgePack));
  candidates.push(path.resolve(workspacePath, ".agenticqa", "knowledge.json"));

  for (const p of candidates) {
    if (!fssync.existsSync(p)) continue;
    const raw = await fs.readFile(p, "utf8");
    const pack = parseKnowledgePack(raw, p, logger);
    if (pack) {
      logger?.log(`KnowledgePack: loaded "${pack.name ?? path.basename(p)}" from ${p}`);
    }
    return pack;
  }

  logger?.log("KnowledgePack: none found — planner runs page-grounded (no app pack)");
  return null;
}
