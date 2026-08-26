import { Agent, RunContext, Logger } from "../../core/agent/types";
import { LlmClient } from "../../core/llm/LlmClient";
import { extractFirstJsonObject } from "../../core/llm/json";
import { IntentClassificationSchema } from "./schema";
import { loadSystemPrompt } from "../../core/utils/loadPrompt";
import { ZodError } from "zod";

/* ─── Weighted keyword scoring ─── */

interface ScoredIntent {
  intent: "CASUAL" | "DOMAIN_QA" | "TEST_GEN";
  confidence: number;
  reasoning: string;
}

/**
 * Weighted local classifier — produces a confidence score per intent.
 * Replaces the old binary rule matcher with a scoring system.
 */
function classifyLocally(text: string): ScoredIntent {
  const t = text.toLowerCase().trim();
  const words = t.split(/\s+/);

  let testScore = 0;
  let qaScore = 0;
  let casualScore = 0;
  const reasons: string[] = [];

  // ── TEST_GEN signals ──

  // Explicit test phrases (very strong)
  const testPhrases = [
    "generate test", "generate a test", "write test", "write a test",
    "create test", "create a test", "test case for", "test cases for",
    "e2e test", "ui test", "automated test", "playwright test",
    "run test", "run the test", "test the", "verify the",
    "check that", "check the", "check if", "validate the",
    "navigate to", "go to the", "open the",
    "add to cart", "remove from cart", "proceed to checkout",
    "fill in", "fill the", "click on", "click the",
    "login with", "log in with", "sign in with",
    "search for", "filter by", "sort by",
  ];
  for (const phrase of testPhrases) {
    if (t.includes(phrase)) {
      testScore += 5;
      reasons.push(`test phrase: "${phrase}"`);
    }
  }

  // Single test keywords (moderate)
  const testKeywords = [
    "test", "verify", "check", "validate", "assert", "ensure",
    "click", "fill", "navigate", "login", "register", "cart",
    "checkout", "product", "search", "filter", "sort", "button",
    "form", "input", "submit", "page", "homepage", "navbar",
    "visible", "display", "appear", "show", "present", "load",
    "redirect", "error", "toast", "modal", "dropdown",
    "playwright", "automation", "browser", "responsive", "mobile",
  ];
  for (const kw of testKeywords) {
    if (words.includes(kw) || t.includes(kw)) {
      testScore += 1.5;
    }
  }

  // URL presence (strong test signal)
  const hasUrl =
    /https?:\/\/\S+/i.test(text) ||
    /(?:localhost|127\.0\.0\.1):\d+/i.test(text);
  if (hasUrl) {
    testScore += 6;
    reasons.push("contains URL");
  }

  // Slash-path references (moderate test signal)
  if (/\/\w+/.test(t) && !t.startsWith("http")) {
    testScore += 2;
    reasons.push("contains path reference");
  }

  // ── DOMAIN_QA signals ──

  // Question starters (strong)
  const questionStarters = [
    "what is", "what are", "what's", "how does", "how do", "how to",
    "why does", "why is", "when does", "where is", "who is", "which",
    "tell me about", "explain", "describe", "define",
    "difference between", "compare",
  ];
  for (const qs of questionStarters) {
    if (t.startsWith(qs) || t.includes(qs)) {
      qaScore += 4;
      reasons.push(`question pattern: "${qs}"`);
    }
  }

  // Question mark
  if (t.endsWith("?")) {
    qaScore += 3;
    reasons.push("ends with ?");
  }

  // QA keywords
  const qaKeywords = [
    "documentation", "docs", "concept", "architecture", "pattern",
    "best practice", "tutorial", "guide", "example", "explanation",
    "overview", "introduction", "getting started",
  ];
  for (const kw of qaKeywords) {
    if (t.includes(kw)) {
      qaScore += 2;
      reasons.push(`QA keyword: "${kw}"`);
    }
  }

  // ── CASUAL signals ──

  // Greeting patterns (strong)
  const greetings = [
    "hello", "hi there", "hey there", "good morning",
    "good afternoon", "good evening", "howdy", "greetings",
  ];
  for (const g of greetings) {
    if (t.startsWith(g) || t === g) {
      casualScore += 6;
      reasons.push(`greeting: "${g}"`);
    }
  }

  // Short "hi"/"hey" at start only
  if (/^(hi|hey)\b/.test(t) && words.length <= 5) {
    casualScore += 5;
    reasons.push("short greeting");
  }

  // Casual phrases
  const casualPhrases = [
    "how are you", "what can you do", "what do you do",
    "thank you", "thanks", "goodbye", "bye", "see you",
    "nice to meet", "who are you",
  ];
  for (const cp of casualPhrases) {
    if (t.includes(cp)) {
      casualScore += 5;
      reasons.push(`casual phrase: "${cp}"`);
    }
  }

  // Very short input (1-3 words, no action verbs) → likely casual
  if (words.length <= 3 && testScore === 0 && qaScore === 0) {
    casualScore += 2;
    reasons.push("very short input");
  }

  // ── Disambiguation ──

  // "how to test X" → TEST_GEN, not QA
  if (t.includes("how to test") || t.includes("how do i test")) {
    testScore += 4;
    qaScore -= 3;
    reasons.push("disambiguated: 'how to test' → TEST_GEN");
  }

  // Question + test keywords → prefer TEST_GEN
  if (qaScore > 0 && testScore > 0 && hasUrl) {
    testScore += 3;
    reasons.push("URL + question → TEST_GEN");
  }

  // ── Compute winner ──
  const totalScore = testScore + qaScore + casualScore;
  const maxScore = Math.max(testScore, qaScore, casualScore);

  let intent: "CASUAL" | "DOMAIN_QA" | "TEST_GEN";
  let confidence: number;

  if (maxScore === 0) {
    // No signals at all → default to TEST_GEN with low confidence
    intent = "TEST_GEN";
    confidence = 0.3;
    reasons.push("no strong signals, defaulting to TEST_GEN");
  } else if (testScore >= qaScore && testScore >= casualScore) {
    intent = "TEST_GEN";
    confidence = totalScore > 0 ? testScore / totalScore : 0.5;
  } else if (qaScore >= testScore && qaScore >= casualScore) {
    intent = "DOMAIN_QA";
    confidence = totalScore > 0 ? qaScore / totalScore : 0.5;
  } else {
    intent = "CASUAL";
    confidence = totalScore > 0 ? casualScore / totalScore : 0.5;
  }

  // Boost confidence for very strong signals
  if (maxScore >= 10) {
    confidence = Math.min(1.0, confidence + 0.15);
  }

  // Cap at 1.0
  confidence = Math.min(1.0, Math.round(confidence * 100) / 100);

  return {
    intent,
    confidence,
    reasoning: reasons.slice(0, 5).join("; ") || "default classification",
  };
}

/* ─── Agent ─── */

export class ReceptionistAgent implements Agent {
  name = "ReceptionistAgent";

  /** Confidence threshold below which we fall back to LLM */
  private static LLM_FALLBACK_THRESHOLD = 0.6;

  async run(ctx: RunContext, logger: Logger): Promise<void> {
    const text = ctx.requestText;

    // ── Step 1: Try local classification (instant, zero API cost) ──
    const local = classifyLocally(text);
    logger.log(
      `Receptionist (local): intent=${local.intent} confidence=${local.confidence} [${local.reasoning}]`
    );

    // If confidence is high enough, use local result directly
    if (local.confidence >= ReceptionistAgent.LLM_FALLBACK_THRESHOLD) {
      ctx.intent = local.intent;
      logger.log(`Intent = ${ctx.intent} (local classifier, confidence=${local.confidence})`);
      return;
    }

    // ── Step 2: Low confidence — fall back to LLM ──
    logger.log(
      `Receptionist: confidence ${local.confidence} < ${ReceptionistAgent.LLM_FALLBACK_THRESHOLD} threshold. Falling back to LLM.`
    );

    const llm = new LlmClient({ appName: "AgenticQA", role: "receptionist" });
    if (!llm.isConfigured()) {
      logger.log(
        "Receptionist: LLM not configured. Using local result despite low confidence."
      );
      ctx.intent = local.intent;
      logger.log(`Intent = ${ctx.intent} (local fallback, confidence=${local.confidence})`);
      return;
    }

    // Classification prompt lives in prompts/system.md (loaded at runtime — G0.4).
    const systemPrompt = loadSystemPrompt(
      "ReceptionistAgent",
      { localIntent: local.intent, localConfidence: local.confidence },
      { log: (m) => logger.log(m) }
    );

    const userPrompt = `Classify this user request:\n\n${text}\n\nReturn the JSON classification only.`;

    try {
      const response = await llm.chat(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        { temperature: 0.1 }
      );

      const jsonStr = extractFirstJsonObject(response);
      let parsed: unknown;

      try {
        parsed = JSON.parse(jsonStr);
      } catch (e) {
        throw new Error(
          `Receptionist: LLM returned invalid JSON: ${jsonStr.substring(0, 100)}...`
        );
      }

      const classification = IntentClassificationSchema.parse(parsed);

      ctx.intent = classification.intent;
      logger.log(
        `Intent = ${ctx.intent} (LLM fallback, confidence: ${(classification.confidence * 100).toFixed(1)}%)`
      );
      logger.log(`Reasoning: ${classification.reasoning}`);
    } catch (e: any) {
      // LLM failed — use local result anyway
      logger.log(
        `Receptionist: LLM fallback failed — ${e?.message ?? String(e)}. Using local result.`
      );
      ctx.intent = local.intent;
      logger.log(`Intent = ${ctx.intent} (local fallback after LLM error, confidence=${local.confidence})`);
    }
  }
}

