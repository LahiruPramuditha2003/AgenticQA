"use strict";
// Offline unit test: DbService must degrade gracefully (no throw) when DATABASE_URL is absent.
// Requires a build first (imports from dist/).

const { test } = require("node:test");
const assert = require("node:assert");
const { DbService } = require("../dist/core/services/DbService.js");

test("DbService with no DATABASE_URL sets dbEnabled=false without throwing", async () => {
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const ctx = { workspacePath: "/tmp/ws" };
    const logs = [];
    await new DbService().apply(ctx, {
      log: (m) => logs.push(String(m)),
      error: (m) => logs.push(String(m)),
    });
    assert.strictEqual(ctx.dbEnabled, false, "dbEnabled must be false");
    assert.strictEqual(ctx.testRunId, undefined, "no run id without DB");
    assert.strictEqual(ctx.projectId, undefined, "no project id without DB");
    assert.ok(
      logs.some((l) => /without a database/i.test(l)),
      "should log the degraded-mode message"
    );
  } finally {
    if (saved !== undefined) process.env.DATABASE_URL = saved;
  }
});
