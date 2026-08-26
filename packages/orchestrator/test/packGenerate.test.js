"use strict";
// Offline unit tests for the knowledge-pack generator's pure detectors + extractors (N2.1).
// Requires a build first (imports from dist/).

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { detectFramework, detectAppFromListing } = require("../dist/core/knowledge/generate/detectApp.js");
const {
  extractReactRouterRoutes,
  extractNextRoutes,
  extractRoutes,
} = require("../dist/core/knowledge/generate/extractRoutes.js");
const { extractCredentials } = require("../dist/core/knowledge/generate/extractCredentials.js");

const DEMO_WEB = path.resolve(__dirname, "../../../apps/demo-web");

/* ── detectApp ── */

test("detectFramework identifies react-router / next / vue / unknown", () => {
  assert.strictEqual(detectFramework('{"dependencies":{"react-router-dom":"^6"}}'), "react-router");
  assert.strictEqual(detectFramework('{"dependencies":{"next":"14"}}'), "next");
  assert.strictEqual(detectFramework('{"devDependencies":{"vue-router":"4"}}'), "vue-router");
  assert.strictEqual(detectFramework('{"dependencies":{"express":"4"}}'), "unknown");
  assert.strictEqual(detectFramework(undefined), "unknown");
  assert.strictEqual(detectFramework("not json"), "unknown");
});

test("detectAppFromListing flags a code-accessible react app and surfaces candidates", () => {
  const d = detectAppFromListing({
    packageJson: '{"dependencies":{"react-router-dom":"^6"}}',
    files: ["src/App.tsx", "src/pages/Home.tsx", "src/services/mockData.ts", "src/pages/auth/Login.tsx"],
  });
  assert.strictEqual(d.isCodeAccessible, true);
  assert.strictEqual(d.framework, "react-router");
  assert.ok(d.routeFileCandidates.includes("src/App.tsx"), "App.tsx is a route candidate");
  assert.ok(
    d.credentialFileCandidates.some((f) => /mockData/.test(f)) &&
      d.credentialFileCandidates.some((f) => /Login/.test(f)),
    "mockData + Login are credential candidates"
  );
});

test("detectAppFromListing treats a no-framework / source-less app as hosted-only", () => {
  const noFw = detectAppFromListing({ packageJson: '{"dependencies":{"express":"4"}}', files: ["server.js"] });
  assert.strictEqual(noFw.isCodeAccessible, false);
  const noSrc = detectAppFromListing({ packageJson: '{"dependencies":{"next":"14"}}', files: ["README.md"] });
  assert.strictEqual(noSrc.isCodeAccessible, false);
});

test("detectAppFromListing surfaces Next app/pages route files", () => {
  const d = detectAppFromListing({
    packageJson: '{"dependencies":{"next":"14"}}',
    files: ["app/page.tsx", "app/products/page.tsx", "pages/about.tsx", "src/index.ts"],
  });
  assert.strictEqual(d.framework, "next");
  assert.ok(d.routeFileCandidates.includes("app/products/page.tsx"));
});

/* ── extractRoutes: React Router ── */

test("extractReactRouterRoutes pulls JSX <Route path> incl. component, drops catch-all", () => {
  const src = `
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/products" element={<Products />} />
      <Route path="/products/:id" element={<ProductDetail />} />
      <Route path="/account/*" element={<Account />} />
      <Route path="*" element={<Error404 />} />
    </Routes>`;
  const routes = extractReactRouterRoutes(src);
  const paths = routes.map((r) => r.path);
  assert.ok(paths.includes("/"));
  assert.ok(paths.includes("/products"));
  assert.ok(paths.includes("/products/:id"));
  assert.ok(paths.includes("/account"), "/account/* normalized to /account");
  assert.ok(!paths.includes("*"), "catch-all dropped");
  const home = routes.find((r) => r.path === "/");
  assert.strictEqual(home.component, "Home");
});

test("extractReactRouterRoutes reads the real demo-web App.tsx", () => {
  const src = fs.readFileSync(path.join(DEMO_WEB, "src/App.tsx"), "utf8");
  const paths = extractReactRouterRoutes(src).map((r) => r.path);
  for (const expected of ["/", "/products", "/cart", "/checkout", "/auth/login", "/auth/register", "/admin"]) {
    assert.ok(paths.includes(expected), `expected route ${expected} (got ${paths.join(", ")})`);
  }
  assert.ok(!paths.includes("*"));
});

test("extractRoutes dispatches react-router by source content", () => {
  const routes = extractRoutes({
    framework: "react-router",
    sources: [{ path: "App.tsx", content: `<Route path="/login" element={<Login/>} />` }],
  });
  assert.deepStrictEqual(routes.map((r) => r.path), ["/login"]);
});

/* ── extractRoutes: Next ── */

test("extractNextRoutes maps app/ + pages/ trees and [id] → :id", () => {
  const routes = extractNextRoutes([
    "app/page.tsx",
    "app/products/page.tsx",
    "app/products/[id]/page.tsx",
    "pages/index.tsx",
    "pages/about.tsx",
    "pages/api/hello.ts",
    "pages/_app.tsx",
  ]).map((r) => r.path);
  assert.ok(routes.includes("/"));
  assert.ok(routes.includes("/products"));
  assert.ok(routes.includes("/products/:id"));
  assert.ok(routes.includes("/about"));
  assert.ok(!routes.some((r) => r.includes("api")), "api routes skipped");
  assert.ok(!routes.some((r) => r.includes("_app")), "_app skipped");
});

/* ── extractCredentials ── */

test("extractCredentials finds email+password pairs in both orders, with role", () => {
  const creds = extractCredentials([
    {
      path: "Login.tsx",
      content: `
        const credentials = role === 'customer'
          ? { email: 'customer@example.com', password: 'password123' }
          : { email: 'admin@techstore.com', password: 'admin123', role: 'admin' };`,
    },
    {
      path: "api.ts",
      content: `if (password !== 'secretpw' && email !== 'guard@example.com') {}`,
    },
  ]);
  const byEmail = Object.fromEntries(creds.map((c) => [c.email, c]));
  assert.strictEqual(byEmail["customer@example.com"].password, "password123");
  assert.strictEqual(byEmail["admin@techstore.com"].password, "admin123");
  assert.strictEqual(byEmail["admin@techstore.com"].role, "admin");
  assert.strictEqual(byEmail["guard@example.com"].password, "secretpw", "password-then-email order");
});

test("extractCredentials invents nothing when there are no literal pairs", () => {
  const creds = extractCredentials([
    { path: "x.ts", content: `const email = formData.email; const password = formData.password;` },
  ]);
  assert.deepStrictEqual(creds, []);
});

test("extractCredentials reads real demo-web Login.tsx credentials", () => {
  const src = fs.readFileSync(path.join(DEMO_WEB, "src/pages/auth/Login.tsx"), "utf8");
  const creds = extractCredentials([{ path: "Login.tsx", content: src }]);
  const emails = creds.map((c) => c.email);
  assert.ok(emails.includes("customer@example.com"));
  assert.ok(emails.includes("admin@techstore.com"));
});
