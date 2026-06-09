import type { AgentConfig, Message } from "./types.js";
import type { Channel } from "./channel.js";
import type { LLMClient } from "./llm.js";

export class Agent {
  private processing = false;
  private queue: Message[] = [];

  constructor(
    private config: AgentConfig,
    private channel: Channel,
    private llm: LLMClient
  ) {}

  start(): void {
    this.channel.subscribe(this.config.id, (msg) => {
      this.queue.push(msg);
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const msg = this.queue.shift()!;
      await this.onMessage(msg);
    }

    this.processing = false;
  }

  private async onMessage(msg: Message): Promise<void> {
    const history = this.channel.getHistory();

    const conversationMessages = history.map((m) => ({
      role: (m.from === this.config.id ? "assistant" : "user") as
        | "user"
        | "assistant",
      content: `[${m.from}]: ${m.content}`,
    }));

    // Merge consecutive same-role messages to satisfy API constraints
    const merged = mergeConsecutiveRoles(conversationMessages);

    try {
      const response = await this.llm.chat(this.config.systemPrompt, merged);
      this.channel.post(this.config.id, response);
    } catch (err: any) {
      console.error(`[${this.config.id}] LLM error: ${err.message}`);
    }
  }
}

function mergeConsecutiveRoles(
  messages: { role: "user" | "assistant"; content: string }[]
): { role: "user" | "assistant"; content: string }[] {
  if (messages.length === 0) return [];

  const result: { role: "user" | "assistant"; content: string }[] = [];
  for (const msg of messages) {
    const last = result[result.length - 1];
    if (last && last.role === msg.role) {
      last.content += "\n" + msg.content;
    } else {
      result.push({ ...msg });
    }
  }

  // Ensure first message is "user" role (API requirement)
  if (result.length > 0 && result[0].role === "assistant") {
    result[0].role = "user";
  }

  return result;
}
