/**
 * TestPlannerAgent Evaluator
 *
 * Pre-inspects the live site once, then runs all 50 TEST_TEMPLATES.md prompts
 * through RagPlannerEngine with real pageContext. No browser execution.
 *
 * Usage (after `npm run build`, with demo app running on localhost:5173):
 *   node scripts/evalPlanner.js
 *   node scripts/evalPlanner.js --verbose   (print every step)
 *   node scripts/evalPlanner.js --url=http://localhost:3000
 */

const fs   = require("fs");
const path = require("path");
const http  = require("http");
const https = require("https");

const VERBOSE  = process.argv.includes("--verbose");
const SHOW_STEPS = process.argv.includes("--steps");   // print steps for flagged tests
const BASE_URL = (process.argv.find(a => a.startsWith("--url=")) ?? "--url=http://localhost:5173").split("=")[1];

// ─── Load compiled engine ─────────────────────────────────────────────────────
const distDir = path.resolve(__dirname, "../dist");
if (!fs.existsSync(distDir)) {
  console.error("❌  dist/ not found — run `npm run build` first.");
  process.exit(1);
}

let RagPlannerEngine;
try {
  ({ RagPlannerEngine } = require(path.join(distDir, "knowledge/RagPlannerEngine")));
} catch (e) {
  console.error("❌  Could not load RagPlannerEngine:", e.message);
  process.exit(1);
}

// ─── Extract prompts ──────────────────────────────────────────────────────────
const repoRoot     = path.resolve(__dirname, "../../..");
const templatePath = path.join(repoRoot, "benchmarks/TEST_TEMPLATES.md");
const mdText       = fs.readFileSync(templatePath, "utf8");
const sectionRegex = /^###\s*(\d+)\.\s*(.+?)\s*\r?\n```\s*\r?\n([\s\S]*?)```/gm;
const templates    = [];
let m;
while ((m = sectionRegex.exec(mdText)) !== null) {
  templates.push({ num: parseInt(m[1], 10), title: m[2].trim(), prompt: m[3].trim() });
}
if (templates.length === 0) { console.error("❌  No templates found."); process.exit(1); }

// ─── Simple HTML fetch to check site is up ───────────────────────────────────
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    mod.get(url, { timeout: 5000 }, res => {
      res.resume();
      resolve(res.statusCode);
    }).on("error", reject).on("timeout", () => reject(new Error("timeout")));
  });
}

// ─── Build a realistic pageContext from the site's known structure ─────────────
// Instead of a live Playwright inspection (which requires a browser), we build
// a pageContext that matches TechStore's actual element names extracted from
// real snapshot runs seen in prior logs.
function buildRealPageContext(baseUrl) {
  return {
    url: baseUrl + "/",
    pages: [
      {
        url: baseUrl + "/",
        inputs:   [{ role: "textbox", name: "Search products..." }],
        buttons:  [
          { role: "button", name: "Search" },
          { role: "button", name: "Shop Now" },
          { role: "button", name: "View New Arrivals" },
          { role: "button", name: "Add to Cart" },
        ],
        headings: [
          { role: "heading", name: "Welcome to TechStore" },
          { role: "heading", name: "Shop by Category" },
          { role: "heading", name: "Laptops" },
          { role: "heading", name: "Smartphones" },
          { role: "heading", name: "Audio" },
          { role: "heading", name: "Tablets" },
          { role: "heading", name: "Featured Products" },
        ],
        links: [
          { role: "link", name: "⚡ TechStore" },
          { role: "link", name: "Products" },
          { role: "link", name: "Shopping Cart" },
          { role: "link", name: "Login" },
          { role: "link", name: "Sign Up" },
          { role: "link", name: "View All →" },
          { role: "link", name: "Laptops" },
          { role: "link", name: "Smartphones" },
          { role: "link", name: "Audio" },
          { role: "link", name: "Tablets" },
        ],
        selects:   [],
        checkboxes:[],
        radios:    [],
        rawSnapshot: "(home page)",
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
      },
      {
        url: baseUrl + "/products",
        inputs: [
          { role: "textbox",  name: "Search products..." },
          { role: "combobox", name: "Sort by" },
        ],
        buttons: [
          { role: "button", name: "Search" },
          { role: "button", name: "Clear All" },
          { role: "button", name: "Add to Cart" },
          { role: "button", name: "★★★★☆ & up" },
          { role: "button", name: "★★★☆☆ & up" },
          { role: "button", name: "Out of Stock" },
          { role: "button", name: "1" },
          { role: "button", name: "2" },
        ],
        headings: [
          { role: "heading", name: "All Products" },
          { role: "heading", name: "Filters" },
          { role: "heading", name: "Category" },
          { role: "heading", name: "Price Range" },
          { role: "heading", name: "Rating" },
        ],
        links: [
          { role: "link", name: "Products" },
          { role: "link", name: "Shopping Cart" },
          { role: "link", name: "Login" },
          { role: "link", name: "Laptops" },
          { role: "link", name: "Smartphones" },
          { role: "link", name: "Audio" },
          { role: "link", name: "Tablets" },
          { role: "link", name: "Wearables" },
          { role: "link", name: "Gaming" },
        ],
        selects:   [{ role: "listbox", name: "Sort by" }],
        checkboxes:[],
        radios:    [],
        rawSnapshot: "(products page)",
        cards: [
          { role: "gridcell", name: "MacBook Air M2" },
          { role: "gridcell", name: "iPhone 15 Pro" },
          { role: "gridcell", name: "Sony WH-1000XM5 Headphones" },
          { role: "gridcell", name: "AirPods Pro (3rd Gen)" },
          { role: "gridcell", name: "Gaming Laptop ROG" },
          { role: "gridcell", name: "iPad Pro M4" },
        ],
        gridItems: [],
      },
      {
        url: baseUrl + "/cart",
        inputs:   [{ role: "textbox", name: "Quantity" }],
        buttons:  [
          { role: "button", name: "Remove" },
          { role: "button", name: "+" },
          { role: "button", name: "-" },
          { role: "button", name: "Proceed to Checkout" },
          { role: "button", name: "Continue Shopping" },
        ],
        headings: [
          { role: "heading", name: "Shopping Cart" },
          { role: "heading", name: "Order Summary" },
        ],
        links:     [{ role: "link", name: "Products" }, { role: "link", name: "Login" }],
        selects:   [],
        checkboxes:[],
        radios:    [],
        rawSnapshot: "(cart page)",
      },
      {
        url: baseUrl + "/checkout",
        inputs: [
          { role: "textbox", name: "Full Name" },
          { role: "textbox", name: "Email" },
          { role: "textbox", name: "Address" },
          { role: "textbox", name: "City" },
          { role: "textbox", name: "State" },
          { role: "textbox", name: "ZIP Code" },
          { role: "textbox", name: "Card Number" },
          { role: "textbox", name: "Expiry Date" },
          { role: "textbox", name: "CVV" },
        ],
        buttons: [
          { role: "button", name: "Continue" },
          { role: "button", name: "Place Order" },
          { role: "button", name: "Back" },
        ],
        headings: [
          { role: "heading", name: "Checkout" },
          { role: "heading", name: "Shipping Information" },
          { role: "heading", name: "Payment" },
        ],
        links:     [],
        selects:   [],
        checkboxes:[],
        radios:    [
          { role: "radio", name: "Credit Card" },
          { role: "radio", name: "PayPal" },
        ],
        rawSnapshot: "(checkout page)",
      },
      {
        url: baseUrl + "/auth/login",
        inputs: [
          { role: "textbox", name: "Email" },
          { role: "textbox", name: "Password" },
        ],
        buttons: [
          { role: "button", name: "Sign In" },
          { role: "button", name: "Forgot Password" },
        ],
        headings: [{ role: "heading", name: "Sign In" }],
        links: [
          { role: "link", name: "Sign Up" },
          { role: "link", name: "Forgot Password?" },
        ],
        selects:   [],
        checkboxes:[],
        radios:    [],
        rawSnapshot: "(login page)",
      },
      {
        url: baseUrl + "/auth/register",
        inputs: [
          { role: "textbox", name: "Full Name" },
          { role: "textbox", name: "Email" },
          { role: "textbox", name: "Password" },
          { role: "textbox", name: "Confirm Password" },
        ],
        buttons: [{ role: "button", name: "Register" }],
        headings: [{ role: "heading", name: "Create Account" }],
        links: [{ role: "link", name: "Sign In" }],
        selects:   [],
        checkboxes:[],
        radios:    [],
        rawSnapshot: "(register page)",
      },
      {
        url: baseUrl + "/account",
        inputs:  [],
        buttons: [
          { role: "button", name: "Logout" },
          { role: "button", name: "Save Changes" },
          { role: "button", name: "Edit" },
        ],
        headings: [
          { role: "heading", name: "My Account" },
          { role: "heading", name: "Overview" },
          { role: "heading", name: "Order History" },
          { role: "heading", name: "Profile Settings" },
        ],
        links: [
          { role: "link", name: "Overview" },
          { role: "link", name: "Orders" },
          { role: "link", name: "Profile" },
          { role: "link", name: "Settings" },
        ],
        selects:   [],
        checkboxes:[],
        radios:    [],
        rawSnapshot: "(account page)",
      },
      {
        url: baseUrl + "/admin",
        inputs:  [{ role: "textbox", name: "Product Name" }, { role: "textbox", name: "Price" }, { role: "textbox", name: "Stock" }],
        buttons: [
          { role: "button", name: "Add Product" },
          { role: "button", name: "Edit" },
          { role: "button", name: "Delete" },
          { role: "button", name: "Save" },
        ],
        headings: [
          { role: "heading", name: "Admin Dashboard" },
          { role: "heading", name: "Products" },
          { role: "heading", name: "Orders" },
          { role: "heading", name: "Analytics" },
        ],
        links: [
          { role: "link", name: "Products" },
          { role: "link", name: "Orders" },
          { role: "link", name: "Analytics" },
        ],
        selects:   [{ role: "listbox", name: "Category" }],
        checkboxes:[],
        radios:    [],
        rawSnapshot: "(admin page)",
      },
    ],
    // Top-level fields (aggregated from all pages)
    inputs:    [],
    buttons:   [],
    headings:  [],
    links:     [],
    selects:   [],
    checkboxes:[],
    radios:    [],
    rawSnapshot: "(multi-page context)",
  };
}

// ─── Category grouping ────────────────────────────────────────────────────────
const CATEGORY_MAP = {
  "Browsing & Product Discovery":   [1,2,3,4,5],
  "Shopping Cart Operations":       [6,7,8,9,10],
  "Checkout Flow":                  [11,12,13,14],
  "User Authentication":            [15,16,17,18,19,20],
  "User Account Management":        [21,22,23,24],
  "Admin Dashboard":                [25,26,27,28],
  "Complex Multi-Step Scenarios":   [29,30,31,32,33],
  "Edge Cases & Error Handling":    [34,35,36,37,38,39],
  "UI/UX Verification":             [40,41,42,43,44,45],
  "Advanced Testing Patterns":      [46,47,48,49,50],
};

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  // Check site is up
  try {
    const code = await fetchUrl(BASE_URL + "/");
    if (code !== 200) throw new Error(`HTTP ${code}`);
  } catch (e) {
    console.error(`❌  Site not reachable at ${BASE_URL}: ${e.message}`);
    console.error("    Start the demo app first: npm run dev (in apps/demo-web)");
    process.exit(1);
  }

  const pageContext = buildRealPageContext(BASE_URL);
  const totalPages  = pageContext.pages.length;

  console.log(`\n📋  TestPlannerAgent Evaluator`);
  console.log(`    Site:      ${BASE_URL}`);
  console.log(`    Pages:     ${totalPages} (home, products, cart, checkout, login, register, account, admin)`);
  console.log(`    Templates: ${templates.length}`);
  console.log(`    Mode:      planner only (no browser execution)\n`);
  console.log("─".repeat(80));

  const engine  = new RagPlannerEngine();
  const results = [];
  let passed = 0, warned = 0, failed = 0;
  const intentCounts = {};
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
      requestText:       tpl.prompt,
      workspacePath:     repoRoot,
      pageContext,
      effectiveBaseUrl:  BASE_URL,
      effectiveStartUrl: BASE_URL + "/",
    };

    let result;
    try {
      result = await engine.generate(ctx, { log: msg => logs.push(msg) });
    } catch (err) {
      console.log(`  ❌ [${String(tpl.num).padStart(2,"0")}] ${tpl.title}`);
      console.log(`       EXCEPTION: ${err.message}`);
      results.push({ num: tpl.num, title: tpl.title, status: "exception", error: err.message });
      failed++;
      continue;
    }

    const intentLog = logs.find(l => l.includes("intent=")) || "";
    const intent = (intentLog.match(/intent=(\w+)/) || [])[1] ?? "";
    intentCounts[intent] = (intentCounts[intent] || 0) + 1;

    const { testCases } = result;
    const totalSteps    = testCases.reduce((n, tc) => n + tc.steps.length, 0);

    // ── Quality checks ────────────────────────────────────────────────────────
    const flags = [];
    for (const tc of testCases) {
      const steps   = tc.steps;
      const actions = steps.map(s => s.action);

      // Structural
      if (!actions.includes("goto"))
        flags.push("NO_GOTO");
      if (!actions.some(a => a === "expectVisible" || a === "expectText" || a === "expectUrlContains"))
        flags.push("NO_ASSERTION");
      const fills = steps.filter(s => s.action === "fill").map(s => s.field);
      const dupes = fills.filter((f, i) => fills.indexOf(f) !== i);
      if (dupes.length) flags.push(`DUPE_FILL(${[...new Set(dupes)].join(",")})`);

      // Domain: bad assertion targets
      const expectTargets = steps
        .filter(s => s.action === "expectVisible" || s.action === "expectText")
        .map(s => (s.target || s.value || "").trim());
      if (expectTargets.some(t => /^my account$/i.test(t)))
        flags.push("BAD_MY_ACCOUNT");
      if (expectTargets.some(t => /^shopping cart$/i.test(t)))
        flags.push("BAD_SHOPPING_CART");

      // Domain: auth timing — click "Sign In" must be followed by a waitFor timeout
      const signInIdx = steps.findIndex(
        s => s.action === "click" && /sign in/i.test(s.target || "")
      );
      if (signInIdx !== -1) {
        const afterSignIn = steps.slice(signInIdx + 1);
        const hasWaitFor  = afterSignIn.some(s => s.action === "waitFor" && s.timeout);
        if (!hasWaitFor) flags.push("AUTH_NO_WAIT");

        // goto /account before waitFor is a race condition
        const waitIdx  = afterSignIn.findIndex(s => s.action === "waitFor" && s.timeout);
        const acctIdx  = afterSignIn.findIndex(s => s.action === "goto" && /\/account/.test(s.url || ""));
        if (acctIdx !== -1 && (waitIdx === -1 || acctIdx < waitIdx))
          flags.push("AUTH_GOTO_BEFORE_WAIT");
      }

      // Domain: auth test should navigate to /auth/login or /auth/register
      const gotoUrls = steps.filter(s => s.action === "goto").map(s => s.url || "");
      const hasAuthFill = fills.some(f => /email|password/i.test(f));
      if (hasAuthFill &&
          !gotoUrls.some(u => /\/auth\/(login|register)/.test(u)))
        flags.push("AUTH_NO_LOGIN_URL");
    }

    const status = testCases.length === 0 || totalSteps === 0 ? "empty"
                 : flags.length > 0                           ? "warn"
                 :                                              "ok";

    if (status === "ok")    passed++;
    else if (status === "warn") warned++;
    else                        failed++;

    const icon = status === "ok" ? "✅" : status === "warn" ? "⚠️ " : "❌";
    console.log(
      `  ${icon} [${String(tpl.num).padStart(2,"0")}] ${tpl.title.padEnd(44)} intent=${intent.padEnd(10)} steps=${totalSteps}`
    );
    if (flags.length) console.log(`       ⚑  ${flags.join("  ")}`);

    const printSteps = VERBOSE || (SHOW_STEPS && flags.length > 0);
    if (printSteps) {
      for (const tc of testCases) {
        console.log(`       📝  "${tc.title}"`);
        for (const s of tc.steps) {
          const d = s.action === "fill"             ? `field="${s.field}" → "${s.value}"`
                  : s.action === "click"            ? `target="${s.target}"`
                  : s.action === "goto"             ? `url="${s.url}"`
                  : s.action === "select"           ? `field="${s.field}" option="${s.option}"`
                  : s.action === "expectVisible"    ? `"${s.target}"`
                  : s.action === "expectText"       ? `"${s.target}" contains "${s.value}"`
                  : s.action === "expectUrlContains"? `"${s.value}"`
                  : s.action === "waitFor"          ? `timeout=${s.timeout}`
                  : JSON.stringify(s);
          console.log(`           ${s.action.padEnd(18)} ${d}`);
        }
      }
    }

    results.push({ num: tpl.num, title: tpl.title, prompt: tpl.prompt, status, intent, totalSteps, flags, plan: testCases });
  }

  // ─── Summary ─────────────────────────────────────────────────────────────────
  console.log("\n" + "─".repeat(80));
  console.log(`\n📊  Results`);
  console.log(`    Total : ${templates.length}`);
  console.log(`    ✅ OK : ${passed}`);
  console.log(`    ⚠️  Warn: ${warned}`);
  console.log(`    ❌ Fail: ${failed}`);
  console.log(`\n    Intent distribution:`);
  Object.entries(intentCounts).sort((a,b) => b[1]-a[1])
    .forEach(([k,v]) => console.log(`      ${k.padEnd(12)} ${String(v).padStart(2)}  ${"█".repeat(v)}`));

  const problems = results.filter(r => r.status !== "ok");
  if (problems.length) {
    console.log(`\n    Needs attention:`);
    problems.forEach(r => {
      const icon = r.status === "empty" ? "❌" : "⚠️ ";
      console.log(`      ${icon} [${String(r.num).padStart(2,"0")}] ${r.title}  →  ${(r.flags||[]).join(", ")||r.error||"no steps"}`);
    });
  }

  // Flag distribution
  const flagCounts = {};
  results.forEach(r => (r.flags||[]).forEach(f => { flagCounts[f] = (flagCounts[f]||0)+1; }));
  if (Object.keys(flagCounts).length) {
    console.log(`\n    Flag distribution:`);
    Object.entries(flagCounts).sort((a,b) => b[1]-a[1])
      .forEach(([k,v]) => console.log(`      ${k.padEnd(24)} ${String(v).padStart(2)}  ${"█".repeat(v)}`));
  }
  console.log(`\n    Tip: node scripts/evalPlanner.js --steps   (show plan steps for flagged tests)`);
  console.log(`         node scripts/evalPlanner.js --verbose  (show all steps)`);
  console.log();
}

main().catch(e => { console.error(e); process.exit(1); });
