# ReceptionistAgent

## Overview

The ReceptionistAgent is the first agent in the AgenticQA pipeline. It acts as an intelligent router that classifies user requests into three categories:

- **CASUAL**: General conversation and greetings
- **DOMAIN_QA**: Questions about application domain knowledge (routed to DomainQaAgent)
- **TEST_GEN**: Test generation requests (routed to TestPlannerAgent and the full pipeline)

## Architecture

The ReceptionistAgent uses a **hybrid classification approach**:

### Primary: LLM-Based Classification

When properly configured with an LLM API key, the agent uses a large language model to intelligently classify requests based on:

- Semantic understanding of the request
- Context clues (URLs, question patterns, test keywords)
- Intent detection with confidence scoring

**System Prompt**: See `prompts/system.md` for the full classification guidelines.

**Output Schema**:
```json
{
  "intent": "CASUAL" | "DOMAIN_QA" | "TEST_GEN",
  "confidence": 0.0-1.0,
  "reasoning": "Brief explanation of the classification decision"
}
```

### Fallback: Rule-Based Classification

If the LLM is unavailable (missing API key, network error, etc.), the agent falls back to deterministic rule-based classification:

- **Keyword matching** for explicit test generation terms
- **Pattern matching** for questions (ending with `?`, starting with question words)
- **URL detection** via regex
- **Greeting detection** for casual conversation

This ensures the system remains functional even without LLM configuration.

## Configuration

The ReceptionistAgent uses the same LLM configuration as other agents:

```env
# packages/orchestrator/.env
OPENAI_API_KEY=sk-or-v1-your-key-here
OPENAI_BASE_URL=https://openrouter.ai/api/v1
OPENAI_MODEL=arcee-ai/trinity-large-preview:free
```

## Usage

The agent is automatically invoked at the start of the pipeline in `runPipeline.ts`:

```typescript
// run_only mode skips ReceptionistAgent
if (ctx.runMode === "run_only") {
  ctx.intent = "TEST_GEN";
} else {
  const receptionist = new ReceptionistAgent();
  await receptionist.run(ctx, logger);
}
```

## Examples

### CASUAL Intent
```
User: "Hello, how are you?"
→ Intent: CASUAL
→ Action: Respond conversationally
```

### DOMAIN_QA Intent
```
User: "What is the difference between JWT and OAuth2?"
→ Intent: DOMAIN_QA
→ Action: Route to DomainQaAgent for RAG-based answer
```

```
User: "How does authentication work in web applications?"
→ Intent: DOMAIN_QA
→ Action: Route to DomainQaAgent
```

### TEST_GEN Intent
```
User: "Test login with valid credentials at http://localhost:5173"
→ Intent: TEST_GEN
→ Action: Run full test generation pipeline
```

```
User: "Generate a test case for user registration"
→ Intent: TEST_GEN
→ Action: Run full test generation pipeline
```

```
User: "Create an E2E test for the checkout flow"
→ Intent: TEST_GEN
→ Action: Run full test generation pipeline
```

## Files

```
ReceptionistAgent/
├── ReceptionistAgent.ts    # Main agent implementation
├── schema.ts               # Zod schema for classification response
├── prompts/
│   └── system.md           # System prompt for LLM classification
├── tools/                  # (Empty - no tools needed)
├── index.ts                # Module export
└── README.md               # This file
```

## Error Handling

The agent handles errors gracefully:

1. **LLM Configuration Missing**: Falls back to rule-based classification
2. **LLM Request Fails**: Logs error, falls back to rule-based classification
3. **Invalid JSON Response**: Logs error, falls back to rule-based classification
4. **Schema Validation Fails**: Logs error, falls back to rule-based classification

This ensures the pipeline never blocks on classification failures.

## Testing

To test the ReceptionistAgent:

```bash
# Test with LLM (ensure .env is configured)
cd packages/orchestrator
npm run build
npm start

# Test rule-based fallback (temporarily remove OPENAI_API_KEY from .env)
```

## Future Improvements

- [ ] Add unit tests for rule-based classification
- [ ] Implement confidence threshold for auto-retry
- [ ] Add support for multi-intent requests
- [ ] Log classification patterns for analysis
