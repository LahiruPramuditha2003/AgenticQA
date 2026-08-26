import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";

export const AgenticQaConfigSchema = z.object({
  baseUrl: z.string().url().optional(),

  testDir: z.string().min(1).default("tests/generated"),

  allowlistedDomains: z.array(z.string()).optional().default([]),

  /** Optional path (relative to the workspace) to an App Knowledge Pack JSON file. */
  knowledgePack: z.string().min(1).optional(),

  /**
   * Optional per-agent model overrides, keyed by role (planner, domainqa, selfheal, reporter,
   * receptionist, casual). Takes precedence over the OPENAI_MODEL_<ROLE> env vars for that role.
   * Unknown keys and empty values are ignored by the resolver (core/llm/models.ts).
   */
  models: z.record(z.string(), z.string()).optional(),

  /**
   * Which browser projects a run executes against (G5.1 / defect D6).
   *
   * ⚠️ **The default is chromium only, and that is a deliberate change of behaviour.** Every
   * `generate_and_run` used to execute the app's *whole* Playwright matrix serially — five browsers for
   * demo-web — so a single-prompt inner loop cost roughly five times what it needed to, and it was the
   * dominant latency in the system. Cross-browser coverage is a release question, not an every-keystroke
   * one.
   *
   * Set `"all"` to run the full configured matrix (what the benchmark does), or list specific project
   * names. The `execution.allProjects` flag on a `NEW_REQUEST` overrides this per run, which is how the
   * extension's "Run Across All Browsers" command and the accuracy benchmark keep the matrix.
   */
  execution: z
    .object({
      projects: z.union([z.literal("all"), z.array(z.string().min(1))]).optional(),
    })
    .optional(),

  webServer: z
    .object({
      command: z.string().min(1),
      cwd: z.string().min(1).default("."),
      timeoutMs: z.number().int().positive().default(60000),
      reuseExistingServer: z.boolean().default(true),
    })
    .optional(),
});

export type AgenticQaConfig = z.infer<typeof AgenticQaConfigSchema>;

export async function loadAgenticQaConfig(
  workspacePath: string
): Promise<AgenticQaConfig> {
  const configPath = path.join(workspacePath, ".agenticqa.json");
  const raw = await fs.readFile(configPath, "utf8");
  const json = JSON.parse(raw);
  return AgenticQaConfigSchema.parse(json);
}