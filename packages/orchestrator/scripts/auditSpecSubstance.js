"use strict";
/**
 * Spec-substance auditing for the benchmark (G1.3b — defect D13).
 *
 * WHY THIS EXISTS
 * ---------------
 * Playwright pass/fail is not a quality signal for *generated* tests. A plan that lost its assertions,
 * or that only asserts something already true on the landing page, still reports PASS. Measured
 * 2026-08-09 on the held-out TaskFlow app: **19/20 raw pass, ~1/20 actually testing what was asked** —
 * all 20 specs started at `/` and never navigated by URL again, 11 asserted the dashboard heading that
 * was visible before any action, and not one contained a fill/select/check despite seven form-centric
 * prompts. Even the tuned demo-web benchmark has a spec with **zero assertions** counted as a pass.
 *
 * Without this, "G2 improved things" is unfalsifiable — we'd be measuring with a ruler that reads 95%
 * for doing nothing.
 *
 * WHAT IT IS (and is NOT)
 * -----------------------
 * A cheap, pure, static LOWER-BOUND detector of hollow tests. `SUBSTANTIVE` means "not obviously
 * hollow" — NOT "correct". It never overrides pass/fail; it adds a second, honest number alongside it.
 * Deliberately conservative: when unsure it says SUBSTANTIVE, so the metric under-reports rather than
 * inventing failures.
 */

/** Step actions that change page state (as opposed to reading it). */
const INTERACTION_ACTIONS = new Set([
  "click",
  "fill",
  "select",
  "check",
  "uncheck",
  "hover",
  "press",
  "slider",
]);

/**
 * Prompt phrasing → the interaction the generated spec ought to contain.
 * Kept narrow on purpose: each pattern must be an unambiguous request to manipulate a control, so a
 * missing interaction is real evidence of under-testing rather than a wording accident.
 */
const INTERACTION_SIGNALS = [
  { action: "fill", re: /\b(fill(?:\s+in)?|enter|type|input)\b/i },
  {
    // Must clearly denote a <select>. The bare verbs "select"/"choose" are excluded on purpose: they
    // routinely mean "click a menu item" ("click the user menu, select Logout"), which produced a false
    // UNDER_TESTED on a demo-web spec that was in fact correct.
    action: "select",
    re: /\b(dropdown|sort by|select [\w\s"']+ from|set (?:the )?[\w\s]+ (?:dropdown )?to)\b/i,
  },
  { action: "check", re: /\b(tick|check(?:\s+the)?\s+\w*\s*(?:checkbox|box)|checkboxes?)\b/i },
  { action: "click", re: /\b(click|submit|send|press)\b/i },
];

/** Parse the ordered `STEP_ID=plan-step-N | <action>` markers a generated spec always carries. */
function parseSteps(specSource) {
  const steps = [];
  const re = /test\.step\(\s*["'`]STEP_ID=([\w-]+)\s*\|\s*(\w+)/g;
  let m;
  while ((m = re.exec(specSource ?? "")) !== null) {
    steps.push({ stepKey: m[1], action: m[2] });
  }
  return steps;
}

/** Path of each `page.goto(...)`, in order. Handles both the literal and `new URL(path, base)` forms. */
function parseGotoPaths(specSource) {
  const out = [];
  const newUrl = /page\.goto\(\s*new URL\(\s*["'`]([^"'`]+)["'`]/g;
  const literal = /page\.goto\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
  let m;
  while ((m = newUrl.exec(specSource ?? "")) !== null) out.push(m[1]);
  while ((m = literal.exec(specSource ?? "")) !== null) out.push(m[1]);
  return out.map(toPath);
}

function toPath(u) {
  try {
    return new URL(u, "http://x").pathname.replace(/\/+$/, "") || "/";
  } catch {
    return String(u || "/");
  }
}

/**
 * Human-readable targets the spec asserts on: `name: 'X'`, `getByText("X")`, `getByTestId('x')`,
 * regex-literal names. Used to check the assertion is even related to what was asked.
 */
function parseAssertionTargets(specSource) {
  const out = [];
  const src = specSource ?? "";
  // Only look inside expect(...) calls, so an action locator isn't mistaken for an assertion target.
  const expectCalls = src.match(/expect\([\s\S]*?\)\s*\.\s*(?:not\s*\.\s*)?to\w+/g) ?? [];
  for (const call of expectCalls) {
    for (const re of [
      /name:\s*["'`]([^"'`]+)["'`]/g,
      /name:\s*\/([^/]+)\//g,
      /getBy(?:Text|Label|Placeholder|TestId|AltText|Title)\(\s*["'`]([^"'`]+)["'`]/g,
      /getByText\(\s*\/([^/]+)\//g,
    ]) {
      let m;
      while ((m = re.exec(call)) !== null) out.push(m[1]);
    }
  }
  return out;
}

/** Loose containment: ignores case, punctuation and whitespace runs. */
function normalize(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function promptMentions(prompt, target) {
  const p = normalize(prompt);
  const t = normalize(target);
  if (!p || !t) return false;
  if (p.includes(t)) return true;
  // A multi-word target counts as mentioned when every word of it appears in the prompt
  // (covers "Create Task" vs "create a task").
  const words = t.split(" ").filter((w) => w.length > 2);
  return words.length > 0 && words.every((w) => p.includes(w));
}

/**
 * Text the prompt explicitly quotes — e.g. `verify the error "Task title is required"`. When a prompt
 * names the exact expected outcome, a spec that never mentions it did not verify that outcome, however
 * green it went. Single-word quotes are ignored (usually a filter term that is typed, not asserted).
 */
function quotedExpectations(prompt) {
  const out = [];
  const re = /["“]([^"”]{4,80})["”]/g;
  let m;
  while ((m = re.exec(prompt ?? "")) !== null) {
    const text = m[1].trim();
    if (text.split(/\s+/).length >= 2) out.push(text);
  }
  return out;
}

/** Interactions the prompt asks for, as an ordered, de-duped list. */
function expectedInteractions(prompt) {
  const out = [];
  for (const sig of INTERACTION_SIGNALS) {
    if (sig.re.test(prompt ?? "") && !out.includes(sig.action)) out.push(sig.action);
  }
  return out;
}

/**
 * Audit one generated spec against the prompt that produced it.
 *
 * @param {object} input
 * @param {string} input.specSource generated Playwright spec text
 * @param {string} [input.prompt]   the natural-language request
 * @param {string} [input.startPath] app start path (default "/")
 * @returns {{assertions:number, interactions:number, navigations:number, offStartNavigation:boolean,
 *            expected:string[], missing:string[], assertTargets:string[], onTarget:boolean,
 *            verdict:string, reason:string}}
 */
function auditSpecSubstance(input) {
  const specSource = input?.specSource ?? "";
  const prompt = input?.prompt ?? "";
  const startPath = toPath(input?.startPath ?? "/");

  const steps = parseSteps(specSource);
  const assertions = steps.filter((s) => /^expect/i.test(s.action)).length;
  const interactions = steps.filter((s) => INTERACTION_ACTIONS.has(s.action)).length;
  const gotoPaths = parseGotoPaths(specSource);
  const navigations = gotoPaths.length;
  const offStartNavigation = gotoPaths.some((p) => p !== startPath);

  const assertTargets = parseAssertionTargets(specSource);
  const expected = expectedInteractions(prompt);
  const present = new Set(steps.map((s) => s.action));
  const missing = expected.filter((a) => !present.has(a));
  // With no prompt we can't judge relevance — don't penalise it.
  const onTarget =
    !prompt || assertTargets.length === 0
      ? true
      : assertTargets.some((t) => promptMentions(prompt, t));

  // Quoted expectations the spec never mentions anywhere (assertion or otherwise).
  const quoted = quotedExpectations(prompt);
  const specNorm = normalize(specSource);
  const unmetQuotes = quoted.filter((q) => !specNorm.includes(normalize(q)));

  // ── Verdict ──────────────────────────────────────────────────────────────────────────────────
  // Only UNAMBIGUOUS signals become verdicts. Two earlier candidates were withdrawn after they
  // scored the (known-good) demo-web suite at 0/20:
  //   • "assertion target must appear in the prompt" — breaks on legitimate paraphrase. A knowledge
  //     pack's assertionAliases deliberately translate intent into an app-specific anchor ("verify a
  //     welcome message" → assert "Total Orders"), and that is the system working, not failing.
  //   • "prompt's quoted text must appear in the spec" — same problem: a prompt saying
  //     `an error like "Invalid credentials"` is correctly satisfied by "Invalid email or password".
  // Both survive as informational fields (`onTarget`, `unmetQuotes`) for humans reading a run, but
  // they must not drive the number. A metric that cries wolf is as useless as one that never does.
  let verdict = "SUBSTANTIVE";
  let reason = "exercises the prompt's interactions and asserts an outcome";

  if (assertions === 0) {
    verdict = "VACUOUS";
    reason = "no assertions — this test cannot fail";
  } else if (missing.length > 0) {
    // You cannot verify "enter X then click Y" without a fill. This is the signal that separates
    // demo-web's real flows (4 fills + check + click) from TaskFlow's navigate-and-look shells.
    verdict = "UNDER_TESTED";
    reason = `prompt asks to ${missing.join(" + ")}, but the spec never does`;
  } else if (interactions === 0 && !offStartNavigation && !onTarget) {
    // Did nothing AND went nowhere AND asserted something the prompt never mentions — e.g. a
    // "Team page lists…" prompt whose spec never leaves the dashboard and asserts the dashboard's own
    // heading. The `offStartNavigation` guard matters: a prompt like "navigate directly to /checkout
    // and verify the warning" legitimately has no interactions, and its assertion is real work.
    verdict = "OFF_TARGET";
    reason = `never leaves the start page, and asserts ${assertTargets
      .map((t) => `"${t}"`)
      .join(", ")} which the prompt never mentions`;
  }

  return {
    assertions,
    interactions,
    navigations,
    offStartNavigation,
    expected,
    missing,
    assertTargets,
    onTarget,
    quoted,
    unmetQuotes,
    verdict,
    reason,
  };
}

/** Roll a set of audits into headline counts. */
function summarizeSubstance(audits) {
  const counts = {
    SUBSTANTIVE: 0,
    UNDER_TESTED: 0,
    OFF_TARGET: 0,
    VACUOUS: 0,
  };
  for (const a of audits) {
    if (a && counts[a.verdict] !== undefined) counts[a.verdict]++;
  }
  return { total: audits.length, ...counts };
}

module.exports = {
  auditSpecSubstance,
  quotedExpectations,
  summarizeSubstance,
  parseSteps,
  parseGotoPaths,
  parseAssertionTargets,
  expectedInteractions,
  promptMentions,
  INTERACTION_ACTIONS,
};
