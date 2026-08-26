# Contributing to AgenticQA

Thanks for taking an interest. This document is the practical companion to
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how to build it, how to test it, and — most importantly —
the invariants that keep it working.

---

## Setup

```bash
git clone <this-repo>
cd AgenticQA
npm install                                     # installs all workspaces

cp packages/orchestrator/.env.example packages/orchestrator/.env
# add your OPENAI_API_KEY — free tiers at openrouter.ai/keys or build.nvidia.com
```

### Build order matters

**The engine builds before the extension.** The extension bundles the engine at build time, so the order
is not a preference:

```bash
cd packages/orchestrator && npm run build     # tsc → dist/, then copies agent prompts
cd ../agenticqa          && npm run compile   # typecheck + lint + esbuild + bundle the engine
```

In practice you rarely run these by hand: press **F5** in VS Code (**Run Extension**) and the
`Build Extension` task does both in parallel, then opens an Extension Development Host with
`apps/demo-web` loaded.

> The extension bundles with **esbuild**, not `tsc` — use `npm run compile` / `npm run watch`, never raw
> `tsc`. The orchestrator, by contrast, *is* compiled with `tsc`.

### Optional — the database

```bash
docker compose up -d      # Postgres + pgvector
```

Adds run history, locator baselines and the vector self-heal path. **Everything else works without it**,
and it must stay that way (see invariant 2).

---

## Tests

| What | Command | Needs |
|---|---|---|
| Engine suite | `cd packages/orchestrator && npm test` | nothing — no network, no Docker |
| Extension suite | `cd packages/agenticqa && npm test` | nothing |
| Extension host suite | `cd packages/agenticqa && npm run test:vscode` | downloads VS Code |
| Demo app build | `cd apps/demo-web && npm run build` | nothing |

Both offline suites must be green before any change is considered done. They are fast (~20 s and ~1 s) and
they run without a network, so there is no reason to skip them.

### Evaluation harnesses

```bash
cd packages/orchestrator
npm run eval:flowindex        # flow retrieval on the hand-written pack
npm run eval:generatedpack    # flow retrieval on a generated pack
npm run probe:models          # LIVE — is each configured model alive?
```

`probe:models` is worth running whenever results look strange. **A dead free-model ID never looks like a
failure** — the fallback chain hides it — which is how four of eight agent roles once ran on the wrong
model for weeks.

### The benchmark

```bash
cd packages/orchestrator
node scripts/batchRunTemplates.js --from=1 --to=20 --save-logs
```

Live: needs an API key and starts the dev server. See [docs/BENCHMARKS.md](docs/BENCHMARKS.md) for what the
numbers mean and how to read them.

---

## Invariants — do not break these

These are not style preferences. Each one is here because breaking it caused a real, hard-to-find failure.

### 1. stdout is the protocol

The engine talks to the extension in newline-delimited JSON over **stdout**. Anything else written there
corrupts the stream and the extension sees garbage rather than a run. Logs go to stderr or through the
`Logger`. `console.log` is redirected to stderr in `main.ts` precisely so a bundled dependency cannot
break this — do not undo that.

### 2. The database is optional

Every feature must degrade gracefully when `ctx.dbEnabled === false`. Learning from history is a *bonus*
when Postgres is on, never a dependency. Most users will not run Docker.

### 3. No app-specific logic in engine code

App knowledge belongs in the knowledge pack, `.agenticqa.json`, or settings — never in `src/core` or
`src/agents`. Generic, app-neutral fallbacks are fine. `test/noAppLiterals.test.js` enforces this and will
fail if the allowlist grows.

### 4. Step-key parity

The generated spec's `STEP_ID=plan-step-N` marker and the `element_signature` baseline `step_key` for the
same step **must** be identical, or self-heal silently heals nothing. Both producers route through
`core/utils/stepKeys.ts`. Never re-derive that format anywhere else.

### 5. `verified` is never accepted from a model

A golden flow is marked `verified` only by actually running it. The same rule applies to `curated`. A
marker any producer can set means nothing.

### 6. Credentials are never invented

They reach a knowledge pack only from a real source literal or by hand. An incomplete pair is dropped
rather than half-filled.

### 7. The held-out app stays held out

**Never tune `apps/taskflow-web`, its knowledge pack, or its prompts to raise a score.** It is the only
unbiased measurement this project has, and tuning it would destroy the one number that means anything.
See [`apps/taskflow-web/README.md`](apps/taskflow-web/README.md).

### 8. Quote the substantive rate, not the raw one

A Playwright PASS says nothing about whether the test exercised the request. Every claim about accuracy
must use the audited number.

---

## Golden fixtures

Two tests lock behaviour that is otherwise impossible to check offline:

| Fixture | Locks | Regenerate with |
|---|---|---|
| `test/fixtures/scenarioPlans.demo-web.json` | every deterministic **plan** | `node scripts/snapshotScenarioPlans.js --out=…` |
| `test/fixtures/codegen.demo-web.json` | every generated **spec** | `node scripts/snapshotCodegen.js --out=…` |

**A failure here is not automatically a bug — but it must be a decision, not a surprise.** Inspect the
diff, confirm every change is intended, regenerate, and say in the commit message which prompts changed
and why.

> ⚠️ Running **Generate Knowledge Pack** against `apps/demo-web` will overwrite its hand-curated pack and
> break five test suites at once, in files that never mention a pack. The pack is marked
> `"curated": true` and the engine now refuses without explicit confirmation — but demonstrate pack
> generation against `apps/taskflow-web` instead. Its pack is **generated, not hand-written** (it is
> deliberately not marked `curated`), so regenerating it is the intended demonstration rather than a
> destructive act. Do not hand-edit it afterwards — see invariant 7.

---

## Adding things

**A new plan action?** Add it to `TestPlannerAgent/schema.ts` *and* `planToPlaywright.ts`. The exhaustiveness
guard makes the omission a compile error, which is the point.

**A new agent prompt?** Drop `src/agents/<Agent>/prompts/system.md` and load it with
`loadSystemPrompt("<Agent>")`. `copyPrompts.js` picks it up automatically. Add a behaviour-lock test
asserting its exact text — that is what makes prompts safe to edit as data.

**A new agent?** Follow `src/agents/<Name>/`: `<Name>.ts` (logic), `index.ts` (barrel), optional
`prompts/`, `schema.ts`, `tools/`. Wire it in `orchestrator/runPipeline.ts`, which is the spine — read it
first.

---

## Pull requests

- One concern per PR.
- Both offline suites green, and say so.
- If you changed a golden fixture, explain what moved and why.
- If you changed behaviour, update the docs in the same PR. A claim in the docs that the code does not
  support is a defect, not a wording nit.

## Code of conduct

Be decent. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
