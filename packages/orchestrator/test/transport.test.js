"use strict";
/**
 * The stdio transport and per-user state paths (R1.9, from the R0.4 release sweep).
 *
 * Both of these are invariants that only *matter* once the orchestrator is packaged inside the
 * extension (R2), and both would fail silently rather than loudly — which is exactly why they are
 * pinned here rather than discovered during packaging.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ORCH_ROOT = path.resolve(__dirname, "..");

test("stdout carries ONLY protocol lines, even when something calls console.log", () => {
  // The extension parses stdout as newline-delimited JSON. One stray character desynchronises it and
  // the run presents as garbage rather than as an error. The orchestrator's own source is clean today,
  // but R2 inlines openai/pg/zod/dotenv/mcp-sdk into the same process — this asserts the transport is
  // immune by construction rather than by five dependencies staying quiet forever.
  const res = spawnSync(
    process.execPath,
    ["-e", 'require("./dist/main.js"); console.log("LEAK"); console.info("LEAK2"); console.debug("LEAK3");'],
    { cwd: ORCH_ROOT, encoding: "utf8", timeout: 30000 }
  );

  const lines = (res.stdout || "").split("\n").filter((l) => l.trim().length > 0);
  for (const line of lines) {
    assert.doesNotThrow(
      () => JSON.parse(line),
      `stdout must be pure NDJSON, but this line is not JSON: ${JSON.stringify(line)}`
    );
  }
  assert.ok(
    lines.some((l) => JSON.parse(l).type === "READY"),
    "the READY handshake must still be emitted"
  );
  assert.ok(!(res.stdout || "").includes("LEAK"), "console output must never reach stdout");

  // Redirected, not silenced. A log the user cannot see is its own defect.
  const err = res.stderr || "";
  for (const marker of ["LEAK", "LEAK2", "LEAK3"]) {
    assert.ok(err.includes(marker), `${marker} should be visible on stderr`);
  }
});

test("D44: the embeddings cache honours AGENTICQA_CACHE_DIR, and resolves lazily", () => {
  const { cachePath } = require("../dist/knowledge/RagPlannerEngine.js");
  const saved = process.env.AGENTICQA_CACHE_DIR;
  try {
    // Default: beside the module. This is the monorepo-dev path and must not change.
    delete process.env.AGENTICQA_CACHE_DIR;
    const fallback = cachePath();
    assert.strictEqual(path.basename(fallback), "embeddings-cache.json");

    // Configured: wherever the extension says. `globalStorageUri` survives an extension update; the
    // install directory it used to use does not.
    process.env.AGENTICQA_CACHE_DIR = path.join("X:", "storage");
    assert.strictEqual(cachePath(), path.join("X:", "storage", "embeddings-cache.json"));

    // Lazy, not module-load. `main.ts` runs dotenv AFTER its imports, so a constant captured at import
    // time would read an empty environment — the trap that made DEFAULT_MODELS a Proxy.
    process.env.AGENTICQA_CACHE_DIR = path.join("Y:", "later");
    assert.strictEqual(
      cachePath(),
      path.join("Y:", "later", "embeddings-cache.json"),
      "cachePath must re-read the environment on every call"
    );

    // Blank is treated as unset, not as the current directory.
    process.env.AGENTICQA_CACHE_DIR = "   ";
    assert.strictEqual(cachePath(), fallback);
  } finally {
    if (saved === undefined) {delete process.env.AGENTICQA_CACHE_DIR;}
    else {process.env.AGENTICQA_CACHE_DIR = saved;}
  }
});
