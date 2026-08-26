# Domain Q&A Agent (DomainQaAgent)

RAG-based agent for answering questions about allowlisted documentation sites (e.g., Context7) with strict fact-checking and citation requirements.

## Overview

The DomainQaAgent enables users to ask questions about documentation sites and receive accurate, cited answers based **only** on the retrieved content. It prevents hallucination through multiple validation layers.

## Key Features

### 🔍 Enhanced Context7 Integration
- **Smart Search**: Uses Context7's API (with fallback to web scraping) to find relevant documents
- **LLM-Powered Selection**: AI selects the most relevant documents from search results
- **Multi-Document Analysis**: Fetches and analyzes content from multiple sources

### 🛡️ Anti-Hallucination Measures
- **Source-Bound Answers**: Every claim must cite a specific source
- **Hallucination Check**: Post-generation fact-checking validates all claims
- **Confidence Scoring**: Explicit confidence levels (HIGH/MEDIUM/LOW/UNKNOWN)
- **Missing Info Disclosure**: Clearly states when information is unavailable

### 📚 Citation System
- **Inline Citations**: `[Source: Document Title](URL)` format
- **Primary/Secondary Sources**: Distinguishes between main and supporting sources
- **Contribution Tracking**: Explains what each source contributed
- **Related Topics**: Suggests additional relevant documentation

### 🔄 Dual-Mode Operation
- **Context7 Mode**: Enhanced search + multi-document analysis
- **Allowlisted Mode**: Traditional single-page caching + retrieval

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   DomainQaAgent                          │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌──────────────┐    ┌──────────────┐    ┌───────────┐ │
│  │   Search     │───▶│   Document   │───▶│  Content  │ │
│  │  Context7    │    │  Selection   │    │  Fetching │ │
│  └──────────────┘    └──────────────┘    └───────────┘ │
│                            │                              │
│                            ▼                              │
│  ┌──────────────┐    ┌──────────────┐    ┌───────────┐ │
│  │   Embedding  │◀───│    Chunk     │◀───│  Parsing  │ │
│  │   Question   │    │   Creation   │    │  & Clean  │ │
│  └──────────────┘    └──────────────┘    └───────────┘ │
│         │                                              │
│         ▼                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌───────────┐ │
│  │  Similarity  │───▶│   Answer     │───▶│Fact Check │ │
│  │   Search     │    │ Generation   │    │  (LLM)    │ │
│  └──────────────┘    └──────────────┘    └───────────┘ │
│                            │                              │
│                            ▼                              │
│                    ┌──────────────┐                       │
│                    │   Formatted  │                       │
│                    │   Response   │                       │
│                    └──────────────┘                       │
└─────────────────────────────────────────────────────────┘
```

## Pipeline Flow

### Context7 Query Flow

1. **Search**: Query Context7 API for relevant documents
2. **Select**: LLM ranks and selects most relevant documents
3. **Fetch**: Retrieve full content from selected documents
4. **Chunk**: Split content into embeddable segments
5. **Embed**: Create vector embeddings for chunks
6. **Search**: Find top-K chunks via similarity search
7. **Generate**: LLM creates answer with citations
8. **Verify**: Hallucination check validates all claims
9. **Output**: Formatted response with sources

### Allowlisted Domain Flow

1. **Extract URL**: Parse from question or use default
2. **Check Cache**: Look for existing chunks in DB
3. **Fetch**: Download and parse web page
4. **Chunk & Store**: Create embeddings, store in PostgreSQL
5. **Search**: Find relevant chunks via similarity
6. **Generate**: LLM creates answer with citations
7. **Output**: Formatted response

## Configuration

### .agenticqa.json

```json
{
  "baseUrl": "http://localhost:5173",
  "testDir": "tests/generated",
  "allowlistedDomains": [
    "context7.com",
    "example.com"
  ]
}
```

### Environment Variables

```bash
# Required for DomainQaAgent
OPENAI_API_KEY=sk-...           # Or OpenRouter key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
OPENAI_EMBED_MODEL=text-embedding-3-small

# Optional: Context7 API key for enhanced features
CONTEXT7_API_KEY=...            # Get from context7.com
```

## Usage

### Asking Questions

**Via VSCode Extension:**
```
Command: AgenticQA: New Request
Question: "How do I add private documentation sources in Context7?"
```

**Expected Output:**
```
══════════════════════════════════════════
  AgenticQA — Domain Q&A Answer
══════════════════════════════════════════

  📝 Direct Answer:
  Context7 allows you to add private documentation sources by creating an API key 
  and configuring your library.

  📖 Detailed Explanation:
  1. Navigate to context7.com and create an API key from your dashboard
  2. Configure your library with the API key in the settings
  3. Add your documentation source URL...

  📄 Sources:
     [PRIMARY] Add Private Sources
          https://context7.com/docs/how-to/add-private-sources
          → Main steps for adding private docs
     [SECONDARY] Authentication Guide
          https://context7.com/docs/auth
          → API key requirements

  📊 Confidence: HIGH
     Reason: Multiple sources confirm this information

  🔗 Related Topics:
     - API Key Management: https://context7.com/docs/api-keys
══════════════════════════════════════════
```

### Example Questions

```
✅ Good Questions:
- "How do I authenticate with Context7?"
- "What are the pricing plans for Context7?"
- "Explain how to use the Context7 MCP server"
- "https://context7.com/docs/install - what does this page cover?"

❌ Poor Questions:
- "What's the weather?" (not in domain)
- "Tell me about React" (too broad, not Context7-specific)
```

## Response Schema

The agent uses Zod validation to ensure response quality:

```typescript
{
  directAnswer: string;              // 1-2 sentence summary
  detailedExplanation: string;       // Full explanation
  sources: Array<{
    title: string;                   // Document title
    url: string;                     // Full URL
    type: "primary" | "secondary";   // Source importance
    contribution: string;            // What it contributed
  }>;
  confidence: "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
  confidenceReasoning: string;       // Why this confidence
  isComplete: boolean;               // Whether answer is complete
  missingInformation?: string;       // What's missing
  warnings?: string[];               // Any caveats
  relatedTopics?: Array<{
    title: string;
    url: string;
    description?: string;
  }>;
}
```

## Anti-Hallucination Measures

### 1. Source-Bound Generation
The LLM is instructed to:
- Answer ONLY from provided context
- State when information is unavailable
- Cite every factual claim
- Never use external knowledge

### 2. Post-Generation Fact Check
After generating an answer, a second LLM call:
- Extracts all claims from the answer
- Verifies each claim against source chunks
- Flags potentially hallucinated statements
- Recommends revisions if needed

### 3. Confidence Scoring
The agent assesses confidence based on:
- **HIGH**: Multiple sources confirm, detailed information available
- **MEDIUM**: Single source, may be incomplete
- **LOW**: Limited information, partial answer
- **UNKNOWN**: No relevant information found

### 4. Citation Validation
Every answer must include:
- At least one source citation
- Valid URLs for all sources
- Clear contribution statements

## Tools

### context7.ts

Context7-specific search and fetching tools:

```typescript
// Search Context7 for documents
searchContext7(query, { limit?, apiKey? })

// Fetch full document content
fetchContext7Document(url, { apiKey? })

// Chunk text for embedding
chunkText(text, { chunkSize?, overlap?, maxChunks? })
```

### fetcher.ts (Legacy)

General web fetching utilities:

```typescript
// Fetch and extract text from URL
fetchAndExtract(url)

// Chunk text
chunkText(text, options)
```

## Database Schema

The agent uses PostgreSQL + pgvector for RAG:

```sql
-- Document chunks with embeddings
CREATE TABLE doc_chunks (
  id UUID PRIMARY KEY,
  project_id UUID,
  source_url TEXT,
  chunk_index INTEGER,
  chunk_text TEXT,
  embedding VECTOR(1536),  -- Or model-specific dimension
  metadata JSONB,
  created_at TIMESTAMP
);
```

## Error Handling

### Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| "no allowlisted domains" | Missing config | Add `allowlistedDomains` to `.agenticqa.json` |
| "embedding client not configured" | Missing `OPENAI_EMBED_MODEL` | Set env var with embedding model |
| "LLM not configured" | Missing `OPENAI_API_KEY` | Set API key in `.env` |
| "Fetch failed: 403" | Site blocks automated requests | Use Context7 API or manual URL |
| "No relevant chunks found" | Query doesn't match content | Rephrase question, check docs |
| "Hallucination check failed" | LLM invented information | Answer revised or flagged |

### Fallback Behavior

- **Context7 API fails** → Falls back to web scraping
- **Web scraping fails** → Returns "no information found"
- **LLM selection fails** → Uses top results by search score
- **Hallucination check flags issues** → Adds warnings to answer

## Limitations

1. **JavaScript Rendering**: Simple fetch() doesn't execute JS. Sites using heavy client-side rendering may return incomplete content.

2. **Rate Limiting**: Aggressive querying may trigger rate limits. The agent includes delays but may need adjustment.

3. **Authentication**: Cannot access docs behind login walls without credentials.

4. **Context Window**: Very long documents may exceed LLM context limits. Chunking helps but may lose some context.

5. **Freshness**: Cached chunks may become stale. Consider implementing TTL-based invalidation.

## Future Improvements

- [ ] Playwright-based fetching for JavaScript-rendered content
- [ ] Multi-turn Q&A with follow-up questions
- [ ] Cross-document reasoning and synthesis
- [ ] Automatic documentation freshness checks
- [ ] User feedback loop for answer quality
- [ ] Multi-language support
- [ ] Visual citation highlighting in UI

## Testing

To test the DomainQaAgent:

1. Ensure `.agenticqa.json` has `allowlistedDomains` configured
2. Set `OPENAI_API_KEY` and `OPENAI_EMBED_MODEL` in `.env`
3. Ask a question via VSCode extension
4. Verify:
   - Answer cites specific sources
   - Sources are from allowlisted domains
   - Confidence level is appropriate
   - No hallucinated information

## Related

- [ReceptionistAgent](../ReceptionistAgent/README.md) - Routes questions to DomainQaAgent
- [EmbeddingClient](../../core/llm/EmbeddingClient.ts) - Vector embeddings
- [LlmClient](../../core/llm/LlmClient.ts) - LLM API client
- [DbService](../../core/db/db.ts) - PostgreSQL operations
