# Security

## Reporting a vulnerability

Please report security issues privately rather than in a public issue:

- Open a [GitHub security advisory](https://github.com/LahiruPramuditha2003/AgenticQA/security/advisories/new), or
- email the maintainer listed on the repository profile.

Include what you did, what happened, and what you expected. We aim to acknowledge within a week.

---

## How AgenticQA handles your API key

**AgenticQA ships no API key of its own.** You supply one, and it stays yours.

| | |
|---|---|
| **Where it is stored** | VS Code [SecretStorage](https://code.visualstudio.com/api/references/vscode-api#SecretStorage), which is backed by the OS credential store — Keychain on macOS, Credential Manager on Windows, libsecret on Linux. |
| **Where it is *not* stored** | Never in `settings.json`. Never in the workspace. Never in the packaged extension. Settings sync does not carry it. |
| **How the engine receives it** | As an environment variable on the engine process at spawn time. It is not written to disk and not passed on a command line (where it would be visible in a process list). |
| **Where it is sent** | Only to the base URL you configured — `https://openrouter.ai/api/v1` by default. AgenticQA has no server of its own and sends your key nowhere else. |
| **Removing it** | **AgenticQA: Clear API Key**, or the Settings panel. |

### Why there is no built-in key

Two reasons, and the second is the decisive one.

1. **A shipped key would be a public key.** A `.vsix` is a ZIP archive. Anything the extension can read at
   runtime, anyone who downloads it can read too — encryption does not change this, because the extension
   would have to ship whatever it uses to decrypt.
2. **It would not work.** Free tiers are rate-limited *per account*, not per user. One key shared across
   every installation would exhaust its allowance daily, and every user after the first few would see
   errors. Asking you for your own key is the option that actually functions.

Free tiers exist at [OpenRouter](https://openrouter.ai/keys) and [NVIDIA NIM](https://build.nvidia.com/).

---

## What AgenticQA does on your machine

Worth knowing before you install, because the extension is not a passive one:

- **It launches browsers.** Page inspection drives a Chromium instance through Playwright MCP, and running
  a test invokes `npx playwright test` in your workspace.
- **It writes files into your workspace** — generated specs under your configured `testDir`, and
  `.agenticqa/knowledge.json` when you ask it to generate a knowledge pack. It writes nothing outside the
  workspace except its own caches, which live in the extension's VS Code global-storage directory.
- **It navigates the app you point it at, and submits forms.** Exploratory mode and pack generation click
  buttons and submit forms on the target application. `isSubmitButton` deliberately excludes controls
  matching *delete* / *remove*, but **point it at a development environment, not production.**
- **It sends page structure to your LLM provider.** Planning and Domain Q&A include accessibility-tree
  snapshots (element roles and visible names) and your request text. If the page you inspect displays
  sensitive data, that data can appear in those snapshots.
- **Optional Postgres.** With `DATABASE_URL` set, run history and locator baselines are stored locally.
  Everything works without it.

## Supported versions

Security fixes are applied to the latest released version. Please upgrade before reporting an issue against
an older one.
