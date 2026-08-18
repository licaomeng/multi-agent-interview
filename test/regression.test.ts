import { describe, it, expect } from "vitest";
import { Channel } from "../src/channel.js";
import {
  makeAgent,
  makeMockLLM,
  waitFor,
  settle,
  pmConfig,
  engineerConfig,
  qaConfig,
} from "./helpers.js";

describe("REGRESSION: anti-replay / loop termination", () => {
  it("the naive A -> B -> C -> A loop terminates (bounded, quiet)", async () => {
    const channel = new Channel();
    const a = makeAgent({ ...pmConfig }, channel, makeMockLLM(["a-reply"]).llm, { replyBudget: 2 });
    const b = makeAgent({ ...engineerConfig }, channel, makeMockLLM(["b-reply"]).llm, { replyBudget: 2 });
    const c = makeAgent({ ...qaConfig }, channel, makeMockLLM(["c-reply"]).llm, { replyBudget: 2 });
    [a, b, c].forEach((x) => x.start());

    // No completer: the LLM never emits the marker, so the reply budget is the
    // only thing stopping the ping-pong.
    channel.post("human", "start", { topic: "general", kind: "question" });

    await settle(channel, 80, 3000);

    // Bounded: 1 human + at most 3 agents * budget 2 = 7.
    expect(channel.getHistory("general").length).toBeLessThanOrEqual(8);
    for (const id of ["pm", "engineer", "qa"]) {
      expect(channel.getReplyCount("general", id)).toBeLessThanOrEqual(2);
    }
  });

  it("FR11: a task that meets all negative constraints but never completes is caught", async () => {
    const channel = new Channel();
    const a = makeAgent({ ...pmConfig }, channel, makeMockLLM(["a1", "a2"]).llm, { replyBudget: 2 });
    const b = makeAgent({ ...engineerConfig }, channel, makeMockLLM(["b1", "b2"]).llm, { replyBudget: 2 });
    [a, b].forEach((x) => x.start());

    channel.post("human", "never-ending task", { topic: "general", kind: "question" });

    await settle(channel, 80, 3000);

    // No close was ever produced => the task never completed (FR11 catch).
    expect(channel.isClosed("general")).toBe(false);
    expect(channel.getHistory("general").filter((m) => m.kind === "close")).toEqual([]);
    // But it's still bounded — nobody looped forever.
    expect(channel.getHistory("general").length).toBeLessThan(15);
  });

  it("stall watchdog force-closes an open topic that never completes", async () => {
    const channel = new Channel("#dev", 40);
    const a = makeAgent({ ...pmConfig }, channel, makeMockLLM(["a1"]).llm, { replyBudget: 1 });
    a.start();

    channel.post("human", "stall", { topic: "general", kind: "question" });

    await waitFor(() => channel.getReplyCount("general", "pm") === 1);
    await waitFor(() => channel.isClosed("general"), 2000);

    // The watchdog calls close() directly — it does NOT post a close message.
    const history = channel.getHistory("general");
    expect(history.filter((m) => m.kind === "close")).toEqual([]);

    // After the force-close, no agent posts a further reply: the count and
    // history stay exactly where they were when the topic closed.
    const lenAtClose = history.length;
    await settle(channel, 60, 1000);
    expect(channel.getReplyCount("general", "pm")).toBe(1);
    expect(channel.getHistory("general").length).toBe(lenAtClose);
  });
});

describe("REGRESSION: re-topic bypass & budget enforcement", () => {
  it("an agent cannot dodge its budget by renaming the topic", async () => {
    const channel = new Channel();
    channel.post("human", "start", { topic: "task-1", kind: "question" });

    // Agent "a" burns its 2-reply budget on task-1.
    channel.post("a", "r1", { topic: "task-1", taskId: "task-1", countReply: true });
    channel.post("a", "r2", { topic: "task-1", taskId: "task-1", countReply: true });
    expect(channel.getReplyCount("task-1", "a")).toBe(2);

    // a re-topic attempt ("task-1-renamed") with the same taskId is bound to
    // the SAME ledger key — no fresh budget is granted.
    channel.post("a", "r3", { topic: "task-1-renamed", taskId: "task-1", countReply: true });
    expect(channel.getReplyCount("task-1", "a")).toBe(3);
    expect(channel.getHistory("task-1-renamed").every((m) => m.taskId === "task-1")).toBe(true);
  });

  it("budget is enforced at post time for real agents (sender-exclusion regression)", async () => {
    const channel = new Channel();
    // Scripted mocks that would reply forever if the budget did not bind.
    const a = makeAgent({ ...pmConfig }, channel, makeMockLLM(["reply"]).llm, { replyBudget: 2 });
    const b = makeAgent({ ...engineerConfig }, channel, makeMockLLM(["reply"]).llm, { replyBudget: 2 });
    a.start();
    b.start();

    channel.post("human", "start", { topic: "general", kind: "question" });

    await settle(channel, 60, 2000);

    // Each agent posted exactly `budget` replies, and each agent's own posts
    // were counted at post time (this is the sender-exclusion bug: previously
    // the poster never received its own message, so its own budget never
    // advanced, and the loop ran to the LLM context limit).
    expect(channel.getReplyCount("general", "pm")).toBe(2);
    expect(channel.getReplyCount("general", "engineer")).toBe(2);
    expect(channel.getHistory("general").filter((m) => m.from === "pm").length).toBe(2);
    expect(channel.getHistory("general").filter((m) => m.from === "engineer").length).toBe(2);
    expect(channel.getHistory("general").length).toBeLessThan(10);
  });

  it("a non-owner agent cannot open a new topic via post (minting rule)", () => {
    const channel = new Channel();
    channel.post("human", "start", { topic: "known" });
    const before = channel.getHistory().length;
    channel.post("engineer", "let me start a new task", {
      topic: "secret-side-quest",
      taskId: "secret-side-quest",
    });
    expect(channel.getHistory().length).toBe(before);
    expect(channel.getHistory("secret-side-quest")).toEqual([]);
  });
});
