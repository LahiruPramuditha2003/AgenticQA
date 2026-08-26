"use strict";
// Offline unit tests for the Exploratory agent's pure crawler helpers (no MCP/network). Imports from dist/.

const { test } = require("node:test");
const assert = require("node:assert");
const {
  resolveSameOriginUrl,
  routeKeyForPath,
  collectLinkUrls,
  collectSnapshotLinkUrls,
  parseSnapshotLinkHrefs,
  pathOf,
} = require("../dist/core/explore/Crawler.js");
const { extractJsonArray } = require("../dist/core/inspection/PageInventory.js");
const {
  synthesizeFlows,
  isSubmitButton,
  sampleValueFor,
} = require("../dist/core/explore/synthesizeFlows.js");
const {
  buildJudgePrompt,
  parseJudgeResponse,
  heuristicRank,
} = require("../dist/agents/ExploratoryAgent/judge.js");

test("resolveSameOriginUrl: resolves same-origin, rejects cross-origin / non-navigational (S3.1)", () => {
  const base = "http://localhost:5173/";
  assert.strictEqual(resolveSameOriginUrl("/products", base), "http://localhost:5173/products");
  assert.strictEqual(resolveSameOriginUrl("products/5", base), "http://localhost:5173/products/5");
  assert.strictEqual(resolveSameOriginUrl("https://google.com/x", base), null, "cross-origin");
  assert.strictEqual(resolveSameOriginUrl("#top", base), null, "in-page anchor");
  assert.strictEqual(resolveSameOriginUrl("mailto:a@b.com", base), null, "mailto");
  assert.strictEqual(resolveSameOriginUrl("javascript:void(0)", base), null, "javascript:");
  assert.strictEqual(resolveSameOriginUrl("/cart#section", base), "http://localhost:5173/cart", "hash stripped");
});

test("routeKeyForPath collapses numeric/hash id segments (S3.1)", () => {
  assert.strictEqual(routeKeyForPath("/products/1"), "/products/:id");
  assert.strictEqual(routeKeyForPath("/products/5"), "/products/:id");
  assert.strictEqual(routeKeyForPath("/account/orders"), "/account/orders");
  assert.strictEqual(routeKeyForPath("/"), "/");
  assert.strictEqual(routeKeyForPath("/Products/Detail/"), "/products/detail");
});

test("collectLinkUrls keeps distinct same-origin anchors only (S3.1)", () => {
  const base = "http://localhost:5173/";
  const dom = [
    { tagName: "a", href: "/products" },
    { tagName: "a", href: "/products" }, // duplicate
    { tagName: "a", href: "https://x.com" }, // cross-origin
    { tagName: "button", href: "/x" }, // not an anchor
    { tagName: "a", href: "/cart" },
    { tagName: "a", href: "#top" }, // non-navigational
  ];
  assert.deepStrictEqual(collectLinkUrls(dom, base), [
    "http://localhost:5173/products",
    "http://localhost:5173/cart",
  ]);
});

test("pathOf returns the pathname", () => {
  assert.strictEqual(pathOf("http://localhost:5173/products/5?q=1"), "/products/5");
});

/* ── S3.2 flow synthesis ── */

const SITE = {
  startUrl: "http://localhost:5173/",
  routes: [
    {
      url: "http://localhost:5173/", path: "/", routeKey: "/", title: "Welcome to TechStore",
      inputs: [], buttons: [],
      links: [
        { role: "link", name: "Products", href: "/products" },
        { role: "link", name: "Login", href: "/auth/login" },
      ],
      headings: [{ role: "heading", name: "Welcome to TechStore" }],
    },
    {
      url: "http://localhost:5173/products", path: "/products", routeKey: "/products", title: "All Products",
      inputs: [{ role: "textbox", name: "Search products..." }], buttons: [], links: [],
      headings: [{ role: "heading", name: "All Products" }],
    },
    {
      url: "http://localhost:5173/auth/login", path: "/auth/login", routeKey: "/auth/login", title: "Welcome Back",
      inputs: [{ role: "textbox", name: "Email" }, { role: "textbox", name: "Password" }],
      buttons: [{ role: "button", name: "Sign In" }], links: [],
      headings: [{ role: "heading", name: "Welcome Back" }],
    },
  ],
};

test("isSubmitButton matches generic action VERBS, not domain phrases (G2.5)", () => {
  assert.ok(isSubmitButton("Sign In"));
  assert.ok(isSubmitButton("Create Account"));
  // G2.5: the list used to be domain phrases ("create account", "place order", "checkout"), so
  // "Create Task" was unrecognised and TaskFlow's main form got NO form flow at all. Matching the verb
  // makes any app's Create-X / Add-X work without new entries.
  assert.ok(isSubmitButton("Create Task"), "verb `create`, not the phrase `create account`");
  assert.ok(isSubmitButton("Add Item"));
  assert.ok(isSubmitButton("Send invite"));
  assert.ok(isSubmitButton("Save changes"));
  // Destructive actions are NOT form submits — pointing a generated flow at one is the worst case.
  assert.ok(!isSubmitButton("Delete workspace"));
  assert.ok(!isSubmitButton("Remove item"));
  // Not an action verb at all.
  assert.ok(!isSubmitButton("Apollo Redesign"));
  assert.match(sampleValueFor("Email"), /@example\.com$/);
  assert.strictEqual(sampleValueFor("Password"), "Password123!");
});

test("no fillable inputs ⇒ no form flow, whatever the button says (G2.5)", () => {
  // This — not the verb list — is what stops a product-listing page ("Add to Cart", search box only)
  // from yielding a bogus form flow. `formFlow` excludes search inputs, so nothing is fillable.
  const listing = {
    startUrl: "http://localhost:5173/",
    routes: [
      {
        url: "http://localhost:5173/products", path: "/products", routeKey: "/products",
        title: "All Products",
        inputs: [{ role: "searchbox", name: "Search products..." }],
        buttons: [{ role: "button", name: "Add to Cart" }],
        links: [], headings: [{ role: "heading", name: "All Products" }],
      },
    ],
  };
  const flows = synthesizeFlows(listing, { baseUrl: "http://localhost:5173/" });
  assert.strictEqual(flows.filter((f) => f.kind === "form").length, 0);
});

test("synthesizeFlows emits a smoke flow per titled route (S3.2)", () => {
  const flows = synthesizeFlows(SITE, { baseUrl: "http://localhost:5173/" });
  const smokes = flows.filter((f) => f.kind === "smoke");
  assert.strictEqual(smokes.length, 3, "one smoke per route");
  const home = smokes.find((f) => f.routeKey === "/");
  assert.strictEqual(home.steps[0].action, "goto");
  assert.strictEqual(home.steps[home.steps.length - 1].target, "Welcome to TechStore");
});

test("synthesizeFlows builds a form flow only where inputs + a submit button exist (S3.2)", () => {
  const flows = synthesizeFlows(SITE, { baseUrl: "http://localhost:5173/" });
  const login = flows.find((f) => f.kind === "form" && f.routeKey === "/auth/login");
  assert.ok(login, "login route yields a form flow");
  assert.ok(login.steps.some((s) => s.action === "fill" && s.field === "Email"));
  assert.ok(login.steps.some((s) => s.action === "fill" && s.field === "Password"));
  // The form is asserted complete and then SUBMITTED (owner decision 2026-08-11; before that the flow
  // stopped at the assertion and every generated pack tested a form it never sent).
  const idxAssert = login.steps.findIndex((s) => s.action === "expectVisible" && s.target === "Sign In");
  const idxClick = login.steps.findIndex((s) => s.action === "click" && s.target === "Sign In");
  assert.ok(idxAssert >= 0, "the submit control is asserted available once the form is filled");
  assert.ok(idxClick > idxAssert, "and then clicked");
  assert.strictEqual(login.steps[login.steps.length - 1].action, "waitForLoad", "settle after submit");
  // /products has only a search input and no submit → no form flow
  assert.ok(!flows.some((f) => f.kind === "form" && f.routeKey === "/products"));
});

test("a form flow never submits via a destructive control (2026-08-11)", () => {
  // `isSubmitButton` excludes delete/remove precisely so that turning submission ON cannot point a
  // generated test at the most dangerous button on the page.
  const site = {
    startUrl: "http://x/danger",
    routes: [
      {
        routeKey: "/danger",
        path: "/danger",
        url: "http://x/danger",
        title: "Danger",
        inputs: [{ role: "textbox", name: "Confirm name" }],
        buttons: [{ role: "button", name: "Delete workspace" }],
        links: [],
      },
    ],
  };
  assert.strictEqual(
    synthesizeFlows(site, { baseUrl: "http://x/" }).some((f) => f.kind === "form"),
    false,
    "a page whose only action is destructive yields no form flow at all"
  );
});

test("synthesizeFlows builds nav flows that assert the destination heading (S3.2)", () => {
  const flows = synthesizeFlows(SITE, { baseUrl: "http://localhost:5173/" });
  const navs = flows.filter((f) => f.kind === "nav");
  const toProducts = navs.find((f) => f.routeKey === "/products");
  assert.ok(toProducts, "nav to products");
  assert.ok(toProducts.steps.some((s) => s.action === "click" && s.target === "Products"));
  assert.strictEqual(toProducts.steps[toProducts.steps.length - 1].target, "All Products");
  assert.ok(navs.some((f) => f.routeKey === "/auth/login" &&
    f.steps[f.steps.length - 1].target === "Welcome Back"));
});

/* ── S3.3 LLM-judge ranking (pure pieces) ── */

const JFLOWS = [
  { title: "Smoke /", kind: "smoke", routeKey: "/", steps: [{ action: "goto" }, { action: "waitForLoad" }, { action: "expectVisible" }] },
  { title: "Smoke /products", kind: "smoke", routeKey: "/products", steps: [{ action: "goto" }, { action: "waitForLoad" }, { action: "expectVisible" }] },
  { title: "Fill login", kind: "form", routeKey: "/auth/login", steps: [{ action: "goto" }, { action: "waitForLoad" }, { action: "fill" }, { action: "fill" }, { action: "expectVisible" }] },
  { title: "Nav products", kind: "nav", routeKey: "/products", steps: [{ action: "goto" }, { action: "waitForLoad" }, { action: "click" }, { action: "waitForLoad" }, { action: "expectVisible" }] },
];

test("buildJudgePrompt lists indexed flows + asks for a JSON ranking (S3.3)", () => {
  const p = buildJudgePrompt(JFLOWS, 5);
  assert.match(p, /0\. \[smoke\]/);
  assert.match(p, /2\. \[form\]/);
  assert.match(p, /"ranking"/);
  assert.match(p, /diverse mix/i, "nudges toward a mix of flow types (S3.7)");
});

test("parseJudgeResponse maps indices, clamps scores, drops junk/dupes (S3.3)", () => {
  const raw = 'sure: {"ranking":[{"index":2,"score":9,"reason":"valuable form"},{"index":0,"score":15},{"index":99,"score":5},{"index":2,"score":1}]} done';
  const ranked = parseJudgeResponse(raw, JFLOWS);
  assert.ok(ranked);
  assert.strictEqual(ranked.length, 2, "idx 99 dropped, duplicate idx 2 dropped");
  assert.strictEqual(ranked[0].title, "Fill login");
  assert.strictEqual(ranked[0].score, 9);
  assert.strictEqual(ranked[0].rationale, "valuable form");
  assert.strictEqual(ranked[1].score, 10, "score clamped to 10");
});

test("parseJudgeResponse returns null on unusable output (S3.3)", () => {
  assert.strictEqual(parseJudgeResponse("no json here", JFLOWS), null);
  assert.strictEqual(parseJudgeResponse('{"notranking":1}', JFLOWS), null);
});

test("heuristicRank returns a diverse top-N, form first, scores descending (S3.3)", () => {
  const ranked = heuristicRank(JFLOWS, 3);
  assert.strictEqual(ranked.length, 3);
  assert.strictEqual(ranked[0].kind, "form", "richest + new route/kind ranks first");
  assert.ok(ranked[0].score >= ranked[1].score && ranked[1].score >= ranked[2].score, "descending scores");
  assert.strictEqual(new Set(ranked.map((r) => r.routeKey)).size, 3, "spreads across distinct routes");
});

/* ── S3.6 live-finding fix: snapshot-based link discovery + wrapper-tolerant DOM inventory ── */

const NAV_SNAPSHOT = [
  '- navigation [ref=e4]:',
  '  - link "⚡ TechStore" [ref=e7] [cursor=pointer]:',
  '    - /url: /',
  '  - link "Products" [ref=e14] [cursor=pointer]:',
  '    - /url: /products',
  '  - link "Shopping Cart" [ref=e15] [cursor=pointer]:',
  '    - /url: /cart',
  '    - text: 🛒',
  '  - link "Login" [ref=e17] [cursor=pointer]:',
  '    - /url: /auth/login',
  '  - link "External" [ref=e20]:',
  '    - /url: https://example.com/x',
].join("\n");

test("collectSnapshotLinkUrls extracts same-origin /url lines from the snapshot (S3.6)", () => {
  const urls = collectSnapshotLinkUrls(NAV_SNAPSHOT, "http://localhost:5173/");
  assert.deepStrictEqual(urls, [
    "http://localhost:5173/",
    "http://localhost:5173/products",
    "http://localhost:5173/cart",
    "http://localhost:5173/auth/login",
  ]); // cross-origin example.com dropped
});

test("parseSnapshotLinkHrefs pairs each link with its /url child (S3.6)", () => {
  const pairs = parseSnapshotLinkHrefs(NAV_SNAPSHOT);
  assert.deepStrictEqual(pairs.find((p) => p.name === "Products"), { name: "Products", url: "/products" });
  assert.deepStrictEqual(pairs.find((p) => p.name === "Login"), { name: "Login", url: "/auth/login" });
  assert.deepStrictEqual(pairs.find((p) => p.name === "Shopping Cart"), { name: "Shopping Cart", url: "/cart" });
});

test("extractJsonArray tolerates a '### Result' wrapper / fences (S3.6)", () => {
  assert.deepStrictEqual(extractJsonArray('### Result\n[{"tagName":"a"}]'), [{ tagName: "a" }]);
  assert.deepStrictEqual(extractJsonArray('```json\n[1,2,3]\n```'), [1, 2, 3]);
  assert.strictEqual(extractJsonArray("no array here"), null);
  assert.strictEqual(extractJsonArray('{"not":"array"}'), null);
});

/* ─── D14: a <select> is chosen from, never typed into (G2.7b) ─── */

test("D14: a combobox with NO captured options is skipped, never filled", () => {
  // Playwright rejects fill() on a <select> ("Element is not an <input>"). On the 2026-08-10 TaskFlow
  // run this killed both interaction-heavy flows during validate-by-running, leaving a pack of
  // smoke/nav flows only — every generated test passed while exercising nothing.
  const site = {
    startUrl: "http://x/",
    routes: [{
      url: "http://x/tasks/new", path: "/tasks/new", routeKey: "/tasks/new", title: "Create Task",
      inputs: [
        { role: "textbox", name: "Task title" },
        { role: "combobox", name: "Project" },   // no options captured
        { role: "combobox", name: "Priority", options: ["Low", "High"] },
      ],
      buttons: [{ role: "button", name: "Create Task" }],
      links: [], headings: [{ role: "heading", name: "Create Task" }],
    }],
  };
  const form = synthesizeFlows(site, { baseUrl: "http://x/" }).find((f) => f.kind === "form");
  assert.ok(form, "still yields a form flow");
  const fills = form.steps.filter((s) => s.action === "fill").map((s) => s.field);
  const selects = form.steps.filter((s) => s.action === "select").map((s) => s.field);
  assert.deepStrictEqual(fills, ["Task title"], "only the real textbox is filled");
  assert.deepStrictEqual(selects, ["Priority"], "the option-bearing select is selected");
  assert.ok(!fills.includes("Project"), "an option-less combobox must NOT be filled");
});

test("D14: options are recovered from a duplicate inventory entry", () => {
  // The snapshot pass and the DOM pass each contribute the control; they only merge when testId matches,
  // which it usually doesn't. So the same select appears twice — once bare, once with its options.
  const site = {
    startUrl: "http://x/",
    routes: [{
      url: "http://x/s", path: "/s", routeKey: "/s", title: "Settings",
      inputs: [
        { role: "textbox", name: "Display name" },
        { role: "combobox", name: "Timezone" },                              // snapshot copy
        { role: "combobox", name: "Timezone", testId: "tz", options: ["UTC", "CET"] }, // DOM copy
      ],
      buttons: [{ role: "button", name: "Save changes" }],
      links: [], headings: [{ role: "heading", name: "Settings" }],
    }],
  };
  const form = synthesizeFlows(site, { baseUrl: "http://x/" }).find((f) => f.kind === "form");
  const tz = form.steps.filter((s) => s.field === "Timezone");
  assert.strictEqual(tz.length, 1, "deduped to one step");
  assert.strictEqual(tz[0].action, "select");
  assert.strictEqual(tz[0].option, "CET");
});

test("D14: a form of nothing but unusable selects yields no flow at all", () => {
  const site = {
    startUrl: "http://x/",
    routes: [{
      url: "http://x/f", path: "/f", routeKey: "/f", title: "Filter",
      inputs: [{ role: "combobox", name: "Status" }],
      buttons: [{ role: "button", name: "Apply" }],
      links: [], headings: [{ role: "heading", name: "Filter" }],
    }],
  };
  assert.strictEqual(synthesizeFlows(site, { baseUrl: "http://x/" }).filter((f) => f.kind === "form").length, 0);
});

test("a typed input gets a value its type accepts (G3.6)", () => {
  // `<input type="date">` rejects anything but YYYY-MM-DD with `fill: Error: Malformed value`. On
  // 2026-08-10 "Due date" got the generic "Test value", so TaskFlow's Create Task flow failed
  // validate-by-running and the generated pack shipped with no way to test the app's main workflow.
  assert.strictEqual(sampleValueFor("Due date", "date"), "2026-12-31");
  assert.strictEqual(sampleValueFor("Anything", "number"), "1");
  assert.strictEqual(sampleValueFor("Contact", "email"), "test.user@example.com");
  assert.strictEqual(sampleValueFor("When", "time"), "10:00");
  // Type wins over the name.
  assert.strictEqual(sampleValueFor("City", "date"), "2026-12-31");
  // …and a date-ish NAME is caught even when the crawler reported no type.
  assert.strictEqual(sampleValueFor("Due date"), "2026-12-31");
  assert.strictEqual(sampleValueFor("Start Date"), "2026-12-31");
  // Untyped, non-date fields keep the old behavior.
  assert.strictEqual(sampleValueFor("Task title"), "Test value");
});

test("formFlow fills a date input with a valid date (G3.6)", () => {
  const site = {
    startUrl: "http://x/",
    routes: [{
      url: "http://x/tasks/new", path: "/tasks/new", routeKey: "/tasks/new", title: "Create Task",
      inputs: [
        { role: "textbox", name: "Task title" },
        { role: "textbox", name: "Due date" },                              // snapshot copy: no type
        { role: "textbox", name: "Due date", testId: "due", inputType: "date" }, // DOM copy: typed
      ],
      buttons: [{ role: "button", name: "Create Task" }],
      links: [], headings: [{ role: "heading", name: "Create Task" }],
    }],
  };
  const form = synthesizeFlows(site, { baseUrl: "http://x/" }).find((f) => f.kind === "form");
  const due = form.steps.find((s) => s.field === "Due date");
  assert.strictEqual(due.value, "2026-12-31", "the type is recovered from the duplicate DOM entry");
});

/* ─── G3.11 coverage half: the `filter` family (2026-08-11) ─── */

const FILTER_SITE = {
  startUrl: "http://x/",
  routes: [
    {
      routeKey: "/projects", path: "/projects", url: "http://x/projects", title: "Projects",
      inputs: [
        { role: "searchbox", name: "Filter projects" },
        { role: "combobox", name: "Status", options: ["All", "Active", "Paused"] },
      ],
      checkboxes: [{ role: "checkbox", name: "Archived only" }],
      buttons: [], links: [], headings: [{ name: "Projects" }],
    },
  ],
};

test("a page with controls but NO submit button still gets a flow", () => {
  // `formFlow` requires a submit control and bails without one, so a filter bar produced nothing but a
  // smoke flow — the page was crawled, its controls captured, then discarded for lack of a button. That
  // is why "type a name into the Projects filter" and "set the Status dropdown" had no flow at all.
  const flows = synthesizeFlows(FILTER_SITE, { baseUrl: "http://x/" });
  const f = flows.find((x) => x.kind === "filter");
  assert.ok(f, "a filter flow is generated");
  const actions = f.steps.map((s) => s.action);
  assert.ok(actions.includes("fill"), "the searchbox is typed into");
  assert.ok(actions.includes("select"), "the dropdown is chosen from");
  assert.ok(actions.includes("check"), "the checkbox is ticked");
  assert.strictEqual(f.steps[f.steps.length - 1].action, "expectVisible");
});

test("the filter family never competes with a real form", () => {
  // A page WITH a submit button is formFlow's job; emitting both would duplicate the same controls.
  const withSubmit = {
    startUrl: "http://x/",
    routes: [{
      ...FILTER_SITE.routes[0],
      buttons: [{ name: "Save changes" }],
    }],
  };
  const flows = synthesizeFlows(withSubmit, { baseUrl: "http://x/" });
  assert.strictEqual(flows.some((x) => x.kind === "filter"), false);
  assert.strictEqual(flows.some((x) => x.kind === "form"), true);
});

test("a page with no controls yields no filter flow", () => {
  const bare = {
    startUrl: "http://x/",
    routes: [{
      routeKey: "/about", path: "/about", url: "http://x/about", title: "About",
      inputs: [], checkboxes: [], buttons: [], links: [], headings: [{ name: "About" }],
    }],
  };
  assert.strictEqual(
    synthesizeFlows(bare, { baseUrl: "http://x/" }).some((x) => x.kind === "filter"),
    false
  );
});

test("a form flow ticks the checkboxes it now knows about", () => {
  // The crawler captured no checkboxes at all until 2026-08-11, so no generated flow could ever tick one.
  const site = {
    startUrl: "http://x/",
    routes: [{
      routeKey: "/tasks/new", path: "/tasks/new", url: "http://x/tasks/new", title: "Create Task",
      inputs: [{ role: "textbox", name: "Task title" }],
      checkboxes: [{ role: "checkbox", name: "Bug" }, { role: "checkbox", name: "Documentation" }],
      buttons: [{ name: "Create Task" }], links: [], headings: [{ name: "Create Task" }],
    }],
  };
  const f = synthesizeFlows(site, { baseUrl: "http://x/" }).find((x) => x.kind === "form");
  assert.deepStrictEqual(
    f.steps.filter((s) => s.action === "check").map((s) => s.target),
    ["Bug", "Documentation"]
  );
});
