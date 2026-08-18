import type { AgentConfig, Message } from "./types.js";
import type { Channel } from "./channel.js";
import type { LLM } from "./llm.js";

export interface AgentOptions {
  replyBudget?: number;
  completeMarker?: string;
}

const DEFAULT_REPLY_BUDGET = 2;
const DEFAULT_COMPLETE_MARKER = "[DONE]";

export class Agent {
  private processing = false;
  private queue: Message[] = [];

  constructor(
    private config: AgentConfig,
    private channel: Channel,
    private llm: LLM,
    private opts: AgentOptions = {}
  ) {}

  get id(): string {
    return this.config.id;
  }

  start(): void {
    this.channel.subscribe(
      this.config.id,
      (msg) => {
        if (this.shouldIgnore(msg)) return;
        this.queue.push(msg);
        this.processQueue();
      },
      this.config.topics
    );
  }

  /**
   * Routing filter, applied BEFORE the message is queued. All coordination
   * state is read from the Channel, never from a local cache.
   */
  private shouldIgnore(msg: Message): boolean {
    const topic = msg.topic ?? "general";
    const taskId = msg.taskId ?? topic;

    if (msg.kind === "close") return true;
    if (this.channel.isClosed(taskId)) return true;

    // Human messages route to every agent regardless of role or an explicit
    // (even bogus) `to` (FR9 / §8.1 #5). Addressing + role gating apply to
    // agent-authored messages only — routing derives from the sender's static
    // role, never from LLM-authored content (§8.1 #6).
    if (msg.from !== "human") {
      if (msg.to && msg.to !== "channel" && msg.to !== this.config.id) return true;
      if (!this.config.topics.includes(topic)) return true;
    }

    // Reply budget (counted at post time). The topic owner is exempt so it can
    // always publish the completion summary + close.
    const isOwner = this.channel.getOwner(taskId) === this.config.id;
    const budget = this.opts.replyBudget ?? DEFAULT_REPLY_BUDGET;
    if (!isOwner && this.channel.getReplyCount(taskId, this.config.id) >= budget) {
      return true;
    }

    return false;
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const msg = this.queue.shift()!;
        try {
          await this.onMessage(msg);
        } catch (err: any) {
          console.error(`[${this.config.id}] onMessage error: ${err.message}`);
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private async onMessage(msg: Message): Promise<void> {
    const topic = msg.topic ?? "general";
    const taskId = msg.taskId ?? topic;

    // Topic ownership: claim synchronously (before the first await). First
    // agent whose role matches the topic wins; non-owners may NOT open topics.
    if (!this.channel.getOwner(taskId) && this.config.topics.includes(topic)) {
      this.channel.claim(taskId, this.config.id);
    }
    // Whether THIS agent owned the topic when it started processing. Ownership
    // can change while the LLM call is in flight — see the post-await re-check.
    const claimedOwnership = this.channel.getOwner(taskId) === this.config.id;

    // Per-topic history when available (windowed context).
    const history = this.channel.getHistory(topic);
    const conversationMessages = history.map((m) => ({
      role: (m.from === this.config.id ? "assistant" : "user") as
        | "user"
        | "assistant",
      content: `[${m.from}]: ${m.content}`,
    }));
    const merged = mergeConsecutiveRoles(conversationMessages);

    let response: string;
    try {
      response = await this.llm.chat(this.config.systemPrompt, merged);
    } catch (err: any) {
      console.error(`[${this.config.id}] LLM error: ${err.message}`);
      // Release ownership so the topic can be re-claimed / force-closed.
      // release() only clears ownership if this agent still owns the topic, so
      // it is a safe no-op if ownership was already re-claimed elsewhere.
      if (claimedOwnership) this.channel.release(taskId, this.config.id);
      return;
    }

    // Re-check after the await: a topic may have been closed / ownership may
    // have changed while we were calling the LLM.
    if (this.channel.isClosed(taskId)) return;

    // Stale-ownership guard: the topic may have been released and re-claimed
    // by another agent while this LLM call was in flight. Only the CURRENT
    // owner may publish the completion summary + close.
    const isOwner = this.channel.getOwner(taskId) === this.config.id;

    // Owner completion: publish a final summary + a close message. Both are
    // EXEMPT from the reply budget.
    const marker = this.opts.completeMarker ?? DEFAULT_COMPLETE_MARKER;
    if (isOwner && response.includes(marker)) {
      const summary = response.replace(marker, "").trim();
      this.channel.post(this.config.id, summary, {
        to: "channel",
        topic,
        taskId,
        kind: "answer",
      });
      this.channel.post(this.config.id, marker, {
        to: "channel",
        topic,
        taskId,
        kind: "close",
      });
      this.channel.close(taskId);
      return;
    }

    // Normal reply, subject to the per-task reply budget.
    const budget = this.opts.replyBudget ?? DEFAULT_REPLY_BUDGET;
    if (this.channel.getReplyCount(taskId, this.config.id) >= budget) return;

    const kind = msg.kind === "question" ? "answer" : "review";
    this.channel.post(this.config.id, response, {
      to: "channel",
      topic,
      taskId,
      kind,
      countReply: true,
    });
  }
}

export function mergeConsecutiveRoles(
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
