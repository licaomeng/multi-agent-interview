import Anthropic from "@anthropic-ai/sdk";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  // Context windowing/summarization: injected into the system prompt.
  // Deliberately NOT injected as an assistant-head turn — that gets coerced
  // to "user" by the agent's merge logic and corrupts history.
  summary?: string;
}

/** Structural contract the Agent depends on (mockable in tests). */
export interface LLM {
  chat(
    systemPrompt: string,
    messages: ChatMessage[],
    opts?: ChatOptions
  ): Promise<string>;
}

export class LLMClient implements LLM {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async chat(
    systemPrompt: string,
    messages: ChatMessage[],
    opts?: ChatOptions
  ): Promise<string> {
    const system = opts?.summary
      ? `${systemPrompt}\n\n[Summary of earlier conversation]\n${opts.summary}`
      : systemPrompt;

    const response = await this.client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system,
      messages,
    });

    const block = response.content[0];
    if (block.type === "text") {
      return block.text;
    }
    return "[no text response]";
  }
}
