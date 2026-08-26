#!/usr/bin/env node
/**
 * Verify every configured model actually answers, BEFORE spending a benchmark run on it.
 *
 * WHY THIS EXISTS. A dead model ID does not look like a failure: `resolveModelChain` falls through to
 * the next candidate, so the run *succeeds* while quietly using something other than what you configured.
 * That has now bitten this project twice — three OpenRouter defaults silently went paid-only (4 of 8
 * roles were running on the fallback), and a stale `OPENAI_MODEL` in a developer's `.env` made all 8
 * roles 404-then-fall-back for a whole benchmark.
 *
 *   npm run probe:models            # one tiny chat request per role + one embedding
 *   node scripts/probeModels.js --verbose
 *
 * Reads `.env` itself. Costs 9 near-empty requests.
 *
 * Reading the results:
 *   OK    — the model answered. Good.
 *   QUOTA — alive, but the account's allowance is spent (OpenRouter 429 / NVIDIA credit exhaustion).
 *   DEAD  — 404 / unknown model. Fix it in `src/core/llm/modelCatalog.ts`.
 *   AUTH  — 401/403. Wrong key for this base URL (an `nvapi-` key needs the NVIDIA base URL).
 */

const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const {
  AGENT_ROLES,
  activeProvider,
  catalogFor,
  defaultModelsFor,
  defaultEmbedModelFor,
} = require("../dist/core/llm/modelCatalog.js");
const { resolveModel } = require("../dist/core/llm/models.js");

const verbose = process.argv.includes("--verbose");
const apiKey = process.env.OPENAI_API_KEY;
const provider = activeProvider();
const cat = catalogFor(provider);
const baseUrl = (process.env.OPENAI_BASE_URL || cat.baseUrl).replace(/\/+$/, "");

/** How long to wait for a first token. Hosted NIM models cold-start, sometimes for tens of seconds. */
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 90000);
/** Above this, a model is usable but too slow for an interactive role. */
const SLOW_MS = 15000;

function classify(status, body) {
  if (status === 200) {return ["OK", ""];}
  if (status === 401 || status === 403) {return ["AUTH", "key rejected for this base URL"]; }
  if (status === 404) {return ["DEAD", "no such model on this provider"]; }
  if (status === 429) {return ["QUOTA", "alive, allowance spent"]; }
  if (status === 402) {return ["QUOTA", "payment required / credits exhausted"]; }
  // 5xx is the provider struggling, not a bad ID — usually a cold start on a large model.
  if (status >= 500) {return ["SLOW", `gateway ${status} — model exists but did not respond in time`]; }
  return [`HTTP ${status}`, (body || "").slice(0, 120).replace(/\s+/g, " ")];
}

async function probeChat(model) {
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: ctl.signal,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
    });
    const secs = (Date.now() - started) / 1000;
    const body = res.ok ? "" : await res.text().catch(() => "");
    const [state, note] = classify(res.status, body);
    if (state === "OK" && Date.now() - started > SLOW_MS) {
      return ["SLOW", `answered, but took ${secs.toFixed(1)}s`];
    }
    return [state, state === "OK" ? `${secs.toFixed(1)}s` : note];
  } catch {
    return ["SLOW", `no answer within ${(TIMEOUT_MS / 1000) | 0}s`];
  } finally {
    clearTimeout(timer);
  }
}

async function probeEmbedding(model) {
  const attempt = async (withInputType) => {
    const body = { model, input: "probe" };
    if (withInputType) {body.input_type = "query";}
    const res = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = res.ok ? null : await res.text().catch(() => "");
    let dim = null;
    if (res.ok) {
      const json = await res.json().catch(() => null);
      const v = json?.data?.[0]?.embedding;
      dim = Array.isArray(v) ? v.length : null;
    }
    return { status: res.status, text, dim };
  };

  try {
    // NVIDIA's retrieval models require input_type; OpenRouter's ignore it.
    let r = await attempt(provider === "nvidia");
    if (r.status !== 200 && provider === "nvidia") {r = await attempt(false);}
    const [state, note] = classify(r.status, r.text);
    return [state, r.dim ? `dim=${r.dim}` : note];
  } catch (e) {
    return ["ERROR", e?.message ?? String(e)];
  }
}

(async () => {
  console.log(`provider : ${cat.label}  (${provider})`);
  console.log(`base URL : ${baseUrl}`);
  console.log(`api key  : ${apiKey ? `${apiKey.slice(0, 7)}…${apiKey.slice(-4)} (${apiKey.length} chars)` : "NOT SET"}`);
  if (process.env.OPENAI_MODEL) {
    console.log(`\n⚠️  OPENAI_MODEL=${process.env.OPENAI_MODEL} is set — it OVERRIDES every per-role default.`);
    console.log("    Unset it unless you deliberately want one model everywhere.");
  }
  if (!apiKey) {
    console.log("\nNo OPENAI_API_KEY — nothing to probe.");
    process.exit(1);
  }

  console.log("\nrole          model                                        result");
  console.log("-".repeat(92));

  const defaults = defaultModelsFor(provider);
  const seen = new Map();
  let bad = 0;
  let slow = 0;
  for (const role of AGENT_ROLES) {
    const model = resolveModel(role);
    let res = seen.get(model);
    if (!res) {
      res = await probeChat(model);
      seen.set(model, res);
    }
    const [state, note] = res;
    // SLOW is not a failure: the ID is valid and the model answers, it is just cold or heavy. It is
    // reported so you can move an interactive role (receptionist, casual) off it if you care.
    if (state !== "OK" && state !== "QUOTA" && state !== "SLOW") {bad++;}
    if (state === "SLOW") {slow++;}
    const flag = model !== defaults[role] ? " *" : "";
    console.log(`${role.padEnd(13)} ${(model + flag).padEnd(44)} ${state}${note ? "  — " + note : ""}`);
  }

  const embedModel = process.env.OPENAI_EMBED_MODEL || defaultEmbedModelFor(provider);
  const [eState, eNote] = await probeEmbedding(embedModel);
  console.log("-".repeat(92));
  console.log(`${"embeddings".padEnd(13)} ${embedModel.padEnd(44)} ${eState}${eNote ? "  — " + eNote : ""}`);
  if (/dim=(\d+)/.test(eNote)) {
    const dim = Number(RegExp.$1);
    const { EMBEDDING_DIM } = require("../dist/core/db/db.js");
    console.log(
      dim === EMBEDDING_DIM
        ? `              ✅ matches EMBEDDING_DIM (${EMBEDDING_DIM}) — no database reset needed`
        : `              ⚠️  EMBEDDING_DIM is ${EMBEDDING_DIM}. With Postgres ON the vector path will ` +
          `switch itself off (with a warning); run "AgenticQA: Reset Database" after changing EMBEDDING_DIM.`
    );
  }

  console.log("");
  if (seen.size && [...seen.values()].every(([s]) => s === "QUOTA")) {
    console.log("Every model answered QUOTA: the IDs are valid, the account's allowance is spent.");
  }
  if (bad) {
    console.log(`❌ ${bad} role(s) are NOT usable — fix them in src/core/llm/modelCatalog.ts`);
  } else if (slow) {
    console.log(`✅ every role works. ${slow} is/are SLOW (cold start or a heavy model) — fine for `
      + `planner/packgen, worth avoiding for receptionist/casual.`);
  } else {
    console.log("✅ every role resolves to a usable model.");
  }
  console.log("(* = overridden by env or .agenticqa.json, not the catalog default)");
  process.exit(bad ? 1 : 0);
})();
