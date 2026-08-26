# Architecture

How AgenticQA turns a sentence into a passing test, and why it is built this way.

---

## Two processes, one pipe

```
┌────────────────────────┐                                  ┌──────────────────────────┐
│   VS Code extension    │   newline-delimited JSON, stdio   │       Node engine        │
│  packages/agenticqa    │ ◄──────────────────────────────►  │  packages/orchestrator   │
│                        │                                   │                          │
│  • commands & views    │   ──►  NEW_REQUEST / PING          │  • the agent pipeline    │
│  • report rendering    │   ◄──  LOG / RUN_SUMMARY / DONE    │  • Playwright + LLMs     │
│  • settings, secrets   │                                   │  • Postgres (optional)   │
└────────────────────────┘                                   └──────────────────────────┘
```

The extension spawns the engine as a child process and writes **one** `NEW_REQUEST` line to its stdin. The
engine streams `LOG` / `ERROR` / `RUN_SUMMARY` / `DOMAIN_QA_ANSWER` lines back on stdout, ends with `DONE`,
and exits.

Not HTTP: there is no port to conflict with, no server to leave running, and the process lifetime is
exactly the request. It also means **stdout is the protocol** — a stray `console.log` from any dependency
would corrupt the stream, so `console.log` is redirected to stderr at startup.

Since v1.0 the engine is **bundled inside the extension** (`dist/orchestrator.js`), which is what makes a
marketplace install work at all.

---

## The pipeline

`src/orchestrator/runPipeline.ts` is the spine. Read it first.

A **Receptionist** classifies the request into one of three intents:

- **CASUAL** → a conversational reply. Done.
- **DOMAIN_QA** → retrieval-augmented answer with citations. Done.
- **TEST_GEN** → the full pipeline:

```
 1  Pre-inspect      Which pages will this test touch? Browse them, build a page inventory.
 2  Plan             Knowledge pack first (no LLM). LLM only when retrieval abstains.
 3  Ground           Resolve every locator against the live page.
 4  Generate         Emit the .spec.ts.
 5  Execute          Run Playwright, capture step results and screenshots.
 6  Heal             On a locator failure: re-ground at the failure state, patch, re-run.
 7  Report           Emit RUN_SUMMARY; the extension renders it.
```

Everything threads through one mutable **`RunContext`**. Agents read what earlier agents wrote and add
their own. There is no return-value contract between agents — **the context *is* the contract**.

---

## Deterministic-first planning

This is the design decision everything else follows from.

A naive agent asks an LLM to write the test. That is non-deterministic by construction: the same request
produces different plans on different days, and quality tracks whichever model you configured.

AgenticQA plans from **verified golden flows** in the app's knowledge pack instead:

```
request ──► FlowIndex retrieval ──► matched? ──► bind parameters ──► plan     (NO LLM CALL)
                                       │
                                       └── abstains ──► RAG + LLM ──► plan
```

Retrieval is **BM25F** over each flow's key, tags, description and step content, with the key weighted
highest. It **abstains** — deferring to the LLM — on two structural conditions: nothing overlaps the
request, or the request spans multiple states no single flow can express.

> Abstention is deliberately **not** a confidence threshold. That was tried and measured: the one benchmark
> prompt that *should* abstain scored the highest confidence of any prompt in the set.

The consequence: most requests are planned identically every time, regardless of model. The LLM handles
genuinely novel requests, which is what it is good at.

---

## The App Knowledge Pack

`.agenticqa/knowledge.json` in your project. This is the seam that keeps app-specific knowledge **out of
engine code** — a rule enforced by a test that fails if app literals appear in generic modules.

```jsonc
{
  "curated": true,                    // hand-written: refuse to overwrite without confirmation
  "credentials": { … },               // only ever from real source literals — never invented
  "routes": { "login": "/auth/login" },
  "goldenFlows": {
    "customer-login": {
      "description": "Log in as a customer",
      "tags": ["sign in", "authenticate"],   // how a USER would say it
      "verified": true,                       // set only by actually running it
      "steps": [ … ]
    }
  },
  "assertionAliases": [ … ],          // "assert X instead" for ambiguous post-action states
  "plannerGuidance": "…"              // free-form app-specific prompt text
}
```

**With no pack, planning is purely page-grounded** — the planner invents no routes, no credentials, no
literals. That is the difference between an engine and a demo.

### How a pack is built

**AgenticQA: Generate Knowledge Pack** chains:

```
detect ──► extract ──► crawl ──► synthesize ──► VALIDATE ──► write
           (source     (live     (LLM +         (run each
            only)       app)      floor)         flow)
```

**Validation is the point.** Candidate flows are executed, and only passers reach the pack. A flow that
doesn't work never gets written. Two rules make that meaningful:

- **`verified` is never accepted from a model** — only running a flow sets it.
- **Credentials come only from extraction**, never from the LLM.

Apps with no source in the workspace work too: the crawl alone is enough. It goes one level deeper to
compensate and omits credentials entirely, since those exist only in source.

---

## Grounding: the live page decides

A plan says *click "Add to Cart"*. Grounding turns that into a locator that exists.

The page inventory comes from **Playwright MCP** accessibility snapshots — roles and accessible names, the
same tree a screen reader sees. Not CSS selectors, which break on any restyle.

Two details that took real debugging to get right:

**Refs are namespaced per page.** An MCP element ref (`e2`, `e17`, …) is a *per-snapshot* counter, so every
page restarts at `e1`. Pooling elements across pages by raw ref silently discarded most of them — one app
pooled 108 of 139 elements and reported "1 input" across three pages including a two-field login form.
Which elements vanished depended only on visit order.

**Exact matches beat substring matches across all roles.** Preferring a substring hit in an early role over
an exact hit in a later one made `"Login"` resolve to a heading `"Please Login"` on a page already left,
instead of the exact `link "Login"` in the navbar.

Grounding is **non-destructive**: it will not invent a locator for something absent, and two rules protect
the result — a value the plan itself types can never be "absent from the page", and *a test that cannot
fail is not a test*, so if grounding removes the last assertion, one is restored against a real element.

---

## Self-healing

When a run fails on a **locator** — not an assertion — healing runs:

1. **Capture the failure state.** The failed spec is copied to a temp file with an injected `afterEach`
   hook and re-run, capturing the page's accessibility snapshot **at the moment of failure**. This matters:
   the page where a step failed is usually not the page the run started on.
2. **Choose a replacement**, by one of two strategies from that same snapshot:
   - **deterministic** (default, no database): role-aware fuzzy match of the step's intended name;
   - **vector + LLM rerank** (Postgres + embeddings + a baseline): nearest stored observation, optionally
     re-ranked by an LLM, falling back to the deterministic path.
3. **Patch and re-run.**

Three safeguards, each from a real failure:

- **Plausibility.** A candidate must share a strict **majority** of the intended name's significant words.
  Without it, `Add to Cart` and `Proceed to Checkout` were both rewritten to the same
  `link "Shopping Cart"`, and the healed spec failed worse than the original.
- **Only healable actions.** Healing once rewrote `page.goto(...)` into a `getByRole(...)` call; the spec
  stopped parsing and the verification run reported zero steps. **Corrupting a spec is strictly worse than
  declining to heal it.**
- **Assertion targets are flagged, not hidden.** Re-pointing what you were checking could mask the exact
  regression the test exists to catch.

**Healing works without a database.** The vector path is a bonus.

---

## Learning from history

With Postgres on, AgenticQA reads back what past runs learned:

- **Locator reliability** — which repairs actually produced passing re-runs.
- **Heal feedback** — proven repairs are tried ahead of the nearest embedding; known-bad ones are demoted.
- **Flow priors** — flows that historically produce good tests rank slightly higher.
- **Flakiness** — flagged only when recent runs of the same spec *disagree*.

Two governing rules:

**No history means no opinion, never "zero".** An unproven locator must not lose to one lucky pass.

**Scores use a Wilson lower bound**, not a raw pass rate, for the same reason: 1/1 scores ≈ 0.21 while
47/50 scores ≈ 0.84.

The loop is entirely DB-gated and does nothing until history accumulates, so a first run against a fresh
database behaves exactly as it always did — a property locked by a test.

---

## The agents

Eleven, each in `src/agents/<Name>/`. Eight make LLM calls, and each of those can run a **different model**.

| Agent | Role | LLM? |
|---|---|---|
| Receptionist | Classify intent | fallback only |
| Casual | Conversational replies | yes |
| Domain QA | RAG answers with citations | yes |
| Test Planner | Request → test plan | only when retrieval abstains |
| UI Inspector | Resolve locators on the live page | no |
| Test Script Generator | Plan → `.spec.ts` | no |
| Executor | Run Playwright | no |
| Self-Heal | Repair broken locators | rerank only |
| Reporter | Build the run summary | failure analysis only |
| Exploratory | Discover tests unprompted | ranking only |
| Knowledge Pack | Crawl and synthesize a pack | yes |

Three load their system prompt from a markdown file at runtime, resolved workspace → user → shipped. Each
prompt's exact text is locked by a test, which is what makes prompts safe to edit as data: you can change
one deliberately, but not by accident.

---

## Data layer

`src/core/db/db.ts` owns the schema and every query. No ORM.

| Table | Holds |
|---|---|
| `project`, `test_case`, `test_step`, `test_run` | runs and their plans |
| `element_signature`, `element_observation` | locator baselines for vector self-heal |
| `doc_chunk`, `qa_cache` | Domain Q&A retrieval |
| `locator_stat`, `flow_stat`, `heal_feedback`, `spec_outcome` | the learning loop |

**Migrations are append-only, versioned and transactional.** Nothing drops a table implicitly — an earlier
version dropped five tables on *every startup*, so run history and locator baselines never survived a run,
which silently made the learning loop impossible. The only destructive path is now the explicit
**Reset Database** command.

A dimension mismatch between the configured embedding model and the stored vectors **degrades** — the
vector path switches off with an explanation, and run history and deterministic self-heal keep working.

---

## Design principles

**Deterministic where possible, LLM where necessary.** Every LLM call is a place results can vary between
runs. Retrieval, grounding and codegen are deterministic; only genuinely novel planning is not.

**Validate by running, not by asking.** A flow is in the pack because it passed, not because a model said
it would work.

**Degrade, never crash.** No database, no API key, no knowledge pack, a broken prompt override — each
removes capability and says so, rather than failing the run.

**Make silent failures loud.** Most defects in this project's history were invisible: a dead model hidden
by a fallback chain, a pooling bug that dropped elements by visit order, a token budget that made an LLM
return nothing. The recurring fix is not cleverness — it is a check that fails, loudly, at the moment the
assumption breaks.

---

## Further reading

- [CONFIGURATION.md](CONFIGURATION.md) — every knob
- [BENCHMARKS.md](BENCHMARKS.md) — how quality is measured
- [../CONTRIBUTING.md](../CONTRIBUTING.md) — build, test, invariants
