# User Guide

Day-to-day use of AgenticQA. If you have not installed it yet, start with the
[README](../README.md#getting-started).

---

## The mental model

AgenticQA is not a code generator that guesses. It works from three things, in this order:

1. **Your app's knowledge pack** — verified flows it learned by crawling and *running* your app.
2. **The live page** — every locator is grounded against the real DOM before it is written.
3. **An LLM** — only for what the first two cannot answer.

That order is why results are stable: a request matching a known flow is planned with **no LLM call at
all**, so it does not change because a model did.

**The single highest-value thing you can do is generate a knowledge pack.** Everything else improves once
AgenticQA knows your app.

---

## Generating a knowledge pack

`Ctrl+Shift+P` → **AgenticQA: Generate Knowledge Pack**

What happens:

1. **Detect** — is your app's source in this workspace, or is it a hosted URL?
2. **Extract** *(source only)* — routes from your router, credentials from real source literals.
   Credentials are **never invented**; if it can't find them, you get no credentials.
3. **Crawl** — a bounded, same-origin walk of your app, collecting routes, headings, inputs and buttons.
4. **Synthesize** — candidate flows: smoke, form, filter, navigation.
5. **Validate** — it **runs each candidate** and keeps only the ones that pass.
6. **Write** — `.agenticqa/knowledge.json`.

The validation step is what makes the pack trustworthy. A flow that doesn't work never reaches it.

**Commit the pack.** It is your app's institutional memory, it makes every later run better, and it is
reviewable in a diff.

> **Hosted apps with no source** work too — the crawl alone is enough. It crawls one level deeper to
> compensate, and omits credentials entirely, so auth flows are not included.

> **Regenerating replaces**, it does not merge. Every existing flow is discarded. A timestamped backup is
> written beside the pack, and a pack marked `"curated": true` will not be replaced without an explicit
> confirmation.

---

## Writing a request

Click the **AgenticQA** icon → **New Request**, and describe the test.

**What works well:**

> Log in as a customer, search for headphones, open the first result, and verify the price is shown

> Add two items to the cart and check the total updates

> Try to log in with the wrong password and verify the error message

**What works less well:**

- **Multiple unrelated scenarios in one request.** Ask for one thing; run it again for the next.
- **Steps that need state you haven't described.** "Verify the order history" needs a login first — say so.
- **Anything behind a dialog that has to be opened first.** See [Known limits](#known-limits).

**Be specific about what to verify.** "Test the checkout page" produces a weaker test than "go to checkout
and verify the order summary shows the shipping cost".

---

## Reading the result

The sidebar shows each run as `pass/total · duration · ⚠ failure class · time ago`, with steps beneath it
named in plain language (`✅ click "Add to Cart"`), not `plan-step-3`.

**Open Report** gives the full picture: pass-rate ring, per-step timeline with durations, inline
screenshots of failures, the test plan, what was healed, and the environment the run used.

**Export Report (PDF)** renders that same report to a file for sharing.

### Failure classes

| Class | Means | Usually |
|---|---|---|
| `locator-not-found` | An element wasn't there | The UI changed → self-heal will try |
| `strict-mode` | The locator matched several elements | Ambiguous name; self-heal will try |
| `assertion` | The page loaded but the check failed | **A real bug, or a wrong expectation** |
| `timeout` | Something never settled | Slow app, or a step waiting on the wrong thing |
| `no-report` | Playwright produced nothing | Config or install problem — run Doctor |

---

## Self-healing

When a run fails on a **locator**, AgenticQA:

1. Re-runs the failed spec with a capture hook, grabbing the page's accessibility snapshot **at the moment
   of failure** — not at the start, which is a different page.
2. Finds the best replacement for the element the step *intended*.
3. Patches that step's locator and re-runs.

Two safeguards worth knowing:

- **It declines rather than guessing wildly.** A candidate must share a strict majority of the intended
  name's significant words. "Add to Cart" will not be healed to "Shopping Cart".
- **Healing an assertion target is flagged**, not hidden. If the thing you were checking moved, you are
  told — otherwise self-heal could mask a real regression.

**With Postgres running**, AgenticQA also learns: repairs that worked before are tried ahead of fresh
guesses, and repairs that failed are demoted. The Output panel says which — `history AGREES`,
`history REORDERS`, `history DEMOTES`.

---

## Explore mode

**AgenticQA: Explore App** discovers tests with no prompt at all. It crawls, synthesizes candidate flows,
has an LLM judge rank them, then generates and runs the top few.

Useful for a first look at an unfamiliar app, or to find coverage you didn't think to ask for.

> ⚠️ **It submits forms.** Controls matching *delete* / *remove* are excluded, but point it at a
> development environment, never production.

---

## Domain Q&A

Ask a documentation question instead of requesting a test, and AgenticQA answers from retrieved documents
with citations. If the answer isn't in the sources, it says so rather than inventing one.

Works without Postgres — retrieval and ranking happen in memory.

---

## Cross-browser runs

A normal run executes on **chromium only**. That is deliberate: cross-browser coverage is a release-time
decision, not the price of every keystroke.

For the full matrix, use **AgenticQA: New Test (All Browsers)**, or set it per project:

```jsonc
{ "execution": { "projects": "all" } }
```

---

## Customizing the agents

**Settings → Per-agent models.** Eight roles, each with its own model. Planning is hard and self-heal
reranking is trivial — they need not share a model.

**Settings → Agent prompts.** Edit the system prompt of the Domain Q&A, Receptionist or Self-heal agent.
It opens as a normal markdown file, comments included; **Reset** restores the original.

> ⚠️ The published accuracy numbers were measured with the built-in prompts. If results get worse after an
> edit, Reset is the first thing to try.

To share a tuned prompt with your team, commit it to `.agenticqa/prompts/<Agent>.md` in your project — a
workspace override beats a personal one.

---

## Known limits

**Pages are inspected in their initial state.** A form that only exists after opening a dialog may not be
discovered by a crawl. There is a plan-walk that resolves many of these cases by walking the plan in a live
browser, but not all of them.

**Generated tests are a starting point.** Review them as you would any generated code — especially the
assertions, which are where a weak test hides.

**Free models are rate-limited**, and providers retire free model IDs without notice. If quality drops
suddenly, run `npm run probe:models` (from source) or check Doctor.

---

## See also

- [CONFIGURATION.md](CONFIGURATION.md) — every setting, in detail
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — when something goes wrong
- [ARCHITECTURE.md](ARCHITECTURE.md) — how it actually works
