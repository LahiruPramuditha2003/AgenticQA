"use strict";
/**
 * Offline unit tests for the agent system-prompt loader (G0.4, extended in R1.1).
 *
 * Three jobs:
 *  1. the loader's own contract (comment stripping, {{var}} substitution, caching, loud failure);
 *  2. the R1.1 **resolution chain** — workspace override > user override > shipped default — including
 *     the rule that a broken override degrades instead of killing the run;
 *  3. a BEHAVIOR LOCK on every wired agent prompt — the exact text each agent had inlined before G0.4.
 *     If a prompt file drifts, these fail. This is what makes "prompts are editable data" safe: you can
 *     edit them deliberately (and update the lock), but you can't change agent behavior by accident.
 *
 * Requires a build first (imports from dist/, which is also where copyPrompts.js puts the .md files —
 * so these tests double as proof that the build's prompt-copy step ran, in BOTH layouts).
 */

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const {
  loadSystemPrompt,
  stripPromptComments,
  applyPromptVars,
  clearPromptCache,
  setPromptWorkspace,
  packagedCandidates,
} = require("../dist/core/utils/loadPrompt.js");

const AGENTS_DIR = path.resolve(__dirname, "../dist/agents");

/** Run `fn` with the prompt-resolution environment fully reset, and restore it afterwards. */
function withCleanEnv(fn) {
  const savedDir = process.env.AGENTICQA_PROMPT_DIR;
  const savedRoot = process.env.AGENTICQA_PROMPT_ROOT;
  delete process.env.AGENTICQA_PROMPT_DIR;
  delete process.env.AGENTICQA_PROMPT_ROOT;
  setPromptWorkspace(undefined);
  clearPromptCache();
  try {
    return fn();
  } finally {
    if (savedDir === undefined) {delete process.env.AGENTICQA_PROMPT_DIR;}
    else {process.env.AGENTICQA_PROMPT_DIR = savedDir;}
    if (savedRoot === undefined) {delete process.env.AGENTICQA_PROMPT_ROOT;}
    else {process.env.AGENTICQA_PROMPT_ROOT = savedRoot;}
    setPromptWorkspace(undefined);
    clearPromptCache();
  }
}

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `aqa-${tag}-`));
}

/* ─── loader contract ─── */

test("stripPromptComments removes HTML comments and trims", () => {
  assert.strictEqual(stripPromptComments("Hello\n<!-- note -->\n"), "Hello");
  assert.strictEqual(stripPromptComments("A<!--x-->B"), "AB");
  assert.strictEqual(
    stripPromptComments("keep\n<!--\nmulti\nline\n-->\nkeep2"),
    "keep\n\nkeep2"
  );
  assert.strictEqual(stripPromptComments("<!--only-->"), "");
});

test("applyPromptVars substitutes known tokens and leaves unknown ones visible", () => {
  assert.strictEqual(applyPromptVars("a {{x}} b", { x: "1" }), "a 1 b");
  assert.strictEqual(applyPromptVars("a {{ x }} b", { x: "1" }), "a 1 b", "tolerates inner spaces");
  assert.strictEqual(applyPromptVars("n={{n}}", { n: 0.42 }), "n=0.42", "numbers are stringified");
  assert.strictEqual(
    applyPromptVars("a {{typo}} b", { x: "1" }),
    "a {{typo}} b",
    "an unknown token stays visible rather than becoming 'undefined'"
  );
  assert.strictEqual(applyPromptVars("no tokens", { x: "1" }), "no tokens");
  assert.strictEqual(applyPromptVars("a {{x}}"), "a {{x}}", "no vars ⇒ unchanged");
});

test("loadSystemPrompt reads, strips comments, substitutes, and caches by resolved path", () => {
  withCleanEnv(() => {
    const root = tmpdir("promptroot");
    fs.mkdirSync(path.join(root, "Fake"), { recursive: true });
    const file = path.join(root, "Fake", "system.md");
    fs.writeFileSync(file, "Hi {{who}}\n<!-- maintainer note -->\n", "utf8");
    process.env.AGENTICQA_PROMPT_ROOT = root;

    assert.strictEqual(loadSystemPrompt("Fake", { who: "there" }), "Hi there");

    // Cached: the template is reused, but vars are re-applied per call.
    fs.writeFileSync(file, "COMPLETELY DIFFERENT", "utf8");
    assert.strictEqual(loadSystemPrompt("Fake", { who: "again" }), "Hi again", "template is cached");

    clearPromptCache();
    assert.strictEqual(loadSystemPrompt("Fake"), "COMPLETELY DIFFERENT", "cache can be cleared");

    fs.rmSync(root, { recursive: true, force: true });
  });
});

test("loadSystemPrompt fails loudly on a missing or empty shipped default", () => {
  withCleanEnv(() => {
    assert.throws(
      () => loadSystemPrompt("ThisAgentDoesNotExist"),
      /Could not load system prompt for "ThisAgentDoesNotExist"/
    );

    const root = tmpdir("promptempty");
    fs.mkdirSync(path.join(root, "Fake"), { recursive: true });
    fs.writeFileSync(path.join(root, "Fake", "system.md"), "<!-- only a comment -->", "utf8");
    process.env.AGENTICQA_PROMPT_ROOT = root;
    assert.throws(() => loadSystemPrompt("Fake"), /is empty/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

test("the missing-prompt error names every location it looked in", () => {
  withCleanEnv(() => {
    // A loader that says only "not found" makes a packaging bug a guessing game — and R2 introduces
    // exactly the packaging bug this message has to diagnose.
    try {
      loadSystemPrompt("Nope");
      assert.fail("should have thrown");
    } catch (e) {
      for (const c of packagedCandidates("Nope")) {
        assert.ok(e.message.includes(c), `error should mention candidate ${c}`);
      }
    }
  });
});

/* ─── R1.1 resolution chain ─── */

test("a workspace override beats a user override, which beats the shipped default", () => {
  withCleanEnv(() => {
    const ws = tmpdir("ws");
    const userDir = tmpdir("user");
    fs.mkdirSync(path.join(ws, ".agenticqa", "prompts"), { recursive: true });

    process.env.AGENTICQA_PROMPT_DIR = userDir;

    // Shipped default only.
    assert.match(loadSystemPrompt("SelfHealAgent"), /single digit/);

    // User override wins over shipped.
    fs.writeFileSync(path.join(userDir, "SelfHealAgent.md"), "USER PROMPT", "utf8");
    clearPromptCache();
    assert.strictEqual(loadSystemPrompt("SelfHealAgent"), "USER PROMPT");

    // Workspace override wins over user.
    setPromptWorkspace(ws);
    fs.writeFileSync(
      path.join(ws, ".agenticqa", "prompts", "SelfHealAgent.md"),
      "WORKSPACE PROMPT",
      "utf8"
    );
    clearPromptCache();
    assert.strictEqual(loadSystemPrompt("SelfHealAgent"), "WORKSPACE PROMPT");

    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(userDir, { recursive: true, force: true });
  });
});

test("an EMPTY override is ignored, logged, and never fatal", () => {
  withCleanEnv(() => {
    const userDir = tmpdir("emptyoverride");
    process.env.AGENTICQA_PROMPT_DIR = userDir;
    // Saving an empty file is an easy accident. Killing the run over it would be a far worse outcome
    // than quietly using the prompt that is known to work.
    fs.writeFileSync(path.join(userDir, "SelfHealAgent.md"), "   \n<!-- gone -->\n", "utf8");

    const logs = [];
    const got = loadSystemPrompt("SelfHealAgent", undefined, { log: (m) => logs.push(m) });

    assert.match(got, /single digit/, "fell through to the shipped default");
    assert.ok(
      logs.some((l) => /is empty/.test(l) && /SelfHealAgent/.test(l)),
      `expected an 'override is empty' log, got: ${JSON.stringify(logs)}`
    );
    fs.rmSync(userDir, { recursive: true, force: true });
  });
});

test("an override that drops a required placeholder warns by name but still runs", () => {
  withCleanEnv(() => {
    const userDir = tmpdir("varoverride");
    process.env.AGENTICQA_PROMPT_DIR = userDir;
    // The Receptionist's prompt carries the local classifier's guess. An override without it still
    // produces an answer — which is exactly why it needs to be said out loud.
    fs.writeFileSync(
      path.join(userDir, "ReceptionistAgent.md"),
      "Classify the request. Return JSON.",
      "utf8"
    );

    const logs = [];
    const got = loadSystemPrompt(
      "ReceptionistAgent",
      { localIntent: "TEST_GEN", localConfidence: 0.9 },
      { log: (m) => logs.push(m) }
    );

    assert.strictEqual(got, "Classify the request. Return JSON.");
    const warn = logs.find((l) => l.includes("drops"));
    assert.ok(warn, `expected a missing-placeholder warning, got: ${JSON.stringify(logs)}`);
    assert.match(warn, /\{\{localIntent\}\}/);
    assert.match(warn, /\{\{localConfidence\}\}/);
    fs.rmSync(userDir, { recursive: true, force: true });
  });
});

test("no override configured ⇒ byte-identical to the shipped default (parity guard)", () => {
  // The whole override feature must be inert until someone opts in. If this ever fails, every
  // benchmark number in the project is measuring something other than the shipped prompts.
  withCleanEnv(() => {
    const direct = stripPromptComments(
      fs.readFileSync(path.join(AGENTS_DIR, "SelfHealAgent", "prompts", "system.md"), "utf8")
    );
    assert.strictEqual(loadSystemPrompt("SelfHealAgent"), direct);
  });
});

test("each agent resolves to ITS OWN prompt, not a shared one (blocker B2 guard)", () => {
  // Under the old `loadSystemPrompt(__dirname)` API this became false the moment the orchestrator was
  // bundled: esbuild collapses every agent into one file, so all three resolved to the same path and
  // the Receptionist would have been handed the Domain-QA prompt. Nothing would have looked broken.
  withCleanEnv(() => {
    const selfheal = loadSystemPrompt("SelfHealAgent");
    const domainqa = loadSystemPrompt("DomainQaAgent");
    const reception = loadSystemPrompt("ReceptionistAgent", {
      localIntent: "TEST_GEN",
      localConfidence: 0.42,
    });
    assert.notStrictEqual(selfheal, domainqa);
    assert.notStrictEqual(domainqa, reception);
    assert.match(selfheal, /single digit/);
    assert.match(domainqa, /DomainQaResponse schema/);
    assert.match(reception, /Receptionist for AgenticQA/);
  });
});

/* ─── behavior lock: the wired prompts must match what was previously inlined ─── */

const EXPECTED_RECEPTIONIST = `You are the Receptionist for AgenticQA, an AI-powered test automation system.

Your role is to classify user requests into exactly ONE of these three intents:

1. **CASUAL** - General conversation, greetings, or requests unrelated to testing/documentation
   - Examples: "Hello", "How are you?", "What can you do?", "Thanks"

2. **DOMAIN_QA** - Questions about the application domain, documentation, or knowledge retrieval
   - Examples: "What is authentication?", "How does JWT work?", "Explain OAuth2"

3. **TEST_GEN** - Requests to generate, create, or write automated tests
   - Examples: "Test login with valid credentials", "Generate a test for the checkout flow"

A local classifier suggested "TEST_GEN" with confidence 0.42.
Consider this suggestion but make your own judgment.

Return ONLY a valid JSON object:
{
  "intent": "CASUAL" | "DOMAIN_QA" | "TEST_GEN",
  "confidence": 0.0-1.0,
  "reasoning": "Brief explanation"
}

Do NOT include any text outside the JSON object.`;

const EXPECTED_DOMAINQA = `You are a Domain Knowledge Q&A Agent. Answer questions ONLY based on provided documentation.

CRITICAL REQUIREMENTS:
1. EVERY factual claim MUST be supported by source chunks
2. If information isn't in the sources, say "The documentation does not contain information about..."
3. DO NOT invent, hallucinate, or make assumptions
4. Use inline citations: [Source: Document Title]
5. Be precise and cite specific sources for each claim
6. Only mark confidence as HIGH if all claims are well-supported; otherwise use MEDIUM or LOW
7. Respond in valid JSON matching the DomainQaResponse schema.

The 'sources' array CAN be empty if no relevant information is found.`;

const EXPECTED_SELFHEAL =
  "You are an expert at identifying HTML elements. Return only a single digit (0-9).";

test("LOCK: ReceptionistAgent prompt is byte-identical to the pre-G0.4 inlined text", () => {
  withCleanEnv(() => {
    const got = loadSystemPrompt("ReceptionistAgent", {
      localIntent: "TEST_GEN",
      localConfidence: 0.42,
    });
    assert.strictEqual(got, EXPECTED_RECEPTIONIST);
  });
});

test("LOCK: DomainQaAgent prompt is byte-identical, and still demands strict JSON", () => {
  withCleanEnv(() => {
    const got = loadSystemPrompt("DomainQaAgent");
    assert.strictEqual(got, EXPECTED_DOMAINQA);
    // The caller brace-matches + Zod-validates the reply; a prompt that stops demanding JSON breaks it.
    assert.match(got, /valid JSON matching the DomainQaResponse schema/);
  });
});

test("LOCK: SelfHealAgent rerank prompt is byte-identical, and still demands a single digit", () => {
  withCleanEnv(() => {
    const got = loadSystemPrompt("SelfHealAgent");
    assert.strictEqual(got, EXPECTED_SELFHEAL);
    // The caller parses the LAST number in the reply — free-form prose here would break selection.
    assert.match(got, /single digit/);
  });
});

test("prompt text is line-ending normalised, whatever the checkout produced", () => {
  // Found by cloning the published repository and running its own suite: the source checkout passed and
  // a fresh clone failed both behaviour locks, because `.gitattributes` and git's autocrlf settings gave
  // the two checkouts different line endings. The bytes sent to a model must not depend on that — nor on
  // whether a user saved their prompt override in an editor that writes CRLF.
  withCleanEnv(() => {
    const root = tmpdir("crlf");
    fs.mkdirSync(path.join(root, "Fake"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "Fake", "system.md"),
      ["line one", "line two", "", "line three"].join(String.fromCharCode(13, 10)),
      "utf8"
    );
    process.env.AGENTICQA_PROMPT_ROOT = root;

    const got = loadSystemPrompt("Fake");
    assert.ok(!got.includes(String.fromCharCode(13)), "no carriage returns may survive");
    assert.strictEqual(
      got,
      ["line one", "line two", "", "line three"].join(String.fromCharCode(10))
    );

    fs.rmSync(root, { recursive: true, force: true });
  });
});

test("the build copies every prompt file into dist, in BOTH layouts", () => {
  const srcAgents = path.resolve(__dirname, "../src/agents");
  const distRoot = path.resolve(__dirname, "../dist");
  const wired = fs
    .readdirSync(srcAgents, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(srcAgents, d.name, "prompts", "system.md")))
    .map((d) => d.name);

  assert.ok(wired.length >= 3, `expected at least 3 agents with prompts, found ${wired.length}`);
  for (const agent of wired) {
    assert.ok(
      fs.existsSync(path.join(AGENTS_DIR, agent, "prompts", "system.md")),
      `${agent}'s prompt is missing from the tsc layout — is copyPrompts.js in the build script?`
    );
    // The flat layout is the one the release bundle uses. Checking it here means an ordinary build
    // catches its absence, rather than the packaging step being the first to find out.
    assert.ok(
      fs.existsSync(path.join(distRoot, "prompts", agent, "system.md")),
      `${agent}'s prompt is missing from the flat dist/prompts/ layout used by the bundled build`
    );
  }
});

test("no EMPTY prompt files remain (a file nothing can use is worse than none)", () => {
  const srcAgents = path.resolve(__dirname, "../src/agents");
  for (const d of fs.readdirSync(srcAgents, { withFileTypes: true })) {
    if (!d.isDirectory()) {continue;}
    const file = path.join(srcAgents, d.name, "prompts", "system.md");
    if (!fs.existsSync(file)) {continue;}
    const cleaned = stripPromptComments(fs.readFileSync(file, "utf8"));
    assert.ok(cleaned.length > 0, `${d.name}/prompts/system.md is empty — delete it or fill it in`);
  }
});

test("every prompt the Settings panel offers to edit is one the loader actually resolves", () => {
  // Cross-package invariant (R1.4). The panel writes `<globalStorage>/prompts/<Agent>.md`, and the
  // loader looks for exactly that filename. A typo or a renamed agent on either side produces the worst
  // possible outcome: Edit opens a file, the user writes a prompt, saves it — and nothing happens,
  // because no agent ever asks for that name. Neither package's own tests can catch that alone.
  const panel = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "agenticqa", "src", "views", "SettingsViewProvider.ts"),
    "utf8"
  );
  const offered = [...panel.matchAll(/agent:\s*"([A-Za-z]+Agent)"/g)].map((m) => m[1]);

  assert.ok(offered.length >= 3, `expected the panel to offer >= 3 prompts, found ${offered.length}`);
  for (const agent of offered) {
    assert.doesNotThrow(
      () => loadSystemPrompt(agent, { localIntent: "TEST_GEN", localConfidence: 0.5 }),
      `the Settings panel offers to edit "${agent}", but the loader cannot resolve a prompt for it`
    );
  }

  // …and the reverse: every agent that loads a prompt should be offerable, or a user has no way to
  // customize it. A soft check — adding an agent without UI is a choice, but it should be a conscious
  // one, so this asserts the counts match rather than silently drifting.
  const srcAgents = path.resolve(__dirname, "../src/agents");
  const wired = fs
    .readdirSync(srcAgents, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(srcAgents, d.name, "prompts", "system.md")))
    .map((d) => d.name)
    .sort();
  assert.deepStrictEqual(
    offered.sort(),
    wired,
    "the Settings panel's editable-prompt list has drifted from the agents that actually load prompts"
  );
});
