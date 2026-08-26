"use strict";
/**
 * Offline unit tests for Playwright-MCP launch resolution (G0.5).
 *
 * Regression context: `require.resolve("@playwright/mcp/cli.js")` throws ERR_PACKAGE_PATH_NOT_EXPORTED
 * because the package's `exports` map publishes only "." and "./package.json" — even though cli.js exists
 * on disk. The old code caught that and silently fell back to `npx -y @playwright/mcp@latest`, so EVERY
 * run ignored the pinned dependency and paid an npx cold start (observed: MCP connect timing out with
 * -32001; after the fix, connect takes ~1.7s).
 *
 * Requires a build first (imports from dist/).
 */

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const { resolveMcpLaunch } = require("../dist/core/mcp/PlaywrightMcpClient.js");

const FLAGS = ["--headless", "--caps=core,testing", "--snapshot-mode=full"];

test("resolves the LOCAL pinned cli.js via the package.json subpath", () => {
  const pkgJson = path.join("/repo", "node_modules", "@playwright", "mcp", "package.json");
  const launch = resolveMcpLaunch(FLAGS, {
    resolve: (spec) => {
      assert.strictEqual(
        spec,
        "@playwright/mcp/package.json",
        "must resolve package.json (exported), NOT cli.js (not exported)"
      );
      return pkgJson;
    },
    exists: () => true,
  });

  assert.strictEqual(launch.source, "local");
  assert.strictEqual(launch.command, "node");
  assert.strictEqual(launch.args[0], path.join(path.dirname(pkgJson), "cli.js"));
  assert.deepStrictEqual(launch.args.slice(1), FLAGS, "flags are appended unchanged");
});

test("REGRESSION GUARD: never resolves the non-exported cli.js subpath", () => {
  // Simulate the real package: only "." and "./package.json" are exported.
  const asked = [];
  resolveMcpLaunch(FLAGS, {
    resolve: (spec) => {
      asked.push(spec);
      if (spec.endsWith("/cli.js")) {
        const err = new Error("Package subpath './cli.js' is not defined by \"exports\"");
        err.code = "ERR_PACKAGE_PATH_NOT_EXPORTED";
        throw err;
      }
      return "/repo/node_modules/@playwright/mcp/package.json";
    },
    exists: () => true,
  });
  assert.ok(
    !asked.some((s) => s.endsWith("/cli.js")),
    `must not attempt the non-exported subpath (asked: ${asked.join(", ")})`
  );
});

test("falls back to npx when the package cannot be resolved", () => {
  const launch = resolveMcpLaunch(FLAGS, {
    resolve: () => {
      throw new Error("MODULE_NOT_FOUND");
    },
  });
  assert.strictEqual(launch.source, "npx");
  assert.strictEqual(launch.command, "npx");
  assert.deepStrictEqual(launch.args, ["-y", "@playwright/mcp@latest", ...FLAGS]);
});

test("falls back to npx when the package resolves but cli.js is absent", () => {
  const launch = resolveMcpLaunch(FLAGS, {
    resolve: () => "/repo/node_modules/@playwright/mcp/package.json",
    exists: () => false,
  });
  assert.strictEqual(launch.source, "npx");
});

test("falls back to npx when no resolver is available", () => {
  assert.strictEqual(resolveMcpLaunch(FLAGS).source, "npx");
});

test("the pinned @playwright/mcp really is reachable in THIS checkout", () => {
  // The point of the fix: in a normal `npm install`ed tree we must take the local path, not npx.
  const launch = resolveMcpLaunch(FLAGS, { resolve: (spec) => require.resolve(spec) });
  assert.strictEqual(
    launch.source,
    "local",
    "expected the pinned @playwright/mcp — run `npm install` at the repo root if this fails"
  );
  assert.match(launch.args[0], /[\\/]@playwright[\\/]mcp[\\/]cli\.js$/);
});
