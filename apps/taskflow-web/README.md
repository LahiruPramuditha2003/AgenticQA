# TaskFlow — AgenticQA's held-out benchmark app

A small task/issue tracker (React + Vite + React Router, in-memory fixtures, no backend).

## Why this app exists

`apps/demo-web` cannot measure whether AgenticQA generalizes: its prompts, its hand-curated knowledge
pack, and the planner's scenario matcher were authored together, so a high score there is close to
guaranteed. **TaskFlow is the unseen app** — the control that makes the demo-web number interpretable.

It is deliberately built to share nothing with demo-web:

| | demo-web | TaskFlow |
|---|---|---|
| Domain | e-commerce | project / task tracking |
| Vocabulary | product, cart, checkout, category | project, task, assignee, priority, member, workspace |
| Auth route | `/auth/login` | `/login` |
| Widgets | inputs, selects, buttons | + textarea, date input, checkbox group, sortable table, `role="dialog"` modals |
| Port | 5173 | 5174 (so both can run at once) |
| Knowledge pack | hand-curated, 15 golden flows | **auto-generated, 12 flows — earned, not written** |

> **On the knowledge pack.** TaskFlow started with none. Its pack was produced by running
> **AgenticQA: Generate Knowledge Pack** — the same command any user runs — and is committed so the
> benchmark is reproducible. It is deliberately **not** marked `"curated"`, so regenerating it is a
> legitimate demonstration rather than a destructive act. **Never hand-edit it.** The moment a human
> improves TaskFlow's pack, the number it produces stops meaning anything.

## Please don't "fix" this app to improve benchmark scores

A failing prompt means the **engine** needs work, not the app. In particular:

- The **`Filter projects`** box on `/projects` is an `<input type="search">` (ARIA role `searchbox`). That
  is correct HTML and what a real tracker would ship. It once made the field invisible to the planner —
  the engine was fixed to handle `searchbox`, which is exactly the right outcome. Leave the app alone.
- Seeded credentials in `src/services/seedUsers.ts` are **real literals on purpose** — the knowledge-pack
  generator statically extracts them and must never invent credentials.

The app's own health is separately verified: a temporary Playwright smoke covering every behaviour the 20
benchmark prompts rely on passed 7/7 (G1.2). If a benchmark run looks broken, suspect the engine first.

## Run it

```bash
npm run dev          # http://localhost:5174
npm run build        # tsc -b && vite build
```

## Benchmark it

```bash
cd ../../packages/orchestrator
node scripts/batchRunTemplates.js --app=apps/taskflow-web \
     --templates=TEST_TEMPLATES_TASKFLOW.md --project=chromium
```

Prompts live in the repo-root [`TEST_TEMPLATES_TASKFLOW.md`](../../TEST_TEMPLATES_TASKFLOW.md).

## Seeded accounts

| Email | Password | Role |
|---|---|---|
| `ada@taskflow.test` | `Taskflow123!` | Member |
| `grace@taskflow.test` | `Admin123!` | Admin |
