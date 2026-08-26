# Changelog

All notable changes to the AgenticQA extension. Format follows [Keep a Changelog](https://keepachangelog.com/);
versions follow [semver](https://semver.org/).

## [1.0.0] — 2026-08-22

First public release.

### The headline

AgenticQA turns a plain-English request into a Playwright test, runs it, and repairs broken locators when
the UI changes. This release is the first one a stranger can actually install and use.

**Measured accuracy** — quoted as the *substantive* rate, because a Playwright PASS does not prove a test
tested anything (a plan that lost its assertions still passes), so every benchmark run is audited for what
the generated spec actually exercises:

| App | Raw | **Substantive** |
|---|---|---|
| Tuned demo app, 5 browsers | 19/20 | **18/20 (90%)** |
| **Held-out** app — never tuned, auto-generated knowledge pack | 20/20 | **19/20 (95%)** |

The held-out app scoring above the app the engine was built on is the evidence that this generalizes.

### Added

- **The engine ships inside the extension.** Previously it was resolved from a sibling directory that only
  existed in the development monorepo, so a packaged install could not run at all. It is now bundled, and
  the build refuses to complete unless the packaged engine starts, answers a handshake, resolves its
  dependencies from the installed layout, and has its prompts present.
- **Editable agent prompts.** Settings → *Agent prompts* → Edit opens the real prompt as markdown; Reset
  restores the original. A per-workspace override (`.agenticqa/prompts/<Agent>.md`) can be committed
  alongside the app under test. A broken override degrades to the built-in prompt rather than failing a run.
- **First-run onboarding.** A fresh install with no API key now explains what is needed and links to the
  free tiers, instead of silently degrading into a thinner planner.
- **`agenticqa.enginePath`** for pointing a packaged install at a local engine build. Doctor reports which
  engine is actually in use.
- **Curated knowledge packs are protected.** A pack marked `"curated": true` is not replaced by generation
  without an explicit confirmation naming the flow counts being traded.

### Fixed

- `expectCount` with *at least* / *at most* emitted an **exact** count assertion, so "at least 3 results"
  failed whenever there were 4.
- `check` / `uncheck` could bind to the wrong checkbox — and still pass. A named target no longer falls
  back to "any checkbox on the page".
- Assertions using *starts with* / *ends with* produced a **syntax error** when the text contained a quote,
  which failed every test in the file rather than the one step.
- Generated flows baked crawl-time counts into assertions (`"Shopping Cart (23 items)"`), so a flow broke
  as soon as the count changed — which is exactly what an add-to-cart test causes.
- Page titles were taken from the first heading in document order rather than the highest-ranked one, so a
  page with a sidebar could be titled after the sidebar.
- The embeddings cache was written into the extension's install directory, which VS Code wipes on update
  and may mount read-only. It now lives in per-user storage.
- Self-heal's LLM reranking never ran: its token budget was sized for the answer rather than for a
  reasoning model, so the reply came back empty every time.
- Domain Q&A could discard a complete, well-sourced answer because one field arrived in an unexpected shape.
- An unhandled plan action would have emitted an empty, always-passing test step. It is now a compile error.

### Security

- **No API key ships with the extension, and none ever will.** A `.vsix` is a ZIP, so a bundled key is a
  public key; and a single shared key would exhaust its provider's free-tier rate limit daily. Bring your
  own — it is stored in VS Code SecretStorage (your OS keychain) and sent only to the provider you set.
- Packaging now blocks secret-shaped files four independent ways. This was not theoretical: a trial package
  reached outside the extension directory through a workspace symlink and pulled in a real `.env`.

### Changed

- **Minimum VS Code is 1.90** (was 1.109), verified by typechecking against exactly those API definitions
  rather than assumed.
- A prompted run executes on **chromium only**. Use **New Test (All Browsers)** for the full matrix —
  cross-browser coverage is a release-time decision, not the cost of every keystroke.
