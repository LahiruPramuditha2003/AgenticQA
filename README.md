<div align="center">

<img src="packages/agenticqa/media/icon.png" width="96" alt="AgenticQA">

# AgenticQA

**Describe a test in plain English. Get a real Playwright test.**

AgenticQA plans the test, writes the spec, runs it, and **repairs broken locators** when your UI changes.
It ships as a VS Code extension driving a Node engine of cooperating LLM agents.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.90%2B-007ACC.svg)](https://code.visualstudio.com/)
[![Playwright](https://img.shields.io/badge/Playwright-powered-2EAD33.svg)](https://playwright.dev/)

</div>

---

## What it does

| | |
|---|---|
| 🧠 **Plain-English → Playwright** | *"Log in as a customer and add the Sony headphones to the cart"* becomes a real `.spec.ts` with real assertions. |
| 🔧 **Self-healing locators** | When a rename breaks a selector, AgenticQA re-grounds it against the page **in the state where it failed**, patches the spec, and re-runs. |
| 🕸️ **Learns your app** | It crawls your routes, synthesizes candidate flows, **validates them by running them**, and keeps only the ones that pass. |
| 🧭 **Explore mode** | No prompt needed — it discovers and ranks tests on its own. |
| 📚 **Domain Q&A** | Answers questions over documentation with citations, so it can say *"the docs don't cover that"* instead of inventing an answer. |
| 📈 **Learns from history** | Locator repairs that worked before are tried ahead of fresh guesses; repairs that failed are demoted. |
| 📊 **Real reports** | A printable HTML report: pass-rate ring, step timeline with durations, inline failure screenshots, and what was healed. |

---

# Getting started

There are two ways in. **Path A** is for using AgenticQA on your own project. **Path B** is for working on
AgenticQA itself, or for reproducing the benchmarks.

## Before you start — prerequisites

| | Needed for | Notes |
|---|---|---|
| **VS Code 1.90+** | everything | |
| **Node.js 20+** | everything | `node --version` |
| **Playwright in your project** | running tests | AgenticQA generates tests into *your* project and runs them with *your* Playwright config. |
| **An API key** | AI features | OpenRouter or NVIDIA NIM. **Both have free tiers.** Without one, AgenticQA still generates tests from a knowledge pack, but cannot plan new scenarios. |
| **Docker + Postgres** | *optional* | Run history, locator baselines, and the vector self-heal path. Everything else works without it. |

---

## Path A — Use AgenticQA on your project

### Step 1 · Get the extension

Download `agenticqa-1.0.0.vsix` from the [Releases page](../../releases), then:

```bash
code --install-extension agenticqa-1.0.0.vsix
```

<sub>Or in VS Code: **Extensions** panel → **⋯** menu → **Install from VSIX…**</sub>

### Step 2 · Prepare your project

AgenticQA writes tests into your project and runs them there, so your project needs Playwright:

```bash
npm install --save-dev @playwright/test
npx playwright install chromium
```

> ⚠️ **Do not skip `npx playwright install`.** Installing the package does *not* download browsers, and
> this is the most common first-run failure. **AgenticQA: Doctor / Setup Check** verifies it for you.

### Step 3 · Add your API key

`Ctrl+Shift+P` → **AgenticQA: Set API Key** → paste it.

Get a free key from [OpenRouter](https://openrouter.ai/keys) (`sk-or-v1-…`) or
[NVIDIA NIM](https://build.nvidia.com/) (`nvapi-…`). If you use NVIDIA, also set
**AgenticQA: Settings** → *Base URL* → `https://integrate.api.nvidia.com/v1`.

Your key is stored in VS Code **SecretStorage** (your OS keychain), never in `settings.json`, and is sent
only to the provider you chose. See [SECURITY.md](SECURITY.md).

### Step 4 · Point it at your app

Create `.agenticqa.json` in your project root — or just run a command and AgenticQA will offer to create
one for you:

```jsonc
{
  "baseUrl": "http://localhost:5173",   // where your app runs
  "testDir": "tests/generated",          // where generated specs go
  "webServer": {                         // optional: AgenticQA starts it if it isn't running
    "command": "npm run dev",
    "reuseExistingServer": true
  }
}
```

### Step 5 · Check your setup

`Ctrl+Shift+P` → **AgenticQA: Doctor / Setup Check**

Read the Output panel. Every ❌ on a non-optional row is something to fix before continuing; the report
tells you what and how.

### Step 6 · Teach it your app *(recommended)*

`Ctrl+Shift+P` → **AgenticQA: Generate Knowledge Pack**

AgenticQA crawls your app, proposes candidate flows, **runs each one**, and keeps only the passing ones in
`.agenticqa/knowledge.json`. This is what lets it plan real tests instead of generic ones — and it is the
single biggest quality difference you can make.

<sub>Commit that file. It is your app's institutional memory.</sub>

### Step 7 · Write your first test

Click the **AgenticQA** icon in the activity bar → **New Request** → describe what you want:

> *Log in as a customer, search for headphones, open the first result and verify the price is shown*

AgenticQA plans it, generates a spec into your `testDir`, runs it, and shows the result in the sidebar.
Click **Open Report** for the full breakdown.

### Step 8 · Watch it heal

Rename a button in your app, then run **AgenticQA: Run Existing Tests**. AgenticQA re-grounds the broken
locator against the page *in the state where it failed*, patches the spec, and re-runs it.

---

## Path B — Run from source

For contributors, and for reproducing the benchmarks.

```bash
git clone <this-repo>
cd AgenticQA
npm install                                    # installs all workspaces

cp packages/orchestrator/.env.example packages/orchestrator/.env
# edit .env and add your OPENAI_API_KEY

cd packages/orchestrator && npm run build      # build the engine FIRST
cd ../agenticqa && npm run compile             # then the extension
```

Then press **F5** in VS Code (**Run Extension**) — it opens an Extension Development Host with
`apps/demo-web` loaded and AgenticQA active.

**Optional — the database** (adds run history, locator baselines, vector self-heal):

```bash
docker compose up -d
```

**Build your own `.vsix`:**

```bash
cd packages/agenticqa && npm run vsix
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the build order, test suites, and the invariants that must not
be broken.

---

## Commands

| Command | What it does |
|---|---|
| **New Request** | Plain-English → generate → run → report. |
| **Run Existing Tests** | Re-run generated specs and self-heal failures. |
| **Explore App** | Discover tests with no prompt. |
| **Generate Knowledge Pack** | Crawl the app and build its flow library. |
| **New Test (All Browsers)** | Run the full Playwright matrix instead of chromium only. |
| **Doctor / Setup Check** | What is configured, what is missing, which engine is running. |
| **Settings** | API key, per-agent models, embeddings, agent prompts. |
| **Reset Database** | Drop all AgenticQA tables. Destructive; asks first. |

---

## How it works

```
┌──────────────────────┐   newline-delimited JSON over stdio   ┌────────────────────────┐
│  VS Code extension   │ ◄───────────────────────────────────► │      Node engine       │
│  packages/agenticqa  │                                        │ packages/orchestrator  │
└──────────────────────┘                                        └────────────────────────┘
                                                                            │
   Receptionist ─► classifies intent ──┬── Casual ─────────────────► reply  │
                                       ├── Domain Q&A ─► RAG ──────► answer │
                                       └── Test generation:                 │
                                             Inspect page (Playwright MCP)  │
                                           → Plan  (knowledge pack first,   │
                                                    LLM only when needed)   │
                                           → Ground locators on the live page
                                           → Generate .spec.ts
                                           → Run  (Playwright)
                                           → Heal broken locators
                                           → Report
```

The key design choice: **planning is deterministic first.** A request that matches a verified flow in your
knowledge pack is planned with **no LLM call at all**, which makes it stable regardless of which model you
configure. The LLM handles what retrieval genuinely cannot.

Full detail in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## How well does it work?

A Playwright **PASS does not mean the test tested anything** — a plan that lost its assertions still
passes. So every benchmark run is also **audited for what the generated spec actually exercises**, and
that is the number we quote:

| App | Raw pass | **Substantive** |
|---|---|---|
| Tuned demo app, 5 browsers | 19/20 | **18/20 (90%)** |
| **Held-out app** — never tuned, auto-generated pack | 20/20 | **19/20 (95%)** |

The held-out app scores *above* the app the engine was built on. That inversion is the strongest evidence
that AgenticQA generalizes rather than memorizes — the engine was never tuned against it, its knowledge
pack was generated automatically, and it still wins.

Reproduce it yourself: [docs/BENCHMARKS.md](docs/BENCHMARKS.md).

### Known limits

- **Pages are inspected in their initial state.** A form that only appears after opening a dialog may not
  be discovered. A plan-walk handles many cases, not all.
- **Generated tests are a starting point.** Review them like any generated code.
- **Free models are rate-limited**, and providers retire free model IDs without notice.
  `npm run probe:models` tells you which of yours are alive.
- Primarily exercised on **Windows + Chromium**. Other combinations should work; fewer eyes have been on
  them.

---

## Documentation

| Doc | For |
|---|---|
| [docs/USER-GUIDE.md](docs/USER-GUIDE.md) | Day-to-day use, every command, every workflow. |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | `.agenticqa.json`, settings, models, providers, database. |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the engine works, agent by agent. |
| [docs/BENCHMARKS.md](docs/BENCHMARKS.md) | How accuracy is measured, and how to reproduce it. |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | When something goes wrong. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Build, test, and the rules that keep it working. |
| [SECURITY.md](SECURITY.md) | Key handling, what runs on your machine, reporting issues. |

## Repository layout

```
packages/orchestrator   The engine — the agent pipeline. Node + TypeScript.
packages/agenticqa      The VS Code extension. Bundles the engine at build time.
apps/demo-web           E-commerce demo app, used for development and benchmarking.
apps/taskflow-web       Task tracker. The HELD-OUT app — never tuned, so the
                        benchmark on it means something.
benchmarks/             The prompt sets both apps are measured against.
docs/                   Everything above.
```

## License

[MIT](LICENSE).

---

<div align="center">
<sub>

**About this repository**

AgenticQA was built as a private project for a company. This repository is the **public release of that
work** — a single squashed commit representing the finished product, rather than the internal development
history. The code, tests, benchmarks and documentation here are complete and self-contained; what is
absent is the private commit history and the internal planning material, which are not ours to publish.

</sub>
</div>
