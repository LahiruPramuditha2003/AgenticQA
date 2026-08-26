import dotenv from "dotenv";
import * as path from "node:path";
import type { AgentRole } from "./models";
import { resolveModelChain } from "./models";

dotenv.config({ path: path.resolve(__dirname, "../.env"), quiet: true });
dotenv.config({ quiet: true });

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export class LlmClient {
  private apiKey = process.env.OPENAI_API_KEY;
  private baseUrl = process.env.OPENAI_BASE_URL ?? "https://openrouter.ai/api/v1";

  /**
   * @param opts.role  When set, the model (and its fallback chain) is resolved from the per-agent
   *                   registry (`core/llm/models.ts`). When omitted, behavior is back-compatible:
   *                   a single model = `opts.model` ?? `OPENAI_MODEL`, with no fallback chain.
   * @param opts.model Explicit model override (highest precedence, also used as the single model
   *                   when no role is given).
   */
  constructor(private opts?: { appName?: string; siteUrl?: string; role?: AgentRole; model?: string }) {}

  /**
   * Ordered model fallback chain for this client, resolved live from env/config.
   * - role set     → full registry chain (primary → … → safety model)
   * - role absent  → single model (`opts.model` ?? `OPENAI_MODEL`) for strict back-compat
   */
  private modelChain(): string[] {
    if (this.opts?.role) return resolveModelChain(this.opts.role, { model: this.opts.model });
    const explicit = this.opts?.model ?? process.env.OPENAI_MODEL;
    return explicit ? [explicit] : [];
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey && this.modelChain().length > 0);
  }

  async chat(messages: ChatMessage[], params?: { temperature?: number; maxTokens?: number; retries?: number }): Promise<string> {
    if (!this.apiKey) throw new Error("OPENAI_API_KEY is not set");
    const chain = this.modelChain();
    if (chain.length === 0) throw new Error("OPENAI_MODEL is not set");

    const maxRetries = params?.retries ?? 2;
    let lastError: Error | null = null;

    // Outer loop: walk the model fallback chain. Inner loop: per-model retry with backoff.
    for (let m = 0; m < chain.length; m++) {
      const model = chain[m];
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          return await this._doChat(model, messages, params);
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (attempt < maxRetries) {
            // Exponential backoff: 1s, 2s, 4s...
            const delay = Math.pow(2, attempt) * 1000;
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      }
      // This model exhausted its retries — advance to the next model in the chain, if any.
      if (m < chain.length - 1) {
        // stderr only (never the stdout JSON protocol); surfaced as an orchestrator diagnostic.
        console.error(`LlmClient: model ${model} failed (${lastError?.message ?? "unknown"}); trying ${chain[m + 1]}`);
      }
    }

    throw lastError || new Error("LLM request failed after retries");
  }

  private async _doChat(model: string, messages: ChatMessage[], params?: { temperature?: number; maxTokens?: number }): Promise<string> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/chat/completions`;

    const headers: Record<string, string> = {
      "Authorization": `Bearer ${this.apiKey}`,
      "Content-Type": "application/json"
    };

    // Optional OpenRouter headers (recommended by OpenRouter docs)
    if (this.opts?.siteUrl) headers["HTTP-Referer"] = this.opts.siteUrl;
    if (this.opts?.appName) headers["X-Title"] = this.opts.appName;

    const body = {
      model,
      messages,
      temperature: params?.temperature ?? 0.2,
      max_tokens: params?.maxTokens ?? 1200
    };

    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`LLM request failed: ${res.status} ${res.statusText}\n${text}`);
    }

    const json = await res.json() as any;
    const content = json?.choices?.[0]?.message?.content;
    if (!content) throw new Error("LLM returned empty content");
    return content;
  }
}
