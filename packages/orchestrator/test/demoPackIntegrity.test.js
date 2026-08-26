/**
 * A canary for the eight cryptic failures you get when demo-web's pack is replaced by a generated one.
 *
 * `apps/demo-web/.agenticqa/knowledge.json` is a COMMITTED, hand-curated asset that several suites treat
 * as ground truth (`knowledgePack`, `plannerPrompt`, `scenarioPlanGolden`, `flowRetrieval`, …). Running
 * **AgenticQA: Generate Knowledge Pack** against demo-web overwrites it — a product action mutating a
 * source-controlled fixture — and the suite then fails in eight places that never mention the pack.
 * This case fails FIRST and says exactly what happened and how to undo it.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const PACK = path.join(__dirname, "..", "..", "..", "apps", "demo-web", ".agenticqa", "knowledge.json");

test("demo-web still ships its hand-curated pack, not a generated one", () => {
  const pack = JSON.parse(fs.readFileSync(PACK, "utf8"));
  const keys = Object.keys(pack.goldenFlows ?? {});

  // Generated packs are keyed `<kind>-<route>`. Only `smoke-` and `nav-` are safe tells: the curated
  // pack legitimately contains `filter-category-select`, and a hand-written pack may reasonably name a
  // flow `form-…`. Those two prefixes are pure generator vocabulary.
  const generatedShaped = keys.filter((k) => /^(smoke|nav)-/.test(k));
  const dir = path.dirname(PACK);
  const backups = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("knowledge.backup-"))
    .sort();
  const hint =
    `\n\n  The pack at apps/demo-web/.agenticqa/knowledge.json has been REPLACED by a generated one` +
    `\n  (${keys.length} flow(s): ${keys.join(", ")}).` +
    `\n  Generation overwrites in place — it does not merge — so the curated 15 flows are gone.` +
    `\n  Restore with:  git checkout -- apps/demo-web/.agenticqa/knowledge.json` +
    (backups.length ? `\n  Or from the newest backup: ${backups[backups.length - 1]}` : "") +
    `\n  Demo pack generation against apps/taskflow-web instead — it ships no pack by design.\n`;

  assert.equal(generatedShaped.length, 0, `generated-shaped flow keys found${hint}`);
  assert.ok(keys.length >= 15, `expected the 15 curated flows, found ${keys.length}${hint}`);
  assert.ok(keys.includes("product-detail"), `"product-detail" flow missing${hint}`);
});

/* ── R1.6: the guard that makes the canary above harder to trip in the first place ── */

test("D30/D38: demo-web's pack is marked curated, so generate_pack cannot silently replace it", () => {
  const pack = JSON.parse(fs.readFileSync(PACK, "utf8"));
  assert.strictEqual(
    pack.curated,
    true,
    'apps/demo-web/.agenticqa/knowledge.json must keep `"curated": true`. It is ground truth for five ' +
      "offline suites, and without the marker `generate_pack` will replace all 15 hand-written flows."
  );
});

test("D30/D38: the generator never emits `curated` itself", () => {
  // Same rule as `verified`: a marker any producer can set means nothing. Only a human writing a pack
  // by hand may claim it, so `writePack` deletes the field before writing.
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "agents", "KnowledgePackAgent", "KnowledgePackAgent.ts"),
    "utf8"
  );
  assert.match(
    src,
    /delete \(pack as \{ curated\?: boolean \}\)\.curated;/,
    "writePack must strip `curated` from a generated pack"
  );
  assert.match(
    src,
    /previousCurated && ctx\.overwriteCuratedPack !== true/,
    "writePack must refuse to replace a curated pack without explicit permission"
  );
});
