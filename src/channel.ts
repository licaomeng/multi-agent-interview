import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import type { Message, MessageKind } from "./types.js";

export interface PostOptions {
  to?: string | "channel";
  topic?: string;
  kind?: MessageKind;
  // A taskId minted by the Channel. Non-owner agents may NOT mint new ones.
  taskId?: string;
  // When true, this post increments the sender's reply ledger for the task.
  // Exempt messages (owner summary, close) omit it.
  countReply?: boolean;
}

/**
 * The coordination kernel for the multi-agent system.
 *
 * Still an EventEmitter, still no central coordinator agent — the Channel
 * only holds the shared facts (topics/ownership/closed-set/reply ledger) that
 * distributed routing decisions consult. All shared-state access is
 * synchronous, so first-come-first-wins claim is race-free.
 */
export class Channel extends EventEmitter {
  private messages: Message[] = [];
  private subscribers = new Map<string, (msg: Message) => void>();
  private memberNames = new Map<string, string>();

  // Coordination state.
  private owners = new Map<string, string>(); // taskId -> owner agentId
  private closed = new Set<string>(); // closed taskIds
  private replyLedger = new Map<string, number>(); // "taskId::agentId" -> count
  private topicToTaskId = new Map<string, string>(); // topic -> canonical taskId
  private knownTaskIds = new Set<string>();
  private activityTimers = new Map<string, NodeJS.Timeout>();
  // Static role maps registered by agents at subscribe time. Post-time role
  // gating derives from these — never from LLM-authored message content (§8.1 #6).
  private senderTopics = new Map<string, string[]>(); // agentId -> its role topics
  // Topic strings a human opened. Human-opened topics are open to every agent
  // (FR9 / §8.1 #5), so posts on them bypass sender role gating.
  private humanTopics = new Set<string>();

  constructor(
    private name: string = "#general",
    private stallTimeoutMs: number = 0
  ) {
    super();
  }

  post(from: string, content: string, opts: PostOptions = {}): Message {
    const topic = opts.topic ?? "general";
    const kind = opts.kind ?? "announce";
    const to = opts.to ?? "channel";

    // A human-opened topic is open to every agent regardless of role (FR9 /
    // §8.1 #5). Record it before any gating so agent replies to a human-opened
    // task are never dropped for being outside the replier's role map.
    if (from === "human") this.humanTopics.add(topic);

    // Post-time role gating (§8.1 #6): routing derives from the sender's static
    // role map, never from LLM-authored message content. A known agent posting
    // on a topic outside its own role map is a role-violating contribution —
    // dropped before it can bind a taskId or be delivered (also blocks the
    // cross-role re-topic injection of §8.1 #1).
    if (from !== "human") {
      const senderTopics = this.senderTopics.get(from);
      if (
        senderTopics &&
        !senderTopics.includes(topic) &&
        !this.humanTopics.has(topic)
      ) {
        return {
          id: randomUUID(),
          timestamp: Date.now(),
          from,
          content,
          to,
          topic,
          kind,
          taskId: undefined,
        };
      }
    }

    const taskId = this.resolveTaskId(topic, from, opts);
    if (taskId === null) {
      // A non-owner agent attempted to open a brand-new topic/taskId.
      // Rejected: not stored, not emitted, no ledger increment.
      return {
        id: randomUUID(),
        timestamp: Date.now(),
        from,
        content,
        to,
        topic,
        kind,
        taskId: undefined,
      };
    }

    // Close-signal ownership guard (§8.1 #3/#4): only the CURRENT topic owner
    // (or a human, FR9/§8.1 #5) may publish a `close` on a topic owned by
    // someone else. A non-owner spoofing a close is dropped exactly like the
    // send-side role gate — not stored, not emitted, not delivered — so the
    // "exactly one close" invariant on raw history holds. (A close on a topic
    // with no current owner is left to the legacy path.)
    if (kind === "close" && from !== "human") {
      const owner = this.getOwner(taskId);
      if (owner !== null && owner !== from) {
        return {
          id: randomUUID(),
          timestamp: Date.now(),
          from,
          content,
          to,
          topic,
          kind,
          taskId: undefined,
        };
      }
    }

    const msg: Message = {
      id: randomUUID(),
      timestamp: Date.now(),
      from,
      content,
      to,
      topic,
      kind,
      taskId,
    };

    // Post-time guard: a reply that arrives after its topic closed is dropped
    // (kind "close" itself always passes, so a close signal is never lost).
    if (this.closed.has(taskId) && kind !== "close") {
      return msg;
    }

    // Reply budget is counted at POST time (regression for the sender-exclusion
    // bug: the poster's own post always increments its own ledger entry).
    if (opts.countReply) {
      this.incrementReplies(taskId, from);
    }

    this.messages.push(msg);
    this.emit("message", msg);
    this.touch(taskId);

    for (const [agentId, callback] of this.subscribers) {
      if (agentId !== from) {
        callback(msg);
      }
    }

    return msg;
  }

  /**
   * Resolve (and mint when allowed) the canonical taskId for a post.
   * - Known topic -> its existing taskId.
   * - Agent re-topic attempt with a KNOWN taskId -> binds the renamed topic to
   *   the existing taskId (no fresh budget / ownership).
   * - "human" may open a brand-new topic/task.
   * - Any other agent attempting a new topic -> null (rejected).
   */
  private resolveTaskId(
    topic: string,
    from: string,
    opts: PostOptions
  ): string | null {
    const known = this.topicToTaskId.get(topic);
    if (known) return known;

    if (opts.taskId && this.knownTaskIds.has(opts.taskId)) {
      this.topicToTaskId.set(topic, opts.taskId);
      return opts.taskId;
    }

    if (from === "human") {
      this.knownTaskIds.add(topic);
      this.topicToTaskId.set(topic, topic);
      return topic;
    }

    return null;
  }

  /**
   * Atomically claim a topic. First caller wins; returns the ownerId.
   * Closed topics cannot be claimed.
   */
  claim(taskId: string, agentId: string): string | null {
    if (this.closed.has(taskId)) return null;
    const existing = this.owners.get(taskId);
    if (existing !== undefined) return existing;
    this.owners.set(taskId, agentId);
    return agentId;
  }

  getOwner(taskId: string): string | null {
    return this.owners.get(taskId) ?? null;
  }

  /** Release ownership (e.g. on agent failure) so the topic can be re-claimed. */
  release(taskId: string, agentId: string): boolean {
    if (this.owners.get(taskId) === agentId) {
      this.owners.delete(taskId);
      return true;
    }
    return false;
  }

  /** Close a topic. Idempotent. Returns true if this call closed it. */
  close(taskId: string): boolean {
    const timer = this.activityTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.activityTimers.delete(taskId);
    }
    if (this.closed.has(taskId)) return false;
    this.closed.add(taskId);
    return true;
  }

  isClosed(taskId: string): boolean {
    return this.closed.has(taskId);
  }

  /** Reply-ledger increment API, keyed by (taskId, agentId). */
  incrementReplies(taskId: string, agentId: string): number {
    const key = `${taskId}::${agentId}`;
    const n = (this.replyLedger.get(key) ?? 0) + 1;
    this.replyLedger.set(key, n);
    return n;
  }

  getReplyCount(taskId: string, agentId: string): number {
    return this.replyLedger.get(`${taskId}::${agentId}`) ?? 0;
  }

  /** Full history, or a per-topic view when a topic is given. */
  getHistory(topic?: string): Message[] {
    if (topic === undefined) return [...this.messages];
    return this.messages.filter((m) => (m.topic ?? "general") === topic);
  }

  subscribe(
    agentId: string,
    callback: (msg: Message) => void,
    topics?: string[]
  ): void {
    this.subscribers.set(agentId, callback);
    if (topics) this.senderTopics.set(agentId, topics);
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

  getMembers(): string[] {
    return [...this.memberNames.keys()];
  }

  getName(): string {
    return this.name;
  }

  /** Stall watchdog: force-close a still-open topic after inactivity. */
  private touch(taskId: string): void {
    if (!this.stallTimeoutMs) return;
    const existing = this.activityTimers.get(taskId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.activityTimers.delete(taskId);
      if (!this.closed.has(taskId)) this.close(taskId);
    }, this.stallTimeoutMs);
    timer.unref?.();
    this.activityTimers.set(taskId, timer);
  }
}
