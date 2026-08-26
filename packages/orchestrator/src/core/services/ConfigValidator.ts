import {
  PROVIDERS,
  providerForBaseUrl,
  isPlaceholderApiKey,
  looksLikeProviderKey,
} from "../llm/modelCatalog";
import { Logger, RunContext } from "../agent/types";

export interface ConfigValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validates the complete AgenticQA environment and configuration.
 * Provides clear, actionable error messages.
 */
export class ConfigValidator {
  /** A key is treated as unset if empty, a bare provider prefix (`.env.example` ships `sk-or-v1-` and
   *  `nvapi-`), or a common placeholder. Prefixes come from the model catalog so a new provider does not
   *  need this list edited. */
  static isPlaceholderKey(k: string | undefined): boolean {
    const v = (k ?? "").trim();
    if (!v) return true;
    if (isPlaceholderApiKey(v)) return true;
    return /change[_-]?me|xxx+|your[_-]?key|placeholder/i.test(v);
  }

  static validateEnv(logger: Logger): ConfigValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // 1. Database URL (optional but recommended)
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      warnings.push(
        "DATABASE_URL not set — self-healing and test tracking disabled"
      );
    } else {
      if (!dbUrl.includes("postgresql://")) {
        errors.push(
          "DATABASE_URL must start with 'postgresql://' (format: postgresql://user:pass@host:port/db)"
        );
      }
    }

    // 2. LLM configuration (optional — falls back to rules)
    const apiKey = process.env.OPENAI_API_KEY;
    const baseUrl = process.env.OPENAI_BASE_URL;
    const model = process.env.OPENAI_MODEL;

    const provider = providerForBaseUrl(baseUrl);
    const apiKeyMissing = ConfigValidator.isPlaceholderKey(apiKey);
    const hasLlm = !apiKeyMissing && Boolean(baseUrl) && Boolean(model);

    if (apiKeyMissing) {
      warnings.push(
        `OPENAI_API_KEY not set — falling back to rule-based intent classification.
          For full capability, get a free key from: https://openrouter.ai/keys`
      );
    } else if (apiKey && !looksLikeProviderKey(apiKey, provider)) {
      // ⚠️ A WARNING, never an error. This was `errors.push(...)` gated on `startsWith("sk-")`, and
      // `main.ts` exits(1) on any error — so the moment an `nvapi-` key was configured the orchestrator
      // died before the pipeline ran at all, while a stale pack on disk made it look like it had worked.
      // Key formats belong to the provider and change without notice; the authoritative test is whether
      // a request succeeds, which is what `npm run probe:models` does. Guessing must not be fatal.
      warnings.push(
        `OPENAI_API_KEY does not look like a ${PROVIDERS[provider].label} key ` +
          `(expected it to start with ${PROVIDERS[provider].keyPrefixes.join(" or ")}). ` +
          `If OPENAI_BASE_URL points at a different provider, this is fine. Run "npm run probe:models" ` +
          `to check for real.`
      );
    }

    if (!baseUrl) {
      warnings.push(
        "OPENAI_BASE_URL not set — using default: https://openrouter.ai/api/v1"
      );
    } else if (!baseUrl.includes("://")) {
      errors.push("OPENAI_BASE_URL format invalid (should be a full URL)");
    }

    if (!model) {
      if (hasLlm) {
        errors.push(
          "OPENAI_MODEL not set — required for test generation (e.g., arcee-ai/trinity-large-preview:free)"
        );
      }
    }

    // 3. Embedding model (optional, improves self-healing)
    const embedModel = process.env.OPENAI_EMBED_MODEL;
    if (!embedModel) {
      warnings.push(
        "OPENAI_EMBED_MODEL not set — self-healing will be less accurate. Recommended: google/gemini-embedding-001"
      );
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  static logValidation(result: ConfigValidationResult, logger: Logger): void {
    if (result.errors.length === 0 && result.warnings.length === 0) {
      logger.log("Config Validator: All checks passed ✅");
      return;
    }

    if (result.errors.length > 0) {
      logger.error("Config Validator: Critical errors found:");
      for (const err of result.errors) {
        logger.error(`  ❌ ${err}`);
      }
    }

    if (result.warnings.length > 0) {
      logger.log("Config Validator: Warnings (running with degraded capability):");
      for (const warn of result.warnings) {
        logger.log(`  ⚠️ ${warn}`);
      }
    }
  }

  static throwIfInvalid(result: ConfigValidationResult): void {
    if (!result.isValid) {
      const msg = result.errors.join("\n");
      throw new Error(
        `Configuration validation failed:\n${msg}\n\nSee SETUP.md for instructions.`
      );
    }
  }
}
