import { z } from "zod";

export const StepSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("goto"),
    url: z.string().min(1), // can be absolute or relative
    description: z.string().optional() // Optional description for clarity
  }),
  z.object({
    action: z.literal("click"),
    target: z.string().min(1), // natural description (later matched by inspector)
    description: z.string().optional(),
    waitFor: z.number().optional() // Wait time in ms before clicking
  }),
  z.object({
    action: z.literal("fill"),
    field: z.string().min(1), // label/placeholder/name description
    value: z.string(),
    clear: z.boolean().optional() // Whether to clear field first (default: true)
  }),
  z.object({
    action: z.literal("expectVisible"),
    target: z.string().min(1),
    timeout: z.number().optional() // Custom timeout in ms
  }),
  z.object({
    action: z.literal("expectNotVisible"),
    target: z.string().min(1),
    timeout: z.number().optional()
  }),
  z.object({
    action: z.literal("expectText"),
    target: z.string().min(1),
    text: z.string().min(1),
    mode: z.enum(["contains", "equals", "startsWith", "endsWith"]).optional()
  }),
  z.object({
    action: z.literal("expectCount"),
    target: z.string().min(1),
    count: z.number().min(0),
    comparison: z.enum(["equal", "atLeast", "atMost", "greaterThan", "lessThan"]).optional()
  }),
  z.object({
    action: z.literal("expectUrl"),
    url: z.string().min(1),
    mode: z.enum(["equals", "contains", "startsWith"]).optional()
  }),
  z.object({
    action: z.literal("expectUrlContains"),
    value: z.string().min(1)
  }),
  z.object({
    action: z.literal("waitFor"),
    timeout: z.number().min(100).max(30000), // Wait in ms (100-30000)
    description: z.string().optional()
  }),
  z.object({
    action: z.literal("waitForLoad"),
    description: z.string().optional()
  }),
  z.object({
    action: z.literal("select"),
    field: z.string().min(1),
    option: z.string().min(1), // Option text or value
    by: z.enum(["text", "value", "index"]).optional()
  }),
  z.object({
    action: z.literal("slider"),
    field: z.string().min(1),
    value: z.number(),
    description: z.string().optional()
  }),
  z.object({
    action: z.literal("check"),
    target: z.string().min(1) // Checkbox label or description
  }),
  z.object({
    action: z.literal("uncheck"),
    target: z.string().min(1)
  }),
  z.object({
    action: z.literal("hover"),
    target: z.string().min(1)
  }),
  z.object({
    action: z.literal("press"),
    key: z.string().min(1), // e.g., "Enter", "Tab", "ArrowDown"
    target: z.string().optional() // Optional target, defaults to current focus
  }),
  z.object({
    action: z.literal("scroll"),
    direction: z.enum(["up", "down", "left", "right"]),
    amount: z.number().optional() // Pixels, default 500
  }),
  z.object({
    action: z.literal("screenshot"),
    description: z.string().optional()
  }),
  z.object({
    action: z.literal("evaluate"),
    code: z.string().min(1), // JavaScript to evaluate in page context
    description: z.string().optional()
  }),
  z.object({
    action: z.literal("expectAttribute"),
    target: z.string().min(1),
    attribute: z.string().min(1),
    value: z.string().min(1),
    mode: z.enum(["contains", "equals"]).optional()
  }),
  z.object({
    action: z.literal("setViewport"),
    width: z.number().min(320).max(3840),
    height: z.number().min(320).max(2160)
  }),
  z.object({
    action: z.literal("measurePerformance"),
    metric: z.enum(["LCP", "FCP", "load"]),
    maxTimeMs: z.number()
  }),
  z.object({
    action: z.literal("checkAccessibility"),
    description: z.string().optional()
  }),
  z.object({
    action: z.literal("simulateApiError"),
    enable: z.boolean()
  })
]);

export const TestCaseSchema = z.object({
  title: z.string().min(3),
  description: z.string().optional(), // Test case description
  tags: z.array(z.string()).optional(), // e.g., ["smoke", "regression", "checkout"]
  steps: z.array(StepSchema).min(1)
});

export const TestPlanSchema = z.object({
  testCases: z.array(TestCaseSchema).min(1)
});

export type TestPlan = z.infer<typeof TestPlanSchema>;
export type Step = z.infer<typeof StepSchema>;
export type TestCase = z.infer<typeof TestCaseSchema>;