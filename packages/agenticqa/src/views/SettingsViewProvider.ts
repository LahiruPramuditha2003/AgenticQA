/**
 * AgenticQA Settings panel — a friendly webview editor over the native `agenticqa.*` settings + the
 * SecretStorage API key (owner decision: "Both" — native settings are the source of truth, this panel is
 * the nice editor). Per-agent model inputs are comboboxes (a shared `<datalist>` of free models — live
 * from the user's key, unioned with the curated fallback — plus free-text). A "Test key" button validates
 * the key, "Refresh models" re-fetches the live free list.
 *
 * The panel only reads/writes settings + secrets; it never touches the run/orchestrator path.
 */

import * as vscode from "vscode";
import * as crypto from "node:crypto";
import { CURATED_FREE_MODELS, fetchFreeModels } from "../config/freeModels";
import {
  AGENT_ROLES,
  SECRET_API_KEY,
  readUserConfig,
  validateModelChoice,
  type AgentRole,
  type UserConfig,
} from "../config/userConfig";

let currentPanel: vscode.WebviewPanel | undefined;

/**
 * The agent prompts a user may edit (R1.4).
 *
 * Deliberately just these three: they are the only prompts the engine loads as DATA. The planner's
 * prompt is *assembled* from the knowledge pack, the live page context and a strict JSON contract —
 * exposing it as free text would let a typo break plan parsing with no feedback and no obvious cause.
 * The safe planner knob is `plannerGuidance` in the app's knowledge pack, which is additive by design.
 */
const EDITABLE_PROMPTS: Array<{ agent: string; label: string; blurb: string }> = [
  {
    agent: "DomainQaAgent",
    label: "Domain Q&A",
    blurb: "How documentation questions are answered, and how strictly claims must be cited.",
  },
  {
    agent: "ReceptionistAgent",
    label: "Receptionist",
    blurb: "How a request is classified as chat, a documentation question, or a test to generate.",
  },
  {
    agent: "SelfHealAgent",
    label: "Self-heal",
    blurb: "How a replacement element is chosen when a locator breaks.",
  },
];

/** `<globalStorage>/prompts/<Agent>.md` — mirrors `promptOverrideDir` in extension.ts. */
function promptFileFor(context: vscode.ExtensionContext, agent: string): vscode.Uri {
  return vscode.Uri.joinPath(context.globalStorageUri, "prompts", `${agent}.md`);
}

/** Which prompts the user has customized, so the panel can show Default vs Customized. */
async function readPromptStates(
  context: vscode.ExtensionContext
): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const p of EDITABLE_PROMPTS) {
    try {
      const buf = await vscode.workspace.fs.readFile(promptFileFor(context, p.agent));
      out[p.agent] = Buffer.from(buf).toString("utf8").trim().length > 0;
    } catch {
      out[p.agent] = false;
    }
  }
  return out;
}

const ROLE_LABELS: Record<AgentRole, string> = {
  planner: "Planner",
  domainqa: "Domain Q&A",
  selfheal: "Self-heal",
  reporter: "Reporter",
  receptionist: "Receptionist",
  casual: "Casual",
  explorer: "Explorer",
  packgen: "Knowledge-pack generator",
};

// Role placeholders and the API-key hint come from the ONE catalog
// (`packages/orchestrator/src/core/llm/modelCatalog.ts`), so this panel can never advertise a default
// the orchestrator does not use, nor a key format the configured provider does not issue. These were
// previously hand-synced copies. esbuild inlines the import — no runtime dependency is created.
import {
  DEFAULT_MODELS as ROLE_DEFAULTS,
  keyHintFor,
  providerForBaseUrl,
} from "../../../orchestrator/src/core/llm/modelCatalog";
import { resolveEngine, packagedPromptFile } from "../util/engine";

/** Open (or reveal) the singleton Settings panel. */
export async function openSettingsPanel(context: vscode.ExtensionContext): Promise<void> {
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.Active);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "agenticqaSettings",
    "AgenticQA Settings",
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  currentPanel = panel;
  panel.onDidDispose(() => {
    currentPanel = undefined;
  });

  const uc = await readUserConfig(context);
  const models = await fetchFreeModels({ baseUrl: uc.baseUrl, apiKey: uc.apiKey });
  panel.webview.html = buildSettingsHtml(uc, models, await readPromptStates(context));

  panel.webview.onDidReceiveMessage(async (msg: any) => {
    try {
      if (!msg || typeof msg.type !== "string") {return;}
      switch (msg.type) {
        case "save":
          await handleSave(context, panel, msg.payload ?? {});
          break;
        case "testKey":
          await handleTestKey(context, panel, msg.payload ?? {});
          break;
        case "refreshModels": {
          const p = msg.payload ?? {};
          const stored = await context.secrets.get(SECRET_API_KEY);
          const next = await fetchFreeModels({
            baseUrl: p.baseUrl,
            apiKey: (p.apiKey && String(p.apiKey).trim()) || stored || undefined,
          });
          panel.webview.postMessage({ type: "models", models: next });
          panel.webview.postMessage({
            type: "status",
            level: "ok",
            message: `Loaded ${next.length} free model(s).`,
          });
          break;
        }
        case "editPrompt":
          await handleEditPrompt(context, panel, String(msg.agent ?? ""));
          break;
        case "resetPrompt":
          await handleResetPrompt(context, panel, String(msg.agent ?? ""));
          break;
        case "clearKey":
          await context.secrets.delete(SECRET_API_KEY);
          panel.webview.postMessage({ type: "keyCleared" });
          panel.webview.postMessage({
            type: "status",
            level: "ok",
            message: "API key removed. LLM features are unavailable until you add another key.",
          });
          break;
      }
    } catch (e: any) {
      panel.webview.postMessage({
        type: "status",
        level: "error",
        message: e?.message ?? String(e),
      });
    }
  });
}

/**
 * Open a user's override for editing, creating it from the SHIPPED prompt on first use (R1.4).
 *
 * Seeding from the real file matters: those prompts carry `<!-- maintainer notes -->` documenting each
 * one's parsing contract (Domain Q&A must return JSON the caller Zod-validates; Self-heal must return a
 * bare number). A blank editor would invite a rewrite that parses as nothing.
 */
async function handleEditPrompt(
  context: vscode.ExtensionContext,
  panel: vscode.WebviewPanel,
  agent: string
): Promise<void> {
  if (!EDITABLE_PROMPTS.some((p) => p.agent === agent)) {return;}
  const target = promptFileFor(context, agent);

  let exists = true;
  try {
    await vscode.workspace.fs.stat(target);
  } catch {
    exists = false;
  }

  if (!exists) {
    const engine = await resolveEngine({
      extensionPath: context.extensionPath,
      configuredPath: vscode.workspace.getConfiguration("agenticqa").get<string>("enginePath"),
      exists: async (p) => {
        try {
          await vscode.workspace.fs.stat(vscode.Uri.file(p));
          return true;
        } catch {
          return false;
        }
      },
    });
    let seed = "";
    if (engine) {
      try {
        const buf = await vscode.workspace.fs.readFile(
          vscode.Uri.file(packagedPromptFile(engine.path, agent))
        );
        seed = Buffer.from(buf).toString("utf8");
      } catch {
        /* fall through to the explanatory stub below */
      }
    }
    if (!seed) {
      // Better an honest note than an empty file the engine will ignore — an empty override falls
      // through to the shipped prompt by design, which would look like "editing does nothing".
      seed =
        `<!-- AgenticQA could not read the shipped ${agent} prompt to seed this file.
` +
        `     Anything you write here REPLACES that prompt. Delete this file (or use Reset in
` +
        `     AgenticQA Settings) to go back to the default. -->
`;
    }
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(context.globalStorageUri, "prompts"));
    await vscode.workspace.fs.writeFile(target, Buffer.from(seed, "utf8"));
  }

  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));
  panel.webview.postMessage({ type: "promptStates", states: await readPromptStates(context) });
  panel.webview.postMessage({
    type: "status",
    level: "ok",
    message: `Editing the ${agent} prompt. Save the file — the next run picks it up.`,
  });
}

/** Delete an override so the shipped prompt applies again. */
async function handleResetPrompt(
  context: vscode.ExtensionContext,
  panel: vscode.WebviewPanel,
  agent: string
): Promise<void> {
  if (!EDITABLE_PROMPTS.some((p) => p.agent === agent)) {return;}
  const confirm = await vscode.window.showWarningMessage(
    `Discard your customized ${agent} prompt and go back to the built-in one?`,
    { modal: true },
    "Reset"
  );
  if (confirm !== "Reset") {return;}
  try {
    await vscode.workspace.fs.delete(promptFileFor(context, agent));
  } catch {
    /* already gone — the desired end state either way */
  }
  panel.webview.postMessage({ type: "promptStates", states: await readPromptStates(context) });
  panel.webview.postMessage({
    type: "status",
    level: "ok",
    message: `${agent} is back to the built-in prompt.`,
  });
}

async function handleSave(
  context: vscode.ExtensionContext,
  panel: vscode.WebviewPanel,
  p: any
): Promise<void> {
  const hadKey = !!(await context.secrets.get(SECRET_API_KEY));
  const willSetKey = typeof p.apiKey === "string" && p.apiKey.trim().length > 0;
  const usingOwnKey = hadKey || willSetKey;
  const enforceFree = !!p.enforceFreeModels;

  // Validate chat models (global + per-role) against the soft free policy. Embeddings are not chat models
  // and aren't subject to the free list.
  const checks: Array<{ what: string; model: string }> = [];
  if (p.globalModel && String(p.globalModel).trim()) {
    checks.push({ what: "Global model", model: String(p.globalModel).trim() });
  }
  for (const r of AGENT_ROLES) {
    const m = p.models?.[r];
    if (m && String(m).trim()) {checks.push({ what: ROLE_LABELS[r], model: String(m).trim() });}
  }

  const blocks: string[] = [];
  const warns: string[] = [];
  for (const c of checks) {
    const res = validateModelChoice(c.model, { usingOwnKey, enforceFreeModels: enforceFree });
    if (res.level === "block") {blocks.push(`${c.what} — ${res.message}`);}
    else if (res.level === "warn") {warns.push(`${c.what} — ${res.message}`);}
  }
  if (blocks.length) {
    panel.webview.postMessage({
      type: "status",
      level: "error",
      message: "Not saved. " + blocks.join("  "),
    });
    return;
  }

  if (willSetKey) {await context.secrets.store(SECRET_API_KEY, p.apiKey.trim());}

  const cfg = vscode.workspace.getConfiguration("agenticqa");
  const G = vscode.ConfigurationTarget.Global;
  await cfg.update("api.baseUrl", String(p.baseUrl ?? "").trim(), G);
  await cfg.update("api.globalModel", String(p.globalModel ?? "").trim(), G);
  for (const r of AGENT_ROLES) {
    await cfg.update(`models.${r}`, String(p.models?.[r] ?? "").trim(), G);
  }
  await cfg.update("embedModel", String(p.embedModel ?? "").trim(), G);
  await cfg.update("enforceFreeModels", enforceFree, G);

  const note = warns.length ? "  ⚠ " + warns.join("  ⚠ ") : "";
  panel.webview.postMessage({
    type: "status",
    level: warns.length ? "warn" : "ok",
    message: "Settings saved ✓" + note,
  });
  if (willSetKey) {panel.webview.postMessage({ type: "keySaved" });}
}

async function handleTestKey(
  context: vscode.ExtensionContext,
  panel: vscode.WebviewPanel,
  p: any
): Promise<void> {
  const baseUrl = (String(p.baseUrl ?? "").trim() || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
  const key =
    (p.apiKey && String(p.apiKey).trim()) ||
    (await context.secrets.get(SECRET_API_KEY)) ||
    "";
  if (!key) {
    panel.webview.postMessage({
      type: "status",
      level: "warn",
      message: "No API key to test — enter one above, or run AgenticQA: Set API Key.",
    });
    return;
  }
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    });
    if (res.ok) {
      const json = (await res.json().catch(() => ({}))) as { data?: unknown[] };
      const count = Array.isArray(json?.data) ? json.data.length : 0;
      panel.webview.postMessage({
        type: "status",
        level: "ok",
        message: `Key works ✓ — ${count} model(s) reachable at ${baseUrl}.`,
      });
    } else {
      panel.webview.postMessage({
        type: "status",
        level: "error",
        message: `Key test failed: ${res.status} ${res.statusText}.`,
      });
    }
  } catch (e: any) {
    panel.webview.postMessage({
      type: "status",
      level: "error",
      message: `Key test error: ${e?.message ?? String(e)}`,
    });
  }
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

function buildSettingsHtml(
  uc: UserConfig,
  models: string[],
  promptStates: Record<string, boolean>
): string {
  const nonce = crypto.randomBytes(16).toString("hex");

  const suggestions = [
    ...new Set(
      [...models, ...CURATED_FREE_MODELS, uc.globalModel, ...Object.values(uc.models)]
        .filter((m): m is string => !!m)
    ),
  ];
  const options = suggestions.map((m) => `<option value="${esc(m)}"></option>`).join("");

  const roleRows = AGENT_ROLES.map(
    (r) => `
      <div class="field">
        <label for="model-${r}">${esc(ROLE_LABELS[r])}</label>
        <input id="model-${r}" class="model" list="freeModels" data-role="${esc(r)}"
               value="${esc(uc.models[r] ?? "")}" placeholder="${esc(ROLE_DEFAULTS[r])} (default)" />
      </div>`
  ).join("");

  const promptRows = EDITABLE_PROMPTS.map((p) => {
    const customized = promptStates[p.agent] === true;
    return `
    <div class="promptRow">
      <div class="promptMeta">
        <strong>${esc(p.label)}</strong>
        <span class="badge ${customized ? "custom" : "default"}">${customized ? "Customized" : "Default"}</span>
        <div class="hint">${esc(p.blurb)}</div>
      </div>
      <div class="promptActions">
        <button class="secondary" data-edit="${esc(p.agent)}">Edit</button>
        <button class="secondary" data-reset="${esc(p.agent)}" ${customized ? "" : "disabled"}>Reset</button>
      </div>
    </div>`;
  }).join("");

  const rolesJson = JSON.stringify([...AGENT_ROLES]);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<title>AgenticQA Settings</title>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         background: var(--vscode-editor-background); margin: 0; padding: 20px; font-size: 13px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: var(--vscode-descriptionForeground); margin: 0 0 18px; }
  .card { background: var(--vscode-editorWidget-background, rgba(127,127,127,.08));
          border: 1px solid var(--vscode-widget-border, rgba(127,127,127,.25));
          border-radius: 8px; padding: 14px 16px; margin-bottom: 16px; }
  .card h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .5px;
             color: var(--vscode-descriptionForeground); margin: 0 0 12px; }
  .field { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
  .field label { flex: 0 0 180px; }
  .field input[type=text], .field input[type=password] {
    flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; padding: 6px 8px;
    font-family: var(--vscode-editor-font-family); font-size: 12px; }
  .field input:focus { outline: 1px solid var(--vscode-focusBorder); }
  .field input.nonfree { border-color: var(--vscode-inputValidation-warningBorder, #f59e0b); }
  .hint { color: var(--vscode-descriptionForeground); font-size: 11px; margin: 2px 0 0 192px; }
  .check { display: flex; align-items: center; gap: 8px; }
  .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 4px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
           border: none; border-radius: 4px; padding: 8px 14px; font-size: 12px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: transparent; color: var(--vscode-foreground);
                     border: 1px solid var(--vscode-button-border, var(--vscode-widget-border, #555)); }
  button.secondary:disabled { opacity: .45; cursor: default; }
  /* Agent prompts (R1.4) — a row per editable prompt: what it controls, whether it is customized. */
  .promptRow { display: flex; align-items: flex-start; gap: 12px; padding: 10px 0;
               border-top: 1px solid var(--vscode-widget-border, rgba(127,127,127,.25)); }
  .promptRow:first-of-type { border-top: none; }
  .promptMeta { flex: 1; min-width: 0; }
  /* The blurb sits under the name here, so the global .hint left margin (which aligns with the
     192px form-label column elsewhere) has to be cancelled or it reads as belonging to nothing. */
  .promptMeta .hint { margin-left: 0; margin-top: 3px; }
  .promptActions { display: flex; gap: 6px; flex-shrink: 0; }
  .badge { display: inline-block; margin-left: 8px; padding: 1px 7px; border-radius: 9px;
           font-size: 10px; vertical-align: middle; }
  .badge.default { background: rgba(127,127,127,.22); color: var(--vscode-descriptionForeground); }
  .badge.custom { background: var(--vscode-inputValidation-warningBackground, rgba(245,158,11,.2));
                  color: var(--vscode-foreground);
                  border: 1px solid var(--vscode-inputValidation-warningBorder, #f59e0b); }
  .keystate { font-size: 11px; color: var(--vscode-descriptionForeground); margin-left: 8px; }
  #status { margin-top: 14px; padding: 10px 12px; border-radius: 6px; font-size: 12px; display: none; white-space: pre-wrap; }
  #status.ok { display: block; background: rgba(34,197,94,.14); border: 1px solid rgba(34,197,94,.4); }
  #status.warn { display: block; background: rgba(245,158,11,.14); border: 1px solid rgba(245,158,11,.4); }
  #status.error { display: block; background: rgba(239,68,68,.14); border: 1px solid rgba(239,68,68,.4); }
</style>
</head>
<body>
  <h1>AgenticQA Settings</h1>
  <p class="sub">Use your own OpenRouter-compatible API key and pick a model per agent. Leave anything blank
     to leave it unset. Free models end in <code>:free</code>.</p>

  <datalist id="freeModels">${options}</datalist>

  <div class="card">
    <h2>API</h2>
    <div class="field">
      <label for="apiKey">API key</label>
      <input id="apiKey" type="password" placeholder="${uc.usingOwnKey ? "•••••••• saved — type to replace" : `${keyHintFor(providerForBaseUrl(uc.baseUrl))} — required for AI features`}" />
      <span class="keystate" id="keystate">${uc.usingOwnKey ? "A key is saved" : "No key configured"}</span>
    </div>
    <div class="field">
      <label for="baseUrl">Base URL</label>
      <input id="baseUrl" type="text" value="${esc(uc.baseUrl ?? "")}" placeholder="https://openrouter.ai/api/v1 (default)" />
    </div>
    <div class="actions">
      <button id="btnTest" class="secondary">Test key</button>
      <button id="btnRefresh" class="secondary">Refresh models</button>
      <button id="btnClearKey" class="secondary">Clear key</button>
    </div>
  </div>

  <div class="card">
    <h2>Per-agent models</h2>
    <div class="field">
      <label for="globalModel">Force one model (all agents)</label>
      <input id="globalModel" class="model" list="freeModels" value="${esc(uc.globalModel ?? "")}" placeholder="blank = use per-agent models below" />
    </div>
    ${roleRows}
    <p class="hint">Tip: keep big models on Planner / Domain Q&A and small/fast ones on the trivial roles.</p>
  </div>

  <div class="card">
    <h2>Embeddings &amp; policy</h2>
    <div class="field">
      <label for="embedModel">Embedding model</label>
      <input id="embedModel" type="text" value="${esc(uc.embedModel ?? "")}" placeholder="blank = configured default" />
    </div>
    <p class="hint">Used for RAG + vector self-heal. Safe to change with the DB off; with Postgres on, the DB fixes the vector dimension.</p>
    <div class="field check">
      <input id="enforceFree" type="checkbox" ${uc.enforceFreeModels ? "checked" : ""} />
      <label for="enforceFree" style="flex:1">Block non-free models when no API key is configured</label>
    </div>
  </div>

  <div class="card">
    <h2>Agent prompts</h2>
    <p class="hint">
      Each agent's system prompt is a markdown file you can edit. Changes apply to the next run — no
      rebuild. Only these three are exposed: they are the prompts the engine loads as data. The planner's
      prompt is assembled from your knowledge pack plus a strict JSON contract, so it is not free text;
      use <code>plannerGuidance</code> in the app's knowledge pack to add planner instructions.
    </p>
    ${promptRows}
    <p class="hint">
      ⚠️ The published accuracy figures were measured with the built-in prompts. If results get worse
      after an edit, <strong>Reset</strong> is the first thing to try.
    </p>
  </div>

  <div class="actions">
    <button id="btnSave">Save settings</button>
  </div>
  <div id="status"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const ROLES = ${rolesJson};
    const $ = (id) => document.getElementById(id);

    function isFree(v) { v = (v||'').trim(); return v === 'openrouter/free' || /:free$/i.test(v); }
    function markFree() {
      document.querySelectorAll('.model').forEach((el) => {
        const v = el.value.trim();
        el.classList.toggle('nonfree', !!v && !isFree(v));
      });
    }
    document.querySelectorAll('.model').forEach((el) => el.addEventListener('input', markFree));
    markFree();

    function gather() {
      const models = {};
      ROLES.forEach((r) => {
        const el = document.getElementById('model-' + r);
        if (el && el.value.trim()) { models[r] = el.value.trim(); }
      });
      return {
        apiKey: $('apiKey').value,
        baseUrl: $('baseUrl').value,
        globalModel: $('globalModel').value,
        embedModel: $('embedModel').value,
        enforceFreeModels: $('enforceFree').checked,
        models,
      };
    }

    $('btnSave').addEventListener('click', () => vscode.postMessage({ type: 'save', payload: gather() }));
    $('btnTest').addEventListener('click', () => vscode.postMessage({ type: 'testKey', payload: { apiKey: $('apiKey').value, baseUrl: $('baseUrl').value } }));
    $('btnRefresh').addEventListener('click', () => vscode.postMessage({ type: 'refreshModels', payload: { apiKey: $('apiKey').value, baseUrl: $('baseUrl').value } }));
    $('btnClearKey').addEventListener('click', () => vscode.postMessage({ type: 'clearKey' }));

    // Agent prompts — delegated, so re-rendering the rows never leaves a dead listener behind.
    document.addEventListener('click', (e) => {
      const edit = e.target && e.target.getAttribute && e.target.getAttribute('data-edit');
      if (edit) { vscode.postMessage({ type: 'editPrompt', agent: edit }); return; }
      const reset = e.target && e.target.getAttribute && e.target.getAttribute('data-reset');
      if (reset) { vscode.postMessage({ type: 'resetPrompt', agent: reset }); }
    });

    function renderPromptStates(states) {
      document.querySelectorAll('[data-edit]').forEach((btn) => {
        const agent = btn.getAttribute('data-edit');
        const row = btn.closest('.promptRow');
        if (!row) { return; }
        const badge = row.querySelector('.badge');
        const custom = states[agent] === true;
        if (badge) {
          badge.textContent = custom ? 'Customized' : 'Default';
          badge.className = 'badge ' + (custom ? 'custom' : 'default');
        }
        const resetBtn = row.querySelector('[data-reset]');
        if (resetBtn) { resetBtn.disabled = !custom; }
      });
    }

    window.addEventListener('message', (event) => {
      const msg = event.data || {};
      if (msg.type === 'status') {
        const s = $('status');
        s.className = msg.level || 'ok';
        s.textContent = msg.message || '';
      } else if (msg.type === 'promptStates') {
        renderPromptStates(msg.states || {});
      } else if (msg.type === 'models') {
        const dl = $('freeModels');
        dl.innerHTML = (msg.models || []).map((m) => '<option value="' + m.replace(/"/g, '&quot;') + '"></option>').join('');
      } else if (msg.type === 'keySaved') {
        $('apiKey').value = '';
        $('apiKey').placeholder = '•••••••• saved — type to replace';
        $('keystate').textContent = 'A key is saved';
      } else if (msg.type === 'keyCleared') {
        $('apiKey').value = '';
        $('apiKey').placeholder = ${JSON.stringify(`${keyHintFor(providerForBaseUrl(uc.baseUrl))} — required for AI features`)};
        $('keystate').textContent = 'No key configured';
      }
    });
  </script>
</body>
</html>`;
}
