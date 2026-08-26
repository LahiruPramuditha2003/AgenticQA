#!/usr/bin/env node
/**
 * Bundle the AgenticQA engine INTO the extension (R2.1 + R2.2).
 *
 * WHY THIS EXISTS
 * ---------------
 * `extension.ts` used to resolve the engine at `<extensionPath>/../orchestrator/dist/main.js` — a sibling
 * directory that exists only in this monorepo. A normally installed extension lives in
 * `~/.vscode/extensions/<publisher>.<name>-<version>/`, whose parent is the extensions folder, so a
 * `.vsix` install could not run at all (blocker B1). This script produces the thing that makes a
 * packaged install work:
 *
 *   dist/orchestrator.js                  the whole engine, one CJS file
 *   dist/prompts/<Agent>/system.md        the shipped agent prompts, flat layout
 *   dist/node_modules/@playwright/mcp/**  the one dependency that CANNOT be inlined, plus its tree
 *
 * WHY @playwright/mcp IS EXTERNAL
 * -------------------------------
 * `PlaywrightMcpClient` resolves it with `require.resolve("@playwright/mcp/package.json")` and then
 * **spawns `cli.js` as a child process**. A bundler cannot inline a program that is executed as a
 * separate process, so it has to exist as real files on disk. Everything else the engine imports
 * (`openai`, `pg`, `zod`, `dotenv`, `@modelcontextprotocol/sdk`) is an ordinary import and inlines.
 *
 * ⚠️ They go in **`dist/node_modules/`**, which is the FIRST place Node looks when resolving from
 * `dist/orchestrator.js` — and, unlike the extension's own `node_modules/`, it is a plain build artifact
 * that `vsce package --no-dependencies` will happily ship.
 *
 * That flag is not optional. Without it vsce walks the npm dependency graph, which in a workspace
 * monorepo escapes the extension directory entirely: a trial package pulled in `../../node_modules/
 * agenticqa` (the workspace symlink pointing back here) and, through it, **`packages/orchestrator/.env`
 * — a real API key**. vsce's own env-file check caught that one, but relying on a single guard for a
 * secret is not a design. With `--no-dependencies` nothing outside this directory is even considered.
 *
 * WHY A STAGING INSTALL RATHER THAN COPYING FOLDERS
 * ------------------------------------------------
 * npm workspaces hoist everything to the REPO ROOT `node_modules`, where `vsce` does not look — and
 * hand-copying `@playwright/mcp` would silently drop its transitive dependencies. So we write a throwaway
 * `package.json` containing only that one dependency at the version the orchestrator pins, let npm
 * resolve the real tree, and copy the result.
 *
 *   node scripts/build-engine.js [--production] [--skip-deps]
 *
 * `--skip-deps` bundles the engine but leaves `node_modules` alone — for fast iteration, since the
 * dependency stage is the slow part and its output rarely changes.
 */

const esbuild = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const production = process.argv.includes("--production");
const skipDeps = process.argv.includes("--skip-deps");

const EXT_ROOT = path.resolve(__dirname, "..");
const ORCH_ROOT = path.resolve(EXT_ROOT, "..", "orchestrator");

/**
 * Packages the bundle must NOT inline.
 *
 * Keep this list minimal and justified. Every entry is weight in the `.vsix` and a resolution that has to
 * work at runtime, so "just in case" belongs nowhere near it.
 */
const EXTERNALS = [
  // Spawned as a child process (see header). Pulls in playwright-core.
  "@playwright/mcp",
];

function log(msg) {
  console.log(`[build-engine] ${msg}`);
}

/* ────────────────────────────── 1. bundle the engine ────────────────────────────── */

async function bundleEngine() {
  const entry = path.join(ORCH_ROOT, "src", "main.ts");
  if (!fs.existsSync(entry)) {
    throw new Error(`Engine entry point not found: ${entry}`);
  }

  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    // The orchestrator's tsconfig is already `module: CommonJS`, so there is no ESM/CJS interop risk.
    format: "cjs",
    platform: "node",
    // Match the Node that ships inside the supported VS Code range.
    target: "node20",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    outfile: path.join(EXT_ROOT, "dist", "orchestrator.js"),
    external: EXTERNALS,
    logLevel: "silent",
    metafile: true,
  });

  const outSize = fs.statSync(path.join(EXT_ROOT, "dist", "orchestrator.js")).size;
  log(`bundled engine -> dist/orchestrator.js (${(outSize / 1024 / 1024).toFixed(2)} MB)`);
  return result;
}

/* ────────────────────────────── 2. copy the prompts ────────────────────────────── */

/**
 * Copy `src/agents/<Agent>/prompts/*.md` into `dist/prompts/<Agent>/`.
 *
 * The FLAT layout is mandatory for the bundle: esbuild collapses every agent into one file, so `__dirname`
 * is identical for all of them and there is no per-agent directory left to resolve against. This mirrors
 * what the orchestrator's own `copyPrompts.js` emits, so the two builds cannot disagree about the shape.
 */
function copyPrompts() {
  const srcAgents = path.join(ORCH_ROOT, "src", "agents");
  const outRoot = path.join(EXT_ROOT, "dist", "prompts");
  fs.rmSync(outRoot, { recursive: true, force: true });

  let count = 0;
  for (const entry of fs.readdirSync(srcAgents, { withFileTypes: true })) {
    if (!entry.isDirectory()) {continue;}
    const promptsDir = path.join(srcAgents, entry.name, "prompts");
    if (!fs.existsSync(promptsDir)) {continue;}
    for (const file of fs.readdirSync(promptsDir)) {
      if (!file.endsWith(".md")) {continue;}
      const to = path.join(outRoot, entry.name, file);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(promptsDir, file), to);
      count++;
    }
  }

  if (count === 0) {
    // An engine with no prompts throws on its first LLM call, by design. Better to fail the build.
    throw new Error(
      "No agent prompts were found to copy. The bundled engine would throw on its first LLM call."
    );
  }
  log(`copied ${count} prompt file(s) -> dist/prompts/<Agent>/`);
}

/* ──────────────────── 3. stage the externals into node_modules ──────────────────── */

/** The version the ORCHESTRATOR pins. Never hardcode it here — the two would drift. */
function pinnedVersion(pkg) {
  const orchPkg = JSON.parse(fs.readFileSync(path.join(ORCH_ROOT, "package.json"), "utf8"));
  const version = orchPkg.dependencies?.[pkg] ?? orchPkg.devDependencies?.[pkg];
  if (!version) {
    throw new Error(`${pkg} is listed as an engine external but the orchestrator does not depend on it.`);
  }
  return version;
}

function stageExternals() {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "agenticqa-engine-deps-"));
  const deps = Object.fromEntries(EXTERNALS.map((p) => [p, pinnedVersion(p)]));

  fs.writeFileSync(
    path.join(staging, "package.json"),
    JSON.stringify({ name: "agenticqa-engine-deps", version: "1.0.0", private: true, dependencies: deps }, null, 2)
  );

  log(`resolving engine dependencies (${Object.entries(deps).map(([k, v]) => `${k}@${v}`).join(", ")})…`);
  const res = spawnSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--silent"], {
    cwd: staging,
    stdio: "inherit",
    shell: true,
  });
  if (res.status !== 0) {
    throw new Error("npm install failed while staging engine dependencies");
  }

  const from = path.join(staging, "node_modules");
  const to = path.join(EXT_ROOT, "dist", "node_modules");

  // `dist/node_modules` holds nothing but these packages, so it is safe to rebuild from scratch —
  // no stale package from a previous dependency set can survive into a release.
  fs.rmSync(to, { recursive: true, force: true });
  const staged = [];
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === ".package-lock.json" || entry.name === ".bin") {continue;}
    if (entry.name.startsWith("@")) {
      for (const scoped of fs.readdirSync(path.join(from, entry.name))) {
        staged.push(path.join(entry.name, scoped).replace(/\\/g, "/"));
      }
    } else {
      staged.push(entry.name);
    }
  }

  for (const rel of staged) {
    const dest = path.join(to, rel);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(path.join(from, rel), dest, { recursive: true });
  }

  // Record exactly what ships, so the packaged contents are reviewable in a diff rather than being
  // whatever npm resolved on the day someone happened to build a release.
  const manifest = staged
    .map((rel) => {
      let version = "unknown";
      try {
        version = JSON.parse(fs.readFileSync(path.join(to, rel, "package.json"), "utf8")).version;
      } catch {
        /* not every directory is a package */
      }
      return { package: rel, version };
    })
    .sort((a, b) => a.package.localeCompare(b.package));

  fs.writeFileSync(
    path.join(EXT_ROOT, "engine-deps.lock.json"),
    JSON.stringify({ externals: EXTERNALS, resolved: manifest }, null, 2) + "\n"
  );

  fs.rmSync(staging, { recursive: true, force: true });
  log(`staged ${manifest.length} package(s) into dist/node_modules/ (see engine-deps.lock.json)`);
  return manifest;
}

/* ────────────────────────────── 4. verify ────────────────────────────── */

/**
 * Prove the bundle actually runs BEFORE it is packaged.
 *
 * A `.vsix` that installs and then does nothing is the single most likely failure mode here, and it is
 * invisible to every other check in this repo: the sources compile, the tests pass, and the extension
 * loads. Spawning the real bundle and waiting for its READY handshake is the only thing that catches an
 * external that failed to resolve or a prompt tree that did not ship.
 */
function verifyBundle() {
  const enginePath = path.join(EXT_ROOT, "dist", "orchestrator.js");

  // (a) Every external must resolve FROM THE BUNDLE'S OWN LOCATION. Node walks up from the requiring
  // file, so this is the real question: `<ext>/dist/node_modules` then `<ext>/node_modules`. Getting it
  // wrong is silent until the first page inspection, where it surfaces as an MCP connect timeout —
  // exactly how defect D11 hid for weeks behind an npx fallback.
  const bundleRequire = require("node:module").createRequire(enginePath);
  for (const ext of EXTERNALS) {
    let resolved;
    try {
      resolved = bundleRequire.resolve(`${ext}/package.json`);
    } catch (e) {
      throw new Error(
        `external "${ext}" does not resolve from ${enginePath}. ` +
          `It must live in <extension>/node_modules/. (${e?.message ?? e})`
      );
    }
    if (ext === "@playwright/mcp" && !fs.existsSync(path.join(path.dirname(resolved), "cli.js"))) {
      throw new Error("@playwright/mcp resolved but cli.js is missing — the engine spawns that file.");
    }
  }
  log(`verified: ${EXTERNALS.length} external(s) resolve from the bundle`);

  // (b) Every agent that has a prompt in source must have one beside the bundle. With the engine
  // collapsed into a single file, `__dirname` is `<ext>/dist` for ALL agents, so this flat tree is the
  // only thing the loader can find. A missing prompt throws on the first LLM call, not at startup, so
  // nothing below would catch it.
  const srcAgents = path.join(ORCH_ROOT, "src", "agents");
  for (const entry of fs.readdirSync(srcAgents, { withFileTypes: true })) {
    if (!entry.isDirectory()) {continue;}
    if (!fs.existsSync(path.join(srcAgents, entry.name, "prompts", "system.md"))) {continue;}
    const shipped = path.join(EXT_ROOT, "dist", "prompts", entry.name, "system.md");
    if (!fs.existsSync(shipped)) {
      throw new Error(`${entry.name} has a prompt in source but none at ${shipped}`);
    }
  }
  log("verified: every agent prompt is present in the flat dist/prompts/ layout");

  const res = spawnSync(process.execPath, [enginePath], {
    input: JSON.stringify({ type: "PING" }) + "\n",
    encoding: "utf8",
    timeout: 60000,
    cwd: EXT_ROOT,
  });

  const lines = (res.stdout || "").split("\n").filter((l) => l.trim());
  const parsed = lines.map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      throw new Error(`bundled engine wrote non-JSON to stdout: ${JSON.stringify(l)}`);
    }
  });

  if (!parsed.some((m) => m.type === "READY")) {
    throw new Error(
      `bundled engine did not emit READY.\nstdout: ${res.stdout}\nstderr: ${(res.stderr || "").slice(0, 2000)}`
    );
  }
  if (!parsed.some((m) => m.type === "PONG")) {
    throw new Error(`bundled engine did not answer PING with PONG.\nstdout: ${res.stdout}`);
  }
  log("verified: bundled engine emits READY and answers PING -> PONG");

  // (d) Nothing that looks like a secret may be inside the packaged tree. vsce has its own `.env`
  // check, and `.vscodeignore` excludes them, and `--no-dependencies` stops the graph walk that found
  // one — this is the fourth guard, and it is here because the cost of being wrong once is unbounded.
  const suspicious = [];
  const walk = (dir, rel = "") => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(path.join(dir, e.name), r);
      } else if (/(^|\/)\.env($|\.)|\.pem$|\.key$|(^|\/)id_rsa/.test(r)) {
        suspicious.push(`dist/${r}`);
      }
    }
  };
  walk(path.join(EXT_ROOT, "dist"));
  if (suspicious.length) {
    throw new Error(`secret-looking files inside dist/: ${suspicious.join(", ")}`);
  }
  log("verified: no secret-shaped files inside dist/");
}

/* ────────────────────────────── main ────────────────────────────── */

async function main() {
  await bundleEngine();
  copyPrompts();
  if (!skipDeps) {
    stageExternals();
  } else {
    log("skipping dependency staging (--skip-deps)");
  }
  verifyBundle();
  log("engine build complete");
}

main().catch((e) => {
  console.error(`[build-engine] FAILED: ${e?.message ?? e}`);
  process.exit(1);
});
