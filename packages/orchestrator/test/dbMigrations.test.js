"use strict";
/**
 * Offline unit tests for the schema-migration framework (G0.2).
 *
 * No Postgres, no Docker: the migration runner and schema inspectors take a `Queryable`, so a fake
 * client can record every statement. These tests also encode the REGRESSION GUARD for the defect this
 * stage fixed — `dbInit()` used to `DROP TABLE … CASCADE` five tables on every process start, destroying
 * all run history, locator baselines, doc chunks, and the QA cache. Only the explicit `dbReset()` may drop.
 *
 * Requires a build first (imports from dist/).
 */

const { test } = require("node:test");
const assert = require("node:assert");
const {
  EMBEDDING_DIM,
  MIGRATIONS,
  VECTOR_COLUMNS,
  AGENTICQA_TABLES,
  pendingMigrations,
  runMigrations,
  parseVectorDim,
  readVectorColumnDims,
  checkSchemaVectorDims,
  dbReset,
} = require("../dist/core/db/db.js");

/* ─── fake Queryable ─── */

function fakeDb(opts = {}) {
  const calls = [];
  return {
    calls,
    sqls: () => calls.map((c) => c.sql),
    async query(sql, params) {
      const text = String(sql).trim();
      calls.push({ sql: text, params });
      if (opts.failOn && text.includes(opts.failOn)) {
        throw new Error(`boom: ${opts.failOn}`);
      }
      if (/FROM\s+schema_migration/i.test(text)) {
        return { rows: opts.appliedRows ?? [] };
      }
      if (/pg_attribute/i.test(text)) {
        return { rows: opts.vectorRows ?? [] };
      }
      return { rows: [] };
    },
  };
}

const vectorRow = (table, column, colType) => ({
  table_name: table,
  column_name: column,
  col_type: colType,
});

/* ─── migration list integrity ─── */

test("MIGRATIONS versions are unique, ascending, and start at 1", () => {
  const versions = MIGRATIONS.map((m) => m.version);
  assert.deepStrictEqual(
    versions,
    [...versions].sort((a, b) => a - b),
    "versions must be listed in ascending order"
  );
  assert.strictEqual(new Set(versions).size, versions.length, "versions must be unique");
  assert.strictEqual(versions[0], 1, "the baseline migration must be version 1");
  for (const m of MIGRATIONS) {
    assert.ok(m.name && typeof m.name === "string", `migration ${m.version} needs a name`);
    assert.ok(m.statements.length > 0, `migration ${m.version} needs statements`);
  }
});

test("REGRESSION GUARD: no migration may DROP or TRUNCATE — only dbReset() destroys data", () => {
  for (const m of MIGRATIONS) {
    for (const sql of m.statements) {
      assert.ok(
        !/\bDROP\s+TABLE\b/i.test(sql),
        `migration ${m.version} ("${m.name}") contains DROP TABLE — this is the G0.2 defect returning:\n${sql}`
      );
      assert.ok(
        !/\bTRUNCATE\b/i.test(sql),
        `migration ${m.version} ("${m.name}") contains TRUNCATE:\n${sql}`
      );
      assert.ok(
        !/\bDROP\s+COLUMN\b/i.test(sql),
        `migration ${m.version} ("${m.name}") contains DROP COLUMN:\n${sql}`
      );
    }
  }
});

test("baseline migration is idempotent (every DDL statement guards with IF NOT EXISTS)", () => {
  const baseline = MIGRATIONS.find((m) => m.version === 1);
  for (const sql of baseline.statements) {
    if (/^\s*CREATE\s+TABLE/i.test(sql) || /^\s*CREATE\s+INDEX/i.test(sql)) {
      assert.match(sql, /IF NOT EXISTS/i, `not idempotent:\n${sql}`);
    }
    if (/^\s*ALTER\s+TABLE/i.test(sql) && /ADD\s+COLUMN/i.test(sql)) {
      assert.match(sql, /ADD COLUMN IF NOT EXISTS/i, `not idempotent:\n${sql}`);
    }
  }
});

test("every vector column in the DDL uses EMBEDDING_DIM (no stale literals)", () => {
  const all = MIGRATIONS.flatMap((m) => m.statements).join("\n");
  const dims = [...all.matchAll(/vector\s*\(\s*(\d+)\s*\)/gi)].map((m) => Number(m[1]));
  assert.ok(dims.length >= VECTOR_COLUMNS.length, "expected a vector column per VECTOR_COLUMNS entry");
  for (const d of dims) {
    assert.strictEqual(d, EMBEDDING_DIM, `found vector(${d}) but EMBEDDING_DIM is ${EMBEDDING_DIM}`);
  }
});

/* ─── pendingMigrations ─── */

test("pendingMigrations filters applied versions and sorts ascending", () => {
  const all = [
    { version: 3, name: "c", statements: ["c"] },
    { version: 1, name: "a", statements: ["a"] },
    { version: 2, name: "b", statements: ["b"] },
  ];
  assert.deepStrictEqual(
    pendingMigrations([], all).map((m) => m.version),
    [1, 2, 3]
  );
  assert.deepStrictEqual(
    pendingMigrations([1, 2], all).map((m) => m.version),
    [3]
  );
  assert.deepStrictEqual(pendingMigrations([1, 2, 3], all), []);
});

/* ─── runMigrations ─── */

test("runMigrations creates the bookkeeping table and applies pending migrations in a transaction", async () => {
  const db = fakeDb();
  const all = [{ version: 1, name: "baseline", statements: ["CREATE TABLE IF NOT EXISTS a ();"] }];

  const res = await runMigrations(db, all);

  assert.deepStrictEqual(res, { applied: [1], current: 1 });
  const sqls = db.sqls();
  assert.match(sqls[0], /CREATE TABLE IF NOT EXISTS schema_migration/i);
  assert.match(sqls[1], /SELECT version FROM schema_migration/i);
  assert.strictEqual(sqls[2], "BEGIN");
  assert.match(sqls[3], /CREATE TABLE IF NOT EXISTS a/i);
  assert.match(sqls[4], /INSERT INTO schema_migration/i);
  assert.strictEqual(sqls[5], "COMMIT");

  const insert = db.calls.find((c) => /INSERT INTO schema_migration/i.test(c.sql));
  assert.deepStrictEqual(insert.params, [1, "baseline"], "records version + name");
});

test("runMigrations is a no-op when everything is already applied", async () => {
  const db = fakeDb({ appliedRows: [{ version: 1 }] });
  const all = [{ version: 1, name: "baseline", statements: ["CREATE TABLE IF NOT EXISTS a ();"] }];

  const res = await runMigrations(db, all);

  assert.deepStrictEqual(res, { applied: [], current: 1 });
  assert.ok(!db.sqls().includes("BEGIN"), "must not open a transaction when nothing is pending");
  assert.ok(
    !db.sqls().some((s) => /INSERT INTO schema_migration/i.test(s)),
    "must not re-record an applied migration"
  );
});

test("runMigrations applies only the pending versions on an partially-migrated database", async () => {
  const db = fakeDb({ appliedRows: [{ version: 1 }] });
  const all = [
    { version: 1, name: "baseline", statements: ["SELECT 1"] },
    { version: 2, name: "second", statements: ["SELECT 2"] },
  ];

  const res = await runMigrations(db, all);

  assert.deepStrictEqual(res, { applied: [2], current: 2 });
  assert.ok(!db.sqls().includes("SELECT 1"), "must not re-run an applied migration");
  assert.ok(db.sqls().includes("SELECT 2"));
});

test("runMigrations rolls back and rethrows when a statement fails, leaving the version unrecorded", async () => {
  const db = fakeDb({ failOn: "WILL_FAIL" });
  const all = [
    { version: 1, name: "bad", statements: ["SELECT ok", "SELECT WILL_FAIL"] },
  ];

  await assert.rejects(() => runMigrations(db, all), /boom: WILL_FAIL/);

  const sqls = db.sqls();
  assert.ok(sqls.includes("BEGIN"));
  assert.ok(sqls.includes("ROLLBACK"), "a failed migration must roll back");
  assert.ok(!sqls.includes("COMMIT"), "a failed migration must not commit");
  assert.ok(
    !sqls.some((s) => /INSERT INTO schema_migration/i.test(s)),
    "a failed migration must not be recorded as applied"
  );
});

/* ─── vector-schema inspection ─── */

test("parseVectorDim reads a declared dimension and detects legacy dimensionless columns", () => {
  assert.strictEqual(parseVectorDim("vector(4096)"), 4096);
  assert.strictEqual(parseVectorDim("vector(1536)"), 1536);
  assert.strictEqual(parseVectorDim("vector( 768 )"), 768);
  assert.strictEqual(parseVectorDim("vector"), null, "dimensionless legacy column");
  assert.strictEqual(parseVectorDim("text"), null);
  assert.strictEqual(parseVectorDim(""), null);
});

test("readVectorColumnDims maps catalog rows to {table, column, dim}", async () => {
  const db = fakeDb({
    vectorRows: [
      vectorRow("doc_chunk", "embedding", `vector(${EMBEDDING_DIM})`),
      vectorRow("qa_cache", "question_embedding", "vector"),
    ],
  });
  assert.deepStrictEqual(await readVectorColumnDims(db), [
    { table: "doc_chunk", column: "embedding", dim: EMBEDDING_DIM },
    { table: "qa_cache", column: "question_embedding", dim: null },
  ]);
});

test("checkSchemaVectorDims: a matching schema is ok", async () => {
  const db = fakeDb({
    vectorRows: VECTOR_COLUMNS.map((c) => vectorRow(c.table, c.column, `vector(${EMBEDDING_DIM})`)),
  });
  const res = await checkSchemaVectorDims(db);
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.mismatches, []);
});

test("checkSchemaVectorDims: a legacy dimensionless column is a mismatch, not a crash", async () => {
  const db = fakeDb({
    vectorRows: [
      ...VECTOR_COLUMNS.slice(1).map((c) => vectorRow(c.table, c.column, `vector(${EMBEDDING_DIM})`)),
      vectorRow(VECTOR_COLUMNS[0].table, VECTOR_COLUMNS[0].column, "vector"),
    ],
  });
  const res = await checkSchemaVectorDims(db);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.mismatches.length, 1);
  assert.strictEqual(res.mismatches[0].dim, null);
  assert.strictEqual(res.mismatches[0].table, VECTOR_COLUMNS[0].table);
});

test("checkSchemaVectorDims: a differently-sized column is a mismatch", async () => {
  const db = fakeDb({
    vectorRows: [vectorRow("doc_chunk", "embedding", "vector(1536)")],
  });
  const res = await checkSchemaVectorDims(db);
  assert.strictEqual(res.ok, false);
  assert.deepStrictEqual(res.mismatches, [
    { table: "doc_chunk", column: "embedding", dim: 1536 },
  ]);
});

test("checkSchemaVectorDims ignores vector columns we don't own, and absent columns", async () => {
  const db = fakeDb({
    vectorRows: [vectorRow("someone_elses_table", "embedding", "vector(3)")],
  });
  const res = await checkSchemaVectorDims(db);
  assert.strictEqual(res.ok, true, "a foreign vector column is not our problem");

  const empty = fakeDb({ vectorRows: [] });
  const res2 = await checkSchemaVectorDims(empty);
  assert.strictEqual(res2.ok, true, "a fresh database (no columns yet) is not a mismatch");
});

/* ─── explicit reset ─── */

test("dbReset drops every AgenticQA table with CASCADE, dependents first", async () => {
  const db = fakeDb();
  const dropped = await dbReset(db);

  assert.deepStrictEqual(dropped, AGENTICQA_TABLES);
  for (const sql of db.sqls()) {
    assert.match(sql, /^DROP TABLE IF EXISTS \w+ CASCADE$/);
  }
  const order = db.sqls().map((s) => s.replace(/^DROP TABLE IF EXISTS (\w+) CASCADE$/, "$1"));
  assert.ok(
    order.indexOf("step_result") < order.indexOf("test_run"),
    "dependents must be dropped before their parents"
  );
  assert.ok(order.includes("schema_migration"), "reset must clear the migration ledger too");
});
