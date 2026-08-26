"use strict";
/**
 * Source hygiene: no stray control characters in checked-in source.
 *
 * WHY THIS EXISTS — it caught a real, invisible bug twice.
 *
 * A regex written as `/\b(date|due)\b/` was saved with `\b` as an actual **backspace byte (0x08)**
 * instead of the two-character escape, because the tool that wrote it used a non-raw string. The file
 * *looked* correct in every editor and in terminal output — backspaces render as nothing — but the
 * pattern could never match, so `sampleValueFor("Due date")` returned the generic `"Test value"`,
 * Playwright rejected it on an `<input type="date">`, and TaskFlow's Create Task flow failed validation.
 * The generated knowledge pack then shipped with no way to test the app's central workflow.
 *
 * The same mistake also put `\x00`/`\x01`/`\x02` into `FlowEmbeddings.ts` as hash separators, which made
 * grep treat the file as binary — a clue that went unexamined for a while.
 *
 * Tabs, newlines and carriage returns are allowed; nothing else below 0x20 is.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOTS = [
  path.join(__dirname, "..", "src"),
  path.join(__dirname, "..", "scripts"),
  __dirname,
  path.join(__dirname, "..", "..", "agenticqa", "src"),
];
const EXTS = new Set([".ts", ".js", ".json", ".md"]);
const ALLOWED = new Set([0x09, 0x0a, 0x0d]); // tab, LF, CR

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === "dist" || e.name === "fixtures") {continue;}
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {yield* walk(full);}
    else if (EXTS.has(path.extname(e.name))) {yield full;}
  }
}

test("no stray control characters in checked-in source", () => {
  const offenders = [];
  for (const root of ROOTS) {
    for (const file of walk(root)) {
      const buf = fs.readFileSync(file);
      const found = new Set();
      let line = 1;
      let firstLine = null;
      for (const byte of buf) {
        if (byte === 0x0a) {line++; continue;}
        if (byte < 0x20 && !ALLOWED.has(byte)) {
          found.add(byte);
          if (firstLine === null) {firstLine = line;}
        }
      }
      if (found.size) {
        offenders.push(
          `${path.relative(path.join(__dirname, "..", "..", ".."), file)} ` +
            `(line ~${firstLine}: ${[...found].map((b) => "0x" + b.toString(16)).join(", ")})`
        );
      }
    }
  }
  assert.deepStrictEqual(
    offenders,
    [],
    "Control characters found. Almost always a `\\b`/`\\0`/`\\1` escape that got interpreted by the " +
      "tool that wrote the file instead of being written literally. They are INVISIBLE in editors, so " +
      "the code looks right and silently misbehaves:\n  " + offenders.join("\n  ")
  );
});

test("the date-field regex actually works (the bug this guard was written for)", () => {
  const { sampleValueFor } = require("../dist/core/explore/synthesizeFlows.js");
  assert.strictEqual(sampleValueFor("Due date"), "2026-12-31");
  assert.strictEqual(sampleValueFor("Start Date"), "2026-12-31");
  // The word-boundary must be real: "update" contains "date" but is not a date field.
  assert.strictEqual(sampleValueFor("Update note"), "Test value");
  assert.strictEqual(sampleValueFor("Candidate"), "Test value");
});

/**
 * No live API keys in anything committed.
 *
 * WHY THIS EXISTS — defect D3. A real OpenRouter key reached `.env.example` and is still in this
 * repository's git history at three commits, on a GitHub remote. Editing the file did not revoke it;
 * only rotation does. This guard cannot clean history, but it stops the *next* one getting in, which is
 * the only part a test can own.
 *
 * The rule is shape-based: a known key prefix followed by a long run of key-ish characters. Every
 * placeholder in `.env.example` (`nvapi-YOUR_KEY_HERE`, `sk-or-v1-YOUR_KEY_HERE`, `ctx7sk-YOUR_KEY_HERE`)
 * is deliberately exempt, because it contains `_`, which real keys of these formats do not.
 */
test("no live-looking API keys in committed files", () => {
  const SECRET_RE =
    /\b(sk-or-v1-|nvapi-|ctx7sk-|sk-ant-|sk-proj-)[A-Za-z0-9][A-Za-z0-9-]{19,}/g;

  const roots = [
    path.join(__dirname, "..", "src"),
    path.join(__dirname, "..", "scripts"),
    __dirname,
    path.join(__dirname, "..", ".env.example"),
    path.join(__dirname, "..", "..", "agenticqa", "src"),
    path.join(__dirname, "..", "..", "agenticqa", "scripts"),
    // Documentation is where a key is most likely to be pasted by accident — someone illustrating a
    // config block copies their own. Scanned as a tree so a new doc is covered the moment it is added,
    // rather than when somebody remembers to list it here.
    path.join(__dirname, "..", "..", "..", "docs"),
    path.join(__dirname, "..", "..", "..", "README.md"),
    path.join(__dirname, "..", "..", "..", "CONTRIBUTING.md"),
    path.join(__dirname, "..", "..", "..", "SECURITY.md"),
    path.join(__dirname, "..", "..", "agenticqa", "README.md"),
    // Internal-only files: present in the working repo, absent in the published one. `existsSync` below
    // skips whichever are missing, so this list is safe in both.
    path.join(__dirname, "..", "..", "..", "CLAUDE.md"),
    path.join(__dirname, "..", "..", "..", "IMPLEMENTATION-PLAN.md"),
  ];

  const files = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) {continue;}
    if (fs.statSync(root).isDirectory()) {files.push(...walk(root));}
    else {files.push(root);}
  }

  const offenders = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(SECRET_RE)) {
      // Placeholders use an underscore; real keys of these formats are alphanumeric + dashes only.
      if (m[0].includes("_")) {continue;}
      offenders.push(`${path.basename(file)}: ${m[0].slice(0, m[1].length + 6)}…`);
    }
  }

  assert.deepStrictEqual(
    offenders,
    [],
    "Something key-shaped is in a committed file. Do NOT just delete it — a key that has been committed " +
      "is compromised whether or not it is still in the working tree. Revoke it at the provider, issue a " +
      "new one, and keep it in `.env` (gitignored) only:\n  " + offenders.join("\n  ")
  );
});
