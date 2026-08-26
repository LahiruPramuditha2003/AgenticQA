import { z } from "zod";

/**
 * Schema for the ReceptionistAgent's intent classification response.
 */
export const IntentClassificationSchema = z.object({
  /** The classified intent type */
  intent: z.enum(["CASUAL", "DOMAIN_QA", "TEST_GEN"]),
  /** Confidence score from 0.0 to 1.0 */
  confidence: z.number().min(0).max(1),
  /** Brief explanation of the classification decision */
  reasoning: z.string(),
});

export type IntentClassification = z.infer<typeof IntentClassificationSchema>;
