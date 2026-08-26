import { z } from "zod";

/**
 * Models routinely return a *list* where the schema asks for prose — `detailedExplanation` comes back as
 * an array of paragraphs or bullets rather than one string. That is cosmetic shape drift, not a wrong
 * answer, but a bare `z.string()` rejects it and the ENTIRE answer is discarded. Observed live
 * (2026-08-19): `"path": ["detailedExplanation"], "message": "expected string, received array"` threw
 * away a fully-researched answer with 8 retrieved chunks behind it.
 *
 * So: accept the drift and normalise it. Arrays join into paragraphs; a stray number/boolean stringifies.
 * Anything genuinely absent still fails the `.min(1)` check underneath, so this loosens the SHAPE without
 * loosening the REQUIREMENT.
 */
const prose = (schema: z.ZodString) =>
  z.preprocess((v) => {
    if (Array.isArray(v)) {
      return v
        .map((x) => (typeof x === "string" ? x : typeof x === "object" && x ? JSON.stringify(x) : String(x)))
        .filter((x) => x.trim())
        .join("\n\n");
    }
    if (typeof v === "number" || typeof v === "boolean") {return String(v);}
    return v;
  }, schema);

/**
 * Schema for validated Domain Q&A responses
 * Ensures structured, cited, and fact-checked answers
 */

export const ConfidenceLevelSchema = z.enum([
  "HIGH",
  "MEDIUM",
  "LOW",
  "UNKNOWN",
]);

export type ConfidenceLevel = z.infer<typeof ConfidenceLevelSchema>;

export const SourceCitationSchema = z.object({
  /** Title of the source document */
  title: z.string().min(1, "Source title is required"),
  /** Full URL of the source document */
  url: z.string(),
  /** Type of source (primary or secondary) */
  type: z.enum(["primary", "secondary", "related"]).default("secondary"),
  /** Brief description of what this source contributed */
  contribution: z.string().optional(),
});

export type SourceCitation = z.infer<typeof SourceCitationSchema>;

export const FactCheckSchema = z.object({
  /** The factual claim being made */
  claim: z.string().min(1, "Claim is required"),
  /** Which source(s) support this claim */
  sources: z.array(z.string()).min(1, "At least one source required"),
  /** Direct quote from the source (optional but recommended) */
  quote: z.string().optional(),
  /** Confidence in this specific fact */
  confidence: ConfidenceLevelSchema,
});

export type FactCheck = z.infer<typeof FactCheckSchema>;

export const DomainQaResponseSchema = z.object({
  /** Direct, concise answer to the question (1-2 sentences) */
  directAnswer: prose(
    z
      .string()
      .min(1, "Direct answer is required")
      // ⚠️ Not `.max(500)`. A model that writes three sentences instead of two is not wrong, and
      // rejecting the whole answer over concision loses the research behind it. `outputAnswer` can
      // truncate for display; the schema should not police style.
  ),

  /** Detailed explanation with supporting information */
  detailedExplanation: prose(z.string().min(1, "Detailed explanation is required")),

  /** List of all sources cited in the answer */
  sources: z
    .array(SourceCitationSchema)
    .min(0)
    .default([]),

  /** Overall confidence level in the answer */
  confidence: ConfidenceLevelSchema,

  /** Explanation of confidence assessment */
  confidenceReasoning: prose(z.string().min(1, "Confidence reasoning is required")),

  /** Key facts extracted from sources with citations */
  factChecks: z.array(FactCheckSchema).optional(),

  /** Related topics or documents for further reading */
  relatedTopics: z
    .array(
      z.object({
        title: z.string(),
        // ⚠️ NOT `.url()`. This is model-authored text; a relative path or a trailing-comma typo would
        // fail the whole response. A malformed related-topic link is worth far less than the answer.
        url: z.string(),
        description: z.string().optional(),
      })
    )
    .optional(),

  /** Whether the answer is complete or partial */
  isComplete: z.boolean().default(true),

  /** If incomplete, what information is missing */
  missingInformation: z.string().optional(),

  /** Any warnings or caveats about the information */
  warnings: z.array(z.string()).optional(),
});

export type DomainQaResponse = z.infer<typeof DomainQaResponseSchema>;

/**
 * Schema for document selection from search results
 * Used to validate LLM's choice of relevant documents
 */
export const DocumentSelectionSchema = z.object({
  /** Selected documents for detailed analysis */
  selected: z.array(
    z.object({
      id: z.string(),
      url: z.string().url(),
      title: z.string(),
      relevanceScore: z.number().min(0).max(1),
      reason: z.string(),
    })
  ),
  /** Documents excluded and why */
  excluded: z
    .array(
      z.object({
        id: z.string(),
        url: z.string().url(),
        title: z.string(),
        reason: z.string(),
      })
    )
    .optional(),
  /** Whether search results are sufficient */
  isSufficient: z.boolean(),
  /** If insufficient, what additional search is needed */
  additionalSearchNeeded: z.string().optional(),
});

export type DocumentSelection = z.infer<typeof DocumentSelectionSchema>;

/**
 * Schema for search query refinement
 * Helps improve search results when initial query fails
 */
export const SearchQueryRefinementSchema = z.object({
  /** Original query from user */
  originalQuery: z.string(),
  /** Refined query for better search results */
  refinedQuery: z.string(),
  /** Keywords extracted from the query */
  keywords: z.array(z.string()),
  /** Suggested topics or categories to focus on */
  topics: z.array(z.string()).optional(),
  /** Whether the query needs disambiguation */
  needsDisambiguation: z.boolean().default(false),
  /** Clarification questions if ambiguous */
  clarificationQuestions: z.array(z.string()).optional(),
});

export type SearchQueryRefinement = z.infer<
  typeof SearchQueryRefinementSchema
>;

/**
 * Schema for hallucination check
 * Validates that answer is grounded in provided sources
 */
export const HallucinationCheckSchema = z.object({
  /** Each claim in the answer */
  claims: z.array(
    z.object({
      claim: z.string(),
      supportedBySources: z.boolean(),
      sourceUrls: z.array(z.string().url()),
      isHallucinated: z.boolean(),
      confidence: z.number().min(0).max(1),
    })
  ),
  /** Overall hallucination risk assessment */
  overallRisk: z.enum(["NONE", "LOW", "MEDIUM", "HIGH"]),
  /** Flagged statements that may be hallucinated */
  flaggedStatements: z.array(z.string()).optional(),
  /** Recommendation for answer revision */
  needsRevision: z.boolean(),
  /** Specific revision suggestions */
  revisionSuggestions: z.array(z.string()).optional(),
});

export type HallucinationCheck = z.infer<
  typeof HallucinationCheckSchema
>;
