"use strict";
// Offline unit tests for the knowledge-pack synthesizer (N2.2). Requires a build (imports from dist/).

const { test } = require("node:test");
const assert = require("node:assert");

const {
  synthesizePackDeterministic,
  buildPackPrompt,
  parsePackResponse,
  validateGeneratedPack,
  finalizePack,
} = require("../dist/core/knowledge/generate/synthesizePack.js");
const { synthesizeFlows } = require("../dist/core/explore/synthesizeFlows.js");

function fixtureInput() {
  const site = {
    startUrl: "http://localhost:5173/",
    routes: [
      {
        url: "http://localhost:5173/",
        path: "/",
        routeKey: "/",
        title: "Welcome",
        inputs: [],
        buttons: [],
        links: [
          { role: "link", name: "Products", href: "/products" },
          { role: "link", name: "Login", href: "/auth/login" },
        ],
        headings: [{ role: "heading", name: "Welcome" }],
      },
      {
        url: "http://localhost:5173/products",
        path: "/products",
        routeKey: "/products",
        title: "All Products",
        inputs: [{ role: "textbox", name: "Search products..." }],
        buttons: [{ role: "button", name: "Search" }],
        links: [],
        headings: [{ role: "heading", name: "All Products" }],
      },
      {
        url: "http://localhost:5173/auth/login",
        path: "/auth/login",
        routeKey: "/auth/login",
        title: "Welcome Back",
        inputs: [
          { role: "textbox", name: "Email" },
          { role: "textbox", name: "Password" },
        ],
        buttons: [{ role: "button", name: "Sign In" }],
        links: [],
        headings: [{ role: "heading", name: "Welcome Back" }],
      },
    ],
  };
  return {
    appName: "",
    baseUrl: "http://localhost:5173",
    siteMap: site,
    extractedRoutes: [{ path: "/" }, { path: "/products" }, { path: "/auth/login" }],
    credentials: [
      { email: "customer@example.com", password: "password123", role: "customer" },
      { email: "admin@techstore.com", password: "admin123", role: "admin" },
    ],
  };
}

test("synthesizePackDeterministic builds a non-empty, grounded pack", () => {
  const pack = synthesizePackDeterministic(fixtureInput());
  assert.strictEqual(pack.name, "localhost:5173");
  // credentials only from extraction
  assert.strictEqual(pack.credentials.customer.email, "customer@example.com");
  assert.strictEqual(pack.credentials.admin.email, "admin@techstore.com");
  // route hints
  assert.strictEqual(pack.routes.home, "/");
  assert.strictEqual(pack.routes.products, "/products");
  assert.strictEqual(pack.routes.login, "/auth/login");
  // stable search element
  assert.strictEqual(pack.stableElements.searchInput, "Search products...");
  // grounded guidance mentions the login route + a real credential
  const guidance = pack.plannerGuidance.join("\n");
  assert.ok(/\/auth\/login/.test(guidance));
  assert.ok(/customer@example\.com/.test(guidance));
  // Golden flows present, and none is vacuous. The invariant is that every flow CONTAINS an assertion,
  // not that it ends with one: since 2026-08-11 a form flow asserts its submit control is available and
  // then submits, so it ends on the settle wait. A flow with no assertion at all is still a defect —
  // Playwright reports such a spec as PASS whatever the app does.
  const flows = Object.values(pack.goldenFlows);
  assert.ok(flows.length >= 3, `expected several flows, got ${flows.length}`);
  for (const [key, f] of Object.entries(pack.goldenFlows)) {
    assert.ok(
      f.steps.some((s) => /^expect/i.test(s.action)),
      `flow "${key}" has no assertion — it cannot fail`
    );
  }
  // a login form flow exists (fills Email + Password)
  const hasLoginForm = flows.some(
    (f) => f.steps.some((s) => s.action === "fill" && s.field === "Email")
  );
  assert.ok(hasLoginForm, "a login form flow filling Email exists");
});

test("buildCredentials maps a 2nd role-less credential to admin (not dropped)", () => {
  const input = fixtureInput();
  // Two accounts with NO detected role (e.g. a `role === 'customer' ? … : …` ternary).
  input.credentials = [
    { email: "c@example.com", password: "pw1" },
    { email: "a@example.com", password: "pw2" },
  ];
  const pack = synthesizePackDeterministic(input);
  assert.strictEqual(pack.credentials.customer.email, "c@example.com");
  assert.strictEqual(pack.credentials.admin.email, "a@example.com", "2nd account fills the admin slot");
});

test("synthesizePackDeterministic omits credentials/guidance when none were found", () => {
  const input = fixtureInput();
  input.credentials = [];
  const pack = synthesizePackDeterministic(input);
  assert.strictEqual(pack.credentials, undefined);
  // no login credentials → guidance only the login-route line (still fine), or undefined if no login route
  assert.ok(pack.goldenFlows && Object.keys(pack.goldenFlows).length > 0);
});

test("buildPackPrompt grounds the prompt in real routes, elements, credentials", () => {
  const prompt = buildPackPrompt(fixtureInput());
  assert.ok(prompt.includes("/auth/login"));
  assert.ok(prompt.includes("Search products..."));
  assert.ok(prompt.includes("customer@example.com"));
  assert.ok(/JSON/i.test(prompt));
  assert.ok(prompt.includes("expectVisible"));
});

test("buildPackPrompt asks for INTENT tags, and warns against restating page text (G2.5)", () => {
  // Tags are the one field that carries what the app's own words cannot — how a user would ask. They are
  // also measurably double-edged: intent tags lifted generated-pack retrieval 13→14/20, while tags that
  // restate page wording dropped demo-web's from 17→13/19. The instruction must stay specific.
  const prompt = buildPackPrompt(fixtureInput());
  assert.ok(/"tags"/.test(prompt), "asks for tags");
  assert.ok(/USER'S INTENT/i.test(prompt), "asks for intent, not description");
  assert.ok(/Do NOT restate the page heading/i.test(prompt), "warns off restating page text");
  assert.ok(/Never claim a flow is verified/i.test(prompt), "verification is earned by running");
});

test("generated flow descriptions carry the page's real heading (G2.5)", () => {
  // Regression guard for a measured defect: form flows described themselves as "Fill the form on /path",
  // discarding the heading the crawler already had. On the TaskFlow generated pack that single omission
  // cost 7 of 20 prompts — `smoke-*` flows kept the app's vocabulary and outranked the form flows that
  // actually satisfied the request.
  const flows = synthesizeFlows(
    {
      startUrl: "http://x/",
      routes: [
        {
          url: "http://x/tasks/new", path: "/tasks/new", routeKey: "/tasks/new", title: "Create Task",
          inputs: [{ role: "textbox", name: "Task title" }],
          buttons: [{ role: "button", name: "Create Task" }],
          links: [], headings: [{ role: "heading", name: "Create Task" }],
        },
      ],
    },
    { baseUrl: "http://x/" }
  );
  const form = flows.find((f) => f.kind === "form");
  const smoke = flows.find((f) => f.kind === "smoke");
  assert.ok(form, "a Create-X button must yield a form flow");
  assert.ok(form.title.includes("Create Task"), `heading missing from: ${form.title}`);
  assert.ok(!/^Smoke /.test(smoke.title), "developer jargon 'Smoke' is not retrieval text");
  assert.ok(smoke.title.includes("Create Task"));
});

test("parsePackResponse tolerates prose-wrapped JSON and rejects junk", () => {
  const good = `Here is the pack:
\`\`\`json
{ "goldenFlows": { "smoke": { "description": "d", "steps": [ { "action": "goto", "url": "/" }, { "action": "expectVisible", "target": "Welcome" } ] } } }
\`\`\`
Done.`;
  const pack = parsePackResponse(good);
  assert.ok(pack && pack.goldenFlows.smoke);
  assert.strictEqual(parsePackResponse("no json here"), null);
  assert.strictEqual(parsePackResponse("{ not valid json"), null);
});

test("validateGeneratedPack clamps malformed fields and drops bad flows", () => {
  const raw = {
    name: "X",
    routes: { ok: "/x", bad: 5 },
    plannerGuidance: ["a", 2, "b"],
    assertionAliases: [{ when: "w", assert: "a" }, { when: 1 }, "junk"],
    goldenFlows: {
      good: { description: "d", steps: [{ action: "goto", url: "/" }] },
      noSteps: { description: "d" },
      badSteps: { steps: [{ notAction: 1 }] },
    },
    junkKey: "ignored",
  };
  const pack = validateGeneratedPack(raw);
  assert.strictEqual(pack.routes.ok, "/x");
  assert.ok(!("bad" in pack.routes), "non-string route dropped");
  assert.deepStrictEqual(pack.plannerGuidance, ["a", "b"]);
  assert.strictEqual(pack.assertionAliases.length, 1);
  assert.ok(pack.goldenFlows.good, "valid flow kept");
  assert.ok(!pack.goldenFlows.noSteps, "flow without steps dropped");
  assert.ok(!pack.goldenFlows.badSteps, "flow with action-less steps dropped");
  assert.ok(!("junkKey" in pack));
});

test("validateGeneratedPack returns null for empty/contentless objects", () => {
  assert.strictEqual(validateGeneratedPack({}), null);
  assert.strictEqual(validateGeneratedPack({ foo: 1 }), null);
  assert.strictEqual(validateGeneratedPack([1, 2]), null);
  assert.strictEqual(validateGeneratedPack("x"), null);
});

test("finalizePack merges LLM flows over the deterministic floor but keeps extracted credentials", () => {
  const input = fixtureInput();
  // null LLM → deterministic base
  const base = finalizePack(input, null);
  assert.ok(base.goldenFlows && Object.keys(base.goldenFlows).length > 0);

  const llm = validateGeneratedPack({
    credentials: { customer: { email: "hacker@evil.com", password: "x" } },
    goldenFlows: {
      "extra-login": {
        description: "Login and see dashboard",
        steps: [
          { action: "goto", url: "/auth/login" },
          { action: "expectVisible", target: "Welcome Back" },
        ],
      },
    },
    plannerGuidance: ["custom guidance"],
  });
  const merged = finalizePack(input, llm);
  // credentials come from extraction, NEVER the LLM
  assert.strictEqual(merged.credentials.customer.email, "customer@example.com");
  // LLM golden flow added on top of the deterministic floor
  assert.ok(merged.goldenFlows["extra-login"], "LLM flow merged");
  assert.ok(Object.keys(merged.goldenFlows).length > 1, "deterministic floor retained");
  // LLM guidance preferred
  assert.deepStrictEqual(merged.plannerGuidance, ["custom guidance"]);
});

/* ── G1.4: sourceless (hosted-only) generation — no source, therefore no credentials ── */

/** The sourceless case: a live crawl, but no extracted routes and no extracted credentials. */
function sourcelessInput() {
  const full = fixtureInput();
  return { baseUrl: full.baseUrl, siteMap: full.siteMap }; // no extractedRoutes, no credentials
}

test("sourceless: still produces a usable pack from the crawl alone", () => {
  const pack = synthesizePackDeterministic(sourcelessInput());
  assert.ok(pack.name, "derives a name from the host when there is no package.json");
  assert.ok(pack.routes && Object.keys(pack.routes).length > 0, "routes come from the crawl");
  assert.ok(
    pack.goldenFlows && Object.keys(pack.goldenFlows).length > 0,
    "candidate flows are still synthesized from the SiteMap"
  );
});

test("sourceless: credentials are OMITTED, never invented", () => {
  const pack = synthesizePackDeterministic(sourcelessInput());

  // The invariant is about CREDENTIALS — values presented to the planner as real logins for this app.
  assert.strictEqual(pack.credentials, undefined, "no source ⇒ no credentials at all");

  // `plannerGuidance` is the other channel where extracted credentials surface ("Credential (admin):
  // email=… password=…"). With nothing extracted, no such line may exist.
  const guidance = []
    .concat(pack.plannerGuidance ?? [])
    .join("\n")
    .toLowerCase();
  assert.ok(!guidance.includes("credential"), `guidance must not claim any credential, got: ${guidance}`);
  assert.ok(!guidance.includes("password="), "guidance must not contain a password");

  // NOTE: golden-flow *steps* may legitimately contain synthetic form values such as
  // "test.user@example.com" from `sampleValueFor` — that is sample input for filling a form, not a
  // claimed login. If such a flow ever tried to authenticate it would fail, and validation-by-running
  // would drop it. Asserting "no @example.com anywhere" conflates the two and is wrong.
});

test("sourceless: the LLM prompt explicitly forbids inventing credentials", () => {
  const prompt = buildPackPrompt(sourcelessInput());
  assert.match(prompt, /No credentials were found in source — do not invent any/i);
  assert.match(prompt, /never invent routes, elements, or/i);
});

test("REGRESSION GUARD: an LLM cannot smuggle credentials into a sourceless pack", () => {
  // The whole point of D2/G0.3: credentials come from real source literals or not at all. A hallucinating
  // (or prompt-injected) model must not be able to put a login into the pack that nothing verified.
  const llm = validateGeneratedPack({
    credentials: {
      customer: { email: "totally@made-up.test", password: "hunter2" },
      admin: { email: "root@made-up.test", password: "toor" },
    },
    goldenFlows: {
      "smoke-home": { description: "Home loads", steps: [{ action: "goto", url: "/" }] },
    },
  });
  assert.ok(llm && llm.credentials, "the raw parse does surface them…");

  const merged = finalizePack(sourcelessInput(), llm);
  assert.strictEqual(merged.credentials, undefined, "…but finalizePack must drop LLM credentials entirely");
  assert.ok(
    !JSON.stringify(merged).includes("made-up.test"),
    "no invented credential may reach the written pack"
  );
});

/* ── G2.1: parsing retrieval metadata out of an LLM pack ── */

test("parsePackResponse preserves tags and routeKey", () => {
  const pack = parsePackResponse(
    JSON.stringify({
      goldenFlows: {
        "form-login": {
          description: "Log in via the form on /login",
          tags: ["Login", "sign in", "login", "AUTH"],
          routeKey: "/login",
          steps: [{ action: "goto", url: "/login" }, { action: "expectVisible", target: "Sign in" }],
        },
      },
    })
  );
  const flow = pack.goldenFlows["form-login"];
  assert.deepStrictEqual(flow.tags, ["login", "sign in", "auth"], "normalized + deduped");
  assert.strictEqual(flow.routeKey, "/login");
});

test("REGRESSION GUARD: an LLM cannot mark its own flow `verified`", () => {
  // `verified` means "this was executed and passed". Only the generator's validation step may set it —
  // otherwise a model could assert trustworthiness it never earned, defeating validate-by-execution.
  const pack = parsePackResponse(
    JSON.stringify({
      goldenFlows: {
        "smoke-home": {
          description: "Home loads",
          verified: true,
          steps: [{ action: "goto", url: "/" }, { action: "expectVisible", target: "Welcome" }],
        },
      },
    })
  );
  assert.strictEqual(pack.goldenFlows["smoke-home"].verified, undefined);
});

test("parsePackResponse tolerates junk metadata without losing the flow", () => {
  const pack = parsePackResponse(
    JSON.stringify({
      goldenFlows: {
        "smoke-home": {
          description: "Home",
          tags: "not-an-array",
          routeKey: 42,
          steps: [{ action: "goto", url: "/" }],
        },
      },
    })
  );
  const flow = pack.goldenFlows["smoke-home"];
  assert.ok(flow, "flow survives");
  assert.strictEqual(flow.tags, undefined);
  assert.strictEqual(flow.routeKey, undefined);
});

test("finalizePack carries an LLM flow's tags through the merge", () => {
  const input = fixtureInput();
  const llm = validateGeneratedPack({
    goldenFlows: {
      "extra-login": {
        description: "Login and see dashboard",
        tags: ["login", "auth"],
        steps: [{ action: "goto", url: "/auth/login" }, { action: "expectVisible", target: "Welcome Back" }],
      },
    },
  });
  const merged = finalizePack(input, llm);
  assert.deepStrictEqual(merged.goldenFlows["extra-login"].tags, ["login", "auth"]);
});

/* ─── G3.8: the validation budget must not delete a whole flow family ─── */

const { selectFlowsForValidation } = require("../dist/core/knowledge/generate/synthesizePack.js");

function keysOf(sel) {
  return sel.map(([k]) => k);
}

test("selectFlowsForValidation keeps every family within the budget (G3.8)", () => {
  // `buildGoldenFlows` emits smoke+form per route in crawl order and appends nav flows LAST, so taking
  // the first N cut at exactly the boundary before them. Every TaskFlow pack shipped with zero nav flows
  // — the only family that clicks anything — and 8 of 20 prompts scored UNDER_TESTED for "never clicks".
  const flows = {};
  for (const r of ["home", "login", "projects", "new", "team", "settings", "apollo"]) {
    flows[`smoke-${r}`] = { steps: [] };
  }
  for (const r of ["login", "new", "settings"]) {flows[`form-${r}`] = { steps: [] };}
  for (const r of ["projects", "team", "settings", "login"]) {flows[`nav-${r}`] = { steps: [] };}

  const picked = keysOf(selectFlowsForValidation(flows, 10));
  assert.strictEqual(picked.length, 10);
  for (const kind of ["smoke", "form", "nav"]) {
    assert.ok(
      picked.some((k) => k.startsWith(`${kind}-`)),
      `no ${kind} flow survived the budget: ${picked.join(", ")}`
    );
  }
  // Interaction-bearing families lead each cycle; a smoke flow asserts what was already on screen.
  assert.strictEqual(picked[0], "form-login");
  assert.strictEqual(picked[1], "nav-projects");
});

test("selectFlowsForValidation is a no-op under budget (G3.8)", () => {
  const flows = { "smoke-home": { steps: [] }, "form-login": { steps: [] } };
  assert.deepStrictEqual(keysOf(selectFlowsForValidation(flows, 10)), ["smoke-home", "form-login"]);
});

test("selectFlowsForValidation still fills the budget from one family (G3.8)", () => {
  const flows = Object.fromEntries(
    ["a", "b", "c", "d"].map((r) => [`smoke-${r}`, { steps: [] }])
  );
  assert.strictEqual(selectFlowsForValidation(flows, 3).length, 3);
});

test("selectFlowsForValidation keeps LLM-invented keys eligible (G3.8)", () => {
  // A model may name a flow anything; those land in `other` and must still compete for a slot.
  const flows = {
    "smoke-home": { steps: [] },
    "smoke-b": { steps: [] },
    checkoutHappyPath: { steps: [] },
  };
  const picked = keysOf(selectFlowsForValidation(flows, 2));
  assert.ok(picked.includes("checkoutHappyPath"), picked.join(", "));
});
