import { Pool } from "pg";

/**
 * Fixed embedding dimension for every `vector(...)` column in the schema. pgvector columns must declare a
 * dimension, so it is baked into the DDL — but the DDL now *interpolates this constant* (see `MIGRATIONS`),
 * so there are no literal `4096`s to keep in sync.
 *
 * Two independent things can disagree with it, and both are checked rather than assumed:
 *   • the **model** — a custom `OPENAI_EMBED_MODEL` returning a different vector length
 *     (`DbService` probes it once, N1.6);
 *   • the **schema** — a database created by an older build whose columns are a different dimension, or
 *     dimensionless (`checkSchemaVectorDims`, G0.2).
 * Either mismatch disables the DB vector path for the run (`ctx.embeddingDimOk = false`) with a clear
 * warning. Neither destroys data.
 */
export const EMBEDDING_DIM = 4096;

let pool: Pool | null = null;

export function getDbPool(): Pool {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url)
    throw new Error(
      "DATABASE_URL is not set (checked orchestrator/.env and cwd/.env)"
    );
  pool = new Pool({ connectionString: url });
  return pool;
}

export async function dbPing(): Promise<void> {
  await getDbPool().query("select 1 as ok");
}

/* ────────────────────────── schema migrations (G0.2) ────────────────────────── */

/**
 * Minimal query surface shared by `pg`'s `Pool` and `PoolClient` — lets the migration runner and the
 * schema inspectors below be unit-tested offline against a fake client (no Postgres, no Docker).
 */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

export interface Migration {
  version: number;
  name: string;
  /** Executed in order inside one transaction. Must be idempotent (`IF NOT EXISTS`) so that a database
   *  created by a pre-migration build can adopt the baseline as a no-op without losing data. */
  statements: string[];
}

/**
 * Ordered, append-only migration list.
 *
 * ⚠️ **Never edit a shipped migration and never renumber.** To change the schema, append a new version.
 * Version 1 is the historical baseline: every statement is `IF NOT EXISTS`, so applying it to a database
 * created by the old `dbInit()` (which recreated these tables on every start) is a safe no-op that simply
 * records the baseline version.
 *
 * Prior behavior this replaces: `dbInit()` used to `DROP TABLE … CASCADE` five vector tables on **every**
 * process start — destroying all run history, locator baselines, doc chunks, and the QA cache each run.
 * The motivating problem (legacy dimensionless `vector` columns) is now *detected* by
 * `checkSchemaVectorDims` and surfaced as a warning + an explicit opt-in reset, instead of silent data loss.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "baseline-schema",
    statements: [
      `CREATE TABLE IF NOT EXISTS project (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         workspace_path text UNIQUE NOT NULL,
         created_at timestamptz NOT NULL DEFAULT now()
       );`,

      `CREATE TABLE IF NOT EXISTS test_case (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
         title text NOT NULL,
         description text,
         created_at timestamptz NOT NULL DEFAULT now()
       );`,

      `CREATE TABLE IF NOT EXISTS test_step (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         test_case_id uuid NOT NULL REFERENCES test_case(id) ON DELETE CASCADE,
         step_index int NOT NULL,
         action_type text NOT NULL,
         url text,
         intent_text text NOT NULL,
         locator_hint text,
         intent_embedding vector(${EMBEDDING_DIM}),
         created_at timestamptz NOT NULL DEFAULT now()
       );`,

      `CREATE TABLE IF NOT EXISTS test_run (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         project_id uuid NOT NULL REFERENCES project(id),
         started_at timestamptz NOT NULL DEFAULT now(),
         status text NOT NULL
       );`,
      `ALTER TABLE test_run ADD COLUMN IF NOT EXISTS initial_status text;`,
      `ALTER TABLE test_run ADD COLUMN IF NOT EXISTS heal_attempted boolean NOT NULL DEFAULT false;`,
      `ALTER TABLE test_run ADD COLUMN IF NOT EXISTS heal_succeeded boolean NOT NULL DEFAULT false;`,
      `ALTER TABLE test_run ADD COLUMN IF NOT EXISTS ended_at timestamptz;`,
      `ALTER TABLE test_run ADD COLUMN IF NOT EXISTS test_case_id uuid;`,
      `ALTER TABLE test_run ADD COLUMN IF NOT EXISTS json_report_path text;`,
      `ALTER TABLE test_run ADD COLUMN IF NOT EXISTS html_report_path text;`,

      `CREATE TABLE IF NOT EXISTS step_result (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         test_run_id uuid NOT NULL REFERENCES test_run(id) ON DELETE CASCADE,
         test_step_id uuid,
         step_key text,
         status text NOT NULL,
         error_message text,
         screenshot_path text,
         created_at timestamptz NOT NULL DEFAULT now()
       );`,

      `CREATE TABLE IF NOT EXISTS healing_attempt (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         test_run_id uuid NOT NULL REFERENCES test_run(id) ON DELETE CASCADE,
         failed_step_id text,
         old_locator text,
         new_locator text,
         patched_file text,
         succeeded boolean NOT NULL DEFAULT false,
         created_at timestamptz NOT NULL DEFAULT now()
       );`,

      `CREATE TABLE IF NOT EXISTS element_signature (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
         step_key text NOT NULL,
         page_url text NOT NULL,
         role text,
         accessible_name text,
         locator text NOT NULL,
         signature_text text NOT NULL,
         embedding vector(${EMBEDDING_DIM}),
         is_baseline boolean NOT NULL DEFAULT true,
         created_at timestamptz NOT NULL DEFAULT now()
       );`,

      `CREATE TABLE IF NOT EXISTS element_observation (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         test_run_id uuid NOT NULL REFERENCES test_run(id) ON DELETE CASCADE,
         step_key text NOT NULL,
         page_url text NOT NULL,
         role text,
         accessible_name text,
         locator text NOT NULL,
         signature_text text NOT NULL,
         embedding vector(${EMBEDDING_DIM}),
         created_at timestamptz NOT NULL DEFAULT now()
       );`,

      `CREATE TABLE IF NOT EXISTS doc_chunk (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
         source_url text NOT NULL,
         chunk_index int NOT NULL,
         chunk_text text NOT NULL,
         embedding vector(${EMBEDDING_DIM}),
         created_at timestamptz NOT NULL DEFAULT now()
       );`,

      `CREATE TABLE IF NOT EXISTS qa_cache (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
         question text NOT NULL,
         question_embedding vector(${EMBEDDING_DIM}),
         answer_json jsonb NOT NULL,
         sources text[] NOT NULL DEFAULT ARRAY[]::text[],
         hit_count int NOT NULL DEFAULT 0,
         created_at timestamptz NOT NULL DEFAULT now(),
         expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days')
       );`,

      // Note: no vector index on qa_cache.question_embedding — pgvector in Docker doesn't support
      // >2000 dimensions. The table is small, so a sequential scan is fine.
      `CREATE INDEX IF NOT EXISTS idx_qa_cache_project_expires
         ON qa_cache (project_id, expires_at);`,
    ],
  },

  {
    version: 2,
    name: "learning-from-run-history",
    statements: [
      // ── G4.1 ────────────────────────────────────────────────────────────────────────────────────
      // Three counters the engine READS BACK. Everything before this migration was write-only: the
      // system recorded outcomes faithfully and then never consulted them (limitation L4). These tables
      // exist to be queried at decision time, so each is keyed by exactly what the decision needs.
      //
      // ⚠️ Counters, not event logs. A row per attempt would grow without bound and force an aggregate
      // on every read; the decisions here only ever need "how often did this work?", so the row IS the
      // aggregate. `last_seen` lets a future step age evidence out without changing the shape.
      //
      // ⚠️ Nothing here is required for a run. Every write is gated on `ctx.dbEnabled`/`ctx.testRunId`
      // and every read degrades to today's behaviour on an empty table — see G4.6's parity test.

      // How reliable is this locator for this step? Read by UiInspectorAgent when several refs match.
      `CREATE TABLE IF NOT EXISTS locator_stat (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
         step_key text NOT NULL,
         locator text NOT NULL,
         attempts int NOT NULL DEFAULT 0,
         passes int NOT NULL DEFAULT 0,
         last_seen timestamptz NOT NULL DEFAULT now(),
         UNIQUE (project_id, step_key, locator)
       );`,
      `CREATE INDEX IF NOT EXISTS idx_locator_stat_lookup
         ON locator_stat (project_id, step_key);`,

      // Does this golden flow actually produce passing tests? Read by FlowIndex as a ranking prior.
      `CREATE TABLE IF NOT EXISTS flow_stat (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
         flow_key text NOT NULL,
         attempts int NOT NULL DEFAULT 0,
         passes int NOT NULL DEFAULT 0,
         last_seen timestamptz NOT NULL DEFAULT now(),
         UNIQUE (project_id, flow_key)
       );`,
      `CREATE INDEX IF NOT EXISTS idx_flow_stat_lookup
         ON flow_stat (project_id, flow_key);`,

      // Did this particular repair actually work? Read by SelfHealAgent to promote replacements that
      // have healed this step before and demote ones that were tried and still failed.
      //
      // ⚠️ `run_passed_after` is the honest column. `succeeded` on `healing_attempt` means "the patch was
      // applied", which says nothing about whether the test then passed — the 2026-08-11 prompt-14 run
      // applied two patches and failed harder than before (D24). Only the re-run outcome is evidence.
      `CREATE TABLE IF NOT EXISTS heal_feedback (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
         step_key text NOT NULL,
         old_locator text,
         new_locator text NOT NULL,
         strategy text,
         run_passed_after boolean NOT NULL DEFAULT false,
         attempts int NOT NULL DEFAULT 0,
         successes int NOT NULL DEFAULT 0,
         last_seen timestamptz NOT NULL DEFAULT now(),
         UNIQUE (project_id, step_key, new_locator)
       );`,
      `CREATE INDEX IF NOT EXISTS idx_heal_feedback_lookup
         ON heal_feedback (project_id, step_key);`,

      // Flakiness needs per-run outcomes, not a counter — "same spec, mixed results across the last N
      // runs" is a question about a sequence. Kept narrow and indexed for a bounded recent-window read.
      `CREATE TABLE IF NOT EXISTS spec_outcome (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
         spec_path text NOT NULL,
         passed boolean NOT NULL,
         created_at timestamptz NOT NULL DEFAULT now()
       );`,
      `CREATE INDEX IF NOT EXISTS idx_spec_outcome_recent
         ON spec_outcome (project_id, spec_path, created_at DESC);`,
    ],
  },
];

/** Migrations not yet recorded in `schema_migration`, in ascending version order. */
export function pendingMigrations(
  appliedVersions: number[],
  all: Migration[] = MIGRATIONS
): Migration[] {
  const applied = new Set(appliedVersions);
  return all.filter((m) => !applied.has(m.version)).sort((a, b) => a.version - b.version);
}

/**
 * Create the bookkeeping table if needed, then apply every pending migration — each inside its own
 * transaction, so a failure leaves the database on the last fully-applied version rather than half-way
 * through one. Idempotent: a second call applies nothing.
 */
export async function runMigrations(
  db: Queryable,
  all: Migration[] = MIGRATIONS
): Promise<{ applied: number[]; current: number }> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      version int PRIMARY KEY,
      name text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const existing = await db.query(`SELECT version FROM schema_migration`);
  const appliedVersions: number[] = (existing.rows ?? []).map((r: any) => Number(r.version));

  const applied: number[] = [];
  for (const m of pendingMigrations(appliedVersions, all)) {
    await db.query("BEGIN");
    try {
      for (const sql of m.statements) {
        await db.query(sql);
      }
      await db.query(`INSERT INTO schema_migration (version, name) VALUES ($1, $2)`, [
        m.version,
        m.name,
      ]);
      await db.query("COMMIT");
      applied.push(m.version);
    } catch (e) {
      await db.query("ROLLBACK").catch(() => {});
      throw e;
    }
  }

  const known = [...appliedVersions, ...applied];
  return { applied, current: known.length ? Math.max(...known) : 0 };
}

/* ── vector-schema inspection (replaces the old drop-everything "migration") ── */

/** Every `vector(...)` column the schema owns, so a dimension drift can be detected precisely. */
export const VECTOR_COLUMNS: Array<{ table: string; column: string }> = [
  { table: "test_step", column: "intent_embedding" },
  { table: "element_signature", column: "embedding" },
  { table: "element_observation", column: "embedding" },
  { table: "doc_chunk", column: "embedding" },
  { table: "qa_cache", column: "question_embedding" },
];

export interface VectorColumnInfo {
  table: string;
  column: string;
  /** Declared dimension, or null for a legacy dimensionless `vector` column. */
  dim: number | null;
}

/** `"vector(4096)"` → 4096; `"vector"` (legacy, dimensionless) → null. */
export function parseVectorDim(formatType: string): number | null {
  const m = /^vector\s*\(\s*(\d+)\s*\)$/i.exec((formatType ?? "").trim());
  return m ? Number(m[1]) : null;
}

/** Read the declared dimension of every existing `vector` column in the current schema. */
export async function readVectorColumnDims(db: Queryable): Promise<VectorColumnInfo[]> {
  const res = await db.query(`
    SELECT c.relname AS table_name,
           a.attname AS column_name,
           format_type(a.atttypid, a.atttypmod) AS col_type
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_type t ON t.oid = a.atttypid
    WHERE n.nspname = current_schema()
      AND t.typname = 'vector'
      AND a.attnum > 0
      AND NOT a.attisdropped
  `);
  return (res.rows ?? []).map((r: any) => ({
    table: String(r.table_name),
    column: String(r.column_name),
    dim: parseVectorDim(String(r.col_type)),
  }));
}

/**
 * Does the live schema's vector width match what this build writes? A database created by an older build
 * (different `EMBEDDING_DIM`, or dimensionless `vector` columns from a pre-1.0 pgvector) would reject or
 * mis-store inserts. Callers disable the vector path on a mismatch — they must never drop the data.
 * Columns that don't exist yet are not mismatches (the migration will create them correctly).
 */
export async function checkSchemaVectorDims(
  db: Queryable,
  expected: number = EMBEDDING_DIM
): Promise<{ ok: boolean; mismatches: VectorColumnInfo[] }> {
  const found = await readVectorColumnDims(db);
  const owned = new Set(VECTOR_COLUMNS.map((c) => `${c.table}.${c.column}`));
  const mismatches = found.filter(
    (c) => owned.has(`${c.table}.${c.column}`) && c.dim !== expected
  );
  return { ok: mismatches.length === 0, mismatches };
}

/* ────────────────────────── schema init ────────────────────────── */

/**
 * Ensure the extensions exist and every pending migration is applied. Runs on a single pooled client so
 * each migration's BEGIN/COMMIT is a real transaction. Returns which versions were applied this call
 * (empty on every run after the first) so the caller can log it.
 */
export async function dbInit(): Promise<{ applied: number[]; current: number }> {
  const client = await getDbPool().connect();
  try {
    await client.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
    await client.query(`CREATE EXTENSION IF NOT EXISTS vector;`);
    return await runMigrations(client);
  } finally {
    client.release();
  }
}

/** Vector-schema health for the live database (see `checkSchemaVectorDims`). */
export async function dbCheckVectorSchema(): Promise<{
  ok: boolean;
  mismatches: VectorColumnInfo[];
}> {
  return checkSchemaVectorDims(getDbPool());
}

/* ────────────────────────── explicit reset ────────────────────────── */

/**
 * Every table AgenticQA owns, in drop order (dependents first). Used only by `dbReset`.
 */
export const AGENTICQA_TABLES = [
  "qa_cache",
  "doc_chunk",
  "element_observation",
  "element_signature",
  "healing_attempt",
  "step_result",
  "test_step",
  "test_case",
  "test_run",
  "project",
  "schema_migration",
];

/**
 * **Destructive, and only ever called from an explicit user action** (the `AgenticQA: Reset Database`
 * command → the orchestrator's `RESET_DB` message). Drops every AgenticQA table; the next run rebuilds
 * the schema from `MIGRATIONS`. This is the deliberate escape hatch that replaces the implicit
 * drop-on-every-start behavior removed in G0.2 — the fix for a legacy/dimension-mismatched schema.
 */
export async function dbReset(db: Queryable = getDbPool()): Promise<string[]> {
  const dropped: string[] = [];
  for (const table of AGENTICQA_TABLES) {
    await db.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
    dropped.push(table);
  }
  return dropped;
}

/* ────────────────────────── project ────────────────────────── */

export async function getOrCreateProjectId(
  workspacePath: string
): Promise<string> {
  const p = getDbPool();
  const found = await p.query(
    `SELECT id FROM project WHERE workspace_path = $1 LIMIT 1`,
    [workspacePath]
  );
  if (found.rowCount && found.rows[0]?.id) return found.rows[0].id;
  const created = await p.query(
    `INSERT INTO project (workspace_path) VALUES ($1) RETURNING id`,
    [workspacePath]
  );
  return created.rows[0].id;
}

/* ────────────────────────── test_case / test_step ────────────────────────── */

export async function insertTestCase(
  projectId: string,
  title: string,
  description?: string
): Promise<string> {
  const p = getDbPool();
  const res = await p.query(
    `INSERT INTO test_case (project_id, title, description)
     VALUES ($1, $2, $3) RETURNING id`,
    [projectId, title, description ?? null]
  );
  return res.rows[0].id;
}

export async function insertTestStep(input: {
  testCaseId: string;
  stepIndex: number;
  actionType: string;
  url?: string;
  intentText: string;
  locatorHint?: string;
  intentEmbedding?: number[];
}): Promise<string> {
  const p = getDbPool();
  const res = await p.query(
    `INSERT INTO test_step (
       test_case_id, step_index, action_type, url,
       intent_text, locator_hint, intent_embedding
     ) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      input.testCaseId,
      input.stepIndex,
      input.actionType,
      input.url ?? null,
      input.intentText,
      input.locatorHint ?? null,
      input.intentEmbedding ? vectorParam(input.intentEmbedding) : null,
    ]
  );
  return res.rows[0].id;
}

/* ────────────────────────── test_run ────────────────────────── */

export async function createTestRun(
  projectId: string,
  status: string
): Promise<string> {
  const p = getDbPool();
  const res = await p.query(
    `INSERT INTO test_run (project_id, status) VALUES ($1, $2) RETURNING id`,
    [projectId, status]
  );
  return res.rows[0].id;
}

export async function linkTestRunToTestCase(
  testRunId: string,
  testCaseId: string
): Promise<void> {
  const p = getDbPool();
  await p.query(`UPDATE test_run SET test_case_id = $2 WHERE id = $1`, [
    testRunId,
    testCaseId,
  ]);
}

export async function updateTestRunStatus(
  testRunId: string,
  status: string
): Promise<void> {
  const p = getDbPool();
  await p.query(`UPDATE test_run SET status = $2 WHERE id = $1`, [
    testRunId,
    status,
  ]);
}

export async function updateTestRunInitialStatus(
  testRunId: string,
  status: string
): Promise<void> {
  const p = getDbPool();
  await p.query(`UPDATE test_run SET initial_status = $2 WHERE id = $1`, [
    testRunId,
    status,
  ]);
}

export async function updateTestRunReportPaths(
  testRunId: string,
  jsonPath?: string,
  htmlPath?: string
): Promise<void> {
  const p = getDbPool();
  await p.query(
    `UPDATE test_run SET json_report_path = $2, html_report_path = $3 WHERE id = $1`,
    [testRunId, jsonPath ?? null, htmlPath ?? null]
  );
}

export async function markTestRunEnded(
  testRunId: string,
  finalStatus: string
): Promise<void> {
  const p = getDbPool();
  await p.query(
    `UPDATE test_run SET status = $2, ended_at = now() WHERE id = $1`,
    [testRunId, finalStatus]
  );
}

export async function markHealAttempted(testRunId: string): Promise<void> {
  const p = getDbPool();
  await p.query(`UPDATE test_run SET heal_attempted = true WHERE id = $1`, [
    testRunId,
  ]);
}

export async function markHealSucceeded(
  testRunId: string,
  succeeded: boolean
): Promise<void> {
  const p = getDbPool();
  await p.query(`UPDATE test_run SET heal_succeeded = $2 WHERE id = $1`, [
    testRunId,
    succeeded,
  ]);
}

/* ────────────────────────── step_result ────────────────────────── */

export async function deleteStepResultsForRun(
  testRunId: string
): Promise<void> {
  const p = getDbPool();
  await p.query(`DELETE FROM step_result WHERE test_run_id = $1`, [testRunId]);
}

export async function insertStepResult(input: {
  testRunId: string;
  testStepId?: string;
  stepKey?: string;
  status: string;
  errorMessage?: string;
  screenshotPath?: string;
}): Promise<string> {
  const p = getDbPool();
  const res = await p.query(
    `INSERT INTO step_result (
       test_run_id, test_step_id, step_key, status, error_message, screenshot_path
     ) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      input.testRunId,
      input.testStepId ?? null,
      input.stepKey ?? null,
      input.status,
      input.errorMessage ?? null,
      input.screenshotPath ?? null,
    ]
  );
  return res.rows[0].id;
}

export async function getStepResultsForRun(
  testRunId: string
): Promise<
  Array<{
    stepKey: string | null;
    status: string;
    errorMessage: string | null;
  }>
> {
  const p = getDbPool();
  const res = await p.query(
    `SELECT step_key, status, error_message
     FROM step_result WHERE test_run_id = $1
     ORDER BY created_at`,
    [testRunId]
  );
  return res.rows.map((r) => ({
    stepKey: r.step_key,
    status: r.status,
    errorMessage: r.error_message,
  }));
}

export async function getHealingAttemptsForRun(
  testRunId: string
): Promise<
  Array<{
    failedStepId: string | null;
    oldLocator: string | null;
    newLocator: string | null;
    succeeded: boolean;
  }>
> {
  const p = getDbPool();
  const res = await p.query(
    `SELECT failed_step_id, old_locator, new_locator, succeeded
     FROM healing_attempt WHERE test_run_id = $1
     ORDER BY created_at`,
    [testRunId]
  );
  return res.rows.map((r) => ({
    failedStepId: r.failed_step_id,
    oldLocator: r.old_locator,
    newLocator: r.new_locator,
    succeeded: r.succeeded,
  }));
}

/* ────────────────────────── healing_attempt ────────────────────────── */

export async function insertHealingAttempt(input: {
  testRunId: string;
  failedStepId?: string;
  oldLocator?: string;
  newLocator?: string;
  patchedFile?: string;
  succeeded: boolean;
}): Promise<void> {
  const p = getDbPool();
  await p.query(
    `INSERT INTO healing_attempt (
       test_run_id, failed_step_id, old_locator, new_locator, patched_file, succeeded
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.testRunId,
      input.failedStepId ?? null,
      input.oldLocator ?? null,
      input.newLocator ?? null,
      input.patchedFile ?? null,
      input.succeeded,
    ]
  );
}

/* ────────────────────────── element_signature ────────────────────────── */

export async function insertElementSignature(input: {
  projectId: string;
  stepKey: string;
  pageUrl: string;
  role?: string;
  name?: string;
  locator: string;
  signatureText: string;
  embedding: number[];
}): Promise<void> {
  const p = getDbPool();
  await p.query(
    `INSERT INTO element_signature (
       project_id, step_key, page_url, role, accessible_name,
       locator, signature_text, embedding, is_baseline
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)`,
    [
      input.projectId,
      input.stepKey,
      input.pageUrl,
      input.role ?? null,
      input.name ?? null,
      input.locator,
      input.signatureText,
      vectorParam(input.embedding),
    ]
  );
}

export async function getLatestBaselineEmbedding(
  projectId: string,
  stepKey: string
): Promise<number[] | null> {
  const p = getDbPool();
  const res = await p.query(
    `SELECT embedding FROM element_signature
     WHERE project_id = $1 AND step_key = $2 AND is_baseline = true
     ORDER BY created_at DESC LIMIT 1`,
    [projectId, stepKey]
  );
  return parseVector(res.rows?.[0]?.embedding);
}

export async function getLatestBaselineSignature(
  projectId: string,
  stepKey: string
): Promise<{
  pageUrl: string;
  role: string | null;
  accessibleName: string | null;
  embedding: number[] | null;
} | null> {
  const p = getDbPool();
  const res = await p.query(
    `SELECT page_url, role, accessible_name, embedding
     FROM element_signature
     WHERE project_id = $1 AND step_key = $2 AND is_baseline = true
     ORDER BY created_at DESC LIMIT 1`,
    [projectId, stepKey]
  );
  if (!res.rowCount) return null;
  const r = res.rows[0];
  return {
    pageUrl: r.page_url,
    role: r.role ?? null,
    accessibleName: r.accessible_name ?? null,
    embedding: parseVector(r.embedding),
  };
}

export async function promoteNearestObservationToBaseline(input: {
  projectId: string;
  testRunId: string;
  stepKey: string;
}): Promise<boolean> {
  const p = getDbPool();
  const baselineEmb = await getLatestBaselineEmbedding(
    input.projectId,
    input.stepKey
  );
  if (!baselineEmb) return false;

  const obs = await p.query(
    `SELECT page_url, role, accessible_name, locator,
            signature_text, embedding::text AS emb_text
     FROM element_observation
     WHERE test_run_id = $1 AND step_key = $2
     ORDER BY embedding <-> $3
     LIMIT 1`,
    [input.testRunId, input.stepKey, vectorParam(baselineEmb)]
  );

  if (!obs.rowCount) return false;
  const r = obs.rows[0];

  // Retire the prior baseline(s) for this step and insert the promoted one atomically, so exactly
  // one row stays is_baseline=true per (project_id, step_key) — otherwise baselines accumulate
  // (queries still work via ORDER BY created_at DESC, but the table grows unbounded).
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE element_signature SET is_baseline = false
       WHERE project_id = $1 AND step_key = $2 AND is_baseline = true`,
      [input.projectId, input.stepKey]
    );
    await client.query(
      `INSERT INTO element_signature (
         project_id, step_key, page_url, role, accessible_name,
         locator, signature_text, embedding, is_baseline
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, true)`,
      [
        input.projectId,
        input.stepKey,
        r.page_url,
        r.role,
        r.accessible_name,
        r.locator,
        r.signature_text,
        r.emb_text,
      ]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  return true;
}

/* ────────────────────────── element_observation ────────────────────────── */

export async function insertElementObservation(input: {
  testRunId: string;
  stepKey: string;
  pageUrl: string;
  role?: string;
  name?: string;
  locator: string;
  signatureText: string;
  embedding: number[];
}): Promise<void> {
  const p = getDbPool();
  await p.query(
    `INSERT INTO element_observation (
       test_run_id, step_key, page_url, role, accessible_name,
       locator, signature_text, embedding
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      input.testRunId,
      input.stepKey,
      input.pageUrl,
      input.role ?? null,
      input.name ?? null,
      input.locator,
      input.signatureText,
      vectorParam(input.embedding),
    ]
  );
}

export async function findTopNObservations(input: {
  testRunId: string;
  stepKey: string;
  baselineEmbedding: number[];
  limit?: number;
  excludeCurrentRun?: boolean;
}): Promise<
  Array<{
    locator: string;
    role: string | null;
    name: string | null;
    distance: number;
  }>
> {
  const p = getDbPool();
  const limit = input.limit ?? 5;

  let query = `
    SELECT locator, role, accessible_name,
           embedding <-> $3 AS distance
    FROM element_observation
    WHERE step_key = $2
  `;

  const params: any[] = [input.testRunId, input.stepKey, vectorParam(input.baselineEmbedding)];

  // By default, exclude observations from the current test run to avoid picking same wrong candidate
  if (input.excludeCurrentRun !== false) {
    query += ` AND test_run_id != $1`;
    params[0] = input.testRunId;
  } else {
    query += ` AND test_run_id = $1`;
  }

  query += `
    ORDER BY embedding <-> $3
    LIMIT $4
  `;
  params.push(limit);

  const res = await p.query(query, params);
  return res.rows.map((r) => ({
    locator: r.locator,
    role: r.role ?? null,
    name: r.accessible_name ?? null,
    distance: Number(r.distance),
  }));
}

/* ────────────────────────── doc_chunk (Domain QA) ────────────────────────── */

export async function getDocChunkCountForUrl(
  projectId: string,
  sourceUrl: string
): Promise<number> {
  const p = getDbPool();
  const res = await p.query(
    `SELECT COUNT(*)::int AS cnt FROM doc_chunk
     WHERE project_id = $1 AND source_url = $2`,
    [projectId, sourceUrl]
  );
  return Number(res.rows[0]?.cnt ?? 0);
}

export async function insertDocChunk(input: {
  projectId: string;
  sourceUrl: string;
  chunkIndex: number;
  chunkText: string;
  embedding: number[];
}): Promise<void> {
  const p = getDbPool();
  await p.query(
    `INSERT INTO doc_chunk (
       project_id, source_url, chunk_index, chunk_text, embedding
     ) VALUES ($1, $2, $3, $4, $5)`,
    [
      input.projectId,
      input.sourceUrl,
      input.chunkIndex,
      input.chunkText,
      vectorParam(input.embedding),
    ]
  );
}

/** Build the doc_chunk vector-search SQL. When `hasSourceUrl`, the search is scoped to a single
 *  source_url (used to isolate a question's scratch chunks so other questions' chunks can't skew
 *  relevance). Param order: $1 project, $2 query vector, then ($3 source_url, $4 limit) or ($3 limit).
 *  Pure + unit-tested. */
export function buildDocChunkSearchSql(hasSourceUrl: boolean): string {
  return `SELECT chunk_text, source_url,
            embedding <-> $2 AS distance
     FROM doc_chunk
     WHERE project_id = $1${hasSourceUrl ? " AND source_url = $3" : ""}
     ORDER BY embedding <-> $2
     LIMIT $${hasSourceUrl ? 4 : 3}`;
}

export async function searchDocChunks(input: {
  projectId: string;
  queryEmbedding: number[];
  limit?: number;
  /** When set, restrict the search to a single source_url (isolates a question's scratch chunks). */
  sourceUrl?: string;
}): Promise<
  Array<{ chunkText: string; sourceUrl: string; distance: number }>
> {
  const p = getDbPool();
  const hasSourceUrl =
    typeof input.sourceUrl === "string" && input.sourceUrl.length > 0;
  const params: any[] = [input.projectId, vectorParam(input.queryEmbedding)];
  if (hasSourceUrl) params.push(input.sourceUrl);
  params.push(input.limit ?? 5);

  const res = await p.query(buildDocChunkSearchSql(hasSourceUrl), params);
  return res.rows.map((r) => ({
    chunkText: r.chunk_text,
    sourceUrl: r.source_url,
    distance: Number(r.distance),
  }));
}

/** Delete all doc_chunk rows for a (project, source_url) — used to clean up a question's scratch
 *  chunks after answering, so doc_chunk stays ephemeral per-question. Returns the row count removed. */
export async function deleteDocChunksForUrl(
  projectId: string,
  sourceUrl: string
): Promise<number> {
  const p = getDbPool();
  const res = await p.query(
    `DELETE FROM doc_chunk WHERE project_id = $1 AND source_url = $2`,
    [projectId, sourceUrl]
  );
  return res.rowCount || 0;
}

/* ────────────────────────── qa_cache (Domain QA caching) ────────────────────────── */

export async function findCachedQaAnswer(input: {
  projectId: string;
  questionEmbedding: number[];
  similarityThreshold?: number;
}): Promise<{
  answerJson: any;
  sources: string[];
  distance: number;
  hitCount: number;
} | null> {
  const p = getDbPool();
  const threshold = input.similarityThreshold ?? 0.15;

  const res = await p.query(
    `SELECT id, answer_json, sources, hit_count,
            question_embedding <-> $2 AS distance
     FROM qa_cache
     WHERE project_id = $1 
       AND expires_at > now()
       AND (question_embedding <-> $2) < $3
     ORDER BY (question_embedding <-> $2) ASC
     LIMIT 1`,
    [input.projectId, vectorParam(input.questionEmbedding), threshold]
  );

  if (!res.rowCount) return null;

  const row = res.rows[0];
  const cacheId = row.id;

  // Increment hit count
  await p.query(`UPDATE qa_cache SET hit_count = hit_count + 1 WHERE id = $1`, [cacheId]);

  return {
    answerJson: row.answer_json,
    sources: row.sources || [],
    distance: Number(row.distance),
    hitCount: row.hit_count + 1,
  };
}

export async function cacheQaAnswer(input: {
  projectId: string;
  question: string;
  questionEmbedding: number[];
  answerJson: any;
  sources: string[];
}): Promise<void> {
  const p = getDbPool();

  await p.query(
    `INSERT INTO qa_cache (
       project_id, question, question_embedding, answer_json, sources
     ) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    [
      input.projectId,
      input.question,
      vectorParam(input.questionEmbedding),
      JSON.stringify(input.answerJson),
      input.sources,
    ]
  );
}

export async function cleanExpiredQaCache(projectId: string): Promise<number> {
  const p = getDbPool();
  const res = await p.query(
    `DELETE FROM qa_cache WHERE project_id = $1 AND expires_at <= now()`,
    [projectId]
  );
  return res.rowCount || 0;
}

/* ────────────────────────── helpers ────────────────────────── */

function parseVector(val: any): number[] | null {
  if (!val) return null;
  if (Array.isArray(val)) return val.map(Number);
  if (typeof val === "string") {
    const trimmed = val.trim();
    const s = trimmed.startsWith("[") ? trimmed.slice(1, -1) : trimmed;
    if (!s.trim()) return [];
    return s.split(",").map((x) => Number(x.trim()));
  }
  return null;
}

function vectorParam(v: number[]): string {
  return `[${v.join(",")}]`;
}
/* ══════════════════════════════════════════════════════════════════════════════
 * G4 — learning from run history
 *
 * Everything above this line was WRITE-ONLY: the system recorded outcomes faithfully and then never
 * consulted them (limitation L4). These are the first queries whose results change a later decision.
 *
 * Two rules hold for every function here:
 *  1. **Writes are best-effort.** A counter that fails to update must never fail a test run — the run is
 *     the product, the statistics are a side-effect. Callers are already `ctx.dbEnabled`-gated; these
 *     swallow their own errors on top of that.
 *  2. **Reads must be meaningful on an empty table.** With no history the answer has to be "no opinion",
 *     never "zero" — a brand-new locator scoring 0 would lose to anything, which is the opposite of the
 *     intent. Every read below returns `null`/empty rather than a default, and every caller treats that
 *     as "carry on exactly as before". That is what G4.6's parity test locks.
 * ══════════════════════════════════════════════════════════════════════════════ */

/** One `(step, locator)` pair's track record. */
export interface LocatorStat {
  locator: string;
  attempts: number;
  passes: number;
}

/** Record whether a locator worked this run. Upsert, so the row IS the aggregate. */
export async function recordLocatorOutcome(input: {
  projectId: string;
  stepKey: string;
  locator: string;
  passed: boolean;
}): Promise<void> {
  try {
    const p = getDbPool();
    await p.query(
      `INSERT INTO locator_stat (project_id, step_key, locator, attempts, passes, last_seen)
       VALUES ($1, $2, $3, 1, $4, now())
       ON CONFLICT (project_id, step_key, locator) DO UPDATE
         SET attempts = locator_stat.attempts + 1,
             passes   = locator_stat.passes + $4,
             last_seen = now()`,
      [input.projectId, input.stepKey, input.locator, input.passed ? 1 : 0]
    );
  } catch {
    /* statistics must never fail a run */
  }
}

/** Track records for a step's known locators. Empty when nothing has been recorded. */
export async function getLocatorStats(
  projectId: string,
  stepKey: string
): Promise<LocatorStat[]> {
  try {
    const p = getDbPool();
    const res = await p.query(
      `SELECT locator, attempts, passes FROM locator_stat
        WHERE project_id = $1 AND step_key = $2`,
      [projectId, stepKey]
    );
    return (res.rows ?? []).map((r: any) => ({
      locator: String(r.locator),
      attempts: Number(r.attempts),
      passes: Number(r.passes),
    }));
  } catch {
    return [];
  }
}

/** One golden flow's track record as a plan source. */
export interface FlowStat {
  flowKey: string;
  attempts: number;
  passes: number;
}

export async function recordFlowOutcome(input: {
  projectId: string;
  flowKey: string;
  passed: boolean;
}): Promise<void> {
  try {
    const p = getDbPool();
    await p.query(
      `INSERT INTO flow_stat (project_id, flow_key, attempts, passes, last_seen)
       VALUES ($1, $2, 1, $3, now())
       ON CONFLICT (project_id, flow_key) DO UPDATE
         SET attempts = flow_stat.attempts + 1,
             passes   = flow_stat.passes + $3,
             last_seen = now()`,
      [input.projectId, input.flowKey, input.passed ? 1 : 0]
    );
  } catch {
    /* statistics must never fail a run */
  }
}

/** Every flow's track record for a project, keyed by flow key. Empty map when there is no history. */
export async function getFlowStats(projectId: string): Promise<Map<string, FlowStat>> {
  const out = new Map<string, FlowStat>();
  try {
    const p = getDbPool();
    const res = await p.query(
      `SELECT flow_key, attempts, passes FROM flow_stat WHERE project_id = $1`,
      [projectId]
    );
    for (const r of res.rows ?? []) {
      out.set(String(r.flow_key), {
        flowKey: String(r.flow_key),
        attempts: Number(r.attempts),
        passes: Number(r.passes),
      });
    }
  } catch {
    /* no history is a valid answer */
  }
  return out;
}

/** A replacement locator's track record for one step. */
export interface HealFeedback {
  newLocator: string;
  attempts: number;
  successes: number;
}

/**
 * Record a heal and — crucially — whether the **re-run then passed**.
 *
 * ⚠️ `healing_attempt.succeeded` already existed and means "the patch was applied", which is not evidence
 * of anything: the 2026-08-11 prompt-14 run applied two patches and failed harder than before (D24). Only
 * the re-run outcome tells you whether a replacement was right, so that is what this table stores.
 */
export async function recordHealOutcome(input: {
  projectId: string;
  stepKey: string;
  oldLocator?: string | null;
  newLocator: string;
  strategy?: string | null;
  runPassedAfter: boolean;
}): Promise<void> {
  try {
    const p = getDbPool();
    await p.query(
      `INSERT INTO heal_feedback (
         project_id, step_key, old_locator, new_locator, strategy,
         run_passed_after, attempts, successes, last_seen
       ) VALUES ($1, $2, $3, $4, $5, $6, 1, $7, now())
       ON CONFLICT (project_id, step_key, new_locator) DO UPDATE
         SET attempts = heal_feedback.attempts + 1,
             successes = heal_feedback.successes + $7,
             run_passed_after = $6,
             strategy = COALESCE(EXCLUDED.strategy, heal_feedback.strategy),
             last_seen = now()`,
      [
        input.projectId,
        input.stepKey,
        input.oldLocator ?? null,
        input.newLocator,
        input.strategy ?? null,
        input.runPassedAfter,
        input.runPassedAfter ? 1 : 0,
      ]
    );
  } catch {
    /* statistics must never fail a run */
  }
}

/** What previous heals of this step taught us, keyed by replacement locator. */
export async function getHealFeedback(
  projectId: string,
  stepKey: string
): Promise<Map<string, HealFeedback>> {
  const out = new Map<string, HealFeedback>();
  try {
    const p = getDbPool();
    const res = await p.query(
      `SELECT new_locator, attempts, successes FROM heal_feedback
        WHERE project_id = $1 AND step_key = $2`,
      [projectId, stepKey]
    );
    for (const r of res.rows ?? []) {
      out.set(String(r.new_locator), {
        newLocator: String(r.new_locator),
        attempts: Number(r.attempts),
        successes: Number(r.successes),
      });
    }
  } catch {
    /* no history is a valid answer */
  }
  return out;
}

/** Append one spec-level outcome. Flakiness is a question about a sequence, so this is not a counter. */
export async function recordSpecOutcome(input: {
  projectId: string;
  specPath: string;
  passed: boolean;
}): Promise<void> {
  try {
    const p = getDbPool();
    await p.query(
      `INSERT INTO spec_outcome (project_id, spec_path, passed) VALUES ($1, $2, $3)`,
      [input.projectId, input.specPath, input.passed]
    );
  } catch {
    /* statistics must never fail a run */
  }
}

/** The most recent `limit` outcomes for a spec, newest first. */
export async function getRecentSpecOutcomes(
  projectId: string,
  specPath: string,
  limit = 10
): Promise<boolean[]> {
  try {
    const p = getDbPool();
    const res = await p.query(
      `SELECT passed FROM spec_outcome
        WHERE project_id = $1 AND spec_path = $2
        ORDER BY created_at DESC
        LIMIT $3`,
      [projectId, specPath, limit]
    );
    return (res.rows ?? []).map((r: any) => Boolean(r.passed));
  } catch {
    return [];
  }
}
