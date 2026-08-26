import * as fs from "node:fs/promises";
import * as path from "node:path";

export async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true });
}

export async function writeFile(workspacePath: string, relPath: string, content: string) {
  const full = path.join(workspacePath, relPath);
  await ensureDir(path.dirname(full));
  await fs.writeFile(full, content, "utf8");
  return full;
}

export async function readFile(workspacePath: string, relPath: string) {
  const full = path.join(workspacePath, relPath);
  return await fs.readFile(full, "utf8");
}

export async function writeFileAbs(fullPath: string, content: string) {
  await fs.writeFile(fullPath, content, "utf8");
}