"use strict";
// Offline unit tests for the App Knowledge Pack seam.
// Requires a build first (imports from dist/).

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const {
  resolveCredentials,
  formatCredentialsBlock,
  resolveGoldenFlows,
  parseKnowledgePack,
  loadAppKnowledgePack,
} = require("../dist/core/knowledge/AppKnowledgePack.js");

// The credentials block demo-web's pack produces. Every value here comes from
// apps/demo-web/.agenticqa/knowledge.json — the engine itself holds no credentials (G0.3).
const EXPECTED_DEMO_BLOCK = [
  "Credentials (use EXACTLY these):",
  "- Customer: email=customer@example.com password=password123",
  "- Admin: email=admin@techstore.com password=admin123",
  "- New registration: name=Test User, email=newuser@example.com, password=TestPass123!, confirmPassword=TestPass123!",
  "- Shipping: name=Jane Smith, address=123 Main St, city=New York, state=NY, zip=10001, card=4111111111111111, expiry=12/28, cvv=123",
].join("\n");

// Demo-web's real logins. No pack ⇒ none of these may appear anywhere.
const DEMO_SECRETS = [
  "customer@example.com",
  "password123",
  "admin@techstore.com",
  "admin123",
  "newuser@example.com",
  "TestPass123!",
  "Jane Smith",
  "4111111111111111",
];

/* ── G0.3: absent means absent — the engine never invents a credential ── */

test("no pack ⇒ no credentials at all (not demo-web's)", () => {
  for (const pack of [null, undefined, {}, { credentials: {} }]) {
    const c = resolveCredentials(pack);
    assert.deepStrictEqual(c, {}, `expected no credentials for ${JSON.stringify(pack)}`);
    assert.strictEqual(
      formatCredentialsBlock(c),
      "",
      "an app that declares no credentials gets no credentials block"
    );
  }
});

test("REGRESSION GUARD: a partial pack never leaks demo-web credentials", () => {
  // The exact D2 shape: an app supplies a customer login but no admin. It must NOT be handed
  // admin@techstore.com — that belongs to a completely different application.
  const pack = { credentials: { customer: { email: "me@x.com", password: "secret" } } };
  const c = resolveCredentials(pack);

  assert.deepStrictEqual(c.customer, { email: "me@x.com", password: "secret" });
  assert.strictEqual(c.admin, undefined, "an unsupplied group stays unsupplied");
  assert.strictEqual(c.registration, undefined);
  assert.strictEqual(c.shipping, undefined);

  const block = formatCredentialsBlock(c);
  assert.strictEqual(block, "Credentials (use EXACTLY these):\n- Customer: email=me@x.com password=secret");
  for (const secret of DEMO_SECRETS) {
    assert.ok(!block.includes(secret), `partial-pack block must not contain "${secret}"`);
  }
});

test("an incomplete login pair is dropped rather than half-invented", () => {
  // An email with no password can't sign anything in, and there is no honest value to fill in.
  const c = resolveCredentials({ credentials: { customer: { email: "only-email@x.com" } } });
  assert.strictEqual(c.customer, undefined);
  assert.strictEqual(formatCredentialsBlock(c), "");
});

test("form-fill groups keep whatever fields the pack supplied, in interface order", () => {
  const c = resolveCredentials({
    credentials: { shipping: { zip: "99999", name: "Ada" }, registration: { email: "a@b.c" } },
  });
  assert.deepStrictEqual(c.shipping, { zip: "99999", name: "Ada" });
  assert.strictEqual(
    formatCredentialsBlock(c),
    [
      "Credentials (use EXACTLY these):",
      "- New registration: email=a@b.c",
      "- Shipping: name=Ada, zip=99999",
    ].join("\n")
  );
});

test("blank / non-string credential values are ignored, not emitted", () => {
  const c = resolveCredentials({
    credentials: { customer: { email: "  ", password: "x" }, shipping: { zip: 10001, city: "NY" } },
  });
  assert.strictEqual(c.customer, undefined, "a blank email is not a credential");
  assert.deepStrictEqual(c.shipping, { city: "NY" }, "a non-string field is dropped");
});

test("parseKnowledgePack accepts an object, rejects junk", () => {
  assert.deepStrictEqual(parseKnowledgePack('{"name":"x"}', "src"), { name: "x" });
  assert.strictEqual(parseKnowledgePack("not json", "src"), null);
  assert.strictEqual(parseKnowledgePack("[1,2,3]", "src"), null);
  assert.strictEqual(parseKnowledgePack("42", "src"), null);
});

test("resolveGoldenFlows returns flows or null", () => {
  assert.strictEqual(resolveGoldenFlows(null), null);
  assert.strictEqual(resolveGoldenFlows({ goldenFlows: {} }), null);
  const flows = resolveGoldenFlows({ goldenFlows: { a: { description: "d", steps: [] } } });
  assert.ok(flows && flows.a && flows.a.description === "d");
});

test("loads the real demo-web pack via explicit path and via default", async () => {
  const demoWebDir = path.resolve(__dirname, "../../../apps/demo-web");

  const viaCfg = await loadAppKnowledgePack(demoWebDir, { knowledgePack: ".agenticqa/knowledge.json" });
  assert.ok(viaCfg, "pack loads via cfg.knowledgePack");
  assert.strictEqual(viaCfg.name, "TechStore demo-web");
  assert.ok(viaCfg.goldenFlows && viaCfg.goldenFlows["customer-login"], "has golden flows");
  assert.ok(viaCfg.routes && viaCfg.routes.login === "/auth/login", "has route hints");

  const viaDefault = await loadAppKnowledgePack(demoWebDir, undefined);
  assert.ok(viaDefault, "pack also resolves via default .agenticqa/knowledge.json path");

  // Demo-web's credentials now live entirely in its own pack — this block is produced from that data,
  // not from anything baked into the engine.
  assert.strictEqual(formatCredentialsBlock(resolveCredentials(viaCfg)), EXPECTED_DEMO_BLOCK);
});

test("returns null when no pack exists", async () => {
  const noPackDir = path.resolve(__dirname, ".."); // orchestrator root has no .agenticqa/knowledge.json
  const pack = await loadAppKnowledgePack(noPackDir, undefined);
  assert.strictEqual(pack, null);
});

/* ── G2.1: retrieval metadata on GoldenFlow (tags / verified / routeKey) ── */

const { normalizeFlowTags } = require("../dist/core/knowledge/AppKnowledgePack.js");

test("normalizeFlowTags cleans, lower-cases, dedupes and caps", () => {
  assert.deepStrictEqual(normalizeFlowTags(["Login", " SIGN IN ", "login", "auth"]), [
    "login",
    "sign in",
    "auth",
  ]);
  assert.deepStrictEqual(normalizeFlowTags(["a  b"]), ["a b"], "collapses whitespace");
  assert.strictEqual(normalizeFlowTags(["", "   "]), undefined, "all-blank ⇒ undefined");
  assert.strictEqual(normalizeFlowTags("login"), undefined, "non-array ⇒ undefined");
  assert.strictEqual(normalizeFlowTags(undefined), undefined);
  assert.deepStrictEqual(normalizeFlowTags([1, "ok", null, {}]), ["ok"], "drops non-strings");
  assert.strictEqual(normalizeFlowTags(Array.from({ length: 50 }, (_, i) => `t${i}`)).length, 12, "capped");
});

test("BACKWARD COMPAT: the real demo-web pack still loads with no retrieval metadata", async () => {
  const demoWebDir = path.resolve(__dirname, "../../../apps/demo-web");
  const pack = await loadAppKnowledgePack(demoWebDir, { knowledgePack: ".agenticqa/knowledge.json" });
  assert.ok(pack && pack.goldenFlows, "pack loads");
  const flow = pack.goldenFlows["customer-login"];
  assert.ok(flow && Array.isArray(flow.steps) && flow.steps.length > 0, "flow intact");
  // The new fields are optional — an existing pack simply doesn't have them, and nothing may invent them.
  assert.strictEqual(flow.tags, undefined);
  assert.strictEqual(flow.verified, undefined);
  assert.strictEqual(flow.routeKey, undefined);
});
