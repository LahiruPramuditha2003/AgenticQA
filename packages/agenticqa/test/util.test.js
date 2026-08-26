"use strict";
/**
 * Real unit tests for the extension's vscode-free helpers (G5.2 / defect D8).
 *
 * ⚠️ Until now this package's ENTIRE test suite was one stub asserting `[1,2,3].indexOf(5) === -1`, while
 * a 1,600-line `extension.ts` shipped with no coverage at all. The obstacle was structural rather than
 * lazy: `extension.ts` imports `vscode`, so testing anything inside it means downloading and launching a
 * VS Code instance (`vscode-test`). G5.2 moved the helpers that don't need `vscode` into `util/`, which is
 * what makes this file possible — it runs under plain `node:test` in milliseconds.
 *
 * `npm test` runs this. `npm run test:vscode` still runs the host-dependent suite.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const OUT = path.join(__dirname, "..", "out", "packages", "agenticqa", "src", "util");
const { extractUrlFromText, looksLikeQuestion, sanitizeUrl } = require(path.join(OUT, "text.js"));
const {
  findAgenticQaConfigFile,
  getAgenticQaConfigInfo,
  hasKnowledgePack,
  detectCodeAccessibleApp,
} = require(path.join(OUT, "workspace.js"));
const { inlineScreenshots, MAX_SCREENSHOT_BYTES } = require(path.join(OUT, "screenshots.js"));
const {
  parseExpectedBrowsers,
  checkPlaywrightBrowsers,
  describeBrowserCheck,
} = require(path.join(OUT, "playwright.js"));
const {
  engineCandidates,
  resolveEngine,
  monorepoOrchestratorDir,
  missingEngineMessage,
  packagedPromptFile,
} = require(path.join(OUT, "engine.js"));
const { readKnowledgePackSummary } = require(path.join(OUT, "workspace.js"));

/* ─── text ─── */

test("a URL is recovered from ordinary prose", () => {
  assert.strictEqual(
    extractUrlFromText("please test https://shop.example.com/cart and report"),
    "https://shop.example.com/cart"
  );
  // A bare host:port is how people actually write a dev server.
  assert.strictEqual(extractUrlFromText("run it against localhost:5173"), "http://localhost:5173");
  assert.strictEqual(extractUrlFromText("check 127.0.0.1:8080/admin"), "http://127.0.0.1:8080/admin");
  assert.strictEqual(extractUrlFromText("no url in here"), undefined);
});

test("sentence punctuation is not part of the URL", () => {
  // The classic bug: "visit http://localhost:5173." yields a URL with a trailing dot and every request 404s.
  assert.strictEqual(extractUrlFromText("visit http://localhost:5173."), "http://localhost:5173");
  assert.strictEqual(extractUrlFromText("(see https://example.com/a)"), "https://example.com/a");
  assert.strictEqual(sanitizeUrl('"https://example.com",'), "https://example.com");
});

test("questions are distinguished from test requests", () => {
  for (const q of ["What is the refund policy?", "how do I reset my password", "Tell me about shipping", "explain the checkout flow"]) {
    assert.strictEqual(looksLikeQuestion(q), true, q);
  }
  for (const r of ["Add a product to the cart and verify the badge", "Login with valid credentials"]) {
    assert.strictEqual(looksLikeQuestion(r), false, r);
  }
});

/* ─── workspace ─── */

async function tmpTree(spec) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aqa-test-"));
  for (const [rel, content] of Object.entries(spec)) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, "utf8");
  }
  return root;
}

test("the config at the workspace root wins over a nested one", async () => {
  // Breadth-first matters: opening a monorepo root must pick the root's config, not whichever app the
  // directory listing happened to yield first.
  const root = await tmpTree({
    ".agenticqa.json": "{}",
    "apps/web/.agenticqa.json": "{}",
  });
  assert.strictEqual(await findAgenticQaConfigFile(root), path.join(root, ".agenticqa.json"));
});

test("a nested config is found when the root has none", async () => {
  const root = await tmpTree({ "apps/web/.agenticqa.json": "{}" });
  assert.strictEqual(
    await findAgenticQaConfigFile(root),
    path.join(root, "apps", "web", ".agenticqa.json")
  );
  const info = await getAgenticQaConfigInfo(root);
  assert.strictEqual(info.configRoot, path.join(root, "apps", "web"), "the run root is the config's dir");
});

test("node_modules is never searched", async () => {
  // Otherwise a dependency's fixture config could be picked as the workspace's own.
  const root = await tmpTree({ "node_modules/pkg/.agenticqa.json": "{}" });
  assert.strictEqual(await findAgenticQaConfigFile(root), undefined);
});

test("a missing config yields a sensible default path, not a crash", async () => {
  const root = await tmpTree({ "readme.md": "hi" });
  const info = await getAgenticQaConfigInfo(root);
  assert.strictEqual(info.configPath, path.join(root, ".agenticqa.json"));
  assert.strictEqual(info.configRoot, root);
});

test("a knowledge pack is found at the configured path or the conventional one", async () => {
  const conventional = await tmpTree({ ".agenticqa/knowledge.json": "{}" });
  assert.strictEqual(await hasKnowledgePack(conventional), true);

  const configured = await tmpTree({
    ".agenticqa.json": JSON.stringify({ knowledgePack: "packs/app.json" }),
    "packs/app.json": "{}",
  });
  assert.strictEqual(await hasKnowledgePack(configured), true);

  // A config that POINTS at a pack which does not exist is not a pack.
  const dangling = await tmpTree({
    ".agenticqa.json": JSON.stringify({ knowledgePack: "packs/missing.json" }),
  });
  assert.strictEqual(await hasKnowledgePack(dangling), false);
});

test("framework detection reads package.json and declines when unsure", async () => {
  const react = await tmpTree({ "package.json": '{"dependencies":{"react-router-dom":"^6"}}' });
  assert.strictEqual(await detectCodeAccessibleApp(react), "React");
  const next = await tmpTree({ "package.json": '{"dependencies":{"next":"14"}}' });
  assert.strictEqual(await detectCodeAccessibleApp(next), "Next.js");
  const vue = await tmpTree({ "package.json": '{"dependencies":{"vue-router":"^4"}}' });
  assert.strictEqual(await detectCodeAccessibleApp(vue), "Vue");
  // Declining is the safe answer — it only suppresses an OFFER to generate a pack.
  const plain = await tmpTree({ "package.json": '{"dependencies":{"express":"^4"}}' });
  assert.strictEqual(await detectCodeAccessibleApp(plain), null);
  const none = await tmpTree({ "readme.md": "hi" });
  assert.strictEqual(await detectCodeAccessibleApp(none), null);
});

/* ─── screenshots ─── */

test("screenshots become data URIs the report's CSP allows", async () => {
  const root = await tmpTree({ "shot.png": "" });
  const file = path.join(root, "shot.png");
  await fs.writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const out = await inlineScreenshots({ steps: [{ stepKey: "plan-step-1", screenshots: [file] }] });
  assert.match(out.steps[0].screenshots[0], /^data:image\/png;base64,/);
});

test("a missing screenshot is skipped, never fatal", async () => {
  // This runs AFTER a test has already failed; losing the report too would be the worse outcome.
  const out = await inlineScreenshots({
    steps: [{ stepKey: "plan-step-1", screenshots: ["/nope/missing.png"] }],
  });
  assert.strictEqual(out.steps[0].screenshots, undefined);
});

test("an already-inlined URI is not re-read from disk", async () => {
  const uri = "data:image/png;base64,AAAA";
  const out = await inlineScreenshots({ steps: [{ stepKey: "s", screenshots: [uri] }] });
  assert.deepStrictEqual(out.steps[0].screenshots, [uri]);
});

test("a summary with no screenshots is returned untouched", async () => {
  const summary = { steps: [{ stepKey: "plan-step-1" }] };
  assert.strictEqual(await inlineScreenshots(summary), summary, "same object — no needless copying");
  assert.ok(MAX_SCREENSHOT_BYTES > 0);
});

/* ─── engine resolution (R1.7 / blocker B1) ─── */

const EXT = path.join("C:", "ext", "publisher.agenticqa-1.0.0");

test("engineCandidates: configured wins, then bundled, then the monorepo sibling", () => {
  const plain = engineCandidates(EXT).map((c) => c.kind);
  assert.deepStrictEqual(plain, ["bundled", "monorepo"]);

  // An explicit setting must outrank a bundled engine. People set it precisely when a bundled engine
  // exists and they want a local build instead — an escape hatch that loses to the default is useless.
  const configured = engineCandidates(EXT, path.join("D:", "dev", "main.js"));
  assert.deepStrictEqual(configured.map((c) => c.kind), ["configured", "bundled", "monorepo"]);

  assert.strictEqual(
    engineCandidates(EXT)[0].path,
    path.join(EXT, "dist", "orchestrator.js"),
    "the bundled engine lives inside the extension, which is what makes a .vsix install runnable"
  );
  assert.strictEqual(
    engineCandidates(EXT)[1].path,
    path.join(EXT, "..", "orchestrator", "dist", "main.js"),
    "the monorepo path must stay byte-identical — it is what the F5 dev host uses today"
  );
});

test("engineCandidates: blank/whitespace configured paths are ignored, not resolved to cwd", () => {
  for (const blank of ["", "   ", undefined]) {
    assert.deepStrictEqual(engineCandidates(EXT, blank).map((c) => c.kind), ["bundled", "monorepo"]);
  }
});

test("resolveEngine returns the first candidate that exists, with its kind", async () => {
  const only = (wanted) => async (p) => p === wanted;

  const bundled = path.join(EXT, "dist", "orchestrator.js");
  assert.deepStrictEqual(await resolveEngine({ extensionPath: EXT, exists: only(bundled) }), {
    path: bundled,
    kind: "bundled",
  });

  // Today there is no bundled engine, so every install falls through to the sibling — this is the
  // behaviour that must be preserved exactly until R2.1 creates the bundle.
  const mono = path.join(EXT, "..", "orchestrator", "dist", "main.js");
  assert.deepStrictEqual(await resolveEngine({ extensionPath: EXT, exists: only(mono) }), {
    path: mono,
    kind: "monorepo",
  });

  // Both present ⇒ bundled wins, so a stale sibling build cannot shadow the shipped engine.
  const both = async (p) => p === bundled || p === mono;
  assert.strictEqual((await resolveEngine({ extensionPath: EXT, exists: both })).kind, "bundled");

  assert.strictEqual(
    await resolveEngine({ extensionPath: EXT, exists: async () => false }),
    undefined,
    "nothing on disk ⇒ undefined, so the caller must handle it rather than spawning a missing file"
  );
});

test("missingEngineMessage gives layout-appropriate advice", async () => {
  // A monorepo checkout needs a build; a packaged install with no engine is a broken download and no
  // amount of `npm run build` will help. Telling the second group to build wastes their afternoon.
  const generic = missingEngineMessage(EXT);
  assert.match(generic, /reinstall the extension/i);
  assert.match(generic, /build the orchestrator/i);
  assert.ok(generic.includes(path.join(EXT, "dist", "orchestrator.js")));

  const configured = missingEngineMessage(EXT, path.join("D:", "nope", "main.js"));
  assert.match(configured, /agenticqa\.enginePath/);
  assert.doesNotMatch(configured, /reinstall/i, "a bad setting is the user's to fix, not a bad install");
});

test("monorepoOrchestratorDir points at the buildable package", () => {
  assert.strictEqual(monorepoOrchestratorDir(EXT), path.join(EXT, "..", "orchestrator"));
});

/* ─── knowledge-pack summary (R1.6 / defects D30, D38) ─── */

test("readKnowledgePackSummary reports flow count and the curated marker", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aqa-pack-"));
  await fs.mkdir(path.join(dir, ".agenticqa"), { recursive: true });
  const packFile = path.join(dir, ".agenticqa", "knowledge.json");

  await fs.writeFile(packFile, JSON.stringify({ goldenFlows: { a: {}, b: {} }, curated: true }));
  let got = await readKnowledgePackSummary(dir);
  assert.strictEqual(got.flowCount, 2);
  assert.strictEqual(got.curated, true);

  // Absent marker ⇒ not curated. Only an explicit `true` protects a pack, so a generated pack (which
  // never writes the field) is always replaceable.
  await fs.writeFile(packFile, JSON.stringify({ goldenFlows: { a: {} } }));
  got = await readKnowledgePackSummary(dir);
  assert.strictEqual(got.curated, false);
  assert.strictEqual(got.flowCount, 1);

  // Unparseable or missing ⇒ undefined: there is nothing to protect, and refusing to generate because
  // a pack is corrupt would leave the user stuck.
  await fs.writeFile(packFile, "{ not json");
  assert.strictEqual(await readKnowledgePackSummary(dir), undefined);
  await fs.rm(packFile);
  assert.strictEqual(await readKnowledgePackSummary(dir), undefined);

  await fs.rm(dir, { recursive: true, force: true });
});

test("packagedPromptFile resolves beside the engine, for either layout", () => {
  // Uniform because copyPrompts.js emits the flat dist/prompts/<Agent>/system.md tree in BOTH the tsc
  // build and the bundle — only the engine's directory differs. The Settings panel seeds a user's
  // override from this file, so they start from the real prompt rather than a blank page.
  assert.strictEqual(
    packagedPromptFile(path.join(EXT, "dist", "orchestrator.js"), "SelfHealAgent"),
    path.join(EXT, "dist", "prompts", "SelfHealAgent", "system.md")
  );
  assert.strictEqual(
    packagedPromptFile(path.join(EXT, "..", "orchestrator", "dist", "main.js"), "DomainQaAgent"),
    path.join(EXT, "..", "orchestrator", "dist", "prompts", "DomainQaAgent", "system.md")
  );
});

/* ─── Playwright readiness (R2.7 follow-up) ─── */

// Real captured output from `npx playwright install --dry-run` on Windows. Using the genuine article
// matters: the format has header lines, indented "Install location:" lines, and several Download rows
// per browser, and a parser written against an imagined shape would pass its tests and fail in the wild.
const DRY_RUN = [
  "Chrome for Testing 151.0.7922.34 (playwright chromium v1234)",
  "  Install location:    /home/me/.cache/ms-playwright/chromium-1234",
  "  Download url:        https://cdn.playwright.dev/builds/cft/151.0.7922.34/linux/chrome-linux.zip",
  "",
  "FFmpeg (playwright ffmpeg v1011)",
  "  Install location:    /home/me/.cache/ms-playwright/ffmpeg-1011",
  "  Download url:        https://cdn.playwright.dev/dbazure/download/playwright/builds/ffmpeg/x.zip",
  "  Download fallback 1: https://playwright.download.prss.microsoft.com/x.zip",
  "",
  "Chrome Headless Shell 151.0.7922.34 (playwright chromium-headless-shell v1234)",
  "  Install location:    /home/me/.cache/ms-playwright/chromium_headless_shell-1234",
].join("\n");

test("parseExpectedBrowsers reads the browsers and locations Playwright reports", () => {
  const got = parseExpectedBrowsers(DRY_RUN);
  assert.strictEqual(got.length, 3, "chromium, ffmpeg and the headless shell are all required");
  assert.match(got[0].name, /^Chrome for Testing/);
  assert.ok(got[0].location.endsWith("chromium-1234"));
  assert.ok(got[2].location.endsWith("chromium_headless_shell-1234"));
  // Download rows must never be mistaken for a location.
  assert.ok(got.every((b) => !/^https?:/.test(b.location)));
  assert.deepStrictEqual(parseExpectedBrowsers(""), []);
});

test("checkPlaywrightBrowsers reports exactly what is missing", async () => {
  const all = async () => true;
  const ready = await checkPlaywrightBrowsers({ dryRun: async () => DRY_RUN, exists: all });
  assert.strictEqual(ready.ok, true);
  assert.strictEqual(ready.missing.length, 0);
  assert.match(describeBrowserCheck(ready), /3 browser build\(s\) installed/);

  // The real failure seen in a fresh workspace: the package is installed, the headless shell is not.
  const onlySome = async (p) => !p.includes("chromium_headless_shell");
  const partial = await checkPlaywrightBrowsers({ dryRun: async () => DRY_RUN, exists: onlySome });
  assert.strictEqual(partial.ok, false);
  assert.strictEqual(partial.missing.length, 1);
  assert.match(describeBrowserCheck(partial), /Chrome Headless Shell/);
  assert.match(describeBrowserCheck(partial), /npx playwright install/);
  assert.doesNotMatch(
    describeBrowserCheck(partial),
    /\(playwright/,
    "the version parenthetical is noise in a one-line Doctor row"
  );
});

test("checkPlaywrightBrowsers reports inconclusive as an ERROR, never as missing", async () => {
  // Telling someone to download browsers they already have — because npx timed out on a slow machine —
  // wastes their time and teaches them to ignore Doctor. Unknown must not masquerade as absent.
  const noOutput = await checkPlaywrightBrowsers({ dryRun: async () => undefined, exists: async () => true });
  assert.strictEqual(noOutput.missing.length, 0);
  assert.ok(noOutput.error);
  assert.match(describeBrowserCheck(noOutput), /Could not verify/);

  const threw = await checkPlaywrightBrowsers({
    dryRun: async () => { throw new Error("spawn ENOENT"); },
    exists: async () => true,
  });
  assert.match(threw.error, /ENOENT/);

  const empty = await checkPlaywrightBrowsers({ dryRun: async () => "no browsers here", exists: async () => true });
  assert.ok(empty.error);
  assert.strictEqual(empty.missing.length, 0);
});
