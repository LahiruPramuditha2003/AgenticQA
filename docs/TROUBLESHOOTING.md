# Troubleshooting

**Start here: `Ctrl+Shift+P` → AgenticQA: Doctor / Setup Check.** It checks Node, Docker, Postgres, the
engine, your API key, `.agenticqa.json`, Playwright, and Playwright's browsers — and tells you which of
those is actually wrong. Most of this page is only needed when Doctor says everything is fine and
something still isn't.

**Second stop: the Output panel.** View → Output → **AgenticQA**. The engine narrates what it is doing;
the answer is usually in there.

---

## Setup

### "Executable doesn't exist at …chromium_headless_shell-…"

Playwright's package is installed but its **browsers** are not. Installing the package does not download
them, and upgrading Playwright changes which build is required — so this can appear on a project that
worked yesterday.

```bash
npx playwright install chromium
```

Doctor's **Playwright browsers** row catches this.

### Doctor says "Engine — Not found"

If you installed from a `.vsix`, this is a broken installation — reinstall the extension. Building
something will not help; there are no sources to build.

If you are running from source, build the engine first:

```bash
cd packages/orchestrator && npm run build
```

If you have set `agenticqa.enginePath`, check it points at a file that exists — or clear it.

### Doctor says the engine is the "monorepo sibling build" and you didn't expect that

You are running a source checkout, and it found `packages/orchestrator/dist/main.js` next to the
extension. That is correct for development. It is a problem only if you meant to test a packaged install
— in which case open a folder that is not the monorepo.

### "No API key configured"

`Ctrl+Shift+P` → **AgenticQA: Set API Key**. Free tiers: [OpenRouter](https://openrouter.ai/keys),
[NVIDIA NIM](https://build.nvidia.com/).

Using NVIDIA? Also set the base URL to `https://integrate.api.nvidia.com/v1` in **AgenticQA: Settings**.
An `nvapi-` key sent to OpenRouter's endpoint fails with an unhelpful auth error.

### The dev server doesn't start

Check `webServer.command` in `.agenticqa.json` actually starts your app, and that `baseUrl` matches the
port it uses. If your server is already running, set `"reuseExistingServer": true`.

---

## Generation quality

### Every generated test looks the same, and thin

**Your app has no knowledge pack, or it has a poor one.** Without one, AgenticQA can only ground against
whatever page it can reach and produces generic tests.

Run **AgenticQA: Generate Knowledge Pack**, then try again. This is the single biggest quality lever.

If you *have* a pack and this started happening, check whether it was regenerated — a generated pack of 5
smoke flows replacing a hand-written pack of 15 produces exactly this symptom. Backups are written beside
the pack as `knowledge.backup-<timestamp>.json`.

### The test passes but doesn't test anything

Real, and worth taking seriously — it is why this project audits "substantive" rather than "passing". Look
for a spec with no `expect(...)`, or one that never leaves the start page.

Usual causes:

- **The request was vague.** "Test the checkout page" gives the planner nothing to assert. Say what should
  be true.
- **The assertion was grounded away.** If the planner asserts something that isn't on the page it inspects,
  grounding drops it. The Output panel says when this happens.
- **The page needed a state the crawl never saw** — see [Known limits](USER-GUIDE.md#known-limits).

### The test clicks the wrong thing

Usually an ambiguous accessible name — several elements share it. Give the element a `data-testid`, or
make its visible text distinct. AgenticQA prefers a `data-testid` when one exists.

---

## Runs and failures

### Self-heal did nothing

It only fires on **locator** failures (`locator-not-found`, `strict-mode`). An assertion failure is not
healed, because that is usually a real bug and healing it would hide one.

It also **declines** when no candidate is a plausible stand-in — a replacement must share a strict majority
of the intended name's significant words. `SelfHeal: … is not a plausible stand-in` in the Output panel
means it decided not to guess. That is working as designed: a wrong locator is worse than none.

### Self-heal "learns" but I see no evidence

Learning is DB-gated and needs history. With Postgres off, there is nothing to learn from.

With it on, the Output panel reports on every heal: `history AGREES` / `history REORDERS` /
`history DEMOTES` / `no heal history for … yet`. Agreement is the common case once a repair is proven —
and it *is* a result, not a silence.

### Runs are slow

A prompted run is chromium-only by default. If it is running five browsers, something asked for that —
check `execution.projects` in `.agenticqa.json`.

Otherwise the time is usually the LLM. A large model on the `planner` role is worth it; a large model on
`receptionist` or `casual` is not.

### `no-report` failure class

Playwright produced no report at all — the run died before it started. Almost always a Playwright config
or install problem in your project. Try running `npx playwright test` yourself.

---

## Models

### Everything got worse and I changed nothing

**A free model ID probably got retired.** Providers do this without notice, and it does not look like a
failure: the fallback chain quietly serves a different model.

From a source checkout:

```bash
cd packages/orchestrator && npm run probe:models
```

Each role is reported **OK** / **QUOTA** (alive, allowance spent) / **DEAD** (404) / **AUTH**.

### "Model not available for free"

That model is no longer on the free tier. Pick another, or add a key with credit.

### Rate limited

Free tiers are capped per account. Wait, or use a different provider. AgenticQA's deterministic path needs
no LLM at all — with a good knowledge pack, most requests never call one.

---

## Database

### Doctor says PostgreSQL is not available

Optional. `docker compose up -d` to enable it; everything works without it except run history, locator
baselines, learning and vector self-heal.

### Vector dimension mismatch

You changed the embedding model while Postgres held vectors of the old width. AgenticQA disables the
vector path with a warning rather than crashing — run history and deterministic self-heal keep working.

To adopt the new model fully: **AgenticQA: Reset Database** (destructive; it asks first).

---

## Still stuck

Open an issue with:

- what you asked for,
- the **Output panel** contents,
- the **Doctor** report,
- the generated spec, if there is one.

The Output panel is the single most useful thing to include.
