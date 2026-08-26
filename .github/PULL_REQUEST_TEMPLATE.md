## What & why

<!-- What does this change, and what problem does it solve? -->

## How it was verified

- [ ] `cd packages/orchestrator && npm test` — green
- [ ] `cd packages/agenticqa && npm test && npm run compile` — green
- [ ] If a golden fixture changed, the diff is explained below

<!-- Which prompts/specs changed in a golden fixture, and why? -->

## Invariants

<!-- Delete any that do not apply. See CONTRIBUTING.md. -->

- [ ] Nothing new writes to the engine's **stdout** except the protocol
- [ ] Works with the **database off**
- [ ] No app-specific literals in `src/core` or `src/agents`
- [ ] `apps/taskflow-web` (the held-out app) was **not** tuned
- [ ] Docs updated in this PR if behaviour changed
