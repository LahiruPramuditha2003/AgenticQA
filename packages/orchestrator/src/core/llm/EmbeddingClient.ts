import { providerForBaseUrl } from "./modelCatalog";

export class EmbeddingClient {
  private apiKey = process.env.OPENAI_API_KEY;
  private baseUrl = process.env.OPENAI_BASE_URL ?? "https://openrouter.ai/api/v1";
  private model = process.env.OPENAI_EMBED_MODEL;

  isConfigured(): boolean {
    return Boolean(this.apiKey && this.model);
  }

  /**
   * Embed one string.
   *
   * `inputType` matters on NVIDIA NIM and is ignored elsewhere. Their retrieval models are trained
   * asymmetrically — a stored document and a search query are encoded differently — and NVIDIA's docs
   * warn that using the wrong one causes **large drops in retrieval accuracy**. It is a silent failure:
   * the request succeeds and the vectors merely stop meaning what you think.
   *
   * Default `"passage"`, because most call sites here are INDEXING (doc chunks, element signatures,
   * flow documents). The three search paths pass `"query"` explicitly.
   */
  async embedOne(
    text: string,
    opts?: { retries?: number; inputType?: "query" | "passage" }
  ): Promise<number[]> {
    if (!this.apiKey) throw new Error("OPENAI_API_KEY is not set");
    if (!this.model) throw new Error("OPENAI_EMBED_MODEL is not set");

    const maxRetries = opts?.retries ?? 2;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this._doEmbed(text, opts?.inputType ?? "passage");
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxRetries) {
          // Exponential backoff: 1s, 2s, 4s...
          const delay = Math.pow(2, attempt) * 1000;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError || new Error("Embedding request failed after retries");
  }

  private async _doEmbed(text: string, inputType: "query" | "passage"): Promise<number[]> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/embeddings`;

    // NVIDIA's retrieval models REQUIRE `input_type`; OpenAI's schema has no such field. Because this
    // client speaks raw HTTP rather than going through the OpenAI SDK, we can simply add it — the SDK
    // route would reject the extra argument, which is why other projects resort to `-query`/`-passage`
    // model-name suffixes. Sent only for NVIDIA so nothing changes for OpenRouter.
    const isNvidia = providerForBaseUrl(this.baseUrl) === "nvidia";
    const body: Record<string, unknown> = { model: this.model, input: text };
    if (isNvidia) {body.input_type = inputType;}

    const send = (payload: Record<string, unknown>) =>
      fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

    let res = await send(body);

    // Not every NVIDIA embedding model takes `input_type` (the generalist ones use task instructions
    // instead). If one rejects it, retry once without rather than failing the run outright.
    if (!res.ok && isNvidia && (res.status === 400 || res.status === 422)) {
      const detail = await res.clone().text().catch(() => "");
      if (/input_type/i.test(detail)) {
        const { input_type: _drop, ...withoutType } = body;
        res = await send(withoutType);
      }
    }

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`Embeddings request failed: ${res.status} ${res.statusText}\n${t}`);
    }

    const json = await res.json() as any;
    const vec = json?.data?.[0]?.embedding;
    if (!Array.isArray(vec)) throw new Error("Embeddings response missing embedding vector");
    return vec;
  }
}