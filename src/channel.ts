import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import type { Message } from "./types.js";

export class Channel extends EventEmitter {
  private messages: Message[] = [];
  private subscribers = new Map<string, (msg: Message) => void>();
  private memberNames = new Map<string, string>();

  constructor(private name: string = "#general") {
    super();
  }

  post(from: string, content: string): Message {
    const msg: Message = {
      id: randomUUID(),
      timestamp: Date.now(),
      from,
      content,
    };
    this.messages.push(msg);
    this.emit("message", msg);

    for (const [agentId, callback] of this.subscribers) {
      if (agentId !== from) {
        callback(msg);
      }
    }

    return msg;
  }

  subscribe(agentId: string, callback: (msg: Message) => void): void {
    this.subscribers.set(agentId, callback);
  }

  unsubscribe(agentId: string): void {
    this.subscribers.delete(agentId);
  }

  join(agentId: string, displayName: string): void {
    this.memberNames.set(agentId, displayName);
    this.emit("join", { agentId, displayName });
  }

  getDisplayName(id: string): string {
    return this.memberNames.get(id) ?? id;
  }

  getHistory(): Message[] {
    return [...this.messages];
  }

  getMembers(): string[] {
    return [...this.memberNames.keys()];
  }

  getName(): string {
    return this.name;
  }
}
