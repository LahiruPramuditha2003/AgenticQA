# Configuration

Everything AgenticQA reads, and where it reads it from.

---

## Where settings come from

Four layers. Later wins.

```
built-in defaults  →  packages/orchestrator/.env  →  .agenticqa.json  →  VS Code settings
     (shipped)          (source checkouts only)        (per project)       (per user)
```

Two consequences worth internalising:

- **Anything you leave blank falls through.** An unconfigured install behaves exactly like a default one.
- **A packaged extension has no `.env`.** That layer exists only when you run from source.

---

## `.agenticqa.json` — per project

Put it in your project root. AgenticQA searches up to three directories deep and treats the file's
directory as the run root.

```jsonc
{
  // ── required ──
  "baseUrl": "http://localhost:5173",   // where your app runs

  // ── where generated specs go (default: tests/generated) ──
  "testDir": "tests/generated",

  // ── your app's knowledge pack ──
  "knowledgePack": ".agenticqa/knowledge.json",

  // ── AgenticQA starts your dev server if it isn't already up ──
  "webServer": {
    "command": "npm run dev",
    "cwd": ".",
    "timeoutMs": 60000,
    "reuseExistingServer": true       // don't restart one that's already running
  },

  // ── which browsers a run uses. Default: chromium only ──
  "execution": {
    "projects": ["chromium"]          // or "all" for your full Playwright matrix
  },

  // ── per-agent model overrides, same names as the settings below ──
  "models": {
    "planner": "nvidia/nemotron-3-super-120b-a12b:free"
  },

  // ── Domain Q&A may fetch from these hosts ──
  "allowlistedDomains": ["context7.com"]
}
```

---

## VS Code settings

All under `agenticqa.*`. The **AgenticQA: Settings** panel is a friendlier editor for the same values.

| Setting | What it does |
|---|---|
| `agenticqa.api.baseUrl` | OpenAI-compatible endpoint. Blank → OpenRouter. |
| `agenticqa.api.globalModel` | Force **one** model on every agent. Blank → per-agent defaults. |
| `agenticqa.models.<role>` | Model for one role (see below). |
| `agenticqa.embedModel` | Embedding model for RAG + vector self-heal. |
| `agenticqa.enforceFreeModels` | Block non-free models when no API key is configured. |
| `agenticqa.enginePath` | Point at a specific engine build. **Leave blank** unless developing AgenticQA. |

**Your API key is not a setting.** It lives in VS Code SecretStorage — set it with **AgenticQA: Set API
Key**. See [SECURITY.md](../SECURITY.md).

---

## Providers

Two are supported, and switching is configuration, not code — both speak the OpenAI wire format.

| | OpenRouter | NVIDIA NIM |
|---|---|---|
| Base URL | `https://openrouter.ai/api/v1` | `https://integrate.api.nvidia.com/v1` |
| Key looks like | `sk-or-v1-…` | `nvapi-…` |
| Free tier | daily request cap | credit pool + rate limit |
| Free model IDs | suffixed `:free` | no suffix — the catalog shares one pool |
| Embedding model | `qwen/qwen3-embedding-8b` | `nvidia/nv-embed-v1` |

AgenticQA detects which provider you're on from the base URL, and the per-role defaults, free-model rule
and embedding default all follow.

---

## The eight agent roles

Each can run a different model. Planning is hard; self-heal reranking is trivial. They need not match.

| Role | Does what |
|---|---|
| `planner` | Turns a request into a test plan. **The one worth a big model.** |
| `domainqa` | Answers documentation questions. |
| `packgen` | Synthesizes your app's knowledge pack. **Also worth a big model.** |
| `explorer` | Ranks discovered flows in Explore mode. |
| `selfheal` | Re-ranks locator repair candidates. |
| `reporter` | Explains failures. |
| `receptionist` | Classifies intent (only as a fallback). |
| `casual` | Conversational replies. |

**Resolution order**, first match wins:

```
.agenticqa.json "models"  →  OPENAI_MODEL_<ROLE>  →  OPENAI_MODEL  →  built-in default  →  safety model
```

> ⚠️ **`OPENAI_MODEL` overrides the whole table.** It forces one model on every role. A stale value there
> is a classic cause of "everything got worse and nothing changed".

If a model fails, AgenticQA walks a **fallback chain** to the next one, so a single free model going down
does not break a run.

> ⚠️ Embeddings are deliberately **not** per-agent. With Postgres on, the database fixes the vector
> dimension, so changing the embedding model is only safe with the database off — or after a
> **Reset Database**.

---

## `.env` — source checkouts only

Copy `packages/orchestrator/.env.example` to `.env`. Every value is optional; the pipeline degrades rather
than failing.

| Variable | Effect if missing |
|---|---|
| `OPENAI_API_KEY` | LLM features off; deterministic planning still works. |
| `OPENAI_BASE_URL` | Defaults to OpenRouter. |
| `OPENAI_MODEL` | Per-role defaults apply. **Prefer leaving it unset.** |
| `OPENAI_MODEL_<ROLE>` | That role uses its default. |
| `OPENAI_EMBED_MODEL` | RAG + vector self-heal off; lexical retrieval still works. |
| `DATABASE_URL` | No run history, no baselines, no vector self-heal. **Deterministic self-heal still works.** |

> **Never commit `.env`.** `.env.example` is committed by design and must only ever hold placeholders.

Verify a configuration with `npm run probe:models` — one tiny request per role, reported as **OK** /
**QUOTA** / **DEAD** / **AUTH**. A dead free-model ID never *looks* like a failure, because the fallback
chain hides it.

---

## The database

Optional. `docker compose up -d` starts Postgres with pgvector.

| With it | Without it |
|---|---|
| Run history in the sidebar | Runs still work; history is per-session |
| Locator baselines + vector self-heal | **Deterministic self-heal still works** |
| Learning from past repairs | No learning, no opinions |
| Flakiness detection | — |
| Domain Q&A caching | Q&A still works, retrieval in memory |

Schema changes are applied as versioned, transactional migrations. **Nothing drops a table implicitly.**
The only destructive path is **AgenticQA: Reset Database**, which asks first.

---

## Agent prompts

Three agents load their system prompt as data, resolved in this order:

```
<workspace>/.agenticqa/prompts/<Agent>.md    ← commit this to share with your team
<globalStorage>/prompts/<Agent>.md           ← what the Settings panel edits
the shipped default                          ← ships with the extension
```

A missing or empty override falls through to the next source and logs it — it never breaks a run. An
override that drops a required `{{placeholder}}` warns you by name.
