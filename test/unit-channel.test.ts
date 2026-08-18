import { describe, it, expect } from "vitest";
import { Channel } from "../src/channel.js";
import type { Message } from "../src/types.js";

describe("Channel: post envelope defaults", () => {
  it("applies to:'channel', kind:'announce', topic:'general', and mints a taskId", () => {
    const ch = new Channel();
    const m = ch.post("human", "hi");
    expect(m.to).toBe("channel");
    expect(m.kind).toBe("announce");
    expect(m.topic).toBe("general");
    expect(m.taskId).toBe("general");
    expect(m.from).toBe("human");
  });

  it("stores, emits 'message', and delivers to subscribers except the sender", () => {
    const ch = new Channel();
    const received: Message[] = [];
    ch.subscribe("a", (m) => received.push(m));
    ch.subscribe("b", (m) => received.push(m));
    ch.on("message", (m) => received.push(m));

    // Mint the topic with a human post first (agents cannot open topics).
    ch.post("human", "start", { topic: "t" });
    const m = ch.post("a", "hello", { topic: "t", taskId: "t" });
    expect(m.taskId).toBe("t");
    expect(ch.getHistory().length).toBe(2);

    // b got it via subscribe; a (sender) did not; the "message" emitter also got it.
    const fromSubscribers = received.filter((x) => x.id === m.id);
    expect(fromSubscribers.length).toBe(2);
  });
});

describe("Channel: claim/close/isClosed semantics", () => {
  function primedChannel(topic = "t"): Channel {
    const ch = new Channel();
    ch.post("human", "start", { topic, kind: "question" });
    return ch;
  }

  it("claim is first-wins and idempotent", () => {
    const ch = primedChannel();
    expect(ch.claim("t", "a")).toBe("a");
    expect(ch.claim("t", "b")).toBe("a"); // first wins
    expect(ch.getOwner("t")).toBe("a");
  });

  it("close is idempotent and blocks claim after close", () => {
    const ch = primedChannel();
    expect(ch.close("t")).toBe(true);
    expect(ch.close("t")).toBe(false); // second close is a no-op
    expect(ch.isClosed("t")).toBe(true);
    expect(ch.claim("t", "a")).toBeNull(); // cannot claim a closed topic
  });

  it("release clears ownership only for the current owner", () => {
    const ch = primedChannel();
    ch.claim("t", "a");
    expect(ch.release("t", "b")).toBe(false);
    expect(ch.release("t", "a")).toBe(true);
    expect(ch.getOwner("t")).toBeNull();
    expect(ch.claim("t", "b")).toBe("b"); // re-claimable
  });
});

describe("Channel: reply ledger", () => {
  it("increments per (taskId, agentId)", () => {
    const ch = new Channel();
    expect(ch.incrementReplies("t", "a")).toBe(1);
    expect(ch.incrementReplies("t", "a")).toBe(2);
    expect(ch.incrementReplies("t", "b")).toBe(1);
    expect(ch.getReplyCount("t", "a")).toBe(2);
    expect(ch.getReplyCount("t", "b")).toBe(1);
    expect(ch.getReplyCount("other", "a")).toBe(0);
  });

  it("counts replies at post time (regression for the sender-exclusion bug)", () => {
    const ch = new Channel();
    ch.post("human", "start", { topic: "t" });
    // Even though "a" never receives its own messages (sender excluded), its
    // own post-time increment still lands in the ledger.
    ch.post("a", "r1", { topic: "t", taskId: "t", countReply: true });
    ch.post("a", "r2", { topic: "t", taskId: "t", countReply: true });
    expect(ch.getReplyCount("t", "a")).toBe(2);
  });

  it("does not count posts where countReply is omitted (close/summary exemption)", () => {
    const ch = new Channel();
    ch.post("human", "start", { topic: "t" });
    ch.post("a", "summary", { topic: "t", taskId: "t", kind: "answer" });
    ch.post("a", "[DONE]", { topic: "t", taskId: "t", kind: "close" });
    expect(ch.getReplyCount("t", "a")).toBe(0);
  });
});

describe("Channel: getHistory(topic?)", () => {
  it("filters per topic, and returns full history with no arg", () => {
    const ch = new Channel();
    ch.post("human", "one", { topic: "alpha" });
    ch.post("human", "two", { topic: "beta" });
    ch.post("a", "three", { topic: "alpha" });

    expect(ch.getHistory().length).toBe(3);
    expect(ch.getHistory("alpha").map((m) => m.topic)).toEqual(["alpha", "alpha"]);
    expect(ch.getHistory("alpha").map((m) => m.content)).toEqual(["one", "three"]);
    expect(ch.getHistory("gamma")).toEqual([]);
  });
});

describe("Channel: taskId minting rules", () => {
  it("non-owner agents cannot open a brand-new topic (post is dropped)", () => {
    const ch = new Channel();
    ch.post("human", "start", { topic: "known" });
    const before = ch.getHistory().length;
    const dropped = ch.post("a", "new task attempt", {
      topic: "brand-new",
      taskId: "brand-new",
    });
    expect(ch.getHistory().length).toBe(before); // not stored
    expect(ch.getHistory("brand-new")).toEqual([]); // not emitted to history
    expect(dropped.taskId).toBeUndefined();
  });

  it("re-topic with a known taskId binds to the SAME task (no fresh budget)", () => {
    const ch = new Channel();
    ch.post("human", "start", { topic: "task-1" });
    ch.post("a", "r1", { topic: "task-1", taskId: "task-1", countReply: true });
    ch.post("a", "r2", { topic: "task-1", taskId: "task-1", countReply: true });
    expect(ch.getReplyCount("task-1", "a")).toBe(2);

    // a renames the topic but keeps the same taskId.
    ch.post("a", "r3", {
      topic: "task-1-renamed",
      taskId: "task-1",
      countReply: true,
    });

    // Still keyed to the original taskId — the ledger did NOT reset.
    expect(ch.getReplyCount("task-1", "a")).toBe(3);
    expect(ch.getReplyCount("task-1-renamed", "a")).toBe(0);
    expect(ch.getHistory("task-1-renamed").every((m) => m.taskId === "task-1")).toBe(
      true
    );
  });
});

describe("Channel: post-time stale-close guard", () => {
  it("drops a non-close reply after the topic closed", () => {
    const ch = new Channel();
    ch.post("human", "start", { topic: "t" });
    ch.close("t");
    const before = ch.getHistory().length;
    const dropped = ch.post("a", "too late", { topic: "t", taskId: "t", countReply: true });
    expect(ch.getHistory().length).toBe(before);
    expect(ch.getReplyCount("t", "a")).toBe(0);
    expect(dropped.kind).toBe("announce");
  });

  it("still stores a close signal even after the topic closed", () => {
    const ch = new Channel();
    ch.post("human", "start", { topic: "t" });
    ch.close("t");
    ch.post("a", "[DONE]", { topic: "t", taskId: "t", kind: "close" });
    expect(ch.getHistory("t").length).toBe(2); // human + close
  });
});

describe("Channel: stall watchdog", () => {
  it("force-closes an open topic after the inactivity timeout", async () => {
    const ch = new Channel("#dev", 30);
    ch.post("human", "start", { topic: "t" });
    expect(ch.isClosed("t")).toBe(false);
    await new Promise((r) => setTimeout(r, 100));
    expect(ch.isClosed("t")).toBe(true);
  });

  it("is disabled when the timeout is 0 (default)", async () => {
    const ch = new Channel();
    ch.post("human", "start", { topic: "t" });
    await new Promise((r) => setTimeout(r, 50));
    expect(ch.isClosed("t")).toBe(false);
  });
});
