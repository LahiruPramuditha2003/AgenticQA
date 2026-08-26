#!/usr/bin/env node
/**
 * Copy agent prompt files into the build output (G0.4).
 *
 * `tsc` only emits `.ts`/`.json`, so `src/**\/prompts/*.md` would never reach `dist/` — and the loader
 * resolves against `dist/` at runtime.
 *
 * TWO layouts are emitted, because the same code runs in two very different shapes (R1.1b):
 *
 *   1. `dist/agents/<Agent>/prompts/system.md`  — the tsc build, mirroring `src/`.
 *   2. `dist/prompts/<Agent>/system.md`         — the FLAT layout, which is the one the release bundle
 *      uses. esbuild collapses every agent into a single file, so there is no per-agent directory left
 *      to resolve against; prompts must sit in one predictable place beside the bundle.
 *
 * Emitting both here (rather than only in the extension's packaging script) keeps the two builds honest:
 * `test/loadPrompt.test.js` exercises the flat layout from an ordinary `npm run build`, so a packaging
 * change cannot be the first thing to discover that the flat tree is missing.
 *
 * Runs automatically as part of `npm run build`.
 */

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const srcDir = path.join(root, "src");
const outDir = path.join(root, "dist");

/** Every `*.md` under a directory named `prompts`, as paths relative to `src/`. */
function findPromptFiles(dir, rel = "") {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const relPath = rel ? path.join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) {
      out.push(...findPromptFiles(abs, relPath));
    } else if (entry.isFile() && entry.name.endsWith(".md") && path.basename(rel) === "prompts") {
      out.push(relPath);
    }
  }
  return out;
}

/** `agents/DomainQaAgent/prompts/system.md` -> `DomainQaAgent`. */
function agentNameFor(rel) {
  const parts = rel.split(path.sep);
  const i = parts.lastIndexOf("prompts");
  return i > 0 ? parts[i - 1] : null;
}

const files = findPromptFiles(srcDir);
let copied = 0;
let flat = 0;
for (const rel of files) {
  const from = path.join(srcDir, rel);

  // Layout 1 — mirror src/ (tsc build).
  const to = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  copied++;

  // Layout 2 — flat, keyed by agent name (release bundle).
  const agent = agentNameFor(rel);
  if (agent) {
    const flatTo = path.join(outDir, "prompts", agent, path.basename(rel));
    fs.mkdirSync(path.dirname(flatTo), { recursive: true });
    fs.copyFileSync(from, flatTo);
    flat++;
  }
}

console.log(
  copied > 0
    ? `copyPrompts: copied ${copied} prompt file(s) to dist/ (+${flat} into the flat dist/prompts/ layout)`
    : "copyPrompts: no prompt files found (nothing to copy)"
);
