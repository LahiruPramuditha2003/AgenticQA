/**
 * Pure, file-text helpers for SelfHealAgent — no MCP / DB / network, so they're unit-testable
 * offline. The agent (`agents/SelfHealAgent/SelfHealAgent.ts`) owns the live browser + DB work and
 * imports everything structural from here.
 */

/* ─── failure gating ─── */

/**
 * Heuristic: does this Playwright stdout/stderr look like a locator (not assertion/logic) failure?
 * Used as a fallback when `ctx.failureClass` is unavailable. `SelfHealAgent` prefers the Executor's
 * `failureClass` and only falls back to this text scan.
 */
export function looksLikeLocatorNotFound(output: string): boolean {
  const t = output.toLowerCase();
  return (
    t.includes("element(s) not found") ||
    (t.includes("waiting for") && t.includes("getby")) ||
    t.includes("strict mode violation") ||
    (t.includes("timeout") && t.includes("waiting for"))
  );
}

/* ─── step-key derivation ─── */

/** Recover the canonical `plan-step-N` key (or the raw id) from a failed step's STEP_ID. */
export function stepKeyFromFailedStepId(stepId: string): string | null {
  const m = stepId.match(/plan-step-(\d+)/);
  if (m) return `plan-step-${m[1]}`;
  if (stepId && stepId.length > 0) return stepId;
  return null;
}

/* ─── spec parsing ─── */

/**
 * Parse a generated/hand-written spec for the heal flow: the first `page.goto(...)` URL and a map of
 * STEP_ID → { action } from each `test.step("STEP_ID=… | action", …)` title. Used in run_only when
 * there is no in-memory test plan.
 */
export function parseTestFileForHealing(fileText: string): {
  gotoUrl: string | null;
  steps: Map<string, { action: string }>;
} {
  let gotoUrl: string | null = null;
  const steps = new Map<string, { action: string }>();

  const directMatch = fileText.match(/page\.goto\(\s*["']([^"']+)["']\s*\)/);
  if (directMatch) {
    gotoUrl = directMatch[1];
  }

  if (!gotoUrl) {
    const newUrlMatch = fileText.match(
      /page\.goto\(\s*new URL\(\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']\s*\)\.toString\(\)\s*\)/
    );
    if (newUrlMatch) {
      try {
        gotoUrl = new URL(newUrlMatch[1], newUrlMatch[2]).toString();
      } catch {
        gotoUrl = newUrlMatch[2] + newUrlMatch[1];
      }
    }
  }

  const stepRegex = /test\.step\(\s*["']STEP_ID=([\w-]+)\s*\|\s*(\w+)/g;
  let m;
  while ((m = stepRegex.exec(fileText)) !== null) {
    steps.set(m[1], { action: m[2] });
  }

  return { gotoUrl, steps };
}

/* ─── locator patching ─── */

/**
 * Locate the locator expression inside a single `test.step` body. Tries action calls first, then
 * assertions. Returns the regex match whose group 1 is the locator expression.
 */
function matchLocatorInBlock(block: string): RegExpMatchArray | null {
  let locMatch: RegExpMatchArray | null = null;

  // Pattern 1: await <locator>.(click|fill|clear|check|uncheck|selectOption|hover|press|scroll)
  locMatch = block.match(
    /await\s+(.+?)\.(click|fill|clear|check|uncheck|selectOption|hover|press|scroll)\(/
  );

  // Pattern 2: expect(<locator>).(toBeVisible|…)
  if (!locMatch) {
    locMatch = block.match(
      /expect\(\s*(.+?)\s*\)\s*\.\s*(toBeVisible|toBeHidden|toContainText|toHaveText|toHaveCount|toBeChecked|toBeEnabled|toBeDisabled|toHaveValue|toHaveAttribute)/
    );
  }

  // Pattern 2b: expect(page).(toHaveURL|toHaveTitle) — no locator to heal
  if (!locMatch) {
    locMatch = block.match(/expect\(\s*page\s*\)\s*\.\s*(toHaveURL|toHaveTitle)/);
  }

  // Pattern 2c: expect(<locator>).toHaveScreenshot / toMatchSnapshot
  if (!locMatch) {
    locMatch = block.match(
      /expect\(\s*(.+?)\s*\)\s*\.\s*(toHaveScreenshot|toMatchSnapshot)/
    );
  }

  // Pattern 3: await <locator>.(fill|type) with string argument
  if (!locMatch) {
    locMatch = block.match(/await\s+(.+?)\.(fill|type)\(\s*["']/);
  }

  // Pattern 4: await <locator>.selectOption
  if (!locMatch) {
    locMatch = block.match(/await\s+(.+?)\.selectOption\(/);
  }

  // Pattern 5: await <locator>.setInputFiles
  if (!locMatch) {
    locMatch = block.match(/await\s+(.+?)\.setInputFiles\(/);
  }

  // Pattern 6: await page.waitForSelector or similar
  if (!locMatch) {
    locMatch = block.match(/await\s+(page\.\w+\(.+?\))\./);
  }

  return locMatch;
}

/**
 * Find the index of the `STEP_ID=<stepId>` marker, rejecting longer numeric keys (so `plan-step-1`
 * does not match inside `plan-step-10`). Returns -1 if not found.
 */
function findStepMarkerIndex(fileText: string, stepId: string): number {
  const needle = `STEP_ID=${stepId}`;
  let from = 0;
  for (;;) {
    const i = fileText.indexOf(needle, from);
    if (i === -1) return -1;
    const next = fileText[i + needle.length];
    // A trailing digit means we matched a prefix of a longer key (plan-step-1 inside plan-step-10);
    // keep looking. Any other char (space, `|`, quote, EOF) means this is the real marker.
    if (next === undefined || !/[0-9]/.test(next)) return i;
    from = i + needle.length;
  }
}

/**
 * Isolate a single step's body. The block runs from the `await test.step` containing the marker to
 * the start of the NEXT `await test.step` (or EOF) — robust to multi-line bodies (e.g. `evaluate`,
 * `checkAccessibility`) whose bodies contain their own `});`, which a naive `indexOf("  });")` would
 * stop at prematurely. Returns null when the step can't be located.
 */
function findStepBlock(
  fileText: string,
  stepId: string
): { blockStart: number; blockEnd: number; block: string } | null {
  const markerIdx = findStepMarkerIndex(fileText, stepId);
  if (markerIdx === -1) return null;

  const blockStart = fileText.lastIndexOf("await test.step", markerIdx);
  if (blockStart === -1) return null;

  const afterMarker = markerIdx + `STEP_ID=${stepId}`.length;
  const nextStepStart = fileText.indexOf("await test.step", afterMarker);
  const blockEnd = nextStepStart === -1 ? fileText.length : nextStepStart;

  return { blockStart, blockEnd, block: fileText.slice(blockStart, blockEnd) };
}

/**
 * Replace the locator expression inside the `test.step` block identified by `stepId` with
 * `newLocatorExpr`. Returns the patched file text + the old locator, or null when the step/locator
 * can't be found.
 */
export function patchLocatorInStepBlock(
  fileText: string,
  stepId: string,
  newLocatorExpr: string
): { patched: string; oldLocator: string } | null {
  const found = findStepBlock(fileText, stepId);
  if (!found) return null;

  const locMatch = matchLocatorInBlock(found.block);
  if (!locMatch?.[1]) return null;

  const oldLocatorExpr = locMatch[1].trim();
  // String first-arg replace is literal (not regex) and replaces only the first occurrence — the
  // locator in this step's body.
  const patchedBlock = found.block.replace(oldLocatorExpr, newLocatorExpr);
  const patched =
    fileText.slice(0, found.blockStart) + patchedBlock + fileText.slice(found.blockEnd);

  return { patched, oldLocator: oldLocatorExpr };
}

/**
 * Return the locator expression currently used in a step's block (without patching), or null. Used
 * to recover the intended target name for deterministic re-grounding when there's no in-memory plan.
 */
export function findLocatorExprInStepBlock(
  fileText: string,
  stepId: string
): string | null {
  const found = findStepBlock(fileText, stepId);
  if (!found) return null;
  const locMatch = matchLocatorInBlock(found.block);
  return locMatch?.[1]?.trim() ?? null;
}

/* ─── intended-target recovery (for deterministic re-grounding, P4.4) ─── */

/** Strip backslash escapes from a generated regex-literal body (best-effort, for name recovery). */
function unescapeRegexBody(s: string): string {
  return s.replace(/\\(.)/g, "$1");
}

/**
 * Recover the human-facing element name from a generated Playwright locator expression — e.g.
 * `page.getByRole('button', { name: 'Sign In', exact: true })` → "Sign In",
 * `page.getByLabel('Email', …)` → "Email", `page.getByRole('heading', { name: /login/i })` → "login".
 * Used to re-ground a failed step when there is no in-memory plan (run_only). Returns null if nothing
 * usable is found.
 */
export function extractTargetFromLocatorExpr(expr: string): string | null {
  if (!expr) return null;

  // name: 'X' | name: "X"
  const nameStr = expr.match(/name:\s*(['"])(.*?)\1/);
  if (nameStr) return nameStr[2] || null;

  // name: /X/flags
  const nameRe = expr.match(/name:\s*\/(.+?)\/[a-z]*\s*[,}]/);
  if (nameRe) return unescapeRegexBody(nameRe[1]) || null;

  // getByTestId('add-to-cart-x') → "add to cart x": humanize `-`/`_` so the id's words become
  // matchable tokens against a real accessible name ("Add to Cart") during re-grounding.
  const testId = expr.match(/getByTestId\(\s*(['"])(.*?)\1/);
  if (testId) {
    const human = testId[2].replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
    return human || null;
  }

  // getByLabel/Placeholder/Text/AltText/Title('X') — already human text
  const byStr = expr.match(
    /getBy(?:Label|Placeholder|Text|AltText|Title)\(\s*(['"])(.*?)\1/
  );
  if (byStr) return byStr[2] || null;

  // getByText(/X/flags)
  const byRe = expr.match(/getByText\(\s*\/(.+?)\/[a-z]*/);
  if (byRe) return unescapeRegexBody(byRe[1]) || null;

  return null;
}

/**
 * The intended element name a plan step targets: `field` for fill/select/slider, `target` for
 * click/hover/check/expect*. Returns null when the step carries neither.
 */
export function intendedTargetForStep(step: any): string | null {
  if (!step || typeof step !== "object") return null;
  const raw = step.field ?? step.target ?? null;
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  return t.length ? t : null;
}

/**
 * Parse a Playwright `ariaSnapshot()` (captured at the moment of failure) into `{role, name}`
 * candidate refs. Matches the quoted-name form `- role "name" [attrs]` / `- role "name":`; ignores
 * property lines (`- /url: …`) and unnamed container nodes. Used by the capture-based heal path.
 */
export function parseAriaSnapshot(text: string): Array<{ role: string; name: string }> {
  const out: Array<{ role: string; name: string }> = [];
  if (!text) return out;
  for (const line of text.split(/\r?\n/)) {
    // e.g.  `  - heading "Order Summary" [level=2]:`  |  `- button "Add to Cart"`
    const m = line.match(/^\s*-\s+([a-zA-Z]+)\s+"((?:[^"\\]|\\.)*)"/);
    if (!m) continue;
    const role = m[1].toLowerCase();
    const name = m[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    out.push({ role, name });
  }
  return out;
}

/** Locator-bearing assertion actions — healing these re-points an assertion target (see policy). */
const ASSERTION_ACTIONS = new Set([
  "expectVisible", "expectNotVisible", "expectText", "expectCount",
  "expectAttribute", "expectValue",
]);

/**
 * True for assertion actions whose locator can be healed. Re-pointing such a step keeps the test
 * green but could mask a real text/content regression, so the report flags it.
 */
export function isAssertionAction(action: string): boolean {
  return ASSERTION_ACTIONS.has(action);
}

/** ARIA roles we re-ground via `getByRole(role, { name })`; everything else falls back to text. */
const SYNTHESIZABLE_ROLES = new Set([
  "heading", "button", "link", "textbox", "combobox", "searchbox", "checkbox",
  "radio", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option",
  "switch", "slider", "spinbutton", "listbox", "menu", "img", "cell", "columnheader",
  "rowheader", "treeitem",
]);

/**
 * Build a working Playwright locator from a captured candidate's `role` + `name` — the capture-based
 * heal synthesizes locators (no live MCP `browser_generate_locator`). Uses a non-exact `getByRole`
 * name match (substring, case-insensitive — tolerant of minor drift) for nameable roles, and
 * `getByText` for text/paragraph/generic nodes. `.first()` guards against ties.
 */
export function synthesizeLocator(role: string, name: string): string {
  const r = (role || "").toLowerCase();
  const nm = JSON.stringify(name);
  if (SYNTHESIZABLE_ROLES.has(r)) {
    return `page.getByRole(${JSON.stringify(r)}, { name: ${nm} }).first()`;
  }
  return `page.getByText(${nm}).first()`;
}

/**
 * Absolute URL of the last `goto` step at or before `failedIndex` — i.e. the page the failed step
 * actually runs on in a multi-page flow. The heal navigation base is still the FIRST goto (so the
 * whole prefix can be replayed to rebuild state); this is used to label the observation's `page_url`
 * so it matches the baseline. Returns null when there is no preceding goto.
 */
export function lastGotoUrlBeforeIndex(
  plannedSteps: any[],
  failedIndex: number,
  baseUrl: string
): string | null {
  if (!Array.isArray(plannedSteps)) return null;
  const end = Math.min(failedIndex, plannedSteps.length - 1);
  for (let i = end; i >= 0; i--) {
    const s = plannedSteps[i];
    if (s && s.action === "goto" && typeof s.url === "string") {
      try {
        return s.url.startsWith("http") ? s.url : new URL(s.url, baseUrl).toString();
      } catch {
        return s.url;
      }
    }
  }
  return null;
}
