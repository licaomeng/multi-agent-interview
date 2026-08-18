import { describe, it, expect } from "vitest";
import { Channel } from "../src/channel.js";
import {
  makeAgent,
  makeMockLLM,
  makeDeferredMock,
  waitFor,
  settle,
  pmConfig,
  engineerConfig,
  qaConfig,
  reviewerConfig,
} from "./helpers.js";
import type { LLM } from "../src/llm.js";

describe("INTEGRATION: multi-agent task completion", () => {
  it("3 agents complete a task: exactly one owner, owner summary + close, bounded messages", async () => {
    const channel = new Channel("#dev");
    // pm is subscribed first => first to claim => owner. It completes on its
    // SECOND call so the other agents get a chance to contribute first.
    const pm = makeAgent(pmConfig, channel, makeMockLLM(["plan drafted", "[DONE] final plan"]).llm);
    const eng = makeAgent(engineerConfig, channel, makeMockLLM(["implementing"]).llm);
    const qa = makeAgent(qaConfig, channel, makeMockLLM(["testing edge cases"]).llm);
    [pm, eng, qa].forEach((a) => a.start());

    channel.post("human", "Build feature-42", {
      to: "channel",
      topic: "general",
      kind: "question",
    });

    await waitFor(() => channel.isClosed("general"));

    const history = channel.getHistory("general");
    const closeMsgs = history.filter((m) => m.kind === "close");
    expect(closeMsgs.length).toBe(1);

    // Exactly one owner.
    expect(channel.getOwner("general")).toBe("pm");

    // Owner published a final summary (kind answer, non-empty) before closing.
    const summaries = history.filter(
      (m) => m.from === "pm" && m.kind === "answer" && m.content.length > 0
    );
    expect(summaries.length).toBeGreaterThan(0);

    // Bounded even though the mocked LLM would happily keep replying.
    expect(history.length).toBeLessThan(30);
  });

  it("human messages route to ALL agents regardless of role", async () => {
    const channel = new Channel();
    const pm = makeAgent({ ...pmConfig, topics: ["planning"] }, channel, makeMockLLM(["pm-reply"]).llm);
    const eng = makeAgent({ ...engineerConfig, topics: ["implementation"] }, channel, makeMockLLM(["eng-reply"]).llm);
    [pm, eng].forEach((a) => a.start());

    // Topic "general" is in NEITHER agent's role map, yet both must respond
    // because it came from the human.
    channel.post("human", "hello everyone", { to: "channel", topic: "general", kind: "question" });

    await waitFor(() => channel.getHistory("general").length >= 3); // human + 2 replies

    const replyFroms = channel.getHistory("general").slice(1).map((m) => m.from);
    expect(replyFroms).toEqual(expect.arrayContaining(["pm", "engineer"]));

    // And it terminates: neither agent's role map includes "general", so the
    // agent-authored replies are not re-processed by the other agent.
    await settle(channel);
    expect(channel.getHistory("general").length).toBeLessThan(10);
  });

  it("role gating: an agent never replies to agent-authored topics outside its role map", async () => {
    const channel = new Channel();
    const engLLM = makeMockLLM(["eng-impl"]);
    const qaLLM = makeMockLLM(["qa-anything"]);
    const eng = makeAgent({ ...engineerConfig, topics: ["implementation"] }, channel, engLLM.llm);
    const qa = makeAgent({ ...qaConfig, topics: ["testing"] }, channel, qaLLM.llm);
    [eng, qa].forEach((a) => a.start());

    // Human opens an "implementation" task: BOTH process it (human bypass).
    channel.post("human", "implement X", { topic: "implementation", kind: "question" });

    await waitFor(() => engLLM.calls.length >= 1 && qaLLM.calls.length >= 1);

    // Let the agents exchange agent-authored messages on "implementation".
    await settle(channel);

    // qa must never reply to an agent-authored "implementation" message:
    // it only ever processed the human's message (1 call), never eng's.
    expect(qaLLM.calls.length).toBe(1);
    const qaMsgs = channel.getHistory("implementation").filter((m) => m.from === "qa");
    expect(qaMsgs.length).toBe(1);
  });

  it("scales to 5 agents and still terminates with a single owner", async () => {
    const channel = new Channel();
    const all = [
      { ...pmConfig },
      { ...engineerConfig },
      { ...qaConfig },
      { ...reviewerConfig },
      { id: "ops", name: "Ope", role: "ops", topics: ["general", "deployment"], systemPrompt: "ops" },
    ];
    // First agent completes immediately.
    const agents = all.map((cfg, i) =>
      makeAgent(
        cfg,
        channel,
        makeMockLLM(i === 0 ? ["[DONE] scoped"] : ["working"]).llm
      )
    );
    agents.forEach((a) => a.start());

    channel.post("human", "Ship the thing", { topic: "general", kind: "question" });

    await waitFor(() => channel.isClosed("general"));

    const history = channel.getHistory("general");
    expect(history.filter((m) => m.kind === "close").length).toBe(1);
    expect(channel.getOwner("general")).toBe(agents[0].id);
    expect(history.length).toBeLessThan(30);
  });

  it("LLM error path: ownership is released and the topic can be re-claimed", async () => {
    const channel = new Channel();
    let pmCalls = 0;
    const flakyPm: LLM = {
      chat: async () => {
        pmCalls++;
        if (pmCalls === 1) throw new Error("boom");
        return "[DONE] recovered";
      },
    };
    const pm = makeAgent(pmConfig, channel, flakyPm);
    pm.start();

    channel.post("human", "task", { topic: "general", kind: "question" });

    // pm claims, errors, releases ownership.
    await waitFor(() => channel.getOwner("general") === null);
    expect(pmCalls).toBe(1);

    // A second human message lets pm re-claim and complete.
    channel.post("human", "retry", { topic: "general", kind: "question" });
    await waitFor(() => channel.isClosed("general"));
    expect(channel.getOwner("general")).toBe("pm");
    expect(pmCalls).toBeGreaterThanOrEqual(2);
  });

  it("stale-close: a queued reply does not post after its topic closed", async () => {
    const channel = new Channel();
    const deferred = makeDeferredMock();
    // pm is subscribed first => owner, and it completes immediately.
    const pm = makeAgent(pmConfig, channel, makeMockLLM(["[DONE] done"]).llm);
    const eng = makeAgent(engineerConfig, channel, deferred.llm);
    pm.start();
    eng.start();

    channel.post("human", "task", { topic: "general", kind: "question" });

    // Wait until eng is actually inside the LLM call (calls >= 1)...
    await waitFor(() => deferred.calls >= 1);

    // ...and the topic is already closed by the owner.
    await waitFor(() => channel.isClosed("general"));

    // Now eng's pending reply resolves, long after the close.
    const before = channel.getHistory("general").length;
    deferred.resolve("late reply");

    await settle(channel);
    expect(channel.getHistory("general").length).toBe(before);
    expect(
      channel.getHistory("general").some((m) => m.content === "late reply")
    ).toBe(false);
  });
});
