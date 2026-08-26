# AgenticQA

**Describe a test in plain English. Get a real Playwright test.**

AgenticQA plans the test, writes the spec, runs it, and **repairs broken locators** when your UI changes.
It can also crawl your app to learn it, discover tests without being asked, and answer questions about
your documentation.

---

## What it does

| | |
|---|---|
| 🧠 **Plain-English → Playwright** | *"Log in as a customer and add the Sony headphones to the cart"* becomes a real `.spec.ts` with real assertions. |
| 🔧 **Self-healing locators** | When a rename breaks a selector, AgenticQA re-grounds it against the page **in the state where it failed**, patches the spec, and re-runs. |
| 🕸️ **Learns your app** | Point it at your app and it crawls the routes, synthesizes candidate flows, **validates them by running them**, and keeps only the ones that pass. |
| 🧭 **Explore mode** | No prompt needed — it discovers and ranks tests on its own. |
| 📚 **Domain Q&A** | Answers questions over documentation with citations, so it can say *"the docs don't cover that"* instead of inventing an answer. |
| 📊 **Real reports** | A branded, printable HTML report: pass-rate ring, step timeline with durations, inline failure screenshots, and what was healed. |

---

## Getting started

**1. Install** the extension.

**2. Add an API key** — AgenticQA uses your own, and both supported providers have a free tier:

- [OpenRouter](https://openrouter.ai/keys) (`sk-or-v1-…`)
- [NVIDIA NIM](https://build.nvidia.com/) (`nvapi-…`)

Run **AgenticQA: Set API Key**. The key is stored in VS Code SecretStorage (your OS keychain) and is sent
only to the provider you configured. See [SECURITY.md](https://github.com/LahiruPramuditha2003/AgenticQA/blob/main/SECURITY.md).

**3. Tell it where your app is.** Create `.agenticqa.json` in your project — or just run a command and
AgenticQA will offer to create one:

```jsonc
{
  "baseUrl": "http://localhost:5173",
  "testDir": "tests/generated"
}
```

**4. Run `AgenticQA: New Request`** and describe a test.

Run **AgenticQA: Doctor / Setup Check** at any point — it reports exactly what is configured and what is
missing.

### Requirements

- **Playwright in your project** (`npm i -D @playwright/test && npx playwright install`) — AgenticQA
  generates and runs tests there, using your own config and browsers.
- **An API key** for the AI features.
- **Optional: Docker + Postgres** for run history, locator baselines and the vector self-heal path.
  Everything else works without it.

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

---

## Configurable to a fault

**A different model per agent.** Planning is hard and self-heal reranking is trivial, so they need not
share a model. Eight roles — planner, domainqa, selfheal, reporter, receptionist, casual, explorer,
packgen — each with its own setting, all defaulting to free models.

**Editable agent prompts.** Settings → *Agent prompts* → Edit. The prompt opens as a normal markdown file,
comments and all. Reset restores the original.

**Two providers, no code change.** OpenRouter and NVIDIA NIM are both OpenAI-compatible; set the base URL
and the key and the per-role defaults follow.

---

## How well does it work?

Honestly reported, because a Playwright PASS does not mean the test tested anything — a plan that lost its
assertions still passes. Every benchmark run is therefore **audited for what the spec actually exercises**,
and that is the number quoted:

| App | Raw pass | **Substantive** |
|---|---|---|
| Tuned demo app, 5 browsers | 19/20 | **18/20 (90%)** |
| **Held-out app** — never tuned, auto-generated pack | 20/20 | **19/20 (95%)** |

The held-out app scoring *above* the app the engine was built on is the strongest evidence that AgenticQA
generalizes rather than memorizes.

### Known limits

- **Pages are inspected in their initial state.** A form that only exists after opening a dialog may not be
  discovered. There is a plan-walk that handles many cases, but not all.
- **Generated tests are a starting point.** Review them like any generated code.
- **Free models are rate-limited**, and free model IDs get retired by providers. Doctor will tell you.
- Primarily exercised on **Windows + Chromium**. Other combinations should work; fewer eyes have been on
  them.

---

## Privacy

Your API key goes only to the provider you configure. Page structure (accessibility snapshots: element
roles and visible names) and your request text are sent to that provider for planning and Q&A — so if the
page shows sensitive data, that data can appear in a snapshot. AgenticQA runs no server of its own and
collects no telemetry. Full detail in [SECURITY.md](https://github.com/LahiruPramuditha2003/AgenticQA/blob/main/SECURITY.md).

## License

MIT.
