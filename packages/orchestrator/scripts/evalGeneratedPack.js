#!/usr/bin/env node
/**
 * Measure retrieval over an AUTO-GENERATED pack (G2.5).
 *
 * WHY THIS EXISTS
 * ---------------
 * `eval:flowindex` scores retrieval over demo-web's *hand-curated* pack. That says nothing about the packs
 * the generator actually produces, whose flow keys, descriptions and step text are machine-made — and those
 * are the packs G2 exists to make usable. G2.4 also measured that **adding metadata can make retrieval
 * worse** (a hand-written tag set scored 13/19 against 17/19 for none), so G2.5 must not add `tags` or
 * rewrite descriptions on faith. This is the gate that decides.
 *
 * The pack is built by running the REAL generator (`synthesizePackDeterministic`) over a SiteMap fixture
 * transcribed from `apps/taskflow-web`'s actual routes, headings, inputs and buttons — so it exercises the
 * shipped code path rather than a hand-imagined pack. Ground truth is hand-labelled, as in `evalFlowIndex`.
 *
 *   node scripts/evalGeneratedPack.js [--verbose] [--flows]
 *
 * Offline: no crawl, no LLM, no network.
 */

const path = require("node:path");

const { extractTemplatePrompts, repoRootFromHere } = require("./extractTemplatePrompts");
const { buildFlowIndex, rankFlows } = require("../dist/core/knowledge/FlowIndex.js");
const {
  synthesizePackDeterministic,
  selectFlowsForValidation,
} = require("../dist/core/knowledge/generate/synthesizePack.js");

/** Mirrors `KnowledgePackAgent`'s MAX_VALIDATE — the number of flows a generated pack can actually keep. */
const MAX_VALIDATE = 12;

const verbose = process.argv.includes("--verbose");
const showFlows = process.argv.includes("--flows");
const repoRoot = repoRootFromHere();
const BASE = "http://localhost:5174";

const el = (name, extra = {}) => ({ name, ...extra });
const NAV = [
  { name: "Dashboard", href: "/" },
  { name: "Projects", href: "/projects" },
  { name: "Team", href: "/team" },
  { name: "Settings", href: "/settings" },
  { name: "Sign in", href: "/login" },
];

/** Transcribed from apps/taskflow-web (real headings/labels/buttons), in the crawler's output shape. */
const SITE_MAP = {
  startUrl: `${BASE}/`,
  routes: [
    {
      url: `${BASE}/`, path: "/", routeKey: "/", title: "Your Work",
      inputs: [], buttons: [el("Create Task")], links: NAV, headings: [el("Your Work"), el("Due soon")],
    },
    {
      url: `${BASE}/login`, path: "/login", routeKey: "/login", title: "Sign in to TaskFlow",
      inputs: [el("Email"), el("Password")], buttons: [el("Sign in")], links: NAV,
      headings: [el("Sign in to TaskFlow")],
    },
    {
      url: `${BASE}/projects`, path: "/projects", routeKey: "/projects", title: "Projects",
      inputs: [
        el("Filter projects", { role: "searchbox" }),
        el("Status", { role: "combobox", options: ["All", "Active", "Paused", "Archived"] }),
        el("Sort by", { role: "combobox", options: ["Name", "Owner", "Updated"] }),
      ],
      buttons: [], links: NAV, headings: [el("Projects")],
    },
    {
      url: `${BASE}/projects/apollo-redesign`, path: "/projects/apollo-redesign",
      routeKey: "/projects/:id", title: "Apollo Redesign",
      inputs: [], buttons: [], links: NAV, headings: [el("Apollo Redesign"), el("Tasks")],
    },
    {
      url: `${BASE}/tasks/new`, path: "/tasks/new", routeKey: "/tasks/new", title: "Create Task",
      inputs: [
        el("Task title"), el("Description"),
        el("Project", { role: "combobox", options: ["Apollo Redesign", "Delta Onboarding"] }),
        el("Assignee", { role: "combobox", options: ["Ada Lovelace", "Grace Hopper"] }),
        el("Priority", { role: "combobox", options: ["Low", "Medium", "High"] }),
        el("Due date"),
      ],
      // Real: the Create Task form carries label checkboxes. They were absent from this fixture for as
      // long as the crawler failed to capture checkboxes at all — a fixture tidier than reality again.
      checkboxes: [el("Bug"), el("Documentation")],
      buttons: [el("Create Task")], links: NAV, headings: [el("Create Task")],
    },
    {
      url: `${BASE}/team`, path: "/team", routeKey: "/team", title: "Team",
      inputs: [el("Work email"), el("Role", { role: "combobox", options: ["Member", "Admin"] })],
      buttons: [el("Invite member"), el("Send invite")], links: NAV, headings: [el("Team")],
    },
    {
      url: `${BASE}/settings`, path: "/settings", routeKey: "/settings", title: "Settings",
      inputs: [el("Display name"), el("Timezone", { role: "combobox", options: ["UTC", "CET"] })],
      buttons: [el("Save changes"), el("Delete workspace")], links: NAV,
      headings: [el("Settings"), el("Danger zone")],
    },
  ],
};

/**
 * Acceptable flows per TaskFlow prompt. Sets, not single labels — a generated pack legitimately contains
 * near-equivalent flows (`smoke-projects` and `nav-projects` both land on /projects and assert its
 * heading), so demanding one specific key would overstate failure.
 *
 * LABELLING RULE, applied uniformly so the sets can't be quietly widened to flatter a result: a flow is
 * accepted iff (a) it lands on the page the prompt is about, AND (b) it performs the kind of interaction
 * the prompt describes — a prompt that fills a form is only satisfied by a form flow, never by a smoke
 * flow that merely asserts the heading.
 *
 * Keys are whatever the generator emits; run with --flows to list them.
 */
const PROJECTS = ["smoke-projects", "nav-projects"];
const EXPECTED = {
  1: ["smoke-home"],
  2: ["nav-projects", "nav-team", "nav-settings"],       // "the navigation bar offers …"
  3: PROJECTS,                                            // views the table — no interaction requested
  // ⚠️ 4/5/6 were `PROJECTS` with the note "filter box — generator makes no /projects form". The `filter`
  // family (2026-08-11) means one now exists, so the rule at the top of this block applies as written:
  // these prompts ask to fill/select, and a smoke flow that only asserts a heading does NOT satisfy them.
  // This TIGHTENS the labels — `smoke-projects` is no longer accepted for them — rather than widening
  // them to flatter the new code. If `filter-projects` ever stops being generated, 4/5/6 must FAIL here.
  4: ["filter-projects"],                                 // "type … into the filter"
  5: ["filter-projects"],                                 // "set the Status dropdown to Paused"
  6: ["filter-projects"],                                 // "change the Sort by dropdown to Owner"
  7: ["smoke-apollo-redesign", ...PROJECTS],              // opening a project
  8: ["smoke-apollo-redesign", ...PROJECTS],
  9: ["form-new"], 10: ["form-new"], 11: ["form-new"], 12: ["form-new"],
  13: ["smoke-team", "nav-team"],
  14: ["form-team"], 15: ["form-team"],
  16: ["form-settings"],
  17: ["smoke-settings", "nav-settings", "form-settings"],
  18: ["form-login"], 19: ["form-login"], 20: ["form-login"],
};

/**
 * Tags a competent `packgen` LLM would plausibly write for these flows — user vocabulary, not app text.
 * Used by `--tags` to answer the G2.5 question BEFORE spending prompt budget on asking for them: G2.4
 * measured that a hand-written tag set made demo-web retrieval *worse* (13/19 vs 17/19), so "more metadata
 * helps" is not an assumption this project is allowed to make.
 */
const SIMULATED_LLM_TAGS = {
  "smoke-home": ["dashboard", "home page", "overview"],
  "smoke-login": ["login page", "sign in page"],
  "form-login": ["sign in", "log in", "authenticate", "credentials", "email and password"],
  "smoke-projects": ["projects list", "workspace projects"],
  "smoke-apollo-redesign": ["project detail", "open a project"],
  "smoke-new": ["create task page", "new task page"],
  "form-new": ["create task", "new task", "add task", "task form"],
  "smoke-team": ["team page", "team members"],
  "form-team": ["invite member", "invite teammate", "send invite"],
  "smoke-settings": ["settings page", "preferences"],
  "form-settings": ["update settings", "change display name", "save preferences"],
  "nav-projects": ["projects link", "go to projects"],
  "nav-team": ["team link", "go to team"],
  "nav-settings": ["settings link", "go to settings"],
  "nav-login": ["login link", "go to sign in"],
};

function main() {
  const pack = synthesizePackDeterministic({ appName: "taskflow-web", baseUrl: BASE, siteMap: SITE_MAP });
  // Score the pack that actually SHIPS. `KnowledgePackAgent` validates at most MAX_VALIDATE candidates by
  // running them and writes only those, so evaluating the uncapped generator output measured a pack no app
  // ever receives — which is how a cap that silently deleted every nav flow survived this eval untouched.
  const allFlows = pack.goldenFlows ?? {};
  const flows = Object.fromEntries(selectFlowsForValidation(allFlows, MAX_VALIDATE));
  if (process.argv.includes("--tags")) {
    for (const [k, f] of Object.entries(flows)) {
      if (SIMULATED_LLM_TAGS[k]) {f.tags = SIMULATED_LLM_TAGS[k];}
    }
    console.log("(--tags: simulated LLM-authored tags injected)\n");
  }

  console.log(
    `Generated pack: ${Object.keys(flows).length} of ${Object.keys(allFlows).length} golden flow(s) ` +
      `from the real generator (validation budget ${MAX_VALIDATE}).\n`
  );
  if (showFlows) {
    for (const [k, f] of Object.entries(flows)) {
      console.log(`  ${k.padEnd(22)} ${f.description}`);
      if (f.tags) {console.log(`  ${" ".repeat(22)} tags: ${f.tags.join(", ")}`);}
    }
    console.log("");
  }

  const index = buildFlowIndex(flows);
  const prompts = extractTemplatePrompts(path.join(repoRoot, "benchmarks/TEST_TEMPLATES_TASKFLOW.md")).filter(
    (p) => p.index >= 1 && p.index <= 20
  );

  let hit1 = 0, hit3 = 0, scored = 0, mrrSum = 0, planned = 0;
  const missed = [];

  console.log(" #  | acceptable                        | retrieved             |");
  console.log("-".repeat(76));
  for (const p of prompts) {
    const want = EXPECTED[p.index] ?? null;
    const r = rankFlows(index, p.prompt);
    const got = r.abstained ? "(abstained)" : r.hit.key;
    if (!r.abstained) {planned++;}

    if (want === null) {
      console.log(`${String(p.index).padStart(2)}  | ${"(abstain)".padEnd(33)} | ${got.padEnd(21)} | ${r.abstained ? "✓" : "✗"}`);
      continue;
    }
    scored++;
    const ok = new Set(want);
    const rank = r.candidates.findIndex((h) => ok.has(h.key)) + 1; // best acceptable candidate's rank
    if (rank === 1) {hit1++;} else {missed.push(`${p.index}:${got}`);}
    if (rank > 0 && rank <= 3) {hit3++;}
    if (rank > 0) {mrrSum += 1 / rank;}
    console.log(
      `${String(p.index).padStart(2)}  | ${want.join("|").slice(0, 33).padEnd(33)} | ${got.padEnd(21)} | ${rank === 1 ? "✓" : "✗"}`
    );
    if (verbose) {
      console.log("     " + r.candidates.map((h) => `${h.key}(${h.score.toFixed(2)})`).join(", "));
    }
  }

  const pct = (n) => `${Math.round((n / scored) * 1000) / 10}%`;
  console.log("-".repeat(64));
  console.log(`Deterministic plans produced : ${planned}/${prompts.length}  (the regex ladder produced 0)`);
  console.log(`  hit@1 : ${hit1}/${scored}  (${pct(hit1)})`);
  console.log(`  hit@3 : ${hit3}/${scored}  (${pct(hit3)})`);
  console.log(`  MRR   : ${(mrrSum / scored).toFixed(3)}`);
  if (missed.length) {console.log(`  missed: ${missed.join(" ")}`);}
}

// Exported so other measurements can reuse the transcribed SiteMap instead of re-deriving it. Guarded so
// the CLI behaviour is unchanged: running the file still just prints the eval.
module.exports = { SITE_MAP, BASE, EXPECTED };

if (require.main === module) {main();}
