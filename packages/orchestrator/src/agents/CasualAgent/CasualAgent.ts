import { Agent, RunContext, Logger } from "../../core/agent/types";
import { LlmClient } from "../../core/llm/LlmClient";

/**
 * Casual Conversation Agent
 * 
 * Responds to casual greetings, questions, and conversation in a friendly manner.
 * Used when the ReceptionistAgent classifies intent as CASUAL.
 */
export class CasualAgent implements Agent {
  name = "CasualAgent";

  async run(ctx: RunContext, logger: Logger): Promise<void> {
    const text = ctx.requestText;
    const llm = new LlmClient({ appName: "AgenticQA", role: "casual" });

    // Check if LLM is configured
    if (!llm.isConfigured()) {
      // Fallback to canned responses
      const fallbackResponse = this.getFallbackResponse(text);
      this.outputResponse(fallbackResponse, logger);
      return;
    }

    // Generate conversational response using LLM
    const systemPrompt = `You are the friendly assistant for AgenticQA, an AI-powered test automation system.

Your role is to engage in casual conversation with users in a helpful, friendly manner.

## Guidelines:
1. Be warm, concise, and helpful
2. Keep responses under 3-4 sentences unless asking for more details
3. If appropriate, mention how AgenticQA can help with test automation
4. Don't generate tests or technical solutions - just converse naturally
5. If the user seems interested in testing, gently guide them toward that topic

## What AgenticQA Does:
- Generates Playwright tests from natural language descriptions
- Automatically heals broken tests when UI changes
- Answers questions about testing and documentation
- Runs tests and provides detailed reports

Respond conversationally. No JSON, no structured output - just natural conversation.`;

    const userPrompt = `User: ${text}`;

    try {
      const response = await llm.chat(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        { temperature: 0.7, maxTokens: 300 }
      );

      this.outputResponse(response, logger);
    } catch (e: any) {
      logger.log(`CasualAgent: LLM failed — ${e?.message ?? String(e)}. Using fallback.`);
      const fallbackResponse = this.getFallbackResponse(text);
      this.outputResponse(fallbackResponse, logger);
    }
  }

  /**
   * Fallback responses when LLM is unavailable
   */
  private getFallbackResponse(text: string): string {
    const t = text.toLowerCase().trim();

    // Greetings
    if (t.match(/^(hi|hello|hey|greetings)/)) {
      return "Hello! 👋 I'm the AgenticQA assistant. I can help you generate automated tests, answer questions about testing, or debug test failures. What would you like to do today?";
    }

    // How are you
    if (t.includes("how are you")) {
      return "I'm doing great, thank you for asking! 😊 Ready to help you with some test automation. What can I do for you today?";
    }

    // What can you do
    if (t.includes("what can you") || t.includes("what do you do")) {
      return "I'm part of AgenticQA, an AI-powered test automation system! I can:\n\n• Generate Playwright tests from your descriptions\n• Automatically fix broken tests when UI changes\n• Answer questions about testing best practices\n• Run your tests and provide detailed reports\n\nJust describe what you want to test, and I'll help you automate it!";
    }

    // Thanks
    if (t.includes("thank")) {
      return "You're welcome! 😊 Feel free to ask if you need help with test automation or have any questions about AgenticQA!";
    }

    // Goodbye
    if (t.match(/(bye|goodbye|see you|later)/)) {
      return "Goodbye! 👋 Come back anytime you need help with test automation. Happy testing!";
    }

    // Default friendly response
    return "Thanks for reaching out! I'm here to help with test automation. You can ask me to generate tests, explain testing concepts, or help debug issues. What would you like to work on?";
  }

/**
 * Output formatted response
   */
  private outputResponse(response: string, logger: Logger): void {
    // Emit structured answer for extension UI (chat display)
    if (logger.casualAnswer) {
      logger.casualAnswer(response);
    }

    const lines: string[] = [];
    lines.push("══════════════════════════════════════════");
    lines.push(" AgenticQA — Assistant Response");
    lines.push("══════════════════════════════════════════");
    lines.push("");
    lines.push(response);
    lines.push("");
    lines.push("══════════════════════════════════════════");

    logger.log("\n" + lines.join("\n"));
  }
}
