# Changelog

All notable changes to AgenticQA. The extension keeps its own, more detailed changelog at
[`packages/agenticqa/CHANGELOG.md`](packages/agenticqa/CHANGELOG.md).

## [1.0.0] — 2026-08-22

First public release.

AgenticQA turns a plain-English request into a Playwright test, runs it, and repairs broken locators when
the UI changes. It ships as a VS Code extension with the engine bundled inside it.

**Measured accuracy** — reported as the *substantive* rate, because a Playwright PASS does not prove a
test tested anything:

| App | Raw | **Substantive** |
|---|---|---|
| Tuned demo app, 5 browsers | 19/20 | **18/20 (90%)** |
| **Held-out** app — never tuned, auto-generated pack | 20/20 | **19/20 (95%)** |

See [docs/BENCHMARKS.md](docs/BENCHMARKS.md) for what those numbers mean and how to reproduce them.

### Highlights

- **Deterministic-first planning** — a request matching a verified flow is planned with no LLM call, so
  results do not drift with the model.
- **Self-healing locators**, re-grounded against the page in the state where the failure happened.
- **Knowledge packs built by crawling and *running* your app** — a flow reaches the pack only if it passed.
- **Learning from run history** (optional Postgres): proven repairs are tried first, failed ones demoted.
- **Editable agent prompts**, per user or committed per workspace.
- **Bring-your-own-key**, stored in the OS keychain. No key ships with the extension.

Full detail in the [extension changelog](packages/agenticqa/CHANGELOG.md).
