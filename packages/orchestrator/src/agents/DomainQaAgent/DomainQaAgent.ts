import { Agent, RunContext, Logger } from "../../core/agent/types";
import { LlmClient } from "../../core/llm/LlmClient";
import { EmbeddingClient } from "../../core/llm/EmbeddingClient";
import { rankChunksByVector, type RankableChunk } from "../../core/rag/ranker";
import { loadSystemPrompt } from "../../core/utils/loadPrompt";
import { extractJsonObjects } from "../../core/llm/json";
import {
  Context7ApiClient,
  type Context7Library,
} from "../../core/context7/Context7ApiClient";
import {
  fetchContext7Document,
  chunkText,
  type Context7Document,
} from "./tools/context7";
import {
  getDocChunkCountForUrl,
  insertDocChunk,
  searchDocChunks,
  deleteDocChunksForUrl,
  findCachedQaAnswer,
  cacheQaAnswer,
  cleanExpiredQaCache,
} from "../../core/db/db";
import {
  DomainQaResponseSchema,
  DocumentSelectionSchema,
  HallucinationCheckSchema,
  type DomainQaResponse,
  type DocumentSelection,
  type HallucinationCheck,
} from "./schema";

export class DomainQaAgent implements Agent {
  name = "DomainQaAgent";

  async run(ctx: RunContext, logger: Logger): Promise<void> {
    const question = ctx.requestText;
    const allowlisted: string[] = ctx.cfg?.allowlistedDomains ?? [];

    if (allowlisted.length === 0) {
      logger.log(
        "DomainQA: no allowlisted domains configured. Add 'allowlistedDomains' to .agenticqa.json"
      );
      logger.log(
        'Example: "allowlistedDomains": ["context7.com"]'
      );
      return;
    }

    const llm = new LlmClient({ appName: "AgenticQA", role: "domainqa" });
    if (!llm.isConfigured()) {
      logger.log("DomainQA: LLM not configured (OPENAI_API_KEY). Cannot compose answer.");
      return;
    }

    const embedder = new EmbeddingClient();
    if (!embedder.isConfigured()) {
      logger.log(
        "DomainQA: embedding client not configured (OPENAI_EMBED_MODEL). Cannot perform similarity search."
      );
      return;
    }

    logger.log(`DomainQA: Processing question: "${question}"`);

    // Domain QA works with or without a database. With Postgres (ctx.projectId set) it uses doc_chunk
    // vector search + the qa_cache; without it, retrieval + ranking happen in memory and caching is
    // skipped (docs are re-fetched per question, so nothing is lost).
    const projectId = ctx.projectId ?? null;
    logger.log(
      projectId
        ? `DomainQA: using database (projectId=${projectId})`
        : "DomainQA: no database — in-memory retrieval"
    );

    try {
      const questionEmbedding = await embedder.embedOne(question, { inputType: "query" });
      const cached = projectId
        ? await findCachedQaAnswer({
            projectId,
            questionEmbedding,
            similarityThreshold: 0.15,
          })
        : null;

      if (cached) {
        logger.log(
          `DomainQA: Cache hit! (distance=${cached.distance.toFixed(4)}, hits=${cached.hitCount})`
        );
        this.outputAnswer(cached.answerJson, logger);
        return;
      }

      logger.log("DomainQA: Cache miss, proceeding with RAG pipeline");

      const isContext7Query = allowlisted.some(
        (d) =>
          d.toLowerCase().includes("context7") ||
          question.toLowerCase().includes("context7")
      );

      let documents: Context7Document[];
      if (isContext7Query) {
        documents = await this.searchDocumentContext7(question, logger);
      } else {
        documents = await this.searchDocumentsAllowlisted(question, allowlisted, logger);
      }

      if (documents.length === 0) {
        logger.log("DomainQA: No documents found");
        await this.respondNoInformationFound(question, logger);
        return;
      }

      logger.log(`DomainQA: Found ${documents.length} document(s) via search`);

      const filtered = this.filterDocumentsByKeyword(question, documents);
      logger.log(`DomainQA: Filtered to ${filtered.length} document(s) via keyword matching`);

      // ⚠️ When nothing clears the keyword threshold, fall back to the SCORE-RANKED order, not to raw
      // search order. `filterDocumentsByKeyword` demands that >=50% of the question's keywords appear in
      // a document's title+description, which a natural-language question almost never achieves —
      // "what are the new playwright rules" scores 1/3 against a doc titled "Playwright". Observed live
      // (2026-08-19): "Filtered to 0 document(s)" on 3 of 4 questions, after which `slice(0, 3)` took
      // whatever order the search happened to return and the ranking work was simply discarded.
      const selectedDocs =
        filtered.length > 0 ? filtered : this.rankDocumentsByKeyword(question, documents).slice(0, 3);
      if (filtered.length === 0) {
        logger.log(
          "DomainQA: no document cleared the keyword threshold — using the 3 best-ranked instead."
        );
      }

      const documentContents = await this.fetchAndChunkDocuments(selectedDocs, question, logger);

      if (documentContents.length === 0) {
        logger.log("DomainQA: Could not fetch any document content");
        await this.respondNoInformationFound(question, logger);
        return;
      }

      logger.log(
        `DomainQA: Fetched ${documentContents.length} document(s) with ${documentContents.reduce(
          (sum, d) => sum + d.chunks.length,
          0
        )} total chunks`
      );

      const topChunks = await this.findRelevantChunks(
        question,
        documentContents,
        questionEmbedding,
        projectId,
        embedder,
        logger
      );

      if (topChunks.length === 0) {
        logger.log("DomainQA: No relevant chunks found");
        await this.respondNoInformationFound(question, logger);
        return;
      }

      logger.log(`DomainQA: Found ${topChunks.length} relevant chunk(s)`);

      const answer = await this.generateAnswerWithConstraints(
        question,
        topChunks,
        documentContents,
        llm,
        logger
      );

      if (!answer) {
        logger.log("DomainQA: Failed to generate answer");
        return;
      }

      if (projectId) {
        try {
          const sourceUrls = answer.sources.map((s) => s.url);
          await cacheQaAnswer({
            projectId,
            question,
            questionEmbedding,
            answerJson: answer,
            sources: sourceUrls,
          });
          logger.log("DomainQA: Answer cached for 30 days");
        } catch (e: any) {
          logger.log(`DomainQA: Cache write failed: ${e?.message}`);
        }
      }

      this.outputAnswer(answer, logger);
    } catch (error: any) {
      logger.log(`DomainQA: Unexpected error: ${error?.message}`);
      logger.log(`DomainQA: Stack: ${error?.stack?.substring(0, 200)}`);
      await this.respondNoInformationFound(question, logger, `Error: ${error?.message}`);
    }
  }

  private async searchDocumentContext7(
    question: string,
    logger: Logger
  ): Promise<Context7Document[]> {
    const context7 = new Context7ApiClient();

    try {
      logger.log(`DomainQA: Searching Context7 for libraries related to: "${question}"`);
      const searchResult = await context7.searchLibraries(question);

      if (searchResult.libraries.length === 0) {
        logger.log("DomainQA: No libraries found for query");
        return [];
      }

      logger.log(`DomainQA: Found ${searchResult.libraries.length} library(ies)`);

      return searchResult.libraries.slice(0, 5).map((lib: Context7Library, i: number) => ({
        id: `context7-${i}`,
        title: lib.title,
        url: `https://context7.com/docs${lib.id}`,
        description: lib.description,
        library: lib.title,
        score: lib.benchmarkScore / 100,
        libraryId: lib.id,
        benchmarkScore: lib.benchmarkScore,
      }));
    } catch (error: any) {
      logger.log(`DomainQA: Context7 search failed: ${error?.message}`);
      logger.log("DomainQA: Falling back to HTTP-based search...");

      try {
        const { searchContext7 } = await import("./tools/context7");
        const results = await searchContext7(question, { limit: 10 });
        return results.documents;
      } catch (fallbackError: any) {
        logger.log(`DomainQA: Fallback also failed: ${fallbackError?.message}`);
        return [];
      }
    }
  }

  private async searchDocumentsAllowlisted(
    question: string,
    allowlisted: string[],
    logger: Logger
  ): Promise<Context7Document[]> {
    return allowlisted.map((domain, i) => ({
      id: `allowlist-${i}`,
      title: `Documentation - ${domain}`,
      url: `https://${domain}`,
      description: `Official documentation for ${domain}`,
      library: domain,
      score: 0.5,
    }));
  }

  /**
   * Same scoring as `filterDocumentsByKeyword`, but ORDERS instead of rejecting.
   *
   * The threshold version answers "is this document clearly on topic?" and is right to be strict. This
   * one answers "which of these is most on topic?", which is the question worth asking once nothing has
   * cleared the bar — a 0.33 match is weak evidence, but it is strictly better evidence than position in
   * an unranked search result.
   */
  private rankDocumentsByKeyword(
    question: string,
    documents: Context7Document[]
  ): Context7Document[] {
    const keywords = question
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2 && !this.isCommonStopword(w));
    if (keywords.length === 0) {return documents;}

    return documents
      .map((doc, i) => {
        const text = `${doc.title} ${doc.description || ""}`.toLowerCase();
        const matches = keywords.filter((k) => text.includes(k)).length;
        return { doc, score: matches / keywords.length, i };
      })
      // Stable: equal scores keep the search engine's own ordering, which is itself a relevance signal.
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .map((x) => x.doc);
  }

  private filterDocumentsByKeyword(
    question: string,
    documents: Context7Document[]
  ): Context7Document[] {
    const keywords = question
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2 && !this.isCommonStopword(w));

    if (keywords.length === 0) return [];

    const scored = documents.map((doc) => {
      const text = `${doc.title} ${doc.description || ""}`.toLowerCase();
      let matchCount = 0;

      for (const keyword of keywords) {
        if (text.includes(keyword)) matchCount++;
      }

      const score = matchCount / keywords.length;
      return { doc, score };
    });

    return scored
      .filter((s) => s.score >= 0.5)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((s) => s.doc);
  }

  private isCommonStopword(word: string): boolean {
    const stopwords = new Set([
      "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
      "is", "was", "are", "be", "been", "being", "have", "has", "had",
      "do", "does", "did", "will", "would", "could", "should", "may",
      "what", "which", "who", "when", "where", "why", "how", "can",
      "how", "its", "this", "that", "these", "those", "i", "you", "he",
    ]);
    return stopwords.has(word);
  }

  private async fetchAndChunkDocuments(
    documents: Context7Document[],
    question: string,
    logger: Logger
  ): Promise<Array<{ url: string; title: string; content: string; chunks: string[] }>> {
    const context7 = new Context7ApiClient();
    const results = [];

    for (const doc of documents) {
      const libraryId = (doc as any).libraryId as string | undefined;
      try {
        let content: string;

        if (libraryId) {
          logger.log(`DomainQA: Fetching context from Context7 API for "${doc.title}" (${libraryId})...`);
          content = await context7.getContext(libraryId, question, "txt");
        } else {
          logger.log(`DomainQA: Fetching ${doc.title} via HTTP...`);
          const fetched = await fetchContext7Document(doc.url);
          content = fetched.content;
        }

        if (!content || content.length < 50) {
          logger.log(`DomainQA: Skipping ${doc.title} - insufficient content`);
          continue;
        }

        const chunks = chunkText(content, { chunkSize: 1000, overlap: 150, maxChunks: 15 });

        results.push({
          url: doc.url,
          title: doc.title,
          content,
          chunks,
        });

        logger.log(`DomainQA: Fetched ${chunks.length} chunks from ${doc.title}`);

        await this.sleep(200);
      } catch (error: any) {
        logger.log(`DomainQA: Failed to fetch ${doc.title}: ${error?.message}`);
      }
    }

    return results;
  }

  private async findRelevantChunks(
    question: string,
    documentContents: Array<{
      url: string;
      title: string;
      content: string;
      chunks: string[];
    }>,
    questionEmbedding: number[],
    projectId: string | null,
    embedder: EmbeddingClient,
    logger: Logger
  ): Promise<Array<{ chunkText: string; sourceUrl: string; docTitle: string }>> {
    // ── No DB → rank in memory (no doc_chunk writes). Reuses the same pure ranker + top-k contract. ──
    if (!projectId) {
      const chunks: RankableChunk[] = [];
      for (const doc of documentContents) {
        for (const text of doc.chunks) {
          try {
            const embedding = await embedder.embedOne(text);
            chunks.push({ chunkText: text, embedding, sourceUrl: doc.url, docTitle: doc.title });
          } catch (e: any) {
            logger.log(`DomainQA: Failed to embed chunk: ${e?.message}`);
          }
        }
      }
      if (chunks.length === 0) return [];
      return rankChunksByVector(questionEmbedding, chunks, 8).map((r) => ({
        chunkText: r.chunkText,
        sourceUrl: r.sourceUrl ?? "",
        docTitle: r.docTitle ?? "Unknown",
      }));
    }

    // ── DB path: scratch insert → scoped vector search → cleanup. ──
    const tempUrl = `temp://qa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let storedCount = 0;

    try {
      for (const doc of documentContents) {
        for (let i = 0; i < doc.chunks.length; i++) {
          try {
            const embedding = await embedder.embedOne(doc.chunks[i]);
            await insertDocChunk({
              projectId,
              sourceUrl: tempUrl,
              chunkIndex: storedCount++,
              chunkText: doc.chunks[i],
              embedding,
            });
          } catch (e: any) {
            logger.log(`DomainQA: Failed to embed chunk: ${e?.message}`);
          }
        }
      }

      if (storedCount === 0) {
        return [];
      }

      // Scope the vector search to THIS question's scratch chunks only — never the whole project's
      // doc_chunk (which would mix in other questions' chunks and skew relevance).
      const topK = await searchDocChunks({
        projectId,
        queryEmbedding: questionEmbedding,
        limit: 8,
        sourceUrl: tempUrl,
      });

      return topK.map((chunk) => {
        const docTitle =
          documentContents.find((d) => d.chunks.includes(chunk.chunkText))?.title ||
          "Unknown";

        return {
          chunkText: chunk.chunkText,
          sourceUrl: chunk.sourceUrl,
          docTitle,
        };
      });
    } finally {
      // Remove this question's scratch chunks so they can't contaminate later questions or grow
      // doc_chunk unbounded.
      try {
        const removed = await deleteDocChunksForUrl(projectId, tempUrl);
        if (removed) logger.log(`DomainQA: cleaned ${removed} scratch chunk(s)`);
      } catch (e: any) {
        logger.log(`DomainQA: scratch chunk cleanup failed: ${e?.message}`);
      }
    }
  }

  private async generateAnswerWithConstraints(
    question: string,
    chunks: Array<{ chunkText: string; sourceUrl: string; docTitle: string }>,
    documentContents: Array<{
      url: string;
      title: string;
      content: string;
      chunks: string[];
    }>,
    llm: LlmClient,
    logger: Logger
  ): Promise<DomainQaResponse | null> {
    const contextText = chunks
      .map((c, i) => `[Source ${i + 1}: ${c.docTitle}]\n${c.chunkText}`)
      .join("\n\n");

    // System prompt lives in prompts/system.md (loaded at runtime — G0.4). It MUST keep demanding
    // strict JSON: the reply is parsed with a brace match + Zod below.
    const systemPrompt = loadSystemPrompt("DomainQaAgent", undefined, { log: (m) => logger.log(m) });

    const userPrompt = `QUESTION: ${question}

CONTEXT DOCUMENTS:
${contextText}

Generate a complete answer using the schema:
{
  "directAnswer": "1-2 sentence direct answer, must cite sources",
  "detailedExplanation": "full explanation with citations to sources",
  "sources": [
    {"title": "doc title", "url": "url", "type": "primary|secondary", "contribution": "what it contributed"}
  ],
  "confidence": "HIGH|MEDIUM|LOW|UNKNOWN",
  "confidenceReasoning": "why this confidence (based on source quality and completeness)",
  "isComplete": true/false,
  "missingInformation": "what's missing if incomplete"
}

REMEMBER: Every claim must be verifiable in the sources. Do not hallucinate.`;

    try {
      const response = await llm.chat(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        // ⚠️ Was 2000, and that TRUNCATED the answer mid-JSON. This is D21 repeating in Domain QA: a
        // reasoning model spends tokens thinking before it emits a single character of JSON, so the cap
        // has to cover reasoning + a sources array + prose, not just the visible answer. Observed live
        // (2026-08-19) as `Expected ',' or ']' after array element ... at position 3621` — the classic
        // signature of a response that simply stopped. The planner uses 6000 for the same reason.
        { maxTokens: 6000, temperature: 0.1 }
      );

      // ⚠️ Was `response.match(/\{[\s\S]*\}/)` — first `{` to LAST `}`. That is defect D22, which the
      // planner path already fixed and this path did not. It breaks two ways, both observed:
      //   1. A model that reasons in prose quotes an inline `{ "action": "click" }` example, so the
      //      slice STARTS inside the reasoning and is not valid JSON.
      //   2. On a TRUNCATED response the last `}` is some nested object's brace, so the slice is a
      //      half-open object — exactly the "Expected ',' or ']'" error above.
      // `extractJsonObjects` walks the text tracking brace depth AND string state, returning every
      // balanced candidate; we try them last-first because the real answer follows the reasoning.
      const candidates = extractJsonObjects(response);
      if (!candidates.length) {
        logger.log(
          `DomainQA: no balanced JSON object in the reply (${response.length} chars). ` +
            `Excerpt: ${JSON.stringify(response.slice(0, 240))}`
        );
        return null;
      }

      let lastError: any = null;
      for (let i = candidates.length - 1; i >= 0; i--) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(candidates[i]);
        } catch (e) {
          lastError = e;
          continue;
        }
        const result = DomainQaResponseSchema.safeParse(parsed);
        if (result.success) {
          if (i !== candidates.length - 1) {
            logger.log(`DomainQA: used JSON candidate ${i + 1} of ${candidates.length}.`);
          }
          return result.data;
        }
        lastError = result.error;
      }

      // ── Salvage ────────────────────────────────────────────────────────────────────────────────
      // A research answer is not a test plan: a well-sourced explanation that merely mislabels its
      // confidence is still worth showing, and silently returning null after fetching and ranking real
      // documents is the worst of both worlds — the work was done and then thrown away.
      const salvaged = this.salvageAnswer(candidates, logger);
      if (salvaged) {return salvaged;}

      logger.log(
        `DomainQA: reply did not satisfy the answer schema — ${
          lastError?.message ?? String(lastError)
        } (${response.length} chars, ${candidates.length} JSON candidate(s))`
      );
      return null;
    } catch (error: any) {
      logger.log(`DomainQA: Answer generation failed: ${error?.message}`);
      return null;
    }
  }

  /**
   * Last resort: rebuild a usable answer from a JSON candidate that failed full validation.
   *
   * ⚠️ Deliberately conservative — it invents NOTHING. It only accepts text the model actually wrote,
   * and it requires a real answer field to be present; a blob with neither is still a failure. Missing
   * metadata degrades to UNKNOWN confidence and an explicit warning, so the user can see the answer is
   * partial rather than being handed silence.
   */
  private salvageAnswer(candidates: string[], logger: Logger): DomainQaResponse | null {
    const asProse = (v: unknown): string | null => {
      if (typeof v === "string" && v.trim()) {return v.trim();}
      if (Array.isArray(v)) {
        const joined = v
          .map((x) => (typeof x === "string" ? x : x == null ? "" : JSON.stringify(x)))
          .filter((x) => x.trim())
          .join("\n\n");
        return joined.trim() ? joined : null;
      }
      return null;
    };

    for (let i = candidates.length - 1; i >= 0; i--) {
      let obj: any;
      try {
        obj = JSON.parse(candidates[i]);
      } catch {
        continue;
      }
      if (!obj || typeof obj !== "object") {continue;}

      const direct = asProse(obj.directAnswer);
      const detail = asProse(obj.detailedExplanation);
      if (!direct && !detail) {continue;}

      const sources = Array.isArray(obj.sources)
        ? obj.sources
            .filter((x: any) => x && typeof x === "object" && typeof x.title === "string")
            .map((x: any) => ({
              title: String(x.title),
              url: typeof x.url === "string" ? x.url : "",
              type: ["primary", "secondary", "related"].includes(x.type) ? x.type : "secondary",
              contribution: typeof x.contribution === "string" ? x.contribution : undefined,
            }))
        : [];

      logger.log(
        "DomainQA: reply failed strict validation — salvaged the answer text and sources it did contain."
      );
      return {
        directAnswer: direct ?? (detail as string).slice(0, 500),
        detailedExplanation: detail ?? (direct as string),
        sources,
        confidence: ["HIGH", "MEDIUM", "LOW", "UNKNOWN"].includes(obj.confidence)
          ? obj.confidence
          : "UNKNOWN",
        confidenceReasoning:
          asProse(obj.confidenceReasoning) ??
          "Recovered from a reply that did not fully match the expected schema; treat with caution.",
        isComplete: obj.isComplete === true,
        warnings: [
          "This answer was recovered from a malformed model reply — some fields may be missing.",
          ...(Array.isArray(obj.warnings) ? obj.warnings.filter((w: any) => typeof w === "string") : []),
        ],
      } as DomainQaResponse;
    }
    return null;
  }

  private outputAnswer(answer: DomainQaResponse, logger: Logger): void {
    // Emit structured answer for extension UI (chat display)
    if (logger.domainAnswer) {
      logger.domainAnswer({
        question: "", // Will be filled by extension
        directAnswer: answer.directAnswer,
        detailedExplanation: answer.detailedExplanation,
        sources: answer.sources.map(s => ({
          title: s.title,
          url: s.url,
          type: s.type,
          contribution: s.contribution
        })),
        confidence: answer.confidence,
        confidenceReasoning: answer.confidenceReasoning,
        isComplete: answer.isComplete,
        missingInformation: answer.missingInformation,
        warnings: answer.warnings
      });
    }

    const lines: string[] = [];

    lines.push("══════════════════════════════════════════");
    lines.push(" AgenticQA — Domain Q&A Answer");
    lines.push("══════════════════════════════════════════");
    lines.push("");
    lines.push(` 📝 Direct Answer:`);
    lines.push(` ${answer.directAnswer}`);
    lines.push("");
    lines.push("──────────────────────────────────────────");
    lines.push("");
    lines.push(` 📖 Detailed Explanation:`);
    lines.push("");
    lines.push(answer.detailedExplanation);
    lines.push("");
    lines.push("──────────────────────────────────────────");
    lines.push("");
    lines.push(" 📄 Sources:");
    if (answer.sources.length === 0) {
      lines.push(" (No sources - information may not be from verified documentation)");
    }
    for (const source of answer.sources) {
      const typeBadge = source.type === "primary" ? "[PRIMARY]" : "[SECONDARY]";
      lines.push(` ${typeBadge} ${source.title}`);
      lines.push(` ${source.url}`);
      if (source.contribution) {
        lines.push(` → ${source.contribution}`);
      }
    }
    lines.push("");
    lines.push(` 📊 Confidence: ${answer.confidence}`);
    lines.push(` Reason: ${answer.confidenceReasoning}`);

    if (!answer.isComplete) {
      lines.push("");
      lines.push(` ⚠️ Incomplete: ${answer.missingInformation}`);
    }

    if (answer.warnings && answer.warnings.length > 0) {
      lines.push("");
      lines.push(" ⚠️ Warnings:");
      for (const warning of answer.warnings) {
        lines.push(` - ${warning}`);
      }
    }

    lines.push("");
    lines.push("══════════════════════════════════════════");
    logger.log("\n" + lines.join("\n"));
  }

  private async respondNoInformationFound(
    question: string,
    logger: Logger,
    reason?: string
  ): Promise<void> {
    // Emit structured "no answer" for extension UI
    if (logger.domainAnswer) {
      logger.domainAnswer({
        question,
        directAnswer: "No relevant information found in the documentation.",
        detailedExplanation: reason
          ? `The search failed with: ${reason}`
          : "The documentation search did not find relevant information to answer your question.",
        sources: [],
        confidence: "UNKNOWN",
        confidenceReasoning: "No relevant sources were found.",
        isComplete: false,
        missingInformation: "The topic may not be covered in the allowlisted documentation.",
        warnings: reason ? [reason] : []
      });
    }

    const lines: string[] = [];
    lines.push("══════════════════════════════════════════");
    lines.push(" AgenticQA — Domain Q&A");
    lines.push("══════════════════════════════════════════");
    lines.push("");
    lines.push(` ❌ No Information Found`);
    lines.push("");
    lines.push(` Q: ${question}`);
    lines.push("");
    lines.push("──────────────────────────────────────────");
    lines.push("");
    lines.push(" The documentation search did not find");
    lines.push(" relevant information to answer your question.");
    if (reason) {
      lines.push("");
      lines.push(` Reason: ${reason}`);
    }
    lines.push("");
    lines.push(" Suggestions:");
    lines.push(" • Try rephrasing your question");
    lines.push(" • Use more specific keywords");
    lines.push(" • Check if the topic is covered in docs");
    lines.push("");
    lines.push("══════════════════════════════════════════");
    logger.log("\n" + lines.join("\n"));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}