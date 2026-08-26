const fs = require("fs");
const path = require("path");

function repoRootFromHere() {
  return path.resolve(__dirname, "../../..");
}

function extractTemplatePrompts(templatePath) {
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Cannot find TEST_TEMPLATES.md at ${templatePath}`);
  }

  const text = fs.readFileSync(templatePath, "utf8");
  const prompts = [];
  const regex = /^###\s*(\d+)\.\s*(.+?)\s*\r?\n```(?:\w+)?\s*\r?\n([\s\S]*?)```/gm;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const index = Number(match[1]);
    const title = match[2].trim();
    const prompt = match[3].trim();
    if (!Number.isFinite(index) || !prompt) continue;
    prompts.push({ index, title, prompt });
  }

  return prompts.sort((a, b) => a.index - b.index);
}

if (require.main === module) {
  const repoRoot = repoRootFromHere();
  const templatePath = path.join(repoRoot, "benchmarks/TEST_TEMPLATES.md");
  const prompts = extractTemplatePrompts(templatePath);
  process.stdout.write(JSON.stringify(prompts, null, 2));
}

module.exports = {
  extractTemplatePrompts,
  repoRootFromHere,
};
