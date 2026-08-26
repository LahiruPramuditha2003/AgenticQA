import { Logger, RunContext } from "../agent/types";
import {
  dbPing,
  dbInit,
  dbCheckVectorSchema,
  getOrCreateProjectId,
  createTestRun,
  EMBEDDING_DIM,
} from "../db/db";
import { EmbeddingClient } from "../llm/EmbeddingClient";

export class DbService {
  async apply(ctx: RunContext, logger: Logger): Promise<void> {
    ctx.dbEnabled = false;

    if (!process.env.DATABASE_URL) {
      logger.log(
        "DB: DATABASE_URL not set — running without a database. Test generation and execution work normally; self-healing, run history, and locator baselines are disabled."
      );
      return;
    }

    logger.log("DB: connecting...");
    try {
      await dbPing();
      logger.log("DB: connected");

      const { applied, current } = await dbInit();
      logger.log(
        applied.length
          ? `DB: applied migration(s) ${applied.join(", ")} — schema now at v${current}`
          : `DB: schema up to date (v${current})`
      );

      const projectId = await getOrCreateProjectId(ctx.workspacePath);
      ctx.projectId = projectId;
      logger.log(`DB: projectId=${projectId}`);

      const testRunId = await createTestRun(projectId, "created");
      ctx.testRunId = testRunId;
      logger.log(`DB: testRunId=${testRunId}`);

      ctx.dbEnabled = true;

      // ── Embedding-dimension safety: TWO independent things can disagree with EMBEDDING_DIM. ──
      // Either one disables the DB vector path for this run (deterministic self-heal + run history keep
      // working); neither destroys data.

      // (a) SCHEMA (G0.2): a database created by an older build may have differently-sized — or legacy
      // dimensionless — vector columns. Before G0.2 this was "handled" by dropping the tables on every
      // start; now it is detected and reported, and the user chooses when to reset.
      let schemaVectorOk = true;
      try {
        const check = await dbCheckVectorSchema();
        schemaVectorOk = check.ok;
        if (!check.ok) {
          const detail = check.mismatches
            .map((m) => `${m.table}.${m.column}=${m.dim ?? "dimensionless"}`)
            .join(", ");
          logger.log(
            `DB: ⚠ existing schema's vector columns don't match this build (expected ${EMBEDDING_DIM}; found ${detail}). ` +
              `Vector features (intent embeddings, vector self-heal, doc-chunk search) are DISABLED for this run. ` +
              `Your data is untouched — run the "AgenticQA: Reset Database" command to rebuild the schema.`
          );
        }
      } catch (e: any) {
        // Inspection failed (permissions/unexpected catalog shape) — don't block the run.
        logger.log(`DB: vector-schema check skipped — ${e?.message ?? String(e)}`);
      }

      // (b) MODEL (N1.6): a custom OPENAI_EMBED_MODEL returning a different vector length would otherwise
      // crash the first vector insert mid-run. Probe once.
      const embedder = new EmbeddingClient();
      if (!schemaVectorOk) {
        ctx.embeddingDimOk = false;
      } else if (embedder.isConfigured()) {
        try {
          const probe = await embedder.embedOne("dimension probe");
          ctx.embeddingDimOk = probe.length === EMBEDDING_DIM;
          if (!ctx.embeddingDimOk) {
            logger.log(
              `DB: ⚠ the configured embed model returns ${probe.length}-dim vectors but the database expects ${EMBEDDING_DIM}. ` +
                `Vector features (intent embeddings, vector self-heal, doc-chunk search) are DISABLED for this run. ` +
                `Use the default embed model, or run with the DB off — deterministic self-heal still works.`
            );
          }
        } catch (e: any) {
          // Probe failed (network/key) — leave individual vector calls to their existing try/catch paths.
          logger.log(`DB: embedding-dimension probe skipped — ${e?.message ?? String(e)}`);
        }
      }
    } catch (e: any) {
      // Degrade gracefully: a missing/unreachable DB must not abort the pipeline.
      ctx.dbEnabled = false;
      ctx.projectId = undefined;
      ctx.testRunId = undefined;
      logger.log(
        `DB: connection failed — ${e?.message ?? String(e)}. Continuing without a database (self-healing, run history, and locator baselines disabled).`
      );
    }
  }
}