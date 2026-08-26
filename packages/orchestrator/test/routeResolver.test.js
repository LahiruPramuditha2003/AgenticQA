"use strict";
/**
 * Offline unit tests for request → inspection-route selection (rewritten for G3.1).
 *
 * ⚠️ THE CONTRACT CHANGED. These tests used to assert that the *word* "login" produced `/auth/login`,
 * "search" produced `/products`, and so on — a built-in map of demo-web's URLs. That map was the proven
 * root cause of the held-out app's score: on TaskFlow it sent pre-inspection to `/products` and `/admin`,
 * both 404s, so the planner's context for the whole application held 0 inputs and 0 buttons.
 *
 * Routes now come from the APP (its pack's `routes` map plus the `goto` targets of its golden flows).
 * The old assertions still hold for demo-web — but only because demo-web's pack *declares* those routes,
 * which is the entire point. With no pack, nothing is guessed.
 *
 * Requires a build (imports from dist/).
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const {
  buildInspectUrlsFromRequest,
  collectKnownRoutes,
} = require("../dist/core/inspection/RouteIntentResolver.js");

const BASE = "http://localhost:5173";
const has = (urls, p) => urls.includes(new URL(p, BASE).toString());

const DEMO_PACK = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "..", "..", "..", "apps", "demo-web", ".agenticqa", "knowledge.json"),
    "utf8"
  )
);

/** A pack shaped like the generator's output for a non-ecommerce app. */
const TASKFLOW_PACK = {
  routes: { home: "/", login: "/login", projects: "/projects", new: "/tasks/new", team: "/team" },
  goldenFlows: {
    "form-login": { steps: [{ action: "goto", url: "/login" }, { action: "fill", field: "Email" }] },
  },
};

test("always includes the base/home route", () => {
  const urls = buildInspectUrlsFromRequest("anything at all", BASE, "/", DEMO_PACK);
  assert.ok(has(urls, "/"), "home route always inspected");
});

/* ─── the app's declared routes drive selection ─── */

test("demo-web: login requests reach the auth + account routes THE PACK DECLARES", () => {
  const urls = buildInspectUrlsFromRequest(
    "Login with valid credentials and verify redirect to account page",
    BASE,
    "/",
    DEMO_PACK
  );
  assert.ok(has(urls, "/auth/login"), "login → /auth/login");
  assert.ok(has(urls, "/account"), "account mention → /account");
});

test("demo-web: a search request reaches /products", () => {
  const urls = buildInspectUrlsFromRequest("Search for laptop in the navbar", BASE, "/", DEMO_PACK);
  assert.ok(has(urls, "/products"));
});

test("demo-web: admin and register requests reach their routes", () => {
  assert.ok(
    has(buildInspectUrlsFromRequest("Open the admin dashboard analytics", BASE, "/", DEMO_PACK), "/admin")
  );
  assert.ok(
    has(
      buildInspectUrlsFromRequest("Create account on the register page", BASE, "/", DEMO_PACK),
      "/auth/register"
    )
  );
});

test("THE POINT OF G3.1: a non-ecommerce app gets ITS routes, and none of demo-web's", () => {
  const urls = buildInspectUrlsFromRequest(
    "Go to the Projects page and filter the projects table",
    "http://localhost:5174",
    "http://localhost:5174/",
    TASKFLOW_PACK
  );
  const paths = urls.map((u) => new URL(u).pathname);
  assert.ok(paths.includes("/projects"), `expected /projects, got ${paths.join(", ")}`);
  for (const demoRoute of ["/products", "/admin", "/cart", "/auth/login"]) {
    assert.ok(!paths.includes(demoRoute), `must not invent demo-web's ${demoRoute}`);
  }
});

test("'sign in' reaches a route named /login", () => {
  // Lexical retrieval needs shared words; "sign in" and "login" are the same word spaced differently.
  // Without the tokenizer's auth normalization, all three sign-in prompts on the held-out app inspected
  // the home page only and never saw the login form.
  const paths = buildInspectUrlsFromRequest(
    "Go to the sign in page, enter ada@taskflow.test and click Sign in",
    "http://localhost:5174",
    "http://localhost:5174/",
    TASKFLOW_PACK
  ).map((u) => new URL(u).pathname);
  assert.ok(paths.includes("/login"), `expected /login, got ${paths.join(", ")}`);
});

/* ─── no pack ⇒ no guessing ─── */

test("with NO pack, routes are never invented — start page only", () => {
  const urls = buildInspectUrlsFromRequest(
    "Login with valid credentials, search for a laptop, and open the admin dashboard",
    BASE,
    "/"
  );
  const paths = urls.map((u) => new URL(u).pathname);
  assert.deepStrictEqual(paths, ["/"], `guessed routes without app knowledge: ${paths.join(", ")}`);
});

test("with NO pack, an explicitly stated path is still honoured", () => {
  const urls = buildInspectUrlsFromRequest("Navigate directly to /checkout with empty cart", BASE, "/");
  assert.ok(has(urls, "/checkout"), "the user's own instruction is not inference");
});

/* ─── route collection + ranking details ─── */

test("collectKnownRoutes reads the routes map AND golden-flow goto targets", () => {
  const routes = collectKnownRoutes({
    routes: { home: "/", team: "/team" },
    goldenFlows: { anything: { steps: [{ action: "goto", url: "http://x/deep/page" }] } },
  });
  const paths = routes.map((r) => r.path).sort();
  assert.deepStrictEqual(paths, ["/", "/deep/page", "/team"]);
});

test("a flow's KEY never labels the route it lands on", () => {
  // demo-web's `admin-login` flow ends at /admin. Labelling that route "admin login" made every prompt
  // containing the word "login" drag the admin panel into pre-inspection.
  const routes = collectKnownRoutes({
    goldenFlows: { "admin-login": { steps: [{ action: "goto", url: "/admin" }] } },
  });
  const admin = routes.find((r) => r.path === "/admin");
  assert.ok(admin);
  assert.ok(!/login/i.test(admin.label), `flow vocabulary leaked into the route label: "${admin.label}"`);
});

test("a deeper route must earn its slot with a term its parent didn't match", () => {
  // /account, /account/orders and /account/profile all match the single word "account"; spending three
  // inspection slots on one area crowds out genuinely different pages.
  const pack = {
    routes: {
      account: "/account",
      accountOrders: "/account/orders",
      accountProfile: "/account/profile",
      register: "/auth/register",
    },
  };
  const plain = buildInspectUrlsFromRequest("open my account", BASE, "/", pack).map(
    (u) => new URL(u).pathname
  );
  assert.deepStrictEqual(plain, ["/", "/account"], "siblings add nothing for a bare 'account'");

  const withOrders = buildInspectUrlsFromRequest("open my account orders", BASE, "/", pack).map(
    (u) => new URL(u).pathname
  );
  assert.ok(withOrders.includes("/account/orders"), "naming 'orders' earns the deeper route");
});

test("a path-like fragment mid-word is not treated as a route", () => {
  // "set the timezone to Europe/London" must not produce a request for /london.
  const paths = buildInspectUrlsFromRequest(
    "Change the timezone to Europe/London and save",
    BASE,
    "/",
    DEMO_PACK
  ).map((u) => new URL(u).pathname);
  assert.ok(!paths.includes("/london"), `matched mid-word: ${paths.join(", ")}`);
});

test("returns absolute, de-duplicated URLs", () => {
  const urls = buildInspectUrlsFromRequest("products products search products", BASE, "/", DEMO_PACK);
  assert.strictEqual(new Set(urls).size, urls.length, "no duplicates");
  assert.ok(urls.every((u) => u.startsWith("http")), "all absolute");
});
