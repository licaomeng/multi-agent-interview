import Anthropic from "@anthropic-ai/sdk";

export class LLMClient {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async chat(
    systemPrompt: string,
    messages: { role: "user" | "assistant"; content: string }[]
  ): Promise<string> {
    const response = await this.client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    });

    const block = response.content[0];
    if (block.type === "text") {
      return block.text;
    }
    return "[no text response]";
  }
}
