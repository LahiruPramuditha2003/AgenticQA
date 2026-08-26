/**
 * RAG Planner Offline Evaluator
 *
 * Runs all 50 templates from TEST_TEMPLATES.md through RagPlannerEngine
 * without a browser. Uses a realistic mock e-commerce pageContext.
 *
 * Usage (after `npm run build`):
 *   node scripts/evalRag.js
 *   node scripts/evalRag.js --verbose   (show full step list per test)
 *   node scripts/evalRag.js --json      (write evalRag-results.json)
 */

const fs = require("fs");
const path = require("path");

// ─── CLI flags ────────────────────────────────────────────────────────────────
const VERBOSE = process.argv.includes("--verbose");
const WRITE_JSON = process.argv.includes("--json");

// ─── Load compiled engine ─────────────────────────────────────────────────────
const distDir = path.resolve(__dirname, "../dist");
if (!fs.existsSync(distDir)) {
  console.error(
    "❌  dist/ not found — run `npm run build` inside packages/orchestrator first."
  );
  process.exit(1);
}

let RagPlannerEngine;
try {
  ({ RagPlannerEngine } = require(path.join(distDir, "knowledge/RagPlannerEngine")));
} catch (e) {
  console.error("❌  Could not load RagPlannerEngine from dist:", e.message);
  process.exit(1);
}

// ─── Mock e-commerce pageContext ──────────────────────────────────────────────
// Simulates a typical TechStore-like SPA with common elements on each page.
const MOCK_PAGE_CONTEXT = {
  url: "http://localhost:5173/",
  inputs: [
    { role: "textbox", name: "Search" },
    { role: "textbox", name: "Email address" },
    { role: "textbox", name: "Password" },
    { role: "textbox", name: "Confirm Password" },
    { role: "textbox", name: "Full Name" },
    { role: "textbox", name: "Address" },
    { role: "textbox", name: "City" },
    { role: "textbox", name: "ZIP Code" },
    { role: "textbox", name: "Phone Number" },
    { role: "textbox", name: "Card Number" },
    { role: "textbox", name: "CVV" },
    { role: "textbox", name: "Expiry Date" },
    { role: "combobox", name: "Category" },
    { role: "combobox", name: "Sort by" },
    { role: "combobox", name: "State" },
  ],
  buttons: [
    { role: "button", name: "Sign In" },
    { role: "button", name: "Register" },
    { role: "button", name: "Add to Cart" },
    { role: "button", name: "Remove from Cart" },
    { role: "button", name: "Checkout" },
    { role: "button", name: "Place Order" },
    { role: "button", name: "Continue" },
    { role: "button", name: "Search" },
    { role: "button", name: "Apply Filter" },
    { role: "button", name: "Save Changes" },
    { role: "button", name: "Delete" },
    { role: "button", name: "Edit" },
    { role: "button", name: "Add Product" },
    { role: "button", name: "Logout" },
    { role: "button", name: "Increase Quantity" },
    { role: "button", name: "Decrease Quantity" },
    { role: "button", name: "Close" },
    { role: "button", name: "Forgot Password" },
  ],
  headings: [
    { role: "heading", name: "Welcome to TechStore" },
    { role: "heading", name: "All Products" },
    { role: "heading", name: "Shopping Cart" },
    { role: "heading", name: "Checkout" },
    { role: "heading", name: "Login" },
    { role: "heading", name: "Register" },
    { role: "heading", name: "My Account" },
    { role: "heading", name: "Order History" },
    { role: "heading", name: "Admin Dashboard" },
  ],
  links: [
    { role: "link", name: "Home" },
    { role: "link", name: "Products" },
    { role: "link", name: "Cart" },
    { role: "link", name: "Login" },
    { role: "link", name: "Laptops" },
    { role: "link", name: "Smartphones" },
    { role: "link", name: "Audio" },
    { role: "link", name: "Wearables" },
    { role: "link", name: "Gaming" },
    { role: "link", name: "Orders" },
    { role: "link", name: "Profile" },
    { role: "link", name: "Settings" },
    { role: "link", name: "Forgot Password?" },
  ],
  selects: [
    { role: "listbox", name: "Category" },
    { role: "listbox", name: "Sort by" },
  ],
  checkboxes: [],
  radios: [
    { role: "radio", name: "Credit Card" },
    { role: "radio", name: "PayPal" },
  ],
  cards: [
    { role: "gridcell", name: "MacBook Air M2" },
    { role: "gridcell", name: "iPhone 15 Pro" },
    { role: "gridcell", name: "Sony WH-1000XM5" },
    { role: "gridcell", name: "AirPods Pro" },
    { role: "gridcell", name: "Gaming Laptop ROG" },
  ],
  gridItems: [
    { role: "gridcell", name: "MacBook Air M2" },
    { role: "gridcell", name: "iPhone 15 Pro" },
    { role: "gridcell", name: "Sony WH-1000XM5" },
  ],
  rawSnapshot: "(mock snapshot)",
};

// ─── Extract prompts from TEST_TEMPLATES.md ──────────────────────────────────
const repoRoot = path.resolve(__dirname, "../../..");
const templatePath = path.join(repoRoot, "benchmarks/TEST_TEMPLATES.md");

if (!fs.existsSync(templatePath)) {
  console.error(`❌  Cannot find TEST_TEMPLATES.md at ${templatePath}`);
  process.exit(1);
}

const mdText = fs.readFileSync(templatePath, "utf8");
// Extract the ### N. Title and the code block that follows
const sectionRegex = /^###\s*(\d+)\.\s*(.+?)\s*\r?\n```\s*\r?\n([\s\S]*?)```/gm;
const templates = [];
let m;
while ((m = sectionRegex.exec(mdText)) !== null) {
  templates.push({
    num: parseInt(m[1], 10),
    title: m[2].trim(),
    prompt: m[3].trim(),
  });
}

if (templates.length === 0) {
  console.error("❌  No templates found in TEST_TEMPLATES.md");
  process.exit(1);
}

console.log(`\n📋  AgenticQA RAG Planner Evaluator`);
console.log(`    Templates found: ${templates.length}`);
console.log(`    Mock page: ${MOCK_PAGE_CONTEXT.url}`);
console.log(`    Inputs: ${MOCK_PAGE_CONTEXT.inputs.length}  Buttons: ${MOCK_PAGE_CONTEXT.buttons.length}  Links: ${MOCK_PAGE_CONTEXT.links.length}\n`);
console.log("─".repeat(80));

// ─── Quality checks ───────────────────────────────────────────────────────────
function qualityFlags(testCases) {
  const flags = [];
  for (const tc of testCases) {
    const actions = tc.steps.map((s) => s.action);
    if (!actions.includes("goto")) flags.push("NO_GOTO");
    if (!actions.includes("waitForLoad") && actions.length > 1) flags.push("NO_WAIT_FOR_LOAD");
    const hasAssertion = actions.some(
      (a) => a === "expectVisible" || a === "expectText" || a === "expectUrlContains"
    );
    if (!hasAssertion) flags.push("NO_ASSERTION");
    const filledFields = tc.steps
      .filter((s) => s.action === "fill")
      .map((s) => s.field);
    const dupes = filledFields.filter((f, i) => filledFields.indexOf(f) !== i);
    if (dupes.length > 0) flags.push(`DUPLICATE_FILL(${[...new Set(dupes)].join(",")})`);
    const placeholderFills = tc.steps.filter(
      (s) =>
        s.action === "fill" &&
        typeof s.value === "string" &&
        (s.value.includes("PLACEHOLDER") || s.value.startsWith("<") || s.value === "")
    );
    if (placeholderFills.length > 0) flags.push(`UNRESOLVED_PLACEHOLDER(${placeholderFills.map((s) => s.field).join(",")})`);
  }
  return [...new Set(flags)];
}

// ─── Run evaluation ───────────────────────────────────────────────────────────
async function main() {
const engine = new RagPlannerEngine();
const results = [];

// Stats counters
let totalOk = 0;
let totalWarn = 0;
let totalEmpty = 0;
let intentCounts = {};

// Category grouping for summary
const CATEGORY_MAP = {
  "Browsing & Product Discovery": [1, 2, 3, 4, 5],
  "Shopping Cart Operations": [6, 7, 8, 9, 10],
  "Checkout Flow": [11, 12, 13, 14],
  "User Authentication": [15, 16, 17, 18, 19, 20],
  "User Account Management": [21, 22, 23, 24],
  "Admin Dashboard": [25, 26, 27, 28],
  "Complex Multi-Step Scenarios": [29, 30, 31, 32, 33],
  "Edge Cases & Error Handling": [34, 35, 36, 37, 38, 39],
  "UI/UX Verification": [40, 41, 42, 43, 44, 45],
  "Advanced Testing Patterns": [46, 47, 48, 49, 50],
};

let currentCategory = "";

for (const tpl of templates) {
  // Print category header
  for (const [cat, nums] of Object.entries(CATEGORY_MAP)) {
    if (nums.includes(tpl.num) && cat !== currentCategory) {
      currentCategory = cat;
      console.log(`\n▶  ${cat}`);
      console.log("─".repeat(80));
    }
  }

  const logs = [];
  const ctx = {
    requestText: tpl.prompt,
    workspacePath: repoRoot,
    pageContext: MOCK_PAGE_CONTEXT,
    effectiveBaseUrl: "http://localhost:5173",
    effectiveStartUrl: "http://localhost:5173/",
  };

  let result;
  try {
    result = await engine.generate(ctx, { log: (msg) => logs.push(msg) });
  } catch (err) {
    console.log(`  [${String(tpl.num).padStart(2, "0")}] ${tpl.title}`);
    console.log(`       ❌  EXCEPTION: ${err.message}`);
    results.push({ num: tpl.num, title: tpl.title, status: "exception", error: err.message });
    totalEmpty++;
    continue;
  }

  const intent = (logs.find((l) => l.startsWith("RagPlanner: intent=")) || "").replace("RagPlanner: intent=", "");
  const patternLine = logs.find((l) => l.startsWith("RagPlanner: adapting pattern")) || "";
  const patternId = patternLine.match(/"([^"]+)"/)?.[1] ?? "(intent fallback)";
  const fromIntent = logs.some((l) => l.includes("generating from intent"));

  intentCounts[intent] = (intentCounts[intent] || 0) + 1;

  const { testCases } = result;
  const totalSteps = testCases.reduce((n, tc) => n + tc.steps.length, 0);
  const flags = qualityFlags(testCases);

  const status = testCases.length === 0 || totalSteps === 0
    ? "empty"
    : flags.length > 0
    ? "warn"
    : "ok";

  if (status === "ok") totalOk++;
  else if (status === "warn") totalWarn++;
  else totalEmpty++;

  // ─── Print result line ────────────────────────────────────────────────────
  const icon = status === "ok" ? "✅" : status === "warn" ? "⚠️ " : "❌";
  const sourceLabel = fromIntent ? "(intent)" : `(pattern: ${patternId})`;
  console.log(
    `  ${icon} [${String(tpl.num).padStart(2, "0")}] ${tpl.title.padEnd(42)} intent=${intent.padEnd(10)} cases=${testCases.length}  steps=${totalSteps}  ${sourceLabel}`
  );

  if (flags.length > 0) {
    console.log(`       ⚑  ${flags.join("  ")}`);
  }

  if (VERBOSE) {
    for (const tc of testCases) {
      console.log(`       📝  "${tc.title}"`);
      for (const s of tc.steps) {
        const detail =
          s.action === "fill"
            ? `field="${s.field}" value="${s.value}"`
            : s.action === "click"
            ? `target="${s.target}"`
            : s.action === "goto"
            ? `url="${s.url}"`
            : s.action === "expectVisible"
            ? `target="${s.target}"`
            : s.action === "select"
            ? `field="${s.field}" option="${s.option}"`
            : JSON.stringify(s).slice(0, 80);
        console.log(`           ${s.action.padEnd(18)} ${detail}`);
      }
    }
  }

  results.push({
    num: tpl.num,
    title: tpl.title,
    prompt: tpl.prompt,
    status,
    intent,
    patternId,
    fromIntent,
    testCases: testCases.length,
    totalSteps,
    flags,
    plan: testCases,
    logs,
  });
}

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log("\n" + "─".repeat(80));
console.log(`\n📊  Summary`);
console.log(`    Total templates : ${templates.length}`);
console.log(`    ✅  OK          : ${totalOk}`);
console.log(`    ⚠️   Warnings    : ${totalWarn}`);
console.log(`    ❌  Empty/error : ${totalEmpty}`);
console.log(`\n    Intent distribution:`);
const sortedIntents = Object.entries(intentCounts).sort((a, b) => b[1] - a[1]);
for (const [intent, count] of sortedIntents) {
  const bar = "█".repeat(count);
  console.log(`      ${intent.padEnd(12)} ${String(count).padStart(2)}  ${bar}`);
}

// Warn list
const warnings = results.filter((r) => r.status === "warn" || r.status === "empty");
if (warnings.length > 0) {
  console.log(`\n    Templates needing attention:`);
  for (const r of warnings) {
    const icon = r.status === "empty" ? "❌" : "⚠️ ";
    console.log(`      ${icon} [${String(r.num).padStart(2, "0")}] ${r.title}  →  ${(r.flags || []).join(", ") || r.error || "no steps"}`);
  }
}

console.log();

if (WRITE_JSON) {
  const outPath = path.join(__dirname, "../evalRag-results.json");
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`📄  Full results written to ${path.relative(process.cwd(), outPath)}\n`);
}
} // end main()

main().catch(e => { console.error(e); process.exit(1); });
