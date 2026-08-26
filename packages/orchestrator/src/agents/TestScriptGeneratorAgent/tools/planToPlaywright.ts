import { stepIdMarker } from "../../../core/utils/stepKeys";

type Step =
  | { action: "goto"; url: string; description?: string }
  | { action: "click"; target: string; description?: string; waitFor?: number }
  | { action: "fill"; field: string; value: string }
  | { action: "expectVisible"; target: string; timeout?: number }
  | { action: "expectNotVisible"; target: string; timeout?: number }
  | { action: "expectText"; target: string; text: string; mode?: "contains" | "equals" | "startsWith" | "endsWith" }
  | { action: "expectCount"; target: string; count: number; comparison?: "equal" | "atLeast" | "atMost" | "greaterThan" | "lessThan" }
  | { action: "expectUrl"; url: string; mode?: "equals" | "contains" | "startsWith" }
  | { action: "expectUrlContains"; value: string }
  | { action: "waitFor"; timeout: number; description?: string }
  | { action: "waitForLoad"; description?: string }
  | { action: "select"; field: string; option: string; by?: "text" | "value" | "index" }
  | { action: "slider"; field: string; value: number }
  | { action: "check"; target: string }
  | { action: "uncheck"; target: string }
  | { action: "hover"; target: string }
  | { action: "press"; key: string; target?: string }
  | { action: "scroll"; direction: "up" | "down" | "left" | "right"; amount?: number }
  | { action: "screenshot"; description?: string }
  | { action: "evaluate"; code: string; description?: string }
  | { action: "expectAttribute"; target: string; attribute: string; value: string; mode?: "contains" | "equals" }
  | { action: "setViewport"; width: number; height: number }
  | { action: "measurePerformance"; metric: "LCP" | "FCP" | "load"; maxTimeMs: number }
  | { action: "checkAccessibility"; description?: string }
  | { action: "simulateApiError"; enable: boolean };

type TestCase = { title: string; description?: string; tags?: string[]; steps: Step[] };
type TestPlan = { testCases: TestCase[] };

function jsString(s: string) {
  return JSON.stringify(s);
}

function stripSurroundingQuotes(s: string): string {
  // Remove surrounding quotes from target strings (LLM sometimes includes them)
  s = s.trim();
  // Remove matching pairs of quotes at start and end
  while (s.length >= 2 && (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'")) ||
    (s.startsWith('"') && s.endsWith('"'))
  )) {
    s = s.slice(1, -1);
  }
  return s;
}

function stripRolePrefixes(s: string): string {
  // Remove role prefixes from targets (e.g., "textbox \"Search\"" → "Search")
  // This handles cases where the planner incorrectly includes role prefixes
  
  // Handle format like: heading "Welcome to TechStore" → Welcome to TechStore
  const quoteMatch = s.match(/^(heading|textbox|link|button|combobox|checkbox|radio|listbox|menuitem|tab|role)\s+"([^"]+)"/i);
  if (quoteMatch) {
    return quoteMatch[2].trim();
  }
  
  // Handle format like: heading 'Welcome to TechStore' → Welcome to TechStore  
  const singleQuoteMatch = s.match(/^(heading|textbox|link|button|combobox|checkbox|radio|listbox|menuitem|tab|role)\s+'([^']+)'/i);
  if (singleQuoteMatch) {
    return singleQuoteMatch[2].trim();
  }
  
  // Handle format like: heading Welcome → Welcome
  const rolePattern = /^(heading|textbox|link|button|combobox|checkbox|radio|listbox|menuitem|tab|role)\s+/i;
  const match = s.match(rolePattern);
  if (match) {
    s = s.slice(match[0].length).trim();
  }
  
  return s.trim();
}

function escapeRegex(s: string): string {
  // Escape all regex special characters: \ ^ $ * + ? . ( ) { } [ ] | /
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * Emit `new RegExp(<literal>)` for an anchored match on `text` (D41).
 *
 * The old code interpolated the escaped text straight into a double-quoted literal —
 * `new RegExp("^${escaped}")` — which escapes regex metacharacters but NOT the quote that terminates
 * the string. A target containing a double quote produced `new RegExp("^He said "hi"")`: a syntax
 * error, and because it is a *parse* failure it takes down every test in the file, not just its step.
 *
 * Escaping happens in two different grammars here and both are required: `escapeRegex` for the regex,
 * then `jsString` (JSON.stringify) for the JavaScript string that carries it.
 */
/**
 * Locator for a checkbox the plan named (D40).
 *
 * The previous form appended an UNNAMED catch-all — `.or(page.getByRole('checkbox')).first()`. Two
 * things go wrong with that. `.or()` is a **union**, and `.first()` picks the DOM-first member *across*
 * the union — so an unrelated checkbox earlier in the page wins even when the named one exists. And when
 * the named one does not exist, the step ticks an arbitrary box and the test **passes**, which is worse
 * than failing: a green run that asserted nothing it claimed to.
 *
 * A named target now resolves by name only. The bare-checkbox fallback survives for the genuinely
 * unnamed case (a lone checkbox with no accessible name), where it is the best available guess.
 */
function checkboxLocator(target: string | undefined): string {
  const name = (target ?? "").trim();
  if (!name) {
    return `page.getByRole('checkbox').first()`;
  }
  // A wrapping <label> containing links (e.g. "I agree to the Terms…") does not always expose an
  // accessible name, so getByLabel stays as a second attempt — it is still bound to the same text.
  return (
    `page.getByRole('checkbox', { name: ${jsString(name)} })` +
    `.or(page.getByLabel(${jsString(name)})).first()`
  );
}

function anchoredRegexExpr(text: string, anchor: "start" | "end"): string {
  const body = escapeRegex(text);
  return `new RegExp(${jsString(anchor === "start" ? `^${body}` : `${body}$`)})`;
}

function regexLiteral(pattern: string, flags = "i") {
  const escaped = escapeRegex(pattern);
  return `/${escaped}/${flags}`;
}

/**
 * A results heading of the form `<Something> - "<query>"` is built at runtime, and apps are inconsistent
 * about the quotes. Emit a locator that tolerates them either way.
 *
 * G3.4: the pattern used to be anchored to the literal `all products`, which is demo-web's products
 * heading. The SHAPE — a label, a dash, then a quoted value — is app-neutral, so the literal is gone.
 * Widening it is safe: a target without that shape returns null, and one with it matches the same text
 * either way; the only change is quote tolerance.
 */
function regexOptionalQuotedSearchHeading(target: string): string | null {
  const match = target.match(/^(.+?)\s*[-–—]\s*"(.+)"$/);
  if (!match) return null;
  const heading = match[1];
  const query = match[2].replace(/^"(.+)"$/g, "$1");
  const escapedHeading = escapeRegex(heading);
  const escapedQuery = escapeRegex(query);
  return `/${escapedHeading}\\s*[-–—]\\s*\"?${escapedQuery}\"?/i`;
}

function normalizeName(raw: string): string {
  // Only normalize whitespace. A leading role word is already removed by stripRolePrefixes;
  // do NOT strip role words mid-name or element names that legitimately contain them get
  // mangled (e.g. "Send Reset Link" → "Send Reset", "Add to Wishlist").
  return raw.replace(/\s+/g, " ").trim();
}

function inferRole(target: string): "button" | "link" | "heading" | undefined {
  // Treat a role word as a hint only when it LEADS the target (e.g. 'link "Products"'), never
  // when it's part of the name — "Send Reset Link" is a button, not a link.
  const t = target.trim().toLowerCase();
  if (/^(heading|title)\b/.test(t)) return "heading";
  if (/^link\b/.test(t)) return "link";
  if (/^button\b/.test(t)) return "button";
  return undefined;
}

/**
 * Roles of the app's real elements, by lowercased accessible name (G3.4). Supplied from the live page
 * inventory so codegen can KNOW whether "Products" is a link, a heading or a button.
 *
 * Everything below that consults a name list is a FALLBACK for names this map does not contain.
 */
export type RoleByName = Record<string, string>;

let roleLookup: RoleByName = {};

/** Role of an element by name, or undefined when the page never reported one. */
function knownRole(name: string): string | undefined {
  return roleLookup[name.trim().toLowerCase()];
}

/**
 * Is this click target a navigation link?
 *
 * ⚠️ The fallback list below is demo-web's nav items. It is knowingly app-specific and knowingly
 * inadequate — but it is only consulted when the page inventory did not report the element, and an
 * attempt to replace it with a *better guess* (G3.4, first try) made things worse, not better: judging
 * by label shape ("short and not a verb") reclassified 40 of 48 demo-web specs, turning the headings
 * `All Products` and `Order Summary` into `getByRole('link')`. Without seeing the page you cannot tell a
 * nav link from a heading, so the fix is to SEE THE PAGE, which `roleLookup` now does. Do not replace
 * the fallback with a cleverer heuristic; shrink it by making the role map cover more cases.
 */
function isNavLinkTarget(target: string): boolean {
  const normalized = target.trim().toLowerCase();
  const role = knownRole(normalized);
  if (role) {return role === "link";}
  return [
    "products",
    "cart",
    "shopping cart",
    "login",
    "sign up",
    "home",
    "account",
    "orders",
  ].includes(normalized);
}

function isLikelyHeadingTarget(target: string): boolean {
  const normalized = target.trim().toLowerCase();
  if (!normalized) return false;
  // The live page settles it when it knows the element (G3.4). Only guess for names it never reported.
  const role = knownRole(normalized);
  if (role) {return role === "heading";}
  // Emoji prefix → button/icon, not a heading
  if (/^\p{Emoji}/u.test(target.trim())) return false;
  const nonHeadingKeywords = [
    "add to cart",
    "search",
    "submit",
    "login",
    "sign in",
    "sign out",
    "logout",
    "register",
    "checkout",
    "cart",
    "filter",
    "sort",
    "price",
    "rating",
    "description",
    "button",
    "link",
    "select",
    "option",
    "view all",
    "new arrivals",
    "next",
    "previous",
    "back",
    "apply",
    "save",
    "remove",
    "continue",
    "buy",
    "pay",
    "order",
    "payment",
    "profile",
    "account",
    "user menu",
    "customer",
    "admin",
    "menu",
    "shop now",
    "start shopping",
    "view",
    "clear",
    // error / toast / status messages are never headings — assert them as text
    "invalid",
    "incorrect",
    "do not match",
    "must",
    "failed",
    "required",
    "successfully",
    "sent",
    "not found",
    "unable",
    "error",
    "resend",
  ];
  if (nonHeadingKeywords.some((kw) => normalized.includes(kw))) return false;
  const words = normalized.split(/\s+/).filter(Boolean);
  return words.length <= 4;
}

function locatorForClick(target: string): string {
  // Strip quotes and role prefixes from target
  target = stripSurroundingQuotes(target);
  target = stripRolePrefixes(target);
  
  const role = inferRole(target);
  const name = normalizeName(target) || target.trim();
  const lower = name.toLowerCase();

  const testIdMatch = name.match(/^\[?data-testid=['"]?([^'"\]]+)['"]?\]?$/i);
  if (testIdMatch) {
    return `page.getByTestId(${jsString(testIdMatch[1])})`;
  }
  
  if (role) {
    const baseLocator = `page.getByRole(${jsString(role)}, { name: ${jsString(name)}, exact: true })`;
    if (role === 'button') {
      return `${baseLocator}.first()`;
    }
    return baseLocator;
  }

  const isNavLink = isNavLinkTarget(name);
  if (isNavLink && !lower.includes("submit") && !lower.includes("apply") && !lower.includes("save")) {
    return `page.getByRole('link', { name: ${jsString(name)}, exact: true })`;
  }

  const buttonKeywords = [
    'search',
    'submit',
    'login',
    'sign in',
    'sign up',
    'register',
    'create account',
    'logout',
    'log out',
    'sign out',
    'add to cart',
    'checkout',
    'remove',
    'continue',
    'apply',
    'save',
    'update',
    'next',
    'previous',
    'back',
    'buy',
    'place order',
    'pay',
    'filter',
    'sort',
    'clear',
    'close',
  ];
  const isButtonAction = buttonKeywords.some((keyword) => lower.includes(keyword));
  if (isButtonAction) {
    // exact:false so emoji/icon-prefixed buttons (e.g. "🚪 Logout", "👤 Customer") still match,
    // and a heading sharing the label (e.g. the "Create Account" page title) is excluded by role.
    return `page.getByRole('button', { name: ${jsString(name)} }).first()`;
  }

  if (name.length < 20 && isNavLinkTarget(name)) {
    return `page.getByRole('link', { name: ${jsString(name)}, exact: true })`;
  }

  // .and(':visible') excludes matches inside hidden <select><option> elements,
  // which resolve via getByText but can never become clickable.
  return `page.getByText(${jsString(name)}, { exact: true }).and(page.locator(':visible')).first()`;
}

function locatorForField(field: string): string {
  field = stripSurroundingQuotes(field);
  field = stripRolePrefixes(field);
  const testIdMatch = field.match(/^\[?data-testid=['"]?([^'"\]]+)['"]?\]?$/i);
  if (testIdMatch) {
    return `page.getByTestId(${jsString(testIdMatch[1])})`;
  }
  if (!field) {
    return `page.getByLabel(${jsString(field)})`;
  }
  // "..." suffix (e.g. "Search products...") → actual placeholder text
  if (/\.\.\./.test(field)) {
    return `page.getByPlaceholder(${jsString(field)}).first()`;
  }
  if (/^(textbox|combobox|textarea|searchbox)\b/i.test(field)) {
    const cleaned = field.replace(/^(textbox|combobox|textarea|searchbox)\b/i, '').trim();
    return `page.getByLabel(${jsString(cleaned || field)}, { exact: false }).first()`;
  }
  // Default: use label (accessible name), which works for Email, Password, Search, etc.
  return `page.getByLabel(${jsString(field)}, { exact: false }).or(page.getByPlaceholder(${jsString(field)})).first()`;
}

function locatorForExpectVisible(target: string): string {
  // Handle textbox placeholder expectations
  if (/^textbox\s+/i.test(target)) {
    const after = target.replace(/^textbox\s+/i, '').trim();
    const field = stripSurroundingQuotes(after);
    return `page.getByPlaceholder(${jsString(field)}).first()`;
  }
  // Heading handling for expectVisible
  if (/^heading\s+/i.test(target)) {
    const after = target.replace(/^heading\s+/i, '').trim();
    const heading = stripSurroundingQuotes(after);
    return `page.getByRole('heading', { name: ${regexLiteral(heading)} })`;
  }

  target = stripSurroundingQuotes(target);
  target = stripRolePrefixes(target);

  const testIdMatch = target.match(/\[data-testid=['"]([^'"]+)['"]\]/) ||
                      target.match(/data-testid=['"]([^'"]+)['"]/);
  if (testIdMatch) {
    return `page.getByTestId(${jsString(testIdMatch[1])})`;
  }

  const placeholderCandidate = target.trim();
  // Only treat as placeholder when the field name itself ends with "..." (real placeholder text)
  if (/\.\.\./.test(placeholderCandidate)) {
    return `page.getByPlaceholder(${jsString(placeholderCandidate)}).first()`;
  }

  const t = target.toLowerCase();
  const role = inferRole(target);
  const searchHeadingRegex = regexOptionalQuotedSearchHeading(target);
  if (searchHeadingRegex) {
    return `page.getByText(${searchHeadingRegex})`;
  }

  if (role === "heading") {
    if (t.includes("login"))
      return `page.getByRole('heading', { name: ${regexLiteral("login")} })`;
    if (t.includes("dashboard"))
      return `page.getByRole('heading', { name: ${regexLiteral("dashboard")} })`;
    if (t.includes("welcome"))
      return `page.getByRole('heading', { name: ${regexLiteral("welcome")} })`;
    if (t.includes("filter"))
      return `page.getByRole('heading', { name: ${regexLiteral("filter")} })`;

    const searchHeadingRegex = regexOptionalQuotedSearchHeading(target);
    if (searchHeadingRegex) {
      return `page.getByText(${searchHeadingRegex})`;
    }

    const name = normalizeName(target);
    if (name && name !== "heading")
      return `page.getByRole('heading', { name: ${regexLiteral(name)} })`;

    return `page.getByText(${jsString(target)}, { exact: true }).first()`;
  }

  if (role === "button") {
    const name = normalizeName(target) || target.trim();
    return `page.getByRole('button', { name: ${jsString(name)}, exact: true }).first()`;
  }

  if (role === "link") {
    const name = normalizeName(target) || target.trim();
    return `page.getByRole('link', { name: ${jsString(name)}, exact: true })`;
  }

  const name = normalizeName(target) || target.trim();
  const normalized = target.trim().toLowerCase();
  if (!role && isNavLinkTarget(normalized)) {
    return `page.getByRole('link', { name: ${jsString(target.trim())}, exact: true })`;
  }
  if (!role && isLikelyHeadingTarget(target)) {
    return `page.getByRole('heading', { name: ${jsString(name)}, exact: true })`;
  }
  return `page.getByText(${jsString(name)}, { exact: true }).first()`;
}

/**
 * Step ID marker — shared with the UiInspectorAgent baseline `step_key` via core/utils/stepKeys.
 * Carries the test case since D7: two test cases used to emit the same `plan-step-1`.
 */
function stepId(i: number, tcIdx: number) {
  return stepIdMarker(i, tcIdx);
}

export function planToPlaywrightTs(opts: {
  plan: TestPlan;
  baseUrl: string;
  startUrl?: string;
  stepLocators?: Record<string, string>;
  /** Real element roles by lowercased name, from the live page inventory (G3.4). */
  roleByName?: RoleByName;
}): string {
  const { plan, baseUrl, stepLocators } = opts;
  roleLookup = opts.roleByName ?? {};

  const tests: string[] = [];

  for (let tcIdx = 0; tcIdx < plan.testCases.length; tcIdx++) {
    const tc = plan.testCases[tcIdx];
    const lines: string[] = [];
    let stepIndex = 0;
    const steps = tc.steps;

    lines.push(`test(${jsString(tc.title)}, async ({ page }) => {`);

    for (const s of steps) {

      const label = `${stepId(stepIndex, tcIdx)} | ${s.action}`;
      lines.push(`  await test.step(${jsString(label)}, async () => {`);
      // Use new locator key format: "tcIdx-stepNum" (e.g., "0-1", "1-3")
      const locatorKey = `${tcIdx}-${stepIndex + 1}`;
      const overrideLocator = stepLocators?.[locatorKey];

      if (s.action === "goto") {
        const urlExpr = s.url.startsWith("http")
          ? jsString(s.url)
          : `new URL(${jsString(s.url)}, ${jsString(baseUrl)}).toString()`;
        lines.push(`    await page.goto(${urlExpr});`);
      } else if (s.action === "fill") {
        const shouldClear = false; // Don't clear by default - fill() replaces content
        if (overrideLocator) {
          if (shouldClear) {
            lines.push(`    await ${overrideLocator}.clear();`);
          }
          lines.push(
            `    await ${overrideLocator}.fill(${jsString(s.value)});`
          );
        } else {
          if (shouldClear) {
            lines.push(`    await ${locatorForField(s.field)}.clear();`);
          }
          lines.push(
            `    await ${locatorForField(s.field)}.fill(${jsString(s.value)});`
          );
        }
      } else if (s.action === "click") {
        if (s.waitFor) {
          lines.push(`    await page.waitForTimeout(${s.waitFor});`);
        }
        if (overrideLocator) {
          // Use force: true for mobile to handle overlapping elements in responsive layouts
          lines.push(`    await ${overrideLocator}.click({ force: true });`);
        } else {
          lines.push(`    await ${locatorForClick(s.target)}.click();`);
        }
      } else if (s.action === "select") {
        const selectBy = s.by ?? "text";
        const locator = overrideLocator || locatorForField(s.field);
        if (selectBy === "text") {
          lines.push(`    await ${locator}.selectOption({ label: ${jsString(s.option)} });`);
        } else if (selectBy === "value") {
          lines.push(`    await ${locator}.selectOption({ value: ${jsString(s.option)} });`);
        } else {
          lines.push(`    await ${locator}.selectOption(${jsString(s.option)});`);
        }
      } else if (s.action === "slider") {
        const locator = overrideLocator || locatorForField(s.field);
        lines.push(`    await ${locator}.fill(${jsString(String(s.value))});`);
      } else if (s.action === "check") {
        lines.push(`    await ${overrideLocator || checkboxLocator(s.target)}.check();`);
      } else if (s.action === "uncheck") {
        lines.push(`    await ${overrideLocator || checkboxLocator(s.target)}.uncheck();`);
      } else if (s.action === "hover") {
        const locator = overrideLocator || locatorForClick(s.target);
        lines.push(`    await ${locator}.hover();`);
      } else if (s.action === "press") {
        if (s.target) {
          const locator = overrideLocator || locatorForClick(s.target);
          lines.push(`    await ${locator}.press(${jsString(s.key)});`);
        } else {
          lines.push(`    await page.keyboard.press(${jsString(s.key)});`);
        }
      } else if (s.action === "scroll") {
        const amount = s.amount ?? 500;
        const scrollMap = {
          up: `window.scrollBy(0, -${amount})`,
          down: `window.scrollBy(0, ${amount})`,
          left: `window.scrollBy(-${amount}, 0)`,
          right: `window.scrollBy(${amount}, 0)`,
        };
        lines.push(`    await page.evaluate(() => ${scrollMap[s.direction]});`);
      } else if (s.action === "screenshot") {
        const desc = s.description ? s.description.replace(/[^a-z0-9]+/gi, "-") : `step-${stepIndex}`;
        lines.push(`    await page.screenshot({ path: \`screenshot-${desc}.png\` });`);
      } else if (s.action === "evaluate") {
        lines.push(`    await page.evaluate(() => { ${s.code} });`);
      } else if (s.action === "expectAttribute") {
        const locator = overrideLocator || locatorForExpectVisible(s.target);
        const mode = s.mode ?? "contains";
        if (mode === "equals") {
          lines.push(`    await expect(${locator}).toHaveAttribute(${jsString(s.attribute)}, ${jsString(s.value)});`);
        } else {
          const escaped = s.value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
          lines.push(`    await expect(${locator}).toHaveAttribute(${jsString(s.attribute)}, new RegExp(${jsString(escaped)}));`);
        }
      } else if (s.action === "setViewport") {
        lines.push(`    await page.setViewportSize({ width: ${s.width}, height: ${s.height} });`);
      } else if (s.action === "measurePerformance") {
        lines.push(`    // Measure performance: ${s.metric}`);
        lines.push(`    const duration = await page.evaluate(metric => {`);
        lines.push(`      if (metric === 'load') {`);
        lines.push(`        return window.performance.getEntriesByType('navigation')[0]?.duration || 0;`);
        lines.push(`      }`);
        lines.push(`      const entries = window.performance.getEntriesByType('paint');`);
        lines.push(`      const paint = entries.find(e => e.name === (metric === 'FCP' ? 'first-contentful-paint' : 'largest-contentful-paint'));`);
        lines.push(`      return paint ? paint.startTime : 0;`);
        lines.push(`    }, ${jsString(s.metric)});`);
        lines.push(`    expect(duration).toBeLessThanOrEqual(${s.maxTimeMs});`);
      } else if (s.action === "checkAccessibility") {
        lines.push(`    // Inject axe-core and run accessibility check`);
        lines.push(`    await page.addScriptTag({ url: 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.7.0/axe.min.js' });`);
        lines.push(`    const violations = await page.evaluate(async () => {`);
        lines.push(`       // @ts-ignore`);
        lines.push(`       const results = await axe.run();`);
        lines.push(`       return results.violations;`);
        lines.push(`    });`);
        lines.push(`    expect(violations.length, "Accessibility violations: " + JSON.stringify(violations)).toBe(0);`);
      } else if (s.action === "simulateApiError") {
        lines.push(`    await page.evaluate((enable) => {`);
        lines.push(`       if (enable) localStorage.setItem('SIMULATE_API_ERROR', 'true');`);
        lines.push(`       else localStorage.removeItem('SIMULATE_API_ERROR');`);
        lines.push(`    }, ${s.enable});`);
      } else if (s.action === "expectVisible") {
        const timeout = s.timeout ? `, { timeout: ${s.timeout} }` : "";
        if (overrideLocator) {
          lines.push(
            `    await expect(${overrideLocator}).toBeVisible()${timeout};`
          );
        } else {
          lines.push(
            `    await expect(${locatorForExpectVisible(s.target)}).toBeVisible()${timeout};`
          );
        }
      } else if (s.action === "expectNotVisible") {
        const timeout = s.timeout ? `, { timeout: ${s.timeout} }` : "";
        if (overrideLocator) {
          lines.push(
            `    await expect(${overrideLocator}).not.toBeVisible()${timeout};`
          );
        } else {
          lines.push(
            `    await expect(${locatorForExpectVisible(s.target)}).not.toBeVisible()${timeout};`
          );
        }
      } else if (s.action === "expectText") {
        const mode = s.mode ?? "contains";
        // Strip quotes and role prefixes from target
        let cleanTarget = stripSurroundingQuotes(s.target);
        cleanTarget = stripRolePrefixes(cleanTarget);
        
        let locator: string;
        // Check if target looks like a testid selector
        if (cleanTarget.startsWith("[data-testid=") || cleanTarget.startsWith("data-testid=")) {
          const testIdMatch = cleanTarget.match(/\[data-testid=['"]([^'"]+)['"]\]/);
          const testId = testIdMatch ? testIdMatch[1] : cleanTarget.replace(/.*data-testid=['"]([^'"]+)['"].*/, "$1");
          locator = `page.getByTestId(${jsString(testId)})`;
        } else {
          locator = overrideLocator || locatorForExpectVisible(s.target);
        }
        
        if (mode === "contains") {
          lines.push(`    await expect(${locator}).toContainText(${jsString(s.text)});`);
        } else if (mode === "equals") {
          lines.push(`    await expect(${locator}).toHaveText(${jsString(s.text)});`);
        } else if (mode === "startsWith") {
          lines.push(`    await expect(${locator}).toHaveText(${anchoredRegexExpr(s.text, "start")});`);
        } else if (mode === "endsWith") {
          lines.push(`    await expect(${locator}).toHaveText(${anchoredRegexExpr(s.text, "end")});`);
        }
      } else if (s.action === "expectCount") {
        const locator = overrideLocator || `page.getByText(${jsString(s.target)})`;
        const comparison = s.comparison ?? "equal";
        const count = s.count;
        
        // D39: `atLeast`/`atMost` used to emit `toHaveCount(n)` — exact equality — while the trailing
        // comment claimed otherwise. "At least 3 products" then FAILED whenever there were 4. The
        // inequality forms read the count and compare it, matching the shape already used below.
        //
        // `n` is scoped to this step's arrow function, so two count steps in one test cannot collide.
        if (comparison === "equal") {
          lines.push(`    await expect(${locator}).toHaveCount(${count});`);
        } else if (comparison === "atLeast") {
          lines.push(`    const n = await ${locator}.count(); expect(n).toBeGreaterThanOrEqual(${count});`);
        } else if (comparison === "atMost") {
          lines.push(`    const n = await ${locator}.count(); expect(n).toBeLessThanOrEqual(${count});`);
        } else if (comparison === "greaterThan") {
          lines.push(`    const n = await ${locator}.count(); expect(n).toBeGreaterThan(${count});`);
        } else if (comparison === "lessThan") {
          lines.push(`    const n = await ${locator}.count(); expect(n).toBeLessThan(${count});`);
        }
      } else if (s.action === "expectUrl") {
        const mode = s.mode ?? "contains";
        if (mode === "equals") {
          lines.push(`    await expect(page).toHaveURL(${jsString(s.url)});`);
        } else if (mode === "contains") {
          const escapedUrl = s.url.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
          lines.push(`    await expect(page).toHaveURL(new RegExp(${jsString(escapedUrl)}));`);
        } else if (mode === "startsWith") {
          lines.push(`    await expect(page).toHaveURL(${anchoredRegexExpr(s.url, "start")});`);
        }
      } else if (s.action === "expectUrlContains") {
        const escapedValue = s.value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
        lines.push(
          `    await expect(page).toHaveURL(new RegExp(${jsString(escapedValue)}));`
        );
      } else if (s.action === "waitFor") {
        lines.push(`    await page.waitForTimeout(${s.timeout});`);
      } else if (s.action === "waitForLoad") {
        // networkidle resolves as soon as all in-flight requests finish (faster than fixed 1500ms),
        // falls back to a short timeout if network never goes idle (e.g. background polling).
        lines.push(`    await page.waitForLoadState('networkidle', { timeout: 1500 }).catch(() => {});`);
      } else {
        // D42 — exhaustiveness guard.
        //
        // This chain had no `else`. Every one of the 24 actions in `schema.ts` happens to be handled
        // today, so nothing was broken — but the NEXT action added to the schema would have silently
        // emitted `await test.step("…", async () => {});`: an empty step that always passes and that
        // `auditSpecSubstance.js` cannot see, because a step with no assertion looks the same as a step
        // whose assertion was legitimately grounded away.
        //
        // The `never` assignment turns that omission into a COMPILE error at the moment the schema
        // grows, which is the only point where the author still has the context to handle it.
        const unhandled: never = s;
        throw new Error(
          `planToPlaywrightTs: no codegen for step action "${(unhandled as { action?: string }).action}". ` +
            `Add a branch here when you add an action to TestPlannerAgent/schema.ts.`
        );
      }

      lines.push(`  });`);
      stepIndex++;
    }

    lines.push(`});`);
    tests.push(lines.join("\n"));
  }

  return `import { test, expect } from '@playwright/test';

${tests.join("\n\n")}
`;
}