#!/usr/bin/env node
/**
 * Render `media/icon.svg` to the PNGs the marketplace requires (R2.5).
 *
 * The VS Code Marketplace accepts **PNG only** — an SVG `icon` is rejected — and wants at least 128×128.
 * Rather than add an image-processing dependency (sharp, canvas: native builds, platform wheels, a whole
 * toolchain for two files), this renders with the Playwright chromium the repo already installs for
 * running tests. The SVG stays the source of truth, so the mark is editable rather than a binary blob
 * nobody can change.
 *
 *   node scripts/render-icon.js
 *
 * Also emits a 32×32 preview, because 32px is the size the marketplace list actually renders and it is
 * the only honest test of whether the mark survives.
 */

const fs = require("node:fs");
const path = require("node:path");

const MEDIA = path.resolve(__dirname, "..", "media");
const SVG = path.join(MEDIA, "icon.svg");
const SIZES = [
  { size: 128, file: "icon.png" },
  { size: 256, file: "icon@2x.png" },
  { size: 32, file: "icon-32-preview.png" },
];

async function main() {
  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch {
    console.error(
      "[render-icon] playwright is not installed here. Run this from the repo root, where the " +
        "workspaces share a hoisted install:  node packages/agenticqa/scripts/render-icon.js"
    );
    process.exit(1);
  }

  const svg = fs.readFileSync(SVG, "utf8");
  const browser = await chromium.launch();

  for (const { size, file } of SIZES) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      // Render at 1x into an exact-size viewport: scaling the viewport rather than the image keeps the
      // stroke weights true instead of resampling a large bitmap down.
      deviceScaleFactor: 1,
    });
    await page.setContent(
      `<!doctype html><html><body style="margin:0;padding:0;width:${size}px;height:${size}px">` +
        svg.replace(/width="\d+"\s+height="\d+"/, `width="${size}" height="${size}"`) +
        `</body></html>`
    );
    await page.screenshot({ path: path.join(MEDIA, file), omitBackground: true });
    await page.close();
    const bytes = fs.statSync(path.join(MEDIA, file)).size;
    console.log(`[render-icon] ${file.padEnd(22)} ${size}x${size}  ${(bytes / 1024).toFixed(1)} KB`);
  }

  await browser.close();
  console.log("[render-icon] done — media/icon.png is the marketplace icon (PNG only; SVG is rejected)");
}

main().catch((e) => {
  console.error(`[render-icon] FAILED: ${e?.message ?? e}`);
  process.exit(1);
});
